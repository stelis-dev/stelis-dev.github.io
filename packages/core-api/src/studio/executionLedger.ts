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

/** One internally consistent Promotion accounting read. */
export interface PromotionLedgerStatus {
  promotionId: string;
  entitlement: Entitlement | null;
  claimedCount: number;
  budget: BudgetSummary;
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
export const PROMOTION_EXECUTION_LEDGER_SWEEP_BATCH_SIZE = 100;

/**
 * Default background reaper sweep interval in milliseconds.
 * Only used by implementations that run a background timer (e.g., Redis).
 *
 * Redis keeps reservation deadlines in one ordered index and releases
 * expired reservations in fixed-size batches using Redis server time.
 * This cadence bounds how long an expired reservation remains visible.
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
   * synchronous block). If any of those sub-steps fails, no accounting
   * or entitlement mutation is committed.
   *
   * The first claim atomically creates the current Promotion accounting
   * record and entitlement. Later claims must match the same immutable
   * Promotion economics before incrementing the claim count.
   *
   * @param promotionId - Promotion to claim.
   * @param userId - User claiming the promotion.
   * @param opts - Claim options owned by the claim request.
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
   * Implementations validate the exact current Promotion, accounting,
   * entitlement, reservation, and final-result records before mutation.
   * A same-receipt retry succeeds only when the stored reservation and
   * entitlement binding are exact.
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
   * `prepared.reservedGasMist` (post-signature uncertainty). Pre-submit
   * failures and congestion still call `release()` instead.
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
   * Read one internally consistent accounting snapshot.
   *
   * Pass a user ID when the same snapshot must include that user's
   * entitlement. Pass null for a Promotion-only operator read. The method is
   * read-only and returns zero accounting when no claim has created it.
   */
  getPromotionLedgerStatus(
    promotionId: string,
    userId: string | null,
  ): Promise<PromotionLedgerStatus>;

  /**
   * Read the Studio list projection for one bounded Promotion page.
   *
   * Results preserve the exact input ID order. Implementations snapshot their
   * underlying ledger state inside this bounded adapter operation rather than
   * calling the single-Promotion read contract for every ID. Redis performs
   * one atomic batch read; Memory snapshots its local records in one pass.
   */
  getPromotionListLedgerStatuses(
    promotionIds: readonly string[],
    userId: string,
  ): Promise<PromotionListLedgerStatus[]>;

  // ── Background ──

  /**
   * Sweep one bounded batch of expired reservations and restore their
   * accounting and entitlement. A final result that still has a reservation
   * deadline is storage corruption, not a stale index entry to repair.
   * Returns the number of reservations actually released.
   */
  sweepExpiredReservations(): Promise<number>;

  /**
   * Dispose background resources (timers, connections).
   */
  dispose(): Promise<void>;
}
