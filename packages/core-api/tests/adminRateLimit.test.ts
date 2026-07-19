import { describe, it, expect, vi } from 'vitest';
import { parseFixedWindowResult } from '../src/store/redisFixedWindowCounter.js';
import {
  RATE_LIMIT_MAX,
  getRateLimitKey,
  checkAndIncrement,
  resetAttempts,
} from '../src/admin/adminRateLimit.js';
import {
  ADMIN_OPERATIONS_RATE_LIMIT_MAX,
  getAdminOperationsRateLimitKey,
  checkAndIncrementAdminOperationAttempt,
} from '../src/admin/adminOperationsRateLimit.js';
import type { AdminRedisClient } from '../src/admin/adminRedis.js';

// ─────────────────────────────────────────────
// parseFixedWindowResult
// ─────────────────────────────────────────────

describe('parseFixedWindowResult', () => {
  it('parses valid [current, pttl] tuple', () => {
    const result = parseFixedWindowResult([3, 850000]);
    expect(result).toEqual({ current: 3, pttlMs: 850000 });
  });

  it('throws on non-array', () => {
    expect(() => parseFixedWindowResult('bad')).toThrow('invalid EVAL response');
  });

  it('throws on short array', () => {
    expect(() => parseFixedWindowResult([1])).toThrow('invalid EVAL response');
  });

  it('throws on trailing values', () => {
    expect(() => parseFixedWindowResult([1, 900000, 'unexpected'])).toThrow(
      'invalid EVAL response',
    );
  });

  it('coerces string values to number', () => {
    const result = parseFixedWindowResult(['5', '900000']);
    expect(result).toEqual({ current: 5, pttlMs: 900000 });
  });

  it('rejects decimal, exponent, and unsafe integer responses', () => {
    expect(() => parseFixedWindowResult(['1.5', '900000'])).toThrow('invalid current');
    expect(() => parseFixedWindowResult(['1e3', '900000'])).toThrow('invalid current');
    expect(() => parseFixedWindowResult(['9007199254740993', '900000'])).toThrow('invalid current');
  });

  it('rejects impossible counter and expiry states', () => {
    expect(() => parseFixedWindowResult([0, 900000])).toThrow('invalid EVAL response');
    expect(() => parseFixedWindowResult([1, -1])).toThrow('invalid EVAL response');
    expect(() => parseFixedWindowResult([1, -2])).toThrow('invalid EVAL response');
  });
});

// ─────────────────────────────────────────────
// Admin auth rate limit
// ─────────────────────────────────────────────

describe('adminRateLimit', () => {
  it('RATE_LIMIT_MAX is 5', () => {
    expect(RATE_LIMIT_MAX).toBe(5);
  });

  it('key prefix matches expected pattern', () => {
    expect(getRateLimitKey('1.2.3.4')).toBe('stelis:admin:auth_rate:1.2.3.4');
  });

  it('checkAndIncrement returns allowed when under limit', async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue([2, 850000]),
    } as unknown as AdminRedisClient;

    const result = await checkAndIncrement(redis, '1.2.3.4');
    expect(result.allowed).toBe(true);
    expect(result.current).toBe(2);
    expect(redis.eval).toHaveBeenCalledOnce();
  });

  it('checkAndIncrement returns not allowed when at limit', async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue([6, 850000]),
    } as unknown as AdminRedisClient;

    const result = await checkAndIncrement(redis, '1.2.3.4');
    expect(result.allowed).toBe(false);
    expect(result.current).toBe(6);
    expect(result.retryAfterMs).toBe(850000);
  });

  it('resetAttempts deletes the key', async () => {
    const redis = {
      del: vi.fn().mockResolvedValue(1),
    } as unknown as AdminRedisClient;

    await resetAttempts(redis, '1.2.3.4');
    expect(redis.del).toHaveBeenCalledWith('stelis:admin:auth_rate:1.2.3.4');
  });
});

// ─────────────────────────────────────────────
// Admin operations rate limit
// ─────────────────────────────────────────────

describe('adminOperationsRateLimit', () => {
  it('ADMIN_OPERATIONS_RATE_LIMIT_MAX is 5', () => {
    expect(ADMIN_OPERATIONS_RATE_LIMIT_MAX).toBe(5);
  });

  it('key prefix matches expected pattern', () => {
    expect(getAdminOperationsRateLimitKey('10.0.0.1')).toBe('admin:operations_rate:10.0.0.1');
  });

  it('checkAndIncrementAdminOperationAttempt returns allowed when under limit', async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue([3, 900000]),
    } as unknown as AdminRedisClient;

    const result = await checkAndIncrementAdminOperationAttempt(redis, '10.0.0.1');
    expect(result.allowed).toBe(true);
    expect(result.current).toBe(3);
  });

  it('checkAndIncrementAdminOperationAttempt returns not allowed when over limit', async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue([6, 700000]),
    } as unknown as AdminRedisClient;

    const result = await checkAndIncrementAdminOperationAttempt(redis, '10.0.0.1');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(700000);
  });
});
