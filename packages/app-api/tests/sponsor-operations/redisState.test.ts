import { describe, it, expect, beforeEach } from 'vitest';
import type { RedisClientLike, RedisSetOptions } from '@stelis/core-api';
import {
  createRedisSponsorOperationsState,
  slotKey,
  SPONSOR_REFILL_ACCOUNT_KEY,
  READ_ALL_LUA,
  UPDATE_ENTITY_LUA,
} from '../../src/sponsor-operations/redisState.js';

// ─────────────────────────────────────────────
// Minimal inline RedisClientLike stub — supports the subset of commands
// needed by `redisState`: the `updateEntityLuaScript` eval path and
// `hgetall`. Keeps tests independent of core-api's FakeRedisClient.
// ─────────────────────────────────────────────

class StubRedis implements RedisClientLike {
  readonly hashes = new Map<string, Map<string, string>>();
  private clock = 1_700_000_000_000;
  hgetallCalls = 0;
  readAllEvalCalls = 0;

  // Expose for tests to verify monotonic ordering.
  nextClock(): string {
    this.clock += 1;
    return String(this.clock);
  }

  private getHash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map<string, string>();
      this.hashes.set(key, h);
    }
    return h;
  }

  async get(_key: string): Promise<string | null> {
    return null;
  }
  async set(_k: string, _v: string, _o?: RedisSetOptions): Promise<'OK' | null> {
    return 'OK';
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.hashes.delete(k)) n += 1;
    }
    return n;
  }
  async incr(_k: string): Promise<number> {
    return 0;
  }
  async pexpire(_k: string, _t: number): Promise<boolean> {
    return true;
  }
  async scan(_p: string): Promise<string[]> {
    return [];
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.hgetallCalls += 1;
    const h = this.hashes.get(key);
    if (!h) return {};
    const out: Record<string, string> = {};
    for (const [f, v] of h.entries()) out[f] = v;
    return out;
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    if (script === READ_ALL_LUA) {
      this.readAllEvalCalls += 1;
      const slotRows = args.map((address, i) => {
        const h = this.hashes.get(keys[i] ?? '');
        const get = (field: string) => h?.get(field) ?? '';
        return [
          address,
          get('state'),
          get('balanceMist'),
          get('lastError'),
          get('lastObservedAtMs'),
          get('writeSeq'),
          get('pendingRefillDigest'),
          get('refillAttemptedAmountMist'),
          get('refillObservedBalanceMist'),
          get('refillReconciliationResult'),
        ];
      });
      const sponsorRefillAccountHash = this.hashes.get(keys[keys.length - 1] ?? '');
      const getSponsorField = (field: string) => sponsorRefillAccountHash?.get(field) ?? '';
      return [
        slotRows,
        [
          getSponsorField('balanceMist'),
          getSponsorField('healthy'),
          getSponsorField('refillsRemaining'),
          getSponsorField('lastError'),
          getSponsorField('lastObservedAtMs'),
          getSponsorField('writeSeq'),
        ],
      ];
    }

    if (
      script.includes("redis.call('TIME')") &&
      script.includes('HINCRBY') &&
      script.includes('writeSeq')
    ) {
      const key = keys[0];
      const h = this.getHash(key);
      const nowMs = this.nextClock();
      const nextSeq = (Number(h.get('writeSeq') ?? '0') + 1).toString();
      h.set('writeSeq', nextSeq);
      h.set('lastObservedAtMs', nowMs);
      for (let i = 0; i < args.length; i += 2) {
        const f = args[i];
        const v = args[i + 1];
        if (f !== undefined && v !== undefined) h.set(f, v);
      }
      return [nowMs, nextSeq];
    }
    throw new Error('StubRedis: unsupported eval script');
  }
}

const SLOT_A = '0xslota';
const SLOT_B = '0xslotb';

describe('redisState keyspace helpers', () => {
  it('slotKey uses the stelis:app-api:sponsor-operations:slot: prefix', () => {
    expect(slotKey(SLOT_A)).toBe(`stelis:app-api:sponsor-operations:slot:${SLOT_A}`);
  });

  it('SPONSOR_REFILL_ACCOUNT_KEY uses the stelis:app-api:sponsor-operations:sponsor-refill-account key', () => {
    expect(SPONSOR_REFILL_ACCOUNT_KEY).toBe(
      'stelis:app-api:sponsor-operations:sponsor-refill-account',
    );
  });

  it('UPDATE_ENTITY_LUA uses Redis TIME + HINCRBY writeSeq', () => {
    expect(UPDATE_ENTITY_LUA).toContain("redis.call('TIME')");
    expect(UPDATE_ENTITY_LUA).toContain("redis.call('HINCRBY', KEYS[1], 'writeSeq', 1)");
    expect(UPDATE_ENTITY_LUA).toContain("redis.call('HSET', KEYS[1], 'lastObservedAtMs'");
  });

  it('READ_ALL_LUA reads slot and sponsor refill account fields without HGETALL', () => {
    expect(READ_ALL_LUA).toContain("redis.call('HGET', key, 'state')");
    expect(READ_ALL_LUA).toContain("redis.call('HGET', key, 'pendingRefillDigest')");
    expect(READ_ALL_LUA).toContain("redis.call('HGET', sponsorKey, 'healthy')");
    expect(READ_ALL_LUA).toContain('return { slotRows, sponsorRefillAccount }');
  });
});

describe('createRedisSponsorOperationsState — writes', () => {
  let redis: StubRedis;

  beforeEach(() => {
    redis = new StubRedis();
  });

  it('updateSlot writes caller-owned fields and server-stamps ordering fields', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    await state.updateSlot(SLOT_A, {
      state: 'healthy',
      balanceMist: '5000000000',
      lastError: '',
    });
    const h = redis.hashes.get(slotKey(SLOT_A));
    expect(h).toBeDefined();
    expect(h!.get('state')).toBe('healthy');
    expect(h!.get('balanceMist')).toBe('5000000000');
    expect(h!.get('lastError')).toBe('');
    expect(h!.get('writeSeq')).toBe('1');
    expect(h!.get('lastObservedAtMs')).toBeDefined();
  });

  it('updateSlot rejects unknown slot addresses', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    await expect(state.updateSlot(SLOT_B, { state: 'healthy' })).rejects.toThrow(
      /unknown slot address/,
    );
  });

  it('writeSeq is strictly monotonic per entity across updates', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A, SLOT_B],
    });
    await state.updateSlot(SLOT_A, { state: 'healthy' });
    await state.updateSlot(SLOT_A, { state: 'low_balance' });
    await state.updateSlot(SLOT_A, { state: 'healthy' });
    expect(redis.hashes.get(slotKey(SLOT_A))!.get('writeSeq')).toBe('3');
    // Cross-entity: SLOT_B's writeSeq is independent.
    await state.updateSlot(SLOT_B, { state: 'healthy' });
    expect(redis.hashes.get(slotKey(SLOT_B))!.get('writeSeq')).toBe('1');
  });

  it('updateSponsorRefillAccount writes sponsor-refill-account HASH with caller-owned fields only', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    await state.updateSponsorRefillAccount({
      balanceMist: '10000000000',
      healthy: '1',
      refillsRemaining: '2',
      lastError: '',
    });
    const h = redis.hashes.get(SPONSOR_REFILL_ACCOUNT_KEY);
    expect(h).toBeDefined();
    expect(h!.get('balanceMist')).toBe('10000000000');
    expect(h!.get('healthy')).toBe('1');
    expect(h!.get('refillsRemaining')).toBe('2');
    expect(h!.get('writeSeq')).toBe('1');
    expect(h!.get('lastObservedAtMs')).toBeDefined();
  });

  it('lastObservedAtMs advances on each write (server-authored)', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    await state.updateSlot(SLOT_A, { state: 'healthy' });
    const first = redis.hashes.get(slotKey(SLOT_A))!.get('lastObservedAtMs')!;
    await state.updateSlot(SLOT_A, { state: 'low_balance' });
    const second = redis.hashes.get(slotKey(SLOT_A))!.get('lastObservedAtMs')!;
    expect(Number(second)).toBeGreaterThan(Number(first));
  });
});

describe('createRedisSponsorOperationsState — reads', () => {
  let redis: StubRedis;

  beforeEach(() => {
    redis = new StubRedis();
  });

  it('readSlot returns null when the key is missing', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    expect(await state.readSlot(SLOT_A)).toBeNull();
  });

  it('readSlot parses fields after write', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    await state.updateSlot(SLOT_A, {
      state: 'low_balance',
      balanceMist: '1000',
      lastError: 'timeout',
      pendingRefillDigest: '0xabc',
      refillAttemptedAmountMist: '9000',
      refillObservedBalanceMist: '1000',
      refillReconciliationResult: 'dispatch_timeout',
    });
    const read = await state.readSlot(SLOT_A);
    expect(read).not.toBeNull();
    expect(read!.state).toBe('low_balance');
    expect(read!.balanceMist).toBe('1000');
    expect(read!.lastError).toBe('timeout');
    expect(read!.pendingRefillDigest).toBe('0xabc');
    expect(read!.refillAttemptedAmountMist).toBe('9000');
    expect(read!.refillObservedBalanceMist).toBe('1000');
    expect(read!.refillReconciliationResult).toBe('dispatch_timeout');
    expect(read!.writeSeq).toBe(1);
    expect(read!.lastObservedAtMs).not.toBeNull();
  });

  it('readSlot rejects unknown slot addresses', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    await expect(state.readSlot(SLOT_B)).rejects.toThrow(/unknown slot address/);
  });

  it('readSlot treats empty string fields as null', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    await state.updateSlot(SLOT_A, {
      state: 'rpc_unreachable',
      balanceMist: '',
      lastError: '',
    });
    const read = await state.readSlot(SLOT_A);
    expect(read!.state).toBe('rpc_unreachable');
    expect(read!.balanceMist).toBeNull();
    expect(read!.lastError).toBeNull();
  });

  it('readSponsorRefillAccount returns null when the key is missing', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    expect(await state.readSponsorRefillAccount()).toBeNull();
  });

  it('readSponsorRefillAccount parses healthy as boolean and refillsRemaining as number', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    await state.updateSponsorRefillAccount({
      balanceMist: '5000',
      healthy: '1',
      refillsRemaining: '3',
    });
    const read = await state.readSponsorRefillAccount();
    expect(read!.healthy).toBe(true);
    expect(read!.refillsRemaining).toBe(3);
    await state.updateSponsorRefillAccount({ healthy: '0' });
    const next = await state.readSponsorRefillAccount();
    expect(next!.healthy).toBe(false);
  });

  it('readAll returns every slot and the sponsor refill account from one Redis eval', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A, SLOT_B],
    });
    await state.updateSlot(SLOT_A, {
      state: 'healthy',
      balanceMist: '5000000000',
      lastError: '',
    });
    await state.updateSlot(SLOT_B, {
      state: 'low_balance',
      balanceMist: '10',
      lastError: 'below threshold',
    });
    await state.updateSponsorRefillAccount({
      balanceMist: '9000000000',
      healthy: '1',
      refillsRemaining: '4',
      lastError: '',
    });

    redis.hgetallCalls = 0;
    redis.readAllEvalCalls = 0;
    const read = await state.readAll();

    expect(redis.readAllEvalCalls).toBe(1);
    expect(redis.hgetallCalls).toBe(0);
    expect(read.slots).toEqual([
      {
        address: SLOT_A,
        state: 'healthy',
        balanceMist: '5000000000',
        lastError: null,
        lastObservedAtMs: expect.any(Number),
        writeSeq: 1,
        pendingRefillDigest: null,
        refillAttemptedAmountMist: null,
        refillObservedBalanceMist: null,
        refillReconciliationResult: null,
      },
      {
        address: SLOT_B,
        state: 'low_balance',
        balanceMist: '10',
        lastError: 'below threshold',
        lastObservedAtMs: expect.any(Number),
        writeSeq: 1,
        pendingRefillDigest: null,
        refillAttemptedAmountMist: null,
        refillObservedBalanceMist: null,
        refillReconciliationResult: null,
      },
    ]);
    expect(read.sponsorRefillAccount).toEqual({
      balanceMist: '9000000000',
      healthy: true,
      refillsRemaining: 4,
      lastError: null,
      lastObservedAtMs: expect.any(Number),
      writeSeq: 1,
    });
  });
});
