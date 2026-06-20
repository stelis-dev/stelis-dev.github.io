import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { probeAndWriteSponsorRefillAccountState } from '../../src/sponsor-operations/sponsorRefillAccountProbe.js';
import type {
  SponsorRefillAccountWriteFields,
  RedisSponsorOperationsState,
} from '../../src/sponsor-operations/redisState.js';

const SPONSOR_REFILL_ACCOUNT_ADDRESS = '0x' + '55'.repeat(32);
const LONG_MULTIBYTE_ERROR = '한'.repeat(300);
const TRIMMED_MULTIBYTE_ERROR = '한'.repeat(170);

function makeStubSui(impl: (owner: string) => Promise<string | Error>): SuiGrpcClient {
  const stub = {
    async getBalance({ owner }: { owner: string }): Promise<{ balance: { balance: string } }> {
      const result = await impl(owner);
      if (result instanceof Error) throw result;
      return { balance: { balance: result } };
    },
  };
  return stub as unknown as SuiGrpcClient;
}

function makeStubState(): {
  state: RedisSponsorOperationsState;
  sponsorRefillAccountWrites: SponsorRefillAccountWriteFields[];
} {
  const sponsorRefillAccountWrites: SponsorRefillAccountWriteFields[] = [];
  return {
    sponsorRefillAccountWrites,
    state: {
      async updateSlot() {},
      async updateSponsorRefillAccount(fields) {
        sponsorRefillAccountWrites.push(fields);
      },
      async readSlot() {
        return null;
      },
      async readSponsorRefillAccount() {
        return null;
      },
      async readAll() {
        return { slots: [], sponsorRefillAccount: {} as never };
      },
    },
  };
}

describe('probeAndWriteSponsorRefillAccountState', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function findWriteFailedLogs(source?: string): Record<string, unknown>[] {
    return warnSpy.mock.calls
      .map((args: unknown[]) => {
        try {
          return JSON.parse(args[0] as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null &&
          entry['event'] === 'SPONSOR_OPERATIONS_STATE_WRITE_FAILED' &&
          (source === undefined || entry['source'] === source),
      );
  }

  it('writes healthy sponsor-refill-account state and computed refillsRemaining after a successful probe', async () => {
    const stub = makeStubState();

    await probeAndWriteSponsorRefillAccountState(
      {
        sui: makeStubSui(async () => '250'),
        state: stub.state,
        sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
        refillTargetMist: 100n,
        sponsorRefillAccountBalanceTimeoutMs: 500,
      },
      {
        operation: 'test.sponsor_refill_account.success',
        source: 'admin_sponsor_operations_sponsor_refill_account_update',
        writeFailureMode: 'throw',
      },
    );

    expect(stub.sponsorRefillAccountWrites).toEqual([
      {
        balanceMist: '250',
        healthy: '1',
        refillsRemaining: '2',
        lastError: '',
      },
    ]);
    expect(findWriteFailedLogs()).toHaveLength(0);
  });

  it('writes degraded sponsor-refill-account state without emitting when the probe fails but Redis accepts the fallback write', async () => {
    const stub = makeStubState();

    await probeAndWriteSponsorRefillAccountState(
      {
        sui: makeStubSui(async () => new Error('sponsor refill account rpc down')),
        state: stub.state,
        sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
        refillTargetMist: 100n,
        sponsorRefillAccountBalanceTimeoutMs: 500,
      },
      {
        operation: 'test.sponsor_refill_account.probe_failure',
        source: 'admin_sponsor_operations_sponsor_refill_account_update',
        writeFailureMode: 'throw',
      },
    );

    expect(stub.sponsorRefillAccountWrites).toEqual([
      {
        balanceMist: '',
        healthy: '0',
        refillsRemaining: '',
        lastError: 'sponsor refill account rpc down',
      },
    ]);
    expect(findWriteFailedLogs()).toHaveLength(0);
  });

  it('treats non-decimal sponsor-refill-account balances as degraded probe failures', async () => {
    const stub = makeStubState();

    await probeAndWriteSponsorRefillAccountState(
      {
        sui: makeStubSui(async () => '1e6'),
        state: stub.state,
        sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
        refillTargetMist: 100n,
        sponsorRefillAccountBalanceTimeoutMs: 500,
      },
      {
        operation: 'test.sponsor_refill_account.invalid_balance',
        source: 'admin_sponsor_operations_sponsor_refill_account_update',
        writeFailureMode: 'throw',
      },
    );

    expect(stub.sponsorRefillAccountWrites[0]).toMatchObject({
      balanceMist: '',
      healthy: '0',
      refillsRemaining: '',
    });
    expect(stub.sponsorRefillAccountWrites[0].lastError).toContain(
      'must be a non-negative decimal integer string',
    );
  });

  it('trims multibyte sponsor-refill-account lastError payloads to 512 UTF-8 bytes', async () => {
    const stub = makeStubState();

    await probeAndWriteSponsorRefillAccountState(
      {
        sui: makeStubSui(async () => new Error(LONG_MULTIBYTE_ERROR)),
        state: stub.state,
        sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
        refillTargetMist: 100n,
        sponsorRefillAccountBalanceTimeoutMs: 500,
      },
      {
        operation: 'test.sponsor_refill_account.probe_failure_trim',
        source: 'admin_sponsor_operations_sponsor_refill_account_update',
        writeFailureMode: 'throw',
      },
    );

    expect(stub.sponsorRefillAccountWrites[0].lastError).toBe(TRIMMED_MULTIBYTE_ERROR);
    expect(
      new TextEncoder().encode(stub.sponsorRefillAccountWrites[0].lastError ?? '').length,
    ).toBeLessThanOrEqual(512);
  });

  it('emits and resolves when writeFailureMode is swallow', async () => {
    const state: RedisSponsorOperationsState = {
      async updateSlot() {},
      async updateSponsorRefillAccount() {
        throw new Error('sponsor refill account redis rejected');
      },
      async readSlot() {
        return null;
      },
      async readSponsorRefillAccount() {
        return null;
      },
      async readAll() {
        return { slots: [], sponsorRefillAccount: {} as never };
      },
    };

    await expect(
      probeAndWriteSponsorRefillAccountState(
        {
          sui: makeStubSui(async () => '250'),
          state,
          sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
          refillTargetMist: 100n,
          sponsorRefillAccountBalanceTimeoutMs: 500,
        },
        {
          operation: 'test.sponsor_refill_account.write_failure_swallow',
          source: 'refill_worker_sponsor_refill_account_update',
          writeFailureMode: 'swallow',
        },
      ),
    ).resolves.toBeUndefined();

    const logs = findWriteFailedLogs('refill_worker_sponsor_refill_account_update');
    expect(logs).toHaveLength(1);
    expect(logs[0]['sponsor_refill_account_address']).toBe(SPONSOR_REFILL_ACCOUNT_ADDRESS);
    expect(logs[0]['probe_error']).toBeUndefined();
    expect(logs[0]['write_error']).toBe('sponsor refill account redis rejected');
  });

  it('still resolves in swallow mode when the warn log sink throws', async () => {
    const state: RedisSponsorOperationsState = {
      async updateSlot() {},
      async updateSponsorRefillAccount() {
        throw new Error('sponsor refill account redis rejected');
      },
      async readSlot() {
        return null;
      },
      async readSponsorRefillAccount() {
        return null;
      },
      async readAll() {
        return { slots: [], sponsorRefillAccount: {} as never };
      },
    };

    warnSpy.mockRestore();
    let warnCalls = 0;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      warnCalls += 1;
      throw new Error('log sink transient failure');
    });

    await expect(
      probeAndWriteSponsorRefillAccountState(
        {
          sui: makeStubSui(async () => '250'),
          state,
          sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
          refillTargetMist: 100n,
          sponsorRefillAccountBalanceTimeoutMs: 500,
        },
        {
          operation: 'test.sponsor_refill_account.write_failure_swallow_log_sink_throw',
          source: 'admin_withdraw_sponsor_refill_account_update',
          writeFailureMode: 'swallow',
        },
      ),
    ).resolves.toBeUndefined();

    expect(warnCalls).toBe(1);
  });

  it('emits and rethrows when writeFailureMode is throw', async () => {
    const state: RedisSponsorOperationsState = {
      async updateSlot() {},
      async updateSponsorRefillAccount() {
        throw new Error('sponsor refill account redis rejected');
      },
      async readSlot() {
        return null;
      },
      async readSponsorRefillAccount() {
        return null;
      },
      async readAll() {
        return { slots: [], sponsorRefillAccount: {} as never };
      },
    };

    await expect(
      probeAndWriteSponsorRefillAccountState(
        {
          sui: makeStubSui(async () => new Error('sponsor refill account rpc down')),
          state,
          sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
          refillTargetMist: 100n,
          sponsorRefillAccountBalanceTimeoutMs: 500,
        },
        {
          operation: 'test.sponsor_refill_account.write_failure_throw',
          source: 'admin_sponsor_operations_sponsor_refill_account_update',
          writeFailureMode: 'throw',
        },
      ),
    ).rejects.toThrow('sponsor refill account redis rejected');

    const logs = findWriteFailedLogs('admin_sponsor_operations_sponsor_refill_account_update');
    expect(logs).toHaveLength(1);
    expect(logs[0]['sponsor_refill_account_address']).toBe(SPONSOR_REFILL_ACCOUNT_ADDRESS);
    expect(logs[0]['probe_error']).toBe('sponsor refill account rpc down');
    expect(logs[0]['write_error']).toBe('sponsor refill account redis rejected');
  });

  it('rethrows the original write failure in throw mode even when the warn log sink throws', async () => {
    const state: RedisSponsorOperationsState = {
      async updateSlot() {},
      async updateSponsorRefillAccount() {
        throw new Error('sponsor refill account redis rejected');
      },
      async readSlot() {
        return null;
      },
      async readSponsorRefillAccount() {
        return null;
      },
      async readAll() {
        return { slots: [], sponsorRefillAccount: {} as never };
      },
    };

    warnSpy.mockRestore();
    let warnCalls = 0;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      warnCalls += 1;
      throw new Error('log sink transient failure');
    });

    await expect(
      probeAndWriteSponsorRefillAccountState(
        {
          sui: makeStubSui(async () => new Error('sponsor refill account rpc down')),
          state,
          sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
          refillTargetMist: 100n,
          sponsorRefillAccountBalanceTimeoutMs: 500,
        },
        {
          operation: 'test.sponsor_refill_account.write_failure_throw_log_sink_throw',
          source: 'admin_sponsor_operations_sponsor_refill_account_update',
          writeFailureMode: 'throw',
        },
      ),
    ).rejects.toThrow('sponsor refill account redis rejected');

    expect(warnCalls).toBe(1);
  });
});
