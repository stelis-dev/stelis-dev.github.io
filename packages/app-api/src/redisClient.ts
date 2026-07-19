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
  isOpen: boolean;
  on(event: 'error', listener: (error: unknown) => void): this;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lPush(key: string, ...values: string[]): Promise<number>;
  lTrim(key: string, start: number, stop: number): Promise<void>;
  /** Raw command execution — used for topology probe before wrapping. */
  sendCommand(args: string[], options?: { readonly signal?: AbortSignal }): Promise<unknown>;
}

const REQUIRED_REDIS_RUNTIME_METHODS = [
  'connect',
  'disconnect',
  'on',
  'get',
  'set',
  'del',
  'eval',
  'hGetAll',
  'lRange',
  'lPush',
  'lTrim',
  'sendCommand',
] as const;

function assertRedisRuntimeClient(value: unknown): asserts value is RedisRuntimeClient {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Redis runtime did not create a client object');
  }
  const missing = REQUIRED_REDIS_RUNTIME_METHODS.filter(
    (method) => typeof Reflect.get(value, method) !== 'function',
  );
  if (missing.length > 0) {
    throw new Error(`Redis runtime is missing required command methods: ${missing.join(', ')}`);
  }
  if (typeof Reflect.get(value, 'isOpen') !== 'boolean') {
    throw new Error('Redis runtime client is missing the required isOpen state');
  }
}

async function loadRedisModule(): Promise<{
  createClient: (options: {
    url: string;
    socket: { reconnectStrategy: false; signal?: AbortSignal };
  }) => RedisRuntimeClient;
}> {
  try {
    return (await import(/* webpackIgnore: true */ 'redis')) as unknown as {
      createClient: (options: {
        url: string;
        socket: { reconnectStrategy: false; signal?: AbortSignal };
      }) => RedisRuntimeClient;
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
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  dispose(): Promise<void>;
}

export async function createRedisClient(
  redisUrl: string,
  startupSignal?: AbortSignal,
): Promise<RedisClient> {
  const { createClient } = await loadRedisModule();
  // A runtime must be able to abort and clean up a failed start. The node-redis
  // default reconnect loop can otherwise keep the initial connect pending
  // forever while the raw client is still private to this factory. Independent
  // later commands may call ensureOpen(), but each connection attempt is finite.
  // node-redis stores its internal socket only after TCP/TLS connect resolves,
  // so disconnect() alone cannot cancel a connection that is still pending.
  // RedisSocket forwards this option to Node net.connect/tls.connect; binding
  // the owner signal here makes cancellation destroy both pending and connected
  // sockets, including an independent reconnect during runtime shutdown.
  const client = createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: false,
      ...(startupSignal === undefined ? {} : { signal: startupSignal }),
    },
  });
  assertRedisRuntimeClient(client);
  client.on('error', (error) => {
    if (startupSignal?.aborted) return;
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    // Command promises remain the operation-level failure authority. This
    // listener owns node-redis's separate process-level EventEmitter channel.
    // eslint-disable-next-line no-console
    console.error(`[app-api] Redis client error: ${message}`);
  });
  let reconnectPromise: Promise<void> | null = null;

  const disconnectImmediately = async (): Promise<void> => {
    if (!client.isOpen) return;
    await client.disconnect().catch(() => undefined);
  };

  async function connectAndProbe(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!client.isOpen) {
      await client.connect();
    }
    signal?.throwIfAborted();

    try {
      await assertSupportedRedisTopology(client, signal);
      signal?.throwIfAborted();
    } catch (err) {
      // Failure and cancellation use an immediate socket disconnect. QUIT is
      // itself a Redis command and cannot be trusted to settle on this path.
      await disconnectImmediately();
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
    // Once a command has been submitted, a transport error does not prove
    // whether Redis applied it. Replaying here would be unsafe for EVAL,
    // LPUSH, counters, and other mutations. The current call fails closed;
    // a later independent call reconnects and re-runs the topology probe
    // before sending its own command.
    return operation();
  }

  // ── Topology probe (fail-closed) ─────────────────────────────────
  // Must run before wrapRedisClient() drops raw command access.
  // Receipt lifecycle scripts use dynamic Lua key access that Redis
  // Multi-key Lua scripts require one writable Redis data endpoint. Boot must reject
  // unsupported topologies rather than relying on operator memory.
  const onStartupAbort = () => {
    void disconnectImmediately();
  };
  startupSignal?.addEventListener('abort', onStartupAbort, { once: true });
  try {
    await connectAndProbe(startupSignal);
  } catch (error) {
    await disconnectImmediately();
    throw error;
  } finally {
    startupSignal?.removeEventListener('abort', onStartupAbort);
  }

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

  const wrapped = wrapRedisClient(commandClient);

  return {
    ...wrapped,
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
        await client.disconnect();
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
async function assertSupportedRedisTopology(
  client: RedisRuntimeClient,
  signal?: AbortSignal,
): Promise<void> {
  let infoText: string;
  try {
    const result =
      signal === undefined
        ? await client.sendCommand(['INFO', 'server'])
        : await client.sendCommand(['INFO', 'server'], { signal });
    if (typeof result !== 'string') {
      throw new Error(
        `Unexpected INFO server response type: ${typeof result}. ` +
          'Cannot determine Redis topology — fail closed.',
      );
    }
    infoText = result;
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
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
        'Receipt lifecycle scripts use dynamic Lua key access ' +
        'that multi-key Lua scripts require one writable data endpoint, and shared locks require one write authority.',
    );
  }

  // redis_mode:standalone → supported
}
