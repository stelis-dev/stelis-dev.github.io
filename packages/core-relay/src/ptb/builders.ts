/**
 * Settle PTB Builders — server-side Host settle command construction.
 *
 * The Host builds settle commands server-side.
 *
 * Functions:
 *   buildSwapAndSettlePtb()    — swap settlement token → SUI + settle
 *   buildSettleWithCreditPtb() — vault credit only settlement
 *
 * buildWithdrawPtb() stays in sdk/src/ptb.ts — user operation.
 */
import {
  Transaction,
  type TransactionArgument,
  type TransactionObjectArgument,
} from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '../constants.js';
import {
  SETTLE_FIELD_SCHEMA,
  SETTLEMENT_ENTRY_FUNCTIONS,
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
  SETTLE_MODULE,
  SETTLE_WITH_CREDIT_FUNCTION,
  type SettleFieldValues,
} from '@stelis/contracts';
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

function requireCompiledU64BigInt(name: string, value: unknown): bigint {
  if (typeof value !== 'bigint') {
    throw new Error(`${name} must be a bigint for compiled Move u64`);
  }
  return value;
}

// ─────────────────────────────────────────────
// buildSwapAndSettlePtb — single MoveCall
//   Swap settlement token → SUI → settle atomically.
//   Enables arbitrary MoveCall commands in the same PTB.
// ─────────────────────────────────────────────

/** Single-hop settlement swap path fields. */
export type SettlementSwapPathFields = {
  settlementSwapDirection: SettlementSwapDirection;
  /** Move entry type parameter: settlement token. */
  settlementTokenType: string;
  /** DeepBook pool shared object ID. */
  poolId: string;
};

/** Common params for swap_and_settle (both variants) */
export type SwapAndSettleCommonParams = SettlementSwapPathFields & SwapAndSettleSharedParams;

interface SwapAndSettleSharedParams {
  packageId: string;
  configId: string;
  vaultRegistryId: string;

  /** Settlement token coin object ID */
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
  quoteTimestampMs: bigint;
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
 * Build the settle Pure args by iterating SETTLE_FIELD_SCHEMA.
 *
 * Single assembly source for both swap and credit builders.
 * Field order is driven by the compiled schema for both builder functions.
 */
function buildSettlePureArgs(tx: Transaction, values: SettleFieldValues) {
  for (const field of SETTLE_FIELD_SCHEMA) {
    if (field.moveType === 'u64') {
      requireCompiledU64BigInt(field.name, values[field.name]);
    }
  }

  return new Map<string, TransactionArgument>(
    SETTLE_FIELD_SCHEMA.map((field) => {
      const v = values[field.name];
      switch (field.moveType) {
        case 'u64':
          return [field.moveName, tx.pure.u64(v as bigint)] as const;
        case 'address':
          return [field.moveName, tx.pure.address(v as string)] as const;
        case 'vector<u8>':
          return [field.moveName, tx.pure.vector('u8', Array.from(v as Uint8Array))] as const;
      }
    }),
  );
}

/** Order named arguments exactly as the compiled production function declares them. */
function orderCompiledSettleArguments(
  functionName: string,
  argumentsByName: ReadonlyMap<string, TransactionArgument>,
  typeArgumentCount: number,
): TransactionArgument[] {
  const entry = (
    SETTLEMENT_ENTRY_FUNCTIONS as Readonly<
      Record<string, (typeof SETTLEMENT_ENTRY_FUNCTIONS)[keyof typeof SETTLEMENT_ENTRY_FUNCTIONS]>
    >
  )[functionName];
  if (!entry) throw new Error(`Unsupported compiled settlement function ${functionName}`);
  if (entry.typeParameters.length !== typeArgumentCount) {
    throw new Error(
      `Compiled settlement function ${functionName} requires ${entry.typeParameters.length} type arguments, got ${typeArgumentCount}`,
    );
  }

  return entry.parameters.map((parameter) => {
    const argument = argumentsByName.get(parameter.name);
    if (!argument) {
      throw new Error(
        `No builder argument for compiled parameter ${functionName}.${parameter.name}: ${parameter.moveType}`,
      );
    }
    return argument;
  });
}

/**
 * Builds a single-MoveCall PTB that atomically:
 *   1. Swaps settlement token → SUI via DeepBook
 *   2. Settles: validates vault, deducts host fees, deposits surplus
 *
 * settlementSwapDirection determines which Move function suffix to call
 * (`_bfq` for `baseForQuote`, `_qfb` for `quoteForBase`).
 * settlementTokenType becomes the Move entry's single type parameter.
 */
export function buildSwapAndSettlePtb(tx: Transaction, params: SwapAndSettleParams): void {
  validateSettleInput(params);

  const swapAmount = requireCompiledU64BigInt('swapAmount', params.swapAmount);
  const minSuiOut = requireCompiledU64BigInt('minSuiOut', params.minSuiOut);
  const useCreditAmount =
    params.variant === 'with_vault'
      ? requireCompiledU64BigInt('useCreditAmount', params.useCreditAmount ?? 0n)
      : 0n;

  // Resolve target function name from settlementSwapDirection + variant
  const directionFunctions = SETTLEMENT_SWAP_DIRECTION_FUNCTIONS[params.settlementSwapDirection];
  const fnName =
    params.variant === 'new_user' ? directionFunctions.newUser : directionFunctions.withVault;

  const typeArguments = [params.settlementTokenType];
  const argumentsByName = buildSettlePureArgs(tx, params);
  argumentsByName.set('config', tx.object(params.configId));
  argumentsByName.set('registry', tx.object(params.vaultRegistryId));
  argumentsByName.set('clock', tx.object(SUI_CLOCK_OBJECT_ID));
  argumentsByName.set('pool', tx.object(params.poolId));
  argumentsByName.set('payment_coin', toObjArg(tx, params.paymentCoinId));
  argumentsByName.set('swap_amount', tx.pure.u64(swapAmount));
  argumentsByName.set('min_sui_out', tx.pure.u64(minSuiOut));
  if (params.variant === 'with_vault') {
    argumentsByName.set('user_vault', tx.object(params.vaultId));
    argumentsByName.set('use_credit_amount', tx.pure.u64(useCreditAmount));
  }
  const moveArgs = orderCompiledSettleArguments(fnName, argumentsByName, typeArguments.length);

  tx.moveCall({
    target: `${params.packageId}::${SETTLE_MODULE}::${fnName}`,
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
  quoteTimestampMs: bigint;
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
  const useCreditAmount = requireCompiledU64BigInt('useCreditAmount', params.useCreditAmount);

  const argumentsByName = buildSettlePureArgs(tx, params);
  argumentsByName.set('config', tx.object(params.configId));
  argumentsByName.set('registry', tx.object(params.vaultRegistryId));
  argumentsByName.set('clock', tx.object(SUI_CLOCK_OBJECT_ID));
  argumentsByName.set('user_vault', tx.object(params.vaultId));
  argumentsByName.set('use_credit_amount', tx.pure.u64(useCreditAmount));
  const typeArguments: string[] = [];

  tx.moveCall({
    target: `${params.packageId}::${SETTLE_MODULE}::${SETTLE_WITH_CREDIT_FUNCTION}`,
    typeArguments,
    arguments: orderCompiledSettleArguments(
      SETTLE_WITH_CREDIT_FUNCTION,
      argumentsByName,
      typeArguments.length,
    ),
  });
}
