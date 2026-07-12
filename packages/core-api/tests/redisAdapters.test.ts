import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisRateLimiter } from '../src/store/redisRateLimiter.js';
import { RedisSponsorPool } from '../src/store/redisSponsorPool.js';
import { SponsorLeaseExpiredError } from '../src/store/sponsorPoolErrors.js';
import { SponsorLeaseCommitError } from '../src/store/sponsorLeaseProof.js';
import { FakeRedisClient } from './helpers/fakeRedisClient.js';
import {
  runRateLimitConformanceTests,
  type RateLimiterFactory,
  type RateLimiterHandle,
} from './rateLimiter.conformance.js';

// ─────────────────────────────────────────────
// RedisRateLimiter — shared conformance entry
// ─────────────────────────────────────────────
//
// `RedisSponsorPool` blocks below are separate and remain local to this file.

const redisRateLimiterFactory: RateLimiterFactory = ({ windowMs, maxRequests }) => {
  const redis = new FakeRedisClient();
  const limiter = new RedisRateLimiter(redis, { windowMs, maxRequests });
  const handle: RateLimiterHandle = {
    limiter,
    dispose: () => {
      /* no-op — FakeRedisClient has no long-lived handles */
    },
  };
  return handle;
};

describe('RedisRateLimiter — shared conformance', () => {
  runRateLimitConformanceTests(redisRateLimiterFactory);
});

/** 32+ char test HMAC secret for lease proofs. */
const TEST_HMAC_SECRET = 'redis-adapter-test-hmac-secret-v1-aaaaaaaaaaaa';
/** Synthetic receiptId used by these slot-lease unit tests. */
const TEST_RECEIPT_ID = '0x' + 'ab'.repeat(32);

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function makeKeypair(address: string) {
  return {
    toSuiAddress: vi.fn().mockReturnValue(address),
    signTransaction: vi.fn().mockResolvedValue({ signature: `sig:${address}` }),
  };
}

describe('Redis-backed adapters with FakeRedisClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-27T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('RedisSponsorPool leases slots, reuses released slots, and signs only after commit()', async () => {
    // Happy path: `checkout()` creates a reserved lease, `commit()`
    // promotes it, and `sign()` requires the exact committed `hash(txBytes)`.
    const redis = new FakeRedisClient();
    const kp1 = makeKeypair('0x' + '66'.repeat(32));
    const kp2 = makeKeypair('0x' + '77'.repeat(32));
    const pool = new RedisSponsorPool(
      redis,
      [
        kp1 as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number],
        kp2 as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number],
      ],
      { leaseTtlMs: 1_000, hmacSecret: TEST_HMAC_SECRET },
    );

    const receipt1 = '0x' + '01'.repeat(32);
    const receipt2 = '0x' + '02'.repeat(32);
    const receipt3 = '0x' + '03'.repeat(32);
    const first = await pool.checkout(receipt1);
    const second = await pool.checkout(receipt2);
    const third = await pool.checkout(receipt3);

    expect(first?.sponsorAddress).not.toBe(second?.sponsorAddress);
    expect(third).toBeNull();

    // Reservation checkin (never committed) — use txBytesHash=null.
    await pool.checkin(first!.sponsorAddress, receipt1, null);
    const receipt4 = '0x' + '04'.repeat(32);
    const reused = await pool.checkout(receipt4);
    expect(reused?.sponsorAddress).toBe(first?.sponsorAddress);

    // Commit second slot to a specific PTB hash, then sign the exact bytes.
    const txBytes = new Uint8Array([1, 2, 3]);
    const txBytesHash = sha256Hex(txBytes);
    await pool.commit(second!.sponsorAddress, receipt2, txBytesHash);
    const signature = await pool.sign(second!.sponsorAddress, receipt2, txBytes);
    expect(signature.signature).toBe(`sig:${second!.sponsorAddress}`);

    vi.advanceTimersByTime(1_001);
    const receipt5 = '0x' + '05'.repeat(32);
    const afterExpiry = await pool.checkout(receipt5);
    expect(afterExpiry).not.toBeNull();
    expect([first!.sponsorAddress, second!.sponsorAddress]).toContain(afterExpiry!.sponsorAddress);
  });

  it('RedisSponsorPool checkout scans busy slots with one Redis eval', async () => {
    const redis = new FakeRedisClient();
    const evalSpy = vi.spyOn(redis, 'eval');
    const kp1 = makeKeypair('0x' + '21'.repeat(32));
    const kp2 = makeKeypair('0x' + '22'.repeat(32));
    const pool = new RedisSponsorPool(
      redis,
      [
        kp1 as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number],
        kp2 as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number],
      ],
      { leaseTtlMs: 60_000, hmacSecret: TEST_HMAC_SECRET },
    );

    const first = await pool.checkout('0x' + '11'.repeat(32));
    const second = await pool.checkout('0x' + '12'.repeat(32));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    evalSpy.mockClear();
    const exhausted = await pool.checkout('0x' + '13'.repeat(32));

    expect(exhausted).toBeNull();
    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(evalSpy).toHaveBeenCalledWith(
      expect.stringContaining('RedisSponsorPool LEASE_CHECKOUT_SCRIPT'),
      expect.arrayContaining([
        expect.stringContaining(first!.sponsorAddress),
        expect.stringContaining(second!.sponsorAddress),
      ]),
      expect.arrayContaining([String(60_000), first!.sponsorAddress, second!.sponsorAddress]),
    );
  });

  it('RedisSponsorPool leaseStatus reads every slot with one Redis eval', async () => {
    const redis = new FakeRedisClient();
    const evalSpy = vi.spyOn(redis, 'eval');
    const kp1 = makeKeypair('0x' + '31'.repeat(32));
    const kp2 = makeKeypair('0x' + '32'.repeat(32));
    const pool = new RedisSponsorPool(
      redis,
      [
        kp1 as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number],
        kp2 as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number],
      ],
      { leaseTtlMs: 60_000, hmacSecret: TEST_HMAC_SECRET },
    );

    const first = await pool.checkout('0x' + '41'.repeat(32));
    expect(first).not.toBeNull();

    evalSpy.mockClear();
    const status = await pool.leaseStatus();

    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(evalSpy).toHaveBeenCalledWith(
      expect.stringContaining('RedisSponsorPool LEASE_STATUS_SCRIPT'),
      expect.arrayContaining([
        expect.stringContaining(kp1.toSuiAddress()),
        expect.stringContaining(kp2.toSuiAddress()),
      ]),
      [kp1.toSuiAddress(), kp2.toSuiAddress()],
    );
    expect(status).toEqual({
      leasedSlots: 1,
      freeSlots: 1,
      slots: [
        { address: kp1.toSuiAddress(), leased: true },
        { address: kp2.toSuiAddress(), leased: false },
      ],
    });
  });

  it('RedisSponsorPool sign() rejects during the reservation window (T2)', async () => {
    // Reservation window is fail-closed: sign() must never succeed before
    // commit() promotes the lease to the committed stage.
    const redis = new FakeRedisClient();
    const kp = makeKeypair('0x' + '55'.repeat(32));
    const pool = new RedisSponsorPool(
      redis,
      [kp as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number]],
      { leaseTtlMs: 60_000, hmacSecret: TEST_HMAC_SECRET },
    );
    const leased = await pool.checkout(TEST_RECEIPT_ID);
    expect(leased).not.toBeNull();
    await expect(
      pool.sign(leased!.sponsorAddress, TEST_RECEIPT_ID, new Uint8Array([9, 9, 9])),
    ).rejects.toBeInstanceOf(SponsorLeaseExpiredError);
  });

  it('RedisSponsorPool sign() succeeds only for the exact committed txBytes (T1)', async () => {
    // The proof is commit-bound. Present the wrong txBytes after a
    // legitimate commit and the pool refuses to sign because the hash differs.
    const redis = new FakeRedisClient();
    const kp = makeKeypair('0x' + '88'.repeat(32));
    const pool = new RedisSponsorPool(
      redis,
      [kp as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number]],
      { leaseTtlMs: 60_000, hmacSecret: TEST_HMAC_SECRET },
    );
    const leased = await pool.checkout(TEST_RECEIPT_ID);
    const committedBytes = new Uint8Array([0xc0, 0xde]);
    await pool.commit(leased!.sponsorAddress, TEST_RECEIPT_ID, sha256Hex(committedBytes));
    // Correct txBytes matches the commit digest.
    const ok = await pool.sign(leased!.sponsorAddress, TEST_RECEIPT_ID, committedBytes);
    expect(ok.signature).toBe(`sig:${leased!.sponsorAddress}`);
  });

  it('RedisSponsorPool rejects sign() for a forged txBytes under a live committed lease (T5 pool-unit)', async () => {
    // Companion to the end-to-end T5 test in handleSponsor.test.ts:
    // even if an attacker controls Redis entry state, they cannot
    // forge a txBytes whose hash matches the committed lease proof
    // because the HMAC secret is process-local.
    const redis = new FakeRedisClient();
    const kp = makeKeypair('0x' + '99'.repeat(32));
    const pool = new RedisSponsorPool(
      redis,
      [kp as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number]],
      { leaseTtlMs: 60_000, hmacSecret: TEST_HMAC_SECRET },
    );
    const leased = await pool.checkout(TEST_RECEIPT_ID);
    const committedBytes = new Uint8Array([0xc0, 0xde, 0x01]);
    await pool.commit(leased!.sponsorAddress, TEST_RECEIPT_ID, sha256Hex(committedBytes));

    // Attacker submits a completely different PTB.
    const attackerBytes = new Uint8Array([0xba, 0xad, 0xf0, 0x0d]);
    await expect(
      pool.sign(leased!.sponsorAddress, TEST_RECEIPT_ID, attackerBytes),
    ).rejects.toBeInstanceOf(SponsorLeaseExpiredError);
  });

  it('RedisSponsorPool rejects sign() when Redis lease value is stomped by an attacker', async () => {
    // Defence-in-depth: even direct Redis overwrite of the stored HMAC
    // to a forged value fails closed, because the HMAC secret is not
    // in Redis. The attacker cannot compute a proof that matches any
    // sign() call.
    const redis = new FakeRedisClient();
    const kp = makeKeypair('0x' + '88'.repeat(32));
    const pool = new RedisSponsorPool(
      redis,
      [kp as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number]],
      { leaseTtlMs: 60_000, hmacSecret: TEST_HMAC_SECRET },
    );
    const leased = await pool.checkout(TEST_RECEIPT_ID);
    expect(leased).not.toBeNull();
    const sponsorAddress = leased!.sponsorAddress;

    // Overwrite the lease value with an attacker-chosen string.
    await redis.set(`stelis:sponsor_lease:${sponsorAddress}`, 'attacker-forged-value', {
      px: 60_000,
    });
    await expect(
      pool.sign(sponsorAddress, TEST_RECEIPT_ID, new Uint8Array([9])),
    ).rejects.toBeInstanceOf(SponsorLeaseExpiredError);
  });

  it('RedisSponsorPool sign() rejects when receiptId is substituted across slots', async () => {
    // Slot-pinning guard: the HMAC payload includes `sponsorAddress`, so a
    // valid lease for slot A cannot authorise slot B.
    const redis = new FakeRedisClient();
    const kpA = makeKeypair('0x' + 'aa'.repeat(32));
    const kpB = makeKeypair('0x' + 'bb'.repeat(32));
    const pool = new RedisSponsorPool(
      redis,
      [
        kpA as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number],
        kpB as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number],
      ],
      { leaseTtlMs: 60_000, hmacSecret: TEST_HMAC_SECRET },
    );

    const receiptA = '0x' + 'a1'.repeat(32);
    const receiptB = '0x' + 'b1'.repeat(32);
    const leaseA = await pool.checkout(receiptA);
    const leaseB = await pool.checkout(receiptB);
    expect(leaseA).not.toBeNull();
    expect(leaseB).not.toBeNull();
    // Commit both to their own bytes.
    const bytesA = new Uint8Array([0x01, 0x02]);
    const bytesB = new Uint8Array([0x03, 0x04]);
    await pool.commit(leaseA!.sponsorAddress, receiptA, sha256Hex(bytesA));
    await pool.commit(leaseB!.sponsorAddress, receiptB, sha256Hex(bytesB));

    // Cross-slot replay fails even with the legitimate txBytes.
    await expect(pool.sign(leaseB!.sponsorAddress, receiptA, bytesA)).rejects.toBeInstanceOf(
      SponsorLeaseExpiredError,
    );
    await expect(pool.sign(leaseA!.sponsorAddress, receiptB, bytesB)).rejects.toBeInstanceOf(
      SponsorLeaseExpiredError,
    );
  });

  it('RedisSponsorPool commit() fails closed on missing reservation (T3)', async () => {
    // Calling commit() without checkout must raise
    // SponsorLeaseCommitError (LEASE_MISSING). Silent no-op is not
    // allowed — a failed commit indicates either a forged state or a
    // concurrent actor.
    const redis = new FakeRedisClient();
    const kp = makeKeypair('0x' + '77'.repeat(32));
    const pool = new RedisSponsorPool(
      redis,
      [kp as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number]],
      { leaseTtlMs: 60_000, hmacSecret: TEST_HMAC_SECRET },
    );
    await expect(
      pool.commit(kp.toSuiAddress(), TEST_RECEIPT_ID, sha256Hex(new Uint8Array([1]))),
    ).rejects.toBeInstanceOf(SponsorLeaseCommitError);
  });

  it('RedisSponsorPool commit() is not idempotent — a second commit throws (T4)', async () => {
    // Once the lease is promoted from reserved to committed, another
    // commit() must not silently no-op or upgrade the proof. The Lua
    // CAS expects the reserved proof; seeing a committed proof instead
    // is LEASE_COMMIT_CAS_FAILED.
    const redis = new FakeRedisClient();
    const kp = makeKeypair('0x' + 'cd'.repeat(32));
    const pool = new RedisSponsorPool(
      redis,
      [kp as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number]],
      { leaseTtlMs: 60_000, hmacSecret: TEST_HMAC_SECRET },
    );
    const leased = await pool.checkout(TEST_RECEIPT_ID);
    const bytes1 = new Uint8Array([0x10]);
    const bytes2 = new Uint8Array([0x20]);
    await pool.commit(leased!.sponsorAddress, TEST_RECEIPT_ID, sha256Hex(bytes1));
    await expect(
      pool.commit(leased!.sponsorAddress, TEST_RECEIPT_ID, sha256Hex(bytes2)),
    ).rejects.toBeInstanceOf(SponsorLeaseCommitError);
  });

  it('RedisSponsorPool constructor rejects missing or short hmacSecret', () => {
    const redis = new FakeRedisClient();
    const kp = makeKeypair('0x' + 'cc'.repeat(32));
    expect(
      () =>
        new RedisSponsorPool(
          redis,
          [kp as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number]],
          // @ts-expect-error — deliberately missing hmacSecret at construction
          {},
        ),
    ).toThrow(/hmacSecret/);
    expect(
      () =>
        new RedisSponsorPool(
          redis,
          [kp as unknown as ConstructorParameters<typeof RedisSponsorPool>[1][number]],
          { hmacSecret: 'too-short' },
        ),
    ).toThrow(/hmacSecret/);
  });
});
