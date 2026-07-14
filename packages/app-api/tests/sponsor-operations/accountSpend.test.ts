import { describe, expect, it, vi } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type {
  SponsorRefillAccountDispatchLock,
  SponsorRefillAccountDispatchLockHandle,
} from '../../src/sponsor-operations/refillLock.js';
import type {
  ReadySponsorRefillAccountSpend,
  SponsorRefillAccountSpend,
  SponsorRefillAccountSpendStateStore,
  SponsorRefillAccountWithdrawalReceipt,
} from '../../src/sponsor-operations/accountSpendState.js';
import type {
  RedisSponsorOperationsState,
  SlotRead,
} from '../../src/sponsor-operations/redisState.js';
import {
  createSponsorRefillAccountSpendCoordinator,
  createSuiSponsorRefillAccountSpendBoundary,
  type SponsorRefillAccountSpendBoundary,
} from '../../src/sponsor-operations/accountSpend.js';

const SOURCE = `0x${'11'.repeat(32)}`;
const ADMIN = `0x${'22'.repeat(32)}`;
const SLOT = `0x${'33'.repeat(32)}`;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function u64Bytes(value: bigint): string {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return toBase64(bytes);
}

function addressBytes(address: string): string {
  const hex = address.startsWith('0x') ? address.slice(2) : address;
  return toBase64(Uint8Array.from(hex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16))));
}

function createMemoryLock(): SponsorRefillAccountDispatchLock {
  let held = false;
  return {
    async acquire(address) {
      if (held) return null;
      held = true;
      return { token: 'memory-lock', sponsorRefillAccountAddress: address };
    },
    async release(_handle: SponsorRefillAccountDispatchLockHandle) {
      held = false;
    },
  };
}

function createMemorySpendState(nonces: Set<string>) {
  let current: SponsorRefillAccountSpend | null = null;
  let spendSequence = 0;
  let writeSequence = 0;
  const snapshots: SponsorRefillAccountSpend[] = [];
  const receipts = new Map<string, SponsorRefillAccountWithdrawalReceipt>(
    [...nonces].map((nonceKey) => [nonceKey, { type: 'issued', network: 'testnet' }]),
  );

  function save<T extends SponsorRefillAccountSpend>(next: T): T {
    current = next;
    writeSequence += 1;
    snapshots.push(structuredClone(next));
    return next;
  }

  const state: SponsorRefillAccountSpendStateStore = {
    async read() {
      return current;
    },
    async readWithdrawalReceipt(nonceKey) {
      return receipts.get(nonceKey) ?? null;
    },
    async readAccountObservationCursor() {
      return {
        operationId: current?.operationId ?? null,
        spendSequence,
        writeSequence,
      };
    },
    async reserve(input) {
      const receipt = input.nonceKey === null ? null : receipts.get(input.nonceKey);
      if (input.nonceKey !== null && receipt === undefined) {
        return { status: 'nonce_missing' };
      }
      if (receipt !== null && receipt !== undefined && receipt.type !== 'issued') {
        return { status: 'receipt', receipt };
      }
      if (
        current?.state === 'reserved' ||
        current?.state === 'ready' ||
        current?.state === 'reconciling'
      ) {
        return { status: 'active', spend: current };
      }
      spendSequence += 1;
      const common = {
        network: 'testnet',
        operationId: input.operationId,
        sourceAddress: input.sourceAddress,
        destinationAddress: input.destinationAddress,
        amountMist: input.amountMist,
        sequence: spendSequence,
        state: 'reserved',
      } as const;
      const spend = save(
        input.kind === 'refill'
          ? { ...common, kind: 'refill', slotAddress: input.slotAddress!, nonceKey: null }
          : { ...common, kind: 'withdrawal', slotAddress: null, nonceKey: input.nonceKey! },
      );
      if (input.nonceKey !== null) {
        receipts.set(input.nonceKey, {
          type: 'accepted',
          network: 'testnet',
          operationId: input.operationId,
          sourceAddress: input.sourceAddress,
          destinationAddress: input.destinationAddress,
          amountMist: input.amountMist,
        });
      }
      return {
        status: 'created',
        spend,
      };
    },
    async markReady(input) {
      if (
        current?.operationId !== input.operationId ||
        current.sequence !== input.expectedSequence ||
        current.state !== 'reserved'
      ) {
        return null;
      }
      spendSequence += 1;
      return save({
        ...current,
        gasBudgetMist: input.gasBudgetMist,
        transactionBytesBase64: input.transactionBytesBase64,
        signature: input.signature,
        digest: input.digest,
        sequence: spendSequence,
        state: 'ready',
      });
    },
    async markReconciling(input) {
      if (
        current?.operationId !== input.operationId ||
        current.sequence !== input.expectedSequence ||
        current.state !== 'ready'
      ) {
        return null;
      }
      spendSequence += 1;
      const reconciling = {
        ...current,
        sequence: spendSequence,
        state: 'reconciling',
      } as const;
      return save(
        input.chainResult === 'succeeded'
          ? { ...reconciling, chainResult: 'succeeded' }
          : { ...reconciling, chainResult: 'failed', error: input.lastError },
      );
    },
    async complete(input) {
      if (
        current?.operationId !== input.operationId ||
        current.sequence !== input.expectedSequence ||
        current.state !== 'reconciling'
      ) {
        return null;
      }
      spendSequence += 1;
      const common = {
        network: current.network,
        operationId: current.operationId,
        sourceAddress: current.sourceAddress,
        destinationAddress: current.destinationAddress,
        amountMist: current.amountMist,
        sequence: spendSequence,
        ...(current.kind === 'refill'
          ? { kind: 'refill' as const, slotAddress: current.slotAddress, nonceKey: null }
          : { kind: 'withdrawal' as const, slotAddress: null, nonceKey: current.nonceKey }),
      } as const;
      const completed = save(
        input.state === 'succeeded'
          ? { ...common, state: 'succeeded', digest: current.digest }
          : {
              ...common,
              state: 'failed',
              digest: current.digest,
              failureKind: 'failed',
              error: input.lastError,
            },
      );
      if (completed.nonceKey !== null) {
        receipts.set(completed.nonceKey, {
          type: 'terminal',
          network: 'testnet',
          result:
            completed.state === 'succeeded'
              ? {
                  status: 'succeeded',
                  operationId: completed.operationId,
                  sourceAddress: completed.sourceAddress,
                  destinationAddress: completed.destinationAddress,
                  amountMist: completed.amountMist,
                  digest: completed.digest,
                }
              : {
                  status: completed.failureKind,
                  operationId: completed.operationId,
                  sourceAddress: completed.sourceAddress,
                  destinationAddress: completed.destinationAddress,
                  amountMist: completed.amountMist,
                  digest: completed.digest,
                  error: completed.error,
                },
        });
      }
      return completed;
    },
    async failReserved(input) {
      if (
        current?.operationId !== input.operationId ||
        current.sequence !== input.expectedSequence ||
        current.state !== 'reserved'
      ) {
        return null;
      }
      spendSequence += 1;
      const failed = save({
        network: current.network,
        operationId: current.operationId,
        sourceAddress: current.sourceAddress,
        destinationAddress: current.destinationAddress,
        amountMist: current.amountMist,
        ...(current.kind === 'refill'
          ? { kind: 'refill' as const, slotAddress: current.slotAddress, nonceKey: null }
          : { kind: 'withdrawal' as const, slotAddress: null, nonceKey: current.nonceKey }),
        sequence: spendSequence,
        state: 'failed',
        digest: null,
        failureKind: input.failureKind,
        error: input.lastError,
      });
      if (failed.nonceKey !== null) {
        receipts.set(failed.nonceKey, {
          type: 'terminal',
          network: 'testnet',
          result: {
            status: input.failureKind,
            operationId: failed.operationId,
            sourceAddress: failed.sourceAddress,
            destinationAddress: failed.destinationAddress,
            amountMist: failed.amountMist,
            digest: null,
            error: input.lastError,
          },
        });
      }
      return failed;
    },
    async updateAccountObservation(cursor) {
      if (
        cursor.operationId !== (current?.operationId ?? null) ||
        cursor.spendSequence !== spendSequence ||
        cursor.writeSequence !== writeSequence
      ) {
        return false;
      }
      writeSequence += 1;
      return true;
    },
  };

  return { state, snapshots, current: () => current };
}

function requireReadySpend(
  spend: SponsorRefillAccountSpend | null,
): ReadySponsorRefillAccountSpend {
  if (spend?.state !== 'ready') {
    throw new Error(`expected ready spend, received ${spend?.state ?? 'null'}`);
  }
  return spend;
}

function createOperationsState(
  slotBalanceMist = '0',
  automatic?: {
    readonly slotState?: SlotRead['state'];
    readonly requiredSourceBalanceMist?: string | null;
    readonly sourceBalanceMist?: string | null;
    readonly sourceHealthy?: boolean | null;
  },
): RedisSponsorOperationsState {
  let writeSeq = 1;
  let slot: SlotRead = {
    address: SLOT,
    state: automatic?.slotState ?? 'low_balance',
    balanceMist: slotBalanceMist,
    lastError: null,
    lastObservedAtMs: 1,
    writeSeq,
    pendingRefillDigest: null,
    refillAttemptedAmountMist: null,
    refillObservedBalanceMist: null,
    refillReconciliationResult: null,
    refillOperationId: null,
    refillOperationSequence: null,
    refillOperationState: null,
    refillRequiredSourceBalanceMist: automatic?.requiredSourceBalanceMist ?? null,
  };
  return {
    async updateSlotIfWriteSeq(address, expected, fields) {
      if (address !== SLOT || expected !== writeSeq) return false;
      writeSeq += 1;
      slot = {
        ...slot,
        ...fields,
        lastError: fields.lastError === '' ? null : (fields.lastError ?? slot.lastError),
        pendingRefillDigest:
          fields.pendingRefillDigest === ''
            ? null
            : (fields.pendingRefillDigest ?? slot.pendingRefillDigest),
        refillAttemptedAmountMist:
          fields.refillAttemptedAmountMist === ''
            ? null
            : (fields.refillAttemptedAmountMist ?? slot.refillAttemptedAmountMist),
        refillObservedBalanceMist:
          fields.refillObservedBalanceMist === ''
            ? null
            : (fields.refillObservedBalanceMist ?? slot.refillObservedBalanceMist),
        refillReconciliationResult:
          fields.refillReconciliationResult === ''
            ? null
            : (fields.refillReconciliationResult ?? slot.refillReconciliationResult),
        refillOperationId:
          fields.refillOperationId === ''
            ? null
            : (fields.refillOperationId ?? slot.refillOperationId),
        refillOperationSequence:
          fields.refillOperationSequence === ''
            ? null
            : fields.refillOperationSequence === undefined
              ? slot.refillOperationSequence
              : Number(fields.refillOperationSequence),
        refillOperationState:
          fields.refillOperationState === ''
            ? null
            : (fields.refillOperationState ?? slot.refillOperationState),
        refillRequiredSourceBalanceMist:
          fields.refillRequiredSourceBalanceMist === ''
            ? null
            : (fields.refillRequiredSourceBalanceMist ?? slot.refillRequiredSourceBalanceMist),
        writeSeq,
      } as SlotRead;
      return true;
    },
    async readSlot(address) {
      return address === SLOT ? slot : null;
    },
    async readSponsorRefillAccount() {
      return {
        balanceMist: automatic?.sourceBalanceMist ?? null,
        healthy: automatic?.sourceHealthy ?? null,
        refillsRemaining: null,
        lastError: null,
        lastObservedAtMs: 1,
        writeSeq: 1,
      };
    },
    async readAll() {
      return {
        slots: [slot],
        sponsorRefillAccount: {
          balanceMist: automatic?.sourceBalanceMist ?? null,
          healthy: automatic?.sourceHealthy ?? null,
          refillsRemaining: null,
          lastError: null,
          lastObservedAtMs: null,
          writeSeq: null,
        },
      };
    },
  };
}

interface SubmittedIdentity {
  readonly bytes: Uint8Array;
  readonly signature: string;
  readonly digest: string;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function createBoundary(options?: {
  sourceBalance?: bigint;
  slotBalance?: bigint;
  gasBudget?: bigint;
  lookup?: 'not_found' | 'found' | 'unknown';
  submit?: 'success' | 'lost_response_found';
  buildGate?: Promise<void>;
  simulateGate?: Promise<void>;
  submitGate?: Promise<void>;
  onSubmit?: (bytes: Uint8Array, signature: string, digest: string) => Promise<void> | void;
  getBalance?: (address: string) => Promise<bigint> | bigint;
}) {
  let buildCount = 0;
  let lookupCount = 0;
  let validateCount = 0;
  let lookupMode = options?.lookup ?? 'not_found';
  const sourceBalance = options?.sourceBalance ?? 10_000n;
  const slotBalance = options?.slotBalance ?? 0n;
  const visibleDigests = new Set<string>();
  const builtByDigest = new Map<
    string,
    {
      readonly sourceAddress: string;
      readonly destinationAddress: string;
      readonly amountMist: bigint;
      readonly gasBudgetMist: bigint;
      readonly transactionBytes: Uint8Array;
      readonly signature: string;
    }
  >();
  const submissions: SubmittedIdentity[] = [];
  const lookupDigests: string[] = [];

  function assertIdentity(input: {
    readonly sourceAddress: string;
    readonly destinationAddress: string;
    readonly amountMist: bigint;
    readonly gasBudgetMist: bigint;
    readonly transactionBytes: Uint8Array;
    readonly signature: string;
    readonly digest: string;
  }): void {
    const derivedDigest = TransactionDataBuilder.getDigestFromBytes(input.transactionBytes);
    if (derivedDigest !== input.digest)
      throw new Error('mock boundary received a bytes/digest mismatch');
    const built = builtByDigest.get(input.digest);
    if (
      built === undefined ||
      built.sourceAddress !== input.sourceAddress ||
      built.destinationAddress !== input.destinationAddress ||
      built.amountMist !== input.amountMist ||
      built.gasBudgetMist !== input.gasBudgetMist ||
      built.signature !== input.signature ||
      !sameBytes(built.transactionBytes, input.transactionBytes)
    ) {
      throw new Error(
        'mock boundary received a signed identity different from the built transaction',
      );
    }
  }

  const boundary: SponsorRefillAccountSpendBoundary = {
    async buildAndSign(destinationAddress, amountMist) {
      buildCount += 1;
      await options?.buildGate;
      const gasBudgetMist = options?.gasBudget ?? 37n;
      const amountBytes = new Uint8Array(8);
      new DataView(amountBytes.buffer).setBigUint64(0, amountMist, true);
      const transactionBytes = new Uint8Array([
        buildCount,
        Number.parseInt(destinationAddress.slice(-2), 16),
        ...amountBytes,
      ]);
      const digest = TransactionDataBuilder.getDigestFromBytes(transactionBytes);
      const signature = `signature:${digest}`;
      builtByDigest.set(digest, {
        sourceAddress: SOURCE,
        destinationAddress,
        amountMist,
        gasBudgetMist,
        transactionBytes,
        signature,
      });
      return {
        transactionBytes,
        signature,
        digest,
        gasBudgetMist,
      };
    },
    async validateSignedIdentity(input) {
      validateCount += 1;
      assertIdentity(input);
    },
    async simulate() {
      await options?.simulateGate;
      return { success: true, error: null };
    },
    async lookup(digest) {
      lookupCount += 1;
      lookupDigests.push(digest);
      if (lookupMode === 'unknown') throw new Error('rpc unavailable');
      return lookupMode === 'found' || visibleDigests.has(digest)
        ? { status: 'found', result: { digest, success: true, error: null } }
        : { status: 'not_found' };
    },
    async submit(bytes, signature, digest) {
      const built = builtByDigest.get(digest);
      if (built === undefined) throw new Error('mock boundary received an unknown digest');
      assertIdentity({
        sourceAddress: built.sourceAddress,
        destinationAddress: built.destinationAddress,
        amountMist: built.amountMist,
        gasBudgetMist: built.gasBudgetMist,
        transactionBytes: bytes,
        signature,
        digest,
      });
      submissions.push({ bytes: Uint8Array.from(bytes), signature, digest });
      await options?.onSubmit?.(bytes, signature, digest);
      if (options?.submit === 'lost_response_found') {
        visibleDigests.add(digest);
        throw new Error('submit response lost');
      }
      await options?.submitGate;
      visibleDigests.add(digest);
      return { digest, success: true, error: null };
    },
    async getBalance(address) {
      if (options?.getBalance) return options.getBalance(address);
      return address === SOURCE ? sourceBalance : slotBalance;
    },
  };
  return {
    boundary,
    buildCount: () => buildCount,
    lookupCount: () => lookupCount,
    lookupDigests: () => lookupDigests,
    validateCount: () => validateCount,
    submissions: () => submissions,
    submitCount: () => submissions.length,
    setLookup: (next: 'not_found' | 'found' | 'unknown') => {
      lookupMode = next;
    },
  };
}

function coordinator(input: {
  state: SponsorRefillAccountSpendStateStore;
  boundary: SponsorRefillAccountSpendBoundary;
  operationsState?: RedisSponsorOperationsState;
  sourceBalance?: bigint;
  target?: bigint;
  count?: number;
  dispatchTimeoutMs?: number;
  dispatchLock?: SponsorRefillAccountDispatchLock;
}) {
  return createSponsorRefillAccountSpendCoordinator({
    state: input.state,
    operationsState: input.operationsState ?? createOperationsState(),
    dispatchLock: input.dispatchLock ?? createMemoryLock(),
    boundary: input.boundary,
    network: 'testnet',
    sourceAddress: SOURCE,
    sponsorSlotCount: input.count ?? 2,
    refillEnabled: true,
    refillTargetMist: input.target ?? 100n,
    runwayTargetMist: input.target ?? 100n,
    warnThresholdMist: 50n,
    dispatchTimeoutMs: input.dispatchTimeoutMs ?? 20,
    balanceTimeoutMs: 20,
    confirmationTimeoutMs: 20,
  });
}

describe('Sponsor Refill Account spend coordinator', () => {
  it('rejects an automatic refill inside the account lock when current source evidence is below the runway threshold', async () => {
    const memory = createMemorySpendState(new Set());
    const chain = createBoundary();
    const operationsState = createOperationsState('0', {
      slotState: 'refill_failed',
      requiredSourceBalanceMist: '240',
      sourceBalanceMist: '210',
      sourceHealthy: true,
    });

    const result = await coordinator({
      state: memory.state,
      operationsState,
      boundary: chain.boundary,
    }).refill(SLOT, 'source_observed');

    expect(result).toEqual({ status: 'not_eligible', slotAddress: SLOT });
    expect(chain.buildCount()).toBe(0);
    expect(memory.current()).toBeNull();
  });

  it('does not let a slot observation borrow source-balance authority recorded elsewhere', async () => {
    const memory = createMemorySpendState(new Set());
    const chain = createBoundary();
    const operationsState = createOperationsState('0', {
      slotState: 'refill_failed',
      requiredSourceBalanceMist: '240',
      sourceBalanceMist: '250',
      sourceHealthy: true,
    });

    const result = await coordinator({
      state: memory.state,
      operationsState,
      boundary: chain.boundary,
    }).refill(SLOT, 'slot_observed');

    expect(result).toEqual({ status: 'not_eligible', slotAddress: SLOT });
    expect(chain.buildCount()).toBe(0);
    expect(memory.current()).toBeNull();
  });

  it('rechecks automatic refill evidence after acquiring the account lock', async () => {
    const memory = createMemorySpendState(new Set());
    const chain = createBoundary();
    const baseOperationsState = createOperationsState('0', {
      slotState: 'refill_failed',
      requiredSourceBalanceMist: '240',
      sourceBalanceMist: '250',
      sourceHealthy: true,
    });
    let currentSourceBalanceMist = '250';
    const operationsState: RedisSponsorOperationsState = {
      ...baseOperationsState,
      async readAll() {
        const snapshot = await baseOperationsState.readAll();
        return {
          ...snapshot,
          sponsorRefillAccount: {
            ...snapshot.sponsorRefillAccount,
            balanceMist: currentSourceBalanceMist,
          },
        };
      },
    };
    const lockEntered = deferred<void>();
    const releaseAcquire = deferred<void>();
    const dispatchLock: SponsorRefillAccountDispatchLock = {
      async acquire(address) {
        lockEntered.resolve(undefined);
        await releaseAcquire.promise;
        return { token: 'delayed-lock', sponsorRefillAccountAddress: address };
      },
      async release() {},
    };
    const spend = coordinator({
      state: memory.state,
      operationsState,
      dispatchLock,
      boundary: chain.boundary,
    });

    const resultPromise = spend.refill(SLOT, 'source_observed');
    await lockEntered.promise;
    currentSourceBalanceMist = '210';
    releaseAcquire.resolve(undefined);
    const result = await resultPromise;

    expect(result).toEqual({ status: 'not_eligible', slotAddress: SLOT });
    expect(chain.buildCount()).toBe(0);
    expect(memory.current()).toBeNull();
  });

  it('persists exact ready identity before submitting it', async () => {
    const nonce = 'nonce:ready-before-submit';
    const memory = createMemorySpendState(new Set([nonce]));
    const chain = createBoundary({
      onSubmit(bytes, signature, digest) {
        const ready = requireReadySpend(memory.current());
        expect(ready.transactionBytesBase64).toBe(Buffer.from(bytes).toString('base64'));
        expect(ready.signature).toBe(signature);
        expect(ready.digest).toBe(digest);
        expect(ready.gasBudgetMist).toBe('37');
      },
    });

    const result = await coordinator({ state: memory.state, boundary: chain.boundary }).withdraw({
      destinationAddress: ADMIN,
      amountMist: '100',
      nonceKey: nonce,
    });

    expect(result.status).toBe('succeeded');
    expect(chain.submitCount()).toBe(1);
    expect(chain.validateCount()).toBe(1);
    expect(memory.snapshots.map((snapshot) => snapshot.state)).toEqual([
      'reserved',
      'ready',
      'reconciling',
      'succeeded',
    ]);
  });

  it('uses the verified successful digest as authority when the current slot is already low again', async () => {
    const memory = createMemorySpendState(new Set());
    const chain = createBoundary({ slotBalance: 0n });
    const baseOperationsState = createOperationsState();
    const operationsState: RedisSponsorOperationsState = {
      ...baseOperationsState,
      async readSlot(address) {
        const slot = await baseOperationsState.readSlot(address);
        const current = memory.current();
        if (slot === null || current?.kind !== 'refill') return slot;
        return {
          ...slot,
          refillOperationId: current.operationId,
          refillOperationSequence: current.sequence,
          refillOperationState: current.state,
        };
      },
    };
    const spend = coordinator({
      state: memory.state,
      operationsState,
      boundary: chain.boundary,
      target: 100n,
    });

    const result = await spend.refill(SLOT, 'explicit');

    expect(result).toMatchObject({ status: 'succeeded', amountMist: '100' });
    expect(memory.current()).toMatchObject({ state: 'succeeded', amountMist: '100' });
    expect(chain.buildCount()).toBe(1);
    expect(chain.submitCount()).toBe(1);
    expect(memory.snapshots.map((snapshot) => snapshot.state)).toEqual([
      'reserved',
      'ready',
      'reconciling',
      'succeeded',
    ]);
  });

  it('keeps ready identity on lookup uncertainty and recovery submits the same bytes without rebuilding', async () => {
    const nonce = 'nonce:lookup-unknown';
    const memory = createMemorySpendState(new Set([nonce]));
    const chain = createBoundary({ lookup: 'unknown' });
    const first = coordinator({ state: memory.state, boundary: chain.boundary });

    const pending = await first.withdraw({
      destinationAddress: ADMIN,
      amountMist: '100',
      nonceKey: nonce,
    });
    expect(pending.status).toBe('pending');
    expect(chain.submitCount()).toBe(0);
    expect(chain.buildCount()).toBe(1);
    const ready = structuredClone(requireReadySpend(memory.current()));

    chain.setLookup('not_found');
    const recovered = await coordinator({
      state: memory.state,
      boundary: chain.boundary,
    }).withdraw({ destinationAddress: ADMIN, amountMist: '100', nonceKey: nonce });
    expect(recovered?.status).toBe('succeeded');
    expect(chain.submitCount()).toBe(1);
    expect(chain.buildCount()).toBe(1);
    expect(chain.validateCount()).toBe(2);
    const [submission] = chain.submissions();
    expect(toBase64(submission!.bytes)).toBe(ready.transactionBytesBase64);
    expect(submission?.signature).toBe(ready.signature);
    expect(submission?.digest).toBe(ready.digest);
  });

  it('uses a found digest as authority and does not resubmit', async () => {
    const nonce = 'nonce:found';
    const memory = createMemorySpendState(new Set([nonce]));
    const chain = createBoundary({ lookup: 'unknown' });
    await coordinator({ state: memory.state, boundary: chain.boundary }).withdraw({
      destinationAddress: ADMIN,
      amountMist: '100',
      nonceKey: nonce,
    });
    chain.setLookup('found');

    const recovered = await coordinator({
      state: memory.state,
      boundary: chain.boundary,
    }).recoverActiveSpend();
    expect(recovered?.status).toBe('succeeded');
    expect(chain.submitCount()).toBe(0);
  });

  it('validates the stored signed identity before trusting a digest lookup', async () => {
    const nonce = 'nonce:corrupt-ready-identity';
    const memory = createMemorySpendState(new Set([nonce]));
    const chain = createBoundary({ lookup: 'unknown' });
    await coordinator({ state: memory.state, boundary: chain.boundary }).withdraw({
      destinationAddress: ADMIN,
      amountMist: '100',
      nonceKey: nonce,
    });
    const stored = memory.current() as { amountMist: string };
    stored.amountMist = '101';
    chain.setLookup('found');

    await expect(
      coordinator({ state: memory.state, boundary: chain.boundary }).recoverActiveSpend(),
    ).rejects.toThrow('different from the built transaction');
    expect(chain.lookupCount()).toBe(1);
    expect(chain.submitCount()).toBe(0);
  });

  it('rejects a different signed amount without driving the withdrawal accepted for that nonce', async () => {
    const nonce = 'nonce:request-identity';
    const memory = createMemorySpendState(new Set([nonce]));
    const chain = createBoundary({ lookup: 'unknown' });
    await coordinator({ state: memory.state, boundary: chain.boundary }).withdraw({
      destinationAddress: ADMIN,
      amountMist: '100',
      nonceKey: nonce,
    });
    chain.setLookup('found');

    const second = await coordinator({ state: memory.state, boundary: chain.boundary }).withdraw({
      destinationAddress: ADMIN,
      amountMist: '101',
      nonceKey: nonce,
    });

    expect(second).toEqual({ status: 'nonce_missing' });
    expect(memory.current()).toMatchObject({ amountMist: '100', state: 'ready' });

    const originalRetry = await coordinator({
      state: memory.state,
      boundary: chain.boundary,
    }).withdraw({ destinationAddress: ADMIN, amountMist: '100', nonceKey: nonce });
    expect(originalRetry).toMatchObject({ status: 'succeeded', amountMist: '100' });

    const explicitRetry = await coordinator({
      state: memory.state,
      boundary: chain.boundary,
    }).withdraw({ destinationAddress: ADMIN, amountMist: '101', nonceKey: nonce });
    expect(explicitRetry).toEqual({ status: 'nonce_missing' });
    expect(chain.buildCount()).toBe(1);
    expect(chain.submitCount()).toBe(0);
    expect(memory.current()).toMatchObject({ amountMist: '100', state: 'succeeded' });
  });

  it('recovers a different active spend without executing the incoming request in the same call', async () => {
    const nonceA = 'nonce:active-a';
    const nonceB = 'nonce:incoming-b';
    const memory = createMemorySpendState(new Set([nonceA, nonceB]));
    const chain = createBoundary({ lookup: 'unknown' });
    const spend = coordinator({ state: memory.state, boundary: chain.boundary });

    await expect(
      spend.withdraw({ destinationAddress: ADMIN, amountMist: '100', nonceKey: nonceA }),
    ).resolves.toMatchObject({ status: 'pending' });
    chain.setLookup('not_found');

    const firstIncomingAttempt = await spend.withdraw({
      destinationAddress: ADMIN,
      amountMist: '200',
      nonceKey: nonceB,
    });

    expect(firstIncomingAttempt).toMatchObject({ status: 'busy' });
    expect(memory.current()).toMatchObject({ state: 'succeeded', amountMist: '100' });
    expect(chain.buildCount()).toBe(1);
    expect(chain.submitCount()).toBe(1);

    const explicitRetry = await spend.withdraw({
      destinationAddress: ADMIN,
      amountMist: '200',
      nonceKey: nonceB,
    });

    expect(explicitRetry).toMatchObject({ status: 'succeeded', amountMist: '200' });
    expect(chain.buildCount()).toBe(2);
    expect(chain.submitCount()).toBe(2);
  });

  it('returns the original withdrawal outcome after a later spend replaces the active account record', async () => {
    const nonceA = 'nonce:receipt-a';
    const nonceB = 'nonce:receipt-b';
    const memory = createMemorySpendState(new Set([nonceA, nonceB]));
    const chain = createBoundary({ lookup: 'unknown' });
    const spend = coordinator({ state: memory.state, boundary: chain.boundary });

    await expect(
      spend.withdraw({ destinationAddress: ADMIN, amountMist: '100', nonceKey: nonceA }),
    ).resolves.toMatchObject({ status: 'pending' });

    chain.setLookup('not_found');
    await expect(
      spend.withdraw({ destinationAddress: ADMIN, amountMist: '200', nonceKey: nonceB }),
    ).resolves.toMatchObject({ status: 'busy' });
    await expect(
      spend.withdraw({ destinationAddress: ADMIN, amountMist: '200', nonceKey: nonceB }),
    ).resolves.toMatchObject({ status: 'succeeded', amountMist: '200' });

    await expect(
      spend.withdraw({ destinationAddress: ADMIN, amountMist: '100', nonceKey: nonceA }),
    ).resolves.toMatchObject({ status: 'succeeded', amountMist: '100' });
  });

  it('keeps runway rejection stable when the exact withdrawal is retried', async () => {
    const nonce = 'nonce:runway-replay';
    const memory = createMemorySpendState(new Set([nonce]));
    const chain = createBoundary({ sourceBalance: 300n, gasBudget: 37n });
    const spend = coordinator({
      state: memory.state,
      boundary: chain.boundary,
      target: 100n,
      count: 2,
    });

    const first = await spend.withdraw({
      destinationAddress: ADMIN,
      amountMist: '100',
      nonceKey: nonce,
    });
    const replay = await spend.withdraw({
      destinationAddress: ADMIN,
      amountMist: '100',
      nonceKey: nonce,
    });

    expect(first).toMatchObject({ status: 'runway_blocked', amountMist: '100' });
    expect(replay).toMatchObject({ status: 'runway_blocked', amountMist: '100' });
    expect(chain.submitCount()).toBe(0);
  });

  it('projects a reserved failure from the durable terminal returned by the state store', async () => {
    const nonce = 'nonce:durable-failure-authority';
    const memory = createMemorySpendState(new Set([nonce]));
    const state: SponsorRefillAccountSpendStateStore = {
      ...memory.state,
      async failReserved(input) {
        return memory.state.failReserved({
          ...input,
          failureKind: 'failed',
          requiredSourceBalanceMist: null,
        });
      },
    };
    const chain = createBoundary({ sourceBalance: 300n, gasBudget: 37n });
    const spend = coordinator({
      state,
      boundary: chain.boundary,
      target: 100n,
      count: 2,
    });

    await expect(
      spend.withdraw({ destinationAddress: ADMIN, amountMist: '100', nonceKey: nonce }),
    ).resolves.toMatchObject({ status: 'failed', amountMist: '100' });
  });

  it('recovers a submitted transaction whose response was lost by looking up the same digest', async () => {
    const nonce = 'nonce:lost-response';
    const memory = createMemorySpendState(new Set([nonce]));
    const chain = createBoundary({ submit: 'lost_response_found' });

    const result = await coordinator({ state: memory.state, boundary: chain.boundary }).withdraw({
      destinationAddress: ADMIN,
      amountMist: '100',
      nonceKey: nonce,
    });

    expect(result.status).toBe('succeeded');
    expect(chain.buildCount()).toBe(1);
    expect(chain.submitCount()).toBe(1);
    expect(chain.lookupCount()).toBe(3);
    const ready = memory.snapshots.find((snapshot) => snapshot.state === 'ready')!;
    const [submission] = chain.submissions();
    expect(toBase64(submission!.bytes)).toBe(ready.transactionBytesBase64);
    expect(submission?.signature).toBe(ready.signature);
    expect(submission?.digest).toBe(ready.digest);
    expect(result).toMatchObject({ status: 'succeeded', digest: ready.digest });

    const countsBeforeReplay = {
      builds: chain.buildCount(),
      submits: chain.submitCount(),
      lookups: chain.lookupCount(),
      validations: chain.validateCount(),
    };
    const replay = await coordinator({ state: memory.state, boundary: chain.boundary }).withdraw({
      destinationAddress: ADMIN,
      amountMist: '100',
      nonceKey: nonce,
    });
    expect(replay).toEqual(result);
    expect({
      builds: chain.buildCount(),
      submits: chain.submitCount(),
      lookups: chain.lookupCount(),
      validations: chain.validateCount(),
    }).toEqual(countsBeforeReplay);
  });

  it('keeps a confirmed withdrawal successful when the terminal balance observation fails', async () => {
    const nonce = 'nonce:terminal-balance-unavailable';
    const memory = createMemorySpendState(new Set([nonce]));
    let sourceReads = 0;
    const chain = createBoundary({
      getBalance(address) {
        if (address !== SOURCE) return 0n;
        sourceReads += 1;
        if (sourceReads === 1) return 10_000n;
        throw new Error('source balance unavailable after execution');
      },
    });
    const spend = coordinator({ state: memory.state, boundary: chain.boundary });

    const first = await spend.withdraw({
      destinationAddress: ADMIN,
      amountMist: '100',
      nonceKey: nonce,
    });
    expect(first).toMatchObject({ status: 'succeeded', amountMist: '100' });
    expect(memory.current()).toMatchObject({ state: 'succeeded' });

    const replay = await spend.withdraw({
      destinationAddress: ADMIN,
      amountMist: '100',
      nonceKey: nonce,
    });
    expect(replay).toEqual(first);
    expect(sourceReads).toBe(2);
  });

  it('does not re-query a previous terminal digest before admitting the next spend', async () => {
    const nonceA = 'nonce:terminal-admission-a';
    const nonceB = 'nonce:terminal-admission-b';
    const memory = createMemorySpendState(new Set([nonceA, nonceB]));
    const chain = createBoundary();
    const spend = coordinator({ state: memory.state, boundary: chain.boundary });

    const first = await spend.withdraw({
      destinationAddress: ADMIN,
      amountMist: '100',
      nonceKey: nonceA,
    });
    expect(first).toMatchObject({ status: 'succeeded' });
    if (first.status !== 'succeeded') throw new Error('first withdrawal did not succeed');
    const lookupStart = chain.lookupDigests().length;
    chain.setLookup('unknown');

    await expect(
      spend.withdraw({ destinationAddress: ADMIN, amountMist: '100', nonceKey: nonceB }),
    ).resolves.toMatchObject({ status: 'pending', amountMist: '100' });
    expect(chain.buildCount()).toBe(2);
    expect(chain.lookupDigests().slice(lookupStart)).not.toContain(first.digest);
  });

  it('recovers timeout-late-success by the same digest without rebuilding or resubmitting', async () => {
    const nonce = 'nonce:timeout-late-success';
    const memory = createMemorySpendState(new Set([nonce]));
    const submitGate = deferred<void>();
    const chain = createBoundary({ submitGate: submitGate.promise });

    const pending = await coordinator({
      state: memory.state,
      boundary: chain.boundary,
      dispatchTimeoutMs: 10,
    }).withdraw({
      destinationAddress: ADMIN,
      amountMist: '100',
      nonceKey: nonce,
    });

    expect(pending.status).toBe('pending');
    expect(chain.buildCount()).toBe(1);
    expect(chain.submitCount()).toBe(1);
    expect(chain.lookupCount()).toBe(2);
    expect(chain.validateCount()).toBe(1);
    const ready = structuredClone(requireReadySpend(memory.current()));

    submitGate.resolve();
    await Promise.resolve();
    chain.setLookup('found');
    const recovered = await coordinator({
      state: memory.state,
      boundary: chain.boundary,
      dispatchTimeoutMs: 10,
    }).recoverActiveSpend();

    expect(recovered?.status).toBe('succeeded');
    expect(chain.buildCount()).toBe(1);
    expect(chain.submitCount()).toBe(1);
    expect(chain.lookupCount()).toBe(4);
    expect(chain.validateCount()).toBe(2);
    const [submission] = chain.submissions();
    expect(toBase64(submission!.bytes)).toBe(ready.transactionBytesBase64);
    expect(submission?.signature).toBe(ready.signature);
    expect(submission?.digest).toBe(ready.digest);
  });

  it.each(['build', 'simulate'] as const)(
    'bounds a stalled %s phase before any transaction identity becomes ready',
    async (phase) => {
      const nonce = `nonce:stalled-${phase}`;
      const memory = createMemorySpendState(new Set([nonce]));
      const stalled = new Promise<void>(() => undefined);
      const chain = createBoundary({
        buildGate: phase === 'build' ? stalled : undefined,
        simulateGate: phase === 'simulate' ? stalled : undefined,
      });

      const result = await coordinator({
        state: memory.state,
        boundary: chain.boundary,
        dispatchTimeoutMs: 10,
      }).withdraw({ destinationAddress: ADMIN, amountMist: '100', nonceKey: nonce });

      expect(result.status).toBe('pending');
      expect(chain.submitCount()).toBe(0);
      expect(memory.snapshots.map((snapshot) => snapshot.state)).toEqual(['reserved']);
    },
  );

  it('follows the durable winner when a late local preparation failure loses its CAS', async () => {
    const nonce = 'nonce:late-preparation-failure';
    const memory = createMemorySpendState(new Set([nonce]));
    const firstBuildGate = deferred<void>();
    let buildCount = 0;
    let submitCount = 0;
    let submittedDigest: string | null = null;
    const built = new Map<string, Uint8Array>();
    const boundary: SponsorRefillAccountSpendBoundary = {
      async buildAndSign() {
        buildCount += 1;
        const bytes = new Uint8Array([buildCount]);
        if (buildCount === 1) await firstBuildGate.promise;
        const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
        built.set(digest, bytes);
        return {
          transactionBytes: bytes,
          signature: `signature:${digest}`,
          digest,
          gasBudgetMist: 37n,
        };
      },
      async validateSignedIdentity(identity) {
        expect(identity.transactionBytes).toEqual(built.get(identity.digest));
      },
      async simulate(bytes) {
        return bytes[0] === 1
          ? { success: false, error: 'late local simulation failure' }
          : { success: true, error: null };
      },
      async lookup(digest) {
        return submittedDigest === digest
          ? { status: 'found', result: { digest, success: true, error: null } }
          : { status: 'not_found' };
      },
      async submit(_bytes, _signature, digest) {
        submitCount += 1;
        submittedDigest = digest;
        return { digest, success: true, error: null };
      },
      async getBalance() {
        return 10_000n;
      },
    };
    const first = coordinator({ state: memory.state, boundary, dispatchTimeoutMs: 1_000 }).withdraw(
      {
        destinationAddress: ADMIN,
        amountMist: '100',
        nonceKey: nonce,
      },
    );
    await vi.waitFor(() => expect(buildCount).toBe(1));

    const winner = await coordinator({
      state: memory.state,
      boundary,
      dispatchTimeoutMs: 1_000,
    }).recoverActiveSpend();
    expect(winner?.status).toBe('succeeded');
    firstBuildGate.resolve();

    await expect(first).resolves.toMatchObject({ status: 'succeeded' });
    expect(buildCount).toBe(2);
    expect(submitCount).toBe(1);
    expect(memory.current()).toMatchObject({ state: 'succeeded' });
  });

  it.each([37n, 113n])(
    'uses the resolved %s MIST gas budget in the runway boundary',
    async (gas) => {
      const target = 100n;
      const count = 2;
      const amount = 50n;

      const allowedNonce = `nonce:allowed:${gas.toString()}`;
      const allowedState = createMemorySpendState(new Set([allowedNonce]));
      const allowedBoundary = createBoundary({
        sourceBalance: target * BigInt(count) + amount + gas,
        gasBudget: gas,
      });
      const allowed = await coordinator({
        state: allowedState.state,
        boundary: allowedBoundary.boundary,
        target,
        count,
      }).withdraw({
        destinationAddress: ADMIN,
        amountMist: amount.toString(),
        nonceKey: allowedNonce,
      });
      expect(allowed.status).toBe('succeeded');
      expect(
        allowedState.snapshots.find((snapshot) => snapshot.state === 'ready')?.gasBudgetMist,
      ).toBe(gas.toString());

      const blockedNonce = `nonce:blocked:${gas.toString()}`;
      const blockedState = createMemorySpendState(new Set([blockedNonce]));
      const blockedBoundary = createBoundary({
        sourceBalance: target * BigInt(count) + amount + gas - 1n,
        gasBudget: gas,
      });
      const blocked = await coordinator({
        state: blockedState.state,
        boundary: blockedBoundary.boundary,
        target,
        count,
      }).withdraw({
        destinationAddress: ADMIN,
        amountMist: amount.toString(),
        nonceKey: blockedNonce,
      });
      expect(blocked.status).toBe('runway_blocked');
      expect(blockedBoundary.submitCount()).toBe(0);
    },
  );
});

describe('Sui Sponsor Refill Account spend boundary', () => {
  it('builds and signs one exact SDK transaction and reports its encoded gas budget and digest', async () => {
    const signer = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7));
    const sourceAddress = signer.toSuiAddress();
    const resolveTransactionPlugin =
      () =>
      async (
        data: {
          gasData: {
            budget: string | null;
            owner: string | null;
            payment: { objectId: string; version: string; digest: string }[] | null;
            price: string | null;
          };
        },
        _options: unknown,
        next: () => Promise<void>,
      ) => {
        data.gasData.budget = '77';
        data.gasData.owner = sourceAddress;
        data.gasData.price = '1';
        data.gasData.payment = [
          {
            objectId: `0x${'44'.repeat(32)}`,
            version: '1',
            digest: '11111111111111111111111111111111',
          },
        ];
        await next();
      };
    const sui = {
      core: { resolveTransactionPlugin },
    } as unknown as SuiGrpcClient;
    const boundary = createSuiSponsorRefillAccountSpendBoundary({
      sui,
      signer,
      sourceAddress,
    });

    const built = await boundary.buildAndSign(ADMIN, 123n);
    const decoded = TransactionDataBuilder.fromBytes(built.transactionBytes).snapshot();

    expect(decoded.sender).toBe(sourceAddress);
    expect(decoded.gasData.owner).toBe(sourceAddress);
    expect(String(decoded.gasData.budget)).toBe('77');
    expect(built.gasBudgetMist).toBe(77n);
    expect(built.digest).toBe(TransactionDataBuilder.getDigestFromBytes(built.transactionBytes));
    expect(
      await signer.getPublicKey().verifyTransaction(built.transactionBytes, built.signature),
    ).toBe(true);
    expect(decoded.inputs).toEqual([
      { $kind: 'Pure', Pure: { bytes: u64Bytes(123n) } },
      { $kind: 'Pure', Pure: { bytes: addressBytes(ADMIN) } },
    ]);
    expect(decoded.commands).toEqual([
      {
        $kind: 'SplitCoins',
        SplitCoins: {
          coin: { $kind: 'GasCoin', GasCoin: true },
          amounts: [{ $kind: 'Input', Input: 0 }],
        },
      },
      {
        $kind: 'TransferObjects',
        TransferObjects: {
          objects: [{ $kind: 'NestedResult', NestedResult: [0, 0] }],
          address: { $kind: 'Input', Input: 1 },
        },
      },
    ]);
    await expect(
      boundary.validateSignedIdentity({
        sourceAddress,
        destinationAddress: ADMIN,
        amountMist: 123n,
        gasBudgetMist: 77n,
        transactionBytes: built.transactionBytes,
        signature: built.signature,
        digest: built.digest,
      }),
    ).resolves.toBeUndefined();

    await expect(
      boundary.validateSignedIdentity({
        sourceAddress,
        destinationAddress: ADMIN,
        amountMist: 124n,
        gasBudgetMist: 77n,
        transactionBytes: built.transactionBytes,
        signature: built.signature,
        digest: built.digest,
      }),
    ).rejects.toThrow('inputs do not match durable fields');
    await expect(
      boundary.validateSignedIdentity({
        sourceAddress,
        destinationAddress: ADMIN,
        amountMist: 123n,
        gasBudgetMist: 77n,
        transactionBytes: built.transactionBytes,
        signature: 'invalid-signature',
        digest: built.digest,
      }),
    ).rejects.toThrow();

    const corruptedBytes = Uint8Array.from(built.transactionBytes);
    corruptedBytes[corruptedBytes.length - 1] ^= 0x01;
    await expect(
      boundary.validateSignedIdentity({
        sourceAddress,
        destinationAddress: ADMIN,
        amountMist: 123n,
        gasBudgetMist: 77n,
        transactionBytes: corruptedBytes,
        signature: built.signature,
        digest: built.digest,
      }),
    ).rejects.toThrow('bytes do not match their digest');
  });

  it('fails closed on malformed terminal unions and a submit bytes/digest mismatch', async () => {
    const signer = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(9));
    const malformedTerminal = {
      $kind: 'Transaction',
      Transaction: {},
      FailedTransaction: {},
    };
    const executeTransaction = vi.fn(async () => malformedTerminal);
    const sui = {
      simulateTransaction: vi.fn(async () => malformedTerminal),
      getTransaction: vi.fn(async () => malformedTerminal),
      executeTransaction,
    } as unknown as SuiGrpcClient;
    const boundary = createSuiSponsorRefillAccountSpendBoundary({
      sui,
      signer,
      sourceAddress: signer.toSuiAddress(),
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const digest = TransactionDataBuilder.getDigestFromBytes(bytes);

    await expect(boundary.simulate(bytes)).rejects.toThrow('malformed terminal result');
    await expect(boundary.lookup(digest)).rejects.toThrow('malformed terminal result');
    await expect(boundary.submit(bytes, 'signature', digest)).rejects.toThrow(
      'malformed terminal result',
    );

    executeTransaction.mockClear();
    await expect(boundary.submit(bytes, 'signature', `${digest}-corrupt`)).rejects.toThrow(
      'bytes do not match their digest',
    );
    expect(executeTransaction).not.toHaveBeenCalled();
  });

  it('rejects a self-consistent simulation terminal for different transaction bytes', async () => {
    const signer = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(12));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const wrongDigest = TransactionDataBuilder.getDigestFromBytes(new Uint8Array([4, 3, 2, 1]));
    const status = { success: true, error: null };
    const terminal = {
      $kind: 'Transaction',
      Transaction: {
        digest: wrongDigest,
        status,
        effects: { transactionDigest: wrongDigest, status },
      },
    };
    const boundary = createSuiSponsorRefillAccountSpendBoundary({
      sui: { simulateTransaction: vi.fn(async () => terminal) } as unknown as SuiGrpcClient,
      signer,
      sourceAddress: signer.toSuiAddress(),
    });

    await expect(boundary.simulate(bytes)).rejects.toThrow('malformed terminal result');
  });

  it('accepts a current failed terminal union and preserves its error message', async () => {
    const signer = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(11));
    const digest = 'failed-digest';
    const error = { $kind: 'Unknown', Unknown: null, message: 'chain rejected transaction' };
    const status = { success: false, error };
    const terminal = {
      $kind: 'FailedTransaction',
      FailedTransaction: {
        digest,
        status,
        effects: { transactionDigest: digest, status },
      },
    };
    const boundary = createSuiSponsorRefillAccountSpendBoundary({
      sui: { getTransaction: vi.fn(async () => terminal) } as unknown as SuiGrpcClient,
      signer,
      sourceAddress: signer.toSuiAddress(),
    });

    await expect(boundary.lookup(digest)).resolves.toEqual({
      status: 'found',
      result: { digest, success: false, error: 'chain rejected transaction' },
    });
  });

  it.each([
    { $kind: 'Unknown' },
    {
      $kind: 'Transaction',
      Transaction: { digest: 'digest', status: { success: true, error: null } },
    },
    {
      $kind: 'Transaction',
      Transaction: {
        digest: 'digest',
        status: { success: true, error: null },
        effects: {
          transactionDigest: 'different',
          status: { success: true, error: null },
        },
      },
    },
    {
      $kind: 'Transaction',
      Transaction: {
        digest: 'digest',
        status: { success: true, error: null },
        effects: {
          transactionDigest: 'digest',
          status: { success: false, error: { $kind: 'Unknown', message: 'failure' } },
        },
      },
    },
    {
      $kind: 'FailedTransaction',
      FailedTransaction: {
        digest: 'digest',
        status: { success: false, error: { $kind: 'Unknown', message: 'failure' } },
        effects: {
          transactionDigest: 'digest',
          status: { success: false, error: { $kind: 'Unknown', message: 'failure' } },
        },
      },
    },
    {
      $kind: 'FailedTransaction',
      FailedTransaction: {
        digest: 'digest',
        status: {
          success: false,
          error: {
            $kind: 'MoveAbort',
            MoveAbort: { location: '0x1::module', abortCode: '1' },
            message: 'same summary',
          },
        },
        effects: {
          transactionDigest: 'digest',
          status: {
            success: false,
            error: {
              $kind: 'MoveAbort',
              MoveAbort: { location: '0x2::module', abortCode: '2' },
              message: 'same summary',
            },
          },
        },
      },
    },
  ])('rejects a terminal result that violates the current RPC union', async (terminal) => {
    const signer = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(10));
    const boundary = createSuiSponsorRefillAccountSpendBoundary({
      sui: { simulateTransaction: vi.fn(async () => terminal) } as unknown as SuiGrpcClient,
      signer,
      sourceAddress: signer.toSuiAddress(),
    });

    await expect(boundary.simulate(new Uint8Array([1]))).rejects.toThrow(
      'malformed terminal result',
    );
  });
});
