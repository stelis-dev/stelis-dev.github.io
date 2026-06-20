import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { convertSdkCommands } from './convert.js';
import { ParseSettleArgsError, parseSettleArgs } from './parseSettleArgs.js';
import { findSettleCommand } from './settleCommand.js';
import { fail, ok } from './types.js';
import type { SettleArgs, ValidationResult } from './types.js';

export interface SettleTransactionFields {
  settleFunction: string;
  executionCostClaimMist: bigint;
  quotedHostFeeMist: bigint;
  expectedProtocolFeeMist: bigint;
  policyHash: Uint8Array;
  orderIdHash: Uint8Array;
  receiptId: Uint8Array;
  nonce: bigint;
}

export interface ExpectedSettleTransactionFields {
  executionCostClaimMist: bigint;
  quotedHostFeeMist: bigint;
  expectedProtocolFeeMist: bigint;
  policyHash: Uint8Array;
  orderIdHash: Uint8Array;
}

export class SettleTransactionFieldsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettleTransactionFieldsError';
  }
}

function projectSettleFields(settleFunction: string, args: SettleArgs): SettleTransactionFields {
  return {
    settleFunction,
    executionCostClaimMist: args.executionCostClaim,
    quotedHostFeeMist: args.quotedHostFeeMist,
    expectedProtocolFeeMist: args.expectedProtocolFeeMist,
    policyHash: args.policyHash,
    orderIdHash: args.orderIdHash,
    receiptId: args.receiptId,
    nonce: args.nonce,
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Compare extracted settle fields against values the caller expected from
 * the prepare response.
 */
export function validateSettleTransactionFields(
  actual: SettleTransactionFields,
  expected: ExpectedSettleTransactionFields,
): ValidationResult {
  if (actual.executionCostClaimMist !== expected.executionCostClaimMist) {
    return fail(
      'SETTLE_EXECUTION_COST_CLAIM_MISMATCH',
      `executionCostClaimMist ${actual.executionCostClaimMist} != expected ${expected.executionCostClaimMist}`,
    );
  }
  if (actual.quotedHostFeeMist !== expected.quotedHostFeeMist) {
    return fail(
      'SETTLE_HOST_FEE_MISMATCH',
      `quotedHostFeeMist ${actual.quotedHostFeeMist} != expected ${expected.quotedHostFeeMist}`,
    );
  }
  if (actual.expectedProtocolFeeMist !== expected.expectedProtocolFeeMist) {
    return fail(
      'SETTLE_PROTOCOL_FEE_MISMATCH',
      `expectedProtocolFeeMist ${actual.expectedProtocolFeeMist} != expected ${expected.expectedProtocolFeeMist}`,
    );
  }
  if (!sameBytes(actual.policyHash, expected.policyHash)) {
    return fail('SETTLE_POLICY_HASH_MISMATCH', 'policyHash does not match expected value');
  }
  if (!sameBytes(actual.orderIdHash, expected.orderIdHash)) {
    return fail('SETTLE_ORDER_ID_HASH_MISMATCH', 'orderIdHash does not match expected value');
  }
  return ok();
}

/**
 * Extract execution-critical settle fields from transaction command data.
 *
 * This function throws on any missing or malformed field. Callers must treat
 * `SettleTransactionFieldsError` as validation failure.
 */
export function extractSettleTransactionFieldsFromData(
  commands: unknown[],
  inputs: unknown[],
  packageId: string,
): SettleTransactionFields {
  try {
    const normalizedCommands = convertSdkCommands(commands);
    const settleCommand = findSettleCommand(normalizedCommands, packageId);
    if (!settleCommand) {
      throw new SettleTransactionFieldsError('No settle function found in transaction');
    }

    const settleArgs = parseSettleArgs(normalizedCommands, inputs, packageId);
    return projectSettleFields(settleCommand.function, settleArgs);
  } catch (err) {
    if (err instanceof SettleTransactionFieldsError) throw err;
    if (err instanceof ParseSettleArgsError) {
      throw new SettleTransactionFieldsError(err.message);
    }
    throw err;
  }
}

/**
 * Extract execution-critical settle fields from base64 transaction bytes.
 *
 * Full transaction bytes are parsed first. TransactionKind bytes are accepted
 * for callers that validate before gas data is attached.
 */
export function extractSettleTransactionFieldsFromTxBytes(
  txBytesBase64: string,
  packageId: string,
): SettleTransactionFields {
  try {
    const txBytes = fromBase64(txBytesBase64);
    let tx: Transaction;
    try {
      tx = Transaction.from(txBytes);
    } catch {
      tx = Transaction.fromKind(txBytes);
    }
    const data = tx.getData() as { commands: unknown[]; inputs: unknown[] };
    return extractSettleTransactionFieldsFromData(data.commands, data.inputs, packageId);
  } catch (err) {
    if (err instanceof SettleTransactionFieldsError) throw err;
    throw new SettleTransactionFieldsError('Could not parse transaction bytes');
  }
}
