import { describe, expect, it } from 'vitest';
import type { TestSwapPair } from '../src/pages/sandbox/testSwapPairs';
import {
  calculateMinOutputSmallest,
  decodeLittleEndianU64,
  directSwapQuantityOutSpec,
} from '../src/pages/sandbox/deepbookDirectSwap';

const BASE_TYPE = '0x1::base::BASE';
const QUOTE_TYPE = '0x2::quote::QUOTE';

function makePair(swapDirection: TestSwapPair['swapDirection']): TestSwapPair {
  return {
    settlementTokenType: BASE_TYPE,
    label: 'BASE',
    poolId: '0x123',
    baseType: BASE_TYPE,
    quoteType: QUOTE_TYPE,
    swapDirection,
  };
}

function u64le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

describe('direct DeepBook swap quote helpers', () => {
  it('selects quote output for exact base-for-quote swaps', () => {
    expect(directSwapQuantityOutSpec(makePair('swap_exact_base_for_quote'))).toEqual({
      moveFunction: 'get_quote_quantity_out_input_fee',
      outputIndex: 1,
    });
  });

  it('selects base output for exact quote-for-base swaps', () => {
    expect(directSwapQuantityOutSpec(makePair('swap_exact_quote_for_base'))).toEqual({
      moveFunction: 'get_base_quantity_out_input_fee',
      outputIndex: 0,
    });
  });

  it('decodes little-endian u64 values exactly', () => {
    expect(decodeLittleEndianU64(u64le(0n))).toBe(0n);
    expect(decodeLittleEndianU64(u64le(37_000_000n))).toBe(37_000_000n);
    expect(decodeLittleEndianU64(u64le(18_446_744_073_709_551_615n))).toBe(
      18_446_744_073_709_551_615n,
    );
  });

  it('rejects malformed u64 byte lengths', () => {
    expect(() => decodeLittleEndianU64(new Uint8Array(7))).toThrow('8 bytes');
  });

  it('calculates positive minimum output with integer slippage', () => {
    expect(calculateMinOutputSmallest(10_000_000n, 200)).toBe(9_800_000n);
  });

  it('rejects zero-output and dust quotes that cannot produce a positive minimum', () => {
    expect(() => calculateMinOutputSmallest(0n, 200)).toThrow('no settlement token output');
    expect(() => calculateMinOutputSmallest(1n, 200)).toThrow('positive minimum output');
  });

  it('rejects invalid slippage bounds', () => {
    expect(() => calculateMinOutputSmallest(100n, -1)).toThrow('slippage');
    expect(() => calculateMinOutputSmallest(100n, 10_000)).toThrow('slippage');
  });
});
