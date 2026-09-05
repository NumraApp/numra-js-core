# Contributing to @numra/core

Patches are welcome. This is a small package with a large blast radius — it
holds a credential that reads a shared fraud ledger and spends a merchant's
paid quota — so the bar for a change is a test that would have caught the bug,
not a convincing description of it.

## Running the tests

```bash
npm install
npm test
```

Node 22.12 or newer, as `engines` declares. The suite is the built-in
`node:test` runner and there is nothing else to install: `test/mock-server.js`
stands in for the API, so the tests never touch the network and never need a
key.

## Every change needs a test

Every package in this family ships a regression suite, and it is the only
thing standing between a refactor and a silent behavioural change. So:

- A bug fix comes with a test that fails before it and passes after.
- A new option or field comes with a test that exercises it.
- A change to existing behaviour comes with the changed assertion, and the
  reason for the change in the commit message.

`test/hardening.test.js` and `test/handler-hardening.test.js` in particular
encode decisions that look arbitrary until you know the incident behind them —
deny-by-default in `createHandlers`, the browser refusal in the constructor,
`QUOTA_EXCEEDED` never being retried. If a change makes one of those fail,
the fix is almost never to relax the test.

## Which repository your fix belongs in

These repositories are split out of a single monorepo. What you see here is
one package of twelve, and this one is the shared floor for the JavaScript
server side: `@numra/express`, `@numra/fastify`, `@numra/next` and
`@numra/nuxt` are thin adapters over `createHandlers` in `src/server.js`.

So:

- Behaviour common to all four framework packages — authorisation, what the
  browser is allowed to see, how an upstream failure is translated — belongs
  **here**, not in the adapter you noticed it in.
- Anything framework-shaped — a parser, a route signature, a response object —
  belongs in that framework's repository.
- `Numra\Handlers` in [numra-php](https://github.com/NumraApp/numra-php) is
  the PHP twin of `createHandlers`. A change to what either one decides needs
  the same change in the other, or the two backends stop agreeing about the
  same phone number.

A fix that lands here reaches the framework packages as a version bump, so say
in the pull request which of them you expect to need re-releasing.

## The conformance gate

```bash
node scripts/openapi-conformance.js
```

This checks the package against the API contract and against itself — that
`VERSION` in `src/client.js` and the version in `package.json` still agree,
among other things. It fails by default when no contract is vendored, on
purpose: a conformance step that goes green having compared nothing
manufactures exactly the assurance it exists to provide. Point `NUMRA_OPENAPI`
at a copy of the spec, or drop it at one of the paths the script lists, to
make it run for real.

## House style

British spelling, no emoji in headings, and prose that says what a thing does
rather than how good it is. Comments explain the decision, not the syntax.

## Reporting a bug

Open an issue with the package version, the Node version, and the smallest
reproduction you can manage. **A security vulnerability is not a bug report**
— see [SECURITY.md](SECURITY.md) and mail it privately instead.
