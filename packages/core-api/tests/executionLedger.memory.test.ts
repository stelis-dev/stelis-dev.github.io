/**
 * MemoryPromotionExecutionLedger — conformance tests.
 *
 * Runs the shared conformance suite against the in-memory implementation.
 */

import { describe, it, expect } from 'vitest';
import { MAX_PROMOTION_LEDGER_VALUE_MIST } from '@stelis/contracts';
import {
  PROMOTION_EXECUTION_LEDGER_DEFAULT_REAPER_INTERVAL_MS,
  PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS,
} from '../src/studio/executionLedger.js';
import { MemoryPromotionExecutionLedger } from '../src/studio/executionLedgerMemory.js';
import { promotionEntitlementKey } from '../src/studio/promotionRecords.js';
import { runLedgerConformanceTests } from './executionLedger.conformance.js';
import { createMemoryPromotionLedgerStore, PROMO_ID } from './helpers/promotionLedgerFixture.js';
import type {
  PromotionAccountingRecord,
  PromotionEntitlementRecord,
  PromotionOperationResultRecord,
  PromotionReservationRecord,
} from '../src/studio/promotionRecords.js';

describe('MemoryPromotionExecutionLedger', () => {
  runLedgerConformanceTests(
    // Normal factory: default TTL (60s)
    async () => new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore()),
    // Sweep factory: TTL=0 so reservations expire immediately
    async () => new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore(), 0),
  );

  it.each(['paused', 'archived'] as const)(
    'returns an exact existing reservation after the Promotion becomes %s',
    async (status) => {
      const store = await createMemoryPromotionLedgerStore();
      const ledger = new MemoryPromotionExecutionLedger(store);
      await ledger.claim(PROMO_ID, 'lifecycle-retry-user', { useUntilAt: null });
      const params = {
        promotionId: PROMO_ID,
        userId: 'lifecycle-retry-user',
        receiptId: `lifecycle-retry-${status}`,
        amountMist: 100n,
      };
      const first = await ledger.reserve(params);
      const budgetBeforeRetry = await ledger.getPromotionLedgerStatus(PROMO_ID, null);
      await store.transitionStatus(PROMO_ID, status, 'lifecycle changed');

      await expect(ledger.reserve(params)).resolves.toEqual(first);
      await expect(ledger.getPromotionLedgerStatus(PROMO_ID, null)).resolves.toEqual(
        budgetBeforeRetry,
      );
    },
  );

  it('rejects an exact reserve retry when the reservation binding is corrupt', async () => {
    const store = await createMemoryPromotionLedgerStore();
    const ledger = new MemoryPromotionExecutionLedger(store);
    await ledger.claim(PROMO_ID, 'binding-user', { useUntilAt: null });
    await ledger.reserve({
      promotionId: PROMO_ID,
      userId: 'binding-user',
      receiptId: 'binding-receipt',
      amountMist: 100n,
    });

    const state = ledger as unknown as {
      entitlements: Map<string, PromotionEntitlementRecord>;
    };
    const key = promotionEntitlementKey(PROMO_ID, 'binding-user');
    const entitlement = state.entitlements.get(key);
    expect(entitlement).toBeDefined();
    state.entitlements.set(key, {
      ...entitlement!,
      activeReservationAmountMist: '99',
    });
    await store.transitionStatus(PROMO_ID, 'paused', 'test corruption precedence');

    await expect(
      ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'binding-user',
        receiptId: 'binding-receipt',
        amountMist: 100n,
      }),
    ).rejects.toThrow('does not match its accounting and entitlement state');
  });

  it('rejects a duplicate claim when its accounting record is missing', async () => {
    const ledger = new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore());
    await ledger.claim(PROMO_ID, 'partial-user', { useUntilAt: null });

    const state = ledger as unknown as {
      accounting: Map<string, PromotionAccountingRecord>;
    };
    state.accounting.delete(PROMO_ID);

    await expect(ledger.claim(PROMO_ID, 'partial-user', { useUntilAt: null })).rejects.toThrow(
      'entitlement exists without accounting',
    );
  });

  it('rejects entitlement and list reads when entitlement exists without accounting', async () => {
    const ledger = new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore());
    await ledger.claim(PROMO_ID, 'read-partial-user', { useUntilAt: null });

    const state = ledger as unknown as {
      accounting: Map<string, PromotionAccountingRecord>;
    };
    state.accounting.delete(PROMO_ID);

    await expect(ledger.getEntitlement(PROMO_ID, 'read-partial-user')).rejects.toThrow(
      'entitlement exists without accounting',
    );
    await expect(ledger.getPromotionLedgerStatus(PROMO_ID, 'read-partial-user')).rejects.toThrow(
      'entitlement exists without accounting',
    );
    await expect(
      ledger.getPromotionListLedgerStatuses([PROMO_ID], 'read-partial-user'),
    ).rejects.toThrow('entitlement exists without accounting');
  });

  it('rejects entitlement and list reads when accounting contradicts Promotion economics', async () => {
    const ledger = new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore());
    await ledger.claim(PROMO_ID, 'read-economics-user', { useUntilAt: null });

    const state = ledger as unknown as {
      accounting: Map<string, PromotionAccountingRecord>;
    };
    const accounting = state.accounting.get(PROMO_ID);
    expect(accounting).toBeDefined();
    state.accounting.set(PROMO_ID, {
      ...accounting!,
      maxParticipants: accounting!.maxParticipants - 1,
      totalBudgetMist: (
        BigInt(accounting!.totalBudgetMist) - BigInt(accounting!.perUserGasAllowanceMist)
      ).toString(),
      availableMist: (
        BigInt(accounting!.availableMist) - BigInt(accounting!.perUserGasAllowanceMist)
      ).toString(),
    });

    await expect(ledger.getEntitlement(PROMO_ID, 'read-economics-user')).rejects.toThrow(
      'does not match the current Promotion economics',
    );
    await expect(ledger.getPromotionLedgerStatus(PROMO_ID, null)).rejects.toThrow(
      'does not match the current Promotion economics',
    );
    await expect(
      ledger.getPromotionListLedgerStatuses([PROMO_ID], 'read-economics-user'),
    ).rejects.toThrow('does not match the current Promotion economics');
  });

  it('rejects a duplicate claim when claimedCount contradicts its entitlement', async () => {
    const ledger = new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore());
    await ledger.claim(PROMO_ID, 'count-user', { useUntilAt: null });

    const state = ledger as unknown as {
      accounting: Map<string, PromotionAccountingRecord>;
    };
    const accounting = state.accounting.get(PROMO_ID);
    expect(accounting).toBeDefined();
    state.accounting.set(PROMO_ID, { ...accounting!, claimedCount: 0 });

    await expect(ledger.claim(PROMO_ID, 'count-user', { useUntilAt: null })).rejects.toThrow(
      'Persisted Promotion accounting claimedCount must be positive',
    );
  });

  it('rejects a new claim when persisted accounting has zero claims and no entitlement', async () => {
    const ledger = new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore());
    await ledger.claim(PROMO_ID, 'removed-claim-user', { useUntilAt: null });

    const state = ledger as unknown as {
      accounting: Map<string, PromotionAccountingRecord>;
      entitlements: Map<string, PromotionEntitlementRecord>;
    };
    state.entitlements.delete(promotionEntitlementKey(PROMO_ID, 'removed-claim-user'));
    const accounting = state.accounting.get(PROMO_ID);
    expect(accounting).toBeDefined();
    state.accounting.set(PROMO_ID, { ...accounting!, claimedCount: 0 });

    await expect(ledger.claim(PROMO_ID, 'next-user', { useUntilAt: null })).rejects.toThrow(
      'Persisted Promotion accounting claimedCount must be positive',
    );
  });

  it('rejects reserve before reporting entitlement absence when persisted accounting is corrupt', async () => {
    const ledger = new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore());
    await ledger.claim(PROMO_ID, 'removed-reserve-user', { useUntilAt: null });

    const state = ledger as unknown as {
      accounting: Map<string, PromotionAccountingRecord>;
      entitlements: Map<string, PromotionEntitlementRecord>;
    };
    state.entitlements.delete(promotionEntitlementKey(PROMO_ID, 'removed-reserve-user'));
    const accounting = state.accounting.get(PROMO_ID);
    expect(accounting).toBeDefined();
    state.accounting.set(PROMO_ID, { ...accounting!, claimedCount: 0 });

    await expect(
      ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'unclaimed-user',
        receiptId: 'corrupt-accounting-reserve',
        amountMist: 1n,
      }),
    ).rejects.toThrow('Persisted Promotion accounting claimedCount must be positive');
  });

  it('rejects an exact reserve retry when accounting no longer holds the reserved MIST', async () => {
    const ledger = new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore());
    await ledger.claim(PROMO_ID, 'reserved-user', { useUntilAt: null });
    await ledger.reserve({
      promotionId: PROMO_ID,
      userId: 'reserved-user',
      receiptId: 'reserved-receipt',
      amountMist: 100n,
    });

    const state = ledger as unknown as {
      accounting: Map<string, PromotionAccountingRecord>;
    };
    const accounting = state.accounting.get(PROMO_ID);
    expect(accounting).toBeDefined();
    state.accounting.set(PROMO_ID, { ...accounting!, reservedMist: '0' });

    await expect(
      ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'reserved-user',
        receiptId: 'reserved-receipt',
        amountMist: 100n,
      }),
    ).rejects.toThrow('reservation exceeds accounting reserved MIST');
  });

  it('rejects a reservation whose embedded receipt does not match its map key', async () => {
    const ledger = new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore());
    await ledger.claim(PROMO_ID, 'identity-user', { useUntilAt: null });
    await ledger.reserve({
      promotionId: PROMO_ID,
      userId: 'identity-user',
      receiptId: 'identity-receipt',
      amountMist: 100n,
    });

    const state = ledger as unknown as {
      reservations: Map<string, PromotionReservationRecord>;
    };
    const reservation = state.reservations.get('identity-receipt');
    expect(reservation).toBeDefined();
    state.reservations.set('identity-receipt', {
      ...reservation!,
      receiptId: 'different-receipt',
    });

    await expect(ledger.consume('identity-receipt', 50n)).rejects.toThrow(
      'does not match its storage key',
    );
  });

  it.each(['consume', 'release'] as const)(
    'rejects %s when persisted ledger state has lost its Promotion record',
    async (operation) => {
      const store = await createMemoryPromotionLedgerStore();
      const ledger = new MemoryPromotionExecutionLedger(store);
      await ledger.claim(PROMO_ID, 'missing-promotion-user', { useUntilAt: null });
      await ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'missing-promotion-user',
        receiptId: `missing-promotion-${operation}`,
        amountMist: 100n,
      });

      const records = Reflect.get(store, '_records') as Map<string, unknown>;
      records.delete(PROMO_ID);

      const result =
        operation === 'consume'
          ? ledger.consume(`missing-promotion-${operation}`, 50n)
          : ledger.release(`missing-promotion-${operation}`);
      await expect(result).rejects.toThrow(
        'Promotion accounting exists without its Promotion record',
      );
    },
  );

  it('rejects a consume that would exceed the cumulative accounting integer bound', async () => {
    const ledger = new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore());
    await ledger.claim(PROMO_ID, 'bound-user', { useUntilAt: null });
    await ledger.reserve({
      promotionId: PROMO_ID,
      userId: 'bound-user',
      receiptId: 'bound-receipt',
      amountMist: 1n,
    });

    const state = ledger as unknown as {
      accounting: Map<string, PromotionAccountingRecord>;
    };
    const accounting = state.accounting.get(PROMO_ID);
    expect(accounting).toBeDefined();
    state.accounting.set(PROMO_ID, {
      ...accounting!,
      consumedMist: MAX_PROMOTION_LEDGER_VALUE_MIST.toString(),
    });

    await expect(ledger.consume('bound-receipt', 1n)).rejects.toThrow(
      'cumulative accounting consumedMist',
    );
  });

  it('does not leave accounting when claim input fails before entitlement creation', async () => {
    const ledger = new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore());

    await expect(
      ledger.claim(PROMO_ID, 'invalid-claim-user', { useUntilAt: 'not-an-iso-timestamp' }),
    ).rejects.toThrow('must be an ISO timestamp');
    await expect(ledger.getPromotionLedgerStatus(PROMO_ID, null)).resolves.toMatchObject({
      claimedCount: 0,
      budget: { availableMist: 0n, reservedMist: 0n, consumedMist: 0n },
    });
  });

  it('rejects an entitlement reservation pointer without its reservation record', async () => {
    const ledger = new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore());
    await ledger.claim(PROMO_ID, 'orphan-pointer-user', { useUntilAt: null });
    const state = ledger as unknown as {
      accounting: Map<string, PromotionAccountingRecord>;
      entitlements: Map<string, PromotionEntitlementRecord>;
    };
    const key = promotionEntitlementKey(PROMO_ID, 'orphan-pointer-user');
    const entitlement = state.entitlements.get(key);
    expect(entitlement).toBeDefined();
    state.entitlements.set(key, {
      ...entitlement!,
      remainingMist: (BigInt(entitlement!.remainingMist) - 1n).toString(),
      activeReservationReceiptId: 'missing-reservation',
      activeReservationAmountMist: '1',
    });
    const accounting = state.accounting.get(PROMO_ID);
    expect(accounting).toBeDefined();
    state.accounting.set(PROMO_ID, {
      ...accounting!,
      availableMist: (BigInt(accounting!.availableMist) - 1n).toString(),
      reservedMist: '1',
    });

    await expect(
      ledger.reserve({
        promotionId: PROMO_ID,
        userId: 'orphan-pointer-user',
        receiptId: 'new-receipt',
        amountMist: 1n,
      }),
    ).rejects.toThrow('points to a missing or finalized reservation');
  });

  it('rejects a receipt that has both reservation and final-result state', async () => {
    const ledger = new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore(), 0);
    await ledger.claim(PROMO_ID, 'dual-state-user', { useUntilAt: null });
    await ledger.reserve({
      promotionId: PROMO_ID,
      userId: 'dual-state-user',
      receiptId: 'dual-state-receipt',
      amountMist: 1n,
    });
    const state = ledger as unknown as {
      entitlements: Map<string, PromotionEntitlementRecord>;
      operationResults: Map<string, PromotionOperationResultRecord>;
    };
    const entitlement = state.entitlements.get(
      promotionEntitlementKey(PROMO_ID, 'dual-state-user'),
    );
    expect(entitlement).toBeDefined();
    state.operationResults.set('dual-state-receipt', {
      receiptId: 'dual-state-receipt',
      promotionId: PROMO_ID,
      userId: 'dual-state-user',
      operation: 'release',
      amountMist: '1',
      result: 'released',
      entitlement: {
        ...entitlement!,
        remainingMist: (BigInt(entitlement!.remainingMist) + 1n).toString(),
        activeReservationReceiptId: null,
        activeReservationAmountMist: null,
      },
    });

    await expect(ledger.release('dual-state-receipt')).rejects.toThrow(
      'both a reservation and a final operation result',
    );
    await expect(ledger.sweepExpiredReservations()).rejects.toThrow(
      'both a reservation and a final operation result',
    );
  });

  it('rejects an orphan final result without current accounting and entitlement', async () => {
    const ledger = new MemoryPromotionExecutionLedger(await createMemoryPromotionLedgerStore());
    const state = ledger as unknown as {
      operationResults: Map<string, PromotionOperationResultRecord>;
    };
    state.operationResults.set('orphan-result-receipt', {
      receiptId: 'orphan-result-receipt',
      promotionId: PROMO_ID,
      userId: 'orphan-result-user',
      operation: 'release',
      amountMist: '1',
      result: 'released',
      entitlement: {
        promotionId: PROMO_ID,
        userId: 'orphan-result-user',
        claimedAt: '2026-07-16T00:00:00.000Z',
        useUntilAt: null,
        remainingMist: '1',
        consumedMist: '0',
        status: 'active',
        activeReservationReceiptId: null,
        activeReservationAmountMist: null,
        lastUsedAt: null,
      },
    });

    await expect(ledger.release('orphan-result-receipt')).rejects.toThrow(
      'missing accounting or entitlement state',
    );
  });
});

// Runtime/docs drift lock — both values must stay in sync
// with `docs/parameters.md#ttl-constants`. Tightening the reaper to
// 15 s halves max recovery latency without changing the TTL invariant.
describe('Studio execution ledger reaper / TTL constants', () => {
  it('PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS is 60s', () => {
    expect(PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS).toBe(60_000);
  });

  it('PROMOTION_EXECUTION_LEDGER_DEFAULT_REAPER_INTERVAL_MS is 15s', () => {
    expect(PROMOTION_EXECUTION_LEDGER_DEFAULT_REAPER_INTERVAL_MS).toBe(15_000);
  });

  it('reaper interval is strictly less than the reservation TTL', () => {
    expect(PROMOTION_EXECUTION_LEDGER_DEFAULT_REAPER_INTERVAL_MS).toBeLessThan(
      PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS,
    );
  });
});
