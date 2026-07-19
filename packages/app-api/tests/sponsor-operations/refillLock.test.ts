import { describe, expect, it } from 'vitest';
import type { RedisClientLike } from '@stelis/core-api';

type RedisSetOptions = Parameters<RedisClientLike['set']>[2];
import {
  createSponsorRefillAccountDispatchLock,
  sponsorRefillAccountDispatchLockKey,
} from '../../src/sponsor-operations/refillLock.js';

class LockRedis implements RedisClientLike {
  private readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string, options?: RedisSetOptions) {
    if (options?.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK' as const;
  }
  async del(...keys: string[]) {
    return keys.reduce((count, key) => count + Number(this.values.delete(key)), 0);
  }
  async eval(_script: string, keys: string[], args: string[]) {
    if (this.values.get(keys[0]!) === args[0]) {
      this.values.delete(keys[0]!);
      return 'OK';
    }
    return 'MISMATCH';
  }
  async hgetall() {
    return {};
  }
}

const ACCOUNT = `0x${'11'.repeat(32)}`;

describe('Sponsor Refill Account dispatch lock', () => {
  it('uses one account-scoped Redis key for refill and withdrawal coordination', () => {
    expect(sponsorRefillAccountDispatchLockKey(ACCOUNT)).toBe(
      `stelis:app-api:sponsor-operations:sponsor-refill-account-dispatch-lock:${ACCOUNT}`,
    );
  });

  it('admits one owner and releases only its matching token', async () => {
    const redis = new LockRedis();
    const first = createSponsorRefillAccountDispatchLock({
      client: redis,
      ttlMs: 1_000,
      instanceId: 'first',
    });
    const second = createSponsorRefillAccountDispatchLock({
      client: redis,
      ttlMs: 1_000,
      instanceId: 'second',
    });

    const handle = await first.acquire(ACCOUNT);
    expect(handle).not.toBeNull();
    expect(await second.acquire(ACCOUNT)).toBeNull();
    await first.release(handle!);
    expect(await second.acquire(ACCOUNT)).not.toBeNull();
  });
});
