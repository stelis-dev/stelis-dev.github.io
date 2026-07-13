/**
 * [app-api] Sponsor operations boot-time state sync.
 *
 * Runs once inside `createContext()`, before HTTP listen. Populates the
 * shared Redis state store with a fresh chain observation for every
 * slot and the sponsor refill account. HTTP does not accept requests until this function
 * returns, so gate readers observe populated sponsor operations state.
 *
 * Failure policy:
 *   - Redis write failure on any entity → throws. The calling
 *     `createContext()` translates the rejection into a fail-fast boot.
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
  SlotWriteFields,
} from './redisState.js';
import { normalizeSponsorOperationsLastError } from './lastError.js';
import { withTimeout } from './timeout.js';
import { parseChainBalanceMist } from './balanceParsing.js';
import type { SponsorRefillAccountSpendStateStore } from './accountSpendState.js';

export interface BootstrapSponsorOperationsDeps {
  readonly sui: SuiGrpcClient;
  readonly state: RedisSponsorOperationsState;
  readonly slotAddresses: readonly string[];
  readonly sponsorRefillAccountAddress: string;
  readonly warnThresholdMist: bigint;
  readonly refillTargetMist: bigint | null;
  readonly slotBalanceTimeoutMs: number;
  readonly sponsorRefillAccountBalanceTimeoutMs: number;
  readonly spendState: SponsorRefillAccountSpendStateStore;
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
  | 'refillOperationId'
  | 'refillOperationSequence'
  | 'refillOperationState'
> {
  return {
    pendingRefillDigest: '',
    refillAttemptedAmountMist: '',
    refillObservedBalanceMist: '',
    refillReconciliationResult: '',
    refillOperationId: '',
    refillOperationSequence: '',
    refillOperationState: '',
  };
}

async function syncOneSlot(
  deps: BootstrapSponsorOperationsDeps,
  slotAddress: string,
): Promise<void> {
  const previous = await deps.state.readSlot(slotAddress);
  if (
    previous?.refillOperationState === 'reserved' ||
    previous?.refillOperationState === 'ready' ||
    previous?.refillOperationState === 'reconciling'
  ) {
    throw new Error(`Sponsor refill ${previous.refillOperationId ?? 'unknown'} was not recovered`);
  }
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
    fields = {
      state: classifySlotState(balance, deps.warnThresholdMist),
      balanceMist: balance.toString(),
      lastError: '',
      ...clearRefillAttemptFields(),
    };
  } catch (err) {
    fields = {
      state: 'rpc_unreachable',
      balanceMist: '',
      lastError: normalizeSponsorOperationsLastError(err),
      ...clearRefillAttemptFields(),
    };
  }
  const updated = await deps.state.updateSlotIfWriteSeq(
    slotAddress,
    previous?.writeSeq ?? 0,
    fields,
  );
  if (!updated) {
    throw new Error(`Sponsor slot ${slotAddress} changed during boot observation`);
  }
}

async function syncSponsorRefillAccount(deps: BootstrapSponsorOperationsDeps): Promise<void> {
  const observationCursor = await deps.spendState.readAccountObservationCursor();
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
  const updated = await deps.spendState.updateAccountObservation(observationCursor, fields);
  if (!updated) {
    throw new Error('Sponsor Refill Account spend changed during boot observation');
  }
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
