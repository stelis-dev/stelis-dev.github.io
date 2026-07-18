import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SuiEndpointSnapshot } from '@stelis/core-relay';
import type { SponsorRefillAccountSpendStateStore } from '../../src/sponsor-operations/accountSpendState.js';
import type { SponsorRefillAccountWriteFields } from '../../src/sponsor-operations/redisState.js';
import { suiEndpointSnapshotFixture } from '../suiEndpointSnapshotFixture.js';
import { createTestSponsorOperationsSettings } from './settingsFixture.js';

const gateway = vi.hoisted(() => ({ getSuiBalance: vi.fn() }));

vi.mock('@stelis/core-relay', async () => {
  const actual = await vi.importActual<typeof import('@stelis/core-relay')>('@stelis/core-relay');
  return { ...actual, getSuiBalance: gateway.getSuiBalance };
});

import { probeAndWriteSponsorRefillAccountState } from '../../src/sponsor-operations/sponsorRefillAccountProbe.js';

const ACCOUNT = `0x${'55'.repeat(32)}`;
const SETTINGS = createTestSponsorOperationsSettings({
  sponsorRefillAccountAddress: ACCOUNT,
  warnMist: 10n,
  refillTargetMist: 100n,
  runwayTargetMist: 100n,
});

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
  cursor?: {
    operationId: string | null;
    spendState: 'reserved' | 'ready' | 'reconciling' | 'succeeded' | 'failed' | null;
    spendSequence: number;
    writeSequence: number;
  };
  failWrite?: boolean;
  stale?: boolean;
}) {
  const writes: SponsorRefillAccountWriteFields[] = [];
  const cursor = options?.cursor ?? {
    operationId: 'operation-7',
    spendState: 'succeeded' as const,
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
    const observed = await probeAndWriteSponsorRefillAccountState({
      sui: suiBalance('250'),
      spendState: stub.state,
      settings: SETTINGS,
    });
    expect(stub.writes).toEqual([{ totalBalanceMist: '250', lastError: '' }]);
    expect(observed).toBe(250n);
  });

  it('does not probe or write while an active spend owns the account observation', async () => {
    const stub = spendState({
      cursor: {
        operationId: 'operation-active',
        spendState: 'ready',
        spendSequence: 2,
        writeSequence: 11,
      },
    });
    const callsBefore = gateway.getSuiBalance.mock.calls.length;
    await expect(
      probeAndWriteSponsorRefillAccountState({
        sui: suiBalance('250'),
        spendState: stub.state,
        settings: SETTINGS,
      }),
    ).resolves.toBeNull();
    expect(gateway.getSuiBalance.mock.calls).toHaveLength(callsBefore);
    expect(stub.writes).toEqual([]);
  });

  it('writes a degraded observation for an RPC or balance-shape failure', async () => {
    const stub = spendState();
    await probeAndWriteSponsorRefillAccountState({
      sui: suiBalance(new Error('rpc unavailable')),
      spendState: stub.state,
      settings: SETTINGS,
    });
    expect(stub.writes).toEqual([
      {
        totalBalanceMist: '',
        lastError: 'rpc unavailable',
      },
    ]);
  });

  it('rejects a stale observation instead of reporting it as delivered', async () => {
    const stub = spendState({ stale: true });
    await expect(
      probeAndWriteSponsorRefillAccountState({
        sui: suiBalance('250'),
        spendState: stub.state,
        settings: SETTINGS,
      }),
    ).rejects.toThrow('Sponsor Refill Account changed during the balance probe');
    expect(stub.writes).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('reports and propagates an actual Redis write failure', async () => {
    const throwing = spendState({ failWrite: true });
    await expect(
      probeAndWriteSponsorRefillAccountState({
        sui: suiBalance('250'),
        spendState: throwing.state,
        settings: SETTINGS,
      }),
    ).rejects.toThrow('redis rejected observation');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('does not turn caller cancellation into a degraded observation', async () => {
    const stub = spendState();
    const controller = new AbortController();
    controller.abort(new Error('scheduler disposed'));

    await expect(
      probeAndWriteSponsorRefillAccountState({
        sui: suiBalance('250'),
        spendState: stub.state,
        settings: SETTINGS,
        signal: controller.signal,
      }),
    ).rejects.toThrow('scheduler disposed');
    expect(stub.writes).toEqual([]);
  });
});
