/**
 * Sponsored execution store contract.
 *
 * RedisSponsoredLogsStore implements this contract for the deployed Host.
 *
 * Adapter semantics:
 *   - `append` identifies one sponsored execution by `receiptId`.
 *     An exact result replay is a no-op; a different result for the same
 *     receipt is a conflict and MUST NOT mutate either projection.
 *     The recorded receipt fingerprint MUST persist for the adapter's
 *     full lifetime (Redis: no TTL; DB-style stores: unique receipt
 *     constraint plus current-result fingerprint).
 *     `receiptId` is non-null by `SponsoredExecutionLogEntry` contract.
 *     The recorder receives the callback from the durable final receipt,
 *     whose identity always includes `receiptId`.
 *   - aggregate updates, receipt replay identity, and recent-list append are
 *     one atomic mutation. A callback retry therefore cannot create a partial
 *     aggregate or log projection.
 *   - `getSummary('all' | 'generic' | 'promotion')` reads the requested
 *     scope. `'all'` is updated in lockstep with the per-mode scope on
 *     append.
 *   - `getRecent(mode, limit)` returns most recently accepted entries first. The store
 *     MAY cap retention; readers MUST NOT compute lifetime totals from
 *     recent rows.
 */

import { createHash } from 'node:crypto';
import type {
  SponsoredExecutionAggregate,
  SponsoredExecutionAggregateMode,
  SponsoredExecutionLogEntry,
} from './types.js';

export interface SponsoredLogsStoreAdapter {
  /**
   * Append a sponsored execution log entry. Recorder calls this once per
   * sponsor result callback. Implementations MUST enforce the receipt
   * identity and replay contract defined above.
   */
  append(entry: SponsoredExecutionLogEntry): Promise<void>;

  /** Read the lifetime aggregate for the given mode scope. */
  getSummary(mode: SponsoredExecutionAggregateMode): Promise<SponsoredExecutionAggregate>;

  /**
   * Read up to `limit` entries in reverse accepted-append order for the given mode scope.
   * `mode === 'all'` interleaves both modes in accepted append order.
   */
  getRecent(
    mode: SponsoredExecutionAggregateMode,
    limit: number,
  ): Promise<readonly SponsoredExecutionLogEntry[]>;
}

/**
 * Default cap for recent-log retention. Adapters may override per
 * runtime. Keep this value modest; lifetime totals come from aggregate.
 */
export const SPONSORED_LOGS_RECENT_DEFAULT_CAP = 200;

/**
 * Fingerprint the complete current result for replay comparison.
 *
 * `createdAt` is intentionally excluded: a retried recorder callback may
 * observe a different host clock while describing the same execution.
 * Every identity, outcome, digest, and economics field is included in a
 * fixed order so any substantive drift for a receipt is rejected.
 */
export function sponsoredLogReplayFingerprint(entry: SponsoredExecutionLogEntry): string {
  const { createdAt: _createdAt, ...replayIdentity } = entry;
  return createHash('sha256').update(JSON.stringify(replayIdentity)).digest('hex');
}

export function sponsoredLogReceiptConflict(receiptId: string): Error {
  return new Error(`sponsoredLogs: conflicting result for receiptId ${receiptId}`);
}
