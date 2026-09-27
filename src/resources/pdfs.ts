import { inspect } from 'node:util';
import type { HuurayClient } from '../client.js';
import { HuurayTimeoutError } from '../errors.js';
import { sleep } from '../retry.js';
import { Resource, compact } from './base.js';

const PATH = '/v4/Pdf';

/** How long `getWhenReady()` keeps asking unless told otherwise: 10 minutes. */
const DEFAULT_MAX_WAIT_MS = 600_000;

/** The wait after a `202` that carries no usable `Retry-After`, in seconds. */
const DEFAULT_RETRY_AFTER_SECONDS = 30;

/**
 * The shortest wait between two attempts, in seconds, whatever `Retry-After`
 * says: a `0` would otherwise send signed requests back to back.
 */
const MIN_RETRY_AFTER_SECONDS = 1;

/**
 * The longest `maxWaitMs`: a timer holds a signed 32-bit delay, and no single
 * wait is ever longer than `maxWaitMs`.
 */
const MAX_WAIT_LIMIT_MS = 2_147_483_647;

export interface GetPdfParams {
  /**
   * The order's UID: `orderUid` from `orders.create()`, `orders.createSync()`
   * or `orders.search()`.
   */
  orderUid: string;
  /** One voucher of the order, a voucher `id`. Omit for every voucher on the order. */
  voucherId?: number;
  /**
   * A PDF template uid from `templates.list()` (`pdfTemplates`). Omit for the
   * PDF template the order's delivery email was sent with.
   */
  pdfTemplateUid?: string;
  /** `true` for one PDF holding every selected voucher, instead of one per voucher. */
  combine?: boolean;
}

export interface GetPdfWhenReadyParams extends GetPdfParams {
  /**
   * How long to keep asking, in milliseconds, from 0 to 2147483647. Default
   * `600000` (10 minutes).
   */
  maxWaitMs?: number;
}

/**
 * One gift card PDF.
 *
 * `content` is the gift card itself — the redeemable code, and depending on
 * the template the CVV and QR codes — so whoever holds it can redeem it. Never
 * log it, and keep it no longer than needed. `console.log()`,
 * `util.inspect()` and `JSON.stringify()` print it as `[N bytes]`, and
 * `redact()` removes it.
 */
export interface PdfDocument {
  /** The vouchers in the document: one, or every selected voucher when combined. */
  voucherIds: number[];
  /**
   * The PDF template the document was built from; `null` for a combined
   * document built from several templates.
   */
  pdfTemplateUid: string | null;
  /** A suggested file name, e.g. `giftcard-5123401.pdf`. */
  fileName: string | null;
  /** The document's content type, `application/pdf`. */
  contentType: string | null;
  /** The PDF, decoded from the base64 the API sends. */
  content: Uint8Array;
}

/** Result of a PDF request. */
export interface PdfResult {
  /**
   * `true` when the API answered `200` with the documents. `false` when it
   * answered `202`: the order is still being processed, or a supplier has not
   * delivered a code yet. Ask again after `retryAfter` seconds, or 30 when it
   * is `null`.
   */
  ready: boolean;
  orderUid: string | null;
  /** The PDFs: one per voucher, or one when combined. Empty when not `ready`. */
  documents: PdfDocument[];
  /**
   * Whole seconds from the `Retry-After` response header, or `null` when the
   * header is absent or not a number of seconds.
   */
  retryAfter: number | null;
}

/** What `getWhenReady()` tells the time and waits with. */
export interface PollClock {
  /** Milliseconds on a clock that only moves forward. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

const SYSTEM_CLOCK: PollClock = { now: () => performance.now(), sleep };

interface WirePdfDocument {
  VoucherIDs?: number[] | null;
  PDFTemplateUid?: string | null;
  FileName?: string | null;
  ContentType?: string | null;
  Content?: string | null;
}
interface WirePdfResponse {
  OrderUID?: string | null;
  Documents?: WirePdfDocument[] | null;
  Message?: string | null;
  StatusMessage?: string | null;
}

export class PdfsResource extends Resource {
  readonly #clock: PollClock;

  /** @param clock Replaced by the test suite, so polling is tested without waiting. */
  constructor(client: HuurayClient, clock: PollClock = SYSTEM_CLOCK) {
    super(client);
    this.#clock = clock;
  }

  /**
   * Fetches the gift card PDF of each voucher on an order, or of one voucher,
   * or one combined PDF.
   *
   * `POST /v4/Pdf`
   *
   * Check `ready`: a `202` means the order is still being processed, or a
   * supplier has not delivered a code yet, and is returned with `ready: false`
   * and no documents, not thrown. {@link getWhenReady} asks again until it is
   * ready. The token needs the Search permission, and the API supports only
   * orders with at most 3 receivers (a `422` otherwise).
   *
   * A read, despite being a POST: it never changes the order, and is retried
   * on connection failures and 5xx like the other reads.
   */
  async get(params: GetPdfParams): Promise<PdfResult> {
    return (await this.#send(params)).result;
  }

  /**
   * {@link get}, asked again for as long as the API answers `202`, waiting the
   * `Retry-After` seconds between attempts (30 when it sends none, and at least
   * 1).
   *
   * Throws {@link HuurayTimeoutError}, with the API's last status message, when
   * the next wait would pass `maxWaitMs`. Each attempt is a new signed
   * request; any other error is thrown as {@link get} throws it.
   */
  async getWhenReady(params: GetPdfWhenReadyParams): Promise<PdfResult> {
    const maxWaitMs = params.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > MAX_WAIT_LIMIT_MS) {
      throw new RangeError(
        `maxWaitMs must be a number of milliseconds from 0 to ${MAX_WAIT_LIMIT_MS}, ` +
          `received ${String(maxWaitMs)}.`,
      );
    }
    const deadline = this.#clock.now() + maxWaitMs;

    for (;;) {
      const { result, statusMessage } = await this.#send(params);
      if (result.ready) return result;

      const waitMs =
        Math.max(result.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS, MIN_RETRY_AFTER_SECONDS) * 1000;
      if (this.#clock.now() + waitMs > deadline) {
        const last = statusMessage ? `: ${statusMessage.replace(/\.?$/, '.')}` : '.';
        throw new HuurayTimeoutError(
          'POST',
          PATH,
          maxWaitMs,
          `The gift card PDF was not ready${last} Waiting another ${waitMs / 1000} seconds ` +
            'would pass maxWaitMs.',
        );
      }
      await this.#clock.sleep(waitMs);
    }
  }

  async #send(
    params: GetPdfParams,
  ): Promise<{ result: PdfResult; statusMessage: string | undefined }> {
    const { data, httpStatus, headers } = await this.client.send<WirePdfResponse>('POST', PATH, {
      body: compact({
        OrderUID: params.orderUid,
        // null is not given, as undefined is: the key is omitted, never sent as null.
        VoucherID: params.voucherId ?? undefined,
        PDFTemplateUid: params.pdfTemplateUid ?? undefined,
        Combine: params.combine ?? undefined,
      }),
      retryable: true,
      checkBody: unusableContent,
    });
    return {
      result: {
        ready: httpStatus === 200,
        orderUid: data?.OrderUID ?? null,
        // checkBody has vouched for every Content.
        documents: (data?.Documents ?? []).map(
          (d) => new PrintSafeDocument(d, decodeBase64(d.Content!)!),
        ),
        retryAfter: parseRetryAfter(headers.get('Retry-After')),
      },
      statusMessage: data?.StatusMessage ?? data?.Message ?? undefined,
    };
  }
}

/**
 * A document whose bytes print as their size in `console.log()`,
 * `util.inspect()` and `JSON.stringify()`.
 */
class PrintSafeDocument implements PdfDocument {
  voucherIds: number[];
  pdfTemplateUid: string | null;
  fileName: string | null;
  contentType: string | null;
  content: Uint8Array;

  constructor(wire: WirePdfDocument, content: Uint8Array) {
    this.voucherIds = wire.VoucherIDs ?? [];
    this.pdfTemplateUid = wire.PDFTemplateUid ?? null;
    this.fileName = wire.FileName ?? null;
    this.contentType = wire.ContentType ?? null;
    this.content = content;
  }

  toJSON(): Omit<PdfDocument, 'content'> & { content: string } {
    return {
      voucherIds: this.voucherIds,
      pdfTemplateUid: this.pdfTemplateUid,
      fileName: this.fileName,
      contentType: this.contentType,
      content: `[${this.content.byteLength} bytes]`,
    };
  }

  [inspect.custom](): Omit<PdfDocument, 'content'> & { content: string } {
    return this.toJSON();
  }
}

/**
 * Why a 2xx body's documents cannot be used, or `undefined` when they can.
 * Names the document and the length of its content, never the content.
 */
function unusableContent(data: unknown): string | undefined {
  const documents = (data as WirePdfResponse | null)?.Documents;
  if (documents == null) return undefined;
  if (!Array.isArray(documents)) return 'Documents was not a list';
  for (const [i, document] of documents.entries()) {
    const content = (document as WirePdfDocument | null)?.Content;
    if (typeof content !== 'string') return `Documents[${i}].Content was missing`;
    if (decodeBase64(content) === undefined) {
      return `Documents[${i}].Content was not valid base64 (${content.length} characters)`;
    }
  }
  return undefined;
}

/**
 * Standard base64 to bytes, or `undefined` when `s` is not standard base64.
 * Node's own decoder is lenient: it skips or stops at a character it does not
 * know, reads some non-ASCII characters as their low byte, and accepts the
 * base64url alphabet.
 */
function decodeBase64(s: string): Uint8Array | undefined {
  if (s.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(s)) return undefined;
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  // A plain Uint8Array of its own, not a Buffer that may share Node's pool.
  const bytes = new Uint8Array((s.length / 4) * 3 - padding);
  // An "=" anywhere but the last two places ends or skips part of the input,
  // so fewer bytes come out than the length promises.
  const written = Buffer.from(bytes.buffer).write(s, 'base64');
  return written === bytes.length ? bytes : undefined;
}

/** Whole seconds from a `Retry-After` header, or `null`. An HTTP date is not read. */
function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) ? seconds : null;
}
