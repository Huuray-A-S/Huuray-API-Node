import { describe, expect, it } from 'vitest';
import {
  HuurayApiError,
  HuurayAuthError,
  HuurayClient,
  HuurayConfigError,
  HuurayConnectionError,
  HuurayNotFoundError,
  HuurayServerError,
  HuurayTimeoutError,
  HuurayValidationError,
} from '../src/index.js';
import { testClient } from './helpers.js';

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
});
