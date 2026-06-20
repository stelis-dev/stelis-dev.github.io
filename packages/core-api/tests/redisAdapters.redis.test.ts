import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { RedisAbuseBlocker } from '../src/store/redisAbuseBlocker.js';
import { RedisPrepareInflight } from '../src/store/redisPrepareInflight.js';
import { RedisPrepareStore } from '../src/store/redisPrepareStore.js';
import { RedisRateLimiter } from '../src/store/redisRateLimiter.js';
import { RedisSponsorPool } from '../src/store/redisSponsorPool.js';
import { startRealRedis, type RealRedisHandle } from './helpers/realRedis.js';

const TEST_HMAC_SECRET = 'real-redis-adapter-test-hmac-secret-v1-aaaaaaaa';
const SAMPLE_TX_BYTES = new Uint8Array([0xc0, 0xde, 0x01]);

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('Redis-backed adapters — real Redis conformance', () => {
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

  it('RedisRateLimiter — enforces a fixed window and resets through Redis TTL', async () => {
    const limiter = new RedisRateLimiter(redis!.client, {
      windowMs: 25,
      maxRequests: 1,
    });

    await expect(limiter.check('ip:1')).resolves.toMatchObject({
      allowed: true,
      current: 1,
      limit: 1,
    });
    const blocked = await limiter.check('ip:1');
    expect(blocked).toMatchObject({
      allowed: false,
      current: 2,
      limit: 1,
    });
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    await sleep(40);
    await expect(limiter.check('ip:1')).resolves.toMatchObject({
      allowed: true,
      current: 1,
      limit: 1,
    });
  });

  it('RedisAbuseBlocker — records IP and subject blocks through real Redis keys', async () => {
    const blocker = new RedisAbuseBlocker(redis!.client, {
      addressDryRunThreshold: 1,
      addressDryRunWindowMs: 60_000,
      addressBlockDurationMs: 60_000,
      ipFailureThreshold: 1,
      ipFailureWindowMs: 60_000,
      ipBlockDurationMs: 60_000,
    });
    const subject = { kind: 'address' as const, address: '0x' + '11'.repeat(32) };

    await blocker.recordSponsorFailure('203.0.113.10', subject, 'PREFLIGHT_FAILED');
    await expect(blocker.checkIp('203.0.113.10')).resolves.toMatchObject({ blocked: false });
    await expect(blocker.checkSubject(subject)).resolves.toMatchObject({ blocked: false });

    await blocker.recordSponsorFailure('203.0.113.10', subject, 'PREFLIGHT_FAILED');
    await expect(blocker.checkIp('203.0.113.10')).resolves.toMatchObject({
      blocked: true,
      scope: 'ip',
    });
    await expect(blocker.checkSubject(subject)).resolves.toMatchObject({
      blocked: true,
      scope: 'address',
    });
  });

  it('RedisAbuseBlocker — installs fixed-window counter TTL on the first failure record', async () => {
    const blocker = new RedisAbuseBlocker(redis!.client, {
      addressDryRunThreshold: 10,
      addressDryRunWindowMs: 1_000,
      addressBlockDurationMs: 60_000,
      ipFailureThreshold: 10,
      ipFailureWindowMs: 1_000,
      ipBlockDurationMs: 60_000,
    });
    const ip = '198.51.100.10';

    await blocker.recordSponsorFailure(ip, undefined, 'PREFLIGHT_FAILED');

    const pttl = Number(await redis!.rawClient.sendCommand(['PTTL', `stelis:abuse:ip_fail:${ip}`]));
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(1_000);
  });

  it('RedisPrepareInflight — shares capacity across instances through one Redis ZSET', async () => {
    const keyPrefix = `test:inflight:${randomUUID()}:`;
    const instanceA = new RedisPrepareInflight(redis!.client, 1, { keyPrefix });
    const instanceB = new RedisPrepareInflight(redis!.client, 1, { keyPrefix });

    const handleA = await instanceA.tryAcquire('prepare');
    expect(handleA).not.toBeNull();
    await expect(instanceB.tryAcquire('prepare')).resolves.toBeNull();

    await handleA!.release();
    await expect(instanceB.tryAcquire('prepare')).resolves.not.toBeNull();
  });

  it('RedisSponsorPool — completes checkout, commit, sign, checkin with real Redis Lua', async () => {
    const keypair = Ed25519Keypair.generate();
    const pool = new RedisSponsorPool(redis!.client, [keypair], {
      hmacSecret: TEST_HMAC_SECRET,
      keyPrefix: `test:sponsor:${randomUUID()}:`,
      leaseTtlMs: 60_000,
    });

    const receiptId = `receipt-${randomUUID()}`;
    const lease = await pool.checkout(receiptId);
    expect(lease).not.toBeNull();
    expect(lease!.slotId).toBe(keypair.toSuiAddress());

    await pool.commit(lease!.slotId, receiptId, sha256Hex(SAMPLE_TX_BYTES));
    const signature = await pool.sign(lease!.slotId, receiptId, SAMPLE_TX_BYTES);
    expect(signature.signature.length).toBeGreaterThan(0);

    await pool.checkin(lease!.slotId, receiptId, sha256Hex(SAMPLE_TX_BYTES));
    await expect(pool.leaseStatus()).resolves.toMatchObject({
      leasedSlots: 0,
      freeSlots: 1,
    });
  });

  it('RedisPrepareStore — store → consume happy path with BigInt', async () => {
    const released: string[] = [];
    const store = new RedisPrepareStore(
      redis!.client,
      (slotId) => {
        released.push(slotId);
      },
      { keyPrefix: `test:ps:${randomUUID()}:`, ttlMs: 60_000 },
    );

    const entry = {
      issuedAt: Date.now(),
      receiptId: 'integ-pay-001',
      senderAddress: '0xINTEG_SENDER',
      nonce: 1n,
      executionPathKey: 'direct',
      txBytesHash: 'hash-integ',
      slotId: 'slot-integ',
      sponsorAddress: '0xSP',
      clientIp: '10.0.0.99',
      orderId: null,
      mode: 'generic' as const,
    };

    await store.store('integ-pay-001', entry);
    const result = await store.consume('integ-pay-001', 'hash-integ');
    expect(result).not.toBe('not_found');
    expect(result).not.toBe('expired');
    expect(result).not.toBe('hash_mismatch');
    const consumed = result as typeof entry;
    // Coordination-only round-trip: settle observability copies
    // (executionCostClaim, simGas, ...) are never persisted.
    expect(consumed.txBytesHash).toBe('hash-integ');
    expect(consumed.nonce).toBe(1n);
    expect(consumed.mode).toBe('generic');
    expect(released).toHaveLength(0);
  });

  it('RedisPrepareStore — hash_mismatch releases slot', async () => {
    const released: string[] = [];
    const store = new RedisPrepareStore(
      redis!.client,
      (slotId) => {
        released.push(slotId);
      },
      { keyPrefix: `test:ps:${randomUUID()}:`, ttlMs: 60_000 },
    );

    const entry = {
      issuedAt: Date.now(),
      receiptId: 'integ-pay-002',
      senderAddress: '0xINTEG_SENDER_2',
      nonce: 1n,
      executionPathKey: 'direct',
      txBytesHash: 'correct-hash',
      slotId: 'slot-mismatch',
      sponsorAddress: '0xSP',
      clientIp: '10.0.0.88',
      orderId: null,
      mode: 'generic' as const,
    };

    await store.store('integ-pay-002', entry);
    const result = await store.consume('integ-pay-002', 'wrong-hash');
    expect(result).toBe('hash_mismatch');
    expect(released).toContain('slot-mismatch');

    // Entry should be deleted
    const second = await store.consume('integ-pay-002', 'correct-hash');
    expect(second).toBe('not_found');
  });

  it('RedisPrepareStore — reserveNonce derives from live sender metadata', async () => {
    const store = new RedisPrepareStore(redis!.client, () => {}, {
      keyPrefix: `test:ps:${randomUUID()}:`,
      ttlMs: 60_000,
    });

    await store.store('integ-pay-003', {
      issuedAt: Date.now(),
      receiptId: 'integ-pay-003',
      nonce: 7n,
      executionPathKey: 'direct',
      txBytesHash: 'hash-integ-3',
      slotId: 'slot-integ-3',
      sponsorAddress: '0xSP',
      clientIp: '10.0.0.77',
      orderId: null,
      senderAddress: '0xRECOVER',
      mode: 'generic',
    });

    await expect(store.reserveNonce('0xRECOVER', 0n, 'res-1')).resolves.toBe(8n);
  });

  it('RedisPrepareStore — releaseReservation preserves a live entry promoted under same receiptId', async () => {
    // Locks the Lua releaseReservation contract against the real Redis
    // server: after store() promotes a pending reservation to a live
    // sender-metadata entry, a direct releaseReservation under the same
    // receiptId must remove only pending reservations. The live entry's
    // nonce must still raise the next reservation. FakeRedisClient
    // reimplements the Lua, so this case is the authoritative check that
    // the real script (`redis.call('GET' ... cjson.decode ...
    // not (item.pending and item.pid == resId)`) behaves as specified.
    const store = new RedisPrepareStore(redis!.client, () => {}, {
      keyPrefix: `test:ps:${randomUUID()}:`,
      ttlMs: 60_000,
    });

    const sender = '0xLIVE_PRESERVE';
    const live = await store.reserveNonce(sender, 5n, 'integ-pay-004');
    expect(live).toBe(6n);

    await store.store('integ-pay-004', {
      issuedAt: Date.now(),
      receiptId: 'integ-pay-004',
      nonce: live,
      executionPathKey: 'direct',
      txBytesHash: 'hash-integ-4',
      slotId: 'slot-integ-4',
      sponsorAddress: '0xSP',
      clientIp: '10.0.0.66',
      orderId: null,
      senderAddress: sender,
      mode: 'generic',
    });

    // Direct release after promotion — must be a no-op for the live entry.
    await store.releaseReservation('integ-pay-004', sender);

    // Live nonce must still raise the next reservation.
    await expect(store.reserveNonce(sender, 5n, 'integ-pay-004b')).resolves.toBe(7n);

    // The live entry itself must remain peekable, unchanged.
    const peeked = await store.peek('integ-pay-004');
    expect(peeked).not.toBeNull();
    expect(peeked!.nonce).toBe(live);
    expect(peeked!.txBytesHash).toBe('hash-integ-4');

    await store.releaseReservation('integ-pay-004b', sender);
  });

  it('RedisPrepareStore — ignores stale pending reservations when reserving the next nonce', async () => {
    const keyPrefix = `test:ps:${randomUUID()}:`;
    const sender = '0xPENDING_TTL';
    const store = new RedisPrepareStore(redis!.client, () => {}, {
      keyPrefix,
      ttlMs: 500,
      maxOutstandingPerSender: 10,
    });

    await expect(store.reserveNonce(sender, 0n, 'pending-old')).resolves.toBe(1n);
    await sleep(550);
    await expect(redis!.client.get(`${keyPrefix}sender:${sender}`)).resolves.not.toBeNull();

    await expect(store.reserveNonce(sender, 0n, 'pending-new')).resolves.toBe(1n);
    await store.releaseReservation('pending-new', sender);
  });

  it('RedisPrepareStore — evictPreparedEntry deletes entry and cleans related indexes atomically', async () => {
    const keyPrefix = `test:ps:${randomUUID()}:`;
    const released: Array<{ slotId: string; receiptId: string; txBytesHash: string | null }> = [];
    const store = new RedisPrepareStore(
      redis!.client,
      (slotId, receiptId, txBytesHash) => {
        released.push({ slotId, receiptId, txBytesHash });
      },
      {
        keyPrefix,
        ttlMs: 60_000,
        maxPerIp: 5,
        maxPerStudioUser: 1,
        maxOutstandingPerSender: 10,
      },
    );

    const sender = '0xEVICT_SENDER';
    const userId = 'studio-user-evict';
    await store.store('evict-pay-001', {
      issuedAt: Date.now(),
      receiptId: 'evict-pay-001',
      nonce: 1n,
      reservedGasMist: 2_000_000n,
      executionPathKey: 'promotion-sponsored',
      txBytesHash: 'hash-evict',
      slotId: 'slot-evict',
      sponsorAddress: '0xSP',
      clientIp: '10.0.0.42',
      orderId: null,
      senderAddress: sender,
      mode: 'promotion',
      promotionId: 'promotion-evict',
      userId,
    });

    await expect(store.checkUserQuota(userId)).resolves.toEqual({ exceeded: true, limit: 1 });

    await store.evictPreparedEntry('evict-pay-001');

    expect(released).toEqual([
      { slotId: 'slot-evict', receiptId: 'evict-pay-001', txBytesHash: 'hash-evict' },
    ]);
    await expect(redis!.client.get(`${keyPrefix}evict-pay-001`)).resolves.toBeNull();
    await expect(redis!.client.get(`${keyPrefix}ip:10.0.0.42`)).resolves.toBeNull();
    await expect(redis!.client.get(`${keyPrefix}sender:${sender}`)).resolves.toBeNull();
    await expect(redis!.client.get(`${keyPrefix}user:${userId}`)).resolves.toBeNull();
    await expect(store.checkUserQuota(userId)).resolves.toBe('ok');
    await expect(store.reserveNonce(sender, 0n, 'after-evict')).resolves.toBe(1n);
    await store.releaseReservation('after-evict', sender);

    await store.evictPreparedEntry('evict-pay-001');
    expect(released).toHaveLength(1);
  });
});
