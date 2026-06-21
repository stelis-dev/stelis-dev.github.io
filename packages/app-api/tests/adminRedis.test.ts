import { describe, expect, it, vi } from 'vitest';
import { createAdminRedisAdapter } from '../src/adminRedis.js';
import type { RedisClient } from '../src/redisClient.js';

function createMockRedis(): RedisClient {
  return {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn(),
    incr: vi.fn(),
    pexpire: vi.fn().mockResolvedValue(true),
    eval: vi.fn(),
    hgetall: vi.fn(),
    scan: vi.fn(),
    ttl: vi.fn(),
    lrange: vi.fn(),
    lpush: vi.fn(),
    ltrim: vi.fn(),
    hincrby: vi.fn(),
    hset: vi.fn(),
    sadd: vi.fn(),
    smembers: vi.fn(),
    srem: vi.fn(),
    dispose: vi.fn(),
  } as unknown as RedisClient;
}

describe('createAdminRedisAdapter', () => {
  it('reuses the Host Redis client and converts admin TTL seconds to milliseconds', async () => {
    const redis = createMockRedis();
    const adminRedis = createAdminRedisAdapter(redis);

    await adminRedis.set('nonce-key', '1', { ex: 60 });
    await adminRedis.expire('rate-limit-key', 15);

    expect(redis.set).toHaveBeenCalledWith('nonce-key', '1', { px: 60_000 });
    expect(redis.pexpire).toHaveBeenCalledWith('rate-limit-key', 15_000);
  });

  it('delegates admin commands to the shared Host Redis client', async () => {
    const redis = createMockRedis();
    const adminRedis = createAdminRedisAdapter(redis);

    await adminRedis.del('a');
    await adminRedis.scan('stelis:*');
    await adminRedis.lpush('logs', 'entry');
    await adminRedis.eval('return 1', ['k'], ['v']);

    expect(redis.del).toHaveBeenCalledWith('a');
    expect(redis.scan).toHaveBeenCalledWith('stelis:*');
    expect(redis.lpush).toHaveBeenCalledWith('logs', 'entry');
    expect(redis.eval).toHaveBeenCalledWith('return 1', ['k'], ['v']);
  });

  it('rejects non-positive admin TTLs instead of creating persistent nonce keys', async () => {
    const redis = createMockRedis();
    const adminRedis = createAdminRedisAdapter(redis);

    await expect(adminRedis.set('nonce-key', '1', { ex: 0 })).rejects.toThrow(
      'admin Redis EX must be a positive integer number of seconds',
    );
    expect(() => adminRedis.expire('rate-limit-key', 0)).toThrow(
      'admin Redis EXPIRE must be a positive integer number of seconds',
    );
  });
});
