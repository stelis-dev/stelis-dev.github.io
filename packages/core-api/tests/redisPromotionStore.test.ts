/**
 * RedisPromotionStore — unit tests using FakeRedisClient.
 *
 * Proves the Redis adapter contract: Lua-based atomic index maintenance,
 * status transitions with activation guard, and delete policy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RedisPromotionStore,
  InvalidStatusTransitionError,
  PromotionFieldImmutableError,
  PromotionCurrentConflictError,
  type CreatePromotionInput,
} from '../src/studio/promotionStore.js';
import { FakeRedisClient } from './helpers/fakeRedisClient.js';

// ── Fixtures ────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<CreatePromotionInput> = {}): CreatePromotionInput {
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
      expect(await store.list()).toEqual([original]);
      expect(await store.list({ status: 'draft' })).toEqual([original]);
    } finally {
      randomUuid.mockRestore();
    }
  });

  // ── list ───────────────────────────────────────────────────────

  it('lists all promotions via index', async () => {
    await store.create(makeInput({ displayName: 'A' }));
    await store.create(makeInput({ displayName: 'B' }));

    const all = await store.list();
    expect(all).toHaveLength(2);
    const names = all.map((r) => r.displayName).sort();
    expect(names).toEqual(['A', 'B']);
  });

  it('lists by status filter', async () => {
    await store.create(makeInput({ displayName: 'Draft' }));
    const p2 = await store.create(makeInput({ displayName: 'Active' }));
    await store.transitionStatus(p2.promotionId, 'active');

    const drafts = await store.list({ status: 'draft' });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].displayName).toBe('Draft');

    const actives = await store.list({ status: 'active' });
    expect(actives).toHaveLength(1);
    expect(actives[0].displayName).toBe('Active');
  });

  it('returns empty array when no promotions exist', async () => {
    const all = await store.list();
    expect(all).toEqual([]);
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
    let drafts = await store.list({ status: 'draft' });
    expect(drafts).toHaveLength(1);

    // activate → moves to active index
    await store.transitionStatus(p.promotionId, 'active');
    drafts = await store.list({ status: 'draft' });
    expect(drafts).toHaveLength(0);
    let actives = await store.list({ status: 'active' });
    expect(actives).toHaveLength(1);

    // archive → moves to archived index
    await store.transitionStatus(p.promotionId, 'archived');
    actives = await store.list({ status: 'active' });
    expect(actives).toHaveLength(0);
    const archived = await store.list({ status: 'archived' });
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
    expect(await store.list({ status: 'draft' })).toEqual([winner]);
    expect(await store.list({ status: 'active' })).toEqual([]);
  });

  // ── delete ────────────────────────────────────────────────────

  it('deletes a draft promotion', async () => {
    const created = await store.create(makeInput());
    const result = await store.delete(created.promotionId);
    expect(result).toBe(true);

    const found = await store.get(created.promotionId);
    expect(found).toBeNull();

    // Removed from indexes
    const all = await store.list();
    expect(all).toHaveLength(0);
  });

  it('refuses to delete non-draft promotion', async () => {
    const created = await store.create(makeInput());
    await store.transitionStatus(created.promotionId, 'active');

    const result = await store.delete(created.promotionId);
    expect(result).toBe(false);

    const found = await store.get(created.promotionId);
    expect(found).not.toBeNull();
  });

  it('returns false for non-existent delete', async () => {
    const result = await store.delete('nope');
    expect(result).toBe(false);
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
    expect(await store.list({ status: 'draft' })).toEqual([]);
    expect(await store.list({ status: 'active' })).toEqual([activated]);
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
