import { Resource, compact, toDateTime } from './base.js';
import {
  HuurayConnectionError,
  HuurayIndeterminateOrderError,
  HuurayServerError,
} from '../errors.js';

/** The maximum `quantity` a synchronous order may request, per the API. */
export const SYNC_QUANTITY_LIMIT = 25;

export interface Recipient {
  name?: string;
  /** Required when delivering by email. */
  email?: string;
  /** Required when delivering by SMS. */
  phone?: string;
  /** Your own identifier for this recipient. */
  refId?: string;
}

export interface Voucher {
  /** Voucher identifier, used by `resend()` and `cancel()`. */
  id: number | null;
  /**
   * The redeemable code.
   *
   * **Blank unless `ReturnCode` is enabled on your B2B account.** If you need
   * codes returned to your system rather than delivered by Huuray, ask your
   * Huuray contact to enable it.
   */
  code: string | null;
  cvv: string | null;
  redeemLink: string | null;
  expires: string | null;
  recipient: Recipient | null;
}

interface WireRecipient {
  Name?: string | null;
  Email?: string | null;
  Phone?: string | null;
  RefID?: string | null;
}
interface WireVoucher {
  ID?: number | null;
  Code?: string | null;
  CVV?: string | null;
  RedeemLink?: string | null;
  Expires?: string | null;
  Recipient?: WireRecipient | null;
}
interface WireOrderResponse {
  OrderUID?: string | null;
  RefID?: string | null;
  Vouchers?: WireVoucher[] | null;
}

function mapRecipient(r: WireRecipient | null | undefined): Recipient | null {
  if (!r) return null;
  return compact({
    name: r.Name ?? undefined,
    email: r.Email ?? undefined,
    phone: r.Phone ?? undefined,
    refId: r.RefID ?? undefined,
  }) as Recipient;
}

function mapVoucher(v: WireVoucher): Voucher {
  return {
    id: v.ID ?? null,
    code: v.Code ?? null,
    cvv: v.CVV ?? null,
    redeemLink: v.RedeemLink ?? null,
    expires: v.Expires ?? null,
    recipient: mapRecipient(v.Recipient),
  };
}

function toWireRecipient(r: Recipient): WireRecipient {
  return compact({
    Name: r.name,
    Email: r.email,
    Phone: r.phone,
    RefID: r.refId,
  }) as WireRecipient;
}

/* ------------------------------------------------------------------ orders */

interface OrderParamsBase {
  /** Product identifier from `catalogue.list()`. */
  productToken: string;
  /** Denomination **in minor units** — 50.00 is `5000`. Must be an integer. */
  value: number;
  /** ISO alpha-3 currency code. */
  currency: string;
  /** How many codes to order. */
  quantity: number;
  /** Optional expiry for the gift cards. Cannot exceed the product default. */
  expires?: Date | string;
  /** Your own identifier for this order. Strongly recommended — see below. */
  refId?: string;
  /** Delivery template id from `templates.list()`. Omit for no delivery. */
  templateId?: number;
  /** Schedule delivery for a future time. Omit to deliver as soon as possible. */
  deliveryDatetime?: Date | string;
  /** A message included in every email or SMS sent for this order. */
  personalMessage?: string;
  /**
   * Recipients. Required when `templateId` is set. The count must be either 1
   * or exactly `quantity`.
   */
  recipients?: Recipient[];
}

export type CreateOrderParams = OrderParamsBase;
export type CreateSyncOrderParams = OrderParamsBase;

/** Result of an asynchronous order. No voucher data is returned. */
export interface CreateOrderResult {
  orderUid: string | null;
  refId: string | null;
}

/** Result of a synchronous order. Vouchers are returned inline. */
export interface CreateSyncOrderResult extends CreateOrderResult {
  vouchers: Voucher[];
}

export interface SendRewardParams {
  productToken: string;
  /** Denomination **in minor units** — 50.00 is `5000`. */
  value: number;
  currency: string;
  recipient: Recipient;
  /** Delivery template id from `templates.list()`. */
  templateId: number;
  /**
   * Your reconciliation key. **Required by this SDK**, though the API treats it
   * as optional: without it, an order that times out cannot be looked up, and
   * you cannot safely determine whether it landed.
   */
  refId: string;
  expires?: Date | string;
  deliveryDatetime?: Date | string;
  personalMessage?: string;
}

/* ------------------------------------------------------------------ search */

export interface SearchOrdersParams {
  orderUid?: string;
  /** Required for the response to include the voucher code. */
  voucherId?: number;
  productToken?: string;
  /** Your own order reference. */
  refId?: string;
  smsTemplateId?: number;
  emailTemplateId?: number;
  deliveryDatetime?: Date | string;
  recipientName?: string;
  recipientEmail?: string;
  recipientPhone?: string;
  recipientRefId?: string;
}

export interface SearchOrdersResult {
  orderUid: string | null;
  refId: string | null;
  vouchers: Voucher[];
}

/* --------------------------------------------------------- resend / cancel */

export interface ResendParams {
  orderUid: string;
  /** A single voucher. Omit to resend the whole order to all its recipients. */
  voucherId?: number;
}

export interface ResendResult {
  numberOfResends: number | null;
  /**
   * `true` when the API answered `206 Partial Content` — some resends
   * succeeded and some did not. Treating this as plain success is a common bug.
   */
  partial: boolean;
}

export interface CancelParams {
  orderUid: string;
  /** A single voucher. Omit to attempt cancelling the whole order. */
  voucherId?: number;
}

export interface CancelledVoucher {
  id: number;
  cancelled: boolean;
}

export interface CancelResult {
  orderUid: string | null;
  orderCancelled: boolean;
  vouchers: CancelledVoucher[];
  /**
   * `true` when the API answered `206 Partial Content` — inspect `vouchers` to
   * see which ones were not cancelled.
   */
  partial: boolean;
}

/* ---------------------------------------------------------------- resource */

export class OrdersResource extends Resource {
  /**
   * Places an order and returns immediately.
   *
   * `POST /v4/Order` with `Sync: false`
   *
   * Huuray delivers the gift cards using the template you name; no voucher data
   * comes back. Use `search()` with your `refId` to find the order later.
   *
   * **Not retried on failure.** The endpoint has no idempotency key, so a retry
   * can order twice. A timeout or server error throws
   * {@link HuurayIndeterminateOrderError} instead.
   */
  async create(params: CreateOrderParams): Promise<CreateOrderResult> {
    const body = this.#buildOrderBody(params, false);
    const data = await this.#postOrder(body, params.refId);
    return { orderUid: data?.OrderUID ?? null, refId: data?.RefID ?? null };
  }

  /**
   * Places an order and waits for the vouchers.
   *
   * `POST /v4/Order` with `Sync: true`
   *
   * `quantity` is limited to {@link SYNC_QUANTITY_LIMIT} for synchronous orders.
   * Voucher codes are blank unless `ReturnCode` is enabled on your account.
   *
   * **Not retried on failure**, same as {@link create}.
   */
  async createSync(params: CreateSyncOrderParams): Promise<CreateSyncOrderResult> {
    if (params.quantity > SYNC_QUANTITY_LIMIT) {
      throw new RangeError(
        `Synchronous orders are limited to ${SYNC_QUANTITY_LIMIT} codes; received ${params.quantity}. ` +
          'Use orders.create() for larger orders.',
      );
    }
    const body = this.#buildOrderBody(params, true);
    const data = await this.#postOrder(body, params.refId);
    return {
      orderUid: data?.OrderUID ?? null,
      refId: data?.RefID ?? null,
      vouchers: (data?.Vouchers ?? []).map(mapVoucher),
    };
  }

  /**
   * Sends one gift card to one recipient — the common case in a single call.
   *
   * Performs exactly one `POST /v4/Order` with `Sync: false` and `Quantity: 1`.
   */
  async sendReward(params: SendRewardParams): Promise<CreateOrderResult> {
    if (!params.refId) {
      throw new TypeError(
        'refId is required by sendReward(). It is the only way to determine whether an ' +
          'order landed if the request times out, because /v4/Order has no idempotency key. ' +
          'Use a stable key from your own system, e.g. "payroll-2026-08-jane".',
      );
    }
    return this.create({
      productToken: params.productToken,
      value: params.value,
      currency: params.currency,
      quantity: 1,
      refId: params.refId,
      templateId: params.templateId,
      recipients: [params.recipient],
      ...compact({
        expires: params.expires,
        deliveryDatetime: params.deliveryDatetime,
        personalMessage: params.personalMessage,
      }),
    });
  }

  /**
   * Searches gift cards from previous orders.
   *
   * `POST /v4/Search`
   *
   * Also the way to resolve an order whose outcome is unknown: search by the
   * `refId` you sent. A read, despite being a POST.
   */
  async search(params: SearchOrdersParams = {}): Promise<SearchOrdersResult> {
    const { data } = await this.client.send<WireOrderResponse>('POST', '/v4/Search', {
      body: compact({
        OrderUID: params.orderUid,
        VoucherID: params.voucherId,
        ProductToken: params.productToken,
        RefID: params.refId,
        SMSTemplateID: params.smsTemplateId,
        EmailTemplateID: params.emailTemplateId,
        DeliveryDatetime: toDateTime(params.deliveryDatetime),
        RecipientName: params.recipientName,
        RecipientEmail: params.recipientEmail,
        RecipientPhone: params.recipientPhone,
        RecipientRefID: params.recipientRefId,
      }),
      retryable: true,
    });
    return {
      orderUid: data?.OrderUID ?? null,
      refId: data?.RefID ?? null,
      vouchers: (data?.Vouchers ?? []).map(mapVoucher),
    };
  }

  /**
   * Resends an order, or one voucher from it, to its original recipients.
   *
   * `POST /v4/Resend`
   *
   * **Never retried.** A resend delivers a live gift card, so repeating it on a
   * timeout would re-send real value.
   */
  async resend(params: ResendParams): Promise<ResendResult> {
    const { data, httpStatus } = await this.client.send<{ NumberOfResends?: number | null }>(
      'POST',
      '/v4/Resend',
      { body: compact({ OrderUID: params.orderUid, VoucherID: params.voucherId }) },
    );
    return {
      numberOfResends: data?.NumberOfResends ?? null,
      partial: httpStatus === 206,
    };
  }

  /**
   * Cancels an order, or one voucher from it.
   *
   * `DELETE /v4/Cancel`
   *
   * Check `partial`: the API answers `206` when only some vouchers could be
   * cancelled, and the per-voucher outcome is in `vouchers`.
   */
  async cancel(params: CancelParams): Promise<CancelResult> {
    const { data, httpStatus } = await this.client.send<{
      OrderUID?: string | null;
      OrderCancelled?: boolean;
      Vouchers?: { ID?: number; Cancelled?: boolean }[] | null;
    }>('DELETE', '/v4/Cancel', {
      body: compact({ OrderUID: params.orderUid, VoucherID: params.voucherId }),
    });
    return {
      orderUid: data?.OrderUID ?? null,
      orderCancelled: data?.OrderCancelled ?? false,
      vouchers: (data?.Vouchers ?? []).map((v) => ({
        id: v.ID ?? 0,
        cancelled: v.Cancelled ?? false,
      })),
      partial: httpStatus === 206,
    };
  }

  /* ---------------------------------------------------------------- private */

  #buildOrderBody(params: OrderParamsBase, sync: boolean): Record<string, unknown> {
    if (!Number.isInteger(params.value)) {
      throw new TypeError(
        `value must be an integer in minor units (50.00 is 5000), received ${params.value}. ` +
          'A fractional value always means major units were passed by mistake — which would ' +
          'order 1/100th of the intended amount. Note this guard cannot catch every mixup: ' +
          'in JavaScript 50.00 IS the integer 50, and orders 0.50.',
      );
    }
    if (!Number.isInteger(params.quantity) || params.quantity < 1) {
      throw new TypeError(`quantity must be a positive integer, received ${params.quantity}.`);
    }
    if (params.templateId !== undefined) {
      const n = params.recipients?.length ?? 0;
      if (n === 0) {
        throw new TypeError(
          'recipients is required when templateId is set — the template needs somewhere to deliver to.',
        );
      }
      if (n !== 1 && n !== params.quantity) {
        throw new TypeError(
          `recipients must contain either 1 entry or exactly quantity (${params.quantity}); received ${n}.`,
        );
      }
    }

    return compact({
      Product: compact({
        Token: params.productToken,
        Value: params.value,
        Currency: params.currency,
        Quantity: params.quantity,
        Expires: toDateTime(params.expires),
      }),
      Sync: sync,
      RefID: params.refId,
      DeliveryTemplateId: params.templateId,
      DeliveryDatetime: toDateTime(params.deliveryDatetime),
      PersonalMessage: params.personalMessage,
      Recipients: params.recipients?.map(toWireRecipient),
    });
  }

  async #postOrder(
    body: Record<string, unknown>,
    refId: string | undefined,
  ): Promise<WireOrderResponse | undefined> {
    try {
      const { data } = await this.client.send<WireOrderResponse>('POST', '/v4/Order', {
        body,
        retryable: false,
      });
      return data;
    } catch (cause) {
      // The request may have been processed. Never retry; make the caller reconcile.
      if (cause instanceof HuurayConnectionError || cause instanceof HuurayServerError) {
        throw new HuurayIndeterminateOrderError(refId, { cause });
      }
      throw cause;
    }
  }
}
