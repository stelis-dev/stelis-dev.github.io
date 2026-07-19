import { describe, it, expect, vi } from 'vitest';
import type { RedisClientLike } from '@stelis/core-api';
import { RedisSponsoredLogsStore } from '../src/sponsoredLogs/redisStore.js';
import type { SponsoredExecutionLogEntry } from '../src/sponsoredLogs/types.js';

const DIGEST = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD';
const SENDER = `0x${'1'.repeat(64)}`;
const SPONSOR = `0x${'2'.repeat(64)}`;
const ORDER_ID_HASH = 'a'.repeat(64);
const PROMOTION_ID = '00000000-0000-4000-8000-000000000001';

function canonicalReceiptId(label: string): string {
  return `0x${Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64)}`;
}

function makeKnownEntry(
  overrides: Partial<SponsoredExecutionLogEntry> & {
    receiptId: string;
  },
): SponsoredExecutionLogEntry {
  const mode = overrides.mode ?? 'generic';
  const promotion = mode === 'promotion';
  const requestedNet =
    typeof overrides.hostNetMist === 'string' ? overrides.hostNetMist : undefined;
  const net = requestedNet === undefined ? 5_000n : BigInt(requestedNet);
  return {
    createdAt: overrides.createdAt ?? '2026-04-26T16:00:00.000Z',
    mode,
    outcome: overrides.outcome ?? 'success',
    receiptId: canonicalReceiptId(overrides.receiptId),
    digest: DIGEST,
    senderAddress: SENDER,
    sponsorAddress: SPONSOR,
    executionPathKey: 'rk',
    orderIdHash: promotion ? null : ORDER_ID_HASH,
    promotionId: promotion ? PROMOTION_ID : null,
    userId: promotion ? 'user-1' : null,
    recoveredGasMist: requestedNet === undefined ? '12000' : net >= 0n ? net.toString() : '0',
    hostPaidGasMist: requestedNet === undefined ? '8000' : net < 0n ? (-net).toString() : '0',
    hostNetMist: overrides.hostNetMist ?? '5000',
    hostFeeMist: overrides.hostFeeMist ?? (requestedNet === undefined ? '1000' : '0'),
    protocolFeeMist: overrides.protocolFeeMist ?? '50',
    grossGasMist: '9500',
    storageRebateMist: '1500',
    economicsStatus: 'known',
    failureReason: null,
  };
}

function makeUnknownEntry(receiptId: string): SponsoredExecutionLogEntry {
  return {
    createdAt: '2026-04-26T16:00:00.000Z',
    mode: 'generic',
    outcome: 'internal_error',
    receiptId: canonicalReceiptId(receiptId),
    digest: null,
    senderAddress: SENDER,
    sponsorAddress: SPONSOR,
    executionPathKey: 'rk',
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
    failureReason: 'post_signature_uncertainty: Sui RPC transport was unavailable',
  };
}

function makeMockRedis(): {
  client: RedisClientLike;
  evalSpy: ReturnType<typeof vi.fn>;
} {
  const evalSpy = vi.fn().mockResolvedValue('APPENDED');
  const client: RedisClientLike = {
    eval: evalSpy,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(0),
    hgetall: vi.fn().mockResolvedValue({}),
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
    const [, keys, args] = evalSpy.mock.calls[0];
    expect(keys).toHaveLength(4);
    expect(keys[0]).toBe(`stelis:sponsored_logs:idem:${canonicalReceiptId('r1')}`);
    expect(keys[1]).toBe('stelis:sponsored_logs:agg:all');
    expect(keys[2]).toBe('stelis:sponsored_logs:agg:generic');
    expect(keys[3]).toBe('stelis:sponsored_logs:recent');
    // ARGV order: entryJson, fingerprint, execDelta, isKnown, netDelta,
    // lossAmountDelta, lossDelta, recentCap.
    expect(args).toHaveLength(8);
    expect(args[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(args[2]).toBe('1');
    expect(args[3]).toBe('1'); // known
    expect(args[4]).toBe('5000'); // cumulative host net delta
    expect(args[5]).toBe('0'); // cumulativeLoss delta
    expect(args[6]).toBe('0'); // not a loss
  });

  it('marks isKnown=0 and zero deltas for unknown economics', async () => {
    const { client, evalSpy } = makeMockRedis();
    const store = new RedisSponsoredLogsStore(client);
    await store.append(makeUnknownEntry('r-unk'));
    const [, , args] = evalSpy.mock.calls[0];
    expect(args[3]).toBe('0'); // isKnown
    expect(args[4]).toBe('0');
    expect(args[5]).toBe('0');
    expect(args[6]).toBe('0');
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
    expect(args[4]).toBe('-7000'); // netDelta
    expect(args[5]).toBe('-7000'); // lossAmountDelta
    expect(args[6]).toBe('1'); // lossDelta
  });

  it('serializes the entry as JSON for the recent list', async () => {
    const { client, evalSpy } = makeMockRedis();
    const store = new RedisSponsoredLogsStore(client);
    const entry = makeKnownEntry({ receiptId: 'r-json' });
    await store.append(entry);
    const [, , args] = evalSpy.mock.calls[0];
    const parsed = JSON.parse(args[0]);
    expect(parsed.receiptId).toBe(canonicalReceiptId('r-json'));
    expect(parsed.economicsStatus).toBe('known');
  });

  it('accepts duplicate and rejects conflicting script results', async () => {
    const duplicate = makeMockRedis();
    duplicate.evalSpy.mockResolvedValueOnce('DUPLICATE');
    await expect(
      new RedisSponsoredLogsStore(duplicate.client).append(
        makeKnownEntry({ receiptId: 'r-replay' }),
      ),
    ).resolves.toBeUndefined();

    const conflict = makeMockRedis();
    conflict.evalSpy.mockResolvedValueOnce('CONFLICT');
    await expect(
      new RedisSponsoredLogsStore(conflict.client).append(
        makeKnownEntry({ receiptId: 'r-conflict' }),
      ),
    ).rejects.toThrow(/conflicting result for receiptId/);
  });

  it('rejects an unexpected append script result', async () => {
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce(1);
    await expect(
      new RedisSponsoredLogsStore(client).append(makeKnownEntry({ receiptId: 'r-bad-return' })),
    ).rejects.toThrow(/unexpected append script return/);
  });

  it('throws when known entry is missing hostNetMist (and never calls eval)', async () => {
    const { client, evalSpy } = makeMockRedis();
    const store = new RedisSponsoredLogsStore(client);
    const bad: SponsoredExecutionLogEntry = {
      ...makeKnownEntry({ receiptId: 'r-bad' }),
      hostNetMist: null,
    };
    await expect(store.append(bad)).rejects.toThrow(/hostNetMist/);
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

  it('rejects an internally inconsistent economics row before Redis mutation', async () => {
    const { client, evalSpy } = makeMockRedis();
    const store = new RedisSponsoredLogsStore(client);
    const bad = {
      ...makeKnownEntry({ receiptId: 'r-bad-equation' }),
      hostNetMist: '4999',
    };
    await expect(store.append(bad)).rejects.toThrow(/hostNetMist must equal/);
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

  it('rejects malformed aggregate decimals instead of inventing zero', async () => {
    const malformed = [
      [10, '0', '0', '0'],
      ['01', '0', '0', '0'],
      ['0', 'not-a-decimal', '0', '0'],
      ['0', '0', '-1', '0'],
      ['0', '0', '0', '-0'],
    ];
    for (const result of malformed) {
      const { client, evalSpy } = makeMockRedis();
      evalSpy.mockResolvedValueOnce(result);
      await expect(new RedisSponsoredLogsStore(client).getSummary('all')).rejects.toThrow();
    }
  });
});

describe('RedisSponsoredLogsStore — getRecent script wiring', () => {
  it('preserves the accepted append order up to limit', async () => {
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce([
      JSON.stringify(makeKnownEntry({ receiptId: 'r1', createdAt: '2026-04-26T15:00:00.000Z' })),
      JSON.stringify(makeKnownEntry({ receiptId: 'r3', createdAt: '2026-04-26T15:00:02.000Z' })),
      JSON.stringify(makeKnownEntry({ receiptId: 'r2', createdAt: '2026-04-26T15:00:01.000Z' })),
    ]);
    const store = new RedisSponsoredLogsStore(client);
    const entries = await store.getRecent('all', 2);
    expect(entries).toHaveLength(2);
    expect(entries[0].receiptId).toBe(canonicalReceiptId('r1'));
    expect(entries[1].receiptId).toBe(canonicalReceiptId('r3'));
  });

  it('filters by mode (skips non-matching JSON rows)', async () => {
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce([
      JSON.stringify(
        makeKnownEntry({
          receiptId: 'p-old',
          mode: 'promotion',
          createdAt: '2026-04-26T15:00:01.000Z',
        }),
      ),
      JSON.stringify(
        makeKnownEntry({
          receiptId: 'g1',
          mode: 'generic',
          createdAt: '2026-04-26T15:00:03.000Z',
        }),
      ),
      JSON.stringify(
        makeKnownEntry({
          receiptId: 'p-new',
          mode: 'promotion',
          createdAt: '2026-04-26T15:00:02.000Z',
        }),
      ),
    ]);
    const store = new RedisSponsoredLogsStore(client);
    const entries = await store.getRecent('promotion', 5);
    expect(entries.map((e) => e.receiptId)).toEqual([
      canonicalReceiptId('p-old'),
      canonicalReceiptId('p-new'),
    ]);
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

  it('rejects malformed stored JSON instead of hiding it', async () => {
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce([
      '{not valid json',
      JSON.stringify(makeKnownEntry({ receiptId: 'r1' })),
    ]);
    const store = new RedisSponsoredLogsStore(client);
    await expect(store.getRecent('all', 5)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a stored entry that does not have the current shape', async () => {
    const { client, evalSpy } = makeMockRedis();
    evalSpy.mockResolvedValueOnce([
      JSON.stringify({ ...makeKnownEntry({ receiptId: 'extra-field' }), unexpected: true }),
      JSON.stringify(makeKnownEntry({ receiptId: 'ok' })),
    ]);
    const store = new RedisSponsoredLogsStore(client);
    await expect(store.getRecent('all', 5)).rejects.toThrow(/exact current shape/);
  });

  it('rejects the first current-shape row with invalid field semantics', async () => {
    const { client, evalSpy } = makeMockRedis();
    const valid = makeKnownEntry({ receiptId: 'ok' });
    const { sponsorAddress: _missing, ...missingField } = valid;
    evalSpy.mockResolvedValueOnce([
      JSON.stringify({ ...valid, mode: 'unknown' }),
      JSON.stringify({ ...valid, outcome: 'congestion' }),
      JSON.stringify({ ...valid, hostFeeMist: '01' }),
      JSON.stringify({ ...valid, recoveredGasMist: 12000 }),
      JSON.stringify({ ...valid, recoveredGasMist: '-1' }),
      JSON.stringify({ ...valid, hostPaidGasMist: '-1' }),
      JSON.stringify(missingField),
      JSON.stringify(valid),
    ]);
    const store = new RedisSponsoredLogsStore(client);
    await expect(store.getRecent('all', 10)).rejects.toThrow();
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
