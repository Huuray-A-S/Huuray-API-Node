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
 *   retryable    Balance, ExchangeRates, Catalogue, Template, Stock, Search, Pdf
 *   never        Order, Resend, Cancel, Upload
 *
 * Note that five of the retryable operations are POSTs. They are POSTs because
 * they take a request body, not because they change anything.
 */

/** Retry knobs. Defaults are deliberately conservative. */
export interface RetryOptions {
  /** Attempts after the first. `0` disables retrying entirely. Default `2`. */
  maxRetries?: number;
  /** Base delay in ms; doubles per attempt with jitter. Default `250`. */
  baseDelayMs?: number;
  /**
   * Ceiling for a single backoff wait, and for the wait a read makes after a
   * `429` with `Retry-After` (those seconds, at least 1): when that wait is
   * longer, the `429` is thrown at once. So below `1000`, a `429` that carries
   * `Retry-After` is never retried. Default `4000`. Anything above
   * `2147483647`, the longest wait a timer holds, counts as that.
   */
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
 * `429` is a documented response on every v4 operation: the rate limit for the
 * caller's IP address was exceeded and the request was not processed. A read is
 * repeated after the `Retry-After` seconds when the header gives them, see
 * {@link retryAfterDelay}, and after the computed backoff when it does not.
 */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/**
 * The shortest wait a `Retry-After` is honoured with, in seconds, whatever the
 * header says: a `0` would otherwise send signed requests back to back.
 */
export const MIN_RETRY_AFTER_SECONDS = 1;

/** Whole seconds from a `Retry-After` header, or `null`. An HTTP date is not read. */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/** The longest delay a timer holds, in ms: a signed 32-bit value. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The wait before repeating a read that was answered `429` with `retryAfter`
 * seconds, in ms: at least 1 second, and used in place of the computed
 * backoff. `undefined` when it is longer than `maxDelayMs`, or than a timer
 * can hold: the read is then not repeated, so the caller decides.
 */
export function retryAfterDelay(
  retryAfter: number,
  opts: Required<RetryOptions>,
): number | undefined {
  const ms = Math.max(retryAfter, MIN_RETRY_AFTER_SECONDS) * 1000;
  return ms <= Math.min(opts.maxDelayMs, MAX_TIMER_MS) ? ms : undefined;
}

/**
 * Exponential backoff with full jitter, so parallel clients don't resonate.
 *
 * Never longer than a timer can hold, whatever `maxDelayMs` is: past that
 * Node warns and waits about 1 ms. And never NaN, on which Node waits about
 * 1 ms too: a NaN option waits nothing, as 0 does.
 */
export function backoffDelay(attempt: number, opts: Required<RetryOptions>): number {
  const exponential = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs, MAX_TIMER_MS);
  // NaN comes from a NaN option, or from 0 * Infinity once 2 ** attempt overflows.
  return Number.isNaN(exponential) ? 0 : Math.round(Math.random() * exponential);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
