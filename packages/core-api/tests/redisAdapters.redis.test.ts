import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { SUI_CHAIN_IDENTIFIERS } from '@stelis/contracts';
import { RedisAbuseBlocker } from '../src/store/redisAbuseBlocker.js';
import {
  ABUSE_BLOCK_DEADLINE_INDEX_KEY,
  abuseBlockMember,
  abuseBlockRecordKey,
  serializeAbuseBlockRecord,
} from '../src/store/abuseBlockStore.js';
import { RedisPrepareInflight } from '../src/store/redisPrepareInflight.js';
import type { RedisClientLike } from '../src/store/redisClient.js';
import { RedisRateLimiter } from '../src/store/redisRateLimiter.js';
import { RedisSponsoredExecutionStore } from '../src/store/redisSponsoredExecutionStore.js';
import { SponsoredExecutionRecovery } from '../src/store/sponsoredExecutionRecovery.js';
import {
  decodeSponsoredExecutionRecord,
  serializeSponsoredExecutionRecord,
  sponsoredExecutionPreparedRecordKeyPrefix,
  storeSponsorResult,
} from '../src/store/sponsoredExecutionRecords.js';
import { RedisSponsorPool } from '../src/store/redisSponsorPool.js';
import { startRealRedis, type RealRedisHandle } from '../src/testing/redis.js';
import {
  serializePreparedTxEntry,
  type GenericPreparedTxDraft,
  type PromotionPreparedTxDraft,
} from '../src/store/prepareTypes.js';
import type { SponsorResultMetadata } from '../src/handlers/sponsorResult.js';
import { PrepareSenderQuotaError } from '../src/store/prepareErrors.js';
import {
  decodePromotionOperationResultRecord,
  promotionReceiptStorageKeys,
  promotionReservationDeadlineIndexKey,
  promotionReservationKey,
} from '../src/studio/promotionRecords.js';
import { RedisPromotionExecutionLedger } from '../src/studio/executionLedgerRedis.js';
import {
  createRedisPromotionLedgerStore,
  PROMO_ID,
  PROMO_X,
} from './helpers/promotionLedgerFixture.js';
import {
  addressBalanceGasTransactionBytesFixture,
  suiEndpointSnapshotFixture,
} from './helpers/suiGatewayResultFixtures.js';

const TEST_HMAC_SECRET = 'real-redis-adapter-test-hmac-secret-v1-aaaaaaaa';
const SENDER = `0x${'31'.repeat(32)}`;
const USER = 'redis-sponsored-execution-user';
const U64_MAX = (1n << 64n) - 1n;

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function readRedisTimeMs(redis: RealRedisHandle): Promise<number> {
  const result = (await redis.rawClient.sendCommand(['TIME'])) as [string, string];
  return Number(result[0]) * 1_000 + Math.floor(Number(result[1]) / 1_000);
}

function receipt(index: number): string {
  return `0x${index.toString(16).padStart(64, '0')}`;
}

async function transactionBytes(sponsorAddress: string): Promise<Uint8Array> {
  const transaction = new Transaction();
  transaction.setSender(SENDER);
  return addressBalanceGasTransactionBytesFixture({
    transaction,
    sponsorAddress,
    gasBudget: 1_000_000n,
    gasPrice: 1_000n,
    chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet,
  });
}

function genericResult(input: {
  receiptId: string;
  sponsorAddress: string;
  digest?: string;
  outcome?: SponsorResultMetadata['outcome'];
}): SponsorResultMetadata {
  return {
    sponsorAddress: input.sponsorAddress,
    outcome: input.outcome ?? 'success',
    executionStage: input.digest === undefined ? 'before_sponsor_signature' : 'on_chain',
    route: 'generic',
    ...(input.digest === undefined ? {} : { digest: input.digest }),
    receiptId: input.receiptId,
    senderAddress: SENDER,
    executionPathKey: 'generic:redis-test',
    orderIdHash: null,
    promotionId: null,
    userId: null,
    economics: { economicsStatus: 'unknown', failureReason: null },
  };
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

    const counterKeys = await redis!.rawClient.sendCommand(['KEYS', 'stelis:abuse:counter:ip:*']);
    expect(counterKeys).toEqual([expect.any(String)]);
    const pttl = Number(
      await redis!.rawClient.sendCommand(['PTTL', (counterKeys as string[])[0]!]),
    );
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(1_000);
  });

  it('RedisAbuseBlocker — preserves the longer live block and pages after a removed cursor', async () => {
    const blocker = new RedisAbuseBlocker(redis!.client, {
      manipulationBlockDurationMs: 60_000,
      ipFailureThreshold: 0,
      ipBlockDurationMs: 1_000,
    });
    try {
      await blocker.recordSponsorFailure('127.0.0.1', undefined, 'TAMPERING_DETECTED');
      await blocker.recordSponsorFailure('127.0.0.1', undefined, 'PREFLIGHT_FAILED');
      await blocker.recordSponsorFailure(
        '127.0.0.1',
        { kind: 'address', address: '0x2' },
        'TAMPERING_DETECTED',
      );
      await blocker.recordSponsorFailure(
        '127.0.0.1',
        { kind: 'studio_user', userId: 'User-A' },
        'TAMPERING_DETECTED',
      );

      const first = await blocker.listBlocks({ cursor: null, limit: 1 });
      expect(first.blocks).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      expect(first.blocks[0]!.reason).toBe('manipulation');
      await blocker.removeBlock(first.blocks[0]!.identity);

      const second = await blocker.listBlocks({ cursor: first.nextCursor, limit: 2 });
      expect(second.blocks.length).toBeGreaterThan(0);
      expect(second.blocks.every((block) => block.reason === 'manipulation')).toBe(true);
    } finally {
      await blocker.stop();
    }
  });

  it('RedisAbuseBlocker — pages from the cursor tuple when the same live identity moves later', async () => {
    const blocker = new RedisAbuseBlocker(redis!.client, {
      manipulationBlockDurationMs: 60_000,
    });
    const ip = '127.0.0.1';
    const subject = { kind: 'address' as const, address: '0x2' };
    try {
      await blocker.recordSponsorFailure(ip, subject, 'TAMPERING_DETECTED');
      const first = await blocker.listBlocks({ cursor: null, limit: 1 });
      expect(first.blocks).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const movedIdentity = first.blocks[0]!.identity;

      await sleep(10);
      if (movedIdentity.scope === 'ip') {
        await blocker.recordSponsorFailure(movedIdentity.subject, undefined, 'TAMPERING_DETECTED');
      } else {
        await blocker.recordSponsorFailure(ip, subject, 'TAMPERING_DETECTED');
      }

      const next = await blocker.listBlocks({ cursor: first.nextCursor, limit: 50 });
      expect(next.blocks.map((block) => block.identity)).toContainEqual(movedIdentity);
    } finally {
      await blocker.stop();
    }
  });

  it('RedisAbuseBlocker — fails closed when a live cursor has no record', async () => {
    const blocker = new RedisAbuseBlocker(redis!.client, {
      manipulationBlockDurationMs: 60_000,
    });
    try {
      await blocker.recordSponsorFailure(
        '127.0.0.1',
        { kind: 'address', address: '0x2' },
        'TAMPERING_DETECTED',
      );
      const first = await blocker.listBlocks({ cursor: null, limit: 1 });
      expect(first.nextCursor).not.toBeNull();
      await redis!.rawClient.sendCommand(['DEL', abuseBlockRecordKey(first.blocks[0]!.identity)]);

      await expect(blocker.listBlocks({ cursor: first.nextCursor, limit: 50 })).rejects.toThrow(
        'storage is corrupt',
      );
    } finally {
      await blocker.stop();
    }
  });

  it('RedisAbuseBlocker — fails closed when a live cursor record loses its index', async () => {
    const blocker = new RedisAbuseBlocker(redis!.client, {
      manipulationBlockDurationMs: 60_000,
    });
    try {
      await blocker.recordSponsorFailure(
        '127.0.0.1',
        { kind: 'address', address: '0x2' },
        'TAMPERING_DETECTED',
      );
      const first = await blocker.listBlocks({ cursor: null, limit: 1 });
      expect(first.nextCursor).not.toBeNull();
      await redis!.rawClient.sendCommand([
        'ZREM',
        ABUSE_BLOCK_DEADLINE_INDEX_KEY,
        abuseBlockMember(first.blocks[0]!.identity),
      ]);

      await expect(blocker.listBlocks({ cursor: first.nextCursor, limit: 50 })).rejects.toThrow(
        'storage is corrupt',
      );
    } finally {
      await blocker.stop();
    }
  });

  it('RedisAbuseBlocker — binds a live cursor member to the stored identity member', async () => {
    const blocker = new RedisAbuseBlocker(redis!.client, {
      manipulationBlockDurationMs: 60_000,
    });
    try {
      await blocker.recordSponsorFailure(
        '127.0.0.1',
        { kind: 'address', address: '0x2' },
        'TAMPERING_DETECTED',
      );
      const first = await blocker.listBlocks({ cursor: null, limit: 1 });
      expect(first.nextCursor).not.toBeNull();
      const key = abuseBlockRecordKey(first.blocks[0]!.identity);
      const raw = await redis!.client.get(key);
      expect(raw).not.toBeNull();
      await redis!.client.set(
        key,
        JSON.stringify({
          ...(JSON.parse(raw!) as Record<string, unknown>),
          member: abuseBlockMember({ scope: 'studio_user', subject: 'Different-User' }),
        }),
      );

      await expect(blocker.listBlocks({ cursor: first.nextCursor, limit: 50 })).rejects.toThrow(
        'storage is corrupt',
      );
    } finally {
      await blocker.stop();
    }
  });

  it('RedisAbuseBlocker — accepts an expired stale cursor as an exclusive position', async () => {
    const blocker = new RedisAbuseBlocker(redis!.client, {
      manipulationBlockDurationMs: 25,
    });
    try {
      await blocker.recordSponsorFailure(
        '127.0.0.1',
        { kind: 'address', address: '0x2' },
        'TAMPERING_DETECTED',
      );
      const first = await blocker.listBlocks({ cursor: null, limit: 1 });
      expect(first.nextCursor).not.toBeNull();
      await sleep(40);

      await expect(blocker.listBlocks({ cursor: first.nextCursor, limit: 50 })).resolves.toEqual({
        blocks: [],
        nextCursor: null,
      });
    } finally {
      await blocker.stop();
    }
  });

  it('RedisAbuseBlocker — keeps stale rows sparse and resumes after the last examined member', async () => {
    const blocker = new RedisAbuseBlocker(redis!.client, {
      manipulationBlockDurationMs: 60_000,
    });
    try {
      await redis!.rawClient.sendCommand([
        'ZADD',
        ABUSE_BLOCK_DEADLINE_INDEX_KEY,
        '1',
        abuseBlockMember({ scope: 'ip', subject: '192.0.2.1' }),
        '2',
        abuseBlockMember({ scope: 'ip', subject: '192.0.2.2' }),
      ]);
      await blocker.recordSponsorFailure(
        '127.0.0.1',
        { kind: 'address', address: '0x2' },
        'TAMPERING_DETECTED',
      );

      const first = await blocker.listBlocks({ cursor: null, limit: 3 });
      expect(first.blocks).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = await blocker.listBlocks({ cursor: first.nextCursor, limit: 3 });
      expect(second.blocks).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
    } finally {
      await blocker.stop();
    }
  });

  it('RedisAbuseBlocker — fails closed on a malformed live block record', async () => {
    const blocker = new RedisAbuseBlocker(redis!.client, {
      manipulationBlockDurationMs: 60_000,
    });
    const identity = { scope: 'ip' as const, subject: '127.0.0.1' };
    try {
      await blocker.recordSponsorFailure(identity.subject, undefined, 'TAMPERING_DETECTED');
      const deadline = Number(
        await redis!.rawClient.sendCommand([
          'ZSCORE',
          ABUSE_BLOCK_DEADLINE_INDEX_KEY,
          abuseBlockMember(identity),
        ]),
      );
      await redis!.rawClient.sendCommand([
        'SET',
        abuseBlockRecordKey(identity),
        JSON.stringify({
          member: abuseBlockMember(identity),
          reason: 'not_current',
          blockedUntilMs: String(deadline),
        }),
      ]);
      await expect(blocker.checkIp(identity.subject)).rejects.toThrow('storage is corrupt');
      await expect(blocker.listBlocks({ cursor: null, limit: 50 })).rejects.toThrow(
        'storage is corrupt',
      );
    } finally {
      await blocker.stop();
    }
  });

  it('RedisAbuseBlocker — expiry sweep binds the index member to the stored record before deleting', async () => {
    const blocker = new RedisAbuseBlocker(redis!.client);
    const identity = { scope: 'ip' as const, subject: '127.0.0.1' };
    const member = abuseBlockMember(identity);
    const deadline = (await readRedisTimeMs(redis!)) - 1;
    try {
      await redis!.rawClient.sendCommand([
        'SET',
        abuseBlockRecordKey(identity),
        serializeAbuseBlockRecord({
          identity: { scope: 'studio_user', subject: 'Different-User' },
          reason: 'manipulation',
          blockedUntilMs: deadline,
        }),
      ]);
      await redis!.rawClient.sendCommand([
        'ZADD',
        ABUSE_BLOCK_DEADLINE_INDEX_KEY,
        String(deadline),
        member,
      ]);

      await expect(
        (
          blocker as unknown as {
            runExpirySweep(): Promise<void>;
          }
        ).runExpirySweep(),
      ).rejects.toThrow('storage is corrupt');
      await expect(redis!.client.get(abuseBlockRecordKey(identity))).resolves.not.toBeNull();
      await expect(
        redis!.rawClient.sendCommand(['ZSCORE', ABUSE_BLOCK_DEADLINE_INDEX_KEY, member]),
      ).resolves.not.toBeNull();
    } finally {
      await blocker.stop();
    }
  });

  it('RedisAbuseBlocker — does not delete a live record when its index score is corrupt and stale', async () => {
    const blocker = new RedisAbuseBlocker(redis!.client, {
      manipulationBlockDurationMs: 60_000,
    });
    const identity = { scope: 'ip' as const, subject: '127.0.0.1' };
    try {
      await blocker.recordSponsorFailure(identity.subject, undefined, 'TAMPERING_DETECTED');
      await redis!.rawClient.sendCommand([
        'ZADD',
        ABUSE_BLOCK_DEADLINE_INDEX_KEY,
        '1',
        abuseBlockMember(identity),
      ]);
      await expect(blocker.listBlocks({ cursor: null, limit: 50 })).rejects.toThrow(
        'storage is corrupt',
      );
      await expect(redis!.client.get(abuseBlockRecordKey(identity))).resolves.not.toBeNull();
    } finally {
      await blocker.stop();
    }
  });

  it('RedisAbuseBlocker — prunes physically expired records from the ordered index in a bounded page', async () => {
    const blocker = new RedisAbuseBlocker(redis!.client, {
      manipulationBlockDurationMs: 25,
    });
    try {
      await blocker.recordSponsorFailure('127.0.0.1', undefined, 'TAMPERING_DETECTED');
      await sleep(40);
      await expect(blocker.listBlocks({ cursor: null, limit: 50 })).resolves.toEqual({
        blocks: [],
        nextCursor: null,
      });
      const indexSize = Number(
        await redis!.rawClient.sendCommand(['ZCARD', ABUSE_BLOCK_DEADLINE_INDEX_KEY]),
      );
      expect(indexSize).toBe(0);
    } finally {
      await blocker.stop();
    }
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

  it('RedisSponsoredExecutionStore — performs the exact prepared, executing, final, and callback CAS lifecycle', async () => {
    const prefix = `test:{sponsored-${randomUUID()}}:`;
    const keypair = Ed25519Keypair.generate();
    const sponsorPool = new RedisSponsorPool(redis!.client, [keypair], {
      hmacSecret: TEST_HMAC_SECRET,
      keyPrefix: `${prefix}lease:`,
      leaseTtlMs: 60_000,
    });
    const store = new RedisSponsoredExecutionStore(redis!.client, sponsorPool, undefined, {
      keyPrefix: prefix,
      prepareTtlMs: 60_000,
    });
    const receiptId = receipt(100);
    const lease = await sponsorPool.checkout(receiptId);
    if (!lease) throw new Error('Expected the real-Redis sponsor lease');
    const bytes = await transactionBytes(lease.sponsorAddress);
    const nonce = await store.reserveNonce(SENDER, 0n, receiptId);
    const draft: GenericPreparedTxDraft = {
      mode: 'generic',
      receiptId,
      senderAddress: SENDER,
      nonce,
      txBytesHash: sha256Hex(bytes),
      sponsorAddress: lease.sponsorAddress,
      clientIp: '127.0.0.1',
      executionPathKey: 'generic:redis-test',
      orderId: null,
    };

    const prepared = await store.commitPreparedReceipt(draft);
    await expect(store.readPreparedReceipt(receiptId)).resolves.toEqual(prepared);
    await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toMatchObject({
      record: { stage: 'committed', receiptId, txBytesHash: draft.txBytesHash },
    });

    const preparedDeadlineScore = await redis!.rawClient.sendCommand([
      'ZSCORE',
      `${prefix}prepared:deadlines`,
      receiptId,
    ]);
    await expect(
      store.beginSponsoredExecution({
        receiptId,
        txBytes: bytes,
        expectedMode: 'promotion',
        executionBudgetMs: 3_000,
        recovery: {
          route: 'generic',
          senderAddress: SENDER,
          executionPathKey: 'generic:redis-test',
          orderIdHash: null,
          recoveredGasMist: '0',
          hostFeeMist: '0',
          protocolFeeMist: '0',
        },
      }),
    ).resolves.toEqual({ status: 'mode_mismatch', actualMode: 'generic' });
    await expect(store.readPreparedReceipt(receiptId)).resolves.toEqual(prepared);
    await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toMatchObject({
      record: { stage: 'committed', receiptId, txBytesHash: draft.txBytesHash },
    });
    await expect(
      redis!.rawClient.sendCommand(['ZSCORE', `${prefix}prepared:deadlines`, receiptId]),
    ).resolves.toBe(preparedDeadlineScore);
    await expect(redis!.client.get(`${prefix}executing:${receiptId}`)).resolves.toBeNull();

    const unusedUserKey = `${prefix}unused:user`;
    await redis!.client.set(unusedUserKey, 'generic-user-index-must-not-be-read-or-written');
    const beforeBegin = await readRedisTimeMs(redis!);
    const begun = await store.beginSponsoredExecution({
      receiptId,
      txBytes: bytes,
      expectedMode: 'generic',
      executionBudgetMs: 3_000,
      recovery: {
        route: 'generic',
        senderAddress: SENDER,
        executionPathKey: 'generic:redis-test',
        orderIdHash: null,
        recoveredGasMist: '0',
        hostFeeMist: '0',
        protocolFeeMist: '0',
      },
    });
    const afterBegin = await readRedisTimeMs(redis!);
    expect(begun.status).toBe('executing');
    if (begun.status !== 'executing') return;
    await expect(redis!.client.get(unusedUserKey)).resolves.toBe(
      'generic-user-index-must-not-be-read-or-written',
    );
    expect(begun.execution.deadlineMs).toBeGreaterThanOrEqual(beforeBegin + 3_000);
    expect(begun.execution.deadlineMs).toBeLessThanOrEqual(afterBegin + 3_000);
    await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toMatchObject({
      record: { stage: 'executing', deadlineMs: begun.execution.deadlineMs },
    });
    await expect(
      redis!.rawClient.sendCommand(['ZSCORE', `${prefix}executing:deadlines`, receiptId]),
    ).resolves.toBe(String(begun.execution.deadlineMs));
    await expect(store.readPreparedReceipt(receiptId)).resolves.toBeNull();
    await expect(sponsorPool.sign(lease.sponsorAddress, receiptId, bytes)).resolves.toMatchObject({
      signature: expect.any(String),
    });

    const finalInput = {
      expected: begun.execution,
      result: genericResult({
        receiptId,
        sponsorAddress: lease.sponsorAddress,
        digest: begun.execution.transactionDigest,
      }),
      promotion: { operation: 'none' as const },
    };
    await redis!.client.set(`${prefix}callback:pending`, 'wrong-type');
    await expect(store.finalizeSponsoredExecution(finalInput)).rejects.toThrow(/wrong Redis type/);
    await expect(redis!.client.get(`${prefix}executing:${receiptId}`)).resolves.not.toBeNull();
    await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toMatchObject({
      record: { stage: 'executing', receiptId },
    });
    await redis!.client.del(`${prefix}callback:pending`);

    const finalized = await store.finalizeSponsoredExecution(finalInput);
    expect(finalized.status).toBe('finalized');
    if (finalized.status !== 'finalized') return;
    await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toBeNull();
    await expect(store.readDueExecutions(100, null)).resolves.toEqual({
      records: [],
      nextCursor: null,
    });
    await expect(store.readPendingCallbacks(100, null)).resolves.toEqual({
      records: [finalized.record],
      nextCursor: null,
    });
    await redis!.rawClient.sendCommand([
      'ZADD',
      `${prefix}callback:pending`,
      String(finalized.record.finalizedAtMs + 1),
      receiptId,
    ]);
    await expect(store.markCallbackDelivered(finalized.record)).resolves.toBe(false);
    await redis!.rawClient.sendCommand([
      'ZADD',
      `${prefix}callback:pending`,
      String(finalized.record.finalizedAtMs),
      receiptId,
    ]);
    await expect(store.markCallbackDelivered(finalized.record)).resolves.toBe(true);
    await expect(store.markCallbackDelivered(finalized.record)).resolves.toBe(false);
    await expect(store.readPendingCallbacks(100, null)).resolves.toEqual({
      records: [],
      nextCursor: null,
    });
  });

  it('RedisSponsoredExecutionStore — pages past 100 pending callbacks with the same score', async () => {
    const prefix = `test:{callback-page-${randomUUID()}}:`;
    const sponsorPool = new RedisSponsorPool(redis!.client, [Ed25519Keypair.generate()], {
      hmacSecret: TEST_HMAC_SECRET,
      keyPrefix: `${prefix}lease:`,
      leaseTtlMs: 60_000,
    });
    const store = new RedisSponsoredExecutionStore(redis!.client, sponsorPool, undefined, {
      keyPrefix: prefix,
      prepareTtlMs: 60_000,
    });
    const finalizedAtMs = await readRedisTimeMs(redis!);
    const records = Array.from({ length: 101 }, (_, index) => {
      const receiptId = receipt(index + 1_000);
      return {
        state: 'final' as const,
        receiptId,
        sponsorAddress: SENDER,
        transactionDigest: null,
        finalizedAtMs,
        callbackDelivery: 'pending' as const,
        result: storeSponsorResult(
          genericResult({ receiptId, sponsorAddress: SENDER, outcome: 'internal_error' }),
        ),
      };
    });
    for (const record of records) {
      await redis!.client.set(
        `${prefix}final:${record.receiptId}`,
        serializeSponsoredExecutionRecord(record),
      );
      await redis!.rawClient.sendCommand([
        'ZADD',
        `${prefix}callback:pending`,
        String(finalizedAtMs),
        record.receiptId,
      ]);
    }

    const first = await store.readPendingCallbacks(100, null);
    expect(first.records.map((record) => record.receiptId)).toEqual(
      records.slice(0, 100).map((record) => record.receiptId),
    );
    expect(first.nextCursor).toEqual({
      throughMs: expect.any(Number),
      scoreMs: finalizedAtMs,
      receiptId: records[99]?.receiptId,
    });
    if (first.nextCursor === null) throw new Error('Expected a second callback page');

    const second = await store.readPendingCallbacks(100, first.nextCursor);
    expect(second).toEqual({ records: [records[100]], nextCursor: null });
    await expect(
      redis!.rawClient.sendCommand(['ZCARD', `${prefix}callback:pending`]),
    ).resolves.toBe(101);
  });

  it('RedisSponsoredExecutionStore — generic discard ignores the unused user-index slot', async () => {
    const prefix = `test:{generic-discard-${randomUUID()}}:`;
    const sponsorPool = new RedisSponsorPool(redis!.client, [Ed25519Keypair.generate()], {
      hmacSecret: TEST_HMAC_SECRET,
      keyPrefix: `${prefix}lease:`,
      leaseTtlMs: 60_000,
    });
    const store = new RedisSponsoredExecutionStore(redis!.client, sponsorPool, undefined, {
      keyPrefix: prefix,
      prepareTtlMs: 60_000,
    });
    const receiptId = receipt(102);
    const lease = await sponsorPool.checkout(receiptId);
    if (!lease) throw new Error('Expected the generic-discard sponsor lease');
    const bytes = await transactionBytes(lease.sponsorAddress);
    const nonce = await store.reserveNonce(SENDER, 0n, receiptId);
    const prepared = await store.commitPreparedReceipt({
      mode: 'generic',
      receiptId,
      senderAddress: SENDER,
      nonce,
      txBytesHash: sha256Hex(bytes),
      sponsorAddress: lease.sponsorAddress,
      clientIp: '127.0.0.12',
      executionPathKey: 'generic:redis-test',
      orderId: null,
    });
    const unusedUserKey = `${prefix}unused:user`;
    await redis!.client.set(unusedUserKey, 'generic-user-index-must-not-be-read-or-written');

    await expect(
      store.discardPreparedReceipt({
        expected: prepared,
        result: genericResult({
          receiptId,
          sponsorAddress: lease.sponsorAddress,
          outcome: 'validation_failure',
        }),
      }),
    ).resolves.toMatchObject({ status: 'discarded' });
    await expect(redis!.client.get(unusedUserKey)).resolves.toBe(
      'generic-user-index-must-not-be-read-or-written',
    );
    await expect(store.readPreparedReceipt(receiptId)).resolves.toBeNull();
    await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toBeNull();
  });

  it('RedisSponsoredExecutionStore — rejects corrupt current records without partially cleaning the receipt', async () => {
    const prefix = `test:{corrupt-${randomUUID()}}:`;
    const keypair = Ed25519Keypair.generate();
    const sponsorPool = new RedisSponsorPool(redis!.client, [keypair], {
      hmacSecret: TEST_HMAC_SECRET,
      keyPrefix: `${prefix}lease:`,
      leaseTtlMs: 60_000,
    });
    const store = new RedisSponsoredExecutionStore(redis!.client, sponsorPool, undefined, {
      keyPrefix: prefix,
      prepareTtlMs: 60_000,
    });
    const receiptId = receipt(101);
    const lease = await sponsorPool.checkout(receiptId);
    if (!lease) throw new Error('Expected the corruption-test sponsor lease');
    const bytes = await transactionBytes(lease.sponsorAddress);
    const nonce = await store.reserveNonce(SENDER, 0n, receiptId);
    const prepared = await store.commitPreparedReceipt({
      mode: 'generic',
      receiptId,
      senderAddress: SENDER,
      nonce,
      txBytesHash: sha256Hex(bytes),
      sponsorAddress: lease.sponsorAddress,
      clientIp: '127.0.0.2',
      executionPathKey: 'generic:redis-test',
      orderId: null,
    });
    const key = `${prefix}prepared:${receiptId}`;
    const raw = JSON.parse((await redis!.client.get(key))!) as Record<string, unknown>;
    await redis!.client.set(key, JSON.stringify({ ...raw, unexpectedField: true }));

    await expect(store.readPreparedReceipt(receiptId)).rejects.toThrow(/unexpected field set/);
    await expect(
      store.beginSponsoredExecution({
        receiptId,
        txBytes: bytes,
        expectedMode: 'generic',
        executionBudgetMs: 1_000,
        recovery: {
          route: 'generic',
          senderAddress: SENDER,
          executionPathKey: 'generic:redis-test',
          orderIdHash: null,
          recoveredGasMist: '0',
          hostFeeMist: '0',
          protocolFeeMist: '0',
        },
      }),
    ).rejects.toThrow(/unexpected field set/);
    await expect(redis!.client.get(key)).resolves.not.toBeNull();
    await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toMatchObject({
      record: { stage: 'committed', receiptId, txBytesHash: prepared.txBytesHash },
    });
  });

  it('RedisSponsoredExecutionStore — leaves an expired prepared receipt intact for recovery', async () => {
    const prefix = `test:{expired-${randomUUID()}}:`;
    const sponsorPool = new RedisSponsorPool(redis!.client, [Ed25519Keypair.generate()], {
      hmacSecret: TEST_HMAC_SECRET,
      keyPrefix: `${prefix}lease:`,
      leaseTtlMs: 60_000,
    });
    const prepareTtlMs = 20;
    const store = new RedisSponsoredExecutionStore(redis!.client, sponsorPool, undefined, {
      keyPrefix: prefix,
      prepareTtlMs,
    });
    const receiptId = receipt(105);
    const lease = await sponsorPool.checkout(receiptId);
    if (!lease) throw new Error('Expected the expiry-test sponsor lease');
    const bytes = await transactionBytes(lease.sponsorAddress);
    const nonce = await store.reserveNonce(SENDER, 0n, receiptId);
    const prepared = await store.commitPreparedReceipt({
      mode: 'generic',
      receiptId,
      senderAddress: SENDER,
      nonce,
      txBytesHash: sha256Hex(bytes),
      sponsorAddress: lease.sponsorAddress,
      clientIp: '127.0.0.4',
      executionPathKey: 'generic:redis-expiry',
      orderId: null,
    });
    const deadlineMs = prepared.issuedAt + prepareTtlMs;
    const waitMs = Math.max(0, deadlineMs - (await readRedisTimeMs(redis!)) + 2);
    await sleep(waitMs);
    expect(await readRedisTimeMs(redis!)).toBeGreaterThanOrEqual(deadlineMs);

    await expect(
      store.beginSponsoredExecution({
        receiptId,
        txBytes: bytes,
        expectedMode: 'generic',
        executionBudgetMs: 1_000,
        recovery: {
          route: 'generic',
          senderAddress: SENDER,
          executionPathKey: 'generic:redis-expiry',
          orderIdHash: null,
          recoveredGasMist: '0',
          hostFeeMist: '0',
          protocolFeeMist: '0',
        },
      }),
    ).resolves.toEqual({ status: 'expired' });
    await expect(store.readPreparedReceipt(receiptId)).resolves.toEqual(prepared);
    await expect(store.readExpiredPreparedReceipts(100, null)).resolves.toEqual({
      records: [prepared],
      nextCursor: null,
    });
    await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toMatchObject({
      record: { stage: 'committed', receiptId },
    });
    await expect(redis!.client.get(`${prefix}executing:${receiptId}`)).resolves.toBeNull();
  });

  it('RedisSponsoredExecutionStore — keeps same-receipt nonce retries idempotent at quota and bounds u64', async () => {
    const prefix = `test:{nonce-${randomUUID()}}:`;
    const sponsorPool = new RedisSponsorPool(redis!.client, [Ed25519Keypair.generate()], {
      hmacSecret: TEST_HMAC_SECRET,
      keyPrefix: `${prefix}lease:`,
      leaseTtlMs: 60_000,
    });
    const store = new RedisSponsoredExecutionStore(redis!.client, sponsorPool, undefined, {
      keyPrefix: prefix,
      maxOutstandingPerSender: 1,
    });
    const first = receipt(110);
    await expect(store.reserveNonce(SENDER, 0n, first)).resolves.toBe(1n);
    await expect(store.reserveNonce(SENDER, 0n, first)).resolves.toBe(1n);
    const oversizedNonce = '1'.repeat(21);
    await redis!.client.set(`${prefix}nonce:${first}`, oversizedNonce);
    await expect(store.reserveNonce(SENDER, 0n, first)).rejects.toThrow();
    await expect(redis!.client.get(`${prefix}nonce:${first}`)).resolves.toBe(oversizedNonce);
    await redis!.client.set(`${prefix}nonce:${first}`, '1');
    await store.releaseNonceReservation(first, SENDER);
    const contenderReceipts = [receipt(111), receipt(112)] as const;
    const contenders = await Promise.allSettled([
      store.reserveNonce(SENDER, 0n, contenderReceipts[0]),
      store.reserveNonce(SENDER, 0n, contenderReceipts[1]),
    ]);
    expect(contenders.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(contenders.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const loser = contenders.find((result) => result.status === 'rejected');
    expect(loser).toMatchObject({
      status: 'rejected',
      reason: expect.any(PrepareSenderQuotaError),
    });
    const winnerIndex = contenders.findIndex((result) => result.status === 'fulfilled');
    const winnerReceipt = contenderReceipts[winnerIndex];
    const winner = contenders[winnerIndex];
    if (winnerReceipt === undefined || winner === undefined || winner.status !== 'fulfilled') {
      throw new Error('Expected exactly one concurrent nonce reservation winner');
    }
    expect(winner.value).toBe(1n);
    const loserReceipt = contenderReceipts[winnerIndex === 0 ? 1 : 0];
    await expect(redis!.client.get(`${prefix}nonce:${loserReceipt}`)).resolves.toBeNull();
    const senderIndexKey = `${prefix}prepared:sender:${SENDER}`;
    const senderIndexBeforeCorruption = await redis!.rawClient.sendCommand([
      'ZRANGE',
      senderIndexKey,
      '0',
      '-1',
      'WITHSCORES',
    ]);
    await redis!.client.set(`${prefix}nonce:${winnerReceipt}`, oversizedNonce);
    const thirdReceipt = receipt(114);
    await expect(store.reserveNonce(SENDER, 0n, thirdReceipt)).rejects.toThrow();
    await expect(redis!.client.get(`${prefix}nonce:${thirdReceipt}`)).resolves.toBeNull();
    await expect(
      redis!.rawClient.sendCommand(['ZRANGE', senderIndexKey, '0', '-1', 'WITHSCORES']),
    ).resolves.toEqual(senderIndexBeforeCorruption);
    await redis!.client.set(`${prefix}nonce:${winnerReceipt}`, winner.value.toString());
    await store.releaseNonceReservation(winnerReceipt, SENDER);
    await expect(store.reserveNonce(SENDER, U64_MAX, receipt(113))).rejects.toThrow(
      'No u64 nonce remains for this sender',
    );
  });

  it('RedisSponsoredExecutionStore — moves Promotion reservation and accounting in the receipt mutations', async () => {
    const prefix = `test:{promotion-${randomUUID()}}:`;
    const promotionStore = await createRedisPromotionLedgerStore(redis!.client);
    const ledger = new RedisPromotionExecutionLedger(redis!.client, promotionStore, 60_000, 0);
    try {
      await expect(ledger.claim(PROMO_ID, USER, { useUntilAt: null })).resolves.toMatchObject({
        ok: true,
      });
      const receiptId = receipt(120);
      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: USER,
          receiptId,
          amountMist: 1_000_000n,
        }),
      ).resolves.toMatchObject({ ok: true });
      const sponsorPool = new RedisSponsorPool(redis!.client, [Ed25519Keypair.generate()], {
        hmacSecret: TEST_HMAC_SECRET,
        keyPrefix: `${prefix}lease:`,
        leaseTtlMs: 60_000,
      });
      const lease = await sponsorPool.checkout(receiptId);
      if (!lease) throw new Error('Expected the Promotion real-Redis sponsor lease');
      const bytes = await transactionBytes(lease.sponsorAddress);
      const store = new RedisSponsoredExecutionStore(redis!.client, sponsorPool, ledger, {
        keyPrefix: prefix,
      });
      const draft: PromotionPreparedTxDraft = {
        mode: 'promotion',
        receiptId,
        senderAddress: SENDER,
        txBytesHash: sha256Hex(bytes),
        sponsorAddress: lease.sponsorAddress,
        clientIp: '127.0.0.3',
        executionPathKey: 'promotion:redis-test',
        orderId: null,
        promotionId: PROMO_ID,
        userId: USER,
        reservedGasMist: 1_000_000n,
      };
      await store.commitPreparedReceipt(draft);
      const reservationBeforePause = await redis!.client.get(promotionReservationKey(receiptId));
      const ledgerBeforePause = await ledger.getPromotionLedgerStatus(PROMO_ID, USER);
      await promotionStore.transitionStatus(PROMO_ID, 'paused');
      await expect(
        store.beginSponsoredExecution({
          receiptId,
          txBytes: bytes,
          expectedMode: 'promotion',
          executionBudgetMs: 2_000,
          recovery: {
            route: 'promotion',
            senderAddress: SENDER,
            executionPathKey: 'promotion:redis-test',
            promotionId: PROMO_ID,
            userId: USER,
            reservedGasMist: '1000000',
          },
        }),
      ).resolves.toEqual({ status: 'promotion_not_active' });
      await expect(store.readPreparedReceipt(receiptId)).resolves.toMatchObject({ receiptId });
      await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toMatchObject(
        {
          record: { stage: 'committed', receiptId },
        },
      );
      await expect(redis!.client.get(promotionReservationKey(receiptId))).resolves.toBe(
        reservationBeforePause,
      );
      await expect(ledger.getPromotionLedgerStatus(PROMO_ID, USER)).resolves.toEqual(
        ledgerBeforePause,
      );

      await promotionStore.transitionStatus(PROMO_ID, 'active');
      const unusedNonceKey = `${prefix}unused:nonce`;
      await redis!.client.set(unusedNonceKey, 'promotion-nonce-must-not-be-read-or-written');
      const begun = await store.beginSponsoredExecution({
        receiptId,
        txBytes: bytes,
        expectedMode: 'promotion',
        executionBudgetMs: 2_000,
        recovery: {
          route: 'promotion',
          senderAddress: SENDER,
          executionPathKey: 'promotion:redis-test',
          promotionId: PROMO_ID,
          userId: USER,
          reservedGasMist: '1000000',
        },
      });
      expect(begun.status).toBe('executing');
      if (begun.status !== 'executing') return;
      await expect(redis!.client.get(unusedNonceKey)).resolves.toBe(
        'promotion-nonce-must-not-be-read-or-written',
      );
      await promotionStore.transitionStatus(PROMO_ID, 'paused');
      const result: SponsorResultMetadata = {
        sponsorAddress: lease.sponsorAddress,
        outcome: 'success',
        executionStage: 'on_chain',
        route: 'promotion',
        digest: begun.execution.transactionDigest,
        receiptId,
        senderAddress: SENDER,
        executionPathKey: 'promotion:redis-test',
        orderIdHash: null,
        promotionId: PROMO_ID,
        userId: USER,
        economics: {
          economicsStatus: 'known',
          recoveredGasMist: '0',
          hostPaidGasMist: '600000',
          hostFeeMist: '0',
          hostNetMist: '-600000',
          grossGasMist: '600000',
          storageRebateMist: '0',
          protocolFeeMist: '0',
          failureReason: null,
        },
      };
      const finalInput = {
        expected: begun.execution,
        result,
        promotion: { operation: 'consume' as const, chargedMist: 600_000n },
      };
      await expect(store.finalizeSponsoredExecution(finalInput)).resolves.toMatchObject({
        status: 'finalized',
      });
      await expect(store.finalizeSponsoredExecution(finalInput)).resolves.toMatchObject({
        status: 'already_final',
      });
      await expect(
        store.finalizeSponsoredExecution({
          ...finalInput,
          promotion: { operation: 'consume', chargedMist: 500_000n },
        }),
      ).resolves.toEqual({ status: 'state_changed' });
      await expect(ledger.getPromotionLedgerStatus(PROMO_ID, USER)).resolves.toMatchObject({
        budget: { reservedMist: 0n, consumedMist: 600_000n },
        entitlement: {
          activeReservationReceiptId: null,
          remainingGasAllowanceMist: '4400000',
          consumedGasAllowanceMist: '600000',
        },
      });
      await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toBeNull();
    } finally {
      await ledger.dispose();
    }
  });

  it('RedisSponsoredExecutionStore — recovers an exact Promotion commit after its Redis response is lost', async () => {
    const prefix = `test:{promotion-lost-commit-${randomUUID()}}:`;
    const preparedKeyPrefix = sponsoredExecutionPreparedRecordKeyPrefix(prefix);
    const promotionStore = await createRedisPromotionLedgerStore(redis!.client);
    const ledger = new RedisPromotionExecutionLedger(
      redis!.client,
      promotionStore,
      60_000,
      0,
      preparedKeyPrefix,
    );
    try {
      await expect(ledger.claim(PROMO_ID, USER, { useUntilAt: null })).resolves.toMatchObject({
        ok: true,
      });
      const receiptId = receipt(122);
      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: USER,
          receiptId,
          amountMist: 1_000_000n,
        }),
      ).resolves.toMatchObject({ ok: true });
      const sponsorPool = new RedisSponsorPool(redis!.client, [Ed25519Keypair.generate()], {
        hmacSecret: TEST_HMAC_SECRET,
        keyPrefix: `${prefix}lease:`,
        leaseTtlMs: 60_000,
      });
      const lease = await sponsorPool.checkout(receiptId);
      if (!lease) throw new Error('Expected the lost-response test sponsor lease');
      const bytes = await transactionBytes(lease.sponsorAddress);
      const draft: PromotionPreparedTxDraft = {
        mode: 'promotion',
        receiptId,
        senderAddress: SENDER,
        txBytesHash: sha256Hex(bytes),
        sponsorAddress: lease.sponsorAddress,
        clientIp: '127.0.0.14',
        executionPathKey: 'promotion:redis-lost-commit',
        orderId: null,
        promotionId: PROMO_ID,
        userId: USER,
        reservedGasMist: 1_000_000n,
      };
      const preparedKey = `${preparedKeyPrefix}${receiptId}`;
      let responseLost = false;
      let attemptedPreparedRaw: string | null = null;
      const responseLosingClient: RedisClientLike = {
        get: (key) => redis!.client.get(key),
        set: (key, value, options) => redis!.client.set(key, value, options),
        del: (...keys) => redis!.client.del(...keys),
        hgetall: (key) => redis!.client.hgetall(key),
        async eval(script, keys, args) {
          const result = await redis!.client.eval(script, keys, args);
          if (!responseLost && keys[0] === preparedKey) {
            responseLost = true;
            attemptedPreparedRaw = args[2] ?? null;
            throw new Error('simulated Redis response loss after commit');
          }
          return result;
        },
      };
      const store = new RedisSponsoredExecutionStore(responseLosingClient, sponsorPool, ledger, {
        keyPrefix: prefix,
      });
      const reservationBeforeCommit = await redis!.client.get(promotionReservationKey(receiptId));
      const ledgerBeforeCommit = await ledger.getPromotionLedgerStatus(PROMO_ID, USER);

      const prepared = await store.commitPreparedReceipt(draft);

      expect(responseLost).toBe(true);
      expect(prepared).toEqual({ ...draft, issuedAt: expect.any(Number) });
      expect(serializePreparedTxEntry(prepared)).toBe(attemptedPreparedRaw);
      await expect(store.readPreparedReceipt(receiptId)).resolves.toEqual(prepared);
      await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toMatchObject(
        {
          record: {
            stage: 'committed',
            receiptId,
            txBytesHash: draft.txBytesHash,
          },
        },
      );
      await expect(ledger.release(receiptId)).resolves.toEqual({
        ok: false,
        reason: 'record_changed',
      });
      await expect(redis!.client.get(promotionReservationKey(receiptId))).resolves.toBe(
        reservationBeforeCommit,
      );
      await expect(ledger.getPromotionLedgerStatus(PROMO_ID, USER)).resolves.toEqual(
        ledgerBeforeCommit,
      );
      const promotionKeys = promotionReceiptStorageKeys({
        promotionId: PROMO_ID,
        userId: USER,
        receiptId,
        promotionRecordKey: promotionStore.recordKey(PROMO_ID),
      });
      await expect(redis!.client.get(promotionKeys.result)).resolves.toBeNull();
    } finally {
      await ledger.dispose();
    }
  });

  it('RedisSponsoredExecutionStore — protects then atomically discards an expired Promotion prepared receipt', async () => {
    const prefix = `test:{promotion-discard-${randomUUID()}}:`;
    const preparedKeyPrefix = sponsoredExecutionPreparedRecordKeyPrefix(prefix);
    const promotionStore = await createRedisPromotionLedgerStore(redis!.client);
    const ledger = new RedisPromotionExecutionLedger(
      redis!.client,
      promotionStore,
      20,
      0,
      preparedKeyPrefix,
    );
    try {
      await expect(ledger.claim(PROMO_ID, USER, { useUntilAt: null })).resolves.toMatchObject({
        ok: true,
      });
      const receiptId = receipt(121);
      await expect(
        ledger.reserve({
          promotionId: PROMO_ID,
          userId: USER,
          receiptId,
          amountMist: 1_000_000n,
        }),
      ).resolves.toMatchObject({ ok: true });
      const sponsorPool = new RedisSponsorPool(redis!.client, [Ed25519Keypair.generate()], {
        hmacSecret: TEST_HMAC_SECRET,
        keyPrefix: `${prefix}lease:`,
        leaseTtlMs: 60_000,
      });
      const lease = await sponsorPool.checkout(receiptId);
      if (!lease) throw new Error('Expected the Promotion-discard sponsor lease');
      const bytes = await transactionBytes(lease.sponsorAddress);
      const store = new RedisSponsoredExecutionStore(redis!.client, sponsorPool, ledger, {
        keyPrefix: prefix,
        prepareTtlMs: 60_000,
      });
      const draft: PromotionPreparedTxDraft = {
        mode: 'promotion',
        receiptId,
        senderAddress: SENDER,
        txBytesHash: sha256Hex(bytes),
        sponsorAddress: lease.sponsorAddress,
        clientIp: '127.0.0.13',
        executionPathKey: 'promotion:redis-discard',
        orderId: null,
        promotionId: PROMO_ID,
        userId: USER,
        reservedGasMist: 1_000_000n,
      };
      const prepared = await store.commitPreparedReceipt(draft);
      const promotionKeys = promotionReceiptStorageKeys({
        promotionId: PROMO_ID,
        userId: USER,
        receiptId,
        promotionRecordKey: promotionStore.recordKey(PROMO_ID),
      });
      const reservationDeadlineRaw = await redis!.rawClient.sendCommand([
        'ZSCORE',
        promotionReservationDeadlineIndexKey(),
        receiptId,
      ]);
      if (typeof reservationDeadlineRaw !== 'string') {
        throw new Error('Expected the Promotion reservation deadline score');
      }
      const reservationDeadlineMs = Number(reservationDeadlineRaw);
      if (!Number.isSafeInteger(reservationDeadlineMs) || reservationDeadlineMs <= 0) {
        throw new Error('Expected a positive safe Promotion reservation deadline');
      }
      const waitMs = Math.max(0, reservationDeadlineMs - (await readRedisTimeMs(redis!)) + 2);
      if (waitMs > 0) await sleep(waitMs);
      expect(await readRedisTimeMs(redis!)).toBeGreaterThanOrEqual(reservationDeadlineMs);

      const ledgerBeforeSweep = await ledger.getPromotionLedgerStatus(PROMO_ID, USER);
      const reservationBeforeSweep = await redis!.client.get(promotionKeys.reservation);
      await expect(ledger.sweepExpiredReservations()).resolves.toBe(0);
      await expect(store.readPreparedReceipt(receiptId)).resolves.toEqual(prepared);
      await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toMatchObject(
        {
          record: { stage: 'committed', receiptId },
        },
      );
      await expect(redis!.client.get(promotionKeys.reservation)).resolves.toBe(
        reservationBeforeSweep,
      );
      await expect(ledger.getPromotionLedgerStatus(PROMO_ID, USER)).resolves.toEqual(
        ledgerBeforeSweep,
      );

      const discardResult: SponsorResultMetadata = {
        sponsorAddress: lease.sponsorAddress,
        outcome: 'validation_failure',
        executionStage: 'before_sponsor_signature',
        route: 'promotion',
        receiptId,
        senderAddress: SENDER,
        executionPathKey: 'promotion:redis-discard',
        orderIdHash: null,
        promotionId: PROMO_ID,
        userId: USER,
        economics: { economicsStatus: 'unknown', failureReason: 'expired before execution' },
      };
      const callbackKey = `${prefix}callback:pending`;
      const promotionNonceKey = `${prefix}nonce:${receiptId}`;
      await redis!.client.set(callbackKey, 'wrong-type');
      await redis!.client.set(promotionNonceKey, 'promotion-nonce-must-not-be-read-or-written');
      const readState = async () => ({
        prepared: await redis!.client.get(`${preparedKeyPrefix}${receiptId}`),
        lease: await redis!.client.get(sponsorPool.sponsorLeaseRecordKey(lease.sponsorAddress)),
        final: await redis!.client.get(`${prefix}final:${receiptId}`),
        executing: await redis!.client.get(`${prefix}executing:${receiptId}`),
        nonce: await redis!.client.get(promotionNonceKey),
        preparedDeadline: await redis!.rawClient.sendCommand([
          'ZSCORE',
          `${prefix}prepared:deadlines`,
          receiptId,
        ]),
        ipIndex: await redis!.rawClient.sendCommand([
          'ZSCORE',
          `${prefix}prepared:ip:${draft.clientIp}`,
          receiptId,
        ]),
        senderIndex: await redis!.rawClient.sendCommand([
          'ZSCORE',
          `${prefix}prepared:sender:${SENDER}`,
          receiptId,
        ]),
        userIndex: await redis!.rawClient.sendCommand([
          'ZSCORE',
          `${prefix}prepared:user:${USER}`,
          receiptId,
        ]),
        callback: await redis!.client.get(callbackKey),
        promotion: await redis!.client.get(promotionKeys.promotion),
        reservation: await redis!.client.get(promotionKeys.reservation),
        operationResult: await redis!.client.get(promotionKeys.result),
        reservationDeadline: await redis!.rawClient.sendCommand([
          'ZSCORE',
          promotionKeys.reservationDeadlineIndex,
          receiptId,
        ]),
        accounting: await redis!.rawClient.sendCommand(['HGETALL', promotionKeys.accounting]),
        entitlement: await redis!.rawClient.sendCommand(['HGETALL', promotionKeys.entitlement]),
      });
      const beforeFailedDiscard = await readState();
      await expect(
        store.discardPreparedReceipt({ expected: prepared, result: discardResult }),
      ).rejects.toThrow('Pending callback index has the wrong Redis type');
      await expect(readState()).resolves.toEqual(beforeFailedDiscard);

      await redis!.client.del(callbackKey);
      const discarded = await store.discardPreparedReceipt({
        expected: prepared,
        result: discardResult,
      });
      expect(discarded.status).toBe('discarded');
      if (discarded.status !== 'discarded') return;
      await expect(store.readPreparedReceipt(receiptId)).resolves.toBeNull();
      await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toBeNull();
      await expect(
        redis!.rawClient.sendCommand(['ZSCORE', `${prefix}prepared:deadlines`, receiptId]),
      ).resolves.toBeNull();
      await expect(
        redis!.rawClient.sendCommand([
          'ZSCORE',
          `${prefix}prepared:ip:${draft.clientIp}`,
          receiptId,
        ]),
      ).resolves.toBeNull();
      await expect(
        redis!.rawClient.sendCommand(['ZSCORE', `${prefix}prepared:sender:${SENDER}`, receiptId]),
      ).resolves.toBeNull();
      await expect(
        redis!.rawClient.sendCommand(['ZSCORE', `${prefix}prepared:user:${USER}`, receiptId]),
      ).resolves.toBeNull();
      await expect(redis!.client.get(promotionKeys.reservation)).resolves.toBeNull();
      await expect(
        redis!.rawClient.sendCommand(['ZSCORE', promotionKeys.reservationDeadlineIndex, receiptId]),
      ).resolves.toBeNull();
      await expect(redis!.client.get(promotionNonceKey)).resolves.toBe(
        'promotion-nonce-must-not-be-read-or-written',
      );
      const ledgerAfterDiscard = await ledger.getPromotionLedgerStatus(PROMO_ID, USER);
      expect(ledgerAfterDiscard).toMatchObject({
        entitlement: {
          activeReservationReceiptId: null,
          activeReservationAmountMist: null,
          remainingGasAllowanceMist: '5000000',
          consumedGasAllowanceMist: '0',
        },
      });
      expect(ledgerAfterDiscard.budget).toEqual({
        availableMist: ledgerBeforeSweep.budget.availableMist + 1_000_000n,
        reservedMist: 0n,
        consumedMist: ledgerBeforeSweep.budget.consumedMist,
      });
      const operationResultRaw = await redis!.client.get(promotionKeys.result);
      if (operationResultRaw === null) throw new Error('Expected the Promotion release result');
      expect(decodePromotionOperationResultRecord(operationResultRaw)).toMatchObject({
        receiptId,
        operation: 'release',
        amountMist: '1000000',
        result: 'released',
      });
      await expect(store.readPendingCallbacks(100, null)).resolves.toEqual({
        records: [discarded.record],
        nextCursor: null,
      });
      await expect(ledger.release(receiptId)).resolves.toMatchObject({ ok: true });
      await expect(ledger.sweepExpiredReservations()).resolves.toBe(0);
    } finally {
      await ledger.dispose();
    }
  });

  it('SponsoredExecutionRecovery — consumes the full Promotion reservation after an unresolved submit', async () => {
    const prefix = `test:{unresolved-${randomUUID()}}:`;
    const promotionStore = await createRedisPromotionLedgerStore(redis!.client);
    const ledger = new RedisPromotionExecutionLedger(redis!.client, promotionStore, 60_000, 0);
    let recovery: SponsoredExecutionRecovery | null = null;
    try {
      const unresolvedUser = `${USER}-unresolved`;
      await expect(
        ledger.claim(PROMO_X, unresolvedUser, { useUntilAt: null }),
      ).resolves.toMatchObject({
        ok: true,
      });
      const receiptId = receipt(130);
      await expect(
        ledger.reserve({
          promotionId: PROMO_X,
          userId: unresolvedUser,
          receiptId,
          amountMist: 1_000_000n,
        }),
      ).resolves.toMatchObject({ ok: true });
      const sponsorPool = new RedisSponsorPool(redis!.client, [Ed25519Keypair.generate()], {
        hmacSecret: TEST_HMAC_SECRET,
        keyPrefix: `${prefix}lease:`,
        leaseTtlMs: 60_000,
      });
      const lease = await sponsorPool.checkout(receiptId);
      if (!lease) throw new Error('Expected the unresolved-submit sponsor lease');
      const bytes = await transactionBytes(lease.sponsorAddress);
      const store = new RedisSponsoredExecutionStore(redis!.client, sponsorPool, ledger, {
        keyPrefix: prefix,
      });
      await store.commitPreparedReceipt({
        mode: 'promotion',
        receiptId,
        senderAddress: SENDER,
        txBytesHash: sha256Hex(bytes),
        sponsorAddress: lease.sponsorAddress,
        clientIp: '127.0.0.5',
        executionPathKey: 'promotion:redis-unresolved',
        orderId: null,
        promotionId: PROMO_X,
        userId: unresolvedUser,
        reservedGasMist: 1_000_000n,
      });
      const begun = await store.beginSponsoredExecution({
        receiptId,
        txBytes: bytes,
        expectedMode: 'promotion',
        executionBudgetMs: 1,
        recovery: {
          route: 'promotion',
          senderAddress: SENDER,
          executionPathKey: 'promotion:redis-unresolved',
          promotionId: PROMO_X,
          userId: unresolvedUser,
          reservedGasMist: '1000000',
        },
      });
      if (begun.status !== 'executing') throw new Error('Expected an executing unresolved receipt');
      const waitMs = Math.max(0, begun.execution.deadlineMs - (await readRedisTimeMs(redis!)) + 2);
      await sleep(waitMs);
      expect(await readRedisTimeMs(redis!)).toBeGreaterThanOrEqual(begun.execution.deadlineMs);

      const lookupDigests: string[] = [];
      const delivered: SponsorResultMetadata[] = [];
      recovery = new SponsoredExecutionRecovery({
        store,
        sui: suiEndpointSnapshotFixture(),
        intervalMs: 60_000,
        lookup: async (digest) => {
          lookupDigests.push(digest);
          return null;
        },
        onSponsorResult: async (metadata) => {
          delivered.push(metadata);
        },
      });
      await recovery.start();

      expect(lookupDigests).toEqual([begun.execution.transactionDigest]);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        receiptId,
        digest: begun.execution.transactionDigest,
        outcome: 'internal_error',
        executionStage: 'after_sponsor_signature',
        economics: {
          economicsStatus: 'unknown',
          failureReason: 'transaction_result_unresolved',
        },
      });
      const finalRaw = await redis!.client.get(`${prefix}final:${receiptId}`);
      expect(finalRaw).not.toBeNull();
      expect(decodeSponsoredExecutionRecord(finalRaw!)).toMatchObject({
        state: 'final',
        receiptId,
        transactionDigest: begun.execution.transactionDigest,
        callbackDelivery: 'delivered',
      });
      await expect(redis!.client.get(`${prefix}executing:${receiptId}`)).resolves.toBeNull();
      await expect(redis!.client.get(promotionReservationKey(receiptId))).resolves.toBeNull();
      await expect(store.readDueExecutions(100, null)).resolves.toEqual({
        records: [],
        nextCursor: null,
      });
      await expect(store.readPendingCallbacks(100, null)).resolves.toEqual({
        records: [],
        nextCursor: null,
      });
      await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toBeNull();
      await expect(ledger.getPromotionLedgerStatus(PROMO_X, unresolvedUser)).resolves.toMatchObject(
        {
          budget: { reservedMist: 0n, consumedMist: 1_000_000n },
          entitlement: {
            activeReservationReceiptId: null,
            remainingGasAllowanceMist: '4000000',
            consumedGasAllowanceMist: '1000000',
          },
        },
      );
    } finally {
      await recovery?.dispose();
      await ledger.dispose();
    }
  });
});
