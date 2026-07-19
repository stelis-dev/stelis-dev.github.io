/**
 * checkSettlementSwapPathLiquidity — unit tests.
 *
 * Tests verify all return paths:
 *   1. mid_price = 0 → no_orders (hasLiquidity: false)
 *   2. mid_price > 0 → ok (hasLiquidity: true) + priceHuman
 *   3. label is always "SYMBOL/SUI"
 *
 * Strategy: mock batchGetHopMidPrices from @stelis/core-relay to avoid
 * on-chain calls, test checkSettlementSwapPathLiquidity logic in isolation.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { withSuiClientIdentity } from './helpers/suiClientIdentity.js';
import type { SingleHopSettlementSwapPath } from '../src/types.js';
import { createSuiEndpointSnapshot } from '@stelis/core-relay/browser';

// ── Mock: @stelis/core-relay (batchGetHopMidPrices) ──────────────────────────
let _hopPrices: bigint[] = [0n];
vi.mock('@stelis/core-relay/browser', async (importOriginal) => {
  const original = await importOriginal<typeof import('@stelis/core-relay/browser')>();
  return {
    ...original,
    batchGetHopMidPrices: vi.fn(async () => _hopPrices),
  };
});

import { readSettlementSwapPathLiquidity } from '../src/swap.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const PKG = '0x' + '1'.repeat(64);
const DBPKG = '0x' + 'd'.repeat(64);

const DEEP_POOL: SingleHopSettlementSwapPath = {
  hops: [
    {
      poolId: '0x' + '4'.repeat(64),
      baseType: `${PKG}::deep::DEEP`,
      quoteType: '0x2::sui::SUI',
      swapDirection: 'baseForQuote' as const,
      feeBps: 0,
    },
  ],
  settlementTokenType: `${PKG}::deep::DEEP`,
  settlementTokenSymbol: 'DEEP',
  settlementTokenDecimals: 6,
  lotSize: 100n,
  minSize: 1_000_000n,
  effectiveFeeRateBps: 0,
  settlementSwapDirection: 'baseForQuote' as const,
};

const QFB_POOL: SingleHopSettlementSwapPath = {
  hops: [
    {
      poolId: '0x' + '7'.repeat(64),
      baseType: '0x2::sui::SUI',
      quoteType: `${PKG}::alpha::ALPHA`,
      swapDirection: 'quoteForBase' as const,
      feeBps: 0,
    },
  ],
  settlementTokenType: `${PKG}::alpha::ALPHA`,
  settlementTokenSymbol: 'ALPHA',
  settlementTokenDecimals: 6,
  lotSize: 100n,
  minSize: 1_000_000n,
  effectiveFeeRateBps: 0,
  settlementSwapDirection: 'quoteForBase' as const,
};

function mockClient(): SuiGrpcClient {
  return withSuiClientIdentity({});
}

function readLiquidity(
  settlementSwapPath: SingleHopSettlementSwapPath,
): Promise<Awaited<ReturnType<typeof readSettlementSwapPathLiquidity>>> {
  return readSettlementSwapPathLiquidity(
    createSuiEndpointSnapshot([mockClient()]),
    DBPKG,
    settlementSwapPath,
  );
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('checkSettlementSwapPathLiquidity', () => {
  // ── mid_price = 0 → no_orders ─────────────────────────────────────
  it('returns no_orders when midPrice is 0', async () => {
    _hopPrices = [0n];
    const result = await readLiquidity(DEEP_POOL);
    expect(result.hasLiquidity).toBe(false);
    expect(result.status).toBe('no_orders');
    expect(result.midPrice).toBeNull();
    expect(result.midPriceRaw).toBeNull();
    expect(result.priceDisplay).toBeNull();
  });

  it('rejects a price vector that does not cover the complete path', async () => {
    _hopPrices = [];
    await expect(readLiquidity(DEEP_POOL)).rejects.toThrow('exactly one price per hop');
  });

  // ── mid_price > 0 → ok ────────────────────────────────────────────
  it('returns ok when midPrice is positive', async () => {
    _hopPrices = [27_000_000_000n];
    const result = await readLiquidity(DEEP_POOL);
    expect(result.hasLiquidity).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.midPrice).toBe(27_000_000_000);
    expect(result.midPriceRaw).toBe(27_000_000_000n);
  });

  // ── priceHuman calculation ─────────────────────────────────────────
  it('computes priceHuman correctly', async () => {
    _hopPrices = [27_000_000_000n];
    const result = await readLiquidity(DEEP_POOL);
    // priceHuman = 27_000_000_000 × 10^6 / (1e9 × 1e9) = 0.027
    expect(result.priceHuman).toBeCloseTo(0.027, 4);
    expect(result.priceDisplay).toBe('0.027000');
  });

  // ── label is always SYMBOL/SUI ─────────────────────────────────────
  it('returns label as "SYMBOL/SUI"', async () => {
    _hopPrices = [0n];
    const noLiq = await readLiquidity(DEEP_POOL);
    expect(noLiq.label).toBe('DEEP/SUI');

    _hopPrices = [27_000_000_000n];
    const ok = await readLiquidity(DEEP_POOL);
    expect(ok.label).toBe('DEEP/SUI');
  });

  // ── qfb: mid_price > 0 → ok, inverted rate composition ───────────
  it('qfb: composes rate using input × 1e9 / midPrice', async () => {
    // Pool<SUI, ALPHA> with quoteForBase: midPrice = 1_000_000_000 (1e9)
    // qfb composition: chainedOutput = REF * 1e9 / midPrice = 1e18
    // composedMidPrice = Number(1e18 * 1e9 / 1e18) = 1_000_000_000
    // priceHuman = 1_000_000_000 * 1e6 / (1e9 * 1e9) = 0.001
    _hopPrices = [1_000_000_000n];
    const result = await readLiquidity(QFB_POOL);
    expect(result.hasLiquidity).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.midPrice).toBe(1_000_000_000);
    expect(result.midPriceRaw).toBe(1_000_000_000n);
    expect(result.priceHuman).toBeCloseTo(0.001, 9);
    expect(result.priceDisplay).toBe('0.001000');
    expect(result.label).toBe('ALPHA/SUI');
  });

  it('preserves exact raw midPrice when path-wide value exceeds safe number range', async () => {
    _hopPrices = [9_007_199_254_740_993n];
    const result = await readLiquidity(DEEP_POOL);
    expect(result.hasLiquidity).toBe(true);
    expect(result.midPrice).toBeNull();
    expect(result.midPriceRaw).toBe(9_007_199_254_740_993n);
    expect(result.priceDisplay).toBe('9007.199255');
  });
});
