import {
  isPromotionStatus,
  isValidStudioUserId,
  MAX_PROMOTION_LEDGER_VALUE_MIST,
  parsePromotionId,
  STUDIO_USER_ID_MAX_LENGTH,
} from '@stelis/contracts';
import type { Entitlement, Promotion } from './domain.js';
import { parsePromotionLedgerBudget } from './executionLedgerValueGuards.js';

const LEDGER_PREFIX = 'stelis:promotion_execution_ledger:';
const ACCOUNTING_RECORD_PREFIX = `${LEDGER_PREFIX}accounting:`;
const ENTITLEMENT_RECORD_PREFIX = `${LEDGER_PREFIX}entitlement:`;
const RESERVATION_RECORD_PREFIX = `${LEDGER_PREFIX}reservation:`;
const OPERATION_RESULT_RECORD_PREFIX = `${LEDGER_PREFIX}result:`;
const DECIMAL_RE = /^(?:0|[1-9]\d*)$/;
const POSITIVE_DECIMAL_RE = /^[1-9]\d*$/;

export class PromotionRecordCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromotionRecordCorruptionError';
  }
}

export const PROMOTION_ENTITLEMENT_WITHOUT_ACCOUNTING_MESSAGE =
  'Promotion entitlement exists without accounting';

export interface CurrentPromotionRecord {
  readonly promotion: Promotion;
  readonly serialized: string;
}

export interface PromotionAccountingRecord {
  readonly promotionId: string;
  readonly maxParticipants: number;
  readonly perUserGasAllowanceMist: string;
  readonly totalBudgetMist: string;
  readonly claimedCount: number;
  readonly availableMist: string;
  readonly reservedMist: string;
  readonly consumedMist: string;
}

export interface PromotionEntitlementRecord {
  readonly promotionId: string;
  readonly userId: string;
  readonly claimedAt: string;
  readonly useUntilAt: string | null;
  readonly remainingMist: string;
  readonly consumedMist: string;
  readonly status: 'active' | 'exhausted';
  readonly activeReservationReceiptId: string | null;
  readonly activeReservationAmountMist: string | null;
  readonly lastUsedAt: string | null;
}

export interface PromotionReservationRecord {
  readonly receiptId: string;
  readonly promotionId: string;
  readonly userId: string;
  readonly amountMist: string;
  readonly deadlineMs: number;
}

/** Canonical reservation JSON surrounding its one Redis-authored deadline. */
export interface PromotionReservationRecordParts {
  readonly prefix: string;
  readonly suffix: string;
}

export interface PromotionOperationResultRecord {
  readonly receiptId: string;
  readonly promotionId: string;
  readonly userId: string;
  readonly operation: 'consume' | 'release';
  readonly amountMist: string;
  readonly result: 'consumed' | 'released';
  readonly entitlement: PromotionEntitlementRecord;
}

export interface PromotionOperationResultExpectation {
  readonly receiptId: string;
  readonly promotionId: string;
  readonly userId: string;
  readonly operation: 'consume' | 'release';
  readonly amountMist: string;
}

export function promotionEntitlementFromRecord(record: PromotionEntitlementRecord): Entitlement {
  return {
    promotionId: record.promotionId,
    userId: record.userId,
    claimedAt: record.claimedAt,
    useUntilAt: record.useUntilAt,
    remainingGasAllowanceMist: record.remainingMist,
    consumedGasAllowanceMist: record.consumedMist,
    status: record.status,
    activeReservationReceiptId: record.activeReservationReceiptId,
    activeReservationAmountMist: record.activeReservationAmountMist,
    lastUsedAt: record.lastUsedAt,
  };
}

export interface PromotionClaimTransition {
  readonly accounting: PromotionAccountingRecord;
  readonly entitlement: PromotionEntitlementRecord;
}

export interface PromotionReserveTransition {
  readonly accounting: PromotionAccountingRecord;
  readonly entitlement: PromotionEntitlementRecord;
  readonly reservation: PromotionReservationRecord;
}

export interface PromotionReserveStateChange {
  readonly accounting: PromotionAccountingRecord;
  readonly entitlement: PromotionEntitlementRecord;
}

export interface PromotionFinalizeTransition {
  readonly accounting: PromotionAccountingRecord;
  readonly entitlement: PromotionEntitlementRecord;
  readonly result: PromotionOperationResultRecord;
}

export function promotionAccountingKey(promotionId: string): string {
  return `${ACCOUNTING_RECORD_PREFIX}${promotionIdValue(promotionId)}`;
}

export function promotionEntitlementKeyPrefix(promotionId: string): string {
  return `${ENTITLEMENT_RECORD_PREFIX}${promotionIdValue(promotionId)}:`;
}

export function promotionEntitlementKey(promotionId: string, userId: string): string {
  return `${promotionEntitlementKeyPrefix(promotionId)}${studioUserId(
    userId,
    'Promotion entitlement userId',
  )}`;
}

export function promotionReservationKey(receiptId: string): string {
  return `${RESERVATION_RECORD_PREFIX}${promotionReservationDeadlineMember(receiptId)}`;
}

export function promotionReservationKeyPrefix(): string {
  return RESERVATION_RECORD_PREFIX;
}

export function promotionOperationResultKey(receiptId: string): string {
  return `${OPERATION_RESULT_RECORD_PREFIX}${promotionReservationDeadlineMember(receiptId)}`;
}

export function promotionOperationResultKeyPrefix(): string {
  return OPERATION_RESULT_RECORD_PREFIX;
}

export function promotionReservationDeadlineIndexKey(): string {
  return `${LEDGER_PREFIX}reservation:deadlines`;
}

export function promotionReservationDeadlineMember(receiptId: string): string {
  return string(receiptId, 'Promotion reservation receiptId');
}

export interface PromotionReceiptStorageKeys {
  readonly promotion: string;
  readonly accounting: string;
  readonly entitlement: string;
  readonly reservation: string;
  readonly result: string;
  readonly reservationDeadlineIndex: string;
  readonly receiptId: string;
}

/**
 * Exact key bundle for one Promotion-sponsored receipt transition.
 * Cross-record coordinators consume this bundle instead of reconstructing
 * Promotion Redis prefixes.
 */
export function promotionReceiptStorageKeys(input: {
  readonly promotionId: string;
  readonly userId: string;
  readonly receiptId: string;
  readonly promotionRecordKey: string;
}): PromotionReceiptStorageKeys {
  const canonicalReceiptId = promotionReservationDeadlineMember(input.receiptId);
  return Object.freeze({
    promotion: string(input.promotionRecordKey, 'Promotion record key'),
    accounting: promotionAccountingKey(input.promotionId),
    entitlement: promotionEntitlementKey(input.promotionId, input.userId),
    reservation: promotionReservationKey(canonicalReceiptId),
    result: promotionOperationResultKey(canonicalReceiptId),
    reservationDeadlineIndex: promotionReservationDeadlineIndexKey(),
    receiptId: canonicalReceiptId,
  });
}

export function assertPromotionAccountingIdentity(
  record: PromotionAccountingRecord,
  promotionId: string,
): void {
  if (record.promotionId !== promotionId) {
    throw new PromotionRecordCorruptionError(
      'Promotion accounting record does not match its storage key',
    );
  }
}

export function assertPromotionEntitlementIdentity(
  record: PromotionEntitlementRecord,
  promotionId: string,
  userId: string,
): void {
  if (record.promotionId !== promotionId || record.userId !== userId) {
    throw new PromotionRecordCorruptionError(
      'Promotion entitlement record does not match its storage key',
    );
  }
}

export function assertPromotionReservationIdentity(
  record: PromotionReservationRecord,
  receiptId: string,
): void {
  if (record.receiptId !== receiptId) {
    throw new PromotionRecordCorruptionError(
      'Promotion reservation record does not match its storage key',
    );
  }
}

export function assertPromotionOperationResultIdentity(
  record: PromotionOperationResultRecord,
  receiptId: string,
): void {
  if (record.receiptId !== receiptId) {
    throw new PromotionRecordCorruptionError(
      'Promotion operation result does not match its storage key',
    );
  }
}

export function assertPromotionAccountingMatchesPromotion(
  promotion: Promotion,
  accounting: PromotionAccountingRecord,
): void {
  const { perUserGasAllowanceMist, totalBudgetMist } = parsePromotionLedgerBudget(
    promotion.maxParticipants,
    promotion.perUserGasAllowanceMist,
  );
  if (
    accounting.promotionId !== promotion.promotionId ||
    accounting.maxParticipants !== promotion.maxParticipants ||
    accounting.perUserGasAllowanceMist !== perUserGasAllowanceMist.toString() ||
    accounting.totalBudgetMist !== totalBudgetMist.toString()
  ) {
    throw new PromotionRecordCorruptionError(
      'Promotion accounting does not match the current Promotion economics',
    );
  }
}

export function assertPromotionEntitlementAccountingState(
  accounting: PromotionAccountingRecord,
  entitlement: PromotionEntitlementRecord,
): void {
  if (entitlement.promotionId !== accounting.promotionId) {
    throw new PromotionRecordCorruptionError(
      'Promotion entitlement does not match its accounting record',
    );
  }
  if (accounting.claimedCount === 0) {
    throw new PromotionRecordCorruptionError(
      'Promotion entitlement exists while claimedCount is zero',
    );
  }
  const remainingMist = BigInt(entitlement.remainingMist);
  const activeReservationMist =
    entitlement.activeReservationAmountMist === null
      ? 0n
      : BigInt(entitlement.activeReservationAmountMist);
  const perUserMist = BigInt(accounting.perUserGasAllowanceMist);
  if (remainingMist + activeReservationMist > perUserMist) {
    throw new PromotionRecordCorruptionError(
      'Promotion entitlement exceeds its per-user allowance',
    );
  }
  if (activeReservationMist > BigInt(accounting.reservedMist)) {
    throw new PromotionRecordCorruptionError(
      'Promotion entitlement reservation exceeds accounting reserved MIST',
    );
  }
}

export function assertPromotionLedgerReadState(
  current: CurrentPromotionRecord | null,
  promotionId: string,
  userId: string | null,
  accounting: PromotionAccountingRecord | null,
  entitlement: PromotionEntitlementRecord | null,
): void {
  if (entitlement && !accounting) {
    throw new PromotionRecordCorruptionError(PROMOTION_ENTITLEMENT_WITHOUT_ACCOUNTING_MESSAGE);
  }
  if (!accounting) return;
  if (!current) {
    throw new PromotionRecordCorruptionError(
      'Promotion accounting exists without its Promotion record',
    );
  }
  if (accounting.claimedCount === 0) {
    throw new PromotionRecordCorruptionError(
      'Persisted Promotion accounting claimedCount must be positive',
    );
  }
  assertPromotionAccountingIdentity(accounting, promotionId);
  assertPromotionAccountingMatchesPromotion(current.promotion, accounting);
  if (!entitlement) return;
  if (userId === null) {
    throw new PromotionRecordCorruptionError(
      'Promotion accounting-only read unexpectedly returned an entitlement',
    );
  }
  assertPromotionEntitlementIdentity(entitlement, promotionId, userId);
  assertPromotionEntitlementAccountingState(accounting, entitlement);
}

export function assertPromotionReservationAccountingState(
  accounting: PromotionAccountingRecord,
  entitlement: PromotionEntitlementRecord,
  reservation: PromotionReservationRecord,
): void {
  assertPromotionEntitlementAccountingState(accounting, entitlement);
  if (
    reservation.promotionId !== accounting.promotionId ||
    reservation.promotionId !== entitlement.promotionId ||
    reservation.userId !== entitlement.userId ||
    entitlement.status !== 'active' ||
    entitlement.activeReservationReceiptId !== reservation.receiptId ||
    entitlement.activeReservationAmountMist !== reservation.amountMist
  ) {
    throw new PromotionRecordCorruptionError(
      'Promotion reservation does not match its accounting and entitlement state',
    );
  }
  if (BigInt(accounting.reservedMist) < BigInt(reservation.amountMist)) {
    throw new PromotionRecordCorruptionError(
      'Promotion accounting reserved MIST is smaller than its reservation',
    );
  }
}

export function createPromotionClaimTransition(params: {
  readonly promotion: Promotion;
  readonly accounting: PromotionAccountingRecord | null;
  readonly entitlement: PromotionEntitlementRecord | null;
  readonly userId: string;
  readonly claimedAt: string;
  readonly useUntilAt: string | null;
}): PromotionClaimTransition | { readonly status: 'duplicate' | 'capacity_exceeded' } {
  const { promotion, userId, claimedAt, useUntilAt } = params;
  if (promotion.status !== 'active') {
    throw new PromotionRecordCorruptionError(
      'Promotion claim transition requires an active Promotion',
    );
  }
  const { perUserGasAllowanceMist, totalBudgetMist } = parsePromotionLedgerBudget(
    promotion.maxParticipants,
    promotion.perUserGasAllowanceMist,
  );
  const accounting =
    params.accounting === null
      ? decodePromotionAccountingRecord({
          promotionId: promotion.promotionId,
          maxParticipants: String(promotion.maxParticipants),
          perUserGasAllowanceMist: perUserGasAllowanceMist.toString(),
          totalBudgetMist: totalBudgetMist.toString(),
          claimedCount: '0',
          availableMist: totalBudgetMist.toString(),
          reservedMist: '0',
          consumedMist: '0',
        })
      : decodePromotionAccountingRecord(serializePromotionAccountingRecord(params.accounting));
  assertPromotionAccountingMatchesPromotion(promotion, accounting);
  if (params.entitlement !== null) {
    if (params.accounting === null) {
      throw new PromotionRecordCorruptionError(PROMOTION_ENTITLEMENT_WITHOUT_ACCOUNTING_MESSAGE);
    }
    const entitlement = decodePromotionEntitlementRecord(
      serializePromotionEntitlementRecord(params.entitlement),
    );
    assertPromotionEntitlementIdentity(entitlement, promotion.promotionId, userId);
    assertPromotionEntitlementAccountingState(accounting, entitlement);
    return { status: 'duplicate' };
  }
  if (accounting.claimedCount >= accounting.maxParticipants) {
    return { status: 'capacity_exceeded' };
  }
  const entitlement = decodePromotionEntitlementRecord({
    promotionId: promotion.promotionId,
    userId,
    claimedAt,
    useUntilAt: useUntilAt ?? '',
    remainingMist: perUserGasAllowanceMist.toString(),
    consumedMist: '0',
    status: 'active',
    activeReservationReceiptId: '',
    activeReservationAmountMist: '',
    lastUsedAt: '',
  });
  const nextAccounting = decodePromotionAccountingRecord(
    serializePromotionAccountingRecord({
      ...accounting,
      claimedCount: accounting.claimedCount + 1,
    }),
  );
  assertPromotionEntitlementAccountingState(nextAccounting, entitlement);
  return { accounting: nextAccounting, entitlement };
}

export function createPromotionReserveStateChange(params: {
  readonly promotion: Promotion;
  readonly accounting: PromotionAccountingRecord;
  readonly entitlement: PromotionEntitlementRecord;
  readonly receiptId: string;
  readonly amountMist: bigint;
}):
  | PromotionReserveStateChange
  | {
      readonly status:
        | 'entitlement_not_active'
        | 'concurrent_reservation'
        | 'entitlement_insufficient'
        | 'budget_insufficient';
    } {
  const { promotion, receiptId, amountMist } = params;
  if (promotion.status !== 'active') {
    throw new PromotionRecordCorruptionError(
      'Promotion reserve transition requires an active Promotion',
    );
  }
  const accounting = decodePromotionAccountingRecord(
    serializePromotionAccountingRecord(params.accounting),
  );
  const entitlement = decodePromotionEntitlementRecord(
    serializePromotionEntitlementRecord(params.entitlement),
  );
  assertPromotionAccountingMatchesPromotion(promotion, accounting);
  assertPromotionEntitlementAccountingState(accounting, entitlement);
  if (entitlement.status !== 'active') return { status: 'entitlement_not_active' };
  if (entitlement.activeReservationReceiptId !== null) {
    return { status: 'concurrent_reservation' };
  }
  if (BigInt(entitlement.remainingMist) < amountMist) {
    return { status: 'entitlement_insufficient' };
  }
  if (BigInt(accounting.availableMist) < amountMist) {
    return { status: 'budget_insufficient' };
  }
  const nextEntitlement = decodePromotionEntitlementRecord(
    serializePromotionEntitlementRecord({
      ...entitlement,
      remainingMist: (BigInt(entitlement.remainingMist) - amountMist).toString(),
      activeReservationReceiptId: receiptId,
      activeReservationAmountMist: amountMist.toString(),
    }),
  );
  const nextAccounting = decodePromotionAccountingRecord(
    serializePromotionAccountingRecord({
      ...accounting,
      availableMist: (BigInt(accounting.availableMist) - amountMist).toString(),
      reservedMist: (BigInt(accounting.reservedMist) + amountMist).toString(),
    }),
  );
  return {
    accounting: nextAccounting,
    entitlement: nextEntitlement,
  };
}

export function createPromotionReserveTransition(params: {
  readonly promotion: Promotion;
  readonly accounting: PromotionAccountingRecord;
  readonly entitlement: PromotionEntitlementRecord;
  readonly receiptId: string;
  readonly amountMist: bigint;
  readonly deadlineMs: number;
}):
  | PromotionReserveTransition
  | {
      readonly status:
        | 'entitlement_not_active'
        | 'concurrent_reservation'
        | 'entitlement_insufficient'
        | 'budget_insufficient';
    } {
  const stateChange = createPromotionReserveStateChange(params);
  if ('status' in stateChange) return stateChange;
  const reservation = decodePromotionReservationRecord(
    serializePromotionReservationRecord({
      receiptId: params.receiptId,
      promotionId: params.promotion.promotionId,
      userId: stateChange.entitlement.userId,
      amountMist: params.amountMist.toString(),
      deadlineMs: params.deadlineMs,
    }),
  );
  const { accounting: nextAccounting, entitlement: nextEntitlement } = stateChange;
  assertPromotionReservationAccountingState(nextAccounting, nextEntitlement, reservation);
  return {
    accounting: nextAccounting,
    entitlement: nextEntitlement,
    reservation,
  };
}

export function createPromotionFinalizeTransition(params: {
  readonly accounting: PromotionAccountingRecord;
  readonly entitlement: PromotionEntitlementRecord;
  readonly reservation: PromotionReservationRecord;
  readonly operation: 'consume' | 'release';
  readonly chargedMist: bigint;
  readonly usedAt: string | null;
}): PromotionFinalizeTransition {
  const accounting = decodePromotionAccountingRecord(
    serializePromotionAccountingRecord(params.accounting),
  );
  const entitlement = decodePromotionEntitlementRecord(
    serializePromotionEntitlementRecord(params.entitlement),
  );
  const reservation = decodePromotionReservationRecord(
    serializePromotionReservationRecord(params.reservation),
  );
  assertPromotionReservationAccountingState(accounting, entitlement, reservation);

  const reservedMist = BigInt(reservation.amountMist);
  const chargedMist = params.operation === 'consume' ? params.chargedMist : 0n;
  const delta = reservedMist > chargedMist ? reservedMist - chargedMist : 0n;
  const overrun = chargedMist > reservedMist ? chargedMist - reservedMist : 0n;
  const remainingAfterDelta = BigInt(entitlement.remainingMist) + delta;
  const availableAfterDelta = BigInt(accounting.availableMist) + delta;
  const remainingMist = remainingAfterDelta > overrun ? remainingAfterDelta - overrun : 0n;
  const availableMist = availableAfterDelta > overrun ? availableAfterDelta - overrun : 0n;
  const nextEntitlementConsumedMist = BigInt(entitlement.consumedMist) + chargedMist;
  const nextAccountingConsumedMist = BigInt(accounting.consumedMist) + chargedMist;
  if (nextEntitlementConsumedMist > MAX_PROMOTION_LEDGER_VALUE_MIST) {
    throw new PromotionRecordCorruptionError(
      'cumulative entitlement consumedMist exceeds the Promotion ledger bound',
    );
  }
  if (nextAccountingConsumedMist > MAX_PROMOTION_LEDGER_VALUE_MIST) {
    throw new PromotionRecordCorruptionError(
      'cumulative accounting consumedMist exceeds the Promotion ledger bound',
    );
  }
  const nextEntitlement = decodePromotionEntitlementRecord(
    serializePromotionEntitlementRecord({
      ...entitlement,
      remainingMist: remainingMist.toString(),
      consumedMist: nextEntitlementConsumedMist.toString(),
      status: remainingMist === 0n ? 'exhausted' : entitlement.status,
      activeReservationReceiptId: null,
      activeReservationAmountMist: null,
      lastUsedAt: params.operation === 'consume' ? params.usedAt : entitlement.lastUsedAt,
    }),
  );
  const nextAccounting = decodePromotionAccountingRecord(
    serializePromotionAccountingRecord({
      ...accounting,
      availableMist: availableMist.toString(),
      reservedMist: (BigInt(accounting.reservedMist) - reservedMist).toString(),
      consumedMist: nextAccountingConsumedMist.toString(),
    }),
  );
  assertPromotionEntitlementAccountingState(nextAccounting, nextEntitlement);
  const result = decodePromotionOperationResultRecord(
    serializePromotionOperationResultRecord({
      receiptId: reservation.receiptId,
      promotionId: reservation.promotionId,
      userId: reservation.userId,
      operation: params.operation,
      amountMist: params.operation === 'consume' ? chargedMist.toString() : reservation.amountMist,
      result: params.operation === 'consume' ? 'consumed' : 'released',
      entitlement: nextEntitlement,
    }),
  );
  return { accounting: nextAccounting, entitlement: nextEntitlement, result };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PromotionRecordCorruptionError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown> | Record<string, string>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PromotionRecordCorruptionError(`${label} has unsupported fields`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PromotionRecordCorruptionError(`${label} must be a non-empty string`);
  }
  return value;
}

function promotionIdValue(value: unknown): string {
  try {
    return parsePromotionId(value);
  } catch {
    throw new PromotionRecordCorruptionError('Promotion ID is not current');
  }
}

function studioUserId(value: unknown, label: string): string {
  if (!isValidStudioUserId(value)) {
    throw new PromotionRecordCorruptionError(
      `${label} must contain 1-${STUDIO_USER_ID_MAX_LENGTH} ASCII letters, digits, or _ : . -`,
    );
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

function isoString(value: unknown, label: string): string {
  const current = string(value, label);
  if (!Number.isFinite(Date.parse(current))) {
    throw new PromotionRecordCorruptionError(`${label} must be an ISO timestamp`);
  }
  return current;
}

function canonicalIsoString(value: unknown, label: string): string {
  const current = isoString(value, label);
  if (new Date(current).toISOString() !== current) {
    throw new PromotionRecordCorruptionError(`${label} must use canonical ISO format`);
  }
  return current;
}

function nullableIsoString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return isoString(value, label);
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new PromotionRecordCorruptionError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  const current = nonNegativeSafeInteger(value, label);
  if (current === 0) {
    throw new PromotionRecordCorruptionError(`${label} must be positive`);
  }
  return current;
}

function canonicalHashSafeInteger(value: unknown, label: string, positive: boolean): number {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
    throw new PromotionRecordCorruptionError(`${label} must be a canonical decimal string`);
  }
  const current = Number(value);
  if (!Number.isSafeInteger(current) || current < 0 || (positive && current === 0)) {
    throw new PromotionRecordCorruptionError(
      positive ? `${label} must be positive` : `${label} must be non-negative`,
    );
  }
  return current;
}

function promotionId(value: unknown, label: string): string {
  try {
    return parsePromotionId(value, label);
  } catch {
    throw new PromotionRecordCorruptionError(`${label} must be a current Promotion ID`);
  }
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
    throw new PromotionRecordCorruptionError(`${label} must be a canonical decimal string`);
  }
  const amount = BigInt(value);
  if (amount > MAX_PROMOTION_LEDGER_VALUE_MIST) {
    throw new PromotionRecordCorruptionError(`${label} exceeds the Promotion ledger bound`);
  }
  return value;
}

function positiveDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL_RE.test(value)) {
    throw new PromotionRecordCorruptionError(`${label} must be a positive decimal string`);
  }
  return decimal(value, label);
}

function hashNullable(value: string, label: string): string | null {
  return value === '' ? null : string(value, label);
}

export function serializePromotionRecord(record: Promotion): string {
  const serialized = JSON.stringify({
    promotionId: record.promotionId,
    type: record.type,
    displayName: record.displayName,
    description: record.description,
    status: record.status,
    maxParticipants: record.maxParticipants,
    perUserGasAllowanceMist: record.perUserGasAllowanceMist,
    claimDeadlineAt: record.claimDeadlineAt,
    postClaimUseWindowMs: record.postClaimUseWindowMs,
    startAt: record.startAt,
    pauseReason: record.pauseReason,
    archiveReason: record.archiveReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
  decodePromotionRecord(serialized);
  return serialized;
}

export function decodePromotionRecord(serialized: string): Promotion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new PromotionRecordCorruptionError('Promotion record must be valid JSON');
  }
  const raw = object(parsed, 'Promotion record');
  exactKeys(
    raw,
    [
      'promotionId',
      'type',
      'displayName',
      'description',
      'status',
      'maxParticipants',
      'perUserGasAllowanceMist',
      'claimDeadlineAt',
      'postClaimUseWindowMs',
      'startAt',
      'pauseReason',
      'archiveReason',
      'createdAt',
      'updatedAt',
    ],
    'Promotion record',
  );
  if (raw.type !== 'gas_sponsorship') {
    throw new PromotionRecordCorruptionError('Promotion record type is not current');
  }
  if (!isPromotionStatus(raw.status)) {
    throw new PromotionRecordCorruptionError('Promotion record status is not current');
  }
  const promotion: Promotion = {
    promotionId: promotionId(raw.promotionId, 'Promotion promotionId'),
    type: 'gas_sponsorship',
    displayName: string(raw.displayName, 'Promotion displayName'),
    description:
      typeof raw.description === 'string'
        ? raw.description
        : (() => {
            throw new PromotionRecordCorruptionError('Promotion description must be a string');
          })(),
    status: raw.status,
    maxParticipants: positiveSafeInteger(raw.maxParticipants, 'Promotion maxParticipants'),
    perUserGasAllowanceMist: positiveDecimal(
      raw.perUserGasAllowanceMist,
      'Promotion perUserGasAllowanceMist',
    ),
    claimDeadlineAt: nullableIsoString(raw.claimDeadlineAt, 'Promotion claimDeadlineAt'),
    postClaimUseWindowMs: nonNegativeSafeInteger(
      raw.postClaimUseWindowMs,
      'Promotion postClaimUseWindowMs',
    ),
    startAt: nullableIsoString(raw.startAt, 'Promotion startAt'),
    pauseReason: nullableString(raw.pauseReason, 'Promotion pauseReason'),
    archiveReason: nullableString(raw.archiveReason, 'Promotion archiveReason'),
    createdAt: canonicalIsoString(raw.createdAt, 'Promotion createdAt'),
    updatedAt: canonicalIsoString(raw.updatedAt, 'Promotion updatedAt'),
  };
  parsePromotionLedgerBudget(promotion.maxParticipants, promotion.perUserGasAllowanceMist);
  return promotion;
}

const ACCOUNTING_FIELDS = [
  'promotionId',
  'maxParticipants',
  'perUserGasAllowanceMist',
  'totalBudgetMist',
  'claimedCount',
  'availableMist',
  'reservedMist',
  'consumedMist',
] as const;

export const PROMOTION_ACCOUNTING_RECORD_FIELD_COUNT = ACCOUNTING_FIELDS.length;

export function serializePromotionAccountingRecord(
  record: PromotionAccountingRecord,
): Record<string, string> {
  const decoded = decodePromotionAccountingRecord({
    promotionId: record.promotionId,
    maxParticipants: String(record.maxParticipants),
    perUserGasAllowanceMist: record.perUserGasAllowanceMist,
    totalBudgetMist: record.totalBudgetMist,
    claimedCount: String(record.claimedCount),
    availableMist: record.availableMist,
    reservedMist: record.reservedMist,
    consumedMist: record.consumedMist,
  });
  return {
    promotionId: decoded.promotionId,
    maxParticipants: String(decoded.maxParticipants),
    perUserGasAllowanceMist: decoded.perUserGasAllowanceMist,
    totalBudgetMist: decoded.totalBudgetMist,
    claimedCount: String(decoded.claimedCount),
    availableMist: decoded.availableMist,
    reservedMist: decoded.reservedMist,
    consumedMist: decoded.consumedMist,
  };
}

export function samePromotionAccountingRecord(
  left: PromotionAccountingRecord,
  right: PromotionAccountingRecord,
): boolean {
  const leftFields = serializePromotionAccountingRecord(left);
  const rightFields = serializePromotionAccountingRecord(right);
  return ACCOUNTING_FIELDS.every((field) => leftFields[field] === rightFields[field]);
}

export function decodePromotionAccountingRecord(
  fields: Record<string, string>,
): PromotionAccountingRecord {
  exactKeys(fields, ACCOUNTING_FIELDS, 'Promotion accounting record');
  const maxParticipants = canonicalHashSafeInteger(
    fields.maxParticipants,
    'Accounting maxParticipants',
    true,
  );
  const claimedCount = canonicalHashSafeInteger(
    fields.claimedCount,
    'Accounting claimedCount',
    false,
  );
  const perUserGasAllowanceMist = positiveDecimal(
    fields.perUserGasAllowanceMist,
    'Accounting perUserGasAllowanceMist',
  );
  const totalBudgetMist = decimal(fields.totalBudgetMist, 'Accounting totalBudgetMist');
  const expected = parsePromotionLedgerBudget(
    maxParticipants,
    perUserGasAllowanceMist,
  ).totalBudgetMist.toString();
  if (totalBudgetMist !== expected) {
    throw new PromotionRecordCorruptionError('Accounting immutable economics are inconsistent');
  }
  if (claimedCount > maxParticipants) {
    throw new PromotionRecordCorruptionError('Accounting claimedCount exceeds capacity');
  }
  const availableMist = decimal(fields.availableMist, 'Accounting availableMist');
  const reservedMist = decimal(fields.reservedMist, 'Accounting reservedMist');
  const consumedMist = decimal(fields.consumedMist, 'Accounting consumedMist');
  const totalBudget = BigInt(totalBudgetMist);
  const available = BigInt(availableMist);
  const reserved = BigInt(reservedMist);
  if (available > totalBudget || reserved > totalBudget || available + reserved > totalBudget) {
    throw new PromotionRecordCorruptionError(
      'Accounting available and reserved amounts exceed the total budget',
    );
  }
  return {
    promotionId: promotionId(fields.promotionId, 'Accounting promotionId'),
    maxParticipants,
    perUserGasAllowanceMist,
    totalBudgetMist,
    claimedCount,
    availableMist,
    reservedMist,
    consumedMist,
  };
}

const ENTITLEMENT_FIELDS = [
  'promotionId',
  'userId',
  'claimedAt',
  'useUntilAt',
  'remainingMist',
  'consumedMist',
  'status',
  'activeReservationReceiptId',
  'activeReservationAmountMist',
  'lastUsedAt',
] as const;

export const PROMOTION_ENTITLEMENT_RECORD_FIELD_COUNT = ENTITLEMENT_FIELDS.length;

export function serializePromotionEntitlementRecord(
  record: PromotionEntitlementRecord,
): Record<string, string> {
  const fields = {
    promotionId: record.promotionId,
    userId: record.userId,
    claimedAt: record.claimedAt,
    useUntilAt: record.useUntilAt ?? '',
    remainingMist: record.remainingMist,
    consumedMist: record.consumedMist,
    status: record.status,
    activeReservationReceiptId: record.activeReservationReceiptId ?? '',
    activeReservationAmountMist: record.activeReservationAmountMist ?? '',
    lastUsedAt: record.lastUsedAt ?? '',
  };
  decodePromotionEntitlementRecord(fields);
  return fields;
}

export function samePromotionEntitlementRecord(
  left: PromotionEntitlementRecord,
  right: PromotionEntitlementRecord,
): boolean {
  const leftFields = serializePromotionEntitlementRecord(left);
  const rightFields = serializePromotionEntitlementRecord(right);
  return ENTITLEMENT_FIELDS.every((field) => leftFields[field] === rightFields[field]);
}

export function decodePromotionEntitlementRecord(
  fields: Record<string, string>,
): PromotionEntitlementRecord {
  exactKeys(fields, ENTITLEMENT_FIELDS, 'Promotion entitlement record');
  if (fields.status !== 'active' && fields.status !== 'exhausted') {
    throw new PromotionRecordCorruptionError('Entitlement status is not current');
  }
  const receiptId = hashNullable(
    fields.activeReservationReceiptId,
    'Entitlement activeReservationReceiptId',
  );
  const reservationAmount =
    fields.activeReservationAmountMist === ''
      ? null
      : positiveDecimal(
          fields.activeReservationAmountMist,
          'Entitlement activeReservationAmountMist',
        );
  if ((receiptId === null) !== (reservationAmount === null)) {
    throw new PromotionRecordCorruptionError('Entitlement reservation fields are incomplete');
  }
  const remainingMist = decimal(fields.remainingMist, 'Entitlement remainingMist');
  const consumedMist = decimal(fields.consumedMist, 'Entitlement consumedMist');
  if (fields.status === 'exhausted' && (remainingMist !== '0' || receiptId !== null)) {
    throw new PromotionRecordCorruptionError(
      'Exhausted Promotion entitlement has remaining or reserved MIST',
    );
  }
  if (fields.status === 'active' && remainingMist === '0' && receiptId === null) {
    throw new PromotionRecordCorruptionError(
      'Active Promotion entitlement has no remaining or reserved MIST',
    );
  }
  return {
    promotionId: promotionId(fields.promotionId, 'Entitlement promotionId'),
    userId: studioUserId(fields.userId, 'Entitlement userId'),
    claimedAt: canonicalIsoString(fields.claimedAt, 'Entitlement claimedAt'),
    useUntilAt:
      fields.useUntilAt === ''
        ? null
        : canonicalIsoString(fields.useUntilAt, 'Entitlement useUntilAt'),
    remainingMist,
    consumedMist,
    status: fields.status,
    activeReservationReceiptId: receiptId,
    activeReservationAmountMist: reservationAmount,
    lastUsedAt:
      fields.lastUsedAt === ''
        ? null
        : canonicalIsoString(fields.lastUsedAt, 'Entitlement lastUsedAt'),
  };
}

function canonicalRecord<T>(
  record: Record<string, unknown>,
  decode: (serialized: string) => T,
): string {
  const serialized = JSON.stringify(record);
  decode(serialized);
  return serialized;
}

export function serializePromotionReservationRecord(record: PromotionReservationRecord): string {
  return canonicalRecord(
    {
      receiptId: record.receiptId,
      promotionId: record.promotionId,
      userId: record.userId,
      amountMist: record.amountMist,
      deadlineMs: record.deadlineMs,
    },
    decodePromotionReservationRecord,
  );
}

export function createPromotionReservationRecordParts(
  record: Omit<PromotionReservationRecord, 'deadlineMs'>,
): PromotionReservationRecordParts {
  const serialized = serializePromotionReservationRecord({ ...record, deadlineMs: 1 });
  const marker = '"deadlineMs":1';
  const markerStart = serialized.indexOf(marker);
  if (markerStart < 0 || serialized.indexOf(marker, markerStart + marker.length) >= 0) {
    throw new PromotionRecordCorruptionError(
      'Promotion reservation must contain exactly one deadlineMs field',
    );
  }
  const valueStart = markerStart + '"deadlineMs":'.length;
  return Object.freeze({
    prefix: serialized.slice(0, valueStart),
    suffix: serialized.slice(markerStart + marker.length),
  });
}

export function materializePromotionReservationRecord(
  parts: PromotionReservationRecordParts,
  deadlineMs: number,
): { readonly raw: string; readonly record: PromotionReservationRecord } {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new PromotionRecordCorruptionError(
      'Promotion reservation deadlineMs must be a positive safe integer',
    );
  }
  const raw = `${parts.prefix}${deadlineMs}${parts.suffix}`;
  const record = decodePromotionReservationRecord(raw);
  return Object.freeze({ raw, record });
}

export function decodePromotionReservationRecord(serialized: string): PromotionReservationRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new PromotionRecordCorruptionError('Promotion reservation record must be valid JSON');
  }
  const raw = object(parsed, 'Promotion reservation record');
  exactKeys(
    raw,
    ['receiptId', 'promotionId', 'userId', 'amountMist', 'deadlineMs'],
    'Promotion reservation record',
  );
  return {
    receiptId: string(raw.receiptId, 'Reservation receiptId'),
    promotionId: promotionId(raw.promotionId, 'Reservation promotionId'),
    userId: studioUserId(raw.userId, 'Reservation userId'),
    amountMist: positiveDecimal(raw.amountMist, 'Reservation amountMist'),
    deadlineMs: positiveSafeInteger(raw.deadlineMs, 'Reservation deadlineMs'),
  };
}

export function serializePromotionOperationResultRecord(
  record: PromotionOperationResultRecord,
): string {
  const serialized = JSON.stringify({
    receiptId: record.receiptId,
    promotionId: record.promotionId,
    userId: record.userId,
    operation: record.operation,
    amountMist: record.amountMist,
    result: record.result,
    entitlement: serializePromotionEntitlementRecord(record.entitlement),
  });
  decodePromotionOperationResultRecord(serialized);
  return serialized;
}

export function promotionOperationResultMatchesExpectation(
  record: PromotionOperationResultRecord,
  expectation: PromotionOperationResultExpectation,
): boolean {
  const current = decodePromotionOperationResultRecord(
    serializePromotionOperationResultRecord(record),
  );
  return (
    current.receiptId === expectation.receiptId &&
    current.promotionId === expectation.promotionId &&
    current.userId === expectation.userId &&
    current.operation === expectation.operation &&
    current.amountMist === expectation.amountMist &&
    current.result === (expectation.operation === 'consume' ? 'consumed' : 'released')
  );
}

export function decodePromotionOperationResultRecord(
  serialized: string,
): PromotionOperationResultRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new PromotionRecordCorruptionError('Promotion operation result must be valid JSON');
  }
  const raw = object(parsed, 'Promotion operation result');
  exactKeys(
    raw,
    ['receiptId', 'promotionId', 'userId', 'operation', 'amountMist', 'result', 'entitlement'],
    'Promotion operation result',
  );
  if (raw.operation !== 'consume' && raw.operation !== 'release') {
    throw new PromotionRecordCorruptionError('Promotion operation is not current');
  }
  if (raw.result !== 'consumed' && raw.result !== 'released') {
    throw new PromotionRecordCorruptionError('Promotion operation result is not current');
  }
  if (
    (raw.operation === 'consume' && raw.result !== 'consumed') ||
    (raw.operation === 'release' && raw.result !== 'released')
  ) {
    throw new PromotionRecordCorruptionError('Promotion operation/result pair is inconsistent');
  }
  const receiptId = string(raw.receiptId, 'Operation result receiptId');
  const resultPromotionId = promotionId(raw.promotionId, 'Operation result promotionId');
  const resultUserId = studioUserId(raw.userId, 'Operation result userId');
  const entitlementRaw = object(raw.entitlement, 'Operation result entitlement');
  const entitlementFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(entitlementRaw)) {
    if (typeof value !== 'string') {
      throw new PromotionRecordCorruptionError(
        'Operation result entitlement fields must be strings',
      );
    }
    entitlementFields[key] = value;
  }
  const entitlement = decodePromotionEntitlementRecord(entitlementFields);
  if (entitlement.promotionId !== resultPromotionId || entitlement.userId !== resultUserId) {
    throw new PromotionRecordCorruptionError(
      'Operation result entitlement identity is inconsistent',
    );
  }
  const amountMist = decimal(raw.amountMist, 'Operation result amountMist');
  if (raw.operation === 'release' && amountMist === '0') {
    throw new PromotionRecordCorruptionError('Release operation amount must be positive');
  }
  if (
    entitlement.activeReservationReceiptId !== null ||
    entitlement.activeReservationAmountMist !== null
  ) {
    throw new PromotionRecordCorruptionError(
      'Operation result entitlement must not retain an active reservation',
    );
  }
  return {
    receiptId,
    promotionId: resultPromotionId,
    userId: resultUserId,
    operation: raw.operation,
    amountMist,
    result: raw.result,
    entitlement,
  };
}
