import type { RedisClientLike } from '../../src/store/redisClient.js';

type RedisSetOptions = Parameters<RedisClientLike['set']>[2];

interface FakeRedisEntry {
  value: string;
  expiresAt: number | null;
}

/**
 * Minimal in-memory Redis implementation for adapter unit tests.
 *
 * It intentionally supports only the subset used by Stelis adapters:
 * `GET`, `SET NX PX`, `DEL`, `HGETALL`, and the small Lua scripts
 * embedded in the Redis-backed stores. Counter and TTL mutations inside Lua
 * scripts are emulated by private helpers, not exposed on RedisClientLike.
 *
 * This is not production Redis semantics evidence. Real Redis conformance
 * lives in `*.redis.test.ts` and runs through `test:redis`.
 */
export class FakeRedisClient implements RedisClientLike {
  private readonly _store = new Map<string, FakeRedisEntry>();

  async get(key: string): Promise<string | null> {
    this.evictIfExpired(key);
    return this._store.get(key)?.value ?? null;
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<'OK' | null> {
    this.evictIfExpired(key);
    const exists = this._store.has(key);

    if (options?.nx && exists) return null;
    if (options?.xx && !exists) return null;

    this._store.set(key, {
      value,
      expiresAt: options?.px != null ? Date.now() + options.px : null,
    });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      this.evictIfExpired(key);
      if (this._store.delete(key)) deleted += 1;
    }
    return deleted;
  }

  private incrementForLua(key: string): number {
    this.evictIfExpired(key);
    const entry = this._store.get(key);
    const current = entry ? Number(entry.value) : 0;
    const next = current + 1;
    this._store.set(key, {
      value: String(next),
      expiresAt: entry?.expiresAt ?? null,
    });
    return next;
  }

  private setExpiryForLua(key: string, ttlMs: number): boolean {
    this.evictIfExpired(key);
    const entry = this._store.get(key);
    if (!entry) return false;
    entry.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    if (script.includes('RedisSponsorPool REDIS_TIME_MS_SCRIPT')) {
      return String(Date.now());
    }

    // ── RedisSponsorPool LEASE_STATUS_SCRIPT emulation ──
    // Reads lease-key presence for all configured sponsor slots and returns
    // the same positional rows as the production Lua script.
    if (script.includes('RedisSponsorPool LEASE_STATUS_SCRIPT')) {
      let leasedSlots = 0;
      const rows: string[][] = [];
      for (let i = 0; i < keys.length; i++) {
        const value = await this.get(keys[i]!);
        const leased = value !== null;
        if (leased) leasedSlots += 1;
        rows.push([args[i] ?? '', leased ? '1' : '0']);
      }
      return [String(leasedSlots), rows];
    }

    // ── RedisSponsorPool LEASE_CHECKOUT_SCRIPT emulation ──
    // Tries rotated lease keys in order and returns the first reserved
    // slot address plus its one-based offset, matching the production Lua
    // response used to advance RedisSponsorPool's local cursor.
    if (script.includes('RedisSponsorPool LEASE_CHECKOUT_SCRIPT')) {
      const ttlMs = Number(args[0]);
      const slotCount = keys.length;
      for (let i = 0; i < slotCount; i++) {
        const slotAddress = args[1 + i];
        const reservedProof = args[1 + slotCount + i];
        if (slotAddress === undefined || reservedProof === undefined) continue;
        const result = await this.set(keys[i]!, reservedProof, { nx: true, px: ttlMs });
        if (result === 'OK') {
          return [slotAddress, String(i + 1)];
        }
      }
      return null;
    }

    if (script.includes("redis.call('INCR'")) {
      const key = keys[0];
      const ttlMs = Number(args[0]);
      const current = this.incrementForLua(key);
      if (current === 1) {
        this.setExpiryForLua(key, ttlMs);
      }
      const ttl = this.pttl(key);
      return [current, ttl];
    }

    // ── RedisSponsorPool LEASE_CHECKIN_CAS_SCRIPT emulation ──
    // if GET == expected → DEL; else MISMATCH.
    if (script.includes("return 'MISMATCH'")) {
      const key = keys[0];
      const expected = args[0];
      const current = await this.get(key);
      if (current === expected) {
        await this.del(key);
        return 'OK';
      }
      return 'MISMATCH';
    }

    // ── PromotionStore CREATE_LUA emulation ──
    if (
      script.includes("redis.call('EXISTS', KEYS[1])") &&
      script.includes("redis.call('ZADD', KEYS[2], 0, ARGV[2])") &&
      script.includes("redis.call('ZADD', KEYS[3], 0, ARGV[2])")
    ) {
      if ((await this.get(keys[0])) !== null) return 'CURRENT_CONFLICT';
      if (keys.slice(1).some((key) => this._zscore(key, args[1]) !== null)) {
        return 'INDEX_CONFLICT';
      }
      await this.set(keys[0], args[0]);
      this._zadd(keys[1], 0, args[1]);
      this._zadd(keys[2], 0, args[1]);
      return 'OK';
    }

    // ── PromotionStore PAGE_LUA emulation ──
    if (
      script.includes("redis.call('ZRANGEBYLEX', KEYS[1]") &&
      script.includes("redis.call('MGET', unpack(keys))")
    ) {
      const cursor = args[1] === '' ? null : args[1];
      const count = Number(args[2]);
      const ids = this._zrangeByLex(keys[0], cursor, count);
      const results: string[] = ['OK'];
      for (const id of ids) {
        const raw = await this.get(args[0] + id);
        if (raw === null) return ['INDEX_RECORD_MISSING', id];
        const memberships: string[] = [];
        for (const indexKey of keys.slice(1, 6)) {
          const score = this._zscore(indexKey, id);
          if (score !== null && score !== 0) return ['INDEX_SCORE_INVALID', id];
          memberships.push(score === null ? '0' : '1');
        }
        results.push(id, raw, ...memberships);
      }
      return results;
    }

    // ── PromotionStore UPDATE_LUA (exact-record CAS) emulation ──
    if (
      script.includes('currentRaw ~= ARGV[1]') &&
      script.includes("redis.call('SET', KEYS[1], ARGV[2])") &&
      !script.includes("redis.call('ZREM', KEYS[2], ARGV[3])") &&
      !script.includes("redis.call('ZREM', KEYS[currentIndex], ARGV[3])")
    ) {
      const raw = await this.get(keys[0]);
      if (raw === null || raw !== args[0]) return 'CURRENT_CONFLICT';
      await this.set(keys[0], args[1]);
      return 'OK';
    }

    // ── PromotionStore STATUS_LUA (record CAS + index move) emulation ──
    if (
      script.includes('currentRaw ~= ARGV[1]') &&
      script.includes("redis.call('SET', KEYS[1], ARGV[2])") &&
      script.includes("redis.call('ZREM', KEYS[currentIndex], ARGV[3])") &&
      script.includes("redis.call('ZADD', KEYS[targetIndex], 0, ARGV[3])")
    ) {
      const raw = await this.get(keys[0]);
      if (raw === null || raw !== args[0]) return 'CURRENT_CONFLICT';
      const currentIndex = Number(args[3]) - 1;
      const targetIndex = Number(args[4]) - 1;
      if (
        currentIndex < 2 ||
        currentIndex > 5 ||
        targetIndex < 2 ||
        targetIndex > 5 ||
        currentIndex === targetIndex ||
        this._zscore(keys[1], args[2]) !== 0
      )
        return 'INDEX_CONFLICT';
      for (let index = 2; index <= 5; index++) {
        const score = this._zscore(keys[index], args[2]);
        if (index === currentIndex ? score !== 0 : score !== null) return 'INDEX_CONFLICT';
      }
      await this.set(keys[0], args[1]);
      this._zrem(keys[currentIndex], args[2]);
      this._zadd(keys[targetIndex], 0, args[2]);
      return 'OK';
    }

    // ── PromotionStore DELETE_LUA emulation ──
    if (
      script.includes("ARGV[3] ~= 'delete'") &&
      script.includes("redis.call('EXISTS', KEYS[7])") &&
      script.includes("redis.call('DEL', KEYS[1])") &&
      script.includes("redis.call('ZREM', KEYS[2], ARGV[2])") &&
      script.includes("redis.call('ZREM', KEYS[currentIndex], ARGV[2])")
    ) {
      const raw = await this.get(keys[0]);
      if (raw === null) {
        if (args[0] !== '') return 'CURRENT_CONFLICT';
        for (const indexKey of keys.slice(1, 6)) {
          if (this._zscore(indexKey, args[1]) !== null) return 'INDEX_CONFLICT';
        }
        if (
          (await this.get(keys[6])) !== null ||
          Object.keys(await this.hgetall(keys[6])).length > 0
        )
          return 'ACCOUNTING_PRESENT';
        return 'NOT_FOUND';
      }
      if (args[0] === '' || raw !== args[0]) return 'CURRENT_CONFLICT';
      const currentIndex = Number(args[3]) - 1;
      if (currentIndex < 2 || currentIndex > 5 || this._zscore(keys[1], args[1]) !== 0) {
        return 'INDEX_CONFLICT';
      }
      for (let index = 2; index <= 5; index++) {
        const score = this._zscore(keys[index], args[1]);
        if (index === currentIndex ? score !== 0 : score !== null) return 'INDEX_CONFLICT';
      }
      if (args[2] !== 'delete') return 'NOT_DELETABLE';
      if (currentIndex !== 2) return 'INDEX_CONFLICT';
      if (
        (await this.get(keys[6])) !== null ||
        Object.keys(await this.hgetall(keys[6])).length > 0
      ) {
        return 'ACCOUNTING_PRESENT';
      }
      await this.del(keys[0]);
      this._zrem(keys[1], args[1]);
      this._zrem(keys[currentIndex], args[1]);
      return 'OK';
    }

    throw new Error(`FakeRedisClient: unsupported eval script\n${script}`);
  }

  async hgetall(_key: string): Promise<Record<string, string>> {
    return {};
  }

  private pttl(key: string): number {
    this.evictIfExpired(key);
    const entry = this._store.get(key);
    if (!entry) return -2;
    if (entry.expiresAt == null) return -1;
    return Math.max(entry.expiresAt - Date.now(), 0);
  }

  private evictIfExpired(key: string): void {
    const entry = this._store.get(key);
    if (!entry?.expiresAt) return;
    if (entry.expiresAt <= Date.now()) {
      this._store.delete(key);
    }
  }

  // ── Redis sorted-set data structure emulation ─────────────────────

  private readonly _zsets = new Map<string, Map<string, number>>();

  /** ZADD equivalent used by PromotionStore's same-score lex indexes. */
  private _zadd(key: string, score: number, member: string): void {
    let zset = this._zsets.get(key);
    if (!zset) {
      zset = new Map<string, number>();
      this._zsets.set(key, zset);
    }
    zset.set(member, score);
  }

  private _zscore(key: string, member: string): number | null {
    return this._zsets.get(key)?.get(member) ?? null;
  }

  /** Bounded exclusive ZRANGEBYLEX for equal-score members. */
  private _zrangeByLex(key: string, cursor: string | null, count: number): string[] {
    const zset = this._zsets.get(key);
    if (!zset) return [];
    return Array.from(zset.entries())
      .filter(([, score]) => score === 0)
      .map(([member]) => member)
      .sort()
      .filter((member) => cursor === null || member > cursor)
      .slice(0, count);
  }

  /** ZREM equivalent. */
  private _zrem(key: string, member: string): void {
    const zset = this._zsets.get(key);
    if (zset) {
      zset.delete(member);
      if (zset.size === 0) this._zsets.delete(key);
    }
  }
}
