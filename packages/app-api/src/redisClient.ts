/**
 * [app-api] Redis client creation — host layer utility.
 *
 * Creates a Redis client connection and wraps it with the core-api
 * RedisClientLike interface for use with domain store adapters.
 *
 * Uses wrapRedisClient, RedisClientLike, and RawRedisClient from @stelis/core-api.
 */
import type { RedisClientLike, RawRedisClient } from '@stelis/core-api';
import { wrapRedisClient } from '@stelis/core-api';

interface RedisRuntimeClient extends RawRedisClient {
  isOpen?: boolean;
  connect(): Promise<void>;
  quit(): Promise<void>;
  ttl(key: string): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lPush(key: string, ...values: string[]): Promise<number>;
  lTrim(key: string, start: number, stop: number): Promise<void>;
  hIncrBy(key: string, field: string, increment: number): Promise<number>;
  hSet(key: string, field: string, value: string): Promise<number>;
  sAdd(key: string, ...members: string[]): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  sRem(key: string, ...members: string[]): Promise<number>;
  /** Raw command execution — used for topology probe before wrapping. */
  sendCommand?(args: string[]): Promise<unknown>;
}

async function loadRedisModule(): Promise<{
  createClient: (options: { url: string }) => RedisRuntimeClient;
}> {
  try {
    return (await import(/* webpackIgnore: true */ 'redis')) as unknown as {
      createClient: (options: { url: string }) => RedisRuntimeClient;
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      'The "redis" package is required for @stelis/app-api. ' +
        'Run "npm install" in the workspace before starting. ' +
        `Original error: ${message}`,
    );
  }
}

export interface RedisClient extends RedisClientLike {
  ttl(key: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hset(key: string, field: string, value: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  dispose(): Promise<void>;
}

export async function createRedisClient(redisUrl: string): Promise<RedisClient> {
  const { createClient } = await loadRedisModule();
  const client = createClient({ url: redisUrl });

  if (!client.isOpen) {
    await client.connect();
  }

  // ── Topology probe (fail-closed) ─────────────────────────────────
  // Must run before wrapRedisClient() drops raw command access.
  // RedisPrepareStore.consume() uses dynamic Lua key access that Redis
  // Multi-key Lua scripts require one writable Redis data endpoint. Boot must reject
  // unsupported topologies rather than relying on operator memory.
  try {
    await assertSupportedRedisTopology(client);
  } catch (err) {
    // Clean up the connected client before propagating the failure.
    // Prevents connection leak in boot-failure-retry environments.
    if (client.isOpen) {
      await client.quit().catch(() => {});
    }
    throw err;
  }

  const wrapped = wrapRedisClient(client);

  return {
    ...wrapped,
    ttl(key) {
      return client.ttl(key);
    },
    lrange(key, start, stop) {
      return client.lRange(key, start, stop);
    },
    lpush(key, value) {
      return client.lPush(key, value);
    },
    ltrim(key, start, stop) {
      return client.lTrim(key, start, stop);
    },
    hincrby(key, field, increment) {
      return client.hIncrBy(key, field, increment);
    },
    hset(key, field, value) {
      return client.hSet(key, field, value);
    },
    sadd(key, ...members) {
      return client.sAdd(key, ...members);
    },
    smembers(key) {
      return client.sMembers(key);
    },
    srem(key, ...members) {
      return client.sRem(key, ...members);
    },
    async dispose() {
      if (client.isOpen) {
        await client.quit();
      }
    },
  };
}

/**
 * Fail-closed topology probe. Only a writable standalone Redis data endpoint is supported.
 *
 * Probe rules:
 *   - `redis_mode:standalone` → boot proceeds
 *   - `redis_mode:cluster` or `redis_mode:sentinel` → fail closed
 *   - Command unavailable / permission denied / transport error / unrecognized → fail closed
 *
 * Uses `INFO server` which includes `redis_mode` in the server section.
 * Valid values: `standalone`, `cluster`, `sentinel`.
 *
 * Managed failover support requires a single writable data endpoint that
 * reports `redis_mode:standalone`.
 * Direct Sentinel and Redis Cluster endpoints are not supported.
 */
async function assertSupportedRedisTopology(client: RedisRuntimeClient): Promise<void> {
  let infoText: string;
  try {
    if (!client.sendCommand) {
      throw new Error(
        'Redis client does not support sendCommand — cannot probe topology. ' +
          'Ensure the redis package version supports raw command execution.',
      );
    }
    const result = await client.sendCommand(['INFO', 'server']);
    if (typeof result !== 'string') {
      throw new Error(
        `Unexpected INFO server response type: ${typeof result}. ` +
          'Cannot determine Redis topology — fail closed.',
      );
    }
    infoText = result;
  } catch (err) {
    // Command unavailable, permission denied, or transport error → fail closed
    throw new Error(
      `Redis topology probe failed — cannot verify supported deployment. ` +
        `Stelis requires a standalone Redis data endpoint. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Parse redis_mode field from the server section topology config.
  const match = infoText.match(/redis_mode:(\w+)/);
  if (!match) {
    throw new Error(
      'Redis INFO server did not contain redis_mode field. ' +
        'Cannot determine topology — fail closed. ' +
        'Stelis requires a standalone Redis data endpoint.',
    );
  }

  const mode = match[1];
  if (mode !== 'standalone') {
    throw new Error(
      `Unsupported Redis topology: redis_mode:${mode}. ` +
        'Stelis requires a standalone Redis data endpoint. ' +
        'Direct Redis Cluster and Sentinel endpoints are not supported. ' +
        'RedisPrepareStore.consume() uses dynamic Lua key access ' +
        'that multi-key Lua scripts require one writable data endpoint, and shared locks require one write authority.',
    );
  }

  // redis_mode:standalone → supported
}
