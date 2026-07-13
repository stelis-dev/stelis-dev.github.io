import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  signAdminJwt,
  verifyAdminJwt,
  type AdminJwtConfig,
  type AdminRedisClient,
} from '@stelis/core-api/admin';
import { startRealRedis, type RealRedisHandle } from '../../../core-api/tests/helpers/realRedis.js';
import type { AppApiContext } from '../../src/context.js';
import { createAdminRedisAdapter } from '../../src/adminRedis.js';
import type { RedisClient } from '../../src/redisClient.js';
import { requireAdminSession } from '../../src/requireAdminSession.js';
import { raiseAppApiAdminSessionNotBefore } from '../../src/adminSessionNotBefore.js';
import { createAuthRoutes } from '../../src/routes/auth.js';

const JWT_CONFIG: AdminJwtConfig = {
  jwtSecret: 'admin-logout-real-redis-test-secret'.padEnd(32, 'x'),
  sessionExpiry: '1h',
  issuer: 'app-api',
};
const ADMIN_ADDRESS = '0x' + '11'.repeat(32);

function appRedis(real: RealRedisHandle): RedisClient {
  return {
    get: (key) => real.client.get(key),
    async set(key, value, options) {
      await real.client.set(key, value, options);
    },
    del: (key) => real.client.del(key),
    scan: (pattern) => real.client.scan(pattern),
    ttl: async (key) => Number(await real.rawClient.sendCommand(['TTL', key])),
    lrange: async (key, start, stop) =>
      (await real.rawClient.sendCommand(['LRANGE', key, String(start), String(stop)])) as string[],
    lpush: async (key, value) => Number(await real.rawClient.sendCommand(['LPUSH', key, value])),
    async ltrim(key, start, stop) {
      await real.rawClient.sendCommand(['LTRIM', key, String(start), String(stop)]);
    },
    eval: (script, keys, args) => real.client.eval(script, keys, args),
    async dispose() {},
  };
}

async function guardToken(token: string, redis: AdminRedisClient) {
  const app = new Hono();
  app.get('/', async (c) =>
    c.json({ accepted: (await requireAdminSession(c, redis, JWT_CONFIG)) !== null }),
  );
  const response = await app.request('/', { headers: { Cookie: `stelis_admin=${token}` } });
  return (await response.json()) as { accepted: boolean };
}

describe('admin auth durability — real Redis and production adapters', () => {
  let real: RealRedisHandle | null = null;

  beforeAll(async () => {
    real = await startRealRedis();
  });
  beforeEach(async () => {
    await real!.flush();
  });
  afterAll(async () => {
    await real?.stop();
  });

  it('the logout route rejects its JWT and accepts a session issued after the cutoff', async () => {
    const redis = appRedis(real!);
    const adminRedis = createAdminRedisAdapter(redis);
    const contextPromise = Promise.resolve({ redis } as AppApiContext);
    const app = new Hono();
    app.route(
      '/auth',
      createAuthRoutes(contextPromise, {
        resolveClientIp: () => '127.0.0.1',
        adminAddress: ADMIN_ADDRESS,
        adminAuth: {
          jwt: JWT_CONFIG,
          cookie: { maxAgeSeconds: 3_600, secure: false, domain: null },
        },
      }),
    );

    await raiseAppApiAdminSessionNotBefore(adminRedis, 0);
    const oldToken = await signAdminJwt(ADMIN_ADDRESS, JWT_CONFIG);
    const oldSession = await verifyAdminJwt(oldToken, JWT_CONFIG);
    if (!oldSession) throw new Error('expected a valid old session');
    await expect(guardToken(oldToken, adminRedis)).resolves.toEqual({ accepted: true });

    const response = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `stelis_admin=${oldToken}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    await expect(guardToken(oldToken, adminRedis)).resolves.toEqual({ accepted: false });

    const cutoffRaw = await adminRedis.get('stelis:app-api:admin:not_before');
    if (cutoffRaw === null) throw new Error('expected the logout cutoff to be durable');
    const cutoff = Number(cutoffRaw);
    while (Date.now() < cutoff) await sleep(1);
    const newToken = await signAdminJwt(ADMIN_ADDRESS, JWT_CONFIG);
    await expect(guardToken(newToken, adminRedis)).resolves.toEqual({ accepted: true });
  });

  it('the production adapter allows only one concurrent nonce deletion winner', async () => {
    const redis = createAdminRedisAdapter(appRedis(real!));
    const nonceKey = 'stelis:admin:nonce:test-concurrent-consume';
    await redis.set(nonceKey, '1', { px: 60_000 });

    const results = await Promise.all([redis.del(nonceKey), redis.del(nonceKey)]);
    expect(results.sort()).toEqual([0, 1]);
  });
});
