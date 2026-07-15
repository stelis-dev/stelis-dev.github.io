/**
 * RedisPromotionExecutionLedger — conformance tests.
 *
 * Runs the shared conformance suite against the Redis implementation.
 * Uses redis-memory-server for isolated test instances.
 * Redis startup failure is a test failure; this file is part of the
 * non-skippable real Redis authority behind `test:redis`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisPromotionExecutionLedger } from '../src/studio/executionLedgerRedis.js';
import { RedisPromotionStore } from '../src/studio/promotionStore.js';
import { runLedgerConformanceTests } from './executionLedger.conformance.js';
import { startRealRedis, type RealRedisHandle } from '../src/testing/redis.js';

describe('RedisPromotionExecutionLedger — real Redis conformance', () => {
  let redis: RealRedisHandle | null = null;

  beforeAll(async () => {
    redis = await startRealRedis();
  });

  afterAll(async () => {
    await redis?.stop();
  });

  runLedgerConformanceTests(
    // Normal factory: fresh Redis state per test via FLUSHDB
    async () => {
      await redis!.flush();
      const client = redis!.client;
      // Disable reaper (very long interval) for normal tests
      return new RedisPromotionExecutionLedger(client, 60_000, 999_999_999);
    },
    // Sweep factory: TTL=0 so reservations expire immediately
    async () => {
      await redis!.flush();
      const client = redis!.client;
      return new RedisPromotionExecutionLedger(client, 0, 999_999_999);
    },
  );

  describe('Promotion list ledger status batch', () => {
    beforeEach(async () => {
      await redis!.flush();
    });

    it('loads the bounded page through exactly one Redis EVAL', async () => {
      const client = redis!.client;
      const ledger = new RedisPromotionExecutionLedger(client, 60_000, 999_999_999);
      const promotionId = '00000000-0000-4000-8000-000000000001';
      await ledger.claim(promotionId, 'user-a', {
        maxParticipants: 2,
        perUserGasAllowanceMist: '5000000',
        useUntilAt: null,
      });

      const evalSpy = vi.spyOn(client, 'eval');
      try {
        const statuses = await ledger.getPromotionListLedgerStatuses([promotionId], 'user-a');
        expect(statuses).toHaveLength(1);
        expect(statuses[0]?.promotionId).toBe(promotionId);
        expect(evalSpy).toHaveBeenCalledTimes(1);
      } finally {
        evalSpy.mockRestore();
      }
    });

    it('returns null entitlement and zero budget for an active promotion without ledger keys', async () => {
      const client = redis!.client;
      const store = new RedisPromotionStore(client);
      const promotion = await store.create({
        type: 'gas_sponsorship',
        displayName: 'Unclaimed active promotion',
        maxParticipants: 2,
        perUserGasAllowanceMist: '5000000',
      });
      await store.transitionStatus(promotion.promotionId, 'active');
      const ledger = new RedisPromotionExecutionLedger(client, 60_000, 999_999_999);

      const statuses = await ledger.getPromotionListLedgerStatuses(
        [promotion.promotionId],
        'user-without-claim',
      );

      expect(statuses).toEqual([
        {
          promotionId: promotion.promotionId,
          entitlement: null,
          claimedCount: 0,
          availableBudgetMist: 0n,
        },
      ]);
    });
  });

  describe('reserve — Redis reservation TTL', () => {
    beforeEach(async () => {
      await redis!.flush();
    });

    it('stores the reservation coordination record with a physical TTL', async () => {
      const client = redis!.client;
      const ledger = new RedisPromotionExecutionLedger(client, 100, 999_999_999);

      await ledger.claim('ttl-promo', 'ttl-user', {
        maxParticipants: 1,
        perUserGasAllowanceMist: '5000000',
        useUntilAt: null,
      });
      const reserve = await ledger.reserve({
        promotionId: 'ttl-promo',
        userId: 'ttl-user',
        receiptId: 'ttl-receipt',
        amountMist: 1_000_000n,
      });
      expect(reserve.ok).toBe(true);

      const pttl = Number(
        await redis!.rawClient.sendCommand([
          'PTTL',
          'stelis:promotion_execution_ledger:res:ttl-receipt',
        ]),
      );
      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(120_100);
    });
  });

  // ─────────────────────────────────────────────
  // Redis claim status re-check
  // ─────────────────────────────────────────────

  describe('claim — promotion_not_active race closure (Redis-only)', () => {
    beforeEach(async () => {
      await redis!.flush();
    });

    it('rejects claim with promotion_not_active when canonical record has status !== "active"', async () => {
      const client = redis!.client;
      const store = new RedisPromotionStore(client);
      const record = await store.create({
        type: 'gas_sponsorship',
        displayName: 'D-test',
        description: 'race closure test',
        maxParticipants: 10,
        perUserGasAllowanceMist: '5000000',
        claimDeadlineAt: null,
        postClaimUseWindowMs: 0,
        startAt: null,
      });
      await store.transitionStatus(record.promotionId, 'active');
      // Admin flip: pause the promotion after activation.
      await store.transitionStatus(record.promotionId, 'paused');

      const ledger = new RedisPromotionExecutionLedger(
        client,
        60_000,
        999_999_999,
        undefined,
        (pid) => store.recordKey(pid),
      );

      const result = await ledger.claim(record.promotionId, 'user-race', {
        maxParticipants: 10,
        perUserGasAllowanceMist: '5000000',
        useUntilAt: null,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('promotion_not_active');

      // Side-effect assertion: claim index must remain empty — the Lua
      // script aborts BEFORE SET/SADD when status is not active.
      const count = await ledger.getClaimedCount(record.promotionId);
      expect(count).toBe(0);
    });

    it('rejects claim with promotion_not_active when canonical record is missing', async () => {
      const client = redis!.client;
      const store = new RedisPromotionStore(client);

      const ledger = new RedisPromotionExecutionLedger(
        client,
        60_000,
        999_999_999,
        undefined,
        (pid) => store.recordKey(pid),
      );

      const result = await ledger.claim('nonexistent-promo', 'user-x', {
        maxParticipants: 10,
        perUserGasAllowanceMist: '5000000',
        useUntilAt: null,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('promotion_not_active');
    });

    it('succeeds when canonical record has status === "active"', async () => {
      const client = redis!.client;
      const store = new RedisPromotionStore(client);
      const record = await store.create({
        type: 'gas_sponsorship',
        displayName: 'D-test-2',
        description: 'active passes',
        maxParticipants: 10,
        perUserGasAllowanceMist: '5000000',
        claimDeadlineAt: null,
        postClaimUseWindowMs: 0,
        startAt: null,
      });
      await store.transitionStatus(record.promotionId, 'active');

      const ledger = new RedisPromotionExecutionLedger(
        client,
        60_000,
        999_999_999,
        undefined,
        (pid) => store.recordKey(pid),
      );

      const result = await ledger.claim(record.promotionId, 'user-ok', {
        maxParticipants: 10,
        perUserGasAllowanceMist: '5000000',
        useUntilAt: null,
      });

      expect(result.ok).toBe(true);
    });
  });
});
