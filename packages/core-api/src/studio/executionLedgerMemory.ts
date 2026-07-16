import type {
  PromotionExecutionLedger,
  PromotionLedgerStatus,
  PromotionListLedgerStatus,
} from './executionLedger.js';
import {
  assertPromotionListLedgerBatchBound,
  PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS,
  PROMOTION_EXECUTION_LEDGER_SWEEP_BATCH_SIZE,
} from './executionLedger.js';
import type {
  ClaimOpts,
  ClaimResult,
  ConsumeResult,
  Entitlement,
  ReleaseResult,
  ReserveParams,
  ReserveResult,
} from './domain.js';
import {
  assertNonNegativeMist,
  assertPositiveMist,
  assertWithinLedgerBound,
} from './executionLedgerValueGuards.js';
import { MemoryPromotionStore } from './promotionStore.js';
import {
  assertPromotionLedgerReadState,
  assertPromotionOperationResultIdentity,
  assertPromotionReservationAccountingState,
  assertPromotionReservationIdentity,
  createPromotionClaimTransition,
  createPromotionFinalizeTransition,
  createPromotionReserveTransition,
  decodePromotionAccountingRecord,
  decodePromotionEntitlementRecord,
  decodePromotionOperationResultRecord,
  decodePromotionReservationRecord,
  promotionEntitlementFromRecord,
  promotionEntitlementKey,
  serializePromotionAccountingRecord,
  serializePromotionEntitlementRecord,
  serializePromotionOperationResultRecord,
  serializePromotionReservationRecord,
  type CurrentPromotionRecord,
  type PromotionAccountingRecord,
  type PromotionEntitlementRecord,
  type PromotionOperationResultRecord,
  type PromotionReservationRecord,
  PromotionRecordCorruptionError,
  PROMOTION_ENTITLEMENT_WITHOUT_ACCOUNTING_MESSAGE,
} from './promotionRecords.js';
import { type Clock, systemClock } from '../clock.js';

function cloneAccounting(record: PromotionAccountingRecord): PromotionAccountingRecord {
  return decodePromotionAccountingRecord(serializePromotionAccountingRecord(record));
}

function cloneEntitlement(record: PromotionEntitlementRecord): PromotionEntitlementRecord {
  return decodePromotionEntitlementRecord(serializePromotionEntitlementRecord(record));
}

function cloneReservation(record: PromotionReservationRecord): PromotionReservationRecord {
  return decodePromotionReservationRecord(serializePromotionReservationRecord(record));
}

function cloneResult(record: PromotionOperationResultRecord): PromotionOperationResultRecord {
  return decodePromotionOperationResultRecord(serializePromotionOperationResultRecord(record));
}

export class MemoryPromotionExecutionLedger implements PromotionExecutionLedger {
  private readonly accounting = new Map<string, PromotionAccountingRecord>();
  private readonly entitlements = new Map<string, PromotionEntitlementRecord>();
  private readonly reservations = new Map<string, PromotionReservationRecord>();
  private readonly operationResults = new Map<string, PromotionOperationResultRecord>();
  private runningSweepBatch: Promise<number> | null = null;

  constructor(
    private readonly promotionStore: MemoryPromotionStore,
    private readonly reservationTtlMs: number = PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS,
    private readonly clock: Clock = systemClock,
  ) {
    if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs < 0) {
      throw new Error(
        'MemoryPromotionExecutionLedger: reservationTtlMs must be a non-negative safe integer',
      );
    }
    promotionStore.bindAccountingExists((promotionId) => this.accounting.has(promotionId));
  }

  private requireActivePromotion(promotionId: string) {
    const current = this.promotionStore.readCurrentSync(promotionId);
    if (current === null || current.promotion.status !== 'active') return 'not_active';
    return current;
  }

  async claim(promotionId: string, userId: string, opts: ClaimOpts): Promise<ClaimResult> {
    const current = this.requireActivePromotion(promotionId);
    if (current === 'not_active') {
      return { ok: false, reason: 'promotion_not_active' };
    }
    const key = promotionEntitlementKey(promotionId, userId);
    const { accounting, entitlement } = this.readLedgerStateSnapshot(promotionId, userId, current);
    const transition = createPromotionClaimTransition({
      promotion: current.promotion,
      accounting,
      entitlement,
      userId,
      claimedAt: new Date(this.clock.nowMs()).toISOString(),
      useUntilAt: opts.useUntilAt,
    });
    if ('status' in transition) {
      return {
        ok: false,
        reason: transition.status === 'duplicate' ? 'duplicate' : 'capacity_exceeded',
      };
    }
    this.entitlements.set(key, transition.entitlement);
    this.accounting.set(promotionId, transition.accounting);
    return { ok: true, entitlement: promotionEntitlementFromRecord(transition.entitlement) };
  }

  async reserve(params: ReserveParams): Promise<ReserveResult> {
    const { promotionId, userId, receiptId, amountMist } = params;
    assertPositiveMist(amountMist, 'amountMist');
    assertWithinLedgerBound(amountMist, 'amountMist');
    const current = this.promotionStore.readCurrentSync(promotionId);

    const existingResult = this.operationResults.get(receiptId);
    const existingReservationRecord = this.reservations.get(receiptId);
    if (existingResult && existingReservationRecord) {
      throw new PromotionRecordCorruptionError(
        'Promotion receipt has both a reservation and a final operation result',
      );
    }
    if (existingResult) {
      await this.validateOperationResult(existingResult, receiptId);
      return { ok: false, reason: 'record_changed' };
    }

    const key = promotionEntitlementKey(promotionId, userId);
    const existingReservation = existingReservationRecord
      ? cloneReservation(existingReservationRecord)
      : null;
    if (existingReservation) {
      assertPromotionReservationIdentity(existingReservation, receiptId);
      if (!current) {
        throw new PromotionRecordCorruptionError('Reservation exists without its Promotion record');
      }
      if (
        existingReservation.promotionId !== promotionId ||
        existingReservation.userId !== userId ||
        existingReservation.amountMist !== amountMist.toString()
      ) {
        return { ok: false, reason: 'record_changed' };
      }
      const { accounting, entitlement } = this.readLedgerStateSnapshot(
        promotionId,
        userId,
        current,
      );
      if (!entitlement || !accounting) {
        throw new PromotionRecordCorruptionError(
          'Reservation exists without accounting or entitlement state',
        );
      }
      assertPromotionReservationAccountingState(accounting, entitlement, existingReservation);
      return { ok: true, entitlement: promotionEntitlementFromRecord(entitlement) };
    }

    if (current === null || current.promotion.status !== 'active') {
      return { ok: false, reason: 'promotion_not_active' };
    }
    const { accounting, entitlement } = this.readLedgerStateSnapshot(promotionId, userId, current);
    if (!entitlement) return { ok: false, reason: 'entitlement_not_found' };
    if (!accounting) {
      throw new PromotionRecordCorruptionError(PROMOTION_ENTITLEMENT_WITHOUT_ACCOUNTING_MESSAGE);
    }
    if (entitlement.activeReservationReceiptId !== null) {
      const activeReceiptId = entitlement.activeReservationReceiptId;
      const activeReservation = this.reservations.get(activeReceiptId);
      const activeResult = this.operationResults.get(activeReceiptId);
      if (!activeReservation || activeResult) {
        throw new PromotionRecordCorruptionError(
          'Promotion entitlement points to a missing or finalized reservation',
        );
      }
      const currentActiveReservation = cloneReservation(activeReservation);
      assertPromotionReservationIdentity(currentActiveReservation, activeReceiptId);
      assertPromotionReservationAccountingState(accounting, entitlement, currentActiveReservation);
    }
    const transition = createPromotionReserveTransition({
      promotion: current.promotion,
      accounting,
      entitlement,
      receiptId,
      amountMist,
      deadlineMs: this.clock.nowMs() + this.reservationTtlMs,
    });
    if ('status' in transition) return { ok: false, reason: transition.status };
    this.reservations.set(receiptId, transition.reservation);
    this.entitlements.set(key, transition.entitlement);
    this.accounting.set(promotionId, transition.accounting);
    return { ok: true, entitlement: promotionEntitlementFromRecord(transition.entitlement) };
  }

  async consume(receiptId: string, actualGasMist: bigint): Promise<ConsumeResult> {
    assertNonNegativeMist(actualGasMist, 'actualGasMist');
    assertWithinLedgerBound(actualGasMist, 'actualGasMist');
    const storedResult = this.operationResults.get(receiptId);
    const reservation = this.reservations.get(receiptId);
    if (storedResult && reservation) {
      throw new PromotionRecordCorruptionError(
        'Promotion receipt has both a reservation and a final operation result',
      );
    }
    if (storedResult) {
      const currentResult = await this.validateOperationResult(storedResult, receiptId);
      if (
        currentResult.operation !== 'consume' ||
        currentResult.amountMist !== actualGasMist.toString()
      ) {
        return { ok: false, reason: 'record_changed' };
      }
      return { ok: true, entitlement: promotionEntitlementFromRecord(currentResult.entitlement) };
    }
    if (!reservation) return { ok: false, reason: 'reservation_not_found' };
    const currentReservation = cloneReservation(reservation);
    assertPromotionReservationIdentity(currentReservation, receiptId);
    return this.applyConsume(currentReservation, actualGasMist);
  }

  private applyConsume(
    reservation: PromotionReservationRecord,
    actualGasMist: bigint,
  ): ConsumeResult {
    const key = promotionEntitlementKey(reservation.promotionId, reservation.userId);
    const { accounting, entitlement } = this.readLedgerStateSnapshot(
      reservation.promotionId,
      reservation.userId,
    );
    if (!entitlement || !accounting) {
      throw new PromotionRecordCorruptionError(
        'Reservation is missing accounting or entitlement state',
      );
    }
    assertPromotionReservationAccountingState(accounting, entitlement, reservation);

    const transition = createPromotionFinalizeTransition({
      accounting,
      entitlement,
      reservation,
      operation: 'consume',
      chargedMist: actualGasMist,
      usedAt: new Date(this.clock.nowMs()).toISOString(),
    });
    this.entitlements.set(key, transition.entitlement);
    this.accounting.set(reservation.promotionId, transition.accounting);
    this.reservations.delete(reservation.receiptId);
    this.operationResults.set(reservation.receiptId, transition.result);
    return { ok: true, entitlement: promotionEntitlementFromRecord(transition.entitlement) };
  }

  async release(receiptId: string): Promise<ReleaseResult> {
    const storedResult = this.operationResults.get(receiptId);
    const reservation = this.reservations.get(receiptId);
    if (storedResult && reservation) {
      throw new PromotionRecordCorruptionError(
        'Promotion receipt has both a reservation and a final operation result',
      );
    }
    if (storedResult) {
      const currentResult = await this.validateOperationResult(storedResult, receiptId);
      if (currentResult.operation !== 'release') {
        return { ok: false, reason: 'record_changed' };
      }
      return { ok: true, entitlement: promotionEntitlementFromRecord(currentResult.entitlement) };
    }
    if (!reservation) return { ok: false, reason: 'reservation_not_found' };
    const currentReservation = cloneReservation(reservation);
    assertPromotionReservationIdentity(currentReservation, receiptId);
    return this.applyRelease(currentReservation);
  }

  private applyRelease(reservation: PromotionReservationRecord): ReleaseResult {
    const key = promotionEntitlementKey(reservation.promotionId, reservation.userId);
    const { accounting, entitlement } = this.readLedgerStateSnapshot(
      reservation.promotionId,
      reservation.userId,
    );
    if (!entitlement || !accounting) {
      throw new PromotionRecordCorruptionError(
        'Reservation is missing accounting or entitlement state',
      );
    }
    assertPromotionReservationAccountingState(accounting, entitlement, reservation);
    const transition = createPromotionFinalizeTransition({
      accounting,
      entitlement,
      reservation,
      operation: 'release',
      chargedMist: 0n,
      usedAt: null,
    });
    this.entitlements.set(key, transition.entitlement);
    this.accounting.set(reservation.promotionId, transition.accounting);
    this.reservations.delete(reservation.receiptId);
    this.operationResults.set(reservation.receiptId, transition.result);
    return { ok: true, entitlement: promotionEntitlementFromRecord(transition.entitlement) };
  }

  private async validateOperationResult(
    stored: PromotionOperationResultRecord,
    receiptId: string,
  ): Promise<PromotionOperationResultRecord> {
    const result = cloneResult(stored);
    assertPromotionOperationResultIdentity(result, receiptId);
    const accounting = this.accounting.get(result.promotionId);
    const entitlement = this.entitlements.get(
      promotionEntitlementKey(result.promotionId, result.userId),
    );
    const current = this.promotionStore.readCurrentSync(result.promotionId);
    if (!accounting || !entitlement) {
      throw new PromotionRecordCorruptionError(
        'Promotion final result is missing accounting or entitlement state',
      );
    }
    assertPromotionLedgerReadState(
      current,
      result.promotionId,
      result.userId,
      cloneAccounting(accounting),
      cloneEntitlement(entitlement),
    );
    return result;
  }

  private async readLedgerState(
    promotionId: string,
    userId: string | null,
  ): Promise<{
    accounting: PromotionAccountingRecord | null;
    entitlement: PromotionEntitlementRecord | null;
  }> {
    return this.readLedgerStateSnapshot(promotionId, userId);
  }

  private readLedgerStateSnapshot(
    promotionId: string,
    userId: string | null,
    observedPromotion?: CurrentPromotionRecord | null,
  ): {
    accounting: PromotionAccountingRecord | null;
    entitlement: PromotionEntitlementRecord | null;
  } {
    const storedAccounting = this.accounting.get(promotionId);
    const storedEntitlement =
      userId === null ? null : this.entitlements.get(promotionEntitlementKey(promotionId, userId));
    const accounting = storedAccounting ? cloneAccounting(storedAccounting) : null;
    const entitlement = storedEntitlement ? cloneEntitlement(storedEntitlement) : null;
    const current =
      observedPromotion === undefined
        ? accounting === null
          ? null
          : this.promotionStore.readCurrentSync(promotionId)
        : observedPromotion;
    assertPromotionLedgerReadState(current, promotionId, userId, accounting, entitlement);
    return { accounting, entitlement };
  }

  async getEntitlement(promotionId: string, userId: string): Promise<Entitlement | null> {
    const { entitlement } = await this.readLedgerState(promotionId, userId);
    return entitlement ? promotionEntitlementFromRecord(entitlement) : null;
  }

  async getPromotionLedgerStatus(
    promotionId: string,
    userId: string | null,
  ): Promise<PromotionLedgerStatus> {
    const { accounting, entitlement } = await this.readLedgerState(promotionId, userId);
    return {
      promotionId,
      entitlement: entitlement ? promotionEntitlementFromRecord(entitlement) : null,
      claimedCount: accounting?.claimedCount ?? 0,
      budget: {
        availableMist: BigInt(accounting?.availableMist ?? '0'),
        reservedMist: BigInt(accounting?.reservedMist ?? '0'),
        consumedMist: BigInt(accounting?.consumedMist ?? '0'),
      },
    };
  }

  async getPromotionListLedgerStatuses(
    promotionIds: readonly string[],
    userId: string,
  ): Promise<PromotionListLedgerStatus[]> {
    assertPromotionListLedgerBatchBound(promotionIds);
    const snapshots = promotionIds.map((promotionId) => {
      const storedAccounting = this.accounting.get(promotionId);
      const storedEntitlement = this.entitlements.get(promotionEntitlementKey(promotionId, userId));
      return {
        promotionId,
        accounting: storedAccounting ? cloneAccounting(storedAccounting) : null,
        entitlement: storedEntitlement ? cloneEntitlement(storedEntitlement) : null,
      };
    });
    const currentPromotions = snapshots.map(({ promotionId, accounting }) =>
      accounting === null ? null : this.promotionStore.readCurrentSync(promotionId),
    );
    return snapshots.map(({ promotionId, accounting, entitlement }, index) => {
      assertPromotionLedgerReadState(
        currentPromotions[index]!,
        promotionId,
        userId,
        accounting,
        entitlement,
      );
      return {
        promotionId,
        entitlement: entitlement ? promotionEntitlementFromRecord(entitlement) : null,
        claimedCount: accounting?.claimedCount ?? 0,
        availableBudgetMist: BigInt(accounting?.availableMist ?? '0'),
      };
    });
  }

  async sweepExpiredReservations(): Promise<number> {
    if (this.runningSweepBatch) return this.runningSweepBatch;
    this.runningSweepBatch = Promise.resolve()
      .then(() => this.sweepExpiredReservationsBatch())
      .finally(() => {
        this.runningSweepBatch = null;
      });
    return this.runningSweepBatch;
  }

  private sweepExpiredReservationsBatch(): number {
    const now = this.clock.nowMs();
    const due = [...this.reservations.entries()]
      .map(([receiptId, record]) => {
        const current = cloneReservation(record);
        assertPromotionReservationIdentity(current, receiptId);
        return current;
      })
      .filter((record) => record.deadlineMs <= now)
      .sort(
        (left, right) =>
          left.deadlineMs - right.deadlineMs ||
          (left.receiptId < right.receiptId ? -1 : left.receiptId > right.receiptId ? 1 : 0),
      )
      .slice(0, PROMOTION_EXECUTION_LEDGER_SWEEP_BATCH_SIZE);
    let swept = 0;
    for (const reservation of due) {
      if (this.operationResults.has(reservation.receiptId)) {
        throw new PromotionRecordCorruptionError(
          'Promotion receipt has both a reservation and a final operation result',
        );
      }
      const result = this.applyRelease(reservation);
      if (result.ok) swept += 1;
    }
    return swept;
  }

  async dispose(): Promise<void> {
    await this.runningSweepBatch;
  }
}
