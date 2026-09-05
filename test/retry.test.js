import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numra } from '../src/index.js';
import { startMockServer, LOOKUP_OK } from './mock-server.js';

const key = 'test_key';

test('a 500 is retried and the eventual success is returned', async () => {
  const s = await startMockServer((_c, n) =>
    n < 3 ? { status: 500, body: { ok: false, message: 'boom' } } : { body: LOOKUP_OK });
  const numra = new Numra({ apiKey: key, baseUrl: s.url, maxRetries: 2 });

  const r = await numra.check('0600000000');
  assert.equal(r.riskLevel, 'HIGH');
  assert.equal(s.calls.length, 3, 'two retries then success');
  await s.close();
});

test('QUOTA_EXCEEDED is never retried, even though it arrives as a 429', async () => {
  /* The distinction that matters: a rate limit clears in a minute, a quota
     clears at midnight. Retrying a quota inside the request turns one
     exhausted day into sustained hammering. */
  const s = await startMockServer(() => ({
    status: 429,
    body: { ok: false, error: 'QUOTA_EXCEEDED', message: 'daily limit reached' },
  }));
  const numra = new Numra({ apiKey: key, baseUrl: s.url, maxRetries: 3 });

  await assert.rejects(() => numra.check('0600000000'), (e) => {
    assert.equal(e.code, 'QUOTA_EXCEEDED');
    assert.equal(e.isQuotaError, true);
    return true;
  });
  assert.equal(s.calls.length, 1, 'a quota error must not be retried');
  await s.close();
});

test('RATE_LIMITED is retried, and Retry-After is obeyed over our own backoff', async () => {
  const s = await startMockServer((_c, n) =>
    n === 1
      ? { status: 429, body: { ok: false, error: 'RATE_LIMITED', message: 'slow down' }, headers: { 'Retry-After': '0' } }
      : { body: LOOKUP_OK });
  const numra = new Numra({ apiKey: key, baseUrl: s.url, maxRetries: 2 });

  const r = await numra.check('0600000000');
  assert.equal(r.riskLevel, 'HIGH');
  assert.equal(s.calls.length, 2);
  await s.close();
});

test('a timeout aborts, is typed TIMEOUT, and is retried', async () => {
  let hangs = 0;
  const s = await startMockServer((_c, n) => {
    if (n === 1) { hangs++; return 'HANG'; }
    return { body: LOOKUP_OK };
  });
  const numra = new Numra({ apiKey: key, baseUrl: s.url, timeout: 150, maxRetries: 1 });

  const r = await numra.check('0600000000');
  assert.equal(hangs, 1, 'the first attempt really hung');
  assert.equal(r.riskLevel, 'HIGH', 'the retry succeeded');
  await s.close();
});

test('an unreachable host raises NETWORK_ERROR, not a generic failure', async () => {
  /* Port 1 is reserved and refuses instantly. A caller has to be able to
     tell "Numra said no" from "nobody answered". */
  const numra = new Numra({ apiKey: key, baseUrl: 'http://127.0.0.1:1', maxRetries: 0 });
  await assert.rejects(() => numra.check('0600000000'), (e) => {
    assert.equal(e.code, 'NETWORK_ERROR');
    assert.equal(e.retryable, true);
    return true;
  });
});
