
# huuray

#### Easily send gift cards and rewards from Node.js

<!-- badges: start -->
[![CI](https://github.com/ronniegasseholm-prog/huuray-node/actions/workflows/ci.yml/badge.svg)](https://github.com/ronniegasseholm-prog/huuray-node/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/huuray.svg?color=45652a)](https://www.npmjs.com/package/huuray)
[![License: MIT](https://img.shields.io/badge/license-MIT-45652a.svg)](LICENSE)
[![API v4](https://img.shields.io/badge/Huuray%20API-v4-9dcf73.svg)](https://api.huuray.com/swagger/index.html)
[![Sign up](https://img.shields.io/badge/Huuray-sign%20up-ff5c43.svg)](https://huuray.com/sign-up/)
<!-- badges: end -->

[Huuray](https://huuray.com) is a platform for sending digital gift cards and rewards to recipients in 170+ countries. `huuray` is the official, slightly-opinionated Node.js and TypeScript client for the **Huuray API v4** — with, dare we say, *hurray*-worthy defaults for the parts of a rewards API that are easy to get wrong.

Use it to send employee recognition, customer incentives, survey payouts, referral bonuses, or research participant compensation — without anyone opening a dashboard.

<br clear="right"/>

```ts
import { HuurayClient } from 'huuray';

const huuray = new HuurayClient({
  apiToken:  process.env.HUURAY_API_TOKEN!,
  apiSecret: process.env.HUURAY_API_SECRET!,
});

await huuray.sendReward({
  productToken: 'the-product-you-chose',
  value:        50_00,                    // minor units — 50.00
  currency:     'DKK',
  recipient:    { name: 'Jane Doe', email: 'jane@example.com' },
  templateId:   42,
  refId:        'payroll-2026-08-jane',   // your own key
});
```

- **Fully typed**, generated from the Huuray OpenAPI specification, so it cannot drift from the API.
- **Request signing handled** — the nonce and SHA-512 hash every call needs.
- **Safe by default around money** — orders are never automatically retried, because the API has no idempotency key.
- **Zero runtime dependencies.**

---

## Requirements

- **Node 20 or newer.**
- **A Huuray B2B account.** New to Huuray? [Sign up here](https://huuray.com/sign-up/) — it takes a couple of minutes.
- **API credentials** — an API token and secret for your account. Ask your Huuray contact to enable API access if you do not have them yet.

The full API this client wraps is documented at the [Huuray API v4 reference (Swagger)](https://api.huuray.com/swagger/index.html).

## Install

```bash
npm install huuray
```

## Getting started

Start with calls that only read. None of these order anything, deliver anything, or spend anything:

```ts
import { HuurayClient } from 'huuray';

const huuray = new HuurayClient({
  apiToken:  process.env.HUURAY_API_TOKEN!,
  apiSecret: process.env.HUURAY_API_SECRET!,
});

// What can you spend? Amounts are in minor units: 50000 is 500.00.
const { balances } = await huuray.balances.list();

// What can you send? Omitting `all` returns just your products, with tokens.
const { products } = await huuray.catalogue.list();

// How will it be delivered? Templates are the emails and texts recipients get.
const { templates } = await huuray.templates.list();
```

Or from a terminal, without writing any code:

```bash
export HUURAY_API_TOKEN=... HUURAY_API_SECRET=...
npx huuray balance
npx huuray catalogue
```

## Sending a reward

`sendReward()` is one gift card to one recipient — the common case, and exactly one `POST /v4/Order`:

```ts
const reward = await huuray.sendReward({
  productToken: 'the-product-you-chose',
  value:        50_00,
  currency:     'DKK',
  recipient:    { name: 'Jane Doe', email: 'jane@example.com' },
  templateId:   42,
  refId:        'payroll-2026-08-jane',
});

reward.orderUid;  // keep this
```

For anything larger, use the orders resource directly:

```ts
await huuray.orders.create({
  productToken: 'the-product-you-chose',
  value:        25_00,
  currency:     'DKK',
  quantity:     200,
  templateId:   42,
  refId:        'q3-customer-thankyou',
  recipients:   [ /* 1 recipient, or exactly 200 */ ],
});
```

---

## Seven things worth knowing

These are the parts of the API that are easy to get wrong. The client handles each one, but the behaviour is worth understanding.

### 1. Money is in minor units

`value: 50_00` is 50.00, not 5000.00. Passing a major-unit amount into this field orders **1/100th** of what you meant, so the client rejects fractional values rather than rounding:

```ts
await huuray.sendReward({ value: 50.5,  ... });   // throws — fractional
await huuray.sendReward({ value: 50_00, ... });   // 50.00
```

One mixup no runtime guard can catch: in JavaScript `50.00` **is** the integer `50`, so `value: 50.00` compiles, passes the guard, and orders 0.50. Always write amounts as integers in minor units.

### 2. Orders are never retried automatically

`POST /v4/Order` has no idempotency key, so retrying a timed-out order can order a second time — real gift cards, real money. This client never does that. Instead it throws `HuurayIndeterminateOrderError`, and you reconcile:

```ts
import { HuurayIndeterminateOrderError, HuurayNotFoundError } from 'huuray';

try {
  await huuray.sendReward({ refId: 'payroll-2026-08-jane', /* … */ });
} catch (err) {
  if (err instanceof HuurayIndeterminateOrderError) {
    // Do NOT retry. Find out what actually happened.
    try {
      const found = await huuray.orders.search({ refId: 'payroll-2026-08-jane' });
      if (found.orderUid) {
        // It landed. Nothing more to do.
      } else {
        // No match — it did not land. Safe to send again with the same refId.
      }
    } catch (lookup) {
      if (lookup instanceof HuurayNotFoundError) {
        // The API answers 404 when nothing matches: the order did not land.
        // Safe to send again with the same refId.
      } else {
        throw lookup; // the lookup itself failed; the outcome is still unknown
      }
    }
  }
}
```

This is why `sendReward()` requires a `refId` even though the API treats it as optional: without one, an order that times out cannot be looked up.

Reads *are* retried — with backoff, on connection failures and 5xx.

### 3. Synchronous and asynchronous orders are different calls

| | `orders.create()` | `orders.createSync()` |
|---|---|---|
| Sends | `Sync: false` | `Sync: true` |
| Quantity | unlimited | max 25 |
| Returns | `orderUid` only | `orderUid` **and vouchers** |
| Delivery | Huuray sends via your template | you handle the codes |

They are separate methods because their return types differ. Reading `vouchers` on an asynchronous order is a mistake the type system should catch, not a runtime surprise.

### 4. `206 Partial Content` is a real outcome

Cancel and resend can partly succeed. Checking only that the request "worked" will miss it:

```ts
const result = await huuray.orders.cancel({ orderUid });

if (result.partial) {
  const failed = result.vouchers.filter(v => !v.cancelled);
  console.warn(`${failed.length} vouchers could not be cancelled`);
}
```

### 5. Voucher codes are blank unless your account allows them

`voucher.code`, `voucher.cvv` and `voucher.redeemLink` are returned only if **`ReturnCode` is enabled on your B2B account**. Otherwise they come back empty and Huuray delivers the codes for you. If you need codes returned to your own system, ask your Huuray contact to enable it.

This client also never logs a code, and `redact()` is exported so you can keep them out of your own logs:

```ts
import { redact } from 'huuray';
logger.info('order complete', redact(result));   // codes stripped
```

### 6. An empty result is a 404, not an empty list

The API signals "nothing found" as HTTP 404 with a message like *"There were no active templates"* — so `templates.list()` on an account with no templates, or `orders.search()` with no match, throws `HuurayNotFoundError` rather than returning an empty array. Catch it and read it as "none exist":

```ts
import { HuurayNotFoundError } from 'huuray';

let templates = [];
try {
  ({ templates } = await huuray.templates.list());
} catch (err) {
  if (!(err instanceof HuurayNotFoundError)) throw err;   // 404 -> none exist
}
```

### 7. Authentication, and what a 401 usually means

Every request carries three headers, all built for you:

| Header | Value |
|---|---|
| `X-API-TOKEN` | your API token |
| `X-API-NONCE` | a random value, **single-use within 60 days, max 50 characters** |
| `X-API-HASH` | SHA-512 of ( API secret + nonce ) |

Nonces are 24 random bytes as base64url — 32 characters, comfortably under the limit. Avoid rolling your own: 32-byte hex is 64 characters and is silently rejected, and timestamps collide under concurrency.

**If you get a 401 with credentials you know are correct**, the digest encoding is the thing to try. The API specification states the construction but not the encoding, so this client defaults to lowercase hex and lets you change it:

```ts
new HuurayClient({ apiToken, apiSecret, hashEncoding: 'base64' });
// 'hex' (default) | 'hex-upper' | 'base64' | 'base64url'
```

---

## API coverage

All nine v4 operations, and nothing else. Every method maps to one operation in the [Swagger reference](https://api.huuray.com/swagger/index.html):

| Method | Endpoint |
|---|---|
| `balances.list()` | `GET /v4/Balance` |
| `catalogue.list({ all })` | `POST /v4/Catalogue` |
| `templates.list()` | `POST /v4/Template` |
| `stock.check({ productToken, value })` | `POST /v4/Stock` |
| `exchangeRates.get({ from, to })` | `GET /v4/ExchangeRates` |
| `orders.create(…)` | `POST /v4/Order` (`Sync: false`) |
| `orders.createSync(…)` | `POST /v4/Order` (`Sync: true`) |
| `orders.sendReward(…)` | `POST /v4/Order`, one recipient |
| `orders.search(…)` | `POST /v4/Search` |
| `orders.resend(…)` | `POST /v4/Resend` |
| `orders.cancel(…)` | `DELETE /v4/Cancel` |

Need something not covered? `request()` signs any call for you:

```ts
await huuray.request('POST', '/v4/Search', { RefID: 'payroll-2026-08-jane' });
```

**This client targets API v4 only.** Field names match the Huuray API reference exactly, differing only in casing (`OrderUID` → `orderUid`), so anything you read in the API documentation maps straight across.

## Errors

Every error extends `HuurayError`.

| Class | When |
|---|---|
| `HuurayConfigError` | missing or invalid client options |
| `HuurayConnectionError` | the request never reached the API |
| `HuurayTimeoutError` | the request exceeded `timeoutMs` |
| `HuurayAuthError` | 401 or 403 — see *Authentication* above |
| `HuurayNotFoundError` | 404 |
| `HuurayValidationError` | 422 |
| `HuurayServerError` | 5xx |
| `HuurayApiError` | any other non-2xx; the base for the four above |
| `HuurayIndeterminateOrderError` | an order whose outcome is unknown — **do not retry** |

API errors carry `httpStatus`, `status`, `statusMessage`, and the parsed `body`. The client reads `StatusMessage` and falls back to the deprecated `Message`.

## Client options

```ts
new HuurayClient({
  apiToken:     string,        // required
  apiSecret:    string,        // required
  baseUrl?:     string,        // default https://api.huuray.com
  hashEncoding?:'hex' | 'hex-upper' | 'base64' | 'base64url',
  timeoutMs?:   number,        // default 30000
  retry?:       { maxRetries?, baseDelayMs?, maxDelayMs? },
  fetch?:       typeof fetch,  // inject your own, e.g. behind a proxy
  userAgent?:   string,
  nonceFactory?: () => string,
});
```

## CLI

Read-only by design. Ordering, resending and cancelling move real value and belong in reviewed code, not a shell one-liner. Voucher codes are never printed.

```bash
npx huuray balance
npx huuray catalogue --all
npx huuray templates
npx huuray stock --token <token> --value 5000
npx huuray rates --from EUR --to DKK
npx huuray search --ref-id payroll-2026-08-jane
npx huuray --help
```

## Examples

- [`examples/quickstart.ts`](examples/quickstart.ts) — read-only tour, safe to run
- [`examples/reconcile-after-timeout.ts`](examples/reconcile-after-timeout.ts) — recovering from an order whose outcome is unknown

## Links

- [Sign up for a Huuray B2B account](https://huuray.com/sign-up/)
- [Huuray API v4 reference (Swagger)](https://api.huuray.com/swagger/index.html)
- [huuray.com](https://huuray.com)
- [Report a bug](https://github.com/ronniegasseholm-prog/huuray-node/issues)

## Further reading

- [Huuray API v4 reference (Swagger)](https://api.huuray.com/swagger/index.html) — the specification this client is generated from
- [Sign up for a Huuray B2B account](https://huuray.com/sign-up/) — if you do not have one yet
- [Contributing](.github/CONTRIBUTING.md) — including the note on **spec fidelity**: this client deliberately exposes nothing the API does not document, and that rule is enforced by tests
- [Changelog](CHANGELOG.md)

## Feedback

Found a bug, or something in this library that could be friendlier? Please [file an issue](https://github.com/ronniegasseholm-prog/huuray-node/issues) or open a pull request.

For the API itself, your account, or a live production problem, contact your Huuray representative — see [SUPPORT.md](.github/SUPPORT.md) for which channel to use. Never open a public issue for a security vulnerability; see [SECURITY.md](.github/SECURITY.md).

## Code of Conduct

Please note that this project is released with a [Contributor Code of Conduct](.github/CODE_OF_CONDUCT.md). By contributing to this project, you agree to abide by its terms.

---

<p align="center">
  <img src="https://raw.githubusercontent.com/ronniegasseholm-prog/huuray-node/main/.github/assets/huuray-logo.svg" width="96" alt="Huuray"/><br/>
  <sub>Made with 💚 in Denmark by <a href="https://huuray.com">Huuray A/S</a> · <a href="LICENSE">MIT</a></sub>
</p>
