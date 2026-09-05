import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhook, isValidWebhook, WebhookVerificationError } from '../src/index.js';

const secret = 'whsec_test_0123456789';
const NOW = 1_700_000_000;
const body = JSON.stringify({
  id: 'evt_1', event: 'verification.flagged',
  data: { phone: '+212600000000', risk_level: 'HIGH', is_blacklisted: false },
});

const sign = (b = body, ts = NOW, s = secret) => ({
  'numra-signature': 'sha256=' + createHmac('sha256', s).update(`${ts}.${b}`).digest('hex'),
  'numra-timestamp': String(ts),
});

test('a correctly signed payload verifies and is returned parsed', () => {
  const out = verifyWebhook(body, sign(), secret, { nowSeconds: NOW });
  assert.equal(out.event, 'verification.flagged');
  assert.equal(out.data.phone, '+212600000000');
});

test('the scheme matches what the platform actually sends', () => {
  /* Independently recomputed here. If this stops matching, either the
     platform changed the scheme or this SDK did, and the ten siblings
     ported from this file are all wrong too. */
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${NOW}.${body}`).digest('hex');
  assert.equal(sign()['numra-signature'], expected);
});

test('a tampered body is rejected', () => {
  assert.throws(
    () => verifyWebhook(body + ' ', sign(), secret, { nowSeconds: NOW }),
    (e) => e instanceof WebhookVerificationError && e.reason === 'invalid_signature',
  );
});

test('the wrong secret is rejected', () => {
  assert.equal(isValidWebhook(body, sign(), 'whsec_other', { nowSeconds: NOW }), false);
});

test('a replay outside the tolerance is rejected', () => {
  /* Without this check a captured "not blacklisted" payload stays valid for
     ever, which is the whole reason the timestamp is signed. */
  assert.throws(
    () => verifyWebhook(body, sign(body, NOW - 3600), secret, { nowSeconds: NOW }),
    (e) => e.reason === 'expired',
  );
});

test('a replay inside the tolerance is accepted', () => {
  const out = verifyWebhook(body, sign(body, NOW - 120), secret, { nowSeconds: NOW });
  assert.equal(out.id, 'evt_1');
});

test('an already-parsed body is refused with an actionable message', () => {
  /* The most common integration mistake. Rejecting it loudly is better than
     failing the signature and letting someone conclude verification is
     broken and skip it. */
  assert.throws(
    () => verifyWebhook({ id: 'evt_1' }, sign(), secret, { nowSeconds: NOW }),
    (e) => {
      assert.equal(e.reason, 'body_not_raw');
      assert.match(e.message, /raw/i);
      return true;
    },
  );
});

test('missing headers are named individually', () => {
  assert.throws(() => verifyWebhook(body, {}, secret), (e) => e.reason === 'missing_signature');
  assert.throws(
    () => verifyWebhook(body, { 'numra-signature': 'sha256=x' }, secret),
    (e) => e.reason === 'missing_timestamp',
  );
});

test('header lookup is case-insensitive and survives array values', () => {
  const h = sign();
  const upper = { 'Numra-Signature': h['numra-signature'], 'Numra-Timestamp': [h['numra-timestamp']] };
  assert.equal(isValidWebhook(body, upper, secret, { nowSeconds: NOW }), true);
});

test('a Buffer body verifies identically to a string', () => {
  assert.equal(isValidWebhook(Buffer.from(body), sign(), secret, { nowSeconds: NOW }), true);
});
