/**
 * Strict unpadded base64url decoder for Studio developer JWT segments.
 *
 * This module is private to the Node-only core-api Studio boundary and is not
 * re-exported from any package entrypoint.
 */

/** Decode a canonical RFC 4648 base64url string without padding. */
export function decodeBase64url(input: string): Uint8Array {
  const decoded = Buffer.from(input, 'base64url');
  if (decoded.toString('base64url') !== input) {
    throw new Error('base64url: non-canonical encoding');
  }
  return new Uint8Array(decoded);
}
