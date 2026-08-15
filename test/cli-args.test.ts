import { describe, expect, it } from 'vitest';
import {
  optionalInt,
  optionalString,
  parseArgs,
  requireFlag,
  table,
  wantsHelp,
} from '../src/cli-args.js';

describe('parseArgs', () => {
  it('reads a bare command', () => {
    expect(parseArgs(['balance'])).toEqual({ command: 'balance', flags: {} });
  });

  it('reads a command with a boolean flag', () => {
    expect(parseArgs(['catalogue', '--all'])).toEqual({
      command: 'catalogue',
      flags: { all: true },
    });
  });

  it('reads a command with a valued flag', () => {
    expect(parseArgs(['stock', '--token', 'abc'])).toEqual({
      command: 'stock',
      flags: { token: 'abc' },
    });
  });

  it('handles a flag before the command', () => {
    // Regression: --help used to be swallowed as the command name, so
    // `huuray --help` demanded credentials before printing usage.
    expect(parseArgs(['--help'])).toEqual({ command: undefined, flags: { help: true } });
  });

  it('finds the command even when flags come first', () => {
    expect(parseArgs(['--json', 'balance'])).toMatchObject({ command: 'balance' });
  });

  it('supports the short help flag', () => {
    expect(wantsHelp(parseArgs(['-h']).flags)).toBe(true);
    expect(wantsHelp(parseArgs(['balance']).flags)).toBe(false);
  });

  it('rejects a valued flag with no value instead of silently degrading', () => {
    // `huuray search --ref-id --json` must not quietly run a FILTERLESS search:
    // the user typed a filter, so dropping it changes which API query is sent.
    expect(() => parseArgs(['search', '--ref-id'])).toThrow(/--ref-id requires a value/);
    expect(() => parseArgs(['search', '--ref-id', '--json'])).toThrow(/--ref-id requires a value/);
  });

  it('supports GNU --flag=value syntax', () => {
    expect(parseArgs(['search', '--ref-id=abc']).flags).toEqual({ 'ref-id': 'abc' });
    expect(parseArgs(['rates', '--from=EUR', '--to', 'DKK']).flags).toEqual({
      from: 'EUR',
      to: 'DKK',
    });
  });

  it('rejects a value on a boolean flag', () => {
    expect(() => parseArgs(['catalogue', '--all=yes'])).toThrow(/does not take a value/);
  });

  it('accepts negative numbers as flag values', () => {
    expect(parseArgs(['stock', '--token', 'x', '--value', '-500']).flags).toEqual({
      token: 'x',
      value: '-500',
    });
  });

  it('rejects unknown flags instead of ignoring them', () => {
    expect(() => parseArgs(['balance', '--verbose'])).toThrow(/Unknown option --verbose/);
  });

  it('keeps hyphenated flag names intact', () => {
    expect(parseArgs(['search', '--ref-id', 'payroll-2026-08']).flags).toEqual({
      'ref-id': 'payroll-2026-08',
    });
  });

  it('returns no command for empty argv', () => {
    expect(parseArgs([]).command).toBeUndefined();
  });
});

describe('flag readers', () => {
  it('requireFlag explains what is missing', () => {
    expect(() => requireFlag({}, 'token')).toThrow(/--token/);
    expect(() => requireFlag({ token: true }, 'token')).toThrow(/--token/);
    expect(requireFlag({ token: 'abc' }, 'token')).toBe('abc');
  });

  it('optionalInt rejects a non-integer rather than silently truncating', () => {
    expect(() => optionalInt({ value: '50.5' }, 'value')).toThrow(/must be an integer/);
    expect(optionalInt({ value: '5000' }, 'value')).toBe(5000);
    expect(optionalInt({}, 'value')).toBeUndefined();
    expect(optionalInt({ value: true }, 'value')).toBeUndefined();
  });

  it('optionalString ignores boolean flags', () => {
    expect(optionalString({ 'ref-id': true }, 'ref-id')).toBeUndefined();
    expect(optionalString({ 'ref-id': 'r' }, 'ref-id')).toBe('r');
  });
});

describe('table', () => {
  it('says so plainly when there is nothing to show', () => {
    expect(table([])).toBe('(no results)');
  });

  it('aligns columns and includes a header rule', () => {
    const out = table([
      { currency: 'DKK', balance: 50_000 },
      { currency: 'EUR', balance: 1234 },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^currency\s+balance$/);
    expect(lines[1]).toMatch(/^─+\s+─+$/);
    expect(lines).toHaveLength(4);
  });
});
