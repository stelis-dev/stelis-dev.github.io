import {
  computeExecutionCostClaim,
  getSuiTransactionEffects,
  suiExecutionErrorMessage,
  SuiOperationError,
  type SuiEndpointSnapshot,
  type SuiTransactionResult,
} from '@stelis/core-relay';
import { NODE_TIMER_MAX_DELAY_MS } from '@stelis/contracts';
import type { SponsorResultCallback, SponsorResultMetadata } from '../handlers/sponsorResult.js';
import {
  SPONSOR_CONGESTION_FAILURE_REASON,
  deriveHostPaidGasEconomics,
  deriveSettlementExecutionEconomics,
  serializeSponsoredExecutionEconomics,
  sponsorOnchainRevertFailureReason,
  unknownSponsoredExecutionEconomics,
} from '../sponsoredExecution.js';
import type { PreparedTxEntry } from './prepareTypes.js';
import type {
  ExecutingSponsoredExecutionRecord,
  SponsoredExecutionRecoveryContext,
} from './sponsoredExecutionRecords.js';
import { sponsorResultMetadata } from './sponsoredExecutionRecords.js';
import {
  SPONSORED_EXECUTION_RECOVERY_BATCH_SIZE,
  sponsoredExecutionOrderIdHash,
  type PromotionReceiptFinalization,
  type SponsoredExecutionRecoveryCursor,
  type SponsoredExecutionStoreAdapter,
} from './sponsoredExecutionStore.js';

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function nodeTimerDelay(value: number, label: string): number {
  const delay = positiveSafeInteger(value, label);
  if (delay > NODE_TIMER_MAX_DELAY_MS) {
    throw new Error(`${label} must not exceed ${NODE_TIMER_MAX_DELAY_MS}`);
  }
  return delay;
}

function yieldTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function preparedFailureResult(entry: PreparedTxEntry, reason: string): SponsorResultMetadata {
  return {
    sponsorAddress: entry.sponsorAddress,
    outcome: 'validation_failure',
    executionStage: 'before_sponsor_signature',
    route: entry.mode,
    receiptId: entry.receiptId,
    senderAddress: entry.senderAddress,
    executionPathKey: entry.executionPathKey,
    orderIdHash: entry.mode === 'generic' ? sponsoredExecutionOrderIdHash(entry.orderId) : null,
    promotionId: entry.mode === 'promotion' ? entry.promotionId : null,
    userId: entry.mode === 'promotion' ? entry.userId : null,
    economics: serializeSponsoredExecutionEconomics(unknownSponsoredExecutionEconomics(reason)),
  };
}

function isCongestion(result: Extract<SuiTransactionResult, { outcome: 'failure' }>): boolean {
  return (
    result.error.kind === 'CongestedObjects' ||
    result.error.kind === 'ExecutionCanceledDueToConsensusObjectCongestion'
  );
}

function gasEconomics(
  recovery: SponsoredExecutionRecoveryContext,
  gasUsed: SuiTransactionResult['effects']['gasUsed'],
  failureReason: string | null,
) {
  if (recovery.route === 'promotion') {
    return serializeSponsoredExecutionEconomics(deriveHostPaidGasEconomics(gasUsed, failureReason));
  }
  if (failureReason !== null) {
    return serializeSponsoredExecutionEconomics(deriveHostPaidGasEconomics(gasUsed, failureReason));
  }
  const { economics } = deriveSettlementExecutionEconomics({
    gasUsed,
    recoveredGasMist: BigInt(recovery.recoveredGasMist),
    hostFeeMist: BigInt(recovery.hostFeeMist),
    protocolFeeMist: BigInt(recovery.protocolFeeMist),
  });
  return serializeSponsoredExecutionEconomics(economics);
}

function recoveredResult(
  execution: ExecutingSponsoredExecutionRecord,
  transaction: SuiTransactionResult,
): { metadata: SponsorResultMetadata; promotion: PromotionReceiptFinalization } {
  const recovery = execution.recovery;
  const failed = transaction.outcome === 'failure';
  const congestion = failed && isCongestion(transaction);
  const outcome = failed ? (congestion ? 'congestion' : 'onchain_revert') : 'success';
  const failureReason = failed
    ? congestion
      ? SPONSOR_CONGESTION_FAILURE_REASON
      : sponsorOnchainRevertFailureReason(suiExecutionErrorMessage(transaction.error))
    : null;
  const metadata: SponsorResultMetadata = {
    sponsorAddress: execution.sponsorAddress,
    outcome,
    executionStage: congestion ? 'after_sponsor_signature' : 'on_chain',
    route: recovery.route,
    digest: transaction.digest,
    receiptId: execution.receiptId,
    senderAddress: recovery.senderAddress,
    executionPathKey: recovery.executionPathKey,
    orderIdHash: recovery.route === 'generic' ? recovery.orderIdHash : null,
    promotionId: recovery.route === 'promotion' ? recovery.promotionId : null,
    userId: recovery.route === 'promotion' ? recovery.userId : null,
    economics: congestion
      ? serializeSponsoredExecutionEconomics(unknownSponsoredExecutionEconomics(failureReason))
      : gasEconomics(recovery, transaction.effects.gasUsed, failureReason),
  };
  if (recovery.route === 'generic') return { metadata, promotion: { operation: 'none' } };
  if (congestion) return { metadata, promotion: { operation: 'release' } };
  return {
    metadata,
    promotion: {
      operation: 'consume',
      chargedMist: computeExecutionCostClaim(transaction.effects.gasUsed).simGas,
    },
  };
}

function unresolvedResult(execution: ExecutingSponsoredExecutionRecord): {
  metadata: SponsorResultMetadata;
  promotion: PromotionReceiptFinalization;
} {
  const recovery = execution.recovery;
  return {
    metadata: {
      sponsorAddress: execution.sponsorAddress,
      outcome: 'internal_error',
      executionStage: 'after_sponsor_signature',
      route: recovery.route,
      digest: execution.transactionDigest,
      receiptId: execution.receiptId,
      senderAddress: recovery.senderAddress,
      executionPathKey: recovery.executionPathKey,
      orderIdHash: recovery.route === 'generic' ? recovery.orderIdHash : null,
      promotionId: recovery.route === 'promotion' ? recovery.promotionId : null,
      userId: recovery.route === 'promotion' ? recovery.userId : null,
      economics: serializeSponsoredExecutionEconomics(
        unknownSponsoredExecutionEconomics('transaction_result_unresolved'),
      ),
    },
    promotion:
      recovery.route === 'promotion'
        ? { operation: 'consume', chargedMist: BigInt(recovery.reservedGasMist) }
        : { operation: 'none' },
  };
}

export interface SponsoredExecutionRecoveryOptions {
  readonly store: SponsoredExecutionStoreAdapter;
  readonly sui: SuiEndpointSnapshot;
  readonly intervalMs: number;
  readonly onSponsorResult: SponsorResultCallback;
  readonly lookup?: (digest: string, signal: AbortSignal) => Promise<SuiTransactionResult | null>;
}

/**
 * Bounded receipt recovery and callback delivery task.
 *
 * Ticks coalesce, one task runs at a time, and disposal aborts and awaits the
 * retained promise. Full batches yield before continuing so recovery cannot
 * monopolize the event loop.
 */
export class SponsoredExecutionRecovery {
  private readonly store: SponsoredExecutionStoreAdapter;
  private readonly sui: SuiEndpointSnapshot;
  private readonly intervalMs: number;
  private readonly callback: SponsorResultCallback;
  private readonly lookup: (
    digest: string,
    signal: AbortSignal,
  ) => Promise<SuiTransactionResult | null>;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private disposal: Promise<void> | null = null;
  private rerunRequested = false;
  private started = false;
  private disposed = false;

  constructor(options: SponsoredExecutionRecoveryOptions) {
    this.store = options.store;
    this.sui = options.sui;
    this.intervalMs = nodeTimerDelay(options.intervalMs, 'recovery intervalMs');
    this.callback = options.onSponsorResult;
    this.lookup =
      options.lookup ??
      (async (digest, signal) => {
        try {
          return await getSuiTransactionEffects(this.sui, { digest, signal });
        } catch (error) {
          if (error instanceof SuiOperationError && error.kind === 'not_found') return null;
          throw error;
        }
      });
  }

  /** Start scheduling and await the immediate recovery pass. */
  async start(): Promise<void> {
    if (this.disposed) throw new Error('Sponsored execution recovery is disposed');
    if (!this.started) {
      this.started = true;
      this.timer = setInterval(() => {
        void this.requestRun().catch(() => {
          // Durable indexes retain every unresolved item for the next tick.
        });
      }, this.intervalMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
    await this.requestRun();
  }

  requestRun(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.active) {
      this.rerunRequested = true;
      return this.active;
    }
    const tracked = this.runLoop().finally(() => {
      if (this.active === tracked) this.active = null;
      if (this.rerunRequested && !this.disposed) {
        this.rerunRequested = false;
        void this.requestRun().catch(() => {
          // Durable indexes retain every unresolved item for the next tick.
        });
      }
    });
    this.active = tracked;
    return tracked;
  }

  private async runLoop(): Promise<void> {
    await this.discardExpiredPreparedReceipts();
    await this.finalizeDueExecutions();
    await this.deliverCallbacks();
  }

  /** Visit every receipt due at this pass's first Redis-time snapshot once. */
  private async discardExpiredPreparedReceipts(): Promise<void> {
    let cursor: SponsoredExecutionRecoveryCursor | null = null;
    for (;;) {
      this.controller.signal.throwIfAborted();
      const page = await this.store.readExpiredPreparedReceipts(
        SPONSORED_EXECUTION_RECOVERY_BATCH_SIZE,
        cursor,
      );
      for (const entry of page.records) {
        this.controller.signal.throwIfAborted();
        await this.store.discardPreparedReceipt({
          expected: entry,
          result: preparedFailureResult(entry, 'prepared_receipt_expired'),
        });
      }
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
      await yieldTask();
    }
  }

  private async finalizeDueExecutions(): Promise<void> {
    let cursor: SponsoredExecutionRecoveryCursor | null = null;
    for (;;) {
      this.controller.signal.throwIfAborted();
      const page = await this.store.readDueExecutions(
        SPONSORED_EXECUTION_RECOVERY_BATCH_SIZE,
        cursor,
      );
      for (const execution of page.records) {
        this.controller.signal.throwIfAborted();
        let terminal: ReturnType<typeof recoveredResult> | ReturnType<typeof unresolvedResult>;
        try {
          const transaction = await this.lookup(
            execution.transactionDigest,
            this.controller.signal,
          );
          terminal = transaction
            ? recoveredResult(execution, transaction)
            : unresolvedResult(execution);
        } catch (error) {
          if (this.controller.signal.aborted) throw error;
          continue;
        }
        await this.store.finalizeSponsoredExecution({
          expected: execution,
          result: terminal.metadata,
          promotion: terminal.promotion,
        });
      }
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
      await yieldTask();
    }
  }

  private async deliverCallbacks(): Promise<void> {
    let cursor: SponsoredExecutionRecoveryCursor | null = null;
    for (;;) {
      this.controller.signal.throwIfAborted();
      const page = await this.store.readPendingCallbacks(
        SPONSORED_EXECUTION_RECOVERY_BATCH_SIZE,
        cursor,
      );
      for (const record of page.records) {
        this.controller.signal.throwIfAborted();
        try {
          await this.callback(sponsorResultMetadata(record.result), this.controller.signal);
        } catch (error) {
          if (this.controller.signal.aborted) throw error;
          continue;
        }
        this.controller.signal.throwIfAborted();
        await this.store.markCallbackDelivered(record);
      }
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
      await yieldTask();
    }
  }

  dispose(): Promise<void> {
    if (this.disposal !== null) return this.disposal;
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.controller.abort();
    this.disposal = this.active?.catch(() => undefined) ?? Promise.resolve();
    return this.disposal;
  }
}
