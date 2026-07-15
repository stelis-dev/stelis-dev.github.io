import { describe, it, expect, vi } from 'vitest';
import type { SuiEndpointSnapshot } from '@stelis/core-relay';

const gateway = vi.hoisted(() => ({ getSuiBalance: vi.fn() }));

vi.mock('@stelis/core-relay', async () => {
  const actual = await vi.importActual<typeof import('@stelis/core-relay')>('@stelis/core-relay');
  return { ...actual, getSuiBalance: gateway.getSuiBalance };
});

import { bootstrapSponsorOperations } from '../../src/sponsor-operations/bootstrap.js';
import type {
  SponsorRefillAccountWriteFields,
  RedisSponsorOperationsState,
  SlotRead,
  SlotWriteFields,
} from '../../src/sponsor-operations/redisState.js';
import { SPONSOR_BALANCE_WARN_MIST } from '../../src/sponsor-operations/defaults.js';
import type { SponsorRefillAccountSpendStateStore } from '../../src/sponsor-operations/accountSpendState.js';
import { suiEndpointSnapshotFixture } from '../suiEndpointSnapshotFixture.js';

function makeStubState(initialSlots: Record<string, SlotRead | null> = {}): {
  state: RedisSponsorOperationsState;
  spendState: SponsorRefillAccountSpendStateStore;
  slotWrites: Array<{ address: string; fields: SlotWriteFields }>;
  sponsorRefillAccountWrites: SponsorRefillAccountWriteFields[];
  failSlot?: boolean;
  failPm?: boolean;
} {
  const slotWrites: Array<{ address: string; fields: SlotWriteFields }> = [];
  const sponsorRefillAccountWrites: SponsorRefillAccountWriteFields[] = [];
  const slots = new Map<string, SlotRead | null>(Object.entries(initialSlots));
  const ref = { slotWrites, sponsorRefillAccountWrites } as ReturnType<typeof makeStubState>;
  ref.state = {
    async updateSlotIfWriteSeq(address, _expectedWriteSeq, fields) {
      if (ref.failSlot) throw new Error('redis write rejected');
      slotWrites.push({ address, fields });
      return true;
    },
    async readSlot(address) {
      return slots.get(address) ?? null;
    },
    async readSponsorRefillAccount() {
      return null;
    },
    async readAll() {
      return { slots: [], sponsorRefillAccount: {} as never };
    },
  };
  ref.spendState = {
    async read() {
      return null;
    },
    async readWithdrawalReceipt() {
      return null;
    },
    async readAccountObservationCursor() {
      return { operationId: null, spendSequence: 0, writeSequence: 0 };
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
      if (ref.failPm) throw new Error('redis write rejected');
      sponsorRefillAccountWrites.push(fields);
      return true;
    },
  };
  return ref;
}

const balanceReaders = new WeakMap<
  SuiEndpointSnapshot,
  (owner: string) => Promise<string | Error>
>();

gateway.getSuiBalance.mockImplementation(
  async (snapshot: SuiEndpointSnapshot, input: { readonly owner: string }) => {
    const readBalance = balanceReaders.get(snapshot);
    if (!readBalance) throw new Error('Missing balance gateway fixture');
    const result = await readBalance(input.owner);
    if (result instanceof Error) throw result;
    return { balance: result };
  },
);

function makeStubSui(impl: (owner: string) => Promise<string | Error>): SuiEndpointSnapshot {
  const snapshot = suiEndpointSnapshotFixture();
  balanceReaders.set(snapshot, impl);
  return snapshot;
}

function makeSlotRead(
  state: SlotRead['state'],
  fields: Partial<Omit<SlotRead, 'address' | 'state'>> = {},
): SlotRead {
  return {
    address: SLOT_A,
    state,
    balanceMist: fields.balanceMist ?? null,
    lastError: fields.lastError ?? null,
    lastObservedAtMs: fields.lastObservedAtMs ?? null,
    writeSeq: fields.writeSeq ?? null,
    pendingRefillDigest: fields.pendingRefillDigest ?? null,
    refillAttemptedAmountMist: fields.refillAttemptedAmountMist ?? null,
    refillObservedBalanceMist: fields.refillObservedBalanceMist ?? null,
    refillReconciliationResult: fields.refillReconciliationResult ?? null,
    refillOperationId: fields.refillOperationId ?? null,
    refillOperationSequence: fields.refillOperationSequence ?? null,
    refillOperationState: fields.refillOperationState ?? null,
    refillRequiredSourceBalanceMist: fields.refillRequiredSourceBalanceMist ?? null,
  };
}

const SLOT_A = '0xslota';
const SLOT_B = '0xslotb';
const SPONSOR_REFILL_ACCOUNT_ADDRESS = '0x' + '55'.repeat(32);
const LONG_MULTIBYTE_ERROR = '한'.repeat(300);
const TRIMMED_MULTIBYTE_ERROR = '한'.repeat(170);

describe('bootstrapSponsorOperations', () => {
  it('writes healthy slot state when chain balance is above warn threshold', async () => {
    const stub = makeStubState();
    await bootstrapSponsorOperations({
      sui: makeStubSui(async () => SPONSOR_BALANCE_WARN_MIST.toString()),
      state: stub.state,
      spendState: stub.spendState,
      slotAddresses: [SLOT_A],
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
    });
    expect(stub.slotWrites).toHaveLength(1);
    expect(stub.slotWrites[0].fields).toEqual({
      state: 'healthy',
      balanceMist: SPONSOR_BALANCE_WARN_MIST.toString(),
      lastError: '',
      pendingRefillDigest: '',
      refillAttemptedAmountMist: '',
      refillObservedBalanceMist: '',
      refillReconciliationResult: '',
      refillOperationId: '',
      refillOperationSequence: '',
      refillOperationState: '',
    });
  });

  it('writes low_balance when balance is below warn threshold', async () => {
    const stub = makeStubState();
    await bootstrapSponsorOperations({
      sui: makeStubSui(async () => (SPONSOR_BALANCE_WARN_MIST - 1n).toString()),
      state: stub.state,
      spendState: stub.spendState,
      slotAddresses: [SLOT_A],
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
    });
    expect(stub.slotWrites[0].fields.state).toBe('low_balance');
  });

  it('does not overwrite a runway eligibility threshold while a boot observation remains low', async () => {
    const stub = makeStubState({
      [SLOT_A]: makeSlotRead('refill_failed', {
        writeSeq: 4,
        refillRequiredSourceBalanceMist: '237',
      }),
    });
    await bootstrapSponsorOperations({
      sui: makeStubSui(async () => '0'),
      state: stub.state,
      spendState: stub.spendState,
      slotAddresses: [SLOT_A],
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 100n,
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
    });

    expect(stub.slotWrites[0].fields.state).toBe('low_balance');
    expect(stub.slotWrites[0].fields).not.toHaveProperty('refillRequiredSourceBalanceMist');
  });

  it('writes rpc_unreachable + lastError when a slot probe rejects', async () => {
    const stub = makeStubState();
    await bootstrapSponsorOperations({
      sui: makeStubSui(async (owner) => {
        if (owner === SLOT_A) return new Error('slot rpc down');
        return '10000000000';
      }),
      state: stub.state,
      spendState: stub.spendState,
      slotAddresses: [SLOT_A],
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
    });
    expect(stub.slotWrites[0].fields).toEqual({
      state: 'rpc_unreachable',
      balanceMist: '',
      lastError: 'slot rpc down',
      pendingRefillDigest: '',
      refillAttemptedAmountMist: '',
      refillObservedBalanceMist: '',
      refillReconciliationResult: '',
      refillOperationId: '',
      refillOperationSequence: '',
      refillOperationState: '',
    });
  });

  it('treats non-decimal slot balances as degraded probe failures', async () => {
    const stub = makeStubState();
    await bootstrapSponsorOperations({
      sui: makeStubSui(async (owner) => {
        if (owner === SLOT_A) return '0x10';
        return '10000000000';
      }),
      state: stub.state,
      spendState: stub.spendState,
      slotAddresses: [SLOT_A],
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
    });
    expect(stub.slotWrites[0].fields.state).toBe('rpc_unreachable');
    expect(stub.slotWrites[0].fields.balanceMist).toBe('');
    expect(stub.slotWrites[0].fields.lastError).toContain(
      'must be a non-negative decimal integer string',
    );
  });

  it('trims multibyte slot lastError payloads to 512 UTF-8 bytes', async () => {
    const stub = makeStubState();
    await bootstrapSponsorOperations({
      sui: makeStubSui(async (owner) => {
        if (owner === SLOT_A) return new Error(LONG_MULTIBYTE_ERROR);
        return '10000000000';
      }),
      state: stub.state,
      spendState: stub.spendState,
      slotAddresses: [SLOT_A],
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
    });

    expect(stub.slotWrites[0].fields.lastError).toBe(TRIMMED_MULTIBYTE_ERROR);
    expect(
      new TextEncoder().encode(stub.slotWrites[0].fields.lastError ?? '').length,
    ).toBeLessThanOrEqual(512);
  });

  it('writes sponsor-refill-account healthy=0 with lastError when the sponsor-refill-account probe rejects', async () => {
    const stub = makeStubState();
    await bootstrapSponsorOperations({
      sui: makeStubSui(async (owner) => {
        if (owner === SPONSOR_REFILL_ACCOUNT_ADDRESS)
          return new Error('sponsor refill account rpc down');
        return '10000000000';
      }),
      state: stub.state,
      spendState: stub.spendState,
      slotAddresses: [SLOT_A],
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: null,
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
    });
    expect(stub.sponsorRefillAccountWrites[0]).toEqual({
      balanceMist: '',
      healthy: '0',
      refillsRemaining: '',
      lastError: 'sponsor refill account rpc down',
    });
  });

  it('computes refillsRemaining when refillTargetMist is set', async () => {
    const stub = makeStubState();
    await bootstrapSponsorOperations({
      sui: makeStubSui(async () => '30000000000'),
      state: stub.state,
      spendState: stub.spendState,
      slotAddresses: [SLOT_A],
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
    });
    expect(stub.sponsorRefillAccountWrites[0].refillsRemaining).toBe('3');
  });

  it('refuses to overwrite a refill that the account coordinator has not reconciled', async () => {
    const stub = makeStubState({
      [SLOT_A]: makeSlotRead('refilling', {
        pendingRefillDigest: '0xpending',
        refillAttemptedAmountMist: '6000000000',
        refillObservedBalanceMist: '4000000000',
        refillReconciliationResult: 'dispatch_submitted',
        refillOperationId: 'operation-a',
        refillOperationSequence: 3,
        refillOperationState: 'reconciling',
      }),
    });
    await expect(
      bootstrapSponsorOperations({
        sui: makeStubSui(async () => '10000000000'),
        state: stub.state,
        spendState: stub.spendState,
        slotAddresses: [SLOT_A],
        sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
        warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
        refillTargetMist: 10_000_000_000n,
        slotBalanceTimeoutMs: 500,
        sponsorRefillAccountBalanceTimeoutMs: 500,
      }),
    ).rejects.toThrow('was not recovered');
    expect(stub.slotWrites).toEqual([]);
  });

  it('propagates Redis-write failure and fails boot', async () => {
    const stub = makeStubState();
    stub.failSlot = true;
    await expect(
      bootstrapSponsorOperations({
        sui: makeStubSui(async () => '1000000'),
        state: stub.state,
        spendState: stub.spendState,
        slotAddresses: [SLOT_A],
        sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
        warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
        refillTargetMist: null,
        slotBalanceTimeoutMs: 500,
        sponsorRefillAccountBalanceTimeoutMs: 500,
      }),
    ).rejects.toThrow(/redis write rejected/);
  });

  it('syncs multiple slots in parallel', async () => {
    const stub = makeStubState();
    await bootstrapSponsorOperations({
      sui: makeStubSui(async (owner) => {
        if (owner === SLOT_A) return SPONSOR_BALANCE_WARN_MIST.toString();
        if (owner === SLOT_B) return '1000000';
        return '20000000000';
      }),
      state: stub.state,
      spendState: stub.spendState,
      slotAddresses: [SLOT_A, SLOT_B],
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      warnThresholdMist: SPONSOR_BALANCE_WARN_MIST,
      refillTargetMist: 10_000_000_000n,
      slotBalanceTimeoutMs: 500,
      sponsorRefillAccountBalanceTimeoutMs: 500,
    });
    expect(stub.slotWrites).toHaveLength(2);
    const a = stub.slotWrites.find((s) => s.address === SLOT_A)!;
    const b = stub.slotWrites.find((s) => s.address === SLOT_B)!;
    expect(a.fields.state).toBe('healthy');
    expect(b.fields.state).toBe('low_balance');
    expect(stub.sponsorRefillAccountWrites).toHaveLength(1);
    expect(stub.sponsorRefillAccountWrites[0].healthy).toBe('1');
    expect(stub.sponsorRefillAccountWrites[0].refillsRemaining).toBe('2');
  });
});
