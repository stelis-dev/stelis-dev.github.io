import { fromBase64 } from '@mysten/sui/utils';

/** Decode one canonical little-endian BCS u64 and reject truncation or trailing bytes. */
export function decodeExactU64Bytes(bytes: Uint8Array): bigint {
  if (bytes.length !== 8) {
    throw new Error(`u64 BCS value must be exactly 8 bytes, got ${bytes.length}`);
  }

  let value = 0n;
  for (let index = 7; index >= 0; index--) {
    value = (value << 8n) | BigInt(bytes[index]!);
  }
  return value;
}

/** Decode a base64-encoded Transaction Pure input whose declared value is u64. */
export function decodeExactPureU64Base64(bytes: string): bigint {
  return decodeExactU64Bytes(fromBase64(bytes));
}
