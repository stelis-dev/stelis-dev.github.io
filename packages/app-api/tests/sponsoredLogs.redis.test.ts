import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startRealRedis, type RealRedisHandle } from '@stelis/core-api/testing/redis';
import { RedisSponsoredLogsStore } from '../src/sponsoredLogs/redisStore.js';
import type { SponsoredExecutionLogEntry } from '../src/sponsoredLogs/types.js';

function knownEntry(
  overrides: Partial<SponsoredExecutionLogEntry> = {},
): SponsoredExecutionLogEntry {
  const mode = overrides.mode ?? 'generic';
  const promotion = mode === 'promotion';
  return {
    createdAt: '2026-07-14T00:00:00.000Z',
    mode,
    outcome: 'success',
    receiptId: 'receipt-1',
    digest: '0xdigest',
    senderAddress: '0xsender',
    sponsorAddress: '0xsponsor',
    executionPathKey: 'generic-execution-path',
    orderIdHash: promotion ? null : 'order-hash',
    promotionId: promotion ? 'promotion-1' : null,
    userId: promotion ? 'user-1' : null,
    recoveredGasMist: '12000',
    hostPaidGasMist: '8000',
    hostNetMist: '5000',
    hostFeeMist: '1000',
    protocolFeeMist: '50',
    grossGasMist: '9500',
    storageRebateMist: '1500',
    economicsStatus: 'known',
    failureReason: null,
    ...overrides,
  };
}

function unknownEntry(
  overrides: Partial<SponsoredExecutionLogEntry> = {},
): SponsoredExecutionLogEntry {
  return {
    ...knownEntry(overrides),
    digest: null,
    recoveredGasMist: null,
    hostPaidGasMist: null,
    hostNetMist: null,
    hostFeeMist: null,
    protocolFeeMist: null,
    grossGasMist: null,
    storageRebateMist: null,
    economicsStatus: 'unknown',
    failureReason: 'gas evidence unavailable',
  };
}

describe('RedisSponsoredLogsStore — receipt identity', () => {
  let redis: RealRedisHandle | null = null;

  beforeAll(async () => {
    redis = await startRealRedis();
  });
  beforeEach(async () => {
    await redis!.flush();
  });
  afterAll(async () => {
    await redis?.stop();
  });

  it('records an exact result once even when replay time changes', async () => {
    const store = new RedisSponsoredLogsStore(redis!.client);
    const entry = knownEntry();
    await store.append(entry);
    await store.append({ ...entry, createdAt: '2026-07-14T00:00:01.000Z' });

    expect(await store.getSummary('all')).toMatchObject({
      sponsoredExecutions: '1',
      cumulativeHostNetMist: '5000',
      lossCount: '0',
    });
    const recent = await store.getRecent('all', 10);
    expect(recent).toHaveLength(1);
    expect(recent[0].createdAt).toBe('2026-07-14T00:00:00.000Z');
  });

  it('rejects contradictory outcome and economics without changing either projection', async () => {
    const store = new RedisSponsoredLogsStore(redis!.client);
    const entry = knownEntry();
    await store.append(entry);

    await expect(store.append({ ...entry, outcome: 'onchain_revert' })).rejects.toThrow(
      /conflicting result for receiptId receipt-1/,
    );
    await expect(store.append({ ...entry, hostNetMist: '4999' })).rejects.toThrow(
      /conflicting result for receiptId receipt-1/,
    );

    expect(await store.getSummary('all')).toMatchObject({
      sponsoredExecutions: '1',
      cumulativeHostNetMist: '5000',
      lossCount: '0',
    });
    expect(await store.getRecent('all', 10)).toEqual([entry]);
  });

  it('updates all and per-mode aggregates from current economics semantics', async () => {
    const store = new RedisSponsoredLogsStore(redis!.client);
    await store.append(knownEntry({ receiptId: 'generic-gain', hostNetMist: '5000' }));
    await store.append(
      knownEntry({
        receiptId: 'promotion-loss',
        mode: 'promotion',
        outcome: 'onchain_revert',
        hostNetMist: '-7000',
      }),
    );
    await store.append(unknownEntry({ receiptId: 'generic-unknown' }));

    expect(await store.getSummary('all')).toEqual({
      mode: 'all',
      sponsoredExecutions: '3',
      lossCount: '1',
      cumulativeHostNetMist: '-2000',
      cumulativeLossMist: '-7000',
    });
    expect(await store.getSummary('generic')).toEqual({
      mode: 'generic',
      sponsoredExecutions: '2',
      lossCount: '0',
      cumulativeHostNetMist: '5000',
      cumulativeLossMist: '0',
    });
    expect(await store.getSummary('promotion')).toEqual({
      mode: 'promotion',
      sponsoredExecutions: '1',
      lossCount: '1',
      cumulativeHostNetMist: '-7000',
      cumulativeLossMist: '-7000',
    });
    expect((await store.getRecent('promotion', 10)).map((entry) => entry.receiptId)).toEqual([
      'promotion-loss',
    ]);
  });

  it('sorts the retained projection, enforces its cap, and keeps replay identity beyond the cap', async () => {
    const store = new RedisSponsoredLogsStore(redis!.client, { recentCap: 3 });
    const early = knownEntry({
      receiptId: 'early',
      createdAt: '2026-07-14T00:00:00.000Z',
    });
    await store.append(early);
    await store.append(knownEntry({ receiptId: 'latest', createdAt: '2026-07-14T00:00:03.000Z' }));
    await store.append(knownEntry({ receiptId: 'middle', createdAt: '2026-07-14T00:00:02.000Z' }));
    await store.append(knownEntry({ receiptId: 'older', createdAt: '2026-07-14T00:00:01.000Z' }));
    await store.append({ ...early, createdAt: '2099-01-01T00:00:00.000Z' });

    expect((await store.getRecent('all', 10)).map((entry) => entry.receiptId)).toEqual([
      'latest',
      'middle',
      'older',
    ]);
    expect(await store.getSummary('all')).toMatchObject({
      sponsoredExecutions: '4',
      cumulativeHostNetMist: '20000',
    });
  });
});
