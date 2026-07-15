/**
 * Promotion Execution Ledger — unified execution accounting interface.
 *
 * Claim, reserve, consume, and release are all owned by this interface.
 * Budget and entitlement state are co-located in a single atomic unit.
 *
 * Implementations: MemoryPromotionExecutionLedger (test), RedisPromotionExecutionLedger (production).
 * Both must pass the shared conformance test suite.
 *
 * @module studio/executionLedger
 */

import { PROMOTION_PAGE_MAX_LIMIT } from '@stelis/contracts';
import type {
  Entitlement,
  BudgetSummary,
  ClaimedUserProjection,
  ClaimOpts,
  ClaimResult,
  ReserveParams,
  ReserveResult,
  ConsumeResult,
  ReleaseResult,
} from './domain.js';

/** Ledger fields required to project one Studio Promotion page item. */
export interface PromotionListLedgerStatus {
  promotionId: string;
  entitlement: Entitlement | null;
  claimedCount: number;
  availableBudgetMist: bigint;
}

/** Keep the page projection operation within the contracts-owned page bound. */
export function assertPromotionListLedgerBatchBound(promotionIds: readonly string[]): void {
  if (promotionIds.length > PROMOTION_PAGE_MAX_LIMIT) {
    throw new Error(`Promotion page ledger batch cannot exceed ${PROMOTION_PAGE_MAX_LIMIT} IDs`);
  }
}

// ─────────────────────────────────────────────
// Operational parameters
// ─────────────────────────────────────────────

/**
 * Default reservation TTL in milliseconds.
 *
 * Contract for ExecutionLedger implementations (Memory, Redis).
 * Matches the value documented in docs/parameters.md#ttl-constants.
 * Expired reservations are cleaned by sweepExpiredReservations().
 */
export const PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS = 60_000;

/**
 * Default background reaper sweep interval in milliseconds.
 * Only used by implementations that run a background timer (e.g., Redis).
 *
 * The sweep walks `stelis:promotion_execution_ledger:res:*` via a non-blocking SCAN cursor
 * and a single `LUA_RELEASE` per expired key, so this cadence keeps
 * post-expiry recovery bounded for the expected promotion-reservation
 * working set.
 */
export const PROMOTION_EXECUTION_LEDGER_DEFAULT_REAPER_INTERVAL_MS = 15_000;

// ─────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────

/**
 * PromotionExecutionLedger — execution accounting for a promotion system.
 *
 * All write operations are atomic within the ledger. Budget and entitlement
 * consistency is guaranteed by single-owner design (no external coordinator).
 *
 * Money values use string (for serialization) or bigint (for computation),
 * never floating-point number.
 */
export interface PromotionExecutionLedger {
  // ── Claim (atomic: dedupe + capacity + entitlement creation) ──

  /**
   * Claim a promotion for a user.
   *
   * The dedupe + capacity guard + entitlement creation block is atomic
   * within the implementation (single Redis Lua EVAL or single in-memory
   * synchronous block). If any of those sub-steps fails, no entitlement
   * or claim record is committed.
   *
   * Promotion budget materialization differs by adapter and is not part
   * of the atomic dedupe/capacity/entitlement rollback unit:
   *
   *   - Redis: `budget:avail` (set to the derived total), `budget:res_total`,
   *     and `budget:con_total` are installed by idempotent pre-Lua NX
   *     writes immediately before the claim Lua script. NX writes never
   *     overwrite an already-installed value, so a repeat claim is safe.
   *     Summary reads do not create budget keys, and reserve may initialize
   *     zero aggregate keys only after the entitlement gate passes inside
   *     the reserve Lua script. Neither path can install a zero
   *     `budget:avail` ahead of the real total.
   *   - Memory: claim records the shared semantic guard's exact total budget;
   *     the in-memory `budgets` map entry
   *     is materialized lazily by `ensureBudget(promotionId)` on the
   *     first reserve. Read paths (`getBudgetSummary`) derive an
   *     ephemeral snapshot from that validated total without persisting any
   *     `BudgetState`.
   *
   * Either way, after a successful claim the next `reserve()` sees a
   * fully materialized budget equal to `maxParticipants × perUserGasAllowanceMist`.
   *
   * @param promotionId - Promotion to claim.
   * @param userId - User claiming the promotion.
   * @param opts - Claim options (maxParticipants, perUserGasAllowanceMist, useUntilAt).
   * @returns ClaimResult — ok with entitlement, or failure reason.
   */
  claim(promotionId: string, userId: string, opts: ClaimOpts): Promise<ClaimResult>;

  // ── Reserve / Consume / Release ──

  /**
   * Reserve budget + entitlement allowance for a sponsored action.
   *
   * Fails if:
   * - Entitlement not found or not active.
   * - Entitlement has insufficient remaining allowance.
   * - Concurrent reservation already exists for this user+promotion.
   * - Promotion budget insufficient.
   *
   * Implementations must reject the failure paths above before any
   * mutation of budget accounting state. Promotion-budget keys may be
   * lazily installed inside the same atomic block as the budget
   * deduction, after the entitlement gate passes; a failed pre-claim
   * reserve must not initialize or alter budget keys.
   */
  reserve(params: ReserveParams): Promise<ReserveResult>;

  /**
   * Consume a reservation as a terminal settlement.
   *
   * Delta-release semantics: if actualGasMist < reserved, surplus is
   * returned to both budget and entitlement. If actualGasMist > reserved
   * (overrun), extra is deducted from remaining. `actualGasMist === 0n`
   * is permitted (delete-objects-only revert; failure-path callers feed
   * the canonical 0-clamp via `computeExecutionCostClaim`); the full reserved
   * amount delta-releases as surplus.
   *
   * Used by both the success path (`actualGasMist` from successful
   * effects) and the post-signature/post-submit failure branches
   * (post-signature uncertainty and on-chain revert). Failure-path callers
   * pass either the canonical `simGas` (validated on-chain effects) or
   * `prepared.reservedGasMist` (post-signature uncertainty) and append a
   * `result: 'failed'` usage row with a
   * branch-specific `failureReason`. Pre-submit failures and congestion
   * still call `release()` instead.
   *
   * The reservation is terminalized after a successful consume — the
   * background reaper (`sweepExpiredReservations`) MUST NOT later
   * release the same reservation.
   *
   * @param receiptId - Receipt ID from the reservation.
   * @param actualGasMist - Actual gas consumed in MIST. Non-negative
   *   bigint; on-chain effects already clamp to 0 on the failure-path
   *   call sites.
   */
  consume(receiptId: string, actualGasMist: bigint): Promise<ConsumeResult>;

  /**
   * Release a reservation (failure path).
   *
   * Full restoration: reserved amount is returned to both budget
   * and entitlement remaining allowance.
   *
   * @param receiptId - Receipt ID to release.
   */
  release(receiptId: string): Promise<ReleaseResult>;

  // ── Read models ──

  /**
   * Get a user's entitlement for a promotion.
   * Returns null if the user has not claimed.
   */
  getEntitlement(promotionId: string, userId: string): Promise<Entitlement | null>;

  /**
   * Get promotion-level budget summary.
   *
   * Read-only: must not install or mutate budget accounting state.
   * Returns existing snapshot if available; otherwise an ephemeral
   * `{ availableMist: total-from-config, reservedMist: 0n, consumedMist: 0n }`
   * derived from a recorded promo config when present, else
   * `{ 0n, 0n, 0n }`. Read paths cannot create budget keys or affect the
   * later first-claim budget install.
   */
  getBudgetSummary(promotionId: string): Promise<BudgetSummary>;

  /**
   * Get the number of users who have claimed a promotion.
   */
  getClaimedCount(promotionId: string): Promise<number>;

  /**
   * Read the Studio list projection for one bounded Promotion page.
   *
   * Results preserve the exact input ID order. Implementations read their
   * underlying state directly as one bounded adapter operation rather than
   * calling the three single-Promotion read methods for every ID.
   */
  getPromotionListLedgerStatuses(
    promotionIds: readonly string[],
    userId: string,
  ): Promise<PromotionListLedgerStatus[]>;

  /**
   * Get enriched claimed-user projection for admin views.
   *
   * Returns userId + claimedAt + entitlement state per user,
   * eliminating the caller-side N+1 join.
   */
  listClaimedUsers(promotionId: string): Promise<ClaimedUserProjection[]>;

  // ── Background ──

  /**
   * Sweep expired reservations and restore their budget/entitlement.
   * Called by background timer. Returns number of swept reservations.
   */
  sweepExpiredReservations(): Promise<number>;

  /**
   * Dispose background resources (timers, connections).
   */
  dispose(): void;
}
