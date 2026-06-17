import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { createSponsorOperationsRefillWorker } from '../../src/sponsor-operations/refillWorker.js';
import type {
  SponsorRefillAccountWriteFields,
  RedisSponsorOperationsState,
  SlotRead,
  SlotWriteFields,
} from '../../src/sponsor-operations/redisState.js';
import type {
  RefillLock,
  RefillLockHandle,
  SponsorRefillAccountDispatchLock,
  SponsorRefillAccountDispatchLockHandle,
} from '../../src/sponsor-operations/refillLock.js';
import { SPONSOR_BALANCE_WARN_MIST } from '../../src/sponsor-operations/defaults.js';

function makeStubState(initialSlots: Record<string, SlotRead | null> = {}): {
  state: RedisSponsorOperationsState;
  slotWrites: Array<{ address: string; fields: SlotWriteFields }>;
  sponsorRefillAccountWrites: SponsorRefillAccountWriteFields[];
} {
  const slotWrites: Array<{ address: string; fields: SlotWriteFields }> = [];
  const sponsorRefillAccountWrites: SponsorRefillAccountWriteFields[] = [];
  const slots = new Map<string, SlotRead | null>(Object.entries(initialSlots));
  return {
    slotWrites,
    sponsorRefillAccountWrites,
    state: {
      async updateSlot(address, fields) {
        slotWrites.push({ address, fields });
        const previous = slots.get(address) ?? null;
        slots.set(address, {
          address,
          state: fields.state ?? previous?.state ?? null,
          balanceMist: fields.balanceMist === undefined ? (previous?.balanceMist ?? null) : fields.balanceMist || null,
          lastError: fields.lastError === undefined ? (previous?.lastError ?? null) : fields.lastError || null,
          lastObservedAtMs: previous?.lastObservedAtMs ?? null,
          writeSeq: previous?.writeSeq ?? null,
          pendingRefillDigest:
            fields.pendingRefillDigest === undefined
              ? (previous?.pendingRefillDigest ?? null)
              : fields.pendingRefillDigest || null,
          refillAttemptedAmountMist:
            fields.refillAttemptedAmountMist === undefined
              ? (previous?.refillAttemptedAmountMist ?? null)
              : fields.refillAttemptedAmountMist || null,
          refillObservedBalanceMist:
            fields.refillObservedBalanceMist === undefined
              ? (previous?.refillObservedBalanceMist ?? null)
              : fields.refillObservedBalanceMist || null,
          refillReconciliationResult:
            fields.refillReconciliationResult === undefined
              ? (previous?.refillReconciliationResult ?? null)
              : fields.refillReconciliationResult || null,
        });
      },
      async updateSponsorRefillAccount(fields) {
        sponsorRefillAccountWrites.push(fields);
      },
      async readSlot(address) {
        return slots.get(address) ?? null;
      },
      async readSponsorRefillAccount() {
        return null;
      },
      async readAll() {
        return { slots: [], sponsorRefillAccount: {} as never };
      },
    },
  };
}

function makeStubLock(opts: { acquireReturns?: Array<RefillLockHandle | null> } = {}): {
  lock: RefillLock;
  acquireCalls: string[];
  releaseCalls: RefillLockHandle[];
} {
  const acquireCalls: string[] = [];
  const releaseCalls: RefillLockHandle[] = [];
  const queue = [...(opts.acquireReturns ?? [])];
  return {
    acquireCalls,
    releaseCalls,
    lock: {
      async acquire(slotAddress) {
        acquireCalls.push(slotAddress);
        if (queue.length > 0) return queue.shift()!;
        return { slotAddress, token: `token:${slotAddress}` };
      },
      async release(handle) {
        releaseCalls.push(handle);
      },
    },
  };
}

function makeStubSponsorRefillAccountDispatchLock(opts: {
  acquireReturns?: Array<SponsorRefillAccountDispatchLockHandle | null>;
} = {}): {
  lock: SponsorRefillAccountDispatchLock;
  acquireCalls: string[];
  releaseCalls: SponsorRefillAccountDispatchLockHandle[];
} {
  const acquireCalls: string[] = [];
  const releaseCalls: SponsorRefillAccountDispatchLockHandle[] = [];
  const queue = [...(opts.acquireReturns ?? [])];
  let current: SponsorRefillAccountDispatchLockHandle | null = null;
  let seq = 0;
  return {
    acquireCalls,
    releaseCalls,
    lock: {
      async acquire(sponsorRefillAccountAddress) {
        acquireCalls.push(sponsorRefillAccountAddress);
        if (queue.length > 0) return queue.shift()!;
        if (current !== null) return null;
        current = {
          sponsorRefillAccountAddress,
          token: `dispatch-token:${sponsorRefillAccountAddress}:${++seq}`,
        };
        return current;
      },
      async release(handle) {
        releaseCalls.push(handle);
        if (current?.token === handle.token) current = null;
      },
    },
  };
}

function makeStubSui(impl: (owner: string) => Promise<string | Error>): SuiGrpcClient {
  const stub = {
    async getBalance({ owner }: { owner: string }): Promise<{ balance: { balance: string } }> {
      const result = await impl(owner);
      if (result instanceof Error) throw result;
      return { balance: { balance: result } };
    },
  };
  return stub as unknown as SuiGrpcClient;
}

function refillSuccess(digest = '0xrefill'): { success: true; digest: string; error: null } {
  return { success: true, digest, error: null };
}

function refillFailure(error = 'refill tx failed'): {
  success: false;
  digest: null;
  error: string;
} {
  return { success: false, digest: null, error };
}

function makeSlotRead(
  state: SlotRead['state'],
  fields: Partial<Omit<SlotRead, 'address' | 'state'>> = {},
): SlotRead {
  return {
    address: SLOT,
    state,
    balanceMist: fields.balanceMist ?? null,
    lastError: fields.lastError ?? null,
    lastObservedAtMs: fields.lastObservedAtMs ?? null,
    writeSeq: fields.writeSeq ?? null,
    pendingRefillDigest: fields.pendingRefillDigest ?? null,
    refillAttemptedAmountMist: fields.refillAttemptedAmountMist ?? null,
    refillObservedBalanceMist: fields.refillObservedBalanceMist ?? null,
    refillReconciliationResult: fields.refillReconciliationResult ?? null,
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await flushMicrotasks();
  }
}

const SLOT = '0xslot';
const SLOT_B = '0xslotb';
const SPONSOR_REFILL_ACCOUNT_ADDRESS = '0x' + '55'.repeat(32);
const LONG_MULTIBYTE_ERROR = '한'.repeat(300);
const TRIMMED_MULTIBYTE_ERROR = '한'.repeat(170);

describe('createSponsorOperationsRefillWorker — lifecycle', () => {
  let stub: ReturnType<typeof makeStubState>;
  let dispatchLock: ReturnType<typeof makeStubSponsorRefillAccountDispatchLock>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stub = makeStubState();
    dispatchLock = makeStubSponsorRefillAccountDispatchLock();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function findWriteFailedLogs(source?: string): Record<string, unknown>[] {
    return warnSpy.mock.calls
      .map((args: unknown[]) => {
        try {
          return JSON.parse(args[0] as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null &&
          entry['event'] === 'SPONSOR_OPERATIONS_STATE_WRITE_FAILED' &&
          (source === undefined || entry['source'] === source),
      );
  }

  it('rejects non-positive timeouts at construction', () => {
    const lock = makeStubLock().lock;
    const baseDeps = {
      state: stub.state,
      refillLock: lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '0'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      refillTimeoutMs: 100,
      confirmationTimeoutMs: 100,
      sponsorRefillAccountBalanceTimeoutMs: 100,
      executeRefill: async () => refillSuccess(),
      getSlotBalance: async () => 0n,
    };
    expect(() => createSponsorOperationsRefillWorker({ ...baseDeps, refillTimeoutMs: 0 })).toThrow(
      /refillTimeoutMs must be a positive safe integer/,
    );
    expect(() =>
      createSponsorOperationsRefillWorker({ ...baseDeps, confirmationTimeoutMs: -1 }),
    ).toThrow(/confirmationTimeoutMs must be a positive safe integer/);
    expect(() =>
      createSponsorOperationsRefillWorker({
        ...baseDeps,
        sponsorRefillAccountBalanceTimeoutMs: Number.NaN,
      }),
    ).toThrow(/sponsorRefillAccountBalanceTimeoutMs must be a positive safe integer/);
  });

  it('happy path: writes refilling → sponsor-refill-account probe → awaiting_confirmation → healthy', async () => {
    const lock = makeStubLock();
    const executeRefill = vi.fn(async () => refillSuccess());
    const getSlotBalance = vi.fn(async () => 0n);
    getSlotBalance.mockResolvedValueOnce(4_000_000_000n);
    getSlotBalance.mockResolvedValueOnce(10_000_000_000n);
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => stub.slotWrites.length >= 3);

    expect(executeRefill).toHaveBeenCalledWith(SLOT, 6_000_000_000n);
    const states = stub.slotWrites.map((w) => w.fields.state);
    expect(states).toEqual(['refilling', 'awaiting_confirmation', 'healthy']);
    expect(stub.slotWrites[0].fields.refillAttemptedAmountMist).toBe('6000000000');
    expect(stub.slotWrites[1].fields.pendingRefillDigest).toBe('0xrefill');
    expect(stub.slotWrites[2].fields.refillReconciliationResult).toBe('confirmed');
    // Sponsor refill account is refreshed inside the locked window after refill success.
    expect(stub.sponsorRefillAccountWrites).toHaveLength(1);
    expect(stub.sponsorRefillAccountWrites[0].healthy).toBe('1');
    expect(stub.sponsorRefillAccountWrites[0].refillsRemaining).toBe('2');
    // Lock was acquired and released once.
    expect(lock.acquireCalls).toEqual([SLOT]);
    expect(lock.releaseCalls).toHaveLength(1);
    expect(dispatchLock.acquireCalls).toEqual([SPONSOR_REFILL_ACCOUNT_ADDRESS]);
    expect(dispatchLock.releaseCalls).toHaveLength(1);
    worker.dispose();
  });

  it('does not dispatch when the observed slot balance already meets the refill target', async () => {
    const lock = makeStubLock();
    const executeRefill = vi.fn(async () => refillSuccess());
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => 12_000_000_000n,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => stub.slotWrites.length >= 1);

    expect(executeRefill).not.toHaveBeenCalled();
    expect(dispatchLock.acquireCalls).toHaveLength(0);
    expect(stub.slotWrites[0].fields).toMatchObject({
      state: 'healthy',
      balanceMist: '12000000000',
      refillAttemptedAmountMist: '0',
      refillObservedBalanceMist: '12000000000',
      refillReconciliationResult: 'not_needed',
    });
    worker.dispose();
  });

  it('refill failure writes refill_failed + error and releases the lock', async () => {
    const lock = makeStubLock();
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '0'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill: async () => refillFailure('refill tx failed'),
      getSlotBalance: async () => 4_000_000_000n,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => stub.slotWrites.length >= 2);

    const states = stub.slotWrites.map((w) => w.fields.state);
    expect(states).toEqual(['refilling', 'refill_failed']);
    expect(stub.slotWrites[1].fields.lastError).toBe('refill tx failed');
    // Sponsor refill account probe does not run when the refill TX itself rejects.
    expect(stub.sponsorRefillAccountWrites).toHaveLength(0);
    expect(lock.releaseCalls).toHaveLength(1);
    worker.dispose();
  });

  it('trims multibyte refill-failure lastError payloads to 512 UTF-8 bytes', async () => {
    const lock = makeStubLock();
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '0'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill: async () => {
        throw new Error(LONG_MULTIBYTE_ERROR);
      },
      getSlotBalance: async () => 4_000_000_000n,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => stub.slotWrites.length >= 2);

    expect(stub.slotWrites[1].fields.lastError).toBe(TRIMMED_MULTIBYTE_ERROR);
    expect(
      new TextEncoder().encode(stub.slotWrites[1].fields.lastError ?? '').length,
    ).toBeLessThanOrEqual(512);
    worker.dispose();
  });

  it('emits and aborts when a slot-state write cannot be committed', async () => {
    const lock = makeStubLock();
    const executeRefill = vi.fn(async () => refillSuccess());
    const state: RedisSponsorOperationsState = {
      ...stub.state,
      async updateSlot() {
        throw new Error('redis slot write failed');
      },
    };
    const worker = createSponsorOperationsRefillWorker({
      state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => 4_000_000_000n,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => lock.releaseCalls.length === 1);

    expect(executeRefill).not.toHaveBeenCalled();
    expect(stub.slotWrites).toHaveLength(0);
    const logs = findWriteFailedLogs('refill_worker_slot_update');
    expect(logs).toHaveLength(1);
    expect(logs[0]['slot_address']).toBe(SLOT);
    expect(logs[0]['state']).toBe('refilling');
    expect(logs[0]['write_error']).toBe('redis slot write failed');
    worker.dispose();
  });

  it('confirmation below target balance writes refill_failed', async () => {
    const lock = makeStubLock();
    const getSlotBalance = vi.fn(async () => 0n);
    getSlotBalance.mockResolvedValueOnce(4_000_000_000n);
    getSlotBalance.mockResolvedValueOnce(9_999_999_999n);
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '10000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill: async () => refillSuccess(),
      getSlotBalance,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => stub.slotWrites.length >= 3);
    const states = stub.slotWrites.map((w) => w.fields.state);
    expect(states).toEqual(['refilling', 'awaiting_confirmation', 'refill_failed']);
    expect(stub.slotWrites[2].fields.refillReconciliationResult).toBe('balance_below_target');
    worker.dispose();
  });

  it('emits sponsor-refill-account write failure but still completes the slot lifecycle', async () => {
    const lock = makeStubLock();
    const getSlotBalance = vi.fn(async () => 0n);
    getSlotBalance.mockResolvedValueOnce(4_000_000_000n);
    getSlotBalance.mockResolvedValueOnce(10_000_000_000n);
    const state: RedisSponsorOperationsState = {
      ...stub.state,
      async updateSponsorRefillAccount() {
        throw new Error('sponsor refill account redis write failed');
      },
    };
    const worker = createSponsorOperationsRefillWorker({
      state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill: async () => refillSuccess(),
      getSlotBalance,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => stub.slotWrites.length >= 3);

    expect(stub.slotWrites.map((write) => write.fields.state)).toEqual([
      'refilling',
      'awaiting_confirmation',
      'healthy',
    ]);
    const logs = findWriteFailedLogs('refill_worker_sponsor_refill_account_update');
    expect(logs).toHaveLength(1);
    expect(logs[0]['sponsor_refill_account_address']).toBe(SPONSOR_REFILL_ACCOUNT_ADDRESS);
    expect(logs[0]['write_error']).toBe('sponsor refill account redis write failed');
    worker.dispose();
  });

  it('skips dispatch when another instance holds the refill lock', async () => {
    const lock = makeStubLock({ acquireReturns: [null] });
    const executeRefill = vi.fn(async () => refillSuccess());
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '0'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => 0n,
    });
    worker.requestRefill(SLOT);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(executeRefill).not.toHaveBeenCalled();
    expect(stub.slotWrites).toHaveLength(0);
    expect(lock.releaseCalls).toHaveLength(0);
    worker.dispose();
  });

  it('requestRefill suppresses duplicates while a slot is in-flight on this instance', async () => {
    const lock = makeStubLock();
    // Block `executeRefill` on a gate the test controls so duplicate
    // `requestRefill(SLOT)` calls land while the same slot is still
    // mid-lifecycle. Without local in-flight suppression, the
    // duplicates would re-enqueue and dispatch a second time after
    // the first lifecycle finishes.
    let gate!: () => void;
    const executeRefill = vi.fn(
      () =>
        new Promise<ReturnType<typeof refillSuccess>>((resolve) => {
          gate = () => resolve(refillSuccess());
        }),
    );
    const getSlotBalance = vi.fn(async () => 0n);
    getSlotBalance.mockResolvedValueOnce(4_000_000_000n);
    getSlotBalance.mockResolvedValueOnce(10_000_000_000n);
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '10000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance,
    });
    worker.requestRefill(SLOT);
    // Let the first requestRefill reach `executeRefill`.
    await waitUntil(() => executeRefill.mock.calls.length === 1);
    // These must be suppressed — SLOT is in-flight on this instance.
    worker.requestRefill(SLOT);
    worker.requestRefill(SLOT);
    // Release the first lifecycle; no second lifecycle should start
    // because the duplicates were suppressed while SLOT was in-flight.
    gate();
    await waitUntil(() => stub.slotWrites.length >= 3);
    expect(executeRefill).toHaveBeenCalledTimes(1);
    expect(executeRefill).toHaveBeenCalledWith(SLOT, 6_000_000_000n);
    worker.dispose();
  });

  it('runs different slot lifecycles concurrently while serializing refill tx dispatch', async () => {
    const lock = makeStubLock();
    let releaseFirstRefill!: () => void;
    let releaseSecondRefill!: () => void;
    let releaseFirstConfirmation!: () => void;
    const executeRefill = vi.fn((slotAddress: string) => {
      if (slotAddress === SLOT) {
        return new Promise<ReturnType<typeof refillSuccess>>((resolve) => {
          releaseFirstRefill = () => resolve(refillSuccess('0xrefill-a'));
        });
      }
      if (slotAddress === SLOT_B) {
        return new Promise<ReturnType<typeof refillSuccess>>((resolve) => {
          releaseSecondRefill = () => resolve(refillSuccess('0xrefill-b'));
        });
      }
      return Promise.resolve(refillSuccess());
    });
    const balanceReads = new Map<string, number>();
    const getSlotBalance = vi.fn((slotAddress: string) => {
      const nextCount = (balanceReads.get(slotAddress) ?? 0) + 1;
      balanceReads.set(slotAddress, nextCount);
      if (slotAddress === SLOT) {
        if (nextCount === 1) return Promise.resolve(4_000_000_000n);
        return new Promise<bigint>((resolve) => {
          releaseFirstConfirmation = () => resolve(10_000_000_000n);
        });
      }
      if (nextCount === 1) return Promise.resolve(5_000_000_000n);
      return Promise.resolve(10_000_000_000n);
    });
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance,
    });

    worker.requestRefill(SLOT);
    worker.requestRefill(SLOT_B);

    await waitUntil(() => executeRefill.mock.calls.length === 1);
    expect(lock.acquireCalls).toEqual([SLOT, SLOT_B]);
    expect(executeRefill).toHaveBeenCalledTimes(1);
    expect(executeRefill).toHaveBeenCalledWith(SLOT, 6_000_000_000n);
    expect(stub.slotWrites.filter((write) => write.fields.state === 'refilling')).toHaveLength(1);

    releaseFirstRefill();
    await waitUntil(() => executeRefill.mock.calls.length === 2);
    expect(executeRefill).toHaveBeenNthCalledWith(2, SLOT_B, 5_000_000_000n);

    const firstAwaitingConfirmation = stub.slotWrites.some(
      (write) => write.address === SLOT && write.fields.state === 'awaiting_confirmation',
    );
    expect(firstAwaitingConfirmation).toBe(true);
    expect(
      stub.slotWrites.some((write) => write.address === SLOT && write.fields.state === 'healthy'),
    ).toBe(false);

    releaseSecondRefill();
    await waitUntil(() =>
      stub.slotWrites.some((write) => write.address === SLOT_B && write.fields.state === 'healthy'),
    );
    expect(lock.releaseCalls.map((handle) => handle.slotAddress)).toContain(SLOT_B);

    releaseFirstConfirmation();
    await waitUntil(() =>
      stub.slotWrites.some((write) => write.address === SLOT && write.fields.state === 'healthy'),
    );
    expect(lock.releaseCalls.map((handle) => handle.slotAddress).sort()).toEqual(
      [SLOT, SLOT_B].sort(),
    );
    worker.dispose();
  });

  it('serializes refill tx dispatch across worker instances sharing the sponsor refill account lock', async () => {
    const slotLockA = makeStubLock();
    const slotLockB = makeStubLock();
    const sharedDispatchLock = makeStubSponsorRefillAccountDispatchLock();
    let releaseFirstRefill!: () => void;
    let releaseSecondRefill!: () => void;
    const executeRefill = vi.fn((slotAddress: string) => {
      if (slotAddress === SLOT) {
        return new Promise<ReturnType<typeof refillSuccess>>((resolve) => {
          releaseFirstRefill = () => resolve(refillSuccess('0xrefill-a'));
        });
      }
      if (slotAddress === SLOT_B) {
        return new Promise<ReturnType<typeof refillSuccess>>((resolve) => {
          releaseSecondRefill = () => resolve(refillSuccess('0xrefill-b'));
        });
      }
      return Promise.resolve(refillSuccess());
    });
    const balanceReads = new Map<string, number>();
    const getSlotBalance = vi.fn((slotAddress: string) => {
      const nextCount = (balanceReads.get(slotAddress) ?? 0) + 1;
      balanceReads.set(slotAddress, nextCount);
      return Promise.resolve(nextCount === 1 ? 4_000_000_000n : 10_000_000_000n);
    });
    const makeWorker = (slotLock: RefillLock) =>
      createSponsorOperationsRefillWorker({
        state: stub.state,
        refillLock: slotLock,
        sponsorRefillAccountDispatchLock: sharedDispatchLock.lock,
        sui: makeStubSui(async () => '20000000000'),
        sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
        warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
        refillTargetMist: 10_000_000_000n,
        refillTimeoutMs: 500,
        confirmationTimeoutMs: 500,
        sponsorRefillAccountBalanceTimeoutMs: 500,
        executeRefill,
        getSlotBalance,
      });
    const workerA = makeWorker(slotLockA.lock);
    const workerB = makeWorker(slotLockB.lock);

    workerA.requestRefill(SLOT);
    await waitUntil(() => executeRefill.mock.calls.length === 1);
    workerB.requestRefill(SLOT_B);
    await waitUntil(() => sharedDispatchLock.acquireCalls.length >= 2);

    expect(executeRefill).toHaveBeenCalledTimes(1);
    expect(executeRefill).toHaveBeenCalledWith(SLOT, 6_000_000_000n);

    releaseFirstRefill();
    await waitUntil(() => executeRefill.mock.calls.length === 2);
    expect(executeRefill).toHaveBeenNthCalledWith(2, SLOT_B, 6_000_000_000n);

    releaseSecondRefill();
    await waitUntil(() => sharedDispatchLock.releaseCalls.length === 2);
    workerA.dispose();
    workerB.dispose();
  });

  it('does not dispatch when the sponsor refill account lock stays unavailable through the dispatch budget', async () => {
    const lock = makeStubLock();
    const unavailableDispatchLock = makeStubSponsorRefillAccountDispatchLock();
    await unavailableDispatchLock.lock.acquire(SPONSOR_REFILL_ACCOUNT_ADDRESS);
    const executeRefill = vi.fn(async () => refillSuccess());
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: unavailableDispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 30,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => 4_000_000_000n,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() =>
      stub.slotWrites.some((write) => write.fields.state === 'refill_failed'),
    );

    expect(executeRefill).not.toHaveBeenCalled();
    expect(unavailableDispatchLock.releaseCalls).toHaveLength(0);
    expect(stub.slotWrites.map((write) => write.fields.state)).toEqual(['refill_failed']);
    expect(stub.slotWrites[0].fields.lastError).toContain(
      'acquireSponsorRefillAccountDispatchLock',
    );
    expect(stub.slotWrites[0].fields.refillReconciliationResult).toBe('dispatch_failed');
    worker.dispose();
  });

  it('does not release the sponsor refill account lock immediately when dispatch times out', async () => {
    const lock = makeStubLock();
    const executeRefill = vi.fn(
      () =>
        new Promise<ReturnType<typeof refillSuccess>>(() => {
          // Intentionally never settles; account lock recovery is TTL-owned.
        }),
    );
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 30,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => 4_000_000_000n,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() =>
      stub.slotWrites.some(
        (write) =>
          write.fields.state === 'awaiting_confirmation' &&
          write.fields.refillReconciliationResult === 'dispatch_timeout',
      ),
    );

    expect(executeRefill).toHaveBeenCalledTimes(1);
    expect(dispatchLock.releaseCalls).toHaveLength(0);
    expect(stub.slotWrites.map((write) => write.fields.state)).toEqual([
      'refilling',
      'awaiting_confirmation',
    ]);
    expect(stub.slotWrites[1].fields.lastError).toContain('executeRefill');
    expect(stub.slotWrites[1].fields.refillAttemptedAmountMist).toBe('6000000000');
    worker.dispose();
  });

  it('reconciles a late dispatch success after the dispatch timeout', async () => {
    const lock = makeStubLock();
    let resolveRefill!: (result: ReturnType<typeof refillSuccess>) => void;
    const executeRefill = vi.fn(
      () =>
        new Promise<ReturnType<typeof refillSuccess>>((resolve) => {
          resolveRefill = resolve;
        }),
    );
    const getSlotBalance = vi.fn(async () => 0n);
    getSlotBalance.mockResolvedValueOnce(4_000_000_000n);
    getSlotBalance.mockResolvedValueOnce(10_000_000_000n);
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 30,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() =>
      stub.slotWrites.some(
        (write) =>
          write.fields.state === 'awaiting_confirmation' &&
          write.fields.refillReconciliationResult === 'dispatch_timeout',
      ),
    );

    resolveRefill(refillSuccess('0xlate'));
    await waitUntil(() =>
      stub.slotWrites.some(
        (write) =>
          write.fields.state === 'healthy' &&
          write.fields.refillReconciliationResult === 'confirmed',
      ),
    );

    expect(stub.slotWrites.map((write) => write.fields.state)).toEqual([
      'refilling',
      'awaiting_confirmation',
      'awaiting_confirmation',
      'healthy',
    ]);
    expect(stub.slotWrites[2].fields.pendingRefillDigest).toBe('0xlate');
    expect(stub.slotWrites[3].fields.pendingRefillDigest).toBe('');
    expect(dispatchLock.releaseCalls).toHaveLength(1);
    worker.dispose();
  });

  it('does not resend after restart when a previous dispatch result is unknown', async () => {
    stub = makeStubState({
      [SLOT]: makeSlotRead('refill_failed', {
        refillAttemptedAmountMist: '6000000000',
        refillObservedBalanceMist: '4000000000',
        refillReconciliationResult: 'dispatch_timeout',
      }),
    });
    const lock = makeStubLock();
    const executeRefill = vi.fn(async () => refillSuccess());
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => 4_000_000_000n,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => stub.slotWrites.length >= 1);

    expect(executeRefill).not.toHaveBeenCalled();
    expect(dispatchLock.acquireCalls).toHaveLength(0);
    expect(stub.slotWrites[0].fields).toMatchObject({
      state: 'awaiting_confirmation',
      balanceMist: '4000000000',
      refillAttemptedAmountMist: '6000000000',
      refillObservedBalanceMist: '4000000000',
      refillReconciliationResult: 'still_pending',
    });
    worker.dispose();
  });

  it('confirms a pending refill digest without sending another transfer', async () => {
    stub = makeStubState({
      [SLOT]: makeSlotRead('awaiting_confirmation', {
        pendingRefillDigest: '0xpending',
        refillAttemptedAmountMist: '6000000000',
        refillObservedBalanceMist: '4000000000',
        refillReconciliationResult: 'dispatch_submitted',
      }),
    });
    const lock = makeStubLock();
    const executeRefill = vi.fn(async () => refillSuccess());
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '20000000000'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => 10_000_000_000n,
    });

    worker.requestRefill(SLOT);
    await waitUntil(() => stub.slotWrites.length >= 1);

    expect(executeRefill).not.toHaveBeenCalled();
    expect(stub.slotWrites[0].fields).toMatchObject({
      state: 'healthy',
      balanceMist: '10000000000',
      pendingRefillDigest: '',
      refillAttemptedAmountMist: '6000000000',
      refillObservedBalanceMist: '10000000000',
      refillReconciliationResult: 'confirmed',
    });
    worker.dispose();
  });

  it('dispose makes subsequent requestRefill no-ops', () => {
    const lock = makeStubLock();
    const executeRefill = vi.fn(async () => refillSuccess());
    const worker = createSponsorOperationsRefillWorker({
      state: stub.state,
      refillLock: lock.lock,
      sponsorRefillAccountDispatchLock: dispatchLock.lock,
      sui: makeStubSui(async () => '0'),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      refillTimeoutMs: 500,
      confirmationTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
      executeRefill,
      getSlotBalance: async () => 0n,
    });
    worker.dispose();
    worker.requestRefill(SLOT);
    expect(executeRefill).not.toHaveBeenCalled();
  });
});
