/**
 * RedisPrepareInflight — PrepareInflightLimiter conformance + Redis-specific cases.
 *
 * The shared adapter contract is exercised by
 * `prepareInflight.conformance.ts`. Redis-specific cases below cover
 * behaviors that only the tokenized-ZSET backend exhibits:
 *   - TTL-driven crash recovery (expired token pruning)
 *   - Bounded inflight count after prune (no impossible counts)
 *   - Custom key prefix routing
 *   - Default TTL value (`PREPARE_TTL_MS + 5000`)
 *   - Cross-instance shared-state reconciliation via authoritative ZCARD
 *
 * Uses an in-memory ZSET simulation to exercise the Lua script
 * semantics without a real Redis instance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisPrepareInflight } from '../src/store/redisPrepareInflight.js';
import type { RedisClientLike } from '../src/store/redisClient.js';
import {
  runPrepareInflightConformanceTests,
  type PrepareInflightFactory,
  type PrepareInflightHandle,
} from './prepareInflight.conformance.js';

// ─────────────────────────────────────────────
// In-memory ZSET simulation for Lua eval
// ─────────────────────────────────────────────
//
// The mock is defined at module scope (not via a factory-local
// closure) so Redis-specific tests that explicitly need evalSpy /
// instance sharing can reuse the same client without duplicating
// simulation logic.

function createMockRedisClient(): RedisClientLike {
  const zset = new Map<string, number>();

  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(0),
    scan: vi.fn().mockResolvedValue([]),

    async eval(script: string, _keys: string[], args: string[]): Promise<unknown> {
      if (script.includes('ZREMRANGEBYSCORE') && script.includes('ZADD')) {
        const token = args[0];
        const ttlMs = parseInt(args[1], 10);
        const capacity = parseInt(args[2], 10);
        const nowMs = Date.now();

        const cutoff = nowMs - ttlMs;
        for (const [member, score] of zset) {
          if (score <= cutoff) zset.delete(member);
        }

        if (zset.size >= capacity) return -zset.size;

        zset.set(token, nowMs);
        return zset.size;
      }

      if (script.includes('ZREM') && !script.includes('ZREMRANGEBYSCORE')) {
        const token = args[0];
        zset.delete(token);
        return zset.size;
      }

      throw new Error('Unrecognized Lua script in mock');
    },
  };
}

// ─────────────────────────────────────────────
// Shared conformance entry
// ─────────────────────────────────────────────

const redisFactory: PrepareInflightFactory = ({ capacity }) => {
  const redis = createMockRedisClient();
  const limiter = new RedisPrepareInflight(redis, capacity);
  const handle: PrepareInflightHandle = {
    limiter,
    dispose: () => {
      /* no-op — the mock ZSET lives only for this test */
    },
  };
  return handle;
};

describe('RedisPrepareInflight — shared conformance', () => {
  runPrepareInflightConformanceTests(redisFactory);
});

// ─────────────────────────────────────────────
// Redis-specific cases
// ─────────────────────────────────────────────

describe('RedisPrepareInflight — Redis-specific', () => {
  let redis: RedisClientLike;

  beforeEach(() => {
    redis = createMockRedisClient();
  });

  it('rejects capacity < 1', () => {
    expect(() => new RedisPrepareInflight(redis, 0)).toThrow('capacity must be >= 1');
    expect(() => new RedisPrepareInflight(redis, -1)).toThrow('capacity must be >= 1');
    expect(() => new RedisPrepareInflight(redis, 1.5)).toThrow('safe integer');
    expect(() => new RedisPrepareInflight(redis, Number.MAX_SAFE_INTEGER + 1)).toThrow(
      'safe integer',
    );
    expect(() => new RedisPrepareInflight(redis, 1, { ttlMs: 1.5 })).toThrow('ttlMs');
  });

  it('expired tokens are pruned on acquire (TTL crash recovery)', async () => {
    const limiter = new RedisPrepareInflight(redis, 1, { ttlMs: 50 });

    const h1 = await limiter.tryAcquire();
    expect(h1).not.toBeNull();

    const originalDateNow = Date.now;
    Date.now = () => originalDateNow() + 100;
    try {
      const h2 = await limiter.tryAcquire();
      expect(h2).not.toBeNull();
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('inflight count stays bounded after prune (no impossible counts)', async () => {
    const limiter = new RedisPrepareInflight(redis, 1, { ttlMs: 50 });

    await limiter.tryAcquire();
    expect(limiter.inflight).toBe(1);

    const originalDateNow = Date.now;
    Date.now = () => originalDateNow() + 100;
    try {
      const h2 = await limiter.tryAcquire();
      expect(h2).not.toBeNull();
      expect(limiter.inflight).toBe(1);
      expect(limiter.inflight).toBeLessThanOrEqual(limiter.capacity);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('uses custom key prefix', async () => {
    const evalSpy = vi.spyOn(redis, 'eval');
    const limiter = new RedisPrepareInflight(redis, 2, { keyPrefix: 'custom:' });
    await limiter.tryAcquire();

    expect(evalSpy).toHaveBeenCalledWith(
      expect.any(String),
      ['custom:inflight:slots'],
      expect.any(Array),
    );
  });

  it('uses default TTL of PREPARE_TTL_MS + 5000', () => {
    const evalSpy = vi.spyOn(redis, 'eval');
    const limiter = new RedisPrepareInflight(redis, 2);
    void limiter.tryAcquire();

    const call = evalSpy.mock.calls[0];
    const args = call?.[2] as string[];
    expect(args?.[1]).toBe('65000');
  });

  it('cross-instance reject: B.inflight reflects shared Redis state from A', async () => {
    const instanceA = new RedisPrepareInflight(redis, 1);
    const instanceB = new RedisPrepareInflight(redis, 1);

    expect(instanceB.inflight).toBe(0);

    const handleA = await instanceA.tryAcquire();
    expect(handleA).not.toBeNull();
    expect(instanceA.inflight).toBe(1);

    const handleB = await instanceB.tryAcquire();
    expect(handleB).toBeNull();
    expect(instanceB.inflight).toBe(1);
    expect(instanceB.inflight).toBeLessThanOrEqual(instanceB.capacity);

    await handleA!.release();
    const handleB2 = await instanceB.tryAcquire();
    expect(handleB2).not.toBeNull();
    expect(instanceB.inflight).toBe(1);
  });
});
