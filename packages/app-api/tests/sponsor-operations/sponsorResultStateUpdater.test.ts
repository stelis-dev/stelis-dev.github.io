import { describe, expect, it, vi } from 'vitest';
import type { SponsorResultMetadata } from '@stelis/core-api';
import type { SuiEndpointSnapshot } from '@stelis/core-relay';
import type { SponsorRefillAccountSpendStateStore } from '../../src/sponsor-operations/accountSpendState.js';
import type {
  RedisSponsorOperationsState,
  SlotWriteFields,
  SponsorRefillAccountWriteFields,
  SponsorSlotRecord,
} from '../../src/sponsor-operations/redisState.js';
import { suiEndpointSnapshotFixture } from '../suiEndpointSnapshotFixture.js';
import { createTestSponsorOperationsSettings } from './settingsFixture.js';

const gateway = vi.hoisted(() => ({ getSuiBalance: vi.fn() }));

vi.mock('@stelis/core-relay', async () => {
  const actual = await vi.importActual<typeof import('@stelis/core-relay')>('@stelis/core-relay');
  return { ...actual, getSuiBalance: gateway.getSuiBalance };
});

import { createSponsorResultStateUpdater } from '../../src/sponsor-operations/sponsorResultStateUpdater.js';

const SLOT = `0x${'44'.repeat(32)}`;
const ACCOUNT = `0x${'55'.repeat(32)}`;

function metadata(outcome: SponsorResultMetadata['outcome']): SponsorResultMetadata {
  return {
    sponsorAddress: SLOT,
    outcome,
    executionStage: 'on_chain',
    route: 'generic',
    receiptId: 'receipt-1',
    senderAddress: '0xsender',
    executionPathKey: 'generic-execution-path',
    orderIdHash: null,
    promotionId: null,
    userId: null,
    economics: { economicsStatus: 'unknown', failureReason: null },
  };
}

function stateStubs(options?: {
  staleSlot?: boolean;
  failSlot?: boolean;
  failAccount?: boolean;
  slot?: SponsorSlotRecord;
}) {
  const slotWrites: SlotWriteFields[] = [];
  const accountWrites: SponsorRefillAccountWriteFields[] = [];
  const state = {
    async readSlot() {
      return options?.slot ?? null;
    },
    async updateSlotIfWriteSeq(_address: string, expected: number, fields: SlotWriteFields) {
      expect(expected).toBe(0);
      if (options?.failSlot) throw new Error('slot Redis unavailable');
      if (options?.staleSlot) return false;
      slotWrites.push(fields);
      return true;
    },
  } as unknown as RedisSponsorOperationsState;
  const accountCursor = {
    operationId: 'operation-9',
    spendState: 'succeeded' as const,
    spendSequence: 9,
    writeSequence: 12,
  };
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

const balanceReaders = new WeakMap<
  SuiEndpointSnapshot,
  (owner: string, signal?: AbortSignal) => Promise<string>
>();

gateway.getSuiBalance.mockImplementation(
  async (
    snapshot: SuiEndpointSnapshot,
    input: { readonly owner: string; readonly signal?: AbortSignal },
  ) => {
    const readBalance = balanceReaders.get(snapshot);
    if (!readBalance) throw new Error('Missing balance gateway fixture');
    const balance = await readBalance(input.owner, input.signal);
    return { balance, addressBalance: balance };
  },
);

function sui(
  getBalance: (owner: string, signal?: AbortSignal) => Promise<string>,
): SuiEndpointSnapshot {
  const snapshot = suiEndpointSnapshotFixture();
  balanceReaders.set(snapshot, getBalance);
  return snapshot;
}

function updater(
  stubs: ReturnType<typeof stateStubs>,
  getBalance: (owner: string, signal?: AbortSignal) => Promise<string>,
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
    settings: createTestSponsorOperationsSettings({
      sponsorAddresses: [SLOT],
      sponsorRefillAccountAddress: ACCOUNT,
      settlementPayoutRecipientAddress: options?.payoutRecipient ?? `0x${'66'.repeat(32)}`,
      warnMist: 100n,
      refillTargetMist: 200n,
      runwayTargetMist: 200n,
    }),
    onSlotStateChanged: options?.onSlotStateChanged
      ? (_address, state) => options.onSlotStateChanged!(state)
      : undefined,
    onSponsorRefillAccountObserved: options?.onSponsorRefillAccountObserved,
  });
}

describe('Sponsor result state updater', () => {
  it('skips an observation owned by an active refill for the same slot', async () => {
    const slot: SponsorSlotRecord = {
      address: SLOT,
      state: 'refilling',
      addressBalanceMist: '50',
      lastError: null,
      lastObservedAtMs: 1,
      writeSeq: 2,
      refillOperationId: 'operation-1',
      refillOperationSequence: 1,
      refillOperationState: 'reserved',
      refillRequiredSourceBalanceMist: null,
    };
    const stubs = stateStubs({ slot });
    const getBalance = vi.fn(async () => '99');
    const onState = vi.fn();

    await expect(
      updater(stubs, getBalance, { onSlotStateChanged: onState })(metadata('success')),
    ).resolves.toBeUndefined();
    expect(getBalance).not.toHaveBeenCalled();
    expect(stubs.slotWrites).toEqual([]);
    expect(onState).not.toHaveBeenCalled();
  });

  it('commits a sampled slot observation and notifies only after its CAS succeeds', async () => {
    const stubs = stateStubs();
    const onState = vi.fn();
    await updater(stubs, async () => '99', { onSlotStateChanged: onState })(
      metadata('onchain_revert'),
    );
    expect(stubs.slotWrites).toEqual([{ addressBalanceMist: '99', lastError: '' }]);
    expect(onState).toHaveBeenCalledWith('low_balance');

    const stale = stateStubs({ staleSlot: true });
    const staleNotify = vi.fn();
    await expect(
      updater(stale, async () => '99', { onSlotStateChanged: staleNotify })(
        metadata('onchain_revert'),
      ),
    ).rejects.toThrow('changed during result observation');
    expect(staleNotify).not.toHaveBeenCalled();
  });

  it('uses the same sampled slot CAS for degraded RPC observations', async () => {
    const stubs = stateStubs();
    await updater(stubs, async () => {
      throw new Error('slot RPC unavailable');
    })(metadata('preflight_failure'));
    expect(stubs.slotWrites).toEqual([
      {
        addressBalanceMist: '',
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
    expect(stubs.accountWrites).toEqual([{ totalBalanceMist: '500', lastError: '' }]);
    expect(onObserved).toHaveBeenCalledWith();

    const failed = stateStubs();
    await updater(failed, async () => '500', { payoutRecipient: ACCOUNT })(
      metadata('onchain_revert'),
    );
    expect(failed.accountWrites).toEqual([]);
  });

  it('rejects delivery when a required slot or Sponsor Refill Account write is unavailable', async () => {
    const stubs = stateStubs({ failSlot: true });
    await expect(updater(stubs, async () => '150')(metadata('success'))).rejects.toThrow(
      'slot Redis unavailable',
    );

    const accountFailure = stateStubs({ failAccount: true });
    await expect(
      updater(accountFailure, async (owner) => (owner === ACCOUNT ? '500' : '150'), {
        payoutRecipient: ACCOUNT,
      })(metadata('success')),
    ).rejects.toThrow('account Redis unavailable');
  });

  it('forwards recovery cancellation to an active balance read without storing a degraded result', async () => {
    const stubs = stateStubs();
    const controller = new AbortController();
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const callback = updater(
      stubs,
      (_owner, signal) =>
        new Promise<string>((_resolve, reject) => {
          if (signal === undefined) {
            reject(new Error('Balance read requires the callback signal'));
            return;
          }
          readStarted();
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );

    const delivery = callback(metadata('success'), controller.signal);
    await started;
    controller.abort(new Error('recovery disposed'));

    await expect(delivery).rejects.toThrow('recovery disposed');
    expect(stubs.slotWrites).toEqual([]);
  });

  it('does not enqueue a refill hint when cancellation follows the required state write', async () => {
    const stubs = stateStubs();
    const controller = new AbortController();
    const onState = vi.fn();
    const originalUpdate = stubs.state.updateSlotIfWriteSeq;
    stubs.state.updateSlotIfWriteSeq = vi.fn(
      async (address: string, expected: number, fields: SlotWriteFields) => {
        const updated = await originalUpdate.call(stubs.state, address, expected, fields);
        controller.abort(new DOMException('Recovery disposed', 'AbortError'));
        return updated;
      },
    );

    const delivery = updater(stubs, async () => '99', {
      onSlotStateChanged: onState,
    })(metadata('onchain_revert'), controller.signal);

    await expect(delivery).rejects.toMatchObject({ name: 'AbortError' });
    expect(stubs.slotWrites).toEqual([{ addressBalanceMist: '99', lastError: '' }]);
    expect(onState).not.toHaveBeenCalled();
  });

  it('does not let a best-effort refill hint invalidate stored observations', async () => {
    const stubs = stateStubs();
    const onObserved = vi.fn(() => {
      throw new Error('scheduler nudge unavailable');
    });
    const callback = updater(stubs, async (owner) => (owner === ACCOUNT ? '500' : '150'), {
      payoutRecipient: ACCOUNT,
      onSponsorRefillAccountObserved: onObserved,
    });

    await expect(callback(metadata('success'))).resolves.toBeUndefined();
    expect(stubs.accountWrites).toEqual([{ totalBalanceMist: '500', lastError: '' }]);
    expect(onObserved).toHaveBeenCalledOnce();
  });
});
