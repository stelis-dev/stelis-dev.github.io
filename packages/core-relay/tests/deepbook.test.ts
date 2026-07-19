import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { SingleHopSettlementSwapPath } from '@stelis/contracts';
import { createSuiEndpointSnapshot, type SuiEndpointSnapshot } from '../src/sui/suiOperation.js';
import type { SuiGrpcClient } from '@mysten/sui/grpc';

const { mockSimulateSuiMoveView } = vi.hoisted(() => ({
  mockSimulateSuiMoveView: vi.fn(),
}));

vi.mock('../src/sui/suiTransactionGateways.js', () => ({
  simulateSuiMoveView: mockSimulateSuiMoveView,
}));

import { getHopMidPriceRaw, getQuantityOut, getInputForTargetOutput } from '../src/deepbook.js';
import { decodeExactU64Bytes } from '../src/decodeU64.js';
import { SuiOperationError } from '../src/sui/suiOperation.js';

// ─────────────────────────────────────────────
// Shared test fixtures
// ─────────────────────────────────────────────

const MOCK_POOL: SingleHopSettlementSwapPath = {
  hops: [
    {
      poolId: `0x${'1'.repeat(64)}`,
      baseType: '0xdee0::deep::DEEP',
      quoteType: '0x2::sui::SUI',
      swapDirection: 'baseForQuote',
      feeBps: 0,
    },
  ],
  settlementTokenType: '0x::deep::DEEP',
  settlementTokenSymbol: 'DEEP',
  settlementTokenDecimals: 6,
  lotSize: 1000n,
  minSize: 10000n,
  effectiveFeeRateBps: 0,
  settlementSwapDirection: 'baseForQuote',
};
const DEEPBOOK_PACKAGE_ID = `0x${'d'.repeat(64)}`;

function snapshot(): SuiEndpointSnapshot {
  return createSuiEndpointSnapshot([{ network: 'testnet' } as SuiGrpcClient]);
}

beforeEach(() => {
  mockSimulateSuiMoveView.mockReset();
});

function buildOperationError(): SuiOperationError {
  return new SuiOperationError('transport_unavailable', {
    operation: 'resolve_transaction',
    attempt: 1,
    maxAttempts: 1,
  });
}

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

  it('preserves the typed Move-view gateway error', async () => {
    const error = buildOperationError();
    mockSimulateSuiMoveView.mockRejectedValueOnce(error);
    await expect(getHopMidPriceRaw(snapshot(), DEEPBOOK_PACKAGE_ID, hop)).rejects.toBe(error);
    expect(mockSimulateSuiMoveView).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// getQuantityOut
// ─────────────────────────────────────────────

describe('getQuantityOut', () => {
  const hop = MOCK_POOL.hops[0];

  it('preserves the typed Move-view gateway error', async () => {
    const error = buildOperationError();
    mockSimulateSuiMoveView.mockRejectedValueOnce(error);
    await expect(getQuantityOut(snapshot(), DEEPBOOK_PACKAGE_ID, hop, 1_000_000n)).rejects.toBe(
      error,
    );
    expect(mockSimulateSuiMoveView).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// getInputForTargetOutput
// ─────────────────────────────────────────────

describe('getInputForTargetOutput', () => {
  const hop = MOCK_POOL.hops[0];

  it('preserves the typed Move-view gateway error', async () => {
    const error = buildOperationError();
    mockSimulateSuiMoveView.mockRejectedValueOnce(error);
    await expect(
      getInputForTargetOutput(snapshot(), DEEPBOOK_PACKAGE_ID, hop, 1_000_000n),
    ).rejects.toBe(error);
    expect(mockSimulateSuiMoveView).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// Shared exact u64 decoder — BCS width contract
// (DeepBook translates failures into SlippageQueryError at its boundary.)
// ─────────────────────────────────────────────

describe('BCS u64 encoding contract', () => {
  it('encodeU64LE produces exactly 8 bytes', () => {
    expect(encodeU64LE(0n).length).toBe(8);
    expect(encodeU64LE(27_000_000_000n).length).toBe(8);
    expect(encodeU64LE(18_446_744_073_709_551_615n).length).toBe(8); // u64 max
  });

  it('the shared decoder roundtrips known little-endian u64 values', () => {
    const values = [0n, 1n, 255n, 27_000_000_000n, 18_446_744_073_709_551_615n];
    for (const v of values) {
      expect(decodeExactU64Bytes(encodeU64LE(v))).toBe(v);
    }
  });

  it('the shared decoder rejects both truncation and trailing bytes', () => {
    expect(() => decodeExactU64Bytes(new Uint8Array(7))).toThrow('exactly 8 bytes, got 7');
    expect(() => decodeExactU64Bytes(new Uint8Array(9))).toThrow('exactly 8 bytes, got 9');
  });

  it('correctly decodes a known mid_price value (27 SUI/DEEP)', () => {
    // This proves the encode/decode contract matches DeepBook's BCS format.
    // DeepBook consumers use the shared exact u64 decoder internally.
    const midPrice = 27_000_000_000n;
    const encoded = encodeU64LE(midPrice);

    // Verify byte-level layout (little-endian)
    expect(encoded[0]).toBe(0x00); // least significant byte
    expect(encoded.length).toBe(8);

    expect(decodeExactU64Bytes(encoded)).toBe(midPrice);
  });
});
