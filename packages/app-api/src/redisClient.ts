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
import { redactSensitiveText } from '@stelis/core-api/observability';

interface RedisRuntimeClient extends RawRedisClient {
  isOpen?: boolean;
  connect(): Promise<void>;
  quit(): Promise<void>;
  ttl(key: string): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lPush(key: string, ...values: string[]): Promise<number>;
  lTrim(key: string, start: number, stop: number): Promise<void>;
  /** Raw command execution — used for topology probe before wrapping. */
  sendCommand?(args: string[]): Promise<unknown>;
}

function isClientClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'ClientClosedError' || /client is closed/i.test(error.message);
}

async function loadRedisModule(): Promise<{
  createClient: (options: { url: string }) => RedisRuntimeClient;
}> {
  try {
    return (await import(/* webpackIgnore: true */ 'redis')) as unknown as {
      createClient: (options: { url: string }) => RedisRuntimeClient;
    };
  } catch (error) {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
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
  dispose(): Promise<void>;
}

export async function createRedisClient(redisUrl: string): Promise<RedisClient> {
  const { createClient } = await loadRedisModule();
  const client = createClient({ url: redisUrl });
  let reconnectPromise: Promise<void> | null = null;

  async function connectAndProbe(): Promise<void> {
    if (!client.isOpen) {
      await client.connect();
    }

    try {
      await assertSupportedRedisTopology(client);
    } catch (err) {
      // Clean up the connected client before propagating the failure.
      // Prevents connection leak in boot-failure-retry environments and keeps
      // reconnect attempts fail-closed if the endpoint changes under us.
      if (client.isOpen) {
        await client.quit().catch(() => {});
      }
      throw err;
    }
  }

  async function ensureOpen(): Promise<void> {
    if (client.isOpen) return;
    reconnectPromise ??= connectAndProbe().finally(() => {
      reconnectPromise = null;
    });
    await reconnectPromise;
  }

  async function withOpenClient<T>(operation: () => Promise<T>): Promise<T> {
    await ensureOpen();
    try {
      return await operation();
    } catch (err) {
      if (!isClientClosedError(err)) throw err;
      await ensureOpen();
      return operation();
    }
  }

  // ── Topology probe (fail-closed) ─────────────────────────────────
  // Must run before wrapRedisClient() drops raw command access.
  // RedisPrepareStore.consume() uses dynamic Lua key access that Redis
  // Multi-key Lua scripts require one writable Redis data endpoint. Boot must reject
  // unsupported topologies rather than relying on operator memory.
  await connectAndProbe();

  const commandClient: RawRedisClient = {
    get(key) {
      return withOpenClient(() => client.get(key));
    },
    set(key, value, options) {
      return withOpenClient(() => client.set(key, value, options));
    },
    del(...keys) {
      return withOpenClient(() => client.del(...keys));
    },
    eval(script, options) {
      return withOpenClient(() => client.eval(script, options));
    },
    hGetAll(key) {
      return withOpenClient(() => client.hGetAll(key));
    },
  };
  if (client.scanIterator) {
    commandClient.scanIterator = (options) =>
      (async function* scanWithOpenClient() {
        await ensureOpen();
        for await (const key of client.scanIterator!(options)) {
          yield key;
        }
      })();
  }
  if (client.ping) {
    commandClient.ping = () => withOpenClient(() => client.ping!());
  }
  if (client.quit) {
    commandClient.quit = async () => {
      if (client.isOpen) {
        await client.quit();
      }
    };
  }

  const wrapped = wrapRedisClient(commandClient);

  return {
    ...wrapped,
    ttl(key) {
      return withOpenClient(() => client.ttl(key));
    },
    lrange(key, start, stop) {
      return withOpenClient(() => client.lRange(key, start, stop));
    },
    lpush(key, value) {
      return withOpenClient(() => client.lPush(key, value));
    },
    ltrim(key, start, stop) {
      return withOpenClient(() => client.lTrim(key, start, stop));
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
        `Original error: ${redactSensitiveText(err instanceof Error ? err.message : String(err))}`,
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
