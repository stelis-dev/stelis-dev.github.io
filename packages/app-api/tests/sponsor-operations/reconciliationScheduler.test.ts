import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SponsorResultMetadata } from '@stelis/core-api';
import type { SponsorRefillAccountSpendCoordinator } from '../../src/sponsor-operations/accountSpend.js';
import type { RedisSponsorOperationsState } from '../../src/sponsor-operations/redisState.js';
import {
  createSponsorOperationsTaskScheduler,
  type SponsorOperationsTaskSchedulerDeps,
} from '../../src/sponsor-operations/reconciliationScheduler.js';
import { createTestSponsorOperationsSettings } from './settingsFixture.js';
import type { SponsorOperationsSettings } from '../../src/sponsor-operations/settings.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function requireAbortSignal(signal: AbortSignal | undefined): AbortSignal {
  if (signal === undefined) throw new Error('Expected the scheduler-owned abort signal');
  return signal;
}

function emptyState(
  settings: SponsorOperationsSettings,
): SponsorOperationsTaskSchedulerDeps['state'] {
  return {
    readAll: vi.fn(async () => ({
      settings,
      slots: [],
      sponsorRefillAccount: {
        totalBalanceMist: '1000',
        healthy: true,
        lastError: null,
        lastObservedAtMs: 1,
        writeSeq: 1,
        observationFresh: true,
      },
    })),
    readSlot: vi.fn(async () => null),
  } as unknown as Pick<RedisSponsorOperationsState, 'readAll' | 'readSlot'>;
}

function coordinator(
  overrides: Partial<SponsorRefillAccountSpendCoordinator> = {},
): SponsorRefillAccountSpendCoordinator {
  return {
    withdraw: vi.fn(async () => ({ status: 'nonce_missing' as const })),
    refill: vi.fn(async (slotAddress) => ({ status: 'not_eligible' as const, slotAddress })),
    recoverActiveSpend: vi.fn(async () => null),
    ...overrides,
  };
}

function scheduler(input: {
  spendCoordinator?: SponsorRefillAccountSpendCoordinator;
  observeBalances?: (signal: AbortSignal) => Promise<void>;
  observeSponsorResult?: (metadata: SponsorResultMetadata, signal?: AbortSignal) => Promise<void>;
  state?: SponsorOperationsTaskSchedulerDeps['state'];
  intervalMs?: number;
}) {
  const intervalMs = input.intervalMs ?? 10_000;
  const settings = createTestSponsorOperationsSettings({
    reconciliationIntervalMs: intervalMs,
    slotBalanceTimeoutMs: Math.min(5_000, intervalMs),
    sponsorRefillAccountBalanceTimeoutMs: Math.min(5_000, intervalMs),
  });
  return createSponsorOperationsTaskScheduler({
    settings,
    state: input.state ?? emptyState(settings),
    spendCoordinator: input.spendCoordinator ?? coordinator(),
    observeBalances: input.observeBalances ?? vi.fn(async () => undefined),
    observeSponsorResult: input.observeSponsorResult ?? vi.fn(async () => undefined),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SponsorOperations task scheduler', () => {
  it('completes recovery and observation before installing the periodic interval', async () => {
    vi.useFakeTimers();
    const recoverActiveSpend = vi.fn(async () => null);
    const observeBalances = vi.fn(async () => undefined);
    const tasks = scheduler({
      spendCoordinator: coordinator({ recoverActiveSpend }),
      observeBalances,
      intervalMs: 100,
    });

    await tasks.start();
    expect(recoverActiveSpend).toHaveBeenCalledTimes(1);
    expect(observeBalances).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(recoverActiveSpend).toHaveBeenCalledTimes(3);
    expect(observeBalances).toHaveBeenCalledTimes(3);

    await tasks.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(recoverActiveSpend).toHaveBeenCalledTimes(3);
    expect(observeBalances).toHaveBeenCalledTimes(3);
  });

  it('runs observation beside an active refill without overlap and retains one trailing pass', async () => {
    const refillResult = deferred<{ status: 'not_eligible'; slotAddress: string }>();
    const refill = vi.fn<SponsorRefillAccountSpendCoordinator['refill']>(
      (_slot, _reason, signal) => {
        requireAbortSignal(signal).throwIfAborted();
        return refillResult.promise;
      },
    );
    const recoverActiveSpend = vi.fn(async () => null);
    const firstObservation = deferred<void>();
    let activeObservations = 0;
    let maximumActiveObservations = 0;
    const observeBalances = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockImplementationOnce(async (signal) => {
        signal.throwIfAborted();
        activeObservations += 1;
        maximumActiveObservations = Math.max(maximumActiveObservations, activeObservations);
        await firstObservation.promise;
        activeObservations -= 1;
      })
      .mockImplementation(async (signal) => {
        signal.throwIfAborted();
        activeObservations += 1;
        maximumActiveObservations = Math.max(maximumActiveObservations, activeObservations);
        activeObservations -= 1;
      });
    const tasks = scheduler({
      spendCoordinator: coordinator({ refill, recoverActiveSpend }),
      observeBalances,
    });

    tasks.requestObservedSlotRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));

    const reconciliations = [tasks.reconcileOnce(), tasks.reconcileOnce(), tasks.reconcileOnce()];
    await vi.waitFor(() => expect(observeBalances).toHaveBeenCalledTimes(1));
    expect(recoverActiveSpend).not.toHaveBeenCalled();

    firstObservation.resolve();
    await vi.waitFor(() => expect(observeBalances).toHaveBeenCalledTimes(2));
    expect(maximumActiveObservations).toBe(1);

    refillResult.resolve({ status: 'not_eligible', slotAddress: '0xslot' });
    await Promise.all(reconciliations);
    expect(recoverActiveSpend).toHaveBeenCalledTimes(1);
    expect(observeBalances).toHaveBeenCalledTimes(2);
    await tasks.dispose();
  });

  it('runs pending recovery and FIFO withdrawals before the next queued refill', async () => {
    const firstRefill = deferred<{ status: 'not_eligible'; slotAddress: string }>();
    const recovery = deferred<null>();
    const order: string[] = [];
    const refill = vi
      .fn<SponsorRefillAccountSpendCoordinator['refill']>()
      .mockImplementationOnce(async (slot, _reason, signal) => {
        requireAbortSignal(signal).throwIfAborted();
        order.push(`refill:${slot}`);
        return firstRefill.promise;
      })
      .mockImplementation(async (slot, _reason, signal) => {
        requireAbortSignal(signal).throwIfAborted();
        order.push(`refill:${slot}`);
        return { status: 'not_eligible', slotAddress: slot };
      });
    const recoverActiveSpend = vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
      order.push('recover');
      return recovery.promise;
    });
    const withdraw = vi.fn<SponsorRefillAccountSpendCoordinator['withdraw']>(async (input) => {
      requireAbortSignal(input.signal).throwIfAborted();
      order.push(`withdraw:${input.nonceKey}`);
      return { status: 'nonce_missing' };
    });
    const tasks = scheduler({
      spendCoordinator: coordinator({
        refill,
        recoverActiveSpend,
        withdraw,
      }),
    });

    tasks.requestObservedSlotRefill('slot-a');
    await vi.waitFor(() => expect(order).toEqual(['refill:slot-a']));
    tasks.requestObservedSlotRefill('slot-b');
    const firstWithdrawal = tasks.withdraw({
      destinationAddress: '0xdestination',
      amountMist: '1',
      nonceKey: 'nonce-a',
    });
    const secondWithdrawal = tasks.withdraw({
      destinationAddress: '0xdestination',
      amountMist: '2',
      nonceKey: 'nonce-b',
    });
    const reconciliation = tasks.reconcileOnce();

    firstRefill.resolve({ status: 'not_eligible', slotAddress: 'slot-a' });
    await vi.waitFor(() => expect(order).toEqual(['refill:slot-a', 'recover']));
    expect(refill).toHaveBeenCalledTimes(1);
    expect(withdraw).not.toHaveBeenCalled();
    const coalescedReconciliation = tasks.reconcileOnce();

    recovery.resolve(null);
    await Promise.all([reconciliation, coalescedReconciliation]);
    await Promise.all([firstWithdrawal, secondWithdrawal]);
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    expect(recoverActiveSpend).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      'refill:slot-a',
      'recover',
      'withdraw:nonce-a',
      'withdraw:nonce-b',
      'refill:slot-b',
    ]);
    await tasks.dispose();
  });

  it('does not run recovery beside an active withdrawal', async () => {
    const withdrawalResult = deferred<{ status: 'nonce_missing' }>();
    const order: string[] = [];
    const withdraw = vi.fn<SponsorRefillAccountSpendCoordinator['withdraw']>((input) => {
      requireAbortSignal(input.signal).throwIfAborted();
      order.push('withdraw');
      return withdrawalResult.promise;
    });
    const recoverActiveSpend = vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted();
      order.push('recover');
      return null;
    });
    const tasks = scheduler({
      spendCoordinator: coordinator({ withdraw, recoverActiveSpend }),
    });

    const withdrawal = tasks.withdraw({
      destinationAddress: '0xdestination',
      amountMist: '1',
      nonceKey: 'nonce',
    });
    await vi.waitFor(() => expect(order).toEqual(['withdraw']));
    const reconciliation = tasks.reconcileOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(recoverActiveSpend).not.toHaveBeenCalled();

    withdrawalResult.resolve({ status: 'nonce_missing' });
    await withdrawal;
    await reconciliation;
    expect(order).toEqual(['withdraw', 'recover']);
    await tasks.dispose();
  });

  it('retries a terminal refill failure after the confirmation interval', async () => {
    vi.useFakeTimers();
    const refill = vi
      .fn<SponsorRefillAccountSpendCoordinator['refill']>()
      .mockResolvedValueOnce({
        status: 'failed',
        operationId: 'operation-1',
        digest: null,
        amountMist: '100',
        error: 'chain execution failed',
      })
      .mockImplementation(async (slot, _reason, signal) => {
        requireAbortSignal(signal).throwIfAborted();
        return { status: 'not_eligible', slotAddress: slot };
      });
    const tasks = scheduler({ spendCoordinator: coordinator({ refill }) });

    tasks.requestObservedSlotRefill('0xslot');
    await vi.advanceTimersByTimeAsync(0);
    expect(refill).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(refill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refill).toHaveBeenCalledTimes(2);

    await tasks.dispose();
  });

  it('owns observation and active spend work and rejects a queued withdrawal on disposal', async () => {
    const observationSignal = deferred<AbortSignal>();
    const refillSignal = deferred<AbortSignal>();
    const sponsorResultSignal = deferred<AbortSignal>();
    const waitForAbort = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const observeBalances = vi.fn(async (signal: AbortSignal) => {
      observationSignal.resolve(signal);
      return waitForAbort(signal);
    });
    const refill = vi.fn<SponsorRefillAccountSpendCoordinator['refill']>(
      async (_slot, _reason, signal) => {
        const taskSignal = requireAbortSignal(signal);
        refillSignal.resolve(taskSignal);
        return waitForAbort(taskSignal);
      },
    );
    const withdraw = vi.fn<SponsorRefillAccountSpendCoordinator['withdraw']>(async (input) => {
      const taskSignal = requireAbortSignal(input.signal);
      return waitForAbort(taskSignal);
    });
    const observeSponsorResult = vi.fn(
      async (_metadata: SponsorResultMetadata, signal?: AbortSignal) => {
        const taskSignal = requireAbortSignal(signal);
        sponsorResultSignal.resolve(taskSignal);
        return waitForAbort(taskSignal);
      },
    );
    const tasks = scheduler({
      spendCoordinator: coordinator({ refill, withdraw }),
      observeBalances,
      observeSponsorResult,
    });
    const sponsorResultMetadata: SponsorResultMetadata = {
      sponsorAddress: '0x1',
      outcome: 'success',
      executionStage: 'on_chain',
      route: 'generic',
      digest: 'digest',
      receiptId: 'receipt',
      senderAddress: '0x2',
      executionPathKey: 'path',
      orderIdHash: null,
      promotionId: null,
      userId: null,
      economics: { economicsStatus: 'unknown', failureReason: null },
    };

    tasks.requestObservedSlotRefill('0xslot');
    const observationResult = tasks.observeBalances().catch((error: unknown) => error);
    const withdrawalResult = tasks
      .withdraw({ destinationAddress: '0xdestination', amountMist: '1', nonceKey: 'nonce' })
      .catch((error: unknown) => error);
    const sponsorResult = tasks
      .observeSponsorResult(sponsorResultMetadata)
      .catch((error: unknown) => error);
    const [observed, spending, resultObservation] = await Promise.all([
      observationSignal.promise,
      refillSignal.promise,
      sponsorResultSignal.promise,
    ]);
    expect(withdraw).not.toHaveBeenCalled();

    await tasks.dispose();
    expect(observed.aborted).toBe(true);
    expect(spending.aborted).toBe(true);
    expect(resultObservation.aborted).toBe(true);
    await expect(observationResult).resolves.toMatchObject({ name: 'AbortError' });
    await expect(withdrawalResult).resolves.toMatchObject({ name: 'AbortError' });
    await expect(sponsorResult).resolves.toMatchObject({ name: 'AbortError' });
    await expect(tasks.observeBalances()).rejects.toThrow('scheduler is disposed');
    await expect(
      tasks.withdraw({ destinationAddress: '0xdestination', amountMist: '1', nonceKey: 'nonce' }),
    ).rejects.toThrow('scheduler is disposed');
    await expect(tasks.observeSponsorResult(sponsorResultMetadata)).rejects.toThrow(
      'scheduler is disposed',
    );
  });

  it('keeps every disposal pending until abort-triggered cleanup settles', async () => {
    const observationStarted = deferred<AbortSignal>();
    const cleanupStarted = deferred<void>();
    const releaseCleanup = deferred<void>();
    const observeBalances = vi.fn(async (signal: AbortSignal) => {
      observationStarted.resolve(signal);
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            cleanupStarted.resolve(undefined);
            resolve();
          },
          { once: true },
        );
      });
      await releaseCleanup.promise;
      throw signal.reason;
    });
    const tasks = scheduler({ observeBalances });
    const observation = tasks.observeBalances().catch((error: unknown) => error);
    await observationStarted.promise;

    const firstDispose = tasks.dispose();
    const secondDispose = tasks.dispose();
    let disposed = false;
    void firstDispose.then(() => {
      disposed = true;
    });
    await cleanupStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disposed).toBe(false);

    releaseCleanup.resolve(undefined);
    await expect(firstDispose).resolves.toBeUndefined();
    await expect(secondDispose).resolves.toBeUndefined();
    await expect(observation).resolves.toMatchObject({ name: 'AbortError' });
  });
});
