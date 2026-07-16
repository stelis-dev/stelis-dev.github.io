import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisAbuseBlocker } from '../src/store/redisAbuseBlocker.js';
import {
  ABUSE_BLOCK_DEADLINE_INDEX_KEY,
  AbuseBlockCurrentConflictError,
  abuseBlockMember,
  abuseBlockRecordKey,
  serializeAbuseBlockRecord,
  type AbuseBlockIdentity,
} from '../src/store/abuseBlockStore.js';
import type { RedisClientLike } from '../src/store/redisClient.js';
import { startRealRedis, type RealRedisHandle } from '../src/testing/redis.js';
import {
  runAbuseBlockerConformanceTests,
  type AbuseBlockerFactory,
  type AbuseBlockerHandle,
} from './abuseBlocker.conformance.js';

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

function injectBeforeSecondEval(
  base: RedisClientLike,
  inject: () => Promise<void>,
): { client: RedisClientLike; callCount: () => number } {
  let calls = 0;
  return {
    client: interceptEval(base, async () => {
      calls += 1;
      if (calls === 2) await inject();
    }),
    callCount: () => calls,
  };
}

describe('RedisAbuseBlocker — shared conformance against real Redis', () => {
  let redis: RealRedisHandle | null = null;

  beforeAll(async () => {
    redis = await startRealRedis();
  });

  afterAll(async () => {
    await redis?.stop();
  });

  const redisFactory: AbuseBlockerFactory = async (config) => {
    await redis!.flush();
    const blocker = new RedisAbuseBlocker(redis!.client, config);
    const handle: AbuseBlockerHandle = {
      blocker,
      advanceTime: async (ms) => {
        await sleep(ms);
      },
      seedEqualDeadlineStudioUsers: async (userIds) => {
        const time = (await redis!.rawClient.sendCommand(['TIME'])) as [string, string];
        const blockedUntilMs =
          Number(time[0]) * 1_000 + Math.floor(Number(time[1]) / 1_000) + 60_000;
        for (const subject of userIds) {
          const identity = { scope: 'studio_user' as const, subject };
          const stored = serializeAbuseBlockRecord({
            identity,
            reason: 'manipulation',
            blockedUntilMs,
          });
          await redis!.rawClient.sendCommand(['SET', abuseBlockRecordKey(identity), stored]);
          await redis!.rawClient.sendCommand([
            'PEXPIREAT',
            abuseBlockRecordKey(identity),
            String(blockedUntilMs),
          ]);
          await redis!.rawClient.sendCommand([
            'ZADD',
            ABUSE_BLOCK_DEADLINE_INDEX_KEY,
            String(blockedUntilMs),
            abuseBlockMember(identity),
          ]);
        }
      },
      dispose: async () => {
        await blocker.stop();
      },
    };
    return handle;
  };

  runAbuseBlockerConformanceTests(redisFactory);

  describe('exact-current block transitions', () => {
    beforeEach(async () => {
      await redis!.flush();
    });

    async function seedBlock(
      identity: AbuseBlockIdentity,
      blockedUntilMs: number,
    ): Promise<string> {
      const raw = serializeAbuseBlockRecord({
        identity,
        reason: 'manipulation',
        blockedUntilMs,
      });
      await redis!.rawClient.sendCommand(['SET', abuseBlockRecordKey(identity), raw]);
      await redis!.rawClient.sendCommand([
        'PEXPIREAT',
        abuseBlockRecordKey(identity),
        String(blockedUntilMs),
      ]);
      await redis!.rawClient.sendCommand([
        'ZADD',
        ABUSE_BLOCK_DEADLINE_INDEX_KEY,
        String(blockedUntilMs),
        abuseBlockMember(identity),
      ]);
      return raw;
    }

    it('returns one typed conflict when remove loses its exact-current CAS', async () => {
      const identity = { scope: 'ip' as const, subject: '192.0.2.10' };
      const now = Date.now();
      await seedBlock(identity, now + 60_000);
      let replacementRaw = '';
      const race = injectBeforeSecondEval(redis!.client, async () => {
        replacementRaw = await seedBlock(identity, Date.now() + 120_000);
      });
      const blocker = new RedisAbuseBlocker(race.client);

      try {
        await expect(blocker.removeBlock(identity)).rejects.toBeInstanceOf(
          AbuseBlockCurrentConflictError,
        );
        expect(race.callCount()).toBe(2);
        await expect(redis!.client.get(abuseBlockRecordKey(identity))).resolves.toBe(
          replacementRaw,
        );
      } finally {
        await blocker.stop();
      }
    });

    it('re-reads once and preserves a longer block when an insert wins the first set CAS', async () => {
      const identity = { scope: 'ip' as const, subject: '192.0.2.11' };
      let winnerRaw = '';
      const race = injectBeforeSecondEval(redis!.client, async () => {
        winnerRaw = await seedBlock(identity, Date.now() + 48 * 60 * 60 * 1_000);
      });
      const blocker = new RedisAbuseBlocker(race.client);

      try {
        await expect(
          blocker.recordSponsorFailure(identity.subject, undefined, 'TAMPERING_DETECTED'),
        ).resolves.toBeUndefined();
        expect(race.callCount()).toBe(4);
        await expect(redis!.client.get(abuseBlockRecordKey(identity))).resolves.toBe(winnerRaw);
      } finally {
        await blocker.stop();
      }
    });

    it('re-reads once and installs a block when expiry cleanup wins the first set CAS', async () => {
      const identity = { scope: 'ip' as const, subject: '192.0.2.13' };
      await seedBlock(identity, 1);
      const race = injectBeforeSecondEval(redis!.client, async () => {
        await redis!.rawClient.sendCommand([
          'ZREM',
          ABUSE_BLOCK_DEADLINE_INDEX_KEY,
          abuseBlockMember(identity),
        ]);
      });
      const blocker = new RedisAbuseBlocker(race.client);

      try {
        await expect(
          blocker.recordSponsorFailure(identity.subject, undefined, 'TAMPERING_DETECTED'),
        ).resolves.toBeUndefined();
        expect(race.callCount()).toBe(4);
        await expect(blocker.checkIp(identity.subject)).resolves.toMatchObject({
          blocked: true,
          scope: 'ip',
          reason: 'manipulation',
        });
      } finally {
        await blocker.stop();
      }
    });

    it('keeps admission read-only when it observes expired block state', async () => {
      const identity = { scope: 'ip' as const, subject: '192.0.2.14' };
      await seedBlock(identity, 1);
      const observed = injectBeforeSecondEval(redis!.client, async () => {
        throw new Error('checkBlock must not perform a cleanup CAS');
      });
      const blocker = new RedisAbuseBlocker(observed.client);

      try {
        await expect(blocker.checkIp(identity.subject)).resolves.toEqual({
          blocked: false,
        });
        expect(observed.callCount()).toBe(1);
        await expect(
          redis!.rawClient.sendCommand([
            'ZSCORE',
            ABUSE_BLOCK_DEADLINE_INDEX_KEY,
            abuseBlockMember(identity),
          ]),
        ).resolves.toBe('1');
      } finally {
        await blocker.stop();
      }
    });
  });
});
