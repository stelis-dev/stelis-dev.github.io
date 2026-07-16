import { describe, expect, it, vi } from 'vitest';
import { createAdminRedisAdapter } from '../src/adminRedis.js';
import type { RedisClient } from '../src/redisClient.js';

function createMockRedis(): RedisClient {
  return {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn(),
    eval: vi.fn(),
    hgetall: vi.fn(),
    lrange: vi.fn(),
    lpush: vi.fn(),
    ltrim: vi.fn(),
    dispose: vi.fn(),
  } as unknown as RedisClient;
}

describe('createAdminRedisAdapter', () => {
  it('reuses the Host Redis client with millisecond TTLs', async () => {
    const redis = createMockRedis();
    const adminRedis = createAdminRedisAdapter(redis);

    await adminRedis.set('nonce-key', '1', { px: 60_000 });

    expect(redis.set).toHaveBeenCalledWith('nonce-key', '1', { px: 60_000 });
  });

  it('delegates admin commands to the shared Host Redis client', async () => {
    const redis = createMockRedis();
    const adminRedis = createAdminRedisAdapter(redis);

    await adminRedis.del('a');
    await adminRedis.lpush('logs', 'entry');
    await adminRedis.eval('return 1', ['k'], ['v']);

    expect(redis.del).toHaveBeenCalledWith('a');
    expect(redis.lpush).toHaveBeenCalledWith('logs', 'entry');
    expect(redis.eval).toHaveBeenCalledWith('return 1', ['k'], ['v']);
  });

  it('rejects non-positive admin TTLs instead of creating persistent nonce keys', async () => {
    const redis = createMockRedis();
    const adminRedis = createAdminRedisAdapter(redis);

    await expect(adminRedis.set('nonce-key', '1', { px: 0 })).rejects.toThrow(
      'admin Redis PX must be a positive integer number of milliseconds',
    );
  });
});
