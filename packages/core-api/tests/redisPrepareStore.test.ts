/**
 * RedisPrepareStore — PrepareStoreAdapter conformance + Redis-specific cases.
 *
 * The shared behavioral contract is exercised by
 * `prepareStore.conformance.ts` and runs here under the
 * "RedisPrepareStore — shared conformance" describe.
 *
 * Redis-specific persistence / schema / serialization cases live
 * under "RedisPrepareStore — Redis-specific". They exist because
 * RedisPrepareStore is the only backend that:
 *   - serializes BigInt to strings and back (JSON round-trip)
 *   - stores one exact current generic/Promotion JSON shape
 *   - has a physical key that outlives the logical TTL (grace window)
 *   - must tolerate / reject various forms of storage-layer corruption
 *
 * References:
 *   redisPrepareStore.ts — implementation under test
 *   fakeRedisClient.ts — STORE/CONSUME Lua emulation
 *   prepareTypes.ts — PrepareStoreAdapter interface
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedisClient } from './helpers/fakeRedisClient.js';
import { RedisPrepareStore } from '../src/store/redisPrepareStore.js';
import type {
  GenericPreparedTxDraft,
  GenericPreparedTxEntry,
  PreparedTxEntry,
  PromotionPreparedTxDraft,
  PromotionPreparedTxEntry,
} from '../src/store/prepareTypes.js';
import {
  runPrepareStoreConformanceTests,
  type PrepareStoreFactory,
  type PrepareStoreHandle,
  type ReleasedSlot,
} from './prepareStore.conformance.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<GenericPreparedTxDraft> = {}): GenericPreparedTxDraft {
  return {
    receiptId: 'pay-001',
    senderAddress: '0xSENDER',
    nonce: 1n,
    executionPathKey: 'direct',
    txBytesHash: 'hash-aaa',
    sponsorAddress: 'slot-1',
    clientIp: '10.0.0.1',
    orderId: null,
    mode: 'generic',
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// Shared conformance suite
// ─────────────────────────────────────────────

const redisConformanceFactory: PrepareStoreFactory = ({
  ttlMs,
  maxPerIp,
  maxPerStudioUser,
  maxOutstandingPerSender,
}) => {
  const releasedSlots: ReleasedSlot[] = [];
  let nowMs = 1_700_000_000_000;
  const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  const redis = new FakeRedisClient();
  const store = new RedisPrepareStore(
    redis,
    (sponsorAddress, receiptId, txBytesHash) => {
      releasedSlots.push({ sponsorAddress, receiptId, txBytesHash });
    },
    { ttlMs, maxPerIp, maxPerStudioUser, maxOutstandingPerSender },
  );
  const handle: PrepareStoreHandle = {
    store,
    releasedSlots,
    setNowMs: (value) => {
      nowMs = value;
    },
    advanceNowMs: (deltaMs) => {
      nowMs += deltaMs;
    },
    // FakeRedisClient has no long-lived handle to release; the Redis
    // adapter itself does not hold timers, so there is no teardown
    // required beyond dropping the references.
    dispose: () => {
      dateNow.mockRestore();
    },
  };
  return handle;
};

describe('RedisPrepareStore — shared conformance', () => {
  runPrepareStoreConformanceTests(redisConformanceFactory);
});

// ─────────────────────────────────────────────
// Redis-specific tests
// ─────────────────────────────────────────────

const mockOnRelease =
  vi.fn<(sponsorAddress: string, receiptId: string, txBytesHash: string | null) => void>();

describe('RedisPrepareStore — Redis-specific', () => {
  // These tests exercise behaviors that only the Redis backend exhibits:
  //   - JSON BigInt round-trip fidelity
  //   - exact current field-set and decimal-string rejection rules
  //   - Grace-window semantics (logical TTL < physical key PX)
  //   - Corruption tolerance paths (missing / wrong / malformed entries)
  //   - Sender-metadata bookkeeping that Redis maintains under its own keys
  // They are intentionally NOT part of the shared conformance suite.

  let redis: FakeRedisClient;
  let store: RedisPrepareStore;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = new FakeRedisClient();
    store = new RedisPrepareStore(redis, mockOnRelease, {
      ttlMs: 60_000,
      maxPerIp: 2,
      maxPerStudioUser: 10,
      maxOutstandingPerSender: 10,
    });
  });

  // ── BigInt serialization (round-trip fidelity) ───────────────────

  it('store → consume happy path preserves coordination BigInt (`nonce`) and carries no settle observability copies', async () => {
    const entry = makeEntry();
    const committed = await store.store(entry);
    expect(committed.receiptId).toBe(entry.receiptId);
    expect(committed.issuedAt).toEqual(expect.any(Number));

    const result = await store.consume('pay-001', 'hash-aaa');
    const consumed = result as PreparedTxEntry;
    expect(consumed.receiptId).toBe('pay-001');
    // The only generic BigInt field is `nonce` (coordination).
    const generic = consumed as GenericPreparedTxEntry;
    expect(generic.nonce).toBe(1n);
    // Settle observability fields are not persisted — sponsor reads each
    // value from `parseSettleArgs(txBytes)`.
    expect(generic).not.toHaveProperty('executionCostClaim');
    expect(generic).not.toHaveProperty('simGas');
    expect(generic).not.toHaveProperty('gasVarianceFixedMist');
    expect(generic).not.toHaveProperty('slippageBufferMist');
    expect(generic).not.toHaveProperty('grossGas');
    expect(generic).not.toHaveProperty('quotedHostFeeMist');
    expect(generic).not.toHaveProperty('profile');
    expect(generic).not.toHaveProperty('quoteTimestampMs');
    expect(generic).not.toHaveProperty('policyHash');

    expect(mockOnRelease).not.toHaveBeenCalled();
  });

  // ── Constructor validation ──────────────────────────────────────

  it('rejects ttlMs <= 0', () => {
    expect(() => new RedisPrepareStore(redis, mockOnRelease, { ttlMs: 0 })).toThrow(
      'ttlMs must be > 0',
    );
    expect(() => new RedisPrepareStore(redis, mockOnRelease, { ttlMs: 1.5 })).toThrow(
      'safe integer',
    );
  });

  it('rejects maxPerIp < 1', () => {
    expect(() => new RedisPrepareStore(redis, mockOnRelease, { maxPerIp: 0 })).toThrow(
      'maxPerIp must be >= 1',
    );
    expect(() => new RedisPrepareStore(redis, mockOnRelease, { maxPerIp: 1.5 })).toThrow(
      'safe integer',
    );
  });

  it('rejects a malformed IP index before creating any prepared commit projection', async () => {
    const receiptId = 'fake-no-partial';
    const clientIp = '10.0.0.98';
    const senderAddress = '0xFAKE_NO_PARTIAL';
    const ipKey = `stelis:prepare:ip:${clientIp}`;
    await redis.set(ipKey, '{not-valid-json', { px: 120_000 });

    await expect(
      store.store(
        makeEntry({
          receiptId,
          clientIp,
          senderAddress,
          sponsorAddress: 'slot-fake-no-partial',
        }),
      ),
    ).rejects.toThrow();

    await expect(redis.get(`stelis:prepare:${receiptId}`)).resolves.toBeNull();
    await expect(redis.get(`stelis:prepare:sender:${senderAddress}`)).resolves.toBeNull();
    await expect(redis.get(ipKey)).resolves.toBe('{not-valid-json');
  });

  // ── Redis sender-metadata bookkeeping ────────────────────────────

  it('reserveNonce derives max from live sender entries (sender-local metadata)', async () => {
    const sender = '0xNONCE_RECOVER';
    await store.store(
      makeEntry({
        receiptId: 'recover-pid-1',
        senderAddress: sender,
        clientIp: '10.9.0.1',
        sponsorAddress: 'slot-r1',
        txBytesHash: 'hash-r1',
        nonce: 7n,
      }),
    );
    await store.store(
      makeEntry({
        receiptId: 'recover-pid-2',
        senderAddress: sender,
        clientIp: '10.9.0.2',
        sponsorAddress: 'slot-r2',
        txBytesHash: 'hash-r2',
        nonce: 9n,
      }),
    );

    await expect(store.reserveNonce(sender, 3n, 'res-1')).resolves.toBe(10n);
    await expect(store.reserveNonce(sender, 3n, 'res-2')).resolves.toBe(11n);
  });

  it('reserveNonce preserves u64 precision beyond JS safe integer range', async () => {
    const sender = '0xNONCE_BIG';
    const bigNonce = 9_007_199_254_740_999n;

    await store.store(
      makeEntry({
        receiptId: 'big-pid-1',
        senderAddress: sender,
        clientIp: '10.10.0.1',
        sponsorAddress: 'slot-big',
        txBytesHash: 'hash-big',
        nonce: bigNonce,
      }),
    );
    await expect(store.reserveNonce(sender, 0n, 'res-1')).resolves.toBe(bigNonce + 1n);
  });

  it('store() for one reservation preserves unrelated pending reservations', async () => {
    const sender = '0xPENDING_SURVIVE';
    const nonceA = await store.reserveNonce(sender, 0n, 'res-A');
    const nonceB = await store.reserveNonce(sender, 0n, 'res-B');
    expect(nonceA).toBe(1n);
    expect(nonceB).toBe(2n);

    await store.store(
      makeEntry({
        receiptId: 'res-A',
        senderAddress: sender,
        clientIp: '10.20.0.1',
        sponsorAddress: 'slot-A',
        txBytesHash: 'hash-A',
        nonce: nonceA,
      }),
    );

    const nonceC = await store.reserveNonce(sender, 0n, 'res-C');
    expect(nonceC).toBe(3n);

    await store.releaseReservation('res-B', sender);
    await store.releaseReservation('res-C', sender);
  });

  it('IP and sender indexes contain only coordination fields', async () => {
    const sender = '0xINDEX_SHAPE';
    const clientIp = '10.21.0.1';
    await store.store(
      makeEntry({
        receiptId: 'index-shape',
        senderAddress: sender,
        clientIp,
        sponsorAddress: 'sponsor-index-shape',
        nonce: 7n,
      }),
    );

    const ipRows = JSON.parse((await redis.get(`stelis:prepare:ip:${clientIp}`))!);
    const senderRows = JSON.parse((await redis.get(`stelis:prepare:sender:${sender}`))!);
    expect(Object.keys(ipRows[0]).sort()).toEqual(['pid', 't']);
    expect(Object.keys(senderRows[0]).sort()).toEqual(['nonce', 'pid', 't']);
  });

  it('consume removes live nonce from sender metadata so next reserve ignores it', async () => {
    const sender = '0xCONSUME_CLEANUP';
    const nonce = await store.reserveNonce(sender, 5n, 'res-consume');
    expect(nonce).toBe(6n);

    await store.store(
      makeEntry({
        receiptId: 'res-consume',
        senderAddress: sender,
        clientIp: '10.30.0.1',
        sponsorAddress: 'slot-consume',
        txBytesHash: 'hash-consume',
        nonce,
      }),
    );

    const result = await store.consume('res-consume', 'hash-consume');
    expect(result).not.toBe('not_found');
    expect(result).not.toBe('expired');
    expect(result).not.toBe('hash_mismatch');

    const nextNonce = await store.reserveNonce(sender, 5n, 'res-after-consume');
    expect(nextNonce).toBe(6n);
    await store.releaseReservation('res-after-consume', sender);
  });

  it('IP eviction removes same-sender evicted nonce from sender metadata', async () => {
    const sender = '0xIP_EVICT_SENDER';
    const ip = '10.50.0.1';

    await store.reserveNonce(sender, 0n, 'evict-A');
    await store.store(
      makeEntry({
        receiptId: 'evict-A',
        senderAddress: sender,
        clientIp: ip,
        sponsorAddress: 'slot-evA',
        txBytesHash: 'hash-evA',
        nonce: 1n,
      }),
    );
    await store.reserveNonce(sender, 0n, 'evict-B');
    await store.store(
      makeEntry({
        receiptId: 'evict-B',
        senderAddress: sender,
        clientIp: ip,
        sponsorAddress: 'slot-evB',
        txBytesHash: 'hash-evB',
        nonce: 2n,
      }),
    );

    await store.reserveNonce(sender, 0n, 'evict-C');
    await store.store(
      makeEntry({
        receiptId: 'evict-C',
        senderAddress: sender,
        clientIp: ip,
        sponsorAddress: 'slot-evC',
        txBytesHash: 'hash-evC',
        nonce: 3n,
      }),
    );

    await store.consume('evict-B', 'hash-evB');
    await store.consume('evict-C', 'hash-evC');

    const next = await store.reserveNonce(sender, 0n, 'evict-D');
    expect(next).toBe(1n);
    await store.releaseReservation('evict-D', sender);
  });

  // ── Grace window (logical TTL < physical PX) ────────────────────

  it('reserveNonce ignores logically expired live entries even if key still exists', async () => {
    const shortStore = new RedisPrepareStore(redis, () => {}, {
      keyPrefix: 'stelis:prepare:',
      ttlMs: 100,
      maxPerIp: 10,
    });
    const sender = '0xGRACE_WINDOW';

    await shortStore.reserveNonce(sender, 0n, 'grace-A');
    await shortStore.store(
      makeEntry({
        receiptId: 'grace-A',
        senderAddress: sender,
        clientIp: '10.60.0.1',
        sponsorAddress: 'slot-gA',
        txBytesHash: 'hash-gA',
        nonce: 1n,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 120));

    const next = await shortStore.reserveNonce(sender, 0n, 'grace-B');
    expect(next).toBe(1n);
    await shortStore.releaseReservation('grace-B', sender);
  });

  it('checkUserQuota ignores logically expired promotion entries inside the physical key grace window', async () => {
    // Regression: production Redis precheck used to count any promotion
    // entry whose physical key was still present, including the
    // PREPARE_STORE_KEY_TTL_GRACE_MS window past logical TTL. STORE_SCRIPT
    // already compacts on `item.t + ttlMs >= nowMs`, so the precheck
    // false-rejected new prepares that the authoritative store-time
    // quota would accept. CHECK_USER_QUOTA_SCRIPT now uses the same
    // Redis `TIME` baseline and the same live-entry condition.
    const shortStore = new RedisPrepareStore(redis, () => {}, {
      keyPrefix: 'stelis:prepare:',
      ttlMs: 100,
      maxPerIp: 10,
      maxPerStudioUser: 2,
    });
    const userId = 'user-grace-quota';
    const makePromo = (
      receiptId: string,
      sponsorAddress: string,
      txBytesHash: string,
    ): PromotionPreparedTxDraft => ({
      receiptId,
      senderAddress: '0xSENDER_GRACE_QUOTA',
      reservedGasMist: 1_000_000n,
      nonce: 0n,
      txBytesHash,
      sponsorAddress,
      clientIp: '10.80.0.1',
      executionPathKey: 'promotion:grace-quota',
      orderId: null,
      mode: 'promotion',
      promotionId: 'promo-grace-quota',
      userId,
    });

    await shortStore.store(makePromo('gq-A', 'slot-gqA', 'hash-gqA'));
    await shortStore.store(makePromo('gq-B', 'slot-gqB', 'hash-gqB'));

    // Quota is at the limit — precheck reports exceeded while entries
    // are still logically live.
    await expect(shortStore.checkUserQuota(userId)).resolves.toEqual({
      exceeded: true,
      limit: 2,
    });

    // Wait past logical TTL but well inside the 5 s physical PX grace
    // window, so the entry keys still exist in Redis.
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Lock the precondition explicitly: physical entry keys must still
    // be present at this point. Without this, the test could pass for
    // the wrong reason (e.g. the keys also disappeared), which would
    // make it equivalent to "ok after enough time passes" rather than
    // proving the precheck respects logical TTL while physical keys
    // are still in the grace window.
    await expect(redis.get('stelis:prepare:gq-A')).resolves.not.toBeNull();
    await expect(redis.get('stelis:prepare:gq-B')).resolves.not.toBeNull();

    await expect(shortStore.checkUserQuota(userId)).resolves.toBe('ok');

    // STORE_SCRIPT must accept the next promotion entry, proving the
    // precheck and authoritative quota agree on live-entry semantics.
    await expect(
      shortStore.store(makePromo('gq-C', 'slot-gqC', 'hash-gqC')),
    ).resolves.toMatchObject({ receiptId: 'gq-C' });
  });

  it('store() compaction ignores logically expired same-sender entries in grace window', async () => {
    const shortStore = new RedisPrepareStore(redis, () => {}, {
      keyPrefix: 'stelis:prepare:',
      ttlMs: 100,
      maxPerIp: 10,
    });
    const sender = '0xSTORE_GRACE';

    await shortStore.reserveNonce(sender, 0n, 'sg-A');
    await shortStore.store(
      makeEntry({
        receiptId: 'sg-A',
        senderAddress: sender,
        clientIp: '10.70.0.1',
        sponsorAddress: 'slot-sgA',
        txBytesHash: 'hash-sgA',
        nonce: 1n,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 120));

    await shortStore.reserveNonce(sender, 0n, 'sg-B');
    await shortStore.store(
      makeEntry({
        receiptId: 'sg-B',
        senderAddress: sender,
        clientIp: '10.70.0.1',
        sponsorAddress: 'slot-sgB',
        txBytesHash: 'hash-sgB',
        nonce: 1n,
      }),
    );

    const next = await shortStore.reserveNonce(sender, 0n, 'sg-C');
    expect(next).toBe(2n);
    await shortStore.releaseReservation('sg-C', sender);
  });

  // ── Promotion-mode JSON roundtrip (no generic fields in payload) ─

  it('store → consume roundtrip for promotion-mode entry (no generic settle fields)', async () => {
    const promotionEntry: PromotionPreparedTxDraft = {
      receiptId: 'promo-001',
      senderAddress: '0xSENDER',
      reservedGasMist: 1_850_000n,
      nonce: 0n,
      txBytesHash: 'hash-promo',
      sponsorAddress: 'slot-promo',
      clientIp: '10.0.0.1',
      executionPathKey: 'promotion:promo-test',
      orderId: null,
      mode: 'promotion',
      promotionId: 'promo-test',
      userId: 'user-1',
    };

    await store.store(promotionEntry);
    const result = await store.consume('promo-001', 'hash-promo');
    expect(result).not.toBe('not_found');
    expect(result).not.toBe('expired');
    expect(result).not.toBe('hash_mismatch');

    const consumed = result as PromotionPreparedTxEntry;
    expect(consumed.receiptId).toBe('promo-001');
    expect(consumed.mode).toBe('promotion');
    expect(consumed.promotionId).toBe('promo-test');
    expect(consumed.userId).toBe('user-1');
    expect(consumed.reservedGasMist).toBe(1_850_000n);
    expect(consumed.nonce).toBe(0n);
    expect('executionCostClaim' in consumed).toBe(false);
    expect('simGas' in consumed).toBe(false);
    expect('grossGas' in consumed).toBe(false);
    expect('gasVarianceFixedMist' in consumed).toBe(false);
    expect('slippageBufferMist' in consumed).toBe(false);
    expect('quotedHostFeeMist' in consumed).toBe(false);
    expect('profile' in consumed).toBe(false);
    expect('policyHash' in consumed).toBe(false);
    expect('quoteTimestampMs' in consumed).toBe(false);
  });

  // ── Exact current stored shape ────────────────────────────────────

  it('serializes only the current generic fields with canonical decimal strings', async () => {
    const committed = await store.store(makeEntry({ receiptId: 'shape-generic', nonce: 4n }));

    const rawJson = await redis.get('stelis:prepare:shape-generic');
    expect(JSON.parse(rawJson!)).toEqual({
      mode: 'generic',
      issuedAt: expect.any(Number),
      receiptId: 'shape-generic',
      senderAddress: '0xSENDER',
      txBytesHash: 'hash-aaa',
      sponsorAddress: 'slot-1',
      clientIp: '10.0.0.1',
      executionPathKey: 'direct',
      orderId: null,
      nonce: '4',
    });
    expect(JSON.parse(rawJson!).issuedAt).toBe(committed.issuedAt);
  });

  it('projects the exact Promotion shape and rejects a malformed reserved amount', async () => {
    const entry: PromotionPreparedTxDraft = {
      mode: 'promotion',
      receiptId: 'shape-promotion',
      senderAddress: '0xPROMOTION_SENDER',
      txBytesHash: 'hash-shape-promotion',
      sponsorAddress: 'sponsor-shape-promotion',
      clientIp: '10.0.0.8',
      executionPathKey: 'promotion:shape-promotion',
      orderId: null,
      nonce: 0n,
      promotionId: 'shape-promotion',
      userId: 'user-shape-promotion',
      reservedGasMist: 1_500_000n,
    };
    const committed = await store.store(entry);

    const key = `stelis:prepare:${entry.receiptId}`;
    const rawJson = await redis.get(key);
    const raw = JSON.parse(rawJson!);
    expect(raw).toEqual({
      mode: 'promotion',
      issuedAt: committed.issuedAt,
      receiptId: entry.receiptId,
      senderAddress: entry.senderAddress,
      txBytesHash: entry.txBytesHash,
      sponsorAddress: entry.sponsorAddress,
      clientIp: entry.clientIp,
      executionPathKey: entry.executionPathKey,
      orderId: null,
      nonce: '0',
      promotionId: entry.promotionId,
      userId: entry.userId,
      reservedGasMist: '1500000',
    });

    raw.reservedGasMist = '01500000';
    await redis.set(key, JSON.stringify(raw), { PX: 65_000 });
    await expect(store.consume(entry.receiptId, entry.txBytesHash)).rejects.toThrow(
      /canonical unsigned decimal/,
    );
    expect(mockOnRelease).toHaveBeenCalledOnce();
    expect(mockOnRelease).toHaveBeenCalledWith(
      entry.sponsorAddress,
      entry.receiptId,
      entry.txBytesHash,
    );
  });

  it('rejects extra, missing, wrong-type, and unknown-mode stored records', async () => {
    await store.store(makeEntry({ receiptId: 'shape-invalid' }));
    const rawJson = await redis.get('stelis:prepare:shape-invalid');
    const current = JSON.parse(rawJson!) as Record<string, unknown>;
    const missing = { ...current };
    delete missing.senderAddress;
    const malformed: Record<string, unknown>[] = [
      { ...current, unexpected: true },
      missing,
      { ...current, issuedAt: '1' },
      { ...current, senderAddress: { malformed: true } },
      { ...current, orderId: 7 },
      { ...current, mode: 'future' },
      { ...current, promotionId: 'cross-mode' },
    ];

    for (let i = 0; i < malformed.length; i++) {
      const receiptId = `shape-invalid-${i}`;
      await redis.set(
        `stelis:prepare:${receiptId}`,
        JSON.stringify({ ...malformed[i], receiptId }),
        { PX: 65_000 },
      );
      await expect(store.peek(receiptId)).rejects.toThrow();
    }
  });

  it('consume returns raw evidence and releases the key-bound lease once for malformed entry and index types', async () => {
    const receiptId = 'malformed-consume';
    const sponsorAddress = 'sponsor-malformed-consume';
    const txBytesHash = 'hash-malformed-consume';
    const clientIp = '10.0.0.61';
    await store.store(makeEntry({ receiptId, sponsorAddress, txBytesHash, clientIp }));

    const entryKey = `stelis:prepare:${receiptId}`;
    const raw = JSON.parse((await redis.get(entryKey))!);
    raw.receiptId = 'forged-receipt';
    raw.senderAddress = { malformed: true };
    await redis.set(entryKey, JSON.stringify(raw), { PX: 65_000 });
    await redis.set(
      `stelis:prepare:ip:${clientIp}`,
      JSON.stringify([true, { pid: { malformed: true }, t: 'bad' }]),
      { PX: 120_000 },
    );

    await expect(store.consume(receiptId, txBytesHash)).rejects.toThrow(
      /stored receiptId does not match its Redis key/,
    );
    await Promise.resolve();

    expect(mockOnRelease).toHaveBeenCalledOnce();
    expect(mockOnRelease).toHaveBeenCalledWith(sponsorAddress, receiptId, txBytesHash);
    await expect(redis.get(entryKey)).resolves.toBeNull();
  });

  it('rejects non-canonical decimals and releases each recoverable lease once', async () => {
    const malformed = ['01', '-1', '1.0', 1] as const;
    for (let i = 0; i < malformed.length; i++) {
      const receiptId = `decimal-invalid-${i}`;
      const sponsorAddress = `sponsor-decimal-${i}`;
      const txBytesHash = `hash-decimal-${i}`;
      await store.store(makeEntry({ receiptId, sponsorAddress, txBytesHash }));
      const rawJson = await redis.get(`stelis:prepare:${receiptId}`);
      const parsed = JSON.parse(rawJson!);
      parsed.nonce = malformed[i];
      await redis.set(`stelis:prepare:${receiptId}`, JSON.stringify(parsed), { PX: 65_000 });

      await expect(store.consume(receiptId, txBytesHash)).rejects.toThrow();
      expect(mockOnRelease).toHaveBeenCalledTimes(i + 1);
      expect(mockOnRelease).toHaveBeenLastCalledWith(sponsorAddress, receiptId, txBytesHash);
    }
  });

  it('consume releases slot even when JSON BigInt fields are corrupted', async () => {
    const entry = makeEntry({
      receiptId: 'corrupt-bi',
      sponsorAddress: 'slot-corrupt-bi',
      txBytesHash: 'hash-corrupt-bi',
    });
    await store.store(entry);

    const rawJson = await redis.get('stelis:prepare:corrupt-bi');
    const parsed = JSON.parse(rawJson!);
    // The only generic-mode BigInt field is `nonce`; it is the canonical
    // corruption target for this test.
    parsed.nonce = 'not-a-number';
    await redis.set('stelis:prepare:corrupt-bi', JSON.stringify(parsed), { PX: 65_000 });

    await expect(store.consume('corrupt-bi', 'hash-corrupt-bi')).rejects.toThrow();
    expect(mockOnRelease).toHaveBeenCalledWith('slot-corrupt-bi', 'corrupt-bi', 'hash-corrupt-bi');
  });

  it('peek throws on undeserializable entry (handler must call evictPreparedEntry)', async () => {
    const entry = makeEntry({
      receiptId: 'peek-bad',
      sponsorAddress: 'slot-peek-bad',
      txBytesHash: 'hash-peek-bad',
    });
    await store.store(entry);

    const rawJson = await redis.get('stelis:prepare:peek-bad');
    const parsed = JSON.parse(rawJson!);
    parsed.unexpected = true;
    await redis.set('stelis:prepare:peek-bad', JSON.stringify(parsed), { PX: 65_000 });

    await expect(store.peek('peek-bad')).rejects.toThrow(/unexpected field/);
  });

  // ── evictPreparedEntry Redis-specific paths ──────────────────────────

  it('evictPreparedEntry removes the entry and releases the slot', async () => {
    const entry = makeEntry({
      receiptId: 'evict-test',
      sponsorAddress: 'slot-evict',
      txBytesHash: 'hash-evict',
    });
    await store.store(entry);

    const rawJson = await redis.get('stelis:prepare:evict-test');
    const parsed = JSON.parse(rawJson!);
    parsed.unexpected = true;
    await redis.set('stelis:prepare:evict-test', JSON.stringify(parsed), { PX: 65_000 });

    await store.evictPreparedEntry('evict-test');

    expect(mockOnRelease).toHaveBeenCalledWith('slot-evict', 'evict-test', 'hash-evict');
    await expect(store.peek('evict-test')).resolves.toBeNull();
  });

  it('evictPreparedEntry returns raw evidence after malformed cleanup fields and uses the key receipt', async () => {
    const receiptId = 'evict-malformed';
    const sponsorAddress = 'sponsor-evict-malformed';
    const txBytesHash = 'hash-evict-malformed';
    const senderAddress = '0xEVICT_MALFORMED';
    await store.store(makeEntry({ receiptId, sponsorAddress, txBytesHash, senderAddress }));

    const entryKey = `stelis:prepare:${receiptId}`;
    const raw = JSON.parse((await redis.get(entryKey))!);
    raw.receiptId = 'forged-evict-receipt';
    raw.clientIp = { malformed: true };
    await redis.set(entryKey, JSON.stringify(raw), { PX: 65_000 });
    await redis.set(
      `stelis:prepare:sender:${senderAddress}`,
      JSON.stringify([null, { pid: [], t: 'bad' }]),
      { PX: 120_000 },
    );

    await store.evictPreparedEntry(receiptId);
    await store.evictPreparedEntry(receiptId);

    expect(mockOnRelease).toHaveBeenCalledOnce();
    expect(mockOnRelease).toHaveBeenCalledWith(sponsorAddress, receiptId, txBytesHash);
    await expect(redis.get(entryKey)).resolves.toBeNull();
  });

  it('evictPreparedEntry does not throw when raw JSON is malformed', async () => {
    await redis.set('stelis:prepare:garbled', 'not-json-at-all', { PX: 65_000 });

    await expect(store.evictPreparedEntry('garbled')).resolves.toBeUndefined();
    expect(mockOnRelease).not.toHaveBeenCalled();
  });
});

describe('RedisPrepareStore — _onRelease rejection emits SPONSOR_POOL_LEASE_RELEASE_FAILED warn', () => {
  let redis: FakeRedisClient;
  let store: RedisPrepareStore;

  beforeEach(() => {
    redis = new FakeRedisClient();
    store = new RedisPrepareStore(
      redis,
      () => Promise.reject(new Error('release-callback-failed')),
      { ttlMs: 60_000, maxPerIp: 2, maxPerStudioUser: 10 },
    );
  });

  function collectReleaseFailed(warnSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
    return warnSpy.mock.calls
      .map((call: unknown[]) => {
        try {
          return JSON.parse(String(call[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry: Record<string, unknown> | null): entry is Record<string, unknown> =>
          entry?.['event'] === 'SPONSOR_POOL_LEASE_RELEASE_FAILED',
      );
  }

  it('store() IP eviction — release rejection emits warn', async () => {
    const smallStore = new RedisPrepareStore(
      redis,
      () => Promise.reject(new Error('release-callback-failed')),
      { ttlMs: 60_000, maxPerIp: 1, maxPerStudioUser: 10 },
    );
    await smallStore.store(
      makeEntry({
        receiptId: 'pid-a',
        sponsorAddress: 'slot-ip-a',
        clientIp: '10.9.0.1',
        senderAddress: '0xA',
        nonce: 1n,
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await smallStore.store(
        makeEntry({
          receiptId: 'pid-b',
          sponsorAddress: 'slot-ip-b',
          clientIp: '10.9.0.1',
          senderAddress: '0xB',
          nonce: 2n,
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find(
        (w) => w['reason'] === 'ip_concurrent_eviction',
      );
      expect(match).toBeDefined();
      expect(match!['adapter']).toBe('redis-prepare');
      expect(match!['sponsor_address']).toBe('slot-ip-a');
      expect(match!['error']).toBe('release-callback-failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('consume() expired — release rejection emits warn', async () => {
    const issuedAt = Date.now() - 120_000;
    const entryJson = JSON.stringify({
      issuedAt,
      receiptId: 'exp-1',
      senderAddress: '0xSENDER',
      nonce: '1',
      txBytesHash: 'hash-exp',
      sponsorAddress: 'slot-exp',
      clientIp: '10.0.0.1',
      executionPathKey: 'direct',
      orderId: null,
      mode: 'generic',
    });
    await redis.set('stelis:prepare:exp-1', entryJson, { PX: 65_000 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await store.consume('exp-1', 'hash-exp')).toBe('expired');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find((w) => w['reason'] === 'prepare_expired');
      expect(match).toBeDefined();
      expect(match!['adapter']).toBe('redis-prepare');
      expect(match!['sponsor_address']).toBe('slot-exp');
      expect(match!['error']).toBe('release-callback-failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('consume() hash_mismatch — release rejection emits warn', async () => {
    await store.store(
      makeEntry({
        receiptId: 'hm-1',
        sponsorAddress: 'slot-hm',
        txBytesHash: 'correct-hash',
        clientIp: '10.0.0.2',
        senderAddress: '0xHM',
        nonce: 1n,
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await store.consume('hm-1', 'wrong-hash')).toBe('hash_mismatch');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find((w) => w['reason'] === 'hash_mismatch');
      expect(match).toBeDefined();
      expect(match!['adapter']).toBe('redis-prepare');
      expect(match!['sponsor_address']).toBe('slot-hm');
      expect(match!['error']).toBe('release-callback-failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('consume() success with undeserializable entry — raw-entry release rejection emits warn', async () => {
    await store.store(
      makeEntry({
        receiptId: 'raw-1',
        sponsorAddress: 'slot-raw',
        txBytesHash: 'hash-raw',
        clientIp: '10.0.0.3',
        senderAddress: '0xRAW',
        nonce: 1n,
      }),
    );
    // Add a field outside the current shape so deserializeEntry throws on
    // the success branch and forces the raw-entry fallback release path.
    const raw = await redis.get('stelis:prepare:raw-1');
    const parsed = JSON.parse(raw!);
    parsed.unexpected = true;
    await redis.set('stelis:prepare:raw-1', JSON.stringify(parsed), { PX: 65_000 });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(store.consume('raw-1', 'hash-raw')).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find(
        (w) => w['reason'] === 'consume_success_undeserializable',
      );
      expect(match).toBeDefined();
      expect(match!['adapter']).toBe('redis-prepare');
      expect(match!['sponsor_address']).toBe('slot-raw');
      expect(match!['error']).toBe('release-callback-failed');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('RedisPrepareStore — _onRelease synchronous throw emits SPONSOR_POOL_LEASE_RELEASE_FAILED warn', () => {
  let redis: FakeRedisClient;
  let store: RedisPrepareStore;

  beforeEach(() => {
    redis = new FakeRedisClient();
    store = new RedisPrepareStore(
      redis,
      () => {
        throw new Error('release-sync-throw');
      },
      { ttlMs: 60_000, maxPerIp: 2, maxPerStudioUser: 10 },
    );
  });

  function collectReleaseFailed(warnSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
    return warnSpy.mock.calls
      .map((call: unknown[]) => {
        try {
          return JSON.parse(String(call[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry: Record<string, unknown> | null): entry is Record<string, unknown> =>
          entry?.['event'] === 'SPONSOR_POOL_LEASE_RELEASE_FAILED',
      );
  }

  it('store() IP eviction — sync throw emits warn', async () => {
    const smallStore = new RedisPrepareStore(
      redis,
      () => {
        throw new Error('release-sync-throw');
      },
      { ttlMs: 60_000, maxPerIp: 1, maxPerStudioUser: 10 },
    );
    await smallStore.store(
      makeEntry({
        receiptId: 'pid-sa',
        sponsorAddress: 'slot-ip-sa',
        clientIp: '10.9.1.1',
        senderAddress: '0xA',
        nonce: 1n,
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await smallStore.store(
        makeEntry({
          receiptId: 'pid-sb',
          sponsorAddress: 'slot-ip-sb',
          clientIp: '10.9.1.1',
          senderAddress: '0xB',
          nonce: 2n,
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find(
        (w) => w['reason'] === 'ip_concurrent_eviction',
      );
      expect(match).toBeDefined();
      expect(match!['adapter']).toBe('redis-prepare');
      expect(match!['sponsor_address']).toBe('slot-ip-sa');
      expect(match!['error']).toBe('release-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('consume() expired — sync throw emits warn', async () => {
    const issuedAt = Date.now() - 120_000;
    const entryJson = JSON.stringify({
      issuedAt,
      receiptId: 'exp-s1',
      senderAddress: '0xSENDER',
      nonce: '1',
      txBytesHash: 'hash-exp-s',
      sponsorAddress: 'slot-exp-s',
      clientIp: '10.0.0.1',
      executionPathKey: 'direct',
      orderId: null,
      mode: 'generic',
    });
    await redis.set('stelis:prepare:exp-s1', entryJson, { PX: 65_000 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await store.consume('exp-s1', 'hash-exp-s')).toBe('expired');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find((w) => w['reason'] === 'prepare_expired');
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe('slot-exp-s');
      expect(match!['error']).toBe('release-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('consume() hash_mismatch — sync throw emits warn', async () => {
    await store.store(
      makeEntry({
        receiptId: 'hm-s1',
        sponsorAddress: 'slot-hm-s',
        txBytesHash: 'correct-hash',
        clientIp: '10.0.0.2',
        senderAddress: '0xHM',
        nonce: 1n,
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await store.consume('hm-s1', 'wrong-hash')).toBe('hash_mismatch');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find((w) => w['reason'] === 'hash_mismatch');
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe('slot-hm-s');
      expect(match!['error']).toBe('release-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('consume() success with undeserializable entry — raw-entry fallback sync throw emits warn', async () => {
    await store.store(
      makeEntry({
        receiptId: 'raw-s1',
        sponsorAddress: 'slot-raw-s',
        txBytesHash: 'hash-raw-s',
        clientIp: '10.0.0.3',
        senderAddress: '0xRAW',
        nonce: 1n,
      }),
    );
    const raw = await redis.get('stelis:prepare:raw-s1');
    const parsed = JSON.parse(raw!);
    parsed.unexpected = true;
    await redis.set('stelis:prepare:raw-s1', JSON.stringify(parsed), { PX: 65_000 });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(store.consume('raw-s1', 'hash-raw-s')).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find(
        (w) => w['reason'] === 'consume_success_undeserializable',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe('slot-raw-s');
      expect(match!['error']).toBe('release-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('RedisPrepareStore — raw-entry slot-info unrecoverable emits SPONSOR_POOL_SLOT_INFO_UNRECOVERABLE warn', () => {
  let redis: FakeRedisClient;
  let store: RedisPrepareStore;
  // Capture release callback invocations so we can prove
  // raw-entry recovery short-circuits before attempting release
  // when sponsor-address identity cannot be recovered from the raw JSON.
  const onReleaseCalls: Array<{
    sponsorAddress: string;
    receiptId: string;
    txBytesHash: string | null;
  }> = [];

  beforeEach(() => {
    onReleaseCalls.length = 0;
    redis = new FakeRedisClient();
    store = new RedisPrepareStore(
      redis,
      (sponsorAddress, receiptId, txBytesHash) => {
        onReleaseCalls.push({ sponsorAddress, receiptId, txBytesHash });
      },
      { ttlMs: 60_000, maxPerIp: 2, maxPerStudioUser: 10 },
    );
  });

  function collectSlotInfoUnrecoverable(
    warnSpy: ReturnType<typeof vi.spyOn>,
  ): Record<string, unknown>[] {
    return warnSpy.mock.calls
      .map((call: unknown[]) => {
        try {
          return JSON.parse(String(call[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry: Record<string, unknown> | null): entry is Record<string, unknown> =>
          entry?.['event'] === 'SPONSOR_POOL_SLOT_INFO_UNRECOVERABLE',
      );
  }

  it('consume() expired with unrecoverable raw entry emits SPONSOR_POOL_SLOT_INFO_UNRECOVERABLE and does not invoke _onRelease', async () => {
    // Seed an expired entry whose raw JSON has no sponsorAddress field AND is
    // not valid against the schema — forces the expired branch's
    // deserializeEntry to throw, which then falls back to
    // raw-entry recovery, which in turn fails to recover sponsor
    // identity because `sponsorAddress` is missing.
    const issuedAt = Date.now() - 120_000;
    const rawEntry = JSON.stringify({
      issuedAt,
      receiptId: 'slot-info-1',
      // sponsorAddress intentionally omitted so raw identity recovery returns null.
      txBytesHash: 'hash-si',
      clientIp: '10.0.0.9',
      senderAddress: '0xSI',
    });
    await redis.set('stelis:prepare:slot-info-1', rawEntry, { PX: 65_000 });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await store.consume('slot-info-1', 'hash-si');
      expect(result).toBe('expired');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectSlotInfoUnrecoverable(warnSpy).find(
        (w) => w['reason'] === 'prepare_expired_undeserializable',
      );
      expect(match).toBeDefined();
      expect(match!['adapter']).toBe('redis-prepare');
      expect(onReleaseCalls).toEqual([]);

      // The free-form `console.warn('[redis-prepare] cannot extract
      // slot info for cleanup ...')` string must not appear.
      const freeFormWarning = warnSpy.mock.calls.some((call) => {
        const raw = String(call[0] ?? '');
        return raw.includes('[redis-prepare] cannot extract slot info');
      });
      expect(freeFormWarning).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('RedisPrepareStore — _onEntryEvict failures emit PREPARE_STORE_EVICT_CALLBACK_FAILED warn', () => {
  let redis: FakeRedisClient;

  beforeEach(() => {
    redis = new FakeRedisClient();
  });

  function makeStore(
    onEntryEvict: (entry: PreparedTxEntry) => void | Promise<void>,
    opts: { maxPerIp?: number } = {},
  ): RedisPrepareStore {
    return new RedisPrepareStore(
      redis,
      () => {
        /* onRelease: succeed silently, this describe focuses on _onEntryEvict */
      },
      { ttlMs: 60_000, maxPerIp: opts.maxPerIp ?? 2, maxPerStudioUser: 10 },
      onEntryEvict,
    );
  }

  function collectEvictCallbackFailed(
    warnSpy: ReturnType<typeof vi.spyOn>,
  ): Record<string, unknown>[] {
    return warnSpy.mock.calls
      .map((call: unknown[]) => {
        try {
          return JSON.parse(String(call[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry: Record<string, unknown> | null): entry is Record<string, unknown> =>
          entry?.['event'] === 'PREPARE_STORE_EVICT_CALLBACK_FAILED',
      );
  }

  // ── store() IP eviction ──

  it('store() IP eviction — sync throw emits warn', async () => {
    const store = makeStore(
      () => {
        throw new Error('evict-sync-throw');
      },
      { maxPerIp: 1 },
    );
    await store.store(
      makeEntry({
        receiptId: 'pid-a',
        sponsorAddress: 'slot-evict-a',
        clientIp: '10.9.0.10',
        senderAddress: '0xA',
        nonce: 1n,
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await store.store(
        makeEntry({
          receiptId: 'pid-b',
          sponsorAddress: 'slot-evict-b',
          clientIp: '10.9.0.10',
          senderAddress: '0xB',
          nonce: 2n,
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
      const match = collectEvictCallbackFailed(warnSpy).find(
        (w) => w['reason'] === 'ip_concurrent_eviction',
      );
      expect(match).toBeDefined();
      expect(match!['adapter']).toBe('redis-prepare');
      expect(match!['sponsor_address']).toBe('slot-evict-a');
      expect(match!['receipt_id']).toBe('pid-a');
      expect(match!['error']).toBe('evict-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('store() IP eviction — rejected promise emits warn', async () => {
    const store = makeStore(() => Promise.reject(new Error('evict-reject')), { maxPerIp: 1 });
    await store.store(
      makeEntry({
        receiptId: 'pid-a',
        sponsorAddress: 'slot-evict-a',
        clientIp: '10.9.0.11',
        senderAddress: '0xA',
        nonce: 1n,
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await store.store(
        makeEntry({
          receiptId: 'pid-b',
          sponsorAddress: 'slot-evict-b',
          clientIp: '10.9.0.11',
          senderAddress: '0xB',
          nonce: 2n,
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
      const match = collectEvictCallbackFailed(warnSpy).find(
        (w) => w['reason'] === 'ip_concurrent_eviction',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe('slot-evict-a');
      expect(match!['error']).toBe('evict-reject');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── consume() expired ──

  function seedExpired(entryId: string, sponsorAddress: string): Promise<void> {
    const issuedAt = Date.now() - 120_000;
    const entryJson = JSON.stringify({
      issuedAt,
      receiptId: entryId,
      senderAddress: '0xSENDER',
      nonce: '1',
      txBytesHash: 'hash-exp',
      sponsorAddress,
      clientIp: '10.0.0.1',
      executionPathKey: 'direct',
      orderId: null,
      mode: 'generic',
    });
    return redis.set(`stelis:prepare:${entryId}`, entryJson, { PX: 65_000 }).then(() => undefined);
  }

  it('consume() expired — sync throw emits warn', async () => {
    const store = makeStore(() => {
      throw new Error('evict-sync-throw');
    });
    await seedExpired('exp-1', 'slot-exp-1');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await store.consume('exp-1', 'hash-exp')).toBe('expired');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectEvictCallbackFailed(warnSpy).find(
        (w) => w['reason'] === 'prepare_expired',
      );
      expect(match).toBeDefined();
      expect(match!['adapter']).toBe('redis-prepare');
      expect(match!['sponsor_address']).toBe('slot-exp-1');
      expect(match!['receipt_id']).toBe('exp-1');
      expect(match!['error']).toBe('evict-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('consume() expired — rejected promise emits warn', async () => {
    const store = makeStore(() => Promise.reject(new Error('evict-reject')));
    await seedExpired('exp-2', 'slot-exp-2');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await store.consume('exp-2', 'hash-exp')).toBe('expired');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectEvictCallbackFailed(warnSpy).find(
        (w) => w['reason'] === 'prepare_expired',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe('slot-exp-2');
      expect(match!['error']).toBe('evict-reject');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── consume() hash_mismatch ──

  it('consume() hash_mismatch — sync throw emits warn', async () => {
    const store = makeStore(() => {
      throw new Error('evict-sync-throw');
    });
    await store.store(
      makeEntry({
        receiptId: 'hm-1',
        sponsorAddress: 'slot-hm-1',
        txBytesHash: 'correct-hash',
        clientIp: '10.0.0.2',
        senderAddress: '0xHM1',
        nonce: 1n,
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await store.consume('hm-1', 'wrong-hash')).toBe('hash_mismatch');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectEvictCallbackFailed(warnSpy).find(
        (w) => w['reason'] === 'hash_mismatch',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe('slot-hm-1');
      expect(match!['receipt_id']).toBe('hm-1');
      expect(match!['error']).toBe('evict-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('consume() hash_mismatch — rejected promise emits warn', async () => {
    const store = makeStore(() => Promise.reject(new Error('evict-reject')));
    await store.store(
      makeEntry({
        receiptId: 'hm-2',
        sponsorAddress: 'slot-hm-2',
        txBytesHash: 'correct-hash',
        clientIp: '10.0.0.3',
        senderAddress: '0xHM2',
        nonce: 1n,
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await store.consume('hm-2', 'wrong-hash')).toBe('hash_mismatch');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectEvictCallbackFailed(warnSpy).find(
        (w) => w['reason'] === 'hash_mismatch',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe('slot-hm-2');
      expect(match!['error']).toBe('evict-reject');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
