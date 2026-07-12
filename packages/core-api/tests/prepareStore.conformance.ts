/**
 * PrepareStoreAdapter — shared conformance test suite.
 *
 * Both MemoryPrepareStore and RedisPrepareStore must pass this suite.
 * The factory parameter lets each implementation provide its own
 * setup/teardown (timer disposal, Redis client injection, etc).
 *
 * This file intentionally contains no implementation-specific
 * assertions. Memory-only (background eviction timer) and Redis-only
 * (BigInt JSON round-trip, exact current stored shape, corrupt JSON
 * tolerance, constructor input validation) cases live in their
 * respective backend entry files.
 *
 * Tests verify the behavioral contract defined by PrepareStoreAdapter.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type {
  GenericPreparedTxEntry,
  PreparedTxEntry,
  PrepareStoreAdapter,
  PromotionPreparedTxEntry,
} from '../src/store/prepareTypes.js';
import {
  PrepareSenderQuotaError,
  PrepareStudioUserQuotaError,
} from '../src/store/prepareErrors.js';

// ─────────────────────────────────────────────
// Factory contract
// ─────────────────────────────────────────────

/** Release callback payload captured per backend. */
export interface ReleasedSlot {
  sponsorAddress: string;
  receiptId: string;
  txBytesHash: string | null;
}

/** Handle returned by a backend factory. */
export interface PrepareStoreHandle {
  store: PrepareStoreAdapter;
  /** Populated by the backend's onRelease callback, in call order. */
  releasedSlots: ReleasedSlot[];
  /** Per-test cleanup (timer disposal, etc). Must be idempotent. */
  dispose(): Promise<void> | void;
}

export interface PrepareStoreFactoryOpts {
  /** TTL in ms. Backends must honor this for expiry semantics. */
  ttlMs: number;
  /** Max outstanding entries per client IP. */
  maxPerIp: number;
  /** Max outstanding entries per verified Studio user. */
  maxPerStudioUser: number;
  /** Max live or pending entries per verified wallet sender. */
  maxOutstandingPerSender: number;
}

/** Factory contract: one fresh store per call. */
export type PrepareStoreFactory = (
  opts: PrepareStoreFactoryOpts,
) => Promise<PrepareStoreHandle> | PrepareStoreHandle;

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

const SLOT_A = 'slot-a';
const SLOT_B = 'slot-b';
const SLOT_C = 'slot-c';
const IP_1 = '192.168.1.1';
const IP_2 = '10.0.0.1';
const SENDER_A = '0xSENDER_A';
const SENDER_B = '0xSENDER_B';

function makeGeneric(overrides: Partial<GenericPreparedTxEntry> = {}): GenericPreparedTxEntry {
  return {
    issuedAt: Date.now(),
    receiptId: 'pid-default',
    senderAddress: SENDER_A,
    nonce: 1n,
    txBytesHash: 'hash-default',
    sponsorAddress: SLOT_A,
    clientIp: IP_1,
    executionPathKey: 'mock-execution-path',
    orderId: null,
    mode: 'generic',
    ...overrides,
  };
}

function makePromotion(
  overrides: Partial<PromotionPreparedTxEntry> = {},
): PromotionPreparedTxEntry {
  return {
    issuedAt: Date.now(),
    receiptId: 'pid-promo-default',
    senderAddress: SENDER_A,
    reservedGasMist: 1_650_000n,
    nonce: 0n,
    txBytesHash: 'hash-promo-default',
    sponsorAddress: SLOT_A,
    clientIp: IP_1,
    executionPathKey: 'promotion:test',
    orderId: null,
    mode: 'promotion',
    promotionId: 'promo-001',
    userId: 'user-001',
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// Conformance suite
// ─────────────────────────────────────────────

export function runPrepareStoreConformanceTests(factory: PrepareStoreFactory): void {
  let handle: PrepareStoreHandle | null = null;

  async function setup(
    partial: Partial<PrepareStoreFactoryOpts> = {},
  ): Promise<PrepareStoreHandle> {
    const resolved: PrepareStoreFactoryOpts = {
      ttlMs: 60_000,
      maxPerIp: 2,
      maxPerStudioUser: 3,
      maxOutstandingPerSender: 3,
      ...partial,
    };
    handle = await factory(resolved);
    return handle;
  }

  afterEach(async () => {
    if (handle) {
      await handle.dispose();
      handle = null;
    }
  });

  // ── store + consume ───────────────────────────────

  describe('store + consume', () => {
    it('store and consume — happy path', async () => {
      const h = await setup();
      const entry = makeGeneric({ receiptId: 'pid-1', txBytesHash: 'hash-1' });
      await h.store.store('pid-1', entry);

      const result = await h.store.consume('pid-1', 'hash-1');
      expect(result).not.toBe('not_found');
      expect(result).not.toBe('expired');
      expect(result).not.toBe('hash_mismatch');
      const entryResult = result as PreparedTxEntry;
      expect(entryResult.receiptId).toBe('pid-1');
      expect(entryResult.txBytesHash).toBe('hash-1');
      // Slot NOT released by consume — caller's responsibility.
      expect(h.releasedSlots).toEqual([]);
    });

    it('consume is single-use — second consume returns not_found', async () => {
      const h = await setup();
      await h.store.store('pid-1', makeGeneric({ receiptId: 'pid-1', txBytesHash: 'hash-1' }));

      const first = await h.store.consume('pid-1', 'hash-1');
      expect(typeof first).toBe('object');
      const second = await h.store.consume('pid-1', 'hash-1');
      expect(second).toBe('not_found');
    });

    it('consume — not_found for unknown receiptId', async () => {
      const h = await setup();
      const result = await h.store.consume('pid-unknown', 'anything');
      expect(result).toBe('not_found');
    });

    it('stores and returns isolated current-shape records', async () => {
      const h = await setup();
      const input = makeGeneric({ receiptId: 'pid-isolated', txBytesHash: 'hash-original' });
      await h.store.store('pid-isolated', input);

      (input as { txBytesHash: string }).txBytesHash = 'hash-mutated-input';
      const firstPeek = await h.store.peek('pid-isolated');
      expect(firstPeek?.txBytesHash).toBe('hash-original');

      (firstPeek as { txBytesHash: string }).txBytesHash = 'hash-mutated-peek';
      const secondPeek = await h.store.peek('pid-isolated');
      expect(secondPeek?.txBytesHash).toBe('hash-original');

      const consumed = await h.store.consume('pid-isolated', 'hash-original');
      expect(typeof consumed).toBe('object');
      expect((consumed as PreparedTxEntry).txBytesHash).toBe('hash-original');
    });

    it('rejects a key/entry receipt mismatch before creating a record', async () => {
      const h = await setup();
      await expect(
        h.store.store('key-receipt', makeGeneric({ receiptId: 'row-receipt' })),
      ).rejects.toThrow('receiptId argument must match entry.receiptId');
      await expect(h.store.peek('key-receipt')).resolves.toBeNull();
      await expect(h.store.peek('row-receipt')).resolves.toBeNull();
      expect(h.releasedSlots).toEqual([]);
    });

    it('rejects non-current runtime records before storing them', async () => {
      const h = await setup();
      const generic = makeGeneric({ receiptId: 'pid-invalid' });
      const promotion = makePromotion({ receiptId: 'pid-invalid' });
      const invalid: unknown[] = [
        { ...generic, unexpected: true },
        { ...generic, mode: 'future' },
        { ...generic, issuedAt: '1' },
        { ...generic, nonce: -1n },
        { ...generic, orderId: 7 },
        { ...generic, promotionId: 'cross-mode' },
        Object.fromEntries(Object.entries(promotion).filter(([key]) => key !== 'userId')),
      ];

      for (const candidate of invalid) {
        await expect(h.store.store('pid-invalid', candidate as PreparedTxEntry)).rejects.toThrow();
      }
      await expect(h.store.peek('pid-invalid')).resolves.toBeNull();
    });
  });

  // ── Expiry ───────────────────────────────────────

  describe('expiry', () => {
    it('consume — expired entry releases slot', async () => {
      const h = await setup({ ttlMs: 100 });
      await h.store.store(
        'pid-1',
        makeGeneric({
          receiptId: 'pid-1',
          sponsorAddress: SLOT_A,
          txBytesHash: 'hash-1',
          issuedAt: Date.now() - 200,
        }),
      );

      const result = await h.store.consume('pid-1', 'hash-1');
      expect(result).toBe('expired');
      expect(h.releasedSlots).toEqual([
        { sponsorAddress: SLOT_A, receiptId: 'pid-1', txBytesHash: 'hash-1' },
      ]);
    });

    it('peek — returns null for expired entry', async () => {
      const h = await setup({ ttlMs: 100 });
      await h.store.store(
        'pid-exp',
        makeGeneric({ receiptId: 'pid-exp', issuedAt: Date.now() - 200 }),
      );
      expect(await h.store.peek('pid-exp')).toBeNull();
    });
  });

  // ── Hash mismatch ───────────────────────────────

  describe('hash mismatch', () => {
    it('consume — hash_mismatch releases slot', async () => {
      const h = await setup();
      await h.store.store(
        'pid-1',
        makeGeneric({ receiptId: 'pid-1', sponsorAddress: SLOT_B, txBytesHash: 'correct-hash' }),
      );

      const result = await h.store.consume('pid-1', 'wrong-hash');
      expect(result).toBe('hash_mismatch');
      expect(h.releasedSlots).toEqual([
        { sponsorAddress: SLOT_B, receiptId: 'pid-1', txBytesHash: 'correct-hash' },
      ]);
    });
  });

  // ── IP concurrency ──────────────────────────────

  describe('IP concurrency', () => {
    it('IP max concurrent — oldest evicted and slot released on overflow', async () => {
      const h = await setup({ maxPerIp: 2 });

      await h.store.store(
        'pid-1',
        makeGeneric({
          receiptId: 'pid-1',
          sponsorAddress: SLOT_A,
          txBytesHash: 'h1',
          clientIp: IP_1,
          issuedAt: 1_000,
          senderAddress: SENDER_A,
        }),
      );
      await h.store.store(
        'pid-2',
        makeGeneric({
          receiptId: 'pid-2',
          sponsorAddress: SLOT_B,
          txBytesHash: 'h2',
          clientIp: IP_1,
          issuedAt: 2_000,
          senderAddress: SENDER_B,
        }),
      );
      await h.store.store(
        'pid-3',
        makeGeneric({
          receiptId: 'pid-3',
          sponsorAddress: SLOT_C,
          txBytesHash: 'h3',
          clientIp: IP_1,
          issuedAt: 3_000,
          // Distinct sender keeps this test focused on IP-overflow semantics
          // and avoids colliding with studio-user-quota eviction paths.
          senderAddress: '0xSENDER_C',
        }),
      );

      expect(h.releasedSlots).toEqual([
        { sponsorAddress: SLOT_A, receiptId: 'pid-1', txBytesHash: 'h1' },
      ]);
      expect(await h.store.consume('pid-1', 'h1')).toBe('not_found');
      expect(await h.store.consume('pid-2', 'h2')).not.toBe('not_found');
      expect(await h.store.consume('pid-3', 'h3')).not.toBe('not_found');
    });

    it('different IPs do not interfere', async () => {
      const h = await setup({ maxPerIp: 2 });

      await h.store.store(
        'pid-1',
        makeGeneric({
          receiptId: 'pid-1',
          sponsorAddress: SLOT_A,
          clientIp: IP_1,
          txBytesHash: 'h1',
          senderAddress: SENDER_A,
        }),
      );
      await h.store.store(
        'pid-2',
        makeGeneric({
          receiptId: 'pid-2',
          sponsorAddress: SLOT_B,
          clientIp: IP_1,
          txBytesHash: 'h2',
          senderAddress: SENDER_B,
        }),
      );
      await h.store.store(
        'pid-3',
        makeGeneric({
          receiptId: 'pid-3',
          sponsorAddress: SLOT_C,
          clientIp: IP_2,
          txBytesHash: 'h3',
          senderAddress: '0xSENDER_C',
        }),
      );

      expect(h.releasedSlots).toEqual([]);
    });

    it('consume cleans up IP index — allows new entries after consume', async () => {
      const h = await setup({ maxPerIp: 2 });
      const base = Date.now();

      await h.store.store(
        'pid-1',
        makeGeneric({
          receiptId: 'pid-1',
          sponsorAddress: SLOT_A,
          clientIp: IP_1,
          txBytesHash: 'h1',
          senderAddress: SENDER_A,
          issuedAt: base,
        }),
      );
      await h.store.store(
        'pid-2',
        makeGeneric({
          receiptId: 'pid-2',
          sponsorAddress: SLOT_B,
          clientIp: IP_1,
          txBytesHash: 'h2',
          senderAddress: SENDER_B,
          issuedAt: base + 1,
        }),
      );

      await h.store.consume('pid-1', 'h1');

      await h.store.store(
        'pid-3',
        makeGeneric({
          receiptId: 'pid-3',
          sponsorAddress: SLOT_C,
          clientIp: IP_1,
          txBytesHash: 'h3',
          senderAddress: '0xSENDER_C',
          issuedAt: base + 2,
        }),
      );

      // consume() itself does NOT release — sponsor processing does.
      // store() must not evict anything because the IP has one outstanding
      // entry (pid-2).
      expect(h.releasedSlots).toEqual([]);
    });
  });

  // ── peek ────────────────────────────────────────

  describe('peek', () => {
    it('returns entry without consuming', async () => {
      const h = await setup();
      await h.store.store('pid-1', makeGeneric({ receiptId: 'pid-1', txBytesHash: 'hash-1' }));
      const peeked = await h.store.peek('pid-1');
      expect(peeked).not.toBeNull();
      expect(peeked!.txBytesHash).toBe('hash-1');

      const consumed = await h.store.consume('pid-1', 'hash-1');
      expect(typeof consumed).toBe('object');
    });

    it('returns null for unknown receiptId', async () => {
      const h = await setup();
      expect(await h.store.peek('pid-unknown')).toBeNull();
    });
  });

  // ── reserveNonce / releaseReservation ─────────────

  describe('reserveNonce / releaseReservation', () => {
    it('returns distinct values for the same sender', async () => {
      const h = await setup();
      await expect(h.store.reserveNonce(SENDER_A, 0n, 'res-1')).resolves.toBe(1n);
      await expect(h.store.reserveNonce(SENDER_A, 0n, 'res-2')).resolves.toBe(2n);
      await expect(h.store.reserveNonce(SENDER_A, 1n, 'res-3')).resolves.toBe(3n);
      await h.store.releaseReservation('res-1', SENDER_A);
      await h.store.releaseReservation('res-2', SENDER_A);
      await h.store.releaseReservation('res-3', SENDER_A);
    });

    it('releaseReservation cleans up pending nonce on pre-store failure', async () => {
      const h = await setup();
      const nonce = await h.store.reserveNonce(SENDER_A, 5n, 'res-fail');
      expect(nonce).toBe(6n);

      await h.store.releaseReservation('res-fail', SENDER_A);

      // Next reservation should not see the released nonce in pending.
      await expect(h.store.reserveNonce(SENDER_A, 5n, 'res-retry')).resolves.toBe(6n);
      await h.store.releaseReservation('res-retry', SENDER_A);
    });

    it('releaseReservation does not damage a live entry promoted under the same receiptId', async () => {
      // Contract: releaseReservation removes only pending reservations.
      // After store() promotes the pending reservation to a live entry,
      // calling releaseReservation with the same id MUST be a no-op for
      // the live entry. The runner protects this with
      // `store()` → `transferOwnership()` ordering, but the store
      // contract has to hold even when called directly.
      const h = await setup();

      const live = await h.store.reserveNonce(SENDER_A, 5n, 'pid-live');
      expect(live).toBe(6n);

      await h.store.store(
        'pid-live',
        makeGeneric({
          receiptId: 'pid-live',
          senderAddress: SENDER_A,
          nonce: live,
          txBytesHash: 'hash-live',
          sponsorAddress: SLOT_A,
        }),
      );

      // Direct release after promotion — must not remove the live nonce
      // from sender-local metadata.
      await h.store.releaseReservation('pid-live', SENDER_A);

      // The live entry's nonce must still raise the next reservation
      // (the live nonce is observed via sender metadata).
      await expect(h.store.reserveNonce(SENDER_A, 5n, 'pid-next')).resolves.toBe(7n);

      // The live entry itself must remain peekable, unchanged.
      const peeked = await h.store.peek('pid-live');
      expect(peeked).not.toBeNull();
      expect(peeked!.nonce).toBe(live);
      expect(peeked!.txBytesHash).toBe('hash-live');

      await h.store.releaseReservation('pid-next', SENDER_A);
    });

    it('concurrent reservations for the same sender get distinct nonces', async () => {
      const h = await setup();
      const n1 = await h.store.reserveNonce(SENDER_A, 0n, 'res-a');
      const n2 = await h.store.reserveNonce(SENDER_A, 0n, 'res-b');
      expect(n1).toBe(1n);
      expect(n2).toBe(2n);
      await h.store.releaseReservation('res-a', SENDER_A);
      await h.store.releaseReservation('res-b', SENDER_A);
    });

    it('enforces verified sender outstanding quota across pending reservations', async () => {
      const h = await setup({ maxOutstandingPerSender: 2 });
      await expect(h.store.reserveNonce(SENDER_A, 0n, 'res-a')).resolves.toBe(1n);
      await expect(h.store.reserveNonce(SENDER_A, 0n, 'res-b')).resolves.toBe(2n);
      await expect(h.store.reserveNonce(SENDER_A, 0n, 'res-c')).rejects.toBeInstanceOf(
        PrepareSenderQuotaError,
      );
      await h.store.releaseReservation('res-a', SENDER_A);
      await h.store.releaseReservation('res-b', SENDER_A);
    });
  });

  // ── Studio-user outstanding-prepare quota ──────────────

  describe('studio-user quota', () => {
    it('generic mode — studio-user quota is NOT enforced', async () => {
      const h = await setup({ maxPerStudioUser: 1, maxPerIp: 10 });

      // Store two generic entries from the same sender. The studio-user
      // outstanding-prepare quota is keyed by verified developer JWT
      // `userId`, which is absent on the generic path; the gate therefore
      // never runs.
      await h.store.store(
        'g-1',
        makeGeneric({
          receiptId: 'g-1',
          sponsorAddress: SLOT_A,
          txBytesHash: 'h1',
          senderAddress: SENDER_A,
        }),
      );
      await h.store.store(
        'g-2',
        makeGeneric({
          receiptId: 'g-2',
          sponsorAddress: SLOT_B,
          txBytesHash: 'h2',
          senderAddress: SENDER_A,
        }),
      );

      expect(await h.store.peek('g-1')).not.toBeNull();
      expect(await h.store.peek('g-2')).not.toBeNull();
    });

    it('promotion mode — rejects entry exceeding maxPerStudioUser', async () => {
      const h = await setup({ maxPerStudioUser: 2, maxPerIp: 10 });

      await h.store.store(
        'p-1',
        makePromotion({
          receiptId: 'p-1',
          sponsorAddress: SLOT_A,
          txBytesHash: 'ph1',
          senderAddress: SENDER_A,
        }),
      );
      await h.store.store(
        'p-2',
        makePromotion({
          receiptId: 'p-2',
          sponsorAddress: SLOT_B,
          txBytesHash: 'ph2',
          senderAddress: SENDER_A,
        }),
      );
      await expect(
        h.store.store(
          'p-3',
          makePromotion({
            receiptId: 'p-3',
            sponsorAddress: SLOT_C,
            txBytesHash: 'ph3',
            senderAddress: SENDER_A,
          }),
        ),
      ).rejects.toBeInstanceOf(PrepareStudioUserQuotaError);
    });

    it('cross-mode isolation — generic entries do NOT count toward promotion quota', async () => {
      const h = await setup({ maxPerStudioUser: 1, maxPerIp: 10 });

      await h.store.store(
        'g-1',
        makeGeneric({
          receiptId: 'g-1',
          sponsorAddress: SLOT_A,
          txBytesHash: 'h1',
          senderAddress: SENDER_A,
        }),
      );
      // Promotion bucket is empty for this sender, so this must succeed
      // even though generic has an outstanding entry.
      await h.store.store(
        'p-1',
        makePromotion({
          receiptId: 'p-1',
          sponsorAddress: SLOT_B,
          txBytesHash: 'ph1',
          senderAddress: SENDER_A,
        }),
      );
      expect(await h.store.peek('p-1')).not.toBeNull();
    });

    it('checkUserQuota returns ok under limit and exceeded at limit', async () => {
      const h = await setup({ maxPerStudioUser: 1, maxPerIp: 10 });

      await expect(h.store.checkUserQuota('user-001')).resolves.toBe('ok');

      await h.store.store(
        'p-1',
        makePromotion({
          receiptId: 'p-1',
          sponsorAddress: SLOT_A,
          txBytesHash: 'ph1',
          senderAddress: SENDER_A,
        }),
      );

      await expect(h.store.checkUserQuota('user-001')).resolves.toEqual({
        exceeded: true,
        limit: 1,
      });
    });

    it('checkUserQuota drops logically expired entries from the count', async () => {
      // Shared contract: a promotion entry whose logical TTL has
      // elapsed must not count toward the user quota even if its
      // backing storage row is still present. Memory drops via
      // `now - issuedAt > ttlMs`; Redis drops via the same condition
      // in CHECK_USER_QUOTA_SCRIPT. Both backends honor the same
      // STORE_SCRIPT-equivalent live-entry rule.
      //
      // Test design: maxPerStudioUser=1 + 1 past-dated entry is the
      // minimum case that distinguishes "count physical existence"
      // from "count logical liveness". With maxPerStudioUser=2 and
      // multiple past-dated stores, STORE_SCRIPT's in-place compaction
      // collapses the user index to one entry on each successive
      // store(), so a physical-existence count of 1 is still under
      // any quota >= 2 and the test would pass even under a buggy
      // precheck. With maxPerStudioUser=1 the single past-dated
      // entry forces the comparison: a physical-existence count of 1
      // crosses the threshold, while a correct logical-liveness count
      // of 0 stays under it.
      //
      // ttlMs is left at the conformance default (60s) so the user
      // index physical PX (2 * ttlMs = 120s) cannot expire during the
      // test, which would otherwise let `if not userRaw then return 0`
      // produce 'ok' for the wrong reason.
      const h = await setup({ maxPerStudioUser: 1, maxPerIp: 10 });

      // Past-date issuedAt past the conformance ttlMs default so the
      // entry lands already logically expired (same pattern as the
      // consume/peek expiry conformance tests above). No real-time
      // sleep needed.
      const pastIssuedAt = Date.now() - 60_001;
      await h.store.store(
        'p-old',
        makePromotion({
          receiptId: 'p-old',
          sponsorAddress: SLOT_A,
          txBytesHash: 'ph-old',
          issuedAt: pastIssuedAt,
        }),
      );

      // The single userIndex entry is logically expired. A precheck
      // that only counts physical existence would return exceeded
      // (1 >= 1); the correct logical-liveness precheck returns 'ok'.
      await expect(h.store.checkUserQuota('user-001')).resolves.toBe('ok');
    });
  });

  // ── evictPreparedEntry ────────────────────────────────

  describe('evictPreparedEntry', () => {
    it('is idempotent on missing entry', async () => {
      const h = await setup();
      // No entry stored under this receiptId — must not throw.
      await expect(h.store.evictPreparedEntry('pid-never-stored')).resolves.toBeUndefined();
      expect(h.releasedSlots).toEqual([]);
    });
  });
}
