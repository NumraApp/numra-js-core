import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Numra, NumraError, ERROR_CODES, VERSION, verifyWebhook, isValidWebhook, WebhookVerificationError } from '../src/index.js';
import { startMockServer, LOOKUP_OK } from './mock-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const dts = fs.readFileSync(path.join(here, '..', 'index.d.ts'), 'utf8');
const key = 'test_key';

test('the browser guard actually fires', async () => {
  /* The single most important behaviour in the package. An API key in a
     bundle reads a shared fraud database, and a README warning has never
     once stopped anyone. */
  const g = globalThis;
  const hadWindow = 'window' in g, hadDoc = 'document' in g;
  g.window = {}; g.document = {};
  try {
    assert.throws(() => new Numra({ apiKey: key }), (e) => {
      assert.equal(e instanceof NumraError, true);
      assert.match(e.message, /never run in a browser/);
      /* It must also say what to do instead, or it is just an obstacle. */
      assert.match(e.message, /@getnumra\/express|backend/);
      return true;
    });
  } finally {
    if (!hadWindow) delete g.window;
    if (!hadDoc) delete g.document;
  }
});

test('a worker-like global with no DOM is allowed', () => {
  /* Cloudflare Workers define a window-like global without being a page, and
     running server code there is legitimate. Guarding on `window` alone
     would have locked them out. */
  const g = globalThis;
  const had = 'window' in g;
  g.window = {};
  try {
    assert.doesNotThrow(() => new Numra({ apiKey: key }));
  } finally {
    if (!had) delete g.window;
  }
});

test('a missing key fails at construction, not at first call', () => {
  assert.throws(() => new Numra({}), (e) => e.code === 'LICENSE_MISSING');
});

test('index.d.ts declares everything the runtime exports', () => {
  /* The package ships hand-written types with no build step, so this is what
     stops them silently falling behind src/. */
  for (const name of ['Numra', 'NumraError', 'verifyWebhook', 'isValidWebhook', 'WebhookVerificationError', 'VERSION', 'ERROR_CODES']) {
    assert.match(dts, new RegExp(`\\b${name}\\b`), `index.d.ts is missing ${name}`);
  }
  for (const m of ['check', 'reportOutcome', 'verifyLicense']) {
    assert.ok(typeof Numra.prototype[m] === 'function', `${m} missing at runtime`);
    assert.match(dts, new RegExp(`\\b${m}\\(`), `index.d.ts is missing ${m}()`);
  }
  assert.equal(VERSION, pkg.version, 'VERSION must match package.json');
  assert.ok(ERROR_CODES.includes('QUOTA_EXCEEDED'));
});

test('the published package has no dependencies', () => {
  /* A fraud client that pulls a tree of transitive packages into a
     merchant's checkout is a supply-chain surface nobody asked for. */
  assert.equal(pkg.dependencies, undefined);
  /* LICENSE is listed even though npm always includes it: `files` is what a
     reader checks to see what ships, and a licence that is only there by
     npm's implicit rule is one nobody knows is there. */
  assert.deepEqual(pkg.files, ['src', 'index.d.ts', 'LICENSE', 'README.md']);
});

test('reportOutcome requires the whole idempotency key', async () => {
  const s = await startMockServer(() => ({ body: { ok: true } }));
  const numra = new Numra({ apiKey: key, baseUrl: s.url });
  await assert.rejects(() => numra.reportOutcome({ phone: '06', outcomeType: 'DELIVERED' }),
    (e) => { assert.match(e.message, /orderId/); return true; });
  assert.equal(s.calls.length, 0, 'never left the client');
  await s.close();
});

test('an idempotent replay is distinguishable from a fresh record', async () => {
  const s = await startMockServer((_c, n) => ({
    status: n === 1 ? 201 : 200,
    body: {
      ok: true, recorded: n === 1, idempotent: n !== 1,
      phone: '+212600000000', order_id: '1042', outcome_type: 'REFUSED_COD',
      message: n === 1 ? 'Recorded.' : 'Already recorded.',
    },
  }));
  const numra = new Numra({ apiKey: key, baseUrl: s.url });
  const input = { phone: '0600000000', orderId: '1042', outcomeType: 'REFUSED_COD' };

  const first = await numra.reportOutcome(input);
  const second = await numra.reportOutcome(input);
  assert.equal(first.recorded, true);
  assert.equal(second.recorded, false);
  assert.equal(second.idempotent, true);
  await s.close();
});

test('daily_limit: null survives as null and is never coerced to 0', async () => {
  /* null means unlimited. Coercing it to 0 reads as "no quota left" — the
     exact opposite, and it would gate a merchant out of their own plan. */
  const s = await startMockServer(() => ({
    body: {
      ok: true, license_status: 'active', plan: 'Pro', country: 'MA',
      daily_limit: null, daily_used: 12, unlimited: true,
      expires_at: null, renew_url: 'https://numra.ma/billing',
    },
  }));
  const r = await new Numra({ apiKey: key, baseUrl: s.url }).verifyLicense();
  assert.equal(r.dailyLimit, null);
  assert.equal(r.unlimited, true);
  await s.close();
});
