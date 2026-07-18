/**
 * concreteReservations.test.ts — runtime adapter bindings of the abstract
 * `SponsoredExecution` reservations.
 *
 * Verifies acquire/release/commit/transferOwnership cycles for each
 * concrete subclass and pins the prepare-runner cleanup behavior:
 *
 *   - `InflightReservationImpl` emits `PREPARE_INFLIGHT_RELEASE_FAILED`
 *     on release error.
 *   - `SponsorSlotReservationImpl` delegates release to
 *     `safeSlotCheckin`, which emits `SPONSOR_POOL_CHECKIN_FAILED`
 *     internally.
 *   - `NonceReservationImpl` swallows release errors silently.
 *   - `LedgerBudgetReservationImpl` emits
 *     `LEDGER_RELEASE_FAILED_IN_HANDLER` on `result.ok === false` and
 *     `LEDGER_RELEASE_THREW_IN_HANDLER` on throw.
 *
 * The prepare runner routes cleanup through these reservation
 * adapters.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  InflightReservationImpl,
  LedgerBudgetReservationImpl,
  NonceReservationImpl,
  SponsorSlotReservationImpl,
} from '../src/session/sponsoredExecution/reservations.js';
import { PrepareOverloadError } from '../src/store/prepareErrors.js';
import type { SponsorPoolAdapter } from '../src/context.js';
import type { SponsoredExecutionStoreAdapter } from '../src/store/sponsoredExecutionStore.js';
import type { InflightHandle, PrepareInflightLimiter } from '../src/store/prepareInflightTypes.js';
import type { PromotionExecutionLedger } from '../src/studio/executionLedger.js';

// ─────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleInfoSpy.mockRestore();
});

function findStructuredEvent(
  spies: {
    error: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    info: ReturnType<typeof vi.spyOn>;
  },
  eventName: string,
): Record<string, unknown> | undefined {
  const all: unknown[] = [];
  for (const s of [spies.error, spies.warn, spies.info]) {
    for (const call of s.mock.calls) all.push(call[0]);
  }
  for (const raw of all) {
    if (typeof raw !== 'string') continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed['event'] === eventName) return parsed;
    } catch {
      // not a structured-event JSON line
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────
// Section 1 — InflightReservationImpl
// ─────────────────────────────────────────────

describe('InflightReservationImpl', () => {
  function makeLimiter(handle: InflightHandle | null): PrepareInflightLimiter {
    return {
      tryAcquire: vi.fn().mockResolvedValue(handle),
      get inflight(): number {
        return 0;
      },
      get capacity(): number {
        return 8;
      },
    };
  }

  test('acquire(route) acquires a limiter handle', async () => {
    const releaseFn = vi.fn().mockResolvedValue(undefined);
    const limiter = makeLimiter({ release: releaseFn });
    const r = new InflightReservationImpl(limiter);

    await r.acquire('generic');
    expect(limiter.tryAcquire).toHaveBeenCalledWith('generic');
  });

  test('acquire throws PrepareOverloadError when the limiter returns null (capacity exhausted)', async () => {
    const limiter = makeLimiter(null);
    const r = new InflightReservationImpl(limiter);
    await expect(r.acquire('generic')).rejects.toBeInstanceOf(PrepareOverloadError);
  });

  test('release() invokes the handle release exactly once and is idempotent', async () => {
    const releaseFn = vi.fn().mockResolvedValue(undefined);
    const limiter = makeLimiter({ release: releaseFn });
    const r = new InflightReservationImpl(limiter);
    await r.acquire('generic');

    await r.release();
    await r.release();
    await r.release();

    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  test('release() emits PREPARE_INFLIGHT_RELEASE_FAILED with route + error message on throw', async () => {
    const releaseFn = vi.fn().mockRejectedValue(new Error('redis unreachable'));
    const limiter = makeLimiter({ release: releaseFn });
    const r = new InflightReservationImpl(limiter);
    await r.acquire('promotion');

    await expect(r.release()).resolves.toBeUndefined();

    const event = findStructuredEvent(
      { error: consoleErrorSpy, warn: consoleWarnSpy, info: consoleInfoSpy },
      'PREPARE_INFLIGHT_RELEASE_FAILED',
    );
    expect(event).toBeDefined();
    expect(event!['route']).toBe('promotion');
    expect(event!['error']).toBe('redis unreachable');
  });

  test('InflightReservationImpl is NOT transferable — `transferOwnership` is absent at the type and runtime level', async () => {
    // The current cleanup order makes `inflight release` the last step on
    // every path. Inflight
    // admission caps in-process concurrency; releasing must happen on
    // success and failure alike. `finalize()` transfers slot/nonce/ledger
    // ownership but `release()` drops the inflight handle unconditionally.
    const releaseFn = vi.fn().mockResolvedValue(undefined);
    const limiter = makeLimiter({ release: releaseFn });
    const r = new InflightReservationImpl(limiter);
    await r.acquire('generic');

    // Compile-time gate: `InflightReservation` extends `ReservationBase`
    // directly, NOT `TransferableReservationBase`. Calling
    // `transferOwnership` is a TS2339 error. The runtime check below
    // confirms the method does not exist on the prototype either.
    expect(typeof (r as unknown as { transferOwnership?: unknown }).transferOwnership).toBe(
      'undefined',
    );

    // Inflight ALWAYS releases on `release()` — there is no skip path.
    await r.release();
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// Section 2 — SponsorSlotReservationImpl
// ─────────────────────────────────────────────

describe('SponsorSlotReservationImpl', () => {
  function makePool(slot: { sponsorAddress: string } | null): SponsorPoolAdapter {
    return {
      size: 1,
      primaryAddress: '0xPRIMARY',
      checkout: vi.fn().mockResolvedValue(slot),
      checkin: vi.fn().mockResolvedValue(undefined),
      leaseStatus: vi.fn().mockResolvedValue({
        leasedSlots: 0,
        freeSlots: 1,
        slots: [{ address: '0xPRIMARY', leased: false }],
      }),
      addresses: vi.fn().mockReturnValue([]),
      sign: vi.fn(),
    };
  }

  test('acquire issues SponsorSlotReservationHandle with the pool-returned sponsorAddress', async () => {
    const pool = makePool({ sponsorAddress: '0xSPONSOR_X' });
    const r = new SponsorSlotReservationImpl(pool);

    const ev = await r.acquire('0xRECEIPT');

    expect(ev).not.toBeNull();
    expect(ev!.sponsorAddress).toBe('0xSPONSOR_X');
    expect(ev!.receiptId).toBe('0xRECEIPT');
    expect(ev!.reservationKind).toBe('SponsorSlot');
    expect(ev!.isLive()).toBe(true);
  });

  test('acquire returns null when the pool is exhausted and stays in pending state', async () => {
    const pool = makePool(null);
    const r = new SponsorSlotReservationImpl(pool);
    const ev = await r.acquire('0xRECEIPT');
    expect(ev).toBeNull();
  });

  test('release() before durable commit checks in the exact reserved lease', async () => {
    const pool = makePool({ sponsorAddress: '0xSP' });
    const r = new SponsorSlotReservationImpl(pool);
    await r.acquire('0xRECEIPT');

    await r.release();

    expect(pool.checkin).toHaveBeenCalledWith('0xSP', '0xRECEIPT');
  });

  test('release() never throws even when pool.checkin throws (safeSlotCheckin internal swallow)', async () => {
    const pool = makePool({ sponsorAddress: '0xSP' });
    (pool.checkin as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('redis down'));
    const r = new SponsorSlotReservationImpl(pool);
    await r.acquire('0xRECEIPT');

    await expect(r.release()).resolves.toBeUndefined();
    // safeSlotCheckin emits SPONSOR_POOL_CHECKIN_FAILED via its own
    // structured-log path; this reservation must not rethrow it.
  });

  test('transferOwnership() then release() does not call pool.checkin', async () => {
    const pool = makePool({ sponsorAddress: '0xSP' });
    const r = new SponsorSlotReservationImpl(pool);
    await r.acquire('0xRECEIPT');

    r.transferOwnership();
    await r.release();

    expect(pool.checkin).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Section 3 — NonceReservationImpl
// ─────────────────────────────────────────────

describe('NonceReservationImpl', () => {
  function makeStore(reservedNonce: bigint = 1n): SponsoredExecutionStoreAdapter {
    return {
      commitPreparedReceipt: vi.fn(),
      readPreparedReceipt: vi.fn(),
      discardPreparedReceipt: vi.fn(),
      beginSponsoredExecution: vi.fn(),
      finalizeSponsoredExecution: vi.fn(),
      readExpiredPreparedReceipts: vi.fn(),
      readDueExecutions: vi.fn(),
      readPendingCallbacks: vi.fn(),
      markCallbackDelivered: vi.fn(),
      checkUserQuota: vi.fn(),
      reserveNonce: vi.fn().mockResolvedValue(reservedNonce),
      releaseNonceReservation: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };
  }

  test('acquire issues NonceReservationHandle with the store-returned nonce + sender + receiptId', async () => {
    const store = makeStore(7n);
    const r = new NonceReservationImpl(store);

    const ev = await r.acquire('0xSENDER', 0n, '0xRECEIPT');

    expect(ev.nonce).toBe(7n);
    expect(ev.senderAddress).toBe('0xSENDER');
    expect(ev.receiptId).toBe('0xRECEIPT');
    expect(ev.reservationKind).toBe('Nonce');
    expect(ev.isLive()).toBe(true);
    expect(store.reserveNonce).toHaveBeenCalledWith('0xSENDER', 0n, '0xRECEIPT');
  });

  test('release() forwards to store.releaseNonceReservation(receiptId, sender)', async () => {
    const store = makeStore();
    const r = new NonceReservationImpl(store);
    await r.acquire('0xSENDER', 0n, '0xRECEIPT');

    await r.release();

    expect(store.releaseNonceReservation).toHaveBeenCalledWith('0xRECEIPT', '0xSENDER');
  });

  test('release() silently swallows store.releaseNonceReservation throws', async () => {
    const store = makeStore();
    (store.releaseNonceReservation as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('redis unreachable'),
    );
    const r = new NonceReservationImpl(store);
    await r.acquire('0xSENDER', 0n, '0xRECEIPT');

    await expect(r.release()).resolves.toBeUndefined();
    // No structured log expected — silent swallow by contract.
    const noEvent = findStructuredEvent(
      { error: consoleErrorSpy, warn: consoleWarnSpy, info: consoleInfoSpy },
      'NONCE_RELEASE_FAILED',
    );
    expect(noEvent).toBeUndefined();
  });

  test('transferOwnership() then release() does not release the nonce reservation', async () => {
    const store = makeStore();
    const r = new NonceReservationImpl(store);
    await r.acquire('0xSENDER', 0n, '0xRECEIPT');

    r.transferOwnership();
    await r.release();

    expect(store.releaseNonceReservation).not.toHaveBeenCalled();
  });

  test('release() is idempotent — second call is a no-op', async () => {
    const store = makeStore();
    const r = new NonceReservationImpl(store);
    await r.acquire('0xSENDER', 0n, '0xRECEIPT');

    await r.release();
    await r.release();

    expect(store.releaseNonceReservation).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// Section 4 — LedgerBudgetReservationImpl
// ─────────────────────────────────────────────

describe('LedgerBudgetReservationImpl', () => {
  function makeLedger(opts?: {
    reserveOk?: boolean;
    reserveReason?: string;
    releaseOk?: boolean;
    releaseReason?: string;
    releaseThrows?: Error;
    consumeOk?: boolean;
  }): PromotionExecutionLedger {
    return {
      claim: vi.fn(),
      reserve: vi
        .fn()
        .mockResolvedValue(
          opts?.reserveOk === false
            ? { ok: false, reason: opts.reserveReason ?? 'OVER_LIMIT' }
            : { ok: true },
        ),
      consume: vi
        .fn()
        .mockResolvedValue(
          opts?.consumeOk === false ? { ok: false, reason: 'consumed' } : { ok: true },
        ),
      release: vi.fn().mockImplementation(async () => {
        if (opts?.releaseThrows) throw opts.releaseThrows;
        return opts?.releaseOk === false
          ? { ok: false, reason: opts.releaseReason ?? 'reservation_not_found' }
          : { ok: true };
      }),
      getEntitlement: vi.fn(),
      getPromotionLedgerStatus: vi.fn(),
    } as unknown as PromotionExecutionLedger;
  }

  const ACQUIRE_PARAMS = {
    receiptId: '0xR',
    promotionId: 'promo-1',
    userId: 'user-1',
    amountMist: 1_400_000n,
  };

  test('acquire issues LedgerReservationHandle on ok result', async () => {
    const ledger = makeLedger();
    const r = new LedgerBudgetReservationImpl(ledger);

    const ev = await r.acquire(ACQUIRE_PARAMS);

    expect(ev).not.toBeNull();
    expect(ev!.receiptId).toBe('0xR');
    expect(ev!.promotionId).toBe('promo-1');
    expect(ev!.userId).toBe('user-1');
    expect(ev!.reservedGasMist).toBe(1_400_000n);
    expect(ev!.reservationKind).toBe('LedgerReservation');
    expect(ev!.isLive()).toBe(true);
    expect(ledger.reserve).toHaveBeenCalledWith({
      promotionId: 'promo-1',
      userId: 'user-1',
      receiptId: '0xR',
      amountMist: 1_400_000n,
    });
  });

  test('acquire returns null on reserve failure and stays in pending state', async () => {
    const ledger = makeLedger({ reserveOk: false, reserveReason: 'OVER_LIMIT' });
    const r = new LedgerBudgetReservationImpl(ledger);
    const ev = await r.acquire(ACQUIRE_PARAMS);
    expect(ev).toBeNull();
  });

  test('release() forwards to ledger.release(receiptId)', async () => {
    const ledger = makeLedger();
    const r = new LedgerBudgetReservationImpl(ledger);
    await r.acquire(ACQUIRE_PARAMS);

    await r.release();

    expect(ledger.release).toHaveBeenCalledWith('0xR');
  });

  test('release() emits LEDGER_RELEASE_FAILED_IN_HANDLER on result.ok=false', async () => {
    const ledger = makeLedger({ releaseOk: false, releaseReason: 'reservation_not_found' });
    const r = new LedgerBudgetReservationImpl(ledger);
    await r.acquire(ACQUIRE_PARAMS);

    await r.release();

    const event = findStructuredEvent(
      { error: consoleErrorSpy, warn: consoleWarnSpy, info: consoleInfoSpy },
      'LEDGER_RELEASE_FAILED_IN_HANDLER',
    );
    expect(event).toBeDefined();
    expect(event!['receiptId']).toBe('0xR');
    expect(event!['triggerReason']).toBe('prepared_receipt_not_committed');
    expect(event!['releaseFailureReason']).toBe('reservation_not_found');
  });

  test('release() emits LEDGER_RELEASE_THREW_IN_HANDLER on throw', async () => {
    const ledger = makeLedger({ releaseThrows: new Error('redis unreachable') });
    const r = new LedgerBudgetReservationImpl(ledger);
    await r.acquire(ACQUIRE_PARAMS);

    await expect(r.release()).resolves.toBeUndefined();

    const event = findStructuredEvent(
      { error: consoleErrorSpy, warn: consoleWarnSpy, info: consoleInfoSpy },
      'LEDGER_RELEASE_THREW_IN_HANDLER',
    );
    expect(event).toBeDefined();
    expect(event!['receiptId']).toBe('0xR');
    expect(event!['triggerReason']).toBe('prepared_receipt_not_committed');
  });

  test('transferOwnership() then release() does not call ledger.release', async () => {
    const ledger = makeLedger();
    const r = new LedgerBudgetReservationImpl(ledger);
    await r.acquire(ACQUIRE_PARAMS);

    r.transferOwnership();
    await r.release();

    expect(ledger.release).not.toHaveBeenCalled();
  });
});
