/**
 * MemoryRateLimiter — in-memory fixed-window counter rate limiter.
 *
 * Algorithm: per-key counter anchored at `windowStart`. The counter resets
 * on the first request observed after `windowMs` has elapsed since the
 * current window's anchor. This mirrors the Redis counterpart
 * (`redisFixedWindowCounter.ts`: `INCR + PEXPIRE on current==1`) so both
 * adapters share the same fixed-window semantics.
 *
 * Uses an in-process map and an injected clock:
 *   - MAX_KEYS for memory DoS prevention
 *   - Periodic eviction of expired entries
 *
 * Test-only fixture. Production hosts inject `RedisRateLimiter` through
 * `createHostContext()`; this class is not exported from the
 * `@stelis/core-api` main barrel and is not a runtime fallback.
 */
import type { RateLimitAdapter, RateLimitResult, RateLimitConfig } from './rateLimitTypes.js';
import { ensureBoundedCapacity } from './boundedMapEvict.js';
import { type Clock, systemClock } from '../clock.js';

interface WindowEntry {
  count: number;
  windowStart: number;
}

/** Maximum tracked keys (memory DoS prevention). */
const MAX_KEYS = 50_000;

export class MemoryRateLimiter implements RateLimitAdapter {
  private readonly _map = new Map<string, WindowEntry>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly _clock: Clock;

  constructor(config: RateLimitConfig, clock: Clock = systemClock) {
    if (!Number.isSafeInteger(config.windowMs) || config.windowMs <= 0) {
      throw new Error('MemoryRateLimiter: windowMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(config.maxRequests) || config.maxRequests <= 0) {
      throw new Error('MemoryRateLimiter: maxRequests must be a positive safe integer');
    }
    this.windowMs = config.windowMs;
    this.maxRequests = config.maxRequests;
    this._clock = clock;
  }

  async check(key: string): Promise<RateLimitResult> {
    const now = this._clock.nowMs();
    const entry = this._map.get(key);

    // New key or expired window → reset
    if (!entry || now - entry.windowStart >= this.windowMs) {
      // Bounded eviction: expired first → oldest live evict.
      // Never skips tracking — prevents fail-open under saturation.
      if (!this._map.has(key)) {
        ensureBoundedCapacity(
          this._map,
          MAX_KEYS,
          (v) => now - v.windowStart >= this.windowMs,
          (v) => v.windowStart,
        );
      }
      this._map.set(key, { count: 1, windowStart: now });
      return { allowed: true, current: 1, limit: this.maxRequests };
    }

    // Within window
    entry.count++;
    if (entry.count > this.maxRequests) {
      const retryAfterMs = this.windowMs - (now - entry.windowStart);
      return {
        allowed: false,
        retryAfterMs: Math.max(retryAfterMs, 0),
        current: entry.count,
        limit: this.maxRequests,
      };
    }

    return { allowed: true, current: entry.count, limit: this.maxRequests };
  }

  /** For testing only: clear all entries. */
  _clearForTesting(): void {
    this._map.clear();
  }
}
