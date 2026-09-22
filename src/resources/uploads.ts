import { Resource } from './base.js';
import { HuurayConnectionError, HuurayTimeoutError } from '../errors.js';

/**
 * What a Blob keeps as its type: anything outside U+0020 to U+007E makes it
 * silently drop the whole value, and the part would go out as
 * `application/octet-stream` instead.
 */
const SENDABLE_CONTENT_TYPE = /^[\x20-\x7E]*$/;

/** Appended to a timeout or connection error from an upload. */
const MAY_BE_STORED =
  "The upload may still have been stored, and may hold one of the account's pending upload " +
  'slots until it is used or cleaned up. It was not retried.';

export interface CreateUploadParams {
  /** The file's contents. A `Buffer` is a `Uint8Array`. */
  file: Uint8Array | ArrayBuffer | Blob;
  /** The file name, e.g. `purchase-order-4711.pdf`, sent as the part's file name. */
  fileName: string;
  /**
   * The file's content type, e.g. `application/pdf`. When omitted the part is
   * sent as `application/octet-stream`. A `Blob`'s own `type` is not used.
   */
  contentType?: string;
}

/** Result of an upload. Pass `token` to an order as `purchaseOrderFileToken`. */
export interface UploadResult {
  /** Identifies the uploaded file. Consumed by the order it is used with. */
  token: string | null;
  /** The file name the upload was stored with. */
  fileName: string | null;
  /** The content type the file was recognized as. */
  contentType: string | null;
  /** The size of the uploaded file in bytes. */
  size: number | null;
}

interface WireUploadResponse {
  Token?: string | null;
  FileName?: string | null;
  ContentType?: string | null;
  Size?: number | null;
}

export class UploadsResource extends Resource {
  /**
   * Uploads a purchase order file, to attach to an order by its token.
   *
   * `POST /v4/Upload` — `multipart/form-data`, one part named `File`
   *
   * Pass the returned `token` as `purchaseOrderFileToken` to `orders.create()`,
   * `orders.createSync()` or `sendReward()`. The token is consumed by the order
   * it is used with.
   *
   * **Never retried.** Every upload stores a new file that counts as pending
   * until an order uses it, and no endpoint looks an upload up. A timeout or
   * dropped connection throws the ordinary {@link HuurayTimeoutError} or
   * {@link HuurayConnectionError}, whose message says the upload may still have
   * been stored.
   */
  async create(params: CreateUploadParams): Promise<UploadResult> {
    const { file, fileName, contentType } = params;
    // Checked because a mistake here is sent, not refused: a string path would
    // be uploaded as the file's contents, and a missing name as "blob".
    if (!(file instanceof Uint8Array || file instanceof ArrayBuffer || file instanceof Blob)) {
      throw new TypeError(
        'file must be the file contents: a Uint8Array (or Buffer), ArrayBuffer or Blob.',
      );
    }
    if (typeof fileName !== 'string') {
      throw new TypeError('fileName is required: the name to upload the file with.');
    }
    if (
      contentType != null &&
      (typeof contentType !== 'string' || !SENDABLE_CONTENT_TYPE.test(contentType))
    ) {
      throw new TypeError(
        'contentType must be visible ASCII, such as "application/pdf"; a control or non-ASCII ' +
          "character cannot be sent as the part's Content-Type.",
      );
    }

    const form = new FormData();
    const type = contentType ?? 'application/octet-stream';
    form.append('File', new Blob([file], { type }), fileName);

    let data: WireUploadResponse | undefined;
    try {
      ({ data } = await this.client.send<WireUploadResponse>('POST', '/v4/Upload', {
        form,
        retryable: false,
      }));
    } catch (cause) {
      throw withUploadNote(cause);
    }
    return {
      token: data?.Token ?? null,
      fileName: data?.FileName ?? null,
      contentType: data?.ContentType ?? null,
      size: data?.Size ?? null,
    };
  }
}

/** The same error, of the same class, with {@link MAY_BE_STORED} added to its message. */
function withUploadNote(error: unknown): unknown {
  if (error instanceof HuurayTimeoutError) {
    return new HuurayTimeoutError(error.method, error.path, error.timeoutMs, MAY_BE_STORED);
  }
  if (error instanceof HuurayConnectionError) {
    return new HuurayConnectionError(
      `${error.message.replace(/\.?$/, '.')} ${MAY_BE_STORED}`,
      error.method,
      error.path,
      'cause' in error ? { cause: error.cause } : undefined,
    );
  }
  return error;
}
