import { Resource, compact } from './base.js';

export interface CheckStockParams {
  /** The product to check. Get this from `catalogue.list()`. */
  productToken: string;
  /**
   * The denomination to check, **in minor units**. Omit to use the product's
   * default price.
   */
  value?: number;
}

export interface CheckStockResult {
  /** Number of gift cards available, or `null` if the API did not report one. */
  stock: number | null;
}

interface WireStockResponse {
  Stock?: number | null;
}

export class StockResource extends Resource {
  /**
   * Current stock for a product.
   *
   * `POST /v4/Stock`
   *
   * A read, despite being a POST.
   */
  async check(params: CheckStockParams): Promise<CheckStockResult> {
    if (params.value !== undefined && !Number.isInteger(params.value)) {
      throw new TypeError(
        `value must be an integer in minor units (5.00 is 500), received ${params.value}.`,
      );
    }
    const { data } = await this.client.send<WireStockResponse>('POST', '/v4/Stock', {
      body: compact({ ProductToken: params.productToken, Value: params.value }),
      retryable: true,
    });
    return { stock: data?.Stock ?? null };
  }
}
