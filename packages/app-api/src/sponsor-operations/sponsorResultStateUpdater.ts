/**
 * [app-api] Sponsor result state updater — slot and sponsor refill account state updater.
 *
 * Implements the host-side of the `core-api`-owned
 * `SponsorResultCallback` contract (see
 * `packages/core-api/src/handlers/sponsorResult.ts`). The callback is
 * invoked by sponsor SponsoredExecutionPolicy `Release` hooks after the sponsor
 * runner's `safeSlotCheckin()` boundary. It drives per-action
 * sponsor operations state updates:
 *
 *   1. Bounded `getBalance` probe on the consumed slot, bounded by
 *      `SPONSOR_OPERATIONS_SLOT_BALANCE_TIMEOUT_MS`. Result is written to the
 *      slot HASH via `updateEntityLuaScript` (Redis authors ordering
 *      fields).
 *   2. When the sponsor refill account address equals `SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS`
 *      and `outcome === 'success'`, run a bounded sponsor refill account
 *      `getBalance` probe and write the sponsor refill account HASH.
 *
 * The callback is a never-throws contract: every async step is wrapped
 * in try/catch and rejections are logged via `logStructuredEvent`.
 * Callers (the sponsor SponsoredExecutionPolicy Release hooks) also wrap the call in
 * try/catch as defence-in-depth.
 *
 * Observability contract:
 *   - A failed chain probe with a successful degraded-state fallback
 *     write (the common case — RPC blip, write a single
 *     `rpc_unreachable` / `healthy=0` row) is **not** an observability
 *     event; the degraded state itself is the signal.
 *   - `SPONSOR_OPERATIONS_STATE_WRITE_FAILED` is emitted whenever the shared
 *     Redis state store cannot accept the callback's slot or sponsor refill account update,
 *     or when an unexpected error escapes the outer `try`. The
 *     `source` payload field discriminates the concrete site:
 *     `sponsor_result_state_update_slot_update` /
 *     `sponsor_result_state_update_sponsor_refill_account_update` /
 *     `sponsor_result_state_update_unhandled`.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SponsorResultCallback, SponsorResultMetadata } from '@stelis/core-api';
import type { SponsorSlotState } from '@stelis/contracts';
import {
  logStructuredEvent,
  SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
} from '@stelis/core-api/observability';
import type { RedisSponsorOperationsState } from './redisState.js';
import { normalizeSponsorOperationsLastError } from './lastError.js';
import { probeAndWriteSponsorRefillAccountState } from './sponsorRefillAccountProbe.js';
import { withTimeout } from './timeout.js';
import { SPONSOR_BALANCE_WARN_MIST } from './defaults.js';
import { parseChainBalanceMist } from './balanceParsing.js';
import type { SponsorRefillAccountSpendStateStore } from './accountSpendState.js';

export interface SponsorResultCallbackDeps {
  /** Sui gRPC client for bounded balance probes. */
  readonly sui: SuiGrpcClient;
  /** Shared Redis state store (write + read). */
  readonly state: RedisSponsorOperationsState;
  /** Account spend sequence used to reject stale Sponsor Refill Account probes. */
  readonly spendState: SponsorRefillAccountSpendStateStore;
  /** Sponsor refill account address for bounded sponsor refill account balance probes. */
  readonly sponsorRefillAccountAddress: string;
  /** Settlement payout recipient address. Used to detect sponsor refill account-as-recipient mode. */
  readonly settlementPayoutRecipientAddress: string;
  /**
   * Slot balance probe upper bound (ms). Required — caller must justify
   * per `docs/parameters.md`. No default is supplied here.
   */
  readonly slotBalanceTimeoutMs: number;
  /**
   * Sponsor refill account balance probe upper bound (ms). Required — same contract as
   * `slotBalanceTimeoutMs`.
   */
  readonly sponsorRefillAccountBalanceTimeoutMs: number;
  /**
   * Per-slot warn threshold used to classify probe results into
   * `healthy` vs `low_balance`. Defaults to `SPONSOR_BALANCE_WARN_MIST`.
   */
  readonly warnThresholdMist?: bigint;
  /**
   * Per-slot refill target in MIST. Used to compute
   * `refillsRemaining = floor(sponsorRefillAccountBalance / refillTargetMist)` when present.
   */
  readonly refillTargetMist: bigint | null;
  /**
   * Optional hook fired after a slot state write resolves (regardless of
   * whether the probe succeeded or the degraded fallback was written).
   * The host wires this to `refillWorker.requestRefill` so a slot
   * transitioning to `low_balance` immediately enqueues a refill attempt.
   *
   * Must be synchronous, best-effort, and never throw. The callback
   * invokes it in a try/catch as defence-in-depth.
   */
  readonly onSlotStateChanged?: (slotAddress: string, state: SponsorSlotState) => void;
}

/**
 * Build the host-side post-sponsor result callback. The returned function is the
 * value you pass to `HostRuntimeConfig.onSponsorResult` /
 * `PromotionSponsorContext.onSponsorResult`.
 */
export function createSponsorResultStateUpdater(
  deps: SponsorResultCallbackDeps,
): SponsorResultCallback {
  const warnThresholdMist = deps.warnThresholdMist ?? SPONSOR_BALANCE_WARN_MIST;
  const sponsorRefillAccountIsSettlementPayoutRecipient =
    deps.sponsorRefillAccountAddress === deps.settlementPayoutRecipientAddress;

  function classifySlot(balance: bigint): SponsorSlotState {
    return balance >= warnThresholdMist ? 'healthy' : 'low_balance';
  }

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

  async function probeAndWriteSlot(slotAddress: string): Promise<void> {
    const previous = await deps.state.readSlot(slotAddress);
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
        deps.slotBalanceTimeoutMs,
        async () => {
          const res = await deps.sui.getBalance({ owner: slotAddress });
          return parseChainBalanceMist(res.balance.balance, `Slot ${slotAddress} balance`);
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        const updated = await deps.state.updateSlotIfWriteSeq(slotAddress, expectedWriteSeq, {
          state: 'rpc_unreachable',
          balanceMist: '',
          lastError: normalizeSponsorOperationsLastError(err),
        });
        if (updated) notifySlotStateChanged(slotAddress, 'rpc_unreachable');
      } catch (writeErr) {
        logSlotWriteFailure(writeErr, { state: 'rpc_unreachable', probeError: message });
      }
      return;
    }

    const nextState = classifySlot(balance);
    try {
      const updated = await deps.state.updateSlotIfWriteSeq(slotAddress, expectedWriteSeq, {
        state: nextState,
        balanceMist: balance.toString(),
        lastError: '',
      });
      if (updated) notifySlotStateChanged(slotAddress, nextState);
    } catch (writeErr) {
      logSlotWriteFailure(writeErr, { state: nextState });
    }
  }

  async function probeAndWriteSponsorRefillAccount(): Promise<void> {
    await probeAndWriteSponsorRefillAccountState(
      {
        sui: deps.sui,
        spendState: deps.spendState,
        sponsorRefillAccountAddress: deps.sponsorRefillAccountAddress,
        refillTargetMist: deps.refillTargetMist,
        sponsorRefillAccountBalanceTimeoutMs: deps.sponsorRefillAccountBalanceTimeoutMs,
      },
      {
        operation: 'sponsorResultStateUpdater.getSponsorRefillAccountBalance',
        source: 'sponsor_result_state_update_sponsor_refill_account_update',
        writeFailureMode: 'swallow',
      },
    );
  }

  return async function onSponsorResult(metadata: SponsorResultMetadata): Promise<void> {
    try {
      await probeAndWriteSlot(metadata.sponsorAddress);
      if (sponsorRefillAccountIsSettlementPayoutRecipient && metadata.outcome === 'success') {
        await probeAndWriteSponsorRefillAccount();
      }
    } catch (outerErr) {
      // Defence-in-depth: the two helpers above are expected to catch
      // their own errors. If something still escapes, log + swallow so
      // the never-throws contract holds.
      logStructuredEvent(
        SPONSOR_OPERATIONS_STATE_WRITE_FAILED,
        {
          source: 'sponsor_result_state_update_unhandled',
          sponsor_address: metadata.sponsorAddress,
          outcome: metadata.outcome,
          error: outerErr instanceof Error ? outerErr.message : String(outerErr),
        },
        'warn',
      );
    }
  };
}
