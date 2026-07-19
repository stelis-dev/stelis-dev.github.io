import { describe, it, expect } from 'vitest';
import {
  computePromotionAdminSummary,
  computeUserPromotionDetail,
  computePromotionListItem,
} from '../src/studio/promotionDerivedSummary.js';
import type { Entitlement, Promotion } from '../src/studio/domain.js';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makePromoConfig(
  overrides: Partial<{
    promotionId: string;
    type: Promotion['type'];
    displayName: string;
    maxParticipants: number;
    perUserGasAllowanceMist: string;
    claimDeadlineAt: string | null;
    status: 'draft' | 'active' | 'paused' | 'archived';
    startAt: string | null;
  }> = {},
) {
  return {
    promotionId: 'test-promo',
    type: 'gas_sponsorship' as const,
    displayName: 'Test Promo',
    maxParticipants: 10,
    perUserGasAllowanceMist: '5000000',
    claimDeadlineAt: null as string | null,
    status: 'active' as const,
    startAt: null as string | null,
    ...overrides,
  };
}

function makeEntitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    promotionId: 'test-promo',
    userId: 'test-user',
    claimedAt: '2026-01-15T00:00:00Z',
    useUntilAt: null,
    remainingGasAllowanceMist: '3000000',
    consumedGasAllowanceMist: '2000000',
    status: 'active',
    activeReservationReceiptId: null,
    activeReservationAmountMist: null,
    lastUsedAt: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// Admin Summary
// ─────────────────────────────────────────────

describe('computePromotionAdminSummary', () => {
  it('computes basic summary from config + claimed count + budget snapshot', () => {
    const summary = computePromotionAdminSummary(
      makePromoConfig(),
      3, // 3 users claimed
      { availableMist: 40_000_000n, reservedMist: 5_000_000n, consumedMist: 5_000_000n },
    );

    expect(summary.claimedCount).toBe(3);
    expect(summary.remainingParticipantSlots).toBe(7);
    expect(summary.totalRequiredBudgetMist).toBe('50000000'); // 10 × 5M
    expect(summary.totalRemainingBudgetMist).toBe('40000000');
    expect(summary.totalReservedBudgetMist).toBe('5000000');
    expect(summary.totalConsumedBudgetMist).toBe('5000000');
  });

  it('rejects maxParticipants=0 instead of presenting an unlimited summary', () => {
    expect(() =>
      computePromotionAdminSummary(makePromoConfig({ maxParticipants: 0 }), 5, {
        availableMist: 0n,
        reservedMist: 0n,
        consumedMist: 0n,
      }),
    ).toThrow('maxParticipants must be a positive safe integer');
  });

  it('separates consumed and reserved from budget snapshot', () => {
    // Total = 50M, available = 30M, reserved = 10M, consumed = 10M
    const summary = computePromotionAdminSummary(makePromoConfig(), 2, {
      availableMist: 30_000_000n,
      reservedMist: 10_000_000n,
      consumedMist: 10_000_000n,
    });

    expect(summary.totalConsumedBudgetMist).toBe('10000000');
    expect(summary.totalReservedBudgetMist).toBe('10000000');
    expect(summary.totalRemainingBudgetMist).toBe('30000000');
  });

  it('handles zero available budget', () => {
    const summary = computePromotionAdminSummary(makePromoConfig(), 10, {
      availableMist: 0n,
      reservedMist: 0n,
      consumedMist: 50_000_000n,
    });

    expect(summary.totalConsumedBudgetMist).toBe('50000000');
    expect(summary.totalReservedBudgetMist).toBe('0');
    expect(summary.totalRemainingBudgetMist).toBe('0');
    expect(summary.remainingParticipantSlots).toBe(0);
  });
});

// ─────────────────────────────────────────────
// User Promotion Detail
// ─────────────────────────────────────────────

describe('computeUserPromotionDetail', () => {
  describe('not claimed', () => {
    it('returns not_claimed with canClaim=true for active promotion', () => {
      const detail = computeUserPromotionDetail(makePromoConfig(), null, 3);

      expect(detail.claimStatus).toBe('not_claimed');
      expect(detail.canClaim).toBe(true);
      expect(detail.canUseSponsoredAction).toBe(false);
      expect(detail.unavailableReason).toBe('not_claimed');
      expect(detail.userRemainingGasAllowanceMist).toBeNull();
    });

    it('canClaim=false when claim deadline passed', () => {
      const detail = computeUserPromotionDetail(
        makePromoConfig({ claimDeadlineAt: '2025-01-01T00:00:00Z' }),
        null,
        0,
        new Date('2026-01-01T00:00:00Z'),
      );

      expect(detail.canClaim).toBe(false);
      expect(detail.unavailableReason).toBe('claim_deadline_passed');
    });

    it('canClaim=false when slots are full', () => {
      const detail = computeUserPromotionDetail(
        makePromoConfig({ maxParticipants: 5 }),
        null,
        5, // all slots taken
      );

      expect(detail.canClaim).toBe(false);
    });

    it('canClaim=false when promotion is not active', () => {
      const detail = computeUserPromotionDetail(makePromoConfig({ status: 'paused' }), null, 0);

      expect(detail.canClaim).toBe(false);
    });

    it('canClaim=false with promotion_unavailable when paused + not-claimed', () => {
      const detail = computeUserPromotionDetail(makePromoConfig({ status: 'paused' }), null, 0);

      expect(detail.canClaim).toBe(false);
      expect(detail.unavailableReason).toBe('promotion_unavailable');
    });

    it('canClaim=false with promotion_unavailable when archived + not-claimed', () => {
      const detail = computeUserPromotionDetail(makePromoConfig({ status: 'archived' }), null, 0);

      expect(detail.canClaim).toBe(false);
      expect(detail.unavailableReason).toBe('promotion_unavailable');
    });

    it('temporal gate wins over claim_deadline_passed when both apply', () => {
      // status=paused AND deadline already in the past — temporal wins.
      const detail = computeUserPromotionDetail(
        makePromoConfig({
          status: 'paused',
          claimDeadlineAt: '2025-12-31T00:00:00Z',
        }),
        null,
        0,
        new Date('2026-06-01T00:00:00Z'),
      );

      expect(detail.canClaim).toBe(false);
      expect(detail.unavailableReason).toBe('promotion_unavailable');
    });

    it('canClaim=false with promotion_not_started when startAt is in the future', () => {
      const future = '2027-01-01T00:00:00Z';
      const detail = computeUserPromotionDetail(
        makePromoConfig({ startAt: future }),
        null,
        0,
        new Date('2026-06-01T00:00:00Z'),
      );

      expect(detail.canClaim).toBe(false);
      expect(detail.unavailableReason).toBe('promotion_not_started');
    });

    it('canClaim=true when startAt is in the past', () => {
      const detail = computeUserPromotionDetail(
        makePromoConfig({ startAt: '2026-01-01T00:00:00Z' }),
        null,
        0,
        new Date('2026-06-01T00:00:00Z'),
      );

      expect(detail.canClaim).toBe(true);
    });
  });

  describe('claimed', () => {
    it('canUseSponsoredAction=true for active entitlement with remaining', () => {
      const detail = computeUserPromotionDetail(makePromoConfig(), makeEntitlement(), 3);

      expect(detail.claimStatus).toBe('claimed');
      expect(detail.canClaim).toBe(false);
      expect(detail.canUseSponsoredAction).toBe(true);
      expect(detail.unavailableReason).toBeNull();
      expect(detail.userRemainingGasAllowanceMist).toBe('3000000');
    });

    it('canUseSponsoredAction=false when use window expired', () => {
      const detail = computeUserPromotionDetail(
        makePromoConfig(),
        makeEntitlement({ useUntilAt: '2025-12-31T00:00:00Z' }),
        3,
        new Date('2026-01-01T00:00:00Z'),
      );

      expect(detail.canUseSponsoredAction).toBe(false);
      expect(detail.unavailableReason).toBe('use_window_expired');
    });

    it('canUseSponsoredAction=false when allowance exhausted', () => {
      const detail = computeUserPromotionDetail(
        makePromoConfig(),
        makeEntitlement({
          status: 'exhausted',
          remainingGasAllowanceMist: '0',
          consumedGasAllowanceMist: '5000000',
        }),
        3,
      );

      expect(detail.canUseSponsoredAction).toBe(false);
      expect(detail.unavailableReason).toBe('allowance_exhausted');
    });

    it('canUseSponsoredAction=false when action in flight', () => {
      const detail = computeUserPromotionDetail(
        makePromoConfig(),
        makeEntitlement({
          activeReservationReceiptId: 'inflight-receipt',
          activeReservationAmountMist: '1000000',
        }),
        3,
      );

      expect(detail.canUseSponsoredAction).toBe(false);
      expect(detail.unavailableReason).toBe('action_in_flight');
    });

    it('use window not expired returns correct useUntilAt', () => {
      const futureDate = '2027-12-31T00:00:00Z';
      const detail = computeUserPromotionDetail(
        makePromoConfig(),
        makeEntitlement({ useUntilAt: futureDate }),
        3,
        new Date('2026-06-01T00:00:00Z'),
      );

      expect(detail.canUseSponsoredAction).toBe(true);
      expect(detail.useUntilAt).toBe(futureDate);
    });

    it('canUseSponsoredAction=false with promotion_not_started when startAt is in the future', () => {
      const future = '2027-01-01T00:00:00Z';
      const detail = computeUserPromotionDetail(
        makePromoConfig({ startAt: future }),
        makeEntitlement(),
        3,
        new Date('2026-06-01T00:00:00Z'),
      );

      expect(detail.claimStatus).toBe('claimed');
      expect(detail.canClaim).toBe(false);
      expect(detail.canUseSponsoredAction).toBe(false);
      expect(detail.unavailableReason).toBe('promotion_not_started');
    });

    it('canUseSponsoredAction=false when promotion is paused (promotion_unavailable)', () => {
      const detail = computeUserPromotionDetail(
        makePromoConfig({ status: 'paused' }),
        makeEntitlement(),
        3,
      );

      expect(detail.claimStatus).toBe('claimed');
      expect(detail.canUseSponsoredAction).toBe(false);
      expect(detail.unavailableReason).toBe('promotion_unavailable');
    });

    it('canUseSponsoredAction=false when promotion is archived (promotion_unavailable)', () => {
      const detail = computeUserPromotionDetail(
        makePromoConfig({ status: 'archived' }),
        makeEntitlement(),
        3,
      );

      expect(detail.claimStatus).toBe('claimed');
      expect(detail.canUseSponsoredAction).toBe(false);
      expect(detail.unavailableReason).toBe('promotion_unavailable');
    });

    it('promotion_unavailable takes priority over use_window_expired', () => {
      const detail = computeUserPromotionDetail(
        makePromoConfig({ status: 'paused' }),
        makeEntitlement({ useUntilAt: '2025-01-01T00:00:00Z' }),
        3,
        new Date('2026-01-01T00:00:00Z'),
      );

      // promotion-level gate fires first
      expect(detail.unavailableReason).toBe('promotion_unavailable');
    });
  });
});

// ─────────────────────────────────────────────
// Promotion List Item (§H)
// ─────────────────────────────────────────────

describe('computePromotionListItem', () => {
  it('returns unclaimed item with canClaim=true for active promotion', () => {
    const item = computePromotionListItem(makePromoConfig() as Promotion, null, 3, 40_000_000n);

    expect(item.promotionId).toBe('test-promo');
    expect(item.displayName).toBe('Test Promo');
    expect(item.type).toBe('gas_sponsorship');
    expect(item.canClaim).toBe(true);
    expect(item.canUseSponsoredAction).toBe(false);
    expect(item.promotionRemainingBudgetMist).toBe('40000000');
    expect(item.remainingParticipantSlots).toBe(7);
    expect(item.userRemainingGasAllowanceMist).toBeNull();
    expect(item.unavailableReason).toBe('not_claimed');
  });

  it('returns claimed item with canUseSponsoredAction=true', () => {
    const item = computePromotionListItem(
      makePromoConfig() as Promotion,
      makeEntitlement(),
      5,
      30_000_000n,
    );

    expect(item.canClaim).toBe(false);
    expect(item.canUseSponsoredAction).toBe(true);
    expect(item.userRemainingGasAllowanceMist).toBe('3000000');
    expect(item.remainingParticipantSlots).toBe(5);
    expect(item.unavailableReason).toBeNull();
  });

  it('treats an invalid maxParticipants=0 read model as having no remaining slots', () => {
    const item = computePromotionListItem(
      makePromoConfig({ maxParticipants: 0 }) as Promotion,
      null,
      0,
      0n,
    );

    expect(item.remainingParticipantSlots).toBe(0);
    expect(item.canClaim).toBe(false);
  });

  it('remainingParticipantSlots never goes below 0', () => {
    const item = computePromotionListItem(
      makePromoConfig({ maxParticipants: 5 }) as Promotion,
      null,
      10, // more claimed than max
      0n,
    );

    expect(item.remainingParticipantSlots).toBe(0);
  });
});
