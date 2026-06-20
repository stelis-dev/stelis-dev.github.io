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
import type { PromotionExecutionLedger } from '../src/studio/executionLedger.js';
import type { ClaimOpts, ReserveParams } from '../src/studio/domain.js';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const PROMO_ID = 'test-promo-1';
const USER_A = 'user-a';
const USER_B = 'user-b';
const USER_C = 'user-c';
const PER_USER_ALLOWANCE = '5000000'; // 5M MIST
const RESERVE_AMOUNT = 1_000_000n; // 1M MIST

function defaultClaimOpts(overrides?: Partial<ClaimOpts>): ClaimOpts {
  return {
    maxParticipants: 10,
    perUserGasAllowanceMist: PER_USER_ALLOWANCE,
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
      const r1 = await ledger.claim('promo-x', USER_A, defaultClaimOpts());
      const r2 = await ledger.claim('promo-y', USER_A, defaultClaimOpts());
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
    });

    it('enforces capacity guard (maxParticipants)', async () => {
      const opts = defaultClaimOpts({ maxParticipants: 2 });
      await ledger.claim(PROMO_ID, USER_A, opts);
      await ledger.claim(PROMO_ID, USER_B, opts);
      const result = await ledger.claim(PROMO_ID, USER_C, opts);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('capacity_exceeded');
    });

    it('allows unlimited claims when maxParticipants = 0', async () => {
      const opts = defaultClaimOpts({ maxParticipants: 0 });
      const r1 = await ledger.claim(PROMO_ID, USER_A, opts);
      const r2 = await ledger.claim(PROMO_ID, USER_B, opts);
      const r3 = await ledger.claim(PROMO_ID, USER_C, opts);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(true);
    });

    it('rejects non-safe participant counts and non-decimal allowance strings', async () => {
      await expect(
        ledger.claim(
          PROMO_ID,
          USER_A,
          defaultClaimOpts({ maxParticipants: Number.MAX_SAFE_INTEGER + 1 }),
        ),
      ).rejects.toThrow('maxParticipants must be a non-negative safe integer');

      await expect(
        ledger.claim(PROMO_ID, USER_A, defaultClaimOpts({ perUserGasAllowanceMist: '1e6' })),
      ).rejects.toThrow('perUserGasAllowanceMist must be a non-negative decimal integer string');
    });

    it('rejects perUserGasAllowanceMist > MAX_PROMOTION_LEDGER_VALUE_MIST (Number.MAX_SAFE_INTEGER)', async () => {
      // Defensive bound parity with the activation gate. Any out-of-band
      // caller that bypasses `validateActivationPrerequisites` and tries
      // to claim a promotion with an over-bound `perUserGasAllowanceMist`
      // must be refused at the ledger layer so the Redis budget keys
      // never receive a value that breaks Lua int64 arithmetic.
      const overBound = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
      await expect(
        ledger.claim(PROMO_ID, USER_A, defaultClaimOpts({ perUserGasAllowanceMist: overBound })),
      ).rejects.toThrow(
        /perUserGasAllowanceMist.*MAX_PROMOTION_LEDGER_VALUE_MIST|MAX_PROMOTION_LEDGER_VALUE_MIST.*perUserGasAllowanceMist/,
      );
    });

    it('rejects maxParticipants × perUserGasAllowanceMist > MAX_PROMOTION_LEDGER_VALUE_MIST', async () => {
      // Per-user fits the bound, but the product overflows it. Both
      // adapters must refuse so a bypass cannot poison the budget
      // counters. 1_000_000 × 9_007_199_254_740 ≈ 9.0 × 10^18 >
      // Number.MAX_SAFE_INTEGER (≈ 9.007 × 10^15).
      await expect(
        ledger.claim(
          PROMO_ID,
          USER_A,
          defaultClaimOpts({
            maxParticipants: 1_000_000,
            perUserGasAllowanceMist: '9007199254740',
          }),
        ),
      ).rejects.toThrow(/total budget.*MAX_PROMOTION_LEDGER_VALUE_MIST/);
    });

    it('sets useUntilAt from opts when provided', async () => {
      const useUntil = '2026-12-31T23:59:59Z';
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

    it('rejects reservation amount > MAX_PROMOTION_LEDGER_VALUE_MIST (defensive ledger-boundary lock; mirrors the activation-gate cap)', async () => {
      // The activation gate normally caps `perUserGasAllowanceMist` at
      // the bound, so realistic reservations are well below it. This
      // conformance case exercises the defensive ledger-side guard so
      // any out-of-band caller that bypasses activation cannot push
      // Redis-Lua arithmetic above the 2^53−1 precision boundary.
      const overBound = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
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

    it('deducts from budget available', async () => {
      await ledger.reserve(defaultReserveParams());
      const afterBudget = await ledger.getBudgetSummary(PROMO_ID);
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
      const budget = await ledger.getBudgetSummary(PROMO_ID);
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

      const budget = await ledger.getBudgetSummary(PROMO_ID);
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
      const overBound = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
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
      const budget = await ledger.getBudgetSummary(PROMO_ID);
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
      await ledger.claim(
        'clamp-promo',
        USER_B,
        defaultClaimOpts({
          maxParticipants: 1,
          perUserGasAllowanceMist: '2000000',
        }),
      );
      await ledger.reserve({
        promotionId: 'clamp-promo',
        userId: USER_B,
        receiptId: 'clamp-receipt',
        amountMist: 500_000n,
      });
      const result = await ledger.consume('clamp-receipt', 10_500_000n);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const budget = await ledger.getBudgetSummary('clamp-promo');
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

    it('prevents double consume (same receiptId)', async () => {
      await ledger.consume('receipt-1', 500_000n);
      const result = await ledger.consume('receipt-1', 500_000n);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('reservation_not_found');
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

        // Allow the TTL=0 expiry window to pass (matches the sweep test
        // pattern below). After the wait the reservation is no longer
        // tracked; sweep must report 0 swept.
        await new Promise((resolve) => setTimeout(resolve, 5));
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
      await ledger.claim(
        'promo-exhaust',
        USER_B,
        defaultClaimOpts({
          perUserGasAllowanceMist: '1000',
        }),
      );
      await ledger.reserve({
        promotionId: 'promo-exhaust',
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
      const budget = await ledger.getBudgetSummary(PROMO_ID);
      expect(budget.reservedMist).toBe(0n);
    });

    it('rejects release for unknown receiptId', async () => {
      const result = await ledger.release('nonexistent-receipt');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('reservation_not_found');
    });

    it('prevents double release', async () => {
      await ledger.release('receipt-1');
      const result = await ledger.release('receipt-1');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('reservation_not_found');
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

    it('getEntitlement returns entitlement after claim', async () => {
      await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      const ent = await ledger.getEntitlement(PROMO_ID, USER_A);
      expect(ent).not.toBeNull();
      expect(ent!.userId).toBe(USER_A);
    });

    it('getClaimedCount reflects claims', async () => {
      expect(await ledger.getClaimedCount(PROMO_ID)).toBe(0);
      await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      expect(await ledger.getClaimedCount(PROMO_ID)).toBe(1);
      await ledger.claim(PROMO_ID, USER_B, defaultClaimOpts());
      expect(await ledger.getClaimedCount(PROMO_ID)).toBe(2);
    });

    it('getBudgetSummary returns zero-init for unclaimed promotion', async () => {
      const summary = await ledger.getBudgetSummary('promo-empty');
      expect(summary.availableMist).toBe(0n);
      expect(summary.reservedMist).toBe(0n);
      expect(summary.consumedMist).toBe(0n);
    });

    it('getBudgetSummary returns total budget after claim, before first reserve', async () => {
      await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      const summary = await ledger.getBudgetSummary(PROMO_ID);
      // total = maxParticipants(10) * perUserAllowance(5M) = 50M
      const expectedTotal = 10n * BigInt(PER_USER_ALLOWANCE);
      expect(summary.availableMist).toBe(expectedTotal);
      expect(summary.reservedMist).toBe(0n);
      expect(summary.consumedMist).toBe(0n);
    });

    // Budget summaries before claim are pure reads. They must not create
    // durable budget accounting state that can affect the first claim or
    // the first successful reserve.
    it('summary-before-claim → claim → reserve succeeds', async () => {
      // Step 1: summary read against an unclaimed promotion. Must be
      // pure read — no permanent budget snapshot.
      const preSummary = await ledger.getBudgetSummary(PROMO_ID);
      expect(preSummary.availableMist).toBe(0n);
      expect(preSummary.reservedMist).toBe(0n);
      expect(preSummary.consumedMist).toBe(0n);

      // Step 2: first claim must install the real total budget.
      const claimResult = await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      expect(claimResult.ok).toBe(true);

      const expectedTotal = 10n * BigInt(PER_USER_ALLOWANCE);
      const postClaimSummary = await ledger.getBudgetSummary(PROMO_ID);
      expect(postClaimSummary.availableMist).toBe(expectedTotal);

      // Step 3: reserve must decrement the real total.
      const reserveResult = await ledger.reserve(defaultReserveParams());
      expect(reserveResult.ok).toBe(true);

      const postReserveSummary = await ledger.getBudgetSummary(PROMO_ID);
      expect(postReserveSummary.availableMist).toBe(expectedTotal - RESERVE_AMOUNT);
      expect(postReserveSummary.reservedMist).toBe(RESERVE_AMOUNT);
    });

    // Repeated read-only summary calls before any claim must not
    // accumulate side-effects.
    it('repeated summary-before-claim reads are pure', async () => {
      for (let i = 0; i < 3; i++) {
        const summary = await ledger.getBudgetSummary(PROMO_ID);
        expect(summary.availableMist).toBe(0n);
      }
      const claimResult = await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      expect(claimResult.ok).toBe(true);

      const expectedTotal = 10n * BigInt(PER_USER_ALLOWANCE);
      const postClaimSummary = await ledger.getBudgetSummary(PROMO_ID);
      expect(postClaimSummary.availableMist).toBe(expectedTotal);
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
      const midSummary = await ledger.getBudgetSummary(PROMO_ID);
      expect(midSummary.availableMist).toBe(0n);
      expect(midSummary.reservedMist).toBe(0n);
      expect(midSummary.consumedMist).toBe(0n);

      // Step 3: first claim must install the real total budget despite
      // the prior failed reserve.
      const claimResult = await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      expect(claimResult.ok).toBe(true);

      const expectedTotal = 10n * BigInt(PER_USER_ALLOWANCE);
      const postClaimSummary = await ledger.getBudgetSummary(PROMO_ID);
      expect(postClaimSummary.availableMist).toBe(expectedTotal);

      // Step 4: reserve now succeeds against the real budget total.
      const reserveResult = await ledger.reserve(defaultReserveParams());
      expect(reserveResult.ok).toBe(true);

      const postReserveSummary = await ledger.getBudgetSummary(PROMO_ID);
      expect(postReserveSummary.availableMist).toBe(expectedTotal - RESERVE_AMOUNT);
      expect(postReserveSummary.reservedMist).toBe(RESERVE_AMOUNT);
    });

    it('listClaimedUsers returns enriched projection', async () => {
      await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      await ledger.claim(PROMO_ID, USER_B, defaultClaimOpts());
      const users = await ledger.listClaimedUsers(PROMO_ID);
      expect(users).toHaveLength(2);
      const userA = users.find((u) => u.userId === USER_A);
      expect(userA).toBeDefined();
      expect(userA!.remainingGasAllowanceMist).toBe(PER_USER_ALLOWANCE);
      expect(userA!.status).toBe('active');
    });

    it('listClaimedUsers reflects reservation state', async () => {
      await ledger.claim(PROMO_ID, USER_A, defaultClaimOpts());
      await ledger.reserve(defaultReserveParams());
      const users = await ledger.listClaimedUsers(PROMO_ID);
      const userA = users.find((u) => u.userId === USER_A);
      expect(userA!.activeReservationReceiptId).toBe('receipt-1');
    });

    it('listClaimedUsers returns empty for unclaimed promotion', async () => {
      const users = await ledger.listClaimedUsers('promo-none');
      expect(users).toHaveLength(0);
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

      const budget = await ledger.getBudgetSummary(PROMO_ID);
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

        // Allow TTL to expire (TTL=0 → already expired at creation)
        // Small yield to ensure Date.now() advances past expiresAt
        await new Promise((resolve) => setTimeout(resolve, 5));

        const swept = await sweepLedger.sweepExpiredReservations();
        expect(swept).toBe(1);

        // Entitlement fully restored
        const entAfter = await sweepLedger.getEntitlement(PROMO_ID, USER_A);
        expect(entAfter!.activeReservationReceiptId).toBeNull();
        expect(entAfter!.remainingGasAllowanceMist).toBe(PER_USER_ALLOWANCE);

        // Budget fully restored
        const budget = await sweepLedger.getBudgetSummary(PROMO_ID);
        expect(budget.reservedMist).toBe(0n);
        const expectedTotal = 10n * BigInt(PER_USER_ALLOWANCE);
        expect(budget.availableMist).toBe(expectedTotal);
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

        await new Promise((resolve) => setTimeout(resolve, 5));
        await sweepLedger.sweepExpiredReservations();

        // New reservation should succeed
        const r2 = await sweepLedger.reserve(defaultReserveParams({ receiptId: 'r-new' }));
        expect(r2.ok).toBe(true);
      });
    });
  }
}
