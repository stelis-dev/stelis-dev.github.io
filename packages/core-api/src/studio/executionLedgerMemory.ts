/**
 * MemoryPromotionExecutionLedger — in-memory implementation for testing.
 *
 * Single-threaded, no Lua needed. All operations are synchronous-safe
 * (wrapped in Promise for interface conformance).
 *
 * Budget is lazily installed in mutation paths (`reserve` / `consume` /
 * `release` / `sweepExpiredReservations`) via `ensureBudget()`. Read paths
 * (`getBudgetSummary`) are non-mutating: they return existing snapshots
 * directly, derive an ephemeral snapshot from `promoConfig` if a claim has
 * already recorded one, or return `{0n,0n,0n}` for unclaimed promotions.
 * Total budget = `maxParticipants * perUserGasAllowanceMist` (computed
 * from claim opts at claim time and stored per-promotion).
 *
 * @module studio/executionLedgerMemory
 */

import type { PromotionExecutionLedger } from './executionLedger.js';
import {
  PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS,
  MAX_PROMOTION_LEDGER_VALUE_MIST,
} from './executionLedger.js';
import {
  parseNonNegativeDecimalBigInt,
  assertPositiveMist,
  assertNonNegativeMist,
  assertWithinLedgerBound,
} from './executionLedgerValueGuards.js';
import type {
  Entitlement,
  EntitlementStatus,
  BudgetSummary,
  ClaimedUserProjection,
  ClaimOpts,
  ClaimResult,
  ReserveParams,
  ReserveResult,
  ConsumeResult,
  ReleaseResult,
} from './domain.js';
import { type Clock, systemClock } from '../clock.js';

// Money-input parse + assertion helpers live in
// `executionLedgerValueGuards.ts` so the Memory and Redis adapters
// stay in lock-step on bound semantics and error messages. The
// `MAX_PROMOTION_LEDGER_VALUE_MIST` constant import above is reused
// by the inline `claim()` bound checks below (which carry
// branch-specific error messages distinct from the helper's generic
// `${label}` shape).

// ─────────────────────────────────────────────
// Internal state types
// ─────────────────────────────────────────────

interface ClaimEntry {
  userId: string;
  claimedAt: string;
}

interface EntitlementState {
  promotionId: string;
  userId: string;
  claimedAt: string;
  useUntilAt: string | null;
  remainingMist: bigint;
  consumedMist: bigint;
  status: EntitlementStatus;
  activeReservationReceiptId: string | null;
  activeReservationAmountMist: bigint | null;
  lastUsedAt: string | null;
}

interface ReservationRecord {
  promotionId: string;
  userId: string;
  amountMist: bigint;
  createdAt: number;
  expiresAt: number;
}

interface BudgetState {
  totalMist: bigint;
  availableMist: bigint;
  reservedMist: bigint;
  consumedMist: bigint;
}

// ─────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────

export class MemoryPromotionExecutionLedger implements PromotionExecutionLedger {
  private readonly reservationTtlMs: number;
  private readonly _clock: Clock;

  /**
   * @param reservationTtlMs - TTL for reservations. Default: PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS.
   *   Tests can pass a short value to verify sweep behavior.
   * @param clock             - Optional `Clock` for reservation TTL reads.
   *                            Defaults to `systemClock`. ISO timestamp
   *                            fields (`claimedAt`, `lastUsedAt`) intentionally
   *                            still use `new Date().toISOString()` — they
   *                            live on a separate observability axis.
   */
  constructor(
    reservationTtlMs: number = PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS,
    clock: Clock = systemClock,
  ) {
    if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs < 0) {
      throw new Error(
        'MemoryPromotionExecutionLedger: reservationTtlMs must be a non-negative safe integer',
      );
    }
    this.reservationTtlMs = reservationTtlMs;
    this._clock = clock;
  }

  /**
   * claim index: promotionId → Set<userId>
   * Used for dedupe, capacity guard, and listClaimedUsers.
   */
  private readonly claimIndex = new Map<string, Map<string, ClaimEntry>>();

  /** entitlement state: `${promotionId}:${userId}` → EntitlementState */
  private readonly entitlements = new Map<string, EntitlementState>();

  /** reservation records: receiptId → ReservationRecord */
  private readonly reservations = new Map<string, ReservationRecord>();

  /** budget state: promotionId → BudgetState */
  private readonly budgets = new Map<string, BudgetState>();

  /** promotion config cache (from claim opts): promotionId → { maxParticipants, perUserGasAllowanceMist } */
  private readonly promoConfig = new Map<
    string,
    { maxParticipants: number; perUserGasAllowanceMist: string }
  >();

  /** final receipts (consumed or released): receiptId → true */
  private readonly terminalReceipts = new Set<string>();

  // ── Claim ──────────────────────────────────

  async claim(promotionId: string, userId: string, opts: ClaimOpts): Promise<ClaimResult> {
    if (!Number.isSafeInteger(opts.maxParticipants) || opts.maxParticipants <= 0) {
      throw new Error('maxParticipants must be a positive safe integer');
    }
    const perUserGasAllowanceMist = parseNonNegativeDecimalBigInt(
      opts.perUserGasAllowanceMist,
      'perUserGasAllowanceMist',
    );
    // Defensive bound check (parity with the Redis ledger). The
    // activation gate is the main validation point; this re-check
    // ensures any out-of-band caller cannot poison the Memory
    // entitlement counters with a value that the Redis adapter would
    // refuse, keeping the two adapters' conformance behavior aligned.
    if (perUserGasAllowanceMist > MAX_PROMOTION_LEDGER_VALUE_MIST) {
      throw new Error(
        `perUserGasAllowanceMist (${perUserGasAllowanceMist.toString()}) exceeds MAX_PROMOTION_LEDGER_VALUE_MIST (${MAX_PROMOTION_LEDGER_VALUE_MIST.toString()})`,
      );
    }
    const totalBudgetBigInt = BigInt(opts.maxParticipants) * perUserGasAllowanceMist;
    if (totalBudgetBigInt > MAX_PROMOTION_LEDGER_VALUE_MIST) {
      throw new Error(
        `total budget (maxParticipants × perUserGasAllowanceMist = ${totalBudgetBigInt.toString()}) exceeds MAX_PROMOTION_LEDGER_VALUE_MIST (${MAX_PROMOTION_LEDGER_VALUE_MIST.toString()})`,
      );
    }

    // Get or create claim index for this promotion
    let promoClaims = this.claimIndex.get(promotionId);
    if (!promoClaims) {
      promoClaims = new Map();
      this.claimIndex.set(promotionId, promoClaims);
    }

    // Dedupe check
    if (promoClaims.has(userId)) {
      return { ok: false, reason: 'duplicate' };
    }

    // Capacity check
    if (promoClaims.size >= opts.maxParticipants) {
      return { ok: false, reason: 'capacity_exceeded' };
    }

    // Store promo config for budget lazy-init
    if (!this.promoConfig.has(promotionId)) {
      this.promoConfig.set(promotionId, {
        maxParticipants: opts.maxParticipants,
        perUserGasAllowanceMist: perUserGasAllowanceMist.toString(),
      });
    }

    const now = new Date().toISOString();
    const key = entKey(promotionId, userId);

    // Create claim entry
    promoClaims.set(userId, { userId, claimedAt: now });

    // Create entitlement
    const state: EntitlementState = {
      promotionId,
      userId,
      claimedAt: now,
      useUntilAt: opts.useUntilAt,
      remainingMist: perUserGasAllowanceMist,
      consumedMist: 0n,
      status: 'active',
      activeReservationReceiptId: null,
      activeReservationAmountMist: null,
      lastUsedAt: null,
    };
    this.entitlements.set(key, state);

    return { ok: true, entitlement: toEntitlement(state) };
  }

  // ── Reserve ────────────────────────────────

  async reserve(params: ReserveParams): Promise<ReserveResult> {
    const { promotionId, userId, receiptId, amountMist } = params;
    assertPositiveMist(amountMist, 'amountMist');
    assertWithinLedgerBound(amountMist, 'amountMist');
    const key = entKey(promotionId, userId);
    const state = this.entitlements.get(key);

    if (!state) {
      return { ok: false, reason: 'entitlement_not_found' };
    }

    if (state.status !== 'active') {
      return { ok: false, reason: 'entitlement_not_active' };
    }

    if (state.activeReservationReceiptId !== null) {
      return { ok: false, reason: 'concurrent_reservation' };
    }

    if (state.remainingMist < amountMist) {
      return { ok: false, reason: 'entitlement_insufficient' };
    }

    // Ensure budget is initialized
    const budget = this.ensureBudget(promotionId);

    if (budget.availableMist < amountMist) {
      return { ok: false, reason: 'budget_insufficient' };
    }

    // Atomically update entitlement + budget + reservation
    state.remainingMist -= amountMist;
    state.activeReservationReceiptId = receiptId;
    state.activeReservationAmountMist = amountMist;

    budget.availableMist -= amountMist;
    budget.reservedMist += amountMist;

    const now = this._clock.nowMs();
    this.reservations.set(receiptId, {
      promotionId,
      userId,
      amountMist,
      createdAt: now,
      expiresAt: now + this.reservationTtlMs,
    });

    return { ok: true, entitlement: toEntitlement(state) };
  }

  // ── Consume ────────────────────────────────

  async consume(receiptId: string, actualGasMist: bigint): Promise<ConsumeResult> {
    assertNonNegativeMist(actualGasMist, 'actualGasMist');
    assertWithinLedgerBound(actualGasMist, 'actualGasMist');
    const reservation = this.reservations.get(receiptId);
    if (!reservation || this.terminalReceipts.has(receiptId)) {
      return { ok: false, reason: 'reservation_not_found' };
    }

    const { promotionId, userId, amountMist: reservedMist } = reservation;
    const key = entKey(promotionId, userId);
    const state = this.entitlements.get(key);
    const budget = this.budgets.get(promotionId);

    if (!state || !budget) {
      return { ok: false, reason: 'reservation_not_found' };
    }

    // Delta-release semantics
    const delta = reservedMist > actualGasMist ? reservedMist - actualGasMist : 0n;
    const overrun = actualGasMist > reservedMist ? actualGasMist - reservedMist : 0n;

    // Update entitlement
    // Restore delta to remaining (delta-release)
    state.remainingMist += delta;
    // Deduct overrun from remaining (clamped to 0)
    if (overrun > 0n) {
      state.remainingMist = state.remainingMist > overrun ? state.remainingMist - overrun : 0n;
    }
    state.consumedMist += actualGasMist;
    state.activeReservationReceiptId = null;
    state.activeReservationAmountMist = null;
    state.lastUsedAt = new Date().toISOString();

    // Update status if exhausted
    if (state.remainingMist === 0n) {
      state.status = 'exhausted';
    }

    // Update budget
    budget.reservedMist -= reservedMist;
    budget.consumedMist += actualGasMist;
    // Return delta to available
    budget.availableMist += delta;
    // Deduct overrun from available (clamped to 0)
    if (overrun > 0n) {
      budget.availableMist = budget.availableMist > overrun ? budget.availableMist - overrun : 0n;
    }

    // Mark terminal
    this.terminalReceipts.add(receiptId);
    this.reservations.delete(receiptId);

    return { ok: true, entitlement: toEntitlement(state) };
  }

  // ── Release ────────────────────────────────

  async release(receiptId: string): Promise<ReleaseResult> {
    const reservation = this.reservations.get(receiptId);
    if (!reservation || this.terminalReceipts.has(receiptId)) {
      return { ok: false, reason: 'reservation_not_found' };
    }

    const { promotionId, userId, amountMist } = reservation;
    const key = entKey(promotionId, userId);
    const state = this.entitlements.get(key);
    const budget = this.budgets.get(promotionId);

    if (!state || !budget) {
      return { ok: false, reason: 'reservation_not_found' };
    }

    // Full restoration
    state.remainingMist += amountMist;
    state.activeReservationReceiptId = null;
    state.activeReservationAmountMist = null;

    budget.reservedMist -= amountMist;
    budget.availableMist += amountMist;

    // Mark terminal
    this.terminalReceipts.add(receiptId);
    this.reservations.delete(receiptId);

    return { ok: true, entitlement: toEntitlement(state) };
  }

  // ── Read models ────────────────────────────

  async getEntitlement(promotionId: string, userId: string): Promise<Entitlement | null> {
    const state = this.entitlements.get(entKey(promotionId, userId));
    return state ? toEntitlement(state) : null;
  }

  async getBudgetSummary(promotionId: string): Promise<BudgetSummary> {
    // Read-only: summaries never materialize `BudgetState`. Mutation
    // paths own `ensureBudget()` because they update budget accounting.
    const existing = this.budgets.get(promotionId);
    if (existing) {
      return {
        availableMist: existing.availableMist,
        reservedMist: existing.reservedMist,
        consumedMist: existing.consumedMist,
      };
    }
    // No budget materialized yet. Derive an ephemeral snapshot from
    // `promoConfig` if claim() recorded one; otherwise return the
    // unclaimed-promotion shape `{ 0, 0, 0 }`.
    const config = this.promoConfig.get(promotionId);
    if (!config) {
      return { availableMist: 0n, reservedMist: 0n, consumedMist: 0n };
    }
    const total =
      BigInt(config.maxParticipants) *
      parseNonNegativeDecimalBigInt(config.perUserGasAllowanceMist, 'perUserGasAllowanceMist');
    return { availableMist: total, reservedMist: 0n, consumedMist: 0n };
  }

  async getClaimedCount(promotionId: string): Promise<number> {
    return this.claimIndex.get(promotionId)?.size ?? 0;
  }

  async listClaimedUsers(promotionId: string): Promise<ClaimedUserProjection[]> {
    const claims = this.claimIndex.get(promotionId);
    if (!claims) return [];

    const result: ClaimedUserProjection[] = [];
    for (const [userId, claim] of claims) {
      const state = this.entitlements.get(entKey(promotionId, userId));
      result.push({
        userId,
        claimedAt: claim.claimedAt,
        remainingGasAllowanceMist: state ? state.remainingMist.toString() : null,
        consumedGasAllowanceMist: state ? state.consumedMist.toString() : null,
        status: state ? state.status : null,
        activeReservationReceiptId: state ? state.activeReservationReceiptId : null,
      });
    }
    return result;
  }

  // ── Background ─────────────────────────────

  async sweepExpiredReservations(): Promise<number> {
    const now = this._clock.nowMs();
    let swept = 0;

    for (const [receiptId, reservation] of this.reservations) {
      if (reservation.expiresAt > now) continue;
      if (this.terminalReceipts.has(receiptId)) continue;

      // Expired reservation: full restoration (same semantics as release)
      const { promotionId, userId, amountMist } = reservation;
      const key = entKey(promotionId, userId);
      const state = this.entitlements.get(key);
      const budget = this.budgets.get(promotionId);

      if (state) {
        state.remainingMist += amountMist;
        state.activeReservationReceiptId = null;
        state.activeReservationAmountMist = null;
      }

      if (budget) {
        budget.reservedMist -= amountMist;
        budget.availableMist += amountMist;
      }

      this.terminalReceipts.add(receiptId);
      this.reservations.delete(receiptId);
      swept++;
    }

    return swept;
  }

  dispose(): void {
    // No background timers in memory implementation.
  }

  // ── Private helpers ────────────────────────

  private ensureBudget(promotionId: string): BudgetState {
    let budget = this.budgets.get(promotionId);
    if (!budget) {
      const config = this.promoConfig.get(promotionId);
      const total = config
        ? BigInt(config.maxParticipants) *
          parseNonNegativeDecimalBigInt(config.perUserGasAllowanceMist, 'perUserGasAllowanceMist')
        : 0n;
      budget = {
        totalMist: total,
        availableMist: total,
        reservedMist: 0n,
        consumedMist: 0n,
      };
      this.budgets.set(promotionId, budget);
    }
    return budget;
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function entKey(promotionId: string, userId: string): string {
  return `${promotionId}:${userId}`;
}

function toEntitlement(state: EntitlementState): Entitlement {
  return {
    promotionId: state.promotionId,
    userId: state.userId,
    claimedAt: state.claimedAt,
    useUntilAt: state.useUntilAt,
    remainingGasAllowanceMist: state.remainingMist.toString(),
    consumedGasAllowanceMist: state.consumedMist.toString(),
    status: state.status,
    activeReservationReceiptId: state.activeReservationReceiptId,
    activeReservationAmountMist: state.activeReservationAmountMist?.toString() ?? null,
    lastUsedAt: state.lastUsedAt,
  };
}
