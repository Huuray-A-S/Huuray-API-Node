import { Resource } from './base.js';

export interface GetExchangeRateParams {
  /** Source currency, ISO alpha-3. */
  from: string;
  /** Target currency, ISO alpha-3. */
  to: string;
}

export interface ExchangeRateResult {
  exchangeRate: number | null;
  /** Spread in percent. */
  spread: number | null;
}

interface WireExchangeRatesResponse {
  ExchangeRate?: number | null;
  Spread?: number | null;
}

export class ExchangeRatesResource extends Resource {
  /**
   * Current exchange rate and spread between two currencies.
   *
   * `GET /v4/ExchangeRates`
   */
  async get(params: GetExchangeRateParams): Promise<ExchangeRateResult> {
    const { data } = await this.client.send<WireExchangeRatesResponse>(
      'GET',
      '/v4/ExchangeRates',
      {
        query: { FromCurrency: params.from, ToCurrency: params.to },
        retryable: true,
      },
    );
    return {
      exchangeRate: data?.ExchangeRate ?? null,
      spread: data?.Spread ?? null,
    };
  }
}
