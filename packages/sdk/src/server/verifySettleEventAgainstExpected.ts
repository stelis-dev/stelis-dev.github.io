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
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';
import {
  decodeSettleEvent,
  SETTLE_EVENT_TYPE,
  type DecodedSettleEvent,
} from './settleEventDecoder.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Decoded on-chain SettleEvent returned only after expected-field comparison. */
export type VerifiedSettleEvent = DecodedSettleEvent;

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

function normalizeExactHex32Field(value: unknown, name: string): string {
  assertStringField(value, name);
  const normalized = normalizeHex(value);
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`[Stelis] expected.${name} must be a 32-byte hex string`);
  }
  return normalized;
}

function assertStringField(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[Stelis] expected.${name} is required`);
  }
}

function validateExpectedFields(expected: ExpectedSettleEventFields): {
  receiptId: string;
  orderIdHash: string;
  user: string;
} {
  const candidate = expected as Record<string, unknown>;
  const receiptId = normalizeExactHex32Field(candidate['receiptId'], 'receiptId');
  assertStringField(candidate['user'], 'user');
  const normalizedUser = normalizeSuiAddress(candidate['user']);
  if (!isValidSuiAddress(normalizedUser)) {
    throw new Error('[Stelis] expected.user must be a valid Sui address');
  }

  const hasOrderId = typeof candidate['orderId'] === 'string' && candidate['orderId'].length > 0;
  const hasOrderIdHash =
    typeof candidate['orderIdHash'] === 'string' && candidate['orderIdHash'].length > 0;
  if (hasOrderId === hasOrderIdHash) {
    throw new Error('[Stelis] expected must include exactly one of orderId or orderIdHash');
  }
  const orderIdHash = hasOrderId
    ? sha256Hex(candidate['orderId'] as string)
    : normalizeExactHex32Field(candidate['orderIdHash'], 'orderIdHash');

  for (const field of ['executionCostClaimMist', 'quotedHostFeeMist', 'protocolFeeMist']) {
    const value = candidate[field];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new Error(`[Stelis] expected.${field} must be a non-empty MIST string`);
    }
  }

  return { receiptId, orderIdHash, user: normalizedUser };
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
 * @param expected - Application-owned fields to compare with the on-chain event
 * @returns Decoded SettleEvent after every expected field matches
 * @throws Error if expected fields are missing, transaction data is missing, no
 * SettleEvent exists, BCS decoding fails, or any expected field mismatches
 */
export async function verifySettleEventAgainstExpected(
  client: SuiGrpcClient,
  digest: string,
  expected: ExpectedSettleEventFields,
): Promise<VerifiedSettleEvent> {
  const validatedExpected = validateExpectedFields(expected);

  const result = await client.getTransaction({
    digest,
    include: { events: true },
  });

  if (result.$kind === 'FailedTransaction') {
    const reason = result.FailedTransaction.status.error?.message ?? 'unknown execution failure';
    throw new Error(`[Stelis] Transaction ${digest} failed: ${reason}`);
  }

  const events = result.Transaction.events;
  if (!Array.isArray(events)) {
    throw new Error(`[Stelis] Transaction ${digest} did not include requested events`);
  }
  if (events.length === 0) {
    throw new Error(`[Stelis] No events found in transaction ${digest}`);
  }

  const settleEvents = events.filter((event) => event.eventType === SETTLE_EVENT_TYPE);
  if (settleEvents.length === 0) {
    throw new Error(
      `[Stelis] SettleEvent not found in transaction ${digest}. ` +
        `Expected eventType: ${SETTLE_EVENT_TYPE}`,
    );
  }
  if (settleEvents.length !== 1) {
    throw new Error(
      `[Stelis] Expected exactly one SettleEvent in transaction ${digest}, found ${settleEvents.length}`,
    );
  }

  const verified = decodeSettleEvent(settleEvents[0]!.bcs);
  const onChainReceiptId = normalizeHex(verified.receiptId);
  const onChainOrderIdHash = normalizeHex(verified.orderIdHash);
  const normalizedOnChainUser = verified.user;

  const mismatches: string[] = [];
  const expectedReceiptId = validatedExpected.receiptId;
  if (expectedReceiptId !== onChainReceiptId) {
    mismatches.push(`receiptId: expected ${expectedReceiptId}, on-chain ${onChainReceiptId}`);
  }

  const expectedOrderIdHash = validatedExpected.orderIdHash;
  if (expectedOrderIdHash !== onChainOrderIdHash) {
    mismatches.push(`orderIdHash: expected ${expectedOrderIdHash}, on-chain ${onChainOrderIdHash}`);
  }

  const normalizedExpectedUser = validatedExpected.user;
  if (normalizedExpectedUser !== normalizedOnChainUser) {
    mismatches.push(`user: expected ${normalizedExpectedUser}, on-chain ${normalizedOnChainUser}`);
  }

  if (
    expected.executionCostClaimMist !== undefined &&
    expected.executionCostClaimMist !== verified.executionCostClaim
  ) {
    mismatches.push(
      `executionCostClaimMist: expected ${expected.executionCostClaimMist}, on-chain ${verified.executionCostClaim}`,
    );
  }

  if (
    expected.quotedHostFeeMist !== undefined &&
    expected.quotedHostFeeMist !== verified.quotedHostFeeMist
  ) {
    mismatches.push(
      `quotedHostFeeMist: expected ${expected.quotedHostFeeMist}, on-chain ${verified.quotedHostFeeMist}`,
    );
  }

  if (expected.protocolFeeMist !== undefined && expected.protocolFeeMist !== verified.protocolFee) {
    mismatches.push(
      `protocolFeeMist: expected ${expected.protocolFeeMist}, on-chain ${verified.protocolFee}`,
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
