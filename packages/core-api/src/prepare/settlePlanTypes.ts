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
 * (settlePayloadContract.ts), on-chain types (types.ts), or persisted store types
 * (prepareTypes.ts).
 */

import type {
  SettleProfile,
  SingleHopSettlementSwapPath,
  SettlementSwapDirection,
} from '@stelis/contracts';
import type { PaymentInputSource } from '@stelis/core-relay/server';

// ─────────────────────────────────────────────
// PrefixUsage — user TX prefix coin provenance
// ─────────────────────────────────────────────

/**
 * Canonical representation of user PTB prefix coin state.
 *
 * Extracted from the deserialized user TX before any settlement
 * suffix is appended. Used by the planner to determine which coins
 * are available for payment (R-9 compliance) and how much address
 * balance the prefix already consumed.
 */
export interface PrefixUsage {
  /** Coins that survive the user prefix (MergeCoins targets, still alive). */
  readonly survivors: Set<string>;
  /** Coins consumed by user TX commands. */
  readonly consumed: Set<string>;
  /** Result-backed objects (opaque, may not be coins). */
  readonly opaqueInUse: Set<string>;
  /**
   * All SplitCoins source coins after precedence pruning. Payment-token
   * selection may admit the narrower `reusableSplitSources` subset, while
   * conservative paths may still exclude the whole set.
   */
  readonly mutated: Set<string>;
  /**
   * Narrow additive subset of direct-input SplitCoins sources that remain
   * structurally eligible for the narrow payment-token safe-reuse policy.
   */
  readonly reusableSplitSources: Set<string>;
  /** MergeCoins destination → source IDs mapping for merge credit calculation. */
  readonly mergeDestToSources: Map<string, Set<string>>;
  /** Address-balance amount consumed by prefix FundsWithdrawal commands. */
  readonly prefixAbConsumed: bigint;
}

// ─────────────────────────────────────────────
// FundingPlan — payment source decision
// ─────────────────────────────────────────────

/**
 * Explicit funding-source decision made by the planner.
 *
 * Pure decision that the compiler consumes without re-querying.
 */
export interface FundingPlan {
  /** Which payment pathway to use. */
  readonly source: PaymentInputSource;
  /** Coins available for payment (after R-9 exclusion). */
  readonly usableCoins: ReadonlyArray<{ objectId: string; balance: string }>;
  /** Total balance of usable coins (including merge credit). */
  readonly usableCoinTotal: bigint;
  /** Address balance available (after prefix FundsWithdrawal deduction). */
  readonly addressBalance: bigint;
  /** Amount to redeem from address balance (0 for coin_object path). */
  readonly redeemDelta: bigint;
  /** Vault credit to apply (0 for new_user or when credit insufficient). */
  readonly useCreditAmount: bigint;
}

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
  /** Minimum SUI output (slippage guard). */
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
 * The compiler does perform coin object discovery (listCoins) because
 * coin selection is tightly coupled with PTB mutation (merge/split).
 * However, the funding source priority (coin_object vs address_balance
 * vs mixed_topup) is determined by the planner and the compiler
 * follows plan.funding.source without re-deciding.
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
  readonly funding: FundingPlan;
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
 * and passed through to the PTB compiler without modification.
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
