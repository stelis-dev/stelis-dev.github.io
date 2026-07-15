/**
 * RedisPromotionStore — real Redis page and atomic-mutation authority.
 *
 * The read barrier makes both public store operations observe the same
 * current record before either Lua mutation can run. Real Redis then decides
 * the winner by exact-record CAS. FakeRedisClient intentionally remains only
 * branch coverage for Lua result handling.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminPromotionCreateRequest } from '@stelis/contracts';
import type { RedisClientLike } from '../src/store/redisClient.js';
import type { Promotion, PromotionStatus } from '../src/studio/domain.js';
import {
  PromotionCurrentConflictError,
  RedisPromotionStore,
} from '../src/studio/promotionStore.js';
import { startRealRedis, type RealRedisHandle } from '../src/testing/redis.js';

const PAGE_ALL = { cursor: null, limit: 100 } as const;
const ID_A = '00000000-0000-4000-8000-000000000001';
const ID_B = '00000000-0000-4000-8000-000000000002';
const ID_C = '00000000-0000-4000-8000-000000000003';
const ID_D = '00000000-0000-4000-8000-000000000004';

const STATUSES = [
  'draft',
  'active',
  'paused',
  'archived',
] as const satisfies readonly PromotionStatus[];

async function listRecords(store: RedisPromotionStore, status?: PromotionStatus) {
  return (await store.listPage(PAGE_ALL, status === undefined ? undefined : { status })).promotions;
}

function makeInput(
  overrides: Partial<AdminPromotionCreateRequest> = {},
): AdminPromotionCreateRequest {
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
  const all = await listRecords(store);
  if (expected === null) {
    expect(all).toEqual([]);
  } else {
    expect(all).toEqual([expected]);
  }
  expect(await readSortedMembers(redis, 'stelis:promo:index:all')).toEqual(expectedIds);

  for (const status of STATUSES) {
    const records = await listRecords(store, status);
    const statusIds = expected?.status === status ? expectedIds : [];
    if (expected?.status === status) {
      expect(records).toEqual([expected]);
    } else {
      expect(records).toEqual([]);
    }
    expect(await readSortedMembers(redis, `stelis:promo:index:status:${status}`)).toEqual(
      statusIds,
    );
  }
}

async function readSortedMembers(redis: RealRedisHandle, key: string): Promise<string[]> {
  const type = await redis.rawClient.sendCommand(['TYPE', key]);
  if (type === 'none') return [];
  expect(type).toBe('zset');

  const rows = (await redis.rawClient.sendCommand([
    'ZRANGE',
    key,
    '0',
    '-1',
    'WITHSCORES',
  ])) as string[];
  const members: string[] = [];
  for (let index = 0; index < rows.length; index += 2) {
    members.push(rows[index]!);
    expect(rows[index + 1]).toBe('0');
  }
  return members;
}

describe('RedisPromotionStore — real Redis bounded pages and atomic races', () => {
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

  it('pages non-insertion IDs in ascending ASCII order with one-record lookahead', async () => {
    const store = new RedisPromotionStore(redis!.client);
    const randomUuid = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(ID_C)
      .mockReturnValueOnce(ID_A)
      .mockReturnValueOnce(ID_D)
      .mockReturnValueOnce(ID_B);
    try {
      for (const displayName of ['C', 'A', 'D', 'B']) {
        await store.create(makeInput({ displayName }));
      }

      const first = await store.listPage({ cursor: null, limit: 2 });
      expect(first.promotions.map((promotion) => promotion.promotionId)).toEqual([ID_A, ID_B]);
      expect(first.nextCursor).toBe(ID_B);

      const second = await store.listPage({ cursor: first.nextCursor, limit: 2 });
      expect(second.promotions.map((promotion) => promotion.promotionId)).toEqual([ID_C, ID_D]);
      expect(second.nextCursor).toBeNull();
      expect(await readSortedMembers(redis!, 'stelis:promo:index:all')).toEqual([
        ID_A,
        ID_B,
        ID_C,
        ID_D,
      ]);
    } finally {
      randomUuid.mockRestore();
    }
  });

  it('continues strictly after a cursor whose draft record was deleted', async () => {
    const store = new RedisPromotionStore(redis!.client);
    const randomUuid = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(ID_A)
      .mockReturnValueOnce(ID_B)
      .mockReturnValueOnce(ID_C);
    try {
      for (const displayName of ['A', 'B', 'C']) {
        await store.create(makeInput({ displayName }));
      }

      const first = await store.listPage({ cursor: null, limit: 1 });
      expect(first.nextCursor).toBe(ID_A);
      await expect(store.delete(ID_A)).resolves.toEqual({ status: 'deleted' });

      const second = await store.listPage({ cursor: ID_A, limit: 1 });
      expect(second.promotions.map((promotion) => promotion.promotionId)).toEqual([ID_B]);
      expect(second.nextCursor).toBe(ID_B);
    } finally {
      randomUuid.mockRestore();
    }
  });

  it('continues after an active cursor moves to another status index', async () => {
    const store = new RedisPromotionStore(redis!.client);
    const randomUuid = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(ID_A)
      .mockReturnValueOnce(ID_B)
      .mockReturnValueOnce(ID_C);
    try {
      for (const displayName of ['A', 'B', 'C']) {
        const record = await store.create(makeInput({ displayName }));
        await store.transitionStatus(record.promotionId, 'active');
      }

      const first = await store.listPage({ cursor: null, limit: 1 }, { status: 'active' });
      expect(first.nextCursor).toBe(ID_A);
      await store.transitionStatus(ID_A, 'paused');

      const second = await store.listPage({ cursor: ID_A, limit: 1 }, { status: 'active' });
      expect(second.promotions.map((promotion) => promotion.promotionId)).toEqual([ID_B]);
      expect(second.nextCursor).toBe(ID_B);
    } finally {
      randomUuid.mockRestore();
    }
  });

  it('fails closed when a sorted index references a missing record', async () => {
    const store = new RedisPromotionStore(redis!.client);
    const created = await store.create(makeInput());
    await redis!.rawClient.sendCommand(['DEL', store.recordKey(created.promotionId)]);

    await expect(store.listPage(PAGE_ALL)).rejects.toThrow(
      `Promotion index references missing record ${created.promotionId}`,
    );
  });

  it('refuses create, status, and delete mutations when their indexes are inconsistent', async () => {
    const store = new RedisPromotionStore(redis!.client);
    const randomUuid = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(ID_A)
      .mockReturnValueOnce(ID_B)
      .mockReturnValueOnce(ID_C);
    try {
      await redis!.rawClient.sendCommand(['ZADD', 'stelis:promo:index:all', '0', ID_A]);
      await expect(store.create(makeInput({ displayName: 'ghost collision' }))).rejects.toThrow(
        `Promotion index conflict while creating ${ID_A}`,
      );
      await expect(store.get(ID_A)).resolves.toBeNull();

      const statusRecord = await store.create(makeInput({ displayName: 'status conflict' }));
      await redis!.rawClient.sendCommand([
        'ZREM',
        'stelis:promo:index:status:draft',
        statusRecord.promotionId,
      ]);
      await expect(store.transitionStatus(statusRecord.promotionId, 'active')).rejects.toThrow(
        `Promotion index conflict while changing status for ${statusRecord.promotionId}`,
      );
      await expect(store.get(statusRecord.promotionId)).resolves.toMatchObject({ status: 'draft' });

      const deleteRecord = await store.create(makeInput({ displayName: 'delete conflict' }));
      await redis!.rawClient.sendCommand([
        'ZREM',
        'stelis:promo:index:all',
        deleteRecord.promotionId,
      ]);
      await expect(store.delete(deleteRecord.promotionId)).rejects.toThrow(
        `Promotion index conflict while deleting ${deleteRecord.promotionId}`,
      );
      await expect(store.get(deleteRecord.promotionId)).resolves.toEqual(deleteRecord);
    } finally {
      randomUuid.mockRestore();
    }
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
    await expect(store.delete(created.promotionId)).resolves.toEqual({ status: 'deleted' });
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
          .then((result) => ({ kind: 'delete', result }) as const),
        racedStore
          .transitionStatus(created.promotionId, 'active')
          .then((record) => ({ kind: 'activate', record }) as const),
      ]),
    );

    const finalRecord = await initialStore.get(created.promotionId);
    if (winner.kind === 'delete') {
      expect(winner.result).toEqual({ status: 'deleted' });
      expect(finalRecord).toBeNull();
    } else {
      expect(winner.record).not.toBeNull();
      expect(finalRecord).toEqual(winner.record);
      expect(finalRecord?.status).toBe('active');
    }
    await expectRecordAndIndexes(redis!, initialStore, finalRecord);
  });
});
