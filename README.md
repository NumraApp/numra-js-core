# @getnumra/core

**Check a buyer's phone number before you ship a cash-on-delivery order, and report back what happened.**

[![npm version](https://img.shields.io/npm/v/@getnumra/core)](https://www.npmjs.com/package/@getnumra/core) [![npm downloads](https://img.shields.io/npm/dm/@getnumra/core)](https://www.npmjs.com/package/@getnumra/core) [![licence: MIT](https://img.shields.io/npm/l/@getnumra/core)](LICENSE)

Numra API client — phone risk signals for cash-on-delivery orders in Morocco.

Zero dependencies. Ships as plain ESM, no build step, so what is on npm is
what is in the repo.

```bash
npm install @getnumra/core
```

## Server-side only

**This package refuses to run in a browser, and the constructor enforces it.**

Numra reads a shared fraud ledger. An API key in a JavaScript bundle is
readable by anyone who opens dev tools, so there is no publishable key and no
browser build. The split:

| You are writing | Use |
|---|---|
| A backend | `@getnumra/core`, or the framework wrapper for it |
| Express / Fastify / Next / Nuxt route | `@getnumra/express`, `@getnumra/fastify`, `@getnumra/next`, `@getnumra/nuxt` |
| A React / Vue / Angular / Svelte page | `@getnumra/react` etc — they call **your** backend, never Numra |

Keep the key in the environment and out of version control. A key committed
once is a key in the history of every clone and fork of that repository, and
rotating it is the only fix.

## Checking a number

```js
import { Numra } from '@getnumra/core';

const numra = new Numra({ apiKey: process.env.NUMRA_API_KEY });

const check = await numra.check('0600000000');

if (check.isBlacklisted || check.riskLevel === 'CRITICAL') {
  hold(order);
}
```

Any Moroccan spelling works — `0600000000`, `+212600000000`, `00212…`, spaced
or dashed. Do not normalise it yourself.

### Reading the result properly

`riskScore` alone **cannot tell a checked-and-clean customer from a complete
stranger** — both come back low. On a cash-on-delivery store most buyers are
new, so this matters:

```js
if (!check.isRated) {
  // No history at all. Not a clean bill of health — just no evidence.
} else if (check.trustScore > 70) {
  // Actually vouched for.
}
```

`trustScore` already encodes the distinction: it sits at a neutral 50 with
`confidence: 0` for an unknown number, and moves as evidence arrives.

Render decisions from `verdict` and `verdictSource` rather than re-deriving a
conclusion from the raw flags — that is what stops your UI and Numra's
disagreeing about the same number.

## Reporting outcomes

The half that gets skipped, and the half that makes the ledger worth reading.
A merchant who only calls `check` is querying a database they never write to.

```js
await numra.reportOutcome({
  phone: order.phone,
  orderId: order.id,          // half the idempotency key
  outcomeType: 'REFUSED_COD',
  orderTotal: 349,
  currency: 'MAD',
});
```

Idempotent on `(merchant, orderId, outcomeType)` — safe to call from a webhook
that fires twice. Check `recorded`, not just success: it is `false` both for a
replay and for a number that is no longer tracked, and `message` says which.

## Verifying webhooks

```js
import { verifyWebhook } from '@getnumra/core';

// Mounted before any app-wide express.json(). A parser that has already run
// leaves req.body a parsed object and the exact bytes gone.
app.post('/numra/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = verifyWebhook(req.body, req.headers, process.env.NUMRA_WEBHOOK_SECRET);
  } catch {
    // Catch it. An uncaught throw is a 500, and Numra retries a 5xx — so one
    // forged or expired delivery becomes an indefinite retry storm instead of
    // the terminal rejection a 400 gives it.
    return res.sendStatus(400);
  }

  res.sendStatus(200);              // acknowledge first
  if (!alreadySeen(event.id)) {     // then the slow part
    queue.add(event);
  }
});
```

`req.body` must be the **raw bytes**. A re-serialised object never matches —
`JSON.stringify(JSON.parse(x))` is not `x` — and this function throws
`body_not_raw` rather than letting you conclude that verification is broken.

Verification is constant-time and rejects replays outside a 300-second window.
De-duplicate on `event.id`; retries reuse it.

## Rate-limit the endpoint you put in front of this

An `authorize` function decides *who* may spend your quota. It does not decide
*how much*, and on a public checkout the two are not the same question: the
guard there is usually a session that owns a cart, which any visitor can get by
loading the page. One session in a loop is then a bill.

So put a limit on the route as well, keyed per IP or per session, before it
reaches the client. `@getnumra/express`, `@getnumra/fastify`, `@getnumra/next` and
`@getnumra/nuxt` each show the idiomatic way to do it in that framework.

## Errors

Switch on `code`. `message` is written for humans and changes without notice.

```js
import { NumraError } from '@getnumra/core';

try {
  await numra.check(phone);
} catch (e) {
  if (e instanceof NumraError) {
    if (e.isAuthError) alertOps(e);          // retrying will never help
    else if (e.isQuotaError) shipAnyway();    // clears at midnight
    else if (e.retryable) queueForLater();
  }
}
```

`NETWORK_ERROR` means nobody answered — distinct from every API code, which
mean Numra said no. When you are deciding whether to ship a parcel anyway,
that difference is the whole question.

### When Numra is unreachable

**This client neither fails open nor fails closed. It throws, and you decide.**

There is no default here on purpose: a fraud signal that quietly returns "looks
fine" during an outage is worse than no signal, and one that blocks checkout
turns our downtime into your lost orders. Only you know which of those your
business can absorb.

So decide it now, in code, rather than at 3am. The branches above are the
decision: `shipAnyway()` for an exhausted quota, `queueForLater()` for
something transient. A `NETWORK_ERROR` or `TIMEOUT` needs the same explicit
answer — most cash-on-delivery merchants take the order and re-check it before
dispatch, which keeps the till open without shipping blind.

## Retries

Transient failures (5xx, network, timeout, `RATE_LIMITED`) are retried twice
by default with exponential backoff and full jitter. `Retry-After` wins when
the server sends one.

`QUOTA_EXCEEDED` is **never** retried, even though it arrives as a 429 — the
quota resets at midnight, and retrying turns one exhausted day into sustained
hammering.

## Options

```js
new Numra({
  apiKey: '…',                    // required; licence key or API key
  baseUrl: 'https://api.numra.ma',
  timeout: 10_000,
  maxRetries: 2,
  integration: 'my-app/1.0.0',    // appended to the User-Agent
});
```

## Release notes

Every release is tagged and written up on the
[Releases page](https://github.com/NumraApp/numra-js-core/releases). The same
history in one file is in [CHANGELOG.md](CHANGELOG.md).

## Contributing

Bug reports and patches are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
running the tests, the regression test a change is expected to bring with it,
and which repository a given fix actually belongs in.

## Security

Vulnerabilities go privately to the address in [SECURITY.md](SECURITY.md).
**Do not open a public issue for a security problem** — this package holds a
credential that reads a shared fraud ledger, and a public report is a working
exploit for every merchant using it until a fix ships.

## The rest of the family

Twelve packages, one contract. The server side holds the API key; the browser
side calls the endpoint the server side mounts.

Server:

| Package | Repository |
|---|---|
| `@getnumra/core` | [numra-js-core](https://github.com/NumraApp/numra-js-core) — this repo |
| `@getnumra/express` | [numra-express](https://github.com/NumraApp/numra-express) |
| `@getnumra/fastify` | [numra-fastify](https://github.com/NumraApp/numra-fastify) |
| `@getnumra/next` | [numra-next](https://github.com/NumraApp/numra-next) |
| `@getnumra/nuxt` | [numra-nuxt](https://github.com/NumraApp/numra-nuxt) |
| `numra/numra-php` | [numra-php](https://github.com/NumraApp/numra-php) |
| `numra/laravel` | [numra-laravel](https://github.com/NumraApp/numra-laravel) |

Browser:

| Package | Repository |
|---|---|
| `@getnumra/browser` | [numra-browser](https://github.com/NumraApp/numra-browser) |
| `@getnumra/react` | [numra-react](https://github.com/NumraApp/numra-react) |
| `@getnumra/vue` | [numra-vue](https://github.com/NumraApp/numra-vue) |
| `@getnumra/svelte` | [numra-svelte](https://github.com/NumraApp/numra-svelte) |
| `@getnumra/angular` | [numra-angular](https://github.com/NumraApp/numra-angular) |

Documentation for all of them is at [numra.ma/docs](https://numra.ma/docs).

## Licence

MIT
