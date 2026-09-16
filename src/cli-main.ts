/**
 * Read-only command line interface.
 *
 * Deliberately limited to operations that cannot move value: there is no
 * ordering, resending, or cancelling here. Sending real gift cards from a shell
 * one-liner is too easy to do by accident, and a mistyped quantity is money.
 *
 * Voucher codes are never printed, whatever the account settings allow.
 *
 * The process wiring (argv, exit code, error printing) lives in `cli.ts`; this
 * module only defines the commands, so tests can run them against a fake fetch.
 */

import { HuurayClient } from './client.js';
import {
  optionalInt,
  optionalString,
  parseArgs,
  requireFlag,
  table,
  wantsHelp,
} from './cli-args.js';
import { redact } from './redact.js';

export const USAGE = `
huuray — read-only CLI for the Huuray API v4

  Usage
    huuray <command> [options]

  Commands
    balance                       Available balances, per currency
    catalogue [--all]             Products you can order (--all for the full catalogue)
    templates                     Delivery and PDF templates on your account
    stock --token <t> [--value N] Stock for a product (value in minor units)
    rates --from EUR --to DKK     Exchange rate and spread
    search [--ref-id R] [--order-uid U] [--voucher-id N]
                                  Look up vouchers from previous orders

  Options
    --json                        Machine-readable output
    -h, --help                    This text

  Credentials, from the environment
    HUURAY_API_TOKEN
    HUURAY_API_SECRET
    HUURAY_BASE_URL               Optional; defaults to https://api.huuray.com

  Ordering, resending and cancelling are not available here. They move real
  value, so they belong in code you have reviewed. See the README.

  Voucher codes are never printed by this CLI.
`;

export interface CliOptions {
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Passed to the client; the test suite injects a fake. */
  fetch?: typeof globalThis.fetch;
}

export async function main(argv: string[], options: CliOptions = {}): Promise<number> {
  const { command, flags } = parseArgs(argv);

  // Help must work before anything else, including the credential check.
  if (wantsHelp(flags) || !command) {
    console.log(USAGE.trim());
    return wantsHelp(flags) ? 0 : 1;
  }

  const env = options.env ?? process.env;
  const apiToken = env['HUURAY_API_TOKEN'];
  const apiSecret = env['HUURAY_API_SECRET'];
  if (!apiToken || !apiSecret) {
    console.error('Set HUURAY_API_TOKEN and HUURAY_API_SECRET in the environment.');
    console.error('Run "huuray --help" for usage.');
    return 1;
  }

  const baseUrl = env['HUURAY_BASE_URL'];
  const client = new HuurayClient({
    apiToken,
    apiSecret,
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    userAgent: 'huuray-cli',
  });

  const asJson = flags['json'] === true;
  // redact() runs on every output path — voucher codes never reach stdout.
  const printJson = (data: unknown) => console.log(JSON.stringify(redact(data), null, 2));
  const render = (rows: Record<string, unknown>[]) =>
    table(rows.map((r) => redact(r) as Record<string, unknown>));
  const emit = (data: unknown, rows: () => Record<string, unknown>[]) => {
    if (asJson) printJson(data);
    else console.log(render(rows()));
  };

  switch (command) {
    case 'balance': {
      const { balances } = await client.balances.list();
      emit(balances, () =>
        balances.map((b) => ({
          currency: b.currency ?? '',
          'balance (minor units)': b.balance,
          master: b.master ? 'yes' : '',
        })),
      );
      return 0;
    }

    case 'catalogue': {
      const { products } = await client.catalogue.list({ all: flags['all'] === true });
      emit(products, () =>
        products.map((p) => ({
          token: p.productToken ?? '(not returned with --all)',
          brand: p.brandName ?? '',
          country: p.countryCode ?? '',
          currency: p.currency ?? '',
          discount: p.discount ?? '',
          active: p.active ? 'yes' : 'no',
        })),
      );
      return 0;
    }

    case 'templates': {
      // Both lists, always: an account whose templates are all PDF templates
      // must not print an empty result.
      const { templates, pdfTemplates } = await client.templates.list();
      if (asJson) {
        printJson({ templates, pdfTemplates });
        return 0;
      }
      console.log('Delivery templates');
      console.log(
        render(
          templates.map((t) => ({
            id: t.id,
            name: t.name ?? '',
            type: t.type ?? '',
            language: t.language ?? '',
            sender: t.sender ?? '',
          })),
        ),
      );
      console.log('');
      console.log('PDF templates');
      console.log(
        render(
          pdfTemplates.map((t) => ({
            uid: t.uid ?? '',
            name: t.name ?? '',
            type: t.type ?? '',
            language: t.language ?? '',
            country: t.country ?? '',
            brand: t.brandName ?? '',
          })),
        ),
      );
      return 0;
    }

    case 'stock': {
      const value = optionalInt(flags, 'value');
      const result = await client.stock.check({
        productToken: requireFlag(flags, 'token'),
        ...(value !== undefined ? { value } : {}),
      });
      emit(result, () => [{ stock: result.stock ?? 'unknown' }]);
      return 0;
    }

    case 'rates': {
      const result = await client.exchangeRates.get({
        from: requireFlag(flags, 'from'),
        to: requireFlag(flags, 'to'),
      });
      emit(result, () => [{ rate: result.exchangeRate ?? '', 'spread (%)': result.spread ?? '' }]);
      return 0;
    }

    case 'search': {
      const refId = optionalString(flags, 'ref-id');
      const orderUid = optionalString(flags, 'order-uid');
      const voucherId = optionalInt(flags, 'voucher-id');
      const result = await client.orders.search({
        ...(refId !== undefined ? { refId } : {}),
        ...(orderUid !== undefined ? { orderUid } : {}),
        ...(voucherId !== undefined ? { voucherId } : {}),
      });
      // No code column at all: codes are never printed by this CLI, and a
      // column of redaction markers would wrongly imply codes were present.
      emit(result, () =>
        result.vouchers.map((v) => ({
          'voucher id': v.id ?? '',
          expires: v.expires ?? '',
          recipient: v.recipient?.name ?? v.recipient?.refId ?? '',
        })),
      );
      if (!asJson) {
        console.log(`\norder: ${result.orderUid ?? '(none)'}  ref: ${result.refId ?? ''}`);
        console.log('(voucher codes are never printed by this CLI)');
      }
      return 0;
    }

    default:
      console.error(`Unknown command "${command}". Run "huuray --help".`);
      return 1;
  }
}
