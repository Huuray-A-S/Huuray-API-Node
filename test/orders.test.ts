import { describe, expect, it } from 'vitest';
import { HuurayIndeterminateOrderError, SYNC_QUANTITY_LIMIT } from '../src/index.js';
import { testClient } from './helpers.js';

const base = { productToken: 'tok', value: 5000, currency: 'DKK', quantity: 1 } as const;

describe('minor units', () => {
  it('rejects a fractional value before sending anything', async () => {
    const { client, calls } = testClient();
    await expect(client.orders.create({ ...base, value: 50.0001 })).rejects.toThrow(
      /integer in minor units/,
    );
    expect(calls).toHaveLength(0);
  });

  it('explains the real failure in the error: major units order 1/100th', async () => {
    const { client } = testClient();
    await expect(client.orders.create({ ...base, value: 50.5 })).rejects.toThrow(
      /1\/100th of the intended amount/,
    );
  });

  it('sends the integer through untouched', async () => {
    const { client, calls } = testClient({ status: 200, json: { OrderUID: 'x' } });
    await client.orders.create({ ...base, value: 5000 });
    expect((calls[0]?.body as { Product: { Value: number } }).Product.Value).toBe(5000);
  });
});

describe('sync vs async ordering', () => {
  it('create() sends Sync: false', async () => {
    const { client, calls } = testClient({ status: 200, json: { OrderUID: 'x' } });
    await client.orders.create(base);
    expect((calls[0]?.body as { Sync: boolean }).Sync).toBe(false);
  });

  it('createSync() sends Sync: true', async () => {
    const { client, calls } = testClient({ status: 200, json: { OrderUID: 'x', Vouchers: [] } });
    await client.orders.createSync(base);
    expect((calls[0]?.body as { Sync: boolean }).Sync).toBe(true);
  });

  it('createSync() enforces the documented 25-code limit', async () => {
    const { client, calls } = testClient();
    await expect(
      client.orders.createSync({ ...base, quantity: SYNC_QUANTITY_LIMIT + 1 }),
    ).rejects.toThrow(/limited to 25/);
    expect(calls).toHaveLength(0);
  });

  it('createSync() returns vouchers; create() does not expose them', async () => {
    const { client } = testClient({
      status: 200,
      json: {
        OrderUID: 'x',
        Vouchers: [{ ID: 1, Code: 'ABC', RedeemLink: 'https://r/1', Expires: '2027-01-01' }],
      },
    });
    const result = await client.orders.createSync(base);
    expect(result.vouchers[0]).toMatchObject({ id: 1, code: 'ABC', redeemLink: 'https://r/1' });
  });

  it('surfaces blanked codes as null rather than pretending', async () => {
    // Codes come back empty unless ReturnCode is enabled on the account.
    const { client } = testClient({
      status: 200,
      json: { OrderUID: 'x', Vouchers: [{ ID: 1, Code: null, CVV: null, RedeemLink: null }] },
    });
    const result = await client.orders.createSync(base);
    expect(result.vouchers[0]).toMatchObject({ id: 1, code: null, cvv: null, redeemLink: null });
  });
});

describe('recipient validation, as the spec states it', () => {
  it('requires recipients when a delivery template is set', async () => {
    const { client } = testClient();
    await expect(client.orders.create({ ...base, templateId: 42 })).rejects.toThrow(
      /recipients is required/,
    );
  });

  it('accepts exactly one recipient for a multi-code order', async () => {
    const { client } = testClient({ status: 200, json: { OrderUID: 'x' } });
    await expect(
      client.orders.create({
        ...base,
        quantity: 5,
        templateId: 42,
        recipients: [{ email: 'a@example.com' }],
      }),
    ).resolves.toBeDefined();
  });

  it('accepts a recipient count matching quantity', async () => {
    const { client } = testClient({ status: 200, json: { OrderUID: 'x' } });
    await expect(
      client.orders.create({
        ...base,
        quantity: 2,
        templateId: 42,
        recipients: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a count that is neither 1 nor quantity', async () => {
    const { client } = testClient();
    await expect(
      client.orders.create({
        ...base,
        quantity: 5,
        templateId: 42,
        recipients: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
      }),
    ).rejects.toThrow(/either 1 entry or exactly quantity/);
  });

  it('allows no recipients when there is no delivery template', async () => {
    const { client } = testClient({ status: 200, json: { OrderUID: 'x' } });
    await expect(client.orders.create(base)).resolves.toBeDefined();
  });
});

describe('sendReward', () => {
  it('makes exactly one POST /v4/Order with Quantity 1 and Sync false', async () => {
    const { client, calls } = testClient({ status: 200, json: { OrderUID: 'x', RefID: 'r' } });
    await client.orders.sendReward({
      productToken: 'tok',
      value: 5000,
      currency: 'DKK',
      recipient: { name: 'Jane', email: 'jane@example.com' },
      templateId: 42,
      refId: 'payroll-2026-08-jane',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v4/Order' });
    const body = calls[0]?.body as {
      Product: { Quantity: number };
      Sync: boolean;
      RefID: string;
      Recipients: unknown[];
    };
    expect(body.Product.Quantity).toBe(1);
    expect(body.Sync).toBe(false);
    expect(body.RefID).toBe('payroll-2026-08-jane');
    expect(body.Recipients).toHaveLength(1);
  });

  it('refuses without a refId, and never generates one', async () => {
    const { client, calls } = testClient();
    await expect(
      client.orders.sendReward({
        productToken: 'tok',
        value: 5000,
        currency: 'DKK',
        recipient: { email: 'jane@example.com' },
        templateId: 42,
        refId: '',
      }),
    ).rejects.toThrow(/refId is required/);
    expect(calls).toHaveLength(0);
  });

  it('is also reachable from the client for the one-call case', async () => {
    const { client, calls } = testClient({ status: 200, json: { OrderUID: 'x' } });
    await client.sendReward({
      productToken: 'tok',
      value: 5000,
      currency: 'DKK',
      recipient: { email: 'jane@example.com' },
      templateId: 42,
      refId: 'r-1',
    });
    expect(calls).toHaveLength(1);
  });
});

describe('indeterminate orders', () => {
  it('throws HuurayIndeterminateOrderError when the connection drops', async () => {
    const { client } = testClient({ throws: new TypeError('socket hang up') });
    await expect(
      client.orders.create({ ...base, refId: 'ref-9' }),
    ).rejects.toBeInstanceOf(HuurayIndeterminateOrderError);
  });

  it('throws it when the connection drops mid-body — after the request was sent', async () => {
    // The regression that mattered most: a body-read failure used to escape as
    // a raw DOMException, bypassing this wrapper entirely — and a consumer's
    // generic retry handler would then re-order.
    const { client } = testClient({ bodyThrows: new TypeError('terminated') });
    await expect(
      client.orders.create({ ...base, refId: 'ref-9' }),
    ).rejects.toBeInstanceOf(HuurayIndeterminateOrderError);
  });

  it('throws it on a timeout that fires while the response body streams', async () => {
    const { client } = testClient({
      bodyThrows: new DOMException('The operation timed out.', 'TimeoutError'),
    });
    await expect(
      client.orders.create({ ...base, refId: 'ref-9' }),
    ).rejects.toBeInstanceOf(HuurayIndeterminateOrderError);
  });

  it('throws it on a garbled 2xx body — the order may well have landed', async () => {
    const { client } = testClient({ status: 200, text: 'not json at all' });
    await expect(
      client.orders.create({ ...base, refId: 'ref-9' }),
    ).rejects.toBeInstanceOf(HuurayIndeterminateOrderError);
  });

  it('throws it on a 5xx too — the server may still have processed the order', async () => {
    const { client } = testClient({ status: 500 });
    await expect(client.orders.create({ ...base, refId: 'ref-9' })).rejects.toBeInstanceOf(
      HuurayIndeterminateOrderError,
    );
  });

  it('carries the refId so the caller can reconcile', async () => {
    // The error is captured, never asserted inside .catch() — a resolving call
    // would make in-catch assertions pass vacuously.
    const { client } = testClient({ status: 502 });
    const err: unknown = await client.orders
      .create({ ...base, refId: 'ref-9' })
      .then(() => expect.unreachable('order must reject on 502'), (e: unknown) => e);
    expect(err).toBeInstanceOf(HuurayIndeterminateOrderError);
    expect((err as HuurayIndeterminateOrderError).refId).toBe('ref-9');
    expect((err as Error).message).toMatch(/Do NOT retry/);
    expect((err as Error).message).toMatch(/ref-9/);
  });

  it('says so plainly when no refId was sent', async () => {
    const { client } = testClient({ status: 500 });
    await expect(client.orders.create(base)).rejects.toMatchObject({
      message: expect.stringMatching(/No RefID was sent/),
    });
  });

  it('does NOT mask a 422 — that order was definitively rejected', async () => {
    const { client } = testClient({ status: 422, json: { Status: 422, StatusMessage: 'bad' } });
    await expect(client.orders.create(base)).rejects.not.toBeInstanceOf(
      HuurayIndeterminateOrderError,
    );
  });
});

describe('partial success on 206', () => {
  it('flags a partial cancel and exposes the per-voucher outcome', async () => {
    const { client } = testClient({
      status: 206,
      json: {
        OrderUID: 'uid',
        OrderCancelled: false,
        Vouchers: [
          { ID: 1, Cancelled: true },
          { ID: 2, Cancelled: false },
        ],
      },
    });
    const result = await client.orders.cancel({ orderUid: 'uid' });
    expect(result.partial).toBe(true);
    expect(result.orderCancelled).toBe(false);
    expect(result.vouchers).toEqual([
      { id: 1, cancelled: true },
      { id: 2, cancelled: false },
    ]);
  });

  it('does not flag a clean 200 cancel as partial', async () => {
    const { client } = testClient({
      status: 200,
      json: { OrderUID: 'uid', OrderCancelled: true, Vouchers: [] },
    });
    const result = await client.orders.cancel({ orderUid: 'uid' });
    expect(result.partial).toBe(false);
    expect(result.orderCancelled).toBe(true);
  });

  it('flags a partial resend', async () => {
    const { client } = testClient({ status: 206, json: { NumberOfResends: 3 } });
    const result = await client.orders.resend({ orderUid: 'uid' });
    expect(result).toEqual({ numberOfResends: 3, partial: true });
  });
});

describe('search', () => {
  it('omits every parameter that was not supplied', async () => {
    const { client, calls } = testClient({ status: 200, json: { OrderUID: 'x', Vouchers: [] } });
    await client.orders.search({ refId: 'ref-1' });
    expect(calls[0]?.body).toEqual({ RefID: 'ref-1' });
  });

  it('is the documented way to reconcile after an indeterminate order', async () => {
    const { client, calls } = testClient({
      status: 200,
      json: { OrderUID: 'uid-7', RefID: 'ref-9', Vouchers: [] },
    });
    const found = await client.orders.search({ refId: 'ref-9' });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v4/Search' });
    expect(found.orderUid).toBe('uid-7');
  });
});
