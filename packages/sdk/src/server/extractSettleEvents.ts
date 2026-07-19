/**
 * Batch SettleEvent extraction for reconciliation.
 *
 * This helper fetches transactions, extracts matching SettleEvent entries, and
 * returns decoded summaries. It does not verify payment completion against an
 * application order. Use `verifySettleEventAgainstExpected` for that.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  getSuiTransactionEvents,
  suiExecutionErrorMessage,
  type SuiTransactionWithEventsResult,
} from '@stelis/core-relay/browser';
import { decodeCanonicalSettleEvent, type DecodedSettleEvent } from './settleEventDecoder.js';
import { createSettlementSuiEndpoint } from './settlementSuiEndpoint.js';

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
  const endpoint = await createSettlementSuiEndpoint(client);

  for (const digest of digests) {
    let result: SuiTransactionWithEventsResult;
    try {
      result = await getSuiTransactionEvents(endpoint, { digest });
    } catch (err) {
      logger(
        `[reconciliation] Transaction ${digest}: fetch failed (${err instanceof Error ? err.message : String(err)}); skipping.`,
      );
      continue;
    }

    if (result.outcome === 'failure') {
      logger(
        `[reconciliation] Transaction ${digest}: execution failed (${suiExecutionErrorMessage(result.error)}); skipping.`,
      );
      continue;
    }

    let settleEvents: DecodedSettleEvent[];
    try {
      settleEvents = result.events
        .map(decodeCanonicalSettleEvent)
        .filter((event): event is DecodedSettleEvent => event !== null);
    } catch (decodeErr) {
      logger(
        `[reconciliation] Transaction ${digest}: invalid SettleEvent (${decodeErr instanceof Error ? decodeErr.message : String(decodeErr)}); skipping.`,
      );
      continue;
    }

    if (settleEvents.length === 0) {
      continue;
    }
    if (settleEvents.length !== 1) {
      logger(
        `[reconciliation] Transaction ${digest}: expected one SettleEvent, found ${settleEvents.length}; skipping.`,
      );
      continue;
    }

    const decoded = settleEvents[0]!;

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
