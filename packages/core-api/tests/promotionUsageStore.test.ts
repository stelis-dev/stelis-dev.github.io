import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryPromotionUsageStore,
  type PromotionUsageStoreAdapter,
} from '../src/studio/promotionUsageStore.js';
import type { CreateUsageEventInput } from '../src/studio/domain.js';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const PROMO_ID = 'usage-promo-1';
const USER_ID = 'usage-user-1';
const SENDER_ADDR = '0xUsageAddr1';

function makeInput(overrides: Partial<CreateUsageEventInput> = {}): CreateUsageEventInput {
  return {
    promotionId: PROMO_ID,
    userId: USER_ID,
    senderAddress: SENDER_ADDR,
    receiptId: 'usage-r-1',
    txDigest: null,
    reservedGasMist: '3000000',
    consumedGasMist: '0',
    releasedGasMist: '0',
    result: 'reserved',
    failureReason: null,
    policyCheckResult: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('MemoryPromotionUsageStore', () => {
  let store: PromotionUsageStoreAdapter;

  beforeEach(() => {
    store = new MemoryPromotionUsageStore();
  });

  // ── Append ───────────────────────────────────

  describe('append', () => {
    it('appends an event and populates createdAt', async () => {
      const event = await store.append(makeInput());
      expect(event.promotionId).toBe(PROMO_ID);
      expect(event.userId).toBe(USER_ID);
      expect(event.result).toBe('reserved');
      expect(event.createdAt).toBeTruthy();
      expect(new Date(event.createdAt).getTime()).toBeGreaterThan(0);
    });

    it('deduplicates by receiptId + result', async () => {
      const first = await store.append(makeInput());
      const second = await store.append(makeInput());
      expect(second.createdAt).toBe(first.createdAt);

      // Only one entry should exist
      const events = await store.getByReceipt('usage-r-1');
      expect(events.length).toBe(1);
    });

    it('allows different results for same receiptId', async () => {
      await store.append(makeInput({ result: 'reserved' }));
      await store.append(
        makeInput({
          result: 'consumed',
          consumedGasMist: '2000000',
          releasedGasMist: '1000000',
        }),
      );

      const events = await store.getByReceipt('usage-r-1');
      expect(events.length).toBe(2);
      expect(events[0].result).toBe('reserved');
      expect(events[1].result).toBe('consumed');
    });

    it('records failure events with reason', async () => {
      const event = await store.append(
        makeInput({
          receiptId: 'usage-fail-1',
          result: 'failed',
          failureReason: 'budget_insufficient',
        }),
      );
      expect(event.result).toBe('failed');
      expect(event.failureReason).toBe('budget_insufficient');
    });
  });

  // ── Query by Receipt ─────────────────────────

  describe('getByReceipt', () => {
    it('returns events in chronological order', async () => {
      await store.append(makeInput({ receiptId: 'chrono-1', result: 'reserved' }));
      await store.append(
        makeInput({
          receiptId: 'chrono-1',
          result: 'consumed',
          consumedGasMist: '2000000',
        }),
      );
      await store.append(
        makeInput({
          receiptId: 'chrono-1',
          result: 'released',
          releasedGasMist: '1000000',
        }),
      );

      const events = await store.getByReceipt('chrono-1');
      expect(events.length).toBe(3);
      expect(events[0].result).toBe('reserved');
      expect(events[1].result).toBe('consumed');
      expect(events[2].result).toBe('released');
    });

    it('returns empty for nonexistent receipt', async () => {
      const events = await store.getByReceipt('nonexistent');
      expect(events.length).toBe(0);
    });
  });

  // ── Query by User ────────────────────────────

  describe('getByUser', () => {
    it('returns events in reverse-chronological order', async () => {
      await store.append(makeInput({ receiptId: 'u-1', result: 'reserved' }));
      await store.append(makeInput({ receiptId: 'u-2', result: 'reserved' }));
      await store.append(makeInput({ receiptId: 'u-3', result: 'reserved' }));

      const events = await store.getByUser(PROMO_ID, USER_ID);
      expect(events.length).toBe(3);
      expect(events[0].receiptId).toBe('u-3');
      expect(events[1].receiptId).toBe('u-2');
      expect(events[2].receiptId).toBe('u-1');
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await store.append(makeInput({ receiptId: `lim-${i}`, result: 'reserved' }));
      }

      const events = await store.getByUser(PROMO_ID, USER_ID, 3);
      expect(events.length).toBe(3);
    });

    it('isolates by promotionId + userId', async () => {
      await store.append(makeInput({ receiptId: 'iso-1', userId: 'user-a' }));
      await store.append(makeInput({ receiptId: 'iso-2', userId: 'user-b' }));

      const eventsA = await store.getByUser(PROMO_ID, 'user-a');
      expect(eventsA.length).toBe(1);
      expect(eventsA[0].receiptId).toBe('iso-1');

      const eventsB = await store.getByUser(PROMO_ID, 'user-b');
      expect(eventsB.length).toBe(1);
      expect(eventsB[0].receiptId).toBe('iso-2');
    });
  });

  // ── Query by Promotion ───────────────────────

  describe('getByPromotion', () => {
    it('returns all events for a promotion', async () => {
      await store.append(makeInput({ receiptId: 'p-1', userId: 'u1' }));
      await store.append(makeInput({ receiptId: 'p-2', userId: 'u2' }));

      const events = await store.getByPromotion(PROMO_ID);
      expect(events.length).toBe(2);
    });

    it('isolates by promotionId', async () => {
      await store.append(makeInput({ receiptId: 'iso-p1', promotionId: 'promo-a' }));
      await store.append(makeInput({ receiptId: 'iso-p2', promotionId: 'promo-b' }));

      expect((await store.getByPromotion('promo-a')).length).toBe(1);
      expect((await store.getByPromotion('promo-b')).length).toBe(1);
    });
  });

  // ── TTL / Retention ──────────────────────────

  describe('retention', () => {
    it('sweeps events older than retention window', async () => {
      // Create store with very short retention (1ms)
      const shortStore = new MemoryPromotionUsageStore(1);
      await shortStore.append(makeInput({ receiptId: 'old-1' }));

      // Wait a tiny bit for the event to expire
      await new Promise((resolve) => setTimeout(resolve, 5));

      const events = await shortStore.getByReceipt('old-1');
      expect(events.length).toBe(0);
    });
  });

  // ── Lifecycle ────────────────────────────────

  describe('full sponsored action lifecycle', () => {
    it('records reserve → consume lifecycle', async () => {
      // Reserve
      await store.append(
        makeInput({
          receiptId: 'lifecycle-1',
          result: 'reserved',
          reservedGasMist: '3000000',
        }),
      );

      // Consume with delta
      await store.append(
        makeInput({
          receiptId: 'lifecycle-1',
          result: 'consumed',
          consumedGasMist: '2000000',
          releasedGasMist: '1000000',
          txDigest: '0xDIGEST123',
        }),
      );

      const events = await store.getByReceipt('lifecycle-1');
      expect(events.length).toBe(2);
      expect(events[0].result).toBe('reserved');
      expect(events[0].txDigest).toBeNull();
      expect(events[1].result).toBe('consumed');
      expect(events[1].txDigest).toBe('0xDIGEST123');
      expect(events[1].consumedGasMist).toBe('2000000');
      expect(events[1].releasedGasMist).toBe('1000000');
    });

    it('records reserve → release lifecycle (failure path)', async () => {
      await store.append(
        makeInput({
          receiptId: 'lifecycle-2',
          result: 'reserved',
          reservedGasMist: '3000000',
        }),
      );

      await store.append(
        makeInput({
          receiptId: 'lifecycle-2',
          result: 'released',
          releasedGasMist: '3000000',
        }),
      );

      const events = await store.getByReceipt('lifecycle-2');
      expect(events.length).toBe(2);
      expect(events[0].result).toBe('reserved');
      expect(events[1].result).toBe('released');
      expect(events[1].releasedGasMist).toBe('3000000');
    });
  });
});
