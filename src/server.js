import { NumraError } from './errors.js';
import { MAX_PHONE_LENGTH } from './client.js';
import { verifyWebhook, WebhookVerificationError } from './webhooks.js';

/* ═══════════════════════════════════════════════════════════════════════════
   Framework-neutral request handling
   ───────────────────────────────────────────────────────────────────────────
   @getnumra/express, @getnumra/fastify, @getnumra/next and @getnumra/nuxt all do the same
   four things: authorise, call Numra, narrow the result for the browser, and
   translate upstream failures. Written once per framework, those four things
   drift — and the one that drifts silently is "deny by default", which is the
   difference between a private endpoint and an open relay pointed at the
   merchant's paid quota.

   So it lives here, once, and each framework package is a thin adapter that
   converts its own req/res into these calls. `{ status, body }` in and out;
   nothing in this file knows what a Response is.

   Still zero-dependency: this is plain functions over plain objects.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Exported so a framework adapter can compare against it and produce the
   loud configuration error rather than a bland 403. */
export const DENY_BY_DEFAULT = () => false;

/* The last line has to be code the reader can paste, in the package they
   actually installed — a Fastify user told to call `numraRouter` will decide
   the message is stale and reach for `authorize: () => true` instead. So each
   adapter passes its own `usage`. */
export const DEFAULT_USAGE =
  'numraRouter({ apiKey, authorize: (req) => Boolean(req.session?.user) })';

export function notConfiguredMessage(usage = DEFAULT_USAGE) {
  return (
    '[numra] Refusing every request because no `authorize` was provided.\n' +
    '        This route spends your Numra quota, so it must not be open.\n' +
    '        ' + String(usage).replace(/\n/g, '\n        ')
  );
}

export const NOT_CONFIGURED_MESSAGE = notConfiguredMessage();

/* What the browser is allowed to see.
   ─────────────────────────────────────────────────────────────────────────
   A subset, deliberately. `raw` would leak the shape of our ledger,
   `risk_score_raw` is engine diagnostics, and nothing here names another
   merchant. The page needs to know what to do about this order, not how the
   score was built. */
export function forBrowser(check) {
  return {
    phone: check.phone,
    verdict: check.verdict,
    riskLevel: check.riskLevel,
    riskScore: check.riskScore,
    trustScore: check.trustScore,
    confidence: check.confidence,
    isRated: check.isRated,
    isBlacklisted: check.isBlacklisted,
    customerStyle: check.customerStyle,
  };
}

/* Upstream failures are translated, never relayed.
   ─────────────────────────────────────────────────────────────────────────
   A rejected credential is the MERCHANT's problem, not the visitor's, and a
   401 arriving in a browser reads as "you are logged out". It becomes a 502
   and the detail goes to the server log. */
export function translateError(e, log = console.error) {
  if (e instanceof NumraError) {
    if (e.isAuthError) {
      log('[numra] credential rejected:', e.code, e.message);
      return { status: 502, body: { error: 'UPSTREAM_UNAVAILABLE' } };
    }
    if (e.isQuotaError) return { status: 503, body: { error: 'QUOTA_EXCEEDED' } };
    if (e.code === 'INVALID_PAYLOAD') {
      /* The one branch that used to relay upstream prose to the browser, in a
         file whose own heading says failures are translated and never
         relayed — and it is the code an anonymous caller can most reliably
         provoke, by sending a malformed phone. Whatever the API writes in
         `message` became public. Our own validation messages are safe because
         we wrote them; anything with a `status` came from upstream. */
      const ours = e.status == null;
      return {
        status: 400,
        body: { error: 'INVALID_PAYLOAD', message: ours ? e.message : 'The request was rejected.' },
      };
    }
    return { status: 502, body: { error: 'UPSTREAM_UNAVAILABLE' } };
  }
  log('[numra] unexpected:', e);
  return { status: 500, body: { error: 'INTERNAL' } };
}

/**
 * Build the handlers a framework adapter wraps.
 *
 * Every handler returns `{ status, body }`. None of them throw.
 *
 * @param {{ client: import('./client.js').Numra,
 *           authorize?: (ctx: any) => boolean|Promise<boolean>,
 *           webhookSecret?: string,
 *           usage?: string,
 *           log?: (...a: any[]) => void }} options
 */
export function createHandlers(options = {}) {
  const { client, webhookSecret, log = console.error, usage } = options;

  /* A default parameter only fires on `undefined`.
     ─────────────────────────────────────────────────────────────────────
     So `authorize: null`, `false`, `0`, `''`, `'yes'`, `{}` — every shape a
     missing config key or a `process.env.X === '1'` produces — sailed past
     the default, threw `TypeError: authorize is not a function` inside the
     guard, and was swallowed by its bare catch into a silent 403. Every
     customer got refused, the badge stopped rendering, and nothing was
     logged. Refuse at construction, the way the PHP twin's `?callable`
     already does: a boot failure is findable, a silent 403 is not. */
  const authorize = options.authorize === undefined ? DENY_BY_DEFAULT : options.authorize;
  if (typeof authorize !== 'function') {
    throw new TypeError(
      `[numra] \`authorize\` must be a function, received ${authorize === null ? 'null' : typeof authorize}. ` +
      'Leave it out entirely to refuse every request until you are ready.',
    );
  }

  /* The not-configured diagnostic is loud on purpose, but it used to be loud
     once per REQUEST — and the endpoint is public, so a scanner filled the
     merchant's disk at 215 bytes a hit while they were mid-deploy. Said once
     per process, which is where a configuration error belongs. */
  let saidNotConfigured = false;

  /** @returns {null} when allowed, or a `{status, body}` refusal. */
  async function guard(ctx) {
    let allowed;
    try {
      allowed = await authorize(ctx);
    } catch {
      /* Fail closed. A session lookup that throws must not become an open
         door — that is how a database blip turns into a spending spree. */
      allowed = false;
    }
    if (allowed === true) return null;

    if (authorize === DENY_BY_DEFAULT) {
      /* A configuration mistake, not a permissions one, and the message has
         to say exactly what to write — otherwise it gets "fixed" with
         `authorize: () => true`. */
      if (!saidNotConfigured) {
        saidNotConfigured = true;
        log(notConfiguredMessage(usage));
      }
      return {
        status: 500,
        body: { error: 'NUMRA_NOT_CONFIGURED', message: 'This endpoint has no authorize function.' },
      };
    }
    return { status: 403, body: { error: 'FORBIDDEN' } };
  }

  return {
    async check(input, ctx) {
      const refusal = await guard(ctx);
      if (refusal) return refusal;

      const phone = input?.phone;
      /* `!phone` accepted "   ", which cost a billable lookup on a string of
         spaces; the PHP twin trimmed and this did not. */
      if (!phone || typeof phone !== 'string' || phone.trim() === '') {
        return { status: 400, body: { error: 'INVALID_PAYLOAD', message: 'phone is required' } };
      }
      /* The cap lives here as well as in the client because this is the
         public edge. Express bounded the body at 32 KB, Fastify at 1 MiB, and
         Next and Nuxt not at all — so on a Next store one authorised session
         could push 30 MB through as a "phone number", burning a billable
         lookup and the merchant's egress on every request. One rule in the
         shared file, rather than four adapters disagreeing. */
      if (phone.length > MAX_PHONE_LENGTH) {
        return {
          status: 400,
          body: { error: 'INVALID_PAYLOAD', message: `phone is longer than ${MAX_PHONE_LENGTH} characters` },
        };
      }
      try {
        return { status: 200, body: forBrowser(await client.check(phone)) };
      } catch (e) {
        return translateError(e, log);
      }
    },

    async outcome(input, ctx) {
      const refusal = await guard(ctx);
      if (refusal) return refusal;
      try {
        /* The client validates these now, and throws INVALID_PAYLOAD rather
           than putting an array or a 10 MB string on the wire. Nothing to
           duplicate here — translateError already renders that as a 400. */
        const r = await client.reportOutcome({
          phone: input?.phone,
          orderId: input?.orderId,
          outcomeType: input?.outcomeType,
          orderTotal: input?.orderTotal,
          currency: input?.currency,
          region: input?.region,
          note: input?.note,
        });
        return { status: 200, body: { recorded: r.recorded, idempotent: r.idempotent } };
      } catch (e) {
        return translateError(e, log);
      }
    },

    /**
     * Verify a webhook. `rawBody` must be the exact bytes; every adapter is
     * responsible for getting them, because every framework loses them in a
     * different way.
     *
     * Returns `{ status, body, event }` — `event` is present only on success,
     * and the adapter is expected to acknowledge BEFORE running the
     * merchant's handler, since Numra retries on a non-2xx and a slow handler
     * would otherwise become duplicate deliveries.
     */
    webhook(rawBody, headers) {
      if (!webhookSecret) {
        return { status: 404, body: { error: 'NOT_FOUND' } };
      }
      const isRaw =
        typeof rawBody === 'string' ||
        (typeof Buffer !== 'undefined' && Buffer.isBuffer(rawBody)) ||
        rawBody instanceof Uint8Array;

      /* An empty body is unauthentic, not a misconfiguration.
         ─────────────────────────────────────────────────────────────────
         Anyone can send `Content-Length: 0`, and answering that with a 500
         plus a log line accusing the merchant's own setup is a way to make
         someone disable webhook verification — the outcome this whole file
         exists to prevent. 400, no log, no alarm.

         The PHP twin needs one extra distinction here that Node does not: a
         form-encoded POST is consumed into $_POST before any of our code
         runs, so there an empty body with a form Content-Type really is the
         bytes being gone. See Handlers::looksConsumedByPhp. */
      if (isRaw && rawBody.length === 0) {
        return { status: 400, body: { error: 'missing_signature', message: 'Empty request body.' } };
      }

      if (!isRaw) {
        /* NOT a 400. "Invalid signature" reads as "Numra sent a bad webhook"
           and ends with someone disabling verification; this accuses the
           configuration, which is what is actually wrong. */
        log(
          '[numra] Cannot verify this webhook: the raw body was already consumed.\n' +
          '        A body parser ran before this route, so the exact bytes are gone.\n' +
          '        See your framework package\'s README for the two supported setups.',
        );
        return {
          status: 500,
          body: {
            error: 'NUMRA_RAW_BODY_UNAVAILABLE',
            message: 'A body parser consumed the request before signature verification. See the server log.',
          },
        };
      }

      try {
        const event = verifyWebhook(rawBody, headers, webhookSecret);
        return { status: 200, body: { ok: true }, event };
      } catch (e) {
        if (e instanceof WebhookVerificationError) {
          /* 400, not 401: an unauthentic sender has no credential to fix, and
             401 invites a retry storm. */
          return { status: 400, body: { error: e.reason, message: e.message } };
        }
        return translateError(e, log);
      }
    },
  };
}
