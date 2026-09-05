/* ═══════════════════════════════════════════════════════════════════════════
   The error taxonomy
   ───────────────────────────────────────────────────────────────────────────
   Ten sibling SDKs will be ported from this file, so the decisions here are
   the ones the whole family inherits.

   Callers switch on `code`, never on `message`. openapi.yaml says it plainly:
   the code is the stable surface, the message is written for humans and
   changes without notice. An SDK that exposes only a message forces every
   integrator to string-match, and then a copy edit on our side breaks their
   checkout.

   Codes are the API's own, plus three the client raises itself:

     NETWORK_ERROR  nobody answered — DNS, reset socket, abort. Distinct from
                    every API code because those mean "Numra said no" and this
                    means "nobody said anything". A caller deciding whether to
                    ship the parcel anyway must be able to tell them apart.
     TIMEOUT        we gave up waiting.
     SERVER_ERROR   a 5xx, or a body we could not parse.
     CANCELLED      the caller's own AbortSignal fired. Deliberately not
                    retryable and deliberately not TIMEOUT: the shopper closed
                    the tab, which is not a failure and must not be reported
                    to the merchant as one.
   ═══════════════════════════════════════════════════════════════════════════ */

export class NumraError extends Error {
  constructor(code, message, opts = {}) {
    super(message, { cause: opts.cause });
    this.name = 'NumraError';
    this.code = code;
    this.status = opts.status ?? null;
    this.requestId = opts.requestId ?? null;
    this.retryAfter = opts.retryAfter ?? null;
    this.docsUrl = opts.docsUrl ?? null;
    /* The parsed body, when there was one. Never contains the credential. */
    this.body = opts.body ?? null;
  }

  /** True when trying again later could plausibly succeed. */
  get retryable() {
    return (
      this.code === 'NETWORK_ERROR' ||
      this.code === 'TIMEOUT' ||
      this.code === 'SERVER_ERROR' ||
      this.code === 'RATE_LIMITED'
    );
  }

  /** True when the credential is the problem and retrying will never help. */
  get isAuthError() {
    return (
      this.code === 'LICENSE_MISSING' ||
      this.code === 'LICENSE_INVALID' ||
      this.code === 'LICENSE_EXPIRED' ||
      this.code === 'LICENSE_BOUND'
    );
  }

  /** True when you are out of quota — retryable, but not today. */
  get isQuotaError() {
    return this.code === 'QUOTA_EXCEEDED';
  }
}

/** Every code this library can raise. openapi.yaml plus the three above. */
export const ERROR_CODES = Object.freeze([
  'LICENSE_MISSING',
  'LICENSE_INVALID',
  'LICENSE_EXPIRED',
  'LICENSE_BOUND',
  'COUNTRY_NOT_ALLOWED',
  'INVALID_PAYLOAD',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'ENDPOINT_NOT_FOUND',
  'NETWORK_ERROR',
  'TIMEOUT',
  'SERVER_ERROR',
  'CANCELLED',
]);
