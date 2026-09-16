import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli-main.js';
import { recordingFetch } from './helpers.js';

/** Throwaway credentials; the fake fetch below means nothing reaches the network. */
const env = { HUURAY_API_TOKEN: 'test-token', HUURAY_API_SECRET: 'test-secret' };

/** Runs the CLI against a one-response fake fetch and captures stdout. */
async function runCli(argv: string[], json: unknown) {
  const rec = recordingFetch([{ status: 200, json }]);
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    const code = await main(argv, { env, fetch: rec.fetch });
    return { code, stdout: lines.join('\n'), calls: rec.calls };
  } finally {
    log.mockRestore();
  }
}

describe('cli templates', () => {
  // Invented values, not taken from any account.
  const PDF_TEMPLATE = {
    Uid: '00000000-0000-4000-8000-00000000c11a',
    Name: 'Invented PDF template',
    Type: 'InventedType',
    Language: 'zz',
    Country: null,
    BrandName: null,
  };
  const response = { Templates: [], PDFTemplates: [PDF_TEMPLATE] };

  it('prints PDF templates in table output even when there are no delivery templates', async () => {
    const { code, stdout, calls } = await runCli(['templates'], response);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v4/Template' });

    const lines = stdout.split('\n');
    expect(lines.slice(0, 4)).toEqual(['Delivery templates', '(no results)', '', 'PDF templates']);
    expect(lines[4]).toMatch(/^uid\s+name\s+type\s+language\s+country\s+brand$/);
    expect(stdout).toContain(PDF_TEMPLATE.Uid);
    expect(stdout).toContain(PDF_TEMPLATE.Name);
    // Null country and brand render as empty cells, not "null".
    expect(stdout).not.toContain('null');
  });

  it('includes PDF templates in --json output alongside delivery templates', async () => {
    const { code, stdout } = await runCli(['templates', '--json'], response);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      templates: [],
      pdfTemplates: [
        {
          uid: PDF_TEMPLATE.Uid,
          name: PDF_TEMPLATE.Name,
          type: PDF_TEMPLATE.Type,
          language: PDF_TEMPLATE.Language,
          country: null,
          brandName: null,
        },
      ],
    });
  });
});
