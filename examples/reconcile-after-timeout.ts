/**
 * The pattern that matters most: recovering from an order whose outcome is
 * unknown.
 *
 * `POST /v4/Order` has no idempotency key. If the request times out or the
 * server returns a 5xx, the order may or may not have been created — and
 * retrying can order a second time, for real money.
 *
 * So this SDK never retries an order. It throws
 * `HuurayIndeterminateOrderError` and expects you to reconcile, which is only
 * possible if you sent a `refId` you can look up. That is why `sendReward()`
 * requires one.
 */

import {
  HuurayClient,
  HuurayIndeterminateOrderError,
  HuurayNotFoundError,
} from '../src/index.js';

const huuray = new HuurayClient({
  apiToken: process.env['HUURAY_API_TOKEN']!,
  apiSecret: process.env['HUURAY_API_SECRET']!,
});

/** A key from your own system — stable, unique, and meaningful to you. */
const refId = 'payroll-2026-08-jane';

async function sendOnce() {
  try {
    const reward = await huuray.sendReward({
      productToken: 'REPLACE_WITH_A_REAL_TOKEN',
      value: 50_00, // minor units — 50.00
      currency: 'DKK',
      recipient: { name: 'Jane Doe', email: 'jane@example.com' },
      templateId: 1,
      refId,
    });

    console.log(`Ordered. orderUid=${reward.orderUid}`);
    return reward;
  } catch (err) {
    if (!(err instanceof HuurayIndeterminateOrderError)) throw err;

    // Do NOT retry the order here. Find out what actually happened.
    console.warn('Order outcome unknown. Reconciling by refId instead of retrying.');

    try {
      const found = await huuray.orders.search({ refId });

      if (found.orderUid) {
        console.log(`It landed after all: orderUid=${found.orderUid}. Nothing more to do.`);
        return { orderUid: found.orderUid, refId: found.refId };
      }

      console.log('No order exists for this refId. Safe to send again with the same refId.');
      return null;
    } catch (lookup) {
      // The spec documents 404 on /v4/Search — the API's way of saying no
      // order matched. That IS the answer: the order did not land.
      if (lookup instanceof HuurayNotFoundError) {
        console.log('No order exists for this refId (404). Safe to send again with the same refId.');
        return null;
      }
      // Anything else means the lookup itself failed and the outcome is STILL
      // unknown. Escalate — do not treat a failed lookup as "not landed".
      throw lookup;
    }
  }
}

await sendOnce();
