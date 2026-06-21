import { describe, it, expect, vi } from 'vitest';
import type { RedisClientLike } from '@stelis/core-api';
import { RedisSponsoredLogsStore } from '../src/sponsoredLogs/redisStore.js';
import type { SponsoredExecutionLogEntry } from '../src/sponsoredLogs/types.js';

function makeKnownEntry(
  overrides: Partial<SponsoredExecutionLogEntry> & {
    receiptId: string;
  },
): SponsoredExecutionLogEntry {
  return {
    schemaVersion: 1,
    createdAt: overrides.createdAt ?? '2026-04-26T16:00:00.000Z',
    mode: overrides.mode ?? 'generic',
    outcome: overrides.outcome ?? 'success',
    receiptId: overrides.receiptId,
    digest: '0xdigest',
    senderAddress: '0xsender',
    sponsorAddress: '0xsponsor',
    slotId: '0xslot',
    executionPathKey: 'rk',
    orderIdHash: null,
    promotionId: null,
    userId: null,
    recoveredGasMist: '12000',
    hostPaidGasMist: '8000',
    hostNetMist: overrides.hostNetMist ?? '5000',
    hostFeeMist: overrides.hostFeeMist ?? '1000',
    protocolFeeMist: overrides.protocolFeeMist ?? '50',
    grossGasMist: '9500',
    storageRebateMist: '1500',
    economicsStatus: 'known',
    failureReason: null,
  };
}

function makeUnknownEntry(receiptId: string): SponsoredExecutionLogEntry {
  return {
    schemaVersion: 1,
    createdAt: '2026-04-26T16:00:00.000Z',
    mode: 'generic',
    outcome: 'success',
    receiptId,
    digest: null,
    senderAddress: null,
    sponsorAddress: null,
    slotId: null,
    executionPathKey: null,
    orderIdHash: null,
    promotionId: null,
    userId: null,
    recoveredGasMist: null,
    hostPaidGasMist: null,
    hostNetMist: null,
    hostFeeMist: null,
    protocolFeeMist: null,
    grossGasMist: null,
    storageRebateMist: null,
    economicsStatus: 'unknown',
    failureReason: 'SPONSOR_EXEC_GAS_USED_MISSING',
  };
}

function makeMockRedis(): {
  client: RedisClientLike;
  evalSpy: ReturnType<typeof vi.fn>;
} {
  const evalSpy = vi.fn().mockResolvedValue(1);
  const client: RedisClientLike = {
    eval: evalSpy,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(0),
    hgetall: vi.fn().mockResolvedValue({}),
    scan: vi.fn().mockResolvedValue([]),
  };
  return { client, evalSpy };
}

describe('RedisSponsoredLogsStore — append script wiring', () => {
  it('passes the four canonical keys to eval (idem, agg-all, agg-mode, recent)', async () => {
    const { client, evalSpy } = makeMockRedis();
    const store = new RedisSponsoredLogsStore(client);
    const entry = makeKnownEntry({ receiptId: 'r1' });
    await store.append(entry);

    expect(evalSpy).toHaveBeenCalledTimes(1);
    const [script, keys, args] = evalSpy.mock.calls[0];
    expect(keys).toHaveLength(4);
    expect(keys[0]).toBe('stelis:sponsored_logs:idem:generic|r1|success');
    expect(keys[1]).toBe('stelis:sponsored_logs:agg:all');
    expect(keys[2]).toBe('stelis:sponsored_logs:agg:generic');
    expect(keys[3]).toBe('stelis:sponsored_logs:recent');
    // ARGV order: entryJson, execDelta, isKnown, netDelta,
    // lossAmountDelta, lossDelta, recentCap.
    expect(args).toHaveLength(7);
    expect(args[1]).toBe('1');
    expect(args[2]).toBe('1'); // known
    expect(args[3]).toBe('5000'); // cumulative host net delta
    expect(args[4]).toBe('0'); // cumulativeLoss delta
    expect(args[5]).toBe('0'); // not a loss
    // Idempotency contract: SET NX without PX so dedup persists for the
    // adapter lifetime (no TTL).
    expect(typeof script).toBe('string');
    expect(script).toMatch(/SET',\s*idempotencyKey,\s*'1',\s*'NX'\)/);
    expect(script).not.toMatch(/'PX'/);
    expect(script).toContain('table.sort');
    expect(script).toContain('createdAt');
  });

  it('marks isKnown=0 and zero deltas for unknown economics', async () => {
    const { client, evalSpy } = makeMockRedis();
    const store = new RedisSponsoredLogsStore(client);
    await store.append(makeUnknownEntry('r-unk'));
    const [, , args] = evalSpy.mock.calls[0];
    expect(args[2]).toBe('0'); // isKnown
    expect(args[3]).toBe('0'); // net delta
    expect(args[4]).toBe('0');
    expect(args[5]).toBe('0');
  });

  it('flags loss when hostNetMist is negative', async () => {
    const { client, evalSpy } = makeMockRedis();
    const store = new RedisSponsoredLogsStore(client);
    await store.append(
      makeKnownEntry({
        receiptId: 'r-loss',
        hostNetMist: '-7000',
      }),
    );
    const [, , args] = evalSpy.mock.calls[0];
    expect(args[3]).toBe('-7000'); // netDelta
    expect(args[4]).toBe('-7000'); // lossAmountDelta
    expect(args[5]).toBe('1'); // lossDelta
  });

  it('serializes the entry as JSON for the recent list', async () => {
    const { client, evalSpy } = makeMockRedis();
    const store = new RedisSponsoredLogsStore(client);
    const entry = makeKnownEntry({ receiptId: 'r-json' });
    await store.append(entry);
    const [, , args] = evalSpy.mock.calls[0];
    const parsed = JSON.parse(args[0]);
    expect(parsed.receiptId).toBe('r-json');
    expect(parsed.economicsStatus).toBe('known');
  });

  it('throws when known entry is missing hostNetMist (and never calls eval)', async () => {
    const { client, evalSpy } = makeMockRedis();
    const store = new RedisSponsoredLogsStore(client);
    const bad: SponsoredExecutionLogEntry = {
      ...makeKnownEntry({ receiptId: 'r-bad' }),
      hostNetMist: null,
    };
    await expect(store.append(bad)).rejects.toThrow(/known economics entry missing/);
    // Validation must run before the Lua script so a rejected append
    // never claims the idempotency key on Redis.
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it('throws on malformed signed-mist string (and never calls eval)', async () => {
    const { client, evalSpy } = makeMockRedis();
    const store = new RedisSponsoredLogsStore(client);
    const bad: SponsoredExecutionLogEntry = {
      ...makeKnownEntry({ receiptId: 'r-bad-str' }),
      hostNetMist: 'abc',
    };
    await expect(store.append(bad)).rejects.toThrow();
    expect(evalSpy).not.toHaveBeenCalled();
  });
});

describe('RedisSponsoredLogsStore — getSummary script wiring', () => {
  it('returns string fields from the four-element script return', async () => {
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce(['10', '12345', '2', '-67890']);
    const store = new RedisSponsoredLogsStore(client);
    const summary = await store.getSummary('all');
    expect(summary).toEqual({
      mode: 'all',
      sponsoredExecutions: '10',
      lossCount: '2',
      cumulativeHostNetMist: '12345',
      cumulativeLossMist: '-67890',
    });
    const [, keys] = evalSpy.mock.calls[0];
    expect(keys[0]).toBe('stelis:sponsored_logs:agg:all');
  });

  it('defaults missing fields to 0', async () => {
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce(['0', '0', '0', '0']);
    const store = new RedisSponsoredLogsStore(client);
    const summary = await store.getSummary('promotion');
    expect(summary.sponsoredExecutions).toBe('0');
    expect(summary.lossCount).toBe('0');
    expect(summary.cumulativeHostNetMist).toBe('0');
    expect(summary.cumulativeLossMist).toBe('0');
  });

  it('throws on unexpected script return shape', async () => {
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce('bad');
    const store = new RedisSponsoredLogsStore(client);
    await expect(store.getSummary('generic')).rejects.toThrow(/unexpected summary/);
  });
});

describe('RedisSponsoredLogsStore — getRecent script wiring', () => {
  it('parses JSON entries newest-first up to limit', async () => {
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce([
      JSON.stringify(makeKnownEntry({ receiptId: 'r1', createdAt: '2026-04-26T15:00:00Z' })),
      JSON.stringify(makeKnownEntry({ receiptId: 'r3', createdAt: '2026-04-26T15:00:02Z' })),
      JSON.stringify(makeKnownEntry({ receiptId: 'r2', createdAt: '2026-04-26T15:00:01Z' })),
    ]);
    const store = new RedisSponsoredLogsStore(client);
    const entries = await store.getRecent('all', 2);
    expect(entries).toHaveLength(2);
    expect(entries[0].receiptId).toBe('r3');
    expect(entries[1].receiptId).toBe('r2');
  });

  it('filters by mode (skips non-matching JSON rows)', async () => {
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce([
      JSON.stringify(
        makeKnownEntry({
          receiptId: 'p-old',
          mode: 'promotion',
          createdAt: '2026-04-26T15:00:01Z',
        }),
      ),
      JSON.stringify(
        makeKnownEntry({ receiptId: 'g1', mode: 'generic', createdAt: '2026-04-26T15:00:03Z' }),
      ),
      JSON.stringify(
        makeKnownEntry({
          receiptId: 'p-new',
          mode: 'promotion',
          createdAt: '2026-04-26T15:00:02Z',
        }),
      ),
    ]);
    const store = new RedisSponsoredLogsStore(client);
    const entries = await store.getRecent('promotion', 5);
    expect(entries.map((e) => e.receiptId)).toEqual(['p-new', 'p-old']);
  });

  it('mode-filter requests the full retained list (no limit*k truncation)', async () => {
    // Lock for the getRecent contract: mode-filter must scan the
    // adapter's full retained list (recentCap) so a matching row past
    // index `limit*5` is never silently hidden.
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce([]);
    const store = new RedisSponsoredLogsStore(client, { recentCap: 200 });
    await store.getRecent('promotion', 10);
    const [, keys, args] = evalSpy.mock.calls[0];
    expect(keys[0]).toBe('stelis:sponsored_logs:recent');
    expect(args[0]).toBe('200');
  });

  it('all-mode requests exactly limit (no over-fetch)', async () => {
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce([]);
    const store = new RedisSponsoredLogsStore(client, { recentCap: 200 });
    await store.getRecent('all', 10);
    const [, , args] = evalSpy.mock.calls[0];
    expect(args[0]).toBe('10');
  });

  it('skips malformed JSON rather than throwing', async () => {
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce([
      '{not valid json',
      JSON.stringify(makeKnownEntry({ receiptId: 'r1' })),
    ]);
    const store = new RedisSponsoredLogsStore(client);
    const entries = await store.getRecent('all', 5);
    expect(entries.map((e) => e.receiptId)).toEqual(['r1']);
  });

  it('skips entries failing shape check', async () => {
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce([
      JSON.stringify({ schemaVersion: 999, mode: 'generic' }),
      JSON.stringify(makeKnownEntry({ receiptId: 'ok' })),
    ]);
    const store = new RedisSponsoredLogsStore(client);
    const entries = await store.getRecent('all', 5);
    expect(entries.map((e) => e.receiptId)).toEqual(['ok']);
  });

  it('limit <= 0 returns empty without calling eval', async () => {
    const { client, evalSpy } = makeMockRedis();
    const store = new RedisSponsoredLogsStore(client);
    expect(await store.getRecent('all', 0)).toEqual([]);
    expect(await store.getRecent('all', -1)).toEqual([]);
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it('throws on unexpected script return shape', async () => {
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce('bad');
    const store = new RedisSponsoredLogsStore(client);
    await expect(store.getRecent('all', 5)).rejects.toThrow(/unexpected lrange/);
  });
});
