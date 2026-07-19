/**
 * Promotion Derived Summary — read models derived from existing stores.
 *
 * These are pure functions and type definitions for admin / service-user
 * read models. They aggregate data from:
 *   - `Promotion` (promotionStore) for configuration
 *   - `ExecutionLedger` status reads for per-user and promotion-level
 *     execution state
 *   - `computeTotalRequiredBudgetMist()` (domain) for budget derivation
 *
 * No new store is introduced. This module only computes derived values.
 *
 * @module promotionDerivedSummary
 */

import type {
  PromotionListItem,
  PromotionUnavailableReason,
  UserPromotionDetail,
} from '@stelis/contracts';
import type { Entitlement, Promotion } from './domain.js';
import { computeTotalRequiredBudgetMist } from './domain.js';
import { checkPromotionTemporalGate } from './validation.js';

export type {
  PromotionListItem,
  PromotionUnavailableReason,
  UserPromotionDetail,
} from '@stelis/contracts';

// ─────────────────────────────────────────────
// Admin Summary (promotion-level)
// ─────────────────────────────────────────────

/**
 * Promotion-level admin summary, derived from stores.
 */
export interface PromotionAdminSummary {
  /** Number of users who have claimed this promotion. */
  claimedCount: number;
  /** Remaining participant slots under the finite promotion cap. */
  remainingParticipantSlots: number;
  /** Total budget consumed so far in MIST. */
  totalConsumedBudgetMist: string;
  /** Total budget currently reserved (in-flight) in MIST. */
  totalReservedBudgetMist: string;
  /** Total remaining available budget in MIST. */
  totalRemainingBudgetMist: string;
  /**
   * Total required budget (maxParticipants × perUserGasAllowanceMist).
   * The shared Promotion ledger-value guard validates this product before a
   * record can be stored, activated, or projected through the Host wire.
   */
  totalRequiredBudgetMist: string;
}

/**
 * Budget state snapshot for admin summary computation.
 *
 * Caller obtains these fields from
 * `PromotionExecutionLedger.getPromotionLedgerStatus().budget`.
 */
export interface BudgetSnapshot {
  availableMist: bigint;
  reservedMist: bigint;
  consumedMist: bigint;
}

/**
 * Compute admin summary from promotion config and ExecutionLedger read models.
 *
 * @param promotion - Promotion record.
 * @param claimedCount - Number of claimed users from the ledger status.
 * @param budget - Budget from the same ledger status.
 */
export function computePromotionAdminSummary(
  promotion: Pick<Promotion, 'maxParticipants' | 'perUserGasAllowanceMist'>,
  claimedCount: number,
  budget: BudgetSnapshot,
): PromotionAdminSummary {
  const totalRequired = BigInt(computeTotalRequiredBudgetMist(promotion));

  const remainingSlots = Math.max(0, promotion.maxParticipants - claimedCount);

  return {
    claimedCount,
    remainingParticipantSlots: remainingSlots,
    totalConsumedBudgetMist: budget.consumedMist.toString(),
    totalReservedBudgetMist: budget.reservedMist.toString(),
    totalRemainingBudgetMist: budget.availableMist.toString(),
    totalRequiredBudgetMist: totalRequired.toString(),
  };
}

// ─────────────────────────────────────────────
// Service User Detail (user-level read model)
// ─────────────────────────────────────────────

/**
 * Compute user promotion detail from stored data.
 *
 * @param promotion - Promotion record.
 * @param entitlement - User's entitlement record (null if not claimed).
 * @param claimedCount - Current count of claimed users.
 * @param now - Current timestamp for deadline checks.
 */
export function computeUserPromotionDetail(
  promotion: Pick<Promotion, 'maxParticipants' | 'claimDeadlineAt' | 'status' | 'startAt'>,
  entitlement: Entitlement | null,
  claimedCount: number,
  now = new Date(),
): UserPromotionDetail {
  // Shared temporal gate (status + startAt). Promotion-not-found path is not
  // relevant to the read model (caller has already loaded the record).
  const temporal = checkPromotionTemporalGate(promotion, now);
  const claimDeadlinePassed = promotion.claimDeadlineAt
    ? new Date(promotion.claimDeadlineAt).getTime() <= now.getTime()
    : false;

  // Not claimed — precedence must match the shared temporal gate so
  // paused/archived (PROMOTION_NOT_ACTIVE) and not-yet-started
  // (PROMOTION_NOT_STARTED) records keep distinct reasons instead of
  // falling through to `not_claimed`.
  if (!entitlement) {
    const slotsAvailable = claimedCount < promotion.maxParticipants;
    const temporalOk = temporal === null;
    const canClaim = temporalOk && !claimDeadlinePassed && slotsAvailable;

    let unavailableReason: PromotionUnavailableReason;
    if (temporal) {
      unavailableReason =
        temporal.code === 'PROMOTION_NOT_STARTED'
          ? 'promotion_not_started'
          : 'promotion_unavailable';
    } else if (claimDeadlinePassed) {
      unavailableReason = 'claim_deadline_passed';
    } else {
      unavailableReason = 'not_claimed';
    }

    return {
      claimStatus: 'not_claimed',
      userRemainingGasAllowanceMist: null,
      claimDeadlineAt: promotion.claimDeadlineAt ?? null,
      useUntilAt: null,
      canClaim,
      canUseSponsoredAction: false,
      unavailableReason,
    };
  }

  // Claimed — check promotion-level gate then per-user state.
  const useWindowExpired = entitlement.useUntilAt
    ? new Date(entitlement.useUntilAt).getTime() <= now.getTime()
    : false;

  let canUseSponsoredAction = true;
  let unavailableReason: PromotionUnavailableReason | null = null;

  // Promotion-level gate: non-active promotion OR not-yet-started window
  // blocks sponsored actions for claimed users. Consistent with prepare/
  // sponsor route paths via `checkPromotionTemporalGate`.
  if (temporal) {
    canUseSponsoredAction = false;
    unavailableReason =
      temporal.code === 'PROMOTION_NOT_STARTED' ? 'promotion_not_started' : 'promotion_unavailable';
  } else if (useWindowExpired) {
    canUseSponsoredAction = false;
    unavailableReason = 'use_window_expired';
  } else if (entitlement.status === 'exhausted') {
    canUseSponsoredAction = false;
    unavailableReason = 'allowance_exhausted';
  } else if (entitlement.activeReservationReceiptId !== null) {
    canUseSponsoredAction = false;
    unavailableReason = 'action_in_flight';
  }

  return {
    claimStatus: 'claimed',
    userRemainingGasAllowanceMist: entitlement.remainingGasAllowanceMist,
    claimDeadlineAt: promotion.claimDeadlineAt ?? null,
    useUntilAt: entitlement.useUntilAt,
    canClaim: false, // Already claimed
    canUseSponsoredAction,
    unavailableReason,
  };
}

// ─────────────────────────────────────────────
// Service User Promotion List Item
// ─────────────────────────────────────────────

/**
 * Compute a promotion list item for a specific user.
 *
 * Reuses computeUserPromotionDetail() for user-state derivation,
 * then enriches with promotion-level metadata.
 *
 * @param promotion - Full promotion record.
 * @param entitlement - User's entitlement record (null if not claimed).
 * @param claimedCount - Current count of claimed users from the ledger status.
 * @param availableBudgetMist - Available budget from the same ledger status.
 * @param now - Current timestamp for deadline checks.
 */
export function computePromotionListItem(
  promotion: Promotion,
  entitlement: Entitlement | null,
  claimedCount: number,
  availableBudgetMist: bigint,
  now = new Date(),
): PromotionListItem {
  const userDetail = computeUserPromotionDetail(promotion, entitlement, claimedCount, now);

  const remainingParticipantSlots = Math.max(0, promotion.maxParticipants - claimedCount);

  return {
    promotionId: promotion.promotionId,
    displayName: promotion.displayName,
    type: promotion.type,
    status: promotion.status,
    canClaim: userDetail.canClaim,
    canUseSponsoredAction: userDetail.canUseSponsoredAction,
    promotionRemainingBudgetMist: availableBudgetMist.toString(),
    remainingParticipantSlots,
    userRemainingGasAllowanceMist: userDetail.userRemainingGasAllowanceMist,
    unavailableReason: userDetail.unavailableReason,
  };
}
