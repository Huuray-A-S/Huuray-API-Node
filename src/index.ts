/**
 * Official Node.js and TypeScript client for the Huuray API v4.
 *
 * ```ts
 * import { HuurayClient } from 'huuray';
 *
 * const huuray = new HuurayClient({
 *   apiToken:  process.env.HUURAY_API_TOKEN!,
 *   apiSecret: process.env.HUURAY_API_SECRET!,
 * });
 *
 * const { balances } = await huuray.balances.list();
 * ```
 *
 * Every method maps onto a single documented v4 operation. Request and response
 * field names match the Huuray API reference exactly, differing only in casing.
 */

export { HuurayClient, DEFAULT_BASE_URL } from './client.js';
export type { HuurayClientOptions, RawResponse, SendOptions } from './client.js';

export {
  generateNonce,
  signRequest,
  buildAuthHeaders,
  DEFAULT_HASH_ENCODING,
  NONCE_MAX_LENGTH,
} from './auth.js';
export type { HashEncoding } from './auth.js';

export {
  HuurayError,
  HuurayConfigError,
  HuurayConnectionError,
  HuurayTimeoutError,
  HuurayApiError,
  HuurayAuthError,
  HuurayNotFoundError,
  HuurayValidationError,
  HuurayServerError,
  HuurayIndeterminateOrderError,
} from './errors.js';

export { redact, safeStringify } from './redact.js';
export type { RetryOptions } from './retry.js';

export type { Balance, ListBalancesResult } from './resources/balances.js';
export type {
  CatalogueProduct,
  ListCatalogueParams,
  ListCatalogueResult,
} from './resources/catalogue.js';
export type { Template, ListTemplatesResult } from './resources/templates.js';
export type { CheckStockParams, CheckStockResult } from './resources/stock.js';
export type {
  GetExchangeRateParams,
  ExchangeRateResult,
} from './resources/exchange-rates.js';
export { SYNC_QUANTITY_LIMIT } from './resources/orders.js';
export type {
  Recipient,
  Voucher,
  CreateOrderParams,
  CreateOrderResult,
  CreateSyncOrderParams,
  CreateSyncOrderResult,
  SendRewardParams,
  SearchOrdersParams,
  SearchOrdersResult,
  ResendParams,
  ResendResult,
  CancelParams,
  CancelResult,
  CancelledVoucher,
} from './resources/orders.js';
