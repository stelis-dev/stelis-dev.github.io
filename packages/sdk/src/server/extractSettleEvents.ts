/**
 * Batch SettleEvent extraction for reconciliation.
 *
 * This helper fetches transactions, extracts matching SettleEvent entries, and
 * returns decoded summaries. It does not verify payment completion against an
 * application order. Use `verifySettleEventAgainstExpected` for that.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { decodeSettleEvent, SETTLE_EVENT_TYPE } from './settleEventDecoder.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Summary of a decoded SettleEvent from a transaction. */
export interface ExtractedSettleEventSummary {
  /** Transaction digest. */
  digest: string;
  /** Receipt ID as lowercase hex without a 0x prefix. */
  receiptId: string;
  /** Order ID hash as lowercase hex, empty string if absent. */
  orderIdHash: string;
  /** User wallet address. */
  user: string;
  /** Execution timestamp in milliseconds. */
  timestampMs: string;
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

/**
 * Extract SettleEvents from a list of transaction digests.
 *
 * Successful transactions without a SettleEvent are skipped without warning.
 * Failed transactions, fetch failures, missing requested event data, duplicate
 * SettleEvents, and invalid BCS are reported to the required logger and skipped.
 *
 * @param client - SuiGrpcClient instance
 * @param digests - Transaction digests to scan
 * @param logger - required warning sink for digests that cannot be reconciled
 * @returns Decoded SettleEvent summaries
 */
export async function extractSettleEvents(
  client: SuiGrpcClient,
  digests: string[],
  logger: (msg: string) => void,
): Promise<ExtractedSettleEventSummary[]> {
  const results: ExtractedSettleEventSummary[] = [];

  for (const digest of digests) {
    let result: import('@mysten/sui/client').SuiClientTypes.TransactionResult<{
      events: true;
    }>;
    try {
      result = await client.getTransaction({
        digest,
        include: { events: true },
      });
    } catch (err) {
      logger(
        `[reconciliation] Transaction ${digest}: fetch failed (${err instanceof Error ? err.message : String(err)}); skipping.`,
      );
      continue;
    }

    if (result.$kind === 'FailedTransaction') {
      const reason = result.FailedTransaction.status.error?.message ?? 'unknown execution failure';
      logger(`[reconciliation] Transaction ${digest}: execution failed (${reason}); skipping.`);
      continue;
    }

    const events = result.Transaction.events;
    if (!Array.isArray(events)) {
      logger(`[reconciliation] Transaction ${digest}: requested events were missing; skipping.`);
      continue;
    }
    const settleEvents = events.filter((event) => event.eventType === SETTLE_EVENT_TYPE);

    if (settleEvents.length === 0) {
      continue;
    }
    if (settleEvents.length !== 1) {
      logger(
        `[reconciliation] Transaction ${digest}: expected one SettleEvent, found ${settleEvents.length}; skipping.`,
      );
      continue;
    }

    let decoded;
    try {
      decoded = decodeSettleEvent(settleEvents[0]!.bcs);
    } catch (decodeErr) {
      logger(
        `[reconciliation] Transaction ${digest}: invalid SettleEvent BCS (${decodeErr instanceof Error ? decodeErr.message : String(decodeErr)}); skipping.`,
      );
      continue;
    }

    results.push({
      digest,
      receiptId: decoded.receiptId,
      orderIdHash: decoded.orderIdHash,
      user: decoded.user,
      timestampMs: decoded.execTimestampMs,
    });
  }

  return results;
}
