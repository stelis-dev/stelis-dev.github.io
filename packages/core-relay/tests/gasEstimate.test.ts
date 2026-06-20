import { describe, it, expect } from 'vitest';
import { computeExecutionCostClaim, GAS_VARIANCE_FIXED_MIST } from '../src/gasEstimate.js';
import { SLIPPAGE_CAP_BPS } from '@stelis/contracts';

describe('computeExecutionCostClaim', () => {
  const makeGas = (comp: string, storage: string, rebate: string) => ({
    computationCost: comp,
    storageCost: storage,
    storageRebate: rebate,
  });

  // ── Two-component formula ──────────────────────────────────────────────────

  it('credit path (no slippage): executionCostClaim = simGas + GAS_VARIANCE_FIXED_MIST', () => {
    // simGas = 8_000_000 + 2_000_000 - 1_000_000 = 9_000_000
    // executionCostClaim = 9_000_000 + 100_000 + 0 = 9_100_000
    const result = computeExecutionCostClaim(makeGas('8000000', '2000000', '1000000'));
    expect(result.simGas).toBe(9_000_000n);
    expect(result.grossGas).toBe(10_000_000n);
    expect(result.gasVarianceFixedMist).toBe(100_000n);
    expect(result.slippageBufferMist).toBe(0n);
    expect(result.executionCostClaim).toBe(9_100_000n);
  });

  it('swap path (with slippage): executionCostClaim = simGas + GAS_VARIANCE_FIXED_MIST + slippage', () => {
    // simGas = 9_000_000, executionCostClaim = 9_000_000 + 100_000 + 50_000 = 9_150_000
    const result = computeExecutionCostClaim(makeGas('8000000', '2000000', '1000000'), {
      slippageBufferMist: 50_000n,
    });
    expect(result.simGas).toBe(9_000_000n);
    expect(result.gasVarianceFixedMist).toBe(100_000n);
    expect(result.slippageBufferMist).toBe(50_000n);
    expect(result.executionCostClaim).toBe(9_150_000n);
  });

  it('negative slippageBufferMist is clamped to 0', () => {
    const result = computeExecutionCostClaim(makeGas('8000000', '2000000', '1000000'), {
      slippageBufferMist: -50_000n,
    });
    expect(result.slippageBufferMist).toBe(0n);
    expect(result.executionCostClaim).toBe(9_100_000n);
  });

  // ── Constant exports ──────────────────────────────────────────────────────

  it('GAS_VARIANCE_FIXED_MIST is 100_000', () => {
    expect(GAS_VARIANCE_FIXED_MIST).toBe(100_000n);
  });

  it('SLIPPAGE_CAP_BPS is 500 (5%)', () => {
    expect(SLIPPAGE_CAP_BPS).toBe(500);
  });

  // ── simGas = 0 edge case ──────────────────────────────────────────────────

  it('simGas = 0: executionCostClaim is still GAS_VARIANCE_FIXED_MIST', () => {
    const result = computeExecutionCostClaim(makeGas('0', '0', '0'));
    expect(result.simGas).toBe(0n);
    expect(result.gasVarianceFixedMist).toBe(100_000n);
    expect(result.slippageBufferMist).toBe(0n);
    expect(result.executionCostClaim).toBe(100_000n);
  });

  // ── Negative simGas clamp ─────────────────────────────────────────────────

  it('clamps simGas to 0 when storageRebate exceeds comp + storage', () => {
    const result = computeExecutionCostClaim(makeGas('1000000', '1000000', '5000000'));
    expect(result.simGas).toBe(0n);
    expect(result.grossGas).toBe(2_000_000n);
    expect(result.executionCostClaim).toBe(100_000n);
  });

  it('executionCostClaim is always non-negative', () => {
    const result = computeExecutionCostClaim(makeGas('100000', '100000', '99999999'));
    expect(result.simGas).toBeGreaterThanOrEqual(0n);
    expect(result.executionCostClaim).toBeGreaterThanOrEqual(0n);
  });

  // ── grossGas relationship ─────────────────────────────────────────────────

  it('grossGas does not subtract rebate', () => {
    const result = computeExecutionCostClaim(makeGas('5000000', '3000000', '2000000'));
    expect(result.grossGas).toBe(8_000_000n);
    expect(result.simGas).toBe(6_000_000n);
  });

  it('grossGas is always >= simGas', () => {
    const result = computeExecutionCostClaim(makeGas('3000000', '2000000', '1000000'));
    expect(result.grossGas).toBeGreaterThanOrEqual(result.simGas);
    expect(result.grossGas).toBe(5_000_000n);
    expect(result.simGas).toBe(4_000_000n);
  });

  // ── Real-world scenario ──────────────────────────────────────────────────

  it('typical credit-only settlement scenario', () => {
    // simGas = 1_000_000 + 5_852_000 - 4_815_360 = 2_036_640
    // executionCostClaim = 2_036_640 + 100_000 = 2_136_640
    const result = computeExecutionCostClaim(makeGas('1000000', '5852000', '4815360'));
    expect(result.simGas).toBe(2_036_640n);
    expect(result.gasVarianceFixedMist).toBe(100_000n);
    expect(result.slippageBufferMist).toBe(0n);
    expect(result.executionCostClaim).toBe(2_136_640n);
  });

  it('rejects non-canonical gas amount strings', () => {
    expect(() => computeExecutionCostClaim(makeGas('0x10', '0', '0'))).toThrow(
      'gasUsed.computationCost must be a non-negative decimal integer string',
    );
    expect(() => computeExecutionCostClaim(makeGas('1e6', '0', '0'))).toThrow(
      'gasUsed.computationCost must be a non-negative decimal integer string',
    );
  });
});
