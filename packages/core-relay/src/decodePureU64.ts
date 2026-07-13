import { fromBase64 } from '@mysten/sui/utils';

/** Decode one canonical BCS u64 value and reject both truncation and trailing bytes. */
export function decodeExactPureU64Bytes(bytes: Uint8Array): bigint {
  if (bytes.length !== 8) {
    throw new Error(`Pure u64 must be exactly 8 bytes, got ${bytes.length}`);
  }

  let value = 0n;
  for (let index = 7; index >= 0; index--) {
    value = (value << 8n) | BigInt(bytes[index]!);
  }
  return value;
}

export function decodeExactPureU64Base64(bytes: string): bigint {
  return decodeExactPureU64Bytes(fromBase64(bytes));
}
