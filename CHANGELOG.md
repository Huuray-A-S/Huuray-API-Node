# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Confirmed against the live API (2026-08-15)

Every assumption the specification left open has been verified with real calls:

- **`X-API-HASH` encoding is lowercase hex** — authenticated against
  `GET /v4/Balance`; the other three candidate encodings return 401. The default
  is pinned by a test; `hashEncoding` remains available as an override.
- **Base URL `https://api.huuray.com`** works for every endpoint exercised.
- **`POST /v4/Template` accepts a bodyless request**, as the spec implies.
- **The full order loop works end to end through this SDK**: Balance → sync
  Order (quantity 1, no delivery) → Search by `RefID` (matched) → Cancel
  (full) → Balance.
- **An empty result set is signalled as HTTP 404**, not as an empty 200 — observed
  live on `/v4/Template` ("There were no active templates"). This is why the
  reconciliation examples treat `HuurayNotFoundError` from `/v4/Search` as
  "the order did not land".

## [0.1.0] — unreleased

First release. Complete coverage of the Huuray API v4.

### Added

- `HuurayClient` with request signing, nonce generation, timeouts, and typed errors.
- All nine v4 operations: balances, catalogue, templates, stock, exchange rates,
  orders (create, createSync, search, resend, cancel).
- `sendReward()` — one gift card to one recipient in a single call.
- `request()` — an escape hatch that signs any call.
- Read-only CLI: `balance`, `catalogue`, `templates`, `stock`, `rates`, `search`.
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
