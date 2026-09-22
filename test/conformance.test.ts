/**
 * Spec-fidelity gates.
 *
 * The SDK's central promise is that it invents nothing: it calls only documented
 * operations and sends only documented fields. That promise has to be mechanical,
 * not a matter of discipline, or it quietly decays.
 *
 *   no-invention   every request the SDK makes exists in the spec
 *   coverage       every operation in the spec has an SDK method
 *   conformance    every request body validates against the spec schema,
 *                  including no unknown properties
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Resource } from '../src/resources/base.js';
import {
  recordingFetch,
  testClient,
  type CapturedMultipart,
  type CapturedPart,
  type CapturedRequest,
} from './helpers.js';

const SPEC = JSON.parse(
  readFileSync(fileURLToPath(new URL('../openapi/huuray-v4.json', import.meta.url)), 'utf8'),
) as SpecDoc;

interface SpecDoc {
  paths: Record<string, Record<string, SpecOperation>>;
  components: { schemas: Record<string, SpecSchema> };
}
interface SpecOperation {
  requestBody?: { content?: Record<string, SpecMediaType> };
  parameters?: { name: string; in: string; required?: boolean }[];
}
interface SpecMediaType {
  schema?: SpecSchema;
  encoding?: Record<string, Record<string, unknown>>;
}
interface SpecSchema {
  $ref?: string;
  type?: string;
  format?: string;
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, SpecSchema>;
  items?: SpecSchema;
  allOf?: SpecSchema[];
  oneOf?: SpecSchema[];
  anyOf?: SpecSchema[];
}

/** `POST /v4/Order` style keys for every operation the API documents. */
function specOperations(): Set<string> {
  const ops = new Set<string>();
  for (const [path, item] of Object.entries(SPEC.paths)) {
    for (const verb of Object.keys(item)) {
      if (verb === 'parameters') continue;
      ops.add(`${verb.toUpperCase()} ${path}`);
    }
  }
  return ops;
}

function deref(schema: SpecSchema): SpecSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.replace('#/components/schemas/', '');
  const target = SPEC.components.schemas[name];
  if (!target) throw new Error(`Unresolvable $ref in spec: ${schema.$ref}`);
  return target;
}

/**
 * Returns human-readable violations; an empty array means the value conforms.
 *
 * FAILS CLOSED: a schema shape this validator does not understand is an error,
 * never a silent pass. The spec-drift job re-downloads the live spec weekly —
 * if a refresh starts using `allOf` wrappers (standard Swashbuckle output for
 * nullable $refs) or drops `type`, the gates must break loudly rather than
 * validate nothing while staying green.
 */
function validate(schema: SpecSchema, value: unknown, at = '$'): string[] {
  const s = deref(schema);
  const errors: string[] = [];

  if (s.allOf || s.oneOf || s.anyOf) {
    errors.push(
      `${at}: schema uses allOf/oneOf/anyOf, which this validator does not handle — ` +
        'extend validate() before trusting this run',
    );
    return errors;
  }

  if (value === null || value === undefined) {
    if (!s.nullable) errors.push(`${at}: null/undefined but the spec does not mark it nullable`);
    return errors;
  }

  switch (s.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${at}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
        break;
      }
      const obj = value as Record<string, unknown>;
      const known = new Set(Object.keys(s.properties ?? {}));

      // The invention detector: a property the spec does not define.
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) {
          errors.push(
            `${at}.${key}: not defined in the spec — the SDK must not send undocumented fields`,
          );
        }
      }
      for (const req of s.required ?? []) {
        if (!(req in obj)) errors.push(`${at}.${req}: required by the spec but not sent`);
      }
      for (const [key, sub] of Object.entries(s.properties ?? {})) {
        if (key in obj) errors.push(...validate(sub, obj[key], `${at}.${key}`));
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${at}: expected array, got ${typeof value}`);
        break;
      }
      if (s.items) {
        value.forEach((v, i) => errors.push(...validate(s.items!, v, `${at}[${i}]`)));
      }
      break;
    }
    case 'integer':
      if (!Number.isInteger(value)) errors.push(`${at}: expected integer, got ${String(value)}`);
      break;
    case 'number':
      if (typeof value !== 'number') errors.push(`${at}: expected number, got ${typeof value}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${at}: expected boolean, got ${typeof value}`);
      break;
    case 'string':
      if (typeof value !== 'string') errors.push(`${at}: expected string, got ${typeof value}`);
      break;
    default:
      errors.push(
        `${at}: schema has ${s.type === undefined ? 'no "type"' : `unknown type "${s.type}"`} — ` +
          'this validator cannot check it; extend validate() before trusting this run',
      );
      break;
  }
  return errors;
}

/**
 * Checks one captured request against its operation's requestBody. FAILS
 * CLOSED like validate(): a media type it does not handle, or a body of the
 * wrong kind, is a violation, never a pass.
 */
function checkRequestBody(op: SpecOperation | undefined, call: CapturedRequest): string[] {
  const at = `${call.method} ${call.path}`;
  const content = op?.requestBody?.content;
  if (!content) {
    // The spec declares no body for this operation, so the SDK must send none.
    return call.bodyOmitted ? [] : [`${at}: spec declares no requestBody, but the SDK sent one`];
  }

  const mediaTypes = Object.keys(content);
  const mediaType = mediaTypes[0];
  if (mediaType === undefined || mediaTypes.length > 1) {
    return [
      `${at}: requestBody declares ${mediaTypes.length} media types, and this gate handles ` +
        'exactly one — extend checkRequestBody() before trusting this run',
    ];
  }
  const media = content[mediaType]!;
  const sent = {
    none: 'no body',
    json: 'a JSON body',
    multipart: 'a multipart body',
    other: 'a body that is neither JSON nor multipart',
  }[call.bodyKind];

  switch (mediaType) {
    case 'application/json':
      if (!media.schema) return [`${at}: the application/json requestBody has no schema`];
      if (call.bodyKind !== 'json' && call.bodyKind !== 'none') {
        return [`${at}: spec declares an application/json body, but the SDK sent ${sent}`];
      }
      return validate(media.schema, call.body, at);
    case 'multipart/form-data':
      if (call.bodyKind !== 'multipart' || !call.multipart) {
        return [`${at}: spec declares a multipart/form-data body, but the SDK sent ${sent}`];
      }
      return validateMultipart(media, call.multipart, at);
    default:
      return [
        `${at}: requestBody media type "${mediaType}" is not one this gate handles — ` +
          'extend checkRequestBody() before trusting this run',
      ];
  }
}

/**
 * Validates a multipart/form-data body by its parts, never by JSON-typing its
 * bytes: every part must be a declared property (the invention detector),
 * sent once; every required property must be sent; and a `format: binary`
 * property must be a file part, with a filename and its own Content-Type.
 *
 * FAILS CLOSED on anything else: a composed or non-object schema, a property
 * that is not binary, or an encoding other than the default `style: form`.
 */
function validateMultipart(media: SpecMediaType, sent: CapturedMultipart, at: string): string[] {
  if (!sent.parts) return [`${at}: the multipart body could not be parsed — ${sent.error}`];
  if (!media.schema) return [`${at}: the multipart/form-data requestBody has no schema`];
  const s = deref(media.schema);
  if (s.allOf || s.oneOf || s.anyOf || s.type !== 'object' || !s.properties) {
    return [
      `${at}: the multipart schema is not a plain object with properties, which this ` +
        'validator does not handle — extend validateMultipart() before trusting this run',
    ];
  }
  const properties = s.properties;
  const errors: string[] = [];

  for (const [name, encoding] of Object.entries(media.encoding ?? {})) {
    if (!(name in properties)) {
      errors.push(`${at}: encoding names "${name}", which is not a declared property`);
      continue;
    }
    for (const [key, value] of Object.entries(encoding)) {
      if (key === 'style' && value === 'form') continue;
      errors.push(
        `${at}: encoding.${name}.${key} = ${JSON.stringify(value)} is not understood — ` +
          'extend validateMultipart() before trusting this run',
      );
    }
  }

  const seen = new Set<string>();
  for (const part of sent.parts) {
    const name = part.name ?? '(no name)';
    if (seen.has(name)) errors.push(`${at}.${name}: sent more than once`);
    seen.add(name);

    const declared = part.name === undefined ? undefined : properties[part.name];
    if (!declared) {
      errors.push(
        `${at}.${name}: not defined in the spec — the SDK must not send undocumented fields`,
      );
      continue;
    }
    const p = deref(declared);
    if (p.allOf || p.oneOf || p.anyOf || p.type !== 'string' || p.format !== 'binary') {
      errors.push(
        `${at}.${name}: only a type "string", format "binary" part can be checked — ` +
          'extend validateMultipart() before trusting this run',
      );
      continue;
    }
    if (part.filename === undefined) {
      errors.push(`${at}.${name}: the spec declares a binary file, but the part has no filename`);
    }
    if (part.contentType === undefined) {
      errors.push(
        `${at}.${name}: the spec declares a binary file, but the part has no Content-Type`,
      );
    }
  }
  for (const req of s.required ?? []) {
    if (!seen.has(req)) errors.push(`${at}.${req}: required by the spec but not sent`);
  }
  return errors;
}

/**
 * Calls every public SDK method once, with every optional parameter populated,
 * so the gates below see the widest request each method can produce.
 */
async function exerciseEverything(): Promise<CapturedRequest[]> {
  const { client, calls } = testClient({ status: 200, json: {} });
  const purchaseOrder = (n: number) => ({
    additionalReference: `PO-471${n}`,
    customerReference: 'Jane Doe',
    articleNumber: `ART-${n}`,
    description: 'Gift cards for the sales team',
    purchaseOrderFileToken: `60050460-7a2d-42a8-a4dd-5cef88ad837${n}`,
  });

  await client.balances.list();
  await client.catalogue.list({ all: true });
  await client.templates.list();
  await client.stock.check({ productToken: 'tok', value: 5000 });
  await client.exchangeRates.get({ from: 'DKK', to: 'EUR' });

  await client.uploads.create({
    file: new TextEncoder().encode('%PDF-1.7 purchase order'),
    fileName: 'purchase-order-4711.pdf',
    contentType: 'application/pdf',
  });

  await client.orders.create({
    productToken: 'tok',
    value: 5000,
    currency: 'DKK',
    quantity: 2,
    expires: new Date('2027-01-01T00:00:00Z'),
    refId: 'ref-1',
    templateId: 42,
    pdfTemplateUid: '00000000-0000-4000-8000-00000000c001',
    deliveryDatetime: new Date('2026-09-01T09:00:00Z'),
    personalMessage: 'Thank you',
    recipients: [
      { name: 'A', email: 'a@example.com', refId: 'r-a' },
      { name: 'B', phone: '+4512345678', refId: 'r-b' },
    ],
    ...purchaseOrder(1),
  });

  await client.orders.createSync({
    productToken: 'tok',
    value: 5000,
    currency: 'DKK',
    quantity: 1,
    expires: new Date('2027-01-01T00:00:00Z'),
    refId: 'ref-sync',
    templateId: 42,
    pdfTemplateUid: '00000000-0000-4000-8000-00000000c002',
    deliveryDatetime: new Date('2026-09-01T09:00:00Z'),
    personalMessage: 'Thanks',
    recipients: [{ name: 'C', email: 'c@example.com', refId: 'r-c' }],
    ...purchaseOrder(2),
  });

  await client.orders.sendReward({
    productToken: 'tok',
    value: 5000,
    currency: 'DKK',
    recipient: { name: 'Jane', email: 'jane@example.com' },
    templateId: 42,
    pdfTemplateUid: '00000000-0000-4000-8000-00000000c003',
    refId: 'ref-2',
    personalMessage: 'Nice work',
    expires: '2027-01-01T00:00:00Z',
    deliveryDatetime: '2026-09-01T09:00:00Z',
    ...purchaseOrder(3),
  });

  await client.orders.search({
    orderUid: 'uid',
    voucherId: 7,
    productToken: 'tok',
    refId: 'ref-1',
    smsTemplateId: 1,
    emailTemplateId: 2,
    deliveryDatetime: new Date('2026-09-01T09:00:00Z'),
    recipientName: 'Jane',
    recipientEmail: 'jane@example.com',
    recipientPhone: '+4512345678',
    recipientRefId: 'r-a',
  });

  await client.orders.resend({ orderUid: 'uid', voucherId: 7 });
  await client.orders.cancel({ orderUid: 'uid', voucherId: 7 });

  return calls;
}

let calls: CapturedRequest[];
beforeAll(async () => {
  calls = await exerciseEverything();
});

describe('no-invention gate', () => {
  it('every request the SDK makes is a documented v4 operation', () => {
    const documented = specOperations();
    const undocumented = calls
      .map((c) => `${c.method.toUpperCase()} ${c.path}`)
      .filter((key) => !documented.has(key));
    expect([...new Set(undocumented)]).toEqual([]);
  });

  it('every query parameter the SDK sends is declared in the spec', () => {
    for (const call of calls) {
      const keys = Object.keys(call.query);
      if (keys.length === 0) continue;

      const op = SPEC.paths[call.path]?.[call.method.toLowerCase()];
      const declared = new Set(
        (op?.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name),
      );
      for (const key of keys) {
        expect(declared, `${call.method} ${call.path} sent undeclared query param "${key}"`)
          .toContain(key);
      }
    }
  });
});

describe('coverage gate', () => {
  it('every documented v4 operation has an SDK method', () => {
    const exercised = new Set(calls.map((c) => `${c.method.toUpperCase()} ${c.path}`));
    const missing = [...specOperations()].filter((op) => !exercised.has(op));
    expect(missing).toEqual([]);
  });

  it('covers exactly the ten v4 operations — no more, no fewer', () => {
    expect(specOperations().size).toBe(10);
  });
});

describe('request-conformance gate', () => {
  it('every request body validates against its spec schema', () => {
    const failures: string[] = [];

    for (const call of calls) {
      const op = SPEC.paths[call.path]?.[call.method.toLowerCase()];
      failures.push(...checkRequestBody(op, call));
    }

    expect(failures).toEqual([]);
  });

  it('sees the five purchase order fields on every order create, createSync and sendReward make', () => {
    // exerciseEverything() must populate each of them, or the gate above never
    // validates them against the spec.
    const fields = [
      'AdditionalReference',
      'CustomerReference',
      'ArticleNumber',
      'Description',
      'PurchaseOrderFileToken',
    ];
    const orders = calls.filter((c) => c.method === 'POST' && c.path === '/v4/Order');
    expect(orders).toHaveLength(3);
    for (const call of orders) {
      for (const field of fields) expect(call.body).toHaveProperty(field, expect.any(String));
    }
    for (const field of fields) {
      expect(SPEC.components.schemas['OrderRequest']?.properties).toHaveProperty(field);
    }
  });

  it('sees POST /v4/Upload sent as multipart, with one File part carrying a content type', () => {
    const uploads = calls.filter((c) => c.method === 'POST' && c.path === '/v4/Upload');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.bodyKind).toBe('multipart');
    expect(uploads[0]?.multipart?.parts).toEqual([
      expect.objectContaining({
        name: 'File',
        filename: 'purchase-order-4711.pdf',
        contentType: 'application/pdf',
      }),
    ]);
  });

  it('sees DeliveryPDFTemplateUid on every order create, createSync and sendReward make', () => {
    // exerciseEverything() must populate pdfTemplateUid, or the gate above never
    // validates the field against the spec.
    const orders = calls.filter((c) => c.method === 'POST' && c.path === '/v4/Order');
    expect(orders).toHaveLength(3);
    for (const call of orders) {
      expect(call.body).toHaveProperty('DeliveryPDFTemplateUid', expect.any(String));
    }
    expect(SPEC.components.schemas['OrderRequest']?.properties).toHaveProperty(
      'DeliveryPDFTemplateUid',
    );
  });

  it('sends no body to POST /v4/Template, which declares none', () => {
    const call = calls.find((c) => c.path === '/v4/Template');
    expect(call?.bodyOmitted).toBe(true);
  });
});

describe('exerciseEverything stays mechanically linked to the public surface', () => {
  /**
   * The three gates above only inspect requests exerciseEverything() happens to
   * make. This inventory pins the full public method list: adding a resource
   * method without updating BOTH this list and exerciseEverything() fails here,
   * so a new method can never silently bypass the gates.
   */
  const EXERCISED: Record<string, string[]> = {
    BalancesResource: ['list'],
    CatalogueResource: ['list'],
    TemplatesResource: ['list'],
    StockResource: ['check'],
    ExchangeRatesResource: ['get'],
    OrdersResource: ['cancel', 'create', 'createSync', 'resend', 'search', 'sendReward'],
    UploadsResource: ['create'],
  };

  it('every public resource method is on the exercised inventory', () => {
    const { client } = testClient({ status: 200, json: {} });
    const resources = [
      client.balances,
      client.catalogue,
      client.templates,
      client.stock,
      client.exchangeRates,
      client.orders,
      client.uploads,
    ];

    const actual: Record<string, string[]> = {};
    for (const resource of resources) {
      const proto = Object.getPrototypeOf(resource) as object;
      const name = proto.constructor.name;
      actual[name] = Object.getOwnPropertyNames(proto)
        .filter(
          (n) =>
            n !== 'constructor' &&
            typeof (proto as Record<string, unknown>)[n] === 'function',
        )
        .sort();
    }

    expect(actual).toEqual(EXERCISED);
  });

  it('the list above holds every resource on the client', () => {
    const { client } = testClient({ status: 200, json: {} });
    const onClient = Object.values(client)
      .filter((v): v is Resource => v instanceof Resource)
      .map((r) => r.constructor.name)
      .sort();
    expect(onClient).toEqual(Object.keys(EXERCISED).sort());
  });
});

describe('the gates themselves work', () => {
  it('flags an undocumented property', () => {
    const schema = SPEC.components.schemas['CancelRequest']!;
    const errors = validate(schema, { OrderUID: 'x', Invented: true });
    expect(errors.join('\n')).toMatch(/Invented.*not defined in the spec/);
  });

  it('flags a missing required property', () => {
    const schema = SPEC.components.schemas['CancelRequest']!;
    expect(validate(schema, {}).join('\n')).toMatch(/OrderUID.*required/);
  });

  it('flags a wrong type on DeliveryPDFTemplateUid', () => {
    const schema = SPEC.components.schemas['OrderRequest']!;
    const errors = validate(schema, {
      Product: { Token: 'tok', Value: 5000, Currency: 'DKK', Quantity: 1 },
      Sync: false,
      DeliveryPDFTemplateUid: 123,
    });
    expect(errors.join('\n')).toMatch(/DeliveryPDFTemplateUid.*expected string/);
  });

  it('flags a wrong type', () => {
    const schema = SPEC.components.schemas['StockRequest']!;
    const errors = validate(schema, { ProductToken: 'x', Value: 1.5 });
    expect(errors.join('\n')).toMatch(/Value.*expected integer/);
  });

  it('flags a wrong type on each purchase order field', () => {
    const schema = SPEC.components.schemas['OrderRequest']!;
    const errors = validate(schema, {
      Product: { Token: 'tok', Value: 5000, Currency: 'DKK', Quantity: 1 },
      Sync: false,
      AdditionalReference: 1,
      CustomerReference: 2,
      ArticleNumber: 3,
      Description: 4,
      PurchaseOrderFileToken: 5,
    }).join('\n');
    for (const field of [
      'AdditionalReference',
      'CustomerReference',
      'ArticleNumber',
      'Description',
      'PurchaseOrderFileToken',
    ]) {
      expect(errors).toMatch(new RegExp(`${field}: expected string`));
    }
  });
});

describe('the multipart gate works', () => {
  const UPLOAD = SPEC.paths['/v4/Upload']!['post']!;
  const MEDIA = UPLOAD.requestBody!.content!['multipart/form-data']!;

  const part = (over: Partial<CapturedPart> = {}): CapturedPart => ({
    name: 'File',
    filename: 'po.pdf',
    contentType: 'application/pdf',
    headers: {},
    data: new Uint8Array([1, 2, 3]),
    ...over,
  });
  const body = (...parts: CapturedPart[]): CapturedMultipart => ({
    contentType: 'multipart/form-data; boundary=x',
    parts,
    error: undefined,
  });
  const call = (over: Partial<CapturedRequest>): CapturedRequest => ({
    method: 'POST',
    url: 'https://api.huuray.com/v4/Upload',
    origin: 'https://api.huuray.com',
    path: '/v4/Upload',
    query: {},
    headers: {},
    body: undefined,
    bodyOmitted: false,
    bodyKind: 'multipart',
    multipart: body(part()),
    ...over,
  });

  it('passes the File part the SDK sends', () => {
    expect(validateMultipart(MEDIA, body(part()), 'upload')).toEqual([]);
  });

  it('flags an undocumented part', () => {
    const errors = validateMultipart(MEDIA, body(part(), part({ name: 'Invented' })), 'upload');
    expect(errors.join('\n')).toMatch(/Invented.*not defined in the spec/);
  });

  it('flags a part sent twice', () => {
    expect(validateMultipart(MEDIA, body(part(), part()), 'upload').join('\n')).toMatch(
      /File.*more than once/,
    );
  });

  it('flags a missing required part', () => {
    const media = { ...MEDIA, schema: { ...deref(MEDIA.schema!), required: ['File'] } };
    expect(validateMultipart(media, body(), 'upload').join('\n')).toMatch(/File.*required/);
  });

  it('flags a File part with no filename, or no Content-Type', () => {
    expect(
      validateMultipart(MEDIA, body(part({ filename: undefined })), 'upload').join('\n'),
    ).toMatch(/File.*no filename/);
    expect(
      validateMultipart(MEDIA, body(part({ contentType: undefined })), 'upload').join('\n'),
    ).toMatch(/File.*no Content-Type/);
  });

  it('fails closed on an encoding other than style: form', () => {
    const media = {
      ...MEDIA,
      encoding: { File: { style: 'form', contentType: 'application/pdf' } },
    };
    expect(validateMultipart(media, body(part()), 'upload').join('\n')).toMatch(/not understood/);
  });

  it('fails closed on a property that is not binary', () => {
    const media = {
      ...MEDIA,
      schema: { type: 'object', properties: { File: { type: 'string' } } },
    };
    expect(validateMultipart(media, body(part()), 'upload').join('\n')).toMatch(
      /only a type "string", format "binary" part/,
    );
  });

  it('fails closed on a composed schema', () => {
    const media = { ...MEDIA, schema: { allOf: [MEDIA.schema!] } };
    expect(validateMultipart(media, body(part()), 'upload').join('\n')).toMatch(
      /not a plain object/,
    );
  });

  it('reports a body that could not be parsed', () => {
    const unparsed = { contentType: 'text/plain', parts: undefined, error: 'no boundary' };
    expect(validateMultipart(MEDIA, unparsed, 'upload').join('\n')).toMatch(/no boundary/);
  });

  it('fails closed on a media type it does not handle, or more than one', () => {
    const op = (content: Record<string, SpecMediaType>): SpecOperation => ({
      requestBody: { content },
    });
    expect(checkRequestBody(op({ 'text/csv': MEDIA }), call({})).join('\n')).toMatch(
      /"text\/csv" is not one this gate handles/,
    );
    expect(
      checkRequestBody(op({ 'multipart/form-data': MEDIA, 'application/json': MEDIA }), call({}))
        .join('\n'),
    ).toMatch(/2 media types/);
  });

  it('flags a JSON body sent to the multipart operation, and the reverse', () => {
    const json = call({ bodyKind: 'json', body: { File: 'x' }, multipart: undefined });
    expect(checkRequestBody(UPLOAD, json).join('\n')).toMatch(
      /declares a multipart\/form-data body, but the SDK sent a JSON body/,
    );
    const order = SPEC.paths['/v4/Order']!['post'];
    expect(checkRequestBody(order, call({ path: '/v4/Order' })).join('\n')).toMatch(
      /declares an application\/json body, but the SDK sent a multipart body/,
    );
  });

  it('the harness records a non-JSON body as "other" and never JSON-parses multipart', async () => {
    // Either used to throw inside the recording fetch, taking every gate with it.
    const { fetch, calls: recorded } = recordingFetch({ status: 200, json: {} });
    await fetch('https://api.huuray.com/v4/Order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    const form = new FormData();
    form.append('File', new Blob(['{"not":"parsed"}'], { type: 'application/json' }), 'a.json');
    await fetch('https://api.huuray.com/v4/Upload', { method: 'POST', body: form });

    expect(recorded.map((c) => c.bodyKind)).toEqual(['other', 'multipart']);
    expect(recorded.map((c) => c.body)).toEqual([undefined, undefined]);
    expect(checkRequestBody(SPEC.paths['/v4/Order']!['post'], recorded[0]!).join('\n')).toMatch(
      /sent a body that is neither JSON nor multipart/,
    );
    expect(checkRequestBody(UPLOAD, recorded[1]!)).toEqual([]);
  });
});
