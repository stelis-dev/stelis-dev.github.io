/**
 * Local refill trigger queue.
 *
 * Transaction identity, cross-instance serialization, durable recovery, and
 * slot/account reconciliation are owned by the shared Sponsor Refill Account
 * spend coordinator. This worker only coalesces duplicate local triggers.
 */
import {
  logStructuredEvent,
  SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
} from '@stelis/core-api/observability';
import {
  isAutomaticSponsorRefillEligible,
  type SponsorRefillAccountRefillReason,
  type SponsorRefillAccountSpendCoordinator,
} from './accountSpend.js';
import type { RedisSponsorOperationsState } from './redisState.js';
import { normalizeSponsorOperationsLastError } from './lastError.js';

export interface SponsorOperationsRefillWorkerDeps {
  readonly state: Pick<
    RedisSponsorOperationsState,
    'readAll' | 'readSlot' | 'updateSlotIfWriteSeq'
  >;
  readonly spendCoordinator: SponsorRefillAccountSpendCoordinator;
  readonly retryDelayMs: number;
}

export interface SponsorOperationsRefillWorker {
  /** Explicit operator request. Durable recovery remains coordinator-owned. */
  requestRefill(slotAddress: string): void;
  /** Automatic hint from a freshly stored low slot observation. */
  requestObservedSlotRefill(slotAddress: string): void;
  /** Re-evaluate slots after a stored Sponsor Refill Account observation. */
  requestEligibleRefills(): Promise<void>;
  dispose(): void;
}

type RefillTrigger = { readonly reason: SponsorRefillAccountRefillReason };

const REFILL_TRIGGER_PRIORITY: Readonly<Record<SponsorRefillAccountRefillReason, number>> = {
  slot_observed: 0,
  source_observed: 1,
  retry: 2,
  explicit: 3,
};

function mergeTrigger(current: RefillTrigger | undefined, incoming: RefillTrigger): RefillTrigger {
  if (current === undefined) return incoming;
  // Each higher-priority reason admits every current-state case admitted by
  // the reasons below it. Coalescing therefore preserves, but never invents,
  // execution authority.
  return REFILL_TRIGGER_PRIORITY[incoming.reason] > REFILL_TRIGGER_PRIORITY[current.reason]
    ? incoming
    : current;
}

export function createSponsorOperationsRefillWorker(
  deps: SponsorOperationsRefillWorkerDeps,
): SponsorOperationsRefillWorker {
  if (!Number.isSafeInteger(deps.retryDelayMs) || deps.retryDelayMs <= 0) {
    throw new Error('createSponsorOperationsRefillWorker: retryDelayMs must be positive');
  }

  let disposed = false;
  const inFlight = new Set<string>();
  const pendingTriggers = new Map<string, RefillTrigger>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleRetry(slotAddress: string, trigger: RefillTrigger): void {
    if (disposed || retryTimers.has(slotAddress)) return;
    const timer = setTimeout(() => {
      retryTimers.delete(slotAddress);
      enqueue(slotAddress, trigger);
    }, deps.retryDelayMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    retryTimers.set(slotAddress, timer);
  }

  async function run(slotAddress: string, trigger: RefillTrigger): Promise<void> {
    let before: Awaited<ReturnType<RedisSponsorOperationsState['readSlot']>> = null;
    try {
      before = await deps.state.readSlot(slotAddress);
      const result = await deps.spendCoordinator.refill(slotAddress, trigger.reason);
      if (result.status === 'pending' || result.status === 'busy') {
        scheduleRetry(slotAddress, trigger);
        return;
      }
      if (result.status === 'runway_blocked') {
        // The slot projection now carries the exact source-balance threshold
        // observed from the signed candidate. Time alone cannot satisfy it;
        // a later Sponsor Refill Account balance observation re-enqueues the slot.
        return;
      }
      if (result.status === 'not_eligible') return;
      const after = await deps.state.readSlot(slotAddress);
      if (after?.state === 'low_balance' || after?.state === 'rpc_unreachable') {
        scheduleRetry(slotAddress, { reason: 'retry' });
      }
    } catch (error) {
      scheduleRetry(slotAddress, { reason: 'retry' });
      if (before?.writeSeq === null || before?.writeSeq === undefined) return;
      try {
        await deps.state.updateSlotIfWriteSeq(slotAddress, before.writeSeq, {
          lastError: normalizeSponsorOperationsLastError(error),
        });
      } catch (writeError) {
        try {
          logStructuredEvent(
            SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
            {
              source: 'refill_worker_slot_update',
              slot_address: slotAddress,
              state: before.state ?? 'unknown',
              write_error: normalizeSponsorOperationsLastError(writeError),
            },
            'warn',
          );
        } catch {
          // An observability sink failure must not cancel the durable retry.
        }
      }
    }
  }

  function enqueue(slotAddress: string, trigger: RefillTrigger): void {
    if (disposed) return;
    if (inFlight.has(slotAddress)) {
      pendingTriggers.set(slotAddress, mergeTrigger(pendingTriggers.get(slotAddress), trigger));
      return;
    }
    const retryTimer = retryTimers.get(slotAddress);
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimers.delete(slotAddress);
    }
    inFlight.add(slotAddress);
    void run(slotAddress, trigger).finally(() => {
      inFlight.delete(slotAddress);
      const pending = pendingTriggers.get(slotAddress);
      pendingTriggers.delete(slotAddress);
      if (pending === undefined || disposed) return;
      enqueue(slotAddress, pending);
    });
  }

  return {
    requestRefill(slotAddress): void {
      enqueue(slotAddress, { reason: 'explicit' });
    },
    requestObservedSlotRefill(slotAddress): void {
      enqueue(slotAddress, { reason: 'slot_observed' });
    },
    async requestEligibleRefills(): Promise<void> {
      if (disposed) return;
      const { slots, sponsorRefillAccount } = await deps.state.readAll();
      for (const slot of slots) {
        if (!isAutomaticSponsorRefillEligible(slot, sponsorRefillAccount, 'source_observed')) {
          continue;
        }
        enqueue(slot.address, { reason: 'source_observed' });
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      pendingTriggers.clear();
      inFlight.clear();
    },
  };
}
