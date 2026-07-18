import { describe, expect, it, vi } from 'vitest';
import type { SuiEndpointSnapshot } from '@stelis/core-relay';

const gateway = vi.hoisted(() => ({ getSuiBalance: vi.fn() }));

vi.mock('@stelis/core-relay', async () => {
  const actual = await vi.importActual<typeof import('@stelis/core-relay')>('@stelis/core-relay');
  return { ...actual, getSuiBalance: gateway.getSuiBalance };
});

import { observeSponsorOperationsBalances } from '../../src/sponsor-operations/bootstrap.js';
import type {
  RedisSponsorOperationsState,
  SponsorRefillAccountWriteFields,
  SponsorSlotRecord,
  SlotWriteFields,
} from '../../src/sponsor-operations/redisState.js';
import type { SponsorRefillAccountSpendStateStore } from '../../src/sponsor-operations/accountSpendState.js';
import { suiEndpointSnapshotFixture } from '../suiEndpointSnapshotFixture.js';
import { createTestSponsorOperationsSettings } from './settingsFixture.js';

const SLOT_A = `0x${'aa'.repeat(32)}`;
const SLOT_B = `0x${'bb'.repeat(32)}`;
const REFILL_ACCOUNT = `0x${'55'.repeat(32)}`;

function slotRecord(
  address: string,
  overrides: Partial<SponsorSlotRecord> = {},
): SponsorSlotRecord {
  return {
    address,
    state: 'healthy',
    addressBalanceMist: '100',
    lastError: null,
    lastObservedAtMs: 1,
    writeSeq: 1,
    refillOperationId: null,
    refillOperationSequence: null,
    refillOperationState: null,
    refillRequiredSourceBalanceMist: null,
    ...overrides,
  };
}

function fixture(initialSlots: readonly SponsorSlotRecord[] = []) {
  const slots = new Map(initialSlots.map((slot) => [slot.address, slot]));
  const slotWrites: Array<{ address: string; fields: SlotWriteFields }> = [];
  const accountWrites: SponsorRefillAccountWriteFields[] = [];
  let failSlotWrite = false;
  let staleSlotWrite = false;
  let staleAccountWrite = false;
  let accountSpendState: 'reserved' | 'ready' | 'reconciling' | 'succeeded' | 'failed' | null =
    null;

  const state: RedisSponsorOperationsState = {
    async updateSlotIfWriteSeq(address, _expectedWriteSequence, fields) {
      if (failSlotWrite) throw new Error('redis write rejected');
      if (staleSlotWrite) return false;
      slotWrites.push({ address, fields });
      return true;
    },
    async readSlot(address) {
      return slots.get(address) ?? null;
    },
    async readSlotAvailability(address) {
      const record = slots.get(address) ?? null;
      return record === null ? null : { ...record, observationFresh: true };
    },
    async readSponsorRefillAccount() {
      return null;
    },
    async readAll() {
      throw new Error('not used');
    },
  };

  const spendState: SponsorRefillAccountSpendStateStore = {
    async read() {
      return null;
    },
    async readWithdrawalReceipt() {
      return null;
    },
    async readAccountObservationCursor() {
      return {
        operationId: accountSpendState === null ? null : 'operation-a',
        spendState: accountSpendState,
        spendSequence: accountSpendState === null ? 0 : 1,
        writeSequence: 0,
      };
    },
    async reserve() {
      throw new Error('not used');
    },
    async markReady() {
      throw new Error('not used');
    },
    async markReconciling() {
      throw new Error('not used');
    },
    async complete() {
      throw new Error('not used');
    },
    async failReserved() {
      throw new Error('not used');
    },
    async updateAccountObservation(_cursor, fields) {
      if (staleAccountWrite) return false;
      accountWrites.push(fields);
      return true;
    },
  };

  return {
    state,
    spendState,
    slotWrites,
    accountWrites,
    failSlotWrites() {
      failSlotWrite = true;
    },
    makeSlotWriteStale() {
      staleSlotWrite = true;
    },
    makeAccountWriteStale() {
      staleAccountWrite = true;
    },
    setAccountSpendState(state: typeof accountSpendState) {
      accountSpendState = state;
    },
  };
}

function settings(sponsorAddresses: readonly string[] = [SLOT_A]) {
  return createTestSponsorOperationsSettings({
    sponsorAddresses,
    sponsorRefillAccountAddress: REFILL_ACCOUNT,
    slotBalanceTimeoutMs: 100,
    sponsorRefillAccountBalanceTimeoutMs: 100,
  });
}

function sui(read: (owner: string) => Promise<string | Error>): SuiEndpointSnapshot {
  const snapshot = suiEndpointSnapshotFixture();
  gateway.getSuiBalance.mockImplementation(
    async (_snapshot: SuiEndpointSnapshot, input: { owner: string }) => {
      const result = await read(input.owner);
      if (result instanceof Error) throw result;
      return { balance: result, addressBalance: result };
    },
  );
  return snapshot;
}

describe('observeSponsorOperationsBalances', () => {
  it('stores only raw slot and refill-account observations', async () => {
    const store = fixture();
    const snapshot = sui(async (owner) => (owner === SLOT_A ? '90' : '500'));

    await observeSponsorOperationsBalances({
      sui: snapshot,
      state: store.state,
      spendState: store.spendState,
      settings: settings(),
    });

    expect(store.slotWrites).toEqual([
      { address: SLOT_A, fields: { addressBalanceMist: '90', lastError: '' } },
    ]);
    expect(store.accountWrites).toEqual([{ totalBalanceMist: '500', lastError: '' }]);
    expect(store.slotWrites[0]?.fields).not.toHaveProperty('state');
    expect(store.accountWrites[0]).not.toHaveProperty('healthy');
  });

  it('records a bounded probe failure as raw error evidence', async () => {
    const store = fixture();
    const snapshot = sui(async (owner) => (owner === SLOT_A ? new Error('slot rpc down') : '500'));

    await observeSponsorOperationsBalances({
      sui: snapshot,
      state: store.state,
      spendState: store.spendState,
      settings: settings(),
    });

    expect(store.slotWrites[0]).toEqual({
      address: SLOT_A,
      fields: { addressBalanceMist: '', lastError: 'slot rpc down' },
    });
  });

  it('skips a slot observation owned by an active refill spend', async () => {
    const store = fixture([
      slotRecord(SLOT_A, {
        state: 'refilling',
        refillOperationId: 'operation-a',
        refillOperationSequence: 3,
        refillOperationState: 'reconciling',
      }),
    ]);

    await observeSponsorOperationsBalances({
      sui: sui(async () => '100'),
      state: store.state,
      spendState: store.spendState,
      settings: settings(),
    });
    expect(store.slotWrites).toEqual([]);
  });

  it('skips the refill-account observation while its spend lifecycle is active', async () => {
    const store = fixture();
    store.setAccountSpendState('ready');

    await observeSponsorOperationsBalances({
      sui: sui(async () => '100'),
      state: store.state,
      spendState: store.spendState,
      settings: settings(),
    });

    expect(store.slotWrites).toHaveLength(1);
    expect(store.accountWrites).toEqual([]);
  });

  it('lets a concurrent owner win either observation CAS without failing the task', async () => {
    const store = fixture();
    store.makeSlotWriteStale();
    store.makeAccountWriteStale();

    await expect(
      observeSponsorOperationsBalances({
        sui: sui(async () => '100'),
        state: store.state,
        spendState: store.spendState,
        settings: settings(),
      }),
    ).resolves.toBeUndefined();
    expect(store.slotWrites).toEqual([]);
    expect(store.accountWrites).toEqual([]);
  });

  it('propagates durable observation write failure', async () => {
    const store = fixture();
    store.failSlotWrites();

    await expect(
      observeSponsorOperationsBalances({
        sui: sui(async () => '100'),
        state: store.state,
        spendState: store.spendState,
        settings: settings(),
      }),
    ).rejects.toThrow('redis write rejected');
  });

  it('observes all configured slots without storing derived status', async () => {
    const store = fixture();
    const snapshot = sui(async (owner) => (owner === REFILL_ACCOUNT ? '500' : '100'));

    await observeSponsorOperationsBalances({
      sui: snapshot,
      state: store.state,
      spendState: store.spendState,
      settings: settings([SLOT_A, SLOT_B]),
    });

    expect(store.slotWrites.map((entry) => entry.address).sort()).toEqual([SLOT_A, SLOT_B]);
    expect(store.slotWrites.every((entry) => !('state' in entry.fields))).toBe(true);
  });
});
