import { createHash } from 'node:crypto';
import { computeExecutionCostClaim, SUI_OPERATION_ATTEMPT_TIMEOUT_MS } from '@stelis/core-relay';
import type { SponsorResultCallback, SponsorResultMetadata } from '../../handlers/sponsorResult.js';
import type { PreparedTxEntry } from '../../store/prepareTypes.js';
import type {
  ExecutingSponsoredExecutionRecord,
  SponsoredExecutionRecoveryContext,
} from '../../store/sponsoredExecutionRecords.js';
import { storedSponsorResultMatchesMetadata } from '../../store/sponsoredExecutionRecords.js';
import { attemptSponsorResultDelivery } from '../../store/sponsorResultDelivery.js';
import type {
  PromotionReceiptFinalization,
  SponsoredExecutionStoreAdapter,
} from '../../store/sponsoredExecutionStore.js';
import type {
  SponsorSubmissionContext,
  SponsorValidatedContext,
  SponsoredExecutionPolicy,
} from './executionPolicy.js';
import type {
  LedgerReservationHandle,
  NonceReservationHandle,
  SponsorSlotReservationHandle,
} from './reservationHandles.js';
import { reconstructReservationHandles } from './reservationHandles.js';
import type { ExecResult } from '../sessionTypes.js';
import { SponsorPostSignatureUncertaintyError } from '../sessionPrimitives.js';
import { authenticateSponsorSubmission } from './sponsorSubmissionAuthentication.js';

/** The only side-effecting execution port. It receives the original validated bytes. */
export type SignAndSubmitPort = (
  sponsorAddress: string,
  receiptId: string,
  txBytes: Uint8Array,
  userSignature: string,
  expectedDigest: string,
) => Promise<ExecResult>;

export interface SponsorStateMachineHost {
  readonly store: SponsoredExecutionStoreAdapter;
  readonly signAndSubmit: SignAndSubmitPort;
  readonly endpointCount: number;
  readonly onSponsorResult: SponsorResultCallback;
  /** Fresh receipt-specific check for the exact assigned sponsor address. */
  readonly isSponsorAddressAvailable: (sponsorAddress: string) => Promise<boolean>;
}

export interface SponsorResultSnapshot {
  readonly receiptId: string;
  readonly clientIp: string;
  readonly prepared: PreparedTxEntry;
  readonly sponsorSlot: SponsorSlotReservationHandle;
  readonly nonce?: NonceReservationHandle;
  readonly ledgerReservation?: LedgerReservationHandle;
  readonly execResult: Extract<ExecResult, { success: true }>;
}

export interface SponsorStateMachineRequest<TResult> {
  readonly hookContext: Pick<SponsorSubmissionContext, 'receiptId' | 'clientIp'>;
  readonly txBytes: Uint8Array;
  readonly userSignature: string;
  readonly buildRecoveryContext: () => SponsoredExecutionRecoveryContext;
  readonly buildResultMetadata: (
    executionStage: SponsorResultMetadata['executionStage'],
  ) => SponsorResultMetadata;
  readonly stateChangedError: () => Error;
  readonly projectResult: (snapshot: SponsorResultSnapshot) => TResult | Promise<TResult>;
}

/** Route-specific public error and abuse classification. No storage mutation is allowed. */
export interface SponsorReceiptPolicyAdapter {
  readonly route: PreparedTxEntry['mode'];
  onNotFound(receiptId: string): Error;
  onExpired(receiptId: string): Error;
  onHashMismatch(receiptId: string): Promise<Error> | Error;
  onPromotionNotActive(receiptId: string): Error;
  onSponsorUnavailable(receiptId: string): Error;
  onStateChanged(receiptId: string): Error;
  onCorrupt(input: { receiptId: string; error: unknown }): Promise<Error> | Error;
  validatePreparedEntry(entry: PreparedTxEntry): Promise<void> | void;
}

export class RunnerSponsorReservationHandleMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerSponsorReservationHandleMissingError';
  }
}

export class RunnerSponsorPolicyContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerSponsorPolicyContractError';
  }
}

function executionBudgetMs(endpointCount: number): number {
  if (!Number.isSafeInteger(endpointCount) || endpointCount <= 0) {
    throw new TypeError('Sponsor endpointCount must be a positive safe integer');
  }
  const value = (endpointCount + 1) * SUI_OPERATION_ATTEMPT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value)) {
    throw new TypeError('Sponsored execution deadline exceeds the safe integer range');
  }
  return value;
}

function txBytesHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function promotionFinalization(
  prepared: PreparedTxEntry,
  metadata: SponsorResultMetadata,
  result: ExecResult | null,
): PromotionReceiptFinalization {
  if (prepared.mode === 'generic') return { operation: 'none' };
  if (result?.success || (result && !result.isCongestion)) {
    return {
      operation: 'consume',
      chargedMist: computeExecutionCostClaim(result.gasUsed).simGas,
    };
  }
  if (result && !result.success && result.isCongestion) return { operation: 'release' };
  return metadata.executionStage === 'before_sponsor_signature'
    ? { operation: 'release' }
    : { operation: 'consume', chargedMist: prepared.reservedGasMist };
}

async function finalize<TResult>(
  host: SponsorStateMachineHost,
  request: SponsorStateMachineRequest<TResult>,
  expected: ExecutingSponsoredExecutionRecord,
  prepared: PreparedTxEntry,
  stage: SponsorResultMetadata['executionStage'],
  result: ExecResult | null,
): Promise<void> {
  const metadata = request.buildResultMetadata(stage);
  const outcome = await host.store.finalizeSponsoredExecution({
    expected,
    result: metadata,
    promotion: promotionFinalization(prepared, metadata, result),
  });
  if (outcome.status === 'state_changed') throw request.stateChangedError();
  if (
    outcome.status === 'already_final' &&
    !storedSponsorResultMatchesMetadata(outcome.record.result, metadata)
  ) {
    throw request.stateChangedError();
  }
  await attemptSponsorResultDelivery({
    record: outcome.record,
    callback: host.onSponsorResult,
    store: host.store,
  });
}

async function discard<TResult>(
  host: SponsorStateMachineHost,
  request: SponsorStateMachineRequest<TResult>,
  prepared: PreparedTxEntry,
): Promise<void> {
  const metadata = request.buildResultMetadata('before_sponsor_signature');
  const outcome = await host.store.discardPreparedReceipt({
    expected: prepared,
    result: metadata,
  });
  if (outcome.status === 'state_changed') throw request.stateChangedError();
  if (
    outcome.status === 'already_final' &&
    !storedSponsorResultMatchesMetadata(outcome.record.result, metadata)
  ) {
    throw request.stateChangedError();
  }
  await attemptSponsorResultDelivery({
    record: outcome.record,
    callback: host.onSponsorResult,
    store: host.store,
  });
}

/**
 * Execute one prepared receipt.
 *
 * The prepared record remains current while the request bytes and policy are
 * checked. Immediately before signing, the store atomically consumes that
 * exact record and creates the execution record. The same `Uint8Array` is then
 * passed to the signing/submission port; the runner never rebuilds it.
 */
export async function runSponsorStateMachine<TResult>(
  host: SponsorStateMachineHost,
  request: SponsorStateMachineRequest<TResult>,
  policy: SponsoredExecutionPolicy,
  receiptPolicy: SponsorReceiptPolicyAdapter,
): Promise<TResult> {
  const receiptId = request.hookContext.receiptId;
  const authentication = await authenticateSponsorSubmission({
    txBytes: request.txBytes,
    userSignature: request.userSignature,
  });
  await policy.hooks.SponsorSubmissionAdmission({
    ...request.hookContext,
    authentication,
  });
  if (authentication.outcome === 'rejected') {
    throw new RunnerSponsorPolicyContractError(
      'SponsorSubmissionAdmission returned after rejected authentication',
    );
  }
  const authenticatedSubmission = authentication.submission;

  let prepared: PreparedTxEntry;
  let current: PreparedTxEntry | null;
  try {
    current = await host.store.readPreparedReceipt(receiptId);
  } catch (error) {
    throw await receiptPolicy.onCorrupt({ receiptId, error });
  }
  if (!current) throw receiptPolicy.onNotFound(receiptId);
  prepared = current;
  await receiptPolicy.validatePreparedEntry(prepared);

  if (txBytesHash(request.txBytes) !== prepared.txBytesHash) {
    throw await receiptPolicy.onHashMismatch(receiptId);
  }
  if (!(await host.isSponsorAddressAvailable(prepared.sponsorAddress))) {
    throw receiptPolicy.onSponsorUnavailable(receiptId);
  }

  const sponsorSlot = reconstructReservationHandles.sponsorSlot({
    sponsorAddress: prepared.sponsorAddress,
    receiptId: prepared.receiptId,
  });
  let nonce: NonceReservationHandle | undefined;
  let ledgerReservation: LedgerReservationHandle | undefined;
  const context = (): SponsorValidatedContext => ({
    receiptId,
    clientIp: request.hookContext.clientIp,
    authenticatedSubmission,
    executionStage: 'before_sponsor_signature',
    sponsorSlot,
    nonce,
    ledgerReservation,
  });

  let execution: ExecutingSponsoredExecutionRecord | null = null;
  let discardOnFailure = true;
  try {
    const shared = await policy.hooks.SharedSponsorChecks(context());
    if (shared.nonce) nonce = reconstructReservationHandles.nonce(shared.nonce);
    const route = await policy.hooks.PolicySponsorChecks(context());
    if (route.ledgerReservation) {
      ledgerReservation = reconstructReservationHandles.ledgerReservation(route.ledgerReservation);
    }
    await policy.hooks.Preflight(context());

    if (policy.handleRequirements.sponsorResult.ledgerReservation && !ledgerReservation) {
      throw new RunnerSponsorReservationHandleMissingError(
        'Policy requires a Promotion reservation at the sponsor result boundary',
      );
    }

    const begun = await host.store.beginSponsoredExecution({
      receiptId,
      txBytes: request.txBytes,
      expectedMode: receiptPolicy.route,
      recovery: request.buildRecoveryContext(),
      executionBudgetMs: executionBudgetMs(host.endpointCount),
    });
    switch (begun.status) {
      case 'executing':
        execution = begun.execution;
        prepared = begun.prepared;
        discardOnFailure = false;
        break;
      case 'not_found':
        throw receiptPolicy.onNotFound(receiptId);
      case 'expired':
        throw receiptPolicy.onExpired(receiptId);
      case 'hash_mismatch':
        throw await receiptPolicy.onHashMismatch(receiptId);
      case 'mode_mismatch':
      case 'state_changed':
        throw receiptPolicy.onStateChanged(receiptId);
      case 'promotion_not_active':
        throw receiptPolicy.onPromotionNotActive(receiptId);
    }
  } catch (error) {
    if (discardOnFailure) await discard(host, request, prepared);
    throw error;
  }
  if (!execution) throw request.stateChangedError();

  let result: ExecResult;
  try {
    result = await host.signAndSubmit(
      prepared.sponsorAddress,
      prepared.receiptId,
      request.txBytes,
      request.userSignature,
      execution.transactionDigest,
    );
  } catch (error) {
    if (error instanceof SponsorPostSignatureUncertaintyError) throw error;
    await finalize(host, request, execution, prepared, 'before_sponsor_signature', null);
    throw error;
  }

  let classifiedError: unknown;
  try {
    await policy.hooks.ClassifySponsorResult(
      { ...context(), executionStage: result.executionStage },
      result,
    );
    if (!result.success) {
      classifiedError = new RunnerSponsorPolicyContractError(
        'ClassifySponsorResult returned without classifying a failed Sui result',
      );
    }
  } catch (error) {
    classifiedError = error;
  }

  await finalize(host, request, execution, prepared, result.executionStage, result);
  if (classifiedError !== undefined) throw classifiedError;
  if (!result.success) {
    throw new RunnerSponsorPolicyContractError(
      'Failed Sui result reached the public success projection',
    );
  }

  return await request.projectResult({
    receiptId,
    clientIp: request.hookContext.clientIp,
    prepared,
    sponsorSlot,
    nonce,
    ledgerReservation,
    execResult: result,
  });
}
