/**
 * RedisPromotionStore — unit tests using FakeRedisClient.
 *
 * Proves the Redis adapter contract: Lua-based atomic index maintenance,
 * status transitions with the shared ledger-budget guard, and delete policy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AdminPromotionCreateRequest } from '@stelis/contracts';
import {
  RedisPromotionStore,
  InvalidStatusTransitionError,
  PromotionFieldImmutableError,
  PromotionCurrentConflictError,
  type PromotionStoreAdapter,
  type PromotionStoreFilter,
} from '../src/studio/promotionStore.js';
import { FakeRedisClient } from './helpers/fakeRedisClient.js';

const PAGE_ALL = { cursor: null, limit: 100 } as const;
const ID_A = '00000000-0000-4000-8000-000000000001';
const ID_B = '00000000-0000-4000-8000-000000000002';
const ID_C = '00000000-0000-4000-8000-000000000003';
const ID_D = '00000000-0000-4000-8000-000000000004';

async function listRecords(store: PromotionStoreAdapter, filter?: PromotionStoreFilter) {
  return (await store.listPage(PAGE_ALL, filter)).promotions;
}

// ── Fixtures ────────────────────────────────────────────────────────────

function makeInput(
  overrides: Partial<AdminPromotionCreateRequest> = {},
): AdminPromotionCreateRequest {
  return {
    type: 'gas_sponsorship',
    displayName: 'Redis Promo',
    description: 'A test promotion for redis adapter',
    maxParticipants: 50,
    perUserGasAllowanceMist: '5000000',
    claimDeadlineAt: null,
    postClaimUseWindowMs: 0,
    startAt: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('RedisPromotionStore', () => {
  let redis: FakeRedisClient;
  let store: RedisPromotionStore;

  beforeEach(() => {
    redis = new FakeRedisClient();
    store = new RedisPromotionStore(redis);
  });

  // ── create + get ───────────────────────────────────────────────

  it('creates and retrieves a promotion', async () => {
    const record = await store.create(makeInput());

    expect(record.promotionId).toBeTruthy();
    expect(record.status).toBe('draft');
    expect(record.displayName).toBe('Redis Promo');

    const retrieved = await store.get(record.promotionId);
    expect(retrieved).toEqual(record);
  });

  it('returns null for non-existent promotion', async () => {
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  it('does not overwrite an existing record when generated IDs collide', async () => {
    const fixedId = '00000000-0000-4000-8000-000000000001';
    const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(fixedId);
    try {
      const original = await store.create(makeInput({ displayName: 'Original' }));

      await expect(store.create(makeInput({ displayName: 'Replacement' }))).rejects.toMatchObject({
        name: 'PromotionCurrentConflictError',
        promotionId: fixedId,
        operation: 'create',
      } satisfies Partial<PromotionCurrentConflictError>);

      expect(await store.get(fixedId)).toEqual(original);
      expect(await listRecords(store)).toEqual([original]);
      expect(await listRecords(store, { status: 'draft' })).toEqual([original]);
    } finally {
      randomUuid.mockRestore();
    }
  });

  // ── list ───────────────────────────────────────────────────────

  it('lists all promotions via index', async () => {
    await store.create(makeInput({ displayName: 'A' }));
    await store.create(makeInput({ displayName: 'B' }));

    const all = await listRecords(store);
    expect(all).toHaveLength(2);
    const names = all.map((r) => r.displayName).sort();
    expect(names).toEqual(['A', 'B']);
  });

  it('lists by status filter', async () => {
    await store.create(makeInput({ displayName: 'Draft' }));
    const p2 = await store.create(makeInput({ displayName: 'Active' }));
    await store.transitionStatus(p2.promotionId, 'active');

    const drafts = await listRecords(store, { status: 'draft' });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].displayName).toBe('Draft');

    const actives = await listRecords(store, { status: 'active' });
    expect(actives).toHaveLength(1);
    expect(actives[0].displayName).toBe('Active');
  });

  it('returns empty array when no promotions exist', async () => {
    const all = await listRecords(store);
    expect(all).toEqual([]);
  });

  it('pages non-insertion IDs in ascending ASCII order with one-record lookahead', async () => {
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
    } finally {
      randomUuid.mockRestore();
    }
  });

  it('fails closed when an indexed record is missing', async () => {
    const created = await store.create(makeInput());
    await redis.del(`stelis:promo:${created.promotionId}`);

    await expect(store.listPage(PAGE_ALL)).rejects.toThrow(
      `Promotion index references missing record ${created.promotionId}`,
    );
  });

  it('fails closed when an indexed record has a different identity', async () => {
    const created = await store.create(makeInput());
    await redis.set(
      `stelis:promo:${created.promotionId}`,
      JSON.stringify({ ...created, promotionId: ID_D }),
    );

    await expect(store.listPage(PAGE_ALL)).rejects.toThrow(
      `Promotion index identity mismatch for ${created.promotionId}`,
    );
  });

  // ── update ────────────────────────────────────────────────────

  it('updates mutable fields', async () => {
    const created = await store.create(makeInput());
    const updated = await store.update(created.promotionId, {
      displayName: 'Updated',
      maxParticipants: 200,
    });

    expect(updated).not.toBeNull();
    expect(updated!.displayName).toBe('Updated');
    expect(updated!.maxParticipants).toBe(200);
    expect(updated!.description).toBe('A test promotion for redis adapter');
  });

  it('returns null when updating non-existent', async () => {
    const result = await store.update('nope', { displayName: 'X' });
    expect(result).toBeNull();
  });

  it('rejects an update when the full record changed after its read', async () => {
    const created = await store.create(makeInput());
    const recordKey = `stelis:promo:${created.promotionId}`;
    const staleRaw = await redis.get(recordKey);
    const winner = await store.update(created.promotionId, { description: 'concurrent winner' });

    await expect(
      withStaleFirstRead(redis, recordKey, staleRaw!, () =>
        store.update(created.promotionId, { displayName: 'stale loser' }),
      ),
    ).rejects.toMatchObject({
      name: 'PromotionCurrentConflictError',
      promotionId: created.promotionId,
      operation: 'update',
    } satisfies Partial<PromotionCurrentConflictError>);

    expect(await store.get(created.promotionId)).toEqual(winner);
  });

  // ── Immutable-after-draft fields ──────────────────────────────

  it('rejects economic-field update on active promotion', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');
    await expect(store.update(created.promotionId, { maxParticipants: 200 })).rejects.toThrow(
      PromotionFieldImmutableError,
    );
  });

  it('rejects perUserGasAllowanceMist update on paused promotion', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');
    await store.transitionStatus(created.promotionId, 'paused');
    await expect(
      store.update(created.promotionId, { perUserGasAllowanceMist: '1' }),
    ).rejects.toThrow(PromotionFieldImmutableError);
  });

  it('allows displayName/description update on active promotion', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');
    const updated = await store.update(created.promotionId, {
      displayName: 'Renamed',
      description: 'new',
    });
    expect(updated!.displayName).toBe('Renamed');
    expect(updated!.description).toBe('new');
    expect(updated!.maxParticipants).toBe(50);
  });

  // ── transitionStatus ──────────────────────────────────────────

  it('transitions draft → active', async () => {
    const created = await store.create(makeInput());
    const result = await store.transitionStatus(created.promotionId, 'active');
    expect(result!.status).toBe('active');
  });

  it('transitions active → paused with reason', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');
    const result = await store.transitionStatus(created.promotionId, 'paused', 'Budget review');
    expect(result!.status).toBe('paused');
    expect(result!.pauseReason).toBe('Budget review');
  });

  it('transitions active → archived', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');
    const result = await store.transitionStatus(created.promotionId, 'archived', 'Done');
    expect(result!.status).toBe('archived');
    expect(result!.archiveReason).toBe('Done');
  });

  it('maintains status index consistency across transitions', async () => {
    const p = await store.create(makeInput());

    // draft index has it
    let drafts = await listRecords(store, { status: 'draft' });
    expect(drafts).toHaveLength(1);

    // activate → moves to active index
    await store.transitionStatus(p.promotionId, 'active');
    drafts = await listRecords(store, { status: 'draft' });
    expect(drafts).toHaveLength(0);
    let actives = await listRecords(store, { status: 'active' });
    expect(actives).toHaveLength(1);

    // archive → moves to archived index
    await store.transitionStatus(p.promotionId, 'archived');
    actives = await listRecords(store, { status: 'active' });
    expect(actives).toHaveLength(0);
    const archived = await listRecords(store, { status: 'archived' });
    expect(archived).toHaveLength(1);
  });

  it('throws on invalid transitions', async () => {
    const created = await store.create(makeInput());
    await expect(store.transitionStatus(created.promotionId, 'archived')).rejects.toThrow(
      InvalidStatusTransitionError,
    );
  });

  it('returns null for non-existent promotion', async () => {
    const result = await store.transitionStatus('nope', 'active');
    expect(result).toBeNull();
  });

  // ── STATUS_LUA full-record CAS ─────────────────────────────────

  it('rejects a status transition after a same-status record update', async () => {
    const created = await store.create(makeInput());
    const recordKey = `stelis:promo:${created.promotionId}`;
    const staleRaw = await redis.get(recordKey);
    const winner = await store.update(created.promotionId, { displayName: 'concurrent winner' });

    await expect(
      withStaleFirstRead(redis, recordKey, staleRaw!, () =>
        store.transitionStatus(created.promotionId, 'active'),
      ),
    ).rejects.toMatchObject({
      name: 'PromotionCurrentConflictError',
      promotionId: created.promotionId,
      operation: 'status',
    } satisfies Partial<PromotionCurrentConflictError>);

    expect(await store.get(created.promotionId)).toEqual(winner);
    expect(await listRecords(store, { status: 'draft' })).toEqual([winner]);
    expect(await listRecords(store, { status: 'active' })).toEqual([]);
  });

  // ── delete ────────────────────────────────────────────────────

  it('deletes a draft promotion', async () => {
    const created = await store.create(makeInput());
    const result = await store.delete(created.promotionId);
    expect(result).toEqual({ status: 'deleted' });

    const found = await store.get(created.promotionId);
    expect(found).toBeNull();

    // Removed from indexes
    const all = await listRecords(store);
    expect(all).toHaveLength(0);
  });

  it('refuses to delete non-draft promotion', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');

    const result = await store.delete(created.promotionId);
    expect(result).toEqual({ status: 'not_deletable' });

    const found = await store.get(created.promotionId);
    expect(found).not.toBeNull();
  });

  it('distinguishes a non-existent delete', async () => {
    const result = await store.delete('nope');
    expect(result).toEqual({ status: 'not_found' });
  });

  it('rejects delete when activation wins after the draft read', async () => {
    const created = await store.create(makeInput());
    const recordKey = `stelis:promo:${created.promotionId}`;
    const staleRaw = await redis.get(recordKey);
    const activated = await store.transitionStatus(created.promotionId, 'active');

    await expect(
      withStaleFirstRead(redis, recordKey, staleRaw!, () => store.delete(created.promotionId)),
    ).rejects.toMatchObject({
      name: 'PromotionCurrentConflictError',
      promotionId: created.promotionId,
      operation: 'delete',
    } satisfies Partial<PromotionCurrentConflictError>);

    expect(await store.get(created.promotionId)).toEqual(activated);
    expect(await listRecords(store, { status: 'draft' })).toEqual([]);
    expect(await listRecords(store, { status: 'active' })).toEqual([activated]);
  });
});

async function withStaleFirstRead<T>(
  redis: FakeRedisClient,
  recordKey: string,
  staleRaw: string,
  operation: () => Promise<T>,
): Promise<T> {
  const originalGet = redis.get.bind(redis);
  let staleReadReturned = false;
  const spy = vi.spyOn(redis, 'get').mockImplementation(async (key: string) => {
    if (key === recordKey && !staleReadReturned) {
      staleReadReturned = true;
      return staleRaw;
    }
    return originalGet(key);
  });

  try {
    return await operation();
  } finally {
    spy.mockRestore();
  }
}
