/**
 * @stelis/core-api/testing/redis — real Redis test infrastructure.
 *
 * This explicit test-only subpath is the single owner of the Redis process
 * used by core-api and app-api conformance suites. Production code must not
 * import it; the package-boundary gate permits it only from workspace tests.
 */
import { createRequire } from 'node:module';
import { wrapRedisClient } from '../store/redisClient.js';
import type { RawRedisClient, RedisClientLike } from '../store/redisClient.js';

const require = createRequire(import.meta.url);

type RedisModule = typeof import('redis');
type RedisMemoryServerModule = {
  RedisMemoryServer: new () => {
    getHost(): Promise<string>;
    getPort(): Promise<number>;
    stop(): Promise<void>;
  };
};

type RedisRawClient = Awaited<ReturnType<RedisModule['createClient']>> & {
  sendCommand(command: string[]): Promise<unknown>;
};

export interface RealRedisHandle {
  client: RedisClientLike;
  rawClient: RedisRawClient;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

/** Start an isolated Redis-compatible process for conformance tests. */
export async function startRealRedis(): Promise<RealRedisHandle> {
  const redisModule = require('redis') as RedisModule;
  const redisMemoryServerModule = require('redis-memory-server') as RedisMemoryServerModule;

  const server = new redisMemoryServerModule.RedisMemoryServer();
  const host = await server.getHost();
  const port = await server.getPort();
  const rawClient = redisModule.createClient({
    url: `redis://${host}:${port}`,
  }) as RedisRawClient;

  let clientConnected = false;
  try {
    await rawClient.connect();
    clientConnected = true;
  } catch (error) {
    await server.stop();
    throw error;
  }

  const wrapped = wrapRedisClient(rawClient as unknown as RawRedisClient);
  return {
    client: wrapped,
    rawClient,
    async flush() {
      await rawClient.sendCommand(['FLUSHDB']);
    },
    async stop() {
      if (clientConnected && rawClient.isOpen) {
        await rawClient.quit();
      }
      await server.stop();
    },
  };
}
