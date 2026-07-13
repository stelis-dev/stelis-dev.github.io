/**
 * Internal helpers for prepare-store callback wrapper skeleton.
 *
 * `MemoryPrepareStore` and `RedisPrepareStore` both inject two
 * best-effort callbacks per adapter:
 *
 *   - `_onRelease(sponsorAddress, receiptId, txBytesHash)` — sponsor lease return.
 *   - `_onEntryEvict(entry)` — coordinator-side entry cleanup.
 *
 * Each callback may return `void` or a `Promise<void>`, and may also
 * throw synchronously. The adapters must:
 *
 *   - never let a callback failure mask the primary classified result;
 *   - emit the existing structured events on success and failure; and
 *   - route synchronous throws and rejected promises into the same
 *     `.catch` arm so the failure handling is uniform.
 *
 * These helpers encapsulate that wrapping skeleton. They do not change
 * event names, payload shapes, reason literals, callback signatures, or
 * logger choice — they consolidate the identical boilerplate so both
 * adapters share one callback wrapper.
 *
 * This module is core-api store internal. It must not be re-exported
 * from `packages/core-api/src/index.ts`.
 */
import type { PreparedTxEntry } from './prepareTypes.js';
import { logSponsorPoolEvent } from '../sponsorPoolEventLog.js';
import { logStructuredEvent } from '../structuredEventLog.js';
import {
  PREPARE_STORE_EVICT_CALLBACK_FAILED,
  SPONSOR_POOL_LEASE_RELEASE,
  SPONSOR_POOL_LEASE_RELEASE_FAILED,
} from '../observability/events.js';

export type PrepareStoreAdapterTag = 'memory-prepare' | 'redis-prepare';

export type PrepareStoreReleaseReason =
  | 'ip_concurrent_eviction'
  | 'prepare_expired'
  | 'hash_mismatch'
  | 'background_ttl_eviction'
  | 'evict_corrupt'
  | 'prepare_expired_undeserializable'
  | 'hash_mismatch_undeserializable'
  | 'consume_success_undeserializable'
  | 'undeserializable_eviction';

export type PrepareStoreEvictReason =
  | 'ip_concurrent_eviction'
  | 'prepare_expired'
  | 'hash_mismatch'
  | 'background_ttl_eviction';

export type OnReleaseCallback = (
  sponsorAddress: string,
  receiptId: string,
  txBytesHash: string | null,
) => void | Promise<void>;

export type OnEntryEvictCallback = (entry: PreparedTxEntry) => void | Promise<void>;

/**
 * Invoke `_onRelease` as a best-effort slot release.
 *
 * Wraps the callback invocation inside a `.then` so both synchronous
 * throws and rejected promises funnel to the same `.catch` arm. On
 * success, emits `SPONSOR_POOL_LEASE_RELEASE` (info). On failure, emits
 * `SPONSOR_POOL_LEASE_RELEASE_FAILED` (warn) carrying the call-site
 * context plus an `error` field.
 *
 * Returns a `Promise<void>` that always resolves. Fire-and-forget call
 * sites use `void invokeReleaseCallback(...)`; sites that must wait for
 * completion (the `evictPreparedEntry()` path) use `await`.
 *
 * `emitSuccess` defaults to `true` to match the majority of call sites.
 * Pass `false` when the caller should emit only the failure event.
 */
export function invokeReleaseCallback(args: {
  onRelease: OnReleaseCallback;
  sponsorAddress: string;
  receiptId: string;
  txBytesHash: string | null;
  adapter: PrepareStoreAdapterTag;
  reason: PrepareStoreReleaseReason;
  extraFields?: Record<string, unknown>;
  emitSuccess?: boolean;
}): Promise<void> {
  const emitSuccess = args.emitSuccess ?? true;
  return Promise.resolve()
    .then(() => args.onRelease(args.sponsorAddress, args.receiptId, args.txBytesHash))
    .then(() => {
      if (!emitSuccess) return;
      logSponsorPoolEvent(SPONSOR_POOL_LEASE_RELEASE, {
        adapter: args.adapter,
        reason: args.reason,
        sponsor_address: args.sponsorAddress,
        ...args.extraFields,
      });
    })
    .catch((err) => {
      logSponsorPoolEvent(
        SPONSOR_POOL_LEASE_RELEASE_FAILED,
        {
          adapter: args.adapter,
          reason: args.reason,
          sponsor_address: args.sponsorAddress,
          ...args.extraFields,
          error: err instanceof Error ? err.message : String(err),
        },
        'warn',
      );
    });
}

/**
 * Invoke `_onEntryEvict` as a best-effort coordinator cleanup.
 *
 * Wraps the callback inside a `.then` so synchronous throws and
 * rejected promises funnel to the same `.catch` arm and emit
 * `PREPARE_STORE_EVICT_CALLBACK_FAILED` (warn). This store-layer event
 * is a safety-net: the callback owner (app-api context) owns its own
 * callback-local event names (`PREPARE_STORE_EVICT_CLEANUP_FAILED` /
 * `PREPARE_STORE_EVICT_CLEANUP_THREW`) and the two layers are
 * orthogonal.
 *
 * Fire-and-forget. No success event — owner body owns success-side
 * semantics for `_onEntryEvict`.
 */
export function invokeEvictCallback(args: {
  onEntryEvict: OnEntryEvictCallback;
  entry: PreparedTxEntry;
  adapter: PrepareStoreAdapterTag;
  reason: PrepareStoreEvictReason;
}): void {
  void Promise.resolve()
    .then(() => args.onEntryEvict(args.entry))
    .catch((err) => {
      logStructuredEvent(
        PREPARE_STORE_EVICT_CALLBACK_FAILED,
        {
          adapter: args.adapter,
          reason: args.reason,
          sponsor_address: args.entry.sponsorAddress,
          receipt_id: args.entry.receiptId,
          error: err instanceof Error ? err.message : String(err),
        },
        'warn',
      );
    });
}
