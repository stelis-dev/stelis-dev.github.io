import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startRealRedis, type RealRedisHandle } from '../../core-api/tests/helpers/realRedis.js';
import { RedisSponsoredLogsStore } from '../src/sponsoredLogs/redisStore.js';
import type { SponsoredExecutionLogEntry } from '../src/sponsoredLogs/types.js';

function knownEntry(
  overrides: Partial<SponsoredExecutionLogEntry> = {},
): SponsoredExecutionLogEntry {
  return {
    createdAt: '2026-07-14T00:00:00.000Z',
    mode: 'generic',
    outcome: 'success',
    receiptId: 'receipt-1',
    digest: '0xdigest',
    senderAddress: '0xsender',
    sponsorAddress: '0xsponsor',
    executionPathKey: 'generic-execution-path',
    orderIdHash: null,
    promotionId: null,
    userId: null,
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
});
