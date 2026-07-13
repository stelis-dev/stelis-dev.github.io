/**
 * Sponsored execution store contract.
 *
 * Two adapters implement this contract:
 *   - MemorySponsoredLogsStore (tests + local dev).
 *   - RedisSponsoredLogsStore  (production).
 *
 * Adapter semantics:
 *   - `append` is idempotent on `(mode, receiptId, outcome)`.
 *     Retries / duplicate dispatches MUST NOT double-count aggregates.
 *     The dedup record MUST persist for the adapter's full lifetime
 *     (Redis: NX with no TTL; memory: unbounded set; DB-style stores:
 *     unique constraint).
 *     `receiptId` is non-null by `SponsoredExecutionLogEntry` contract
 *     (the recorder is invoked from `finally` after `consume()`, where
 *     the sponsor result callback contract guarantees a non-null receiptId).
 *   - aggregate updates and the recent-list append are NOT required to be
 *     co-atomic across the two projections. Aggregate updates MUST be
 *     atomic per emit (Lua/Redis or DB transaction); recent-list append
 *     is best-effort.
 *   - `getSummary('all' | 'generic' | 'promotion')` reads the requested
 *     scope. `'all'` is updated in lockstep with the per-mode scope on
 *     append.
 *   - `getRecent(mode, limit)` returns newest-first entries. The store
 *     MAY cap retention; readers MUST NOT compute lifetime totals from
 *     recent rows.
 */

import type {
  SponsoredExecutionAggregate,
  SponsoredExecutionAggregateMode,
  SponsoredExecutionLogEntry,
} from './types.js';

export interface SponsoredLogsStoreAdapter {
  /**
   * Append a sponsored execution log entry. Recorder calls this once per
   * sponsor result callback. Implementations MUST be idempotent on the
   * idempotency tuple defined above.
   */
  append(entry: SponsoredExecutionLogEntry): Promise<void>;

  /** Read the lifetime aggregate for the given mode scope. */
  getSummary(mode: SponsoredExecutionAggregateMode): Promise<SponsoredExecutionAggregate>;

  /**
   * Read up to `limit` newest-first entries for the given mode scope.
   * `mode === 'all'` interleaves both modes by `createdAt` order.
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
 * Build the canonical idempotency key for an entry: `mode|receiptId|outcome`.
 * `receiptId` is non-null by the `SponsoredExecutionLogEntry` contract.
 */
export function sponsoredLogIdempotencyKey(entry: SponsoredExecutionLogEntry): string {
  return `${entry.mode}|${entry.receiptId}|${entry.outcome}`;
}
