/**
 * MemoryPrepareStore — PrepareStoreAdapter conformance + memory-only cases.
 *
 * The shared behavioral contract is exercised by
 * `prepareStore.conformance.ts`. Memory-only cases (background
 * eviction timing and stale-pending TTL compaction via an injected clock)
 * live below under the "MemoryPrepareStore — impl-only"
 * describe. Redis implements the same contract with different expiry
 * plumbing and is covered separately in `redisPrepareStore.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryPrepareStore } from '../src/store/memoryPrepareStore.js';
import type { GenericPreparedTxDraft, PreparedTxEntry } from '../src/store/prepareTypes.js';
import {
  runPrepareStoreConformanceTests,
  type PrepareStoreFactory,
  type PrepareStoreHandle,
  type ReleasedSlot,
} from './prepareStore.conformance.js';

// ─────────────────────────────────────────────
// Memory factory
// ─────────────────────────────────────────────

const memoryFactory: PrepareStoreFactory = ({
  ttlMs,
  maxPerIp,
  maxPerStudioUser,
  maxOutstandingPerSender,
}) => {
  const releasedSlots: ReleasedSlot[] = [];
  let nowMs = 1_700_000_000_000;
  const store = new MemoryPrepareStore(
    (sponsorAddress, receiptId, txBytesHash) => {
      releasedSlots.push({ sponsorAddress, receiptId, txBytesHash });
    },
    ttlMs,
    maxPerIp,
    maxPerStudioUser,
    // Long eviction interval — conformance tests never rely on the
    // background timer. The memory-only describe below exercises
    // the internal _evictExpired() directly as a white-box test.
    60_000,
    undefined,
    { nowMs: () => nowMs },
    maxOutstandingPerSender,
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
    dispose: () => store.dispose(),
  };
  return handle;
};

describe('MemoryPrepareStore — shared conformance', () => {
  runPrepareStoreConformanceTests(memoryFactory);
});

// ─────────────────────────────────────────────
// Memory-only cases (no Redis analog)
// ─────────────────────────────────────────────

describe('MemoryPrepareStore — impl-only', () => {
  // These cases exercise behaviors that exist only on the in-memory
  // implementation and have no direct Redis equivalent:
  //   - background eviction timer driven by setInterval
  //   - logical-expiry / stale-pending compaction driven by the store's
  //     injected clock rather than Redis TIME / PX TTL.
  // They are deliberately not part of the shared conformance suite.

  const IP_1 = '192.168.1.1';
  const SLOT_A = 'slot-a';

  it('rejects unsafe numeric constructor values', () => {
    expect(() => new MemoryPrepareStore(() => {}, 0)).toThrow('ttlMs must be > 0');
    expect(() => new MemoryPrepareStore(() => {}, 1.5)).toThrow('safe integer');
    expect(() => new MemoryPrepareStore(() => {}, 60_000, 1.5)).toThrow('safe integer');
    expect(() => new MemoryPrepareStore(() => {}, 60_000, 2, 1.5)).toThrow('safe integer');
    expect(() => new MemoryPrepareStore(() => {}, 60_000, 2, 3, 1.5)).toThrow('safe integer');
  });

  function makeDraft(overrides: Partial<GenericPreparedTxDraft> = {}): GenericPreparedTxDraft {
    return {
      receiptId: 'pid-default',
      senderAddress: '0xSENDER',
      nonce: 1n,
      txBytesHash: 'hash-abc',
      sponsorAddress: SLOT_A,
      clientIp: IP_1,
      executionPathKey: 'mock-execution-path',
      orderId: null,
      mode: 'generic',
      ...overrides,
    };
  }

  let store: MemoryPrepareStore | null = null;
  let nowMs = 1_000;
  const releasedSlots: Array<{
    sponsorAddress: string;
    receiptId: string;
    txBytesHash: string | null;
  }> = [];

  function create(ttlMs: number): MemoryPrepareStore {
    releasedSlots.length = 0;
    nowMs = 1_000;
    store = new MemoryPrepareStore(
      (sponsorAddress, receiptId, txBytesHash) => {
        releasedSlots.push({ sponsorAddress, receiptId, txBytesHash });
      },
      ttlMs,
      2,
      60_000,
      60_000,
      undefined,
      { nowMs: () => nowMs },
    );
    return store;
  }

  afterEach(() => {
    store?.dispose();
    store = null;
  });

  it('background eviction removes expired entries from map', async () => {
    const s = create(100);
    await s.store(makeDraft({ receiptId: 'pid-1', sponsorAddress: SLOT_A, txBytesHash: 'hash-1' }));
    nowMs += 200;

    // White-box: invoke the private sweep. This is the only way to
    // verify the scheduled timer's behavior without waiting 15s.
    (s as unknown as { _evictExpired: () => void })._evictExpired();
    await new Promise((r) => queueMicrotask(() => r(undefined)));

    expect(releasedSlots).toEqual([
      { sponsorAddress: SLOT_A, receiptId: 'pid-1', txBytesHash: 'hash-1' },
    ]);

    expect(await s.consume('pid-1', 'hash-1')).toBe('not_found');

    releasedSlots.length = 0;
    (s as unknown as { _evictExpired: () => void })._evictExpired();
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    expect(releasedSlots).toEqual([]);
  });

  it('reserveNonce ignores logically expired live entries before background sweep', async () => {
    const s = create(100);
    const sender = '0xMEM_GRACE';
    const first = await s.reserveNonce(sender, 0n, 'mg-A');
    expect(first).toBe(1n);
    await s.store(
      makeDraft({
        receiptId: 'mg-A',
        senderAddress: sender,
        nonce: 1n,
        txBytesHash: 'hash-mg',
      }),
    );
    nowMs += 200;
    // Entry is logically expired (issuedAt + 100 < now) but not yet swept.
    const next = await s.reserveNonce(sender, 0n, 'mg-B');
    expect(next).toBe(1n);
    await s.releaseReservation('mg-B', sender);
  });

  it('stale pending reservation does not raise next nonce after TTL', async () => {
    const s = create(100);
    const sender = '0xSTALE_PENDING';
    const n1 = await s.reserveNonce(sender, 0n, 'res-stale');
    expect(n1).toBe(1n);
    const n2 = await s.reserveNonce(sender, 0n, 'res-fresh');
    expect(n2).toBe(2n);
    await s.releaseReservation('res-fresh', sender);

    nowMs += 150;

    const n3 = await s.reserveNonce(sender, 0n, 'res-after');
    expect(n3).toBe(1n);
    await s.releaseReservation('res-after', sender);
  });

  it('store stamps its injected clock once and returns an isolated committed entry', async () => {
    const clockNow = vi.fn(() => 7_654_321);
    store = new MemoryPrepareStore(() => {}, 60_000, 2, 3, 60_000, undefined, {
      nowMs: clockNow,
    });
    const draft = makeDraft({ receiptId: 'clock-owned', txBytesHash: 'hash-original' });

    const committed = await store.store(draft);

    expect(clockNow).toHaveBeenCalledTimes(1);
    expect(committed.issuedAt).toBe(7_654_321);
    expect(committed.receiptId).toBe(draft.receiptId);
    expect(draft).not.toHaveProperty('issuedAt');

    committed.txBytesHash = 'mutated-return';
    const peeked = await store.peek(draft.receiptId);
    expect(peeked?.txBytesHash).toBe('hash-original');
    expect(peeked?.issuedAt).toBe(7_654_321);
  });
});

// ─────────────────────────────────────────────
// _onRelease rejection observability — memory-specific
// ─────────────────────────────────────────────

describe('MemoryPrepareStore — _onRelease rejection emits SPONSOR_POOL_LEASE_RELEASE_FAILED warn', () => {
  const IP_1 = '192.168.1.1';
  const IP_2 = '10.0.0.1';
  const SLOT_A = 'slot-a';
  const SLOT_B = 'slot-b';
  const SLOT_C = 'slot-c';
  const SENDER = '0xSENDER';

  function makeDraft(overrides: Partial<GenericPreparedTxDraft> = {}): GenericPreparedTxDraft {
    return {
      receiptId: 'pid-default',
      senderAddress: SENDER,
      nonce: 1n,
      txBytesHash: 'hash-abc',
      sponsorAddress: SLOT_A,
      clientIp: IP_1,
      executionPathKey: 'mock-execution-path',
      orderId: null,
      mode: 'generic',
      ...overrides,
    };
  }

  let store: MemoryPrepareStore | null = null;
  let nowMs = 2_000;

  function create(ttlMs: number, maxPerIp = 2): MemoryPrepareStore {
    nowMs = 2_000;
    store = new MemoryPrepareStore(
      () => Promise.reject(new Error('release-callback-failed')),
      ttlMs,
      maxPerIp,
      60_000,
      60_000,
      undefined,
      { nowMs: () => nowMs },
    );
    return store;
  }

  afterEach(() => {
    store?.dispose();
    store = null;
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

  it('consume() expired — release rejection emits warn', async () => {
    const s = create(100);
    await s.store(makeDraft({ receiptId: 'pid-1', sponsorAddress: SLOT_A }));
    nowMs += 200;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await s.consume('pid-1', 'hash-abc')).toBe('expired');
      await new Promise((r) => setTimeout(r, 0));
      const warns = collectReleaseFailed(warnSpy);
      expect(warns.length).toBeGreaterThanOrEqual(1);
      const match = warns.find((w) => w['reason'] === 'prepare_expired');
      expect(match).toBeDefined();
      expect(match!['adapter']).toBe('memory-prepare');
      expect(match!['sponsor_address']).toBe(SLOT_A);
      expect(match!['error']).toBe('release-callback-failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('consume() hash_mismatch — release rejection emits warn', async () => {
    const s = create(60_000);
    await s.store(
      makeDraft({ receiptId: 'pid-2', sponsorAddress: SLOT_B, txBytesHash: 'correct' }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await s.consume('pid-2', 'wrong')).toBe('hash_mismatch');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find((w) => w['reason'] === 'hash_mismatch');
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_B);
      expect(match!['error']).toBe('release-callback-failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('evictPreparedEntry() — release rejection emits warn', async () => {
    const s = create(60_000);
    await s.store(makeDraft({ receiptId: 'pid-3', sponsorAddress: SLOT_C }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await s.evictPreparedEntry('pid-3');
      const match = collectReleaseFailed(warnSpy).find((w) => w['reason'] === 'evict_corrupt');
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_C);
      expect(match!['error']).toBe('release-callback-failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('_evictExpired() background — release rejection emits warn', async () => {
    const s = create(100);
    await s.store(makeDraft({ receiptId: 'pid-4', sponsorAddress: SLOT_A }));
    nowMs += 200;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      (s as unknown as { _evictExpired: () => void })._evictExpired();
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find(
        (w) => w['reason'] === 'background_ttl_eviction',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_A);
      expect(match!['error']).toBe('release-callback-failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('store() IP eviction — release rejection emits warn', async () => {
    const s = create(60_000, 1);
    await s.store(
      makeDraft({
        receiptId: 'pid-a',
        sponsorAddress: SLOT_A,
        clientIp: IP_2,
        senderAddress: '0xA',
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await s.store(
        makeDraft({
          receiptId: 'pid-b',
          sponsorAddress: SLOT_B,
          clientIp: IP_2,
          senderAddress: '0xB',
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find(
        (w) => w['reason'] === 'ip_concurrent_eviction',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_A);
      expect(match!['client_ip']).toBe(IP_2);
      expect(match!['error']).toBe('release-callback-failed');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────
// _onRelease synchronous throw observability — memory-specific
// ─────────────────────────────────────────────
//
// Sync-throw hardening: the non-`await` call-sites wrap `_onRelease` in
// `Promise.resolve().then(() => this._onRelease(...))` so synchronous
// throws are routed to the same `.catch` arm as rejected promises and
// exposed on the `SPONSOR_POOL_LEASE_RELEASE_FAILED` event.

describe('MemoryPrepareStore — _onRelease synchronous throw emits SPONSOR_POOL_LEASE_RELEASE_FAILED warn', () => {
  const IP_1 = '192.168.1.1';
  const IP_2 = '10.0.0.1';
  const SLOT_A = 'slot-a';
  const SLOT_B = 'slot-b';

  function makeDraft(overrides: Partial<GenericPreparedTxDraft> = {}): GenericPreparedTxDraft {
    return {
      receiptId: 'pid-default',
      senderAddress: '0xSENDER',
      nonce: 1n,
      txBytesHash: 'hash-abc',
      sponsorAddress: SLOT_A,
      clientIp: IP_1,
      executionPathKey: 'mock-execution-path',
      orderId: null,
      mode: 'generic',
      ...overrides,
    };
  }

  let store: MemoryPrepareStore | null = null;
  let nowMs = 3_000;

  function createSyncThrowing(ttlMs: number, maxPerIp = 2): MemoryPrepareStore {
    nowMs = 3_000;
    store = new MemoryPrepareStore(
      () => {
        throw new Error('release-sync-throw');
      },
      ttlMs,
      maxPerIp,
      60_000,
      60_000,
      undefined,
      { nowMs: () => nowMs },
    );
    return store;
  }

  afterEach(() => {
    store?.dispose();
    store = null;
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

  it('consume() expired — sync throw emits warn', async () => {
    const s = createSyncThrowing(100);
    await s.store(makeDraft({ receiptId: 'pid-s1', sponsorAddress: SLOT_A }));
    nowMs += 200;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await s.consume('pid-s1', 'hash-abc')).toBe('expired');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find((w) => w['reason'] === 'prepare_expired');
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_A);
      expect(match!['error']).toBe('release-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('consume() hash_mismatch — sync throw emits warn', async () => {
    const s = createSyncThrowing(60_000);
    await s.store(
      makeDraft({ receiptId: 'pid-s2', sponsorAddress: SLOT_B, txBytesHash: 'correct' }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await s.consume('pid-s2', 'wrong')).toBe('hash_mismatch');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find((w) => w['reason'] === 'hash_mismatch');
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_B);
      expect(match!['error']).toBe('release-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('_evictExpired() background — sync throw emits warn', async () => {
    const s = createSyncThrowing(100);
    await s.store(makeDraft({ receiptId: 'pid-s4', sponsorAddress: SLOT_A }));
    nowMs += 200;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      (s as unknown as { _evictExpired: () => void })._evictExpired();
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find(
        (w) => w['reason'] === 'background_ttl_eviction',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_A);
      expect(match!['error']).toBe('release-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('store() IP eviction — sync throw emits warn', async () => {
    const s = createSyncThrowing(60_000, 1);
    await s.store(
      makeDraft({
        receiptId: 'pid-sa',
        sponsorAddress: SLOT_A,
        clientIp: IP_2,
        senderAddress: '0xA',
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await s.store(
        makeDraft({
          receiptId: 'pid-sb',
          sponsorAddress: SLOT_B,
          clientIp: IP_2,
          senderAddress: '0xB',
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
      const match = collectReleaseFailed(warnSpy).find(
        (w) => w['reason'] === 'ip_concurrent_eviction',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_A);
      expect(match!['client_ip']).toBe(IP_2);
      expect(match!['error']).toBe('release-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────
// _onEntryEvict observability — memory-specific
// ─────────────────────────────────────────────
//
// The store-layer safety-net covers BOTH sync throws and rejected promises
// from the injected `_onEntryEvict` callback. Owner callback event names
// (PREPARE_STORE_EVICT_CLEANUP_FAILED / _THREW) lives in app-api and is
// a read-only reference here — these tests only exercise the store layer.

describe('MemoryPrepareStore — _onEntryEvict failures emit PREPARE_STORE_EVICT_CALLBACK_FAILED warn', () => {
  const IP_1 = '192.168.1.1';
  const IP_2 = '10.0.0.1';
  const SLOT_A = 'slot-a';
  const SLOT_B = 'slot-b';

  function makeDraft(overrides: Partial<GenericPreparedTxDraft> = {}): GenericPreparedTxDraft {
    return {
      receiptId: 'pid-default',
      senderAddress: '0xSENDER',
      nonce: 1n,
      txBytesHash: 'hash-abc',
      sponsorAddress: SLOT_A,
      clientIp: IP_1,
      executionPathKey: 'mock-execution-path',
      orderId: null,
      mode: 'generic',
      ...overrides,
    };
  }

  let store: MemoryPrepareStore | null = null;
  let nowMs = 4_000;

  function createWithEvictCallback(
    ttlMs: number,
    onEntryEvict: (entry: PreparedTxEntry) => void | Promise<void>,
    maxPerIp = 2,
  ): MemoryPrepareStore {
    nowMs = 4_000;
    store = new MemoryPrepareStore(
      () => {
        /* onRelease: succeed silently, this describe focuses on _onEntryEvict */
      },
      ttlMs,
      maxPerIp,
      60_000,
      60_000,
      onEntryEvict,
      { nowMs: () => nowMs },
    );
    return store;
  }

  afterEach(() => {
    store?.dispose();
    store = null;
  });

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
    const s = createWithEvictCallback(
      60_000,
      () => {
        throw new Error('evict-sync-throw');
      },
      1,
    );
    await s.store(
      makeDraft({
        receiptId: 'pid-a',
        sponsorAddress: SLOT_A,
        clientIp: IP_2,
        senderAddress: '0xA',
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await s.store(
        makeDraft({
          receiptId: 'pid-b',
          sponsorAddress: SLOT_B,
          clientIp: IP_2,
          senderAddress: '0xB',
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
      const match = collectEvictCallbackFailed(warnSpy).find(
        (w) => w['reason'] === 'ip_concurrent_eviction',
      );
      expect(match).toBeDefined();
      expect(match!['adapter']).toBe('memory-prepare');
      expect(match!['sponsor_address']).toBe(SLOT_A);
      expect(match!['receipt_id']).toBe('pid-a');
      expect(match!['error']).toBe('evict-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('store() IP eviction — rejected promise emits warn', async () => {
    const s = createWithEvictCallback(60_000, () => Promise.reject(new Error('evict-reject')), 1);
    await s.store(
      makeDraft({
        receiptId: 'pid-a',
        sponsorAddress: SLOT_A,
        clientIp: IP_2,
        senderAddress: '0xA',
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await s.store(
        makeDraft({
          receiptId: 'pid-b',
          sponsorAddress: SLOT_B,
          clientIp: IP_2,
          senderAddress: '0xB',
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
      const match = collectEvictCallbackFailed(warnSpy).find(
        (w) => w['reason'] === 'ip_concurrent_eviction',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_A);
      expect(match!['receipt_id']).toBe('pid-a');
      expect(match!['error']).toBe('evict-reject');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── consume() expired ──

  it('consume() expired — sync throw emits warn', async () => {
    const s = createWithEvictCallback(100, () => {
      throw new Error('evict-sync-throw');
    });
    await s.store(makeDraft({ receiptId: 'pid-exp', sponsorAddress: SLOT_A }));
    nowMs += 200;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await s.consume('pid-exp', 'hash-abc')).toBe('expired');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectEvictCallbackFailed(warnSpy).find(
        (w) => w['reason'] === 'prepare_expired',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_A);
      expect(match!['receipt_id']).toBe('pid-exp');
      expect(match!['error']).toBe('evict-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('consume() expired — rejected promise emits warn', async () => {
    const s = createWithEvictCallback(100, () => Promise.reject(new Error('evict-reject')));
    await s.store(makeDraft({ receiptId: 'pid-exp', sponsorAddress: SLOT_A }));
    nowMs += 200;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await s.consume('pid-exp', 'hash-abc')).toBe('expired');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectEvictCallbackFailed(warnSpy).find(
        (w) => w['reason'] === 'prepare_expired',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_A);
      expect(match!['error']).toBe('evict-reject');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── consume() hash_mismatch ──

  it('consume() hash_mismatch — sync throw emits warn', async () => {
    const s = createWithEvictCallback(60_000, () => {
      throw new Error('evict-sync-throw');
    });
    await s.store(
      makeDraft({ receiptId: 'pid-hm', sponsorAddress: SLOT_B, txBytesHash: 'correct' }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await s.consume('pid-hm', 'wrong')).toBe('hash_mismatch');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectEvictCallbackFailed(warnSpy).find(
        (w) => w['reason'] === 'hash_mismatch',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_B);
      expect(match!['receipt_id']).toBe('pid-hm');
      expect(match!['error']).toBe('evict-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('consume() hash_mismatch — rejected promise emits warn', async () => {
    const s = createWithEvictCallback(60_000, () => Promise.reject(new Error('evict-reject')));
    await s.store(
      makeDraft({ receiptId: 'pid-hm', sponsorAddress: SLOT_B, txBytesHash: 'correct' }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await s.consume('pid-hm', 'wrong')).toBe('hash_mismatch');
      await new Promise((r) => setTimeout(r, 0));
      const match = collectEvictCallbackFailed(warnSpy).find(
        (w) => w['reason'] === 'hash_mismatch',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_B);
      expect(match!['error']).toBe('evict-reject');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── _evictExpired() background (white-box) ──

  it('_evictExpired() background — sync throw emits warn', async () => {
    const s = createWithEvictCallback(100, () => {
      throw new Error('evict-sync-throw');
    });
    await s.store(makeDraft({ receiptId: 'pid-bg', sponsorAddress: SLOT_A }));
    nowMs += 200;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      (s as unknown as { _evictExpired: () => void })._evictExpired();
      await new Promise((r) => setTimeout(r, 0));
      const match = collectEvictCallbackFailed(warnSpy).find(
        (w) => w['reason'] === 'background_ttl_eviction',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_A);
      expect(match!['receipt_id']).toBe('pid-bg');
      expect(match!['error']).toBe('evict-sync-throw');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('_evictExpired() background — rejected promise emits warn', async () => {
    const s = createWithEvictCallback(100, () => Promise.reject(new Error('evict-reject')));
    await s.store(makeDraft({ receiptId: 'pid-bg', sponsorAddress: SLOT_A }));
    nowMs += 200;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      (s as unknown as { _evictExpired: () => void })._evictExpired();
      await new Promise((r) => setTimeout(r, 0));
      const match = collectEvictCallbackFailed(warnSpy).find(
        (w) => w['reason'] === 'background_ttl_eviction',
      );
      expect(match).toBeDefined();
      expect(match!['sponsor_address']).toBe(SLOT_A);
      expect(match!['error']).toBe('evict-reject');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
