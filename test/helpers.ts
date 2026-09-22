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
  /** Parsed JSON body; `undefined` when no body, or no JSON body, was sent. */
  body: unknown;
  /** `true` when no body was sent at all — distinct from an empty object. */
  bodyOmitted: boolean;
  /**
   * What was sent. Only a string sent as `application/json` is JSON-parsed, and
   * a body that fails to parse is `other`, never an exception — so a gate sees
   * it and fails as an assertion instead of the harness crashing.
   */
  bodyKind: 'none' | 'json' | 'multipart' | 'other';
  /** A `FormData` body as fetch would send it; `undefined` for any other body. */
  multipart: CapturedMultipart | undefined;
}

/** A multipart/form-data body, serialised by fetch's own encoder. */
export interface CapturedMultipart {
  /** The Content-Type fetch writes for it, boundary included. */
  contentType: string;
  /** The parts in wire order, or `undefined` when parsing failed — see `error`. */
  parts: CapturedPart[] | undefined;
  error: string | undefined;
}

/** One part of a multipart body, as it went on the wire. */
export interface CapturedPart {
  /** `name` from the part's Content-Disposition. */
  name: string | undefined;
  /** `filename` from the part's Content-Disposition; `undefined` for a plain field. */
  filename: string | undefined;
  /** The part's own Content-Type, if it has one. */
  contentType: string | undefined;
  /** Every header of the part, names lower-cased. */
  headers: Record<string, string>;
  /** The part's content, byte for byte. */
  data: Uint8Array;
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

type CapturedBody = Pick<CapturedRequest, 'body' | 'bodyOmitted' | 'bodyKind' | 'multipart'>;

async function captureBody(
  url: URL,
  init: RequestInit | undefined,
  headers: Record<string, string>,
): Promise<CapturedBody> {
  const raw = init?.body;
  if (raw === undefined || raw === null) {
    return { body: undefined, bodyOmitted: true, bodyKind: 'none', multipart: undefined };
  }
  const sent = { body: undefined, bodyOmitted: false, multipart: undefined };

  if (raw instanceof FormData) {
    // Serialised by fetch's own encoder, with no network: the bytes and the
    // boundary-bearing Content-Type exactly as they would go out — or the
    // caller's own Content-Type, which fetch would send instead.
    let multipart: CapturedMultipart;
    try {
      const request = new Request(url, { method: init?.method ?? 'POST', headers, body: raw });
      const contentType = request.headers.get('content-type') ?? '';
      multipart = parseMultipart(contentType, new Uint8Array(await request.arrayBuffer()));
    } catch (e) {
      multipart = { contentType: '', parts: undefined, error: `fetch could not encode it: ${e}` };
    }
    return { ...sent, bodyKind: 'multipart', multipart };
  }

  const contentType = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type');
  if (typeof raw === 'string' && /^application\/json\b/i.test(contentType?.[1] ?? '')) {
    try {
      return { ...sent, body: JSON.parse(raw), bodyKind: 'json' };
    } catch {
      // Not JSON after all: recorded as `other` below.
    }
  }
  return { ...sent, bodyKind: 'other' };
}

/**
 * A strict multipart/form-data parser (RFC 7578), enough to check what an SDK
 * sends: never throws, and reports the first thing it cannot parse in `error`.
 */
function parseMultipart(contentType: string, bytes: Uint8Array): CapturedMultipart {
  const fail = (error: string): CapturedMultipart => ({ contentType, parts: undefined, error });
  const boundary = /^multipart\/form-data;\s*boundary=([^\s;"]+)$/i.exec(contentType)?.[1];
  if (!boundary) return fail(`not multipart/form-data with a boundary: "${contentType}"`);

  // latin1 maps each byte to one character, so string offsets are byte offsets.
  const text = Buffer.from(bytes).toString('latin1');
  const delimiter = `--${boundary}`;
  if (!text.startsWith(`${delimiter}\r\n`)) return fail('the body does not open with the boundary');

  const parts: CapturedPart[] = [];
  let pos = delimiter.length + 2;
  for (;;) {
    const n = parts.length + 1;
    const headerEnd = text.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) return fail(`part ${n} has no blank line after its headers`);
    const close = text.indexOf(`\r\n${delimiter}`, headerEnd + 4);
    if (close < 0) return fail(`part ${n} is not closed by the boundary`);

    const headers: Record<string, string> = {};
    for (const line of new TextDecoder().decode(bytes.subarray(pos, headerEnd)).split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon < 1) return fail(`part ${n} has a malformed header line`);
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const disposition = headers['content-disposition'] ?? '';
    if (!/^form-data(;|$)/i.test(disposition)) return fail(`part ${n} is not form-data`);
    parts.push({
      name: /;\s*name="([^"]*)"/i.exec(disposition)?.[1],
      filename: /;\s*filename="([^"]*)"/i.exec(disposition)?.[1],
      contentType: headers['content-type'],
      headers,
      data: bytes.slice(headerEnd + 4, close),
    });

    const after = close + 2 + delimiter.length;
    const rest = text.slice(after);
    if (rest === '--\r\n' || rest === '--') return { contentType, parts, error: undefined };
    if (!rest.startsWith('\r\n')) {
      return fail(`part ${n} is followed by neither a part nor the end`);
    }
    pos = after + 2;
  }
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
    const headers = captureHeaders(init?.headers as AnyHeaders | undefined);

    calls.push({
      method: init?.method ?? 'GET',
      url: url.toString(),
      origin: url.origin,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      ...(await captureBody(url, init, headers)),
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
