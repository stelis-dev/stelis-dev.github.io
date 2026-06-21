/**
 * [app-api] Admin Redis adapter.
 *
 * Admin auth/routes share the single Redis client created during Host context
 * initialization. app-api owns the connection lifecycle and topology probe;
 * core-api owns the admin Redis command contract.
 */
import type { AdminRedisClient } from '@stelis/core-api/admin';
import type { RedisClient } from './redisClient.js';

function secondsToMilliseconds(seconds: number, label: string): number {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`[app-api] ${label} must be a positive integer number of seconds`);
  }
  return seconds * 1000;
}

export function createAdminRedisAdapter(redis: RedisClient): AdminRedisClient {
  return {
    get(key) {
      return redis.get(key);
    },
    async set(key, value, options) {
      await redis.set(
        key,
        value,
        options?.ex != null
          ? { px: secondsToMilliseconds(options.ex, 'admin Redis EX') }
          : undefined,
      );
    },
    del(key) {
      return redis.del(key);
    },
    scan(pattern) {
      return redis.scan(pattern);
    },
    ttl(key) {
      return redis.ttl(key);
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
    hincrby(key, field, increment) {
      return redis.hincrby(key, field, increment);
    },
    hgetall(key) {
      return redis.hgetall(key);
    },
    hset(key, field, value) {
      return redis.hset(key, field, value);
    },
    sadd(key, ...members) {
      return redis.sadd(key, ...members);
    },
    smembers(key) {
      return redis.smembers(key);
    },
    srem(key, ...members) {
      return redis.srem(key, ...members);
    },
    incr(key) {
      return redis.incr(key);
    },
    expire(key, seconds) {
      return redis.pexpire(key, secondsToMilliseconds(seconds, 'admin Redis EXPIRE'));
    },
    eval(script, keys, args) {
      return redis.eval(script, keys, args);
    },
  };
}
