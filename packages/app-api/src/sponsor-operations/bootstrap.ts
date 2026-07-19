/**
 * [app-api] Sponsor operations balance observation.
 *
 * The task scheduler runs this before HTTP listen and at every reconciliation
 * interval. It populates the
 * shared Redis state store with a fresh chain observation for every
 * slot and the sponsor refill account. HTTP does not accept requests until this function
 * returns, so gate readers observe populated sponsor operations state.
 *
 * Failure policy:
 *   - Redis write failure on any entity → throws. The calling
 *     the App API context owner translates the rejection into a fail-fast boot.
 *     This matches the existing admin `not_before` Redis initialization pattern.
 *   - Chain RPC failure on any slot or sponsor refill account → the failed
 *     observation is written via the Lua update script and boot continues.
 *     Current status and health are derived when the state is read. The gate will return
 *     `SPONSOR_CAPACITY_UNAVAILABLE` (or `SPONSOR_REFILL_ACCOUNT_UNHEALTHY`)
 *     until a subsequent successful observation is stored.
 *   - An RPC failure's fallback write rejection re-raises the Redis
 *     failure (promoted to fail-fast boot), matching the first bullet.
 */

import { getSuiBalance, type SuiEndpointSnapshot } from '@stelis/core-relay';
import type {
  SponsorRefillAccountWriteFields,
  RedisSponsorOperationsState,
  SlotWriteFields,
} from './redisState.js';
import { normalizeSponsorOperationsLastError } from './lastError.js';
import { withTimeout } from './timeout.js';
import { parseChainBalanceMist } from './balanceParsing.js';
import type { SponsorRefillAccountSpendStateStore } from './accountSpendState.js';
import type { SponsorOperationsSettings } from './settings.js';
import { isActiveSponsorRefillOperationState } from './status.js';

export interface SponsorOperationsBalanceObserverDeps {
  readonly sui: SuiEndpointSnapshot;
  readonly state: RedisSponsorOperationsState;
  readonly settings: SponsorOperationsSettings;
  readonly spendState: SponsorRefillAccountSpendStateStore;
  readonly signal?: AbortSignal;
}

async function syncOneSlot(
  deps: SponsorOperationsBalanceObserverDeps,
  slotAddress: string,
): Promise<void> {
  deps.signal?.throwIfAborted();
  const previous = await deps.state.readSlot(slotAddress);
  if (isActiveSponsorRefillOperationState(previous?.refillOperationState ?? null)) {
    return;
  }
  let fields: SlotWriteFields;
  try {
    const balance = await withTimeout(
      `bootstrap.getSlotBalance(${slotAddress})`,
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
      deps.signal,
    );
    deps.signal?.throwIfAborted();
    fields = {
      addressBalanceMist: balance.toString(),
      lastError: '',
    };
  } catch (err) {
    fields = {
      addressBalanceMist: '',
      lastError: normalizeSponsorOperationsLastError(err),
    };
  }
  deps.signal?.throwIfAborted();
  const updated = await deps.state.updateSlotIfWriteSeq(
    slotAddress,
    previous?.writeSeq ?? 0,
    fields,
  );
  if (!updated) {
    return;
  }
}

async function syncSponsorRefillAccount(deps: SponsorOperationsBalanceObserverDeps): Promise<void> {
  deps.signal?.throwIfAborted();
  const observationCursor = await deps.spendState.readAccountObservationCursor();
  if (isActiveSponsorRefillOperationState(observationCursor.spendState)) {
    return;
  }
  let fields: SponsorRefillAccountWriteFields;
  try {
    const balance = await withTimeout(
      'bootstrap.getSponsorRefillAccountBalance',
      deps.settings.sponsorRefillAccountBalanceTimeoutMs,
      async (operationSignal) => {
        const res = await getSuiBalance(deps.sui, {
          owner: deps.settings.sponsorRefillAccountAddress,
          signal: operationSignal,
        });
        return parseChainBalanceMist(res.balance, 'Sponsor refill account balance');
      },
      deps.signal,
    );
    deps.signal?.throwIfAborted();
    fields = {
      totalBalanceMist: balance.toString(),
      lastError: '',
    };
  } catch (err) {
    fields = {
      totalBalanceMist: '',
      lastError: normalizeSponsorOperationsLastError(err),
    };
  }
  deps.signal?.throwIfAborted();
  const updated = await deps.spendState.updateAccountObservation(observationCursor, fields);
  if (!updated) {
    return;
  }
}

/**
 * Populate the sponsor operations state store for every slot + sponsor refill account.
 * Resolves on success; rejects when any Redis write rejects. Slot and sponsor refill account syncs run
 * in parallel — each is individually bounded by its own timeout.
 */
export async function observeSponsorOperationsBalances(
  deps: SponsorOperationsBalanceObserverDeps,
): Promise<void> {
  await Promise.all([
    Promise.all(deps.settings.sponsorAddresses.map((addr) => syncOneSlot(deps, addr))),
    syncSponsorRefillAccount(deps),
  ]);
}
