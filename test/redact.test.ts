import { describe, expect, it } from 'vitest';
import { redact, safeStringify } from '../src/index.js';

describe('redaction', () => {
  it('removes voucher codes — they are bearer instruments', () => {
    const out = safeStringify({
      Vouchers: [{ ID: 1, Code: 'REAL-CODE-123', CVV: '999', RedeemLink: 'https://r/abc' }],
    });
    expect(out).not.toContain('REAL-CODE-123');
    expect(out).not.toContain('999');
    expect(out).not.toContain('https://r/abc');
    expect(out).toContain('[redacted: bearer value]');
  });

  it('redacts camelCase fields too, so mapped results are covered', () => {
    const out = safeStringify({ vouchers: [{ code: 'REAL', cvv: '1', redeemLink: 'https://x' }] });
    expect(out).not.toContain('REAL');
  });

  it('keeps ids and expiry, which are safe and useful in a log', () => {
    const out = redact({ ID: 42, Expires: '2027-01-01', Code: 'SECRET' }) as Record<string, unknown>;
    expect(out['ID']).toBe(42);
    expect(out['Expires']).toBe('2027-01-01');
  });

  it('masks personal data without destroying it entirely', () => {
    const out = redact({ Email: 'jane@example.com' }) as Record<string, unknown>;
    expect(out['Email']).not.toBe('jane@example.com');
    expect(String(out['Email'])).toMatch(/^ja\*\*\*om$/);
  });

  it('masks credentials', () => {
    const out = safeStringify({ apiToken: 'tok_live_abcdef', apiSecret: 'shhh-secret' });
    expect(out).not.toContain('tok_live_abcdef');
    expect(out).not.toContain('shhh-secret');
  });

  it('leaves empty and null values alone rather than inventing a marker', () => {
    const out = redact({ Code: null, CVV: '' }) as Record<string, unknown>;
    expect(out['Code']).toBeNull();
    expect(out['CVV']).toBe('');
  });

  it('walks nested structures', () => {
    const out = safeStringify({ a: { b: { c: [{ Code: 'DEEP' }] } } });
    expect(out).not.toContain('DEEP');
  });

  it('does not recurse forever on a cycle', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic['self'] = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });
});
