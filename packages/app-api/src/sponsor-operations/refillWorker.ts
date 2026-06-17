/**
 * [app-api] Sponsor operations refill worker — Redis-shared state + distributed locks.
 *
 * Lifecycle for a single refill:
 *
 *   requestRefill(addr)
 *     → start a slot lifecycle on this instance. No-op if the slot is
 *       already running here. Cross-instance duplicate dispatch is
 *       prevented by the Redis-scoped refill lock (below), not by the
 *       local in-flight set.
 *
 *   runSlotLifecycle(addr)
 *     1. Try to acquire `stelis:app-api:sponsor-operations:refill-lock:<addr>`
 *        via `SET NX PX`. If another instance holds it, the worker
 *        skips this slot — the still-running instance will drive the
 *        refill to completion.
 *     2. Reconcile any previous pending/timeout refill attempt before
 *        sending a new transfer.
 *     3. Observe the current slot balance and calculate the refill
 *        transfer as `max(0, refillTargetMist - currentBalance)`.
 *     4. Acquire the sponsor-refill-account dispatch lock. Only after
 *        that lock is held, write durable attempt fields and execute
 *        the injected refill TX under the remaining `refillTimeoutMs`
 *        budget.
 *     5. Dispatch success writes `state='awaiting_confirmation'` with
 *        the pending digest, refreshes the sponsor refill account
 *        best-effort, then confirms the slot balance against the refill
 *        target. Dispatch timeout writes `state='awaiting_confirmation'`
 *        and lets the underlying promise reconcile late success/failure.
 *     6. Release the slot lock via a matching-token Lua CAS delete.
 *
 * Slot lock TTL:
 *   Derived from the bounded lifecycle phase timers plus
 *   `SPONSOR_OPERATIONS_REFILL_LOCK_SAFETY_MARGIN_MS`.
 * Covers the phases executed inside the locked window.
 *
 * Observability:
 *   - Slot or sponsor refill account write failures emit `SPONSOR_OPERATIONS_STATE_WRITE_FAILED`
 *     so Redis commit failures are visible instead of being silently
 *     swallowed. Slot-write failure aborts the current lifecycle;
 *     sponsor refill account refresh remains best-effort after a successful refill TX.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SponsorSlotState } from '@stelis/contracts';
import {
  logStructuredEvent,
  SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
} from '@stelis/core-api/observability';
import type {
  RedisSponsorOperationsState,
  RefillReconciliationResult,
  SlotRead,
  SlotWriteFields,
} from './redisState.js';
import type {
  RefillLock,
  SponsorRefillAccountDispatchLock,
  SponsorRefillAccountDispatchLockHandle,
} from './refillLock.js';
import { normalizeSponsorOperationsLastError } from './lastError.js';
import { probeAndWriteSponsorRefillAccountState } from './sponsorRefillAccountProbe.js';
import { SponsorOperationsTimeoutError, withTimeout } from './timeout.js';

export interface SponsorOperationsRefillWorkerDeps {
  readonly state: RedisSponsorOperationsState;
  readonly refillLock: RefillLock;
  readonly sponsorRefillAccountDispatchLock: SponsorRefillAccountDispatchLock;
  readonly sui: SuiGrpcClient;
  readonly sponsorRefillAccountAddress: string;
  readonly warnThresholdMist: bigint;
  readonly refillTargetMist: bigint | null;
  /** Upper bound for a single `executeRefill` dispatch. Required — caller must justify. */
  readonly refillTimeoutMs: number;
  /** Upper bound for the `awaiting_confirmation` phase. Required. */
  readonly confirmationTimeoutMs: number;
  /** Upper bound for the bounded post-refill sponsor refill account probe. Required. */
  readonly sponsorRefillAccountBalanceTimeoutMs: number;
  /** Unbounded refill dispatch. Wrapped in `withTimeout(refillTimeoutMs, …)`. */
  readonly executeRefill: (
    slotAddress: string,
    amountMist: bigint,
  ) => Promise<SponsorOperationsRefillDispatchResult>;
  /** Unbounded slot balance reader. Wrapped in `withTimeout(confirmationTimeoutMs, …)`. */
  readonly getSlotBalance: (slotAddress: string) => Promise<bigint>;
}

export interface SponsorOperationsRefillDispatchResult {
  readonly success: boolean;
  readonly digest: string | null;
  readonly error: string | null;
}

interface RefillAttempt {
  readonly observedBalanceMist: bigint;
  readonly amountMist: bigint;
}

interface ActiveRefillDispatch {
  readonly remainingMs: number;
  readonly resultPromise: Promise<SponsorOperationsRefillDispatchResult>;
}

interface AcquiredRefillDispatchLock {
  readonly handle: SponsorRefillAccountDispatchLockHandle;
  readonly remainingMs: number;
}

export interface SponsorOperationsRefillWorker {
  /**
   * Enqueue a refill request. No-op when the slot is already queued on
   * this instance. Cross-instance coordination happens via the Redis
   * refill lock once dispatch begins.
   */
  requestRefill(slotAddress: string): void;
  /**
   * Drain queued work, dispose resources, and make subsequent
   * `requestRefill` calls no-ops.
   */
  dispose(): void;
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `createSponsorOperationsRefillWorker: ${name} must be a positive safe integer, got ${String(value)}`,
    );
  }
}

function classifySlotFromBalance(balance: bigint, warnThresholdMist: bigint): SponsorSlotState {
  return balance >= warnThresholdMist ? 'healthy' : 'low_balance';
}

function refillConfirmationThreshold(
  deps: Pick<SponsorOperationsRefillWorkerDeps, 'refillTargetMist' | 'warnThresholdMist'>,
): bigint {
  return deps.refillTargetMist ?? deps.warnThresholdMist;
}

function computeRefillAmount(currentBalanceMist: bigint, refillTargetMist: bigint): bigint {
  return currentBalanceMist >= refillTargetMist ? 0n : refillTargetMist - currentBalanceMist;
}

function clearRefillAttemptFields(): Pick<
  SlotWriteFields,
  | 'pendingRefillDigest'
  | 'refillAttemptedAmountMist'
  | 'refillObservedBalanceMist'
  | 'refillReconciliationResult'
> {
  return {
    pendingRefillDigest: '',
    refillAttemptedAmountMist: '',
    refillObservedBalanceMist: '',
    refillReconciliationResult: '',
  };
}

function refillAttemptFields(input: {
  readonly pendingRefillDigest?: string | null;
  readonly attemptedAmountMist: bigint | string | null;
  readonly observedBalanceMist: bigint | string | null;
  readonly reconciliationResult: RefillReconciliationResult;
}): Pick<
  SlotWriteFields,
  | 'pendingRefillDigest'
  | 'refillAttemptedAmountMist'
  | 'refillObservedBalanceMist'
  | 'refillReconciliationResult'
> {
  return {
    pendingRefillDigest: input.pendingRefillDigest ?? '',
    refillAttemptedAmountMist:
      typeof input.attemptedAmountMist === 'bigint'
        ? input.attemptedAmountMist.toString()
        : (input.attemptedAmountMist ?? ''),
    refillObservedBalanceMist:
      typeof input.observedBalanceMist === 'bigint'
        ? input.observedBalanceMist.toString()
        : (input.observedBalanceMist ?? ''),
    refillReconciliationResult: input.reconciliationResult,
  };
}

function hasUnresolvedRefill(slot: SlotRead | null): boolean {
  if (slot === null) return false;
  if (slot.pendingRefillDigest !== null) return true;
  if (
    slot.refillReconciliationResult === 'dispatch_started' ||
    slot.refillReconciliationResult === 'dispatch_submitted' ||
    slot.refillReconciliationResult === 'dispatch_timeout' ||
    slot.refillReconciliationResult === 'still_pending'
  ) {
    return true;
  }
  return slot.state === 'awaiting_confirmation' && slot.refillAttemptedAmountMist !== null;
}

function refillTargetNotConfiguredError(): Error {
  return new Error('refill target not configured');
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  });
}

export function createSponsorOperationsRefillWorker(
  deps: SponsorOperationsRefillWorkerDeps,
): SponsorOperationsRefillWorker {
  assertPositiveFinite('refillTimeoutMs', deps.refillTimeoutMs);
  assertPositiveFinite('confirmationTimeoutMs', deps.confirmationTimeoutMs);
  assertPositiveFinite(
    'sponsorRefillAccountBalanceTimeoutMs',
    deps.sponsorRefillAccountBalanceTimeoutMs,
  );

  let disposed = false;
  // Slots currently running through `runSlotLifecycle` on THIS instance.
  // Prevents a duplicate `requestRefill(addr)` from re-enqueueing while
  // the same slot is mid-lifecycle here. Cross-instance duplicate
  // dispatch is prevented separately by the Redis refill lock.
  const inFlight = new Set<string>();
  async function writeSlot(
    address: string,
    fields: Parameters<RedisSponsorOperationsState['updateSlot']>[1],
  ): Promise<boolean> {
    try {
      await deps.state.updateSlot(address, fields);
      return true;
    } catch (err) {
      logStructuredEvent(
        SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
        {
          source: 'refill_worker_slot_update',
          slot_address: address,
          state: fields.state,
          write_error: getErrorMessage(err),
        },
        'warn',
      );
      return false;
    }
  }

  async function refreshSponsorRefillAccount(): Promise<void> {
    await probeAndWriteSponsorRefillAccountState(
      {
        sui: deps.sui,
        state: deps.state,
        sponsorRefillAccountAddress: deps.sponsorRefillAccountAddress,
        refillTargetMist: deps.refillTargetMist,
        sponsorRefillAccountBalanceTimeoutMs: deps.sponsorRefillAccountBalanceTimeoutMs,
      },
      {
        operation: 'refillWorker.getSponsorRefillAccountBalance',
        source: 'refill_worker_sponsor_refill_account_update',
        writeFailureMode: 'swallow',
      },
    );
  }

  async function acquireAccountDispatchLock(deadlineMs: number) {
    const pollMs = 25;
    while (!disposed) {
      const handle = await deps.sponsorRefillAccountDispatchLock.acquire(
        deps.sponsorRefillAccountAddress,
      );
      if (handle !== null) return handle;

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(pollMs, remainingMs));
    }

    if (disposed) return null;
    throw new SponsorOperationsTimeoutError(
      `refillWorker.acquireSponsorRefillAccountDispatchLock(${deps.sponsorRefillAccountAddress})`,
      deps.refillTimeoutMs,
    );
  }

  async function readSlotBalanceForRefill(address: string, operation: string): Promise<bigint> {
    return withTimeout(operation, deps.confirmationTimeoutMs, () => deps.getSlotBalance(address));
  }

  async function reconcileExistingRefill(address: string, slot: SlotRead | null): Promise<boolean> {
    if (!hasUnresolvedRefill(slot)) return false;
    if (slot === null) return false;
    if (deps.refillTargetMist === null) {
      await writeSlot(address, {
        state: 'refill_failed',
        lastError: normalizeSponsorOperationsLastError(refillTargetNotConfiguredError()),
        ...refillAttemptFields({
          pendingRefillDigest: slot.pendingRefillDigest,
          attemptedAmountMist: slot.refillAttemptedAmountMist,
          observedBalanceMist: slot.refillObservedBalanceMist,
          reconciliationResult: 'dispatch_failed',
        }),
      });
      return true;
    }

    try {
      const balance = await readSlotBalanceForRefill(
        address,
        `refillWorker.reconcileExistingRefill(${address})`,
      );
      if (disposed) return true;
      if (balance >= refillConfirmationThreshold(deps)) {
        await writeSlot(address, {
          state: classifySlotFromBalance(balance, deps.warnThresholdMist),
          balanceMist: balance.toString(),
          lastError: '',
          ...refillAttemptFields({
            pendingRefillDigest: '',
            attemptedAmountMist: slot.refillAttemptedAmountMist,
            observedBalanceMist: balance,
            reconciliationResult: 'confirmed',
          }),
        });
      } else {
        await writeSlot(address, {
          state: 'awaiting_confirmation',
          balanceMist: balance.toString(),
          lastError: '',
          ...refillAttemptFields({
            pendingRefillDigest: slot.pendingRefillDigest,
            attemptedAmountMist: slot.refillAttemptedAmountMist,
            observedBalanceMist: balance,
            reconciliationResult: 'still_pending',
          }),
        });
      }
    } catch (err) {
      if (disposed) return true;
      await writeSlot(address, {
        state: 'awaiting_confirmation',
        lastError: normalizeSponsorOperationsLastError(err),
        ...refillAttemptFields({
          pendingRefillDigest: slot.pendingRefillDigest,
          attemptedAmountMist: slot.refillAttemptedAmountMist,
          observedBalanceMist: slot.refillObservedBalanceMist,
          reconciliationResult: 'still_pending',
        }),
      });
    }
    return true;
  }

  async function confirmRefillAttempt(
    address: string,
    attempt: RefillAttempt,
    digest: string | null,
  ): Promise<void> {
    try {
      const balance = await readSlotBalanceForRefill(
        address,
        `refillWorker.confirmation(${address})`,
      );
      if (disposed) return;
      if (balance >= refillConfirmationThreshold(deps)) {
        await writeSlot(address, {
          state: classifySlotFromBalance(balance, deps.warnThresholdMist),
          balanceMist: balance.toString(),
          lastError: '',
          ...refillAttemptFields({
            pendingRefillDigest: '',
            attemptedAmountMist: attempt.amountMist,
            observedBalanceMist: balance,
            reconciliationResult: 'confirmed',
          }),
        });
      } else {
        await writeSlot(address, {
          state: 'refill_failed',
          balanceMist: balance.toString(),
          lastError: '',
          ...refillAttemptFields({
            pendingRefillDigest: '',
            attemptedAmountMist: attempt.amountMist,
            observedBalanceMist: balance,
            reconciliationResult: 'balance_below_target',
          }),
        });
      }
    } catch (err) {
      if (disposed) return;
      await writeSlot(address, {
        state: 'awaiting_confirmation',
        lastError: normalizeSponsorOperationsLastError(err),
        ...refillAttemptFields({
          pendingRefillDigest: digest,
          attemptedAmountMist: attempt.amountMist,
          observedBalanceMist: attempt.observedBalanceMist,
          reconciliationResult: 'still_pending',
        }),
      });
    }
  }

  async function applyDispatchResult(
    address: string,
    attempt: RefillAttempt,
    result: SponsorOperationsRefillDispatchResult,
  ): Promise<void> {
    if (!result.success) {
      await writeSlot(address, {
        state: 'refill_failed',
        balanceMist: attempt.observedBalanceMist.toString(),
        lastError: normalizeSponsorOperationsLastError(result.error ?? 'refill tx failed'),
        ...refillAttemptFields({
          pendingRefillDigest: '',
          attemptedAmountMist: attempt.amountMist,
          observedBalanceMist: attempt.observedBalanceMist,
          reconciliationResult: 'dispatch_failed',
        }),
      });
      return;
    }

    if (
      !(await writeSlot(address, {
        state: 'awaiting_confirmation',
        balanceMist: attempt.observedBalanceMist.toString(),
        lastError: '',
        ...refillAttemptFields({
          pendingRefillDigest: result.digest,
          attemptedAmountMist: attempt.amountMist,
          observedBalanceMist: attempt.observedBalanceMist,
          reconciliationResult: 'dispatch_submitted',
        }),
      }))
    ) {
      return;
    }
    if (disposed) return;
    await refreshSponsorRefillAccount();
    if (disposed) return;
    await confirmRefillAttempt(address, attempt, result.digest);
  }

  function watchLateDispatch(
    address: string,
    attempt: RefillAttempt,
    resultPromise: Promise<SponsorOperationsRefillDispatchResult>,
  ): void {
    void resultPromise.then(
      async (result) => {
        if (disposed) return;
        await applyDispatchResult(address, attempt, result);
      },
      async (err) => {
        if (disposed) return;
        await writeSlot(address, {
          state: 'refill_failed',
          balanceMist: attempt.observedBalanceMist.toString(),
          lastError: normalizeSponsorOperationsLastError(err),
          ...refillAttemptFields({
            pendingRefillDigest: '',
            attemptedAmountMist: attempt.amountMist,
            observedBalanceMist: attempt.observedBalanceMist,
            reconciliationResult: 'dispatch_failed',
          }),
        });
      },
    );
  }

  async function acquireRefillDispatchLock(
    address: string,
  ): Promise<AcquiredRefillDispatchLock | null> {
    if (disposed) return null;

    const deadlineMs = Date.now() + deps.refillTimeoutMs;
    const handle = await acquireAccountDispatchLock(deadlineMs);
    if (handle === null) return null;

    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      await deps.sponsorRefillAccountDispatchLock.release(handle);
      throw new SponsorOperationsTimeoutError(
        `refillWorker.executeRefill(${address})`,
        deps.refillTimeoutMs,
      );
    }

    return { handle, remainingMs };
  }

  function startRefillDispatchWithAccountLock(
    address: string,
    amountMist: bigint,
    acquired: AcquiredRefillDispatchLock,
  ): ActiveRefillDispatch {
    const resultPromise = (async () => {
      try {
        if (disposed) return { success: false, digest: null, error: 'disposed' };
        return await deps.executeRefill(address, amountMist);
      } finally {
        await deps.sponsorRefillAccountDispatchLock.release(acquired.handle);
      }
    })();

    return { remainingMs: acquired.remainingMs, resultPromise };
  }

  async function runSlotLifecycle(address: string): Promise<void> {
    if (disposed) return;

    const handle = await deps.refillLock.acquire(address);
    if (handle === null) {
      // Another instance is driving this slot. Skip silently; the
      // other instance's completion will propagate via the shared
      // state store.
      return;
    }

    try {
      const previous = await deps.state.readSlot(address);
      if (await reconcileExistingRefill(address, previous)) return;

      if (deps.refillTargetMist === null) {
        await writeSlot(address, {
          state: 'refill_failed',
          lastError: normalizeSponsorOperationsLastError(refillTargetNotConfiguredError()),
          ...clearRefillAttemptFields(),
        });
        return;
      }

      let observedBalanceMist: bigint;
      try {
        observedBalanceMist = await readSlotBalanceForRefill(
          address,
          `refillWorker.observeBalanceBeforeRefill(${address})`,
        );
      } catch (err) {
        await writeSlot(address, {
          state: 'refill_failed',
          lastError: normalizeSponsorOperationsLastError(err),
          ...clearRefillAttemptFields(),
        });
        return;
      }
      if (disposed) return;

      const amountMist = computeRefillAmount(observedBalanceMist, deps.refillTargetMist);
      if (amountMist === 0n) {
        await writeSlot(address, {
          state: classifySlotFromBalance(observedBalanceMist, deps.warnThresholdMist),
          balanceMist: observedBalanceMist.toString(),
          lastError: '',
          ...refillAttemptFields({
            pendingRefillDigest: '',
            attemptedAmountMist: 0n,
            observedBalanceMist,
            reconciliationResult: 'not_needed',
          }),
        });
        return;
      }

      const attempt: RefillAttempt = { observedBalanceMist, amountMist };
      let acquiredDispatchLock: AcquiredRefillDispatchLock | null;
      try {
        acquiredDispatchLock = await acquireRefillDispatchLock(address);
      } catch (err) {
        await writeSlot(address, {
          state: 'refill_failed',
          balanceMist: observedBalanceMist.toString(),
          lastError: normalizeSponsorOperationsLastError(err),
          ...refillAttemptFields({
            pendingRefillDigest: '',
            attemptedAmountMist: amountMist,
            observedBalanceMist,
            reconciliationResult: 'dispatch_failed',
          }),
        });
        return;
      }
      if (acquiredDispatchLock === null) return;
      if (disposed) {
        await deps.sponsorRefillAccountDispatchLock.release(acquiredDispatchLock.handle);
        return;
      }

      if (
        !(await writeSlot(address, {
          state: 'refilling',
          balanceMist: observedBalanceMist.toString(),
          lastError: '',
          ...refillAttemptFields({
            pendingRefillDigest: '',
            attemptedAmountMist: amountMist,
            observedBalanceMist,
            reconciliationResult: 'dispatch_started',
          }),
        }))
      ) {
        await deps.sponsorRefillAccountDispatchLock.release(acquiredDispatchLock.handle);
        return;
      }

      const activeDispatch = startRefillDispatchWithAccountLock(
        address,
        amountMist,
        acquiredDispatchLock,
      );

      try {
        const result = await withTimeout(
          `refillWorker.executeRefill(${address})`,
          activeDispatch.remainingMs,
          () => activeDispatch.resultPromise,
        );
        if (disposed) return;
        await applyDispatchResult(address, attempt, result);
      } catch (err) {
        if (err instanceof SponsorOperationsTimeoutError) {
          watchLateDispatch(address, attempt, activeDispatch.resultPromise);
          await writeSlot(address, {
            state: 'awaiting_confirmation',
            balanceMist: observedBalanceMist.toString(),
            lastError: normalizeSponsorOperationsLastError(err),
            ...refillAttemptFields({
              pendingRefillDigest: '',
              attemptedAmountMist: amountMist,
              observedBalanceMist,
              reconciliationResult: 'dispatch_timeout',
            }),
          });
          return;
        }
        await writeSlot(address, {
          state: 'refill_failed',
          balanceMist: observedBalanceMist.toString(),
          lastError: normalizeSponsorOperationsLastError(err),
          ...refillAttemptFields({
            pendingRefillDigest: '',
            attemptedAmountMist: amountMist,
            observedBalanceMist,
            reconciliationResult: 'dispatch_failed',
          }),
        });
      }
    } finally {
      await deps.refillLock.release(handle);
    }
  }

  function startSlotLifecycle(slotAddress: string): void {
    inFlight.add(slotAddress);
    void runSlotLifecycle(slotAddress).finally(() => {
      inFlight.delete(slotAddress);
    });
  }

  return {
    requestRefill(slotAddress: string): void {
      if (disposed) return;
      if (inFlight.has(slotAddress)) return;
      startSlotLifecycle(slotAddress);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      inFlight.clear();
    },
  };
}
