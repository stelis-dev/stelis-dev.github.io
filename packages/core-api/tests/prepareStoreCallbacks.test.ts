/**
 * prepareStoreCallbacks.test.ts — direct unit-level coverage for
 * `invokeReleaseCallback` and `invokeEvictCallback`.
 *
 * These helpers define the prepare-store release / evict
 * callback wrapper skeleton used by both MemoryPrepareStore and
 * RedisPrepareStore. Integration suites (prepareStore.test.ts,
 * redisPrepareStore.test.ts, prepareStore.conformance.ts) cover the
 * helpers indirectly through adapter call-sites; this file covers the
 * helper contract directly so edge cases (sync throw vs rejected promise,
 * emitSuccess suppression, extraFields merge) do not depend on either
 * adapter.
 *
 * Locked behaviors:
 *   invokeReleaseCallback
 *     - success: emits SPONSOR_POOL_LEASE_RELEASE (info)
 *     - sync throw: emits SPONSOR_POOL_LEASE_RELEASE_FAILED (warn)
 *     - rejected promise: emits SPONSOR_POOL_LEASE_RELEASE_FAILED (warn)
 *     - emitSuccess: false suppresses the success event but keeps the
 *       failure path intact
 *     - extraFields merge on both success and failure events
 *   invokeEvictCallback
 *     - sync throw: emits PREPARE_STORE_EVICT_CALLBACK_FAILED (warn)
 *     - rejected promise: emits PREPARE_STORE_EVICT_CALLBACK_FAILED
 *       (warn)
 */
import { describe, expect, it, vi } from 'vitest';
import { invokeEvictCallback, invokeReleaseCallback } from '../src/store/prepareStoreCallbacks.js';
import type { PreparedTxEntry } from '../src/store/prepareTypes.js';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeEntry(overrides: Partial<PreparedTxEntry> = {}): PreparedTxEntry {
  return {
    issuedAt: Date.now(),
    receiptId: 'pid-test',
    senderAddress: '0xSENDER',
    nonce: 1n,
    txBytesHash: 'hash-test',
    sponsorAddress: '0xSPONSOR',
    clientIp: '10.0.0.1',
    executionPathKey: 'mock-execution-path',
    orderId: null,
    mode: 'generic',
    ...overrides,
  } as PreparedTxEntry;
}

function parseJsonFromCalls(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call: unknown[]) => {
      try {
        return JSON.parse(String(call[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

// ─────────────────────────────────────────────
// invokeReleaseCallback
// ─────────────────────────────────────────────

describe('invokeReleaseCallback', () => {
  it('success path emits SPONSOR_POOL_LEASE_RELEASE with call-site context', async () => {
    const onRelease = vi.fn().mockResolvedValue(undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await invokeReleaseCallback({
        onRelease,
        sponsorAddress: 'slot-A',
        receiptId: 'pid-A',
        txBytesHash: 'hash-A',
        adapter: 'memory-prepare',
        reason: 'prepare_expired',
      });
      expect(onRelease).toHaveBeenCalledWith('slot-A', 'pid-A', 'hash-A');
      const release = parseJsonFromCalls(infoSpy).find(
        (e) => e['event'] === 'SPONSOR_POOL_LEASE_RELEASE',
      );
      expect(release).toBeDefined();
      expect(release!['adapter']).toBe('memory-prepare');
      expect(release!['reason']).toBe('prepare_expired');
      expect(release!['sponsor_address']).toBe('slot-A');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('synchronous throw emits SPONSOR_POOL_LEASE_RELEASE_FAILED (warn) and resolves', async () => {
    const onRelease = vi.fn().mockImplementation(() => {
      throw new Error('release-sync-throw');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        invokeReleaseCallback({
          onRelease,
          sponsorAddress: 'slot-B',
          receiptId: 'pid-B',
          txBytesHash: 'hash-B',
          adapter: 'redis-prepare',
          reason: 'ip_concurrent_eviction',
          extraFields: { client_ip: '10.9.9.9' },
        }),
      ).resolves.toBeUndefined();
      const failed = parseJsonFromCalls(warnSpy).find(
        (e) => e['event'] === 'SPONSOR_POOL_LEASE_RELEASE_FAILED',
      );
      expect(failed).toBeDefined();
      expect(failed!['adapter']).toBe('redis-prepare');
      expect(failed!['reason']).toBe('ip_concurrent_eviction');
      expect(failed!['sponsor_address']).toBe('slot-B');
      expect(failed!['client_ip']).toBe('10.9.9.9');
      expect(failed!['error']).toBe('release-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rejected promise emits SPONSOR_POOL_LEASE_RELEASE_FAILED (warn) and resolves', async () => {
    const onRelease = vi
      .fn()
      .mockImplementation(() => Promise.reject(new Error('release-async-reject')));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        invokeReleaseCallback({
          onRelease,
          sponsorAddress: 'slot-C',
          receiptId: 'pid-C',
          txBytesHash: null,
          adapter: 'memory-prepare',
          reason: 'hash_mismatch',
        }),
      ).resolves.toBeUndefined();
      const failed = parseJsonFromCalls(warnSpy).find(
        (e) => e['event'] === 'SPONSOR_POOL_LEASE_RELEASE_FAILED',
      );
      expect(failed).toBeDefined();
      expect(failed!['reason']).toBe('hash_mismatch');
      expect(failed!['sponsor_address']).toBe('slot-C');
      expect(failed!['error']).toBe('release-async-reject');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('emitSuccess: false suppresses the success event but preserves the failure event', async () => {
    // Success branch: onRelease resolves cleanly; no success event must fire.
    const onReleaseOk = vi.fn().mockResolvedValue(undefined);
    const infoSpyOk = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await invokeReleaseCallback({
        onRelease: onReleaseOk,
        sponsorAddress: 'slot-EC',
        receiptId: 'pid-EC',
        txBytesHash: 'hash-EC',
        adapter: 'memory-prepare',
        reason: 'evict_corrupt',
        emitSuccess: false,
      });
      const successEvents = parseJsonFromCalls(infoSpyOk).filter(
        (e) => e['event'] === 'SPONSOR_POOL_LEASE_RELEASE',
      );
      expect(successEvents).toEqual([]);
    } finally {
      infoSpyOk.mockRestore();
    }

    // Failure branch: onRelease rejects; failure event must still fire
    // even with emitSuccess: false.
    const onReleaseFail = vi
      .fn()
      .mockImplementation(() => Promise.reject(new Error('release-rejected')));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await invokeReleaseCallback({
        onRelease: onReleaseFail,
        sponsorAddress: 'slot-EC',
        receiptId: 'pid-EC',
        txBytesHash: 'hash-EC',
        adapter: 'memory-prepare',
        reason: 'evict_corrupt',
        emitSuccess: false,
      });
      const failed = parseJsonFromCalls(warnSpy).find(
        (e) => e['event'] === 'SPONSOR_POOL_LEASE_RELEASE_FAILED',
      );
      expect(failed).toBeDefined();
      expect(failed!['reason']).toBe('evict_corrupt');
      expect(failed!['error']).toBe('release-rejected');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────
// invokeEvictCallback
// ─────────────────────────────────────────────

describe('invokeEvictCallback', () => {
  it('synchronous throw emits PREPARE_STORE_EVICT_CALLBACK_FAILED (warn)', async () => {
    const entry = makeEntry({ sponsorAddress: 'slot-E1', receiptId: 'pid-E1' });
    const onEntryEvict = vi.fn().mockImplementation(() => {
      throw new Error('evict-sync-throw');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      invokeEvictCallback({
        onEntryEvict,
        entry,
        adapter: 'memory-prepare',
        reason: 'prepare_expired',
      });
      // Wait for the .catch microtask to settle before inspecting spy calls.
      await new Promise((r) => setTimeout(r, 0));
      const failed = parseJsonFromCalls(warnSpy).find(
        (e) => e['event'] === 'PREPARE_STORE_EVICT_CALLBACK_FAILED',
      );
      expect(failed).toBeDefined();
      expect(failed!['adapter']).toBe('memory-prepare');
      expect(failed!['reason']).toBe('prepare_expired');
      expect(failed!['sponsor_address']).toBe('slot-E1');
      expect(failed!['receipt_id']).toBe('pid-E1');
      expect(failed!['error']).toBe('evict-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rejected promise emits PREPARE_STORE_EVICT_CALLBACK_FAILED (warn)', async () => {
    const entry = makeEntry({ sponsorAddress: 'slot-E2', receiptId: 'pid-E2' });
    const onEntryEvict = vi
      .fn()
      .mockImplementation(() => Promise.reject(new Error('evict-async-reject')));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      invokeEvictCallback({
        onEntryEvict,
        entry,
        adapter: 'redis-prepare',
        reason: 'hash_mismatch',
      });
      await new Promise((r) => setTimeout(r, 0));
      const failed = parseJsonFromCalls(warnSpy).find(
        (e) => e['event'] === 'PREPARE_STORE_EVICT_CALLBACK_FAILED',
      );
      expect(failed).toBeDefined();
      expect(failed!['adapter']).toBe('redis-prepare');
      expect(failed!['reason']).toBe('hash_mismatch');
      expect(failed!['sponsor_address']).toBe('slot-E2');
      expect(failed!['receipt_id']).toBe('pid-E2');
      expect(failed!['error']).toBe('evict-async-reject');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
