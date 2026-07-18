import { randomUUID } from 'node:crypto';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import {
  fromBase64,
  fromHex,
  isValidSuiAddress,
  normalizeSuiAddress,
  toBase64,
} from '@mysten/sui/utils';
import { isPositiveU64DecimalString, SUI_TYPE } from '@stelis/contracts';
import {
  buildSuiTransaction,
  executeSuiTransaction,
  getSuiBalance,
  getSuiTransactionEffects,
  simulateSuiTransaction,
  SuiOperationError,
  suiExecutionErrorMessage,
  type SuiEndpointSnapshot,
  type SuiSimulationResult,
  type SuiTransactionResult,
} from '@stelis/core-relay';
import type {
  SponsorRefillAccountDispatchLock,
  SponsorRefillAccountDispatchLockHandle,
} from './refillLock.js';
import type {
  RedisSponsorOperationsState,
  SponsorRefillAccountAvailabilityRecord,
  SponsorSlotAvailabilityRecord,
} from './redisState.js';
import {
  createSponsorRefillAccountWithdrawalOperationId,
  isActiveSponsorRefillAccountSpend,
  type ReadySponsorRefillAccountSpend,
  type ReconcilingSponsorRefillAccountSpend,
  type ReservedSponsorRefillAccountSpend,
  type SponsorRefillAccountSpend,
  type SponsorRefillAccountSpendStateStore,
  type SponsorRefillAccountWithdrawalReceipt,
  type SponsorRefillAccountWithdrawalTerminalResult,
  type TerminalSponsorRefillAccountSpend,
} from './accountSpendState.js';
import { parseChainBalanceMist } from './balanceParsing.js';
import { normalizeSponsorOperationsLastError } from './lastError.js';
import { SponsorOperationsTimeoutError, withTimeout } from './timeout.js';
import type { SponsorOperationsSettings } from './settings.js';

const U64_MAX = (1n << 64n) - 1n;

export interface BuiltSponsorRefillAccountSpend {
  readonly transactionBytes: Uint8Array;
  readonly signature: string;
  readonly digest: string;
  readonly gasBudgetMist: bigint;
}

export interface SponsorRefillAccountChainResult {
  readonly digest: string;
  readonly success: boolean;
  readonly error: string | null;
}

export type SponsorRefillAccountTransactionLookup =
  | { readonly status: 'found'; readonly result: SponsorRefillAccountChainResult }
  | { readonly status: 'not_found' };

export interface SponsorRefillAccountSpendBoundary {
  buildAndSign(
    destinationAddress: string,
    amountMist: bigint,
    signal?: AbortSignal,
  ): Promise<BuiltSponsorRefillAccountSpend>;
  validateSignedIdentity(input: {
    readonly sourceAddress: string;
    readonly destinationAddress: string;
    readonly amountMist: bigint;
    readonly gasBudgetMist: bigint;
    readonly transactionBytes: Uint8Array;
    readonly signature: string;
    readonly digest: string;
  }): Promise<void>;
  simulate(
    transactionBytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error: string | null }>;
  lookup(digest: string, signal?: AbortSignal): Promise<SponsorRefillAccountTransactionLookup>;
  submit(
    transactionBytes: Uint8Array,
    signature: string,
    expectedDigest: string,
    signal?: AbortSignal,
  ): Promise<SponsorRefillAccountChainResult>;
  getTotalBalance(address: string, signal?: AbortSignal): Promise<bigint>;
  getAddressBalance(address: string, signal?: AbortSignal): Promise<bigint>;
}

export type SponsorRefillAccountSpendResult =
  | {
      readonly status: 'succeeded';
      readonly operationId: string;
      readonly digest: string;
      readonly amountMist: string;
      readonly destinationAddress: string;
    }
  | {
      readonly status: 'failed';
      readonly operationId: string;
      readonly digest: string | null;
      readonly amountMist: string;
      readonly error: string;
    }
  | {
      readonly status: 'runway_blocked';
      readonly operationId: string;
      readonly digest: string | null;
      readonly amountMist: string;
      readonly error: string;
    }
  | {
      readonly status: 'pending';
      readonly operationId: string;
      readonly digest: string | null;
      readonly amountMist: string;
      readonly error: string;
    }
  | {
      readonly status: 'busy';
      readonly operationId: string;
      readonly digest: string | null;
      readonly error: string;
    }
  | { readonly status: 'nonce_missing' }
  | {
      readonly status: 'not_needed';
      readonly slotAddress: string;
      readonly addressBalanceMist: string;
    };

export type SponsorRefillAccountRefillReason = 'slot_observed' | 'source_observed' | 'retry';

export type SponsorRefillAccountRefillResult =
  | SponsorRefillAccountSpendResult
  | { readonly status: 'not_eligible'; readonly slotAddress: string };

export function isAutomaticSponsorRefillEligible(
  slot: SponsorSlotAvailabilityRecord | null,
  source: SponsorRefillAccountAvailabilityRecord,
  reason: SponsorRefillAccountRefillReason,
): boolean {
  if (slot === null || !slot.observationFresh || !source.observationFresh) return false;
  const required = slot.refillRequiredSourceBalanceMist;
  const sourceMeetsRequiredBalance =
    required !== null &&
    source.healthy === true &&
    source.totalBalanceMist !== null &&
    BigInt(source.totalBalanceMist) >= BigInt(required);

  if (reason === 'slot_observed') {
    return slot.state === 'low_balance' && required === null;
  }
  if (slot.state === 'low_balance') {
    return required === null || sourceMeetsRequiredBalance;
  }
  if (slot.state === 'rpc_unreachable') {
    return reason === 'retry' && (required === null || sourceMeetsRequiredBalance);
  }
  if (slot.state !== 'refill_failed') return false;
  if (required === null) return reason === 'retry';
  return sourceMeetsRequiredBalance;
}

export interface SponsorRefillAccountSpendCoordinatorDeps {
  readonly state: SponsorRefillAccountSpendStateStore;
  readonly operationsState: RedisSponsorOperationsState;
  readonly dispatchLock: SponsorRefillAccountDispatchLock;
  readonly boundary: SponsorRefillAccountSpendBoundary;
  readonly settings: SponsorOperationsSettings;
}

export interface SponsorRefillAccountSpendCoordinator {
  withdraw(input: {
    readonly destinationAddress: string;
    readonly amountMist: string;
    readonly nonceKey: string;
    readonly signal?: AbortSignal;
  }): Promise<SponsorRefillAccountSpendResult>;
  refill(
    slotAddress: string,
    reason: SponsorRefillAccountRefillReason,
    signal?: AbortSignal,
  ): Promise<SponsorRefillAccountRefillResult>;
  recoverActiveSpend(signal: AbortSignal): Promise<SponsorRefillAccountSpendResult | null>;
}

interface SpendExecutionContext {
  readonly signal?: AbortSignal;
  readonly authorizedReservedIntent?: {
    readonly operationId: string;
    readonly kind: 'withdrawal' | 'refill';
    readonly sourceAddress: string;
    readonly destinationAddress: string;
    readonly slotAddress: string | null;
    readonly nonceKey: string | null;
    readonly amountMist: string;
  };
}

function throwIfSpendAborted(context: SpendExecutionContext): void {
  context.signal?.throwIfAborted();
}

type RuntimeRecord = Record<string, unknown>;

function isRuntimeRecord(value: unknown): value is RuntimeRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCurrentTransactionResult(
  transaction: SuiTransactionResult,
  expectedDigest: string,
): SponsorRefillAccountChainResult {
  if (transaction.digest !== expectedDigest) {
    throw new Error('Sponsor Refill Account transaction digest does not match its request');
  }
  return {
    digest: expectedDigest,
    success: transaction.outcome === 'success',
    error: transaction.outcome === 'success' ? null : suiExecutionErrorMessage(transaction.error),
  };
}

function parseSimulationResult(transaction: SuiSimulationResult): {
  success: boolean;
  error: string | null;
} {
  return transaction.outcome === 'success'
    ? { success: true, error: null }
    : { success: false, error: suiExecutionErrorMessage(transaction.error) };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function u64LittleEndian(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function decodedPureBytes(input: unknown): Uint8Array | null {
  if (!isRuntimeRecord(input) || input.$kind !== 'Pure' || !isRuntimeRecord(input.Pure)) {
    return null;
  }
  return typeof input.Pure.bytes === 'string' ? fromBase64(input.Pure.bytes) : null;
}

function assertCompiledSpendIdentity(input: {
  readonly transactionBytes: Uint8Array;
  readonly sourceAddress: string;
  readonly destinationAddress: string;
  readonly amountMist: bigint;
  readonly gasBudgetMist: bigint;
  readonly digest: string;
}): void {
  if (TransactionDataBuilder.getDigestFromBytes(input.transactionBytes) !== input.digest) {
    throw new Error('Stored Sponsor Refill Account transaction bytes do not match their digest');
  }
  const decoded = TransactionDataBuilder.fromBytes(input.transactionBytes).snapshot();
  const sourceAddress = normalizeSuiAddress(input.sourceAddress);
  const destinationAddress = normalizeSuiAddress(input.destinationAddress);
  if (
    normalizeSuiAddress(decoded.sender ?? '') !== sourceAddress ||
    normalizeSuiAddress(decoded.gasData.owner ?? '') !== sourceAddress ||
    String(decoded.gasData.budget ?? '') !== input.gasBudgetMist.toString() ||
    decoded.inputs.length !== 2 ||
    decoded.commands.length !== 2
  ) {
    throw new Error('Sponsor Refill Account transaction identity does not match durable fields');
  }
  const amountBytes = decodedPureBytes(decoded.inputs[0]);
  const destinationBytes = decodedPureBytes(decoded.inputs[1]);
  if (
    amountBytes === null ||
    destinationBytes === null ||
    !sameBytes(amountBytes, u64LittleEndian(input.amountMist)) ||
    !sameBytes(destinationBytes, fromHex(destinationAddress))
  ) {
    throw new Error('Sponsor Refill Account transaction inputs do not match durable fields');
  }

  const split = decoded.commands[0] as unknown;
  const sendFunds = decoded.commands[1] as unknown;
  if (
    !isRuntimeRecord(split) ||
    split.$kind !== 'SplitCoins' ||
    !isRuntimeRecord(split.SplitCoins)
  ) {
    throw new Error('Sponsor Refill Account transaction has an unexpected split command');
  }
  const coin = split.SplitCoins.coin;
  const amounts = split.SplitCoins.amounts;
  if (
    !isRuntimeRecord(coin) ||
    coin.$kind !== 'GasCoin' ||
    !Array.isArray(amounts) ||
    amounts.length !== 1 ||
    !isRuntimeRecord(amounts[0]) ||
    amounts[0].$kind !== 'Input' ||
    amounts[0].Input !== 0
  ) {
    throw new Error('Sponsor Refill Account transaction does not split the exact gas coin amount');
  }
  if (
    !isRuntimeRecord(sendFunds) ||
    sendFunds.$kind !== 'MoveCall' ||
    !isRuntimeRecord(sendFunds.MoveCall)
  ) {
    throw new Error('Sponsor Refill Account transaction has an unexpected send-funds command');
  }
  const moveCall = sendFunds.MoveCall;
  const typeArguments = moveCall.typeArguments;
  const arguments_ = moveCall.arguments;
  if (
    moveCall.package !== normalizeSuiAddress('0x2') ||
    moveCall.module !== 'coin' ||
    moveCall.function !== 'send_funds' ||
    !Array.isArray(typeArguments) ||
    typeArguments.length !== 1 ||
    typeArguments[0] !== SUI_TYPE ||
    !Array.isArray(arguments_) ||
    arguments_.length !== 2 ||
    !isRuntimeRecord(arguments_[0]) ||
    arguments_[0].$kind !== 'NestedResult' ||
    !Array.isArray(arguments_[0].NestedResult) ||
    arguments_[0].NestedResult[0] !== 0 ||
    arguments_[0].NestedResult[1] !== 0 ||
    !isRuntimeRecord(arguments_[1]) ||
    arguments_[1].$kind !== 'Input' ||
    arguments_[1].Input !== 1
  ) {
    throw new Error('Sponsor Refill Account transaction does not send the exact split SUI coin');
  }
}

export function createSuiSponsorRefillAccountSpendBoundary(input: {
  readonly sui: SuiEndpointSnapshot;
  readonly signer: Ed25519Keypair;
  readonly sourceAddress: string;
}): SponsorRefillAccountSpendBoundary {
  async function validateSignedIdentity(identity: {
    readonly sourceAddress: string;
    readonly destinationAddress: string;
    readonly amountMist: bigint;
    readonly gasBudgetMist: bigint;
    readonly transactionBytes: Uint8Array;
    readonly signature: string;
    readonly digest: string;
  }): Promise<void> {
    if (normalizeSuiAddress(identity.sourceAddress) !== normalizeSuiAddress(input.sourceAddress)) {
      throw new Error(
        'Sponsor Refill Account transaction source does not match the current signer',
      );
    }
    assertCompiledSpendIdentity(identity);
    if (
      !(await input.signer
        .getPublicKey()
        .verifyTransaction(identity.transactionBytes, identity.signature))
    ) {
      throw new Error('Sponsor Refill Account transaction signature does not match its bytes');
    }
  }

  return {
    async buildAndSign(destinationAddress, amountMist, signal) {
      signal?.throwIfAborted();
      const transaction = new Transaction();
      const [coin] = transaction.splitCoins(transaction.gas, [transaction.pure.u64(amountMist)]);
      transaction.moveCall({
        target: '0x2::coin::send_funds',
        typeArguments: [SUI_TYPE],
        arguments: [coin, transaction.pure.address(destinationAddress)],
      });
      transaction.setSender(input.sourceAddress);

      const transactionBytes = await buildSuiTransaction(input.sui, {
        transaction,
        ...(signal === undefined ? {} : { signal }),
      });
      signal?.throwIfAborted();
      const decoded = TransactionDataBuilder.fromBytes(transactionBytes).snapshot();
      const gasBudgetRaw = decoded.gasData.budget;
      const gasBudgetMist = gasBudgetRaw == null ? '' : String(gasBudgetRaw);
      if (!isPositiveU64DecimalString(gasBudgetMist)) {
        throw new Error('Sponsor Refill Account transaction resolved an invalid gas budget');
      }
      const digest = TransactionDataBuilder.getDigestFromBytes(transactionBytes);
      const signed = await input.signer.signTransaction(transactionBytes);
      signal?.throwIfAborted();
      if (!sameBytes(fromBase64(signed.bytes), transactionBytes)) {
        throw new Error('Sponsor Refill Account signer returned different transaction bytes');
      }
      await validateSignedIdentity({
        sourceAddress: input.sourceAddress,
        destinationAddress,
        amountMist,
        gasBudgetMist: BigInt(gasBudgetMist),
        transactionBytes,
        signature: signed.signature,
        digest,
      });
      return {
        transactionBytes,
        signature: signed.signature,
        digest,
        gasBudgetMist: BigInt(gasBudgetMist),
      };
    },

    validateSignedIdentity,

    async simulate(transactionBytes, signal) {
      return parseSimulationResult(
        await simulateSuiTransaction(input.sui, {
          transaction: transactionBytes,
          ...(signal === undefined ? {} : { signal }),
        }),
      );
    },

    async lookup(digest, signal) {
      try {
        const result = await getSuiTransactionEffects(input.sui, {
          digest,
          ...(signal === undefined ? {} : { signal }),
        });
        return { status: 'found', result: parseCurrentTransactionResult(result, digest) };
      } catch (error) {
        signal?.throwIfAborted();
        if (
          error instanceof SuiOperationError &&
          error.kind === 'not_found' &&
          error.diagnostic.resourceId === digest
        ) {
          return { status: 'not_found' };
        }
        throw error;
      }
    },

    async submit(transactionBytes, signature, expectedDigest, signal) {
      if (TransactionDataBuilder.getDigestFromBytes(transactionBytes) !== expectedDigest) {
        throw new Error(
          'Stored Sponsor Refill Account transaction bytes do not match their digest',
        );
      }
      return parseCurrentTransactionResult(
        await executeSuiTransaction(input.sui, {
          transaction: transactionBytes,
          expectedDigest,
          signatures: [signature],
          ...(signal === undefined ? {} : { signal }),
        }),
        expectedDigest,
      );
    },

    async getTotalBalance(address, signal) {
      const result = await getSuiBalance(input.sui, {
        owner: address,
        ...(signal === undefined ? {} : { signal }),
      });
      return parseChainBalanceMist(result.balance, `Address ${address} total balance`);
    },

    async getAddressBalance(address, signal) {
      const result = await getSuiBalance(input.sui, {
        owner: address,
        ...(signal === undefined ? {} : { signal }),
      });
      return parseChainBalanceMist(
        result.addressBalance,
        `Sponsor address ${address} address balance`,
      );
    },
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Sponsor Refill Account spend was aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createSponsorRefillAccountSpendCoordinator(
  deps: SponsorRefillAccountSpendCoordinatorDeps,
): SponsorRefillAccountSpendCoordinator {
  const sourceRunwayMist =
    deps.settings.runwayTargetMist * BigInt(deps.settings.sponsorAddresses.length);

  function requireAddress(value: string, label: string): string {
    if (!isValidSuiAddress(value)) throw new Error(`${label} must be a valid Sui address`);
    return normalizeSuiAddress(value);
  }

  function spendDigest(spend: SponsorRefillAccountSpend): string | null {
    return 'digest' in spend ? spend.digest : null;
  }

  async function acquireDispatchLock(
    context: SpendExecutionContext,
  ): Promise<SponsorRefillAccountDispatchLockHandle> {
    const deadlineMs = Date.now() + deps.settings.refillTimeoutMs;
    while (true) {
      throwIfSpendAborted(context);
      const handle = await deps.dispatchLock.acquire(deps.settings.sponsorRefillAccountAddress);
      throwIfSpendAborted(context);
      if (handle !== null) return handle;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new SponsorOperationsTimeoutError(
          `sponsorRefillAccountSpend.acquire(${deps.settings.sponsorRefillAccountAddress})`,
          deps.settings.refillTimeoutMs,
        );
      }
      await delay(Math.min(25, remainingMs), context.signal);
    }
  }

  function sponsorRefillAccountFields(balance: bigint): {
    readonly totalBalanceMist: string;
    readonly lastError: '';
  } {
    return {
      totalBalanceMist: balance.toString(),
      lastError: '',
    };
  }

  function remainingTimeout(deadlineMs: number, operation: string): number {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new SponsorOperationsTimeoutError(operation, deps.settings.refillTimeoutMs);
    }
    return remainingMs;
  }

  async function sourceAccountObservation(context: SpendExecutionContext): Promise<{
    readonly balance: bigint | null;
    readonly fields: {
      readonly totalBalanceMist: string;
      readonly lastError: string;
    };
  }> {
    throwIfSpendAborted(context);
    try {
      const balance = await withTimeout(
        'sponsorRefillAccountSpend.getSourceBalance',
        deps.settings.sponsorRefillAccountBalanceTimeoutMs,
        (operationSignal) =>
          deps.boundary.getTotalBalance(deps.settings.sponsorRefillAccountAddress, operationSignal),
        context.signal,
      );
      throwIfSpendAborted(context);
      return {
        balance,
        fields: sponsorRefillAccountFields(balance),
      };
    } catch (error) {
      throwIfSpendAborted(context);
      return {
        balance: null,
        fields: {
          totalBalanceMist: '',
          lastError: normalizeSponsorOperationsLastError(error),
        },
      };
    }
  }

  async function failReserved(
    spend: ReservedSponsorRefillAccountSpend,
    error: unknown,
    status: 'failed' | 'runway_blocked',
    requiredSourceBalanceMist: bigint | null = null,
    context: SpendExecutionContext,
  ): Promise<SponsorRefillAccountSpendResult> {
    throwIfSpendAborted(context);
    const message = normalizeSponsorOperationsLastError(error);
    const failed = await deps.state.failReserved({
      operationId: spend.operationId,
      expectedSequence: spend.sequence,
      lastError: message,
      failureKind: status,
      requiredSourceBalanceMist: requiredSourceBalanceMist?.toString() ?? null,
    });
    if (failed === null) {
      const current = await deps.state.read();
      throwIfSpendAborted(context);
      if (current !== null && current.operationId === spend.operationId) {
        return driveSpend(current, context);
      }
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: null,
        amountMist: spend.amountMist,
        error: 'Sponsor Refill Account spend changed while recording preparation failure',
      };
    }
    return projectTerminalSpend(failed);
  }

  function pendingReserved(
    spend: ReservedSponsorRefillAccountSpend,
    error: unknown,
  ): SponsorRefillAccountSpendResult {
    return {
      status: 'pending',
      operationId: spend.operationId,
      digest: null,
      amountMist: spend.amountMist,
      error: normalizeSponsorOperationsLastError(error),
    };
  }

  async function requireVisibleChainResult(
    spend: ReconcilingSponsorRefillAccountSpend,
    operation: string,
    context: SpendExecutionContext,
  ): Promise<SponsorRefillAccountSpendResult | null> {
    throwIfSpendAborted(context);
    try {
      const lookup = await withTimeout(
        operation,
        deps.settings.confirmationTimeoutMs,
        (operationSignal) => deps.boundary.lookup(spend.digest, operationSignal),
        context.signal,
      );
      throwIfSpendAborted(context);
      if (lookup.status === 'not_found') {
        return {
          status: 'pending',
          operationId: spend.operationId,
          digest: spend.digest,
          amountMist: spend.amountMist,
          error: 'Sponsor Refill Account spend is not yet visible on the account RPC boundary',
        };
      }
      const expectedSuccess = spend.chainResult === 'succeeded';
      if (lookup.result.success !== expectedSuccess) {
        return {
          status: 'pending',
          operationId: spend.operationId,
          digest: spend.digest,
          amountMist: spend.amountMist,
          error: 'Sponsor Refill Account RPC boundaries disagree on the transaction result',
        };
      }
      return null;
    } catch (error) {
      throwIfSpendAborted(context);
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: normalizeSponsorOperationsLastError(error),
      };
    }
  }

  async function prepareReservedSpend(
    spend: ReservedSponsorRefillAccountSpend,
    context: SpendExecutionContext,
  ): Promise<SponsorRefillAccountSpendResult | SponsorRefillAccountSpend> {
    throwIfSpendAborted(context);
    let built: BuiltSponsorRefillAccountSpend;
    const preparationDeadlineMs = Date.now() + deps.settings.refillTimeoutMs;
    try {
      built = await withTimeout(
        'sponsorRefillAccountSpend.buildAndSign',
        remainingTimeout(preparationDeadlineMs, 'sponsorRefillAccountSpend.buildAndSign'),
        (operationSignal) =>
          deps.boundary.buildAndSign(
            spend.destinationAddress,
            BigInt(spend.amountMist),
            operationSignal,
          ),
        context.signal,
      );
      throwIfSpendAborted(context);
    } catch (error) {
      throwIfSpendAborted(context);
      return pendingReserved(spend, error);
    }
    let simulation: { success: boolean; error: string | null };
    try {
      simulation = await withTimeout(
        'sponsorRefillAccountSpend.simulate',
        remainingTimeout(preparationDeadlineMs, 'sponsorRefillAccountSpend.simulate'),
        (operationSignal) => deps.boundary.simulate(built.transactionBytes, operationSignal),
        context.signal,
      );
      throwIfSpendAborted(context);
    } catch (error) {
      throwIfSpendAborted(context);
      return pendingReserved(spend, error);
    }
    if (!simulation.success) {
      return failReserved(
        spend,
        simulation.error ?? 'Sponsor Refill Account simulation failed',
        'failed',
        null,
        context,
      );
    }

    const accountCursor = await deps.state.readAccountObservationCursor();
    throwIfSpendAborted(context);
    if (
      accountCursor.operationId !== spend.operationId ||
      accountCursor.spendSequence !== spend.sequence
    ) {
      return (await deps.state.read()) ?? spend;
    }
    const sourceObservation = await sourceAccountObservation(context);
    if (sourceObservation.balance === null) {
      return pendingReserved(spend, sourceObservation.fields.lastError);
    }
    const postBalance = sourceObservation.balance - BigInt(spend.amountMist) - built.gasBudgetMist;
    if (postBalance < sourceRunwayMist) {
      const requiredSourceBalanceMist =
        sourceRunwayMist + BigInt(spend.amountMist) + built.gasBudgetMist;
      return failReserved(
        spend,
        `Sponsor Refill Account spend would leave ${postBalance.toString()} MIST below runway ${sourceRunwayMist.toString()} MIST`,
        'runway_blocked',
        spend.kind === 'refill' && requiredSourceBalanceMist <= U64_MAX
          ? requiredSourceBalanceMist
          : null,
        context,
      );
    }

    const ready = await deps.state.markReady({
      operationId: spend.operationId,
      expectedSequence: spend.sequence,
      expectedAccountWriteSequence: accountCursor.writeSequence,
      gasBudgetMist: built.gasBudgetMist.toString(),
      transactionBytesBase64: toBase64(built.transactionBytes),
      signature: built.signature,
      digest: built.digest,
      sourceBalanceMist: sourceObservation.balance.toString(),
    });
    return ready ?? (await deps.state.read()) ?? spend;
  }

  async function observeRefillTerminal(
    spend: ReconcilingSponsorRefillAccountSpend,
    chainResult: SponsorRefillAccountChainResult,
    context: SpendExecutionContext,
  ): Promise<
    | { readonly status: 'not_applicable' }
    | {
        readonly status: 'observed';
        readonly address: string;
        readonly addressBalanceMist: string;
        readonly lastError: string;
      }
  > {
    throwIfSpendAborted(context);
    if (spend.slotAddress === null) return { status: 'not_applicable' };
    if (!chainResult.success) {
      try {
        const balance = await withTimeout(
          `sponsorRefillAccountSpend.getFailedSlotBalance(${spend.slotAddress})`,
          deps.settings.sponsorRefillAccountBalanceTimeoutMs,
          (operationSignal) => deps.boundary.getAddressBalance(spend.slotAddress!, operationSignal),
          context.signal,
        );
        throwIfSpendAborted(context);
        return {
          status: 'observed',
          address: spend.slotAddress,
          addressBalanceMist: balance.toString(),
          lastError: normalizeSponsorOperationsLastError(chainResult.error ?? 'refill failed'),
        };
      } catch (error) {
        throwIfSpendAborted(context);
        return {
          status: 'observed',
          address: spend.slotAddress,
          addressBalanceMist: '',
          lastError: normalizeSponsorOperationsLastError(error),
        };
      }
    }

    try {
      const balance = await withTimeout(
        `sponsorRefillAccountSpend.observeSlot(${spend.slotAddress})`,
        deps.settings.confirmationTimeoutMs,
        (operationSignal) => deps.boundary.getAddressBalance(spend.slotAddress!, operationSignal),
        context.signal,
      );
      throwIfSpendAborted(context);
      return {
        status: 'observed',
        address: spend.slotAddress,
        addressBalanceMist: balance.toString(),
        lastError: '',
      };
    } catch (error) {
      throwIfSpendAborted(context);
      return {
        status: 'observed',
        address: spend.slotAddress,
        addressBalanceMist: '',
        lastError: normalizeSponsorOperationsLastError(error),
      };
    }
  }

  async function reconcileSpend(
    spend: ReconcilingSponsorRefillAccountSpend,
    context: SpendExecutionContext,
  ): Promise<SponsorRefillAccountSpendResult> {
    throwIfSpendAborted(context);
    const chainResult: SponsorRefillAccountChainResult = {
      digest: spend.digest,
      success: spend.chainResult === 'succeeded',
      error: spend.chainResult === 'failed' ? spend.error : null,
    };
    const chainVisibility = await requireVisibleChainResult(
      spend,
      `sponsorRefillAccountSpend.confirm(${spend.digest})`,
      context,
    );
    if (chainVisibility !== null) return chainVisibility;
    const accountCursor = await deps.state.readAccountObservationCursor();
    throwIfSpendAborted(context);
    if (
      accountCursor.operationId !== spend.operationId ||
      accountCursor.spendSequence !== spend.sequence
    ) {
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: 'Sponsor Refill Account changed before reconciliation observation',
      };
    }
    const slotBefore =
      spend.slotAddress === null ? null : await deps.operationsState.readSlot(spend.slotAddress);
    throwIfSpendAborted(context);
    if (
      spend.slotAddress !== null &&
      (slotBefore === null ||
        slotBefore.refillOperationId !== spend.operationId ||
        slotBefore.refillOperationSequence !== spend.sequence ||
        slotBefore.refillOperationState !== 'reconciling')
    ) {
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: 'Sponsor refill slot projection changed before reconciliation observation',
      };
    }
    const slotObservation = await observeRefillTerminal(spend, chainResult, context);
    const accountObservation = await sourceAccountObservation(context);
    throwIfSpendAborted(context);
    const completed = await deps.state.complete({
      operationId: spend.operationId,
      expectedSequence: spend.sequence,
      expectedAccountWriteSequence: accountCursor.writeSequence,
      state: chainResult.success ? 'succeeded' : 'failed',
      lastError: normalizeSponsorOperationsLastError(chainResult.error ?? ''),
      account: accountObservation.fields,
      slot:
        slotObservation.status === 'not_applicable'
          ? null
          : {
              address: slotObservation.address,
              addressBalanceMist: slotObservation.addressBalanceMist,
              lastError: slotObservation.lastError,
              expectedWriteSequence: slotBefore!.writeSeq,
            },
    });
    if (completed === null) {
      const current = await deps.state.read();
      if (
        current !== null &&
        current.operationId === spend.operationId &&
        !isActiveSponsorRefillAccountSpend(current)
      ) {
        return driveSpend(current, context);
      }
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: 'Sponsor Refill Account changed during reconciliation observation',
      };
    }

    return projectTerminalSpend(completed);
  }

  async function beginReconciliation(
    spend: ReadySponsorRefillAccountSpend,
    chainResult: SponsorRefillAccountChainResult,
    context: SpendExecutionContext,
  ): Promise<SponsorRefillAccountSpendResult> {
    throwIfSpendAborted(context);
    const next = await deps.state.markReconciling({
      operationId: spend.operationId,
      expectedSequence: spend.sequence,
      chainResult: chainResult.success ? 'succeeded' : 'failed',
      lastError: normalizeSponsorOperationsLastError(chainResult.error ?? ''),
    });
    const current = next ?? (await deps.state.read());
    throwIfSpendAborted(context);
    if (current === null || current.operationId !== spend.operationId) {
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: 'Sponsor Refill Account reconciliation was superseded',
      };
    }
    return driveSpend(current, context);
  }

  async function driveReadySpend(
    spend: ReadySponsorRefillAccountSpend,
    context: SpendExecutionContext,
  ): Promise<SponsorRefillAccountSpendResult> {
    throwIfSpendAborted(context);
    const transactionBytes = fromBase64(spend.transactionBytesBase64);
    await deps.boundary.validateSignedIdentity({
      sourceAddress: spend.sourceAddress,
      destinationAddress: spend.destinationAddress,
      amountMist: BigInt(spend.amountMist),
      gasBudgetMist: BigInt(spend.gasBudgetMist),
      transactionBytes,
      signature: spend.signature,
      digest: spend.digest,
    });
    throwIfSpendAborted(context);
    let lookup: SponsorRefillAccountTransactionLookup;
    try {
      lookup = await withTimeout(
        `sponsorRefillAccountSpend.lookup(${spend.digest})`,
        deps.settings.confirmationTimeoutMs,
        (operationSignal) => deps.boundary.lookup(spend.digest, operationSignal),
        context.signal,
      );
      throwIfSpendAborted(context);
    } catch (error) {
      throwIfSpendAborted(context);
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: normalizeSponsorOperationsLastError(error),
      };
    }
    if (lookup.status === 'found') return beginReconciliation(spend, lookup.result, context);

    try {
      const result = await withTimeout(
        `sponsorRefillAccountSpend.submit(${spend.digest})`,
        deps.settings.refillTimeoutMs,
        (operationSignal) =>
          deps.boundary.submit(transactionBytes, spend.signature, spend.digest, operationSignal),
        context.signal,
      );
      throwIfSpendAborted(context);
      return beginReconciliation(spend, result, context);
    } catch (submitError) {
      throwIfSpendAborted(context);
      try {
        const afterSubmit = await withTimeout(
          `sponsorRefillAccountSpend.lookupAfterSubmit(${spend.digest})`,
          deps.settings.confirmationTimeoutMs,
          (operationSignal) => deps.boundary.lookup(spend.digest, operationSignal),
          context.signal,
        );
        throwIfSpendAborted(context);
        if (afterSubmit.status === 'found') {
          return beginReconciliation(spend, afterSubmit.result, context);
        }
      } catch {
        throwIfSpendAborted(context);
        // Lookup uncertainty must not be converted into proof that the digest is absent.
      }
      return {
        status: 'pending',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        error: normalizeSponsorOperationsLastError(submitError),
      };
    }
  }

  async function driveSpend(
    spend: SponsorRefillAccountSpend,
    context: SpendExecutionContext,
  ): Promise<SponsorRefillAccountSpendResult> {
    throwIfSpendAborted(context);
    if (spend.network !== deps.settings.network) {
      throw new Error('Sponsor Refill Account active spend belongs to a different network');
    }
    if (spend.sourceAddress !== deps.settings.sponsorRefillAccountAddress) {
      throw new Error('Sponsor Refill Account active spend belongs to a different source address');
    }
    if (spend.state === 'reserved') {
      const intent = context.authorizedReservedIntent;
      const authorized =
        intent !== undefined &&
        intent.operationId === spend.operationId &&
        intent.kind === spend.kind &&
        intent.sourceAddress === spend.sourceAddress &&
        intent.destinationAddress === spend.destinationAddress &&
        intent.slotAddress === spend.slotAddress &&
        intent.nonceKey === spend.nonceKey &&
        intent.amountMist === spend.amountMist;
      if (!authorized) {
        return failReserved(
          spend,
          'Reserved Sponsor Refill Account spend cannot be signed during recovery',
          'failed',
          null,
          { signal: context.signal },
        );
      }
      const prepared = await prepareReservedSpend(spend, context);
      if ('status' in prepared) return prepared;
      if (prepared.operationId !== spend.operationId) {
        return {
          status: 'pending',
          operationId: spend.operationId,
          digest: null,
          amountMist: spend.amountMist,
          error: 'Sponsor Refill Account spend was superseded during preparation',
        };
      }
      return driveSpend(prepared, context);
    }
    if (spend.state === 'ready') return driveReadySpend(spend, context);
    if (spend.state === 'reconciling') return reconcileSpend(spend, context);
    return projectTerminalSpend(spend);
  }

  function projectTerminalSpend(
    spend: TerminalSponsorRefillAccountSpend,
  ): SponsorRefillAccountSpendResult {
    if (spend.kind === 'withdrawal') {
      return projectWithdrawalTerminalResult(
        spend.state === 'succeeded'
          ? {
              status: 'succeeded',
              operationId: spend.operationId,
              sourceAddress: spend.sourceAddress,
              destinationAddress: spend.destinationAddress,
              amountMist: spend.amountMist,
              digest: spend.digest,
            }
          : {
              status: spend.failureKind,
              operationId: spend.operationId,
              sourceAddress: spend.sourceAddress,
              destinationAddress: spend.destinationAddress,
              amountMist: spend.amountMist,
              digest: spend.digest,
              error: spend.error,
            },
      );
    }
    if (spend.state === 'succeeded') {
      return {
        status: 'succeeded',
        operationId: spend.operationId,
        digest: spend.digest,
        amountMist: spend.amountMist,
        destinationAddress: spend.destinationAddress,
      };
    }
    return {
      status: spend.failureKind,
      operationId: spend.operationId,
      digest: spend.digest,
      amountMist: spend.amountMist,
      error: spend.error,
    };
  }

  function projectWithdrawalTerminalResult(
    result: SponsorRefillAccountWithdrawalTerminalResult,
  ): SponsorRefillAccountSpendResult {
    if (result.status === 'succeeded') {
      return {
        status: 'succeeded',
        operationId: result.operationId,
        digest: result.digest,
        amountMist: result.amountMist,
        destinationAddress: result.destinationAddress,
      };
    }
    return {
      status: result.status,
      operationId: result.operationId,
      digest: result.digest,
      amountMist: result.amountMist,
      error: result.error,
    };
  }

  async function resolveWithdrawalReceipt(
    receipt: SponsorRefillAccountWithdrawalReceipt,
    input: {
      readonly operationId: string;
      readonly destinationAddress: string;
      readonly amountMist: string;
    },
    context: SpendExecutionContext,
  ): Promise<SponsorRefillAccountSpendResult | null> {
    throwIfSpendAborted(context);
    if (receipt.type === 'issued') return null;
    const identity = receipt.type === 'terminal' ? receipt.result : receipt;
    if (
      identity.operationId !== input.operationId ||
      identity.sourceAddress !== deps.settings.sponsorRefillAccountAddress ||
      identity.destinationAddress !== input.destinationAddress ||
      identity.amountMist !== input.amountMist
    ) {
      return { status: 'nonce_missing' };
    }
    if (receipt.type === 'terminal') {
      return projectWithdrawalTerminalResult(receipt.result);
    }
    const current = await deps.state.read();
    throwIfSpendAborted(context);
    if (current === null || current.operationId !== receipt.operationId) {
      throw new Error(
        'Sponsor Refill Account accepted withdrawal receipt has no matching durable spend',
      );
    }
    return driveSpend(current, context);
  }

  async function recoverCurrentSpend(
    context: SpendExecutionContext,
  ): Promise<SponsorRefillAccountSpendResult | null> {
    throwIfSpendAborted(context);
    const current = await deps.state.read();
    throwIfSpendAborted(context);
    return isActiveSponsorRefillAccountSpend(current) ? driveSpend(current, context) : null;
  }

  function busyBehindDifferentSpend(
    blockingSpend: SponsorRefillAccountSpend,
    recovered: SponsorRefillAccountSpendResult,
  ): SponsorRefillAccountSpendResult {
    return {
      status: 'busy',
      operationId: blockingSpend.operationId,
      digest: spendDigest(blockingSpend),
      error:
        recovered.status === 'pending'
          ? recovered.error
          : 'A previous Sponsor Refill Account spend was recovered; this request was not accepted',
    };
  }

  async function executeReserved(
    input: {
      readonly operationId: string;
      readonly kind: 'withdrawal' | 'refill';
      readonly destinationAddress: string;
      readonly amountMist: string;
      readonly observedSlotAddressBalanceMist: string | null;
      readonly expectedSlotWriteSequence: number | null;
      readonly expectedSourceObservationWriteSequence: number | null;
      readonly nonceKey: string | null;
    },
    context: SpendExecutionContext,
  ): Promise<SponsorRefillAccountSpendResult | { readonly status: 'source_changed' }> {
    throwIfSpendAborted(context);
    const reservation = await deps.state.reserve({
      operationId: input.operationId,
      kind: input.kind,
      sourceAddress: deps.settings.sponsorRefillAccountAddress,
      destinationAddress: input.destinationAddress,
      slotAddress: input.kind === 'refill' ? input.destinationAddress : null,
      amountMist: input.amountMist,
      observedSlotAddressBalanceMist: input.observedSlotAddressBalanceMist,
      expectedSlotWriteSequence: input.expectedSlotWriteSequence,
      expectedSourceObservationWriteSequence: input.expectedSourceObservationWriteSequence,
      nonceKey: input.nonceKey,
    });
    throwIfSpendAborted(context);
    if (reservation.status === 'receipt') {
      if (input.kind !== 'withdrawal') {
        throw new Error('Sponsor Refill Account refill reservation returned a withdrawal receipt');
      }
      const result = await resolveWithdrawalReceipt(reservation.receipt, input, context);
      if (result === null) {
        throw new Error('Sponsor Refill Account reservation left an issued receipt unconsumed');
      }
      return result;
    }
    if (reservation.status === 'nonce_missing') return { status: 'nonce_missing' };
    if (reservation.status === 'source_changed') return { status: 'source_changed' };
    if (reservation.status === 'slot_changed') {
      return {
        status: 'pending',
        operationId: input.operationId,
        digest: null,
        amountMist: input.amountMist,
        error: 'Sponsor refill slot changed before reservation',
      };
    }
    if (reservation.status === 'active') {
      const sameRequest =
        reservation.spend.operationId === input.operationId ||
        (input.kind === 'refill' &&
          reservation.spend.kind === 'refill' &&
          reservation.spend.slotAddress === input.destinationAddress);
      const activeResult = await driveSpend(reservation.spend, { signal: context.signal });
      if (sameRequest) return activeResult;
      return busyBehindDifferentSpend(reservation.spend, activeResult);
    }
    return driveSpend(reservation.spend, {
      signal: context.signal,
      authorizedReservedIntent: {
        operationId: input.operationId,
        kind: input.kind,
        sourceAddress: deps.settings.sponsorRefillAccountAddress,
        destinationAddress: input.destinationAddress,
        slotAddress: input.kind === 'refill' ? input.destinationAddress : null,
        nonceKey: input.nonceKey,
        amountMist: input.amountMist,
      },
    });
  }

  async function withAccountLock<T>(
    context: SpendExecutionContext,
    task: () => Promise<T>,
  ): Promise<T> {
    const handle = await acquireDispatchLock(context);
    try {
      return await task();
    } finally {
      try {
        await deps.dispatchLock.release(handle);
      } catch {
        // The lock is an expiring efficiency mutex. A release transport error must not
        // replace the result already committed by the durable operation CAS.
      }
    }
  }

  async function withdraw(input: {
    readonly destinationAddress: string;
    readonly amountMist: string;
    readonly nonceKey: string;
    readonly signal?: AbortSignal;
  }): Promise<SponsorRefillAccountSpendResult> {
    const context: SpendExecutionContext = { signal: input.signal };
    throwIfSpendAborted(context);
    if (!isPositiveU64DecimalString(input.amountMist)) {
      throw new Error('Withdrawal amount must be a positive u64 decimal string');
    }
    const destinationAddress = requireAddress(
      input.destinationAddress,
      'Withdrawal destinationAddress',
    );
    if (!input.nonceKey) throw new Error('Withdrawal nonceKey must be non-empty');
    const operationId = createSponsorRefillAccountWithdrawalOperationId({
      network: deps.settings.network,
      sourceAddress: deps.settings.sponsorRefillAccountAddress,
      destinationAddress,
      amountMist: input.amountMist,
      nonceKey: input.nonceKey,
    });
    return withAccountLock(context, async () => {
      const receipt = await deps.state.readWithdrawalReceipt(input.nonceKey);
      if (receipt !== null) {
        const receiptResult = await resolveWithdrawalReceipt(
          receipt,
          {
            operationId,
            destinationAddress,
            amountMist: input.amountMist,
          },
          context,
        );
        if (receiptResult !== null) return receiptResult;
      }
      const current = await deps.state.read();
      if (current?.operationId === operationId) {
        return driveSpend(current, context);
      }
      if (isActiveSponsorRefillAccountSpend(current)) {
        const recovered = await driveSpend(current, context);
        return busyBehindDifferentSpend(current, recovered);
      }
      const result = await executeReserved(
        {
          operationId,
          kind: 'withdrawal',
          destinationAddress,
          amountMist: input.amountMist,
          observedSlotAddressBalanceMist: null,
          expectedSlotWriteSequence: null,
          expectedSourceObservationWriteSequence: null,
          nonceKey: input.nonceKey,
        },
        context,
      );
      if (result.status === 'source_changed') {
        throw new Error('Withdrawal reservation unexpectedly carried source-balance evidence');
      }
      return result;
    });
  }

  async function refill(
    slotAddress: string,
    reason: SponsorRefillAccountRefillReason,
    signal?: AbortSignal,
  ): Promise<SponsorRefillAccountRefillResult> {
    const context: SpendExecutionContext = { signal };
    throwIfSpendAborted(context);
    const normalizedSlotAddress = requireAddress(slotAddress, 'Refill slotAddress');
    if (!deps.settings.sponsorAddresses.includes(normalizedSlotAddress)) {
      throw new Error('Refill slotAddress is not a configured sponsor address');
    }
    const refillTargetMist = deps.settings.refillTargetMist;
    if (!deps.settings.refillEnabled || refillTargetMist === null) {
      return {
        status: 'failed',
        operationId: randomUUID(),
        digest: null,
        amountMist: '0',
        error: 'refill disabled or target not configured',
      };
    }
    return withAccountLock(context, async () => {
      const current = await deps.state.read();
      throwIfSpendAborted(context);
      if (isActiveSponsorRefillAccountSpend(current)) {
        const sameSlot = current.kind === 'refill' && current.slotAddress === normalizedSlotAddress;
        const recovered = await driveSpend(current, context);
        if (sameSlot) return recovered;
        return busyBehindDifferentSpend(current, recovered);
      }

      let expectedSourceObservationWriteSequence: number | null = null;
      const snapshot = await deps.operationsState.readAll();
      throwIfSpendAborted(context);
      const observedSlot =
        snapshot.slots.find((slot) => slot.address === normalizedSlotAddress) ?? null;
      if (observedSlot === null) {
        throw new Error('Sponsor refill targeted an unknown slot');
      }
      if (!isAutomaticSponsorRefillEligible(observedSlot, snapshot.sponsorRefillAccount, reason)) {
        return { status: 'not_eligible', slotAddress: normalizedSlotAddress };
      }
      if (observedSlot.refillRequiredSourceBalanceMist !== null) {
        expectedSourceObservationWriteSequence = snapshot.sponsorRefillAccount.writeSeq;
      }
      const expectedWriteSeq = observedSlot.writeSeq;
      const balance = await withTimeout(
        `sponsorRefillAccountSpend.getSlotBalance(${normalizedSlotAddress})`,
        deps.settings.sponsorRefillAccountBalanceTimeoutMs,
        (operationSignal) =>
          deps.boundary.getAddressBalance(normalizedSlotAddress, operationSignal),
        signal,
      );
      throwIfSpendAborted(context);
      const amountMist = balance >= refillTargetMist ? 0n : refillTargetMist - balance;
      if (amountMist === 0n) {
        const updated = await deps.operationsState.updateSlotIfWriteSeq(
          normalizedSlotAddress,
          expectedWriteSeq,
          {
            addressBalanceMist: balance.toString(),
            lastError: '',
          },
        );
        if (!updated) {
          throw new Error('Sponsor refill slot changed while recording the fresh balance');
        }
        return {
          status: 'not_needed',
          slotAddress: normalizedSlotAddress,
          addressBalanceMist: balance.toString(),
        };
      }
      const result = await executeReserved(
        {
          operationId: randomUUID(),
          kind: 'refill',
          destinationAddress: normalizedSlotAddress,
          amountMist: amountMist.toString(),
          observedSlotAddressBalanceMist: balance.toString(),
          expectedSlotWriteSequence: expectedWriteSeq,
          expectedSourceObservationWriteSequence,
          nonceKey: null,
        },
        context,
      );
      return result.status === 'source_changed'
        ? { status: 'not_eligible', slotAddress: normalizedSlotAddress }
        : result;
    });
  }

  async function recoverActiveSpend(
    signal: AbortSignal,
  ): Promise<SponsorRefillAccountSpendResult | null> {
    // A process may restart while the efficiency lock from the dead process still has TTL.
    // Durable operation/sequence CAS and the stored transaction identity make recovery safe
    // without waiting for that stale mutex.
    return recoverCurrentSpend({ signal });
  }

  return { withdraw, refill, recoverActiveSpend };
}
