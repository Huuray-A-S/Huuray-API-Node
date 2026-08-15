import { createHash, randomBytes } from 'node:crypto';

/**
 * Every v4 request carries three headers:
 *
 *   X-API-TOKEN   your API token
 *   X-API-NONCE   a random value, single-use within 60 days, max 50 characters
 *   X-API-HASH    SHA-512 of ( API-SECRET + NONCE )
 *
 * The spec states the construction but not the encoding of the digest, so the
 * encoding is configurable and its default is documented below.
 */

/** How the SHA-512 digest is encoded into the `X-API-HASH` header. */
export type HashEncoding = 'hex' | 'hex-upper' | 'base64' | 'base64url';

/**
 * Default digest encoding: lowercase hex.
 *
 * The v4 spec describes `X-API-HASH` as "the SHA512 hash of a concatenated
 * string containing ( API-SECRET + NONCE )" without stating an encoding.
 * Lowercase hex is the overwhelmingly common convention for this style of
 * header and is what this client sends unless you override it.
 *
 * If you get a 401 with credentials you know are correct, the encoding is the
 * first thing to try: pass `hashEncoding` to the client.
 */
export const DEFAULT_HASH_ENCODING: HashEncoding = 'hex';

/**
 * The spec's stated maximum length of `X-API-NONCE`. Exceeding it is rejected
 * by the API, and a too-long nonce is an easy mistake — 32 random bytes encoded
 * as hex is 64 characters, silently over the limit.
 */
export const NONCE_MAX_LENGTH = 50;

/** Bytes of entropy per generated nonce. 24 bytes -> 32 base64url characters. */
const NONCE_BYTES = 24;

/**
 * Generates a nonce: 24 crypto-random bytes as base64url, 32 characters.
 *
 * The API stores nonces for 60 days and rejects a repeat, so the only thing
 * that matters is that values never collide. 192 bits of entropy makes that
 * negligible at any realistic volume, and 32 characters leaves headroom under
 * the 50-character cap.
 *
 * Avoid timestamps: at second resolution they collide under concurrency, and
 * the resulting 401s are intermittent and hard to trace.
 */
export function generateNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64url');
}

function encodeDigest(digest: Buffer, encoding: HashEncoding): string {
  switch (encoding) {
    case 'hex':
      return digest.toString('hex');
    case 'hex-upper':
      return digest.toString('hex').toUpperCase();
    case 'base64':
      return digest.toString('base64');
    case 'base64url':
      return digest.toString('base64url');
  }
}

/**
 * Computes the `X-API-HASH` value for a given secret and nonce.
 *
 * @param apiSecret Your API secret. Never logged by this library.
 * @param nonce     The same nonce sent in `X-API-NONCE`.
 */
export function signRequest(
  apiSecret: string,
  nonce: string,
  encoding: HashEncoding = DEFAULT_HASH_ENCODING,
): string {
  const digest = createHash('sha512').update(apiSecret + nonce, 'utf8').digest();
  return encodeDigest(digest, encoding);
}

/** The three auth headers for one request, built from a freshly generated nonce. */
export function buildAuthHeaders(opts: {
  apiToken: string;
  apiSecret: string;
  nonce: string;
  hashEncoding?: HashEncoding;
}): Record<string, string> {
  if (opts.nonce.length > NONCE_MAX_LENGTH) {
    throw new RangeError(
      `Nonce is ${opts.nonce.length} characters; the Huuray API accepts at most ${NONCE_MAX_LENGTH}. ` +
        'If you supplied a custom nonceFactory, shorten its output.',
    );
  }
  return {
    'X-API-TOKEN': opts.apiToken,
    'X-API-NONCE': opts.nonce,
    'X-API-HASH': signRequest(opts.apiSecret, opts.nonce, opts.hashEncoding ?? DEFAULT_HASH_ENCODING),
  };
}
