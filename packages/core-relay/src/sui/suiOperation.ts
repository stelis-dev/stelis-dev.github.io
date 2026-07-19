import { RpcError } from '@protobuf-ts/runtime-rpc';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { isValidTransactionDigest } from '@mysten/sui/utils';
import type { SuiExecutionError } from './suiTransactionShape.js';

/** Fixed timeout for one current Sui RPC attempt. */
export const SUI_OPERATION_ATTEMPT_TIMEOUT_MS = 30_000;

export type SuiOperationName =
  | 'resolve_transaction'
  | 'simulate_transaction'
  | 'simulate_move_view'
  | 'execute_transaction'
  | 'get_transaction_effects'
  | 'get_transaction_events'
  | 'get_transaction_balance_changes'
  | 'get_object'
  | 'get_objects'
  | 'get_dynamic_field'
  | 'list_coins'
  | 'get_coin_metadata'
  | 'get_balance'
  | 'get_chain_identifier';

export type SuiOperationErrorKind =
  | 'aborted'
  | 'deadline_exceeded'
  | 'internal_error'
  | 'invalid_request'
  | 'malformed_response'
  | 'not_found'
  | 'rpc_rejected'
  | 'transport_unavailable';

export interface SuiOperationDiagnostic {
  readonly operation: SuiOperationName;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly rpcCode?: string;
  /** Exact requested object ID, transaction digest, or coin type for a bound absence. */
  readonly resourceId?: string;
}

const ERROR_MESSAGES: Readonly<Record<SuiOperationErrorKind, string>> = Object.freeze({
  aborted: 'Sui operation was aborted',
  deadline_exceeded: 'Sui operation deadline was exceeded',
  internal_error: 'Sui operation failed internally',
  invalid_request: 'Sui operation request was invalid',
  malformed_response: 'Sui operation returned a malformed response',
  not_found: 'Sui operation resource was not found',
  rpc_rejected: 'Sui RPC rejected the operation',
  transport_unavailable: 'Sui RPC transport was unavailable',
});

/**
 * Closed internal error vocabulary for Sui operations.
 *
 * Diagnostics deliberately exclude endpoint URLs and provider messages. Domain
 * callers map this error through their own public error authority.
 */
export class SuiOperationError extends Error {
  override readonly name = 'SuiOperationError';
  readonly diagnostic: SuiOperationDiagnostic;

  constructor(
    readonly kind: SuiOperationErrorKind,
    diagnostic: SuiOperationDiagnostic,
  ) {
    super(ERROR_MESSAGES[kind]);
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

const REJECTED_EXECUTION_ERRORS = new WeakMap<SuiOperationError, SuiExecutionError>();

export interface SuiEndpointSnapshot {
  readonly endpointCount: number;
  readonly network: string;
}

declare const CHAIN_BOUND_SNAPSHOT: unique symbol;

/** Endpoint snapshot whose exact chain identifier was verified before creation. */
export interface ChainBoundSuiEndpointSnapshot extends SuiEndpointSnapshot {
  readonly [CHAIN_BOUND_SNAPSHOT]: true;
}

const SNAPSHOT_ENDPOINTS = new WeakMap<SuiEndpointSnapshot, readonly SuiGrpcClient[]>();
const SNAPSHOT_CHAIN_IDENTIFIERS = new WeakMap<SuiEndpointSnapshot, string>();

function snapshotEndpoints(snapshot: SuiEndpointSnapshot): readonly SuiGrpcClient[] {
  const endpoints = SNAPSHOT_ENDPOINTS.get(snapshot);
  if (!endpoints) {
    throw new TypeError('Sui endpoint snapshot was not created by the operation authority');
  }
  return endpoints;
}

/** Freeze one ordered, non-empty set of already-qualified endpoint clients. */
export function createSuiEndpointSnapshot(
  endpoints: readonly SuiGrpcClient[],
): SuiEndpointSnapshot {
  return createEndpointSnapshot(endpoints);
}

/**
 * Freeze endpoints after their exact chain identifier has been independently
 * verified. Server-side transaction builders use this boundary instead of
 * deriving a chain identifier from the SDK network label.
 */
export function createChainBoundSuiEndpointSnapshot(
  endpoints: readonly SuiGrpcClient[],
  chainIdentifier: string,
): ChainBoundSuiEndpointSnapshot {
  if (!isValidTransactionDigest(chainIdentifier)) {
    throw new TypeError('Sui endpoint snapshot chain identifier is invalid');
  }
  const snapshot = createEndpointSnapshot(endpoints) as ChainBoundSuiEndpointSnapshot;
  SNAPSHOT_CHAIN_IDENTIFIERS.set(snapshot, chainIdentifier);
  return snapshot;
}

/** @internal Read the exact chain identifier bound by endpoint qualification. */
export function getSuiEndpointSnapshotChainIdentifier(
  snapshot: ChainBoundSuiEndpointSnapshot,
): string {
  const chainIdentifier = SNAPSHOT_CHAIN_IDENTIFIERS.get(snapshot);
  if (!chainIdentifier) {
    throw new TypeError('Sui endpoint snapshot has no verified chain identifier');
  }
  return chainIdentifier;
}

function createEndpointSnapshot(endpoints: readonly SuiGrpcClient[]): SuiEndpointSnapshot {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new TypeError('Sui endpoint snapshot requires at least one endpoint');
  }

  const ordered = [...endpoints];
  const seen = new Set<SuiGrpcClient>();
  let network: string | undefined;
  for (const endpoint of ordered) {
    if (typeof endpoint !== 'object' || endpoint === null || typeof endpoint.network !== 'string') {
      throw new TypeError('Sui endpoint snapshot contains an invalid client');
    }
    if (seen.has(endpoint)) {
      throw new TypeError('Sui endpoint snapshot contains the same client more than once');
    }
    seen.add(endpoint);
    network ??= endpoint.network;
    if (endpoint.network !== network) {
      throw new TypeError('Sui endpoint snapshot clients must use one network');
    }
  }

  const frozenEndpoints = Object.freeze(ordered);
  const snapshot: SuiEndpointSnapshot = Object.freeze({
    endpointCount: frozenEndpoints.length,
    network: network!,
  });
  SNAPSHOT_ENDPOINTS.set(snapshot, frozenEndpoints);
  return snapshot;
}

const RETRYABLE_RPC_CODES = new Set([
  'ABORTED',
  'CANCELLED',
  'DATA_LOSS',
  'DEADLINE_EXCEEDED',
  'INTERNAL',
  'RESOURCE_EXHAUSTED',
  'UNAVAILABLE',
  'UNKNOWN',
]);

interface AttemptContext {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** Enforce caller cancellation and the monotonic attempt deadline inside multi-step reads. */
  readonly assertActive: () => void;
}

type Attempt<T> = (client: SuiGrpcClient, context: AttemptContext) => Promise<T>;

function operationError(
  kind: SuiOperationErrorKind,
  operation: SuiOperationName,
  attempt: number,
  maxAttempts: number,
  extra: Pick<SuiOperationDiagnostic, 'rpcCode' | 'resourceId'> = {},
): SuiOperationError {
  return new SuiOperationError(kind, {
    operation,
    attempt,
    maxAttempts,
    ...extra,
  });
}

function withAttempt(
  error: SuiOperationError,
  operation: SuiOperationName,
  attempt: number,
  maxAttempts: number,
): SuiOperationError {
  const next = operationError(error.kind, operation, attempt, maxAttempts, {
    rpcCode: error.diagnostic.rpcCode,
    resourceId: error.diagnostic.resourceId,
  });
  const executionError = REJECTED_EXECUTION_ERRORS.get(error);
  if (executionError) REJECTED_EXECUTION_ERRORS.set(next, executionError);
  return next;
}

function classifyAttemptError(
  error: unknown,
  operation: SuiOperationName,
  attempt: number,
  maxAttempts: number,
): SuiOperationError {
  if (error instanceof SuiOperationError) {
    return withAttempt(error, operation, attempt, maxAttempts);
  }
  if (error instanceof TypeError) {
    return operationError('invalid_request', operation, attempt, maxAttempts);
  }
  if (error instanceof RpcError) {
    if (error.code === 'DEADLINE_EXCEEDED') {
      return operationError('deadline_exceeded', operation, attempt, maxAttempts, {
        rpcCode: error.code,
      });
    }
    if (RETRYABLE_RPC_CODES.has(error.code)) {
      return operationError('transport_unavailable', operation, attempt, maxAttempts, {
        rpcCode: error.code,
      });
    }
    return operationError('rpc_rejected', operation, attempt, maxAttempts, {
      rpcCode: error.code,
    });
  }
  return operationError('internal_error', operation, attempt, maxAttempts);
}

function isRetryableReadError(error: SuiOperationError): boolean {
  return (
    error.kind === 'deadline_exceeded' ||
    error.kind === 'malformed_response' ||
    error.kind === 'not_found' ||
    error.kind === 'transport_unavailable'
  );
}

async function runOneAttempt<T>(
  client: SuiGrpcClient,
  operation: SuiOperationName,
  attemptNumber: number,
  maxAttempts: number,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  attempt: Attempt<T>,
): Promise<T> {
  if (callerSignal?.aborted) {
    throw operationError('aborted', operation, attemptNumber, maxAttempts);
  }

  const controller = new AbortController();
  const deadlineAt = performance.now() + timeoutMs;
  let timedOut = false;
  let callerAborted = false;
  let rejectBoundary: ((reason: SuiOperationError) => void) | undefined;

  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const onCallerAbort = () => {
    if (callerAborted) return;
    callerAborted = true;
    controller.abort();
    rejectBoundary?.(operationError('aborted', operation, attemptNumber, maxAttempts));
  };
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  if (callerSignal?.aborted) onCallerAbort();

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectBoundary?.(operationError('deadline_exceeded', operation, attemptNumber, maxAttempts));
  }, timeoutMs);

  const assertActive = () => {
    if (callerAborted || callerSignal?.aborted) {
      if (!callerAborted) onCallerAbort();
      throw operationError('aborted', operation, attemptNumber, maxAttempts);
    }
    if (timedOut || performance.now() >= deadlineAt) {
      timedOut = true;
      controller.abort();
      throw operationError('deadline_exceeded', operation, attemptNumber, maxAttempts);
    }
  };

  try {
    const attemptPromise = callerAborted
      ? new Promise<never>(() => undefined)
      : attempt(client, {
          attempt: attemptNumber,
          maxAttempts,
          signal: controller.signal,
          timeoutMs,
          assertActive,
        });
    const result = await Promise.race([attemptPromise, boundary]);
    assertActive();
    return result;
  } catch (error) {
    if (callerAborted) {
      throw operationError('aborted', operation, attemptNumber, maxAttempts);
    }
    if (timedOut) {
      throw operationError('deadline_exceeded', operation, attemptNumber, maxAttempts);
    }
    throw classifyAttemptError(error, operation, attemptNumber, maxAttempts);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

/** @internal Package-private validated read/simulation runner. */
export async function runSuiReadOperation<T>(
  snapshot: SuiEndpointSnapshot,
  operation: SuiOperationName,
  callerSignal: AbortSignal | undefined,
  attempt: Attempt<T>,
): Promise<T> {
  const endpoints = snapshotEndpoints(snapshot);
  const startedAt = performance.now();
  const totalBudgetMs = endpoints.length * SUI_OPERATION_ATTEMPT_TIMEOUT_MS;
  let lastError: SuiOperationError | undefined;

  for (let index = 0; index < endpoints.length; index++) {
    const remainingMs = totalBudgetMs - (performance.now() - startedAt);
    if (remainingMs <= 0) {
      throw operationError(
        'deadline_exceeded',
        operation,
        Math.max(1, index),
        snapshot.endpointCount,
      );
    }
    try {
      return await runOneAttempt(
        endpoints[index]!,
        operation,
        index + 1,
        snapshot.endpointCount,
        Math.min(SUI_OPERATION_ATTEMPT_TIMEOUT_MS, remainingMs),
        callerSignal,
        attempt,
      );
    } catch (error) {
      const current = classifyAttemptError(error, operation, index + 1, snapshot.endpointCount);
      if (!isRetryableReadError(current)) throw current;
      lastError = current;
    }
  }

  throw (
    lastError ??
    operationError(
      'transport_unavailable',
      operation,
      snapshot.endpointCount,
      snapshot.endpointCount,
    )
  );
}

/** @internal Package-private signed execution runner: primary exactly once. */
export function runSuiPrimaryExecution<T>(
  snapshot: SuiEndpointSnapshot,
  callerSignal: AbortSignal | undefined,
  attempt: Attempt<T>,
): Promise<T> {
  const endpoints = snapshotEndpoints(snapshot);
  return runOneAttempt(
    endpoints[0]!,
    'execute_transaction',
    1,
    1,
    SUI_OPERATION_ATTEMPT_TIMEOUT_MS,
    callerSignal,
    attempt,
  );
}

/** Create a redacted malformed-response error inside an operation parser. */
export function malformedSuiResponse(operation: SuiOperationName): SuiOperationError {
  return operationError('malformed_response', operation, 1, 1);
}

/** Create a typed exact not-found result without retaining provider text. */
export function suiResourceNotFound(
  operation: SuiOperationName,
  resourceId: string,
): SuiOperationError {
  if (resourceId.length === 0) {
    throw new TypeError('Sui resource not-found identity must be non-empty');
  }
  return operationError('not_found', operation, 1, 1, { resourceId });
}

/** Preserve a parsed current execution failure without exposing provider text. */
export function rejectedSuiOperation(
  operation: SuiOperationName,
  executionError: SuiExecutionError,
): SuiOperationError {
  const error = operationError('rpc_rejected', operation, 1, 1);
  REJECTED_EXECUTION_ERRORS.set(error, executionError);
  return error;
}

/**
 * Server-only access to a parsed failure retained by the Sui operation
 * authority. Structurally similar or caller-created errors cannot forge this
 * association.
 */
export function getSuiRejectedExecutionError(error: unknown): SuiExecutionError | undefined {
  if (!(error instanceof SuiOperationError)) return undefined;
  if (error.kind !== 'rpc_rejected' || error.diagnostic.operation !== 'resolve_transaction') {
    return undefined;
  }
  return REJECTED_EXECUTION_ERRORS.get(error);
}
