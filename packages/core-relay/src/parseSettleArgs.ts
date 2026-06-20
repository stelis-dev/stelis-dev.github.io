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
  SETTLE_FUNCTIONS,
  SETTLE_WITH_CREDIT_FUNCTION,
  settlementSwapDirectionFromFunctionName,
} from '@stelis/contracts';
import {
  FIELD_OFFSET,
  VARIANT_LAYOUTS,
  variantClassFromFnName,
  type SettleVariantClass,
} from './settlePayloadContract.js';
import { findSettleCommand } from './settleCommand.js';

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
// Argument index mapping — derived from settlePayloadContract
// ─────────────────────────────────────────────

/**
 * Index positions for config, registry, claim, recipient, pool(s), and fee fields
 * within the MoveCall arguments for each settle function variant.
 *
 * Layouts are derived from the canonical variant prefix structure
 * (settlePayloadContract.ts VARIANT_LAYOUTS) and settle field offsets
 * (FIELD_OFFSET). bfq/qfb share the same layout within each class.
 */
export interface ArgIndexMap {
  config: number;
  /** registry ObjectId index */
  registry?: number;
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
 * Derive ArgIndexMap from a SettleVariantClass.
 *
 * Uses VARIANT_LAYOUTS for prefix structure (settle start index, pool indices)
 * and FIELD_OFFSET for named settle field offsets within the settle block.
 *
 * Covers every field in SETTLE_FIELD_SCHEMA (all 13 settle-block fields) so
 * that sponsor-side logic can derive all execution-critical values from the
 * submitted `txBytes` instead of the off-chain prepare store.
 */
function deriveArgIndexMap(vc: SettleVariantClass): ArgIndexMap {
  const { settleStartIndex: s, poolIndices } = VARIANT_LAYOUTS[vc];
  return {
    config: 0,
    registry: 1,
    claim: s + FIELD_OFFSET.executionCostClaim,
    recipient: s + FIELD_OFFSET.settlementPayoutRecipient,
    pools: [...poolIndices],
    receiptId: s + FIELD_OFFSET.receiptId,
    nonce: s + FIELD_OFFSET.nonce,
    simGasReported: s + FIELD_OFFSET.simGasReported,
    gasVarianceFixedMist: s + FIELD_OFFSET.gasVarianceFixedMist,
    slippageBufferMist: s + FIELD_OFFSET.slippageBufferMist,
    quotedHostFee: s + FIELD_OFFSET.quotedHostFeeMist,
    expectedProtocolFee: s + FIELD_OFFSET.expectedProtocolFeeMist,
    expectedConfigVersion: s + FIELD_OFFSET.expectedConfigVersion,
    quoteTimestampMs: s + FIELD_OFFSET.quoteTimestampMs,
    policyHash: s + FIELD_OFFSET.policyHash,
    orderIdHash: s + FIELD_OFFSET.orderIdHash,
  };
}

// ─── Derived ARG_INDEX_MAP ────────────────────────────────────────
// Built from shared contract data: each function name → variant class → layout.

const _derivedMap: Record<string, ArgIndexMap> = {};
for (const fn of SETTLE_FUNCTIONS) {
  const vc = variantClassFromFnName(fn);
  if (vc) _derivedMap[fn] = deriveArgIndexMap(vc);
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
  if (typeof arg !== 'object' || arg === null) return false;
  const r = arg as Record<string, unknown>;
  return r.$kind === 'Input' && typeof r.Input === 'number';
}

function resolveObjectId(arg: unknown, inputs: unknown[]): string {
  if (!isInputRef(arg)) {
    throw new ParseSettleArgsError('Expected Input reference for Object arg');
  }
  const input = inputs[arg.Input];
  if (typeof input !== 'object' || input === null) {
    throw new ParseSettleArgsError(`Input[${arg.Input}] is not an object`);
  }
  const i = input as Record<string, unknown>;

  // Resolved Object: { $kind: 'Object', Object: { $kind: 'SharedObject' | 'ImmOrOwnedObject', ... } }
  if (i.$kind === 'Object' && typeof i.Object === 'object' && i.Object !== null) {
    const obj = i.Object as Record<string, unknown>;
    if (
      obj.$kind === 'SharedObject' &&
      typeof obj.SharedObject === 'object' &&
      obj.SharedObject !== null
    ) {
      const shared = obj.SharedObject as Record<string, unknown>;
      if (typeof shared.objectId === 'string') return shared.objectId;
    }
    if (
      obj.$kind === 'ImmOrOwnedObject' &&
      typeof obj.ImmOrOwnedObject === 'object' &&
      obj.ImmOrOwnedObject !== null
    ) {
      const imm = obj.ImmOrOwnedObject as Record<string, unknown>;
      if (typeof imm.objectId === 'string') return imm.objectId;
    }
  }

  // Pre-build UnresolvedObject: { $kind: 'UnresolvedObject', UnresolvedObject: { objectId } }
  if (
    i.$kind === 'UnresolvedObject' &&
    typeof i.UnresolvedObject === 'object' &&
    i.UnresolvedObject !== null
  ) {
    const unresolved = i.UnresolvedObject as Record<string, unknown>;
    if (typeof unresolved.objectId === 'string') return unresolved.objectId;
  }

  throw new ParseSettleArgsError(`Input[${arg.Input}] could not be resolved to an object ID`);
}

function decodePureU64(arg: unknown, inputs: unknown[]): bigint {
  if (!isInputRef(arg)) {
    throw new ParseSettleArgsError('Expected Input reference for Pure u64');
  }
  const input = inputs[arg.Input];
  if (typeof input !== 'object' || input === null) {
    throw new ParseSettleArgsError(`Input[${arg.Input}] is not an object`);
  }
  const i = input as Record<string, unknown>;
  if (i.$kind !== 'Pure' || typeof i.Pure !== 'object' || i.Pure === null) {
    throw new ParseSettleArgsError(`Input[${arg.Input}] is not a Pure arg`);
  }
  const pure = i.Pure as Record<string, unknown>;
  if (typeof pure.bytes !== 'string') {
    throw new ParseSettleArgsError(`Input[${arg.Input}] Pure has no bytes`);
  }
  const decoded = fromBase64(pure.bytes);
  if (decoded.length !== 8) {
    throw new ParseSettleArgsError(`Pure u64 must be exactly 8 bytes, got ${decoded.length}`);
  }
  // BCS u64: 8-byte little-endian
  let value = 0n;
  for (let idx = 7; idx >= 0; idx--) {
    value = (value << 8n) | BigInt(decoded[idx]!);
  }
  return value;
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
  if (!isInputRef(arg)) {
    throw new ParseSettleArgsError('Expected Input reference for Pure vector<u8>');
  }
  const input = inputs[arg.Input];
  if (typeof input !== 'object' || input === null) {
    throw new ParseSettleArgsError(`Input[${arg.Input}] is not an object`);
  }
  const i = input as Record<string, unknown>;
  if (i.$kind !== 'Pure' || typeof i.Pure !== 'object' || i.Pure === null) {
    throw new ParseSettleArgsError(`Input[${arg.Input}] is not a Pure arg`);
  }
  const pure = i.Pure as Record<string, unknown>;
  if (typeof pure.bytes !== 'string') {
    throw new ParseSettleArgsError(`Input[${arg.Input}] Pure has no bytes`);
  }
  const decoded = fromBase64(pure.bytes);
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
  if (!isInputRef(arg)) {
    throw new ParseSettleArgsError('Expected Input reference for Pure address');
  }
  const input = inputs[arg.Input];
  if (typeof input !== 'object' || input === null) {
    throw new ParseSettleArgsError(`Input[${arg.Input}] is not an object`);
  }
  const i = input as Record<string, unknown>;
  if (i.$kind !== 'Pure' || typeof i.Pure !== 'object' || i.Pure === null) {
    throw new ParseSettleArgsError(`Input[${arg.Input}] is not a Pure arg`);
  }
  const pure = i.Pure as Record<string, unknown>;
  if (typeof pure.bytes !== 'string') {
    throw new ParseSettleArgsError(`Input[${arg.Input}] Pure has no bytes`);
  }
  const decoded = fromBase64(pure.bytes);
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

  const args = settleCmd.arguments;

  const configObjectId = resolveObjectId(args[indexMap.config], inputs);

  // Resolve registry (vault-backed variants)
  let registryObjectId: string | undefined;
  if (indexMap.registry !== undefined) {
    registryObjectId = resolveObjectId(args[indexMap.registry], inputs);
  }

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
