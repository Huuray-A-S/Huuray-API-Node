# Contributing

Thanks for taking the time. Bug reports, documentation fixes and pull requests are all welcome.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting set up

```bash
git clone https://github.com/Huuray-A-S/Huuray-API-Node.git
cd huuray-node
npm install
npm test
```

`npm test` runs code generation first, then the suite. No test touches the network.

| Command | What it does |
|---|---|
| `npm test` | generate types, then run every test |
| `npm run typecheck` | generate types, then `tsc --noEmit` |
| `npm run build` | generate types, then compile to `dist/` |
| `npm run codegen` | regenerate `src/types.gen.ts` from the vendored spec |
| `npm run spec:fetch` | re-download the live spec over `openapi/huuray-v4.json` |

## Spec fidelity — read this before adding anything

**This client exposes nothing the API does not document.** It is the rule the whole library is built on, and it is enforced by tests rather than by review.

In practice:

1. **Never send a field the spec does not define.** Not "just in case", not because another endpoint accepts it.
2. **Never call a path or verb the spec does not define.**
3. **Never depend on undocumented behaviour** — an undocumented status code, an undocumented header, an undocumented error shape. If the specification is silent, we confirm with Huuray before implementing. An unanswered question blocks the feature; it does not get a best guess.
4. **Field names mirror the spec, differing only in casing.** `OrderUID` becomes `orderUid`. It does not become `orderId`, `uid`, or anything more tasteful. Someone reading the Huuray API reference must be able to map it across without a translation table.
5. **Convenience methods are allowed, but only as a documented composition of real operations.** `sendReward()` is fine: it is exactly one `POST /v4/Order`, and its documentation says so.

Three tests in [`test/conformance.test.ts`](../test/conformance.test.ts) enforce this:

- **no-invention** — every request the SDK can emit maps to a path and verb in the spec, and sends no undefined property
- **coverage** — every operation in the spec has a method
- **request-conformance** — every request body validates against the spec schema

They work by calling every public method with every optional parameter populated, then checking what came out. **If you add a method, add it to `exerciseEverything()`** or the coverage gate will not see it.

## Generated code

`src/types.gen.ts` is generated from `openapi/huuray-v4.json`. Never edit it by hand. If a type is wrong there, the spec is wrong — raise it, do not patch around it.

The spec itself is vendored deliberately. A scheduled workflow re-downloads it weekly and opens a pull request if it changed, which is how we find out about API changes.

## Tests

- **No live API calls, ever.** Ordering gift cards from a test runner spends real money. Inject a fake via the client's `fetch` option; `test/helpers.ts` has one ready.
- **Fixtures contain invented data only.** Never record a real response.
- New behaviour needs a test that fails without your change.

## Money and value — extra care

Some of this library moves real money. Changes in these areas get closer review, and pull requests that weaken a guard will be asked to justify it:

- **Never add automatic retries to `/v4/Order`, `/v4/Resend` or `/v4/Cancel`.** There is no idempotency key. A retried order orders twice; a retried resend re-delivers a live gift card.
- **Never widen the CLI to move value.** It is read-only on purpose.
- **Never log a voucher code**, at any level, in any code path.
- **Keep amounts as integers in minor units.** No floats, no silent rounding.

## Pull requests

1. Branch from `main`.
2. Keep the change focused — one concern per pull request.
3. Make sure `npm run typecheck` and `npm test` both pass.
4. Describe what changed and why. If it touches ordering, say what you did about the points above.

## Reporting a bug

[Open an issue.](https://github.com/Huuray-A-S/Huuray-API-Node/issues) Include the SDK version, your Node version, what you called, what you expected, and what happened.

**Never paste an API token, an API secret, or a voucher code into an issue.** For a vulnerability, see [SECURITY.md](SECURITY.md) instead.

## What belongs somewhere else

Questions about the API itself, your account, pricing, or a live production problem go to your Huuray representative rather than here — see [SUPPORT.md](SUPPORT.md). We cannot resolve those from a GitHub issue.
