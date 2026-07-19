/**
 * On-chain SettleEvent verification against application-owned expected values.
 *
 * This API is for server reconciliation after a sponsor result returns a
 * transaction digest. It does not treat SettleEvent presence alone as payment
 * completion. The caller must provide the application order binding values.
 */

import { createHash } from 'node:crypto';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { isReceiptId, RECEIPT_ID_FORMAT, type ExpectedSettleEventFields } from '@stelis/contracts';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';
import {
  getSuiTransactionEvents,
  suiExecutionErrorMessage,
  type SuiTransactionWithEventsResult,
} from '@stelis/core-relay/browser';
import {
  decodeCanonicalSettleEvent,
  SETTLE_EVENT_TYPE,
  type DecodedSettleEvent,
} from './settleEventDecoder.js';
import { createSettlementSuiEndpoint } from './settlementSuiEndpoint.js';

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
  assertStringField(candidate['receiptId'], 'receiptId');
  if (!isReceiptId(candidate['receiptId'])) {
    throw new Error(`[Stelis] expected.receiptId must be ${RECEIPT_ID_FORMAT}`);
  }
  const receiptId = candidate['receiptId'];
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

function verifiedSuccessPayload(
  result: SuiTransactionWithEventsResult,
  digest: string,
): Extract<SuiTransactionWithEventsResult, { outcome: 'success' }> {
  if (result.digest !== digest) {
    throw new Error(`[Stelis] Transaction ${digest} returned a mismatched result`);
  }
  if (result.outcome === 'failure') {
    throw new Error(
      `[Stelis] Transaction ${digest} failed: ${suiExecutionErrorMessage(result.error)}`,
    );
  }
  return result;
}

function verifySettleEvent(
  payload: Extract<SuiTransactionWithEventsResult, { outcome: 'success' }>,
  digest: string,
  expected: ExpectedSettleEventFields,
  validatedExpected: ReturnType<typeof validateExpectedFields>,
): VerifiedSettleEvent {
  const events = payload.events;
  if (events.length === 0) {
    throw new Error(`[Stelis] No events found in transaction ${digest}`);
  }

  const settleEvents = events
    .map(decodeCanonicalSettleEvent)
    .filter((event): event is DecodedSettleEvent => event !== null);
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

  const verified = settleEvents[0]!;
  const onChainReceiptId = verified.receiptId;
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

/**
 * Verify an already-loaded, exact Sui transaction-and-events result.
 *
 * The caller owns the network proof for the operation that produced `result`.
 * This pure boundary exists so a caller that has already loaded the terminal
 * result does not perform a second, potentially divergent event read.
 */
export function verifySettleEventResultAgainstExpected(
  result: SuiTransactionWithEventsResult,
  digest: string,
  expected: ExpectedSettleEventFields,
): VerifiedSettleEvent {
  const validatedExpected = validateExpectedFields(expected);
  const payload = verifiedSuccessPayload(result, digest);
  return verifySettleEvent(payload, digest, expected, validatedExpected);
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
  const endpoint = await createSettlementSuiEndpoint(client);
  const result = await getSuiTransactionEvents(endpoint, { digest });
  const payload = verifiedSuccessPayload(result, digest);
  return verifySettleEvent(payload, digest, expected, validatedExpected);
}
