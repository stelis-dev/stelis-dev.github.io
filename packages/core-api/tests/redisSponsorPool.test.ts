import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, test, vi } from 'vitest';
import { PREPARE_TTL_MS } from '../src/preparePolicy.js';
import { RedisSponsorPool } from '../src/store/redisSponsorPool.js';
import { FakeRedisClient } from './helpers/fakeRedisClient.js';

const HMAC_SECRET = 'redis-sponsor-pool-test-secret-aaaaaaaaaaaaaaaa';
const RECEIPT_ID = `0x${'01'.repeat(32)}`;

describe('RedisSponsorPool lease lifetime', () => {
  test('uses the prepare lifetime plus the fixed cleanup grace when no override is supplied', async () => {
    const redis = new FakeRedisClient();
    const evalSpy = vi.spyOn(redis, 'eval');
    const pool = new RedisSponsorPool(redis, [Ed25519Keypair.generate()], {
      hmacSecret: HMAC_SECRET,
    });

    await expect(pool.checkout(RECEIPT_ID)).resolves.not.toBeNull();

    const checkoutCall = evalSpy.mock.calls.find(([script]) =>
      script.includes('RedisSponsorPool LEASE_CHECKOUT_SCRIPT'),
    );
    expect(checkoutCall?.[2][0]).toBe(String(PREPARE_TTL_MS + 5_000));
  });

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an unsupported lease lifetime before using Redis: %s',
    (leaseTtlMs) => {
      expect(
        () =>
          new RedisSponsorPool(new FakeRedisClient(), [Ed25519Keypair.generate()], {
            hmacSecret: HMAC_SECRET,
            leaseTtlMs,
          }),
      ).toThrow('leaseTtlMs must be a positive safe integer');
    },
  );
});
