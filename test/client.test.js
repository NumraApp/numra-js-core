import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numra, NumraError } from '../src/index.js';
import { startMockServer, LOOKUP_OK } from './mock-server.js';

const key = 'test_key';

test('check() maps the wire format to camelCase and keeps the raw body', async () => {
  const s = await startMockServer(() => ({ body: LOOKUP_OK }));
  const numra = new Numra({ apiKey: key, baseUrl: s.url });
  const r = await numra.check('0600000000');

  assert.equal(r.phone, '+212600000000');
  assert.equal(r.riskLevel, 'HIGH');
  assert.equal(r.verdictSource, 'events');
  assert.equal(r.trustScore, 28);
  assert.equal(r.isRated, true);
  assert.equal(r.customerStyle.riskSensitivity, 1.2);
  assert.equal(r.cacheTtlSeconds, 3600);
  /* raw is the escape hatch: a field added server-side must be reachable
     without waiting for an SDK release. */
  assert.equal(r.raw.risk_score_raw, 68.4);
  await s.close();
});

test('every request carries auth, X-Country and a versioned User-Agent', async () => {
  const s = await startMockServer(() => ({ body: LOOKUP_OK }));
  await new Numra({ apiKey: key, baseUrl: s.url, integration: 'woocommerce/1.17.0' }).check('0600000000');

  const h = s.calls[0].headers;
  assert.equal(h.authorization, `Bearer ${key}`);
  assert.equal(h['x-country'], 'MA');
  assert.match(h['user-agent'], /^numra-js\/\d+\.\d+\.\d+ woocommerce\/1\.17\.0 node\//);
  await s.close();
});

test('the API error code becomes the NumraError code, not the message', async () => {
  const s = await startMockServer(() => ({
    status: 403,
    body: { ok: false, error: 'COUNTRY_NOT_ALLOWED', message: 'Only MA is supported' },
  }));
  const numra = new Numra({ apiKey: key, baseUrl: s.url, maxRetries: 0 });

  await assert.rejects(
    () => numra.check('0600000000'),
    (e) => {
      assert.ok(e instanceof NumraError);
      assert.equal(e.code, 'COUNTRY_NOT_ALLOWED');
      assert.equal(e.status, 403);
      assert.equal(e.retryable, false);
      return true;
    },
  );
  await s.close();
});

test('an auth failure is flagged as such and never retried', async () => {
  const s = await startMockServer(() => ({
    status: 401, body: { ok: false, error: 'LICENSE_EXPIRED', message: 'expired' },
  }));
  const numra = new Numra({ apiKey: key, baseUrl: s.url, maxRetries: 3 });

  await assert.rejects(() => numra.check('0600000000'), (e) => {
    assert.equal(e.isAuthError, true);
    return true;
  });
  /* The point: three retries were allowed and none were spent. */
  assert.equal(s.calls.length, 1, 'auth errors must not be retried');
  await s.close();
});
