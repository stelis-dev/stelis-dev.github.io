import { describe, expect, it, vi } from 'vitest';
import type { SuiTransactionResult } from '@stelis/core-relay';
import { NODE_TIMER_MAX_DELAY_MS } from '@stelis/contracts';
import type { SponsorResultMetadata } from '../src/handlers/sponsorResult.js';
import { SponsoredExecutionRecovery } from '../src/store/sponsoredExecutionRecovery.js';
import type { PreparedTxEntry } from '../src/store/prepareTypes.js';
import {
  storeSponsorResult,
  type ExecutingSponsoredExecutionRecord,
  type FinalSponsoredExecutionRecord,
} from '../src/store/sponsoredExecutionRecords.js';
import type {
  BeginSponsoredExecutionInput,
  BeginSponsoredExecutionResult,
  DiscardPreparedReceiptInput,
  DiscardPreparedReceiptResult,
  FinalizeSponsoredExecutionInput,
  FinalizeSponsoredExecutionResult,
  SponsoredExecutionRecoveryCursor,
  SponsoredExecutionRecoveryPage,
  SponsoredExecutionStoreAdapter,
} from '../src/store/sponsoredExecutionStore.js';
import {
  congestedSuiExecutionError,
  suiEndpointSnapshotFixture,
  suiExecutionFailure,
  suiExecutionSuccess,
  suiTransactionDigestFixture,
} from './helpers/suiGatewayResultFixtures.js';

const SPONSOR_ADDRESS = `0x${'11'.repeat(32)}`;
const SENDER_ADDRESS = `0x${'22'.repeat(32)}`;
const PROMOTION_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = 'recovery-user';
const GAS_USED = {
  computationCost: '1000',
  storageCost: '200',
  storageRebate: '50',
  nonRefundableStorageFee: '0',
} as const;

function receiptId(index: number): string {
  return `0x${index.toString(16).padStart(64, '0')}`;
}

function prepared(index: number, mode: 'generic' | 'promotion' = 'generic'): PreparedTxEntry {
  const common = {
    receiptId: receiptId(index),
    senderAddress: SENDER_ADDRESS,
    txBytesHash: index.toString(16).padStart(64, '0'),
    sponsorAddress: SPONSOR_ADDRESS,
    clientIp: '127.0.0.1',
    executionPathKey: `${mode}:recovery`,
    orderId: null,
    issuedAt: 1_000,
  } as const;
  return mode === 'generic'
    ? { mode, ...common, nonce: BigInt(index) }
    : {
        mode,
        ...common,
        promotionId: PROMOTION_ID,
        userId: USER_ID,
        reservedGasMist: 4_000n,
      };
}

function execution(
  index: number,
  mode: 'generic' | 'promotion',
): ExecutingSponsoredExecutionRecord {
  const entry = prepared(index, mode);
  return {
    state: 'executing',
    receiptId: entry.receiptId,
    sponsorAddress: entry.sponsorAddress,
    txBytesHash: entry.txBytesHash,
    transactionDigest: suiTransactionDigestFixture(index),
    deadlineMs: 2_000,
    recovery:
      mode === 'generic'
        ? {
            route: 'generic',
            senderAddress: entry.senderAddress,
            executionPathKey: entry.executionPathKey,
            orderIdHash: null,
            recoveredGasMist: '2000',
            hostFeeMist: '300',
            protocolFeeMist: '40',
          }
        : {
            route: 'promotion',
            senderAddress: entry.senderAddress,
            executionPathKey: entry.executionPathKey,
            promotionId: PROMOTION_ID,
            userId: USER_ID,
            reservedGasMist: '4000',
          },
  };
}

function finalRecord(metadata: SponsorResultMetadata): FinalSponsoredExecutionRecord {
  return {
    state: 'final',
    receiptId: metadata.receiptId,
    sponsorAddress: metadata.sponsorAddress,
    transactionDigest: metadata.digest ?? null,
    finalizedAtMs: 3_000,
    callbackDelivery: 'pending',
    result: storeSponsorResult(metadata),
  };
}

function pendingCallback(index: number): FinalSponsoredExecutionRecord {
  const pending = execution(index, 'generic');
  return finalRecord({
    sponsorAddress: pending.sponsorAddress,
    outcome: 'internal_error',
    executionStage: 'after_sponsor_signature',
    route: 'generic',
    digest: pending.transactionDigest,
    receiptId: pending.receiptId,
    senderAddress: pending.recovery.senderAddress,
    executionPathKey: pending.recovery.executionPathKey,
    orderIdHash: pending.recovery.route === 'generic' ? pending.recovery.orderIdHash : null,
    promotionId: null,
    userId: null,
    economics: { economicsStatus: 'unknown', failureReason: 'test pending callback' },
  });
}

function recoveryPage<T extends { readonly receiptId: string }>(
  records: readonly T[],
  scoreOf: (record: T) => number,
  limit: number,
  cursor: SponsoredExecutionRecoveryCursor | null,
): SponsoredExecutionRecoveryPage<T> {
  const throughMs = cursor?.throughMs ?? 10_000;
  const pageRecords = [...records]
    .filter((record) => {
      const scoreMs = scoreOf(record);
      if (scoreMs > throughMs) return false;
      if (cursor === null) return true;
      return (
        scoreMs > cursor.scoreMs ||
        (scoreMs === cursor.scoreMs && record.receiptId > cursor.receiptId)
      );
    })
    .sort((left, right) => {
      const scoreOrder = scoreOf(left) - scoreOf(right);
      if (scoreOrder !== 0) return scoreOrder;
      return left.receiptId < right.receiptId ? -1 : left.receiptId > right.receiptId ? 1 : 0;
    })
    .slice(0, limit);
  const last = pageRecords.at(-1);
  return {
    records: pageRecords,
    nextCursor:
      pageRecords.length === limit && last
        ? { throughMs, scoreMs: scoreOf(last), receiptId: last.receiptId }
        : null,
  };
}

/**
 * State-bearing recovery fake. It models the CAS effects needed by this task
 * instead of returning unrelated pre-programmed values, so assertions observe
 * whether recovery actually removes or preserves each durable item.
 */
class RecoveryStore implements SponsoredExecutionStoreAdapter {
  readonly expired: PreparedTxEntry[] = [];
  readonly due: ExecutingSponsoredExecutionRecord[] = [];
  readonly final: FinalSponsoredExecutionRecord[] = [];
  readonly expiredReadLimits: number[] = [];
  readonly dueReadLimits: number[] = [];
  readonly callbackReadLimits: number[] = [];
  readonly discardInputs: DiscardPreparedReceiptInput[] = [];
  readonly finalizeInputs: FinalizeSponsoredExecutionInput[] = [];
  readonly delivered: FinalSponsoredExecutionRecord[] = [];
  discardStateChanged = false;
  readonly discardStateChangedReceiptIds = new Set<string>();
  finalizeStateChanged = false;
  markResults: boolean[] = [];

  async commitPreparedReceipt(): Promise<PreparedTxEntry> {
    throw new Error('prepare commit is outside recovery');
  }

  async readPreparedReceipt(): Promise<PreparedTxEntry | null> {
    throw new Error('individual prepared reads are outside recovery');
  }

  async discardPreparedReceipt(
    input: DiscardPreparedReceiptInput,
  ): Promise<DiscardPreparedReceiptResult> {
    this.discardInputs.push(input);
    const index = this.expired.indexOf(input.expected);
    if (
      this.discardStateChanged ||
      this.discardStateChangedReceiptIds.has(input.expected.receiptId) ||
      index < 0
    ) {
      return { status: 'state_changed' };
    }
    this.expired.splice(index, 1);
    const record = finalRecord(input.result);
    this.final.push(record);
    return { status: 'discarded', record };
  }

  async beginSponsoredExecution(
    _input: BeginSponsoredExecutionInput,
  ): Promise<BeginSponsoredExecutionResult> {
    throw new Error('begin is outside recovery');
  }

  async finalizeSponsoredExecution(
    input: FinalizeSponsoredExecutionInput,
  ): Promise<FinalizeSponsoredExecutionResult> {
    this.finalizeInputs.push(input);
    const index = this.due.indexOf(input.expected);
    if (this.finalizeStateChanged || index < 0) return { status: 'state_changed' };
    this.due.splice(index, 1);
    const record = finalRecord(input.result);
    this.final.push(record);
    return { status: 'finalized', record };
  }

  async readExpiredPreparedReceipts(
    limit: number,
    cursor: SponsoredExecutionRecoveryCursor | null,
  ): Promise<SponsoredExecutionRecoveryPage<PreparedTxEntry>> {
    this.expiredReadLimits.push(limit);
    return recoveryPage(this.expired, (entry) => entry.issuedAt, limit, cursor);
  }

  async readDueExecutions(
    limit: number,
    cursor: SponsoredExecutionRecoveryCursor | null,
  ): Promise<SponsoredExecutionRecoveryPage<ExecutingSponsoredExecutionRecord>> {
    this.dueReadLimits.push(limit);
    return recoveryPage(this.due, (record) => record.deadlineMs, limit, cursor);
  }

  async readPendingCallbacks(
    limit: number,
    cursor: SponsoredExecutionRecoveryCursor | null,
  ): Promise<SponsoredExecutionRecoveryPage<FinalSponsoredExecutionRecord>> {
    this.callbackReadLimits.push(limit);
    return recoveryPage(
      this.final.filter((record) => record.callbackDelivery === 'pending'),
      (record) => record.finalizedAtMs,
      limit,
      cursor,
    );
  }

  async markCallbackDelivered(expected: FinalSponsoredExecutionRecord): Promise<boolean> {
    const configured = this.markResults.shift();
    if (configured === false) return false;
    const index = this.final.indexOf(expected);
    if (index < 0 || expected.callbackDelivery !== 'pending') return false;
    this.final.splice(index, 1, { ...expected, callbackDelivery: 'delivered' });
    this.delivered.push(expected);
    return true;
  }

  async checkUserQuota(): Promise<'ok'> {
    return 'ok';
  }
  async reserveNonce(): Promise<bigint> {
    return 1n;
  }
  async releaseNonceReservation(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function recovery(options: {
  store: RecoveryStore;
  lookup?: (digest: string, signal: AbortSignal) => Promise<SuiTransactionResult | null>;
  callback?: (metadata: SponsorResultMetadata, signal?: AbortSignal) => void | Promise<void>;
}): SponsoredExecutionRecovery {
  return new SponsoredExecutionRecovery({
    store: options.store,
    sui: suiEndpointSnapshotFixture(),
    intervalMs: 1_000_000,
    lookup: options.lookup ?? (async () => null),
    onSponsorResult: options.callback ?? (() => undefined),
  });
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe('SponsoredExecutionRecovery', () => {
  it('rejects an interval that Node would truncate instead of scheduling it', () => {
    expect(
      () =>
        new SponsoredExecutionRecovery({
          store: new RecoveryStore(),
          sui: suiEndpointSnapshotFixture(),
          intervalMs: NODE_TIMER_MAX_DELAY_MS + 1,
          lookup: async () => null,
          onSponsorResult: () => undefined,
        }),
    ).toThrow(`recovery intervalMs must not exceed ${NODE_TIMER_MAX_DELAY_MS}`);
  });

  it('starts with an immediate pass and atomically discards an expired prepared receipt', async () => {
    const store = new RecoveryStore();
    const expired = prepared(1, 'promotion');
    store.expired.push(expired);
    const callback = vi.fn();
    const task = recovery({ store, callback });

    await task.start();

    expect(store.expired).toEqual([]);
    expect(store.discardInputs).toHaveLength(1);
    expect(store.discardInputs[0]?.expected).toBe(expired);
    expect(store.discardInputs[0]?.result).toMatchObject({
      outcome: 'validation_failure',
      executionStage: 'before_sponsor_signature',
      route: 'promotion',
      receiptId: expired.receiptId,
      economics: {
        economicsStatus: 'unknown',
        failureReason: 'prepared_receipt_expired',
      },
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(store.delivered).toHaveLength(1);
    await task.dispose();
  });

  it('drains successful full batches in one recovery pass', async () => {
    const drainingStore = new RecoveryStore();
    drainingStore.expired.push(...Array.from({ length: 101 }, (_, index) => prepared(index + 1)));
    const drainingTask = recovery({ store: drainingStore });
    await drainingTask.start();
    expect(drainingStore.expired).toEqual([]);
    expect(drainingStore.expiredReadLimits).toEqual([100, 100]);
    expect(drainingStore.callbackReadLimits.every((limit) => limit === 100)).toBe(true);
    await drainingTask.dispose();
  });

  it('does not let a failing equal-score batch starve the 101st receipt', async () => {
    const staleStore = new RecoveryStore();
    const expired = Array.from({ length: 101 }, (_, index) => prepared(index + 500));
    staleStore.expired.push(...expired);
    for (const entry of expired.slice(0, 100)) {
      staleStore.discardStateChangedReceiptIds.add(entry.receiptId);
    }
    const staleTask = recovery({ store: staleStore });
    await staleTask.start();

    expect(staleStore.expired).toHaveLength(100);
    expect(staleStore.expired.map((entry) => entry.receiptId)).toEqual(
      expired.slice(0, 100).map((entry) => entry.receiptId),
    );
    expect(staleStore.expired).not.toContain(expired[100]);
    expect(staleStore.expiredReadLimits).toEqual([100, 100]);
    expect(staleStore.discardInputs.map(({ expected }) => expected.receiptId)).toEqual(
      expired.map((entry) => entry.receiptId),
    );
    await staleTask.dispose();
  });

  it('does not let 100 permanent equal-score lookup failures starve execution 101', async () => {
    const store = new RecoveryStore();
    const executions = Array.from({ length: 101 }, (_, index) => execution(index + 50, 'generic'));
    store.due.push(...executions);
    const failingDigests = new Set(
      executions.slice(0, 100).map((record) => record.transactionDigest),
    );
    const lookup = vi.fn(async (digest: string) => {
      if (failingDigests.has(digest)) throw new Error('permanent lookup failure');
      return suiExecutionSuccess(digest, GAS_USED);
    });
    const task = recovery({ store, lookup });

    await task.start();

    expect(store.due.map((record) => record.receiptId)).toEqual(
      executions.slice(0, 100).map((record) => record.receiptId),
    );
    expect(store.finalizeInputs.map(({ expected }) => expected.receiptId)).toEqual([
      executions[100]?.receiptId,
    ]);
    expect(store.dueReadLimits).toEqual([100, 100]);
    expect(lookup).toHaveBeenCalledTimes(101);
    await task.dispose();
  });

  it('does not let 100 permanent equal-score callback failures starve callback 101', async () => {
    const store = new RecoveryStore();
    const callbacks = Array.from({ length: 101 }, (_, index) => pendingCallback(index + 151));
    store.final.push(...callbacks);
    const failingReceipts = new Set(callbacks.slice(0, 100).map((record) => record.receiptId));
    const callback = vi.fn(async (metadata: SponsorResultMetadata) => {
      if (failingReceipts.has(metadata.receiptId)) throw new Error('permanent callback failure');
    });
    const task = recovery({ store, callback });

    await task.start();

    expect(store.delivered.map((record) => record.receiptId)).toEqual([callbacks[100]?.receiptId]);
    expect(
      store.final
        .filter((record) => record.callbackDelivery === 'pending')
        .map((record) => record.receiptId),
    ).toEqual(callbacks.slice(0, 100).map((record) => record.receiptId));
    expect(store.callbackReadLimits).toEqual([100, 100]);
    expect(callback).toHaveBeenCalledTimes(101);
    await task.dispose();
  });

  it('retries unresolved executions on the next pass without retrying inside one pass', async () => {
    const retryStore = new RecoveryStore();
    retryStore.due.push(
      ...Array.from({ length: 100 }, (_, index) => execution(index + 100, 'generic')),
    );
    let lookupAttempts = 0;
    const retryTask = recovery({
      store: retryStore,
      lookup: async (digest) => {
        lookupAttempts += 1;
        if (lookupAttempts <= 100) throw new Error('temporary RPC failure');
        return suiExecutionSuccess(digest, GAS_USED);
      },
    });
    await retryTask.start();
    expect(retryStore.due).toHaveLength(100);
    expect(retryStore.dueReadLimits).toEqual([100, 100]);
    expect(lookupAttempts).toBe(100);

    await retryTask.requestRun();
    expect(retryStore.due).toEqual([]);
    expect(retryStore.dueReadLimits).toEqual([100, 100, 100, 100]);
    expect(lookupAttempts).toBe(200);
    await retryTask.dispose();
  });

  it('coalesces overlapping requests without running two store reads concurrently', async () => {
    const store = new RecoveryStore();
    let releaseFirstRead!: () => void;
    const firstReadBlocked = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let reads = 0;
    let activeReads = 0;
    let maxActiveReads = 0;
    store.readExpiredPreparedReceipts = async (limit) => {
      store.expiredReadLimits.push(limit);
      reads += 1;
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      if (reads === 1) await firstReadBlocked;
      activeReads -= 1;
      return { records: [], nextCursor: null };
    };
    const task = recovery({ store });

    const first = task.requestRun();
    const overlapping = task.requestRun();
    expect(overlapping).toBe(first);
    releaseFirstRead();
    await first;
    await eventually(() => expect(reads).toBe(2));
    expect(maxActiveReads).toBe(1);
    await task.dispose();
  });

  it('derives the same exact generic success and revert economics as foreground execution', async () => {
    const store = new RecoveryStore();
    const successExecution = execution(1, 'generic');
    const revertExecution = execution(2, 'generic');
    store.due.push(successExecution, revertExecution);
    const success = suiExecutionSuccess(successExecution.transactionDigest, GAS_USED);
    const revert = suiExecutionFailure(
      revertExecution.transactionDigest,
      { kind: 'InvariantViolation' },
      GAS_USED,
    );
    const lookup = vi.fn(async (digest: string) =>
      digest === successExecution.transactionDigest ? success : revert,
    );
    const task = recovery({ store, lookup });

    await task.start();

    const successFinal = store.finalizeInputs.find(({ expected }) => expected === successExecution);
    expect(successFinal).toMatchObject({
      promotion: { operation: 'none' },
      result: {
        outcome: 'success',
        executionStage: 'on_chain',
        economics: {
          economicsStatus: 'known',
          recoveredGasMist: '2000',
          hostPaidGasMist: '1150',
          hostFeeMist: '300',
          hostNetMist: '1150',
          grossGasMist: '1200',
          storageRebateMist: '50',
          protocolFeeMist: '40',
          failureReason: null,
        },
      },
    });
    const revertFinal = store.finalizeInputs.find(({ expected }) => expected === revertExecution);
    expect(revertFinal).toMatchObject({
      promotion: { operation: 'none' },
      result: {
        outcome: 'onchain_revert',
        executionStage: 'on_chain',
        economics: {
          economicsStatus: 'known',
          recoveredGasMist: '0',
          hostPaidGasMist: '1150',
          hostFeeMist: '0',
          hostNetMist: '-1150',
          grossGasMist: '1200',
          storageRebateMist: '50',
          protocolFeeMist: null,
          failureReason: 'onchain_revert: Sui execution failed (InvariantViolation)',
        },
      },
    });
    await task.dispose();
  });

  it('finalizes Promotion success, revert, congestion, and not-found uncertainty with distinct capacity rules', async () => {
    const store = new RecoveryStore();
    const successExecution = execution(11, 'promotion');
    const revertExecution = execution(12, 'promotion');
    const congestionExecution = execution(13, 'promotion');
    const unresolvedExecution = execution(14, 'promotion');
    store.due.push(successExecution, revertExecution, congestionExecution, unresolvedExecution);
    const lookup = vi.fn(async (digest: string): Promise<SuiTransactionResult | null> => {
      if (digest === successExecution.transactionDigest) {
        return suiExecutionSuccess(digest, GAS_USED);
      }
      if (digest === revertExecution.transactionDigest) {
        return suiExecutionFailure(digest, { kind: 'InvariantViolation' }, GAS_USED);
      }
      if (digest === congestionExecution.transactionDigest) {
        return suiExecutionFailure(digest, congestedSuiExecutionError(), GAS_USED);
      }
      return null;
    });
    const task = recovery({ store, lookup });

    await task.start();

    const byExecution = (expected: ExecutingSponsoredExecutionRecord) =>
      store.finalizeInputs.find((input) => input.expected === expected);
    expect(byExecution(successExecution)).toMatchObject({
      promotion: { operation: 'consume', chargedMist: 1150n },
      result: {
        outcome: 'success',
        economics: {
          economicsStatus: 'known',
          recoveredGasMist: '0',
          hostPaidGasMist: '1150',
          hostFeeMist: '0',
          hostNetMist: '-1150',
          failureReason: null,
        },
      },
    });
    expect(byExecution(revertExecution)).toMatchObject({
      promotion: { operation: 'consume', chargedMist: 1150n },
      result: {
        outcome: 'onchain_revert',
        economics: {
          economicsStatus: 'known',
          recoveredGasMist: '0',
          hostPaidGasMist: '1150',
          hostFeeMist: '0',
          hostNetMist: '-1150',
        },
      },
    });
    expect(byExecution(congestionExecution)).toMatchObject({
      promotion: { operation: 'release' },
      result: {
        outcome: 'congestion',
        executionStage: 'after_sponsor_signature',
        economics: { economicsStatus: 'unknown', failureReason: 'congestion' },
      },
    });
    expect(byExecution(unresolvedExecution)).toMatchObject({
      promotion: { operation: 'consume', chargedMist: 4000n },
      result: {
        outcome: 'internal_error',
        executionStage: 'after_sponsor_signature',
        economics: {
          economicsStatus: 'unknown',
          failureReason: 'transaction_result_unresolved',
        },
      },
    });
    await task.dispose();
  });

  it('retains transient lookup failures and retries callbacks until delivery CAS succeeds', async () => {
    const store = new RecoveryStore();
    const pendingExecution = execution(20, 'generic');
    store.due.push(pendingExecution);
    let lookupAttempts = 0;
    const lookup = vi.fn(async () => {
      lookupAttempts += 1;
      if (lookupAttempts === 1) throw new Error('temporary transport failure');
      return suiExecutionSuccess(pendingExecution.transactionDigest, GAS_USED);
    });
    let callbackAttempts = 0;
    const callback = vi.fn(async () => {
      callbackAttempts += 1;
      if (callbackAttempts === 1) throw new Error('temporary callback failure');
    });
    store.markResults.push(false);
    const task = recovery({ store, lookup, callback });

    await task.start();
    expect(store.due).toEqual([pendingExecution]);
    expect(store.finalizeInputs).toEqual([]);

    await task.requestRun();
    expect(store.due).toEqual([]);
    expect(callback).toHaveBeenCalledOnce();
    expect(store.final[0]?.callbackDelivery).toBe('pending');

    await task.requestRun();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(store.final[0]?.callbackDelivery).toBe('pending');

    await task.requestRun();
    expect(callback).toHaveBeenCalledTimes(3);
    expect(store.final[0]?.callbackDelivery).toBe('delivered');
    await task.dispose();
  });

  it('shares disposal and waits for delayed lookup cleanup without finalizing', async () => {
    const store = new RecoveryStore();
    store.due.push(execution(30, 'generic'));
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    let lookupAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      lookupAborted = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let lookupSettled = false;
    const lookup = vi.fn(
      (_digest: string, signal: AbortSignal) =>
        new Promise<SuiTransactionResult | null>((_resolve, reject) => {
          lookupStarted();
          signal.addEventListener(
            'abort',
            () => {
              lookupAborted();
              void cleanup.then(() => {
                lookupSettled = true;
                reject(signal.reason);
              });
            },
            { once: true },
          );
        }),
    );
    const task = recovery({ store, lookup });

    const start = task.start();
    await started;
    const firstDisposal = task.dispose();
    const secondDisposal = task.dispose();
    expect(secondDisposal).toBe(firstDisposal);
    let disposalSettled = false;
    void firstDisposal.then(() => {
      disposalSettled = true;
    });
    await aborted;
    await Promise.resolve();
    expect(disposalSettled).toBe(false);
    expect(lookupSettled).toBe(false);

    releaseCleanup();
    await Promise.all([firstDisposal, secondDisposal]);
    await expect(start).rejects.toBeDefined();
    expect(lookupSettled).toBe(true);
    expect(store.finalizeInputs).toEqual([]);
    await expect(task.requestRun()).resolves.toBeUndefined();
  });

  it('passes recovery cancellation into an active result callback and awaits its exit', async () => {
    const store = new RecoveryStore();
    const pending = execution(31, 'generic');
    store.final.push(
      finalRecord({
        sponsorAddress: pending.sponsorAddress,
        outcome: 'internal_error',
        executionStage: 'after_sponsor_signature',
        route: 'generic',
        digest: pending.transactionDigest,
        receiptId: pending.receiptId,
        senderAddress: pending.recovery.senderAddress,
        executionPathKey: pending.recovery.executionPathKey,
        orderIdHash: pending.recovery.route === 'generic' ? pending.recovery.orderIdHash : null,
        promotionId: null,
        userId: null,
        economics: { economicsStatus: 'unknown', failureReason: 'test pending callback' },
      }),
    );
    let callbackStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      callbackStarted = resolve;
    });
    let callbackSettled = false;
    const callback = vi.fn(
      (_metadata: SponsorResultMetadata, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          if (signal === undefined) {
            reject(new Error('Recovery callback requires its task signal'));
            return;
          }
          callbackStarted();
          signal.addEventListener(
            'abort',
            () => {
              callbackSettled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const task = recovery({ store, callback });

    const start = task.start();
    await started;
    await task.dispose();
    await expect(start).rejects.toMatchObject({ name: 'AbortError' });
    expect(callbackSettled).toBe(true);
    expect(store.final[0]?.callbackDelivery).toBe('pending');
  });
});
