/**
 * parseSettleArgs — shared settle argument parser for core-relay.
 *
 * Extracts SettleArgs from a Transaction's commands+inputs (from tx.getData()).
 * This is the canonical source for:
 *   1. ARG_INDEX_MAP — argument index mapping for all settle function variants
 *   2. parseSettleArgs() — the full extractor, throws ParseSettleArgsError on failure
 *
 * ParseSettleArgsError is a core-relay-native error. Consumers that need
 * other error types (e.g. core-api's PrepareValidationError) should wrap:
 *
 *   try { return parseSettleArgs(commands, inputs, packageId); }
 *   catch (err) {
 *     if (err instanceof ParseSettleArgsError) throw new PrepareValidationError(...)
 *     throw err; // non-parser bugs propagate as-is
 *   }
 */
import { fromBase64, toHex } from '@mysten/sui/utils';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { SettleArgs } from './types.js';
import type { PtbCommand } from '@stelis/contracts';
import {
  SETTLEMENT_ENTRY_FUNCTIONS,
  SETTLE_FIELD_SCHEMA,
  SETTLE_FUNCTIONS,
  SETTLE_WITH_CREDIT_FUNCTION,
  settlementParameterIndex,
  settlementSwapDirectionFromFunctionName,
} from '@stelis/contracts';
import { findSettleCommand } from './settleCommand.js';
import { decodeExactPureU64Base64 } from './decodeU64.js';
import {
  parseSuiArgument,
  parseSuiCallArg,
  projectSuiCallArgObjectId,
  SuiTransactionShapeError,
} from './sui/suiTransactionShape.js';

// ─────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────

/**
 * Thrown by parseSettleArgs on any extraction failure.
 * Consumers (e.g. core-api) map this to their own error type.
 */
export class ParseSettleArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseSettleArgsError';
  }
}

// ─────────────────────────────────────────────
// Argument index mapping — derived from the generated compiled contract
// ─────────────────────────────────────────────

/**
 * Index positions for config, registry, claim, recipient, pool(s), and fee fields
 * within the MoveCall arguments for each settle function variant.
 *
 * Every index is resolved from the compiled parameter descriptors generated in
 * `@stelis/contracts`; no prefix positions are duplicated here.
 */
export interface ArgIndexMap {
  config: number;
  /** registry ObjectId index */
  registry: number;
  claim: number;
  recipient: number;
  pools: number[]; // pool ObjectId argument indices
  /** BCS vector<u8> receipt_id index (S-10) */
  receiptId: number;
  /** S-14: monotonic nonce Pure u64 index (receipt_id + 1) */
  nonce: number;
  /** sim_gas_reported Pure u64 index (audit-trail, S-12) */
  simGasReported: number;
  /** gas_variance_fixed_mist Pure u64 index (audit-trail, S-12) */
  gasVarianceFixedMist: number;
  /** slippage_buffer_mist Pure u64 index (audit-trail, S-12) */
  slippageBufferMist: number;
  quotedHostFee: number; // quoted_host_fee_mist Pure u64 index
  expectedProtocolFee: number; // expected_protocol_fee_mist Pure u64 index
  expectedConfigVersion: number; // expected_config_version Pure u64 index
  /** quote_timestamp_ms Pure u64 index */
  quoteTimestampMs: number;
  policyHash: number; // BCS vector<u8> argument index
  orderIdHash: number; // BCS vector<u8> argument index (S-10b)
}

/**
 * Derive ArgIndexMap from one compiled production settlement function.
 * Covers every field in SETTLE_FIELD_SCHEMA so
 * that sponsor-side logic can derive all execution-critical values from the
 * submitted `txBytes` instead of the off-chain prepare store.
 */
function deriveArgIndexMap(functionName: string): ArgIndexMap {
  const entry = (
    SETTLEMENT_ENTRY_FUNCTIONS as Readonly<
      Record<string, (typeof SETTLEMENT_ENTRY_FUNCTIONS)[keyof typeof SETTLEMENT_ENTRY_FUNCTIONS]>
    >
  )[functionName];
  if (!entry) throw new Error(`Missing compiled settlement function ${functionName}`);

  const requiredParameterIndex = (parameterName: string): number => {
    const index = settlementParameterIndex(functionName, parameterName);
    if (index === undefined) {
      throw new Error(`Compiled settlement function ${functionName} has no ${parameterName}`);
    }
    return index;
  };
  const settleFieldIndex = (fieldName: (typeof SETTLE_FIELD_SCHEMA)[number]['name']): number => {
    const field = SETTLE_FIELD_SCHEMA.find((candidate) => candidate.name === fieldName);
    if (!field) throw new Error(`Compiled settlement schema has no ${fieldName}`);
    return requiredParameterIndex(field.moveName);
  };

  return {
    config: requiredParameterIndex('config'),
    registry: requiredParameterIndex('registry'),
    claim: settleFieldIndex('executionCostClaim'),
    recipient: settleFieldIndex('settlementPayoutRecipient'),
    pools: entry.parameters.flatMap((parameter, index) =>
      parameter.name === 'pool' ? [index] : [],
    ),
    receiptId: settleFieldIndex('receiptId'),
    nonce: settleFieldIndex('nonce'),
    simGasReported: settleFieldIndex('simGasReported'),
    gasVarianceFixedMist: settleFieldIndex('gasVarianceFixedMist'),
    slippageBufferMist: settleFieldIndex('slippageBufferMist'),
    quotedHostFee: settleFieldIndex('quotedHostFeeMist'),
    expectedProtocolFee: settleFieldIndex('expectedProtocolFeeMist'),
    expectedConfigVersion: settleFieldIndex('expectedConfigVersion'),
    quoteTimestampMs: settleFieldIndex('quoteTimestampMs'),
    policyHash: settleFieldIndex('policyHash'),
    orderIdHash: settleFieldIndex('orderIdHash'),
  };
}

// ─── Derived ARG_INDEX_MAP ────────────────────────────────────────
// Built from the compiled parameter list for each supported function.

const _derivedMap: Record<string, ArgIndexMap> = {};
for (const fn of SETTLE_FUNCTIONS) {
  _derivedMap[fn] = deriveArgIndexMap(fn);
}

export const ARG_INDEX_MAP: Record<string, ArgIndexMap> = _derivedMap;

// ─────────────────────────────────────────────
// CallArg helpers — work with raw SDK getData().inputs
// ─────────────────────────────────────────────

interface InputRef {
  $kind: 'Input';
  Input: number;
}

function isInputRef(arg: unknown): arg is InputRef {
  try {
    const current = parseSuiArgument(arg);
    return current.$kind === 'Input';
  } catch {
    return false;
  }
}

function resolveObjectId(arg: unknown, inputs: unknown[]): string {
  if (!isInputRef(arg)) {
    throw new ParseSettleArgsError('Expected Input reference for Object arg');
  }
  if (arg.Input >= inputs.length) {
    throw new ParseSettleArgsError(`Input[${arg.Input}] is not an object`);
  }
  try {
    const current = parseSuiCallArg(inputs[arg.Input], `inputs[${arg.Input}]`);
    const objectId = projectSuiCallArgObjectId(current);
    if (objectId) return objectId;
  } catch (error) {
    if (error instanceof SuiTransactionShapeError) {
      throw new ParseSettleArgsError(error.message);
    }
    throw error;
  }

  throw new ParseSettleArgsError(`Input[${arg.Input}] could not be resolved to an object ID`);
}

function resolvePureBytesBase64(arg: unknown, inputs: unknown[], label: string): string {
  if (!isInputRef(arg)) {
    throw new ParseSettleArgsError(`Expected Input reference for ${label}`);
  }
  if (arg.Input >= inputs.length) {
    throw new ParseSettleArgsError(`Input[${arg.Input}] is not an object`);
  }
  try {
    const input = parseSuiCallArg(inputs[arg.Input], `inputs[${arg.Input}]`);
    if (input.$kind !== 'Pure') {
      throw new ParseSettleArgsError(`Input[${arg.Input}] is not a Pure arg`);
    }
    return input.Pure.bytes;
  } catch (error) {
    if (error instanceof ParseSettleArgsError) throw error;
    if (error instanceof SuiTransactionShapeError) {
      throw new ParseSettleArgsError(error.message);
    }
    throw error;
  }
}

function decodePureU64(arg: unknown, inputs: unknown[]): bigint {
  try {
    return decodeExactPureU64Base64(resolvePureBytesBase64(arg, inputs, 'Pure u64'));
  } catch (error) {
    throw new ParseSettleArgsError(error instanceof Error ? error.message : String(error));
  }
}

function encodeUleb128Length(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return new Uint8Array(bytes);
}

function decodeCanonicalUleb128Length(decoded: Uint8Array): { length: number; offset: number } {
  let vecLen = 0;
  let multiplier = 1;
  let offset = 0;

  for (; offset < decoded.length; offset++) {
    const byte = decoded[offset]!;
    const digit = byte & 0x7f;
    vecLen += digit * multiplier;
    if (vecLen > 0xffffffff) {
      throw new ParseSettleArgsError('Pure vector<u8> length prefix overflows u32');
    }
    if ((byte & 0x80) === 0) {
      offset++;
      const canonical = encodeUleb128Length(vecLen);
      if (canonical.length !== offset) {
        throw new ParseSettleArgsError('Pure vector<u8> length prefix is not canonical ULEB128');
      }
      for (let i = 0; i < canonical.length; i++) {
        if (decoded[i] !== canonical[i]) {
          throw new ParseSettleArgsError('Pure vector<u8> length prefix is not canonical ULEB128');
        }
      }
      return { length: vecLen, offset };
    }
    multiplier *= 128;
    if (offset >= 4) {
      throw new ParseSettleArgsError('Pure vector<u8> length prefix overflows u32');
    }
  }

  throw new ParseSettleArgsError('Pure vector<u8> length prefix is incomplete');
}

function decodePureVectorU8(arg: unknown, inputs: unknown[]): Uint8Array {
  const decoded = fromBase64(resolvePureBytesBase64(arg, inputs, 'Pure vector<u8>'));
  // BCS vector<u8>: ULEB128 length prefix + raw bytes
  if (decoded.length === 0) {
    throw new ParseSettleArgsError('Pure vector<u8> is empty (missing length prefix)');
  }
  const { length: vecLen, offset } = decodeCanonicalUleb128Length(decoded);
  if (offset + vecLen !== decoded.length) {
    throw new ParseSettleArgsError(
      `Pure vector<u8> length ${vecLen} does not match available bytes ${decoded.length - offset}`,
    );
  }
  return decoded.slice(offset, offset + vecLen);
}

function decodePureAddress(arg: unknown, inputs: unknown[]): string {
  const decoded = fromBase64(resolvePureBytesBase64(arg, inputs, 'Pure address'));
  if (decoded.length !== 32) {
    throw new ParseSettleArgsError(`Pure address needs 32 bytes, got ${decoded.length}`);
  }
  return normalizeSuiAddress(toHex(decoded));
}

// ─────────────────────────────────────────────
// Main extractor
// ─────────────────────────────────────────────

/**
 * Extract SettleArgs from a Transaction's commands + inputs (from tx.getData()).
 *
 * All fields are decoded from the built TX — no builder input values used.
 * Throws ParseSettleArgsError on any extraction failure.
 *
 * @param commands  - from tx.getData().commands (PtbCommand[])
 * @param inputs    - from tx.getData().inputs (unknown[])
 * @param packageId - Stelis package ID (for settle function matching)
 */
export function parseSettleArgs(
  commands: PtbCommand[],
  inputs: unknown[],
  packageId: string,
): SettleArgs {
  const settleCmd = findSettleCommand(commands, packageId);
  if (!settleCmd) {
    throw new ParseSettleArgsError('No settle function found in built transaction');
  }

  const fnName = settleCmd.function;
  const indexMap = ARG_INDEX_MAP[fnName];
  if (!indexMap) {
    throw new ParseSettleArgsError(`Unknown settle function: ${fnName}`);
  }

  const entry = (
    SETTLEMENT_ENTRY_FUNCTIONS as Readonly<
      Record<
        string,
        (typeof SETTLEMENT_ENTRY_FUNCTIONS)[keyof typeof SETTLEMENT_ENTRY_FUNCTIONS] | undefined
      >
    >
  )[fnName];
  if (!entry) {
    throw new ParseSettleArgsError(`Missing compiled settlement function: ${fnName}`);
  }
  if (settleCmd.arguments.length !== entry.parameters.length) {
    throw new ParseSettleArgsError(
      `Settle function ${fnName} requires ${entry.parameters.length} arguments, got ${settleCmd.arguments.length}`,
    );
  }
  if (settleCmd.typeArguments.length !== entry.typeParameters.length) {
    throw new ParseSettleArgsError(
      `Settle function ${fnName} requires ${entry.typeParameters.length} type arguments, got ${settleCmd.typeArguments.length}`,
    );
  }

  const args = settleCmd.arguments;

  const configObjectId = resolveObjectId(args[indexMap.config], inputs);

  // Resolve the registry required by every current compiled settlement entry.
  const registryObjectId = resolveObjectId(args[indexMap.registry], inputs);

  const executionCostClaim = decodePureU64(args[indexMap.claim], inputs);
  const settlementPayoutRecipient = decodePureAddress(args[indexMap.recipient], inputs);

  let extractedSettlementSwapPath: SettleArgs['extractedSettlementSwapPath'] | undefined;
  if (fnName !== SETTLE_WITH_CREDIT_FUNCTION) {
    const settlementSwapDirection = settlementSwapDirectionFromFunctionName(fnName);
    if (!settlementSwapDirection) {
      throw new ParseSettleArgsError(
        `Cannot derive SettlementSwapDirection from function: ${fnName}`,
      );
    }
    const tokenType = settleCmd.typeArguments[0];
    if (!tokenType) {
      throw new ParseSettleArgsError(`Settle function ${fnName} has no type arguments`);
    }
    const hops = indexMap.pools.map((poolIdx) => resolveObjectId(args[poolIdx], inputs));
    extractedSettlementSwapPath = { tokenType, hops, settlementSwapDirection };
  }

  return {
    configObjectId,
    registryObjectId,
    settlementPayoutRecipient,
    executionCostClaim,
    extractedSettlementSwapPath,
    policyHash: decodePureVectorU8(args[indexMap.policyHash], inputs),
    orderIdHash: decodePureVectorU8(args[indexMap.orderIdHash], inputs),
    quotedHostFeeMist: decodePureU64(args[indexMap.quotedHostFee], inputs),
    expectedProtocolFeeMist: decodePureU64(args[indexMap.expectedProtocolFee], inputs),
    expectedConfigVersion: decodePureU64(args[indexMap.expectedConfigVersion], inputs),
    nonce: decodePureU64(args[indexMap.nonce], inputs),
    receiptId: decodePureVectorU8(args[indexMap.receiptId], inputs),
    simGasReported: decodePureU64(args[indexMap.simGasReported], inputs),
    gasVarianceFixedMist: decodePureU64(args[indexMap.gasVarianceFixedMist], inputs),
    slippageBufferMist: decodePureU64(args[indexMap.slippageBufferMist], inputs),
    quoteTimestampMs: decodePureU64(args[indexMap.quoteTimestampMs], inputs),
  };
}
