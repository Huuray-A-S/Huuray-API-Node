/**
 * Error types.
 *
 * The API returns `Status` and `StatusMessage` in the body alongside the HTTP
 * status. `Message` carries the same text but is marked deprecated in the spec,
 * so this client reads `StatusMessage` first and falls back to `Message`.
 */

import { redact } from './redact.js';

/** Base class for everything this library throws. Catch this to catch it all. */
export class HuurayError extends Error {
  override readonly name: string = 'HuurayError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Client is misconfigured — missing credentials, bad base URL. Not a server response. */
export class HuurayConfigError extends HuurayError {
  override readonly name = 'HuurayConfigError';
}

/** The request never completed: network failure, DNS, TLS, or timeout. */
export class HuurayConnectionError extends HuurayError {
  override readonly name: string = 'HuurayConnectionError';
  constructor(
    message: string,
    readonly method: string,
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The request exceeded the configured timeout. */
export class HuurayTimeoutError extends HuurayConnectionError {
  override readonly name = 'HuurayTimeoutError';
  constructor(method: string, path: string, readonly timeoutMs: number) {
    super(`${method} ${path} timed out after ${timeoutMs}ms.`, method, path);
  }
}

/** The API returned a non-2xx response. */
export class HuurayApiError extends HuurayError {
  override readonly name: string = 'HuurayApiError';

  constructor(
    message: string,
    /** HTTP status of the response. */
    readonly httpStatus: number,
    /** The `Status` field from the response body, when present. */
    readonly status: number | undefined,
    /** The `StatusMessage` field, or the deprecated `Message` as fallback. */
    readonly statusMessage: string | undefined,
    /**
     * The parsed response body, if it was JSON — **redacted**: any field that
     * could carry a voucher code or contact detail is masked, so logging an
     * error object never leaks a bearer instrument.
     */
    readonly body: unknown,
    readonly method: string,
    readonly path: string,
  ) {
    super(message);
  }

  static from(
    httpStatus: number,
    body: unknown,
    method: string,
    path: string,
  ): HuurayApiError {
    const b = (body ?? {}) as { Status?: number; StatusMessage?: string; Message?: string };
    const statusMessage = b.StatusMessage ?? b.Message;
    const detail = statusMessage ? ` — ${statusMessage}` : '';
    const message = `${method} ${path} failed with HTTP ${httpStatus}${detail}`;

    // The raw body is dropped here: only the redacted copy is retained, so an
    // undocumented error payload carrying voucher or recipient fields cannot
    // ride into a consumer's logs via console.error(err).
    const args = [message, httpStatus, b.Status, statusMessage, redact(body), method, path] as const;

    if (httpStatus === 401 || httpStatus === 403) return new HuurayAuthError(...args);
    if (httpStatus === 404) return new HuurayNotFoundError(...args);
    if (httpStatus === 422) return new HuurayValidationError(...args);
    if (httpStatus >= 500) return new HuurayServerError(...args);
    return new HuurayApiError(...args);
  }
}

/**
 * 401 or 403.
 *
 * With credentials you believe are correct, the usual causes are, in order:
 * a wrong `X-API-HASH` encoding (see `hashEncoding`), a reused nonce (the API
 * remembers them for 60 days), or a nonce over 50 characters.
 */
export class HuurayAuthError extends HuurayApiError {
  override readonly name = 'HuurayAuthError';
}

/** 404 — the order, voucher, or product was not found. */
export class HuurayNotFoundError extends HuurayApiError {
  override readonly name = 'HuurayNotFoundError';
}

/** 422 — the request was well-formed but rejected. Read `statusMessage`. */
export class HuurayValidationError extends HuurayApiError {
  override readonly name = 'HuurayValidationError';
}

/** 5xx — a server-side failure. Safe to retry only for reads. */
export class HuurayServerError extends HuurayApiError {
  override readonly name = 'HuurayServerError';
}

/**
 * An order request failed in a way that leaves its outcome unknown — a timeout,
 * a dropped connection, or a 5xx after the request was sent.
 *
 * **Do not retry.** `POST /v4/Order` has no idempotency key, so a retry can
 * order a second set of gift cards. The order may or may not have been created.
 *
 * Resolve it by looking the order up instead. Note that the spec documents a
 * `404` response on `/v4/Search`, which this client throws as
 * {@link HuurayNotFoundError} — catch it and read it as "the order did not
 * land":
 *
 * ```ts
 * try {
 *   await huuray.sendReward({ refId: 'payroll-2026-08-jane', ... });
 * } catch (err) {
 *   if (err instanceof HuurayIndeterminateOrderError) {
 *     try {
 *       const found = await huuray.orders.search({ refId: err.refId });
 *       if (found.orderUid) {
 *         // The order landed. Nothing more to do.
 *       } else {
 *         // No match -> it did not land. Safe to send again, same refId.
 *       }
 *     } catch (lookup) {
 *       if (lookup instanceof HuurayNotFoundError) {
 *         // 404 -> no order exists for this refId. Safe to send again.
 *       } else {
 *         throw lookup; // the lookup itself failed; outcome still unknown
 *       }
 *     }
 *   }
 * }
 * ```
 */
export class HuurayIndeterminateOrderError extends HuurayError {
  override readonly name = 'HuurayIndeterminateOrderError';

  constructor(
    /** The `RefID` sent with the order, if any — the key to look it up with. */
    readonly refId: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(
      'The order request did not complete, so it is unknown whether the order was created. ' +
        'Do NOT retry: /v4/Order has no idempotency key and a retry may order a second time. ' +
        (refId
          ? `Call orders.search({ refId: ${JSON.stringify(refId)} }) to check whether it landed.`
          : 'No RefID was sent, so the order cannot be looked up by reference. ' +
            'Always set refId on orders so this case is recoverable.'),
      options,
    );
  }
}
