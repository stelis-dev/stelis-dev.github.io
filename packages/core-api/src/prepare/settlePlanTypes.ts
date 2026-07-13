/**
 * settlePlanTypes — explicit internal planning types for the prepare pipeline.
 *
 * Explicit intermediate state for the prepare pipeline. Making them explicit enables:
 *   - Separation of planning (pure calculation) from compilation (PTB mutation)
 *   - Testability of planning logic without chain state or PTB construction
 *   - Clear boundaries between I/O (market queries) and computation
 *
 * Consumers:
 *   - SettlementPlanner (produces SettlementPlan from config + market + credit state)
 *   - PtbCompiler (consumes SettlementPlan to produce PTB mutations)
 *   - runGenericPrepareBuildPipeline orchestrator (coordinates multi-pass flow)
 *
 * Does not own: settlement swap direction tables (constants.ts), settle field schema
 * (the generated `@stelis/contracts` settlement contract), on-chain types
 * (types.ts), or persisted store types
 * (prepareTypes.ts).
 */

import type {
  SettleProfile,
  SingleHopSettlementSwapPath,
  SettlementSwapDirection,
} from '@stelis/contracts';
import type { PaymentInputSource } from '@stelis/core-relay/server';

// ─────────────────────────────────────────────
// FundingResolution — exact payment materialization
// ─────────────────────────────────────────────

/**
 * Exact funding selected from one prefix-value trace and one chain discovery.
 * The compiler materializes these IDs and amounts without querying or selecting.
 */
export type SwapFundingResolution =
  | {
      readonly source: 'coin_object';
      readonly baseCoinId: string;
      readonly mergeCoinIds: readonly string[];
      /** Exact balance after the user prefix and planned merges, before the Host split. */
      readonly remainingBalance: bigint;
    }
  | {
      readonly source: 'address_balance';
      readonly redeemAmount: bigint;
    }
  | {
      readonly source: 'mixed_topup';
      readonly baseCoinId: string;
      readonly mergeCoinIds: readonly string[];
      /** Exact balance after the user prefix and planned object merges. */
      readonly remainingBalance: bigint;
      readonly redeemAmount: bigint;
    };

export type FundingResolution = { readonly source: 'none_credit_only' } | SwapFundingResolution;

// ─────────────────────────────────────────────
// SwapPlan — swap amount and guard calculations
// ─────────────────────────────────────────────

/**
 * Swap-specific planning outputs.
 *
 * All amounts are in smallest token units (MIST for SUI, micro for tokens).
 * For credit-only paths, swapAmountSmallest is 0n and guards are unused.
 */
export interface SwapPlan {
  /** Exact settlement token amount to swap (after direction-aware DeepBook min/lot constraints). */
  readonly swapAmountSmallest: bigint;
  /** Minimum SUI output required for settlement sufficiency. */
  readonly requiredSwapOutputMist: bigint;
  /** Final on-chain minimum SUI output (settlement sufficiency and slippage guard). */
  readonly minSuiOut: bigint;
}

// ─────────────────────────────────────────────
// SettlementPlan — complete planning output
// ─────────────────────────────────────────────

/**
 * Complete, fully-determined settlement plan.
 *
 * Produced by SettlementPlanner, consumed by PtbCompiler.
 * The compiler must not re-derive settlement swap path shape, swap amounts, or
 * funding-source decisions from chain state — those are in this plan.
 *
 * Funding object discovery and selection are complete before this type is
 * assembled. The compiler only materializes `funding`.
 */
export interface SettlementPlan {
  /** Settle profile (credit_general | with_vault | new_user). */
  readonly profile: SettleProfile;
  /**
   * On-chain function variant (swap-path only; undefined for credit path).
   * Set by assembleSwapSettlementPlan; absent for assembleCreditSettlementPlan.
   * Compiler reads plan.variant without re-deriving from profile + vaultObjectId.
   */
  readonly variant?: 'new_user' | 'with_vault';
  /** Settlement swap path configuration (pool hops, token types, swap directions). */
  readonly settlementSwapPath: SingleHopSettlementSwapPath;
  /** Settlement swap direction string for function name resolution. */
  readonly settlementSwapDirection: SettlementSwapDirection;
  /** Funding-source decision. */
  readonly funding: FundingResolution;
  /** Existing User Vault credit applied by the selected settlement variant. */
  readonly useCreditAmount: bigint;
  /** Swap calculation outputs (amounts and guards). */
  readonly swap: SwapPlan;
  /** Audit fields for settle_core. */
  readonly audit: SettlePlanAuditFields;
}

/**
 * Audit fields embedded in the settle PTB.
 *
 * These are the 13 fields from SETTLE_FIELD_SCHEMA, plus the
 * settlement payout recipient address. All values are determined at plan time
 * without being re-decided by the PTB compiler. The JSON-facing timestamp is
 * checked and converted to the compiled u64 bigint representation there.
 */
export interface SettlePlanAuditFields {
  readonly executionCostClaim: bigint;
  readonly settlementPayoutRecipient: string;
  readonly receiptId: Uint8Array;
  readonly nonce: bigint;
  readonly simGasReported: bigint;
  readonly gasVarianceFixedMist: bigint;
  readonly slippageBufferMist: bigint;
  readonly quotedHostFeeMist: bigint;
  readonly expectedProtocolFeeMist: bigint;
  readonly expectedConfigVersion: bigint;
  readonly quoteTimestampMs: number;
  readonly policyHash: Uint8Array;
  readonly orderIdHash: Uint8Array;
}

// ─────────────────────────────────────────────
// CompiledPreparePtb — compiler output
// ─────────────────────────────────────────────

/**
 * Output of the PtbCompiler.
 *
 * Contains the materialized transaction bytes and all metrics needed
 * for the prepare response and store entry.
 */
export interface CompiledPreparePtb {
  /** Serialized transaction bytes (ready for signing). */
  readonly txBytes: Uint8Array;
  /** SHA-256 hex hash of txBytes (tamper-proof tracking). */
  readonly txBytesHash: string;
  /** Settlement profile used. */
  readonly profile: SettleProfile;
  /** Payment source actually used. */
  readonly paymentInputSource: PaymentInputSource;
}
