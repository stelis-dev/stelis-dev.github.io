import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SuiEndpointSnapshot } from '@stelis/core-relay';
import type { SponsorRefillAccountSpendStateStore } from '../../src/sponsor-operations/accountSpendState.js';
import type { SponsorRefillAccountWriteFields } from '../../src/sponsor-operations/redisState.js';
import { suiEndpointSnapshotFixture } from '../suiEndpointSnapshotFixture.js';

const gateway = vi.hoisted(() => ({ getSuiBalance: vi.fn() }));

vi.mock('@stelis/core-relay', async () => {
  const actual = await vi.importActual<typeof import('@stelis/core-relay')>('@stelis/core-relay');
  return { ...actual, getSuiBalance: gateway.getSuiBalance };
});

import { probeAndWriteSponsorRefillAccountState } from '../../src/sponsor-operations/sponsorRefillAccountProbe.js';

const ACCOUNT = `0x${'55'.repeat(32)}`;

const balanceResults = new WeakMap<SuiEndpointSnapshot, string | Error>();

gateway.getSuiBalance.mockImplementation(async (snapshot: SuiEndpointSnapshot) => {
  const result = balanceResults.get(snapshot);
  if (result === undefined) throw new Error('Missing balance gateway fixture');
  if (result instanceof Error) throw result;
  return { balance: result };
});

function suiBalance(result: string | Error): SuiEndpointSnapshot {
  const snapshot = suiEndpointSnapshotFixture();
  balanceResults.set(snapshot, result);
  return snapshot;
}

function spendState(options?: {
  cursor?: { operationId: string | null; spendSequence: number; writeSequence: number };
  failWrite?: boolean;
  stale?: boolean;
}) {
  const writes: SponsorRefillAccountWriteFields[] = [];
  const cursor = options?.cursor ?? {
    operationId: 'operation-7',
    spendSequence: 7,
    writeSequence: 11,
  };
  const state = {
    async readAccountObservationCursor() {
      return cursor;
    },
    async updateAccountObservation(
      actualCursor: typeof cursor,
      fields: SponsorRefillAccountWriteFields,
    ) {
      expect(actualCursor).toEqual(cursor);
      if (options?.failWrite) throw new Error('redis rejected observation');
      if (options?.stale) return false;
      writes.push(fields);
      return true;
    },
  } as unknown as SponsorRefillAccountSpendStateStore;
  return { state, writes };
}

describe('Sponsor Refill Account observation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());

  it('writes a sampled healthy balance against the unchanged spend sequence', async () => {
    const stub = spendState();
    const observed = await probeAndWriteSponsorRefillAccountState(
      {
        sui: suiBalance('250'),
        spendState: stub.state,
        sponsorRefillAccountAddress: ACCOUNT,
        refillTargetMist: 100n,
        sponsorRefillAccountBalanceTimeoutMs: 100,
      },
      {
        operation: 'test.probe',
        source: 'admin_sponsor_operations_sponsor_refill_account_update',
        writeFailureMode: 'throw',
      },
    );
    expect(stub.writes).toEqual([
      { balanceMist: '250', healthy: '1', refillsRemaining: '2', lastError: '' },
    ]);
    expect(observed).toBe(250n);
  });

  it('writes a degraded observation for an RPC or balance-shape failure', async () => {
    const stub = spendState();
    await probeAndWriteSponsorRefillAccountState(
      {
        sui: suiBalance(new Error('rpc unavailable')),
        spendState: stub.state,
        sponsorRefillAccountAddress: ACCOUNT,
        refillTargetMist: 100n,
        sponsorRefillAccountBalanceTimeoutMs: 100,
      },
      {
        operation: 'test.probe',
        source: 'admin_sponsor_operations_sponsor_refill_account_update',
        writeFailureMode: 'throw',
      },
    );
    expect(stub.writes).toEqual([
      {
        balanceMist: '',
        healthy: '0',
        refillsRemaining: '',
        lastError: 'rpc unavailable',
      },
    ]);
  });

  it('fails an admin freshness read but silently discards a stale callback sample', async () => {
    const stub = spendState({ stale: true });
    await expect(
      probeAndWriteSponsorRefillAccountState(
        {
          sui: suiBalance('250'),
          spendState: stub.state,
          sponsorRefillAccountAddress: ACCOUNT,
          refillTargetMist: 100n,
          sponsorRefillAccountBalanceTimeoutMs: 100,
        },
        {
          operation: 'test.probe',
          source: 'admin_sponsor_operations_sponsor_refill_account_update',
          writeFailureMode: 'throw',
        },
      ),
    ).rejects.toThrow('Sponsor Refill Account changed during the balance probe');

    await expect(
      probeAndWriteSponsorRefillAccountState(
        {
          sui: suiBalance('250'),
          spendState: stub.state,
          sponsorRefillAccountAddress: ACCOUNT,
          refillTargetMist: 100n,
          sponsorRefillAccountBalanceTimeoutMs: 100,
        },
        {
          operation: 'test.probe',
          source: 'sponsor_result_state_update_sponsor_refill_account_update',
          writeFailureMode: 'swallow',
        },
      ),
    ).resolves.toBeNull();
    expect(stub.writes).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves throw and swallow contracts for actual Redis write failures', async () => {
    const throwing = spendState({ failWrite: true });
    await expect(
      probeAndWriteSponsorRefillAccountState(
        {
          sui: suiBalance('250'),
          spendState: throwing.state,
          sponsorRefillAccountAddress: ACCOUNT,
          refillTargetMist: 100n,
          sponsorRefillAccountBalanceTimeoutMs: 100,
        },
        {
          operation: 'test.probe',
          source: 'admin_sponsor_operations_sponsor_refill_account_update',
          writeFailureMode: 'throw',
        },
      ),
    ).rejects.toThrow('redis rejected observation');

    const swallowing = spendState({ failWrite: true });
    await expect(
      probeAndWriteSponsorRefillAccountState(
        {
          sui: suiBalance('250'),
          spendState: swallowing.state,
          sponsorRefillAccountAddress: ACCOUNT,
          refillTargetMist: 100n,
          sponsorRefillAccountBalanceTimeoutMs: 100,
        },
        {
          operation: 'test.probe',
          source: 'sponsor_result_state_update_sponsor_refill_account_update',
          writeFailureMode: 'swallow',
        },
      ),
    ).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});
