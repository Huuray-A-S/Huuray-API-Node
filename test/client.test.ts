import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HuurayApiError,
  HuurayAuthError,
  HuurayClient,
  HuurayConfigError,
  HuurayConnectionError,
  HuurayIndeterminateOrderError,
  HuurayNotFoundError,
  HuurayRateLimitError,
  HuurayServerError,
  HuurayTimeoutError,
  HuurayValidationError,
  signRequest,
  type HuurayClientOptions,
  type RetryOptions,
} from '../src/index.js';
import { WAIT } from '../src/client.js';
import { backoffDelay } from '../src/retry.js';
import { recordingFetch, testClient, type MockResponse } from './helpers.js';

/** The error a call throws, synchronously or as a rejection. Fails if it does not throw. */
async function caught(call: () => unknown): Promise<unknown> {
  return Promise.resolve()
    .then(call)
    .then(
      () => {
        throw new Error('must throw');
      },
      (e: unknown) => e,
    );
}

/** Everything a logger or error reporter could print: properties, stacks, the cause chain. */
function dump(err: unknown): string {
  let out = `${String(err)}\n${inspect(err, { depth: Infinity, showHidden: true })}`;
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    out += `\n${e.name}: ${e.message}\n${e.stack ?? ''}`;
  }
  return out;
}

/**
 * A fetch that builds a real `Request` — fetch's own method, URL and header
 * validation, with no network — then answers 200. The recording fetch in
 * helpers.ts skips that validation, and with it the way these inputs used to
 * fail: as a connection error quoting the value.
 */
function validatingFetch(): typeof globalThis.fetch {
  return (async (input: unknown, init?: RequestInit) => {
    new Request(String(input), init);
    return new Response(JSON.stringify({ OrderUID: 'x', Balances: [] }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

/** A 429, with `Retry-After` when given. */
const rateLimited = (retryAfter?: string): MockResponse => ({
  status: 429,
  json: { Status: 429, StatusMessage: 'Too Many Requests' },
  ...(retryAfter === undefined ? {} : { headers: { 'Retry-After': retryAfter } }),
});

/**
 * A client that retries reads twice, on a recording fetch, whose waits between
 * attempts are recorded in `waits` instead of slept.
 */
function retryingClient(responses: MockResponse[], retry: RetryOptions = {}) {
  const rec = recordingFetch(responses);
  const waits: number[] = [];
  const client = new HuurayClient({
    apiToken: 'test-token',
    apiSecret: 'test-secret',
    fetch: rec.fetch,
    retry: { maxRetries: 2, ...retry },
    // An internal key, so the public options type does not know it.
    [WAIT]: async (ms: number) => {
      waits.push(ms);
    },
  } as HuurayClientOptions);
  return { client, calls: rec.calls, waits };
}

describe('construction', () => {
  it('requires an apiToken', () => {
    expect(() => new HuurayClient({ apiToken: '', apiSecret: 's' })).toThrow(HuurayConfigError);
  });

  it('requires an apiSecret', () => {
    expect(() => new HuurayClient({ apiToken: 't', apiSecret: '' })).toThrow(HuurayConfigError);
  });

  it('defaults to the production host', async () => {
    const { client, calls } = testClient();
    await client.balances.list();
    // Pins the actual origin, not just the path — a typo in DEFAULT_BASE_URL
    // must not ship green.
    expect(calls[0]?.origin).toBe('https://api.huuray.com');
    expect(calls[0]?.path).toBe('/v4/Balance');
  });

  it.each([
    // '/v4' is the case that differs by platform in other languages: not
    // absolute on Windows, a valid file:// URI on Linux and macOS. Validating
    // the scheme makes the behaviour identical everywhere.
    '/v4',
    'v4',
    'api.huuray.com',
    'file:///etc/passwd',
    'ftp://example.test',
  ])('rejects a base URL that is not absolute http(s): %s', (bad) => {
    expect(() => new HuurayClient({ apiToken: 't', apiSecret: 's', baseUrl: bad })).toThrow(
      HuurayConfigError,
    );
  });

  it.each([
    ['not absolute', 'marker.test/PASS-5e8c', /not an absolute http\(s\) URL/],
    ['unparseable', 'https://user:PASS-5e8c@[marker.test', /not an absolute http\(s\) URL/],
    ['not http(s)', 'ftp://user:PASS-5e8c@marker.test', /must use http or https/],
  ])('rejects a base URL that is %s without quoting it anywhere', async (_, bad, problem) => {
    // The URL parser's own error carries the input, so it must not ride along as the cause.
    const err = await caught(
      () => new HuurayClient({ apiToken: 't', apiSecret: 's', baseUrl: bad }),
    );
    expect(err).toBeInstanceOf(HuurayConfigError);
    expect((err as Error).message).toMatch(problem);
    expect((err as Error).message).toContain('Expected something like "https://api.huuray.com".');
    expect(dump(err)).not.toContain('PASS-5e8c');
    expect(dump(err)).not.toContain('marker.test');
  });

  it.each([
    // Node's fetch refuses every request to a URL with user-info, in a message
    // quoting it, password included; a fetch that accepts user-info sends it on.
    ['user-info with a password', 'https://user:PASS-5e8c@marker.test', /user-info/],
    ['user-info with only a user name', 'https://PASS-5e8c@marker.test', /user-info/],
    ['user-info with only a password', 'https://:PASS-5e8c@marker.test', /user-info/],
    ['an empty user-info', 'https://@marker.test/PASS-5e8c', /user-info/],
    ['user-info after backslashes', 'https:\\\\PASS-5e8c@marker.test', /user-info/],
    ['user-info with an upper-case scheme', 'HTTPS://user:PASS-5e8c@marker.test', /user-info/],
    ['user-info and a trailing slash', 'http://user:PASS-5e8c@marker.test:8080/', /user-info/],
    // Paths are appended as text, so they would land in the query or fragment.
    ['a query', 'https://marker.test/?key=PASS-5e8c', /query/],
    ['an empty query', 'https://marker.test/PASS-5e8c?', /query/],
    ['a fragment', 'https://marker.test#PASS-5e8c', /fragment/],
    ['an empty fragment', 'https://marker.test/PASS-5e8c/#', /fragment/],
  ])('rejects a base URL with %s without quoting it anywhere', async (_, bad, problem) => {
    const err = await caught(
      () => new HuurayClient({ apiToken: 't', apiSecret: 's', baseUrl: bad }),
    );
    expect(err).toBeInstanceOf(HuurayConfigError);
    expect((err as Error).message).toMatch(problem);
    expect((err as Error).message).toContain('Expected something like "https://api.huuray.com".');
    expect(dump(err)).not.toContain('PASS-5e8c');
    expect(dump(err)).not.toContain('marker.test');
  });

  it('keeps an "@" in the base URL path, which is not user-info', async () => {
    const { client, calls } = testClient(undefined, { baseUrl: 'https://example.test/a@b/' });
    await client.balances.list();
    expect(calls[0]?.origin).toBe('https://example.test');
    expect(calls[0]?.path).toBe('/a@b/v4/Balance');
  });

  it('keeps an "@" after a backslash, which ends the host as "/" does', async () => {
    const { client, calls } = testClient(undefined, { baseUrl: 'https://example.test\\a@b/' });
    await client.balances.list();
    expect(calls[0]?.origin).toBe('https://example.test');
    expect(calls[0]?.path).toBe('/a@b/v4/Balance');
  });

  it.each(['https://api.huuray.com', 'http://localhost:8080', 'http://localhost:8080/api/'])(
    'accepts an absolute http(s) base URL: %s',
    (good) => {
      expect(
        () => new HuurayClient({ apiToken: 't', apiSecret: 's', baseUrl: good }),
      ).not.toThrow();
    },
  );

  it('accepts a base URL with a trailing slash', async () => {
    const { client, calls } = testClient(undefined, { baseUrl: 'https://example.test/' });
    await client.balances.list();
    expect(calls[0]?.origin).toBe('https://example.test');
    expect(calls[0]?.path).toBe('/v4/Balance');
  });

  it.each([
    // The URL parser would strip, percent-encode or punycode each of these
    // rather than reject it.
    ['a trailing space', 'https://marker.test '],
    ['a leading space', ' https://marker.test'],
    ['a space in the path', 'https://marker.test/a b'],
    ['a line break', 'https://marker.test/\n'],
    ['a tab', 'https://marker.test\t'],
    ['NUL', 'https://marker.test/\x00'],
    ['DEL', 'https://marker.test/\x7F'],
    ['a non-ASCII host', 'https://m\xE4rker.test'],
    ['a non-ASCII path', 'https://marker.test/\xE9'],
  ])('rejects a base URL containing %s, without quoting it', async (_, bad) => {
    const err = await caught(
      () => new HuurayClient({ apiToken: 't', apiSecret: 's', baseUrl: bad }),
    );
    expect(err).toBeInstanceOf(HuurayConfigError);
    expect((err as Error).message).not.toContain('rker.test');
  });

  it.each([' ', '   ', '\t\n'])('treats a whitespace-only apiToken as missing: %j', (token) => {
    // fetch trims header values, so this would send a blank X-API-TOKEN.
    expect(() => new HuurayClient({ apiToken: token, apiSecret: 's' })).toThrow(
      /apiToken is required/,
    );
  });

  const unsendable = [
    ['a line break', 'MARK-7f3a\r\nX-Injected: yes'],
    ['a trailing newline', 'MARK-7f3a\n'],
    ['NUL', 'MARK-7f3a\x00x'],
    ['a tab', 'MARK-7f3a\tx'],
    ['DEL', 'MARK-7f3a\x7Fx'],
    ['another control character', 'MARK-7f3a\x01x'],
    ['a character above U+00FF', 'MARK-7f3a\u{100}'],
  ] as const;

  it.each(unsendable)('rejects an apiToken containing %s, without quoting it', async (_, token) => {
    const err = await caught(() => new HuurayClient({ apiToken: token, apiSecret: 's' }));
    expect(err).toBeInstanceOf(HuurayConfigError);
    expect((err as Error).message).not.toContain('MARK-7f3a');
  });

  it.each(unsendable)('rejects a userAgent containing %s, without quoting it', async (_, ua) => {
    const err = await caught(
      () => new HuurayClient({ apiToken: 't', apiSecret: 's', userAgent: ua }),
    );
    expect(err).toBeInstanceOf(HuurayConfigError);
    expect((err as Error).message).not.toContain('MARK-7f3a');
  });

  it.each([
    // Node fires after 1 ms for 0 and, with a warning, for 2147483648 to
    // 4294967295; it throws for the rest only when a request is attempted.
    0,
    -1,
    0.5,
    1500.5,
    NaN,
    Infinity,
    -Infinity,
    2_147_483_648,
    4_294_967_295,
    4_294_967_296,
    '1000' as unknown as number,
  ])('rejects timeoutMs %o, which the runtime does not honour', (timeoutMs) => {
    expect(() => new HuurayClient({ apiToken: 't', apiSecret: 's', timeoutMs })).toThrow(
      new HuurayConfigError(
        'timeoutMs must be a whole number of milliseconds from 1 to 2147483647, ' +
          `received ${String(timeoutMs)}.`,
      ),
    );
  });

  it.each([1, 30_000, 2_147_483_647])('accepts timeoutMs %j', (timeoutMs) => {
    expect(() => new HuurayClient({ apiToken: 't', apiSecret: 's', timeoutMs })).not.toThrow();
  });

  it('still sends a userAgent suffix of visible text', async () => {
    const { client, calls } = testClient(undefined, { userAgent: 'my-app/1.2 (payroll)' });
    await client.balances.list();
    expect(calls[0]?.headers['User-Agent']).toMatch(/^huuray-node\/\S+ my-app\/1\.2 \(payroll\)$/);
  });

  it('takes the options alone: the wait between retries is not a constructor argument', async () => {
    const rec = recordingFetch([{ status: 503 }, { status: 200, json: { Balances: [] } }]);
    const wait = vi.fn(async () => {});
    const client = new HuurayClient(
      {
        apiToken: 't',
        apiSecret: 's',
        fetch: rec.fetch,
        retry: { maxRetries: 1, baseDelayMs: 0 },
      },
      // @ts-expect-error The constructor takes one argument.
      wait,
    );
    await client.balances.list();
    expect(rec.calls).toHaveLength(2);
    expect(wait).not.toHaveBeenCalled();
  });

  it('keeps the key the test suite injects a wait under out of the package exports', async () => {
    const exported: Record<string, unknown> = await import('../src/index.js');
    expect(Object.values(exported)).not.toContain(WAIT);
    expect(exported).not.toHaveProperty('WAIT');
    // @ts-expect-error Nor is it a client option.
    const options: HuurayClientOptions = { apiToken: 't', apiSecret: 's', [WAIT]: async () => {} };
    expect(Reflect.ownKeys(options)).toContain(WAIT);
  });

  it('invokes an injected fetch without binding `this` to the client', async () => {
    // Browser fetch and some polyfills throw "Illegal invocation" when called
    // with a foreign `this`. Simulate that sensitivity.
    const calls: string[] = [];
    function thisSensitiveFetch(this: unknown, input: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ Balances: [] }), { status: 200 }),
      );
    }
    const client = new HuurayClient({
      apiToken: 't',
      apiSecret: 's',
      fetch: thisSensitiveFetch as unknown as typeof globalThis.fetch,
    });
    await expect(client.balances.list()).resolves.toEqual({ balances: [] });
    expect(calls).toHaveLength(1);
  });
});

describe('signing per request', () => {
  it('sends the three auth headers on every call', async () => {
    const { client, calls } = testClient();
    await client.balances.list();
    await client.templates.list();
    for (const call of calls) {
      expect(call.headers['X-API-TOKEN']).toBe('test-token');
      expect(call.headers['X-API-NONCE']).toBeTruthy();
      expect(call.headers['X-API-HASH']).toMatch(/^[0-9a-f]{128}$/);
    }
  });

  it('uses a fresh nonce for every request', async () => {
    const { client, calls } = testClient();
    await client.balances.list();
    await client.balances.list();
    await client.balances.list();
    const nonces = calls.map((c) => c.headers['X-API-NONCE']);
    expect(new Set(nonces).size).toBe(3);
  });

  it('never sends the secret', async () => {
    const { client, calls } = testClient();
    await client.balances.list();
    expect(JSON.stringify(calls[0])).not.toContain('test-secret');
  });

  it('honours a hashEncoding override', async () => {
    const { client, calls } = testClient(undefined, { hashEncoding: 'base64' });
    await client.balances.list();
    expect(calls[0]?.headers['X-API-HASH']).not.toMatch(/^[0-9a-f]{128}$/);
  });
});

describe('error mapping', () => {
  it.each([
    [401, HuurayAuthError],
    [403, HuurayAuthError],
    [404, HuurayNotFoundError],
    [422, HuurayValidationError],
    [429, HuurayRateLimitError],
    [500, HuurayServerError],
    [400, HuurayApiError],
  ])('maps HTTP %i to the right error type', async (status, type) => {
    const { client } = testClient({ status, json: { Status: status, StatusMessage: 'nope' } });
    await expect(client.balances.list()).rejects.toBeInstanceOf(type);
  });

  it('prefers StatusMessage over the deprecated Message field', async () => {
    const { client } = testClient({
      status: 400,
      json: { Status: 400, Message: 'old text', StatusMessage: 'new text' },
    });
    await expect(client.balances.list()).rejects.toMatchObject({ statusMessage: 'new text' });
  });

  it('falls back to Message when StatusMessage is absent', async () => {
    const { client } = testClient({ status: 400, json: { Status: 400, Message: 'old text' } });
    await expect(client.balances.list()).rejects.toMatchObject({ statusMessage: 'old text' });
  });

  it('exposes the HTTP status and the parsed body', async () => {
    const { client } = testClient({ status: 422, json: { Status: 422, StatusMessage: 'bad' } });
    await expect(client.balances.list()).rejects.toMatchObject({
      httpStatus: 422,
      status: 422,
      method: 'GET',
      path: '/v4/Balance',
    });
  });

  it('maps a 429 to HuurayRateLimitError, an API error, with the Retry-After seconds', async () => {
    const { client } = testClient(rateLimited('17'));
    const err = await caught(() => client.balances.list());
    expect(err).toBeInstanceOf(HuurayRateLimitError);
    expect(err).toBeInstanceOf(HuurayApiError);
    expect(err).toMatchObject({
      name: 'HuurayRateLimitError',
      httpStatus: 429,
      status: 429,
      statusMessage: 'Too Many Requests',
      retryAfter: 17,
      method: 'GET',
      path: '/v4/Balance',
    });
  });

  it.each([
    ['no Retry-After header', undefined, null],
    ['a Retry-After of 0', '0', 0],
    ['surrounding spaces', ' 7 ', 7],
    ['an HTTP date', 'Wed, 21 Oct 2026 07:28:00 GMT', null],
    ['a fraction', '1.5', null],
    ['a negative number', '-5', null],
    ['a number too large to be whole', '99999999999999999999', null],
  ])('reads the retryAfter of a 429 with %s', async (_, header, expected) => {
    const { client } = testClient(rateLimited(header));
    const err = await caught(() => client.balances.list());
    expect(err).toBeInstanceOf(HuurayRateLimitError);
    expect((err as HuurayRateLimitError).retryAfter).toBe(expected);
  });

  it('keeps Retry-After only on a 429', async () => {
    const { client } = testClient({ status: 503, headers: { 'Retry-After': '17' } });
    const err = await caught(() => client.balances.list());
    expect(err).toBeInstanceOf(HuurayServerError);
    expect(err).not.toHaveProperty('retryAfter');
  });

  it.each([
    [503, HuurayServerError],
    [422, HuurayValidationError],
    [400, HuurayApiError],
  ])('reads no header at all on a %i', async (status, type) => {
    // Only a 429 documents a header, so nothing an injected fetch does with
    // `headers` can replace another error.
    const response = {
      ok: false,
      status,
      text: async () => '',
      get headers(): never {
        throw new Error('the headers were read');
      },
    };
    const client = new HuurayClient({
      apiToken: 't',
      apiSecret: 's',
      fetch: (async () => response) as unknown as typeof globalThis.fetch,
    });
    expect(await caught(() => client.balances.list())).toBeInstanceOf(type);
  });

  it.each([
    ['no headers', {}],
    ['headers that are null', { headers: null }],
  ])('maps a 429 from a fetch whose response has %s, with no retryAfter', async (_, extra) => {
    const response = { ok: false, status: 429, text: async () => '', ...extra };
    const client = new HuurayClient({
      apiToken: 't',
      apiSecret: 's',
      fetch: (async () => response) as unknown as typeof globalThis.fetch,
    });
    const err = await caught(() => client.balances.list());
    expect(err).toBeInstanceOf(HuurayRateLimitError);
    expect(err).toMatchObject({ httpStatus: 429, retryAfter: null });
  });

  it('redacts bearer and contact fields from the retained error body', async () => {
    const { client } = testClient({
      status: 400,
      json: { Status: 400, StatusMessage: 'bad', Code: 'LEAKED-CODE', Email: 'jane@example.com' },
    });
    const err: unknown = await client.balances.list().then(
      () => { throw new Error('must reject'); },
      (e: unknown) => e,
    );
    const dumped = JSON.stringify((err as HuurayApiError).body);
    expect(dumped).not.toContain('LEAKED-CODE');
    expect(dumped).not.toContain('jane@example.com');
  });
});

describe('retry policy', () => {
  const order = { productToken: 't', value: 100, currency: 'DKK', quantity: 1 };

  it('retries a read on 503', async () => {
    const { client, calls } = testClient(
      [{ status: 503 }, { status: 200, json: { Balances: [] } }],
      { retry: { maxRetries: 2, baseDelayMs: 1 } },
    );
    await client.balances.list();
    expect(calls).toHaveLength(2);
  });

  it('never retries an order, even on 503', async () => {
    const { client, calls } = testClient({ status: 503 }, { retry: { maxRetries: 3, baseDelayMs: 1 } });
    await client.orders
      .create({ productToken: 't', value: 100, currency: 'DKK', quantity: 1 })
      .catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  it('never retries a resend — it would re-deliver real value', async () => {
    const { client, calls } = testClient({ status: 503 }, { retry: { maxRetries: 3, baseDelayMs: 1 } });
    await client.orders.resend({ orderUid: 'x' }).catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  it('never retries a cancel', async () => {
    const { client, calls } = testClient({ status: 503 }, { retry: { maxRetries: 3, baseDelayMs: 1 } });
    await client.orders.cancel({ orderUid: 'x' }).catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['orders.create()', (c: HuurayClient) => c.orders.create(order)],
    ['orders.createSync()', (c: HuurayClient) => c.orders.createSync(order)],
    [
      'sendReward()',
      (c: HuurayClient) =>
        c.sendReward({
          productToken: 't',
          value: 100,
          currency: 'DKK',
          recipient: { email: 'jane@example.com' },
          templateId: 42,
          refId: 'r',
        }),
    ],
    ['orders.resend()', (c: HuurayClient) => c.orders.resend({ orderUid: 'x' })],
    ['orders.cancel()', (c: HuurayClient) => c.orders.cancel({ orderUid: 'x' })],
    [
      'uploads.create()',
      (c: HuurayClient) => c.uploads.create({ file: new Uint8Array([1]), fileName: 'po.pdf' }),
    ],
  ])('never retries %s on a 429: it throws the rate-limit error at once', async (_, write) => {
    const { client, calls, waits } = retryingClient([rateLimited('1')], { maxRetries: 3 });
    const err = await caught(() => write(client));
    expect(err).toBeInstanceOf(HuurayRateLimitError);
    expect(err).not.toBeInstanceOf(HuurayIndeterminateOrderError);
    expect(err).toMatchObject({ httpStatus: 429, retryAfter: 1 });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('does not retry a 400 — the request is wrong, repeating will not help', async () => {
    const { client, calls } = testClient({ status: 400 }, { retry: { maxRetries: 3, baseDelayMs: 1 } });
    await client.balances.list().catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  it('treats an explicitly-undefined retry option as the default, not as a clobber', async () => {
    // `retry: { maxRetries: undefined }` is the natural result of threading
    // optional config. It must fall back to the default rather than skipping
    // the request loop and throwing the literal value `undefined`.
    const { client, calls } = testClient(undefined, {
      retry: { maxRetries: undefined, baseDelayMs: undefined, maxDelayMs: undefined },
    });
    await expect(client.balances.list()).resolves.toBeDefined();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('clamps a negative maxRetries to zero instead of never sending', async () => {
    const { client, calls } = testClient(undefined, { retry: { maxRetries: -3 } });
    await expect(client.balances.list()).resolves.toBeDefined();
    expect(calls).toHaveLength(1);
  });
});

describe('the backoff between retries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The longest delay a timer holds. Past it, Node warns and waits about 1 ms. */
  const TIMER_LIMIT_MS = 2_147_483_647;
  const ok: MockResponse = { status: 200, json: { Balances: [] } };
  const unavailable = (times: number): MockResponse[] =>
    Array.from({ length: times }, () => ({ status: 503 }));

  it('doubles from baseDelayMs up to maxDelayMs, and stays there', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const { client, waits } = retryingClient([...unavailable(6), ok], { maxRetries: 6 });
    await client.balances.list();
    expect(waits).toEqual([250, 500, 1000, 2000, 4000, 4000]);
  });

  it.each([TIMER_LIMIT_MS + 1, 1e15, Number.POSITIVE_INFINITY])(
    'is never longer than a timer can hold, with a maxDelayMs of %d',
    async (maxDelayMs) => {
      vi.spyOn(Math, 'random').mockReturnValue(1);
      const { client, waits } = retryingClient([...unavailable(40), ok], {
        maxRetries: 40,
        maxDelayMs,
      });
      await client.balances.list();
      // 250 ms doubles to 2097152000 ms by the 24th wait; the 25th would pass the limit.
      expect(waits.slice(0, 24)).toEqual(Array.from({ length: 24 }, (_, i) => 250 * 2 ** i));
      expect(waits.slice(24)).toEqual(Array.from({ length: 16 }, () => TIMER_LIMIT_MS));

      // A timer takes the longest of them as it is: no TimeoutOverflowWarning,
      // after which it would fire in about 1 ms.
      const warned = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
      clearTimeout(setTimeout(() => {}, Math.max(...waits)));
      expect(warned).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['baseDelayMs is NaN', { baseDelayMs: Number.NaN }],
    ['maxDelayMs is NaN', { maxDelayMs: Number.NaN }],
    ['both are NaN', { baseDelayMs: Number.NaN, maxDelayMs: Number.NaN }],
  ])('waits 0 ms, never NaN, when %s', async (_, retry) => {
    const { client, calls, waits } = retryingClient([...unavailable(2), ok], retry);
    await client.balances.list();
    expect(waits).toEqual([0, 0]);
    expect(calls).toHaveLength(3);
  });

  it('waits 0 ms, never NaN, with a baseDelayMs of 0, however often it has doubled', () => {
    // 2 ** 1024 is Infinity, and 0 * Infinity is NaN.
    expect(backoffDelay(1024, { maxRetries: 1025, baseDelayMs: 0, maxDelayMs: 4000 })).toBe(0);
  });
});

describe('a 429 on a read', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Pins the jitter, so a computed backoff is its ceiling: 250 ms, then 500 ms. */
  const noJitter = () => vi.spyOn(Math, 'random').mockReturnValue(1);

  it('waits the Retry-After seconds in place of the backoff, then asks again with a new nonce', async () => {
    noJitter();
    const { client, calls, waits } = retryingClient([
      rateLimited('3'),
      { status: 200, json: { Balances: [] } },
    ]);
    await expect(client.balances.list()).resolves.toEqual({ balances: [] });
    expect(waits).toEqual([3000]);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.headers['X-API-NONCE'])).size).toBe(2);
  });

  it('waits a Retry-After shorter than the backoff: it replaces it, as neither the longer of the two nor their sum', async () => {
    noJitter();
    // The backoff would be 5000 ms, then 10000 ms.
    const { client, waits } = retryingClient(
      [rateLimited('2'), rateLimited('3'), { status: 200, json: { Balances: [] } }],
      { baseDelayMs: 5000, maxDelayMs: 10_000 },
    );
    await client.balances.list();
    expect(waits).toEqual([2000, 3000]);
  });

  it('honours each Retry-After in turn, up to exactly maxDelayMs', async () => {
    const { client, calls, waits } = retryingClient([
      rateLimited('2'),
      rateLimited('4'),
      { status: 200, json: { Balances: [] } },
    ]);
    await client.balances.list();
    expect(waits).toEqual([2000, 4000]);
    expect(calls).toHaveLength(3);
  });

  it('waits at least 1 second, whatever Retry-After says', async () => {
    const { client, waits } = retryingClient([
      rateLimited('0'),
      { status: 200, json: { Balances: [] } },
    ]);
    await client.balances.list();
    expect(waits).toEqual([1000]);
  });

  it('retries a POST that is a read the same way', async () => {
    const { client, calls, waits } = retryingClient([
      rateLimited('2'),
      { status: 200, json: { OrderUID: 'uid-7', Vouchers: [] } },
    ]);
    await expect(client.orders.search({ refId: 'ref-9' })).resolves.toMatchObject({
      orderUid: 'uid-7',
    });
    expect(waits).toEqual([2000]);
    expect(calls).toHaveLength(2);
  });

  it('throws at once, without waiting, when Retry-After is longer than maxDelayMs', async () => {
    // The default maxDelayMs is 4000. The strict queue holds one response.
    const { client, calls, waits } = retryingClient([rateLimited('5')]);
    const err = await caught(() => client.balances.list());
    expect(err).toBeInstanceOf(HuurayRateLimitError);
    expect(err).toMatchObject({ retryAfter: 5 });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it.each([
    ['of 4, with the default maxDelayMs of 4000', '4', {}, 4000],
    ['of 1, with a maxDelayMs of 1000', '1', { maxDelayMs: 1000 }, 1000],
    ['of 0, which is 1 second, with a maxDelayMs of 1000', '0', { maxDelayMs: 1000 }, 1000],
    ['of 30, with a maxDelayMs of 30000', '30', { maxDelayMs: 30_000 }, 30_000],
    [
      'of 2147483, the longest a timer holds in whole seconds, with no maxDelayMs to speak of',
      '2147483',
      { maxDelayMs: Number.POSITIVE_INFINITY },
      2_147_483_000,
    ],
  ])('waits a Retry-After %s: a wait equal to the limit is made', async (_, header, retry, ms) => {
    const { client, calls, waits } = retryingClient(
      [rateLimited(header), { status: 200, json: { Balances: [] } }],
      retry,
    );
    await client.balances.list();
    expect(waits).toEqual([ms]);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['0', 500],
    ['0', 999],
    ['1', 999],
    ['3', 999],
    ['0', 0],
    ['1', Number.NaN],
  ])(
    'never retries a Retry-After of %s with a maxDelayMs of %d: the wait is at least 1 second',
    async (header, maxDelayMs) => {
      const { client, calls, waits } = retryingClient([rateLimited(header)], { maxDelayMs });
      const err = await caught(() => client.balances.list());
      expect(err).toBeInstanceOf(HuurayRateLimitError);
      expect(calls).toHaveLength(1);
      expect(waits).toEqual([]);
    },
  );

  it('waits a longer Retry-After when maxDelayMs allows it', async () => {
    const { client, waits } = retryingClient(
      [rateLimited('30'), { status: 200, json: { Balances: [] } }],
      { maxDelayMs: 60_000 },
    );
    await client.balances.list();
    expect(waits).toEqual([30_000]);
  });

  it('throws at once on a Retry-After no timer can hold, whatever maxDelayMs is', async () => {
    const { client, calls, waits } = retryingClient([rateLimited('2147484')], {
      maxDelayMs: Number.POSITIVE_INFINITY,
    });
    const err = await caught(() => client.balances.list());
    expect(err).toBeInstanceOf(HuurayRateLimitError);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it.each([
    ['no Retry-After', undefined],
    ['a Retry-After that is not whole seconds', 'soon'],
  ])('falls back to the computed backoff on %s', async (_, header) => {
    noJitter();
    const { client, calls, waits } = retryingClient([
      rateLimited(header),
      rateLimited(header),
      { status: 200, json: { Balances: [] } },
    ]);
    await client.balances.list();
    expect(waits).toEqual([250, 500]);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.headers['X-API-NONCE'])).size).toBe(3);
  });

  it('does not carry a Retry-After over to the wait after a later attempt', async () => {
    noJitter();
    const { client, waits } = retryingClient([
      rateLimited('3'),
      { status: 503 },
      { status: 200, json: { Balances: [] } },
    ]);
    await client.balances.list();
    expect(waits).toEqual([3000, 500]);
  });

  it.each([408, 425, 500, 502, 503, 504])(
    'ignores a Retry-After on a retried %i: the wait is the backoff',
    async (status) => {
      noJitter();
      const { client, calls, waits } = retryingClient([
        { status, headers: { 'Retry-After': '3' } },
        { status, headers: { 'Retry-After': '0' } },
        { status: 200, json: { Balances: [] } },
      ]);
      await client.balances.list();
      expect(waits).toEqual([250, 500]);
      expect(calls).toHaveLength(3);
    },
  );

  it('throws the rate-limit error when the retries are used up', async () => {
    const { client, calls, waits } = retryingClient([
      rateLimited('1'),
      rateLimited('1'),
      rateLimited('2'),
    ]);
    const err = await caught(() => client.balances.list());
    expect(err).toBeInstanceOf(HuurayRateLimitError);
    expect(err).toMatchObject({ httpStatus: 429, retryAfter: 2 });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 1000]);
  });

  it('throws it at once with maxRetries 0', async () => {
    const { client, calls, waits } = retryingClient([rateLimited('1')], { maxRetries: 0 });
    await expect(client.balances.list()).rejects.toBeInstanceOf(HuurayRateLimitError);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('really waits, with the default timer, when no wait is injected', async () => {
    const { client, calls } = testClient(
      [rateLimited('1'), { status: 200, json: { Balances: [] } }],
      { retry: { maxRetries: 1 } },
    );
    const start = performance.now();
    await client.balances.list();
    // A timer may fire a little before the clock reads the full second.
    expect(performance.now() - start).toBeGreaterThanOrEqual(950);
    expect(calls).toHaveLength(2);
  });
});

describe('transport faults on the response body', () => {
  it('maps a mid-body connection drop into the error taxonomy, not a raw DOMException', async () => {
    const { client } = testClient({ bodyThrows: new TypeError('terminated') });
    const err: unknown = await client.balances.list().then(
      () => { throw new Error('must reject'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HuurayConnectionError);
  });

  it('maps a mid-body timeout to HuurayTimeoutError', async () => {
    const abort = new DOMException('The operation timed out.', 'TimeoutError');
    const { client } = testClient({ bodyThrows: abort }, { timeoutMs: 1234 });
    const err: unknown = await client.balances.list().then(
      () => { throw new Error('must reject'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HuurayTimeoutError);
    expect(err).toMatchObject({ timeoutMs: 1234 });
    expect((err as Error).message).toBe('GET /v4/Balance timed out after 1234ms.');
  });

  it('treats a garbled 200 body as a transport fault, never as an empty result', async () => {
    // An empty result from a garbled /v4/Search response would tell the
    // reconciliation flow "the order did not land" — inviting a double order.
    const { client } = testClient({ status: 200, text: '<html>gateway error</html>' });
    await expect(client.orders.search({ refId: 'r' })).rejects.toBeInstanceOf(
      HuurayConnectionError,
    );
  });

  it('treats an empty 200 body the same way', async () => {
    const { client } = testClient({ status: 200, text: '' });
    await expect(client.balances.list()).rejects.toBeInstanceOf(HuurayConnectionError);
  });

  it('retries a retryable read after a garbled body', async () => {
    const { client, calls } = testClient(
      [
        { status: 200, text: 'not json' },
        { status: 200, json: { Balances: [] } },
      ],
      { retry: { maxRetries: 2, baseDelayMs: 1 } },
    );
    await expect(client.balances.list()).resolves.toEqual({ balances: [] });
    expect(calls).toHaveLength(2);
  });
});

describe('request() escape hatch', () => {
  it('calls any endpoint with signing handled', async () => {
    const { client, calls } = testClient({ status: 200, json: { OrderUID: 'abc' } });
    const out = await client.request<{ OrderUID: string }>('POST', '/v4/Search', {
      RefID: 'payroll-2026-08-jane',
    });
    expect(out.OrderUID).toBe('abc');
    expect(calls[0]?.body).toEqual({ RefID: 'payroll-2026-08-jane' });
    expect(calls[0]?.headers['X-API-HASH']).toBeTruthy();
  });

  it.each([
    ['a line break', 'GET\r\nX-Injected: yes'],
    ['a space', 'GE T'],
    ['NUL', 'GET\x00'],
    ['a tab', 'G\tET'],
    ['nothing', ''],
    ['a separator', 'GET/'],
    ['a non-ASCII letter', 'G\xC9T'],
  ])('rejects a method containing %s before anything is sent', async (_, method) => {
    const { client, calls } = testClient();
    const err = await caught(() => client.request(method, '/v4/Balance'));
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe(
      'The request was not sent: the HTTP method must be a token such as GET, POST or DELETE.',
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects a bad method as a TypeError, not the connection error fetch would raise', async () => {
    const client = new HuurayClient({ apiToken: 't', apiSecret: 's', fetch: validatingFetch() });
    const err = await caught(() => client.request('PO ST', '/v4/Order', {}));
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(HuurayConnectionError);
  });

  it.each(['CONNECT', 'connect', 'TRACE', 'tRaCe', 'TRACK', 'track'])(
    'rejects %s, a token fetch forbids in any case, before anything is sent',
    async (method) => {
      const { client, calls } = testClient();
      const err = await caught(() => client.request(method, '/v4/Balance'));
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).toBe(
        'The request was not sent: fetch does not allow the CONNECT, TRACE or TRACK method.',
      );
      expect(calls).toHaveLength(0);
    },
  );

  it('rejects a forbidden method as a TypeError, not the connection error fetch would raise', async () => {
    // fetch's own error is a TypeError quoting the method, which the client
    // used to wrap in HuurayConnectionError.
    const client = new HuurayClient({ apiToken: 't', apiSecret: 's', fetch: validatingFetch() });
    const err = await caught(() => client.request('Track', '/v4/Search', {}));
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(HuurayConnectionError);
    expect(dump(err)).not.toContain('Track');
  });

  it.each([
    ['"@host", which would move the request to another host', '@evil.example/v4/Order'],
    ['".host", which would extend the host name', '.evil.example/v4/Balance'],
    ['an absolute URL', 'http://evil.example/v4/Balance'],
    ['":port", which would move the request to another port', ':8443/v4/Balance'],
    ['no leading slash', 'v4/Balance'],
    ['a line break', '/v4/Balance\r\nX-Injected: yes'],
    ['a space', '/v4/Ba lance'],
    ['NUL', '/v4/Balance\x00'],
    ['a tab', '/v4/\tBalance'],
    ['DEL', '/v4/Balance\x7F'],
    ['a non-ASCII character', '/v4/\u{2028}'],
    ['nothing at all', ''],
  ])('rejects a path with %s before anything is sent', async (_, path) => {
    const { client, calls } = testClient();
    const err = await caught(() => client.request('GET', path));
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe(
      'GET request was not sent: the path must start with "/" and contain only visible ASCII.',
    );
    expect(calls).toHaveLength(0);
  });

  it('keeps a path starting with "//" on the configured host', async () => {
    // The path is appended to the base URL as text, not resolved against it,
    // so "//host" is only a path here.
    const { client, calls } = testClient();
    await client.request('GET', '//evil.example/v4/Balance');
    expect(calls[0]?.origin).toBe('https://api.huuray.com');
    expect(calls[0]?.path).toBe('//evil.example/v4/Balance');
  });
});

describe('custom nonces', () => {
  it.each([
    ['no characters', ''],
    ['a line break', 'MARK-7f3a\r\nX-Injected: yes'],
    ['a trailing newline', 'MARK-7f3a\n'],
    ['a tab', 'MARK-7f3a\tx'],
    ['DEL', 'MARK-7f3a\x7F'],
    ['a leading space', ' MARK-7f3a'],
    ['a character above U+00FF', 'MARK-7f3a\u{100}'],
  ])('rejects a nonce with %s before sending, without quoting it', async (_, nonce) => {
    const { client, calls } = testClient(undefined, { nonceFactory: () => nonce });
    const err = await caught(() => client.balances.list());
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).not.toContain('MARK-7f3a');
    expect(calls).toHaveLength(0);
  });

  it('never reports a refused nonce on an order as indeterminate', async () => {
    // Nothing was sent, so there is nothing to reconcile.
    const client = new HuurayClient({
      apiToken: 't',
      apiSecret: 's',
      fetch: validatingFetch(),
      nonceFactory: () => 'MARK-7f3a\r\nX-Injected: yes',
    });
    const err = await caught(() =>
      client.orders.create({ productToken: 'p', value: 100, currency: 'DKK', quantity: 1 }),
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(HuurayIndeterminateOrderError);
  });
});

describe('pre-send failures never leak credentials or recipient data', () => {
  const TOKEN = 'TOKEN-7f3a';
  const SECRET = 'SECRET-9b1c';
  const NONCE = 'NONCE-2d4e';
  const recipient = { name: 'Jane Markname', email: 'jane.mark@example.com', phone: '+4512345678' };
  const order = {
    productToken: 'p',
    value: 100,
    currency: 'DKK',
    quantity: 1,
    refId: 'r',
    templateId: 1,
    recipients: [recipient],
  };
  const search = {
    RecipientName: recipient.name,
    RecipientEmail: recipient.email,
    RecipientPhone: recipient.phone,
  };

  const client = (options: Partial<HuurayClientOptions> = {}) =>
    new HuurayClient({
      apiToken: TOKEN,
      apiSecret: SECRET,
      fetch: validatingFetch(),
      nonceFactory: () => NONCE,
      ...options,
    });

  it.each([
    [
      'a token with a line break',
      () => client({ apiToken: `${TOKEN}\r\nX: y` }).orders.create(order),
    ],
    [
      'a nonce with a line break',
      () => client({ nonceFactory: () => `${NONCE}\r\nX: y` }).orders.create(order),
    ],
    [
      'a nonce with a trailing space',
      () => client({ nonceFactory: () => `${NONCE} ` }).orders.create(order),
    ],
    ['a method that is not a token', () => client().request('PO ST', '/v4/Search', search)],
    [
      'a path that would move the host',
      () => client().request('POST', '@evil.example/v4/Search', search),
    ],
    [
      'a body with a BigInt',
      () => client().request('POST', '/v4/Search', { ...search, VoucherID: 1n }),
    ],
    [
      'a circular body',
      () => {
        const body: Record<string, unknown> = { ...search };
        body['self'] = body;
        return client().request('POST', '/v4/Search', body);
      },
    ],
    [
      'a recipient JSON cannot encode',
      () =>
        client().orders.create({
          ...order,
          recipients: [{ ...recipient, refId: 1n as unknown as string }],
        }),
    ],
  ])('%s', async (_, call) => {
    const err = await caught(call);
    expect(err).not.toBeInstanceOf(HuurayConnectionError);
    expect(err).not.toBeInstanceOf(HuurayIndeterminateOrderError);
    const text = dump(err);
    const hash = signRequest(SECRET, NONCE);
    for (const value of [TOKEN, SECRET, NONCE, hash, ...Object.values(recipient)]) {
      expect(text).not.toContain(value);
    }
  });
});
