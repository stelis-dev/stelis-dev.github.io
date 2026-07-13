import { describe, it, expect, beforeEach } from 'vitest';
import type { RedisClientLike, RedisSetOptions } from '@stelis/core-api';
import {
  createRedisSponsorOperationsState,
  slotKey,
  SPONSOR_REFILL_ACCOUNT_KEY,
  READ_ALL_LUA,
  UPDATE_ENTITY_IF_SEQUENCE_LUA,
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

  seedHash(key: string, fields: Record<string, string>): void {
    const hash = this.getHash(key);
    for (const [field, value] of Object.entries(fields)) hash.set(field, value);
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
          get('refillOperationId'),
          get('refillOperationSequence'),
          get('refillOperationState'),
          get('refillRequiredSourceBalanceMist'),
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

    if (script === UPDATE_ENTITY_IF_SEQUENCE_LUA) {
      const key = keys[0]!;
      const h = this.getHash(key);
      if ((h.get('writeSeq') ?? '0') !== args[0]) return ['STALE'];
      const refillState = h.get('refillOperationState') ?? '';
      if (refillState === 'reserved' || refillState === 'ready' || refillState === 'reconciling') {
        return ['ACTIVE_REFILL'];
      }
      const nowMs = this.nextClock();
      const nextSeq = (Number(h.get('writeSeq') ?? '0') + 1).toString();
      h.set('writeSeq', nextSeq);
      h.set('lastObservedAtMs', nowMs);
      for (let i = 1; i < args.length; i += 2) {
        const field = args[i];
        const value = args[i + 1];
        if (field !== undefined && value !== undefined) h.set(field, value);
      }
      return ['UPDATED', nextSeq];
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
});

describe('createRedisSponsorOperationsState — writes', () => {
  let redis: StubRedis;

  beforeEach(() => {
    redis = new StubRedis();
  });

  it('updateSlotIfWriteSeq writes only when the sampled sequence is current', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    await state.updateSlotIfWriteSeq(SLOT_A, 0, {
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

  it('preserves a refill threshold while degraded and clears it when the slot becomes healthy', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    redis.seedHash(slotKey(SLOT_A), {
      state: 'refill_failed',
      writeSeq: '4',
      refillRequiredSourceBalanceMist: '237',
    });

    await expect(
      state.updateSlotIfWriteSeq(SLOT_A, 4, { state: 'low_balance', balanceMist: '10' }),
    ).resolves.toBe(true);
    await expect(state.readSlot(SLOT_A)).resolves.toMatchObject({
      state: 'low_balance',
      refillRequiredSourceBalanceMist: '237',
    });

    await expect(
      state.updateSlotIfWriteSeq(SLOT_A, 5, { state: 'rpc_unreachable', balanceMist: '' }),
    ).resolves.toBe(true);
    await expect(state.readSlot(SLOT_A)).resolves.toMatchObject({
      state: 'rpc_unreachable',
      refillRequiredSourceBalanceMist: '237',
    });

    await expect(
      state.updateSlotIfWriteSeq(SLOT_A, 6, { state: 'healthy', balanceMist: '500' }),
    ).resolves.toBe(true);
    await expect(state.readSlot(SLOT_A)).resolves.toMatchObject({
      state: 'healthy',
      refillRequiredSourceBalanceMist: null,
    });
  });

  it('updateSlotIfWriteSeq rejects unknown slot addresses', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    await expect(state.updateSlotIfWriteSeq(SLOT_B, 0, { state: 'healthy' })).rejects.toThrow(
      /unknown slot address/,
    );
  });

  it('rejects a malformed refill source balance threshold before writing the slot', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });

    await expect(
      state.updateSlotIfWriteSeq(SLOT_A, 0, {
        state: 'refill_failed',
        refillRequiredSourceBalanceMist: 'not-a-balance',
      }),
    ).rejects.toThrow('refill source balance threshold must be a positive u64 decimal string');
    expect(redis.hashes.has(slotKey(SLOT_A))).toBe(false);
  });

  it('writeSeq is strictly monotonic per entity across updates', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A, SLOT_B],
    });
    await state.updateSlotIfWriteSeq(SLOT_A, 0, { state: 'healthy' });
    await state.updateSlotIfWriteSeq(SLOT_A, 1, { state: 'low_balance' });
    await state.updateSlotIfWriteSeq(SLOT_A, 2, { state: 'healthy' });
    expect(redis.hashes.get(slotKey(SLOT_A))!.get('writeSeq')).toBe('3');
    // Cross-entity: SLOT_B's writeSeq is independent.
    await state.updateSlotIfWriteSeq(SLOT_B, 0, { state: 'healthy' });
    expect(redis.hashes.get(slotKey(SLOT_B))!.get('writeSeq')).toBe('1');
  });

  it('rejects a general slot observation while an active refill owns the projection', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    redis.seedHash(slotKey(SLOT_A), {
      state: 'refilling',
      balanceMist: '1000',
      writeSeq: '4',
      refillOperationId: 'operation-a',
      refillOperationSequence: '2',
      refillOperationState: 'ready',
    });

    await expect(
      state.updateSlotIfWriteSeq(SLOT_A, 4, {
        state: 'healthy',
        balanceMist: '9000',
      }),
    ).resolves.toBe(false);
    expect(redis.hashes.get(slotKey(SLOT_A))!.get('state')).toBe('refilling');
    expect(redis.hashes.get(slotKey(SLOT_A))!.get('balanceMist')).toBe('1000');
    expect(redis.hashes.get(slotKey(SLOT_A))!.get('writeSeq')).toBe('4');
  });

  it('readSponsorRefillAccount parses the account observation fields owned by spend state', async () => {
    redis.seedHash(SPONSOR_REFILL_ACCOUNT_KEY, {
      balanceMist: '10000000000',
      healthy: '1',
      refillsRemaining: '2',
      lastError: '',
      writeSeq: '1',
      lastObservedAtMs: '1700000000001',
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
    await state.updateSlotIfWriteSeq(SLOT_A, 0, { state: 'healthy' });
    const first = redis.hashes.get(slotKey(SLOT_A))!.get('lastObservedAtMs')!;
    await state.updateSlotIfWriteSeq(SLOT_A, 1, { state: 'low_balance' });
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

  it('rejects a healthy slot that retains a refill source balance threshold', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    redis.seedHash(slotKey(SLOT_A), {
      state: 'healthy',
      writeSeq: '1',
      refillRequiredSourceBalanceMist: '237',
    });

    await expect(state.readSlot(SLOT_A)).rejects.toThrow(
      'Healthy sponsor slot cannot retain a refill source balance threshold',
    );
  });

  it('does not interpret a malformed refill source balance threshold as absent', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    redis.seedHash(slotKey(SLOT_A), {
      state: 'refill_failed',
      writeSeq: '1',
      refillRequiredSourceBalanceMist: 'not-a-balance',
    });

    await expect(state.readSlot(SLOT_A)).rejects.toThrow(
      'Sponsor slot refill source balance threshold is malformed',
    );
  });

  it('readSlot parses fields after write', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A],
    });
    await state.updateSlotIfWriteSeq(SLOT_A, 0, {
      state: 'low_balance',
      balanceMist: '1000',
      lastError: 'timeout',
      pendingRefillDigest: '0xabc',
      refillAttemptedAmountMist: '9000',
      refillObservedBalanceMist: '1000',
      refillReconciliationResult: 'dispatch_ready',
    });
    const read = await state.readSlot(SLOT_A);
    expect(read).not.toBeNull();
    expect(read!.state).toBe('low_balance');
    expect(read!.balanceMist).toBe('1000');
    expect(read!.lastError).toBe('timeout');
    expect(read!.pendingRefillDigest).toBe('0xabc');
    expect(read!.refillAttemptedAmountMist).toBe('9000');
    expect(read!.refillObservedBalanceMist).toBe('1000');
    expect(read!.refillReconciliationResult).toBe('dispatch_ready');
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
    await state.updateSlotIfWriteSeq(SLOT_A, 0, {
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
    redis.seedHash(SPONSOR_REFILL_ACCOUNT_KEY, {
      balanceMist: '5000',
      healthy: '1',
      refillsRemaining: '3',
      writeSeq: '1',
      lastObservedAtMs: '1700000000001',
    });
    const read = await state.readSponsorRefillAccount();
    expect(read!.healthy).toBe(true);
    expect(read!.refillsRemaining).toBe(3);
    redis.seedHash(SPONSOR_REFILL_ACCOUNT_KEY, { healthy: '0' });
    const next = await state.readSponsorRefillAccount();
    expect(next!.healthy).toBe(false);
  });

  it('readAll returns every slot and the sponsor refill account from one Redis eval', async () => {
    const state = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: [SLOT_A, SLOT_B],
    });
    await state.updateSlotIfWriteSeq(SLOT_A, 0, {
      state: 'healthy',
      balanceMist: '5000000000',
      lastError: '',
    });
    await state.updateSlotIfWriteSeq(SLOT_B, 0, {
      state: 'low_balance',
      balanceMist: '10',
      lastError: 'below threshold',
    });
    redis.seedHash(SPONSOR_REFILL_ACCOUNT_KEY, {
      balanceMist: '9000000000',
      healthy: '1',
      refillsRemaining: '4',
      lastError: '',
      writeSeq: '1',
      lastObservedAtMs: '1700000000001',
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
        refillOperationId: null,
        refillOperationSequence: null,
        refillOperationState: null,
        refillRequiredSourceBalanceMist: null,
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
        refillOperationId: null,
        refillOperationSequence: null,
        refillOperationState: null,
        refillRequiredSourceBalanceMist: null,
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
