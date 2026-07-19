import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRealRedis, type RealRedisHandle } from '@stelis/core-api/testing/redis';
import {
  createRedisSponsorOperationsState,
  slotKey,
  SPONSOR_SLOT_HASH_FIELDS,
  SPONSOR_REFILL_ACCOUNT_HASH_FIELDS,
  SPONSOR_REFILL_ACCOUNT_KEY,
  SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS,
  SPONSOR_REFILL_ACCOUNT_SPEND_KEY,
  SPONSOR_OPERATIONS_MAX_SEQUENCE,
  serializeSponsorRefillAccountSpendRecord,
} from '../../src/sponsor-operations/redisState.js';
import {
  createSponsorRefillAccountSpendState,
  createSponsorRefillAccountWithdrawalOperationId,
  encodeSponsorRefillAccountWithdrawalIssuedReceipt,
  MARK_SPONSOR_REFILL_ACCOUNT_SPEND_READY_LUA,
} from '../../src/sponsor-operations/accountSpendState.js';
import { createSponsorRefillAccountDispatchLock } from '../../src/sponsor-operations/refillLock.js';
import {
  createSponsorRefillAccountSpendCoordinator,
  type SponsorRefillAccountSpendBoundary,
} from '../../src/sponsor-operations/accountSpend.js';
import { createTestSponsorOperationsSettings } from './settingsFixture.js';

const SOURCE = `0x${'11'.repeat(32)}`;
const ADMIN = `0x${'22'.repeat(32)}`;
const SLOT = `0x${'33'.repeat(32)}`;
const SETTINGS = createTestSponsorOperationsSettings({
  sponsorAddresses: [SLOT],
  sponsorRefillAccountAddress: SOURCE,
  settlementPayoutRecipientAddress: ADMIN,
  refillEnabled: true,
  refillTargetMist: 100n,
  runwayTargetMist: 10n,
  warnMist: 50n,
  withdrawalReceiptTtlMs: 120_000,
});

function signedIdentity(seed: number) {
  const transactionBytes = Uint8Array.from([seed, seed + 1]);
  return {
    transactionBytes,
    transactionBytesBase64: toBase64(transactionBytes),
    signature: toBase64(Uint8Array.from([seed + 2])),
    digest: TransactionDataBuilder.getDigestFromBytes(transactionBytes),
    gasBudgetMist: 1n,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Sponsor Refill Account spend current Redis contract', () => {
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

  function state() {
    return createSponsorRefillAccountSpendState(redis!.client, { settings: SETTINGS });
  }

  it('stores one exact degraded slot record when the first balance observation fails', async () => {
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      settings: SETTINGS,
    });
    await expect(
      operationsState.updateSlotIfWriteSeq(SLOT, 0, {
        addressBalanceMist: '',
        lastError: 'rpc unavailable',
      }),
    ).resolves.toBe(true);

    const stored = await redis!.client.hgetall(slotKey(SLOT));
    expect(Object.keys(stored).sort()).toEqual([...SPONSOR_SLOT_HASH_FIELDS].sort());
    await expect(operationsState.readSlotAvailability(SLOT)).resolves.toMatchObject({
      state: 'rpc_unreachable',
      addressBalanceMist: null,
      lastObservedAtMs: null,
      observationFresh: false,
    });
  });

  async function seedObservations(): Promise<void> {
    const spendState = state();
    await expect(
      spendState.updateAccountObservation(
        { operationId: null, spendState: null, spendSequence: 0, writeSequence: 0 },
        { totalBalanceMist: '10000', lastError: '' },
      ),
    ).resolves.toBe(true);
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      settings: SETTINGS,
    });
    await expect(
      operationsState.updateSlotIfWriteSeq(SLOT, 0, {
        addressBalanceMist: '0',
        lastError: '',
      }),
    ).resolves.toBe(true);
  }

  async function issueReceipt(nonceKey: string): Promise<void> {
    await redis!.client.set(
      nonceKey,
      encodeSponsorRefillAccountWithdrawalIssuedReceipt(SETTINGS.network),
      { px: 60_000 },
    );
  }

  it('keeps raw account observation and exact spend lifecycle in different hashes', async () => {
    await seedObservations();
    const spendState = state();
    const reserved = await spendState.reserve({
      operationId: '11111111-1111-4111-8111-111111111111',
      kind: 'refill',
      sourceAddress: SOURCE,
      destinationAddress: SLOT,
      slotAddress: SLOT,
      amountMist: '100',
      observedSlotAddressBalanceMist: '0',
      expectedSlotWriteSequence: 1,
      expectedSourceObservationWriteSequence: null,
      nonceKey: null,
    });
    expect(reserved).toMatchObject({ status: 'created', spend: { state: 'reserved' } });

    const account = await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_KEY);
    const spend = await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_SPEND_KEY);
    expect(Object.keys(account).sort()).toEqual([...SPONSOR_REFILL_ACCOUNT_HASH_FIELDS].sort());
    expect(Object.keys(spend).sort()).toEqual([...SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS].sort());
    expect(account).not.toHaveProperty('state');
    expect(account).not.toHaveProperty('operationId');
    expect(spend).not.toHaveProperty('totalBalanceMist');
  });

  it('fences a sampled slot observation when refill reservation takes ownership', async () => {
    await seedObservations();
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      settings: SETTINGS,
    });
    const sampledSlot = await operationsState.readSlot(SLOT);
    if (sampledSlot === null) throw new Error('expected seeded slot');

    const spendState = state();
    const created = await spendState.reserve({
      operationId: '66666666-6666-4666-8666-666666666666',
      kind: 'refill',
      sourceAddress: SOURCE,
      destinationAddress: SLOT,
      slotAddress: SLOT,
      amountMist: '100',
      observedSlotAddressBalanceMist: '0',
      expectedSlotWriteSequence: sampledSlot.writeSeq,
      expectedSourceObservationWriteSequence: null,
      nonceKey: null,
    });
    if (created.status !== 'created') throw new Error('expected reservation');

    await expect(
      operationsState.updateSlotIfWriteSeq(SLOT, sampledSlot.writeSeq, {
        addressBalanceMist: '999',
        lastError: '',
      }),
    ).resolves.toBe(false);
    await expect(operationsState.readSlot(SLOT)).resolves.toMatchObject({
      addressBalanceMist: '0',
      writeSeq: sampledSlot.writeSeq + 1,
      refillOperationId: created.spend.operationId,
      refillOperationState: 'reserved',
    });

    const identity = signedIdentity(7);
    const ready = await spendState.markReady({
      operationId: created.spend.operationId,
      expectedSequence: created.spend.sequence,
      expectedAccountWriteSequence: 1,
      gasBudgetMist: identity.gasBudgetMist.toString(),
      transactionBytesBase64: identity.transactionBytesBase64,
      signature: identity.signature,
      digest: identity.digest,
      sourceBalanceMist: '10000',
    });
    if (ready?.state !== 'ready') throw new Error('expected ready spend');
    const reconciling = await spendState.markReconciling({
      operationId: ready.operationId,
      expectedSequence: ready.sequence,
      chainResult: 'succeeded',
      lastError: '',
    });
    if (reconciling?.state !== 'reconciling') throw new Error('expected reconciling spend');
    const ownedSlot = await operationsState.readSlot(SLOT);
    if (ownedSlot === null) throw new Error('expected refill-owned slot');

    await expect(
      spendState.complete({
        operationId: reconciling.operationId,
        expectedSequence: reconciling.sequence,
        expectedAccountWriteSequence: 2,
        state: 'succeeded',
        lastError: '',
        account: { totalBalanceMist: '9900', lastError: '' },
        slot: {
          address: SLOT,
          addressBalanceMist: '100',
          lastError: '',
          expectedWriteSequence: ownedSlot.writeSeq,
        },
      }),
    ).resolves.toMatchObject({ state: 'succeeded' });
    await expect(operationsState.readSlot(SLOT)).resolves.toMatchObject({
      addressBalanceMist: '100',
      writeSeq: sampledSlot.writeSeq + 2,
      refillOperationId: created.spend.operationId,
      refillOperationState: 'succeeded',
    });
  });

  it('exact-CASes the complete reserved record before storing signed identity', async () => {
    await seedObservations();
    const spendState = state();
    const created = await spendState.reserve({
      operationId: '22222222-2222-4222-8222-222222222222',
      kind: 'refill',
      sourceAddress: SOURCE,
      destinationAddress: SLOT,
      slotAddress: SLOT,
      amountMist: '100',
      observedSlotAddressBalanceMist: '0',
      expectedSlotWriteSequence: 1,
      expectedSourceObservationWriteSequence: null,
      nonceKey: null,
    });
    if (created.status !== 'created') throw new Error('expected reservation');
    const identity = signedIdentity(1);
    const expected = serializeSponsorRefillAccountSpendRecord(created.spend, SETTINGS);
    const next = serializeSponsorRefillAccountSpendRecord(
      {
        ...created.spend,
        state: 'ready',
        gasBudgetMist: identity.gasBudgetMist.toString(),
        transactionBytesBase64: identity.transactionBytesBase64,
        signature: identity.signature,
        digest: identity.digest,
        sequence: 2,
      },
      SETTINGS,
    );
    await redis!.client.eval(
      "return redis.call('HSET', KEYS[1], 'destinationAddress', ARGV[1])",
      [SPONSOR_REFILL_ACCOUNT_SPEND_KEY],
      [ADMIN],
    );
    const result = await redis!.client.eval(
      MARK_SPONSOR_REFILL_ACCOUNT_SPEND_READY_LUA,
      [SPONSOR_REFILL_ACCOUNT_SPEND_KEY, SPONSOR_REFILL_ACCOUNT_KEY],
      [
        ...SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS.map((field) => expected[field]!),
        ...SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS.map((field) => next[field]!),
        '1',
        '10000',
      ],
    );
    expect(result).toEqual(['STALE']);
    expect(await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_SPEND_KEY)).toMatchObject({
      state: 'reserved',
      destinationAddress: ADMIN,
      transactionBytesBase64: '',
    });
  });

  it('does not store a ready spend when the account observation is malformed', async () => {
    await seedObservations();
    const spendState = state();
    const created = await spendState.reserve({
      operationId: '44444444-4444-4444-8444-444444444444',
      kind: 'refill',
      sourceAddress: SOURCE,
      destinationAddress: SLOT,
      slotAddress: SLOT,
      amountMist: '100',
      observedSlotAddressBalanceMist: '0',
      expectedSlotWriteSequence: 1,
      expectedSourceObservationWriteSequence: null,
      nonceKey: null,
    });
    if (created.status !== 'created') throw new Error('expected reservation');
    await redis!.client.eval(
      "return redis.call('HDEL', KEYS[1], 'lastError')",
      [SPONSOR_REFILL_ACCOUNT_KEY],
      [],
    );
    const spendBefore = await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_SPEND_KEY);
    const accountBefore = await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_KEY);
    const identity = signedIdentity(3);

    await expect(
      spendState.markReady({
        operationId: created.spend.operationId,
        expectedSequence: created.spend.sequence,
        expectedAccountWriteSequence: 1,
        gasBudgetMist: identity.gasBudgetMist.toString(),
        transactionBytesBase64: identity.transactionBytesBase64,
        signature: identity.signature,
        digest: identity.digest,
        sourceBalanceMist: '10000',
      }),
    ).rejects.toThrow('durable record is malformed');

    expect(await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_SPEND_KEY)).toEqual(spendBefore);
    expect(await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_KEY)).toEqual(accountBefore);
  });

  it('leaves every record unchanged when terminal slot CAS loses', async () => {
    await seedObservations();
    const spendState = state();
    const created = await spendState.reserve({
      operationId: '55555555-5555-4555-8555-555555555555',
      kind: 'refill',
      sourceAddress: SOURCE,
      destinationAddress: SLOT,
      slotAddress: SLOT,
      amountMist: '100',
      observedSlotAddressBalanceMist: '0',
      expectedSlotWriteSequence: 1,
      expectedSourceObservationWriteSequence: null,
      nonceKey: null,
    });
    if (created.status !== 'created') throw new Error('expected reservation');
    const identity = signedIdentity(5);
    const ready = await spendState.markReady({
      operationId: created.spend.operationId,
      expectedSequence: created.spend.sequence,
      expectedAccountWriteSequence: 1,
      gasBudgetMist: identity.gasBudgetMist.toString(),
      transactionBytesBase64: identity.transactionBytesBase64,
      signature: identity.signature,
      digest: identity.digest,
      sourceBalanceMist: '10000',
    });
    if (ready?.state !== 'ready') throw new Error('expected ready spend');
    const reconciling = await spendState.markReconciling({
      operationId: ready.operationId,
      expectedSequence: ready.sequence,
      chainResult: 'succeeded',
      lastError: '',
    });
    if (reconciling?.state !== 'reconciling') throw new Error('expected reconciling spend');
    const spendBefore = await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_SPEND_KEY);
    const accountBefore = await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_KEY);
    const slotBefore = await redis!.client.hgetall(slotKey(SLOT));

    await expect(
      spendState.complete({
        operationId: reconciling.operationId,
        expectedSequence: reconciling.sequence,
        expectedAccountWriteSequence: 2,
        state: 'succeeded',
        lastError: '',
        account: { totalBalanceMist: '9900', lastError: '' },
        slot: {
          address: SLOT,
          addressBalanceMist: '100',
          lastError: '',
          expectedWriteSequence: 0,
        },
      }),
    ).resolves.toBeNull();

    expect(await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_SPEND_KEY)).toEqual(spendBefore);
    expect(await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_KEY)).toEqual(accountBefore);
    expect(await redis!.client.hgetall(slotKey(SLOT))).toEqual(slotBefore);
  });

  it('does not advance observation sequences beyond the supported integer range', async () => {
    await seedObservations();
    await redis!.client.eval(
      "redis.call('HSET', KEYS[1], 'writeSeq', ARGV[1]); redis.call('HSET', KEYS[2], 'writeSeq', ARGV[1]); return 1",
      [slotKey(SLOT), SPONSOR_REFILL_ACCOUNT_KEY],
      [String(SPONSOR_OPERATIONS_MAX_SEQUENCE)],
    );
    const slotBefore = await redis!.client.hgetall(slotKey(SLOT));
    const accountBefore = await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_KEY);
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      settings: SETTINGS,
    });

    await expect(
      operationsState.updateSlotIfWriteSeq(SLOT, SPONSOR_OPERATIONS_MAX_SEQUENCE, {
        addressBalanceMist: '1',
        lastError: '',
      }),
    ).rejects.toThrow('sequence reached its maximum value');
    await expect(
      state().updateAccountObservation(
        {
          operationId: null,
          spendState: null,
          spendSequence: 0,
          writeSequence: SPONSOR_OPERATIONS_MAX_SEQUENCE,
        },
        { totalBalanceMist: '1', lastError: '' },
      ),
    ).rejects.toThrow('sequence reached its maximum value');
    await expect(
      state().reserve({
        operationId: '77777777-7777-4777-8777-777777777777',
        kind: 'refill',
        sourceAddress: SOURCE,
        destinationAddress: SLOT,
        slotAddress: SLOT,
        amountMist: '1',
        observedSlotAddressBalanceMist: '0',
        expectedSlotWriteSequence: SPONSOR_OPERATIONS_MAX_SEQUENCE,
        expectedSourceObservationWriteSequence: null,
        nonceKey: null,
      }),
    ).rejects.toThrow('sequence reached its maximum value');

    expect(await redis!.client.hgetall(slotKey(SLOT))).toEqual(slotBefore);
    expect(await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_KEY)).toEqual(accountBefore);
    expect(await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_SPEND_KEY)).toEqual({});
  });

  it('never signs a reserved record during recovery', async () => {
    await seedObservations();
    const spendState = state();
    await spendState.reserve({
      operationId: '33333333-3333-4333-8333-333333333333',
      kind: 'refill',
      sourceAddress: SOURCE,
      destinationAddress: SLOT,
      slotAddress: SLOT,
      amountMist: '100',
      observedSlotAddressBalanceMist: '0',
      expectedSlotWriteSequence: 1,
      expectedSourceObservationWriteSequence: null,
      nonceKey: null,
    });
    const buildAndSign = vi.fn<SponsorRefillAccountSpendBoundary['buildAndSign']>();
    const coordinator = createSponsorRefillAccountSpendCoordinator({
      state: spendState,
      operationsState: createRedisSponsorOperationsState({
        client: redis!.client,
        settings: SETTINGS,
      }),
      dispatchLock: createSponsorRefillAccountDispatchLock({
        client: redis!.client,
        ttlMs: SETTINGS.refillLockTtlMs,
      }),
      boundary: {
        buildAndSign,
        async validateSignedIdentity() {},
        async simulate() {
          return { success: true, error: null };
        },
        async lookup() {
          return { status: 'not_found' };
        },
        async submit() {
          throw new Error('not expected');
        },
        async getTotalBalance() {
          return 10000n;
        },
        async getAddressBalance() {
          return 0n;
        },
      },
      settings: SETTINGS,
    });
    await expect(
      coordinator.recoverActiveSpend(new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'failed',
    });
    expect(buildAndSign).not.toHaveBeenCalled();
    await expect(spendState.read()).resolves.toMatchObject({ state: 'failed', digest: null });
  });

  it('recovers ready state by validating and submitting the same stored bytes once', async () => {
    await seedObservations();
    const spendState = state();
    const nonceKey = 'stelis:test:withdrawal:nonce';
    await issueReceipt(nonceKey);
    const operationId = createSponsorRefillAccountWithdrawalOperationId({
      network: SETTINGS.network,
      sourceAddress: SOURCE,
      destinationAddress: ADMIN,
      amountMist: '10',
      nonceKey,
    });
    const reserved = await spendState.reserve({
      operationId,
      kind: 'withdrawal',
      sourceAddress: SOURCE,
      destinationAddress: ADMIN,
      slotAddress: null,
      amountMist: '10',
      observedSlotAddressBalanceMist: null,
      expectedSlotWriteSequence: null,
      expectedSourceObservationWriteSequence: null,
      nonceKey,
    });
    if (reserved.status !== 'created') throw new Error('expected reservation');
    const cursor = await spendState.readAccountObservationCursor();
    const identity = signedIdentity(9);
    const ready = await spendState.markReady({
      operationId,
      expectedSequence: reserved.spend.sequence,
      expectedAccountWriteSequence: cursor.writeSequence,
      gasBudgetMist: identity.gasBudgetMist.toString(),
      transactionBytesBase64: identity.transactionBytesBase64,
      signature: identity.signature,
      digest: identity.digest,
      sourceBalanceMist: '10000',
    });
    expect(ready).toMatchObject({ state: 'ready', digest: identity.digest });

    const submitted: Uint8Array[] = [];
    let lookupCount = 0;
    const coordinator = createSponsorRefillAccountSpendCoordinator({
      state: spendState,
      operationsState: createRedisSponsorOperationsState({
        client: redis!.client,
        settings: SETTINGS,
      }),
      dispatchLock: createSponsorRefillAccountDispatchLock({
        client: redis!.client,
        ttlMs: SETTINGS.refillLockTtlMs,
      }),
      boundary: {
        async buildAndSign() {
          throw new Error('ready recovery must not build');
        },
        async validateSignedIdentity(input) {
          expect(toBase64(input.transactionBytes)).toBe(identity.transactionBytesBase64);
          expect(input.signature).toBe(identity.signature);
          expect(input.digest).toBe(identity.digest);
        },
        async simulate() {
          throw new Error('ready recovery must not simulate');
        },
        async lookup() {
          lookupCount += 1;
          return lookupCount === 1
            ? { status: 'not_found' }
            : {
                status: 'found',
                result: { digest: identity.digest, success: true, error: null },
              };
        },
        async submit(bytes, signature, digest) {
          submitted.push(bytes);
          expect(signature).toBe(identity.signature);
          expect(digest).toBe(identity.digest);
          return { digest, success: true, error: null };
        },
        async getTotalBalance() {
          return 9990n;
        },
        async getAddressBalance() {
          return 0n;
        },
      },
      settings: SETTINGS,
    });
    await expect(
      coordinator.recoverActiveSpend(new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'succeeded',
      digest: identity.digest,
    });
    expect(submitted).toHaveLength(1);
    expect(toBase64(submitted[0]!)).toBe(identity.transactionBytesBase64);
  });

  it('serializes concurrent refill and withdrawal through one Redis account lock', async () => {
    await seedObservations();
    const nonceKey = 'stelis:test:withdrawal:concurrent-with-refill';
    await issueReceipt(nonceKey);

    const firstBuildStarted = deferred<void>();
    const releaseFirstBuild = deferred<void>();
    const withdrawalLockAttempted = deferred<void>();
    const submitted = new Set<string>();
    let buildCount = 0;
    let refillSubmitted = false;
    const boundary: SponsorRefillAccountSpendBoundary = {
      async buildAndSign() {
        buildCount += 1;
        if (buildCount === 1) {
          firstBuildStarted.resolve(undefined);
          await releaseFirstBuild.promise;
        }
        return signedIdentity(20 + buildCount);
      },
      async validateSignedIdentity() {},
      async simulate() {
        return { success: true, error: null };
      },
      async lookup(digest) {
        return submitted.has(digest)
          ? { status: 'found', result: { digest, success: true, error: null } }
          : { status: 'not_found' };
      },
      async submit(_bytes, _signature, digest) {
        submitted.add(digest);
        if (submitted.size === 1) refillSubmitted = true;
        return { digest, success: true, error: null };
      },
      async getTotalBalance() {
        return 10_000n;
      },
      async getAddressBalance() {
        return refillSubmitted ? 100n : 0n;
      },
    };
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      settings: SETTINGS,
    });
    const first = createSponsorRefillAccountSpendCoordinator({
      state: state(),
      operationsState,
      dispatchLock: createSponsorRefillAccountDispatchLock({
        client: redis!.client,
        ttlMs: SETTINGS.refillLockTtlMs,
        instanceId: 'refill-worker',
      }),
      boundary,
      settings: SETTINGS,
    });
    const withdrawalLock = createSponsorRefillAccountDispatchLock({
      client: redis!.client,
      ttlMs: SETTINGS.refillLockTtlMs,
      instanceId: 'admin-withdrawal',
    });
    const second = createSponsorRefillAccountSpendCoordinator({
      state: state(),
      operationsState,
      dispatchLock: {
        async acquire(address) {
          withdrawalLockAttempted.resolve(undefined);
          return withdrawalLock.acquire(address);
        },
        release: withdrawalLock.release,
      },
      boundary,
      settings: SETTINGS,
    });

    const refill = first.refill(SLOT, 'slot_observed');
    await firstBuildStarted.promise;
    const withdrawal = second.withdraw({
      destinationAddress: ADMIN,
      amountMist: '10',
      nonceKey,
    });
    await withdrawalLockAttempted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(buildCount).toBe(1);
    await expect(state().read()).resolves.toMatchObject({ kind: 'refill', state: 'reserved' });

    releaseFirstBuild.resolve(undefined);
    await expect(refill).resolves.toMatchObject({ status: 'succeeded', amountMist: '100' });
    await expect(withdrawal).resolves.toMatchObject({ status: 'succeeded', amountMist: '10' });
    expect(buildCount).toBe(2);
    expect(submitted.size).toBe(2);
  });

  it('binds withdrawal reservation to the configured source and exact request identity', async () => {
    await seedObservations();
    const spendState = state();
    const nonceKey = 'stelis:test:withdrawal:identity';
    await issueReceipt(nonceKey);
    await expect(
      spendState.reserve({
        operationId: 'withdrawal:' + '0'.repeat(64),
        kind: 'withdrawal',
        sourceAddress: SOURCE,
        destinationAddress: ADMIN,
        slotAddress: null,
        amountMist: '10',
        observedSlotAddressBalanceMist: null,
        expectedSlotWriteSequence: null,
        expectedSourceObservationWriteSequence: null,
        nonceKey,
      }),
    ).rejects.toThrow('operationId is not bound');
    expect(await redis!.client.hgetall(SPONSOR_REFILL_ACCOUNT_SPEND_KEY)).toEqual({});
    expect(await redis!.client.hgetall(slotKey(SLOT))).not.toHaveProperty('state');
  });
});
