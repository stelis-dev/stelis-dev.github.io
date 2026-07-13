import { describe, expect, it, vi } from 'vitest';
import type { SponsorResultMetadata } from '@stelis/core-api';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SponsorRefillAccountSpendStateStore } from '../../src/sponsor-operations/accountSpendState.js';
import type {
  RedisSponsorOperationsState,
  SlotWriteFields,
  SponsorRefillAccountWriteFields,
} from '../../src/sponsor-operations/redisState.js';
import { createSponsorResultStateUpdater } from '../../src/sponsor-operations/sponsorResultStateUpdater.js';

const SLOT = '0xslot';
const ACCOUNT = `0x${'55'.repeat(32)}`;

function metadata(outcome: SponsorResultMetadata['outcome']): SponsorResultMetadata {
  return {
    sponsorAddress: SLOT,
    outcome,
    executionStage: 'on_chain',
    route: 'generic',
  };
}

function stateStubs(options?: { staleSlot?: boolean; failSlot?: boolean; failAccount?: boolean }) {
  const slotWrites: SlotWriteFields[] = [];
  const accountWrites: SponsorRefillAccountWriteFields[] = [];
  const state = {
    async readSlot() {
      return null;
    },
    async updateSlotIfWriteSeq(_address: string, expected: number, fields: SlotWriteFields) {
      expect(expected).toBe(0);
      if (options?.failSlot) throw new Error('slot Redis unavailable');
      if (options?.staleSlot) return false;
      slotWrites.push(fields);
      return true;
    },
  } as unknown as RedisSponsorOperationsState;
  const accountCursor = { operationId: 'operation-9', spendSequence: 9, writeSequence: 12 };
  const spendState = {
    async readAccountObservationCursor() {
      return accountCursor;
    },
    async updateAccountObservation(
      cursor: typeof accountCursor,
      fields: SponsorRefillAccountWriteFields,
    ) {
      expect(cursor).toEqual(accountCursor);
      if (options?.failAccount) throw new Error('account Redis unavailable');
      accountWrites.push(fields);
      return true;
    },
  } as unknown as SponsorRefillAccountSpendStateStore;
  return { state, spendState, slotWrites, accountWrites };
}

function sui(getBalance: (owner: string) => Promise<string>): SuiGrpcClient {
  return {
    async getBalance({ owner }: { owner: string }) {
      return { balance: { balance: await getBalance(owner) } };
    },
  } as unknown as SuiGrpcClient;
}

function updater(
  stubs: ReturnType<typeof stateStubs>,
  getBalance: (owner: string) => Promise<string>,
  options?: {
    payoutRecipient?: string;
    onSlotStateChanged?: (state: string) => void;
    onSponsorRefillAccountObserved?: () => void;
  },
) {
  return createSponsorResultStateUpdater({
    sui: sui(getBalance),
    state: stubs.state,
    spendState: stubs.spendState,
    sponsorRefillAccountAddress: ACCOUNT,
    settlementPayoutRecipientAddress: options?.payoutRecipient ?? '0xother',
    slotBalanceTimeoutMs: 100,
    sponsorRefillAccountBalanceTimeoutMs: 100,
    warnThresholdMist: 100n,
    refillTargetMist: 200n,
    onSlotStateChanged: options?.onSlotStateChanged
      ? (_address, state) => options.onSlotStateChanged!(state)
      : undefined,
    onSponsorRefillAccountObserved: options?.onSponsorRefillAccountObserved,
  });
}

describe('Sponsor result state updater', () => {
  it('commits a sampled slot observation and notifies only after its CAS succeeds', async () => {
    const stubs = stateStubs();
    const onState = vi.fn();
    await updater(stubs, async () => '99', { onSlotStateChanged: onState })(
      metadata('onchain_revert'),
    );
    expect(stubs.slotWrites).toEqual([{ state: 'low_balance', balanceMist: '99', lastError: '' }]);
    expect(onState).toHaveBeenCalledWith('low_balance');

    const stale = stateStubs({ staleSlot: true });
    const staleNotify = vi.fn();
    await updater(stale, async () => '99', { onSlotStateChanged: staleNotify })(
      metadata('onchain_revert'),
    );
    expect(staleNotify).not.toHaveBeenCalled();
  });

  it('uses the same sampled slot CAS for degraded RPC observations', async () => {
    const stubs = stateStubs();
    await updater(stubs, async () => {
      throw new Error('slot RPC unavailable');
    })(metadata('preflight_failure'));
    expect(stubs.slotWrites).toEqual([
      {
        state: 'rpc_unreachable',
        balanceMist: '',
        lastError: 'slot RPC unavailable',
      },
    ]);
  });

  it('updates the Sponsor Refill Account only for a successful payout into that account', async () => {
    const stubs = stateStubs();
    const onObserved = vi.fn();
    const callback = updater(stubs, async (owner) => (owner === ACCOUNT ? '500' : '150'), {
      payoutRecipient: ACCOUNT,
      onSponsorRefillAccountObserved: onObserved,
    });
    await callback(metadata('success'));
    expect(stubs.accountWrites).toEqual([
      { balanceMist: '500', healthy: '1', refillsRemaining: '2', lastError: '' },
    ]);
    expect(onObserved).toHaveBeenCalledWith();

    const failed = stateStubs();
    await updater(failed, async () => '500', { payoutRecipient: ACCOUNT })(
      metadata('onchain_revert'),
    );
    expect(failed.accountWrites).toEqual([]);
  });

  it('keeps the sponsor result callback never-throwing when a CAS store is unavailable', async () => {
    const stubs = stateStubs({ failSlot: true });
    await expect(updater(stubs, async () => '150')(metadata('success'))).resolves.toBeUndefined();
  });
});
