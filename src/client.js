import { NumraError } from './errors.js';

/* ═══════════════════════════════════════════════════════════════════════════
   @getnumra/core — the reference client
   ───────────────────────────────────────────────────────────────────────────
   SERVER-SIDE ONLY, and the constructor enforces it.

   This is a shared fraud ledger: a key in a bundle is a key in everyone's
   hands. The check lives in the constructor rather than in the README because
   a warning in a README has never once stopped anyone.

   Browser packages (@getnumra/react and friends) call the merchant's own
   endpoint. Server packages (@getnumra/express and friends) are that endpoint
   and hold this client.

   ── No dependencies, and no build ─────────────────────────────────────────
   The only import in the whole package is node:crypto. Plain ESM, published
   as written, so what is on npm is what is in the repo — nothing is minified
   between the two. A fraud client that drags a tree of transitive packages
   into a merchant's checkout is a supply-chain surface nobody asked for, and
   ten more repos each with their own bundler config is ten more things to
   keep in step.
   ═══════════════════════════════════════════════════════════════════════════ */

export const VERSION = '1.0.0';

/* QUOTA_EXCEEDED is separated from RATE_LIMITED deliberately: one clears in a
   minute and the other at midnight, and a caller's backoff should not treat
   them alike. */
const KNOWN_API_CODES = [
  'LICENSE_MISSING', 'LICENSE_INVALID', 'LICENSE_EXPIRED', 'LICENSE_BOUND',
  'COUNTRY_NOT_ALLOWED', 'INVALID_PAYLOAD', 'ENDPOINT_NOT_FOUND',
  'RATE_LIMITED', 'QUOTA_EXCEEDED',
];

function classify(status, code) {
  if (code && KNOWN_API_CODES.includes(code)) return code;
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  if (status === 401 || status === 403) return 'LICENSE_INVALID';
  if (status === 404) return 'ENDPOINT_NOT_FOUND';
  /* Anything else in the 3xx/4xx range is OUR fault, not the server's, and
     the distinction is not cosmetic: SERVER_ERROR is retryable. Classifying a
     404 from a typo'd baseUrl as a server fault meant every checkout spent
     the whole retry budget — three requests and thirty seconds — re-asking a
     question that could never succeed, and then told the merchant Numra was
     down. A 4xx is answered once and reported as what it is. */
  if (status >= 300 && status < 500) return 'INVALID_PAYLOAD';
  return 'SERVER_ERROR';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* An upper bound on how long a server may park us.
   ───────────────────────────────────────────────────────────────────────────
   `Retry-After` was previously honoured verbatim, and it is read for every
   error status rather than only 429. A rate limiter answering `Retry-After:
   86400` under load — entirely ordinary behaviour — therefore put a 24-hour
   sleep inside a checkout. In PHP that is a blocking usleep in an FPM worker,
   and `max_execution_time` does not count sleep, so a few hundred orders take
   the whole store offline rather than just the fraud check.

   The server still wins over our own backoff, up to this ceiling. Past it,
   the honest answer is to fail now and let the merchant decide. */
const MAX_BACKOFF_MS = 20_000;

/* A Moroccan number is ten digits. This is generous enough for any spelling
   anyone writes — +212, spaces, dashes, a leading 00 — and small enough that
   nothing can be smuggled through the field. */
export const MAX_PHONE_LENGTH = 32;

/* `{}` and not an array. A JSON body of `[]`, `"ok"`, `0` or `null` all parse
   without throwing, and every one of them used to be accepted as a result. */
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v, name, max, hint = '') {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new NumraError('INVALID_PAYLOAD', `reportOutcome requires ${name} as a non-empty string${hint}.`);
  }
  if (v.length > max) {
    throw new NumraError('INVALID_PAYLOAD', `reportOutcome: ${name} is longer than ${max} characters.`);
  }
}

function optStr(v, name, max) {
  if (v == null) return;
  str(v, name, max);
}

export class Numra {
  #apiKey;
  #baseUrl;
  #timeout;
  #maxRetries;
  #fetch;
  #ua;

  constructor(options = {}) {
    if (!options.apiKey || typeof options.apiKey !== 'string') {
      throw new NumraError('LICENSE_MISSING', 'A Numra API key is required: new Numra({ apiKey }).');
    }

    /* The check that matters most in this file.
       ─────────────────────────────────────────────────────────────────
       Tests `document` AND `window`, not `typeof window` alone: workers and
       some edge runtimes define a window-like global without being a page,
       and running server code in a Cloudflare Worker is legitimate. A real
       DOM is not. */
    const g = globalThis;
    if (typeof g.document !== 'undefined' && typeof g.window !== 'undefined') {
      throw new NumraError(
        'LICENSE_INVALID',
        '@getnumra/core must never run in a browser — an API key in a bundle is readable by anyone who opens dev tools, and this key reads a shared fraud database. ' +
        'Call your own backend from the browser instead: mount @getnumra/express (or fastify / next / nuxt / laravel) and use @getnumra/react (or vue / angular / svelte) on the page.',
      );
    }

    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? 'https://api.numra.ma').replace(/\/+$/, '');
    this.#timeout = options.timeout ?? 10_000;
    this.#maxRetries = options.maxRetries ?? 2;

    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new NumraError('NETWORK_ERROR', 'No fetch implementation found. Node 18+ has one built in; otherwise pass `fetch` in the options.');
    }
    this.#fetch = f;

    /* Sent on every request so we can report which SDK versions are actually
       live in the field, rather than which ones we published. Nothing
       identifying goes in it — package, version, integration and runtime. */
    const rt = typeof process !== 'undefined' && process.version ? `node/${process.version.slice(1)}` : 'js';
    this.#ua = `numra-js/${VERSION}${options.integration ? ` ${options.integration}` : ''} ${rt}`;
  }

  async #request(path, body, attempt = 0, callerSignal = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);

    /* The caller's own cancellation, composed rather than ignored. When the
       shopper closes the tab the framework aborts the inbound request; before
       this the client carried on, retries and all, spending quota on an
       answer nobody would read. */
    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const done = () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    };

    let res;
    try {
      res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
          /* Required by the API. Morocco is the only market served, and the
             API refuses rather than returning empty results for anywhere
             else — openapi.yaml explains why that refusal is deliberate. */
          'X-Country': 'MA',
          'User-Agent': this.#ua,
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
    } catch (cause) {
      done();
      /* The caller's abort is not a timeout and must not be retried — they
         asked us to stop. */
      if (callerSignal?.aborted) {
        throw new NumraError('CANCELLED', 'The caller aborted this request.', { cause });
      }
      const aborted = cause?.name === 'AbortError';
      const err = new NumraError(
        aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
        aborted
          ? `Numra did not answer within ${this.#timeout}ms.`
          : `Could not reach Numra: ${cause?.message ?? 'unknown network error'}`,
        { cause },
      );
      if (attempt < this.#maxRetries) return this.#retry(path, body, attempt, err, callerSignal);
      throw err;
    }

    const requestId = res.headers.get('x-request-id');
    let json = null;
    let parseFailed = false;
    /* The timer stays armed across the body read.
       ─────────────────────────────────────────────────────────────────────
       `fetch()` resolves on HEADERS, not on the body. Clearing the timeout
       here — which is what this line used to do — left the whole `res.json()`
       with no deadline and no signal, so a server that sent headers and then
       stalled hung the promise for ever and leaked the socket with it. That
       is reachable from any proxy on the path, not only a hostile server. */
    try {
      json = await res.json();
    } catch {
      /* A body we cannot parse is a server problem, not a caller problem —
         but it is a problem, and it used to be swallowed. See below. */
      parseFailed = true;
    } finally {
      done();
    }

    /* A 2xx whose body is not a JSON object is a SERVER_ERROR, not a result.
       ─────────────────────────────────────────────────────────────────────
       This used to `return json` regardless, so a captive portal's HTML
       interstitial, a 204, or a truncated response came back as an empty
       result — and `check()` then read `.phone` off null and threw a raw
       TypeError that escaped every documented `instanceof NumraError` handler.
       The PHP twin had the same root cause with a worse symptom: it returned
       an empty array, which defaulted to verdict UNRATED, score 0, not
       blacklisted. A blacklisted number came back clean, silently.

       `errors.js` already documents SERVER_ERROR as "a 5xx, or a body we
       could not parse". This is the code catching up with the comment. */
    if (res.ok && !parseFailed && isPlainObject(json) && json.ok !== false) return json;

    if (res.ok && (parseFailed || !isPlainObject(json))) {
      /* Now that the timer covers the body read, a stalled body aborts here
         rather than hanging — and the caller must be told it was slow, not
         that it sent garbage. Both are retryable, but only one of them means
         "raise your timeout". */
      if (callerSignal?.aborted) {
        throw new NumraError('CANCELLED', 'The caller aborted this request.');
      }
      const timedOut = controller.signal.aborted;
      const err = timedOut
        ? new NumraError('TIMEOUT', `Numra did not finish answering within ${this.#timeout}ms.`, { status: res.status, requestId })
        : new NumraError(
            'SERVER_ERROR',
            `Numra answered ${res.status} but the body was not a JSON object. Treating it as a failed lookup rather than an empty result.`,
            { status: res.status, requestId },
          );
      if (attempt < this.#maxRetries) return this.#retry(path, body, attempt, err, callerSignal);
      throw err;
    }

    const code = classify(res.status, json?.error);
    /* Only a finite, non-negative number counts.
       ─────────────────────────────────────────────────────────────────────
       RFC 9110 also allows an HTTP-date here, and `Number("Wed, 21 Oct 2026
       ...")` is NaN. `NaN != null` is true, so the old code took the
       Retry-After branch and called `setTimeout(r, NaN)` — which fires
       immediately. The one response designed to slow a client down made it
       hammer as fast as the event loop allowed. A negative value did the
       same. PHP guarded this correctly with is_numeric; JS did not. */
    const rawRetryAfter = Number(res.headers.get('retry-after'));
    const retryAfter = Number.isFinite(rawRetryAfter) && rawRetryAfter >= 0 ? rawRetryAfter : null;
    const err = new NumraError(code, json?.message ?? `Numra returned ${res.status}.`, {
      status: res.status,
      requestId,
      retryAfter,
      docsUrl: typeof json?.docs_url === 'string' ? json.docs_url : null,
      body: json,
    });

    /* QUOTA_EXCEEDED is NOT retried even though it arrives as a 429. The
       quota resets at midnight; retrying inside the request turns one
       exhausted day into sustained hammering and never gets an answer. */
    if (err.retryable && err.code !== 'QUOTA_EXCEEDED' && attempt < this.#maxRetries) {
      return this.#retry(path, body, attempt, err, callerSignal);
    }
    throw err;
  }

  async #retry(path, body, attempt, err, callerSignal = null) {
    /* Exponential backoff with full jitter. Without jitter every store that
       hit the same blip retries in lockstep and re-creates it. Retry-After
       wins when the server sent one — it knows more than we do — but only up
       to MAX_BACKOFF_MS, and it gets jitter too.

       Jitter on this branch is the case that most needed it and was the one
       missing it: every client rate-limited in the same window received the
       IDENTICAL Retry-After and would have retried at the identical instant.
       The stampede reasoning was applied where clients already differ and
       skipped where they are guaranteed to agree. */
    /* Two different kinds of wait, and they must be jittered differently.

       When the server sent Retry-After it gave an instruction, and jitter may
       only ADD to it — full jitter multiplies by 0.5–1.5, so it would have us
       come back BEFORE the server said to, which is the one thing that header
       exists to prevent. A second of spread is enough to decorrelate a fleet
       that all received the identical value.

       Our own curve has no instruction to respect, so it takes full jitter.

       Either way the clamp goes last: capping before the jitter still let a
       20 s ceiling sleep for 30 s. */
    const backoff = err.retryAfter != null
      ? Math.round(Math.max(0, err.retryAfter) * 1000 + Math.random() * 1000)
      : Math.round(2 ** attempt * 250 * (0.5 + Math.random()));
    await sleep(Math.min(backoff, MAX_BACKOFF_MS));
    if (callerSignal?.aborted) {
      throw new NumraError('CANCELLED', 'The caller aborted this request.');
    }
    return this.#request(path, body, attempt + 1, callerSignal);
  }

  /**
   * Check a phone number before you ship.
   *
   *   const check = await numra.check('0600000000');
   *   if (check.isBlacklisted || check.riskLevel === 'CRITICAL') hold(order);
   *
   * Reading the result: `riskScore` alone cannot tell a checked-and-clean
   * customer from a complete stranger — both come back low. Use `isRated`
   * and `confidence`, or `trustScore`, which already encodes the difference.
   *
   * @param {string} phone  any Moroccan spelling; the API normalises it
   * @param {{ eventType?: string, includeTimeline?: boolean, context?: object, signal?: AbortSignal }} [options]
   */
  async check(phone, options = {}) {
    if (!phone || typeof phone !== 'string' || phone.trim() === '') {
      throw new NumraError('INVALID_PAYLOAD', 'check(phone) requires a phone number.');
    }
    /* A hard cap, checked before anything is sent.
       ─────────────────────────────────────────────────────────────────────
       No adapter bounded this, and the ones that did bound it disagreed: 32 KB
       on Express, 1 MiB on Fastify, unlimited on Next and Nuxt. A single
       authorised session could therefore push a 30 MB "phone number" through
       a Next store — one billable lookup and 30 MB of the merchant's egress
       per request. A Moroccan number is ten digits; nothing legitimate is
       near this. */
    if (phone.length > MAX_PHONE_LENGTH) {
      throw new NumraError(
        'INVALID_PAYLOAD',
        `check(phone) received ${phone.length} characters. A phone number is not longer than ${MAX_PHONE_LENGTH}.`,
      );
    }
    const c = options.context;
    const r = await this.#request('/v1/phone/lookup', {
      phone,
      event_type: options.eventType,
      include_timeline: options.includeTimeline,
      context: c && {
        payment_method: c.paymentMethod,
        order_total: c.orderTotal,
        currency: c.currency,
        region: c.region,
        note: c.note,
      },
    }, 0, options.signal ?? null);

    return {
      phone: r.phone,
      country: 'MA',
      carrier: { code: r.carrier?.code ?? null, label: r.carrier?.label ?? 'Unknown' },
      verdict: r.verdict,
      verdictSource: r.verdict_source,
      riskScore: r.risk_score,
      riskLevel: r.risk_level,
      /* `?? 0` like every sibling field. Without it an absent `trust_score`
         became NaN, which `JSON.stringify` writes as null — so a partial
         response reached the storefront with the one field that encodes
         "checked and clean vs complete stranger" silently empty. */
      trustScore: Number(r.trust_score ?? 0),
      confidence: Number(r.confidence ?? 0),
      isRated: Boolean(r.is_rated),
      totalEvents: Number(r.total_events ?? 0),
      customerStyle: r.customer_style
        ? {
            code: r.customer_style.code,
            label: r.customer_style.label,
            icon: r.customer_style.icon,
            color: r.customer_style.color,
            riskSensitivity: r.customer_style.risk_sensitivity,
          }
        : null,
      isBlacklisted: Boolean(r.is_blacklisted),
      blacklistedReason: r.blacklisted_reason ?? null,
      lastRiskUpdateAt: r.last_risk_update_at ?? null,
      cacheTtlSeconds: Number(r.cache_ttl_seconds ?? 0),
      timeline: Array.isArray(r.timeline)
        ? r.timeline.map((t) => ({
            eventType: t.event_type,
            orderTotal: t.order_total ?? null,
            currency: t.currency ?? null,
            region: t.region ?? null,
            note: t.note ?? null,
            siteUrl: t.site_url ?? null,
            createdAt: t.created_at,
          }))
        : null,
      /* The untouched response, so a field we add server-side is reachable
         without waiting for an SDK release. */
      raw: r,
    };
  }

  /**
   * Report what happened to an order. This is the half that gets skipped, and
   * the half that makes the ledger worth reading — a merchant who only calls
   * `check` is querying a database they never write to.
   *
   * Idempotent on (merchant, orderId, outcomeType): calling it twice is safe
   * and returns `recorded: false, idempotent: true` the second time.
   *
   * @param {{ phone: string, orderId: string, outcomeType: string,
   *           orderTotal?: number, currency?: string, region?: string,
   *           note?: string, signal?: AbortSignal }} input
   */
  async reportOutcome(input = {}) {
    /* `check()` insisted on a string and this insisted on truthiness, so an
       array or a nested object reached the wire — and the PHP twin's
       `(string)` cast wrote the literal word "Array" into the ledger.
       `orderId` is half the idempotency key, so a non-string there poisons
       idempotency for that merchant. The documented contract says these are
       strings; this is where that starts being true. */
    str(input.phone, 'phone', MAX_PHONE_LENGTH);
    str(input.orderId, 'orderId', 200, ' — it is half the idempotency key');
    str(input.outcomeType, 'outcomeType', 64);
    optStr(input.currency, 'currency', 8);
    optStr(input.region, 'region', 120);
    optStr(input.note, 'note', 500);
    if (input.orderTotal != null && !Number.isFinite(Number(input.orderTotal))) {
      throw new NumraError('INVALID_PAYLOAD', 'reportOutcome: orderTotal must be a number.');
    }

    const r = await this.#request('/v1/phone/outcome', {
      phone: input.phone,
      order_id: input.orderId,
      outcome_type: input.outcomeType,
      order_total: input.orderTotal,
      currency: input.currency,
      region: input.region,
      note: input.note,
    }, 0, input.signal ?? null);

    return {
      /* False for an idempotent replay AND for a number that is no longer
         tracked — `message` distinguishes them. Do not read success alone as
         "it landed". */
      recorded: Boolean(r.recorded),
      idempotent: Boolean(r.idempotent),
      phone: r.phone,
      orderId: r.order_id,
      outcomeType: r.outcome_type,
      message: r.message ?? null,
    };
  }

  /**
   * Credential status and remaining quota — for a settings screen or a
   * start-up check. Not required before `check()`, which authorises itself;
   * calling it first only doubles the round trips.
   */
  async verifyLicense() {
    const r = await this.#request('/v1/license/verify', {});
    return {
      status: r.license_status,
      plan: r.plan,
      country: 'MA',
      /* Passed through as null, never coerced. `daily_limit: null` means
         unlimited; turning it into 0 says exactly the opposite. */
      dailyLimit: r.daily_limit ?? null,
      dailyUsed: Number(r.daily_used ?? 0),
      unlimited: Boolean(r.unlimited),
      expiresAt: r.expires_at ?? null,
      renewUrl: r.renew_url,
    };
  }
}
