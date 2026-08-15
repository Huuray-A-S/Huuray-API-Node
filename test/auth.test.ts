import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAuthHeaders,
  generateNonce,
  signRequest,
  NONCE_MAX_LENGTH,
  DEFAULT_HASH_ENCODING,
} from '../src/auth.js';

describe('nonce generation', () => {
  it('stays within the 50-character limit the API enforces', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateNonce().length).toBeLessThanOrEqual(NONCE_MAX_LENGTH);
    }
  });

  it('produces 32 base64url characters', () => {
    const n = generateNonce();
    expect(n).toHaveLength(32);
    expect(n).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('does not repeat — the API rejects a reused nonce for 60 days', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i++) seen.add(generateNonce());
    expect(seen.size).toBe(100_000);
  });

  it('rejects a custom nonce that would exceed the API limit', () => {
    expect(() =>
      buildAuthHeaders({ apiToken: 't', apiSecret: 's', nonce: 'x'.repeat(51) }),
    ).toThrow(/at most 50/);
  });

  it('accepts a nonce exactly at the limit', () => {
    expect(() =>
      buildAuthHeaders({ apiToken: 't', apiSecret: 's', nonce: 'x'.repeat(50) }),
    ).not.toThrow();
  });

  it('rejects 32-byte hex, the classic over-limit mistake', () => {
    const hex64 = 'a'.repeat(64);
    expect(() => buildAuthHeaders({ apiToken: 't', apiSecret: 's', nonce: hex64 })).toThrow();
  });
});

describe('request signing', () => {
  // Independently computed here rather than copied from the implementation, so
  // this fails if the construction changes.
  const expected = (secret: string, nonce: string) =>
    createHash('sha512').update(secret + nonce, 'utf8').digest('hex');

  it('is SHA-512 over ( API-SECRET + NONCE ), in that order', () => {
    expect(signRequest('sec', 'non')).toBe(expected('sec', 'non'));
  });

  it('is order-sensitive — nonce+secret is a different digest', () => {
    expect(signRequest('ab', 'cd')).not.toBe(signRequest('cd', 'ab'));
  });

  it('defaults to lowercase hex', () => {
    expect(DEFAULT_HASH_ENCODING).toBe('hex');
    expect(signRequest('sec', 'non')).toMatch(/^[0-9a-f]{128}$/);
  });

  it.each([
    ['hex', /^[0-9a-f]{128}$/],
    ['hex-upper', /^[0-9A-F]{128}$/],
    ['base64', /^[A-Za-z0-9+/]+=*$/],
    ['base64url', /^[A-Za-z0-9_-]+$/],
  ] as const)('supports %s encoding', (encoding, pattern) => {
    expect(signRequest('sec', 'non', encoding)).toMatch(pattern);
  });

  it('uses the encoding confirmed against the live API', () => {
    // The v4 specification states the construction, SHA512(API_SECRET + NONCE),
    // but not the digest encoding. Confirmed live on 2026-08-15: lowercase hex
    // authenticated against GET /v4/Balance on api.huuray.com (the other three
    // candidate encodings returned 401). If this test fails, someone changed
    // the default — that breaks every consumer unless the API changed first.
    expect(DEFAULT_HASH_ENCODING).toBe('hex');
  });
});

describe('auth headers', () => {
  it('sends exactly the three documented headers', () => {
    const h = buildAuthHeaders({ apiToken: 'tok', apiSecret: 'sec', nonce: 'abc' });
    expect(Object.keys(h).sort()).toEqual(['X-API-HASH', 'X-API-NONCE', 'X-API-TOKEN']);
    expect(h['X-API-TOKEN']).toBe('tok');
    expect(h['X-API-NONCE']).toBe('abc');
  });

  it('never puts the secret in a header', () => {
    const h = buildAuthHeaders({ apiToken: 'tok', apiSecret: 'super-secret', nonce: 'abc' });
    expect(JSON.stringify(h)).not.toContain('super-secret');
  });
});
