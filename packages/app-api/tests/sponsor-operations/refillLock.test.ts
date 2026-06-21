import { describe, it, expect, beforeEach } from 'vitest';
import type { RedisClientLike, RedisSetOptions } from '@stelis/core-api';
import {
  createRefillLock,
  createSponsorRefillAccountDispatchLock,
  refillLockKey,
  sponsorRefillAccountDispatchLockKey,
} from '../../src/sponsor-operations/refillLock.js';

// Minimal SET NX PX + Lua CAS DEL emulator for the lock's two operations.
class StubRedis implements RedisClientLike {
  readonly store = new Map<string, { value: string; expiresAt: number | null }>();

  private evict(key: string): void {
    const entry = this.store.get(key);
    if (entry?.expiresAt != null && entry.expiresAt <= Date.now()) this.store.delete(key);
  }

  async get(key: string): Promise<string | null> {
    this.evict(key);
    return this.store.get(key)?.value ?? null;
  }
  async set(key: string, value: string, options?: RedisSetOptions): Promise<'OK' | null> {
    this.evict(key);
    if (options?.nx && this.store.has(key)) return null;
    this.store.set(key, {
      value,
      expiresAt: options?.px != null ? Date.now() + options.px : null,
    });
    return 'OK';
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n += 1;
    return n;
  }
  async scan(_p: string): Promise<string[]> {
    return [];
  }
  async hgetall(_k: string): Promise<Record<string, string>> {
    return {};
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    // Release CAS: DEL only when GET(key) === expected token.
    if (script.includes("redis.call('DEL', KEYS[1])") && script.includes("'MISMATCH'")) {
      const cur = await this.get(keys[0]);
      if (cur === args[0]) {
        await this.del(keys[0]);
        return 'OK';
      }
      return 'MISMATCH';
    }
    throw new Error('StubRedis: unsupported eval');
  }
}

const SLOT_A = '0xslota';
const SLOT_B = '0xslotb';
const SPONSOR_REFILL_ACCOUNT_A = '0x' + '11'.repeat(32);
const SPONSOR_REFILL_ACCOUNT_B = '0x' + '22'.repeat(32);

describe('refillLockKey', () => {
  it('uses the stelis:app-api:sponsor-operations:refill-lock: prefix', () => {
    expect(refillLockKey(SLOT_A)).toBe(`stelis:app-api:sponsor-operations:refill-lock:${SLOT_A}`);
  });

  it('uses the sponsor refill account dispatch lock prefix for account-scoped dispatch', () => {
    expect(sponsorRefillAccountDispatchLockKey(SPONSOR_REFILL_ACCOUNT_A)).toBe(
      `stelis:app-api:sponsor-operations:sponsor-refill-account-dispatch-lock:${SPONSOR_REFILL_ACCOUNT_A}`,
    );
  });
});

describe('createRefillLock', () => {
  let redis: StubRedis;

  beforeEach(() => {
    redis = new StubRedis();
  });

  it('throws on non-positive or non-finite ttlMs', () => {
    expect(() => createRefillLock({ client: redis, ttlMs: 0 })).toThrow(
      /ttlMs must be a positive safe integer/,
    );
    expect(() => createRefillLock({ client: redis, ttlMs: Number.NaN })).toThrow(
      /ttlMs must be a positive safe integer/,
    );
    expect(() => createRefillLock({ client: redis, ttlMs: -1 })).toThrow(
      /ttlMs must be a positive safe integer/,
    );
  });

  it('acquire returns a handle on the first call for a slot', async () => {
    const lock = createRefillLock({ client: redis, ttlMs: 10_000 });
    const handle = await lock.acquire(SLOT_A);
    expect(handle).not.toBeNull();
    expect(handle!.slotAddress).toBe(SLOT_A);
    expect(handle!.token).toMatch(/^app-api:/);
  });

  it('acquire returns null when another owner still holds the lock for the same slot', async () => {
    const lockA = createRefillLock({ client: redis, ttlMs: 10_000, instanceId: 'instance-a' });
    const lockB = createRefillLock({ client: redis, ttlMs: 10_000, instanceId: 'instance-b' });
    const first = await lockA.acquire(SLOT_A);
    const second = await lockB.acquire(SLOT_A);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('acquire admits the next owner after release', async () => {
    const lock = createRefillLock({ client: redis, ttlMs: 10_000 });
    const first = await lock.acquire(SLOT_A);
    expect(first).not.toBeNull();
    await lock.release(first!);
    const second = await lock.acquire(SLOT_A);
    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first!.token);
  });

  it('release is a silent no-op when the stored token does not match', async () => {
    const lockA = createRefillLock({ client: redis, ttlMs: 10_000, instanceId: 'instance-a' });
    const lockB = createRefillLock({ client: redis, ttlMs: 10_000, instanceId: 'instance-b' });
    const first = await lockA.acquire(SLOT_A);
    expect(first).not.toBeNull();
    // Forge a handle with a different token; CAS rejects DEL.
    await lockB.release({ slotAddress: SLOT_A, token: 'instance-b:forged' });
    expect(await redis.get(refillLockKey(SLOT_A))).toBe(first!.token);
  });

  it('locks on different slots are independent', async () => {
    const lock = createRefillLock({ client: redis, ttlMs: 10_000 });
    const a = await lock.acquire(SLOT_A);
    const b = await lock.acquire(SLOT_B);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.token).not.toBe(b!.token);
  });
});

describe('createSponsorRefillAccountDispatchLock', () => {
  let redis: StubRedis;

  beforeEach(() => {
    redis = new StubRedis();
  });

  it('throws on non-positive or non-finite ttlMs', () => {
    expect(() => createSponsorRefillAccountDispatchLock({ client: redis, ttlMs: 0 })).toThrow(
      /ttlMs must be a positive safe integer/,
    );
    expect(() =>
      createSponsorRefillAccountDispatchLock({ client: redis, ttlMs: Number.NaN }),
    ).toThrow(/ttlMs must be a positive safe integer/);
    expect(() => createSponsorRefillAccountDispatchLock({ client: redis, ttlMs: -1 })).toThrow(
      /ttlMs must be a positive safe integer/,
    );
  });

  it('acquire returns null when another owner still holds the lock for the same sponsor refill account', async () => {
    const lockA = createSponsorRefillAccountDispatchLock({
      client: redis,
      ttlMs: 10_000,
      instanceId: 'instance-a',
    });
    const lockB = createSponsorRefillAccountDispatchLock({
      client: redis,
      ttlMs: 10_000,
      instanceId: 'instance-b',
    });

    const first = await lockA.acquire(SPONSOR_REFILL_ACCOUNT_A);
    const second = await lockB.acquire(SPONSOR_REFILL_ACCOUNT_A);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('release is a silent no-op when the stored token does not match', async () => {
    const lockA = createSponsorRefillAccountDispatchLock({
      client: redis,
      ttlMs: 10_000,
      instanceId: 'instance-a',
    });
    const lockB = createSponsorRefillAccountDispatchLock({
      client: redis,
      ttlMs: 10_000,
      instanceId: 'instance-b',
    });
    const first = await lockA.acquire(SPONSOR_REFILL_ACCOUNT_A);
    expect(first).not.toBeNull();

    await lockB.release({
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_A,
      token: 'instance-b:forged',
    });

    expect(await redis.get(sponsorRefillAccountDispatchLockKey(SPONSOR_REFILL_ACCOUNT_A))).toBe(
      first!.token,
    );
  });

  it('locks on different sponsor refill accounts are independent', async () => {
    const lock = createSponsorRefillAccountDispatchLock({ client: redis, ttlMs: 10_000 });
    const a = await lock.acquire(SPONSOR_REFILL_ACCOUNT_A);
    const b = await lock.acquire(SPONSOR_REFILL_ACCOUNT_B);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.token).not.toBe(b!.token);
  });
});
