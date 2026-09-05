import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers } from '../src/server.js';
import { Numra } from '../src/client.js';

/* Regressions from the pre-release audit, 4 September 2026.
   The handlers are the public edge of a merchant's app: mounting them creates
   an endpoint anyone can reach that spends the merchant's paid quota. */

/* A client that records what reached it, so "was anything spent?" is a fact
   rather than an inference. */
function spyClient() {
  const calls = [];
  return {
    calls,
    async check(phone) { calls.push({ op: 'check', phone }); return { phone, verdict: 'UNRATED' }; },
    async reportOutcome(input) { calls.push({ op: 'outcome', input }); return { recorded: true, idempotent: false }; },
  };
}

test('a phone longer than the cap is refused before anything is spent', async () => {
  /* Express bounded the body at 32 KB, Fastify at 1 MiB, Next and Nuxt not at
     all — so on a Next store one authorised session could push 30 MB through
     as a "phone number", burning a billable lookup and the merchant's egress
     on every request. */
  const client = spyClient();
  const h = createHandlers({ client, authorize: () => true });
  const res = await h.check({ phone: '6'.repeat(5000) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INVALID_PAYLOAD');
  assert.equal(client.calls.length, 0);
});

test('a whitespace-only phone is refused, as it already was in PHP', async () => {
  const client = spyClient();
  const h = createHandlers({ client, authorize: () => true });
  assert.equal((await h.check({ phone: '   ' })).status, 400);
  assert.equal(client.calls.length, 0);
});

for (const [label, input] of [
  ['an array phone', { phone: ['a', 'b'], orderId: 'o', outcomeType: 'D' }],
  ['an object orderId', { phone: '06', orderId: { a: 1 }, outcomeType: 'D' }],
  ['a nested currency', { phone: '06', orderId: 'o', outcomeType: 'D', currency: { deep: 1 } }],
  ['a 10 MB note', { phone: '06', orderId: 'o', outcomeType: 'D', note: 'x'.repeat(10_000_000) }],
  ['an empty outcomeType', { phone: '06', orderId: 'o', outcomeType: '' }],
]) {
  test(`outcome refuses ${label} without sending anything`, async () => {
    /* check() insisted on a string and outcome() insisted on truthiness, so
       these reached the wire. The PHP twin's (string) cast wrote the literal
       word "Array" into the ledger, and orderId is half the idempotency key.

       Driven through the REAL client with an instrumented fetch, because the
       validation deliberately lives in one place — the client — and a test
       against a stub would prove only that the stub was polite. */
    const sent = [];
    const client = new Numra({
      apiKey: 'k',
      maxRetries: 0,
      fetch: async (url, init) => {
        sent.push({ url, body: init.body });
        return new Response('{"recorded":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });
    const h = createHandlers({ client, authorize: () => true });
    const res = await h.outcome(input);
    assert.equal(res.status, 400, JSON.stringify(res));
    assert.equal(res.body.error, 'INVALID_PAYLOAD');
    assert.deepEqual(sent, [], `nothing should have been sent, got ${JSON.stringify(sent).slice(0, 200)}`);
  });
}

test('a well-formed outcome still goes through untouched', async () => {
  const sent = [];
  const client = new Numra({
    apiKey: 'k',
    maxRetries: 0,
    fetch: async (url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response('{"recorded":true,"idempotent":false}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const h = createHandlers({ client, authorize: () => true });
  const res = await h.outcome({ phone: '0600000000', orderId: 'ORD-1', outcomeType: 'DELIVERED', orderTotal: 250 });
  assert.equal(res.status, 200);
  assert.equal(res.body.recorded, true);
  assert.equal(sent[0].order_id, 'ORD-1');
});

for (const bad of [null, false, 0, '', 'yes', {}, []]) {
  test(`authorize: ${JSON.stringify(bad)} refuses at construction, not silently at 403`, () => {
    /* A default parameter only fires on `undefined`, so every one of these
       sailed past it, threw inside the guard, and was swallowed by a bare
       catch into a silent 403 with nothing logged. Every customer refused,
       the badge gone, and no way to find out why. */
    assert.throws(() => createHandlers({ client: spyClient(), authorize: bad }), TypeError);
  });
}

test('a missing authorize still denies, and says so once rather than once per request', async () => {
  /* The endpoint is public, so a scanner hitting a mid-deploy
     misconfiguration wrote a three-line diagnostic to the merchant's disk on
     every hit. Loud once is the point; loud forever is an amplifier. */
  let lines = 0;
  const h = createHandlers({ client: spyClient(), log: () => { lines += 1; } });
  const statuses = new Set();
  for (let i = 0; i < 50; i += 1) statuses.add((await h.check({ phone: '0600000000' })).status);
  assert.deepEqual([...statuses], [500]);
  assert.equal(lines, 1);
});

test('an empty webhook body is unauthentic, not a misconfiguration', async () => {
  /* Folding "empty" in with "already consumed" meant anyone could send
     Content-Length: 0 in a loop and produce a 500 plus a log line accusing
     the merchant's own setup — a way to talk someone into disabling webhook
     verification, which is what this whole path exists to prevent. */
  const h = createHandlers({ client: spyClient(), authorize: () => true, webhookSecret: 'whsec_test' });
  const res = h.webhook('', {});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'missing_signature');
});

test('a body that was already parsed is still a loud 500', async () => {
  const h = createHandlers({ client: spyClient(), authorize: () => true, webhookSecret: 'whsec_test', log: () => {} });
  const res = h.webhook({ already: 'parsed' }, {});
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'NUMRA_RAW_BODY_UNAVAILABLE');
});

test('upstream prose is not relayed to the browser, but our own message is', async () => {
  /* INVALID_PAYLOAD was the one branch that passed whatever the API wrote in
     `message` straight through to a public response. */
  const { NumraError } = await import('../src/errors.js');
  const upstream = {
    async check() { throw new NumraError('INVALID_PAYLOAD', 'internal rule R-42 tripped for merchant 8812', { status: 400 }); },
  };
  const h = createHandlers({ client: upstream, authorize: () => true });
  const res = await h.check({ phone: '0600000000' });
  assert.equal(res.status, 400);
  assert.ok(!res.body.message.includes('R-42'), res.body.message);
});
