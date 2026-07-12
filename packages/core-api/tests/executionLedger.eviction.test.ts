/**
 * ExecutionLedger ↔ PrepareStore eviction cleanup coverage.
 *
 * Verifies the critical lifecycle contract:
 *   prepare reserve → prepare-store evicts entry (TTL or IP overflow)
 *                   → eviction callback calls executionLedger.release()
 *                   → budget + entitlement are fully restored
 *
 * Matches the production wiring in app-api/src/context.ts where
 * RedisPrepareStore's onEntryEvict → executionLedger.release().
 */
import { describe, it, expect } from 'vitest';
import { MemoryPromotionExecutionLedger } from '../src/studio/executionLedgerMemory.js';
import { MemoryPrepareStore } from '../src/store/memoryPrepareStore.js';
import type { PreparedTxEntry, PromotionPreparedTxEntry } from '../src/store/prepareTypes.js';

const PROMO_ID = 'evict-promo-1';
const USER_ID = 'evict-user-1';
const PER_USER_ALLOWANCE = '5000000'; // 5M MIST
const RESERVE_AMOUNT = 1_000_000n; // 1M MIST

function makePromotionEntry(
  overrides: Partial<PromotionPreparedTxEntry> = {},
): PromotionPreparedTxEntry {
  return {
    mode: 'promotion',
    issuedAt: Date.now(),
    receiptId: 'receipt-evict-1',
    senderAddress: '0x' + '1'.repeat(64),
    txBytesHash: 'a'.repeat(64),
    sponsorAddress: '0x' + '2'.repeat(64),
    clientIp: '127.0.0.1',
    executionPathKey: `promotion:${PROMO_ID}`,
    orderId: null,
    nonce: 0n,
    promotionId: PROMO_ID,
    userId: USER_ID,
    reservedGasMist: RESERVE_AMOUNT,
    ...overrides,
  };
}

describe('ExecutionLedger + PrepareStore eviction cleanup', () => {
  it('TTL eviction triggers executionLedger.release() and restores budget + allowance', async () => {
    const ledger = new MemoryPromotionExecutionLedger();

    // Setup: claim + reserve
    await ledger.claim(PROMO_ID, USER_ID, {
      maxParticipants: 10,
      perUserGasAllowanceMist: PER_USER_ALLOWANCE,
      useUntilAt: null,
    });
    const reserve = await ledger.reserve({
      promotionId: PROMO_ID,
      userId: USER_ID,
      receiptId: 'receipt-evict-1',
      amountMist: RESERVE_AMOUNT,
    });
    expect(reserve.ok).toBe(true);

    // Verify reserve state
    const entBefore = await ledger.getEntitlement(PROMO_ID, USER_ID);
    expect(entBefore!.activeReservationReceiptId).toBe('receipt-evict-1');
    const budgetBefore = await ledger.getBudgetSummary(PROMO_ID);
    expect(budgetBefore.reservedMist).toBe(RESERVE_AMOUNT);

    // Build prepare-store with eviction callback wired to ledger.release()
    // (mirrors production app-api/context.ts wiring)
    const prepareStore = new MemoryPrepareStore(
      async () => {}, // no-op slot release for test
      50, // short TTL to trigger eviction fast
      100,
      100,
      10, // short evict interval
      (entry: PreparedTxEntry) => {
        if (entry.mode === 'promotion') {
          void ledger.release(entry.receiptId);
        }
      },
    );

    const entry = makePromotionEntry();
    await prepareStore.store(entry.receiptId, entry);

    // Wait for TTL eviction to fire (TTL=50ms, evict interval=10ms)
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Budget + entitlement must be fully restored
    const entAfter = await ledger.getEntitlement(PROMO_ID, USER_ID);
    expect(entAfter!.activeReservationReceiptId).toBeNull();
    expect(entAfter!.remainingGasAllowanceMist).toBe(PER_USER_ALLOWANCE);

    const budgetAfter = await ledger.getBudgetSummary(PROMO_ID);
    expect(budgetAfter.reservedMist).toBe(0n);

    prepareStore.dispose();
  });

  it('IP overflow eviction triggers executionLedger.release() for evicted entry', async () => {
    const ledger = new MemoryPromotionExecutionLedger();

    // Claim + reserve two different entries
    await ledger.claim(PROMO_ID, USER_ID, {
      maxParticipants: 10,
      perUserGasAllowanceMist: PER_USER_ALLOWANCE,
      useUntilAt: null,
    });

    // First reserve + consume to free concurrent_reservation slot
    await ledger.reserve({
      promotionId: PROMO_ID,
      userId: USER_ID,
      receiptId: 'r-old',
      amountMist: RESERVE_AMOUNT,
    });

    // Build prepare-store with maxPerIp=1 so 2nd store() evicts the 1st
    const prepareStore = new MemoryPrepareStore(
      async () => {},
      60_000, // long TTL, we're testing overflow not TTL
      1, // maxPerIp=1
      100,
      999_999_999, // effectively disable background timer
      (entry: PreparedTxEntry) => {
        if (entry.mode === 'promotion') {
          void ledger.release(entry.receiptId);
        }
      },
    );

    // Store first promotion entry
    await prepareStore.store('r-old', makePromotionEntry({ receiptId: 'r-old' }));

    // Release r-old first (so 2nd reserve is not blocked by concurrent_reservation)
    // Actually, we want r-old to remain reserved but be evicted by IP overflow.
    // That means we need a different user to reserve the 2nd receipt, or
    // we accept that the IP overflow test focuses on the eviction → release chain only.

    // Store second entry for same IP → first is evicted
    const entry2 = makePromotionEntry({
      receiptId: 'r-new',
      senderAddress: '0x' + '9'.repeat(64),
    });
    await prepareStore.store('r-new', entry2);

    // Give microtask queue a chance to run the eviction callback
    await new Promise((resolve) => setTimeout(resolve, 20));

    // r-old reservation must be released via eviction callback
    const ent = await ledger.getEntitlement(PROMO_ID, USER_ID);
    expect(ent!.activeReservationReceiptId).toBeNull();
    expect(ent!.remainingGasAllowanceMist).toBe(PER_USER_ALLOWANCE);

    prepareStore.dispose();
  });
});
