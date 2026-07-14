import type { SuiClientTypes } from '@mysten/sui/client';
import { TransactionDataBuilder } from '@mysten/sui/transactions';

export interface TestGasUsed {
  readonly computationCost: string;
  readonly storageCost: string;
  readonly storageRebate: string;
  readonly nonRefundableStorageFee?: string;
}

type ExecutionResult = SuiClientTypes.TransactionResult<{ effects: true; events: true }>;
type SimulationResult = SuiClientTypes.SimulateTransactionResult<{ effects: true }>;

const DEFAULT_GAS_USED: TestGasUsed = {
  computationCost: '1000000',
  storageCost: '500000',
  storageRebate: '200000',
  nonRefundableStorageFee: '0',
};

/**
 * Bind an otherwise intentional RPC fixture shape to the transaction passed
 * to a mock Sui client. Real RPC terminals cannot choose an unrelated digest;
 * tests for malformed unions remain malformed because this helper changes
 * only the terminal identity fields.
 */
export function bindGrpcResultToTransactionBytes<T>(result: T, transaction: Uint8Array): T {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const kind = record.$kind;
  if (kind !== 'Transaction' && kind !== 'FailedTransaction') return result;
  const payload = record[kind];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return result;

  const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
  const payloadRecord = payload as Record<string, unknown>;
  const effectsValue = payloadRecord.effects;
  const effectsRecord =
    typeof effectsValue === 'object' && effectsValue !== null && !Array.isArray(effectsValue)
      ? { ...(effectsValue as Record<string, unknown>), transactionDigest: digest }
      : effectsValue;

  return {
    ...record,
    [kind]: {
      ...payloadRecord,
      digest,
      effects: effectsRecord,
    },
  } as T;
}

function gasSummary(gasUsed: TestGasUsed): SuiClientTypes.GasCostSummary {
  return {
    computationCost: gasUsed.computationCost,
    storageCost: gasUsed.storageCost,
    storageRebate: gasUsed.storageRebate,
    nonRefundableStorageFee: gasUsed.nonRefundableStorageFee ?? '0',
  };
}

function effects(
  digest: string,
  status: SuiClientTypes.ExecutionStatus,
  gasUsed: TestGasUsed,
): SuiClientTypes.TransactionEffects {
  return {
    bcs: null,
    version: 2,
    status,
    gasUsed: gasSummary(gasUsed),
    transactionDigest: digest,
    gasObject: null,
    eventsDigest: null,
    dependencies: [],
    lamportVersion: null,
    changedObjects: [],
    unchangedConsensusObjects: [],
    auxiliaryDataDigest: null,
  };
}

function executionTransaction(
  digest: string,
  status: SuiClientTypes.ExecutionStatus,
  gasUsed: TestGasUsed,
): SuiClientTypes.Transaction<{ effects: true; events: true }> {
  return {
    digest,
    signatures: [],
    epoch: null,
    status,
    balanceChanges: undefined,
    effects: effects(digest, status, gasUsed),
    events: [],
    objectTypes: undefined,
    transaction: undefined,
    bcs: undefined,
  };
}

function simulationTransaction(
  digest: string,
  status: SuiClientTypes.ExecutionStatus,
  gasUsed: TestGasUsed,
): SuiClientTypes.Transaction<{ effects: true }> {
  return {
    digest,
    signatures: [],
    epoch: null,
    status,
    balanceChanges: undefined,
    effects: effects(digest, status, gasUsed),
    events: undefined,
    objectTypes: undefined,
    transaction: undefined,
    bcs: undefined,
  };
}

export function unknownExecutionError(message: string): SuiClientTypes.ExecutionError {
  return {
    $kind: 'Unknown',
    message,
    Unknown: null,
  };
}

export function moveAbortExecutionError(
  message: string,
  abortCode = '0',
): SuiClientTypes.ExecutionError {
  return {
    $kind: 'MoveAbort',
    message,
    MoveAbort: { abortCode },
  };
}

export function congestedObjectsExecutionError(
  message = 'Execution canceled due to shared-object congestion',
): SuiClientTypes.ExecutionError {
  return {
    $kind: 'CongestedObjects',
    message,
    CongestedObjects: {
      name: 'ExecutionCanceledDueToConsensusObjectCongestion',
      objects: [],
    },
  };
}

export function grpcExecutionSuccess(
  digest = '0xexecution-success',
  gasUsed: TestGasUsed = DEFAULT_GAS_USED,
): Extract<ExecutionResult, { $kind: 'Transaction' }> {
  const status = { success: true, error: null } as const satisfies SuiClientTypes.ExecutionStatus;
  return {
    $kind: 'Transaction',
    Transaction: executionTransaction(digest, status, gasUsed),
  };
}

export function grpcExecutionFailure(
  digest: string,
  error: SuiClientTypes.ExecutionError,
  gasUsed: TestGasUsed = DEFAULT_GAS_USED,
): Extract<ExecutionResult, { $kind: 'FailedTransaction' }> {
  const status = { success: false, error } as const satisfies SuiClientTypes.ExecutionStatus;
  return {
    $kind: 'FailedTransaction',
    FailedTransaction: executionTransaction(digest, status, gasUsed),
  };
}

export function grpcSimulationSuccess(
  digest = '0xsimulation-success',
  gasUsed: TestGasUsed = DEFAULT_GAS_USED,
): Extract<SimulationResult, { $kind: 'Transaction' }> {
  const status = { success: true, error: null } as const satisfies SuiClientTypes.ExecutionStatus;
  return {
    $kind: 'Transaction',
    Transaction: simulationTransaction(digest, status, gasUsed),
    commandResults: undefined,
  };
}

export function grpcSimulationFailure(
  digest: string,
  error: SuiClientTypes.ExecutionError,
  gasUsed: TestGasUsed = DEFAULT_GAS_USED,
): Extract<SimulationResult, { $kind: 'FailedTransaction' }> {
  const status = { success: false, error } as const satisfies SuiClientTypes.ExecutionStatus;
  return {
    $kind: 'FailedTransaction',
    FailedTransaction: simulationTransaction(digest, status, gasUsed),
    commandResults: undefined,
  };
}
