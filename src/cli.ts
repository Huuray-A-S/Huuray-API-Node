#!/usr/bin/env node
/**
 * Read-only command line interface.
 *
 * Deliberately limited to operations that cannot move value: there is no
 * ordering, resending, or cancelling here. Sending real gift cards from a shell
 * one-liner is too easy to do by accident, and a mistyped quantity is money.
 *
 * Voucher codes are never printed, whatever the account settings allow.
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
import { HuurayApiError, HuurayError } from './errors.js';
import { redact } from './redact.js';

const USAGE = `
huuray — read-only CLI for the Huuray API v4

  Usage
    huuray <command> [options]

  Commands
    balance                       Available balances, per currency
    catalogue [--all]             Products you can order (--all for the full catalogue)
    templates                     Delivery templates on your account
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

async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);

  // Help must work before anything else, including the credential check.
  if (wantsHelp(flags) || !command) {
    console.log(USAGE.trim());
    return wantsHelp(flags) ? 0 : 1;
  }

  const apiToken = process.env['HUURAY_API_TOKEN'];
  const apiSecret = process.env['HUURAY_API_SECRET'];
  if (!apiToken || !apiSecret) {
    console.error('Set HUURAY_API_TOKEN and HUURAY_API_SECRET in the environment.');
    console.error('Run "huuray --help" for usage.');
    return 1;
  }

  const baseUrl = process.env['HUURAY_BASE_URL'];
  const client = new HuurayClient({
    apiToken,
    apiSecret,
    ...(baseUrl ? { baseUrl } : {}),
    userAgent: 'huuray-cli',
  });

  const asJson = flags['json'] === true;
  const emit = (data: unknown, rows: () => Record<string, unknown>[]) => {
    // redact() runs on both paths — voucher codes never reach stdout.
    if (asJson) console.log(JSON.stringify(redact(data), null, 2));
    else console.log(table(rows().map((r) => redact(r) as Record<string, unknown>)));
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
      const { templates } = await client.templates.list();
      emit(templates, () =>
        templates.map((t) => ({
          id: t.id,
          name: t.name ?? '',
          type: t.type ?? '',
          language: t.language ?? '',
          sender: t.sender ?? '',
        })),
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

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof HuurayApiError) {
      console.error(`Error: ${err.message}`);
      if (err.httpStatus === 401 || err.httpStatus === 403) {
        console.error(
          '\nIf the credentials are correct, the X-API-HASH encoding may differ from this\n' +
            "client's default. See the README section \"Authentication\".",
        );
      }
    } else if (err instanceof HuurayError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  });
