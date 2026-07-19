/**
 * PromotionExecutionLedger — shared conformance test suite.
 *
 * Both MemoryPromotionExecutionLedger and RedisPromotionExecutionLedger
 * must pass this suite. The factory parameter lets each implementation
 * provide its own setup/teardown.
 *
 * Tests verify the behavioral contract, not implementation details.
 *
 * Test count visibility: `runLedgerConformanceTests()` registers the shared
 * `it()` cases. Redis callers run this suite through the non-skippable
 * `test:redis` command, so Redis startup failure must surface as a failed
 * conformance run rather than skipped tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MAX_PROMOTION_LEDGER_VALUE_MIST } from '@stelis/contracts';
import type { PromotionExecutionLedger } from '../src/studio/executionLedger.js';
import type { BudgetSummary, ClaimOpts, ReserveParams } from '../src/studio/domain.js';
import {
  CAPACITY_PROMO,
  CLAMP_PROMO,
  EXHAUST_PROMO,
  PAGE_PROMO_A,
  PAGE_PROMO_B,
  PROMO_ID,
  PROMO_X,
  PROMO_Y,
} from './helpers/promotionLedgerFixture.js';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const USER_A = 'user-a';
const USER_B = 'user-b';
const USER_C = 'user-c';
const PER_USER_ALLOWANCE = '5000000'; // 5M MIST
const RESERVE_AMOUNT = 1_000_000n; // 1M MIST
const PAGE_PROMO_MISSING = '00000000-0000-4000-8000-000000000003';

function defaultClaimOpts(overrides?: Partial<ClaimOpts>): ClaimOpts {
  return {
    useUntilAt: null,
    ...overrides,
  };
}

function defaultReserveParams(overrides?: Partial<ReserveParams>): ReserveParams {
  return {
    promotionId: PROMO_ID,
    userId: USER_A,
    receiptId: 'receipt-1',
    amountMist: RESERVE_AMOUNT,
    ...overrides,
  };
}

async function readBudget(
  ledger: PromotionExecutionLedger,
  promotionId: string,
): Promise<BudgetSummary> {
  return (await ledger.getPromotionLedgerStatus(promotionId, null)).budget;
}

// ─────────────────────────────────────────────
// Conformance suite
// ─────────────────────────────────────────────

/**
 * @param factory - Creates a fresh ledger for each test.
 * @param sweepFactory - Optional: creates a ledger with TTL=0 for sweep tests.
 *   If not provided, sweep/expiry tests are skipped.
 */
export function runLedgerConformanceTests(
  factory: () => PromotionExecutionLedger | Promise<PromotionExecutionLedger>,
  sweepFactory?: () => PromotionExecutionLedger | Promise<PromotionExecutionLedger>,
): void {
  let ledger: PromotionExecutionLedger;

  beforeEach(async () => {
    ledger = await factory();
  });

  // ── Claim ──────────────────────────────────

  describe('claim', () => {
    it('creates entitlement on first claim', async () => {
      const result = await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.entitlement.promotionId).toBe(PROMO_ID);
      expect(result.entitlement.userId).toBe(USER_A);
      expect(result.entitlement.remainingGasAllowanceMist).toBe(PER_USER_ALLOWANCE);
      expect(result.entitlement.consumedGasAllowanceMist).toBe('0');
      expect(result.entitlement.status).toBe('active');
      expect(result.entitlement.activeReservationReceiptId).toBeNull();
    });

    it('rejects duplicate claim (same userId + promotionId)', async () => {
      await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      const result = await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('duplicate');
    });

    it('allows same user to claim different promotions', async () => {
      const r1 = await ledger.claim(PROMO_X, USER_A, defaultClaimOpts());
      const r2 = await ledger.claim(PROMO_Y, USER_A, defaultClaimOpts());
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
    });

    it('enforces capacity guard (maxParticipants)', async () => {
      const opts = defaultClaimOpts();
      await ledger.claim(CAPACITY_PROMO, USER_A, opts);
      await ledger.claim(CAPACITY_PROMO, USER_B, opts);
      const result = await ledger.claim(CAPACITY_PROMO, USER_C, opts);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('capacity_exceeded');
    });

    it('sets useUntilAt from opts when provided', async () => {
      const useUntil = '2026-12-31T23:59:59.000Z';
      const result = await ledger.claim(
        PROMO_ID,
        USER_A,
        defaultClaimOpts({ useUntilAt: useUntil }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.entitlement.useUntilAt).toBe(useUntil);
    });
  });

  // ── Reserve ────────────────────────────────

  describe('reserve', () => {
    beforeEach(async () => {
      await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
    });

    it('reserves budget + entitlement allowance', async () => {
      const result = await ledger.reserve(defaultReserveParams());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.entitlement.activeReservationReceiptId).toBe('receipt-1');
      expect(result.entitlement.activeReservationAmountMist).toBe(RESERVE_AMOUNT.toString());
      // Remaining should be reduced by reserved amount
      expect(BigInt(result.entitlement.remainingGasAllowanceMist)).toBe(
        BigInt(PER_USER_ALLOWANCE) - RESERVE_AMOUNT,
      );
    });

    it('returns the same reservation state for an exact same-receipt retry', async () => {
      const first = await ledger.reserve(defaultReserveParams());
      const budgetAfterFirst = await readBudget(ledger, PROMO_ID);
      const retry = await ledger.reserve(defaultReserveParams());
      const budgetAfterRetry = await readBudget(ledger, PROMO_ID);

      expect(retry).toEqual(first);
      expect(budgetAfterRetry).toEqual(budgetAfterFirst);
    });

    it('rejects a conflicting same-receipt retry without changing accounting', async () => {
      await ledger.reserve(defaultReserveParams());
      const budgetBeforeConflict = await readBudget(ledger, PROMO_ID);
      const conflict = await ledger.reserve(
        defaultReserveParams({ amountMist: RESERVE_AMOUNT - 1n }),
      );

      expect(conflict).toEqual({ ok: false, reason: 'record_changed' });
      await expect(readBudget(ledger, PROMO_ID)).resolves.toEqual(budgetBeforeConflict);
    });

    it('rejects a same-receipt retry bound to a different user without changing that user', async () => {
      await ledger.reserve(defaultReserveParams());
      const conflict = await ledger.reserve(defaultReserveParams({ userId: USER_B }));

      expect(conflict).toEqual({ ok: false, reason: 'record_changed' });
      await expect(ledger.getEntitlement(PROMO_ID, USER_B)).resolves.toBeNull();
    });

    it('rejects concurrent reservation (same user)', async () => {
      await ledger.reserve(defaultReserveParams({ receiptId: 'r-1' }));
      const r2 = await ledger.reserve(defaultReserveParams({ receiptId: 'r-2' }));
      expect(r2.ok).toBe(false);
      if (r2.ok) return;
      expect(r2.reason).toBe('concurrent_reservation');
    });

    it('rejects when entitlement not found', async () => {
      const result = await ledger.reserve(defaultReserveParams({ userId: 'nonexistent-user' }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('entitlement_not_found');
    });

    it('rejects non-positive reservation amounts', async () => {
      await expect(ledger.reserve(defaultReserveParams({ amountMist: 0n }))).rejects.toThrow(
        'amountMist must be greater than zero',
      );
      await expect(ledger.reserve(defaultReserveParams({ amountMist: -1n }))).rejects.toThrow(
        'amountMist must be greater than zero',
      );
    });

    it('rejects reservation amount > MAX_PROMOTION_LEDGER_VALUE_MIST (defensive ledger-boundary lock; mirrors the Promotion write cap)', async () => {
      // The Promotion write boundary normally caps `perUserGasAllowanceMist` at
      // the bound, so realistic reservations are well below it. This
      // conformance case exercises the defensive ledger-side guard so
      // any out-of-band caller that bypasses the store cannot push
      // Redis-Lua arithmetic above the 2^53−1 precision boundary.
      const overBound = MAX_PROMOTION_LEDGER_VALUE_MIST + 1n;
      await expect(ledger.reserve(defaultReserveParams({ amountMist: overBound }))).rejects.toThrow(
        /amountMist.*MAX_PROMOTION_LEDGER_VALUE_MIST/,
      );
    });

    it('rejects when entitlement has insufficient allowance', async () => {
      const tooMuch = BigInt(PER_USER_ALLOWANCE) + 1n;
      const result = await ledger.reserve(defaultReserveParams({ amountMist: tooMuch }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('entitlement_insufficient');
    });

    it('uses the shared transition order when entitlement and budget are both insufficient', async () => {
      await ledger.claim(EXHAUST_PROMO, USER_B, defaultClaimOpts());
      const before = await ledger.getPromotionLedgerStatus(EXHAUST_PROMO, USER_B);
      expect(before.entitlement?.remainingGasAllowanceMist).toBe('1000');
      expect(before.budget.availableMist).toBe(1000n);

      const result = await ledger.reserve({
        promotionId: EXHAUST_PROMO,
        userId: USER_B,
        receiptId: 'both-insufficient',
        amountMist: 1001n,
      });

      expect(result).toEqual({ ok: false, reason: 'entitlement_insufficient' });
    });

    it('deducts from budget available', async () => {
      await ledger.reserve(defaultReserveParams());
      const afterBudget = await readBudget(ledger, PROMO_ID);
      expect(afterBudget.reservedMist).toBe(RESERVE_AMOUNT);
      // Budget total = maxParticipants(10) * perUserAllowance(5M) = 50M
      // Available = total - reserved
      const expectedTotal = 10n * BigInt(PER_USER_ALLOWANCE);
      expect(afterBudget.availableMist).toBe(expectedTotal - RESERVE_AMOUNT);
    });
  });

  // ── Consume ────────────────────────────────

  describe('consume', () => {
    beforeEach(async () => {
      await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      await ledger.reserve(defaultReserveParams());
    });

    it('consumes with actual < reserved (delta release)', async () => {
      const actualGas = 500_000n; // half of RESERVE_AMOUNT
      const result = await ledger.consume('receipt-1', actualGas);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Reservation cleared
      expect(result.entitlement.activeReservationReceiptId).toBeNull();
      expect(result.entitlement.activeReservationAmountMist).toBeNull();

      // consumedGasAllowanceMist increased by actual
      expect(result.entitlement.consumedGasAllowanceMist).toBe(actualGas.toString());

      // remainingGasAllowanceMist: original - actual (not original - reserved)
      const expectedRemaining = BigInt(PER_USER_ALLOWANCE) - actualGas;
      expect(BigInt(result.entitlement.remainingGasAllowanceMist)).toBe(expectedRemaining);

      // Budget: delta (reserved - actual) returned to available
      const budget = await readBudget(ledger, PROMO_ID);
      expect(budget.consumedMist).toBe(actualGas);
      expect(budget.reservedMist).toBe(0n);
    });

    it('consumes with actual == reserved (no delta)', async () => {
      const result = await ledger.consume('receipt-1', RESERVE_AMOUNT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.entitlement.consumedGasAllowanceMist).toBe(RESERVE_AMOUNT.toString());
      expect(BigInt(result.entitlement.remainingGasAllowanceMist)).toBe(
        BigInt(PER_USER_ALLOWANCE) - RESERVE_AMOUNT,
      );

      const budget = await readBudget(ledger, PROMO_ID);
      expect(budget.consumedMist).toBe(RESERVE_AMOUNT);
      expect(budget.reservedMist).toBe(0n);
    });

    it('rejects negative actual gas on consume', async () => {
      await expect(ledger.consume('receipt-1', -1n)).rejects.toThrow(
        'actualGasMist must be non-negative',
      );
    });

    it('rejects actualGasMist > MAX_PROMOTION_LEDGER_VALUE_MIST on consume (defensive ledger-boundary lock; mirrors the reserve-side cap)', async () => {
      // Promotion sponsor-time `consume(receiptId, actualGasMist)` is
      // normally fed `computeExecutionCostClaim(...).simGas` (clamped to ≥ 0
      // and dominated by Sui-runtime gas ceilings far below the bound).
      // This conformance case exercises the defensive guard so any
      // out-of-band caller that hands the ledger an absurd `actualGasMist`
      // cannot push Redis-Lua DECRBY/INCRBY arithmetic above the
      // 2^53−1 precision boundary on the budget/entitlement counters.
      const overBound = MAX_PROMOTION_LEDGER_VALUE_MIST + 1n;
      await expect(ledger.consume('receipt-1', overBound)).rejects.toThrow(
        /actualGasMist.*MAX_PROMOTION_LEDGER_VALUE_MIST/,
      );
    });

    it('consumes with actual > reserved (overrun)', async () => {
      const overrunGas = RESERVE_AMOUNT + 200_000n;
      const result = await ledger.consume('receipt-1', overrunGas);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.entitlement.consumedGasAllowanceMist).toBe(overrunGas.toString());
      // Remaining is clamped: max(0, original - actual)
      const expectedRemaining = BigInt(PER_USER_ALLOWANCE) - overrunGas;
      expect(BigInt(result.entitlement.remainingGasAllowanceMist)).toBe(
        expectedRemaining > 0n ? expectedRemaining : 0n,
      );
    });

    it('accounts overrun as max(0, actual - reserved) without changing response meaning', async () => {
      const actualGas = RESERVE_AMOUNT + 200_000n;
      const result = await ledger.consume('receipt-1', actualGas);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const expectedTotal = 10n * BigInt(PER_USER_ALLOWANCE);
      const budget = await readBudget(ledger, PROMO_ID);
      expect(budget.availableMist).toBe(expectedTotal - actualGas);
      expect(budget.reservedMist).toBe(0n);
      expect(budget.consumedMist).toBe(actualGas);
      expect(result.entitlement.activeReservationReceiptId).toBeNull();
      expect(result.entitlement.consumedGasAllowanceMist).toBe(actualGas.toString());
    });

    it('clamps budget.available to 0 when overrun exceeds remaining budget', async () => {
      // Use a fresh promotion so the clamp scenario is isolated from the
      // suite-wide `beforeEach` reservation. Budget total = 1 * 2M = 2M.
      // After reserve(500k), avail = 1.5M. Consume 10.5M overrun by 10M:
      // the naïve accounting would drive budget.available to -8.5M. Both
      // memory and Redis implementations must floor the result at 0 so
      // admin summaries and later reserve()s never observe a negative
      // available budget.
      await ledger.claim(CLAMP_PROMO, USER_B, defaultClaimOpts());
      await ledger.reserve({
        promotionId: CLAMP_PROMO,
        userId: USER_B,
        receiptId: 'clamp-receipt',
        amountMist: 500_000n,
      });
      const result = await ledger.consume('clamp-receipt', 10_500_000n);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const budget = await readBudget(ledger, CLAMP_PROMO);
      expect(budget.availableMist).toBe(0n);
      expect(budget.reservedMist).toBe(0n);
      expect(budget.consumedMist).toBe(10_500_000n);
    });

    it('rejects consume for unknown receiptId', async () => {
      const result = await ledger.consume('nonexistent-receipt', 100n);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('reservation_not_found');
    });

    it('returns the stored result for an exact consume retry', async () => {
      const first = await ledger.consume('receipt-1', 500_000n);
      const result = await ledger.consume('receipt-1', 500_000n);
      expect(result).toEqual(first);
    });

    it('returns the stored consume snapshot after later entitlement changes', async () => {
      const first = await ledger.consume('receipt-1', 500_000n);
      await ledger.reserve(defaultReserveParams({ receiptId: 'receipt-2' }));
      await ledger.consume('receipt-2', 100_000n);
      await expect(ledger.consume('receipt-1', 500_000n)).resolves.toEqual(first);
    });

    it('rejects a conflicting consume retry', async () => {
      await ledger.consume('receipt-1', 500_000n);
      const result = await ledger.consume('receipt-1', 500_001n);
      expect(result).toEqual({ ok: false, reason: 'record_changed' });
    });

    // Post-signature/post-submit failure branches consume the full
    // reserved amount as a leak-free settlement. The reservation must
    // be terminalized so the ExecutionLedger reservation reaper does not
    // later release the same reservation, which would restore the allowance
    // and recreate the leak the consume policy was designed to prevent.
    if (sweepFactory) {
      it('consume(reservedGasMist) is terminal — reaper does not later sweep/release the reservation', async () => {
        const ledgerWithSweep = await sweepFactory!();
        await ledgerWithSweep.claim(PROMO_ID, USER_A, defaultClaimOpts());
        await ledgerWithSweep.reserve(defaultReserveParams());

        // Failure-path consume of the full reserved amount.
        const consumeResult = await ledgerWithSweep.consume('receipt-1', 1_000_000n);
        expect(consumeResult.ok).toBe(true);

        const swept = await ledgerWithSweep.sweepExpiredReservations();
        expect(swept).toBe(0);

        // Entitlement state confirms termination, not release: consumed
        // bucket advanced by the full reserved amount; no surplus restored
        // to remaining; activeReservation* cleared.
        const entAfter = await ledgerWithSweep.getEntitlement(PROMO_ID, USER_A);
        expect(entAfter!.activeReservationReceiptId).toBeNull();
        expect(entAfter!.consumedGasAllowanceMist).toBe('1000000');
        // Remaining = total - consumed (no release).
        expect(BigInt(entAfter!.remainingGasAllowanceMist)).toBe(
          BigInt(PER_USER_ALLOWANCE) - 1_000_000n,
        );
      });
    }

    it('marks entitlement as exhausted when remaining hits zero', async () => {
      // Claim with small allowance, reserve all, consume all
      await ledger.claim(EXHAUST_PROMO, USER_B, defaultClaimOpts());
      await ledger.reserve({
        promotionId: EXHAUST_PROMO,
        userId: USER_B,
        receiptId: 'receipt-exhaust',
        amountMist: 1000n,
      });
      const result = await ledger.consume('receipt-exhaust', 1000n);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.entitlement.status).toBe('exhausted');
      expect(result.entitlement.remainingGasAllowanceMist).toBe('0');
    });
  });

  // ── Release ────────────────────────────────

  describe('release', () => {
    beforeEach(async () => {
      await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      await ledger.reserve(defaultReserveParams());
    });

    it('fully restores budget and entitlement on release', async () => {
      const result = await ledger.release('receipt-1');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Reservation cleared
      expect(result.entitlement.activeReservationReceiptId).toBeNull();

      // Remaining fully restored
      expect(result.entitlement.remainingGasAllowanceMist).toBe(PER_USER_ALLOWANCE);

      // Budget fully restored
      const budget = await readBudget(ledger, PROMO_ID);
      expect(budget.reservedMist).toBe(0n);
    });

    it('rejects release for unknown receiptId', async () => {
      const result = await ledger.release('nonexistent-receipt');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('reservation_not_found');
    });

    it('returns the stored result for an exact release retry', async () => {
      const first = await ledger.release('receipt-1');
      const result = await ledger.release('receipt-1');
      expect(result).toEqual(first);
    });

    it('rejects a release after consume as a conflicting final operation', async () => {
      await ledger.consume('receipt-1', 500_000n);
      await expect(ledger.release('receipt-1')).resolves.toEqual({
        ok: false,
        reason: 'record_changed',
      });
    });

    it('allows new reservation after release', async () => {
      await ledger.release('receipt-1');
      const result = await ledger.reserve(defaultReserveParams({ receiptId: 'receipt-2' }));
      expect(result.ok).toBe(true);
    });
  });

  // ── Read models ────────────────────────────

  describe('read models', () => {
    it('getEntitlement returns null for unclaimed user', async () => {
      const ent = await ledger.getEntitlement(PROMO_ID, 'nobody');
      expect(ent).toBeNull();
    });

    it('getEntitlement returns null when accounting exists for a different user', async () => {
      await ledger.claim(PROMO_ID, USER_B, defaultClaimOpts());
      await expect(ledger.getEntitlement(PROMO_ID, USER_A)).resolves.toBeNull();
    });

    it('getEntitlement returns entitlement after claim', async () => {
      await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      const ent = await ledger.getEntitlement(PROMO_ID, USER_A);
      expect(ent).not.toBeNull();
      expect(ent!.userId).toBe(USER_A);
    });

    it('returns one aligned bounded Promotion list ledger status', async () => {
      await ledger.claim(PAGE_PROMO_A, USER_A, defaultClaimOpts());
      await ledger.claim(PAGE_PROMO_A, USER_B, defaultClaimOpts());
      await ledger.claim(PAGE_PROMO_B, USER_B, defaultClaimOpts());
      await ledger.reserve(defaultReserveParams({ promotionId: PAGE_PROMO_A, userId: USER_A }));

      const statuses = await ledger.getPromotionListLedgerStatuses(
        [PAGE_PROMO_B, PAGE_PROMO_A, PAGE_PROMO_MISSING],
        USER_A,
      );

      expect(statuses.map((status) => status.promotionId)).toEqual([
        PAGE_PROMO_B,
        PAGE_PROMO_A,
        PAGE_PROMO_MISSING,
      ]);
      expect(statuses[0]).toEqual({
        promotionId: PAGE_PROMO_B,
        entitlement: null,
        claimedCount: 1,
        availableBudgetMist: 50_000_000n,
      });
      expect(statuses[1]).toMatchObject({
        promotionId: PAGE_PROMO_A,
        claimedCount: 2,
        availableBudgetMist: 49_000_000n,
        entitlement: {
          promotionId: PAGE_PROMO_A,
          userId: USER_A,
          activeReservationReceiptId: 'receipt-1',
        },
      });
      expect(statuses[2]).toEqual({
        promotionId: PAGE_PROMO_MISSING,
        entitlement: null,
        claimedCount: 0,
        availableBudgetMist: 0n,
      });
    });

    it('rejects a Promotion list ledger batch above the contracts page bound', async () => {
      const ids = Array.from(
        { length: 101 },
        (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      );
      await expect(ledger.getPromotionListLedgerStatuses(ids, USER_A)).rejects.toThrow(
        /cannot exceed 100 IDs/,
      );
    });

    it('returns an empty aligned status for an empty Promotion page', async () => {
      await expect(ledger.getPromotionListLedgerStatuses([], USER_A)).resolves.toEqual([]);
    });

    it('keeps one coherent status through unclaimed, claimed, and reserved states', async () => {
      const unclaimed = await ledger.getPromotionLedgerStatus(PROMO_ID, USER_A);
      expect(unclaimed).toEqual({
        promotionId: PROMO_ID,
        entitlement: null,
        claimedCount: 0,
        budget: {
          availableMist: 0n,
          reservedMist: 0n,
          consumedMist: 0n,
        },
      });

      await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      const expectedTotal = 10n * BigInt(PER_USER_ALLOWANCE);
      const claimed = await ledger.getPromotionLedgerStatus(PROMO_ID, USER_A);
      expect(claimed).toEqual({
        promotionId: PROMO_ID,
        entitlement: expect.objectContaining({
          userId: USER_A,
          activeReservationReceiptId: null,
        }),
        claimedCount: 1,
        budget: {
          availableMist: expectedTotal,
          reservedMist: 0n,
          consumedMist: 0n,
        },
      });

      await ledger.claim(PROMO_ID, USER_B, defaultClaimOpts());
      await ledger.reserve(defaultReserveParams());
      const reserved = await ledger.getPromotionLedgerStatus(PROMO_ID, USER_A);
      expect(reserved).toEqual({
        promotionId: PROMO_ID,
        entitlement: expect.objectContaining({
          userId: USER_A,
          activeReservationReceiptId: 'receipt-1',
        }),
        claimedCount: 2,
        budget: {
          availableMist: expectedTotal - RESERVE_AMOUNT,
          reservedMist: RESERVE_AMOUNT,
          consumedMist: 0n,
        },
      });
    });

    // A `reserve()` call against a not-yet-claimed promotion returns
    // `entitlement_not_found` before any budget accounting state is
    // installed. Both adapters keep that failure path non-mutating.
    it('reserve-before-claim → claim → reserve succeeds', async () => {
      // Step 1: reserve before any claim. Must fail with
      // entitlement_not_found and must NOT mutate budget keys.
      const preReserve = await ledger.reserve(defaultReserveParams());
      expect(preReserve.ok).toBe(false);
      if (!preReserve.ok) {
        expect(preReserve.reason).toBe('entitlement_not_found');
      }

      // Step 2: budget summary must still report unclaimed-promotion
      // shape (reserve failure must be non-mutating).
      const midSummary = await readBudget(ledger, PROMO_ID);
      expect(midSummary.availableMist).toBe(0n);
      expect(midSummary.reservedMist).toBe(0n);
      expect(midSummary.consumedMist).toBe(0n);

      // Step 3: first claim must install the real total budget despite
      // the prior failed reserve.
      const claimResult = await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      expect(claimResult.ok).toBe(true);

      const expectedTotal = 10n * BigInt(PER_USER_ALLOWANCE);
      const postClaimSummary = await readBudget(ledger, PROMO_ID);
      expect(postClaimSummary.availableMist).toBe(expectedTotal);

      // Step 4: reserve now succeeds against the real budget total.
      const reserveResult = await ledger.reserve(defaultReserveParams());
      expect(reserveResult.ok).toBe(true);

      const postReserveSummary = await readBudget(ledger, PROMO_ID);
      expect(postReserveSummary.availableMist).toBe(expectedTotal - RESERVE_AMOUNT);
      expect(postReserveSummary.reservedMist).toBe(RESERVE_AMOUNT);
    });
  });

  // ── Reserve → Consume → Reserve cycle ─────

  describe('full lifecycle', () => {
    it('supports sequential reserve → consume → reserve cycles', async () => {
      await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());

      // Cycle 1
      await ledger.reserve(defaultReserveParams({ receiptId: 'r-1' }));
      await ledger.consume('r-1', 300_000n);

      // Cycle 2
      const r2 = await ledger.reserve(defaultReserveParams({ receiptId: 'r-2' }));
      expect(r2.ok).toBe(true);
      await ledger.consume('r-2', 200_000n);

      // Verify cumulative state
      const ent = await ledger.getEntitlement(PROMO_ID, USER_A);
      expect(ent).not.toBeNull();
      expect(ent!.consumedGasAllowanceMist).toBe('500000'); // 300k + 200k
      expect(BigInt(ent!.remainingGasAllowanceMist)).toBe(BigInt(PER_USER_ALLOWANCE) - 500_000n);

      const budget = await readBudget(ledger, PROMO_ID);
      expect(budget.consumedMist).toBe(500_000n);
      expect(budget.reservedMist).toBe(0n);
    });

    it('supports reserve → release → reserve cycle', async () => {
      await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());

      await ledger.reserve(defaultReserveParams({ receiptId: 'r-1' }));
      await ledger.release('r-1');

      // After release, full allowance restored, new reservation allowed
      const r2 = await ledger.reserve(defaultReserveParams({ receiptId: 'r-2' }));
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.entitlement.remainingGasAllowanceMist).toBe(
        (BigInt(PER_USER_ALLOWANCE) - RESERVE_AMOUNT).toString(),
      );
    });
  });

  // ── Sweep / Expiry ─────────────────────────

  if (sweepFactory) {
    describe('sweepExpiredReservations', () => {
      let sweepLedger: PromotionExecutionLedger;

      beforeEach(async () => {
        sweepLedger = await sweepFactory!();
      });

      it('sweeps expired reservation and fully restores budget + entitlement', async () => {
        // Setup: claim + reserve with TTL=0 ledger (reservation already expired)
        await sweepLedger.claim(PROMO_ID, USER_A, defaultClaimOpts());
        await sweepLedger.reserve(defaultReserveParams());

        // Verify reservation is active before sweep
        const entBefore = await sweepLedger.getEntitlement(PROMO_ID, USER_A);
        expect(entBefore!.activeReservationReceiptId).toBe('receipt-1');

        const swept = await sweepLedger.sweepExpiredReservations();
        expect(swept).toBe(1);

        // Entitlement fully restored
        const entAfter = await sweepLedger.getEntitlement(PROMO_ID, USER_A);
        expect(entAfter!.activeReservationReceiptId).toBeNull();
        expect(entAfter!.remainingGasAllowanceMist).toBe(PER_USER_ALLOWANCE);

        // Budget fully restored
        const budget = await readBudget(sweepLedger, PROMO_ID);
        expect(budget.reservedMist).toBe(0n);
        const expectedTotal = 10n * BigInt(PER_USER_ALLOWANCE);
        expect(budget.availableMist).toBe(expectedTotal);
      });

      it('shares one in-flight sweep result across overlapping callers', async () => {
        await sweepLedger.claim(PROMO_ID, USER_A, defaultClaimOpts());
        await sweepLedger.reserve(defaultReserveParams());

        await expect(
          Promise.all([
            sweepLedger.sweepExpiredReservations(),
            sweepLedger.sweepExpiredReservations(),
          ]),
        ).resolves.toEqual([1, 1]);
      });

      it('does not sweep non-expired reservations', async () => {
        // This test uses the normal factory (non-zero TTL)
        await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
        await ledger.reserve(defaultReserveParams());

        const swept = await ledger.sweepExpiredReservations();
        expect(swept).toBe(0);

        // Reservation still active
        const ent = await ledger.getEntitlement(PROMO_ID, USER_A);
        expect(ent!.activeReservationReceiptId).toBe('receipt-1');
      });

      it('allows new reservation after sweep clears expired one', async () => {
        await sweepLedger.claim(PROMO_ID, USER_A, defaultClaimOpts());
        await sweepLedger.reserve(defaultReserveParams({ receiptId: 'r-old' }));

        await sweepLedger.sweepExpiredReservations();

        // New reservation should succeed
        const r2 = await sweepLedger.reserve(defaultReserveParams({ receiptId: 'r-new' }));
        expect(r2.ok).toBe(true);
      });
    });
  }
}
