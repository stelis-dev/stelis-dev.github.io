import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRealRedis, type RealRedisHandle } from '@stelis/core-api/testing/redis';
import {
  createRedisSponsorOperationsState,
  slotKey,
  SPONSOR_REFILL_ACCOUNT_KEY,
} from '../../src/sponsor-operations/redisState.js';
import {
  createSponsorRefillAccountSpendState,
  encodeSponsorRefillAccountWithdrawalIssuedReceipt,
  FAIL_RESERVED_SPONSOR_REFILL_ACCOUNT_SPEND_LUA,
  RESERVE_SPONSOR_REFILL_ACCOUNT_SPEND_LUA,
  type SponsorRefillAccountSpendStateStore,
} from '../../src/sponsor-operations/accountSpendState.js';
import { createSponsorRefillAccountDispatchLock } from '../../src/sponsor-operations/refillLock.js';
import {
  createSponsorRefillAccountSpendCoordinator,
  type SponsorRefillAccountSpendBoundary,
} from '../../src/sponsor-operations/accountSpend.js';

const SOURCE = `0x${'11'.repeat(32)}`;
const ADMIN = `0x${'22'.repeat(32)}`;
const SLOT = `0x${'33'.repeat(32)}`;
const SLOT_B = `0x${'44'.repeat(32)}`;
const NETWORK = 'testnet' as const;
const ACCEPTED_RECEIPT_TTL_MS = 120_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const validateSignedIdentity: SponsorRefillAccountSpendBoundary['validateSignedIdentity'] =
  async () => undefined;

function lookupSubmittedDigest(submittedDigests: ReadonlySet<string>, digest: string) {
  return submittedDigests.has(digest)
    ? ({ status: 'found', result: { digest, success: true, error: null } } as const)
    : ({ status: 'not_found' } as const);
}

describe('Sponsor Refill Account spend — real Redis', () => {
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

  function createSpendState(network: 'testnet' | 'mainnet' = NETWORK) {
    return createSponsorRefillAccountSpendState(redis!.client, {
      network,
      acceptedReceiptTtlMs: ACCEPTED_RECEIPT_TTL_MS,
    });
  }

  async function issueWithdrawalReceipt(
    nonceKey: string,
    network: 'testnet' | 'mainnet' = NETWORK,
  ): Promise<void> {
    await redis!.client.set(nonceKey, encodeSponsorRefillAccountWithdrawalIssuedReceipt(network), {
      px: 60_000,
    });
  }

  it('atomically consumes a withdrawal nonce with one reservation and preserves a nonce on active conflict', async () => {
    const state = createSpendState();
    const nonce = 'stelis:admin:withdraw_nonce:shared';
    await issueWithdrawalReceipt(nonce);

    const reserve = (operationId: string, nonceKey: string) =>
      state.reserve({
        operationId,
        kind: 'withdrawal',
        sourceAddress: SOURCE,
        destinationAddress: ADMIN,
        slotAddress: null,
        amountMist: '10',
        observedSlotBalanceMist: null,
        expectedSlotWriteSequence: null,
        expectedSourceObservationWriteSequence: null,
        nonceKey,
      });
    const results = await Promise.all([
      reserve('operation-a', nonce),
      reserve('operation-b', nonce),
    ]);
    expect(results.filter((result) => result.status === 'created')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'receipt')).toHaveLength(1);
    await expect(state.readWithdrawalReceipt(nonce)).resolves.toMatchObject({
      type: 'accepted',
      network: NETWORK,
    });
    const acceptedTtlMs = await redis!.client.eval(
      "return redis.call('PTTL', KEYS[1])",
      [nonce],
      [],
    );
    expect(acceptedTtlMs).toEqual(expect.any(Number));
    expect(acceptedTtlMs as number).toBeGreaterThan(100_000);

    const secondNonce = 'stelis:admin:withdraw_nonce:not-consumed-on-conflict';
    await issueWithdrawalReceipt(secondNonce);
    await expect(reserve('operation-c', secondNonce)).resolves.toMatchObject({ status: 'active' });
    expect(await redis!.client.get(secondNonce)).toBe(
      encodeSponsorRefillAccountWithdrawalIssuedReceipt(NETWORK),
    );
  });

  it('keeps an accepted withdrawal receipt through terminal completion and a newer refill', async () => {
    const state = createSpendState();
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [SLOT],
    });
    await operationsState.updateSlotIfWriteSeq(SLOT, 0, {
      state: 'low_balance',
      balanceMist: '0',
    });
    const nonceKey = 'stelis:admin:withdraw_nonce:durable-receipt-a';
    await issueWithdrawalReceipt(nonceKey);
    const request = {
      operationId: 'withdrawal-a',
      kind: 'withdrawal' as const,
      sourceAddress: SOURCE,
      destinationAddress: ADMIN,
      slotAddress: null,
      amountMist: '10',
      observedSlotBalanceMist: null,
      expectedSlotWriteSequence: null,
      expectedSourceObservationWriteSequence: null,
      nonceKey,
    };
    const reserved = await state.reserve(request);
    if (reserved.status !== 'created') throw new Error('withdrawal A reservation failed');
    await expect(state.readWithdrawalReceipt(nonceKey)).resolves.toMatchObject({
      type: 'accepted',
      operationId: request.operationId,
      amountMist: request.amountMist,
    });

    const readyCursor = await state.readAccountObservationCursor();
    const ready = await state.markReady({
      operationId: reserved.spend.operationId,
      expectedSequence: reserved.spend.sequence,
      expectedAccountWriteSequence: readyCursor.writeSequence,
      gasBudgetMist: '10',
      transactionBytesBase64: 'AQ==',
      signature: 'signature-a',
      digest: 'digest-a',
      sourceBalanceMist: '1000',
      refillsRemaining: '10',
    });
    const reconciling = await state.markReconciling({
      operationId: ready!.operationId,
      expectedSequence: ready!.sequence,
      chainResult: 'succeeded',
      lastError: '',
    });
    await redis!.client.eval(
      "return redis.call('PEXPIRE', KEYS[1], ARGV[1])",
      [nonceKey],
      ['1000'],
    );
    const shortenedReceiptTtlMs = (await redis!.client.eval(
      "return redis.call('PTTL', KEYS[1])",
      [nonceKey],
      [],
    )) as number;
    expect(shortenedReceiptTtlMs).toBeGreaterThan(0);
    expect(shortenedReceiptTtlMs).toBeLessThanOrEqual(1_000);
    const completeCursor = await state.readAccountObservationCursor();
    await state.complete({
      operationId: reconciling!.operationId,
      expectedSequence: reconciling!.sequence,
      expectedAccountWriteSequence: completeCursor.writeSequence,
      state: 'succeeded',
      lastError: '',
      account: { balanceMist: '980', healthy: '1', refillsRemaining: '9', lastError: '' },
      slot: null,
    });
    await expect(state.readWithdrawalReceipt(nonceKey)).resolves.toMatchObject({
      type: 'terminal',
      result: {
        operationId: request.operationId,
        status: 'succeeded',
        digest: 'digest-a',
      },
    });
    expect(
      (await redis!.client.eval("return redis.call('PTTL', KEYS[1])", [nonceKey], [])) as number,
    ).toBeGreaterThan(100_000);

    const refill = await state.reserve({
      operationId: 'refill-b',
      kind: 'refill',
      sourceAddress: SOURCE,
      destinationAddress: SLOT,
      slotAddress: SLOT,
      amountMist: '100',
      observedSlotBalanceMist: '0',
      expectedSlotWriteSequence: (await operationsState.readSlot(SLOT))!.writeSeq!,
      expectedSourceObservationWriteSequence: null,
      nonceKey: null,
    });
    expect(refill.status).toBe('created');
    await expect(state.reserve(request)).resolves.toMatchObject({
      status: 'receipt',
      receipt: {
        type: 'terminal',
        result: {
          operationId: request.operationId,
          status: 'succeeded',
          digest: 'digest-a',
        },
      },
    });
    expect(await state.read()).toMatchObject({ operationId: 'refill-b', state: 'reserved' });
  });

  it('rejects a terminal state that contradicts the chain result and records a digest-bearing failure', async () => {
    const state = createSpendState();
    const nonceKey = 'stelis:admin:withdraw_nonce:failed-terminal';
    await issueWithdrawalReceipt(nonceKey);
    const reserved = await state.reserve({
      operationId: 'withdrawal-failed',
      kind: 'withdrawal',
      sourceAddress: SOURCE,
      destinationAddress: ADMIN,
      slotAddress: null,
      amountMist: '10',
      observedSlotBalanceMist: null,
      expectedSlotWriteSequence: null,
      expectedSourceObservationWriteSequence: null,
      nonceKey,
    });
    if (reserved.status !== 'created') throw new Error('withdrawal reservation failed');
    const readyCursor = await state.readAccountObservationCursor();
    const ready = await state.markReady({
      operationId: reserved.spend.operationId,
      expectedSequence: reserved.spend.sequence,
      expectedAccountWriteSequence: readyCursor.writeSequence,
      gasBudgetMist: '10',
      transactionBytesBase64: 'AQ==',
      signature: 'failed-signature',
      digest: 'failed-digest',
      sourceBalanceMist: '1000',
      refillsRemaining: '10',
    });
    const reconciling = await state.markReconciling({
      operationId: ready!.operationId,
      expectedSequence: ready!.sequence,
      chainResult: 'failed',
      lastError: 'MoveAbort',
    });
    const cursor = await state.readAccountObservationCursor();
    const account = {
      balanceMist: '980',
      healthy: '1' as const,
      refillsRemaining: '9',
      lastError: '',
    };

    await expect(
      state.complete({
        operationId: reconciling!.operationId,
        expectedSequence: reconciling!.sequence,
        expectedAccountWriteSequence: cursor.writeSequence,
        state: 'succeeded',
        lastError: '',
        account,
        slot: null,
      }),
    ).rejects.toThrow('terminal state disagrees with its chain result');
    await expect(state.read()).resolves.toMatchObject({
      state: 'reconciling',
      chainResult: 'failed',
      digest: 'failed-digest',
    });
    await expect(state.readWithdrawalReceipt(nonceKey)).resolves.toMatchObject({
      type: 'accepted',
      operationId: 'withdrawal-failed',
    });

    await expect(
      state.complete({
        operationId: reconciling!.operationId,
        expectedSequence: reconciling!.sequence,
        expectedAccountWriteSequence: cursor.writeSequence,
        state: 'failed',
        lastError: 'MoveAbort',
        account,
        slot: null,
      }),
    ).resolves.toMatchObject({
      state: 'failed',
      failureKind: 'failed',
      error: 'MoveAbort',
      digest: 'failed-digest',
    });
    await expect(state.readWithdrawalReceipt(nonceKey)).resolves.toMatchObject({
      type: 'terminal',
      result: {
        status: 'failed',
        digest: 'failed-digest',
        error: 'MoveAbort',
      },
    });
  });

  it('persists the runway terminal kind in the spend and withdrawal receipt', async () => {
    const state = createSpendState();
    const nonceKey = 'stelis:admin:withdraw_nonce:runway-terminal';
    await issueWithdrawalReceipt(nonceKey);
    const request = {
      operationId: 'withdrawal-runway',
      kind: 'withdrawal' as const,
      sourceAddress: SOURCE,
      destinationAddress: ADMIN,
      slotAddress: null,
      amountMist: '10',
      observedSlotBalanceMist: null,
      expectedSlotWriteSequence: null,
      expectedSourceObservationWriteSequence: null,
      nonceKey,
    };
    const reserved = await state.reserve(request);
    if (reserved.status !== 'created') throw new Error('runway reservation failed');
    await state.failReserved({
      operationId: reserved.spend.operationId,
      expectedSequence: reserved.spend.sequence,
      lastError: 'source runway unavailable',
      failureKind: 'runway_blocked',
      requiredSourceBalanceMist: null,
    });

    expect(await state.read()).toMatchObject({
      operationId: request.operationId,
      state: 'failed',
      failureKind: 'runway_blocked',
    });
    await expect(state.reserve(request)).resolves.toMatchObject({
      status: 'receipt',
      receipt: {
        type: 'terminal',
        result: {
          operationId: request.operationId,
          status: 'runway_blocked',
          digest: null,
          error: 'source runway unavailable',
        },
      },
    });
  });

  it('persists the exact source balance required before a runway-blocked refill is eligible again', async () => {
    const state = createSpendState();
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [SLOT],
    });
    await operationsState.updateSlotIfWriteSeq(SLOT, 0, {
      state: 'low_balance',
      balanceMist: '0',
      lastError: '',
    });
    const slot = await operationsState.readSlot(SLOT);
    const reserved = await state.reserve({
      operationId: 'refill-runway',
      kind: 'refill',
      sourceAddress: SOURCE,
      destinationAddress: SLOT,
      slotAddress: SLOT,
      amountMist: '100',
      observedSlotBalanceMist: '0',
      expectedSlotWriteSequence: slot!.writeSeq!,
      expectedSourceObservationWriteSequence: null,
      nonceKey: null,
    });
    if (reserved.status !== 'created') throw new Error('refill runway reservation failed');

    await state.failReserved({
      operationId: reserved.spend.operationId,
      expectedSequence: reserved.spend.sequence,
      lastError: 'source runway unavailable',
      failureKind: 'runway_blocked',
      requiredSourceBalanceMist: '237',
    });

    await expect(operationsState.readSlot(SLOT)).resolves.toMatchObject({
      state: 'refill_failed',
      refillOperationState: 'failed',
      refillRequiredSourceBalanceMist: '237',
    });
  });

  it('does not reserve an automatic refill after its source-balance observation changes', async () => {
    const state = createSpendState();
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [SLOT],
    });
    await operationsState.updateSlotIfWriteSeq(SLOT, 0, {
      state: 'refill_failed',
      balanceMist: '0',
      refillRequiredSourceBalanceMist: '240',
    });
    const initialCursor = await state.readAccountObservationCursor();
    await state.updateAccountObservation(initialCursor, {
      balanceMist: '250',
      healthy: '1',
      refillsRemaining: '1',
      lastError: '',
    });
    const eligibleCursor = await state.readAccountObservationCursor();
    await state.updateAccountObservation(eligibleCursor, {
      balanceMist: '210',
      healthy: '1',
      refillsRemaining: '0',
      lastError: '',
    });

    await expect(
      state.reserve({
        operationId: 'stale-automatic-refill',
        kind: 'refill',
        sourceAddress: SOURCE,
        destinationAddress: SLOT,
        slotAddress: SLOT,
        amountMist: '100',
        observedSlotBalanceMist: '0',
        expectedSlotWriteSequence: (await operationsState.readSlot(SLOT))!.writeSeq!,
        expectedSourceObservationWriteSequence: eligibleCursor.writeSequence,
        nonceKey: null,
      }),
    ).resolves.toEqual({ status: 'source_changed' });
    await expect(state.read()).resolves.toBeNull();
    await expect(operationsState.readSlot(SLOT)).resolves.toMatchObject({
      state: 'refill_failed',
      refillRequiredSourceBalanceMist: '240',
    });
  });

  it('does not let the reserved-failure Lua transition write a different slot projection', async () => {
    const state = createSpendState();
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [SLOT, SLOT_B],
    });
    await operationsState.updateSlotIfWriteSeq(SLOT, 0, {
      state: 'low_balance',
      balanceMist: '0',
    });
    await operationsState.updateSlotIfWriteSeq(SLOT_B, 0, {
      state: 'low_balance',
      balanceMist: '0',
    });
    const reserved = await state.reserve({
      operationId: 'refill-slot-identity',
      kind: 'refill',
      sourceAddress: SOURCE,
      destinationAddress: SLOT,
      slotAddress: SLOT,
      amountMist: '100',
      observedSlotBalanceMist: '0',
      expectedSlotWriteSequence: (await operationsState.readSlot(SLOT))!.writeSeq!,
      expectedSourceObservationWriteSequence: null,
      nonceKey: null,
    });
    if (reserved.status !== 'created') throw new Error('refill reservation failed');
    const wrongSlotKey = slotKey(SLOT_B);

    await expect(
      redis!.client.eval(
        FAIL_RESERVED_SPONSOR_REFILL_ACCOUNT_SPEND_LUA,
        [SPONSOR_REFILL_ACCOUNT_KEY, wrongSlotKey, SPONSOR_REFILL_ACCOUNT_KEY],
        [
          reserved.spend.operationId,
          String(reserved.spend.sequence),
          'source runway unavailable',
          '1',
          'runway_blocked',
          '237',
          '',
          String(ACCEPTED_RECEIPT_TTL_MS),
        ],
      ),
    ).resolves.toEqual(['SLOT_MISMATCH']);
    await expect(state.read()).resolves.toMatchObject({
      operationId: reserved.spend.operationId,
      state: 'reserved',
      slotAddress: SLOT,
    });
    await expect(operationsState.readSlot(SLOT_B)).resolves.toMatchObject({
      state: 'low_balance',
      refillRequiredSourceBalanceMist: null,
    });
  });

  it('does not let the reservation Lua bind a refill to a different slot key', async () => {
    const state = createSpendState();
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [SLOT, SLOT_B],
    });
    await operationsState.updateSlotIfWriteSeq(SLOT, 0, {
      state: 'low_balance',
      balanceMist: '0',
    });
    await operationsState.updateSlotIfWriteSeq(SLOT_B, 0, {
      state: 'low_balance',
      balanceMist: '0',
    });
    const slot = await operationsState.readSlot(SLOT);

    await expect(
      redis!.client.eval(
        RESERVE_SPONSOR_REFILL_ACCOUNT_SPEND_LUA,
        [SPONSOR_REFILL_ACCOUNT_KEY, SPONSOR_REFILL_ACCOUNT_KEY, slotKey(SLOT_B)],
        [
          '0',
          'refill-reservation-slot-identity',
          'refill',
          SOURCE,
          SLOT,
          SLOT,
          '100',
          '1',
          '0',
          String(slot!.writeSeq),
          NETWORK,
          '',
          '',
          String(ACCEPTED_RECEIPT_TTL_MS),
          '',
        ],
      ),
    ).resolves.toEqual(['SLOT_MISMATCH']);
    await expect(state.read()).resolves.toBeNull();
    await expect(operationsState.readSlot(SLOT_B)).resolves.toMatchObject({
      state: 'low_balance',
      balanceMist: '0',
    });
  });

  it('rejects terminal reconciliation against a slot other than the durable refill identity', async () => {
    const state = createSpendState();
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [SLOT, SLOT_B],
    });
    await operationsState.updateSlotIfWriteSeq(SLOT, 0, {
      state: 'low_balance',
      balanceMist: '0',
    });
    await operationsState.updateSlotIfWriteSeq(SLOT_B, 0, {
      state: 'low_balance',
      balanceMist: '0',
    });
    const reserved = await state.reserve({
      operationId: 'refill-terminal-slot-identity',
      kind: 'refill',
      sourceAddress: SOURCE,
      destinationAddress: SLOT,
      slotAddress: SLOT,
      amountMist: '100',
      observedSlotBalanceMist: '0',
      expectedSlotWriteSequence: (await operationsState.readSlot(SLOT))!.writeSeq!,
      expectedSourceObservationWriteSequence: null,
      nonceKey: null,
    });
    if (reserved.status !== 'created') throw new Error('refill reservation failed');
    const accountCursor = await state.readAccountObservationCursor();
    const ready = await state.markReady({
      operationId: reserved.spend.operationId,
      expectedSequence: reserved.spend.sequence,
      expectedAccountWriteSequence: accountCursor.writeSequence,
      gasBudgetMist: '10',
      transactionBytesBase64: 'AQ==',
      signature: 'slot-identity-signature',
      digest: 'slot-identity-digest',
      sourceBalanceMist: '1000',
      refillsRemaining: '9',
    });
    const reconciling = await state.markReconciling({
      operationId: ready!.operationId,
      expectedSequence: ready!.sequence,
      chainResult: 'succeeded',
      lastError: '',
    });
    const terminalCursor = await state.readAccountObservationCursor();
    const wrongSlot = await operationsState.readSlot(SLOT_B);

    await expect(
      state.complete({
        operationId: reconciling!.operationId,
        expectedSequence: reconciling!.sequence,
        expectedAccountWriteSequence: terminalCursor.writeSequence,
        state: 'succeeded',
        lastError: '',
        account: { balanceMist: '890', healthy: '1', refillsRemaining: '8', lastError: '' },
        slot: {
          address: SLOT_B,
          state: 'healthy',
          balanceMist: '100',
          lastError: '',
          reconciliationResult: 'dispatch_succeeded',
          expectedWriteSequence: wrongSlot!.writeSeq!,
        },
      }),
    ).rejects.toThrow('terminal slot identity changed');
    await expect(state.read()).resolves.toMatchObject({
      operationId: reserved.spend.operationId,
      state: 'reconciling',
      slotAddress: SLOT,
    });
    await expect(operationsState.readSlot(SLOT_B)).resolves.toMatchObject({
      state: 'low_balance',
      balanceMist: '0',
    });
  });

  it('fails closed when durable spend or receipt network identity is missing or different', async () => {
    const state = createSpendState();
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [SLOT],
    });
    await operationsState.updateSlotIfWriteSeq(SLOT, 0, {
      state: 'low_balance',
      balanceMist: '0',
    });
    await state.reserve({
      operationId: 'network-bound-refill',
      kind: 'refill',
      sourceAddress: SOURCE,
      destinationAddress: SLOT,
      slotAddress: SLOT,
      amountMist: '100',
      observedSlotBalanceMist: '0',
      expectedSlotWriteSequence: 1,
      expectedSourceObservationWriteSequence: null,
      nonceKey: null,
    });

    await expect(createSpendState('mainnet').read()).rejects.toThrow(
      'different or missing network',
    );
    await redis!.client.eval(
      "return redis.call('HDEL', KEYS[1], 'spendNetwork')",
      [SPONSOR_REFILL_ACCOUNT_KEY],
      [],
    );
    await expect(state.read()).rejects.toThrow('different or missing network');

    await redis!.flush();
    const wrongNetworkNonce = 'stelis:admin:withdraw_nonce:wrong-network';
    await issueWithdrawalReceipt(wrongNetworkNonce, 'mainnet');
    await expect(
      state.reserve({
        operationId: 'wrong-network-withdrawal',
        kind: 'withdrawal',
        sourceAddress: SOURCE,
        destinationAddress: ADMIN,
        slotAddress: null,
        amountMist: '10',
        observedSlotBalanceMist: null,
        expectedSlotWriteSequence: null,
        expectedSourceObservationWriteSequence: null,
        nonceKey: wrongNetworkNonce,
      }),
    ).rejects.toThrow('invalid network or schema');
    expect(await state.read()).toBeNull();
  });

  it('rejects an older account observation that reuses the same spend cursor', async () => {
    const state = createSpendState();
    const nonceKey = 'stelis:admin:withdraw_nonce:same-sequence-observation';
    await issueWithdrawalReceipt(nonceKey);
    const reserved = await state.reserve({
      operationId: 'same-sequence-observation',
      kind: 'withdrawal',
      sourceAddress: SOURCE,
      destinationAddress: ADMIN,
      slotAddress: null,
      amountMist: '10',
      observedSlotBalanceMist: null,
      expectedSlotWriteSequence: null,
      expectedSourceObservationWriteSequence: null,
      nonceKey,
    });
    expect(reserved.status).toBe('created');

    const cursor = await state.readAccountObservationCursor();
    expect(
      await state.updateAccountObservation(cursor, {
        balanceMist: '900',
        healthy: '1',
        refillsRemaining: '9',
        lastError: '',
      }),
    ).toBe(true);
    expect(
      await state.updateAccountObservation(cursor, {
        balanceMist: '100',
        healthy: '0',
        refillsRemaining: '1',
        lastError: 'older RPC response',
      }),
    ).toBe(false);

    const observation = await createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [],
    }).readSponsorRefillAccount();
    expect(observation).toMatchObject({
      balanceMist: '900',
      healthy: true,
      refillsRemaining: 9,
      lastError: null,
    });
  });

  it('does not let a newer account observation starve spend transitions or get overwritten by them', async () => {
    const state = createSpendState();
    const accountView = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [],
    });
    const nonceKey = 'stelis:admin:withdraw_nonce:observation-does-not-starve';
    await issueWithdrawalReceipt(nonceKey);
    const reserved = await state.reserve({
      operationId: 'observation-does-not-starve',
      kind: 'withdrawal',
      sourceAddress: SOURCE,
      destinationAddress: ADMIN,
      slotAddress: null,
      amountMist: '10',
      observedSlotBalanceMist: null,
      expectedSlotWriteSequence: null,
      expectedSourceObservationWriteSequence: null,
      nonceKey,
    });
    if (reserved.status !== 'created') throw new Error('reservation did not succeed');
    const readyCursor = await state.readAccountObservationCursor();
    await state.updateAccountObservation(readyCursor, {
      balanceMist: '901',
      healthy: '1',
      refillsRemaining: '9',
      lastError: '',
    });
    const ready = await state.markReady({
      operationId: reserved.spend.operationId,
      expectedSequence: reserved.spend.sequence,
      expectedAccountWriteSequence: readyCursor.writeSequence,
      gasBudgetMist: '10',
      transactionBytesBase64: 'AQ==',
      signature: 'signature',
      digest: 'digest',
      sourceBalanceMist: '900',
      refillsRemaining: '9',
    });
    expect(ready?.state).toBe('ready');
    expect(await accountView.readSponsorRefillAccount()).toMatchObject({ balanceMist: '901' });

    const reconciling = await state.markReconciling({
      operationId: ready!.operationId,
      expectedSequence: ready!.sequence,
      chainResult: 'succeeded',
      lastError: '',
    });
    const completeCursor = await state.readAccountObservationCursor();
    await state.updateAccountObservation(completeCursor, {
      balanceMist: '801',
      healthy: '1',
      refillsRemaining: '8',
      lastError: '',
    });
    await expect(
      state.complete({
        operationId: reconciling!.operationId,
        expectedSequence: reconciling!.sequence,
        expectedAccountWriteSequence: completeCursor.writeSequence,
        state: 'succeeded',
        lastError: '',
        account: { balanceMist: '800', healthy: '1', refillsRemaining: '8', lastError: '' },
        slot: null,
      }),
    ).resolves.toMatchObject({ state: 'succeeded' });
    expect(await accountView.readSponsorRefillAccount()).toMatchObject({ balanceMist: '801' });
  });

  it('rejects stale spend transitions and stale account/slot observations by exact sequence', async () => {
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [SLOT],
    });
    await operationsState.updateSlotIfWriteSeq(SLOT, 0, {
      state: 'low_balance',
      balanceMist: '0',
      lastError: '',
    });
    const state = createSpendState();
    const reserved = await state.reserve({
      operationId: 'refill-a',
      kind: 'refill',
      sourceAddress: SOURCE,
      destinationAddress: SLOT,
      slotAddress: SLOT,
      amountMist: '100',
      observedSlotBalanceMist: '0',
      expectedSlotWriteSequence: 1,
      expectedSourceObservationWriteSequence: null,
      nonceKey: null,
    });
    expect(reserved.status).toBe('created');
    if (reserved.status !== 'created') throw new Error('reservation did not succeed');

    const sampledAccountCursor = await state.readAccountObservationCursor();
    const sampledSlotWriteSequence = (await operationsState.readSlot(SLOT))!.writeSeq!;
    const ready = await state.markReady({
      operationId: reserved.spend.operationId,
      expectedSequence: reserved.spend.sequence,
      expectedAccountWriteSequence: sampledAccountCursor.writeSequence,
      gasBudgetMist: '10',
      transactionBytesBase64: 'AQID',
      signature: 'signature',
      digest: 'digest',
      sourceBalanceMist: '1000',
      refillsRemaining: '10',
    });
    expect(ready?.state).toBe('ready');
    expect(
      await state.updateAccountObservation(sampledAccountCursor, {
        balanceMist: 'stale',
        healthy: '0',
        refillsRemaining: '',
        lastError: 'stale',
      }),
    ).toBe(false);
    expect(
      await operationsState.updateSlotIfWriteSeq(SLOT, sampledSlotWriteSequence, {
        state: 'healthy',
        balanceMist: '999',
      }),
    ).toBe(false);

    const reconciling = await state.markReconciling({
      operationId: ready!.operationId,
      expectedSequence: ready!.sequence,
      chainResult: 'succeeded',
      lastError: '',
    });
    expect(reconciling?.state).toBe('reconciling');
    const reconciliationCursor = await state.readAccountObservationCursor();
    const reconciliationSlot = await operationsState.readSlot(SLOT);
    const completed = await state.complete({
      operationId: reconciling!.operationId,
      expectedSequence: reconciling!.sequence,
      expectedAccountWriteSequence: reconciliationCursor.writeSequence,
      state: 'succeeded',
      lastError: '',
      account: { balanceMist: '890', healthy: '1', refillsRemaining: '8', lastError: '' },
      slot: {
        address: SLOT,
        state: 'healthy',
        balanceMist: '100',
        lastError: '',
        reconciliationResult: 'dispatch_succeeded',
        expectedWriteSequence: reconciliationSlot!.writeSeq!,
      },
    });
    expect(completed?.state).toBe('succeeded');
    await expect(
      state.complete({
        operationId: ready!.operationId,
        expectedSequence: reconciling!.sequence,
        expectedAccountWriteSequence: reconciliationCursor.writeSequence,
        state: 'failed',
        lastError: 'late result',
        account: { balanceMist: '', healthy: '0', refillsRemaining: '', lastError: '' },
        slot: null,
      }),
    ).resolves.toBeNull();
    expect((await state.read())?.state).toBe('succeeded');
  });

  it('preserves B ready state when A terminal work arrives late', async () => {
    const state = createSpendState();
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [SLOT],
    });
    await operationsState.updateSlotIfWriteSeq(SLOT, 0, {
      state: 'low_balance',
      balanceMist: '0',
    });
    const a = await state.reserve({
      operationId: 'operation-a',
      kind: 'refill',
      sourceAddress: SOURCE,
      destinationAddress: SLOT,
      slotAddress: SLOT,
      amountMist: '10',
      observedSlotBalanceMist: '0',
      expectedSlotWriteSequence: 1,
      expectedSourceObservationWriteSequence: null,
      nonceKey: null,
    });
    if (a.status !== 'created') throw new Error('operation A reservation failed');
    const aReadyCursor = await state.readAccountObservationCursor();
    const aReady = await state.markReady({
      operationId: a.spend.operationId,
      expectedSequence: a.spend.sequence,
      expectedAccountWriteSequence: aReadyCursor.writeSequence,
      gasBudgetMist: '10',
      transactionBytesBase64: 'AQ==',
      signature: 'signature-a',
      digest: 'digest-a',
      sourceBalanceMist: '900',
      refillsRemaining: '9',
    });
    const aReconciling = await state.markReconciling({
      operationId: aReady!.operationId,
      expectedSequence: aReady!.sequence,
      chainResult: 'succeeded',
      lastError: '',
    });
    const aCursor = await state.readAccountObservationCursor();
    const aSlot = await operationsState.readSlot(SLOT);
    await expect(
      state.complete({
        operationId: aReconciling!.operationId,
        expectedSequence: aReconciling!.sequence,
        expectedAccountWriteSequence: aCursor.writeSequence,
        state: 'succeeded',
        lastError: '',
        account: { balanceMist: '800', healthy: '1', refillsRemaining: '8', lastError: '' },
        slot: {
          address: SLOT,
          state: 'healthy',
          balanceMist: '10',
          lastError: '',
          reconciliationResult: 'dispatch_succeeded',
          expectedWriteSequence: aSlot!.writeSeq!,
        },
      }),
    ).resolves.toMatchObject({ operationId: 'operation-a', state: 'succeeded' });

    const b = await state.reserve({
      operationId: 'operation-b',
      kind: 'refill',
      sourceAddress: SOURCE,
      destinationAddress: SLOT,
      slotAddress: SLOT,
      amountMist: '20',
      observedSlotBalanceMist: '10',
      expectedSlotWriteSequence: (await operationsState.readSlot(SLOT))!.writeSeq!,
      expectedSourceObservationWriteSequence: null,
      nonceKey: null,
    });
    if (b.status !== 'created') throw new Error('operation B reservation failed');
    const bReadyCursor = await state.readAccountObservationCursor();
    const bReady = await state.markReady({
      operationId: b.spend.operationId,
      expectedSequence: b.spend.sequence,
      expectedAccountWriteSequence: bReadyCursor.writeSequence,
      gasBudgetMist: '11',
      transactionBytesBase64: 'Ag==',
      signature: 'signature-b',
      digest: 'digest-b',
      sourceBalanceMist: '700',
      refillsRemaining: '7',
    });

    await expect(
      state.markReconciling({
        operationId: aReady!.operationId,
        expectedSequence: aReady!.sequence,
        chainResult: 'failed',
        lastError: 'late A submit result',
      }),
    ).resolves.toBeNull();
    await expect(
      state.complete({
        operationId: aReconciling!.operationId,
        expectedSequence: aReconciling!.sequence,
        expectedAccountWriteSequence: aCursor.writeSequence,
        state: 'failed',
        lastError: 'late A result',
        account: { balanceMist: '1', healthy: '0', refillsRemaining: '', lastError: 'late' },
        slot: {
          address: SLOT,
          state: 'refill_failed',
          balanceMist: '1',
          lastError: 'late',
          reconciliationResult: 'dispatch_failed',
          expectedWriteSequence: aSlot!.writeSeq!,
        },
      }),
    ).resolves.toBeNull();
    await expect(
      state.updateAccountObservation(aCursor, {
        balanceMist: '2',
        healthy: '0',
        refillsRemaining: '',
        lastError: 'late A observation',
      }),
    ).resolves.toBe(false);
    await expect(
      operationsState.updateSlotIfWriteSeq(SLOT, aSlot!.writeSeq!, {
        state: 'healthy',
        balanceMist: '999',
      }),
    ).resolves.toBe(false);

    expect(await state.read()).toMatchObject({
      operationId: 'operation-b',
      state: 'ready',
      digest: 'digest-b',
      sequence: bReady!.sequence,
    });
    expect(await operationsState.readSponsorRefillAccount()).toMatchObject({
      balanceMist: '700',
      healthy: true,
      refillsRemaining: 7,
      lastError: null,
    });
    expect(await operationsState.readSlot(SLOT)).toMatchObject({
      refillOperationId: 'operation-b',
      refillOperationSequence: bReady!.sequence,
      refillOperationState: 'ready',
      pendingRefillDigest: 'digest-b',
    });
  });

  it('keeps one transaction identity when the mutex TTL expires during submit', async () => {
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [SLOT],
    });
    await operationsState.updateSlotIfWriteSeq(SLOT, 0, {
      state: 'healthy',
      balanceMist: '100',
      lastError: '',
    });
    const stateA = createSpendState();
    const stateB = createSpendState();
    const firstSubmitGate = deferred();
    const submitRecords: Array<{ digest: string; bytes: string; signature: string }> = [];
    const submittedDigests = new Set<string>();
    let buildCount = 0;
    const boundary: SponsorRefillAccountSpendBoundary = {
      async buildAndSign() {
        buildCount += 1;
        return {
          transactionBytes: new Uint8Array([buildCount]),
          signature: `signature-${buildCount}`,
          digest: `digest-${buildCount}`,
          gasBudgetMist: 10n,
        };
      },
      validateSignedIdentity,
      async simulate() {
        return { success: true, error: null };
      },
      async lookup(digest) {
        return lookupSubmittedDigest(submittedDigests, digest);
      },
      async submit(bytes, signature, digest) {
        submitRecords.push({ digest, bytes: Buffer.from(bytes).toString('base64'), signature });
        if (digest === 'digest-1') await firstSubmitGate.promise;
        submittedDigests.add(digest);
        return { digest, success: true, error: null };
      },
      async getBalance() {
        return 10_000n;
      },
    };
    const createCoordinator = (state: SponsorRefillAccountSpendStateStore, instanceId: string) =>
      createSponsorRefillAccountSpendCoordinator({
        state,
        operationsState,
        dispatchLock: createSponsorRefillAccountDispatchLock({
          client: redis!.client,
          ttlMs: 20,
          instanceId,
        }),
        boundary,
        network: NETWORK,
        sourceAddress: SOURCE,
        sponsorSlotCount: 1,
        refillEnabled: true,
        refillTargetMist: 100n,
        runwayTargetMist: 100n,
        warnThresholdMist: 50n,
        dispatchTimeoutMs: 500,
        balanceTimeoutMs: 100,
        confirmationTimeoutMs: 100,
      });
    const coordinatorA = createCoordinator(stateA, 'instance-a');
    const coordinatorB = createCoordinator(stateB, 'instance-b');
    const nonceA = 'stelis:admin:withdraw_nonce:a';
    const nonceB = 'stelis:admin:withdraw_nonce:b';
    await issueWithdrawalReceipt(nonceA);
    await issueWithdrawalReceipt(nonceB);

    const first = coordinatorA.withdraw({
      destinationAddress: ADMIN,
      amountMist: '10',
      nonceKey: nonceA,
    });
    await vi.waitFor(() => expect(submitRecords).toHaveLength(1));
    await sleep(30);
    const second = coordinatorB.withdraw({
      destinationAddress: ADMIN,
      amountMist: '11',
      nonceKey: nonceB,
    });
    await vi.waitFor(() => expect(submitRecords).toHaveLength(2));

    expect(buildCount).toBe(1);
    expect(new Set(submitRecords.map((record) => record.digest))).toEqual(new Set(['digest-1']));
    expect(new Set(submitRecords.map((record) => record.bytes)).size).toBe(1);
    expect(new Set(submitRecords.map((record) => record.signature)).size).toBe(1);

    firstSubmitGate.resolve();
    const firstResult = await first;
    expect(firstResult).toMatchObject({ status: 'succeeded', digest: 'digest-1' });
    await expect(second).resolves.toMatchObject({ status: 'busy', digest: 'digest-1' });
    expect(buildCount).toBe(1);

    await expect(
      coordinatorB.withdraw({
        destinationAddress: ADMIN,
        amountMist: '11',
        nonceKey: nonceB,
      }),
    ).resolves.toMatchObject({ status: 'succeeded', digest: 'digest-2' });
    expect(buildCount).toBe(2);

    const submitCountBeforeReplay = submitRecords.length;
    await expect(
      coordinatorA.withdraw({
        destinationAddress: ADMIN,
        amountMist: '10',
        nonceKey: nonceA,
      }),
    ).resolves.toEqual(firstResult);
    expect(buildCount).toBe(2);
    expect(submitRecords).toHaveLength(submitCountBeforeReplay);
  });

  it('does not let an expired owner release the next lock owner', async () => {
    const expiredOwner = createSponsorRefillAccountDispatchLock({
      client: redis!.client,
      ttlMs: 20,
      instanceId: 'expired-owner',
    });
    const nextOwner = createSponsorRefillAccountDispatchLock({
      client: redis!.client,
      ttlMs: 500,
      instanceId: 'next-owner',
    });
    const contender = createSponsorRefillAccountDispatchLock({
      client: redis!.client,
      ttlMs: 500,
      instanceId: 'contender',
    });

    const expiredHandle = await expiredOwner.acquire(SOURCE);
    expect(expiredHandle).not.toBeNull();
    await sleep(40);
    const nextHandle = await nextOwner.acquire(SOURCE);
    expect(nextHandle).not.toBeNull();

    await expiredOwner.release(expiredHandle!);
    expect(await contender.acquire(SOURCE)).toBeNull();

    await nextOwner.release(nextHandle!);
    expect(await contender.acquire(SOURCE)).not.toBeNull();
  });

  it('serializes two refills for the same slot into one submit followed by not-needed', async () => {
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [SLOT],
    });
    await operationsState.updateSlotIfWriteSeq(SLOT, 0, {
      state: 'low_balance',
      balanceMist: '0',
      lastError: '',
    });
    let sourceBalance = 1_000n;
    let slotBalance = 0n;
    let buildCount = 0;
    let submitCount = 0;
    const submittedDigests = new Set<string>();
    const built = new Map<string, { destination: string; amount: bigint; gas: bigint }>();
    const boundary: SponsorRefillAccountSpendBoundary = {
      async buildAndSign(destination, amount) {
        buildCount += 1;
        const digest = `same-slot-${buildCount}`;
        built.set(digest, { destination, amount, gas: 10n });
        return {
          transactionBytes: new Uint8Array([buildCount, Number(amount)]),
          signature: `same-slot-signature-${buildCount}`,
          digest,
          gasBudgetMist: 10n,
        };
      },
      validateSignedIdentity,
      async simulate() {
        return { success: true, error: null };
      },
      async lookup(digest) {
        return lookupSubmittedDigest(submittedDigests, digest);
      },
      async submit(_bytes, _signature, digest) {
        const transaction = built.get(digest)!;
        submitCount += 1;
        sourceBalance -= transaction.amount + transaction.gas;
        if (transaction.destination === SLOT) slotBalance += transaction.amount;
        submittedDigests.add(digest);
        return { digest, success: true, error: null };
      },
      async getBalance(address) {
        return address === SLOT ? slotBalance : sourceBalance;
      },
    };
    const makeCoordinator = (instanceId: string) =>
      createSponsorRefillAccountSpendCoordinator({
        state: createSpendState(),
        operationsState,
        dispatchLock: createSponsorRefillAccountDispatchLock({
          client: redis!.client,
          ttlMs: 1_000,
          instanceId,
        }),
        boundary,
        network: NETWORK,
        sourceAddress: SOURCE,
        sponsorSlotCount: 1,
        refillEnabled: true,
        refillTargetMist: 100n,
        runwayTargetMist: 100n,
        warnThresholdMist: 50n,
        dispatchTimeoutMs: 1_000,
        balanceTimeoutMs: 100,
        confirmationTimeoutMs: 100,
      });

    const results = await Promise.all([
      makeCoordinator('same-slot-a').refill(SLOT, 'explicit'),
      makeCoordinator('same-slot-b').refill(SLOT, 'explicit'),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['not_needed', 'succeeded']);
    expect(submitCount).toBe(1);
    expect(buildCount).toBe(1);
    expect(slotBalance).toBe(100n);
  });

  it('closes a successful refill after digest visibility even when the current slot is low', async () => {
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [SLOT],
    });
    await operationsState.updateSlotIfWriteSeq(SLOT, 0, {
      state: 'low_balance',
      balanceMist: '40',
    });
    let buildCount = 0;
    let submitCount = 0;
    const submittedDigests = new Set<string>();
    const boundary: SponsorRefillAccountSpendBoundary = {
      async buildAndSign(_destination, amount) {
        buildCount += 1;
        expect(amount).toBe(60n);
        return {
          transactionBytes: new Uint8Array([buildCount]),
          signature: `below-target-signature-${buildCount}`,
          digest: `below-target-${buildCount}`,
          gasBudgetMist: 10n,
        };
      },
      validateSignedIdentity,
      async simulate() {
        return { success: true, error: null };
      },
      async lookup(digest) {
        return lookupSubmittedDigest(submittedDigests, digest);
      },
      async submit(_bytes, _signature, digest) {
        submitCount += 1;
        submittedDigests.add(digest);
        return { digest, success: true, error: null };
      },
      async getBalance(address) {
        return address === SLOT ? 40n : 1_000n;
      },
    };
    const spendState = createSpendState();
    const coordinator = createSponsorRefillAccountSpendCoordinator({
      state: spendState,
      operationsState,
      dispatchLock: createSponsorRefillAccountDispatchLock({
        client: redis!.client,
        ttlMs: 1_000,
        instanceId: 'below-target',
      }),
      boundary,
      network: NETWORK,
      sourceAddress: SOURCE,
      sponsorSlotCount: 1,
      refillEnabled: true,
      refillTargetMist: 100n,
      runwayTargetMist: 100n,
      warnThresholdMist: 50n,
      dispatchTimeoutMs: 1_000,
      balanceTimeoutMs: 100,
      confirmationTimeoutMs: 100,
    });

    await expect(coordinator.refill(SLOT, 'explicit')).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(buildCount).toBe(1);
    expect(submitCount).toBe(1);
    expect(await spendState.read()).toMatchObject({ state: 'succeeded' });
    expect(await operationsState.readSlot(SLOT)).toMatchObject({
      state: 'low_balance',
      balanceMist: '40',
      refillReconciliationResult: 'dispatch_succeeded',
      refillOperationState: 'succeeded',
      pendingRefillDigest: null,
    });
  });

  it('serializes refill before a concurrent withdrawal in the reverse direction', async () => {
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [SLOT],
    });
    await operationsState.updateSlotIfWriteSeq(SLOT, 0, {
      state: 'low_balance',
      balanceMist: '0',
      lastError: '',
    });
    const withdrawalNonce = 'stelis:admin:withdraw_nonce:refill-then-withdraw';
    await issueWithdrawalReceipt(withdrawalNonce);
    const firstSubmitGate = deferred();
    let sourceBalance = 1_000n;
    let slotBalance = 0n;
    let buildCount = 0;
    let activeSubmits = 0;
    let maxActiveSubmits = 0;
    const submittedDestinations: string[] = [];
    const submittedDigests = new Set<string>();
    const built = new Map<string, { destination: string; amount: bigint; gas: bigint }>();
    const boundary: SponsorRefillAccountSpendBoundary = {
      async buildAndSign(destination, amount) {
        buildCount += 1;
        const digest = `reverse-${buildCount}`;
        built.set(digest, { destination, amount, gas: 10n });
        return {
          transactionBytes: new Uint8Array([buildCount, Number(amount)]),
          signature: `reverse-signature-${buildCount}`,
          digest,
          gasBudgetMist: 10n,
        };
      },
      validateSignedIdentity,
      async simulate() {
        return { success: true, error: null };
      },
      async lookup(digest) {
        return lookupSubmittedDigest(submittedDigests, digest);
      },
      async submit(_bytes, _signature, digest) {
        const transaction = built.get(digest)!;
        submittedDestinations.push(transaction.destination);
        activeSubmits += 1;
        maxActiveSubmits = Math.max(maxActiveSubmits, activeSubmits);
        if (submittedDestinations.length === 1) await firstSubmitGate.promise;
        sourceBalance -= transaction.amount + transaction.gas;
        if (transaction.destination === SLOT) slotBalance += transaction.amount;
        activeSubmits -= 1;
        submittedDigests.add(digest);
        return { digest, success: true, error: null };
      },
      async getBalance(address) {
        return address === SLOT ? slotBalance : sourceBalance;
      },
    };
    const makeCoordinator = (instanceId: string) =>
      createSponsorRefillAccountSpendCoordinator({
        state: createSpendState(),
        operationsState,
        dispatchLock: createSponsorRefillAccountDispatchLock({
          client: redis!.client,
          ttlMs: 1_000,
          instanceId,
        }),
        boundary,
        network: NETWORK,
        sourceAddress: SOURCE,
        sponsorSlotCount: 1,
        refillEnabled: true,
        refillTargetMist: 100n,
        runwayTargetMist: 100n,
        warnThresholdMist: 50n,
        dispatchTimeoutMs: 1_000,
        balanceTimeoutMs: 100,
        confirmationTimeoutMs: 100,
      });

    const refill = makeCoordinator('reverse-refill').refill(SLOT, 'explicit');
    await vi.waitFor(() => expect(submittedDestinations).toEqual([SLOT]));
    const withdrawal = makeCoordinator('reverse-withdraw').withdraw({
      destinationAddress: ADMIN,
      amountMist: '20',
      nonceKey: withdrawalNonce,
    });
    await sleep(30);
    expect(submittedDestinations).toEqual([SLOT]);

    firstSubmitGate.resolve();
    await expect(refill).resolves.toMatchObject({ status: 'succeeded' });
    await expect(withdrawal).resolves.toMatchObject({ status: 'succeeded' });
    expect(submittedDestinations).toEqual([SLOT, ADMIN]);
    expect(maxActiveSubmits).toBe(1);
  });

  it('uses each withdrawal fresh source balance and its own resolved gas budget for runway', async () => {
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [],
    });
    const gasBudgets = [10n, 11n];
    let sourceBalance = 260n;
    const observedSourceBalances: bigint[] = [];
    let buildCount = 0;
    let submitCount = 0;
    const submittedDigests = new Set<string>();
    const boundary: SponsorRefillAccountSpendBoundary = {
      async buildAndSign() {
        const gasBudgetMist = gasBudgets[buildCount]!;
        buildCount += 1;
        return {
          transactionBytes: new Uint8Array([buildCount]),
          signature: `runway-signature-${buildCount}`,
          digest: `runway-${buildCount}`,
          gasBudgetMist,
        };
      },
      validateSignedIdentity,
      async simulate() {
        return { success: true, error: null };
      },
      async lookup(digest) {
        return lookupSubmittedDigest(submittedDigests, digest);
      },
      async submit(_bytes, _signature, digest) {
        submitCount += 1;
        submittedDigests.add(digest);
        return { digest, success: true, error: null };
      },
      async getBalance(address) {
        if (address !== SOURCE) throw new Error(`unexpected balance address ${address}`);
        observedSourceBalances.push(sourceBalance);
        return sourceBalance;
      },
    };
    const coordinator = createSponsorRefillAccountSpendCoordinator({
      state: createSpendState(),
      operationsState,
      dispatchLock: createSponsorRefillAccountDispatchLock({
        client: redis!.client,
        ttlMs: 1_000,
        instanceId: 'runway',
      }),
      boundary,
      network: NETWORK,
      sourceAddress: SOURCE,
      sponsorSlotCount: 2,
      refillEnabled: false,
      refillTargetMist: null,
      runwayTargetMist: 100n,
      warnThresholdMist: 50n,
      dispatchTimeoutMs: 1_000,
      balanceTimeoutMs: 100,
      confirmationTimeoutMs: 100,
    });
    const firstNonce = 'stelis:admin:withdraw_nonce:runway-first';
    const secondNonce = 'stelis:admin:withdraw_nonce:runway-second';
    await issueWithdrawalReceipt(firstNonce);
    await issueWithdrawalReceipt(secondNonce);

    await expect(
      coordinator.withdraw({ destinationAddress: ADMIN, amountMist: '50', nonceKey: firstNonce }),
    ).resolves.toMatchObject({ status: 'succeeded' });
    sourceBalance = 270n;
    await expect(
      coordinator.withdraw({ destinationAddress: ADMIN, amountMist: '60', nonceKey: secondNonce }),
    ).resolves.toMatchObject({ status: 'runway_blocked' });

    expect(observedSourceBalances).toEqual([260n, 260n, 270n]);
    expect(buildCount).toBe(2);
    expect(submitCount).toBe(1);
  });

  it.each([
    ['withdrawal / withdrawal', 'withdrawal-withdrawal'],
    ['withdrawal / refill', 'withdrawal-refill'],
    ['refill / refill', 'refill-refill'],
  ] as const)('serializes %s through one account spend flow', async (_label, scenario) => {
    const operationsState = createRedisSponsorOperationsState({
      client: redis!.client,
      slotAddresses: [SLOT, SLOT_B],
    });
    await operationsState.updateSlotIfWriteSeq(SLOT, 0, {
      state: 'low_balance',
      balanceMist: '0',
    });
    await operationsState.updateSlotIfWriteSeq(SLOT_B, 0, {
      state: 'low_balance',
      balanceMist: '0',
    });
    const slotBalances = new Map([
      [SLOT, 0n],
      [SLOT_B, 0n],
    ]);
    const firstSubmitGate = deferred();
    const built = new Map<
      string,
      { readonly destination: string; readonly amount: bigint; readonly bytes: Uint8Array }
    >();
    let buildCount = 0;
    let submitCount = 0;
    let activeSubmits = 0;
    let maxActiveSubmits = 0;
    const submittedDigests = new Set<string>();
    const boundary: SponsorRefillAccountSpendBoundary = {
      async buildAndSign(destination, amount) {
        buildCount += 1;
        const digest = `scenario-digest-${buildCount}`;
        const bytes = new Uint8Array([buildCount, Number(amount)]);
        built.set(digest, { destination, amount, bytes });
        return {
          transactionBytes: bytes,
          signature: `scenario-signature-${buildCount}`,
          digest,
          gasBudgetMist: 10n,
        };
      },
      validateSignedIdentity,
      async simulate() {
        return { success: true, error: null };
      },
      async lookup(digest) {
        return lookupSubmittedDigest(submittedDigests, digest);
      },
      async submit(bytes, _signature, digest) {
        expect(Buffer.from(bytes)).toEqual(Buffer.from(built.get(digest)!.bytes));
        submitCount += 1;
        activeSubmits += 1;
        maxActiveSubmits = Math.max(maxActiveSubmits, activeSubmits);
        if (submitCount === 1) await firstSubmitGate.promise;
        const transaction = built.get(digest)!;
        if (slotBalances.has(transaction.destination)) {
          slotBalances.set(
            transaction.destination,
            slotBalances.get(transaction.destination)! + transaction.amount,
          );
        }
        activeSubmits -= 1;
        submittedDigests.add(digest);
        return { digest, success: true, error: null };
      },
      async getBalance(address) {
        return slotBalances.get(address) ?? 100_000n;
      },
    };
    const createCoordinator = (instanceId: string) =>
      createSponsorRefillAccountSpendCoordinator({
        state: createSpendState(),
        operationsState,
        dispatchLock: createSponsorRefillAccountDispatchLock({
          client: redis!.client,
          ttlMs: 500,
          instanceId,
        }),
        boundary,
        network: NETWORK,
        sourceAddress: SOURCE,
        sponsorSlotCount: 2,
        refillEnabled: true,
        refillTargetMist: 100n,
        runwayTargetMist: 100n,
        warnThresholdMist: 50n,
        dispatchTimeoutMs: 1_000,
        balanceTimeoutMs: 100,
        confirmationTimeoutMs: 100,
      });
    const coordinatorA = createCoordinator('scenario-a');
    const coordinatorB = createCoordinator('scenario-b');
    const nonceA = `stelis:admin:withdraw_nonce:${scenario}:a`;
    const nonceB = `stelis:admin:withdraw_nonce:${scenario}:b`;
    await issueWithdrawalReceipt(nonceA);
    await issueWithdrawalReceipt(nonceB);

    const first =
      scenario === 'refill-refill'
        ? coordinatorA.refill(SLOT, 'explicit')
        : coordinatorA.withdraw({ destinationAddress: ADMIN, amountMist: '10', nonceKey: nonceA });
    await vi.waitFor(() => expect(submitCount).toBe(1));
    const second =
      scenario === 'withdrawal-withdrawal'
        ? coordinatorB.withdraw({ destinationAddress: ADMIN, amountMist: '11', nonceKey: nonceB })
        : coordinatorB.refill(SLOT_B, 'explicit');
    await sleep(30);
    expect(submitCount).toBe(1);
    expect(buildCount).toBe(1);

    firstSubmitGate.resolve();
    await expect(first).resolves.toMatchObject({ status: 'succeeded' });
    await expect(second).resolves.toMatchObject({ status: 'succeeded' });
    expect(submitCount).toBe(2);
    expect(maxActiveSubmits).toBe(1);
  });
});
