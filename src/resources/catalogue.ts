import { Resource } from './base.js';

/** A product in the Huuray catalogue. */
export interface CatalogueProduct {
  /**
   * Unique product identifier, used when ordering.
   *
   * Only present when `all` is `false`. Requesting the entire catalogue omits
   * tokens, because they describe your account's access, not the public list.
   */
  productToken: string | null;
  brandName: string | null;
  country: string | null;
  /** ISO alpha-2 country code. */
  countryCode: string | null;
  /** Your discount on this product, in percent. Only present when `all` is `false`. */
  discount: number | null;
  /** Available denominations, comma-separated, as returned by the API. */
  denominations: string | null;
  /** ISO alpha-3 currency code. */
  currency: string | null;
  /** Either real-time generated or drawn from stock. */
  realTimeStock: string | null;
  /** Categories, comma-separated, as returned by the API. */
  categories: string | null;
  /** ISO alpha-2 language code. */
  languageCode: string | null;
  active: boolean;
  brandDescription: string | null;
  redemptionInstructions: string | null;
  logoFile: string | null;
}

export interface ListCatalogueParams {
  /**
   * `false` (default) — only products your account can order, including your
   * discount and each `productToken`.
   *
   * `true` — the entire Huuray catalogue, without tokens or discounts.
   */
  all?: boolean;
}

export interface ListCatalogueResult {
  products: CatalogueProduct[];
}

interface WireProduct {
  ProductToken?: string | null;
  BrandName?: string | null;
  Country?: string | null;
  CountryCode?: string | null;
  Discount?: number | null;
  Denominations?: string | null;
  Currency?: string | null;
  RealTimeStock?: string | null;
  Categories?: string | null;
  LanguageCode?: string | null;
  Active?: boolean;
  BrandDescription?: string | null;
  RedemptionInstructions?: string | null;
  LogoFile?: string | null;
}
interface WireCatalogueResponse {
  Products?: WireProduct[] | null;
}

export class CatalogueResource extends Resource {
  /**
   * Lists available products.
   *
   * `POST /v4/Catalogue`
   *
   * A read, despite being a POST — it takes a request body but changes nothing.
   */
  async list(params: ListCatalogueParams = {}): Promise<ListCatalogueResult> {
    const { data } = await this.client.send<WireCatalogueResponse>('POST', '/v4/Catalogue', {
      body: { All: params.all ?? false },
      retryable: true,
    });
    return {
      products: (data?.Products ?? []).map((p) => ({
        productToken: p.ProductToken ?? null,
        brandName: p.BrandName ?? null,
        country: p.Country ?? null,
        countryCode: p.CountryCode ?? null,
        discount: p.Discount ?? null,
        denominations: p.Denominations ?? null,
        currency: p.Currency ?? null,
        realTimeStock: p.RealTimeStock ?? null,
        categories: p.Categories ?? null,
        languageCode: p.LanguageCode ?? null,
        active: p.Active ?? false,
        brandDescription: p.BrandDescription ?? null,
        redemptionInstructions: p.RedemptionInstructions ?? null,
        logoFile: p.LogoFile ?? null,
      })),
    };
  }
}
