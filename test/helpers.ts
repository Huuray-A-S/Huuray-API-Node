import { HuurayClient, type HuurayClientOptions } from '../src/index.js';

/** One request the SDK made, captured by {@link recordingFetch}. */
export interface CapturedRequest {
  method: string;
  /** Full URL as requested, e.g. `https://api.huuray.com/v4/Balance?x=1`. */
  url: string;
  /** Origin only, e.g. `https://api.huuray.com` — for pinning the base URL. */
  origin: string;
  /** Path only, e.g. `/v4/Order`. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Parsed JSON body, or `undefined` when no body was sent. */
  body: unknown;
  /** `true` when no body was sent at all — distinct from an empty object. */
  bodyOmitted: boolean;
}

export interface MockResponse {
  status?: number;
  json?: unknown;
  /** Raw body text; takes precedence over `json`. Use to simulate garbled responses. */
  text?: string;
  /** Throw instead of responding, to simulate a network failure before headers. */
  throws?: Error;
  /** Resolve the response, but make reading its body throw — a mid-body drop. */
  bodyThrows?: Error;
}

/** The three RequestInit header forms. (HeadersInit itself needs the DOM lib.) */
type AnyHeaders = Headers | [string, string][] | Record<string, string>;

/** Handles all three RequestInit header forms, not just the plain record. */
function captureHeaders(headers: AnyHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[k!] = v!;
    return out;
  }
  return { ...headers };
}

/**
 * A `fetch` stand-in that records requests and replays canned responses.
 *
 * No test in this suite touches the network: ordering gift cards from a test
 * runner would spend real money.
 *
 * Queue semantics: an array is strict — one response per request, and a request
 * beyond the end THROWS, so a test can never silently absorb an extra HTTP call
 * (an accidental order retry is exactly the bug class this suite exists to
 * catch). A single object repeats for every request.
 */
export function recordingFetch(responses: MockResponse | MockResponse[] = {}) {
  const strict = Array.isArray(responses);
  const queue = strict ? [...responses] : [responses];
  const calls: CapturedRequest[] = [];

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));

    calls.push({
      method: init?.method ?? 'GET',
      url: url.toString(),
      origin: url.origin,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: captureHeaders(init?.headers as AnyHeaders | undefined),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      bodyOmitted: init?.body === undefined || init?.body === null,
    });

    const next = strict ? queue.shift() : queue[0];
    if (strict && next === undefined) {
      throw new Error(
        `recordingFetch: request #${calls.length} (${init?.method ?? 'GET'} ${url.pathname}) ` +
          'exceeds the queued responses — the code under test made more HTTP calls than the test expected.',
      );
    }
    const mock = next ?? {};
    if (mock.throws) throw mock.throws;

    const status = mock.status ?? 200;
    const bodyText = mock.text ?? JSON.stringify(mock.json ?? { Status: status });
    const response = new Response(bodyText, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
    if (mock.bodyThrows) {
      Object.defineProperty(response, 'text', {
        value: () => Promise.reject(mock.bodyThrows),
      });
    }
    return response;
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}

/** A client wired to a recording fetch, with throwaway credentials. */
export function testClient(
  responses?: MockResponse | MockResponse[],
  options: Partial<HuurayClientOptions> = {},
) {
  const rec = recordingFetch(responses);
  const client = new HuurayClient({
    apiToken: 'test-token',
    apiSecret: 'test-secret',
    fetch: rec.fetch,
    retry: { maxRetries: 0 },
    ...options,
  });
  return { client, calls: rec.calls, fetch: rec.fetch };
}
