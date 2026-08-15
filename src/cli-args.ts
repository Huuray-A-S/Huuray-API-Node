import { HuurayError } from './errors.js';

export interface ParsedArgs {
  /** The first non-flag argument, e.g. `balance`. Undefined when only flags were given. */
  command: string | undefined;
  flags: Record<string, string | boolean>;
}

/** Flags that never take a value. */
const BOOLEAN_FLAGS = new Set(['json', 'all', 'help', 'h']);

/**
 * Flags that always take a value.
 *
 * Declared explicitly so a missing value is an error, never a silent downgrade:
 * `huuray search --ref-id --json` must not quietly run a filterless search —
 * the user typed a filter, so dropping it changes which API query is sent.
 */
const VALUED_FLAGS = new Set(['token', 'value', 'from', 'to', 'ref-id', 'order-uid', 'voucher-id']);

/**
 * Parses `argv` into a command and flags.
 *
 * Flags may appear anywhere, including before the command. Both `--flag value`
 * and `--flag=value` are accepted. A valued flag with no value, or a flag the
 * CLI does not know, is an error rather than a guess.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }

    let key = arg.replace(/^--?/, '');
    let inlineValue: string | undefined;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      inlineValue = key.slice(eq + 1);
      key = key.slice(0, eq);
    }

    if (BOOLEAN_FLAGS.has(key)) {
      if (inlineValue !== undefined) {
        throw new HuurayError(`Option --${key} does not take a value.`);
      }
      flags[key] = true;
      continue;
    }

    if (VALUED_FLAGS.has(key)) {
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
        continue;
      }
      const next = argv[i + 1];
      // The next token is the value even when it starts with '-', so negative
      // numbers work; only a missing token or another known flag is an error.
      if (next === undefined || next.replace(/^--?/, '').split('=')[0] === key || isKnownFlag(next)) {
        throw new HuurayError(`Option --${key} requires a value. Run "huuray --help".`);
      }
      flags[key] = next;
      i++;
      continue;
    }

    throw new HuurayError(`Unknown option --${key}. Run "huuray --help".`);
  }

  return { command: positionals[0], flags };
}

function isKnownFlag(token: string): boolean {
  if (!token.startsWith('-')) return false;
  const key = token.replace(/^--?/, '').split('=')[0]!;
  return BOOLEAN_FLAGS.has(key) || VALUED_FLAGS.has(key);
}

export function wantsHelp(flags: Record<string, string | boolean>): boolean {
  return flags['help'] === true || flags['h'] === true;
}

export function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  if (typeof v !== 'string' || v === '') {
    throw new HuurayError(`Missing required option --${name}. Run "huuray --help".`);
  }
  return v;
}

export function optionalInt(
  flags: Record<string, string | boolean>,
  name: string,
): number | undefined {
  const v = flags[name];
  if (v === undefined || typeof v === 'boolean') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HuurayError(`--${name} must be an integer, got "${v}".`);
  return n;
}

export function optionalString(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

/** Minimal fixed-width table. Kept local so the package ships no CLI dependencies. */
export function table(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(no results)';
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const width = Object.fromEntries(
    columns.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length))]),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(width[columns[i]!]!))
      .join('  ')
      .trimEnd();

  return [
    line(columns),
    line(columns.map((c) => '─'.repeat(width[c]!))),
    ...rows.map((r) => line(columns.map((c) => String(r[c] ?? '')))),
  ].join('\n');
}
