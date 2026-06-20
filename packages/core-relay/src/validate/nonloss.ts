/**
 * Layer 3: Sponsor-time nonloss math validation
 *
 * `validateNonlossSponsor` is the public, browser-exported helper consumed
 * by the generic sponsor SponsoredExecutionPolicy. Dust prevention (`totalIn >= minSettleMist`) is
 * not enforced here because `totalIn` is a runtime value that depends on
 * swap execution and is not visible at sponsor time; the on-chain S-3
 * assert (`ETotalInTooLow`) is the dust defense and returns as
 * `SPONSOR_ONCHAIN_FAILED` if it fires.
 *
 * See docs/architecture/pricing-and-validation.md#current-validation-layers.
 */
import type { OnchainConfig, ValidationResult } from '../types.js';
import { ok, fail } from '../types.js';

/**
 * Sponsor-side nonloss context.
 */
export interface SponsorNonlossContext {
  /** Actual gas from preflight simulation */
  simGas: bigint;
  /** Fixed gas variance margin (GAS_VARIANCE_FIXED_MIST constant) */
  gasVarianceFixedMist: bigint;
  /** DEX slippage buffer (0 for credit paths) */
  slippageBufferMist: bigint;
  /** Execution cost claim extracted from hash-bound settle args */
  executionCostClaim: bigint;
  /** TX gas budget from gasData */
  gasBudget: bigint;
}

/**
 * Validates nonloss math for /sponsor.
 *
 * Checks (3 total):
 * 1. executionCostClaim >= simGas + gasVarianceFixedMist + slippageBufferMist  (nonloss guarantee)
 * 2. gasBudget <= config.maxClaimMist     (upper bound alignment, decoupled from executionCostClaim)
 * 3. simGas <= config.maxClaimMist        (range overflow prevention)
 *
 * `gasBudget` may be larger or smaller than `executionCostClaim`: it is the
 * `setGasBudget()` execution cap, not the host revenue. Sui refunds
 * any excess gas. Check 2 still bounds the budget at `maxClaimMist`
 * regardless of the `executionCostClaim` value.
 */
export function validateNonlossSponsor(
  ctx: SponsorNonlossContext,
  config: OnchainConfig,
): ValidationResult {
  const requiredClaim = ctx.simGas + ctx.gasVarianceFixedMist + ctx.slippageBufferMist;

  // 1. Nonloss guarantee
  if (ctx.executionCostClaim < requiredClaim) {
    return fail(
      'L3_NONLOSS_VIOLATION',
      `executionCostClaim (${ctx.executionCostClaim}) < simGas (${ctx.simGas}) + gasVarianceFixedMist (${ctx.gasVarianceFixedMist}) + slippageBufferMist (${ctx.slippageBufferMist})`,
    );
  }

  // 2. Gas budget upper bound
  if (ctx.gasBudget > config.maxClaimMist) {
    return fail(
      'L3_GAS_BUDGET_EXCEEDED',
      `gasBudget (${ctx.gasBudget}) > maxClaimMist (${config.maxClaimMist})`,
    );
  }

  // 3. SimGas range overflow prevention
  if (ctx.simGas > config.maxClaimMist) {
    return fail(
      'L3_SIM_GAS_OUT_OF_RANGE',
      `simGas (${ctx.simGas}) > maxClaimMist (${config.maxClaimMist})`,
    );
  }

  return ok();
}
