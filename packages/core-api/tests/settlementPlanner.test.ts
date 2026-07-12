/**
 * settlementPlanner.test.ts — pure planning logic unit tests.
 *
 * Tests the planner functions WITHOUT mocks (pure computation, no I/O).
 * Covers: credit-only eligibility, swap amount calculation, min output guards,
 * plan assembly for credit and swap paths.
 */
import { describe, it, expect } from 'vitest';
import {
  checkCreditOnlyEligibility,
  calculateRequiredSwapOutput,
  calculateMinOutputGuardsFromQuotedOutputs,
  assembleSwapSettlementPlan,
  assembleCreditSettlementPlan,
} from '../src/prepare/settlementPlanner.js';
import type { SwapFundingResolution } from '../src/prepare/settlePlanTypes.js';
import {
  BASE_CONFIG,
  BASE_AUDIT,
  ADDR_DEEP_COIN,
  ADDR_USABLE_COIN,
  makeInput,
} from './fixtures/prepareTestFixtures.js';

// ─────────────────────────────────────────────
// Credit-only eligibility
// ─────────────────────────────────────────────

describe('checkCreditOnlyEligibility', () => {
  it('returns useCreditAmount when credit covers totalNeeded', () => {
    const input = makeInput({ profile: 'credit_general', creditMist: 10_000_000n });
    const result = checkCreditOnlyEligibility(BASE_CONFIG, input, 5_000_000n);
    expect(result).not.toBeNull();
    // totalNeeded = 5_000_000 + 100_000 + 20_000 = 5_120_000
    expect(result!.useCreditAmount).toBe(5_120_000n);
  });

  it('returns null when credit insufficient', () => {
    const input = makeInput({ profile: 'credit_general', creditMist: 1_000n });
    const result = checkCreditOnlyEligibility(BASE_CONFIG, input, 5_000_000n);
    expect(result).toBeNull();
  });

  it('returns null when profile is not credit_general', () => {
    const input = makeInput({ profile: 'with_vault', creditMist: 999_999_999n });
    const result = checkCreditOnlyEligibility(BASE_CONFIG, input, 5_000_000n);
    expect(result).toBeNull();
  });

  it('returns null when no vaultObjectId', () => {
    const input = makeInput({
      profile: 'credit_general',
      vaultObjectId: null,
      creditMist: 999_999_999n,
    });
    const result = checkCreditOnlyEligibility(BASE_CONFIG, input, 5_000_000n);
    expect(result).toBeNull();
  });

  it('uses minSettleMist as floor when totalNeeded is smaller', () => {
    const config = { ...BASE_CONFIG, minSettleMist: 100_000_000n };
    const input = makeInput({ profile: 'credit_general', creditMist: 100_000_000n });
    const result = checkCreditOnlyEligibility(config, input, 5_000_000n);
    expect(result).not.toBeNull();
    expect(result!.useCreditAmount).toBe(100_000_000n);
  });
});

// ─────────────────────────────────────────────
// Swap output target calculation
// ─────────────────────────────────────────────

describe('calculateRequiredSwapOutput', () => {
  it('returns positive output target for swap path', () => {
    const input = makeInput({ profile: 'new_user', vaultObjectId: null, creditMist: 0n });
    const outputTarget = calculateRequiredSwapOutput(BASE_CONFIG, input, 5_000_000n);
    expect(outputTarget).toBeGreaterThan(0n);
  });

  it('subtracts existing credit for with_vault', () => {
    const noCredit = makeInput({ creditMist: 0n });
    const withCredit = makeInput({ creditMist: 3_000_000n });
    const outputNoCredit = calculateRequiredSwapOutput(BASE_CONFIG, noCredit, 5_000_000n);
    const outputWithCredit = calculateRequiredSwapOutput(BASE_CONFIG, withCredit, 5_000_000n);
    expect(outputWithCredit).toBeLessThan(outputNoCredit);
  });

  it('uses minSettleMist as floor when totalNeeded is smaller', () => {
    const config = { ...BASE_CONFIG, minSettleMist: 100_000_000n };
    const input = makeInput({ profile: 'new_user', vaultObjectId: null });
    const outputTarget = calculateRequiredSwapOutput(config, input, 5_000_000n);
    expect(outputTarget).toBe(100_000_000n);
  });
});

describe('calculateMinOutputGuardsFromQuotedOutputs', () => {
  it('applies slippage to quoted final output', () => {
    const swap = calculateMinOutputGuardsFromQuotedOutputs(1_000_000n, [27_000_000n], 200);
    expect(swap.swapAmountSmallest).toBe(1_000_000n);
    expect(swap.minSuiOut).toBe(26_460_000n); // 27_000_000 * 0.98
  });

  it('returns zero minSuiOut when no hop outputs', () => {
    const swap = calculateMinOutputGuardsFromQuotedOutputs(1_000_000n, [], 200);
    expect(swap.minSuiOut).toBe(0n);
  });

  it('rejects invalid slippage values', () => {
    expect(() => calculateMinOutputGuardsFromQuotedOutputs(1_000_000n, [27_000_000n], 1.5)).toThrow(
      'slippageBps',
    );
    expect(() =>
      calculateMinOutputGuardsFromQuotedOutputs(1_000_000n, [27_000_000n], 10_001),
    ).toThrow('slippageBps');
  });
});

// ─────────────────────────────────────────────
// Plan assembly
// ─────────────────────────────────────────────

describe('assembleCreditSettlementPlan', () => {
  it('produces credit-only plan with zero swap', () => {
    const input = makeInput({ profile: 'credit_general' });
    const creditAudit = { ...BASE_AUDIT, slippageBufferMist: 0n };
    const plan = assembleCreditSettlementPlan(input, creditAudit, 5_120_000n);
    expect(plan.profile).toBe('credit_general');
    expect(plan.swap.swapAmountSmallest).toBe(0n);
    expect(plan.funding).toEqual({ source: 'none_credit_only' });
    expect(plan.useCreditAmount).toBe(5_120_000n);
    expect('useCreditAmount' in plan.funding).toBe(false);
    expect(plan.audit.slippageBufferMist).toBe(0n);
  });

  it('rejects non-zero slippage buffer for credit-only plan', () => {
    const input = makeInput({ profile: 'credit_general' });
    expect(() => assembleCreditSettlementPlan(input, BASE_AUDIT, 5_120_000n)).toThrow(
      /Credit-only settlement requires slippageBufferMist=0/,
    );
  });
});

describe('assembleSwapSettlementPlan', () => {
  const funding: SwapFundingResolution = {
    source: 'coin_object',
    baseCoinId: ADDR_USABLE_COIN,
    mergeCoinIds: [],
    remainingBalance: 10_000_000n,
  };
  const swap = { swapAmountSmallest: 1_916_668n, minSuiOut: 26_730_000n };

  it('assembles swap plan from pre-computed inputs', () => {
    const input = makeInput({ profile: 'with_vault', creditMist: 0n });
    const plan = assembleSwapSettlementPlan(input, BASE_AUDIT, funding, swap);
    expect(plan.swap.swapAmountSmallest).toBe(1_916_668n);
    expect(plan.funding).toBe(funding);
    expect(plan.funding).toEqual({
      source: 'coin_object',
      baseCoinId: ADDR_USABLE_COIN,
      mergeCoinIds: [],
      remainingBalance: 10_000_000n,
    });
    expect(plan.audit.executionCostClaim).toBe(BASE_AUDIT.executionCostClaim);
    expect(plan.variant).toBe('with_vault');
  });

  it('new_user variant has zero useCreditAmount', () => {
    const input = makeInput({ profile: 'new_user', vaultObjectId: null, creditMist: 0n });
    const plan = assembleSwapSettlementPlan(input, BASE_AUDIT, funding, swap);
    expect(plan.profile).toBe('new_user');
    expect(plan.useCreditAmount).toBe(0n);
    expect('useCreditAmount' in plan.funding).toBe(false);
  });

  it('normalizes credit_general swap path to with_vault', () => {
    const input = makeInput({
      profile: 'credit_general',
      vaultObjectId: '0xVAULT',
      creditMist: 2_000_000n,
    });
    const plan = assembleSwapSettlementPlan(input, BASE_AUDIT, funding, swap);
    expect(plan.profile).toBe('with_vault');
    expect(plan.useCreditAmount).toBe(2_000_000n);
    expect(plan.funding).toBe(funding);
  });

  it('with_vault variant carries creditMist as useCreditAmount', () => {
    const input = makeInput({ profile: 'with_vault', creditMist: 2_000_000n });
    const plan = assembleSwapSettlementPlan(input, BASE_AUDIT, funding, swap);
    expect(plan.useCreditAmount).toBe(2_000_000n);
    expect('useCreditAmount' in plan.funding).toBe(false);
  });

  it('preserves the exact mixed funding object identity and amounts', () => {
    const mixedFunding: SwapFundingResolution = {
      source: 'mixed_topup',
      baseCoinId: ADDR_USABLE_COIN,
      mergeCoinIds: [ADDR_DEEP_COIN],
      remainingBalance: 1_416_668n,
      redeemAmount: 500_000n,
    };
    const input = makeInput({ profile: 'with_vault', creditMist: 0n });
    const plan = assembleSwapSettlementPlan(input, BASE_AUDIT, mixedFunding, swap);
    expect(plan.funding).toBe(mixedFunding);
    expect(plan.funding).toEqual(mixedFunding);
    expect(plan.useCreditAmount).toBe(0n);
  });

  it('preserves address-balance funding without adding coin-selection fields', () => {
    const addressFunding: SwapFundingResolution = {
      source: 'address_balance',
      redeemAmount: swap.swapAmountSmallest,
    };
    const input = makeInput({ profile: 'with_vault', creditMist: 750_000n });
    const plan = assembleSwapSettlementPlan(input, BASE_AUDIT, addressFunding, swap);

    expect(plan.funding).toBe(addressFunding);
    expect(plan.funding).toEqual({
      source: 'address_balance',
      redeemAmount: swap.swapAmountSmallest,
    });
    expect(plan.useCreditAmount).toBe(750_000n);
  });
});
