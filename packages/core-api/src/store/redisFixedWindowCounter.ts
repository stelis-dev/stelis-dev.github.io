/**
 * Atomic fixed-window counter — shared Lua script for Redis INCR + PEXPIRE.
 *
 * Used by:
 *   - RedisRateLimiter (relay/studio rate limiting)
 *   - Admin auth/ops rate limiting helpers
 *
 * The script atomically increments a counter key and sets PEXPIRE
 * only on first creation (current == 1). Returns [current, pttl].
 */

/** Lua script: atomic INCR + PEXPIRE on first creation. */
export const FIXED_WINDOW_INCR_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { current, ttl }
`;

export interface FixedWindowCounterResult {
  current: number;
  pttlMs: number;
}

function parseRedisInteger(value: unknown, label: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`redisFixedWindowCounter: invalid ${label}`);
    }
    return value;
  }

  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }

  throw new Error(`redisFixedWindowCounter: invalid ${label}`);
}

/**
 * Parse the [current, pttl] tuple returned by the Lua script.
 */
export function parseFixedWindowResult(value: unknown): FixedWindowCounterResult {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('redisFixedWindowCounter: invalid EVAL response');
  }
  const current = parseRedisInteger(value[0], 'current');
  const pttlMs = parseRedisInteger(value[1], 'pttlMs');
  if (current < 1 || pttlMs < 0) {
    throw new Error('redisFixedWindowCounter: invalid EVAL response');
  }
  return { current, pttlMs };
}
