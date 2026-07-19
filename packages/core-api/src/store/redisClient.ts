export interface RedisSetOptions {
  nx?: boolean;
  xx?: boolean;
  px?: number;
}

/**
 * Minimal Redis client API required by the production adapters.
 *
 * The host app is responsible for providing a concrete client implementation.
 */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  /** HGETALL — returns the hash as `{field: value}`. Empty hash returns `{}`. */
  hgetall(key: string): Promise<Record<string, string>>;
}

// ── Raw redis v4 client adapter ──────────────────────────────────────

/**
 * Structural shape of a raw `redis` v4 client (camelCase API).
 *
 * The `redis` package uses `eval(script, { keys, arguments })` (object form).
 * `RedisClientLike` normalises this to `eval(script, keys, args)`
 * (positional form).
 */
export interface RawRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: Record<string, unknown>): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
}

/**
 * Wrap a raw `redis` v4 client into a `RedisClientLike`.
 *
 * Normalises:
 *   - `eval(script, { keys, arguments })` → `eval(script, keys, args)`
 *   - `set()` return → `'OK' | null`
 */
export function wrapRedisClient(raw: RawRedisClient): RedisClientLike {
  return {
    get(key) {
      return raw.get(key);
    },
    set(key, value, options) {
      const redisOpts: Record<string, unknown> = {};
      if (options?.nx) redisOpts.NX = true;
      if (options?.xx) redisOpts.XX = true;
      if (options?.px != null) redisOpts.PX = options.px;
      const hasOpts = Object.keys(redisOpts).length > 0;
      return raw.set(key, value, hasOpts ? redisOpts : undefined) as Promise<'OK' | null>;
    },
    del(...keys) {
      return raw.del(...keys);
    },
    eval(script, keys, args) {
      return raw.eval(script, { keys, arguments: args });
    },
    hgetall(key) {
      return raw.hGetAll(key);
    },
  };
}
