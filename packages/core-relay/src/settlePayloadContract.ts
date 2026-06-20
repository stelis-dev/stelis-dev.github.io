/**
 * settlePayloadContract — settlement payload transport contract.
 *
 * Defines the transport-level layout that builder, parser, validator, and cost
 * extractor share. Every production settlement entry in SETTLE_FUNCTIONS uses
 * the same 13-field settle block in the same relative order; only the prefix
 * length varies by variant class.
 *
 * This module is a metadata leaf: it must not import from builder, parser, or
 * validator files. Only pure TypeScript types and static constants.
 *
 * Consumers:
 *   - parseSettleArgs.ts       — derives ARG_INDEX_MAP from variant layouts
 *   - settleArgsCost.ts        — transitively via ARG_INDEX_MAP
 *   - builders.ts              — iterates SETTLE_FIELD_SCHEMA via buildSettlePureArgs()
 *   - extractSettleArgs.ts     — transitively via parseSettleArgs
 *   - paymentInputIntegrity.ts — variantClassFromFnName + VARIANT_LAYOUTS
 *
 * Not exported via index.ts / browser.ts (internal-only module).
 */
import {
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
  SETTLE_WITH_CREDIT_FUNCTION,
} from '@stelis/contracts';

// ─────────────────────────────────────────────
// Settle field schema
// ─────────────────────────────────────────────

/** Field name in the settle block. */
export type SettleFieldName =
  | 'executionCostClaim'
  | 'settlementPayoutRecipient'
  | 'receiptId'
  | 'nonce'
  | 'simGasReported'
  | 'gasVarianceFixedMist'
  | 'slippageBufferMist'
  | 'quotedHostFeeMist'
  | 'expectedProtocolFeeMist'
  | 'expectedConfigVersion'
  | 'quoteTimestampMs'
  | 'policyHash'
  | 'orderIdHash';

/** Settle field descriptor: name, Move type, and relative offset within the settle block. */
export interface SettleFieldDescriptor {
  readonly name: SettleFieldName;
  readonly moveType: 'u64' | 'address' | 'vector<u8>';
  /** Offset relative to the start of the settle block (0-based). */
  readonly offset: number;
}

/**
 * The 13 settle fields in Move argument order.
 *
 * Shared reference for the relative ordering of settlement
 * arguments across all production settlement variants. The absolute argument
 * index varies by variant (due to different prefix lengths), but the
 * relative order within the settle block never changes.
 *
 * Matches settle.move settle_core() parameter order:
 *   execution_cost_claim_mist, settlement_payout_recipient, receipt_id, nonce,
 *   sim_gas_reported, gas_variance_fixed_mist, slippage_buffer_mist,
 *   quoted_host_fee_mist, expected_protocol_fee_mist,
 *   expected_config_version, quote_timestamp_ms,
 *   policy_hash, order_id_hash
 */
export const SETTLE_FIELD_SCHEMA: readonly SettleFieldDescriptor[] = [
  { name: 'executionCostClaim', moveType: 'u64', offset: 0 },
  { name: 'settlementPayoutRecipient', moveType: 'address', offset: 1 },
  { name: 'receiptId', moveType: 'vector<u8>', offset: 2 },
  { name: 'nonce', moveType: 'u64', offset: 3 },
  { name: 'simGasReported', moveType: 'u64', offset: 4 },
  { name: 'gasVarianceFixedMist', moveType: 'u64', offset: 5 },
  { name: 'slippageBufferMist', moveType: 'u64', offset: 6 },
  { name: 'quotedHostFeeMist', moveType: 'u64', offset: 7 },
  { name: 'expectedProtocolFeeMist', moveType: 'u64', offset: 8 },
  { name: 'expectedConfigVersion', moveType: 'u64', offset: 9 },
  { name: 'quoteTimestampMs', moveType: 'u64', offset: 10 },
  { name: 'policyHash', moveType: 'vector<u8>', offset: 11 },
  { name: 'orderIdHash', moveType: 'vector<u8>', offset: 12 },
] as const;

/** Total number of settle fields. */
export const SETTLE_FIELD_COUNT = 13;

/**
 * TypeScript value types for the 13 settle fields, keyed by canonical field name.
 *
 * Both builder params and parser output use these same property names.
 * Builder param interfaces (SwapAndSettleSharedParams, SettleWithCreditPtbParams)
 * structurally satisfy this interface so params can be passed directly to
 * buildSettlePureArgs().
 */
export interface SettleFieldValues {
  executionCostClaim: bigint;
  settlementPayoutRecipient: string;
  receiptId: Uint8Array;
  nonce: bigint;
  simGasReported: bigint;
  gasVarianceFixedMist: bigint;
  slippageBufferMist: bigint;
  quotedHostFeeMist: bigint;
  expectedProtocolFeeMist: bigint;
  expectedConfigVersion: bigint;
  quoteTimestampMs: number | bigint;
  policyHash: Uint8Array;
  orderIdHash: Uint8Array;
}

/**
 * Named offsets for each settle field (derived from SETTLE_FIELD_SCHEMA).
 * Use these instead of magic numbers when computing absolute arg indices.
 */
export const FIELD_OFFSET: Readonly<Record<SettleFieldName, number>> = Object.fromEntries(
  SETTLE_FIELD_SCHEMA.map((f) => [f.name, f.offset]),
) as Record<SettleFieldName, number>;

// ─────────────────────────────────────────────
// Variant class and layout
// ─────────────────────────────────────────────

/**
 * Variant class: groups settle function names by arg layout structure.
 *
 * bfq and qfb share the same layout within each class (pool type differs,
 * but argument positions are identical). The split is due to Move type system
 * constraints (Pool<Base,SUI> vs Pool<SUI,Quote> and swap_exact_base_for_quote
 * vs swap_exact_quote_for_base), not argument layout differences.
 */
export type SettleVariantClass = 'new_user' | 'with_vault' | 'credit';

/** Prefix structure for a variant class. */
export interface VariantPrefixLayout {
  /**
   * Absolute arg index where the 13-field settle block begins.
   *
   * Prefix composition per variant:
   *   new_user:   common(3) + pool(1) + payment_coin(1) + swap_pures(2) = 7
   *   with_vault: common(3) + vault(1) + pool(1) + payment_coin(1) + swap_pures(2) = 8
   *   credit:     common(3) + vault(1) + use_credit(1) = 5
   */
  readonly settleStartIndex: number;
  /** Absolute indices of pool object arguments. Empty for credit. */
  readonly poolIndices: readonly number[];
  /** Whether a UserVault object arg exists in the prefix (index 3 when present). */
  readonly hasVault: boolean;
  /** Whether use_credit_amount is appended as a tail arg after the settle block. */
  readonly hasTailCredit: boolean;
  /**
   * Absolute index of the payment_coin arg. Undefined for credit (no swap).
   * Layout: immediately after the last pool (lastPoolIndex + 1).
   */
  readonly paymentCoinIndex?: number;
  /**
   * Absolute index of the swap_amount arg. Undefined for credit (no swap).
   * Layout: payment_coin(+0) + swap_amount(+1) = paymentCoinIndex + 1.
   * (DEEP fee coin is created inside the Move entrypoint, not passed as a PTB argument.)
   */
  readonly swapAmountIndex?: number;
}

/**
 * Canonical layout table for all 3 variant classes.
 *
 * Each entry is verified against settle.move entrypoint signatures:
 *   - common args: config(0), registry(1), clock(2) — always at 0,1,2
 *   - vault (if present): always at index 3
 *   - pool: immediately after common/vault
 *   - coin args: payment_coin only (DEEP fee coin is created internally by the Move entrypoint)
 *   - swap pures: swap_amount, min_sui_out after coin
 *   - settle block: 13 fields starting at settleStartIndex
 *   - tail credit (if with_vault): use_credit_amount after settle block
 */
export const VARIANT_LAYOUTS: Readonly<Record<SettleVariantClass, VariantPrefixLayout>> = {
  // paymentCoinIndex = lastPoolIndex + 1; swapAmountIndex = paymentCoinIndex + 1
  new_user: {
    settleStartIndex: 7,
    poolIndices: [3],
    hasVault: false,
    hasTailCredit: false,
    paymentCoinIndex: 4,
    swapAmountIndex: 5,
  },
  with_vault: {
    settleStartIndex: 8,
    poolIndices: [4],
    hasVault: true,
    hasTailCredit: true,
    paymentCoinIndex: 5,
    swapAmountIndex: 6,
  },
  credit: { settleStartIndex: 5, poolIndices: [], hasVault: true, hasTailCredit: false },
};

// ─────────────────────────────────────────────
// Function name → variant class mapping
// ─────────────────────────────────────────────

/**
 * Map a settle function name to its SettleVariantClass.
 *
 * Co-located with VARIANT_LAYOUTS because the mapping is pure metadata
 * derived from VARIANT_LAYOUTS and SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.
 * Returns undefined for unknown function names.
 */
export function variantClassFromFnName(fnName: string): SettleVariantClass | undefined {
  if (fnName === SETTLE_WITH_CREDIT_FUNCTION) return 'credit';
  for (const fns of Object.values(SETTLEMENT_SWAP_DIRECTION_FUNCTIONS)) {
    if (fns.newUser === fnName) return 'new_user';
    if (fns.withVault === fnName) return 'with_vault';
  }
  return undefined;
}
