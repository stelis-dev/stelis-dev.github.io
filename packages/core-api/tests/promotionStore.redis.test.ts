/**
 * RedisPromotionStore — real Redis atomic-mutation authority.
 *
 * The read barrier makes both public store operations observe the same
 * current record before either Lua mutation can run. Real Redis then decides
 * the winner by exact-record CAS. FakeRedisClient intentionally remains only
 * branch coverage for Lua result handling.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RedisClientLike } from '../src/store/redisClient.js';
import type { Promotion, PromotionStatus } from '../src/studio/domain.js';
import {
  PromotionCurrentConflictError,
  RedisPromotionStore,
  type CreatePromotionInput,
} from '../src/studio/promotionStore.js';
import { startRealRedis, type RealRedisHandle } from '../src/testing/redis.js';

const STATUSES = [
  'draft',
  'active',
  'paused',
  'archived',
] as const satisfies readonly PromotionStatus[];

function makeInput(overrides: Partial<CreatePromotionInput> = {}): CreatePromotionInput {
  return {
    type: 'gas_sponsorship',
    displayName: 'Atomic promotion',
    description: 'real Redis race fixture',
    maxParticipants: 100,
    perUserGasAllowanceMist: '5000000',
    claimDeadlineAt: null,
    postClaimUseWindowMs: 0,
    startAt: null,
    ...overrides,
  };
}

/**
 * Return a client whose first `participants` reads of `recordKey` all capture
 * their value before any caller is released. All mutations still execute on
 * the real Redis client and therefore use production Lua semantics.
 */
function withRecordReadBarrier(
  client: RedisClientLike,
  recordKey: string,
  participants = 2,
): RedisClientLike {
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    async get(key) {
      const value = await client.get(key);
      if (key !== recordKey || arrivals >= participants) return value;

      arrivals += 1;
      if (arrivals === participants) release();
      await gate;
      return value;
    },
    set: (key, value, options) => client.set(key, value, options),
    del: (...keys) => client.del(...keys),
    eval: (script, keys, args) => client.eval(script, keys, args),
    hgetall: (key) => client.hgetall(key),
    scan: (pattern, count) => client.scan(pattern, count),
  };
}

function expectOneWinner<T>(outcomes: readonly PromiseSettledResult<T>[]): T {
  const fulfilled = outcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<T> => outcome.status === 'fulfilled',
  );
  const rejected = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );

  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toBeInstanceOf(PromotionCurrentConflictError);

  const winner = fulfilled[0];
  if (!winner) throw new Error('expected one fulfilled promotion mutation');
  return winner.value;
}

async function expectRecordAndIndexes(
  redis: RealRedisHandle,
  store: RedisPromotionStore,
  expected: Promotion | null,
): Promise<void> {
  const expectedIds = expected === null ? [] : [expected.promotionId];
  const all = await store.list();
  if (expected === null) {
    expect(all).toEqual([]);
  } else {
    expect(all).toEqual([expected]);
  }
  expect(await readSetMembers(redis, 'stelis:promo:index:all')).toEqual(expectedIds);

  for (const status of STATUSES) {
    const records = await store.list({ status });
    const statusIds = expected?.status === status ? expectedIds : [];
    if (expected?.status === status) {
      expect(records).toEqual([expected]);
    } else {
      expect(records).toEqual([]);
    }
    expect(await readSetMembers(redis, `stelis:promo:index:status:${status}`)).toEqual(statusIds);
  }
}

async function readSetMembers(redis: RealRedisHandle, key: string): Promise<string[]> {
  const members = (await redis.rawClient.sendCommand(['SMEMBERS', key])) as string[];
  return [...members].sort();
}

describe('RedisPromotionStore — real Redis atomic races', () => {
  let redis: RealRedisHandle | null = null;

  beforeAll(async () => {
    redis = await startRealRedis();
  });

  afterAll(async () => {
    await redis?.stop();
  });

  beforeEach(async () => {
    await redis!.flush();
  });

  it('allows exactly one of two updates and persists the complete winner record', async () => {
    const initialStore = new RedisPromotionStore(redis!.client);
    const created = await initialStore.create(makeInput());
    const racedStore = new RedisPromotionStore(
      withRecordReadBarrier(redis!.client, initialStore.recordKey(created.promotionId)),
    );

    const winner = expectOneWinner(
      await Promise.allSettled([
        racedStore.update(created.promotionId, { displayName: 'first update' }),
        racedStore.update(created.promotionId, { description: 'second update' }),
      ]),
    );
    expect(winner).not.toBeNull();

    const finalRecord = await initialStore.get(created.promotionId);
    expect(finalRecord).toEqual(winner);
    expect(finalRecord).toEqual(
      expect.objectContaining({
        status: 'draft',
        maxParticipants: created.maxParticipants,
        perUserGasAllowanceMist: created.perUserGasAllowanceMist,
      }),
    );
    await expectRecordAndIndexes(redis!, initialStore, finalRecord);
  });

  it('does not merge a draft economic update with a concurrent activation', async () => {
    const initialStore = new RedisPromotionStore(redis!.client);
    const created = await initialStore.create(makeInput({ maxParticipants: 100 }));
    const racedStore = new RedisPromotionStore(
      withRecordReadBarrier(redis!.client, initialStore.recordKey(created.promotionId)),
    );

    const winner = expectOneWinner(
      await Promise.allSettled([
        racedStore.update(created.promotionId, { maxParticipants: 10 }),
        racedStore.transitionStatus(created.promotionId, 'active'),
      ]),
    );
    expect(winner).not.toBeNull();

    const finalRecord = await initialStore.get(created.promotionId);
    expect(finalRecord).toEqual(winner);
    if (finalRecord?.status === 'active') {
      expect(finalRecord.maxParticipants).toBe(100);
    } else {
      expect(finalRecord?.status).toBe('draft');
      expect(finalRecord?.maxParticipants).toBe(10);
    }
    await expectRecordAndIndexes(redis!, initialStore, finalRecord);
  });

  it('allows exactly one competing status transition and moves only its index', async () => {
    const initialStore = new RedisPromotionStore(redis!.client);
    const created = await initialStore.create(makeInput());
    await initialStore.transitionStatus(created.promotionId, 'active');
    const racedStore = new RedisPromotionStore(
      withRecordReadBarrier(redis!.client, initialStore.recordKey(created.promotionId)),
    );

    const winner = expectOneWinner(
      await Promise.allSettled([
        racedStore.transitionStatus(created.promotionId, 'paused', 'pause winner'),
        racedStore.transitionStatus(created.promotionId, 'archived', 'archive winner'),
      ]),
    );
    expect(winner).not.toBeNull();

    const finalRecord = await initialStore.get(created.promotionId);
    expect(finalRecord).toEqual(winner);
    expect(['paused', 'archived']).toContain(finalRecord?.status);
    await expectRecordAndIndexes(redis!, initialStore, finalRecord);
  });

  it('removes a draft record from the record key and both raw indexes', async () => {
    const store = new RedisPromotionStore(redis!.client);
    const created = await store.create(makeInput());

    await expectRecordAndIndexes(redis!, store, created);
    await expect(store.delete(created.promotionId)).resolves.toBe(true);
    await expect(store.get(created.promotionId)).resolves.toBeNull();
    await expectRecordAndIndexes(redis!, store, null);
  });

  it('makes delete and activation mutually exclusive without record/index drift', async () => {
    const initialStore = new RedisPromotionStore(redis!.client);
    const created = await initialStore.create(makeInput());
    const racedStore = new RedisPromotionStore(
      withRecordReadBarrier(redis!.client, initialStore.recordKey(created.promotionId)),
    );

    const winner = expectOneWinner(
      await Promise.allSettled([
        racedStore
          .delete(created.promotionId)
          .then((deleted) => ({ kind: 'delete', deleted }) as const),
        racedStore
          .transitionStatus(created.promotionId, 'active')
          .then((record) => ({ kind: 'activate', record }) as const),
      ]),
    );

    const finalRecord = await initialStore.get(created.promotionId);
    if (winner.kind === 'delete') {
      expect(winner.deleted).toBe(true);
      expect(finalRecord).toBeNull();
    } else {
      expect(winner.record).not.toBeNull();
      expect(finalRecord).toEqual(winner.record);
      expect(finalRecord?.status).toBe('active');
    }
    await expectRecordAndIndexes(redis!, initialStore, finalRecord);
  });
});
