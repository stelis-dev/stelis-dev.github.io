import type { SuiNetwork, SuiRpcFleetStatus } from '@stelis/contracts';
import { SUI_CHAIN_IDENTIFIERS } from '@stelis/contracts';
import { redactEndpointUrl } from '@stelis/core-api/observability';
import {
  SUI_OPERATION_ATTEMPT_TIMEOUT_MS,
  SuiOperationError,
  createSuiEndpointSnapshot,
  getSuiChainIdentifier,
  type SuiEndpointSnapshot,
} from '@stelis/core-relay';
import {
  createQualifiedSuiRpcAdminSnapshot,
  createSuiRpcEndpointClient,
  type SuiRpcEndpointConfig,
} from './endpointClient.js';

export type SuiRpcEndpointRejectionKind =
  | 'chain_identifier_failed'
  | 'chain_identifier_mismatch'
  | 'chain_identifier_timeout'
  | 'qualification_failed'
  | 'qualification_timeout';

export interface SuiRpcEndpointRejection {
  /** Redacted URL suitable for diagnostics. */
  readonly url: string;
  readonly kind: SuiRpcEndpointRejectionKind;
}

export interface SuiRpcQualificationContext {
  /** A one-endpoint snapshot. Every injected read is therefore pinned to this endpoint. */
  readonly snapshot: SuiEndpointSnapshot;
  /** Aborted when the whole actual qualification suite exceeds one attempt budget. */
  readonly signal: AbortSignal;
}

/**
 * Host-owned, read-only, no-side-effect actual qualification suite for one endpoint.
 *
 * Boot injects the real Config, Vault, and settlement swap-path reads. The
 * callback must not mutate sessions or Host/domain state. Its exact result is
 * retained beside the accepted endpoint so boot can pass the primary accepted
 * result into Host context construction without repeating the reads or using a
 * side-channel map. A generic boolean or capability probe is intentionally not
 * part of this API.
 */
export type QualifySuiRpcEndpoint<T> = (context: SuiRpcQualificationContext) => Promise<T>;

export interface QualifySuiRpcEndpointsOptions<T> {
  readonly network: SuiNetwork;
  readonly endpoints: readonly SuiRpcEndpointConfig[];
  readonly qualify: QualifySuiRpcEndpoint<T>;
  readonly signal?: AbortSignal;
}

export interface QualifiedSuiRpcBoundary<T> {
  /** Ordered, immutable core-relay operation authority. */
  readonly snapshot: SuiEndpointSnapshot;
  /** Exact read-only qualification result from the accepted primary endpoint. */
  readonly primaryQualification: T;
  /** Redacted diagnostics for endpoints excluded from the accepted snapshot. */
  readonly rejected: readonly SuiRpcEndpointRejection[];
  /** Immutable public view containing accepted endpoints only. */
  readonly adminSnapshot: Readonly<SuiRpcFleetStatus>;
}

class QualificationBoundaryError extends Error {
  override readonly name = 'QualificationBoundaryError';

  constructor(readonly kind: 'aborted' | 'timeout') {
    super(
      kind === 'aborted' ? 'Sui RPC qualification was aborted' : 'Sui RPC qualification timed out',
    );
  }
}

function assertCallerActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new QualificationBoundaryError('aborted');
}

function rethrowCallerCancellation(error: unknown, signal: AbortSignal | undefined): void {
  if (
    signal?.aborted ||
    (error instanceof QualificationBoundaryError && error.kind === 'aborted') ||
    (error instanceof SuiOperationError && error.kind === 'aborted')
  ) {
    throw new QualificationBoundaryError('aborted');
  }
}

export class NoQualifiedSuiRpcEndpointsError extends Error {
  override readonly name = 'NoQualifiedSuiRpcEndpointsError';
  readonly rejected: readonly SuiRpcEndpointRejection[];

  constructor(rejected: readonly SuiRpcEndpointRejection[]) {
    super(`No Sui RPC endpoint passed qualification (${rejected.length} rejected)`);
    this.rejected = Object.freeze([...rejected]);
  }
}

async function runQualification<T>(
  snapshot: SuiEndpointSnapshot,
  callerSignal: AbortSignal | undefined,
  qualify: QualifySuiRpcEndpoint<T>,
): Promise<T> {
  assertCallerActive(callerSignal);

  const controller = new AbortController();
  let rejectBoundary: ((error: QualificationBoundaryError) => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  let callerAborted = false;
  let timedOut = false;
  const onCallerAbort = () => {
    if (callerAborted) return;
    callerAborted = true;
    controller.abort();
    rejectBoundary?.(new QualificationBoundaryError('aborted'));
  };
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  if (callerSignal?.aborted) onCallerAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectBoundary?.(new QualificationBoundaryError('timeout'));
  }, SUI_OPERATION_ATTEMPT_TIMEOUT_MS);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  try {
    const qualification = callerAborted
      ? new Promise<never>(() => undefined)
      : qualify(Object.freeze({ snapshot, signal: controller.signal }));
    const result = await Promise.race([qualification, boundary]);
    // The qualification callback is injected application code. If it aborts
    // the caller and resolves in the same turn, promise-race ordering must not
    // turn that cancellation into an accepted endpoint.
    if (callerAborted) throw new QualificationBoundaryError('aborted');
    if (timedOut) throw new QualificationBoundaryError('timeout');
    return result;
  } catch (error) {
    // Caller cancellation and the qualification deadline are terminal boundary
    // states. A signal-aware callback may reject before the boundary promise;
    // promise ordering must not reclassify either state as an endpoint failure.
    if (callerAborted || callerSignal?.aborted) {
      throw new QualificationBoundaryError('aborted');
    }
    if (timedOut) throw new QualificationBoundaryError('timeout');
    throw error;
  } finally {
    // The actual qualification callback may run Config/Vault and settlement
    // path reads concurrently. Once any branch settles the suite, abort every
    // still-running sibling before this endpoint leaves qualification.
    controller.abort();
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

function chainFailureKind(error: unknown): SuiRpcEndpointRejectionKind {
  if (error instanceof SuiOperationError) {
    if (error.kind === 'deadline_exceeded') return 'chain_identifier_timeout';
  }
  return 'chain_identifier_failed';
}

function qualificationFailureKind(error: unknown): SuiRpcEndpointRejectionKind {
  if (error instanceof QualificationBoundaryError) {
    return 'qualification_timeout';
  }
  if (error instanceof SuiOperationError) {
    if (error.kind === 'deadline_exceeded') return 'qualification_timeout';
  }
  return 'qualification_failed';
}

/**
 * Qualify configured endpoints independently and create the one accepted
 * operation boundary. Concurrent completion never changes configured order.
 */
export async function qualifySuiRpcEndpoints<T>(
  options: QualifySuiRpcEndpointsOptions<T>,
): Promise<QualifiedSuiRpcBoundary<T>> {
  if (options.endpoints.length === 0) {
    throw new TypeError('Sui RPC qualification requires at least one configured endpoint');
  }
  assertCallerActive(options.signal);

  const expectedChainIdentifier = SUI_CHAIN_IDENTIFIERS[options.network];
  const candidates = options.endpoints.map((endpoint) =>
    createSuiRpcEndpointClient(options.network, endpoint),
  );
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const snapshot = createSuiEndpointSnapshot([candidate.client]);
      let chainIdentifier: string;
      try {
        ({ chainIdentifier } = await getSuiChainIdentifier(snapshot, {
          signal: options.signal,
        }));
      } catch (error) {
        rethrowCallerCancellation(error, options.signal);
        return {
          accepted: null,
          rejected: Object.freeze({
            url: redactEndpointUrl(candidate.endpoint.baseUrl),
            kind: chainFailureKind(error),
          }),
        };
      }
      assertCallerActive(options.signal);
      if (chainIdentifier !== expectedChainIdentifier) {
        return {
          accepted: null,
          rejected: Object.freeze({
            url: redactEndpointUrl(candidate.endpoint.baseUrl),
            kind: 'chain_identifier_mismatch' as const,
          }),
        };
      }

      try {
        const qualification = await runQualification(snapshot, options.signal, options.qualify);
        return {
          accepted: Object.freeze({
            endpoint: candidate.endpoint,
            client: candidate.client,
            qualification,
          }),
          rejected: null,
        };
      } catch (error) {
        rethrowCallerCancellation(error, options.signal);
        return {
          accepted: null,
          rejected: Object.freeze({
            url: redactEndpointUrl(candidate.endpoint.baseUrl),
            kind: qualificationFailureKind(error),
          }),
        };
      }
    }),
  );
  assertCallerActive(options.signal);

  const accepted = Object.freeze(
    results.flatMap((result) => (result.accepted === null ? [] : [result.accepted])),
  );
  const rejected = Object.freeze(
    results.flatMap((result) => (result.rejected === null ? [] : [result.rejected])),
  );
  if (accepted.length === 0) throw new NoQualifiedSuiRpcEndpointsError(rejected);

  const snapshot = createSuiEndpointSnapshot(accepted.map((endpoint) => endpoint.client));
  return Object.freeze({
    snapshot,
    primaryQualification: accepted[0]!.qualification,
    rejected,
    adminSnapshot: createQualifiedSuiRpcAdminSnapshot(accepted),
  });
}
