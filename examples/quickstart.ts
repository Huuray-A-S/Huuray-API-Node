/**
 * Quickstart — read-only.
 *
 * Every call here is safe to run against a live account: nothing is ordered,
 * nothing is delivered, nothing is spent.
 *
 *   HUURAY_API_TOKEN=... HUURAY_API_SECRET=... npx tsx examples/quickstart.ts
 */

import { HuurayClient } from '../src/index.js';

const huuray = new HuurayClient({
  apiToken: process.env['HUURAY_API_TOKEN']!,
  apiSecret: process.env['HUURAY_API_SECRET']!,
});

// 1. What can we spend? Amounts are in minor units: 50000 is 500.00.
const { balances } = await huuray.balances.list();
for (const b of balances) {
  console.log(`${b.currency}  ${(b.balance / 100).toFixed(2)}${b.master ? '  (master)' : ''}`);
}

// 2. What can we send? Leaving `all` false returns only products this account
//    can order, and includes the productToken you need in order to order them.
const { products } = await huuray.catalogue.list({ all: false });
console.log(`\n${products.length} products available`);

const first = products.find((p) => p.active && p.productToken);
if (!first?.productToken) {
  console.log('No orderable products on this account.');
  process.exit(0);
}
console.log(`Example: ${first.brandName} (${first.currency}) — token ${first.productToken}`);

// 3. Is it in stock?
const { stock } = await huuray.stock.check({ productToken: first.productToken });
console.log(`Stock: ${stock ?? 'unknown'}`);

// 4. How would it be delivered? Templates are the emails and texts recipients get.
const { templates } = await huuray.templates.list();
console.log(`\n${templates.length} delivery templates`);
for (const t of templates.slice(0, 5)) {
  console.log(`  ${t.id}  ${t.name} (${t.type}, ${t.language})`);
}

/*
 * Sending an actual reward is one more call. It is commented out because
 * running it spends real money:
 *
 * const reward = await huuray.sendReward({
 *   productToken: first.productToken,
 *   value:        50_00,          // minor units — 50.00
 *   currency:     first.currency!,
 *   recipient:    { name: 'Jane Doe', email: 'jane@example.com' },
 *   templateId:   templates[0]!.id,
 *   refId:        'quickstart-demo-1',   // your own key, required
 * });
 * console.log(reward.orderUid);
 */
