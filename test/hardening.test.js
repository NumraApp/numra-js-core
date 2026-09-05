import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Numra, NumraError } from '../src/index.js';
import { createHandlers } from '../src/server.js';

/* ═══════════════════════════════════════════════════════════════════════════
   Regressions from the pre-release audit, 4 September 2026
   ───────────────────────────────────────────────────────────────────────────
   Every test here failed before the fix it guards. They are grouped in one
   file on purpose: each one is a way this client used to answer a question it
   had not actually been given an answer to, and that is one failure mode
   wearing several costumes.
   ═══════════════════════════════════════════════════════════════════════════ */

const serve = (handler) =>
  new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve([s, `http://127.0.0.1:${s.address().port}`]));
  });

test('a server that sends headers and then stalls times out instead of hanging for ever', async () => {
  /* `fetch()` resolves on headers, so clearing the timeout there left the
     body read with no deadline and no signal. The promise never settled and
     the socket leaked with it — reachable from any proxy on the path. */
  const [s, url] = await serve((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
    res.write('{');
  });
  try {
    const n = new Numra({ apiKey: 'k', baseUrl: url, timeout: 400, maxRetries: 0 });
    const outcome = await Promise.race([
      n.check('0600000000').then(() => 'resolved', (e) => e.code),
      new Promise((r) => setTimeout(() => r('HUNG'), 4000)),
    ]);
    assert.equal(outcome, 'TIMEOUT');
  } finally { s.close(); }
});

for (const [label, status, body, type] of [
  ['an HTML interstitial', 200, '<html>login</html>', 'text/html'],
  ['a 204 with no content', 204, '', 'application/json'],
  ['a literal JSON null', 200, 'null', 'application/json'],
  ['a JSON array', 200, '[]', 'application/json'],
]) {
  test(`${label} on a 2xx is a failed lookup, not an empty result`, async () => {
    /* This is the one that mattered. The PHP twin returned an empty array
       here, which defaulted to verdict UNRATED / score 0 / not blacklisted —
       so a blacklisted number came back clean, silently. JS returned null and
       then threw a raw TypeError that escaped every documented
       `instanceof NumraError` handler. */
    const [s, url] = await serve((_req, res) => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(body);
    });
    try {
      const n = new Numra({ apiKey: 'k', baseUrl: url, timeout: 2000, maxRetries: 0 });
      const e = await n.check('0600000000').then(() => null, (x) => x);
      assert.ok(e instanceof NumraError, `expected a NumraError, got ${e?.constructor?.name}`);
      assert.equal(e.code, 'SERVER_ERROR');
    } finally { s.close(); }
  });
}

for (const header of ['86400', '999999', 'Wed, 21 Oct 2026 07:28:00 GMT', '-100']) {
  test(`Retry-After ${JSON.stringify(header)} cannot park a checkout`, async () => {
    /* Unclamped, `Retry-After: 86400` — ordinary output from a rate limiter
       under load — was a 24-hour sleep inside a checkout. An HTTP-date became
       NaN, and `setTimeout(r, NaN)` fires immediately, so the one response
       designed to slow a client down made it hammer instead. */
    let hits = 0;
    const [s, url] = await serve((_req, res) => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(500, { 'retry-after': header, 'Content-Type': 'application/json' });
        res.end('{}');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"phone":"0600000000"}');
      }
    });
    try {
      const started = Date.now();
      const n = new Numra({ apiKey: 'k', baseUrl: url, timeout: 2000, maxRetries: 1 });
      await n.check('0600000000').catch(() => {});
      const waited = Date.now() - started;
      assert.ok(waited <= 21_000, `waited ${waited}ms`);
      assert.ok(waited >= 0);
    } finally { s.close(); }
  });
}

test('a 404 is answered once and named, not retried as a server fault', async () => {
  /* A typo'd baseUrl used to spend the whole retry budget on every checkout
     and then report Numra as down. */
  let hits = 0;
  const [s, url] = await serve((_req, res) => {
    hits += 1;
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<html>');
  });
  try {
    const n = new Numra({ apiKey: 'k', baseUrl: url, timeout: 2000, maxRetries: 3 });
    const e = await n.check('0600000000').then(() => null, (x) => x);
    assert.equal(e.code, 'ENDPOINT_NOT_FOUND');
    assert.equal(hits, 1);
  } finally { s.close(); }
});

test("the caller's abort stops the request and is not reported as a timeout", async () => {
  /* The shopper closed the tab. Before this the client carried on, retries
     and all, spending quota on an answer nobody would read. */
  const [s, url] = await serve((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"phone":"06"}');
    }, 3000);
  });
  try {
    const n = new Numra({ apiKey: 'k', baseUrl: url, timeout: 10_000, maxRetries: 2 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const started = Date.now();
    const e = await n.check('0600000000', { signal: ac.signal }).then(() => null, (x) => x);
    assert.equal(e.code, 'CANCELLED');
    assert.ok(Date.now() - started < 1500);
  } finally { s.close(); }
});
