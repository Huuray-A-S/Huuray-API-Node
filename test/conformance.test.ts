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
import { testClient, type CapturedRequest } from './helpers.js';

const SPEC = JSON.parse(
  readFileSync(fileURLToPath(new URL('../openapi/huuray-v4.json', import.meta.url)), 'utf8'),
) as SpecDoc;

interface SpecDoc {
  paths: Record<string, Record<string, SpecOperation>>;
  components: { schemas: Record<string, SpecSchema> };
}
interface SpecOperation {
  requestBody?: { content?: Record<string, { schema?: SpecSchema }> };
  parameters?: { name: string; in: string; required?: boolean }[];
}
interface SpecSchema {
  $ref?: string;
  type?: string;
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
 * Calls every public SDK method once, with every optional parameter populated,
 * so the gates below see the widest request each method can produce.
 */
async function exerciseEverything(): Promise<CapturedRequest[]> {
  const { client, calls } = testClient({ status: 200, json: {} });

  await client.balances.list();
  await client.catalogue.list({ all: true });
  await client.templates.list();
  await client.stock.check({ productToken: 'tok', value: 5000 });
  await client.exchangeRates.get({ from: 'DKK', to: 'EUR' });

  await client.orders.create({
    productToken: 'tok',
    value: 5000,
    currency: 'DKK',
    quantity: 2,
    expires: new Date('2027-01-01T00:00:00Z'),
    refId: 'ref-1',
    templateId: 42,
    deliveryDatetime: new Date('2026-09-01T09:00:00Z'),
    personalMessage: 'Thank you',
    recipients: [
      { name: 'A', email: 'a@example.com', refId: 'r-a' },
      { name: 'B', phone: '+4512345678', refId: 'r-b' },
    ],
  });

  await client.orders.createSync({
    productToken: 'tok',
    value: 5000,
    currency: 'DKK',
    quantity: 1,
    expires: new Date('2027-01-01T00:00:00Z'),
    refId: 'ref-sync',
    templateId: 42,
    deliveryDatetime: new Date('2026-09-01T09:00:00Z'),
    personalMessage: 'Thanks',
    recipients: [{ name: 'C', email: 'c@example.com', refId: 'r-c' }],
  });

  await client.orders.sendReward({
    productToken: 'tok',
    value: 5000,
    currency: 'DKK',
    recipient: { name: 'Jane', email: 'jane@example.com' },
    templateId: 42,
    refId: 'ref-2',
    personalMessage: 'Nice work',
    expires: '2027-01-01T00:00:00Z',
    deliveryDatetime: '2026-09-01T09:00:00Z',
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

  it('covers exactly the nine v4 operations — no more, no fewer', () => {
    expect(specOperations().size).toBe(9);
  });
});

describe('request-conformance gate', () => {
  it('every request body validates against its spec schema', () => {
    const failures: string[] = [];

    for (const call of calls) {
      const op = SPEC.paths[call.path]?.[call.method.toLowerCase()];
      const schema = op?.requestBody?.content?.['application/json']?.schema;

      if (!schema) {
        // The spec declares no body for this operation, so the SDK must send none.
        if (!call.bodyOmitted) {
          failures.push(
            `${call.method} ${call.path}: spec declares no requestBody, but the SDK sent one`,
          );
        }
        continue;
      }
      failures.push(
        ...validate(schema, call.body, `${call.method} ${call.path}`).map((e) => e),
      );
    }

    expect(failures).toEqual([]);
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

  it('flags a wrong type', () => {
    const schema = SPEC.components.schemas['StockRequest']!;
    const errors = validate(schema, { ProductToken: 'x', Value: 1.5 });
    expect(errors.join('\n')).toMatch(/Value.*expected integer/);
  });
});
