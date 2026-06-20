/**
 * Settle PTB Builders — server-side (relayer) settle command construction.
 *
 * The relayer builds settle commands server-side.
 *
 * Functions:
 *   buildSwapAndSettlePtb()    — swap payment token → SUI + settle
 *   buildSettleWithCreditPtb() — vault credit only settlement
 *
 * buildWithdrawPtb() stays in sdk/src/ptb.ts — user operation.
 */
import { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '../constants.js';
import {
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
  SETTLE_WITH_CREDIT_FUNCTION,
} from '@stelis/contracts';
import { SETTLE_FIELD_SCHEMA, type SettleFieldValues } from '../settlePayloadContract.js';
import type { SettlementSwapDirection } from '@stelis/contracts';

// ─────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────

/**
 * S-10: Validate settle input params early for better DX.
 * Matches on-chain constraints in settle.move.
 */
function validateSettleInput(params: {
  receiptId: Uint8Array;
  policyHash: Uint8Array;
  orderIdHash: Uint8Array;
  executionCostClaim: bigint;
}): void {
  const pidLen = params.receiptId.length;
  if (pidLen !== 0 && pidLen !== 32) {
    throw new Error(`receiptId must be 0 or 32 bytes, got ${pidLen}`);
  }
  const phLen = params.policyHash.length;
  if (phLen !== 0 && phLen !== 32) {
    throw new Error(`policyHash must be 0 or 32 bytes, got ${phLen}`);
  }
  const oidLen = params.orderIdHash.length;
  if (oidLen !== 0 && oidLen !== 32) {
    throw new Error(`orderIdHash must be 0 or 32 bytes, got ${oidLen}`);
  }
  if (params.executionCostClaim < 0n) {
    throw new Error(`executionCostClaim must be non-negative, got ${params.executionCostClaim}`);
  }
}

// ─────────────────────────────────────────────
// buildSwapAndSettlePtb — single MoveCall
//   Swap payment token → SUI → settle atomically.
//   Enables arbitrary MoveCall commands in the same PTB.
// ─────────────────────────────────────────────

/** Single-hop settlement swap path fields. */
export type SettlementSwapPathFields = {
  settlementSwapDirection: SettlementSwapDirection;
  /** Move entry type parameter: payment token. */
  paymentTokenType: string;
  /** DeepBook pool shared object ID. */
  poolId: string;
};

/** Common params for swap_and_settle (both variants) */
export type SwapAndSettleCommonParams = SettlementSwapPathFields & SwapAndSettleSharedParams;

interface SwapAndSettleSharedParams {
  packageId: string;
  configId: string;
  vaultRegistryId: string;

  /** Payment token coin object ID */
  paymentCoinId: string | TransactionObjectArgument;
  /** Exact base amount to swap (on-chain u64) */
  swapAmount: bigint;
  /** Minimum SUI output (0 = no slippage guard, on-chain u64) */
  minSuiOut: bigint;
  executionCostClaim: bigint;
  settlementPayoutRecipient: string;
  receiptId: Uint8Array;
  /** S-14: monotonic nonce for on-chain replay prevention */
  nonce: bigint;
  simGasReported: bigint;
  gasVarianceFixedMist: bigint;
  slippageBufferMist: bigint;
  /** Host-quoted fee (MIST) — exact value embedded in PTB. */
  quotedHostFeeMist: bigint;
  /** Expected on-chain protocol fee at quote time — tamper detection. */
  expectedProtocolFeeMist: bigint;
  /** Expected config_version at quote time — drift detection. */
  expectedConfigVersion: bigint;
  quoteTimestampMs: number;
  policyHash: Uint8Array;
  /** sha256(orderId) if provided, empty otherwise. On-chain S-10b: 0 or 32 bytes. */
  orderIdHash: Uint8Array;
}

/** Existing user: vault-backed swap settlement plus optional credit */
export type SwapAndSettleWithVaultParams = SwapAndSettleCommonParams & {
  vaultId: string;
  useCreditAmount?: bigint;
};

export type SwapAndSettleParams =
  | (SwapAndSettleCommonParams & { variant: 'new_user' })
  | (SwapAndSettleWithVaultParams & { variant: 'with_vault' });

/**
 * Coerce string | TransactionObjectArgument → tx.object() argument.
 * Shared utility for PTB builders that accept both string objectIds
 * and pre-constructed TransactionObjectArguments (e.g., splitCoins results).
 */
const toObjArg = (tx: Transaction, id: string | TransactionObjectArgument) =>
  typeof id === 'string' ? tx.object(id) : id;

/**
 * Build the 13 settle Pure args by iterating SETTLE_FIELD_SCHEMA.
 *
 * Single assembly source for both swap and credit builders.
 * Field order is driven by the canonical schema — not by manual push order.
 * This eliminates push-order drift between the two builder functions.
 */
function buildSettlePureArgs(tx: Transaction, values: SettleFieldValues) {
  return SETTLE_FIELD_SCHEMA.map((field) => {
    const v = values[field.name];
    switch (field.moveType) {
      case 'u64':
        return tx.pure.u64(v as bigint | number);
      case 'address':
        return tx.pure.address(v as string);
      case 'vector<u8>':
        return tx.pure.vector('u8', Array.from(v as Uint8Array));
    }
  });
}

/**
 * Builds a single-MoveCall PTB that atomically:
 *   1. Swaps payment token → SUI via DeepBook
 *   2. Settles: validates vault, deducts host fees, deposits surplus
 *
 * settlementSwapDirection determines which Move function suffix to call
 * (`_bfq` for `baseForQuote`, `_qfb` for `quoteForBase`).
 * paymentTokenType becomes the Move entry's single type parameter.
 */
export function buildSwapAndSettlePtb(tx: Transaction, params: SwapAndSettleParams): void {
  validateSettleInput(params);

  // Resolve target function name from settlementSwapDirection + variant
  const directionFunctions = SETTLEMENT_SWAP_DIRECTION_FUNCTIONS[params.settlementSwapDirection];
  const fnName =
    params.variant === 'new_user' ? directionFunctions.newUser : directionFunctions.withVault;

  const commonArgs = [
    tx.object(params.configId),
    tx.object(params.vaultRegistryId),
    tx.object(SUI_CLOCK_OBJECT_ID),
  ];

  const settleArgs = buildSettlePureArgs(tx, params);

  const typeArguments = [params.paymentTokenType];

  const swapArgs = [
    tx.object(params.poolId),
    toObjArg(tx, params.paymentCoinId),
    tx.pure.u64(params.swapAmount),
    tx.pure.u64(params.minSuiOut),
  ];

  const moveArgs =
    params.variant === 'new_user'
      ? [...commonArgs, ...swapArgs, ...settleArgs]
      : [
          ...commonArgs,
          tx.object(params.vaultId),
          ...swapArgs,
          ...settleArgs,
          tx.pure.u64(params.useCreditAmount ?? 0n),
        ];

  tx.moveCall({
    target: `${params.packageId}::settle::${fnName}`,
    typeArguments,
    arguments: moveArgs,
  });
}

// ─────────────────────────────────────────────
// Credit-only settlement PTB builder
// ─────────────────────────────────────────────

export interface SettleWithCreditPtbParams {
  packageId: string;
  configId: string;
  vaultRegistryId: string;
  vaultId: string;
  /** Amount of credit (MIST) to withdraw from vault for settlement (on-chain u64) */
  useCreditAmount: bigint;
  executionCostClaim: bigint;
  settlementPayoutRecipient: string;
  receiptId: Uint8Array;
  /** S-14: monotonic nonce for on-chain replay prevention */
  nonce: bigint;
  simGasReported: bigint;
  gasVarianceFixedMist: bigint;
  slippageBufferMist: bigint;
  /** Host-quoted fee (MIST) — exact value embedded in PTB. */
  quotedHostFeeMist: bigint;
  /** Expected on-chain protocol fee at quote time — tamper detection. */
  expectedProtocolFeeMist: bigint;
  /** Expected config_version at quote time — drift detection. */
  expectedConfigVersion: bigint;
  quoteTimestampMs: number;
  policyHash: Uint8Array;
  /** sha256(orderId) if provided, empty otherwise. On-chain S-10b: 0 or 32 bytes. */
  orderIdHash: Uint8Array;
}

/**
 * Builds the credit-only settlement MoveCall: no swap, vault credit only.
 */
export function buildSettleWithCreditPtb(tx: Transaction, params: SettleWithCreditPtbParams): void {
  validateSettleInput(params);
  if (params.slippageBufferMist !== 0n) {
    throw new Error(
      `${SETTLE_WITH_CREDIT_FUNCTION} requires slippageBufferMist=0, got ${params.slippageBufferMist}`,
    );
  }

  const prefixArgs = [
    tx.object(params.configId),
    tx.object(params.vaultRegistryId),
    tx.object(SUI_CLOCK_OBJECT_ID),
    tx.object(params.vaultId),
    tx.pure.u64(params.useCreditAmount),
  ];

  const settleArgs = buildSettlePureArgs(tx, params);

  tx.moveCall({
    target: `${params.packageId}::settle::${SETTLE_WITH_CREDIT_FUNCTION}`,
    arguments: [...prefixArgs, ...settleArgs],
  });
}
