import { describe, expect, it } from 'vitest';
import { MAX_PROMOTION_LEDGER_VALUE_MIST } from '@stelis/contracts';
import {
  assertWithinLedgerBound,
  parsePromotionLedgerBudget,
} from '../src/studio/executionLedgerValueGuards.js';
import {
  assertPromotionEntitlementAccountingState,
  assertPromotionReservationAccountingState,
  decodePromotionAccountingRecord,
  decodePromotionEntitlementRecord,
  decodePromotionOperationResultRecord,
  decodePromotionRecord,
  serializePromotionOperationResultRecord,
  serializePromotionReservationRecord,
  type PromotionAccountingRecord,
  type PromotionEntitlementRecord,
  type PromotionOperationResultRecord,
  type PromotionReservationRecord,
} from '../src/studio/promotionRecords.js';

const FINAL_ENTITLEMENT: PromotionEntitlementRecord = {
  promotionId: '00000000-0000-4000-8000-000000000401',
  userId: 'user-1',
  claimedAt: '2026-07-16T00:00:00.000Z',
  useUntilAt: null,
  remainingMist: '400',
  consumedMist: '100',
  status: 'active',
  activeReservationReceiptId: null,
  activeReservationAmountMist: null,
  lastUsedAt: '2026-07-16T00:01:00.000Z',
};

const ACCOUNTING: PromotionAccountingRecord = {
  promotionId: FINAL_ENTITLEMENT.promotionId,
  maxParticipants: 10,
  perUserGasAllowanceMist: '100',
  totalBudgetMist: '1000',
  claimedCount: 1,
  availableMist: '900',
  reservedMist: '100',
  consumedMist: '100',
};

describe('Promotion ledger numeric boundary', () => {
  it('accepts the exact contracts-owned maximum without widening it', () => {
    expect(parsePromotionLedgerBudget(1, MAX_PROMOTION_LEDGER_VALUE_MIST.toString())).toEqual({
      perUserGasAllowanceMist: MAX_PROMOTION_LEDGER_VALUE_MIST,
      totalBudgetMist: MAX_PROMOTION_LEDGER_VALUE_MIST,
    });
    expect(() =>
      assertWithinLedgerBound(MAX_PROMOTION_LEDGER_VALUE_MIST, 'amountMist'),
    ).not.toThrow();
  });
});

function operationResult(
  overrides: Partial<PromotionOperationResultRecord> = {},
): PromotionOperationResultRecord {
  return {
    receiptId: 'receipt-1',
    promotionId: FINAL_ENTITLEMENT.promotionId,
    userId: FINAL_ENTITLEMENT.userId,
    operation: 'consume',
    amountMist: '100',
    result: 'consumed',
    entitlement: FINAL_ENTITLEMENT,
    ...overrides,
  };
}

describe('Promotion stored-record codecs', () => {
  it('rejects non-canonical accounting integer strings', () => {
    const fields = {
      promotionId: FINAL_ENTITLEMENT.promotionId,
      maxParticipants: '10',
      perUserGasAllowanceMist: '100',
      totalBudgetMist: '1000',
      claimedCount: '1',
      availableMist: '900',
      reservedMist: '100',
      consumedMist: '100',
    };
    expect(() => decodePromotionAccountingRecord({ ...fields, maxParticipants: '010' })).toThrow(
      'canonical decimal string',
    );
    expect(() => decodePromotionAccountingRecord({ ...fields, claimedCount: '01' })).toThrow(
      'canonical decimal string',
    );
  });

  it('rejects accounting whose available and reserved amounts exceed the total budget', () => {
    expect(() =>
      decodePromotionAccountingRecord({
        promotionId: FINAL_ENTITLEMENT.promotionId,
        maxParticipants: '10',
        perUserGasAllowanceMist: '100',
        totalBudgetMist: '1000',
        claimedCount: '1',
        availableMist: '901',
        reservedMist: '100',
        consumedMist: '50',
      }),
    ).toThrow('exceed the total budget');
  });

  it('keeps actual sponsor gas usage independent from the remaining campaign budget', () => {
    const record = decodePromotionAccountingRecord({
      promotionId: FINAL_ENTITLEMENT.promotionId,
      maxParticipants: '10',
      perUserGasAllowanceMist: '100',
      totalBudgetMist: '1000',
      claimedCount: '1',
      availableMist: '0',
      reservedMist: '0',
      consumedMist: '1500',
    });
    expect(record.consumedMist).toBe('1500');
  });

  it('rejects non-canonical stored timestamps and Promotion IDs', () => {
    expect(() =>
      decodePromotionEntitlementRecord({
        promotionId: FINAL_ENTITLEMENT.promotionId,
        userId: FINAL_ENTITLEMENT.userId,
        claimedAt: '2026-07-16T00:00:00Z',
        useUntilAt: '',
        remainingMist: '400',
        consumedMist: '100',
        status: 'active',
        activeReservationReceiptId: '',
        activeReservationAmountMist: '',
        lastUsedAt: '',
      }),
    ).toThrow('canonical ISO format');

    expect(() =>
      decodePromotionRecord(
        JSON.stringify({
          promotionId: 'not-a-promotion-id',
          type: 'gas_sponsorship',
          displayName: 'Promotion',
          description: '',
          status: 'draft',
          maxParticipants: 1,
          perUserGasAllowanceMist: '100',
          claimDeadlineAt: null,
          postClaimUseWindowMs: 0,
          startAt: null,
          pauseReason: null,
          archiveReason: null,
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z',
        }),
      ),
    ).toThrow('current Promotion ID');

    expect(() =>
      decodePromotionEntitlementRecord({
        promotionId: FINAL_ENTITLEMENT.promotionId,
        userId: '사용자',
        claimedAt: FINAL_ENTITLEMENT.claimedAt,
        useUntilAt: '',
        remainingMist: '1',
        consumedMist: '0',
        status: 'active',
        activeReservationReceiptId: '',
        activeReservationAmountMist: '',
        lastUsedAt: '',
      }),
    ).toThrow('ASCII letters');

    expect(() =>
      serializePromotionReservationRecord({
        receiptId: 'receipt-1',
        promotionId: FINAL_ENTITLEMENT.promotionId,
        userId: '사용자',
        amountMist: '1',
        deadlineMs: 1,
      }),
    ).toThrow('ASCII letters');

    const result = JSON.parse(serializePromotionOperationResultRecord(operationResult())) as Record<
      string,
      unknown
    >;
    expect(() =>
      decodePromotionOperationResultRecord(JSON.stringify({ ...result, userId: '사용자' })),
    ).toThrow('ASCII letters');
  });

  it('rejects final entitlement snapshots whose status contradicts remaining MIST', () => {
    expect(() =>
      serializePromotionOperationResultRecord(
        operationResult({
          entitlement: {
            ...FINAL_ENTITLEMENT,
            remainingMist: '0',
            status: 'active',
          },
        }),
      ),
    ).toThrow('Active Promotion entitlement has no remaining or reserved MIST');

    expect(() =>
      decodePromotionEntitlementRecord({
        promotionId: FINAL_ENTITLEMENT.promotionId,
        userId: FINAL_ENTITLEMENT.userId,
        claimedAt: FINAL_ENTITLEMENT.claimedAt,
        useUntilAt: '',
        remainingMist: '1',
        consumedMist: '100',
        status: 'exhausted',
        activeReservationReceiptId: '',
        activeReservationAmountMist: '',
        lastUsedAt: '',
      }),
    ).toThrow('Exhausted Promotion entitlement has remaining or reserved MIST');
  });

  it('rejects cross-record entitlement and reservation contradictions', () => {
    const entitlement: PromotionEntitlementRecord = {
      ...FINAL_ENTITLEMENT,
      remainingMist: '90',
      activeReservationReceiptId: 'receipt-1',
      activeReservationAmountMist: '20',
    };
    expect(() => assertPromotionEntitlementAccountingState(ACCOUNTING, entitlement)).toThrow(
      'exceeds its per-user allowance',
    );

    const reservation: PromotionReservationRecord = {
      receiptId: 'receipt-1',
      promotionId: FINAL_ENTITLEMENT.promotionId,
      userId: FINAL_ENTITLEMENT.userId,
      amountMist: '100',
      deadlineMs: 123,
    };
    expect(() =>
      assertPromotionReservationAccountingState(
        { ...ACCOUNTING, reservedMist: '0' },
        {
          ...FINAL_ENTITLEMENT,
          remainingMist: '0',
          activeReservationReceiptId: 'receipt-1',
          activeReservationAmountMist: '100',
        },
        reservation,
      ),
    ).toThrow('reservation exceeds accounting reserved MIST');
  });

  it('serializes reservation fields in one canonical property order', () => {
    const first = serializePromotionReservationRecord({
      receiptId: 'receipt-1',
      promotionId: FINAL_ENTITLEMENT.promotionId,
      userId: FINAL_ENTITLEMENT.userId,
      amountMist: '100',
      deadlineMs: 123,
    });
    const second = serializePromotionReservationRecord({
      deadlineMs: 123,
      amountMist: '100',
      userId: FINAL_ENTITLEMENT.userId,
      promotionId: FINAL_ENTITLEMENT.promotionId,
      receiptId: 'receipt-1',
    });
    expect(second).toBe(first);
  });

  it('rejects a zero reservation deadline because Redis time is always positive', () => {
    expect(() =>
      serializePromotionReservationRecord({
        receiptId: 'receipt-1',
        promotionId: FINAL_ENTITLEMENT.promotionId,
        userId: FINAL_ENTITLEMENT.userId,
        amountMist: '100',
        deadlineMs: 0,
      }),
    ).toThrow('Reservation deadlineMs must be positive');
  });

  it('stores and restores the exact final entitlement snapshot', () => {
    const record = operationResult();
    expect(
      decodePromotionOperationResultRecord(serializePromotionOperationResultRecord(record)),
    ).toEqual(record);
  });

  it('rejects a zero-amount release result', () => {
    expect(() =>
      serializePromotionOperationResultRecord(
        operationResult({ operation: 'release', result: 'released', amountMist: '0' }),
      ),
    ).toThrow('Release operation amount must be positive');
  });

  it('rejects a final result whose entitlement still holds a reservation', () => {
    expect(() =>
      serializePromotionOperationResultRecord(
        operationResult({
          entitlement: {
            ...FINAL_ENTITLEMENT,
            activeReservationReceiptId: 'receipt-1',
            activeReservationAmountMist: '100',
          },
        }),
      ),
    ).toThrow('must not retain an active reservation');
  });
});
