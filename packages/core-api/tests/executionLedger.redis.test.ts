/**
 * RedisPromotionExecutionLedger — conformance tests.
 *
 * Runs the shared conformance suite against the Redis implementation.
 * Uses redis-memory-server for isolated test instances.
 * Redis startup failure is a test failure; this file is part of the
 * non-skippable real Redis authority behind `test:redis`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PROMOTION_LEDGER_VALUE_MIST } from '@stelis/contracts';
import type { RedisClientLike } from '../src/store/redisClient.js';
import {
  RedisPromotionExecutionLedger,
  type RedisPromotionRecordAccess,
} from '../src/studio/executionLedgerRedis.js';
import { RedisPromotionStore } from '../src/studio/promotionStore.js';
import {
  decodePromotionOperationResultRecord,
  promotionAccountingKey,
  promotionEntitlementKey,
  promotionEntitlementKeyPrefix,
  promotionOperationResultKey,
  promotionOperationResultKeyPrefix,
  promotionReservationDeadlineIndexKey,
  promotionReservationKey,
  promotionReservationKeyPrefix,
  serializePromotionOperationResultRecord,
} from '../src/studio/promotionRecords.js';
import { runLedgerConformanceTests } from './executionLedger.conformance.js';
import { startRealRedis, type RealRedisHandle } from '../src/testing/redis.js';
import {
  createRedisPromotionLedgerStore,
  PAGE_PROMO_A,
  PROMO_ID,
} from './helpers/promotionLedgerFixture.js';

function interceptEval(
  base: RedisClientLike,
  intercept: (script: string, keys: string[], args: string[]) => Promise<void>,
): RedisClientLike {
  return {
    get: (key) => base.get(key),
    set: (key, value, options) => base.set(key, value, options),
    del: (...keys) => base.del(...keys),
    hgetall: (key) => base.hgetall(key),
    async eval(script, keys, args) {
      await intercept(script, keys, args);
      return base.eval(script, keys, args);
    },
  };
}

function interceptEvalAfter(
  base: RedisClientLike,
  intercept: (script: string, keys: string[], args: string[]) => Promise<void>,
): RedisClientLike {
  return {
    get: (key) => base.get(key),
    set: (key, value, options) => base.set(key, value, options),
    del: (...keys) => base.del(...keys),
    hgetall: (key) => base.hgetall(key),
    async eval(script, keys, args) {
      const result = await base.eval(script, keys, args);
      await intercept(script, keys, args);
      return result;
    },
  };
}

function isClaimMutation(keys: readonly string[]): boolean {
  return (
    keys.length === 3 &&
    keys[1] === promotionAccountingKey(PROMO_ID) &&
    keys[2]?.startsWith(promotionEntitlementKeyPrefix(PROMO_ID)) === true
  );
}

function isReserveMutation(keys: readonly string[]): boolean {
  return (
    keys.length === 6 &&
    keys[3]?.startsWith(promotionReservationKeyPrefix()) === true &&
    keys[4]?.startsWith(promotionOperationResultKeyPrefix()) === true &&
    keys[5] === promotionReservationDeadlineIndexKey()
  );
}

function isFinalizeMutation(keys: readonly string[]): boolean {
  return (
    keys.length === 6 &&
    keys[0]?.startsWith(promotionReservationKeyPrefix()) === true &&
    keys[1]?.startsWith(promotionOperationResultKeyPrefix()) === true &&
    keys[2] === promotionReservationDeadlineIndexKey()
  );
}

async function readBudget(
  ledger: RedisPromotionExecutionLedger,
  promotionId: string,
): Promise<{ availableMist: bigint; reservedMist: bigint; consumedMist: bigint }> {
  return (await ledger.getPromotionLedgerStatus(promotionId, null)).budget;
}

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
      const store = await createRedisPromotionLedgerStore(client);
      return new RedisPromotionExecutionLedger(client, store, 60_000, 0);
    },
    // Sweep factory: TTL=0 so reservations expire immediately
    async () => {
      await redis!.flush();
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      return new RedisPromotionExecutionLedger(client, store, 0, 0);
    },
  );

  describe('Promotion list ledger status batch', () => {
    beforeEach(async () => {
      await redis!.flush();
    });

    it('loads one bounded Redis snapshot in input order without per-Promotion reads', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const setupLedger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await setupLedger.claim(PROMO_ID, 'user-a', { useUntilAt: null });
      let evalCalls = 0;
      let currentReads = 0;
      const observedClient = interceptEval(client, async () => {
        evalCalls += 1;
      });
      const observedStore: RedisPromotionRecordAccess = {
        recordKey: (promotionId) => store.recordKey(promotionId),
        async readCurrent(promotionId) {
          currentReads += 1;
          return store.readCurrent(promotionId);
        },
      };
      const ledger = new RedisPromotionExecutionLedger(observedClient, observedStore, 60_000, 0);

      const statuses = await ledger.getPromotionListLedgerStatuses(
        [PAGE_PROMO_A, PROMO_ID],
        'user-a',
      );
      expect(statuses.map((status) => status.promotionId)).toEqual([PAGE_PROMO_A, PROMO_ID]);
      expect(statuses[1]?.entitlement?.userId).toBe('user-a');
      expect(evalCalls).toBe(1);
      expect(currentReads).toBe(0);
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
      const ledger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);

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

    it('rejects entitlement and list reads when entitlement exists without accounting', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await ledger.claim(PROMO_ID, 'read-partial-user', { useUntilAt: null });
      await client.del(promotionAccountingKey(PROMO_ID));

      await expect(ledger.getEntitlement(PROMO_ID, 'read-partial-user')).rejects.toThrow(
        'entitlement exists without accounting',
      );
      await expect(ledger.getPromotionLedgerStatus(PROMO_ID, 'read-partial-user')).rejects.toThrow(
        'entitlement exists without accounting',
      );
      await expect(
        ledger.getPromotionListLedgerStatuses([PROMO_ID], 'read-partial-user'),
      ).rejects.toThrow('entitlement exists without accounting');
    });

    it('rejects entitlement and list reads when accounting contradicts Promotion economics', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await ledger.claim(PROMO_ID, 'read-economics-user', { useUntilAt: null });
      await redis!.rawClient.sendCommand([
        'HSET',
        promotionAccountingKey(PROMO_ID),
        'maxParticipants',
        '9',
        'totalBudgetMist',
        '45000000',
        'availableMist',
        '45000000',
      ]);

      await expect(ledger.getEntitlement(PROMO_ID, 'read-economics-user')).rejects.toThrow(
        'does not match the current Promotion economics',
      );
      await expect(ledger.getPromotionLedgerStatus(PROMO_ID, null)).rejects.toThrow(
        'does not match the current Promotion economics',
      );
      await expect(
        ledger.getPromotionListLedgerStatuses([PROMO_ID], 'read-economics-user'),
      ).rejects.toThrow('does not match the current Promotion economics');
    });
  });

  describe('reserve — Redis deadline index', () => {
    beforeEach(async () => {
      await redis!.flush();
    });

    it('stores a durable reservation and its Redis-time deadline index member', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 100, 0);

      await ledger.claim(PROMO_ID, 'ttl-user', { useUntilAt: null });
      const reserve = await ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'ttl-user',
        receiptId: 'ttl-receipt',
        amountMist: 1_000_000n,
      });
      expect(reserve.ok).toBe(true);

      await expect(
        redis!.client.get('stelis:promotion_execution_ledger:reservation:ttl-receipt'),
      ).resolves.not.toBeNull();
      const score = await redis!.rawClient.sendCommand([
        'ZSCORE',
        'stelis:promotion_execution_ledger:reservation:deadlines',
        'ttl-receipt',
      ]);
      expect(Number(score)).toBeGreaterThan(0);
    });

    it('keeps Promotion ledger identity and final-result records independent from key TTLs', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      const userId = 'permanent-record-user';
      const receiptId = 'permanent-record-receipt';

      await ledger.claim(PROMO_ID, userId, { useUntilAt: null });
      await ledger.reserve({
        promotionId: PROMO_ID,
        userId,
        receiptId,
        amountMist: 100n,
      });

      for (const key of [
        store.recordKey(PROMO_ID),
        promotionAccountingKey(PROMO_ID),
        promotionEntitlementKey(PROMO_ID, userId),
        promotionReservationKey(receiptId),
      ]) {
        expect(Number(await redis!.rawClient.sendCommand(['PTTL', key]))).toBe(-1);
      }

      await expect(ledger.consume(receiptId, 50n)).resolves.toMatchObject({ ok: true });
      expect(
        Number(await redis!.rawClient.sendCommand(['PTTL', promotionReservationKey(receiptId)])),
      ).toBe(-2);
      expect(
        Number(
          await redis!.rawClient.sendCommand(['PTTL', promotionOperationResultKey(receiptId)]),
        ),
      ).toBe(-1);
    });

    it('rejects an unsafe Redis-time deadline before mutating ledger state', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, Number.MAX_SAFE_INTEGER, 0);
      await ledger.claim(PROMO_ID, 'unsafe-deadline-user', { useUntilAt: null });
      const budgetBefore = await readBudget(ledger, PROMO_ID);

      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: 'unsafe-deadline-user',
          receiptId: 'unsafe-deadline-receipt',
          amountMist: 100n,
        }),
      ).rejects.toThrow('reservation deadline exceeds the safe integer range');
      await expect(readBudget(ledger, PROMO_ID)).resolves.toEqual(budgetBefore);
      await expect(ledger.getEntitlement(PROMO_ID, 'unsafe-deadline-user')).resolves.toMatchObject({
        activeReservationReceiptId: null,
        activeReservationAmountMist: null,
      });
      await expect(
        client.get(promotionReservationKey('unsafe-deadline-receipt')),
      ).resolves.toBeNull();
      await expect(
        redis!.rawClient.sendCommand([
          'ZSCORE',
          promotionReservationDeadlineIndexKey(),
          'unsafe-deadline-receipt',
        ]),
      ).resolves.toBeNull();
    });
  });

  describe('strict current records and atomic races', () => {
    beforeEach(async () => {
      await redis!.flush();
    });

    it.each([
      { deleted: 'accounting' as const, targetUser: 'new-user' },
      { deleted: 'entitlement' as const, targetUser: 'existing-user' },
    ])('treats deletion of observed $deleted as corruption', async ({ deleted, targetUser }) => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const setupLedger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await setupLedger.claim(PROMO_ID, 'existing-user', { useUntilAt: null });

      let injected = false;
      const racingClient = interceptEval(client, async (_script, keys) => {
        if (injected || !isClaimMutation(keys)) return;
        injected = true;
        await client.del(
          deleted === 'accounting'
            ? promotionAccountingKey(PROMO_ID)
            : promotionEntitlementKey(PROMO_ID, targetUser),
        );
      });
      const ledger = new RedisPromotionExecutionLedger(racingClient, store, 60_000, 0);

      await expect(ledger.claim(PROMO_ID, targetUser, { useUntilAt: null })).rejects.toThrow(
        'corrupt accounting state',
      );
      await expect(client.hgetall(promotionEntitlementKey(PROMO_ID, targetUser))).resolves.toEqual(
        {},
      );
    });

    it('rejects an impossible persisted accounting record before any claim', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const setupLedger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await setupLedger.claim(PROMO_ID, 'zero-count-user', { useUntilAt: null });
      await client.del(promotionEntitlementKey(PROMO_ID, 'zero-count-user'));
      await redis!.rawClient.sendCommand([
        'HSET',
        promotionAccountingKey(PROMO_ID),
        'claimedCount',
        '0',
      ]);

      await expect(setupLedger.claim(PROMO_ID, 'next-user', { useUntilAt: null })).rejects.toThrow(
        'Persisted Promotion accounting claimedCount must be positive',
      );
      await expect(setupLedger.getPromotionLedgerStatus(PROMO_ID, null)).rejects.toThrow(
        'Persisted Promotion accounting claimedCount must be positive',
      );
    });

    it('returns record_changed when another first claim wins the exact-state CAS', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const winningLedger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      let injected = false;
      const racingClient = interceptEval(client, async (_script, keys) => {
        if (!injected && isClaimMutation(keys)) {
          injected = true;
          await winningLedger.claim(PROMO_ID, 'winner-user', { useUntilAt: null });
        }
      });
      const losingLedger = new RedisPromotionExecutionLedger(racingClient, store, 60_000, 0);

      await expect(
        losingLedger.claim(PROMO_ID, 'loser-user', { useUntilAt: null }),
      ).resolves.toEqual({ ok: false, reason: 'record_changed' });
      await expect(losingLedger.getPromotionLedgerStatus(PROMO_ID, null)).resolves.toMatchObject({
        claimedCount: 1,
      });
      await expect(
        winningLedger.claim(PROMO_ID, 'loser-user', { useUntilAt: null }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('returns record_changed when an active Promotion is edited during claim', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      let updated = false;
      const racingStore: RedisPromotionRecordAccess = {
        recordKey: (promotionId) => store.recordKey(promotionId),
        async readCurrent(promotionId) {
          const current = await store.readCurrent(promotionId);
          if (current && !updated) {
            updated = true;
            await store.update(promotionId, { displayName: 'Updated while claiming' });
          }
          return current;
        },
      };
      const ledger = new RedisPromotionExecutionLedger(client, racingStore, 60_000, 0);

      await expect(
        ledger.claim(PROMO_ID, 'active-update-user', { useUntilAt: null }),
      ).resolves.toEqual({ ok: false, reason: 'record_changed' });
      await expect(ledger.getPromotionLedgerStatus(PROMO_ID, null)).resolves.toMatchObject({
        claimedCount: 0,
      });
    });

    it('closes the claim-vs-pause race without creating accounting', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      let paused = false;
      const racingStore: RedisPromotionRecordAccess = {
        recordKey: (promotionId) => store.recordKey(promotionId),
        async readCurrent(promotionId) {
          const current = await store.readCurrent(promotionId);
          if (current && !paused) {
            paused = true;
            await store.transitionStatus(promotionId, 'paused', 'test race');
          }
          return current;
        },
      };
      const ledger = new RedisPromotionExecutionLedger(client, racingStore, 60_000, 0);

      await expect(
        ledger.claim(PROMO_ID, 'claim-pause-user', { useUntilAt: null }),
      ).resolves.toEqual({ ok: false, reason: 'promotion_not_active' });
      await expect(ledger.getPromotionLedgerStatus(PROMO_ID, null)).resolves.toMatchObject({
        claimedCount: 0,
      });
      await expect(
        client.hgetall(promotionEntitlementKey(PROMO_ID, 'claim-pause-user')),
      ).resolves.toEqual({});
    });

    it('rejects a reserve when accounting changes after the TypeScript read', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const setupLedger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await setupLedger.claim(PROMO_ID, 'reserve-race-user', { useUntilAt: null });

      let injected = false;
      const racingClient = interceptEval(client, async (_script, keys) => {
        if (!injected && isReserveMutation(keys)) {
          injected = true;
          await setupLedger.claim(PROMO_ID, 'concurrent-claim-user', { useUntilAt: null });
        }
      });
      const ledger = new RedisPromotionExecutionLedger(racingClient, store, 60_000, 0);

      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: 'reserve-race-user',
          receiptId: 'reserve-race-receipt',
          amountMist: 100n,
        }),
      ).resolves.toEqual({ ok: false, reason: 'record_changed' });
      await expect(ledger.getEntitlement(PROMO_ID, 'reserve-race-user')).resolves.toMatchObject({
        activeReservationReceiptId: null,
      });
    });

    it('treats a missing reserve snapshot record as corruption rather than a conflict', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const setupLedger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await setupLedger.claim(PROMO_ID, 'reserve-missing-user', { useUntilAt: null });

      let injected = false;
      const racingClient = interceptEval(client, async (_script, keys) => {
        if (!injected && isReserveMutation(keys)) {
          injected = true;
          await client.del(promotionAccountingKey(PROMO_ID));
        }
      });
      const ledger = new RedisPromotionExecutionLedger(racingClient, store, 60_000, 0);

      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: 'reserve-missing-user',
          receiptId: 'reserve-missing-receipt',
          amountMist: 100n,
        }),
      ).rejects.toThrow('corrupt stored state');
    });

    it('returns record_changed when a conflicting receipt appears after the TypeScript read', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const setupLedger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await setupLedger.claim(PROMO_ID, 'requested-user', { useUntilAt: null });
      await setupLedger.claim(PROMO_ID, 'other-user', { useUntilAt: null });

      let injected = false;
      const racingClient = interceptEval(client, async (_script, keys) => {
        if (!injected && isReserveMutation(keys)) {
          injected = true;
          await setupLedger.reserve({
            promotionId: PROMO_ID,
            userId: 'other-user',
            receiptId: 'shared-receipt',
            amountMist: 99n,
          });
        }
      });
      const ledger = new RedisPromotionExecutionLedger(racingClient, store, 60_000, 0);

      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: 'requested-user',
          receiptId: 'shared-receipt',
          amountMist: 100n,
        }),
      ).resolves.toEqual({ ok: false, reason: 'record_changed' });
    });

    it('returns the atomic claim snapshot instead of a later entitlement read', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      let injected = false;
      const racingClient = interceptEvalAfter(client, async (_script, keys) => {
        if (!injected && isClaimMutation(keys)) {
          injected = true;
          await redis!.rawClient.sendCommand([
            'HSET',
            promotionEntitlementKey(PROMO_ID, 'snapshot-user'),
            'lastUsedAt',
            '2026-07-16T00:00:00.000Z',
          ]);
        }
      });
      const ledger = new RedisPromotionExecutionLedger(racingClient, store, 60_000, 0);

      const result = await ledger.claim(PROMO_ID, 'snapshot-user', { useUntilAt: null });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.entitlement.lastUsedAt).toBeNull();
      await expect(ledger.getEntitlement(PROMO_ID, 'snapshot-user')).resolves.toMatchObject({
        lastUsedAt: '2026-07-16T00:00:00.000Z',
      });
    });

    it('returns the atomic reserve snapshot instead of a later entitlement read', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const setupLedger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await setupLedger.claim(PROMO_ID, 'reserve-snapshot-user', { useUntilAt: null });

      let injected = false;
      const racingClient = interceptEvalAfter(client, async (_script, keys) => {
        if (!injected && isReserveMutation(keys)) {
          injected = true;
          await redis!.rawClient.sendCommand([
            'HSET',
            promotionEntitlementKey(PROMO_ID, 'reserve-snapshot-user'),
            'lastUsedAt',
            '2026-07-16T00:00:00.000Z',
          ]);
        }
      });
      const ledger = new RedisPromotionExecutionLedger(racingClient, store, 60_000, 0);

      const result = await ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'reserve-snapshot-user',
        receiptId: 'reserve-snapshot-receipt',
        amountMist: 100n,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.entitlement.lastUsedAt).toBeNull();
      await expect(ledger.getEntitlement(PROMO_ID, 'reserve-snapshot-user')).resolves.toMatchObject(
        { lastUsedAt: '2026-07-16T00:00:00.000Z' },
      );
    });

    it('rejects accounting whose available plus reserved amount exceeds the total budget', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await ledger.claim(PROMO_ID, 'budget-user', { useUntilAt: null });
      await redis!.rawClient.sendCommand([
        'HSET',
        promotionAccountingKey(PROMO_ID),
        'reservedMist',
        '1',
      ]);

      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: 'budget-user',
          receiptId: 'budget-receipt',
          amountMist: 1n,
        }),
      ).rejects.toThrow('exceed the total budget');
    });

    it('closes the reserve-vs-pause race without mutating accounting', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const claimLedger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await claimLedger.claim(PROMO_ID, 'pause-user', { useUntilAt: null });
      const budgetBefore = await readBudget(claimLedger, PROMO_ID);

      let paused = false;
      const racingStore: RedisPromotionRecordAccess = {
        recordKey: (promotionId) => store.recordKey(promotionId),
        async readCurrent(promotionId) {
          const current = await store.readCurrent(promotionId);
          if (current && !paused) {
            paused = true;
            await store.transitionStatus(promotionId, 'paused', 'test race');
          }
          return current;
        },
      };
      const ledger = new RedisPromotionExecutionLedger(client, racingStore, 60_000, 0);

      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: 'pause-user',
          receiptId: 'pause-receipt',
          amountMist: 100n,
        }),
      ).resolves.toEqual({ ok: false, reason: 'promotion_not_active' });
      await expect(readBudget(claimLedger, PROMO_ID)).resolves.toEqual(budgetBefore);
    });

    it('returns record_changed when an active Promotion is edited during reserve', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const claimLedger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await claimLedger.claim(PROMO_ID, 'active-edit-user', { useUntilAt: null });
      const budgetBefore = await readBudget(claimLedger, PROMO_ID);

      let updated = false;
      const racingStore: RedisPromotionRecordAccess = {
        recordKey: (promotionId) => store.recordKey(promotionId),
        async readCurrent(promotionId) {
          const current = await store.readCurrent(promotionId);
          if (current && !updated) {
            updated = true;
            await store.update(promotionId, { description: 'Updated while reserving' });
          }
          return current;
        },
      };
      const ledger = new RedisPromotionExecutionLedger(client, racingStore, 60_000, 0);

      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: 'active-edit-user',
          receiptId: 'active-edit-receipt',
          amountMist: 100n,
        }),
      ).resolves.toEqual({ ok: false, reason: 'record_changed' });
      await expect(readBudget(claimLedger, PROMO_ID)).resolves.toEqual(budgetBefore);
      await expect(client.get(promotionReservationKey('active-edit-receipt'))).resolves.toBeNull();
    });

    it.each(['paused', 'archived'] as const)(
      'returns an exact existing reservation after the Promotion becomes %s',
      async (status) => {
        const client = redis!.client;
        const store = await createRedisPromotionLedgerStore(client);
        const ledger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
        await ledger.claim(PROMO_ID, 'lifecycle-retry-user', { useUntilAt: null });
        const params = {
          promotionId: PROMO_ID,
          userId: 'lifecycle-retry-user',
          receiptId: `lifecycle-retry-${status}`,
          amountMist: 100n,
        };
        const first = await ledger.reserve(params);
        const budgetBeforeRetry = await readBudget(ledger, PROMO_ID);
        await store.transitionStatus(PROMO_ID, status, 'lifecycle changed');

        await expect(ledger.reserve(params)).resolves.toEqual(first);
        await expect(readBudget(ledger, PROMO_ID)).resolves.toEqual(budgetBeforeRetry);
      },
    );

    it('distinguishes a conflicting retry from a corrupt reservation binding', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await ledger.claim(PROMO_ID, 'binding-user', { useUntilAt: null });
      await ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'binding-user',
        receiptId: 'binding-receipt',
        amountMist: 100n,
      });

      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: 'binding-user',
          receiptId: 'binding-receipt',
          amountMist: 99n,
        }),
      ).resolves.toEqual({ ok: false, reason: 'record_changed' });

      await redis!.rawClient.sendCommand([
        'HSET',
        promotionEntitlementKey(PROMO_ID, 'binding-user'),
        'activeReservationAmountMist',
        '99',
      ]);
      await store.transitionStatus(PROMO_ID, 'paused', 'test corruption precedence');
      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: 'binding-user',
          receiptId: 'binding-receipt',
          amountMist: 100n,
        }),
      ).rejects.toThrow('does not match its accounting and entitlement state');
    });

    it('returns the current reservation for overlapping identical reserve requests', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const setupLedger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await setupLedger.claim(PROMO_ID, 'overlap-user', { useUntilAt: null });
      const params = {
        promotionId: PROMO_ID,
        userId: 'overlap-user',
        receiptId: 'overlap-receipt',
        amountMist: 100n,
      };
      let injected = false;
      const racingClient = interceptEval(client, async (_script, keys) => {
        if (!injected && isReserveMutation(keys)) {
          injected = true;
          await setupLedger.reserve(params);
        }
      });
      const ledger = new RedisPromotionExecutionLedger(racingClient, store, 60_000, 0);

      const result = await ledger.reserve(params);
      expect(injected).toBe(true);
      expect(result).toMatchObject({
        ok: true,
        entitlement: { activeReservationReceiptId: 'overlap-receipt' },
      });
      await expect(readBudget(ledger, PROMO_ID)).resolves.toMatchObject({
        reservedMist: 100n,
      });
    });

    it('rejects an exact reserve retry when its deadline index member is missing', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await ledger.claim(PROMO_ID, 'missing-index-user', { useUntilAt: null });
      await ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'missing-index-user',
        receiptId: 'missing-index-receipt',
        amountMist: 100n,
      });
      await redis!.rawClient.sendCommand([
        'ZREM',
        promotionReservationDeadlineIndexKey(),
        'missing-index-receipt',
      ]);

      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: 'missing-index-user',
          receiptId: 'missing-index-receipt',
          amountMist: 100n,
        }),
      ).rejects.toThrow('reservation and deadline index are inconsistent');
    });

    it('rejects an entitlement reservation pointer without its reservation record', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await ledger.claim(PROMO_ID, 'orphan-pointer-user', { useUntilAt: null });
      await redis!.rawClient.sendCommand([
        'HSET',
        promotionEntitlementKey(PROMO_ID, 'orphan-pointer-user'),
        'remainingMist',
        '4999999',
        'activeReservationReceiptId',
        'missing-reservation',
        'activeReservationAmountMist',
        '1',
      ]);
      await redis!.rawClient.sendCommand([
        'HSET',
        promotionAccountingKey(PROMO_ID),
        'availableMist',
        '49999999',
        'reservedMist',
        '1',
      ]);

      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: 'orphan-pointer-user',
          receiptId: 'new-receipt',
          amountMist: 1n,
        }),
      ).rejects.toThrow('missing or finalized reservation');
    });

    it('rejects an exact reserve retry when accounting no longer holds the reserved MIST', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await ledger.claim(PROMO_ID, 'reserved-user', { useUntilAt: null });
      await ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'reserved-user',
        receiptId: 'reserved-receipt',
        amountMist: 100n,
      });
      await redis!.rawClient.sendCommand([
        'HSET',
        promotionAccountingKey(PROMO_ID),
        'reservedMist',
        '0',
      ]);

      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: 'reserved-user',
          receiptId: 'reserved-receipt',
          amountMist: 100n,
        }),
      ).rejects.toThrow('reservation exceeds accounting reserved MIST');
    });

    it('rejects consume when the reservation record does not match its key', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await ledger.claim(PROMO_ID, 'reservation-key-user', { useUntilAt: null });
      await ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'reservation-key-user',
        receiptId: 'reservation-key-receipt',
        amountMist: 100n,
      });
      const key = promotionReservationKey('reservation-key-receipt');
      const raw = await client.get(key);
      expect(raw).not.toBeNull();
      await client.set(
        key,
        JSON.stringify({ ...JSON.parse(raw!), receiptId: 'different-receipt' }),
      );

      await expect(ledger.consume('reservation-key-receipt', 50n)).rejects.toThrow(
        'does not match its storage key',
      );
    });

    it('rejects finalize when an unmodified accounting field changes after the read', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const setupLedger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await setupLedger.claim(PROMO_ID, 'finalize-race-user', { useUntilAt: null });
      await setupLedger.reserve({
        promotionId: PROMO_ID,
        userId: 'finalize-race-user',
        receiptId: 'finalize-race-receipt',
        amountMist: 100n,
      });

      let injected = false;
      const racingClient = interceptEval(client, async (_script, keys) => {
        if (!injected && isFinalizeMutation(keys)) {
          injected = true;
          await redis!.rawClient.sendCommand([
            'HINCRBY',
            promotionAccountingKey(PROMO_ID),
            'claimedCount',
            '1',
          ]);
        }
      });
      const ledger = new RedisPromotionExecutionLedger(racingClient, store, 60_000, 0);

      await expect(ledger.consume('finalize-race-receipt', 50n)).resolves.toEqual({
        ok: false,
        reason: 'record_changed',
      });
      await expect(ledger.getEntitlement(PROMO_ID, 'finalize-race-user')).resolves.toMatchObject({
        activeReservationReceiptId: 'finalize-race-receipt',
      });
    });

    it('treats invalid script-time finalize state as corruption rather than a conflict', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const setupLedger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await setupLedger.claim(PROMO_ID, 'finalize-malformed-user', { useUntilAt: null });
      await setupLedger.reserve({
        promotionId: PROMO_ID,
        userId: 'finalize-malformed-user',
        receiptId: 'finalize-malformed-receipt',
        amountMist: 100n,
      });

      let injected = false;
      const racingClient = interceptEval(client, async (_script, keys) => {
        if (!injected && isFinalizeMutation(keys)) {
          injected = true;
          await redis!.rawClient.sendCommand([
            'HSET',
            promotionAccountingKey(PROMO_ID),
            'claimedCount',
            '01',
          ]);
        }
      });
      const ledger = new RedisPromotionExecutionLedger(racingClient, store, 60_000, 0);

      await expect(ledger.consume('finalize-malformed-receipt', 50n)).rejects.toThrow(
        'Accounting claimedCount must be a canonical decimal string',
      );
    });

    it.each(['remove_deadline', 'change_deadline', 'remove_reservation'] as const)(
      'treats a %s race before finalize as receipt corruption',
      async (mutation) => {
        const client = redis!.client;
        const store = await createRedisPromotionLedgerStore(client);
        const setupLedger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
        const receiptId = `finalize-partial-${mutation}`;
        await setupLedger.claim(PROMO_ID, 'finalize-partial-user', { useUntilAt: null });
        await setupLedger.reserve({
          promotionId: PROMO_ID,
          userId: 'finalize-partial-user',
          receiptId,
          amountMist: 100n,
        });
        const budgetBefore = await readBudget(setupLedger, PROMO_ID);
        const reservationRaw = await client.get(promotionReservationKey(receiptId));
        expect(reservationRaw).not.toBeNull();
        const deadlineMs = Number(
          (JSON.parse(reservationRaw!) as { deadlineMs: number }).deadlineMs,
        );

        let injected = false;
        const racingClient = interceptEval(client, async (_script, keys) => {
          if (injected || !isFinalizeMutation(keys)) return;
          injected = true;
          if (mutation === 'remove_reservation') {
            await client.del(promotionReservationKey(receiptId));
            return;
          }
          await redis!.rawClient.sendCommand([
            mutation === 'remove_deadline' ? 'ZREM' : 'ZADD',
            promotionReservationDeadlineIndexKey(),
            ...(mutation === 'remove_deadline' ? [] : [String(deadlineMs + 1)]),
            receiptId,
          ]);
        });
        const ledger = new RedisPromotionExecutionLedger(racingClient, store, 60_000, 0);

        await expect(ledger.consume(receiptId, 50n)).rejects.toThrow(
          'Promotion final operation found corrupt state',
        );
        expect(injected).toBe(true);
        await expect(client.get(promotionOperationResultKey(receiptId))).resolves.toBeNull();
        await expect(readBudget(setupLedger, PROMO_ID)).resolves.toEqual(budgetBefore);
      },
    );

    it('rejects a final retry whose stored receipt does not match its key', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await ledger.claim(PROMO_ID, 'result-key-user', { useUntilAt: null });
      await ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'result-key-user',
        receiptId: 'result-key-receipt',
        amountMist: 100n,
      });
      await ledger.consume('result-key-receipt', 50n);
      const key = promotionOperationResultKey('result-key-receipt');
      const raw = await client.get(key);
      expect(raw).not.toBeNull();
      await client.set(
        key,
        JSON.stringify({ ...JSON.parse(raw!), receiptId: 'different-receipt' }),
      );

      await expect(ledger.consume('result-key-receipt', 50n)).rejects.toThrow(
        'does not match its storage key',
      );
    });

    it('rejects a receipt that has both reservation and final-result state', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 0, 0);
      await ledger.claim(PROMO_ID, 'dual-state-user', { useUntilAt: null });
      await ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'dual-state-user',
        receiptId: 'dual-state-receipt',
        amountMist: 1n,
      });
      const entitlement = await ledger.getEntitlement(PROMO_ID, 'dual-state-user');
      expect(entitlement).not.toBeNull();
      await client.set(
        promotionOperationResultKey('dual-state-receipt'),
        serializePromotionOperationResultRecord({
          receiptId: 'dual-state-receipt',
          promotionId: PROMO_ID,
          userId: 'dual-state-user',
          operation: 'release',
          amountMist: '1',
          result: 'released',
          entitlement: {
            promotionId: PROMO_ID,
            userId: 'dual-state-user',
            claimedAt: entitlement!.claimedAt,
            useUntilAt: entitlement!.useUntilAt,
            remainingMist: (BigInt(entitlement!.remainingGasAllowanceMist) + 1n).toString(),
            consumedMist: entitlement!.consumedGasAllowanceMist,
            status: 'active',
            activeReservationReceiptId: null,
            activeReservationAmountMist: null,
            lastUsedAt: entitlement!.lastUsedAt,
          },
        }),
      );

      await expect(ledger.release('dual-state-receipt')).rejects.toThrow(
        'contradictory reservation, result, or deadline state',
      );
      await expect(ledger.sweepExpiredReservations()).rejects.toThrow(
        'contradictory reservation or final result state',
      );
      await expect(
        client.get(promotionReservationKey('dual-state-receipt')),
      ).resolves.not.toBeNull();
      await expect(
        client.get(promotionOperationResultKey('dual-state-receipt')),
      ).resolves.not.toBeNull();
      await expect(
        redis!.rawClient.sendCommand([
          'ZSCORE',
          promotionReservationDeadlineIndexKey(),
          'dual-state-receipt',
        ]),
      ).resolves.not.toBeNull();
    });

    it('rejects an orphan final result without current accounting and entitlement', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await client.set(
        promotionOperationResultKey('orphan-result-receipt'),
        serializePromotionOperationResultRecord({
          receiptId: 'orphan-result-receipt',
          promotionId: PROMO_ID,
          userId: 'orphan-result-user',
          operation: 'release',
          amountMist: '1',
          result: 'released',
          entitlement: {
            promotionId: PROMO_ID,
            userId: 'orphan-result-user',
            claimedAt: '2026-07-16T00:00:00.000Z',
            useUntilAt: null,
            remainingMist: '1',
            consumedMist: '0',
            status: 'active',
            activeReservationReceiptId: null,
            activeReservationAmountMist: null,
            lastUsedAt: null,
          },
        }),
      );

      await expect(ledger.release('orphan-result-receipt')).rejects.toThrow(
        'missing accounting or entitlement state',
      );
    });

    it('rejects a consume that would exceed the cumulative accounting integer bound', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 60_000, 0);
      await ledger.claim(PROMO_ID, 'bound-user', { useUntilAt: null });
      await ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'bound-user',
        receiptId: 'bound-receipt',
        amountMist: 1n,
      });
      await redis!.rawClient.sendCommand([
        'HSET',
        promotionAccountingKey(PROMO_ID),
        'consumedMist',
        MAX_PROMOTION_LEDGER_VALUE_MIST.toString(),
      ]);

      await expect(ledger.consume('bound-receipt', 1n)).rejects.toThrow(
        'cumulative accounting consumedMist',
      );
    });

    it('rejects a deadline index score that differs from the reservation record', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 0, 0);
      await ledger.claim(PROMO_ID, 'deadline-user', { useUntilAt: null });
      await ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'deadline-user',
        receiptId: 'deadline-receipt',
        amountMist: 100n,
      });
      const raw = await client.get(promotionReservationKey('deadline-receipt'));
      expect(raw).not.toBeNull();
      const deadlineMs = Number((JSON.parse(raw!) as { deadlineMs: number }).deadlineMs);
      await redis!.rawClient.sendCommand([
        'ZADD',
        promotionReservationDeadlineIndexKey(),
        String(deadlineMs - 1),
        'deadline-receipt',
      ]);

      await expect(ledger.sweepExpiredReservations()).rejects.toThrow(
        'deadline index contradicts its record',
      );
      await expect(client.get(promotionReservationKey('deadline-receipt'))).resolves.not.toBeNull();
    });

    it('rejects a final result that regains a deadline without repairing either record', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 0, 0);
      await ledger.claim(PROMO_ID, 'stale-user', { useUntilAt: null });
      await ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'stale-user',
        receiptId: 'stale-receipt',
        amountMist: 100n,
      });
      await ledger.consume('stale-receipt', 50n);
      const resultKey = promotionOperationResultKey('stale-receipt');
      const finalRaw = await client.get(resultKey);
      expect(finalRaw).not.toBeNull();
      await redis!.rawClient.sendCommand([
        'ZADD',
        promotionReservationDeadlineIndexKey(),
        '1',
        'stale-receipt',
      ]);

      await expect(ledger.consume('stale-receipt', 50n)).rejects.toThrow(
        'contradictory reservation, result, or deadline state',
      );
      await expect(ledger.sweepExpiredReservations()).rejects.toThrow(
        'contradictory reservation or final result state',
      );
      await expect(client.get(resultKey)).resolves.toBe(finalRaw);
      await expect(
        redis!.rawClient.sendCommand([
          'ZSCORE',
          promotionReservationDeadlineIndexKey(),
          'stale-receipt',
        ]),
      ).resolves.not.toBeNull();
    });

    it('rejects a final-result plus deadline race inside the reserve CAS', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const setupLedger = new RedisPromotionExecutionLedger(client, store, 0, 0);
      await setupLedger.claim(PROMO_ID, 'reserve-result-race-user', { useUntilAt: null });
      const entitlement = await setupLedger.getEntitlement(PROMO_ID, 'reserve-result-race-user');
      expect(entitlement).not.toBeNull();
      expect(entitlement!.status).toBe('active');
      const finalRaw = serializePromotionOperationResultRecord({
        receiptId: 'reserve-result-race-receipt',
        promotionId: PROMO_ID,
        userId: 'reserve-result-race-user',
        operation: 'release',
        amountMist: '100',
        result: 'released',
        entitlement: {
          promotionId: PROMO_ID,
          userId: 'reserve-result-race-user',
          claimedAt: entitlement!.claimedAt,
          useUntilAt: entitlement!.useUntilAt,
          remainingMist: entitlement!.remainingGasAllowanceMist,
          consumedMist: entitlement!.consumedGasAllowanceMist,
          status: 'active',
          activeReservationReceiptId: null,
          activeReservationAmountMist: null,
          lastUsedAt: entitlement!.lastUsedAt,
        },
      });

      let injected = false;
      const racingClient = interceptEval(client, async (_script, keys) => {
        if (!injected && isReserveMutation(keys)) {
          injected = true;
          await client.set(promotionOperationResultKey('reserve-result-race-receipt'), finalRaw);
          await redis!.rawClient.sendCommand([
            'ZADD',
            promotionReservationDeadlineIndexKey(),
            '1',
            'reserve-result-race-receipt',
          ]);
        }
      });
      const ledger = new RedisPromotionExecutionLedger(racingClient, store, 0, 0);

      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: 'reserve-result-race-user',
          receiptId: 'reserve-result-race-receipt',
          amountMist: 100n,
        }),
      ).rejects.toThrow('corrupt stored state');
      await expect(
        client.get(promotionReservationKey('reserve-result-race-receipt')),
      ).resolves.toBeNull();
      await expect(
        client.get(promotionOperationResultKey('reserve-result-race-receipt')),
      ).resolves.toBe(finalRaw);
      await expect(
        redis!.rawClient.sendCommand([
          'ZSCORE',
          promotionReservationDeadlineIndexKey(),
          'reserve-result-race-receipt',
        ]),
      ).resolves.toBe('1');
    });

    it('lets consume and expiry race to one permanent final result', async () => {
      const client = redis!.client;
      const store = await createRedisPromotionLedgerStore(client);
      const ledger = new RedisPromotionExecutionLedger(client, store, 0, 0);
      await ledger.claim(PROMO_ID, 'race-user', { useUntilAt: null });
      await ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'race-user',
        receiptId: 'race-receipt',
        amountMist: 100n,
      });

      const [consume, swept] = await Promise.all([
        ledger.consume('race-receipt', 50n),
        ledger.sweepExpiredReservations(),
      ]);
      const finalRaw = await client.get(promotionOperationResultKey('race-receipt'));
      expect(finalRaw).not.toBeNull();
      const final = decodePromotionOperationResultRecord(finalRaw!);
      expect(final.receiptId).toBe('race-receipt');
      if (final.operation === 'consume') {
        expect(consume.ok).toBe(true);
        expect(swept).toBe(0);
      } else {
        expect(consume).toEqual({ ok: false, reason: 'record_changed' });
        expect(swept).toBe(1);
      }
    });
  });
});
