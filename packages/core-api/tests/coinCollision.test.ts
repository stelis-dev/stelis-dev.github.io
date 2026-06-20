/**
 * R-9: Coin collision prevention tests.
 *
 * Verifies that selectPaymentCoin correctly handles the case where user TX
 * prefix coins overlap with swap payment coins. This prevents
 * ArgumentWithoutValue errors when transfer token = settlement token.
 *
 * DEEP fee-coin selection is out of scope: the Move entrypoint materializes
 * `coin::zero<DEEP>(ctx)` internally, so there is no user-facing DEEP
 * discovery path to protect against collisions.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { selectPaymentCoin } from '../src/prepare/coinSelection.js';
import { PrepareValidationError } from '../src/prepare/replay.js';
import type { PrefixUsage } from '../src/prepare/settlePlanTypes.js';

// ── Mock SuiGrpcClient ─────────────────────────────────────────────────────

function makeMockSui(coinObjects: { objectId: string; balance?: string }[]) {
  return {
    listCoins: vi.fn().mockImplementation(() => Promise.resolve({ objects: coinObjects })),
  } as unknown as SuiGrpcClient;
}

// ── Mock Transaction ────────────────────────────────────────────────────────

function makeMockTx() {
  const mergeCoins = vi.fn();
  const splitCoins = vi.fn().mockReturnValue(['SPLIT_COIN', 'LEFTOVER_COIN']);
  const object = vi.fn().mockImplementation((id: string) => ({ objectRef: id }));
  const moveCall = vi.fn().mockReturnValue('ZERO_COIN');
  return { mergeCoins, splitCoins, object, moveCall } as unknown as Transaction;
}

function makePrefixUsage(overrides: Partial<PrefixUsage> = {}): PrefixUsage {
  return {
    survivors: new Set(),
    consumed: new Set(),
    opaqueInUse: new Set(),
    mutated: new Set(),
    reusableSplitSources: new Set(),
    mergeDestToSources: new Map(),
    prefixAbConsumed: 0n,
    ...overrides,
  };
}

// ── selectPaymentCoin tests ─────────────────────────────────────────────────

describe('R-9: selectPaymentCoin — coin collision prevention', () => {
  const COIN_A = '0x' + 'a'.repeat(64);
  const COIN_B = '0x' + 'b'.repeat(64);
  const COIN_C = '0x' + 'c'.repeat(64);
  const COIN_D = '0x' + 'd'.repeat(64);

  it('1. payment coin collision: uses survivor as base, skips consumed', async () => {
    // User TX: MergeCoins(A ← B, C) → A is survivor, B/C are consumed
    const sui = makeMockSui([{ objectId: COIN_A }, { objectId: COIN_B }, { objectId: COIN_C }]);
    const tx = makeMockTx();

    const survivors = new Set([COIN_A]);
    const consumed = new Set([COIN_B, COIN_C]);

    const result = await selectPaymentCoin(
      sui,
      tx,
      '0xowner',
      'DEEP_TYPE',
      1000,
      'DEEP',
      makePrefixUsage({ survivors, consumed }),
    );

    // Base should be COIN_A (survivor), not COIN_B or COIN_C (consumed)
    expect(result.paymentCoin).toBe('SPLIT_COIN');
    // No merge needed — only 1 usable coin (A), B/C filtered out
    expect(tx.mergeCoins).not.toHaveBeenCalled();
    // Split from base (COIN_A)
    expect(tx.splitCoins).toHaveBeenCalledWith(tx.object(COIN_A), [1000n]);
  });

  it('3. non-overlap fallback: no overlap → standard merge + split', async () => {
    // No overlap — all coins are usable
    const sui = makeMockSui([{ objectId: COIN_A }, { objectId: COIN_B }, { objectId: COIN_C }]);
    const tx = makeMockTx();

    const result = await selectPaymentCoin(sui, tx, '0xowner', 'DEEP_TYPE', 1000, 'DEEP');

    // Default base = first coin (COIN_A)
    expect(result.paymentCoin).toBe('SPLIT_COIN');
    // Merge B, C into A
    expect(tx.mergeCoins).toHaveBeenCalledWith(tx.object(COIN_A), [
      tx.object(COIN_B),
      tx.object(COIN_C),
    ]);
    expect(tx.splitCoins).toHaveBeenCalledWith(tx.object(COIN_A), [1000n]);
  });

  it('4. overlap 2+, first overlap is consumed: picks survivor as base', async () => {
    // Coins: A (consumed), B (survivor), C (non-overlap), D (non-overlap)
    // User TX: MergeCoins(B ← A), TransferObjects(split)
    const sui = makeMockSui([
      { objectId: COIN_A },
      { objectId: COIN_B },
      { objectId: COIN_C },
      { objectId: COIN_D },
    ]);
    const tx = makeMockTx();

    const survivors = new Set([COIN_B]);
    const consumed = new Set([COIN_A]);

    const result = await selectPaymentCoin(
      sui,
      tx,
      '0xowner',
      'DEEP_TYPE',
      1000,
      'DEEP',
      makePrefixUsage({ survivors, consumed }),
    );

    // Base = COIN_B (survivor), not COIN_A (consumed/filtered)
    expect(result.paymentCoin).toBe('SPLIT_COIN');
    // Merge C, D into B (A is filtered out)
    expect(tx.mergeCoins).toHaveBeenCalledWith(tx.object(COIN_B), [
      tx.object(COIN_C),
      tx.object(COIN_D),
    ]);
  });

  it('5. direct transfer (no merge): TransferObjects coin is consumed', async () => {
    // User TX: TransferObjects([A]) → A is consumed, no merge
    const sui = makeMockSui([{ objectId: COIN_A }, { objectId: COIN_B }]);
    const tx = makeMockTx();

    const survivors = new Set<string>();
    const consumed = new Set([COIN_A]); // A transferred directly

    const result = await selectPaymentCoin(
      sui,
      tx,
      '0xowner',
      'DEEP_TYPE',
      1000,
      'DEEP',
      makePrefixUsage({ survivors, consumed }),
    );

    // Base = COIN_B (A is consumed)
    expect(result.paymentCoin).toBe('SPLIT_COIN');
    expect(tx.mergeCoins).not.toHaveBeenCalled(); // Only 1 usable coin
    expect(tx.splitCoins).toHaveBeenCalledWith(tx.object(COIN_B), [1000n]);
  });

  it('6. MoveCall opaque usage: coin passed to external MoveCall is excluded', async () => {
    const sui = makeMockSui([
      { objectId: COIN_A, balance: '5000' },
      { objectId: COIN_B, balance: '5000' },
    ]);
    const tx = makeMockTx();

    const opaqueInUse = new Set([COIN_A]);

    const result = await selectPaymentCoin(
      sui,
      tx,
      '0xowner',
      'DEEP_TYPE',
      1000,
      'DEEP',
      makePrefixUsage({ opaqueInUse }),
    );

    // Base should be COIN_B (COIN_A excluded)
    expect(result.paymentCoin).toBe('SPLIT_COIN');
    expect(tx.mergeCoins).not.toHaveBeenCalled(); // Only 1 usable coin
    expect(tx.splitCoins).toHaveBeenCalledWith(tx.object(COIN_B), [1000n]);
  });

  it('7. all coins in MoveCall → PAYMENT_COIN_CONFLICT', async () => {
    const sui = makeMockSui([
      { objectId: COIN_A, balance: '5000' },
      { objectId: COIN_B, balance: '5000' },
    ]);
    const tx = makeMockTx();

    // Both coins passed to external MoveCall
    const opaqueInUse = new Set([COIN_A, COIN_B]);

    try {
      await selectPaymentCoin(
        sui,
        tx,
        '0xowner',
        'DEEP_TYPE',
        1000,
        'DEEP',
        makePrefixUsage({ opaqueInUse }),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('PAYMENT_COIN_CONFLICT');
    }
  });

  it('PAYMENT_COIN_CONFLICT when all coins consumed', async () => {
    const sui = makeMockSui([{ objectId: COIN_A }, { objectId: COIN_B }]);
    const tx = makeMockTx();

    const consumed = new Set([COIN_A, COIN_B]);

    try {
      await selectPaymentCoin(
        sui,
        tx,
        '0xowner',
        'DEEP_TYPE',
        1000,
        'DEEP',
        makePrefixUsage({ consumed }),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('PAYMENT_COIN_CONFLICT');
    }
  });

  it('8. reusable split source remains eligible and is preferred as the payment base', async () => {
    const sui = makeMockSui([
      { objectId: COIN_A, balance: '11000000' },
      { objectId: COIN_B, balance: '5000000' },
    ]);
    const tx = makeMockTx();

    const result = await selectPaymentCoin(
      sui,
      tx,
      '0xowner',
      'DEEP_TYPE',
      1000,
      'DEEP',
      makePrefixUsage({
        mutated: new Set([COIN_A]),
        reusableSplitSources: new Set([COIN_A]),
      }),
    );

    expect(result.paymentCoin).toBe('SPLIT_COIN');
    expect(tx.mergeCoins).toHaveBeenCalledWith(tx.object(COIN_A), [tx.object(COIN_B)]);
    expect(tx.splitCoins).toHaveBeenCalledWith(tx.object(COIN_A), [1000n]);
  });
});
