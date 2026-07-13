/**
 * SettleEvent BCS decoder — shared schema for on-chain event parsing.
 *
 * Used by:
 *   - verifySettleEventAgainstExpected.ts (single TX expected-field verification)
 *   - extractSettleEvents.ts (batch digest scanning for reconciliation)
 *
 * Builds the BCS schema from the generated compiled settlement contract.
 *
 * @module settleEventDecoder
 */

import { bcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress, toHex } from '@mysten/sui/utils';
import {
  SETTLE_EVENT_FIELDS,
  SETTLE_EVENT_MODULE,
  SETTLE_EVENT_NAME,
  SETTLEMENT_CONTRACT_NETWORK,
  STELIS_CONTRACT_IDS,
  type SettleEventFieldMoveType,
  type SettleEventValue,
} from '@stelis/contracts';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** BCS vector(u8) → Uint8Array transform (avoids number[] intermediate). */
const bytesVector = bcs.vector(bcs.u8()).transform({
  input: (val: Uint8Array | number[]) => (val instanceof Uint8Array ? Array.from(val) : val),
  output: (val: number[]) => new Uint8Array(val),
});

// ─────────────────────────────────────────────
// BCS schema generated from the compiled event field descriptors
// ─────────────────────────────────────────────

function bcsTypeForMoveType(moveType: SettleEventFieldMoveType) {
  switch (moveType) {
    case 'u64':
      return bcs.u64();
    case 'address':
      return bcs.Address;
    case 'vector<u8>':
      return bytesVector;
  }
}

const settleEventBcsFields = Object.fromEntries(
  SETTLE_EVENT_FIELDS.map((field) => [field.name, bcsTypeForMoveType(field.moveType)]),
);

export const SettleEventBcs = bcs.struct(SETTLE_EVENT_NAME, settleEventBcsFields);

const settlementContractIds = STELIS_CONTRACT_IDS[SETTLEMENT_CONTRACT_NETWORK];
if (!settlementContractIds) {
  throw new Error(`[Stelis] ${SETTLEMENT_CONTRACT_NETWORK} contract IDs are unavailable`);
}
export const SETTLE_EVENT_TYPE = `${settlementContractIds.packageId}::${SETTLE_EVENT_MODULE}::${SETTLE_EVENT_NAME}`;

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Decoded SettleEvent summary (network-portable). */
export interface DecodedSettleEvent {
  receiptId: string;
  /** Monotonic nonce used for this settlement. */
  nonce: string;
  orderIdHash: string;
  user: string;
  executionCostClaim: string;
  quotedHostFeeMist: string;
  protocolFee: string;
  payout: string;
  totalIn: string;
  configVersion: string;
  execTimestampMs: string;
}

// ─────────────────────────────────────────────
// Decoder
// ─────────────────────────────────────────────

function parseCanonicalSettleEvent(bcsBytes: Uint8Array): SettleEventValue {
  const decoded = SettleEventBcs.parse(bcsBytes) as unknown as SettleEventValue;
  // `Object.fromEntries` cannot preserve each generated field's distinct BCS
  // input type. A value parsed by this exact schema is nevertheless a valid
  // input to the same schema: u64 outputs are decimal strings, addresses stay
  // strings, and vector outputs are Uint8Array values accepted by bytesVector.
  const canonicalBytes = SettleEventBcs.serialize(
    decoded as unknown as Parameters<typeof SettleEventBcs.serialize>[0],
  ).toBytes();

  if (
    canonicalBytes.length !== bcsBytes.length ||
    canonicalBytes.some((byte, index) => byte !== bcsBytes[index])
  ) {
    throw new Error('[Stelis] SettleEvent BCS is not canonical for the generated schema');
  }

  return decoded;
}

/**
 * Decode a SettleEvent from BCS bytes.
 *
 * @param bcsBytes - Raw BCS bytes from the event
 * @returns Decoded event with hex-encoded receipt_id, order_id_hash, and address fields
 */
export function decodeSettleEvent(bcsBytes: Uint8Array): DecodedSettleEvent {
  const decoded = parseCanonicalSettleEvent(bcsBytes);

  return {
    receiptId: toHex(decoded.receipt_id),
    nonce: String(decoded.nonce),
    orderIdHash: toHex(decoded.order_id_hash),
    user: normalizeSuiAddress(decoded.user),
    executionCostClaim: String(decoded.execution_cost_claim_mist),
    quotedHostFeeMist: String(decoded.quoted_host_fee_mist),
    protocolFee: String(decoded.protocol_fee),
    payout: String(decoded.payout),
    totalIn: String(decoded.total_in),
    configVersion: String(decoded.config_version),
    execTimestampMs: String(decoded.exec_timestamp_ms),
  };
}
