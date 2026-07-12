/**
 * MemoryPrepareStore — single-process PrepareStoreAdapter.
 *
 * Single-process PrepareStoreAdapter with:
 *   - Single-use consume semantics
 *   - Background TTL eviction with slot release callback
 *   - IP concurrency enforcement (max outstanding entries per IP)
 *   - Verified sender outstanding-prepare quota at nonce reservation
 *
 * ⚠️  SINGLE-PROCESS ONLY — horizontal scaling requires a Redis-backed adapter.
 *
 * TTL default is PREPARE_TTL_MS.
 */
import {
  parseCurrentPreparedTxEntry,
  type PreparedTxEntry,
  type PrepareStoreAdapter,
} from './prepareTypes.js';
import {
  invokeEvictCallback,
  invokeReleaseCallback,
  type OnEntryEvictCallback,
  type OnReleaseCallback,
} from './prepareStoreCallbacks.js';
import { PrepareSenderQuotaError, PrepareStudioUserQuotaError } from './prepareErrors.js';
import { type Clock, systemClock } from '../clock.js';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

import { PREPARE_TTL_MS } from '../preparePolicy.js';
export { PREPARE_TTL_MS };

/** Maximum outstanding prepared entries per client IP. Oldest evicted on overflow. */
export const MAX_CONCURRENT_PER_IP = 2;

/**
 * Maximum outstanding promotion-mode prepared entries per verified
 * developer JWT `userId`. Generic `/relay/prepare` skips this quota
 * because no pre-verified principal exists; only promotion entries
 * count against the Studio user quota.
 */
export const MAX_OUTSTANDING_PER_STUDIO_USER = 3;

/** Maximum live or pending prepared entries per verified wallet sender. */
export const MAX_OUTSTANDING_PER_SENDER = 3;

/** Background eviction interval — must be shorter than TTL to catch expired entries promptly. */
const EVICT_INTERVAL_MS = 15_000;

// ─────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────

export class MemoryPrepareStore implements PrepareStoreAdapter {
  private readonly _entries: Map<string, PreparedTxEntry> = new Map();
  /** Tracks outstanding receiptIds per client IP for concurrency enforcement */
  private readonly _ipIndex: Map<string, Set<string>> = new Map();
  /**
   * Tracks outstanding receiptIds per sender address. Used by S-14 nonce
   * reservation / replay coordination and verified-sender outstanding
   * prepare quota. The quota is enforced at `reserveNonce()` after
   * prepare authorization has proven control of the sender address.
   */
  private readonly _senderIndex: Map<string, Set<string>> = new Map();
  /**
   * Tracks outstanding promotion-mode receiptIds per verified developer
   * JWT `userId`. This is the Studio promotion outstanding-prepare quota
   * subject. Generic-mode entries do NOT participate; the index is
   * populated only when an entry's `mode === 'promotion'`.
   */
  private readonly _userIndex: Map<string, Set<string>> = new Map();
  /** S-14: pending nonce reservations per sender (reservationId → {nonce, issuedAt}). Cleaned up on store/release/TTL. */
  private readonly _pendingNonces: Map<string, Map<string, { nonce: bigint; issuedAt: number }>> =
    new Map();
  private readonly _onRelease: OnReleaseCallback;
  private readonly _onEntryEvict?: OnEntryEvictCallback;
  private readonly _ttlMs: number;
  private readonly _maxPerIp: number;
  private readonly _maxPerStudioUser: number;
  private readonly _maxOutstandingPerSender: number;
  private readonly _timer: ReturnType<typeof setInterval>;
  private readonly _clock: Clock;

  /**
   * @param onRelease       Callback when a slot must return to the pool.
   *                        Inject
   *                        `(sponsorAddress, receiptId, txBytesHash) =>
   *                           sponsorPool.checkin(sponsorAddress, receiptId, txBytesHash)`.
   *                        Entries reaching any release callback here
   *                        are always post-`store()`, meaning the lease
   *                        has already been committed to `txBytesHash`
   *                        in the prepare pipeline. The store therefore
   *                        always passes a non-null `txBytesHash` and
   *                        the pool verifies the committed HMAC.
   * @param ttlMs           Entry TTL in ms. Default: PREPARE_TTL_MS.
   * @param maxPerIp        Max outstanding entries per IP. Default: MAX_CONCURRENT_PER_IP.
   * @param maxPerStudioUser    Max outstanding promotion-mode entries per verified developer JWT `userId`. Default: MAX_OUTSTANDING_PER_STUDIO_USER. Generic mode is not gated by this value.
   * @param evictIntervalMs Background eviction interval. Default: EVICT_INTERVAL_MS.
   * @param onEntryEvict    Optional callback when an entry is evicted (TTL/IP overflow/consume-expired).
   *                        Use for promotion ExecutionLedger reservation cleanup.
   * @param clock           Optional `Clock` for TTL / reservation window reads.
   *                        Defaults to `systemClock`.
   * @param maxOutstandingPerSender Max live or pending entries per verified wallet sender.
   */
  constructor(
    onRelease: OnReleaseCallback,
    ttlMs = PREPARE_TTL_MS,
    maxPerIp = MAX_CONCURRENT_PER_IP,
    maxPerStudioUser = MAX_OUTSTANDING_PER_STUDIO_USER,
    evictIntervalMs = EVICT_INTERVAL_MS,
    onEntryEvict?: OnEntryEvictCallback,
    clock: Clock = systemClock,
    maxOutstandingPerSender = MAX_OUTSTANDING_PER_SENDER,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('MemoryPrepareStore: ttlMs must be > 0 and a safe integer');
    }
    if (!Number.isSafeInteger(maxPerIp) || maxPerIp < 1) {
      throw new Error('MemoryPrepareStore: maxPerIp must be >= 1 and a safe integer');
    }
    if (!Number.isSafeInteger(maxPerStudioUser) || maxPerStudioUser < 1) {
      throw new Error('MemoryPrepareStore: maxPerStudioUser must be >= 1 and a safe integer');
    }
    if (!Number.isSafeInteger(maxOutstandingPerSender) || maxOutstandingPerSender < 1) {
      throw new Error(
        'MemoryPrepareStore: maxOutstandingPerSender must be >= 1 and a safe integer',
      );
    }
    if (!Number.isSafeInteger(evictIntervalMs) || evictIntervalMs <= 0) {
      throw new Error('MemoryPrepareStore: evictIntervalMs must be > 0 and a safe integer');
    }
    this._onRelease = onRelease;
    this._onEntryEvict = onEntryEvict;
    this._ttlMs = ttlMs;
    this._maxPerIp = maxPerIp;
    this._maxPerStudioUser = maxPerStudioUser;
    this._maxOutstandingPerSender = maxOutstandingPerSender;
    this._clock = clock;
    this._timer = setInterval(() => this._evictExpired(), evictIntervalMs);
    if (typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  /** Explicit cleanup — call in graceful shutdown or test teardown. */
  dispose(): void {
    clearInterval(this._timer);
  }

  async store(receiptId: string, entry: PreparedTxEntry): Promise<void> {
    const currentEntry = parseCurrentPreparedTxEntry(entry);
    if (currentEntry.receiptId !== receiptId) {
      throw new Error('PrepareStore: receiptId argument must match entry.receiptId');
    }
    const ip = currentEntry.clientIp;
    const sender = currentEntry.senderAddress;
    const now = this._clock.nowMs();

    // Prune expired sender entries before quota check to avoid false positives.
    // The background eviction runs on EVICT_INTERVAL_MS, so entries may linger up to that interval.
    const senderSet = this._senderIndex.get(sender);
    if (senderSet) {
      for (const pid of [...senderSet]) {
        const existing = this._entries.get(pid);
        if (!existing || now - existing.issuedAt > this._ttlMs) {
          senderSet.delete(pid);
        }
      }
      if (senderSet.size === 0) this._senderIndex.delete(sender);
    }

    // Promotion-mode user quota check. Generic prepare has no pre-verified
    // identity, so quota enforcement on an unsigned address enables
    // victim-targeted DoS; only the promotion route has a verified
    // developer JWT `userId` suitable for outstanding-prepare quota
    // enforcement. The userIndex is populated only by promotion entries;
    // it never sees generic-mode receiptIds, so cross-mode contamination
    // is structurally impossible.
    if (currentEntry.mode === 'promotion') {
      // Prune expired entries from the userIndex bucket before counting.
      const userSetForQuota = this._userIndex.get(currentEntry.userId);
      if (userSetForQuota) {
        for (const pid of [...userSetForQuota]) {
          const existing = this._entries.get(pid);
          if (!existing || now - existing.issuedAt > this._ttlMs) {
            userSetForQuota.delete(pid);
          }
        }
        if (userSetForQuota.size === 0) this._userIndex.delete(currentEntry.userId);
      }
      const liveCount = this._userIndex.get(currentEntry.userId)?.size ?? 0;
      if (liveCount >= this._maxPerStudioUser) {
        throw new PrepareStudioUserQuotaError(currentEntry.userId, this._maxPerStudioUser);
      }
    }

    // Enforce IP concurrency limit — evict oldest if at capacity
    const ipSet = this._ipIndex.get(ip);
    if (ipSet && ipSet.size >= this._maxPerIp) {
      // Find the oldest entry for this IP and evict it
      let oldestId: string | null = null;
      let oldestTime = Infinity;
      for (const pid of ipSet) {
        const existing = this._entries.get(pid);
        if (existing && existing.issuedAt < oldestTime) {
          oldestTime = existing.issuedAt;
          oldestId = pid;
        }
      }
      if (oldestId) {
        const evicted = this._entries.get(oldestId);
        if (evicted) {
          // Slot release — best effort, independent of coordinator cleanup.
          void invokeReleaseCallback({
            onRelease: this._onRelease,
            sponsorAddress: evicted.sponsorAddress,
            receiptId: evicted.receiptId,
            txBytesHash: evicted.txBytesHash,
            adapter: 'memory-prepare',
            reason: 'ip_concurrent_eviction',
            extraFields: { client_ip: ip },
          });

          // Coordinator cleanup — runs independently of slot release outcome.
          if (this._onEntryEvict) {
            invokeEvictCallback({
              onEntryEvict: this._onEntryEvict,
              entry: evicted,
              adapter: 'memory-prepare',
              reason: 'ip_concurrent_eviction',
            });
          }
          // Drop from sender + userIndex via the shared helper so all
          // indexes stay consistent on eviction.
          this._removeEntry(oldestId, evicted);
        } else {
          // Defensive cleanup if the IP set referenced a missing entry.
          ipSet.delete(oldestId);
        }
      }
    }

    // Store the entry
    this._entries.set(receiptId, currentEntry);

    // Update IP index
    if (!this._ipIndex.has(ip)) {
      this._ipIndex.set(ip, new Set());
    }
    this._ipIndex.get(ip)!.add(receiptId);

    // Update sender index (used by S-14 nonce reservation / replay coordination).
    if (!this._senderIndex.has(sender)) {
      this._senderIndex.set(sender, new Set());
    }
    this._senderIndex.get(sender)!.add(receiptId);

    // Update userIndex for promotion entries (Studio outstanding-prepare quota).
    if (currentEntry.mode === 'promotion') {
      if (!this._userIndex.has(currentEntry.userId)) {
        this._userIndex.set(currentEntry.userId, new Set());
      }
      this._userIndex.get(currentEntry.userId)!.add(receiptId);
    }

    // Promote pending reservation → live (implicit confirm).
    // Entry holds the nonce; pending reservation can be cleaned up.
    const pendingMap = this._pendingNonces.get(sender);
    if (pendingMap) {
      pendingMap.delete(receiptId);
      if (pendingMap.size === 0) this._pendingNonces.delete(sender);
    }
  }

  /**
   * Drop a receiptId from the userIndex when its entry leaves the live
   * set (consume / evict / expire). Idempotent: safe when the entry was
   * never indexed (generic mode) or already removed.
   */
  private removeFromUserIndex(entry: PreparedTxEntry, receiptId: string): void {
    if (entry.mode !== 'promotion') return;
    const userSet = this._userIndex.get(entry.userId);
    if (!userSet) return;
    userSet.delete(receiptId);
    if (userSet.size === 0) this._userIndex.delete(entry.userId);
  }

  async consume(
    receiptId: string,
    txBytesHash: string,
  ): Promise<PreparedTxEntry | 'not_found' | 'expired' | 'hash_mismatch'> {
    const entry = this._entries.get(receiptId);
    if (!entry) return 'not_found';

    // TTL check
    if (this._clock.nowMs() - entry.issuedAt > this._ttlMs) {
      // Slot release — best effort, independent of coordinator cleanup.
      void invokeReleaseCallback({
        onRelease: this._onRelease,
        sponsorAddress: entry.sponsorAddress,
        receiptId: entry.receiptId,
        txBytesHash: entry.txBytesHash,
        adapter: 'memory-prepare',
        reason: 'prepare_expired',
      });
      this._removeEntry(receiptId, entry);
      // Coordinator cleanup — runs independently of slot release outcome.
      if (this._onEntryEvict) {
        invokeEvictCallback({
          onEntryEvict: this._onEntryEvict,
          entry,
          adapter: 'memory-prepare',
          reason: 'prepare_expired',
        });
      }
      return 'expired';
    }

    // txBytesHash integrity check — detects txBytes substitution
    if (entry.txBytesHash !== txBytesHash) {
      // Slot release — best effort, independent of coordinator cleanup.
      void invokeReleaseCallback({
        onRelease: this._onRelease,
        sponsorAddress: entry.sponsorAddress,
        receiptId: entry.receiptId,
        txBytesHash: entry.txBytesHash,
        adapter: 'memory-prepare',
        reason: 'hash_mismatch',
      });
      this._removeEntry(receiptId, entry);
      // Coordinator cleanup — runs independently of slot release outcome.
      if (this._onEntryEvict) {
        invokeEvictCallback({
          onEntryEvict: this._onEntryEvict,
          entry,
          adapter: 'memory-prepare',
          reason: 'hash_mismatch',
        });
      }
      return 'hash_mismatch';
    }

    // Success: delete entry (1-time use). Slot checkin is the caller's responsibility.
    this._removeEntry(receiptId, entry);
    return parseCurrentPreparedTxEntry(entry);
  }

  async peek(receiptId: string): Promise<PreparedTxEntry | null> {
    const entry = this._entries.get(receiptId);
    if (!entry) return null;
    if (this._clock.nowMs() - entry.issuedAt > this._ttlMs) return null;
    return parseCurrentPreparedTxEntry(entry);
  }

  /**
   * Best-effort invalidation of a stored prepared entry. The memory store
   * never has a "deserialization failure" path because entries are stored
   * as live JS objects, so this method is effectively a forced delete +
   * slot release. Serves both corrupt-entry eviction and post-`peek`
   * sponsor result rejection invalidation; see the interface docstring.
   *
   * Idempotent and never throws.
   */
  async evictPreparedEntry(receiptId: string): Promise<void> {
    const entry = this._entries.get(receiptId);
    if (!entry) return;
    // Drop from indices first so a parallel store() call cannot resurrect
    // the receiptId during cleanup. Every index that the entry could be
    // in must be cleaned: IP index, sender index (S-14 nonce
    // coordination), and userIndex (Studio user quota — promotion
    // entries only).
    this._entries.delete(receiptId);
    const ipSet = this._ipIndex.get(entry.clientIp);
    if (ipSet) {
      ipSet.delete(receiptId);
      if (ipSet.size === 0) this._ipIndex.delete(entry.clientIp);
    }
    const senderSet = this._senderIndex.get(entry.senderAddress);
    if (senderSet) {
      senderSet.delete(receiptId);
      if (senderSet.size === 0) this._senderIndex.delete(entry.senderAddress);
    }
    this.removeFromUserIndex(entry, receiptId);
    // Best-effort slot release — never throw on the failure path.
    // `emitSuccess: false` keeps this path to failure-event-only
    // emission (no SPONSOR_POOL_LEASE_RELEASE on the
    // evict_corrupt success branch).
    await invokeReleaseCallback({
      onRelease: this._onRelease,
      sponsorAddress: entry.sponsorAddress,
      receiptId: entry.receiptId,
      txBytesHash: entry.txBytesHash,
      adapter: 'memory-prepare',
      reason: 'evict_corrupt',
      emitSuccess: false,
    });
  }

  /**
   * Pre-check Studio user quota before slot checkout (best-effort).
   * Compacts expired entries before counting — same as store() path.
   * Generic `/relay/prepare` skips quota entirely; only promotion-mode
   * entries populate the userIndex, so this method always reflects the
   * promotion-route count exclusively.
   */
  async checkUserQuota(userId: string): Promise<'ok' | { exceeded: true; limit: number }> {
    const now = this._clock.nowMs();
    const userSet = this._userIndex.get(userId);
    if (!userSet) return 'ok';
    let live = 0;
    for (const pid of userSet) {
      const e = this._entries.get(pid);
      if (e && now - e.issuedAt <= this._ttlMs) live++;
    }
    return live >= this._maxPerStudioUser
      ? { exceeded: true, limit: this._maxPerStudioUser }
      : 'ok';
  }

  async reserveNonce(
    senderAddress: string,
    onchainLastNonce: bigint,
    reservationId: string,
  ): Promise<bigint> {
    let maxNonce = onchainLastNonce;
    const now = this._clock.nowMs();
    let outstandingForSender = 0;

    // Scan live entries for this sender — skip logically expired entries
    const senderSet = this._senderIndex.get(senderAddress);
    if (senderSet) {
      for (const pid of senderSet) {
        const entry = this._entries.get(pid);
        if (entry && now - entry.issuedAt <= this._ttlMs) {
          outstandingForSender++;
          if (entry.nonce > maxNonce) {
            maxNonce = entry.nonce;
          }
        }
      }
    }

    // Scan pending reservations for this sender — compact stale entries
    const pendingMap = this._pendingNonces.get(senderAddress);
    if (pendingMap) {
      for (const [rid, pending] of pendingMap) {
        if (now - pending.issuedAt > this._ttlMs) {
          // Stale pending: TTL elapsed without store()/releaseReservation() — remove
          pendingMap.delete(rid);
          continue;
        }
        if (pending.nonce > maxNonce) maxNonce = pending.nonce;
        outstandingForSender++;
      }
      if (pendingMap.size === 0) this._pendingNonces.delete(senderAddress);
    }

    if (outstandingForSender >= this._maxOutstandingPerSender) {
      throw new PrepareSenderQuotaError(senderAddress, this._maxOutstandingPerSender);
    }

    const next = maxNonce + 1n;

    // Store as pending reservation (sender-local)
    if (!this._pendingNonces.has(senderAddress)) {
      this._pendingNonces.set(senderAddress, new Map());
    }
    this._pendingNonces.get(senderAddress)!.set(reservationId, { nonce: next, issuedAt: now });

    return next;
  }

  async releaseReservation(reservationId: string, senderAddress: string): Promise<void> {
    const pendingMap = this._pendingNonces.get(senderAddress);
    if (pendingMap) {
      pendingMap.delete(reservationId);
      if (pendingMap.size === 0) this._pendingNonces.delete(senderAddress);
    }
  }

  // ─────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────

  /** Remove entry from the main map and every index (IP / sender / user). */
  private _removeEntry(receiptId: string, entry: PreparedTxEntry): void {
    this._entries.delete(receiptId);
    // IP index cleanup
    const ipSet = this._ipIndex.get(entry.clientIp);
    if (ipSet) {
      ipSet.delete(receiptId);
      if (ipSet.size === 0) {
        this._ipIndex.delete(entry.clientIp);
      }
    }
    // Sender index cleanup (S-14 nonce coordination keeps using this index).
    const senderSet = this._senderIndex.get(entry.senderAddress);
    if (senderSet) {
      senderSet.delete(receiptId);
      if (senderSet.size === 0) {
        this._senderIndex.delete(entry.senderAddress);
      }
    }
    // User index cleanup (only populated for promotion entries).
    this.removeFromUserIndex(entry, receiptId);
  }

  /** Background eviction: release slots for entries that exceeded TTL. */
  private _evictExpired(): void {
    const now = this._clock.nowMs();
    for (const [receiptId, entry] of this._entries) {
      if (now - entry.issuedAt > this._ttlMs) {
        // Slot release — best effort, independent of coordinator cleanup.
        void invokeReleaseCallback({
          onRelease: this._onRelease,
          sponsorAddress: entry.sponsorAddress,
          receiptId: entry.receiptId,
          txBytesHash: entry.txBytesHash,
          adapter: 'memory-prepare',
          reason: 'background_ttl_eviction',
        });
        // Coordinator cleanup — runs independently of slot release outcome.
        if (this._onEntryEvict) {
          invokeEvictCallback({
            onEntryEvict: this._onEntryEvict,
            entry,
            adapter: 'memory-prepare',
            reason: 'background_ttl_eviction',
          });
        }
        this._removeEntry(receiptId, entry);
      }
    }
  }
}
