/**
 * SettleEvent BCS decoder — shared schema for on-chain event parsing.
 *
 * Used by:
 *   - verifySettleEventAgainstExpected.ts (single TX expected-field verification)
 *   - extractSettleEvents.ts (batch digest scanning for reconciliation)
 *
 * Mirrors the Move struct: stelis::events::SettleEvent
 *
 * @module settleEventDecoder
 */

import { bcs } from '@mysten/sui/bcs';
import { toHex } from '@mysten/sui/utils';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** BCS vector(u8) → Uint8Array transform (avoids number[] intermediate). */
const bytesVector = bcs.vector(bcs.u8()).transform({
  input: (val: Uint8Array | number[]) => (val instanceof Uint8Array ? Array.from(val) : val),
  output: (val: number[]) => new Uint8Array(val),
});

// ─────────────────────────────────────────────
// BCS schema (mirrors events.move)
// ─────────────────────────────────────────────

export const SettleEventBcs = bcs.struct('SettleEvent', {
  receipt_id: bytesVector,
  nonce: bcs.u64(),
  policy_hash: bytesVector,
  quote_timestamp_ms: bcs.u64(),
  exec_timestamp_ms: bcs.u64(),
  sim_gas_reported: bcs.u64(),
  gas_variance_fixed_mist: bcs.u64(),
  slippage_buffer_mist: bcs.u64(),
  execution_cost_claim_mist: bcs.u64(),
  quoted_host_fee_mist: bcs.u64(),
  protocol_fee: bcs.u64(),
  protocol_treasury: bcs.Address,
  payout: bcs.u64(),
  total_in: bcs.u64(),
  surplus_credited: bcs.u64(),
  config_version: bcs.u64(),
  user: bcs.Address,
  settlement_payout_recipient: bcs.Address,
  order_id_hash: bytesVector,
});

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

/**
 * Decode a SettleEvent from BCS bytes.
 *
 * @param bcsBytes - Raw BCS bytes from the event
 * @returns Decoded event with hex-encoded receipt_id, order_id_hash, and address fields
 */
export function decodeSettleEvent(bcsBytes: Uint8Array): DecodedSettleEvent {
  const decoded = SettleEventBcs.parse(bcsBytes);

  return {
    receiptId: toHex(decoded.receipt_id),
    nonce: String(decoded.nonce),
    orderIdHash: toHex(decoded.order_id_hash),
    user: decoded.user,
    executionCostClaim: String(decoded.execution_cost_claim_mist),
    quotedHostFeeMist: String(decoded.quoted_host_fee_mist),
    protocolFee: String(decoded.protocol_fee),
    payout: String(decoded.payout),
    totalIn: String(decoded.total_in),
    configVersion: String(decoded.config_version),
    execTimestampMs: String(decoded.exec_timestamp_ms),
  };
}
