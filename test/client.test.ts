import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  HuurayApiError,
  HuurayAuthError,
  HuurayClient,
  HuurayConfigError,
  HuurayConnectionError,
  HuurayIndeterminateOrderError,
  HuurayNotFoundError,
  HuurayServerError,
  HuurayTimeoutError,
  HuurayValidationError,
  signRequest,
  type HuurayClientOptions,
} from '../src/index.js';
import { testClient } from './helpers.js';

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

  it.each(['https://api.huuray.com', 'http://localhost:8080'])(
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

  it('still sends a userAgent suffix of visible text', async () => {
    const { client, calls } = testClient(undefined, { userAgent: 'my-app/1.2 (payroll)' });
    await client.balances.list();
    expect(calls[0]?.headers['User-Agent']).toMatch(/^huuray-node\/\S+ my-app\/1\.2 \(payroll\)$/);
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
    const { client } = testClient({ bodyThrows: abort });
    await expect(client.balances.list()).rejects.toBeInstanceOf(HuurayTimeoutError);
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

  /** Everything a logger or error reporter could print: properties, stacks, the cause chain. */
  function dump(err: unknown): string {
    let out = inspect(err, { depth: Infinity, showHidden: true });
    for (let e: unknown = err; e instanceof Error; e = e.cause) {
      out += `\n${e.name}: ${e.message}\n${e.stack ?? ''}`;
    }
    return out;
  }

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
