import { format, inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  HuurayApiError,
  HuurayAuthError,
  HuurayClient,
  HuurayConnectionError,
  HuurayIndeterminateOrderError,
  HuurayNotFoundError,
  HuurayServerError,
  HuurayTimeoutError,
  HuurayValidationError,
  redact,
  safeStringify,
  type PdfResult,
} from '../src/index.js';
import { PdfsResource, type PollClock } from '../src/resources/pdfs.js';
import { recordingFetch, testClient, type MockResponse } from './helpers.js';

const ORDER = '0f8a3c52-1d6e-4b7a-9c2f-5e4d3b2a1c90';
const TEMPLATE = 'c7d1e2f3-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

// Invented documents. MARK is what every leak check looks for, in any encoding.
const MARK = 'MARK-5ecret-c0de';
const encode = (s: string) => new TextEncoder().encode(s);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const PDF_1 = encode(`%PDF-1.7 ${MARK} voucher 5123401`);
const PDF_2 = encode(`%PDF-1.7 ${MARK} voucher 5123402`);
/** Every byte value, so a decoder that mangles any of them fails. */
const EVERY_BYTE = new Uint8Array([...encode('%PDF-'), ...Array(256).keys()]);

const doc = (voucherId: number, bytes: Uint8Array) => ({
  VoucherIDs: [voucherId],
  PDFTemplateUid: TEMPLATE,
  FileName: `giftcard-${voucherId}.pdf`,
  ContentType: 'application/pdf',
  Content: b64(bytes),
});
const OK = (documents: unknown[]) => ({
  OrderUID: ORDER,
  Documents: documents,
  Status: 200,
  Message: 'OK',
  StatusMessage: 'OK',
});
const READY: MockResponse = { status: 200, json: OK([doc(5123401, PDF_1), doc(5123402, PDF_2)]) };
const NOT_READY_TEXT = 'The order is still being processed, retry in 30 seconds';
const notReady = (retryAfter?: string): MockResponse => ({
  status: 202,
  json: {
    OrderUID: ORDER,
    Documents: [],
    Status: 202,
    Message: 'OK, order still processing',
    StatusMessage: NOT_READY_TEXT,
  },
  ...(retryAfter === undefined ? {} : { headers: { 'Retry-After': retryAfter } }),
});
const RETRIES = { retry: { maxRetries: 3, baseDelayMs: 1 } };

/** The error a call rejects with. Fails if it resolves. */
async function caught(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    () => expect.unreachable('must reject'),
    (e: unknown) => e,
  );
}

/** Everything a logger or error reporter could print: properties, stacks, the cause chain. */
function dump(value: unknown): string {
  let out =
    `${String(value)}\n${inspect(value, { depth: Infinity, showHidden: true })}\n` +
    `${format('%o %O %j', value, value, value)}`;
  for (let e: unknown = value; e instanceof Error; e = e.cause) {
    out += `\n${e.name}: ${e.message}\n${e.stack ?? ''}`;
  }
  return out;
}

/**
 * Fails if `text` holds a document: as text, as base64, or its bytes the way
 * inspect prints a Buffer or Uint8Array or JSON writes one.
 */
function expectNoContent(text: string): void {
  expect(text).not.toContain(MARK);
  for (const bytes of [PDF_1, PDF_2]) {
    expect(text).not.toContain(b64(bytes).slice(12, 36));
    const head = [...bytes.slice(0, 8)];
    expect(text).not.toContain(head.join(','));
    expect(text).not.toContain(head.join(', '));
    expect(text).not.toContain(head.map((b) => b.toString(16).padStart(2, '0')).join(' '));
    expect(text).not.toContain(Buffer.from(bytes).toString('hex').slice(0, 16));
  }
}

/**
 * A PdfsResource on a recording fetch, with a clock that only moves when it is
 * told to: each sleep moves it by the time slept, and each request by `requestMs`.
 */
function pdfClient(
  responses: MockResponse | MockResponse[],
  { requestMs = 0, maxRetries = 0 }: { requestMs?: number; maxRetries?: number } = {},
) {
  const rec = recordingFetch(responses);
  let now = 0;
  const waits: number[] = [];
  const clock: PollClock = {
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  };
  const client = new HuurayClient({
    apiToken: 'test-token',
    apiSecret: 'test-secret',
    retry: { maxRetries, baseDelayMs: 1 },
    fetch: (input, init) => {
      now += requestMs;
      return rec.fetch(input, init);
    },
  });
  return { pdfs: new PdfsResource(client, clock), calls: rec.calls, waits };
}

describe('pdfs.get() request', () => {
  it('sends one signed POST /v4/Pdf with only OrderUID when nothing else is given', async () => {
    const { client, calls } = testClient(READY);
    await client.pdfs.get({ orderUid: ORDER });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call).toMatchObject({ method: 'POST', path: '/v4/Pdf', query: {}, bodyKind: 'json' });
    expect(call.body).toEqual({ OrderUID: ORDER });
    expect(call.headers['X-API-TOKEN']).toBe('test-token');
    expect(call.headers['X-API-NONCE']).toBeTruthy();
    expect(call.headers['X-API-HASH']).toMatch(/^[0-9a-f]{128}$/);
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers['Accept']).toBe('application/json');
  });

  it('sends each optional field under its spec name, as given', async () => {
    const { client, calls } = testClient(READY);
    await client.pdfs.get({
      orderUid: ORDER,
      voucherId: 5123402,
      pdfTemplateUid: TEMPLATE,
      combine: true,
    });
    await client.pdfs.get({ orderUid: ORDER, combine: false });
    expect(calls.map((c) => c.body)).toEqual([
      { OrderUID: ORDER, VoucherID: 5123402, PDFTemplateUid: TEMPLATE, Combine: true },
      { OrderUID: ORDER, Combine: false },
    ]);
  });

  it('omits an optional field passed as null, as if it were not given', async () => {
    const { client, calls } = testClient(READY);
    await client.pdfs.get({
      orderUid: ORDER,
      voucherId: null as unknown as number,
      pdfTemplateUid: null as unknown as string,
      combine: null as unknown as boolean,
    });
    expect(calls[0]?.body).toEqual({ OrderUID: ORDER });
  });

  it('checks nothing itself: the API decides on the UID, the template and the receivers', async () => {
    const { client, calls } = testClient(READY);
    await client.pdfs.get({ orderUid: ' not-a-guid ', pdfTemplateUid: 'not-a-guid-either' });
    expect(calls[0]?.body).toEqual({
      OrderUID: ' not-a-guid ',
      PDFTemplateUid: 'not-a-guid-either',
    });
  });
});

describe('pdfs.get() result', () => {
  it('maps a 200: ready, every document, and each Content decoded to its exact bytes', async () => {
    const { client } = testClient({
      status: 200,
      json: OK([doc(5123401, EVERY_BYTE), doc(5123402, PDF_2)]),
    });
    const result = await client.pdfs.get({ orderUid: ORDER });

    expect(result).toEqual({
      ready: true,
      orderUid: ORDER,
      documents: [
        {
          voucherIds: [5123401],
          pdfTemplateUid: TEMPLATE,
          fileName: 'giftcard-5123401.pdf',
          contentType: 'application/pdf',
          content: EVERY_BYTE,
        },
        {
          voucherIds: [5123402],
          pdfTemplateUid: TEMPLATE,
          fileName: 'giftcard-5123402.pdf',
          contentType: 'application/pdf',
          content: PDF_2,
        },
      ],
      retryAfter: null,
    });
    const content = result.documents[0]!.content;
    expect(content).toBeInstanceOf(Uint8Array);
    expect([...content]).toEqual([...EVERY_BYTE]);
  });

  it('maps a combined document: several VoucherIDs and a null PDFTemplateUid', async () => {
    const combined = encode(`%PDF-1.7 ${MARK} two vouchers`);
    const { client } = testClient({
      status: 200,
      json: OK([
        {
          VoucherIDs: [5123401, 5123402],
          PDFTemplateUid: null,
          FileName: `giftcard-order-${ORDER}.pdf`,
          ContentType: 'application/pdf',
          Content: b64(combined),
        },
      ]),
    });
    const { documents } = await client.pdfs.get({ orderUid: ORDER, combine: true });
    expect(documents).toEqual([
      {
        voucherIds: [5123401, 5123402],
        pdfTemplateUid: null,
        fileName: `giftcard-order-${ORDER}.pdf`,
        contentType: 'application/pdf',
        content: combined,
      },
    ]);
  });

  it('maps absent or null fields to null, an empty list, or no documents', async () => {
    const { client } = testClient([
      { status: 200, json: { Status: 200, Documents: [{ Content: '' }] } },
      { status: 200, json: { Status: 200, OrderUID: null, Documents: null } },
    ]);
    await expect(client.pdfs.get({ orderUid: ORDER })).resolves.toEqual({
      ready: true,
      orderUid: null,
      documents: [
        {
          voucherIds: [],
          pdfTemplateUid: null,
          fileName: null,
          contentType: null,
          content: new Uint8Array(0),
        },
      ],
      retryAfter: null,
    });
    await expect(client.pdfs.get({ orderUid: ORDER })).resolves.toEqual({
      ready: true,
      orderUid: null,
      documents: [],
      retryAfter: null,
    });
  });

  it('maps a 202 as not ready, with Retry-After in seconds — not thrown, and not success', async () => {
    const { client } = testClient(notReady('30'));
    await expect(client.pdfs.get({ orderUid: ORDER })).resolves.toEqual({
      ready: false,
      orderUid: ORDER,
      documents: [],
      retryAfter: 30,
    });
  });

  it('gives retryAfter null when a 202 has no Retry-After header', async () => {
    const { client } = testClient(notReady());
    await expect(client.pdfs.get({ orderUid: ORDER })).resolves.toMatchObject({
      ready: false,
      retryAfter: null,
    });
  });

  it.each([
    ['0', 0],
    ['45', 45],
    [' 7 ', 7],
    ['soon', null],
    ['-5', null],
    ['1.5', null],
    ['1e3', null],
    ['30, 60', null],
    ['Wed, 21 Oct 2026 07:28:00 GMT', null],
    ['99999999999999999999', null],
  ])('reads Retry-After %j as %j', async (header, expected) => {
    const { client } = testClient(notReady(header));
    const { retryAfter } = await client.pdfs.get({ orderUid: ORDER });
    expect(retryAfter).toBe(expected);
  });
});

describe('pdfs.get() garbled documents', () => {
  const garbled = (content: unknown): MockResponse => ({
    status: 200,
    json: OK([doc(5123401, PDF_1), { ...doc(5123402, PDF_2), Content: content }]),
  });

  it.each([
    ['a character outside the alphabet', `${b64(PDF_2)}!!!!`],
    ['a line break', 'QUJ\nQUJD'],
    ['a space', 'QUJ QUJD'],
    ['a length that is not a multiple of 4', b64(PDF_2).slice(0, -1)],
    ['padding before the end', `QQ==${b64(PDF_2)}`],
    ['the base64url alphabet', 'ab-_'],
    ['a non-ASCII character Node would read as "A"', 'ŁUFB'],
    ['three padding characters', 'Q==='],
  ])('throws a connection-class error, not an empty result, for %s', async (_, content) => {
    const { client } = testClient(garbled(content));
    const err = await caught(() => client.pdfs.get({ orderUid: ORDER }));
    expect(err).toBeInstanceOf(HuurayConnectionError);
    expect(err).not.toBeInstanceOf(HuurayTimeoutError);
    expect(err).not.toBeInstanceOf(HuurayIndeterminateOrderError);
    expect((err as Error).message).toBe(
      'POST /v4/Pdf returned HTTP 200 but Documents[1].Content was not valid base64 ' +
        `(${content.length} characters). Treat the outcome as unknown rather than empty.`,
    );
  });

  it.each([
    ['null', null],
    ['missing', undefined],
    ['a number', 42],
  ])('throws a connection-class error when a Content is %s', async (_, content) => {
    const { client } = testClient(garbled(content));
    const err = await caught(() => client.pdfs.get({ orderUid: ORDER }));
    expect(err).toBeInstanceOf(HuurayConnectionError);
    expect((err as Error).message).toMatch(/HTTP 200 but Documents\[1\]\.Content was missing\./);
  });

  it('throws a connection-class error when Documents is not a list', async () => {
    const { client } = testClient({ status: 200, json: { Status: 200, Documents: { a: 1 } } });
    const err = await caught(() => client.pdfs.get({ orderUid: ORDER }));
    expect(err).toBeInstanceOf(HuurayConnectionError);
    expect((err as Error).message).toMatch(/HTTP 200 but Documents was not a list\./);
  });

  it('retries a garbled document like any garbled read, with a new nonce', async () => {
    const { client, calls } = testClient([garbled('!!!!'), READY], RETRIES);
    const result = await client.pdfs.get({ orderUid: ORDER });
    expect(result.documents.map((d) => d.content)).toEqual([PDF_1, PDF_2]);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.headers['X-API-NONCE'])).size).toBe(2);
  });

  it('never quotes the content, in the error or anything it carries', async () => {
    const { client } = testClient(garbled(`${b64(PDF_2)}!!!!`));
    expectNoContent(dump(await caught(() => client.pdfs.get({ orderUid: ORDER }))));
  });
});

describe('pdfs.get() is a read, retried under the ordinary policy', () => {
  it('retries a 503 with a new nonce, and returns the documents', async () => {
    const { client, calls } = testClient([{ status: 503 }, READY], RETRIES);
    const result = await client.pdfs.get({ orderUid: ORDER });
    expect(result.ready).toBe(true);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.headers['X-API-NONCE'])).size).toBe(2);
  });

  it('retries a dropped connection', async () => {
    const { client, calls } = testClient(
      [{ throws: new TypeError('fetch failed') }, READY],
      RETRIES,
    );
    await expect(client.pdfs.get({ orderUid: ORDER })).resolves.toMatchObject({ ready: true });
    expect(calls).toHaveLength(2);
  });

  it('throws the ordinary server error after the last retry — never the indeterminate-order one', async () => {
    const { client, calls } = testClient({ status: 500 }, RETRIES);
    const err = await caught(() => client.pdfs.get({ orderUid: ORDER }));
    expect(err).toBeInstanceOf(HuurayServerError);
    expect(err).not.toBeInstanceOf(HuurayIndeterminateOrderError);
    expect(calls).toHaveLength(4);
  });

  it('does not retry a 202: it is returned as not ready', async () => {
    const { client, calls } = testClient([notReady('30')], RETRIES);
    await expect(client.pdfs.get({ orderUid: ORDER })).resolves.toMatchObject({ ready: false });
    expect(calls).toHaveLength(1);
  });
});

describe('pdfs.get() errors use the ordinary mapping', () => {
  const envelope = (status: number, message: string, statusMessage: string) => ({
    status,
    json: { OrderUID: ORDER, Documents: [], Status: status, Message: message, StatusMessage: statusMessage },
  });

  it.each([
    [404, HuurayNotFoundError, 'Order not found', 'No order was found with the given OrderUID'],
    [
      422,
      HuurayValidationError,
      'Order has too many receivers',
      'The PDF can only be fetched for orders with at most 3 receivers',
    ],
    [400, HuurayApiError, 'Invalid request', 'OrderUID is required'],
    [401, HuurayAuthError, 'Restricted Access', 'Restricted Access'],
  ])('throws %i as %o, with its StatusMessage, and does not retry it', async (status, type, message, text) => {
    const { client, calls } = testClient(envelope(status, message, text), RETRIES);
    const err = await caught(() => client.pdfs.get({ orderUid: ORDER }));
    expect(err).toBeInstanceOf(type);
    expect(err).not.toBeInstanceOf(HuurayIndeterminateOrderError);
    expect(err).toMatchObject({ httpStatus: status, status, statusMessage: text, path: '/v4/Pdf' });
    expect(calls).toHaveLength(1);
  });

  it('keeps a document that comes back on an error out of the error', async () => {
    // Error bodies are the same envelope with no documents; one that had any
    // must not carry them into a log.
    const { client } = testClient({
      status: 422,
      json: { ...OK([doc(5123401, PDF_1)]), Status: 422, StatusMessage: 'nope' },
    });
    const err = await caught(() => client.pdfs.get({ orderUid: ORDER }));
    expect((err as HuurayApiError).body).toMatchObject({
      Documents: [{ VoucherIDs: [5123401], Content: '[redacted: bearer value]' }],
    });
    expectNoContent(dump(err));
  });
});

describe('pdfs.getWhenReady()', () => {
  it('returns a ready answer at once, without waiting', async () => {
    const { pdfs, calls, waits } = pdfClient([READY]);
    await expect(pdfs.getWhenReady({ orderUid: ORDER })).resolves.toMatchObject({
      ready: true,
      documents: [{ content: PDF_1 }, { content: PDF_2 }],
    });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('waits Retry-After after a 202 and asks again with a new nonce and the same body', async () => {
    const { pdfs, calls, waits } = pdfClient([notReady('5'), READY]);
    const result = await pdfs.getWhenReady({ orderUid: ORDER, voucherId: 5123401, combine: true });

    expect(result.ready).toBe(true);
    expect(waits).toEqual([5000]);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.headers['X-API-NONCE'])).size).toBe(2);
    for (const call of calls) {
      expect(call).toMatchObject({ method: 'POST', path: '/v4/Pdf' });
      expect(call.body).toEqual({ OrderUID: ORDER, VoucherID: 5123401, Combine: true });
    }
  });

  it('honours each Retry-After in turn, but waits at least 1 second', async () => {
    const { pdfs, calls, waits } = pdfClient([notReady('3'), notReady('7'), notReady('0'), READY]);
    await expect(pdfs.getWhenReady({ orderUid: ORDER })).resolves.toMatchObject({ ready: true });
    expect(waits).toEqual([3000, 7000, 1000]);
    expect(calls).toHaveLength(4);
  });

  it('gives up when the 1-second wait after a Retry-After of 0 would pass maxWaitMs', async () => {
    const { pdfs, calls, waits } = pdfClient([notReady('0'), notReady('0')]);
    const err = await caught(() => pdfs.getWhenReady({ orderUid: ORDER, maxWaitMs: 1_500 }));
    expect(err).toBeInstanceOf(HuurayTimeoutError);
    expect(waits).toEqual([1000]);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['no Retry-After', undefined],
    ['an unparseable Retry-After', 'soon'],
    ['a negative Retry-After', '-5'],
  ])('waits 30 seconds after a 202 with %s', async (_, header) => {
    const { pdfs, waits } = pdfClient([notReady(header), READY]);
    await pdfs.getWhenReady({ orderUid: ORDER });
    expect(waits).toEqual([30_000]);
  });

  it('gives up before a wait would pass maxWaitMs, with the ordinary timeout error and the last StatusMessage', async () => {
    const { pdfs, calls, waits } = pdfClient([notReady('30'), notReady('30')]);
    const err = await caught(() => pdfs.getWhenReady({ orderUid: ORDER, maxWaitMs: 50_000 }));

    expect(calls).toHaveLength(2);
    expect(waits).toEqual([30_000]);
    expect(err).toBeInstanceOf(HuurayTimeoutError);
    expect(err).not.toBeInstanceOf(HuurayIndeterminateOrderError);
    expect(err).toMatchObject({ method: 'POST', path: '/v4/Pdf', timeoutMs: 50_000 });
    expect((err as Error).message).toBe(
      `POST /v4/Pdf timed out after 50000ms. The gift card PDF was not ready: ${NOT_READY_TEXT}. ` +
        'Waiting another 30 seconds would pass maxWaitMs.',
    );
  });

  it('waits right up to maxWaitMs, but not past it', async () => {
    const { pdfs, calls, waits } = pdfClient([notReady('30'), notReady('30'), notReady('30')]);
    const err = await caught(() => pdfs.getWhenReady({ orderUid: ORDER, maxWaitMs: 60_000 }));
    expect(err).toBeInstanceOf(HuurayTimeoutError);
    expect(waits).toEqual([30_000, 30_000]);
    expect(calls).toHaveLength(3);
  });

  it('keeps asking for 10 minutes by default', async () => {
    const { pdfs, calls, waits } = pdfClient(Array.from({ length: 21 }, () => notReady('30')));
    const err = await caught(() => pdfs.getWhenReady({ orderUid: ORDER }));
    expect(err).toBeInstanceOf(HuurayTimeoutError);
    expect(err).toMatchObject({ timeoutMs: 600_000 });
    expect(calls).toHaveLength(21);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(600_000);
  });

  it('counts the time the requests take against maxWaitMs, not only the waits', async () => {
    const { pdfs, calls, waits } = pdfClient([notReady('30'), notReady('30')], { requestMs: 20_000 });
    const err = await caught(() => pdfs.getWhenReady({ orderUid: ORDER, maxWaitMs: 60_000 }));
    // 20 s + 30 s wait + 20 s = 70 s, so the second 30 s wait is never started.
    expect(err).toBeInstanceOf(HuurayTimeoutError);
    expect(waits).toEqual([30_000]);
    expect(calls).toHaveLength(2);
  });

  it('gives up at once when the first Retry-After is longer than maxWaitMs', async () => {
    const { pdfs, calls, waits } = pdfClient([notReady('120')]);
    const err = await caught(() => pdfs.getWhenReady({ orderUid: ORDER, maxWaitMs: 60_000 }));
    expect(err).toBeInstanceOf(HuurayTimeoutError);
    expect((err as Error).message).toMatch(/Waiting another 120 seconds would pass maxWaitMs\.$/);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('asks exactly once with maxWaitMs 0', async () => {
    const { pdfs, calls } = pdfClient([notReady('30')]);
    await expect(pdfs.getWhenReady({ orderUid: ORDER, maxWaitMs: 0 })).rejects.toBeInstanceOf(
      HuurayTimeoutError,
    );
    expect(calls).toHaveLength(1);
  });

  it('says only that it was not ready when the 202 has no StatusMessage', async () => {
    const { pdfs } = pdfClient([{ status: 202, json: { Status: 202, Documents: [] } }]);
    const err = await caught(() => pdfs.getWhenReady({ orderUid: ORDER, maxWaitMs: 0 }));
    expect((err as Error).message).toBe(
      'POST /v4/Pdf timed out after 0ms. The gift card PDF was not ready. ' +
        'Waiting another 30 seconds would pass maxWaitMs.',
    );
  });

  it('throws any other error as get() does, without waiting further', async () => {
    const { pdfs, calls, waits } = pdfClient([
      notReady('30'),
      { status: 404, json: { Status: 404, StatusMessage: 'The order is cancelled' } },
    ]);
    const err = await caught(() => pdfs.getWhenReady({ orderUid: ORDER }));
    expect(err).toBeInstanceOf(HuurayNotFoundError);
    expect(err).toMatchObject({ statusMessage: 'The order is cancelled' });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([30_000]);
  });

  it('retries a 503 within an attempt under the ordinary policy, then keeps polling', async () => {
    const { pdfs, calls, waits } = pdfClient([notReady('1'), { status: 503 }, READY], {
      maxRetries: 2,
    });
    await expect(pdfs.getWhenReady({ orderUid: ORDER })).resolves.toMatchObject({ ready: true });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000]);
    expect(new Set(calls.map((c) => c.headers['X-API-NONCE'])).size).toBe(3);
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['above what a timer can hold', 2_147_483_648],
    ['a string', '600000' as unknown as number],
  ])('rejects a maxWaitMs that is %s before sending', async (_, maxWaitMs) => {
    const { pdfs, calls } = pdfClient([]);
    const err = await caught(() => pdfs.getWhenReady({ orderUid: ORDER, maxWaitMs }));
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).toMatch(/^maxWaitMs must be a number of milliseconds from 0 to 2147483647/);
    expect(calls).toHaveLength(0);
  });

  it('is on the client, waiting at least 1 second with a real timer', async () => {
    const { client, calls } = testClient([notReady('0'), READY]);
    const start = performance.now();
    await expect(client.pdfs.getWhenReady({ orderUid: ORDER })).resolves.toMatchObject({
      ready: true,
    });
    // A timer may fire a little before the clock reads the full second.
    expect(performance.now() - start).toBeGreaterThanOrEqual(950);
    expect(calls).toHaveLength(2);
  });
});

describe('a gift card PDF never prints', () => {
  async function ready(): Promise<PdfResult> {
    const { client } = testClient(READY);
    return client.pdfs.get({ orderUid: ORDER });
  }

  it('in util.inspect(), console.log() formatting or JSON.stringify(), which show its size', async () => {
    const result = await ready();
    const text = dump(result);
    expectNoContent(text);
    expect(inspect(result, { depth: Infinity })).toContain(`content: '[${PDF_1.length} bytes]'`);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      ready: true,
      orderUid: ORDER,
      documents: [
        {
          voucherIds: [5123401],
          pdfTemplateUid: TEMPLATE,
          fileName: 'giftcard-5123401.pdf',
          contentType: 'application/pdf',
          content: `[${PDF_1.length} bytes]`,
        },
        {
          voucherIds: [5123402],
          pdfTemplateUid: TEMPLATE,
          fileName: 'giftcard-5123402.pdf',
          contentType: 'application/pdf',
          content: `[${PDF_2.length} bytes]`,
        },
      ],
      retryAfter: null,
    });
    expectNoContent(dump(result.documents[0]));
  });

  it('in redact() or safeStringify(), which remove it like a voucher code', async () => {
    const result = await ready();
    expect(redact(result)).toMatchObject({
      documents: [
        { voucherIds: [5123401], content: '[redacted: bearer value]' },
        { voucherIds: [5123402], content: '[redacted: bearer value]' },
      ],
    });
    expectNoContent(safeStringify(result));
    expectNoContent(safeStringify(READY.json));
    expect(redact(READY.json)).toMatchObject({
      Documents: [{ Content: '[redacted: bearer value]' }, { Content: '[redacted: bearer value]' }],
    });
  });

  it('in the timeout getWhenReady() throws', async () => {
    const { pdfs } = pdfClient([notReady('30')]);
    expectNoContent(dump(await caught(() => pdfs.getWhenReady({ orderUid: ORDER, maxWaitMs: 0 }))));
  });
});
