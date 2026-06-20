/**
 * settlementPlanner — pure planning layer for generic prepare settlement.
 *
 * Contains NO I/O, NO PTB mutation, NO chain queries.
 *
 * Exported functions:
 *   - checkCreditOnlyEligibility:               credit-only path decision
 *   - calculateRequiredSwapOutput:              target SUI output needed from swap
 *   - calculateMinOutputGuardsFromQuotedOutputs: canonical runtime min-out guards (quoted path)
 *   - assembleSwapSettlementPlan:               assemble SettlementPlan for swap path
 *   - assembleCreditSettlementPlan:             assemble SettlementPlan for credit path
 *
 * build.ts is the sole runtime caller. It computes swap amount, funding, and
 * quoted hop outputs before calling the assembly functions.
 */

import type { SingleHopSettlementSwapPath, SettleProfile } from '@stelis/contracts';
import type { PaymentInputSource } from '@stelis/core-relay/server';
import type { SwapPlan, SettlementPlan, SettlePlanAuditFields } from './settlePlanTypes.js';

// ─────────────────────────────────────────────
// Planner config input
// ─────────────────────────────────────────────

/** Fee-only config values needed for planning decisions. */
export interface PlannerConfig {
  readonly minSettleMist: bigint;
  readonly quotedHostFeeMist: bigint;
  readonly protocolFlatFeeMist: bigint;
}

/** Request inputs needed for planning decisions. */
export interface PlannerInput {
  readonly settlementSwapPath: SingleHopSettlementSwapPath;
  readonly profile: SettleProfile;
  readonly vaultObjectId: string | null;
  readonly creditMist: bigint;
}

/** Result of funding-source resolution (from resolvePaymentSource). */
export interface FundingResolution {
  readonly source: PaymentInputSource;
  readonly usableCoins: ReadonlyArray<{ objectId: string; balance: string }>;
  readonly usableCoinTotal: bigint;
  readonly addressBalance: bigint;
  readonly redeemDelta: bigint;
}

// ─────────────────────────────────────────────
// Credit-only eligibility
// ─────────────────────────────────────────────

/**
 * Determine if credit-only settlement is viable.
 *
 * Credit-only is viable when:
 *   - profile is credit_general
 *   - vault exists
 *   - credit covers max(totalNeeded, minSettleMist)
 *
 * Returns the effective credit amount to use, or null if not viable.
 */
export function checkCreditOnlyEligibility(
  config: PlannerConfig,
  input: PlannerInput,
  executionCostClaim: bigint,
): { useCreditAmount: bigint } | null {
  if (input.profile !== 'credit_general' || !input.vaultObjectId) return null;
  const totalNeeded = executionCostClaim + config.quotedHostFeeMist + config.protocolFlatFeeMist;
  const effectiveCredit = totalNeeded > config.minSettleMist ? totalNeeded : config.minSettleMist;
  if (input.creditMist >= effectiveCredit) {
    return { useCreditAmount: effectiveCredit };
  }
  return null;
}

// ─────────────────────────────────────────────
// Swap target calculation
// ─────────────────────────────────────────────

/**
 * Calculate the SUI output target that a swap path must satisfy.
 *
 * Steps:
 *   1. requiredTotalIn = max(executionCostClaim + fees, minSettleMist)
 *   2. Subtract existing vault credit (with_vault only)
 */
export function calculateRequiredSwapOutput(
  config: PlannerConfig,
  input: PlannerInput,
  executionCostClaim: bigint,
): bigint {
  const totalNeeded = executionCostClaim + config.quotedHostFeeMist + config.protocolFlatFeeMist;
  const requiredTotalIn = totalNeeded > config.minSettleMist ? totalNeeded : config.minSettleMist;

  const existingCredit =
    input.profile !== 'new_user' && input.vaultObjectId ? input.creditMist : 0n;
  return requiredTotalIn > existingCredit ? requiredTotalIn - existingCredit : 0n;
}

/**
 * Calculate min output guards from per-hop quoted outputs.
 *
 * Used when runtime quoting is available and should drive
 * for min-out guards. The hop outputs come from the server-side executable
 * market-policy solve, where each candidate input is verified against the
 * input-fee quantity-out path before being used for guard derivation.
 */
export function calculateMinOutputGuardsFromQuotedOutputs(
  swapAmountSmallest: bigint,
  hopOutputs: readonly bigint[],
  slippageBps: number,
): SwapPlan {
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error('slippageBps must be a safe integer in [0, 10000]');
  }
  const applySlippage = (amount: bigint): bigint =>
    amount > 0n ? (amount * BigInt(10_000 - slippageBps)) / 10_000n : 0n;
  return {
    swapAmountSmallest,
    minSuiOut: hopOutputs.length > 0 ? applySlippage(hopOutputs[0]) : 0n,
  };
}

// ─────────────────────────────────────────────
// Plan assembly
// ─────────────────────────────────────────────

/**
 * Assemble a complete swap SettlementPlan from pre-computed inputs.
 *
 * Pure assembler: receives already-calculated swap amounts, funding resolution,
 * and quoted min-output guards. Does NOT re-derive amounts from market data.
 *
 * Call sequence in build.ts:
 *   1. solveExecutableSwap(...)       → swapAmountSmallest + quotedHopOutputs
 *   2. resolvePaymentSource(...)      → funding
 *   3. calculateMinOutputGuardsFromQuotedOutputs(...) → swap
 *   4. assembleSwapSettlementPlan(input, audit, funding, swap)
 */
export function assembleSwapSettlementPlan(
  input: PlannerInput,
  audit: SettlePlanAuditFields,
  funding: FundingResolution,
  swap: SwapPlan,
): SettlementPlan {
  const variant: 'new_user' | 'with_vault' =
    input.profile === 'new_user' || !input.vaultObjectId ? 'new_user' : 'with_vault';

  const useCreditAmount = variant === 'with_vault' ? input.creditMist : 0n;

  return {
    // credit_general on a swap path settles as with_vault on-chain.
    // The credit-only path is already handled by assembleCreditSettlementPlan.
    profile:
      variant === 'new_user'
        ? 'new_user'
        : input.profile === 'credit_general'
          ? 'with_vault'
          : input.profile,
    variant,
    settlementSwapPath: input.settlementSwapPath,
    settlementSwapDirection: input.settlementSwapPath.settlementSwapDirection,
    funding: {
      source: funding.source,
      usableCoins: [...funding.usableCoins],
      usableCoinTotal: funding.usableCoinTotal,
      addressBalance: funding.addressBalance,
      redeemDelta: funding.redeemDelta,
      useCreditAmount,
    },
    swap,
    audit,
  };
}

/**
 * Assemble a credit-only SettlementPlan from pre-computed inputs.
 *
 * Pure assembler: receives already-determined useCreditAmount.
 * Does NOT re-derive amounts.
 */
export function assembleCreditSettlementPlan(
  input: PlannerInput,
  audit: SettlePlanAuditFields,
  useCreditAmount: bigint,
): SettlementPlan {
  if (audit.slippageBufferMist !== 0n) {
    throw new Error(
      `[SETTLEMENT_PLAN] Credit-only settlement requires slippageBufferMist=0, got ${audit.slippageBufferMist}`,
    );
  }
  return {
    profile: 'credit_general',
    settlementSwapPath: input.settlementSwapPath,
    settlementSwapDirection: input.settlementSwapPath.settlementSwapDirection,
    funding: {
      source: 'none_credit_only',
      usableCoins: [],
      usableCoinTotal: 0n,
      addressBalance: 0n,
      redeemDelta: 0n,
      useCreditAmount,
    },
    swap: { swapAmountSmallest: 0n, minSuiOut: 0n },
    audit,
  };
}
