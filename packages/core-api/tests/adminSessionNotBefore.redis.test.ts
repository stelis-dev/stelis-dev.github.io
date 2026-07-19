import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  initializeAdminSessionNotBefore,
  raiseAdminSessionNotBefore,
} from '../src/admin/adminSessionNotBefore.js';
import { startRealRedis, type RealRedisHandle } from '../src/testing/redis.js';

const KEY = 'stelis:test:admin:not_before';

describe('admin session not-before — real Redis state transitions', () => {
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

  it('initializes once across instances and preserves an explicit logout cutoff', async () => {
    const firstStart = 1_700_000_000_000;
    const laterStart = firstStart + 5_000;
    const logoutCutoff = laterStart + 5_000;

    await expect(initializeAdminSessionNotBefore(redis!.client, KEY, firstStart)).resolves.toBe(
      firstStart,
    );
    await expect(initializeAdminSessionNotBefore(redis!.client, KEY, laterStart)).resolves.toBe(
      firstStart,
    );
    await raiseAdminSessionNotBefore(redis!.client, KEY, logoutCutoff);
    await expect(
      initializeAdminSessionNotBefore(redis!.client, KEY, logoutCutoff + 5_000),
    ).resolves.toBe(logoutCutoff);
    await expect(redis!.client.get(KEY)).resolves.toBe(String(logoutCutoff));
  });

  it('rejects a malformed existing cutoff without replacing it', async () => {
    await redis!.client.set(KEY, '01');

    await expect(
      initializeAdminSessionNotBefore(redis!.client, KEY, 1_700_000_000_000),
    ).rejects.toThrow(/INVALID_CURRENT_NOT_BEFORE/);
    await expect(redis!.client.get(KEY)).resolves.toBe('01');
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
