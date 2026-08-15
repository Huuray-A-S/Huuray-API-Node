import { describe, expect, it } from 'vitest';
import { testClient } from './helpers.js';

describe('balances.list', () => {
  it('maps balance rows and keeps amounts in minor units', async () => {
    const { client, calls } = testClient({
      status: 200,
      json: {
        Balances: [
          { Currency: 'DKK', Balance: 50_000, Master: true },
          { Currency: 'EUR', Balance: 1234, Master: false },
        ],
      },
    });
    const { balances } = await client.balances.list();

    expect(calls[0]).toMatchObject({ method: 'GET', path: '/v4/Balance' });
    expect(calls[0]?.bodyOmitted).toBe(true);
    expect(balances).toEqual([
      { currency: 'DKK', balance: 50_000, master: true },
      { currency: 'EUR', balance: 1234, master: false },
    ]);
  });

  it('returns an empty list when the API sends null', async () => {
    const { client } = testClient({ status: 200, json: { Balances: null } });
    await expect(client.balances.list()).resolves.toEqual({ balances: [] });
  });
});

describe('catalogue.list', () => {
  it('defaults All to false — your products, with tokens and discount', async () => {
    const { client, calls } = testClient({ status: 200, json: { Products: [] } });
    await client.catalogue.list();
    expect(calls[0]?.body).toEqual({ All: false });
  });

  it('passes All through when requesting the whole catalogue', async () => {
    const { client, calls } = testClient({ status: 200, json: { Products: [] } });
    await client.catalogue.list({ all: true });
    expect(calls[0]?.body).toEqual({ All: true });
  });

  it('maps product fields', async () => {
    const { client } = testClient({
      status: 200,
      json: {
        Products: [
          {
            ProductToken: 'tok',
            BrandName: 'Example',
            CountryCode: 'DK',
            Discount: 4.5,
            Currency: 'DKK',
            Active: true,
          },
        ],
      },
    });
    const { products } = await client.catalogue.list();
    expect(products[0]).toMatchObject({
      productToken: 'tok',
      brandName: 'Example',
      countryCode: 'DK',
      discount: 4.5,
      currency: 'DKK',
      active: true,
    });
  });
});

describe('templates.list', () => {
  it('sends no request body, because the spec declares none', async () => {
    const { client, calls } = testClient({ status: 200, json: { Templates: [] } });
    await client.templates.list();
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v4/Template' });
    expect(calls[0]?.bodyOmitted).toBe(true);
  });

  it('maps template fields', async () => {
    const { client } = testClient({
      status: 200,
      json: { Templates: [{ Id: 42, Name: 'Default', Type: 'Email', Language: 'da' }] },
    });
    const { templates } = await client.templates.list();
    expect(templates[0]).toMatchObject({ id: 42, name: 'Default', type: 'Email', language: 'da' });
  });
});

describe('stock.check', () => {
  it('omits Value when not supplied', async () => {
    const { client, calls } = testClient({ status: 200, json: { Stock: 10 } });
    await client.stock.check({ productToken: 'tok' });
    expect(calls[0]?.body).toEqual({ ProductToken: 'tok' });
  });

  it('rejects a non-integer value before sending anything', async () => {
    const { client, calls } = testClient();
    await expect(client.stock.check({ productToken: 'tok', value: 50.5 })).rejects.toThrow(
      /integer in minor units/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('exchangeRates.get', () => {
  it('sends the currencies as query parameters', async () => {
    const { client, calls } = testClient({ status: 200, json: { ExchangeRate: 7.46, Spread: 2 } });
    const rate = await client.exchangeRates.get({ from: 'EUR', to: 'DKK' });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/v4/ExchangeRates' });
    expect(calls[0]?.query).toEqual({ FromCurrency: 'EUR', ToCurrency: 'DKK' });
    expect(rate).toEqual({ exchangeRate: 7.46, spread: 2 });
  });
});
