# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **`request()` checks its method and path before anything is sent.** A method
  that is not an RFC 9110 token, or a path that does not start with `/` or holds
  anything but visible ASCII, throws a `TypeError` that does not quote it. A path
  such as `.example.test/…`, `@host/…` or `:8443/…` moved the signed request to
  another host or port, line breaks and tabs in a path were silently stripped, and
  a bad method surfaced as a `HuurayConnectionError` quoting it.
- **Header values are checked before anything is sent.** An `apiToken` or
  `userAgent` containing a control character (a line break, tab, NUL, DEL or
  similar) or a character above U+00FF, and a whitespace-only `apiToken`, throw
  `HuurayConfigError` at construction. A custom nonce that is empty or not visible
  ASCII throws a `TypeError` before sending. Neither message quotes the value.
  Previously fetch refused some of these only when the request was attempted, as a
  `HuurayConnectionError` whose message quoted the token or nonce — on an order, as
  `HuurayIndeterminateOrderError` for a request that was never sent — and let others
  through, such as a tab or a blank `X-API-TOKEN` or `X-API-NONCE` header.
- **A `baseUrl` containing a space, control character or non-ASCII character
  throws `HuurayConfigError`** at construction, instead of being silently stripped,
  percent-encoded or converted to punycode.
- **A `baseUrl` with user-info (`user@` or `user:password@`), a query (`?`) or a
  fragment (`#`) throws `HuurayConfigError`** at construction; a trailing slash is
  still accepted. With Node's fetch, user-info made every request fail as a
  `HuurayConnectionError` whose message quoted the URL, password included — on an
  order, as `HuurayIndeterminateOrderError` for a request never sent — and a fetch
  that accepts user-info would send it to the host as credentials. After `?` or `#`
  every request path became part of the query or fragment, so every request went to
  the base URL's own path. No `baseUrl` error message quotes the value any more;
  those for a URL that was not absolute or not http(s) did.

### Fixed

- **`timeoutMs` must be a whole number from 1 to 2147483647**; anything else throws
  `HuurayConfigError` at construction. That is the range Node honours: it timed a
  request out almost at once for `0` and for values above 2147483647 (a timer
  overflow), and threw for a fraction, `NaN`, `Infinity` or a negative value only
  when a request was attempted — so an order was reported as indeterminate.
- **Docs.** The README *Feedback* section no longer invites pull requests, which
  this repository does not accept. The README, `templates.list()` and this
  changelog no longer present HTTP 404 as how the API signals every empty result:
  it was observed on `POST /v4/Template` when the account had no templates, while
  an account with only PDF templates gets an empty `templates` list. CONTRIBUTING
  and the spec-drift workflow no longer say a changed specification always opens a
  pull request: without a `SPEC_DRIFT_TOKEN` secret the run fails instead.

### Confirmed against the live API

Every assumption the specification left open has been verified with real calls
on 2026-08-15, unless another date is given:

- **`X-API-HASH` encoding is lowercase hex** — authenticated against
  `GET /v4/Balance`; the other three candidate encodings return 401. The default
  is pinned by a test; `hashEncoding` remains available as an override.
- **Base URL `https://api.huuray.com`** works for every endpoint exercised.
- **`POST /v4/Template` accepts a bodyless request**, as the spec implies.
- **The full order loop works end to end through this SDK**: Balance → sync
  Order (quantity 1, no delivery) → Search by `RefID` (matched) → Cancel
  (full) → Balance.
- **`POST /v4/Template` answered HTTP 404** ("There were no active templates"),
  not an empty 200, for an account with no templates. This is why the
  reconciliation examples treat `HuurayNotFoundError` from `/v4/Search` as
  "the order did not land".
- **An account with PDF templates but no email or SMS templates gets `200`** from
  `POST /v4/Template`, with an empty `Templates` list and its PDF templates in
  `PDFTemplates` — observed live 2026-09-16.

## [0.1.0] — unreleased

First release. Complete coverage of the Huuray API v4.

### Added

- `HuurayClient` with request signing, nonce generation, timeouts, and typed errors.
- All nine v4 operations: balances, catalogue, templates, stock, exchange rates,
  orders (create, createSync, search, resend, cancel).
- `sendReward()` — one gift card to one recipient in a single call.
- PDF templates, added to the v4 specification: `templates.list()` returns them
  as `pdfTemplates` (type `PdfTemplate`: `uid`, `name`, `type`, `language`,
  `country`, `brandName`) instead of silently dropping them, and
  `orders.create()`, `orders.createSync()` and `sendReward()` accept an optional
  `pdfTemplateUid`, sent as `DeliveryPDFTemplateUid`. It is rejected before any
  request unless `templateId` is also set; the API requires that to be an email
  template.
- `request()` — an escape hatch that signs any call.
- Read-only CLI: `balance`, `catalogue`, `templates`, `stock`, `rates`, `search`.
- The CLI `templates` command lists PDF templates as well as delivery templates,
  in table and `--json` output.
- `redact()` and `safeStringify()` for keeping voucher codes out of logs.
- Types generated from the vendored OpenAPI specification.

### Hardened after a pre-release audit

- A connection drop or timeout **while the response body streams** now maps into
  the error taxonomy like any other transport fault — on `/v4/Order` it wraps in
  `HuurayIndeterminateOrderError` instead of escaping as a raw `DOMException`.
- A 2xx response with an **empty or unparseable body** throws
  `HuurayConnectionError` instead of masquerading as an empty result — a garbled
  `/v4/Search` response must never read as "the order did not land".
- Error objects retain only a **redacted** copy of the response body.
- `retry: { maxRetries: undefined }` falls back to the default instead of
  disabling the request loop; negative values clamp to zero.
- Injected `fetch` implementations are never called with the client as `this`.
- The CLI rejects a valued flag with no value (`--ref-id --json` no longer runs
  a filterless search), supports `--flag=value`, and errors on unknown flags.
- The reconciliation examples handle the spec-documented `404` from `/v4/Search`.
- Conformance gates fail closed on schema shapes the validator does not
  understand, and a method inventory pins the exercised public surface.

### Safety behaviour worth calling out

- **Orders, resends and cancels are never retried automatically.** The API has no
  idempotency key, so a retry can order twice or re-deliver a live gift card.
  A failed order throws `HuurayIndeterminateOrderError`, which points at
  `orders.search({ refId })` for reconciliation.
- **Amounts must be integers in minor units.** A fractional value is rejected
  rather than rounded, because rounding here is a 100× error.
- **`206 Partial Content`** on cancel and resend is surfaced as `partial: true`
  rather than being treated as plain success.
- **Voucher codes are never logged** by this library at any level.
- **The CLI cannot move value.**

[Unreleased]: https://github.com/Huuray-A-S/Huuray-API-Node/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Huuray-A-S/Huuray-API-Node/releases/tag/v0.1.0
