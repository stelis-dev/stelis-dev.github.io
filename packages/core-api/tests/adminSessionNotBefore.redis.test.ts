import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { raiseAdminSessionNotBefore } from '../src/admin/adminSessionNotBefore.js';
import { startRealRedis, type RealRedisHandle } from '../src/testing/redis.js';

const KEY = 'stelis:test:admin:not_before';

describe('admin session not-before — real Redis monotonicity', () => {
  let redis: RealRedisHandle | null = null;

  beforeAll(async () => {
    redis = await startRealRedis();
  });

  beforeEach(async () => {
    await redis!.flush();
  });

  afterAll(async () => {
    await redis?.stop();
  });

  it('boot and logout writes preserve the logout cutoff in both execution orders', async () => {
    const bootCandidate = 1_700_000_000_000;
    const logoutCandidate = bootCandidate + 10_000;

    await raiseAdminSessionNotBefore(redis!.client, KEY, logoutCandidate);
    await raiseAdminSessionNotBefore(redis!.client, KEY, bootCandidate);
    await expect(redis!.client.get(KEY)).resolves.toBe(String(logoutCandidate));

    await redis!.flush();
    await raiseAdminSessionNotBefore(redis!.client, KEY, bootCandidate);
    await raiseAdminSessionNotBefore(redis!.client, KEY, logoutCandidate);
    await expect(redis!.client.get(KEY)).resolves.toBe(String(logoutCandidate));
  });

  it('logout writes preserve the greatest cutoff in both execution orders', async () => {
    const earlier = 1_700_000_000_001;
    const later = earlier + 2;

    await raiseAdminSessionNotBefore(redis!.client, KEY, later);
    await raiseAdminSessionNotBefore(redis!.client, KEY, earlier);
    await expect(redis!.client.get(KEY)).resolves.toBe(String(later));

    await redis!.flush();
    await raiseAdminSessionNotBefore(redis!.client, KEY, earlier);
    await raiseAdminSessionNotBefore(redis!.client, KEY, later);
    await expect(redis!.client.get(KEY)).resolves.toBe(String(later));
  });
});
