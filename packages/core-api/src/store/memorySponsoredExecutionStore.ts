import { createHash } from 'node:crypto';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import type { MemorySponsorPoolRecordAdapter } from '../context.js';
import { type Clock, systemClock } from '../clock.js';
import type { SponsorResultEconomics, SponsorResultMetadata } from '../handlers/sponsorResult.js';
import type {
  MemoryPromotionReceiptTransitionAccess,
  PromotionExecutionStartPlan,
  PromotionFinalizationPlan,
  PromotionPreparedReceiptCommitPlan,
} from '../studio/executionLedger.js';
import { PREPARE_TTL_MS } from '../preparePolicy.js';
import {
  PrepareOverloadError,
  PrepareSenderQuotaError,
  PrepareStudioUserQuotaError,
} from './prepareErrors.js';
import {
  decodePreparedTxEntry,
  parseCurrentPreparedTxDraft,
  serializePreparedTxEntry,
  type PreparedTxDraft,
  type PreparedTxEntry,
} from './prepareTypes.js';
import {
  createExecutingSponsoredExecutionRecordParts,
  decodeSponsoredExecutionRecord,
  materializeExecutingSponsoredExecutionRecord,
  serializeSponsoredExecutionRecord,
  SponsoredExecutionRecordCorruptionError,
  storedSponsorResultMatchesMetadata,
  storeSponsorResult,
  type ExecutingSponsoredExecutionRecord,
  type FinalSponsoredExecutionRecord,
} from './sponsoredExecutionRecords.js';
import { promotionOperationResultMatchesExpectation } from '../studio/promotionRecords.js';
import {
  MAX_CONCURRENT_PREPARED_PER_IP,
  MAX_OUTSTANDING_PREPARED_PER_SENDER,
  MAX_OUTSTANDING_PREPARED_PER_STUDIO_USER,
  SPONSORED_EXECUTION_RECOVERY_BATCH_SIZE,
  assertFinalResultMatchesExecution,
  assertPreparedResultMatchesReceipt,
  assertRecoveryMatchesPreparedReceipt,
  sponsoredExecutionOrderIdHash,
  type BeginSponsoredExecutionInput,
  type BeginSponsoredExecutionResult,
  type DiscardPreparedReceiptInput,
  type DiscardPreparedReceiptResult,
  type FinalizeSponsoredExecutionInput,
  type FinalizeSponsoredExecutionResult,
  type SponsoredExecutionRecoveryCursor,
  type SponsoredExecutionRecoveryPage,
  type SponsoredExecutionStoreAdapter,
} from './sponsoredExecutionStore.js';

const U64_MAX = (1n << 64n) - 1n;

export interface MemorySponsoredExecutionStoreOptions {
  readonly prepareTtlMs?: number;
  readonly maxPerIp?: number;
  readonly maxPerStudioUser?: number;
  readonly maxOutstandingPerSender?: number;
  readonly clock?: Clock;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function deadline(nowMs: number, durationMs: number, label: string): number {
  const result = nowMs + durationMs;
  if (!Number.isSafeInteger(result) || result <= nowMs)
    throw new Error(`${label} overflows the safe time range`);
  return result;
}

function unknownEconomics(reason: string): SponsorResultEconomics {
  return { economicsStatus: 'unknown', failureReason: reason };
}

function preparedDiscardResult(entry: PreparedTxEntry, reason: string): SponsorResultMetadata {
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
    economics: unknownEconomics(reason),
  };
}

function addToIndex(
  index: Map<string, Map<string, number>>,
  key: string,
  id: string,
  score: number,
): void {
  const values = index.get(key) ?? new Map<string, number>();
  values.set(id, score);
  index.set(key, values);
}

function removeFromIndex(index: Map<string, Map<string, number>>, key: string, id: string): void {
  const values = index.get(key);
  if (!values) return;
  values.delete(id);
  if (values.size === 0) index.delete(key);
}

function compareReceiptIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readRecoveryPage(
  index: Map<string, number>,
  nowMs: number,
  limit: number,
  cursor: SponsoredExecutionRecoveryCursor | null,
): {
  readonly positions: readonly (readonly [receiptId: string, scoreMs: number])[];
  readonly nextCursor: SponsoredExecutionRecoveryCursor | null;
} {
  const throughMs = cursor?.throughMs ?? nowMs;
  if (
    !Number.isSafeInteger(throughMs) ||
    throughMs <= 0 ||
    (cursor !== null &&
      (!Number.isSafeInteger(cursor.scoreMs) ||
        cursor.scoreMs <= 0 ||
        cursor.scoreMs > throughMs ||
        cursor.receiptId.length === 0 ||
        cursor.receiptId.includes('\0')))
  ) {
    throw new Error('Recovery cursor is invalid');
  }
  const positions = [...index.entries()]
    .filter(([receiptId, scoreMs]) => {
      if (scoreMs > throughMs) return false;
      if (cursor === null) return true;
      return (
        scoreMs > cursor.scoreMs ||
        (scoreMs === cursor.scoreMs && compareReceiptIds(receiptId, cursor.receiptId) > 0)
      );
    })
    .sort((left, right) => left[1] - right[1] || compareReceiptIds(left[0], right[0]))
    .slice(0, limit);
  const last = positions.at(-1);
  return {
    positions,
    nextCursor:
      positions.length === limit && last
        ? { throughMs, scoreMs: last[1], receiptId: last[0] }
        : null,
  };
}

export class MemorySponsoredExecutionStore implements SponsoredExecutionStoreAdapter {
  private readonly prepared = new Map<string, string>();
  private readonly executing = new Map<string, string>();
  private readonly final = new Map<string, string>();
  private readonly preparedDeadlines = new Map<string, number>();
  private readonly executionDeadlines = new Map<string, number>();
  private readonly pendingCallbacks = new Map<string, number>();
  private readonly ipIndex = new Map<string, Map<string, number>>();
  private readonly senderIndex = new Map<string, Map<string, number>>();
  private readonly userIndex = new Map<string, Map<string, number>>();
  private readonly nonce = new Map<string, bigint>();
  private readonly prepareTtlMs: number;
  private readonly maxPerIp: number;
  private readonly maxPerStudioUser: number;
  private readonly maxOutstandingPerSender: number;
  private readonly clock: Clock;

  constructor(
    private readonly sponsorPool: MemorySponsorPoolRecordAdapter,
    private readonly promotionLedger: MemoryPromotionReceiptTransitionAccess | undefined,
    options: MemorySponsoredExecutionStoreOptions = {},
  ) {
    this.prepareTtlMs = positiveSafeInteger(options.prepareTtlMs ?? PREPARE_TTL_MS, 'prepareTtlMs');
    this.maxPerIp = positiveSafeInteger(
      options.maxPerIp ?? MAX_CONCURRENT_PREPARED_PER_IP,
      'maxPerIp',
    );
    this.maxPerStudioUser = positiveSafeInteger(
      options.maxPerStudioUser ?? MAX_OUTSTANDING_PREPARED_PER_STUDIO_USER,
      'maxPerStudioUser',
    );
    this.maxOutstandingPerSender = positiveSafeInteger(
      options.maxOutstandingPerSender ?? MAX_OUTSTANDING_PREPARED_PER_SENDER,
      'maxOutstandingPerSender',
    );
    this.clock = options.clock ?? systemClock;
  }

  private requirePromotionLedger(): MemoryPromotionReceiptTransitionAccess {
    if (!this.promotionLedger) throw new Error('Promotion receipt transition access is required');
    return this.promotionLedger;
  }

  async commitPreparedReceipt(value: PreparedTxDraft): Promise<PreparedTxEntry> {
    const draft = parseCurrentPreparedTxDraft(value);
    for (let attempt = 0; attempt < 2; attempt++) {
      const nowMs = this.clock.nowMs();
      const currentDeadline = deadline(nowMs, this.prepareTtlMs, 'Prepared receipt deadline');
      const entry = decodePreparedTxEntry(
        serializePreparedTxEntry({ ...draft, issuedAt: nowMs }),
        draft.receiptId,
      );
      if (
        this.prepared.has(draft.receiptId) ||
        this.executing.has(draft.receiptId) ||
        this.final.has(draft.receiptId)
      ) {
        throw new Error('Prepared receipt identity already exists');
      }
      const ipEntries = this.ipIndex.get(draft.clientIp);
      if ((ipEntries?.size ?? 0) >= this.maxPerIp) {
        if (attempt === 0) {
          const oldestId = [...ipEntries!.entries()].sort(
            (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
          )[0]![0];
          const oldest = await this.readPreparedReceipt(oldestId);
          if (!oldest) throw new Error('Prepared IP index points to a missing record');
          await this.discardPreparedReceipt({
            expected: oldest,
            result: preparedDiscardResult(
              oldest,
              'Replaced by a newer prepared transaction from the same client IP',
            ),
          });
          continue;
        }
        throw new PrepareOverloadError(this.maxPerIp, this.maxPerIp);
      }
      if (
        draft.mode === 'promotion' &&
        (this.userIndex.get(draft.userId)?.size ?? 0) >= this.maxPerStudioUser
      ) {
        throw new PrepareStudioUserQuotaError(draft.userId, this.maxPerStudioUser);
      }
      const senderEntries = this.senderIndex.get(draft.senderAddress);
      if (
        draft.mode === 'promotion' &&
        (senderEntries?.size ?? 0) >= this.maxOutstandingPerSender
      ) {
        throw new PrepareSenderQuotaError(draft.senderAddress, this.maxOutstandingPerSender);
      }
      if (draft.mode === 'generic' && this.nonce.get(draft.receiptId) !== draft.nonce) {
        throw new Error('Prepared receipt nonce reservation changed');
      }
      let promotionCommitPlan: PromotionPreparedReceiptCommitPlan | null = null;
      if (entry.mode === 'promotion') {
        const result = await this.requirePromotionLedger().preparePreparedReceiptCommit({
          receiptId: entry.receiptId,
          promotionId: entry.promotionId,
          userId: entry.userId,
        });
        if (result.status !== 'ready') {
          throw new Error(`Promotion reservation cannot commit prepared receipt: ${result.status}`);
        }
        promotionCommitPlan = result.plan;
      }
      const lease = await this.sponsorPool.readSponsorLeaseRecord(draft.sponsorAddress);
      if (!lease) throw new Error('Reserved sponsor lease is missing');
      const leaseTransition = this.sponsorPool.prepareCommittedSponsorLeaseRecord(
        lease,
        draft.receiptId,
        draft.txBytesHash,
        currentDeadline,
      );
      if (!this.sponsorPool.matchesSponsorLeaseRecordTransition(leaseTransition)) {
        throw new Error('Reserved sponsor lease changed before prepared commit');
      }
      if (
        promotionCommitPlan &&
        !this.requirePromotionLedger().matchesPreparedReceiptCommitPlan(promotionCommitPlan)
      ) {
        throw new Error('Promotion reservation changed before prepared commit');
      }
      if (!this.sponsorPool.applySponsorLeaseRecordTransition(leaseTransition)) {
        throw new Error('Reserved sponsor lease changed during prepared commit');
      }
      if (
        promotionCommitPlan &&
        !this.requirePromotionLedger().applyPreparedReceiptCommitPlan(promotionCommitPlan)
      ) {
        throw new Error('Promotion reservation changed during prepared commit');
      }
      this.prepared.set(entry.receiptId, serializePreparedTxEntry(entry));
      this.preparedDeadlines.set(entry.receiptId, currentDeadline);
      addToIndex(this.ipIndex, entry.clientIp, entry.receiptId, nowMs);
      addToIndex(this.senderIndex, entry.senderAddress, entry.receiptId, nowMs);
      if (entry.mode === 'promotion')
        addToIndex(this.userIndex, entry.userId, entry.receiptId, nowMs);
      return entry;
    }
    throw new Error('Prepared receipt commit exhausted its bounded retry');
  }

  async readPreparedReceipt(receiptId: string): Promise<PreparedTxEntry | null> {
    const raw = this.prepared.get(receiptId);
    return raw === undefined ? null : decodePreparedTxEntry(raw, receiptId);
  }

  private matchesPrepared(entry: PreparedTxEntry): boolean {
    return this.prepared.get(entry.receiptId) === serializePreparedTxEntry(entry);
  }

  private matchesPreparedIndexes(entry: PreparedTxEntry): boolean {
    if (
      this.preparedDeadlines.get(entry.receiptId) !==
        deadline(entry.issuedAt, this.prepareTtlMs, 'Prepared receipt deadline') ||
      this.ipIndex.get(entry.clientIp)?.get(entry.receiptId) !== entry.issuedAt ||
      this.senderIndex.get(entry.senderAddress)?.get(entry.receiptId) !== entry.issuedAt
    ) {
      return false;
    }
    return entry.mode === 'generic'
      ? this.nonce.get(entry.receiptId) === entry.nonce
      : this.userIndex.get(entry.userId)?.get(entry.receiptId) === entry.issuedAt;
  }

  private removePrepared(entry: PreparedTxEntry): void {
    this.prepared.delete(entry.receiptId);
    this.preparedDeadlines.delete(entry.receiptId);
    removeFromIndex(this.ipIndex, entry.clientIp, entry.receiptId);
    removeFromIndex(this.senderIndex, entry.senderAddress, entry.receiptId);
    if (entry.mode === 'promotion') removeFromIndex(this.userIndex, entry.userId, entry.receiptId);
    if (entry.mode === 'generic') this.nonce.delete(entry.receiptId);
  }

  async beginSponsoredExecution(
    input: BeginSponsoredExecutionInput,
  ): Promise<BeginSponsoredExecutionResult> {
    const prepared = await this.readPreparedReceipt(input.receiptId);
    if (!prepared) return { status: 'not_found' };
    if (prepared.mode !== input.expectedMode)
      return { status: 'mode_mismatch', actualMode: prepared.mode };
    assertRecoveryMatchesPreparedReceipt(prepared, input.recovery);
    const hash = createHash('sha256').update(input.txBytes).digest('hex');
    if (hash !== prepared.txBytesHash) return { status: 'hash_mismatch' };
    const nowMs = this.clock.nowMs();
    const preparedDeadline = deadline(
      prepared.issuedAt,
      this.prepareTtlMs,
      'Prepared receipt deadline',
    );
    if (nowMs >= preparedDeadline) return { status: 'expired' };
    const executionDeadline = deadline(nowMs, input.executionBudgetMs, 'Execution deadline');
    const transactionDigest = TransactionDataBuilder.getDigestFromBytes(input.txBytes);
    const lease = await this.sponsorPool.readSponsorLeaseRecord(prepared.sponsorAddress);
    if (!lease) return { status: 'state_changed' };
    const leaseTransition = this.sponsorPool.prepareExecutingSponsorLeaseRecord(
      lease,
      prepared.receiptId,
      prepared.txBytesHash,
      transactionDigest,
    );
    let promotionPlan: PromotionExecutionStartPlan | null = null;
    if (prepared.mode === 'promotion') {
      const result = await this.requirePromotionLedger().prepareExecutionStart({
        receiptId: prepared.receiptId,
        promotionId: prepared.promotionId,
        userId: prepared.userId,
      });
      if (result.status !== 'ready') return { status: result.status };
      promotionPlan = result.plan;
    }
    if (
      !this.matchesPrepared(prepared) ||
      !this.matchesPreparedIndexes(prepared) ||
      this.preparedDeadlines.get(prepared.receiptId) !== preparedDeadline ||
      this.executing.has(prepared.receiptId) ||
      this.final.has(prepared.receiptId)
    ) {
      return { status: 'state_changed' };
    }
    if (!this.sponsorPool.matchesSponsorLeaseRecordDeadlineTransition(leaseTransition))
      return { status: 'state_changed' };
    if (promotionPlan && !this.requirePromotionLedger().matchesExecutionStartPlan(promotionPlan))
      return { status: 'state_changed' };
    const executionValue = materializeExecutingSponsoredExecutionRecord(
      createExecutingSponsoredExecutionRecordParts({
        state: 'executing',
        receiptId: prepared.receiptId,
        sponsorAddress: prepared.sponsorAddress,
        txBytesHash: prepared.txBytesHash,
        transactionDigest,
        recovery: input.recovery,
      }),
      executionDeadline,
    );
    const execution = executionValue.record;
    if (
      !this.sponsorPool.applySponsorLeaseRecordDeadlineTransition(
        leaseTransition,
        executionDeadline,
      )
    )
      return { status: 'state_changed' };
    if (
      promotionPlan &&
      !this.requirePromotionLedger().applyExecutionStartPlan(promotionPlan, executionDeadline)
    ) {
      throw new Error('Promotion reservation changed after the atomic precheck');
    }
    this.removePrepared(prepared);
    this.executing.set(prepared.receiptId, executionValue.raw);
    this.executionDeadlines.set(prepared.receiptId, executionDeadline);
    return { status: 'executing', prepared, execution };
  }

  async discardPreparedReceipt(
    input: DiscardPreparedReceiptInput,
  ): Promise<DiscardPreparedReceiptResult> {
    const expected = decodePreparedTxEntry(
      serializePreparedTxEntry(input.expected),
      input.expected.receiptId,
    );
    assertPreparedResultMatchesReceipt(expected, input.result);
    const nowMs = this.clock.nowMs();
    const existingFinal = this.final.get(expected.receiptId);
    if (existingFinal) {
      const record = this.finalRecord(existingFinal, expected.receiptId);
      if (
        record.transactionDigest !== null ||
        !storedSponsorResultMatchesMetadata(record.result, input.result)
      ) {
        return { status: 'state_changed' };
      }
      if (expected.mode === 'promotion') {
        const promotion = await this.requirePromotionLedger().prepareFinalization({
          receiptId: expected.receiptId,
          operation: 'release',
          chargedMist: 0n,
          usedAtMs: nowMs,
          reservationStage: 'prepared',
        });
        if (promotion.status !== 'already_final') {
          throw new SponsoredExecutionRecordCorruptionError(
            'Final sponsored receipt is missing its Promotion operation result',
          );
        }
        if (
          !promotionOperationResultMatchesExpectation(promotion.result, {
            receiptId: expected.receiptId,
            promotionId: expected.promotionId,
            userId: expected.userId,
            operation: 'release',
            amountMist: expected.reservedGasMist.toString(),
          })
        )
          return { status: 'state_changed' };
      }
      return { status: 'already_final', record };
    }
    if (!this.matchesPrepared(expected)) return { status: 'state_changed' };
    const lease = await this.sponsorPool.readSponsorLeaseRecord(expected.sponsorAddress);
    if (!lease) return { status: 'state_changed' };
    const leaseRemoval = this.sponsorPool.prepareSponsorLeaseRecordRemoval(lease, {
      stage: 'committed',
      receiptId: expected.receiptId,
      txBytesHash: expected.txBytesHash,
    });
    let promotionPlan: PromotionFinalizationPlan | null = null;
    if (expected.mode === 'promotion') {
      const result = await this.requirePromotionLedger().prepareFinalization({
        receiptId: expected.receiptId,
        operation: 'release',
        chargedMist: 0n,
        usedAtMs: nowMs,
        reservationStage: 'prepared',
      });
      if (result.status === 'already_final') {
        throw new SponsoredExecutionRecordCorruptionError(
          'Promotion operation result exists without a final sponsored receipt',
        );
      }
      if (result.status !== 'ready') return { status: 'state_changed' };
      promotionPlan = result.plan;
    }
    if (
      !this.matchesPrepared(expected) ||
      !this.matchesPreparedIndexes(expected) ||
      !this.sponsorPool.matchesSponsorLeaseRecordRemoval(leaseRemoval)
    )
      return { status: 'state_changed' };
    if (promotionPlan && !this.requirePromotionLedger().matchesFinalizationPlan(promotionPlan))
      return { status: 'state_changed' };
    const finalRecord: FinalSponsoredExecutionRecord = {
      state: 'final',
      receiptId: expected.receiptId,
      sponsorAddress: expected.sponsorAddress,
      transactionDigest: null,
      finalizedAtMs: nowMs,
      callbackDelivery: 'pending',
      result: storeSponsorResult(input.result),
    };
    if (!this.sponsorPool.applySponsorLeaseRecordRemoval(leaseRemoval))
      return { status: 'state_changed' };
    if (promotionPlan && !this.requirePromotionLedger().applyFinalizationPlan(promotionPlan))
      throw new Error('Promotion reservation changed after the atomic precheck');
    this.removePrepared(expected);
    this.final.set(expected.receiptId, serializeSponsoredExecutionRecord(finalRecord));
    this.pendingCallbacks.set(expected.receiptId, nowMs);
    return { status: 'discarded', record: finalRecord };
  }

  async finalizeSponsoredExecution(
    input: FinalizeSponsoredExecutionInput,
  ): Promise<FinalizeSponsoredExecutionResult> {
    assertFinalResultMatchesExecution(input.expected, input.result, input.promotion);
    if (
      input.result.digest !== undefined &&
      input.result.digest !== input.expected.transactionDigest
    ) {
      throw new Error('Sponsor result digest does not match the executing transaction digest');
    }
    const existingFinal = this.final.get(input.expected.receiptId);
    if (existingFinal) {
      const record = this.finalRecord(existingFinal, input.expected.receiptId);
      if (
        record.transactionDigest !== input.expected.transactionDigest ||
        !storedSponsorResultMatchesMetadata(record.result, input.result)
      ) {
        return { status: 'state_changed' };
      }
      if (input.promotion.operation !== 'none') {
        const nowMs = this.clock.nowMs();
        const promotion = await this.requirePromotionLedger().prepareFinalization({
          receiptId: input.expected.receiptId,
          operation: input.promotion.operation,
          chargedMist: input.promotion.operation === 'consume' ? input.promotion.chargedMist : 0n,
          usedAtMs: nowMs,
          reservationStage: 'executing',
        });
        if (promotion.status !== 'already_final') {
          throw new SponsoredExecutionRecordCorruptionError(
            'Final sponsored receipt is missing its Promotion operation result',
          );
        }
        const recovery = input.expected.recovery;
        if (recovery.route !== 'promotion') {
          throw new SponsoredExecutionRecordCorruptionError(
            'Promotion finalization does not match the execution recovery route',
          );
        }
        if (
          !promotionOperationResultMatchesExpectation(promotion.result, {
            receiptId: input.expected.receiptId,
            promotionId: recovery.promotionId,
            userId: recovery.userId,
            operation: input.promotion.operation,
            amountMist:
              input.promotion.operation === 'consume'
                ? input.promotion.chargedMist.toString()
                : recovery.reservedGasMist,
          })
        )
          return { status: 'state_changed' };
      }
      return { status: 'already_final', record };
    }
    if (
      this.executing.get(input.expected.receiptId) !==
        serializeSponsoredExecutionRecord(input.expected) ||
      this.executionDeadlines.get(input.expected.receiptId) !== input.expected.deadlineMs
    )
      return { status: 'state_changed' };
    const lease = await this.sponsorPool.readSponsorLeaseRecord(input.expected.sponsorAddress);
    if (!lease) return { status: 'state_changed' };
    const leaseRemoval = this.sponsorPool.prepareSponsorLeaseRecordRemoval(lease, {
      stage: 'executing',
      receiptId: input.expected.receiptId,
      txBytesHash: input.expected.txBytesHash,
      transactionDigest: input.expected.transactionDigest,
    });
    let promotionPlan: PromotionFinalizationPlan | null = null;
    const nowMs = this.clock.nowMs();
    if (input.promotion.operation !== 'none') {
      const result = await this.requirePromotionLedger().prepareFinalization({
        receiptId: input.expected.receiptId,
        operation: input.promotion.operation,
        chargedMist: input.promotion.operation === 'consume' ? input.promotion.chargedMist : 0n,
        usedAtMs: nowMs,
        reservationStage: 'executing',
      });
      if (result.status === 'already_final') {
        throw new SponsoredExecutionRecordCorruptionError(
          'Promotion operation result exists without a final sponsored receipt',
        );
      }
      if (result.status !== 'ready') return { status: 'state_changed' };
      promotionPlan = result.plan;
    }
    if (!this.sponsorPool.matchesSponsorLeaseRecordRemoval(leaseRemoval))
      return { status: 'state_changed' };
    if (promotionPlan && !this.requirePromotionLedger().matchesFinalizationPlan(promotionPlan))
      return { status: 'state_changed' };
    const finalRecord: FinalSponsoredExecutionRecord = {
      state: 'final',
      receiptId: input.expected.receiptId,
      sponsorAddress: input.expected.sponsorAddress,
      transactionDigest: input.expected.transactionDigest,
      finalizedAtMs: nowMs,
      callbackDelivery: 'pending',
      result: storeSponsorResult(input.result),
    };
    if (!this.sponsorPool.applySponsorLeaseRecordRemoval(leaseRemoval))
      return { status: 'state_changed' };
    if (promotionPlan && !this.requirePromotionLedger().applyFinalizationPlan(promotionPlan))
      throw new Error('Promotion reservation changed after the atomic precheck');
    this.executing.delete(input.expected.receiptId);
    this.executionDeadlines.delete(input.expected.receiptId);
    this.final.set(input.expected.receiptId, serializeSponsoredExecutionRecord(finalRecord));
    this.pendingCallbacks.set(input.expected.receiptId, nowMs);
    return { status: 'finalized', record: finalRecord };
  }

  private finalRecord(raw: string, receiptId: string): FinalSponsoredExecutionRecord {
    const record = decodeSponsoredExecutionRecord(raw);
    if (record.state !== 'final' || record.receiptId !== receiptId)
      throw new Error('Final sponsored execution record identity is invalid');
    return record;
  }

  async readExpiredPreparedReceipts(
    limit: number,
    cursor: SponsoredExecutionRecoveryCursor | null,
  ): Promise<SponsoredExecutionRecoveryPage<PreparedTxEntry>> {
    this.assertLimit(limit);
    const page = readRecoveryPage(
      this.preparedDeadlines,
      cursor?.throughMs ?? this.clock.nowMs(),
      limit,
      cursor,
    );
    const records = page.positions.map(([receiptId, scoreMs]) => {
      const raw = this.prepared.get(receiptId);
      if (!raw) throw new Error('Prepared deadline index points to a missing record');
      const entry = decodePreparedTxEntry(raw, receiptId);
      if (deadline(entry.issuedAt, this.prepareTtlMs, 'Prepared receipt deadline') !== scoreMs)
        throw new Error('Prepared receipt deadline index is inconsistent');
      return entry;
    });
    return { records, nextCursor: page.nextCursor };
  }

  async readDueExecutions(
    limit: number,
    cursor: SponsoredExecutionRecoveryCursor | null,
  ): Promise<SponsoredExecutionRecoveryPage<ExecutingSponsoredExecutionRecord>> {
    this.assertLimit(limit);
    const page = readRecoveryPage(
      this.executionDeadlines,
      cursor?.throughMs ?? this.clock.nowMs(),
      limit,
      cursor,
    );
    const records = page.positions.map(([receiptId, scoreMs]) => {
      const raw = this.executing.get(receiptId);
      if (!raw) throw new Error('Execution deadline index points to a missing record');
      const record = decodeSponsoredExecutionRecord(raw);
      if (
        record.state !== 'executing' ||
        record.receiptId !== receiptId ||
        record.deadlineMs !== scoreMs
      )
        throw new Error('Executing receipt deadline index is inconsistent');
      return record;
    });
    return { records, nextCursor: page.nextCursor };
  }

  async readPendingCallbacks(
    limit: number,
    cursor: SponsoredExecutionRecoveryCursor | null,
  ): Promise<SponsoredExecutionRecoveryPage<FinalSponsoredExecutionRecord>> {
    this.assertLimit(limit);
    const page = readRecoveryPage(
      this.pendingCallbacks,
      cursor?.throughMs ?? this.clock.nowMs(),
      limit,
      cursor,
    );
    const records = page.positions.map(([receiptId, scoreMs]) => {
      const raw = this.final.get(receiptId);
      if (!raw) throw new Error('Pending callback index points to a missing record');
      const record = this.finalRecord(raw, receiptId);
      if (record.callbackDelivery !== 'pending' || record.finalizedAtMs !== scoreMs)
        throw new Error('Pending callback index is inconsistent');
      return record;
    });
    return { records, nextCursor: page.nextCursor };
  }

  async markCallbackDelivered(expected: FinalSponsoredExecutionRecord): Promise<boolean> {
    if (
      expected.callbackDelivery !== 'pending' ||
      this.final.get(expected.receiptId) !== serializeSponsoredExecutionRecord(expected) ||
      this.pendingCallbacks.get(expected.receiptId) !== expected.finalizedAtMs
    )
      return false;
    const next: FinalSponsoredExecutionRecord = { ...expected, callbackDelivery: 'delivered' };
    this.final.set(expected.receiptId, serializeSponsoredExecutionRecord(next));
    this.pendingCallbacks.delete(expected.receiptId);
    return true;
  }

  async checkUserQuota(userId: string): Promise<'ok' | { exceeded: true; limit: number }> {
    const live = this.userIndex.get(userId)?.size ?? 0;
    return live >= this.maxPerStudioUser ? { exceeded: true, limit: this.maxPerStudioUser } : 'ok';
  }

  async reserveNonce(
    senderAddress: string,
    onchainLastNonce: bigint,
    receiptId: string,
  ): Promise<bigint> {
    if (onchainLastNonce < 0n || onchainLastNonce > U64_MAX) {
      throw new Error('On-chain nonce must be a u64 value');
    }
    const nowMs = this.clock.nowMs();
    const entries = this.senderIndex.get(senderAddress);
    const existing = this.nonce.get(receiptId);
    if (existing !== undefined) {
      if (!entries?.has(receiptId)) throw new Error('Nonce reservation identity changed');
      return existing;
    }
    if (entries) {
      for (const [id, issuedAt] of [...entries]) {
        if (!this.prepared.has(id) && this.nonce.has(id) && issuedAt + this.prepareTtlMs <= nowMs) {
          entries.delete(id);
          this.nonce.delete(id);
        } else if (!this.prepared.has(id) && !this.nonce.has(id)) {
          entries.delete(id);
        }
      }
      if (entries.size === 0) this.senderIndex.delete(senderAddress);
    }
    const liveEntries = this.senderIndex.get(senderAddress);
    if ((liveEntries?.size ?? 0) >= this.maxOutstandingPerSender)
      throw new PrepareSenderQuotaError(senderAddress, this.maxOutstandingPerSender);
    let maximum = onchainLastNonce;
    for (const id of liveEntries?.keys() ?? []) {
      const value = this.nonce.get(id);
      if (value !== undefined && value > maximum) maximum = value;
    }
    if (maximum >= U64_MAX) throw new Error('No u64 nonce remains for this sender');
    const next = maximum + 1n;
    this.nonce.set(receiptId, next);
    addToIndex(this.senderIndex, senderAddress, receiptId, nowMs);
    return next;
  }

  async releaseNonceReservation(receiptId: string, senderAddress: string): Promise<void> {
    if (this.prepared.has(receiptId)) return;
    this.nonce.delete(receiptId);
    removeFromIndex(this.senderIndex, senderAddress, receiptId);
  }

  private assertLimit(limit: number): void {
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > SPONSORED_EXECUTION_RECOVERY_BATCH_SIZE
    ) {
      throw new Error(
        `Recovery read limit must be between 1 and ${SPONSORED_EXECUTION_RECOVERY_BATCH_SIZE}`,
      );
    }
  }

  async dispose(): Promise<void> {}
}
