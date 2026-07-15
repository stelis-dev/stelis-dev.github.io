import { TransactionDataBuilder } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { fromBase58, normalizeSuiAddress, toBase58 } from '@mysten/sui/utils';
import {
  createSuiEndpointSnapshot,
  type SuiEndpointSnapshot,
  type SuiExecutionError,
  type SuiTransactionResult,
  type SuiTransactionWithEventsResult,
} from '@stelis/core-relay';

/**
 * Create a real opaque endpoint snapshot for tests that mock the gateway
 * operation they exercise. The client intentionally exposes only the current
 * SuiGrpcClient network identity; tests must not reach through the snapshot to
 * raw client methods.
 */
export function suiEndpointSnapshotFixture(
  network: 'testnet' | 'mainnet' = 'testnet',
): SuiEndpointSnapshot {
  const client = Object.freeze({ network }) as unknown as SuiGrpcClient;
  return createSuiEndpointSnapshot([client]);
}

export interface TestGasUsed {
  readonly computationCost: string;
  readonly storageCost: string;
  readonly storageRebate: string;
  readonly nonRefundableStorageFee?: string;
}

const DEFAULT_GAS_USED: TestGasUsed = {
  computationCost: '1000000',
  storageCost: '500000',
  storageRebate: '200000',
  nonRefundableStorageFee: '0',
};

export function suiTransactionDigestFixture(fill = 1): string {
  if (!Number.isInteger(fill) || fill < 0 || fill > 255) {
    throw new TypeError('Sui transaction digest fixture fill must be a byte');
  }
  return toBase58(new Uint8Array(32).fill(fill));
}

export const TEST_SUI_TRANSACTION_DIGEST = suiTransactionDigestFixture();

function requireCurrentSuiTransactionDigest(digest: string): string {
  let bytes: Uint8Array;
  try {
    bytes = fromBase58(digest);
  } catch {
    throw new TypeError('Sui transaction digest fixture must be canonical base58');
  }
  if (bytes.length !== 32 || toBase58(bytes) !== digest) {
    throw new TypeError('Sui transaction digest fixture must encode exactly 32 bytes');
  }
  return digest;
}

function gasUsed(value: TestGasUsed) {
  return Object.freeze({
    computationCost: value.computationCost,
    storageCost: value.storageCost,
    storageRebate: value.storageRebate,
    nonRefundableStorageFee: value.nonRefundableStorageFee ?? '0',
  });
}

function successEffects(digest: string, value: TestGasUsed) {
  const transactionDigest = requireCurrentSuiTransactionDigest(digest);
  return Object.freeze({
    version: 2 as const,
    transactionDigest,
    status: { success: true, error: null } as const,
    gasUsed: gasUsed(value),
    eventsDigest: null,
  });
}

function failureEffects(digest: string, value: TestGasUsed, error: SuiExecutionError) {
  const transactionDigest = requireCurrentSuiTransactionDigest(digest);
  return Object.freeze({
    version: 2 as const,
    transactionDigest,
    status: { success: false, error } as const,
    gasUsed: gasUsed(value),
    eventsDigest: null,
  });
}

export function bindSuiResultToTransactionBytes<
  T extends SuiTransactionResult | SuiTransactionWithEventsResult,
>(result: T, transaction: Uint8Array): T {
  const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
  return {
    ...result,
    digest,
    effects: { ...result.effects, transactionDigest: digest },
  } as T;
}

export function unclassifiedSuiExecutionError(): SuiExecutionError {
  return Object.freeze({ kind: 'InvariantViolation' });
}

export interface MoveAbortFixture {
  readonly command?: number;
  readonly packageId?: string;
  readonly module?: string;
  readonly functionIndex?: number;
  readonly functionName?: string;
  readonly instruction?: number;
  readonly abortCode: string;
  readonly constantName?: string;
}

export function moveAbortSuiExecutionError(input: MoveAbortFixture): SuiExecutionError {
  const moveAbort = Object.freeze({
    abortCode: input.abortCode,
    ...(input.packageId === undefined ? {} : { packageId: normalizeSuiAddress(input.packageId) }),
    ...(input.module === undefined ? {} : { module: input.module }),
    ...(input.functionIndex === undefined ? {} : { functionIndex: input.functionIndex }),
    ...(input.functionName === undefined ? {} : { functionName: input.functionName }),
    ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
    ...(input.constantName === undefined ? {} : { constantName: input.constantName }),
  });
  return Object.freeze({
    kind: 'MoveAbort' as const,
    ...(input.command === undefined ? {} : { command: input.command }),
    moveAbort,
  });
}

export function congestedSuiExecutionError(): SuiExecutionError {
  return Object.freeze({ kind: 'CongestedObjects' });
}

export function suiSimulationSuccess(
  digest = TEST_SUI_TRANSACTION_DIGEST,
  value: TestGasUsed = DEFAULT_GAS_USED,
): SuiTransactionResult {
  return Object.freeze({
    outcome: 'success' as const,
    digest,
    effects: successEffects(digest, value),
  });
}

export function suiSimulationFailure(
  digest: string,
  error: SuiExecutionError,
  value: TestGasUsed = DEFAULT_GAS_USED,
): SuiTransactionResult {
  return Object.freeze({
    outcome: 'failure' as const,
    digest,
    effects: failureEffects(digest, value, error),
    error,
  });
}

export function suiExecutionSuccess(
  digest = TEST_SUI_TRANSACTION_DIGEST,
  value: TestGasUsed = DEFAULT_GAS_USED,
): SuiTransactionWithEventsResult {
  return Object.freeze({
    outcome: 'success' as const,
    digest,
    effects: successEffects(digest, value),
    events: Object.freeze([]),
  });
}

export function suiExecutionFailure(
  digest: string,
  error: SuiExecutionError,
  value: TestGasUsed = DEFAULT_GAS_USED,
): SuiTransactionWithEventsResult {
  return Object.freeze({
    outcome: 'failure' as const,
    digest,
    effects: failureEffects(digest, value, error),
    error,
    events: Object.freeze([]),
  });
}
