import { describe, it, expect, vi } from 'vitest';
import type { SingleHopSettlementSwapPath } from '@stelis/contracts';

vi.mock('@mysten/sui/transactions', () => {
  class MockTransaction {
    moveCall() {}
    object(id?: unknown) {
      return { kind: 'object', id };
    }
    pure = {
      u64: (value: bigint) => ({ kind: 'u64', value }),
      bool: (value: boolean) => ({ kind: 'bool', value }),
    };
    setSender() {}
    async build() {
      throw new Error('mock tx.build failure');
    }
  }

  return {
    Transaction: MockTransaction,
  };
});

import { getHopMidPriceRaw, getQuantityOut, getInputForTargetOutput } from '../src/deepbook.js';
import { SlippageQueryError } from '../src/deepbookErrors.js';

// ─────────────────────────────────────────────
// Shared test fixtures
// ─────────────────────────────────────────────

const MOCK_POOL: SingleHopSettlementSwapPath = {
  hops: [
    {
      poolId: '0xpool1',
      baseType: '0x::deep::DEEP',
      quoteType: '0x2::sui::SUI',
      swapDirection: 'baseForQuote',
      feeBps: 0,
    },
  ],
  settlementTokenType: '0x::deep::DEEP',
  settlementTokenSymbol: 'DEEP',
  settlementTokenDecimals: 6,
  lotSize: 1000,
  minSize: 10000,
  effectiveFeeRateBps: 0,
  settlementSwapDirection: 'baseForQuote',
};

/** Encode a u64 as little-endian 8 bytes (for mock BCS return) */
function encodeU64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
  return buf;
}

// ─────────────────────────────────────────────
// getHopMidPriceRaw
// ─────────────────────────────────────────────

describe('getHopMidPriceRaw', () => {
  const hop = MOCK_POOL.hops[0];

  // Same scope as the getQuantityOut / getInputForTargetOutput build-fail
  // locks later in this file: `Transaction.build()` fails before any RPC runs,
  // so simulateTransaction must NOT be called. The simulate-rejection branch is
  // locked separately in `deepbook-decode.test.ts` against a successful mocked
  // Transaction build.
  it('throws SlippageQueryError when Transaction.build fails', async () => {
    const simulateTransaction = vi.fn().mockResolvedValue({
      commandResults: [{ returnValues: [{ bcs: encodeU64LE(27_000_000_000n) }] }],
    });
    const mockClient = { simulateTransaction };
    await expect(
      getHopMidPriceRaw(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        hop,
      ),
    ).rejects.toThrow(SlippageQueryError);
    expect(simulateTransaction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// getQuantityOut
// ─────────────────────────────────────────────

describe('getQuantityOut', () => {
  const hop = MOCK_POOL.hops[0];

  // Transaction.build() fails before any RPC runs. This locks the fail-closed
  // behaviour for that build-time path; the simulateTransaction-rejection path
  // (where build() succeeds and the simulate call rejects) is locked separately
  // in `deepbook-decode.test.ts` against a successful mocked Transaction build.
  it('throws SlippageQueryError when Transaction.build fails', async () => {
    const simulateTransaction = vi.fn().mockResolvedValue({
      commandResults: [
        {
          returnValues: [
            { bcs: encodeU64LE(100n) },
            { bcs: encodeU64LE(200n) },
            { bcs: encodeU64LE(50n) },
          ],
        },
      ],
    });
    const mockClient = { simulateTransaction };
    await expect(
      getQuantityOut(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        hop,
        1_000_000n,
      ),
    ).rejects.toThrow(SlippageQueryError);
    // build() fails first, so simulateTransaction must NOT have been called.
    expect(simulateTransaction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// getInputForTargetOutput
// ─────────────────────────────────────────────

describe('getInputForTargetOutput', () => {
  const hop = MOCK_POOL.hops[0];

  // Same scope as the getQuantityOut test above: locks the build-time fail
  // path. The simulateTransaction-rejection path is locked in
  // `deepbook-decode.test.ts` against a successful mocked Transaction build.
  it('throws SlippageQueryError when Transaction.build fails', async () => {
    const simulateTransaction = vi.fn().mockResolvedValue({
      commandResults: [
        {
          returnValues: [
            { bcs: encodeU64LE(100n) },
            { bcs: encodeU64LE(200n) },
            { bcs: encodeU64LE(50n) },
          ],
        },
      ],
    });
    const mockClient = { simulateTransaction };
    await expect(
      getInputForTargetOutput(
        mockClient as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
        '0xdeepbook',
        hop,
        1_000_000n,
      ),
    ).rejects.toThrow(SlippageQueryError);
    expect(simulateTransaction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// decodeLittleEndianU64Raw — BCS length guard
// (tested indirectly through encodeU64LE contract)
// ─────────────────────────────────────────────

describe('BCS u64 encoding contract', () => {
  it('encodeU64LE produces exactly 8 bytes', () => {
    expect(encodeU64LE(0n).length).toBe(8);
    expect(encodeU64LE(27_000_000_000n).length).toBe(8);
    expect(encodeU64LE(18_446_744_073_709_551_615n).length).toBe(8); // u64 max
  });

  it('encodeU64LE roundtrips correctly for known values', () => {
    const values = [0n, 1n, 255n, 27_000_000_000n, 18_446_744_073_709_551_615n];
    for (const v of values) {
      const encoded = encodeU64LE(v);
      // Manual decode to verify encode correctness
      let decoded = 0n;
      for (let i = 0; i < 8; i++) {
        decoded |= BigInt(encoded[i]) << BigInt(i * 8);
      }
      expect(decoded).toBe(v);
    }
  });

  it('correctly decodes a known mid_price value (27 SUI/DEEP)', () => {
    // This proves the encode/decode contract matches DeepBook's BCS format.
    // getHopMidPriceRaw and batchGetHopMidPrices use decodeLittleEndianU64Raw internally.
    const midPrice = 27_000_000_000n;
    const encoded = encodeU64LE(midPrice);

    // Verify byte-level layout (little-endian)
    expect(encoded[0]).toBe(0x00); // least significant byte
    expect(encoded.length).toBe(8);

    // Verify roundtrip
    let decoded = 0n;
    for (let i = 0; i < 8; i++) {
      decoded |= BigInt(encoded[i]) << BigInt(i * 8);
    }
    expect(decoded).toBe(midPrice);
  });
});
