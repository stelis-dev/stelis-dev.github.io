/**
 * [app-api] Sponsor operations boot-time state sync.
 *
 * Runs once inside `initContext()`, before HTTP listen. Populates the
 * shared Redis state store with a fresh chain observation for every
 * slot and the sponsor refill account. HTTP does not accept requests until this function
 * returns, so gate readers observe populated sponsor operations state.
 *
 * Failure policy:
 *   - Redis write failure on any entity → throws. The calling
 *     `initContext()` translates the rejection into a fail-fast boot.
 *     This matches the existing admin `not_before` Redis pattern.
 *   - Chain RPC failure on any slot or sponsor refill account → the degraded state
 *     (`rpc_unreachable` / `healthy=0`) is written via the Lua update
 *     script and boot continues. The gate will then return
 *     `SPONSOR_CAPACITY_UNAVAILABLE` (or `SPONSOR_REFILL_ACCOUNT_UNHEALTHY`)
 *     until a subsequent successful write flips the state back.
 *   - An RPC failure's fallback write rejection re-raises the Redis
 *     failure (promoted to fail-fast boot), matching the first bullet.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SponsorSlotState } from '@stelis/contracts';
import type {
  SponsorRefillAccountWriteFields,
  RedisSponsorOperationsState,
  SlotRead,
  SlotWriteFields,
} from './redisState.js';
import { normalizeSponsorOperationsLastError } from './lastError.js';
import { withTimeout } from './timeout.js';
import { parseChainBalanceMist } from './balanceParsing.js';

export interface BootstrapSponsorOperationsDeps {
  readonly sui: SuiGrpcClient;
  readonly state: RedisSponsorOperationsState;
  readonly slotAddresses: readonly string[];
  readonly sponsorRefillAccountAddress: string;
  readonly warnThresholdMist: bigint;
  readonly refillTargetMist: bigint | null;
  readonly slotBalanceTimeoutMs: number;
  readonly sponsorRefillAccountBalanceTimeoutMs: number;
}

function classifySlotState(balance: bigint, warnThresholdMist: bigint): SponsorSlotState {
  return balance >= warnThresholdMist ? 'healthy' : 'low_balance';
}

function computeRefillsRemaining(balance: bigint, refillTargetMist: bigint | null): string {
  if (refillTargetMist == null || refillTargetMist <= 0n) return '';
  return (balance / refillTargetMist).toString();
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

function refillConfirmationThreshold(
  deps: BootstrapSponsorOperationsDeps,
): bigint {
  return deps.refillTargetMist ?? deps.warnThresholdMist;
}

function reconcileUnresolvedRefillFromBalance(
  deps: BootstrapSponsorOperationsDeps,
  previous: SlotRead,
  balance: bigint,
): SlotWriteFields {
  if (balance >= refillConfirmationThreshold(deps)) {
    return {
      state: classifySlotState(balance, deps.warnThresholdMist),
      balanceMist: balance.toString(),
      lastError: '',
      pendingRefillDigest: '',
      refillAttemptedAmountMist: previous.refillAttemptedAmountMist ?? '',
      refillObservedBalanceMist: balance.toString(),
      refillReconciliationResult: 'confirmed',
    };
  }
  return {
    state: 'awaiting_confirmation',
    balanceMist: balance.toString(),
    lastError: '',
    pendingRefillDigest: previous.pendingRefillDigest ?? '',
    refillAttemptedAmountMist: previous.refillAttemptedAmountMist ?? '',
    refillObservedBalanceMist: balance.toString(),
    refillReconciliationResult: 'still_pending',
  };
}

function preserveUnresolvedRefillAfterProbeFailure(
  previous: SlotRead,
  err: unknown,
): SlotWriteFields {
  return {
    state: 'awaiting_confirmation',
    balanceMist: '',
    lastError: normalizeSponsorOperationsLastError(err),
    pendingRefillDigest: previous.pendingRefillDigest ?? '',
    refillAttemptedAmountMist: previous.refillAttemptedAmountMist ?? '',
    refillObservedBalanceMist: previous.refillObservedBalanceMist ?? '',
    refillReconciliationResult: 'still_pending',
  };
}

async function syncOneSlot(
  deps: BootstrapSponsorOperationsDeps,
  slotAddress: string,
): Promise<void> {
  const previous = await deps.state.readSlot(slotAddress);
  let fields: SlotWriteFields;
  try {
    const balance = await withTimeout(
      `bootstrap.getSlotBalance(${slotAddress})`,
      deps.slotBalanceTimeoutMs,
      async () => {
        const res = await deps.sui.getBalance({ owner: slotAddress });
        return parseChainBalanceMist(res.balance.balance, `Slot ${slotAddress} balance`);
      },
    );
    fields =
      previous !== null && hasUnresolvedRefill(previous)
        ? reconcileUnresolvedRefillFromBalance(deps, previous, balance)
        : {
            state: classifySlotState(balance, deps.warnThresholdMist),
            balanceMist: balance.toString(),
            lastError: '',
            ...clearRefillAttemptFields(),
          };
  } catch (err) {
    fields =
      previous !== null && hasUnresolvedRefill(previous)
        ? preserveUnresolvedRefillAfterProbeFailure(previous, err)
        : {
            state: 'rpc_unreachable',
            balanceMist: '',
            lastError: normalizeSponsorOperationsLastError(err),
            ...clearRefillAttemptFields(),
          };
  }
  // Redis write failure here propagates. `initContext()` converts it
  // to a fail-fast boot, matching the existing `admin:not_before` pattern.
  await deps.state.updateSlot(slotAddress, fields);
}

async function syncSponsorRefillAccount(deps: BootstrapSponsorOperationsDeps): Promise<void> {
  let fields: SponsorRefillAccountWriteFields;
  try {
    const balance = await withTimeout(
      'bootstrap.getSponsorRefillAccountBalance',
      deps.sponsorRefillAccountBalanceTimeoutMs,
      async () => {
        const res = await deps.sui.getBalance({ owner: deps.sponsorRefillAccountAddress });
        return parseChainBalanceMist(res.balance.balance, 'Sponsor refill account balance');
      },
    );
    fields = {
      balanceMist: balance.toString(),
      healthy: '1',
      refillsRemaining: computeRefillsRemaining(balance, deps.refillTargetMist),
      lastError: '',
    };
  } catch (err) {
    fields = {
      balanceMist: '',
      healthy: '0',
      refillsRemaining: '',
      lastError: normalizeSponsorOperationsLastError(err),
    };
  }
  await deps.state.updateSponsorRefillAccount(fields);
}

/**
 * Populate the sponsor operations state store for every slot + sponsor refill account.
 * Resolves on success; rejects when any Redis write rejects. Slot and sponsor refill account syncs run
 * in parallel — each is individually bounded by its own timeout.
 */
export async function bootstrapSponsorOperations(
  deps: BootstrapSponsorOperationsDeps,
): Promise<void> {
  await Promise.all([
    Promise.all(deps.slotAddresses.map((addr) => syncOneSlot(deps, addr))),
    syncSponsorRefillAccount(deps),
  ]);
}
