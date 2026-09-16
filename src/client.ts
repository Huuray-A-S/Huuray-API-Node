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

/** RFC 9110 `token` — the only characters an HTTP method may contain. */
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Methods fetch refuses in any case, though each is a valid token. */
const FORBIDDEN_METHOD = /^(?:CONNECT|TRACE|TRACK)$/i;

/** A `request()` path: a leading "/" and visible ASCII only. */
const REQUEST_PATH = /^\/[\x21-\x7E]*$/;

/**
 * A character a header value must not contain: an ASCII control character
 * (0x00-0x1F, 0x7F), which fetch refuses only once a request is attempted,
 * trims from either end, or sends through as-is, or anything above U+00FF,
 * which it cannot encode.
 */
const UNSENDABLE_HEADER_CHAR = /[\x00-\x1F\x7F]|[^\x00-\xFF]/;

export interface HuurayClientOptions {
  /**
   * Your API token. Sent as `X-API-TOKEN`, so it must not contain a control
   * character — trim a value read from a file.
   */
  apiToken: string;
  /** Your API secret. Used to sign each request; never sent and never logged. */
  apiSecret: string;
  /**
   * Override the API host. Defaults to {@link DEFAULT_BASE_URL}. An absolute
   * http(s) URL with no user-info, query or fragment.
   */
  baseUrl?: string;
  /**
   * Encoding of the `X-API-HASH` digest. Defaults to lowercase hex.
   * If you see a 401 with credentials you know are good, try another value.
   */
  hashEncoding?: HashEncoding;
  /** Per-request timeout in milliseconds, a whole number from 1 to 2147483647. Default `30000`. */
  timeoutMs?: number;
  /** Retry behaviour for read operations. Writes are never retried. */
  retry?: RetryOptions;
  /** Inject a `fetch` implementation — used by the test suite, and for proxies. */
  fetch?: typeof globalThis.fetch;
  /** Appended to the `User-Agent`, e.g. your app name and version. No control characters. */
  userAgent?: string;
  /**
   * Supply your own nonce. Must be unique per request, unused for 60 days, and
   * 1 to 50 characters of visible ASCII. The default (24 random bytes,
   * base64url) is right for almost everyone.
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
    // A token of only whitespace counts as missing: fetch trims header values,
    // so the request would go out with a blank X-API-TOKEN.
    if (!options?.apiToken || String(options.apiToken).trim() === '') {
      throw new HuurayConfigError(
        'apiToken is required. Pass it explicitly, e.g. from process.env.HUURAY_API_TOKEN.',
      );
    }
    if (!options.apiSecret) {
      throw new HuurayConfigError(
        'apiSecret is required. Pass it explicitly, e.g. from process.env.HUURAY_API_SECRET.',
      );
    }
    // Rejected, never trimmed. fetch trims a line break or tab at either end and
    // sends the rest; refuses an interior line break or a NUL only once a
    // request is attempted — as a connection error whose message quotes the
    // token, and on an order as an indeterminate one — sends an interior tab
    // through, and fails on DEL at the socket. The secret is not checked because
    // it is never sent. The message does not quote the value.
    if (UNSENDABLE_HEADER_CHAR.test(options.apiToken)) {
      throw new HuurayConfigError(
        'apiToken contains a control character (a line break, tab, NUL or similar) or a character ' +
          'above U+00FF, and cannot be sent as the X-API-TOKEN header. A value read from a file ' +
          'often ends in a newline; trim it first.',
      );
    }

    this.#apiToken = options.apiToken;
    this.#apiSecret = options.apiSecret;

    // No baseUrl message quotes the value: it could hold a password.
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const expectedBaseUrl = `Expected something like ${JSON.stringify(DEFAULT_BASE_URL)}.`;

    // The URL parser silently strips tabs, line breaks and surrounding spaces,
    // percent-encodes other characters and converts a non-ASCII host to
    // punycode, so a mangled value would be quietly turned into a different URL.
    if (/[^\x21-\x7E]/.test(baseUrl)) {
      throw new HuurayConfigError(
        'baseUrl contains a space, control character or non-ASCII character. ' + expectedBaseUrl,
      );
    }
    // Paths are appended to the base URL as text, so after a "?" or "#" they
    // become part of the query or fragment and every request goes to the base
    // URL's own path.
    if (/[?#]/.test(baseUrl)) {
      throw new HuurayConfigError(
        'baseUrl contains a query ("?") or fragment ("#"), which would send every request to ' +
          'the wrong path. ' +
          expectedBaseUrl,
      );
    }
    this.#baseUrl = baseUrl.replace(/\/+$/, '');

    // Fail here, not at the first request. A baseUrl of '/v4' or 'api.huuray.com'
    // (no scheme) would otherwise be accepted and only surface later as a
    // confusing transport error — and requiring http(s) keeps credentials from
    // being aimed at a file:// or ftp:// target by a configuration typo. The
    // parser's own error is not kept as the cause: it carries the input.
    let parsedBaseUrl: URL;
    try {
      parsedBaseUrl = new URL(this.#baseUrl);
    } catch {
      throw new HuurayConfigError('baseUrl is not an absolute http(s) URL. ' + expectedBaseUrl);
    }
    if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
      throw new HuurayConfigError('baseUrl must use http or https. ' + expectedBaseUrl);
    }
    // User-info ("user@" or "user:password@"): Node's fetch refuses every request
    // to such a URL, which surfaced as a connection error quoting it, password
    // included, and a fetch that accepts user-info sends it to the host as
    // credentials. The authority runs from after the scheme's slashes (either
    // kind, for http and https) to the next slash; any "@" in it is rejected,
    // an empty user-info included.
    const authority = baseUrl.replace(/^https?:[/\\]*/i, '').split(/[/\\]/, 1)[0] ?? '';
    if (authority.includes('@')) {
      throw new HuurayConfigError(
        'baseUrl must not contain user-info (a user name or password before "@"). ' +
          expectedBaseUrl,
      );
    }
    this.#hashEncoding = options.hashEncoding;

    // The range Node actually honours. AbortSignal.timeout fires after 1 ms for 0
    // and, with a TimeoutOverflowWarning, for 2147483648 to 4294967295 (a timer
    // holds a signed 32-bit delay), and throws for a fraction, NaN, Infinity, a
    // negative value or anything above 4294967295 — but only once a request is
    // attempted, where it reads as a connection error and, on an order, as an
    // indeterminate one.
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new HuurayConfigError(
        'timeoutMs must be a whole number of milliseconds from 1 to 2147483647, ' +
          `received ${String(timeoutMs)}.`,
      );
    }
    this.#timeoutMs = timeoutMs;

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
    if (UNSENDABLE_HEADER_CHAR.test(this.#userAgent)) {
      throw new HuurayConfigError(
        'userAgent contains a control character (a line break, tab, NUL or similar) or a character ' +
          'above U+00FF, and cannot be sent as the User-Agent header.',
      );
    }

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
   * `method` must be an HTTP token other than CONNECT, TRACE or TRACK, and
   * `path` must start with `/` and contain only visible ASCII; anything else
   * throws a `TypeError` before sending.
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
    // The method goes into the request line and the path is appended to the
    // base URL as text. A path not starting with "/" can move the request —
    // credentials included — to another host (".host") or port (":8443"), as it
    // did with Node's fetch. "@host" turns the base URL into user-info: Node's
    // fetch refuses that, which surfaced as a connection error quoting the URL,
    // but a fetch that accepts user-info sends the request to that host. The URL
    // parser strips line breaks and tabs from the rest and percent-encodes spaces
    // and non-ASCII, and fetch rejects a bad or forbidden method only as a
    // connection error that quotes it. Checked before anything is built, so a
    // refused request is never mapped to a connection or indeterminate-order
    // error. Neither value is quoted.
    if (typeof method !== 'string' || !HTTP_TOKEN.test(method)) {
      throw new TypeError(
        'The request was not sent: the HTTP method must be a token such as GET, POST or DELETE.',
      );
    }
    if (FORBIDDEN_METHOD.test(method)) {
      throw new TypeError(
        'The request was not sent: fetch does not allow the CONNECT, TRACE or TRACK method.',
      );
    }
    if (typeof path !== 'string' || !REQUEST_PATH.test(path)) {
      throw new TypeError(
        `${method} request was not sent: the path must start with "/" and contain only visible ASCII.`,
      );
    }

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
