/**
 * settlementPlanner — pure planning layer for generic prepare settlement.
 *
 * Contains NO I/O, NO PTB mutation, NO chain queries.
 *
 * Exported functions:
 *   - checkCreditOnlyEligibility:               credit-only path decision
 *   - calculateRequiredSwapOutput:              target SUI output needed from swap
 *   - calculateSwapOutputGuards:                canonical runtime min-out guards (quoted path)
 *   - assembleSwapSettlementPlan:               assemble SettlementPlan for swap path
 *   - assembleCreditSettlementPlan:             assemble SettlementPlan for credit path
 *
 * build.ts is the sole runtime caller. It computes swap amount, funding, and
 * quoted hop outputs before calling the assembly functions.
 */

import type { SingleHopSettlementSwapPath, SettleProfile } from '@stelis/contracts';
import type { CreditResult } from '@stelis/core-relay';
import type {
  SwapFundingResolution,
  SwapPlan,
  SettlementPlan,
  SettlePlanAuditFields,
} from './settlePlanTypes.js';

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

export type SettlementFundingProfile =
  | { readonly profile: 'credit_general'; readonly vaultObjectId: string }
  | { readonly profile: 'new_user'; readonly vaultObjectId: null };

/** Project one validated credit snapshot into the initial settlement profile. */
export function deriveSettlementFundingProfile(
  credit: Pick<CreditResult, 'vaultObjectId' | 'needsCreate'>,
): SettlementFundingProfile {
  if (credit.vaultObjectId !== null && credit.needsCreate === false) {
    return { profile: 'credit_general', vaultObjectId: credit.vaultObjectId };
  }
  if (credit.vaultObjectId === null && credit.needsCreate === true) {
    return { profile: 'new_user', vaultObjectId: null };
  }
  throw new Error('Credit snapshot has inconsistent vault identity and creation state');
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
 * Calculate the final on-chain minimum output from one verified quote.
 *
 * `requiredSwapOutputMist` is the economic target already carried by the
 * executable quote. `verifiedOutputMist` is that quote's verified SUI output.
 * Rejecting required > verified keeps the final guard at or below the quote
 * instead of manufacturing an unreachable minimum.
 */
export function calculateSwapOutputGuards(
  swapAmountSmallest: bigint,
  requiredSwapOutputMist: bigint,
  verifiedOutputMist: bigint,
  slippageBps: number,
): SwapPlan {
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error('slippageBps must be a safe integer in [0, 10000]');
  }
  if (requiredSwapOutputMist < 0n) {
    throw new Error('requiredSwapOutputMist must be non-negative');
  }
  if (verifiedOutputMist < requiredSwapOutputMist) {
    throw new Error('verifiedOutputMist must cover requiredSwapOutputMist');
  }

  const slippageFloor =
    verifiedOutputMist > 0n ? (verifiedOutputMist * BigInt(10_000 - slippageBps)) / 10_000n : 0n;
  return {
    swapAmountSmallest,
    requiredSwapOutputMist,
    minSuiOut: requiredSwapOutputMist > slippageFloor ? requiredSwapOutputMist : slippageFloor,
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
 *   2. evaluatePaymentSource(...)     → funding result
 *   3. calculateSwapOutputGuards(...) → swap
 *   4. assembleSwapSettlementPlan(input, audit, funding, swap)
 */
export function assembleSwapSettlementPlan(
  input: PlannerInput,
  audit: SettlePlanAuditFields,
  funding: SwapFundingResolution,
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
    funding,
    useCreditAmount,
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
    funding: { source: 'none_credit_only' },
    useCreditAmount,
    swap: { swapAmountSmallest: 0n, requiredSwapOutputMist: 0n, minSuiOut: 0n },
    audit,
  };
}
