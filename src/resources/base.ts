import type { HuurayClient } from '../client.js';

/**
 * Shared base for the typed resources.
 *
 * Every resource method maps 1:1 onto a single documented v4 operation. A method
 * with no corresponding path and verb in `openapi/huuray-v4.json` fails the
 * no-invention test in `test/conformance.test.ts`.
 */
export abstract class Resource {
  constructor(protected readonly client: HuurayClient) {}
}

/** Drops undefined entries so they are never serialised into a request body. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/** Formats a Date for the spec's `date-time` fields; passes strings through. */
export function toDateTime(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}
