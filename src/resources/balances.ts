import { Resource } from './base.js';

/** One currency balance on your B2B account. */
export interface Balance {
  /** ISO alpha-3 currency code. */
  currency: string | null;
  /** Available balance **in minor units** — `50000` is 500.00. */
  balance: number;
  /** Whether this is a master currency on the account. */
  master: boolean;
}

export interface ListBalancesResult {
  balances: Balance[];
}

interface WireBalanceItem {
  Currency?: string | null;
  Balance?: number;
  Master?: boolean;
}
interface WireBalanceResponse {
  Balances?: WireBalanceItem[] | null;
}

export class BalancesResource extends Resource {
  /**
   * Available balances on your B2B account, per currency.
   *
   * `GET /v4/Balance`
   *
   * Amounts are in **minor units**: `50000` means 500.00, not 50000.00.
   */
  async list(): Promise<ListBalancesResult> {
    const { data } = await this.client.send<WireBalanceResponse>('GET', '/v4/Balance', {
      retryable: true,
    });
    return {
      balances: (data?.Balances ?? []).map((b) => ({
        currency: b.Currency ?? null,
        balance: b.Balance ?? 0,
        master: b.Master ?? false,
      })),
    };
  }
}
