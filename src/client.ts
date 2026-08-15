import { buildAuthHeaders, generateNonce, type HashEncoding } from './auth.js';
import {
  HuurayApiError,
  HuurayConfigError,
  HuurayConnectionError,
  HuurayTimeoutError,
} from './errors.js';
import { DEFAULT_RETRY, backoffDelay, isRetryableStatus, sleep, type RetryOptions } from './retry.js';
import { VERSION } from './version.gen.js';
import { BalancesResource } from './resources/balances.js';
import { CatalogueResource } from './resources/catalogue.js';
import { ExchangeRatesResource } from './resources/exchange-rates.js';
import { OrdersResource, type SendRewardParams, type CreateOrderResult } from './resources/orders.js';
import { StockResource } from './resources/stock.js';
import { TemplatesResource } from './resources/templates.js';

/** The production API. The spec declares no `servers` block, so this is set here. */
export const DEFAULT_BASE_URL = 'https://api.huuray.com';

export interface HuurayClientOptions {
  /** Your API token. Sent as `X-API-TOKEN`. */
  apiToken: string;
  /** Your API secret. Used to sign each request; never sent and never logged. */
  apiSecret: string;
  /** Override the API host. Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /**
   * Encoding of the `X-API-HASH` digest. Defaults to lowercase hex.
   * If you see a 401 with credentials you know are good, try another value.
   */
  hashEncoding?: HashEncoding;
  /** Per-request timeout in milliseconds. Default `30000`. */
  timeoutMs?: number;
  /** Retry behaviour for read operations. Writes are never retried. */
  retry?: RetryOptions;
  /** Inject a `fetch` implementation — used by the test suite, and for proxies. */
  fetch?: typeof globalThis.fetch;
  /** Appended to the `User-Agent`, e.g. your app name and version. */
  userAgent?: string;
  /**
   * Supply your own nonce. Must be unique per request, unused for 60 days, and
   * at most 50 characters. The default (24 random bytes, base64url) is right for
   * almost everyone.
   */
  nonceFactory?: () => string;
}

/** A parsed response plus the HTTP status, which some endpoints use semantically. */
export interface RawResponse<T> {
  data: T;
  httpStatus: number;
}

export interface SendOptions {
  /** JSON request body. Omitted entirely when undefined. */
  body?: unknown;
  /** Query string parameters. Undefined values are dropped. */
  query?: Record<string, string | number | undefined>;
  /**
   * Whether repeating this call is safe. **Opt-in per operation** — never
   * inferred from the HTTP method, because four read-only v4 endpoints are POSTs
   * and two value-moving ones are too. Default `false`.
   */
  retryable?: boolean;
}

/**
 * Client for the Huuray API v4.
 *
 * ```ts
 * const huuray = new HuurayClient({
 *   apiToken:  process.env.HUURAY_API_TOKEN!,
 *   apiSecret: process.env.HUURAY_API_SECRET!,
 * });
 *
 * const { balances } = await huuray.balances.list();
 * ```
 */
export class HuurayClient {
  readonly balances: BalancesResource;
  readonly catalogue: CatalogueResource;
  readonly templates: TemplatesResource;
  readonly stock: StockResource;
  readonly exchangeRates: ExchangeRatesResource;
  readonly orders: OrdersResource;

  readonly #apiToken: string;
  readonly #apiSecret: string;
  readonly #baseUrl: string;
  readonly #hashEncoding: HashEncoding | undefined;
  readonly #timeoutMs: number;
  readonly #retry: Required<RetryOptions>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #userAgent: string;
  readonly #nonceFactory: () => string;

  constructor(options: HuurayClientOptions) {
    if (!options?.apiToken) {
      throw new HuurayConfigError(
        'apiToken is required. Pass it explicitly, e.g. from process.env.HUURAY_API_TOKEN.',
      );
    }
    if (!options.apiSecret) {
      throw new HuurayConfigError(
        'apiSecret is required. Pass it explicitly, e.g. from process.env.HUURAY_API_SECRET.',
      );
    }

    this.#apiToken = options.apiToken;
    this.#apiSecret = options.apiSecret;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#hashEncoding = options.hashEncoding;
    this.#timeoutMs = options.timeoutMs ?? 30_000;

    // `?? DEFAULT` per field, not an object spread: `retry: { maxRetries: undefined }`
    // must fall back to the default, never clobber it — a clobbered maxRetries would
    // skip the request loop entirely and throw `undefined`.
    const retry = options.retry ?? {};
    this.#retry = {
      maxRetries: Math.max(0, Math.trunc(retry.maxRetries ?? DEFAULT_RETRY.maxRetries)),
      baseDelayMs: Math.max(0, retry.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs),
      maxDelayMs: Math.max(0, retry.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs),
    };
    this.#nonceFactory = options.nonceFactory ?? generateNonce;

    const injected = options.fetch ?? globalThis.fetch;
    if (typeof injected !== 'function') {
      throw new HuurayConfigError(
        'No fetch implementation available. Use Node 20 or newer, or pass `fetch` explicitly.',
      );
    }
    // Wrapped so the implementation is never invoked with this client as `this` —
    // browser fetch and some polyfills throw "Illegal invocation" otherwise.
    this.#fetch = (input, init) => injected(input, init);

    this.#userAgent = [`huuray-node/${VERSION}`, options.userAgent].filter(Boolean).join(' ');

    this.balances = new BalancesResource(this);
    this.catalogue = new CatalogueResource(this);
    this.templates = new TemplatesResource(this);
    this.stock = new StockResource(this);
    this.exchangeRates = new ExchangeRatesResource(this);
    this.orders = new OrdersResource(this);
  }

  /**
   * Sends one gift card to one recipient — the common case, in a single call.
   *
   * Performs exactly one `POST /v4/Order` with `Sync: false` and `Quantity: 1`.
   * Delivery is handled by Huuray using the template you name, so no voucher
   * codes come back; use `orders.search()` to look the order up later.
   *
   * `refId` is required by this SDK even though the API treats it as optional:
   * without it there is no way to find out whether an order landed after a
   * timeout. See {@link HuurayIndeterminateOrderError}.
   */
  async sendReward(params: SendRewardParams): Promise<CreateOrderResult> {
    return this.orders.sendReward(params);
  }

  /**
   * Calls any v4 endpoint with signing handled — the escape hatch for anything
   * the typed resources do not cover.
   *
   * Request and response shapes are exactly as documented in the Huuray API
   * reference; this method does no renaming.
   *
   * ```ts
   * await huuray.request('POST', '/v4/Search', { RefID: 'payroll-2026-08-jane' });
   * ```
   */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options?: Omit<SendOptions, 'body'>,
  ): Promise<T> {
    const res = await this.send<T>(method, path, { ...options, body });
    return res.data;
  }

  /**
   * Signs and sends one request, returning the parsed body and the HTTP status.
   *
   * Resource methods use this because some v4 endpoints carry meaning in the
   * status itself — `206 Partial Content` on Cancel and Resend.
   *
   * @internal Not part of the semver-stable surface; use {@link request}.
   */
  async send<T = unknown>(
    method: string,
    path: string,
    options: SendOptions = {},
  ): Promise<RawResponse<T>> {
    const url = new URL(this.#baseUrl + path);
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const attempts = options.retryable ? this.#retry.maxRetries : 0;
    let lastError: unknown;

    for (let attempt = 0; attempt <= attempts; attempt++) {
      if (attempt > 0) await sleep(backoffDelay(attempt - 1, this.#retry));

      // A fresh nonce every attempt: the API rejects a repeat for 60 days.
      const headers: Record<string, string> = {
        ...buildAuthHeaders({
          apiToken: this.#apiToken,
          apiSecret: this.#apiSecret,
          nonce: this.#nonceFactory(),
          ...(this.#hashEncoding ? { hashEncoding: this.#hashEncoding } : {}),
        }),
        Accept: 'application/json',
        'User-Agent': this.#userAgent,
      };

      let payload: string | undefined;
      if (options.body !== undefined) {
        payload = JSON.stringify(options.body);
        headers['Content-Type'] = 'application/json';
      }

      // fetch resolves on headers; the body streams afterwards under the same
      // timeout signal. Both awaits must map through the same error taxonomy —
      // a raw DOMException escaping here would bypass every downstream
      // `instanceof` check, including the one that wraps order failures in
      // HuurayIndeterminateOrderError.
      let response: Response;
      let text: string;
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          ...(payload !== undefined ? { body: payload } : {}),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        text = await response.text();
      } catch (cause) {
        const isTimeout =
          cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
        lastError = isTimeout
          ? new HuurayTimeoutError(method, path, this.#timeoutMs)
          : new HuurayConnectionError(
              `${method} ${path} failed to reach the Huuray API: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              method,
              path,
              { cause },
            );
        if (attempt < attempts) continue;
        throw lastError;
      }

      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }

      if (response.ok) {
        // Every documented 2xx carries a JSON body. An empty or unparseable
        // body on a success status is a transport-level fault (proxy
        // interference, truncation) — NOT an empty result. Coercing it to an
        // empty result would make orders.search() report "order absent" after
        // a garbled response, and the documented reconciliation flow would
        // re-order. Body content is never included in the error: it could
        // hold voucher codes.
        if (parsed === undefined) {
          lastError = new HuurayConnectionError(
            `${method} ${path} returned HTTP ${response.status} but the body was ` +
              `${text ? 'not valid JSON' : 'empty'} (${text.length} bytes). ` +
              'Treat the outcome as unknown rather than empty.',
            method,
            path,
          );
          if (attempt < attempts) continue;
          throw lastError;
        }
        return { data: parsed as T, httpStatus: response.status };
      }

      lastError = HuurayApiError.from(response.status, parsed, method, path);
      if (attempt < attempts && isRetryableStatus(response.status)) continue;
      throw lastError;
    }

    /* istanbul ignore next — the loop always returns or throws. */
    throw lastError;
  }
}
