/**
 * [app-api] Sponsor result state updater — slot and sponsor refill account state updater.
 *
 * Implements the host-side of the `core-api`-owned
 * `SponsorResultCallback` contract (see
 * `packages/core-api/src/handlers/sponsorResult.ts`). The callback is
 * invoked from the durable final sponsored-execution receipt. It drives
 * per-action sponsor operations state updates:
 *
 *   1. Bounded `getBalance` probe on the consumed slot, bounded by
 *      `SPONSOR_OPERATIONS_SLOT_BALANCE_TIMEOUT_MS`. Result is written to the
 *      slot observation through the shared state adapter (Redis authors the
 *      ordering fields).
 *   2. When the sponsor refill account address equals `SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS`
 *      and `outcome === 'success'`, run a bounded sponsor refill account
 *      `getBalance` probe and write the sponsor refill account HASH.
 *
 * Delivery succeeds only after the required Redis observations are written.
 * A write failure is logged and rethrown so the durable final receipt remains
 * pending and recovery can retry this idempotent observation callback.
 *
 * Observability contract:
 *   - A failed chain probe with a successful failed-observation write is
 *     **not** an observability event; the current status derived from that
 *     observation is the signal.
 *   - `SPONSOR_OPERATIONS_STATE_WRITE_FAILED` is emitted whenever the shared
 *     Redis state store cannot accept the callback's slot or sponsor refill account update. The
 *     `source` payload field discriminates the concrete site:
 *     `sponsor_result_state_update_slot_update` /
 *     `sponsor_result_state_update_sponsor_refill_account_update`.
 */

import type { SponsorResultCallback, SponsorResultMetadata } from '@stelis/core-api';
import type { SponsorSlotState } from '@stelis/contracts';
import { getSuiBalance, type SuiEndpointSnapshot } from '@stelis/core-relay';
import {
  logStructuredEvent,
  SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
} from '@stelis/core-api/observability';
import type { RedisSponsorOperationsState } from './redisState.js';
import { normalizeSponsorOperationsLastError } from './lastError.js';
import { probeAndWriteSponsorRefillAccountState } from './sponsorRefillAccountProbe.js';
import { withTimeout } from './timeout.js';
import { parseChainBalanceMist } from './balanceParsing.js';
import type { SponsorRefillAccountSpendStateStore } from './accountSpendState.js';
import type { SponsorOperationsSettings } from './settings.js';
import { calculateSponsorOperationsStatus, isActiveSponsorRefillOperationState } from './status.js';

export interface SponsorResultCallbackDeps {
  /** Qualified Sui endpoint snapshot for bounded balance probes. */
  readonly sui: SuiEndpointSnapshot;
  /** Shared Redis state store (write + read). */
  readonly state: RedisSponsorOperationsState;
  /** Account spend sequence used to reject stale Sponsor Refill Account probes. */
  readonly spendState: SponsorRefillAccountSpendStateStore;
  readonly settings: SponsorOperationsSettings;
  /**
   * Optional hook fired after a slot state write resolves (regardless of
   * whether the probe succeeded or the degraded fallback was written).
   * The host wires this to `SponsorOperationsTaskScheduler.requestObservedSlotRefill` so a slot
   * transitioning to `low_balance` immediately enqueues a refill attempt.
   *
   * Must be synchronous and best-effort. The callback invokes it in a
   * try/catch so an optional refill nudge cannot invalidate a durable state
   * observation that was already written.
   */
  readonly onSlotStateChanged?: (slotAddress: string, state: SponsorSlotState) => void;
  /**
   * Best-effort synchronous nudge after a source-account balance is stored.
   * The SponsorOperations scheduler owns and retains the resulting work.
   */
  readonly onSponsorRefillAccountObserved?: () => void;
}

/**
 * Build the host-side post-sponsor result observer. The SponsorOperations
 * scheduler retains this callback before the Host result callback invokes it.
 */
export function createSponsorResultStateUpdater(
  deps: SponsorResultCallbackDeps,
): SponsorResultCallback {
  const sponsorRefillAccountIsSettlementPayoutRecipient =
    deps.settings.sponsorRefillAccountAddress === deps.settings.settlementPayoutRecipientAddress;

  function notifySlotStateChanged(slotAddress: string, state: SponsorSlotState): void {
    if (!deps.onSlotStateChanged) return;
    try {
      deps.onSlotStateChanged(slotAddress, state);
    } catch {
      // Defence-in-depth: the host hook is documented as never-throws,
      // but we still swallow so the sponsor result callback's own contract
      // holds when a hook implementation is buggy.
    }
  }

  function notifySponsorRefillAccountObserved(): void {
    if (!deps.onSponsorRefillAccountObserved) return;
    try {
      deps.onSponsorRefillAccountObserved();
    } catch {
      // The periodic scheduler will re-evaluate eligibility. A best-effort
      // nudge cannot invalidate the required durable balance observation.
    }
  }

  async function probeAndWriteSlot(slotAddress: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const previous = await deps.state.readSlot(slotAddress);
    signal?.throwIfAborted();
    if (isActiveSponsorRefillOperationState(previous?.refillOperationState ?? null)) {
      return;
    }
    const expectedWriteSeq = previous?.writeSeq ?? 0;
    function logSlotWriteFailure(
      writeErr: unknown,
      fields: {
        readonly state: SponsorSlotState;
        readonly probeError?: string;
      },
    ): void {
      logStructuredEvent(
        SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
        {
          source: 'sponsor_result_state_update_slot_update',
          slot_address: slotAddress,
          state: fields.state,
          probe_error: fields.probeError,
          write_error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        },
        'warn',
      );
    }

    let balance: bigint;
    try {
      balance = await withTimeout(
        `sponsorResultStateUpdater.getSlotBalance(${slotAddress})`,
        deps.settings.slotBalanceTimeoutMs,
        async (operationSignal) => {
          const res = await getSuiBalance(deps.sui, {
            owner: slotAddress,
            signal: operationSignal,
          });
          return parseChainBalanceMist(
            res.addressBalance,
            `Sponsor address ${slotAddress} address balance`,
          );
        },
        signal,
      );
    } catch (err) {
      signal?.throwIfAborted();
      const message = err instanceof Error ? err.message : String(err);
      const calculated = calculateSponsorOperationsStatus({
        entity: 'sponsor_slot',
        settings: deps.settings,
        observation: { status: 'failed' },
        refillOperationState: previous?.refillOperationState ?? null,
      });
      try {
        signal?.throwIfAborted();
        const updated = await deps.state.updateSlotIfWriteSeq(slotAddress, expectedWriteSeq, {
          addressBalanceMist: '',
          lastError: normalizeSponsorOperationsLastError(err),
        });
        if (!updated) {
          throw new Error(`Sponsor slot ${slotAddress} changed during result observation`);
        }
      } catch (writeErr) {
        logSlotWriteFailure(writeErr, { state: calculated.state, probeError: message });
        throw writeErr instanceof Error ? writeErr : new Error(String(writeErr));
      }
      signal?.throwIfAborted();
      notifySlotStateChanged(slotAddress, calculated.state);
      return;
    }

    const calculated = calculateSponsorOperationsStatus({
      entity: 'sponsor_slot',
      settings: deps.settings,
      observation: { status: 'succeeded', addressBalanceMist: balance },
      refillOperationState: previous?.refillOperationState ?? null,
    });
    const nextState = calculated.state;
    try {
      signal?.throwIfAborted();
      const updated = await deps.state.updateSlotIfWriteSeq(slotAddress, expectedWriteSeq, {
        addressBalanceMist: balance.toString(),
        lastError: '',
      });
      if (!updated) {
        throw new Error(`Sponsor slot ${slotAddress} changed during result observation`);
      }
    } catch (writeErr) {
      logSlotWriteFailure(writeErr, { state: nextState });
      throw writeErr instanceof Error ? writeErr : new Error(String(writeErr));
    }
    signal?.throwIfAborted();
    notifySlotStateChanged(slotAddress, nextState);
  }

  async function probeAndWriteSponsorRefillAccount(signal?: AbortSignal): Promise<void> {
    const balance = await probeAndWriteSponsorRefillAccountState({
      sui: deps.sui,
      spendState: deps.spendState,
      settings: deps.settings,
      signal,
    });
    if (balance !== null) {
      signal?.throwIfAborted();
      notifySponsorRefillAccountObserved();
    }
  }

  return async function onSponsorResult(
    metadata: SponsorResultMetadata,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await probeAndWriteSlot(metadata.sponsorAddress, signal);
    signal?.throwIfAborted();
    if (sponsorRefillAccountIsSettlementPayoutRecipient && metadata.outcome === 'success') {
      await probeAndWriteSponsorRefillAccount(signal);
    }
  };
}
