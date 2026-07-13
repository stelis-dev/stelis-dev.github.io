/**
 * MemoryPromotionStore — unit tests.
 *
 * Tests the promotion registry store contract using the in-memory adapter.
 * Redis adapter follows the same interface and is tested separately with integration tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryPromotionStore,
  InvalidStatusTransitionError,
  PromotionActivationError,
  PromotionCurrentConflictError,
  PromotionFieldImmutableError,
  isValidTransition,
  type CreatePromotionInput,
  type UpdatePromotionInput,
} from '../src/studio/promotionStore.js';
import { computeTotalRequiredBudgetMist } from '../src/studio/domain.js';
import type { PromotionStatus } from '../src/studio/domain.js';

// ── Fixtures ────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<CreatePromotionInput> = {}): CreatePromotionInput {
  return {
    type: 'gas_sponsorship',
    displayName: 'Test Promo',
    description: 'A test promotion',
    maxParticipants: 100,
    perUserGasAllowanceMist: '10000000',
    claimDeadlineAt: null,
    postClaimUseWindowMs: 0,
    startAt: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('MemoryPromotionStore', () => {
  let store: MemoryPromotionStore;

  beforeEach(() => {
    store = new MemoryPromotionStore();
  });

  // ── create ─────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a promotion with auto-generated id and draft status', async () => {
      const record = await store.create(makeInput());

      expect(record.promotionId).toMatch(/^promo-test-/);
      expect(record.status).toBe('draft');
      expect(record.type).toBe('gas_sponsorship');
      expect(record.displayName).toBe('Test Promo');
      expect(record.maxParticipants).toBe(100);
      expect(record.perUserGasAllowanceMist).toBe('10000000');
      expect(record.pauseReason).toBeNull();
      expect(record.archiveReason).toBeNull();
      expect(record.createdAt).toBeTruthy();
      expect(record.updatedAt).toBeTruthy();
    });

    it('generates unique IDs for multiple creates', async () => {
      const r1 = await store.create(makeInput());
      const r2 = await store.create(makeInput());
      expect(r1.promotionId).not.toBe(r2.promotionId);
    });

    it('rejects a generated-ID collision without overwriting the current record', async () => {
      class FixedIdMemoryPromotionStore extends MemoryPromotionStore {
        protected override generateId(): string {
          return 'promo-fixed-id';
        }
      }

      const collisionStore = new FixedIdMemoryPromotionStore();
      const first = await collisionStore.create(makeInput({ displayName: 'First' }));

      await expect(collisionStore.create(makeInput({ displayName: 'Second' }))).rejects.toThrow(
        PromotionCurrentConflictError,
      );
      await expect(collisionStore.get(first.promotionId)).resolves.toEqual(first);
    });

    it('does not expose the stored record through the created result', async () => {
      const created = await store.create(makeInput());
      const promotionId = created.promotionId;

      Reflect.set(created, 'promotionId', 'tampered-id');
      Reflect.set(created, 'status', 'archived');
      Reflect.set(created, 'displayName', 'Tampered');

      await expect(store.get(promotionId)).resolves.toMatchObject({
        promotionId,
        status: 'draft',
        displayName: 'Test Promo',
      });
    });
  });

  // ── get ────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns null for non-existent promotion', async () => {
      const result = await store.get('non-existent');
      expect(result).toBeNull();
    });

    it('returns the created record', async () => {
      const created = await store.create(makeInput());
      const result = await store.get(created.promotionId);
      expect(result).toEqual(created);
    });

    it('does not expose the stored record through get', async () => {
      const created = await store.create(makeInput());
      const fetched = await store.get(created.promotionId);
      expect(fetched).not.toBeNull();

      Reflect.set(fetched!, 'status', 'archived');
      Reflect.set(fetched!, 'displayName', 'Tampered');

      await expect(store.get(created.promotionId)).resolves.toMatchObject({
        status: 'draft',
        displayName: 'Test Promo',
      });
    });
  });

  // ── list ───────────────────────────────────────────────────────

  describe('list', () => {
    it('returns empty array when empty', async () => {
      const result = await store.list();
      expect(result).toEqual([]);
    });

    it('returns all promotions', async () => {
      await store.create(makeInput({ displayName: 'A' }));
      await store.create(makeInput({ displayName: 'B' }));
      const result = await store.list();
      expect(result).toHaveLength(2);
    });

    it('filters by status', async () => {
      const draft = await store.create(makeInput({ displayName: 'Draft' }));
      await store.create(makeInput({ displayName: 'Also Draft' }));
      await store.transitionStatus(draft.promotionId, 'active');

      const drafts = await store.list({ status: 'draft' });
      expect(drafts).toHaveLength(1);
      expect(drafts[0].displayName).toBe('Also Draft');

      const actives = await store.list({ status: 'active' });
      expect(actives).toHaveLength(1);
      expect(actives[0].displayName).toBe('Draft');
    });

    it('does not expose stored records through list', async () => {
      const created = await store.create(makeInput());
      const listed = await store.list();
      expect(listed).toHaveLength(1);

      Reflect.set(listed[0], 'status', 'active');
      Reflect.set(listed[0], 'displayName', 'Tampered');

      await expect(store.get(created.promotionId)).resolves.toMatchObject({
        status: 'draft',
        displayName: 'Test Promo',
      });
      await expect(store.list({ status: 'active' })).resolves.toEqual([]);
    });
  });

  // ── update ────────────────────────────────────────────────────

  describe('update', () => {
    it('returns null for non-existent promotion', async () => {
      const result = await store.update('non-existent', { displayName: 'X' });
      expect(result).toBeNull();
    });

    it('updates only specified fields', async () => {
      const created = await store.create(makeInput());
      const updated = await store.update(created.promotionId, {
        displayName: 'Updated Name',
        maxParticipants: 200,
      });

      expect(updated).not.toBeNull();
      expect(updated!.displayName).toBe('Updated Name');
      expect(updated!.maxParticipants).toBe(200);
      // Unchanged fields preserved
      expect(updated!.description).toBe('A test promotion');
      expect(updated!.perUserGasAllowanceMist).toBe('10000000');
      // updatedAt is set
      expect(updated!.updatedAt).toBeTruthy();
    });

    it('allows setting claimDeadlineAt to null', async () => {
      const created = await store.create(makeInput({ claimDeadlineAt: '2025-12-31T00:00:00Z' }));
      const updated = await store.update(created.promotionId, { claimDeadlineAt: null });
      expect(updated!.claimDeadlineAt).toBeNull();
    });

    it('does not expose the stored record through the update result', async () => {
      const created = await store.create(makeInput());
      const updated = await store.update(created.promotionId, { displayName: 'Updated' });
      expect(updated).not.toBeNull();

      Reflect.set(updated!, 'status', 'archived');
      Reflect.set(updated!, 'displayName', 'Tampered');

      await expect(store.get(created.promotionId)).resolves.toMatchObject({
        status: 'draft',
        displayName: 'Updated',
      });
    });

    it('ignores undeclared runtime fields instead of replacing record identity or status', async () => {
      const created = await store.create(makeInput());
      const unsafeInput = {
        displayName: 'Allowed update',
        promotionId: 'attacker-controlled-id',
        status: 'archived',
      } as unknown as UpdatePromotionInput;

      const updated = await store.update(created.promotionId, unsafeInput);

      expect(updated).toMatchObject({
        promotionId: created.promotionId,
        status: 'draft',
        displayName: 'Allowed update',
      });
      await expect(store.get('attacker-controlled-id')).resolves.toBeNull();
      await expect(store.get(created.promotionId)).resolves.toMatchObject({
        promotionId: created.promotionId,
        status: 'draft',
        displayName: 'Allowed update',
      });
    });

    // ── Immutable-after-draft fields ──────────────────────────────

    it('rejects economic-field update on active promotion', async () => {
      const created = await store.create(makeInput());
      await store.transitionStatus(created.promotionId, 'active');
      await expect(store.update(created.promotionId, { maxParticipants: 200 })).rejects.toThrow(
        PromotionFieldImmutableError,
      );
    });

    it('rejects perUserGasAllowanceMist update on active promotion', async () => {
      const created = await store.create(makeInput());
      await store.transitionStatus(created.promotionId, 'active');
      await expect(
        store.update(created.promotionId, { perUserGasAllowanceMist: '99999999' }),
      ).rejects.toThrow(PromotionFieldImmutableError);
    });

    it('rejects claimDeadlineAt update on paused promotion', async () => {
      const created = await store.create(makeInput());
      await store.transitionStatus(created.promotionId, 'active');
      await store.transitionStatus(created.promotionId, 'paused');
      await expect(
        store.update(created.promotionId, { claimDeadlineAt: '2099-01-01T00:00:00Z' }),
      ).rejects.toThrow(PromotionFieldImmutableError);
    });

    it('rejects startAt update on active promotion', async () => {
      const created = await store.create(makeInput());
      await store.transitionStatus(created.promotionId, 'active');
      await expect(
        store.update(created.promotionId, { startAt: '2099-01-01T00:00:00Z' }),
      ).rejects.toThrow(PromotionFieldImmutableError);
    });

    it('allows displayName/description update on active promotion', async () => {
      const created = await store.create(makeInput());
      await store.transitionStatus(created.promotionId, 'active');
      const updated = await store.update(created.promotionId, {
        displayName: 'Renamed',
        description: 'new desc',
      });
      expect(updated!.displayName).toBe('Renamed');
      expect(updated!.description).toBe('new desc');
      expect(updated!.maxParticipants).toBe(100);
    });

    it('reports all attempted immutable fields in the error', async () => {
      const created = await store.create(makeInput());
      await store.transitionStatus(created.promotionId, 'active');
      try {
        await store.update(created.promotionId, {
          maxParticipants: 1,
          perUserGasAllowanceMist: '1',
          displayName: 'ok',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(PromotionFieldImmutableError);
        const immutable = (err as PromotionFieldImmutableError).fields;
        expect(immutable).toEqual(['maxParticipants', 'perUserGasAllowanceMist']);
      }
    });
  });

  // ── transitionStatus ──────────────────────────────────────────

  describe('transitionStatus', () => {
    it('returns null for non-existent promotion', async () => {
      const result = await store.transitionStatus('non-existent', 'active');
      expect(result).toBeNull();
    });

    it('draft → active', async () => {
      const created = await store.create(makeInput());
      const result = await store.transitionStatus(created.promotionId, 'active');
      expect(result!.status).toBe('active');
    });

    it('active → paused (with reason)', async () => {
      const created = await store.create(makeInput());
      await store.transitionStatus(created.promotionId, 'active');
      const result = await store.transitionStatus(created.promotionId, 'paused', 'Budget review');
      expect(result!.status).toBe('paused');
      expect(result!.pauseReason).toBe('Budget review');
    });

    it('paused → active (preserves pauseReason)', async () => {
      const created = await store.create(makeInput());
      await store.transitionStatus(created.promotionId, 'active');
      await store.transitionStatus(created.promotionId, 'paused', 'Temp pause');
      const result = await store.transitionStatus(created.promotionId, 'active');
      expect(result!.status).toBe('active');
      // pauseReason is preserved across active <-> paused transitions.
      expect(result!.pauseReason).toBe('Temp pause');
    });

    it('active → archived (with reason)', async () => {
      const created = await store.create(makeInput());
      await store.transitionStatus(created.promotionId, 'active');
      const result = await store.transitionStatus(
        created.promotionId,
        'archived',
        'Campaign ended',
      );
      expect(result!.status).toBe('archived');
      expect(result!.archiveReason).toBe('Campaign ended');
    });

    it('paused → archived', async () => {
      const created = await store.create(makeInput());
      await store.transitionStatus(created.promotionId, 'active');
      await store.transitionStatus(created.promotionId, 'paused');
      const result = await store.transitionStatus(created.promotionId, 'archived');
      expect(result!.status).toBe('archived');
    });

    it('does not expose the stored record through the transition result', async () => {
      const created = await store.create(makeInput());
      const transitioned = await store.transitionStatus(created.promotionId, 'active');
      expect(transitioned).not.toBeNull();

      Reflect.set(transitioned!, 'status', 'archived');
      Reflect.set(transitioned!, 'displayName', 'Tampered');

      await expect(store.get(created.promotionId)).resolves.toMatchObject({
        status: 'active',
        displayName: 'Test Promo',
      });
    });

    it('throws on invalid transitions', async () => {
      const created = await store.create(makeInput());

      // draft → paused (invalid)
      await expect(store.transitionStatus(created.promotionId, 'paused')).rejects.toThrow(
        InvalidStatusTransitionError,
      );

      // draft → archived (invalid)
      await expect(store.transitionStatus(created.promotionId, 'archived')).rejects.toThrow(
        InvalidStatusTransitionError,
      );
    });

    it('throws on archived → any (terminal)', async () => {
      const created = await store.create(makeInput());
      await store.transitionStatus(created.promotionId, 'active');
      await store.transitionStatus(created.promotionId, 'archived');

      await expect(store.transitionStatus(created.promotionId, 'active')).rejects.toThrow(
        InvalidStatusTransitionError,
      );
    });

    it('blocks activation with maxParticipants=0 for gas_sponsorship', async () => {
      const created = await store.create(makeInput({ maxParticipants: 0 }));
      await expect(store.transitionStatus(created.promotionId, 'active')).rejects.toThrow(
        PromotionActivationError,
      );
    });

    it('blocks activation with perUserGasAllowanceMist=0 for gas_sponsorship', async () => {
      const created = await store.create(makeInput({ perUserGasAllowanceMist: '0' }));
      await expect(store.transitionStatus(created.promotionId, 'active')).rejects.toThrow(
        PromotionActivationError,
      );
    });

    it('blocks activation with non-decimal perUserGasAllowanceMist', async () => {
      const created = await store.create(makeInput({ perUserGasAllowanceMist: '0x10' }));
      await expect(store.transitionStatus(created.promotionId, 'active')).rejects.toThrow(
        PromotionActivationError,
      );
    });
  });

  // ── delete ────────────────────────────────────────────────────

  describe('delete', () => {
    it('returns false for non-existent promotion', async () => {
      const result = await store.delete('non-existent');
      expect(result).toBe(false);
    });

    it('deletes a draft promotion', async () => {
      const created = await store.create(makeInput());
      const result = await store.delete(created.promotionId);
      expect(result).toBe(true);

      const found = await store.get(created.promotionId);
      expect(found).toBeNull();
    });

    it('refuses to delete non-draft promotions', async () => {
      const created = await store.create(makeInput());
      await store.transitionStatus(created.promotionId, 'active');

      const result = await store.delete(created.promotionId);
      expect(result).toBe(false);

      // Record still exists
      const found = await store.get(created.promotionId);
      expect(found).not.toBeNull();
    });
  });
});

// ── isValidTransition ───────────────────────────────────────────

describe('isValidTransition', () => {
  const validCases: [PromotionStatus, PromotionStatus][] = [
    ['draft', 'active'],
    ['active', 'paused'],
    ['active', 'archived'],
    ['paused', 'active'],
    ['paused', 'archived'],
  ];

  const invalidCases: [PromotionStatus, PromotionStatus][] = [
    ['draft', 'paused'],
    ['draft', 'archived'],
    ['draft', 'draft'],
    ['active', 'draft'],
    ['active', 'active'],
    ['paused', 'draft'],
    ['paused', 'paused'],
    ['archived', 'draft'],
    ['archived', 'active'],
    ['archived', 'paused'],
    ['archived', 'archived'],
  ];

  it.each(validCases)('%s → %s is valid', (from, to) => {
    expect(isValidTransition(from, to)).toBe(true);
  });

  it.each(invalidCases)('%s → %s is invalid', (from, to) => {
    expect(isValidTransition(from, to)).toBe(false);
  });
});

// ── computeTotalRequiredBudgetMist ─────────────────────────────────────

describe('computeTotalRequiredBudgetMist', () => {
  it('returns maxParticipants * perUserGasAllowanceMist', () => {
    expect(
      computeTotalRequiredBudgetMist({
        maxParticipants: 100,
        perUserGasAllowanceMist: '10000000',
      }),
    ).toBe('1000000000');
  });

  it('rejects maxParticipants=0 as outside the current finite promotion contract', () => {
    expect(() =>
      computeTotalRequiredBudgetMist({
        maxParticipants: 0,
        perUserGasAllowanceMist: '10000000',
      }),
    ).toThrow('maxParticipants must be a positive safe integer');
  });

  it('handles large values without overflow', () => {
    // 1M participants * 1 SUI each = 1M SUI = 1e15 MIST
    expect(
      computeTotalRequiredBudgetMist({
        maxParticipants: 1_000_000,
        perUserGasAllowanceMist: '1000000000',
      }),
    ).toBe('1000000000000000');
  });

  it('rejects unsafe participants and non-decimal allowance values', () => {
    expect(() =>
      computeTotalRequiredBudgetMist({
        maxParticipants: Number.MAX_SAFE_INTEGER + 1,
        perUserGasAllowanceMist: '1000000000',
      }),
    ).toThrow('maxParticipants');
    expect(() =>
      computeTotalRequiredBudgetMist({
        maxParticipants: 1,
        perUserGasAllowanceMist: '0x10',
      }),
    ).toThrow('perUserGasAllowanceMist');
  });
});
