/**
 * [app-api] Admin Redis adapter.
 *
 * Admin auth/routes share the single Redis client created during Host context
 * initialization. app-api owns the connection lifecycle and topology probe;
 * core-api owns the admin Redis command contract.
 */
import type { AdminRedisClient } from '@stelis/core-api/admin';
import type { RedisClient } from './redisClient.js';

function assertPositiveTtlMs(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('[app-api] admin Redis PX must be a positive integer number of milliseconds');
  }
}

export function createAdminRedisAdapter(redis: RedisClient): AdminRedisClient {
  return {
    get(key) {
      return redis.get(key);
    },
    async set(key, value, options) {
      if (options?.px != null) {
        assertPositiveTtlMs(options.px);
      }
      await redis.set(key, value, options);
    },
    del(key) {
      return redis.del(key);
    },
    lrange(key, start, stop) {
      return redis.lrange(key, start, stop);
    },
    lpush(key, value) {
      return redis.lpush(key, value);
    },
    ltrim(key, start, stop) {
      return redis.ltrim(key, start, stop);
    },
    eval(script, keys, args) {
      return redis.eval(script, keys, args);
    },
  };
}
