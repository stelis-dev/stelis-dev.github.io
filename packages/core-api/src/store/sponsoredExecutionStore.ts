import { createHash } from 'node:crypto';
import type { SponsorResultMetadata } from '../handlers/sponsorResult.js';
import type { PreparedTxDraft, PreparedTxEntry } from './prepareTypes.js';
import type {
  ExecutingSponsoredExecutionRecord,
  FinalSponsoredExecutionRecord,
  SponsoredExecutionRecoveryContext,
} from './sponsoredExecutionRecords.js';

export const SPONSORED_EXECUTION_RECOVERY_BATCH_SIZE = 100;
export const MAX_CONCURRENT_PREPARED_PER_IP = 2;
export const MAX_OUTSTANDING_PREPARED_PER_STUDIO_USER = 3;
export const MAX_OUTSTANDING_PREPARED_PER_SENDER = 3;

/**
 * Exclusive position in one recovery index pass.
 *
 * `throughMs` is authored once from Redis TIME (or the injected memory clock)
 * on the first page. Keeping it in the cursor makes one pass finite even while
 * new work is added. `scoreMs` and `receiptId` are the sorted-set tuple after
 * which the next page starts.
 */
export interface SponsoredExecutionRecoveryCursor {
  readonly throughMs: number;
  readonly scoreMs: number;
  readonly receiptId: string;
}

/** One bounded page from a sponsored-execution recovery index. */
export interface SponsoredExecutionRecoveryPage<T> {
  readonly records: readonly T[];
  readonly nextCursor: SponsoredExecutionRecoveryCursor | null;
}

export function sponsoredExecutionOrderIdHash(orderId: string | null): string | null {
  return orderId === null ? null : createHash('sha256').update(orderId).digest('hex');
}

function assertResultIdentity(
  expected: {
    readonly receiptId: string;
    readonly sponsorAddress: string;
    readonly senderAddress: string;
    readonly executionPathKey: string;
    readonly route: PreparedTxEntry['mode'];
    readonly orderIdHash: string | null;
    readonly promotionId: string | null;
    readonly userId: string | null;
  },
  result: SponsorResultMetadata,
): void {
  if (
    result.receiptId !== expected.receiptId ||
    result.sponsorAddress !== expected.sponsorAddress ||
    result.senderAddress !== expected.senderAddress ||
    result.executionPathKey !== expected.executionPathKey ||
    result.route !== expected.route ||
    result.orderIdHash !== expected.orderIdHash ||
    result.promotionId !== expected.promotionId ||
    result.userId !== expected.userId
  ) {
    throw new Error('Sponsor result identity does not match its receipt lifecycle record');
  }
}

export function assertRecoveryMatchesPreparedReceipt(
  prepared: PreparedTxEntry,
  recovery: SponsoredExecutionRecoveryContext,
): void {
  if (
    recovery.route !== prepared.mode ||
    recovery.senderAddress !== prepared.senderAddress ||
    recovery.executionPathKey !== prepared.executionPathKey
  ) {
    throw new Error('Sponsored execution recovery identity does not match the prepared receipt');
  }
  if (prepared.mode === 'generic') {
    if (
      recovery.route !== 'generic' ||
      recovery.orderIdHash !== sponsoredExecutionOrderIdHash(prepared.orderId)
    ) {
      throw new Error('Generic recovery identity does not match the prepared receipt');
    }
    return;
  }
  if (
    recovery.route !== 'promotion' ||
    recovery.promotionId !== prepared.promotionId ||
    recovery.userId !== prepared.userId ||
    recovery.reservedGasMist !== prepared.reservedGasMist.toString()
  ) {
    throw new Error('Promotion recovery identity does not match the prepared receipt');
  }
}

export function assertPreparedResultMatchesReceipt(
  prepared: PreparedTxEntry,
  result: SponsorResultMetadata,
): void {
  assertResultIdentity(
    {
      receiptId: prepared.receiptId,
      sponsorAddress: prepared.sponsorAddress,
      senderAddress: prepared.senderAddress,
      executionPathKey: prepared.executionPathKey,
      route: prepared.mode,
      orderIdHash:
        prepared.mode === 'generic' ? sponsoredExecutionOrderIdHash(prepared.orderId) : null,
      promotionId: prepared.mode === 'promotion' ? prepared.promotionId : null,
      userId: prepared.mode === 'promotion' ? prepared.userId : null,
    },
    result,
  );
}

export function assertFinalResultMatchesExecution(
  execution: ExecutingSponsoredExecutionRecord,
  result: SponsorResultMetadata,
  promotion: PromotionReceiptFinalization,
): void {
  const recovery = execution.recovery;
  assertResultIdentity(
    {
      receiptId: execution.receiptId,
      sponsorAddress: execution.sponsorAddress,
      senderAddress: recovery.senderAddress,
      executionPathKey: recovery.executionPathKey,
      route: recovery.route,
      orderIdHash: recovery.route === 'generic' ? recovery.orderIdHash : null,
      promotionId: recovery.route === 'promotion' ? recovery.promotionId : null,
      userId: recovery.route === 'promotion' ? recovery.userId : null,
    },
    result,
  );
  if (
    (recovery.route === 'generic' && promotion.operation !== 'none') ||
    (recovery.route === 'promotion' && promotion.operation === 'none')
  ) {
    throw new Error('Promotion finalization does not match the sponsored execution route');
  }
}

export type PromotionReceiptFinalization =
  | { readonly operation: 'none' }
  | { readonly operation: 'release' }
  | { readonly operation: 'consume'; readonly chargedMist: bigint };

export interface BeginSponsoredExecutionInput {
  readonly receiptId: string;
  readonly txBytes: Uint8Array;
  readonly expectedMode: PreparedTxEntry['mode'];
  readonly recovery: SponsoredExecutionRecoveryContext;
  /** Exact deadline window `(1 + endpointCount) * attemptTimeoutMs`. */
  readonly executionBudgetMs: number;
}

export type BeginSponsoredExecutionResult =
  | {
      readonly status: 'executing';
      readonly prepared: PreparedTxEntry;
      readonly execution: ExecutingSponsoredExecutionRecord;
    }
  | { readonly status: 'not_found' }
  | { readonly status: 'expired' }
  | { readonly status: 'hash_mismatch' }
  | { readonly status: 'mode_mismatch'; readonly actualMode: PreparedTxEntry['mode'] }
  | { readonly status: 'promotion_not_active' }
  | { readonly status: 'state_changed' };

export interface FinalizeSponsoredExecutionInput {
  readonly expected: ExecutingSponsoredExecutionRecord;
  readonly result: SponsorResultMetadata;
  readonly promotion: PromotionReceiptFinalization;
}

export type FinalizeSponsoredExecutionResult =
  | { readonly status: 'finalized'; readonly record: FinalSponsoredExecutionRecord }
  | { readonly status: 'already_final'; readonly record: FinalSponsoredExecutionRecord }
  | { readonly status: 'state_changed' };

export interface DiscardPreparedReceiptInput {
  readonly expected: PreparedTxEntry;
  readonly result: SponsorResultMetadata;
}

export type DiscardPreparedReceiptResult =
  | { readonly status: 'discarded'; readonly record: FinalSponsoredExecutionRecord }
  | { readonly status: 'already_final'; readonly record: FinalSponsoredExecutionRecord }
  | { readonly status: 'state_changed' };

/**
 * One receipt lifecycle store used by both prepare and sponsor runners.
 *
 * Implementations own the cross-record mutation. Record modules continue to
 * own their key constructors and exact serialized values; the store must not
 * invent a second prepared, lease, or Promotion record format.
 */
export interface SponsoredExecutionStoreAdapter {
  /**
   * Commit the prepared entry and reserved resources as one mutation.
   *
   * A durable prepared entry is the ownership authority even when the client
   * loses the mutation response. Redis implementations reconcile an uncertain
   * response only against the exact attempted serialized entry; cleanup paths
   * must not release resources protected by an existing prepared entry.
   */
  commitPreparedReceipt(draft: PreparedTxDraft): Promise<PreparedTxEntry>;

  /** Read one current prepared record without changing its state. */
  readPreparedReceipt(receiptId: string): Promise<PreparedTxEntry | null>;

  /** Atomically discard every state owned by one prepared receipt. */
  discardPreparedReceipt(input: DiscardPreparedReceiptInput): Promise<DiscardPreparedReceiptResult>;

  /** Atomically replace prepared state with executing state. */
  beginSponsoredExecution(
    input: BeginSponsoredExecutionInput,
  ): Promise<BeginSponsoredExecutionResult>;

  /** Atomically account, release the lease, and persist one final outcome. */
  finalizeSponsoredExecution(
    input: FinalizeSponsoredExecutionInput,
  ): Promise<FinalizeSponsoredExecutionResult>;

  /** Read one exclusive, bounded page of expired prepared receipts. */
  readExpiredPreparedReceipts(
    limit: number,
    cursor: SponsoredExecutionRecoveryCursor | null,
  ): Promise<SponsoredExecutionRecoveryPage<PreparedTxEntry>>;

  /** Read one exclusive, bounded page of due executing receipts. */
  readDueExecutions(
    limit: number,
    cursor: SponsoredExecutionRecoveryCursor | null,
  ): Promise<SponsoredExecutionRecoveryPage<ExecutingSponsoredExecutionRecord>>;

  /** Read one exclusive, bounded page of final callbacks awaiting delivery. */
  readPendingCallbacks(
    limit: number,
    cursor: SponsoredExecutionRecoveryCursor | null,
  ): Promise<SponsoredExecutionRecoveryPage<FinalSponsoredExecutionRecord>>;

  /** Exact CAS from pending to delivered. */
  markCallbackDelivered(expected: FinalSponsoredExecutionRecord): Promise<boolean>;

  /** Existing prepare admission and nonce authority, retained in this store. */
  checkUserQuota(userId: string): Promise<'ok' | { exceeded: true; limit: number }>;
  reserveNonce(senderAddress: string, onchainLastNonce: bigint, receiptId: string): Promise<bigint>;
  releaseNonceReservation(receiptId: string, senderAddress: string): Promise<void>;

  dispose(): Promise<void>;
}
