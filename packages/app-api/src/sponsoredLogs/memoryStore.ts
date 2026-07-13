/**
 * Memory adapter for sponsored execution log + aggregate.
 *
 * Used by tests and local dev. The Redis adapter implements the same
 * `SponsoredLogsStoreAdapter` contract with Lua-atomic aggregate
 * updates.
 */

import type {
  SponsoredExecutionAggregate,
  SponsoredExecutionAggregateMode,
  SponsoredExecutionLogEntry,
  SponsoredExecutionMode,
} from './types.js';
import { parseSignedDecimalString, parseSponsoredExecutionLogEntry } from './types.js';
import {
  SPONSORED_LOGS_RECENT_DEFAULT_CAP,
  sponsoredLogReceiptConflict,
  sponsoredLogReplayFingerprint,
  type SponsoredLogsStoreAdapter,
} from './store.js';

interface MutableAggregate {
  sponsoredExecutions: bigint;
  lossCount: bigint;
  cumulativeHostNetMist: bigint;
  cumulativeLossMist: bigint;
}

function emptyAggregate(): MutableAggregate {
  return {
    sponsoredExecutions: 0n,
    lossCount: 0n,
    cumulativeHostNetMist: 0n,
    cumulativeLossMist: 0n,
  };
}

function freezeAggregate(
  mode: SponsoredExecutionAggregateMode,
  agg: MutableAggregate,
): SponsoredExecutionAggregate {
  return {
    mode,
    sponsoredExecutions: agg.sponsoredExecutions.toString(),
    lossCount: agg.lossCount.toString(),
    cumulativeHostNetMist: agg.cumulativeHostNetMist.toString(),
    cumulativeLossMist: agg.cumulativeLossMist.toString(),
  };
}

function compareCreatedAtDesc(
  a: SponsoredExecutionLogEntry,
  b: SponsoredExecutionLogEntry,
): number {
  return b.createdAt.localeCompare(a.createdAt);
}

export interface MemorySponsoredLogsStoreOptions {
  /**
   * Recent-list cap. Older entries past this index are dropped on
   * append. Defaults to `SPONSORED_LOGS_RECENT_DEFAULT_CAP`.
   */
  readonly recentCap?: number;
}

/**
 * In-memory `SponsoredLogsStoreAdapter`. One receipt records one exact
 * result; aggregate update and recent append are NOT co-atomic (recent
 * append is best-effort by contract).
 */
export class MemorySponsoredLogsStore implements SponsoredLogsStoreAdapter {
  private readonly aggregates: Map<SponsoredExecutionAggregateMode, MutableAggregate> = new Map();
  private readonly recent: SponsoredExecutionLogEntry[] = [];
  private readonly receiptFingerprints: Map<string, string> = new Map();
  private readonly recentCap: number;

  constructor(options: MemorySponsoredLogsStoreOptions = {}) {
    this.recentCap = options.recentCap ?? SPONSORED_LOGS_RECENT_DEFAULT_CAP;
    this.aggregates.set('all', emptyAggregate());
    this.aggregates.set('generic', emptyAggregate());
    this.aggregates.set('promotion', emptyAggregate());
  }

  async append(entry: SponsoredExecutionLogEntry): Promise<void> {
    const currentEntry = parseSponsoredExecutionLogEntry(entry);
    const fingerprint = sponsoredLogReplayFingerprint(currentEntry);

    // Validate up front — a rejected append MUST NOT poison the
    // receipt map, otherwise a later well-formed retry of the same
    // receipt would conflict silently. Mirrors the
    // Redis adapter, which validates before invoking the Lua script.
    let hostNet: bigint | null = null;
    if (currentEntry.economicsStatus === 'known') {
      hostNet = parseSignedDecimalString(currentEntry.hostNetMist!, 'hostNetMist');
    }

    const recordedFingerprint = this.receiptFingerprints.get(currentEntry.receiptId);
    if (recordedFingerprint !== undefined) {
      if (recordedFingerprint === fingerprint) return;
      throw sponsoredLogReceiptConflict(currentEntry.receiptId);
    }

    // Validation passed — claim this exact receipt result now (adapter
    // lifetime persistent; production uses Redis).
    this.receiptFingerprints.set(currentEntry.receiptId, fingerprint);

    // Aggregate update — `all` plus per-mode scope.
    const scopes: readonly SponsoredExecutionAggregateMode[] = ['all', currentEntry.mode];
    for (const scope of scopes) {
      const agg = this.aggregates.get(scope)!;
      agg.sponsoredExecutions += 1n;
      if (hostNet !== null) {
        agg.cumulativeHostNetMist += hostNet;
        if (hostNet < 0n) {
          agg.cumulativeLossMist += hostNet;
          agg.lossCount += 1n;
        }
      }
    }

    // Recent — newest-first by createdAt, bounded.
    this.recent.unshift(currentEntry);
    this.recent.sort(compareCreatedAtDesc);
    if (this.recent.length > this.recentCap) {
      this.recent.length = this.recentCap;
    }
  }

  async getSummary(mode: SponsoredExecutionAggregateMode): Promise<SponsoredExecutionAggregate> {
    const agg = this.aggregates.get(mode);
    if (!agg) {
      // Defensive — constructor always populates the three modes.
      return freezeAggregate(mode, emptyAggregate());
    }
    return freezeAggregate(mode, agg);
  }

  async getRecent(
    mode: SponsoredExecutionAggregateMode,
    limit: number,
  ): Promise<readonly SponsoredExecutionLogEntry[]> {
    if (limit <= 0) return [];
    if (mode === 'all') {
      return this.recent.slice(0, limit).map((entry) => parseSponsoredExecutionLogEntry(entry));
    }
    const filtered: SponsoredExecutionLogEntry[] = [];
    for (const e of this.recent) {
      if (e.mode === (mode as SponsoredExecutionMode)) {
        filtered.push(parseSponsoredExecutionLogEntry(e));
        if (filtered.length >= limit) break;
      }
    }
    return filtered;
  }
}
