import { logStructuredEvent, SPONSOR_OPERATIONS_TASK_FAILED } from '@stelis/core-api/observability';
import type { SponsorResultCallback, SponsorResultMetadata } from '@stelis/core-api';
import {
  isAutomaticSponsorRefillEligible,
  type SponsorRefillAccountRefillReason,
  type SponsorRefillAccountSpendCoordinator,
  type SponsorRefillAccountSpendResult,
} from './accountSpend.js';
import type { RedisSponsorOperationsState } from './redisState.js';
import { normalizeSponsorOperationsLastError } from './lastError.js';
import type { SponsorOperationsSettings } from './settings.js';

export interface SponsorOperationsTaskSchedulerDeps {
  readonly settings: SponsorOperationsSettings;
  readonly state: Pick<RedisSponsorOperationsState, 'readAll' | 'readSlot'>;
  readonly spendCoordinator: SponsorRefillAccountSpendCoordinator;
  readonly observeBalances: (signal: AbortSignal) => Promise<void>;
  readonly observeSponsorResult: SponsorResultCallback;
}

export interface SponsorOperationsTaskScheduler {
  /** Recover durable spend state and complete the first balance observation. */
  start(): Promise<void>;
  /** Independently request spend recovery and a current balance observation. */
  reconcileOnce(): Promise<void>;
  /** Enqueue a refill after a newly stored low-balance observation. */
  requestObservedSlotRefill(slotAddress: string): void;
  /** Re-evaluate every slot against the current stored observations. */
  requestEligibleRefills(): Promise<void>;
  /** Run a retained current balance observation for an awaited Admin read. */
  observeBalances(): Promise<void>;
  /** Run the required post-execution observations in the retained observation group. */
  observeSponsorResult(metadata: SponsorResultMetadata, signal?: AbortSignal): Promise<void>;
  /** Run an Admin-authorized withdrawal in the retained account-spend task group. */
  withdraw(input: SponsorOperationsWithdrawalInput): Promise<SponsorRefillAccountSpendResult>;
  /** Stop accepting work, abort both task groups, and await retained work. */
  dispose(): Promise<void>;
}

export interface SponsorOperationsWithdrawalInput {
  readonly destinationAddress: string;
  readonly amountMist: string;
  readonly nonceKey: string;
}

type RefillTrigger = { readonly reason: SponsorRefillAccountRefillReason };

interface RecoveryRequest {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

interface WithdrawalRequest {
  readonly input: SponsorOperationsWithdrawalInput;
  readonly promise: Promise<SponsorRefillAccountSpendResult>;
  resolve(result: SponsorRefillAccountSpendResult): void;
  reject(error: unknown): void;
}

const REFILL_TRIGGER_PRIORITY: Readonly<Record<SponsorRefillAccountRefillReason, number>> = {
  slot_observed: 0,
  source_observed: 1,
  retry: 2,
};

function mergeTrigger(current: RefillTrigger | undefined, incoming: RefillTrigger): RefillTrigger {
  if (current === undefined) return incoming;
  return REFILL_TRIGGER_PRIORITY[incoming.reason] > REFILL_TRIGGER_PRIORITY[current.reason]
    ? incoming
    : current;
}

function createRecoveryRequest(): RecoveryRequest {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolveRequest, rejectRequest) => {
    resolve = resolveRequest;
    reject = rejectRequest;
  });
  return { promise, resolve, reject };
}

function createWithdrawalRequest(input: SponsorOperationsWithdrawalInput): WithdrawalRequest {
  let resolve!: (result: SponsorRefillAccountSpendResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<SponsorRefillAccountSpendResult>((resolveRequest, rejectRequest) => {
    resolve = resolveRequest;
    reject = rejectRequest;
  });
  return { input: Object.freeze({ ...input }), promise, resolve, reject };
}

export function createSponsorOperationsTaskScheduler(
  deps: SponsorOperationsTaskSchedulerDeps,
): SponsorOperationsTaskScheduler {
  let startTask: Promise<void> | null = null;
  let disposed = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let observationTask: Promise<void> | null = null;
  let observationTrailing = false;
  let eligibilityTask: Promise<void> | null = null;
  let eligibilityTrailing = false;
  let spendWorker: Promise<void> | null = null;
  let pendingRecovery: RecoveryRequest | null = null;
  let activeRecovery: RecoveryRequest | null = null;
  let disposal: Promise<void> | null = null;
  const abortController = new AbortController();
  const observationTasks = new Set<Promise<unknown>>();
  const spendTasks = new Set<Promise<unknown>>();
  const pendingWithdrawals: WithdrawalRequest[] = [];
  const pendingRefills = new Map<string, RefillTrigger>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function retain<T>(
    tasks: Set<Promise<unknown>>,
    task: Promise<T>,
    onSettled: () => void,
  ): Promise<T> {
    tasks.add(task);
    void task.then(
      () => {
        tasks.delete(task);
        onSettled();
      },
      () => {
        tasks.delete(task);
        onSettled();
      },
    );
    return task;
  }

  function scheduleRetry(slotAddress: string, trigger: RefillTrigger): void {
    if (disposed || retryTimers.has(slotAddress)) return;
    const timer = setTimeout(() => {
      retryTimers.delete(slotAddress);
      if (!abortController.signal.aborted) enqueueRefill(slotAddress, trigger);
    }, deps.settings.confirmationTimeoutMs);
    timer.unref?.();
    retryTimers.set(slotAddress, timer);
  }

  async function runRefill(slotAddress: string, trigger: RefillTrigger): Promise<void> {
    try {
      abortController.signal.throwIfAborted();
      const result = await deps.spendCoordinator.refill(
        slotAddress,
        trigger.reason,
        abortController.signal,
      );
      abortController.signal.throwIfAborted();
      if (result.status === 'pending' || result.status === 'busy') {
        scheduleRetry(slotAddress, trigger);
        return;
      }
      if (result.status === 'failed') {
        if (deps.settings.refillEnabled) {
          scheduleRetry(slotAddress, { reason: 'retry' });
        }
        return;
      }
      if (result.status === 'runway_blocked' || result.status === 'not_eligible') return;
      const after = await deps.state.readSlot(slotAddress);
      abortController.signal.throwIfAborted();
      if (after?.state === 'low_balance' || after?.state === 'rpc_unreachable') {
        scheduleRetry(slotAddress, { reason: 'retry' });
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (deps.settings.refillEnabled) {
        scheduleRetry(slotAddress, { reason: 'retry' });
      }
      try {
        logStructuredEvent(
          SPONSOR_OPERATIONS_TASK_FAILED,
          {
            task: 'slot_refill',
            slot_address: slotAddress,
            error: normalizeSponsorOperationsLastError(error),
          },
          'warn',
        );
      } catch {
        // A diagnostic sink cannot cancel the durable retry.
      }
    }
  }

  async function runSpendTasks(): Promise<void> {
    while (!disposed) {
      const recovery = pendingRecovery;
      if (recovery !== null) {
        pendingRecovery = null;
        activeRecovery = recovery;
        try {
          await deps.spendCoordinator.recoverActiveSpend(abortController.signal);
          abortController.signal.throwIfAborted();
          recovery.resolve();
        } catch (error) {
          recovery.reject(error);
        } finally {
          if (activeRecovery === recovery) activeRecovery = null;
        }
        continue;
      }

      const withdrawal = pendingWithdrawals.shift();
      if (withdrawal !== undefined) {
        try {
          const result = await deps.spendCoordinator.withdraw({
            ...withdrawal.input,
            signal: abortController.signal,
          });
          withdrawal.resolve(result);
        } catch (error) {
          withdrawal.reject(error);
        }
        continue;
      }

      const next = pendingRefills.entries().next();
      if (next.done) return;
      const [slotAddress, trigger] = next.value;
      pendingRefills.delete(slotAddress);
      await runRefill(slotAddress, trigger);
    }
  }

  function ensureSpendWorker(): void {
    if (disposed || spendWorker !== null) return;
    const task = runSpendTasks();
    spendWorker = retain(spendTasks, task, () => {
      if (spendWorker === task) spendWorker = null;
      if (
        !disposed &&
        (pendingRecovery !== null || pendingWithdrawals.length > 0 || pendingRefills.size > 0)
      ) {
        ensureSpendWorker();
      }
    });
  }

  function requestRecovery(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (activeRecovery !== null) return activeRecovery.promise;
    if (pendingRecovery !== null) return pendingRecovery.promise;
    const request = createRecoveryRequest();
    pendingRecovery = request;
    ensureSpendWorker();
    return request.promise;
  }

  function enqueueRefill(slotAddress: string, trigger: RefillTrigger): void {
    if (disposed) return;
    const timer = retryTimers.get(slotAddress);
    if (timer !== undefined) {
      clearTimeout(timer);
      retryTimers.delete(slotAddress);
    }
    pendingRefills.set(slotAddress, mergeTrigger(pendingRefills.get(slotAddress), trigger));
    ensureSpendWorker();
  }

  async function scanEligibleRefills(): Promise<void> {
    abortController.signal.throwIfAborted();
    const { slots, sponsorRefillAccount } = await deps.state.readAll();
    abortController.signal.throwIfAborted();
    for (const slot of slots) {
      if (isAutomaticSponsorRefillEligible(slot, sponsorRefillAccount, 'source_observed')) {
        enqueueRefill(slot.address, { reason: 'source_observed' });
      }
    }
  }

  function requestEligibleRefills(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (eligibilityTask !== null) {
      eligibilityTrailing = true;
      const current = eligibilityTask;
      return current.then(() => {
        const next = eligibilityTask;
        return next !== null && next !== current ? next : undefined;
      });
    }

    const task = (async () => {
      let firstError: unknown;
      do {
        eligibilityTrailing = false;
        try {
          await scanEligibleRefills();
        } catch (error) {
          firstError ??= error;
        }
      } while (eligibilityTrailing && !disposed);
      if (firstError !== undefined) throw firstError;
    })();
    eligibilityTask = retain(observationTasks, task, () => {
      if (eligibilityTask === task) eligibilityTask = null;
      if (!disposed && eligibilityTrailing) {
        void requestEligibleRefills().catch(() => {
          // The request that set the trailing flag also awaits this retained task.
        });
      }
    });
    return eligibilityTask;
  }

  function requestObservation(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (observationTask !== null) {
      observationTrailing = true;
      const current = observationTask;
      return current.then(() => {
        const next = observationTask;
        return next !== null && next !== current ? next : undefined;
      });
    }

    const task = (async () => {
      let firstError: unknown;
      do {
        observationTrailing = false;
        try {
          abortController.signal.throwIfAborted();
          await deps.observeBalances(abortController.signal);
          abortController.signal.throwIfAborted();
          await requestEligibleRefills();
        } catch (error) {
          firstError ??= error;
        }
      } while (observationTrailing && !disposed);
      if (firstError !== undefined) throw firstError;
    })();
    observationTask = retain(observationTasks, task, () => {
      if (observationTask === task) observationTask = null;
      if (!disposed && observationTrailing) {
        void requestObservation().catch(() => {
          // The request that set the trailing flag also awaits this retained task.
        });
      }
    });
    return observationTask;
  }

  function reconcileOnce(): Promise<void> {
    if (disposed) return Promise.resolve();
    const recovery = requestRecovery();
    const observation = requestObservation();
    return Promise.all([recovery, observation]).then(() => undefined);
  }

  function observeBalances(): Promise<void> {
    if (disposed) {
      return Promise.reject(new Error('SponsorOperations task scheduler is disposed'));
    }
    return requestObservation();
  }

  function observeSponsorResult(
    metadata: SponsorResultMetadata,
    signal?: AbortSignal,
  ): Promise<void> {
    if (disposed) {
      return Promise.reject(new Error('SponsorOperations task scheduler is disposed'));
    }
    const taskSignal =
      signal === undefined
        ? abortController.signal
        : AbortSignal.any([abortController.signal, signal]);
    const task = Promise.resolve().then(() => deps.observeSponsorResult(metadata, taskSignal));
    return retain(observationTasks, task, () => undefined);
  }

  function withdraw(
    input: SponsorOperationsWithdrawalInput,
  ): Promise<SponsorRefillAccountSpendResult> {
    if (disposed) {
      return Promise.reject(new Error('SponsorOperations task scheduler is disposed'));
    }
    const request = createWithdrawalRequest(input);
    pendingWithdrawals.push(request);
    ensureSpendWorker();
    return request.promise;
  }

  function start(): Promise<void> {
    if (disposed) return Promise.reject(new Error('SponsorOperations task scheduler is disposed'));
    if (startTask !== null) return startTask;
    startTask = (async () => {
      await reconcileOnce();
      if (disposed) return;
      interval = setInterval(() => {
        void reconcileOnce().catch(() => {
          // Durable records and the retained trailing observation remain retryable.
        });
      }, deps.settings.reconciliationIntervalMs);
      interval.unref?.();
    })();
    return startTask;
  }

  function dispose(): Promise<void> {
    if (disposal !== null) return disposal;
    disposed = true;
    abortController.abort();
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    pendingRefills.clear();
    if (pendingRecovery !== null) {
      pendingRecovery.reject(abortController.signal.reason);
      pendingRecovery = null;
    }
    for (const withdrawal of pendingWithdrawals.splice(0)) {
      withdrawal.reject(abortController.signal.reason);
    }
    disposal = Promise.allSettled([...observationTasks, ...spendTasks]).then(() => undefined);
    return disposal;
  }

  return {
    start,
    reconcileOnce,
    requestObservedSlotRefill(slotAddress): void {
      enqueueRefill(slotAddress, { reason: 'slot_observed' });
    },
    requestEligibleRefills,
    observeBalances,
    observeSponsorResult,
    withdraw,
    dispose,
  };
}
