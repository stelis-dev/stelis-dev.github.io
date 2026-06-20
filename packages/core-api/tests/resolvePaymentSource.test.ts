/**
 * resolvePaymentSource — payment input source selection tests.
 *
 * Verifies the selection priority:
 *   1. coin_object — usable coin objects cover required amount
 *   2. address_balance — address balance alone covers required amount
 *   3. mixed_topup — coin objects + address balance together cover it
 *   4. INSUFFICIENT_BALANCE — nothing covers it
 */
import { describe, it, expect, vi } from 'vitest';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { resolvePaymentSource } from '../src/prepare/coinSelection.js';
import { PrepareValidationError } from '../src/prepare/replay.js';
import type { PrefixUsage } from '../src/prepare/settlePlanTypes.js';

// ── Mock SuiGrpcClient ─────────────────────────────────────────────────────

function makeMockSui(coins: { objectId: string; balance: string }[], addressBalance: string = '0') {
  return {
    listCoins: vi.fn().mockResolvedValue({ objects: coins }),
    getBalance: vi.fn().mockResolvedValue({
      balance: { coinBalance: '0', addressBalance },
    }),
  } as unknown as SuiGrpcClient;
}

const COIN_A = '0x' + 'a'.repeat(64);
const COIN_B = '0x' + 'b'.repeat(64);

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

describe('resolvePaymentSource', () => {
  // ── Priority 1: coin_object ─────────────────────────────────────────────

  it('coin objects sufficient → coin_object', async () => {
    const sui = makeMockSui([
      { objectId: COIN_A, balance: '5000' },
      { objectId: COIN_B, balance: '3000' },
    ]);
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      7000,
      'TKN',
      makePrefixUsage(),
    );
    expect(result.source).toBe('coin_object');
    expect(result.usableCoinTotal).toBe(8000n);
    expect(result.redeemDelta).toBe(0n);
  });

  it('rejects non-decimal coin object balances', async () => {
    const sui = makeMockSui([{ objectId: COIN_A, balance: '0x10' }]);

    await expect(
      resolvePaymentSource(sui, '0xowner', 'TOKEN', 1n, 'TKN', makePrefixUsage()),
    ).rejects.toMatchObject({
      code: 'INVALID_BALANCE_FORMAT',
    });
  });

  // ── Priority 2: address_balance ─────────────────────────────────────────

  it('coin objects insufficient, address balance sufficient → address_balance', async () => {
    const sui = makeMockSui([{ objectId: COIN_A, balance: '2000' }], '10000');
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      8000,
      'TKN',
      makePrefixUsage(),
    );
    expect(result.source).toBe('address_balance');
    expect(result.redeemDelta).toBe(8000n);
  });

  it('rejects non-decimal address balances', async () => {
    const sui = makeMockSui([], '1e6');

    await expect(
      resolvePaymentSource(sui, '0xowner', 'TOKEN', 1n, 'TKN', makePrefixUsage()),
    ).rejects.toMatchObject({
      code: 'INVALID_BALANCE_FORMAT',
    });
  });

  it('no coin objects, address balance sufficient → address_balance', async () => {
    const sui = makeMockSui([], '10000');
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      8000,
      'TKN',
      makePrefixUsage(),
    );
    expect(result.source).toBe('address_balance');
    expect(result.usableCoinTotal).toBe(0n);
    expect(result.redeemDelta).toBe(8000n);
  });

  // ── Priority 3: mixed_topup ─────────────────────────────────────────────

  it('coin + address balance together sufficient → mixed_topup', async () => {
    const sui = makeMockSui(
      [{ objectId: COIN_A, balance: '5000' }],
      '4000', // address balance alone not enough (4000 < 8000)
    );
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      8000,
      'TKN',
      makePrefixUsage(),
    );
    expect(result.source).toBe('mixed_topup');
    expect(result.usableCoinTotal).toBe(5000n);
    expect(result.redeemDelta).toBe(3000n); // 8000 - 5000
  });

  // ── Priority 4: INSUFFICIENT_BALANCE ────────────────────────────────────

  it('nothing covers it → INSUFFICIENT_BALANCE', async () => {
    const sui = makeMockSui([{ objectId: COIN_A, balance: '2000' }], '3000');
    try {
      await resolvePaymentSource(sui, '0xowner', 'TOKEN', 10000, 'TKN', makePrefixUsage());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as PrepareValidationError).code).toBe('INSUFFICIENT_BALANCE');
    }
  });

  // ── R-9 consumed filter ─────────────────────────────────────────────────

  it('consumed coins excluded from usable total', async () => {
    const sui = makeMockSui(
      [
        { objectId: COIN_A, balance: '5000' },
        { objectId: COIN_B, balance: '5000' },
      ],
      '8000',
    );
    const consumed = new Set([COIN_A]);
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      8000,
      'TKN',
      makePrefixUsage({ consumed }),
    );
    // 5000 < 8000, address balance 8000 >= 8000 → address_balance
    expect(result.source).toBe('address_balance');
    expect(result.usableCoinTotal).toBe(5000n);
  });

  // ── Collision error codes ───────────────────────────────────────────────

  it('all coins consumed + no address balance → PAYMENT_COIN_CONFLICT', async () => {
    const sui = makeMockSui([{ objectId: COIN_A, balance: '5000' }], '0');
    const consumed = new Set([COIN_A]);
    try {
      await resolvePaymentSource(
        sui,
        '0xowner',
        'TOKEN',
        8000,
        'TKN',
        makePrefixUsage({ consumed }),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as PrepareValidationError).code).toBe('PAYMENT_COIN_CONFLICT');
    }
  });

  it('no coins at all + no address balance → INSUFFICIENT_BALANCE', async () => {
    const sui = makeMockSui([], '0');
    try {
      await resolvePaymentSource(sui, '0xowner', 'TOKEN', 8000, 'TKN', makePrefixUsage());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as PrepareValidationError).code).toBe('INSUFFICIENT_BALANCE');
    }
  });
});

// ── FundsWithdrawal accounting scope ─────────────────────────────────────
//
// Tests with default PrefixUsage (prefixAbConsumed=0) verify the
// object/account selection path. Tests below cover the full accounting path.

// ── 6-cell functional matrix ──────────────────────────────────────────────
//
// Functional matrix mapped to resolvePaymentSource behavior.
// Each test represents one cell: {asset-state} × {prefix-behavior}.
//
// Asset states: object-only, address-balance-only, mixed
// Prefix behaviors: user-does-not-touch, user-touches
//
// "user-touches" means coin objects land in consumed set (via classifyUserTxCoins
// upstream). For address-balance touches, the current function has no mechanism
// to receive that information — documented separately below.

describe('resolvePaymentSource — 6-cell functional matrix', () => {
  // Cell 1: object-only + does not touch → coin_object
  // Covered by "coin objects sufficient → coin_object" (consumed = ∅).

  // Cell 2: object-only + touches (single coin consumed, AB=0) → PAYMENT_COIN_CONFLICT
  // Covered by "single consumed coin + AB=0 → PAYMENT_COIN_CONFLICT" below.

  // Cell 3: AB-only + does not touch → address_balance
  // Covered by "no coin objects, AB sufficient → address_balance".

  // Cell 4: AB-only + user touches settlement token via tx.withdrawal()
  // No coin objects exist. User prefix uses tx.withdrawal() to consume some AB.
  // Resolver has no mechanism to receive prefix AB consumption → sees full AB.
  it('cell 4: AB-only + user touches AB via withdrawal → resolver sees full AB (gap)', async () => {
    // User has AB=10000, no coin objects.
    // Prefix withdrew 6000 via tx.withdrawal(), but resolver cannot know.
    const sui = makeMockSui([], '10000');
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      8000n,
      'TKN',
      makePrefixUsage(),
    );
    // Resolver selects address_balance because 10000 >= 8000.
    // Actual remaining AB after prefix = 4000. This would fail at build.
    expect(result.source).toBe('address_balance');
    expect(result.addressBalance).toBe(10000n); // full snapshot, no deduction
  });

  // Cell 5: mixed + does not touch → mixed_topup or coin_object
  // Covered by "coin + AB together sufficient → mixed_topup".

  // Cell 6: mixed + user touches coin objects
  it('cell 6: mixed + user touches coin → falls to AB or mixed_topup', async () => {
    // User has COIN_A=5000 (consumed by prefix) + COIN_B=3000 (untouched) + AB=2000.
    // Required: 4000.
    const sui = makeMockSui(
      [
        { objectId: COIN_A, balance: '5000' },
        { objectId: COIN_B, balance: '3000' },
      ],
      '2000',
    );
    const consumed = new Set([COIN_A]);
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      4000n,
      'TKN',
      makePrefixUsage({ consumed }),
    );
    // Usable coin total = COIN_B only = 3000 < 4000.
    // AB = 2000 alone < 4000.
    // mixed: 3000 + 2000 = 5000 >= 4000 → mixed_topup.
    expect(result.source).toBe('mixed_topup');
    expect(result.usableCoinTotal).toBe(3000n);
    expect(result.redeemDelta).toBe(1000n); // 4000 - 3000
  });

  // Cell 6 sub-variant: mixed + user touches BOTH coin and AB
  it('cell 6 sub: mixed + user touches coin + AB via withdrawal → coin tracked, AB gap', async () => {
    // User has COIN_A=5000 (consumed) + AB=8000 (prefix withdrew 3000, resolver doesn't know).
    // Required: 7000.
    const sui = makeMockSui(
      [{ objectId: COIN_A, balance: '5000' }],
      '8000', // snapshot — prefix already claimed 3000
    );
    const consumed = new Set([COIN_A]);
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      7000n,
      'TKN',
      makePrefixUsage({ consumed }),
    );
    // Usable coins = 0 (COIN_A consumed). AB snapshot = 8000 >= 7000 → address_balance.
    // Actual remaining AB = 5000. If 5000 >= 7000 → fail. But resolver says OK.
    expect(result.source).toBe('address_balance');
    expect(result.addressBalance).toBe(8000n); // no deduction
  });
});

describe('resolvePaymentSource — FundsWithdrawal accounting gap', () => {
  // Scenario: user prefix withdrew 7000 from address balance (via tx.withdrawal).
  // Chain snapshot still reports addressBalance = 10000 because the TX hasn't
  // executed yet. resolvePaymentSource has no way to know 7000 is already claimed.
  //
  // Coin objects: 1 coin, 3000 balance, all consumed by prefix (in consumed set).
  // Required: 8000 for swap.
  //
  // Expected current behavior: resolver sees addressBalance = 10000 >= 8000,
  // selects 'address_balance' path. It does NOT subtract the 7000 prefix usage.

  it('prefix-consumed address balance is NOT subtracted — resolver sees full chain snapshot', async () => {
    // Mock: 1 coin (consumed), chain addressBalance = 10000
    const sui = makeMockSui(
      [{ objectId: COIN_A, balance: '3000' }],
      '10000', // chain snapshot — prefix already claimed 7000, but resolver cannot know
    );
    const consumed = new Set([COIN_A]); // coin object consumed by prefix

    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      8000n,
      'TKN',
      makePrefixUsage({ consumed }),
    );

    // Resolver selects address_balance because 10000 >= 8000.
    // It has no input for "prefix already used 7000 of this 10000".
    // In reality, only 3000 AB remains, so this would fail at build/dry-run.
    expect(result.source).toBe('address_balance');
    expect(result.addressBalance).toBe(10000n); // full snapshot, no deduction
    expect(result.redeemDelta).toBe(8000n);
  });

  // ── Single coin object, mutated by prefix ────────────────────────────────
  // User has 1 settlement-token Coin<T> with balance 11_000_000.
  // User prefix: splitCoins(thatCoin, [1_000_000]) + transferObjects.
  // classifyUserTxCoins marks thatCoin as mutated.
  // With no reusable provenance and AB = 0, the resolver still rejects.
  // Result: usable coins = 0, addressBalance = 0, both < required → PAYMENT_COIN_CONFLICT.
  it('single coin consumed + AB=0 → PAYMENT_COIN_CONFLICT', async () => {
    const sui = makeMockSui(
      [{ objectId: COIN_A, balance: '11000000' }], // 11 DEEP
      '0', // address balance = 0
    );
    // classifyUserTxCoins would put COIN_A in mutated → effectiveConsumed
    try {
      await resolvePaymentSource(
        sui,
        '0xowner',
        'TOKEN',
        10_000_000n,
        'DEEP',
        makePrefixUsage({ mutated: new Set([COIN_A]) }),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('PAYMENT_COIN_CONFLICT');
    }
  });

  it('default PrefixUsage with prefixAbConsumed=0', async () => {
    const sui = makeMockSui([], '5000');
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      4000n,
      'TKN',
      makePrefixUsage(),
    );
    expect(result.source).toBe('address_balance');
    expect(result.addressBalance).toBe(5000n);
  });
});

// ── prefixAbConsumed integration tests ───────────────────────────────────
//
// These tests verify R-9 AB accounting through PrefixUsage.prefixAbConsumed.

describe('resolvePaymentSource — prefixAbConsumed (R-9 AB accounting)', () => {
  // A1: no prefix AB consumption, coin objects sufficient → coin_object unchanged
  it('prefixAbConsumed=0, coin objects sufficient → coin_object unchanged', async () => {
    const sui = makeMockSui([
      { objectId: COIN_A, balance: '5000' },
      { objectId: COIN_B, balance: '3000' },
    ]);
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      7000n,
      'TKN',
      makePrefixUsage(),
    );
    expect(result.source).toBe('coin_object');
    expect(result.usableCoinTotal).toBe(8000n);
  });

  // A4: prefix consumed 50% of AB, remaining AB sufficient → address_balance
  it('prefix consumed partial AB, remaining sufficient → address_balance with effective AB', async () => {
    const sui = makeMockSui([], '10000');
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      3000n,
      'TKN',
      makePrefixUsage({ prefixAbConsumed: 7000n }),
    );
    expect(result.source).toBe('address_balance');
    expect(result.addressBalance).toBe(3000n); // 10000 - 7000
    expect(result.redeemDelta).toBe(3000n);
  });

  // A5: prefix consumed 100% of AB, coin objects sufficient → coin_object fallback
  it('prefix consumed all AB, coin objects sufficient → falls back to coin_object', async () => {
    const sui = makeMockSui([{ objectId: COIN_A, balance: '5000' }], '10000');
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      4000n,
      'TKN',
      makePrefixUsage({ prefixAbConsumed: 10000n }),
    );
    // effectiveAb = 0, but coins cover it
    expect(result.source).toBe('coin_object');
    expect(result.usableCoinTotal).toBe(5000n);
  });

  // A6: prefix consumed 100% of AB, no coins → INSUFFICIENT_BALANCE
  it('prefix consumed all AB, no coins → INSUFFICIENT_BALANCE', async () => {
    const sui = makeMockSui([], '10000');
    try {
      await resolvePaymentSource(
        sui,
        '0xowner',
        'TOKEN',
        5000n,
        'TKN',
        makePrefixUsage({ prefixAbConsumed: 10000n }),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('INSUFFICIENT_BALANCE');
    }
  });

  // A7: prefix consumed partial AB + coin consumed, mixed remainder sufficient
  it('prefix consumed partial AB + coin consumed → mixed_topup with effective AB', async () => {
    const sui = makeMockSui(
      [
        { objectId: COIN_A, balance: '3000' },
        { objectId: COIN_B, balance: '2000' },
      ],
      '8000',
    );
    // COIN_A consumed by prefix, COIN_B usable (2000). AB 8000 - 5000 = 3000 effective.
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      4000n,
      'TKN',
      makePrefixUsage({ consumed: new Set([COIN_A]), prefixAbConsumed: 5000n }),
    );
    expect(result.source).toBe('mixed_topup');
    expect(result.usableCoinTotal).toBe(2000n);
    expect(result.addressBalance).toBe(3000n); // effective
    expect(result.redeemDelta).toBe(2000n); // 4000 - 2000
  });

  // A8: all coins consumed + all AB consumed → PAYMENT_COIN_CONFLICT
  it('all coins consumed + all AB consumed → PAYMENT_COIN_CONFLICT', async () => {
    const sui = makeMockSui([{ objectId: COIN_A, balance: '5000' }], '3000');
    try {
      await resolvePaymentSource(
        sui,
        '0xowner',
        'TOKEN',
        4000n,
        'TKN',
        makePrefixUsage({ consumed: new Set([COIN_A]), prefixAbConsumed: 3000n }),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('PAYMENT_COIN_CONFLICT');
    }
  });

  // A11: over-subtract (prefix claims more AB than chain reports) → effectiveAb = 0 (floor)
  it('prefixAbConsumed > raw addressBalance → effectiveAb floored to 0', async () => {
    const sui = makeMockSui([{ objectId: COIN_A, balance: '5000' }], '3000');
    // prefixAbConsumed (10000) > rawAB (3000) → effectiveAb = 0
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      4000n,
      'TKN',
      makePrefixUsage({ prefixAbConsumed: 10000n }),
    );
    // coins (5000) >= required (4000) → coin_object
    expect(result.source).toBe('coin_object');
  });

  // no prefix address-balance consumption, address balance sufficient → unchanged
  it('prefixAbConsumed=0, AB sufficient → address_balance unchanged', async () => {
    const sui = makeMockSui([], '5000');
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      4000n,
      'TKN',
      makePrefixUsage(),
    );
    expect(result.source).toBe('address_balance');
    expect(result.addressBalance).toBe(5000n);
    expect(result.redeemDelta).toBe(4000n);
  });

  // prefixAbConsumed must shift selection to address_balance in this setup.
  it('uses address_balance when prefixAbConsumed reduces effective AB', async () => {
    // Setup: coin consumed, chain AB=10000, prefix claimed 7000.
    const sui = makeMockSui([{ objectId: COIN_A, balance: '3000' }], '10000');
    const consumed = new Set([COIN_A]);

    // WITH prefixAbConsumed: effectiveAb = 10000 - 7000 = 3000
    // Required = 8000, coins = 0 (consumed), effectiveAb = 3000 → insufficient
    try {
      await resolvePaymentSource(
        sui,
        '0xowner',
        'TOKEN',
        8000n,
        'TKN',
        makePrefixUsage({ consumed, prefixAbConsumed: 7000n }),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('INSUFFICIENT_BALANCE');
    }
  });
});

describe('resolvePaymentSource — object and address-balance funding lock', () => {
  it('selects coin_object when usable coin objects cover the amount after address-balance withdrawal', async () => {
    const sui = makeMockSui([{ objectId: COIN_A, balance: '8000' }], '10000');
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      7000n,
      'TKN',
      makePrefixUsage({ prefixAbConsumed: 9000n }),
    );

    expect(result.source).toBe('coin_object');
    expect(result.usableCoinTotal).toBe(8000n);
    expect(result.addressBalance).toBe(0n);
    expect(result.redeemDelta).toBe(0n);
  });

  it('selects address_balance when remaining address balance covers the amount', async () => {
    const sui = makeMockSui([], '10000');
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      8000n,
      'TKN',
      makePrefixUsage({ prefixAbConsumed: 2000n }),
    );

    expect(result.source).toBe('address_balance');
    expect(result.usableCoinTotal).toBe(0n);
    expect(result.addressBalance).toBe(8000n);
    expect(result.redeemDelta).toBe(8000n);
  });

  it('selects mixed_topup when usable coin objects and remaining address balance cover together', async () => {
    const sui = makeMockSui([{ objectId: COIN_A, balance: '3000' }], '10000');
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      6000n,
      'TKN',
      makePrefixUsage({ prefixAbConsumed: 6000n }),
    );

    expect(result.source).toBe('mixed_topup');
    expect(result.usableCoinTotal).toBe(3000n);
    expect(result.addressBalance).toBe(4000n);
    expect(result.redeemDelta).toBe(3000n);
  });

  it('returns INSUFFICIENT_BALANCE when no object or remaining address balance covers the amount', async () => {
    const sui = makeMockSui([], '10000');

    await expect(
      resolvePaymentSource(
        sui,
        '0xowner',
        'TOKEN',
        3000n,
        'TKN',
        makePrefixUsage({ prefixAbConsumed: 8000n }),
      ),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
  });

  it('returns PAYMENT_COIN_CONFLICT when payment coin objects are unavailable and address balance is unavailable', async () => {
    const sui = makeMockSui([{ objectId: COIN_A, balance: '5000' }], '10000');

    await expect(
      resolvePaymentSource(
        sui,
        '0xowner',
        'TOKEN',
        4000n,
        'TKN',
        makePrefixUsage({
          consumed: new Set([COIN_A]),
          prefixAbConsumed: 10000n,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'PAYMENT_COIN_CONFLICT',
    });
  });
});

// ── Merge credit: mergeConsumedIds integration tests ──────────────────────

describe('resolvePaymentSource — mergeDestToSources (carrier-aware merge credit)', () => {
  it('merge credit applied when survivor dest is usable', async () => {
    const COIN_C = '0x' + 'c'.repeat(64);
    const sui = makeMockSui([], '0');
    (sui.listCoins as ReturnType<typeof vi.fn>).mockResolvedValue({
      objects: [
        { objectId: COIN_A, balance: '5000' },
        { objectId: COIN_B, balance: '3000' },
        { objectId: COIN_C, balance: '2000' },
      ],
    });
    // A=survivor(usable), B/C=consumed(merge sources into A)
    const consumed = new Set([COIN_B, COIN_C]);
    const mergeMap = new Map([[COIN_A, new Set([COIN_B, COIN_C])]]);
    const survivors = new Set([COIN_A]);

    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      8000n,
      'TKN',
      makePrefixUsage({ consumed, mergeDestToSources: mergeMap, survivors }),
    );
    expect(result.source).toBe('coin_object');
  });

  it('no mergeDestToSources → no credit', async () => {
    const sui = makeMockSui([
      { objectId: COIN_A, balance: '5000' },
      { objectId: COIN_B, balance: '3000' },
    ]);
    const consumed = new Set([COIN_B]);

    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      4000n,
      'TKN',
      makePrefixUsage({ consumed }),
    );
    expect(result.source).toBe('coin_object');
    expect(result.usableCoinTotal).toBe(5000n);
  });

  it('merge credit + AB deduction work together', async () => {
    const sui = makeMockSui(
      [
        { objectId: COIN_A, balance: '3000' },
        { objectId: COIN_B, balance: '2000' },
      ],
      '5000',
    );
    const consumed = new Set([COIN_B]);
    const mergeMap = new Map([[COIN_A, new Set([COIN_B])]]);
    const survivors = new Set([COIN_A]);

    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      4000n,
      'TKN',
      makePrefixUsage({
        consumed,
        prefixAbConsumed: 3000n,
        mergeDestToSources: mergeMap,
        survivors,
      }),
    );
    expect(result.source).toBe('coin_object');
  });

  it('merge dest later consumed (not survivor) → no false credit', async () => {
    // A=dest(consumed by transfer), B=merge source. No surviving carrier.
    const sui = makeMockSui(
      [
        { objectId: COIN_A, balance: '5000' },
        { objectId: COIN_B, balance: '3000' },
      ],
      '0',
    );
    const consumed = new Set([COIN_A, COIN_B]);
    const mergeMap = new Map([[COIN_A, new Set([COIN_B])]]);
    const survivors = new Set<string>(); // A lost survivor status

    try {
      await resolvePaymentSource(
        sui,
        '0xowner',
        'TOKEN',
        2000n,
        'TKN',
        makePrefixUsage({ consumed, mergeDestToSources: mergeMap, survivors }),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('PAYMENT_COIN_CONFLICT');
    }
  });

  // Adversarial: Result-backed merge dest + unrelated usable coin → no false credit
  it('Result-backed merge dest with unrelated usable coin → no false credit', async () => {
    const COIN_C = '0x' + 'c'.repeat(64);
    const sui = makeMockSui([], '0');
    (sui.listCoins as ReturnType<typeof vi.fn>).mockResolvedValue({
      objects: [
        { objectId: COIN_A, balance: '1000' },
        { objectId: COIN_B, balance: '5000' },
        { objectId: COIN_C, balance: '1000' },
      ],
    });
    // splitCoins(A) → mergeCoins(splitResult, [B]). C is untouched.
    // mergeDestToSources: empty (dest is Result, not direct Input)
    // B consumed, A mutated → consumed. C usable.
    const consumed = new Set([COIN_A, COIN_B]);
    const mergeMap = new Map<string, Set<string>>(); // no entry — dest was Result
    const survivors = new Set<string>(); // no survivors

    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      800n,
      'TKN',
      makePrefixUsage({ consumed, mergeDestToSources: mergeMap, survivors }),
    );
    // C alone (1000) covers 800 → coin_object. No false B credit.
    expect(result.source).toBe('coin_object');
    expect(result.usableCoinTotal).toBe(1000n); // only C
  });
});

describe('resolvePaymentSource — Workstream 2 reusable split-source widening', () => {
  it('safe reusable split source can satisfy coin_object without falling into PAYMENT_COIN_CONFLICT', async () => {
    const sui = makeMockSui([{ objectId: COIN_A, balance: '11000000' }], '0');
    const result = await resolvePaymentSource(
      sui,
      '0xowner',
      'TOKEN',
      10_000_000n,
      'TKN',
      makePrefixUsage({
        mutated: new Set([COIN_A]),
        reusableSplitSources: new Set([COIN_A]),
      }),
    );
    expect(result.source).toBe('coin_object');
    expect(result.usableCoinTotal).toBe(11_000_000n);
  });

  it('opaque usage still overrides reusable split-source and remains rejected', async () => {
    const sui = makeMockSui([{ objectId: COIN_A, balance: '11000000' }], '0');
    try {
      await resolvePaymentSource(
        sui,
        '0xowner',
        'TOKEN',
        10_000_000n,
        'TKN',
        makePrefixUsage({
          opaqueInUse: new Set([COIN_A]),
          mutated: new Set([COIN_A]),
          reusableSplitSources: new Set([COIN_A]),
        }),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('PAYMENT_COIN_CONFLICT');
    }
  });
});
