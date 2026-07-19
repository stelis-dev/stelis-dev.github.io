/**
 * RedisPrepareInflight — Redis-backed distributed in-flight limiter.
 *
 * Implements PrepareInflightLimiter using a tokenized reservation model
 * backed by a Redis sorted set. Each acquire creates a unique token with
 * a timestamp score; release removes that token. Expired tokens are
 * pruned atomically on every acquire, providing automatic crash recovery.
 *
 * Key layout:
 *   {prefix}inflight:slots  → ZSET  member=token, score=acquireTimestampMs
 *
 * All operations use a single shared Redis key.
 *
 * TTL safety net:
 *   Tokens older than `ttlMs` are pruned on every acquire call.
 *   This means capacity is recovered automatically even if a process
 *   crashes without calling release(). No background reaper is needed.
 *
 * References:
 *   prepareInflightTypes.ts — PrepareInflightLimiter interface
 *   memoryPrepareInflight.ts — Memory reference implementation
 */
import type { PrepareInflightLimiter, InflightHandle } from './prepareInflightTypes.js';
import type { RedisClientLike } from './redisClient.js';
import { logStructuredEvent } from '../structuredEventLog.js';
import {
  PREPARE_INFLIGHT_ACQUIRED,
  PREPARE_INFLIGHT_REJECTED,
  PREPARE_INFLIGHT_RELEASED,
} from '../observability/events.js';
import { PREPARE_TTL_MS } from '../preparePolicy.js';

/** Extra safety-net TTL after prepare receipt expiry. */
const PREPARE_INFLIGHT_TTL_GRACE_MS = 5_000;

// ─────────────────────────────────────────────
// Lua scripts
// ─────────────────────────────────────────────

/**
 * ACQUIRE_SCRIPT — atomically prune expired tokens, check capacity, and add a new token.
 *
 * KEYS[1] = sorted set key
 * ARGV[1] = token (unique string)
 * ARGV[2] = ttlMs (string)
 * ARGV[3] = capacity (string)
 *
 * Uses Redis server time (TIME command) for both prune cutoff and token score,
 * so clock drift between application instances does not affect admission accuracy.
 * Uses Redis server time inside the Lua script.
 *
 * Returns:
 *   negative value  — capacity exhausted; absolute value is authoritative ZCARD (e.g. -5 means 5 active)
 *   positive value  — acquired successfully; value is authoritative ZCARD after ZADD
 *
 * Both paths return authoritative post-operation cardinality so the caller
 * never relies on a stale local counter for observability or error reporting.
 */
const ACQUIRE_SCRIPT = `
local key = KEYS[1]
local token = ARGV[1]
local ttlMs = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])

-- Use Redis server time as the expiry authority.
local timeResult = redis.call('TIME')
local nowMs = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)

-- Prune expired tokens (score <= nowMs - ttlMs)
local cutoff = nowMs - ttlMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

-- Check capacity
local current = redis.call('ZCARD', key)
if current >= capacity then
  -- Return negative cardinality: rejected, but caller knows the real count
  return -current
end

-- Add token with Redis server timestamp as score
redis.call('ZADD', key, nowMs, token)
return redis.call('ZCARD', key)
`;

/**
 * RELEASE_SCRIPT — remove a token from the sorted set.
 *
 * KEYS[1] = sorted set key
 * ARGV[1] = token
 *
 * Returns the authoritative ZCARD after removal.
 */
const RELEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
return redis.call('ZCARD', KEYS[1])
`;

// ─────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────

export interface RedisPrepareInflightOptions {
  /** Redis key prefix. Default: 'stelis:' */
  keyPrefix?: string;
  /** TTL safety net in ms. Default: PREPARE_TTL_MS plus the inflight grace constant. */
  ttlMs?: number;
}

export class RedisPrepareInflight implements PrepareInflightLimiter {
  private readonly _client: RedisClientLike;
  private readonly _capacity: number;
  private readonly _ttlMs: number;
  private readonly _key: string;

  /**
   * Last known inflight count from authoritative Redis ZCARD.
   * Updated after every acquire/release Lua call. Never incremented
   * locally — always set from the Lua return value to prevent drift.
   */
  private _lastKnownInflight = 0;

  constructor(
    client: RedisClientLike,
    capacity: number,
    options: RedisPrepareInflightOptions = {},
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('RedisPrepareInflight: capacity must be >= 1 and a safe integer');
    }
    const ttlMs = options.ttlMs ?? PREPARE_TTL_MS + PREPARE_INFLIGHT_TTL_GRACE_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('RedisPrepareInflight: ttlMs must be a positive safe integer');
    }
    this._client = client;
    this._capacity = capacity;
    this._ttlMs = ttlMs;
    this._key = `${options.keyPrefix ?? 'stelis:'}inflight:slots`;
  }

  get inflight(): number {
    return this._lastKnownInflight;
  }

  get capacity(): number {
    return this._capacity;
  }

  async tryAcquire(route?: string): Promise<InflightHandle | null> {
    const token = crypto.randomUUID();

    const result = (await this._client.eval(
      ACQUIRE_SCRIPT,
      [this._key],
      [token, String(this._ttlMs), String(this._capacity)],
    )) as number;

    if (result <= 0) {
      // Capacity exhausted — |result| is authoritative ZCARD after prune.
      // result == 0 means ZCARD is 0 but capacity check still failed
      // (should not happen with capacity >= 1, but handle defensively).
      this._lastKnownInflight = Math.abs(result);
      logStructuredEvent(PREPARE_INFLIGHT_REJECTED, {
        adapter: 'redis',
        route: route ?? 'unknown',
        inflight: this._lastKnownInflight,
        capacity: this._capacity,
      });
      return null;
    }

    // result is authoritative ZCARD after ZADD
    this._lastKnownInflight = result;
    logStructuredEvent(PREPARE_INFLIGHT_ACQUIRED, {
      adapter: 'redis',
      route: route ?? 'unknown',
      inflight: this._lastKnownInflight,
      capacity: this._capacity,
    });

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        const postReleaseCount = (await this._client.eval(
          RELEASE_SCRIPT,
          [this._key],
          [token],
        )) as number;
        this._lastKnownInflight = postReleaseCount;
        logStructuredEvent(PREPARE_INFLIGHT_RELEASED, {
          adapter: 'redis',
          route: route ?? 'unknown',
          inflight: this._lastKnownInflight,
          capacity: this._capacity,
        });
      },
    };
  }
}
