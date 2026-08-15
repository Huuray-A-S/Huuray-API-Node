/**
 * Retry policy.
 *
 * The v4 API exposes no idempotency key. `RefID` is a reference you choose for
 * your own reconciliation; it is not a server-side deduplication key. So a
 * retried `POST /v4/Order` can create a second order, and a retried
 * `POST /v4/Resend` can re-deliver a live gift card.
 *
 * Because of that, retries are **opt-in per operation**, never inferred from the
 * HTTP method. Each resource method declares whether it is safe to repeat:
 *
 *   retryable    Balance, ExchangeRates, Catalogue, Template, Stock, Search
 *   never        Order, Resend, Cancel
 *
 * Note that four of the retryable operations are POSTs. They are POSTs because
 * they take a request body, not because they change anything.
 */

/** Retry knobs. Defaults are deliberately conservative. */
export interface RetryOptions {
  /** Attempts after the first. `0` disables retrying entirely. Default `2`. */
  maxRetries?: number;
  /** Base delay in ms; doubles per attempt with jitter. Default `250`. */
  baseDelayMs?: number;
  /** Ceiling for a single backoff wait. Default `4000`. */
  maxDelayMs?: number;
}

export const DEFAULT_RETRY: Required<RetryOptions> = {
  maxRetries: 2,
  baseDelayMs: 250,
  maxDelayMs: 4000,
};

/** HTTP statuses worth repeating a *read* for. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Whether a response status should be retried, given the operation is already
 * known to be safe to repeat.
 *
 * `429` is included defensively: it is not a documented response on any v4
 * endpoint, so this client never assumes rate limiting exists — but if one
 * appears, backing off is strictly better than hammering.
 */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** Exponential backoff with full jitter, so parallel clients don't resonate. */
export function backoffDelay(attempt: number, opts: Required<RetryOptions>): number {
  const exponential = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
  return Math.round(Math.random() * exponential);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
