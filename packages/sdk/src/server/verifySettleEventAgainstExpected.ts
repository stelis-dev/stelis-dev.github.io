/**
 * On-chain SettleEvent verification against application-owned expected values.
 *
 * This API is for server reconciliation after a sponsor result returns a
 * transaction digest. It does not treat SettleEvent presence alone as payment
 * completion. The caller must provide the application order binding values.
 */

import { createHash } from 'node:crypto';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { ExpectedSettleEventFields } from '@stelis/contracts';
import { toHex } from '@mysten/sui/utils';
import { SettleEventBcs } from './settleEventDecoder.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Verified on-chain SettleEvent data returned after expected-field comparison. */
export interface VerifiedSettleEvent {
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
// Helpers
// ─────────────────────────────────────────────

/** Compute SHA-256 of a UTF-8 string, return lowercase hex. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeHex(value: string): string {
  return value.toLowerCase().replace(/^0x/, '');
}

function assertStringField(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[Stelis] expected.${name} is required`);
  }
}

function validateExpectedFields(expected: ExpectedSettleEventFields): void {
  const candidate = expected as Record<string, unknown>;
  assertStringField(candidate['receiptId'], 'receiptId');
  assertStringField(candidate['user'], 'user');

  const hasOrderId = typeof candidate['orderId'] === 'string' && candidate['orderId'].length > 0;
  const hasOrderIdHash =
    typeof candidate['orderIdHash'] === 'string' && candidate['orderIdHash'].length > 0;
  if (hasOrderId === hasOrderIdHash) {
    throw new Error('[Stelis] expected must include exactly one of orderId or orderIdHash');
  }

  for (const field of ['executionCostClaimMist', 'quotedHostFeeMist', 'protocolFeeMist']) {
    const value = candidate[field];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new Error(`[Stelis] expected.${field} must be a non-empty MIST string`);
    }
  }
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

/**
 * Verify an on-chain SettleEvent against application-owned expected values.
 *
 * Required expected values:
 *   - receiptId
 *   - user
 *   - exactly one of orderId or orderIdHash
 *
 * Optional amount fields are compared when provided:
 *   - executionCostClaimMist
 *   - quotedHostFeeMist
 *   - protocolFeeMist
 *
 * @param client - SuiGrpcClient instance from `@mysten/sui/grpc`
 * @param digest - Transaction digest to verify
 * @param packageId - Stelis package ID used to filter SettleEvent by eventType
 * @param expected - Application-owned fields to compare with the on-chain event
 * @returns Decoded SettleEvent after every expected field matches
 * @throws Error if expected fields are missing, transaction data is missing, no
 * SettleEvent exists, BCS decoding fails, or any expected field mismatches
 */
export async function verifySettleEventAgainstExpected(
  client: SuiGrpcClient,
  digest: string,
  packageId: string,
  expected: ExpectedSettleEventFields,
): Promise<VerifiedSettleEvent> {
  validateExpectedFields(expected);

  const result = await client.getTransaction({
    digest,
    include: { events: true },
  });

  const tx = result.Transaction ?? result.FailedTransaction;
  if (!tx) {
    throw new Error(`[Stelis] Transaction ${digest} not found or empty result`);
  }

  const events = tx.events ?? [];
  if (events.length === 0) {
    throw new Error(`[Stelis] No events found in transaction ${digest}`);
  }

  const settleEventType = `${packageId}::events::SettleEvent`;
  const settleEvent = events.find((e) => e.eventType === settleEventType);
  if (!settleEvent) {
    throw new Error(
      `[Stelis] SettleEvent not found in transaction ${digest}. ` +
        `Expected eventType: ${settleEventType}`,
    );
  }

  const decoded = SettleEventBcs.parse(settleEvent.bcs);
  const onChainReceiptId = normalizeHex(toHex(decoded.receipt_id));
  const onChainOrderIdHash = normalizeHex(toHex(decoded.order_id_hash));

  const verified: VerifiedSettleEvent = {
    receiptId: onChainReceiptId,
    nonce: String(decoded.nonce),
    orderIdHash: onChainOrderIdHash,
    user: decoded.user,
    executionCostClaim: String(decoded.execution_cost_claim_mist),
    quotedHostFeeMist: String(decoded.quoted_host_fee_mist),
    protocolFee: String(decoded.protocol_fee),
    payout: String(decoded.payout),
    totalIn: String(decoded.total_in),
    configVersion: String(decoded.config_version),
    execTimestampMs: String(decoded.exec_timestamp_ms),
  };

  const mismatches: string[] = [];
  const expectedReceiptId = normalizeHex(expected.receiptId);
  if (expectedReceiptId !== onChainReceiptId) {
    mismatches.push(`receiptId: expected ${expectedReceiptId}, on-chain ${onChainReceiptId}`);
  }

  const expectedOrder = expected as { orderId?: unknown; orderIdHash?: unknown };
  const expectedOrderIdHash =
    typeof expectedOrder.orderId === 'string'
      ? sha256Hex(expectedOrder.orderId)
      : normalizeHex(expectedOrder.orderIdHash as string);
  if (expectedOrderIdHash !== onChainOrderIdHash) {
    mismatches.push(`orderIdHash: expected ${expectedOrderIdHash}, on-chain ${onChainOrderIdHash}`);
  }

  const normalizedExpectedUser = expected.user.toLowerCase();
  const normalizedOnChainUser = decoded.user.toLowerCase();
  if (normalizedExpectedUser !== normalizedOnChainUser) {
    mismatches.push(`user: expected ${normalizedExpectedUser}, on-chain ${normalizedOnChainUser}`);
  }

  if (
    expected.executionCostClaimMist !== undefined &&
    expected.executionCostClaimMist !== String(decoded.execution_cost_claim_mist)
  ) {
    mismatches.push(
      `executionCostClaimMist: expected ${expected.executionCostClaimMist}, on-chain ${decoded.execution_cost_claim_mist}`,
    );
  }

  if (
    expected.quotedHostFeeMist !== undefined &&
    expected.quotedHostFeeMist !== String(decoded.quoted_host_fee_mist)
  ) {
    mismatches.push(
      `quotedHostFeeMist: expected ${expected.quotedHostFeeMist}, on-chain ${decoded.quoted_host_fee_mist}`,
    );
  }

  if (
    expected.protocolFeeMist !== undefined &&
    expected.protocolFeeMist !== String(decoded.protocol_fee)
  ) {
    mismatches.push(
      `protocolFeeMist: expected ${expected.protocolFeeMist}, on-chain ${decoded.protocol_fee}`,
    );
  }

  if (mismatches.length > 0) {
    throw new Error(
      `[Stelis] SettleEvent verification failed for ${digest}:\n` +
        mismatches.map((m) => `  - ${m}`).join('\n'),
    );
  }

  return verified;
}
