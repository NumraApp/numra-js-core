import { createHmac, timingSafeEqual } from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════════
   Verifying a webhook from Numra
   ───────────────────────────────────────────────────────────────────────────
   The scheme, normatively, from packages/shared/openapi.yaml:

       Numra-Signature: sha256=<hex>
       Numra-Timestamp: <unix seconds>
       hex = HMAC-SHA256(secret, `${timestamp}.${rawBody}`)

   Three ways to implement this and still be wrong, all of which pass a
   happy-path test:

     1. Verifying a re-serialised body. JSON.stringify(JSON.parse(x)) is not
        x — key order, whitespace and number formatting all move — so every
        signature fails, and the usual "fix" is for the integrator to give up
        and skip verification entirely. This function therefore rejects
        anything that is not raw bytes or a raw string, with a message that
        says what to do instead.
     2. Comparing with ===. That returns on the first differing byte, leaking
        the signature one character at a time to anyone who can time the
        response.
     3. Ignoring the timestamp. The signature then stays valid for ever, so a
        captured "not blacklisted" payload can be replayed at will.

   All ten sibling SDKs must get all three right. Written here first because
   this file is the reference they are ported from.
   ═══════════════════════════════════════════════════════════════════════════ */

export class WebhookVerificationError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'WebhookVerificationError';
    /* One of: missing_signature, missing_timestamp, bad_timestamp, expired,
       invalid_signature, body_not_raw */
    this.reason = reason;
  }
}

function header(h, name) {
  if (!h) return undefined;
  /* A genuine case-insensitive scan, not `exact ?? lower ?? upper`.
     Node lower-cases incoming headers, but Numra sends `Numra-Signature`
     and anything that hands you the outgoing headers — a test, a proxy, a
     framework that preserves case — gives you the mixed form, which matches
     none of those three guesses. */
  const want = name.toLowerCase();
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === want) {
      const v = h[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

/**
 * Verify a Numra webhook and return its parsed payload.
 *
 * `rawBody` must be the exact bytes received. If your framework has already
 * parsed the body into an object, configure it to retain the raw bytes —
 * every server package in this family does that for you.
 *
 * @param {string|Buffer|Uint8Array} rawBody
 * @param {Record<string, string|string[]|undefined>} headers
 * @param {string} secret
 * @param {{ toleranceSeconds?: number, nowSeconds?: number }} [options]
 * @returns {Record<string, unknown>} the parsed payload
 * @throws {WebhookVerificationError} if the request is not authentic
 */
export function verifyWebhook(rawBody, headers, secret, options = {}) {
  const isRaw =
    typeof rawBody === 'string' ||
    Buffer.isBuffer(rawBody) ||
    rawBody instanceof Uint8Array;
  if (!isRaw) {
    throw new WebhookVerificationError(
      'body_not_raw',
      'rawBody must be the exact bytes or string received. A re-serialised object can never match — configure your framework to retain the raw body (express.raw({type:"application/json"}), or Next\'s req.text()).',
    );
  }

  const signature = header(headers, 'numra-signature');
  const timestamp = header(headers, 'numra-timestamp');

  if (!signature) throw new WebhookVerificationError('missing_signature', 'Numra-Signature header is missing.');
  if (!timestamp) throw new WebhookVerificationError('missing_timestamp', 'Numra-Timestamp header is missing.');

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    /* Truncated. The reason string goes into the response body, so an
       unbounded header value was unauthenticated input reflected back at
       whoever sent it — not XSS on a JSON response, but not ours to echo. */
    throw new WebhookVerificationError('bad_timestamp', `Numra-Timestamp is not a number: ${String(timestamp).slice(0, 32)}`);
  }

  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > tolerance) {
    throw new WebhookVerificationError(
      'expired',
      `Timestamp is ${Math.abs(now - ts)}s from now, outside the ${tolerance}s tolerance. This is replay protection, not a clock bug — check the server clock before widening it.`,
    );
  }

  const body = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

  /* timingSafeEqual throws on a length mismatch, which would itself leak
     length. Compare lengths first, then run the constant-time compare. */
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  const equal = a.length === b.length && timingSafeEqual(a, b);
  if (!equal) {
    throw new WebhookVerificationError(
      'invalid_signature',
      'Signature does not match. Verify against the RAW body, and check the signing secret belongs to this endpoint.',
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new WebhookVerificationError('invalid_signature', 'Signature matched but the body is not valid JSON.');
  }
}

/** Non-throwing variant, for callers that prefer a branch to a try/catch. */
export function isValidWebhook(rawBody, headers, secret, options = {}) {
  try {
    verifyWebhook(rawBody, headers, secret, options);
    return true;
  } catch {
    return false;
  }
}
