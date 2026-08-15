/**
 * Voucher codes are bearer instruments: whoever holds the code holds the value.
 * They must never reach a log file, an error report, a CI fixture, or a bug
 * report pasted into a public issue.
 *
 * Redaction is this library's job, not the caller's. Anything this SDK prints
 * or attaches to an error goes through here first.
 */

/** Response fields that carry redeemable value and are never logged. */
export const SECRET_FIELDS = ['Code', 'CVV', 'RedeemLink', 'code', 'cvv', 'redeemLink'] as const;

/** Fields carrying credentials or personal data, masked in any diagnostic output. */
export const SENSITIVE_FIELDS = [
  'X-API-TOKEN',
  'X-API-HASH',
  'apiToken',
  'apiSecret',
  'Email',
  'email',
  'Phone',
  'phone',
] as const;

const SECRET = new Set<string>(SECRET_FIELDS);
const SENSITIVE = new Set<string>(SENSITIVE_FIELDS);

/**
 * Returns a deep copy with secret and sensitive values replaced by markers.
 *
 * Use for anything human-facing. It is deliberately lossy: a redacted voucher
 * code cannot be recovered from the output.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[redacted: too deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET.has(k)) {
      out[k] = v == null || v === '' ? v : '[redacted: bearer value]';
    } else if (SENSITIVE.has(k)) {
      out[k] = v == null || v === '' ? v : maskPartial(String(v));
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

/** Keeps just enough of a value to recognise it, never enough to use it. */
function maskPartial(s: string): string {
  if (s.length <= 4) return '***';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/** `JSON.stringify` with redaction applied. Safe to log. */
export function safeStringify(value: unknown, space?: number): string {
  return JSON.stringify(redact(value), null, space);
}
