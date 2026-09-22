import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  HuurayApiError,
  HuurayConnectionError,
  HuurayIndeterminateOrderError,
  HuurayServerError,
  HuurayTimeoutError,
  HuurayValidationError,
  type CreateUploadParams,
} from '../src/index.js';
import { testClient } from './helpers.js';

const CONTENTS = '%PDF-1.7 MARK-c0ffee purchase order';
const PDF = new TextEncoder().encode(CONTENTS);
const upload: CreateUploadParams = {
  file: PDF,
  fileName: 'purchase-order-4711.pdf',
  contentType: 'application/pdf',
};
const CREATED = {
  Token: '60050460-7a2d-42a8-a4dd-5cef88ad8374',
  FileName: 'purchase-order-4711.pdf',
  ContentType: 'application/pdf',
  Size: 48213,
  Status: 201,
  Message: 'OK',
  StatusMessage: 'OK',
};
const NOTE =
  "The upload may still have been stored, and may hold one of the account's pending upload " +
  'slots until it is used or cleaned up. It was not retried.';
const RETRIES = { retry: { maxRetries: 3, baseDelayMs: 1 } };

/** The error a call rejects with. Fails if it resolves. */
async function caught(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    () => expect.unreachable('must reject'),
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

describe('uploads.create() request', () => {
  it('sends one signed POST /v4/Upload as multipart/form-data with a single File part', async () => {
    const { client, calls } = testClient({ status: 201, json: CREATED });
    await client.uploads.create(upload);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call).toMatchObject({ method: 'POST', path: '/v4/Upload', query: {} });
    expect(call.headers['X-API-TOKEN']).toBe('test-token');
    expect(call.headers['X-API-NONCE']).toBeTruthy();
    expect(call.headers['X-API-HASH']).toMatch(/^[0-9a-f]{128}$/);
    expect(call.headers['Accept']).toBe('application/json');
    // fetch writes the Content-Type with its boundary; the SDK must not set one.
    expect(Object.keys(call.headers).map((k) => k.toLowerCase())).not.toContain('content-type');

    expect(call.bodyKind).toBe('multipart');
    expect(call.body).toBeUndefined();
    expect(call.multipart?.contentType).toMatch(/^multipart\/form-data; boundary=\S+$/);
    expect(call.multipart?.error).toBeUndefined();
    expect(call.multipart?.parts).toHaveLength(1);
    const part = call.multipart!.parts![0]!;
    expect(part).toMatchObject({
      name: 'File',
      filename: 'purchase-order-4711.pdf',
      contentType: 'application/pdf',
    });
    expect(Object.keys(part.headers).sort()).toEqual(['content-disposition', 'content-type']);
    expect(part.data).toEqual(PDF);
  });

  // Every byte value, CRLFs and a boundary look-alike: none may be altered.
  const bytes = new Uint8Array([
    ...Array(256).keys(),
    ...new TextEncoder().encode('\r\n--x--\r\n'),
  ]);
  it.each([
    ['a Uint8Array', bytes],
    [
      'a Buffer that is a view into a larger one',
      Buffer.concat([Buffer.from('junk'), bytes]).subarray(4),
    ],
    ['an ArrayBuffer', bytes.slice().buffer],
    ['a Blob', new Blob([bytes])],
  ])('sends %s byte for byte', async (_, file) => {
    const { client, calls } = testClient({ status: 201, json: CREATED });
    await client.uploads.create({ file, fileName: 'po.bin' });
    expect(calls[0]?.multipart?.parts?.[0]?.data).toEqual(bytes);
  });

  it('sends the file name as given, non-ASCII included', async () => {
    const { client, calls } = testClient({ status: 201, json: CREATED });
    await client.uploads.create({ ...upload, fileName: 'indkøbsordre 4711.pdf' });
    expect(calls[0]?.multipart?.parts?.[0]?.filename).toBe('indkøbsordre 4711.pdf');
  });

  it('sends the content type as given', async () => {
    const { client, calls } = testClient({ status: 201, json: CREATED });
    await client.uploads.create({ ...upload, contentType: 'image/png' });
    expect(calls[0]?.multipart?.parts?.[0]?.contentType).toBe('image/png');
  });

  it.each([
    ['omitted', {}],
    ['null', { contentType: null as unknown as string }],
    [
      'omitted, even for a Blob with a type of its own',
      { file: new Blob([PDF], { type: 'application/pdf' }) },
    ],
  ])('sends application/octet-stream when contentType is %s', async (_, extra) => {
    const { client, calls } = testClient({ status: 201, json: CREATED });
    await client.uploads.create({ file: PDF, fileName: 'po.pdf', ...extra });
    expect(calls[0]?.multipart?.parts?.[0]?.contentType).toBe('application/octet-stream');
  });

  it.each([
    ['a string, such as a path', './purchase-order.pdf'],
    ['missing', undefined],
    ['a number', 42],
  ])('rejects a file that is %s, before sending', async (_, file) => {
    const { client, calls } = testClient();
    const err = await caught(() =>
      client.uploads.create({ ...upload, file: file as unknown as Uint8Array }),
    );
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/file must be the file contents/);
    expect(calls).toHaveLength(0);
  });

  it('rejects a missing fileName before sending, rather than send "blob"', async () => {
    const { client, calls } = testClient();
    const err = await caught(() =>
      client.uploads.create({ file: PDF, fileName: undefined as unknown as string }),
    );
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/fileName is required/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a line break', 'application/pdf\r\nX-Injected: yes'],
    ['a tab', 'application/\tpdf'],
    ['a non-ASCII character', 'application/pdfé'],
  ])('rejects a contentType with %s before sending — a Blob would drop it', async (_, type) => {
    const { client, calls } = testClient();
    const err = await caught(() => client.uploads.create({ ...upload, contentType: type }));
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/contentType must be visible ASCII/);
    expect(calls).toHaveLength(0);
  });
});

describe('uploads.create() result', () => {
  it('maps a 201 UploadResponse, a success like any 2xx', async () => {
    const { client } = testClient({ status: 201, json: CREATED });
    await expect(client.uploads.create(upload)).resolves.toEqual({
      token: '60050460-7a2d-42a8-a4dd-5cef88ad8374',
      fileName: 'purchase-order-4711.pdf',
      contentType: 'application/pdf',
      size: 48213,
    });
  });

  it('returns null for each field the API sends as null or leaves out', async () => {
    const { client } = testClient({ status: 201, json: { Status: 201, ContentType: null } });
    await expect(client.uploads.create(upload)).resolves.toEqual({
      token: null,
      fileName: null,
      contentType: null,
      size: null,
    });
  });
});

describe('uploads.create() is never retried', () => {
  it('makes one attempt on a 503, and throws the ordinary server error', async () => {
    const { client, calls } = testClient({ status: 503 }, RETRIES);
    const err = await caught(() => client.uploads.create(upload));
    expect(err).toBeInstanceOf(HuurayServerError);
    expect(err).not.toBeInstanceOf(HuurayIndeterminateOrderError);
    expect(calls).toHaveLength(1);
  });

  it('makes one attempt when the connection fails, and says the upload may be stored', async () => {
    const cause = new TypeError('fetch failed');
    const { client, calls } = testClient({ throws: cause }, RETRIES);
    const err = await caught(() => client.uploads.create(upload));
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(HuurayConnectionError);
    expect(err).not.toBeInstanceOf(HuurayTimeoutError);
    expect(err).not.toBeInstanceOf(HuurayIndeterminateOrderError);
    expect((err as Error).message).toBe(
      `POST /v4/Upload failed to reach the Huuray API: fetch failed. ${NOTE}`,
    );
    expect((err as Error).cause).toBe(cause);
  });

  it('makes one attempt on a timeout, and says the upload may be stored', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    const { client, calls } = testClient({ throws: timeout }, { ...RETRIES, timeoutMs: 1234 });
    const err = await caught(() => client.uploads.create(upload));
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(HuurayTimeoutError);
    expect(err).not.toBeInstanceOf(HuurayIndeterminateOrderError);
    expect(err).toMatchObject({ method: 'POST', path: '/v4/Upload', timeoutMs: 1234 });
    expect((err as Error).message).toBe(`POST /v4/Upload timed out after 1234ms. ${NOTE}`);
  });

  it('makes one attempt on a timeout while the response streams', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    const { client, calls } = testClient({ bodyThrows: timeout }, RETRIES);
    const err = await caught(() => client.uploads.create(upload));
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(HuurayTimeoutError);
    expect((err as Error).message).toContain(NOTE);
  });

  it('makes one attempt on a garbled 201 — the file was stored', async () => {
    const { client, calls } = testClient({ status: 201, text: '<html>proxy</html>' }, RETRIES);
    const err = await caught(() => client.uploads.create(upload));
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(HuurayConnectionError);
    expect((err as Error).message).toMatch(/HTTP 201 but the body was not valid JSON/);
    expect((err as Error).message).toContain(NOTE);
  });
});

describe('uploads.create() errors use the ordinary mapping', () => {
  it('throws a plain HuurayApiError for a 413 with no JSON body', async () => {
    const { client } = testClient({ status: 413, text: '' });
    const err = await caught(() => client.uploads.create(upload));
    expect((err as object).constructor).toBe(HuurayApiError);
    expect(err).toMatchObject({ httpStatus: 413, body: undefined, path: '/v4/Upload' });
  });

  it('throws HuurayValidationError for a 422', async () => {
    const { client } = testClient({
      status: 422,
      json: { Status: 422, StatusMessage: 'The file type is not supported' },
    });
    const err = await caught(() => client.uploads.create(upload));
    expect(err).toBeInstanceOf(HuurayValidationError);
    expect(err).toMatchObject({ statusMessage: 'The file type is not supported' });
  });
});

describe('uploads never print the file or its name', () => {
  const personal = { ...upload, fileName: 'purchase-order-jane-doe.pdf' };

  it.each([
    ['a dropped connection', { throws: new TypeError('fetch failed') }],
    ['a timeout', { throws: new DOMException('The operation timed out.', 'TimeoutError') }],
    ['a garbled 201', { status: 201, text: 'garbled' }],
  ])('after %s', async (_, mock) => {
    const { client } = testClient(mock);
    const text = dump(await caught(() => client.uploads.create(personal)));
    expect(text).not.toContain('jane-doe');
    expect(text).not.toContain('MARK-c0ffee');
  });

  it('after an error response that echoes the file name', async () => {
    // Upload error bodies carry the UploadResponse fields, FileName included.
    const { client } = testClient({
      status: 422,
      json: {
        Status: 422,
        StatusMessage: 'The file type is not supported',
        Token: null,
        FileName: 'purchase-order-jane-doe.pdf',
        ContentType: null,
        Size: 12,
      },
    });
    const err = await caught(() => client.uploads.create(personal));
    expect((err as HuurayApiError).body).toMatchObject({ FileName: 'pu***df', Size: 12 });
    expect(dump(err)).not.toContain('jane-doe');
  });
});
