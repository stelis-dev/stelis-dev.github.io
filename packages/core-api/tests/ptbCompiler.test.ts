/**
 * ptbCompiler.test.ts — PTB compiler unit tests.
 *
 * Tests the compiler functions with mocked coin selection and PTB builders.
 * Covers: coin_object, address_balance, mixed_topup, with_vault useCreditAmount,
 * PAYMENT_COIN_CONFLICT error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import type { PrefixUsage, SettlementPlan } from '../src/prepare/settlePlanTypes.js';
import {
  ADDR_PKG,
  ADDR_CONFIG,
  ADDR_REGISTRY,
  ADDR_VAULT,
  ADDR_SENDER,
  ADDR_USABLE_COIN,
  ADDR_PAYMENT_COIN,
  ADDR_DEEP_COIN,
  SETTLEMENT_SWAP_PATH_BFQ,
  BASE_AUDIT,
} from './fixtures/prepareTestFixtures.js';

// ─────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────

const mockSelectPaymentCoin = vi.fn();

vi.mock('../src/prepare/coinSelection.js', async () => {
  const actual = await vi.importActual<typeof import('../src/prepare/coinSelection.js')>(
    '../src/prepare/coinSelection.js',
  );
  return {
    ...actual,
    selectPaymentCoin: (...args: unknown[]) => mockSelectPaymentCoin(...args),
  };
});

const mockBuildSwapAndSettlePtb = vi.fn();
const mockBuildSettleWithCreditPtb = vi.fn();

vi.mock('@stelis/core-relay', () => ({
  buildSwapAndSettlePtb: (...args: unknown[]) => mockBuildSwapAndSettlePtb(...args),
  buildSettleWithCreditPtb: (...args: unknown[]) => mockBuildSettleWithCreditPtb(...args),
}));

// Must import AFTER vi.mock declarations
const { compileCreditSettlement, compileSwapSettlement } =
  await import('../src/prepare/ptbCompiler.js');

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

const MOCK_PAYMENT_COIN = { $kind: 'Result', Result: 0 };

const CTX = {
  sui: {} as never,
  packageId: ADDR_PKG,
  configId: ADDR_CONFIG,
  vaultRegistryId: ADDR_REGISTRY,
};

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

function makeSwapPlan(overrides: Partial<SettlementPlan> = {}): SettlementPlan {
  return {
    profile: 'with_vault',
    variant: 'with_vault',
    settlementSwapPath: SETTLEMENT_SWAP_PATH_BFQ,
    settlementSwapDirection: 'baseForQuote',
    funding: {
      source: 'coin_object',
      usableCoins: [{ objectId: ADDR_USABLE_COIN, balance: '10000000' }],
      usableCoinTotal: 10_000_000n,
      addressBalance: 0n,
      redeemDelta: 0n,
      useCreditAmount: 0n,
    },
    swap: { swapAmountSmallest: 500_000n, minSuiOut: 400_000n },
    audit: BASE_AUDIT,
    ...overrides,
  };
}

// ─────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectPaymentCoin.mockResolvedValue({ paymentCoin: MOCK_PAYMENT_COIN, leftoverCoin: null });
});

// ─────────────────────────────────────────────
// Credit-only compilation
// ─────────────────────────────────────────────

describe('compileCreditSettlement', () => {
  it('calls buildSettleWithCreditPtb with plan values', () => {
    const tx = new Transaction();
    const plan = makeSwapPlan({
      profile: 'credit_general',
      funding: {
        source: 'none_credit_only',
        usableCoins: [],
        usableCoinTotal: 0n,
        addressBalance: 0n,
        redeemDelta: 0n,
        useCreditAmount: 5_120_000n,
      },
      swap: { swapAmountSmallest: 0n, minSuiOut: 0n },
      audit: { ...BASE_AUDIT, slippageBufferMist: 0n },
    });

    compileCreditSettlement(tx, plan, CTX, ADDR_VAULT);

    expect(mockBuildSettleWithCreditPtb).toHaveBeenCalledOnce();
    const args = mockBuildSettleWithCreditPtb.mock.calls[0];
    expect(args[1].useCreditAmount).toBe(5_120_000n);
    expect(args[1].executionCostClaim).toBe(BASE_AUDIT.executionCostClaim);
    expect(args[1].slippageBufferMist).toBe(0n);
  });

  it('rejects credit plans with non-zero slippage buffer', () => {
    const tx = new Transaction();
    const plan = makeSwapPlan({
      profile: 'credit_general',
      funding: {
        source: 'none_credit_only',
        usableCoins: [],
        usableCoinTotal: 0n,
        addressBalance: 0n,
        redeemDelta: 0n,
        useCreditAmount: 5_120_000n,
      },
      swap: { swapAmountSmallest: 0n, minSuiOut: 0n },
      audit: { ...BASE_AUDIT, slippageBufferMist: 1n },
    });

    expect(() => compileCreditSettlement(tx, plan, CTX, ADDR_VAULT)).toThrow(
      /Credit-only PTB requires slippageBufferMist=0/,
    );
    expect(mockBuildSettleWithCreditPtb).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Swap compilation — coin_object path
// ─────────────────────────────────────────────

describe('compileSwapSettlement — coin_object', () => {
  it('calls selectPaymentCoin and buildSwapAndSettlePtb', async () => {
    const tx = new Transaction();
    const plan = makeSwapPlan({ profile: 'new_user', variant: 'new_user' });

    await compileSwapSettlement(tx, plan, CTX, ADDR_SENDER, null, makePrefixUsage());

    expect(mockSelectPaymentCoin).toHaveBeenCalledOnce();
    expect(mockBuildSwapAndSettlePtb).toHaveBeenCalledOnce();
    const builderArgs = mockBuildSwapAndSettlePtb.mock.calls[0][1];
    expect(builderArgs.variant).toBe('new_user');
  });
});

// ─────────────────────────────────────────────
// Swap compilation — address_balance path
// ─────────────────────────────────────────────

describe('compileSwapSettlement — address_balance', () => {
  it('does not call selectPaymentCoin', async () => {
    const tx = new Transaction();
    const plan = makeSwapPlan({
      funding: {
        source: 'address_balance',
        usableCoins: [],
        usableCoinTotal: 0n,
        addressBalance: 10_000_000n,
        redeemDelta: 500_000n,
        useCreditAmount: 0n,
      },
    });

    await compileSwapSettlement(tx, plan, CTX, ADDR_SENDER, null, makePrefixUsage());

    expect(mockSelectPaymentCoin).not.toHaveBeenCalled();
    expect(mockBuildSwapAndSettlePtb).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────
// Swap compilation — mixed_topup path
// ─────────────────────────────────────────────

describe('compileSwapSettlement — mixed_topup', () => {
  it('merges coins and redeems delta', async () => {
    const tx = new Transaction();
    const plan = makeSwapPlan({
      funding: {
        source: 'mixed_topup',
        usableCoins: [
          { objectId: ADDR_USABLE_COIN, balance: '5000000' },
          { objectId: ADDR_DEEP_COIN, balance: '3000000' },
        ],
        usableCoinTotal: 8_000_000n,
        addressBalance: 5_000_000n,
        redeemDelta: 2_000_000n,
        useCreditAmount: 0n,
      },
    });

    await compileSwapSettlement(tx, plan, CTX, ADDR_SENDER, null, makePrefixUsage());

    expect(mockSelectPaymentCoin).not.toHaveBeenCalled();
    expect(mockBuildSwapAndSettlePtb).toHaveBeenCalledOnce();
  });

  it('prefers reusable split-source as the mixed_topup base coin when no survivor exists', async () => {
    const tx = new Transaction();
    const plan = makeSwapPlan({
      funding: {
        source: 'mixed_topup',
        usableCoins: [
          { objectId: ADDR_USABLE_COIN, balance: '5000000' },
          { objectId: ADDR_PAYMENT_COIN, balance: '3000000' },
        ],
        usableCoinTotal: 8_000_000n,
        addressBalance: 5_000_000n,
        redeemDelta: 2_000_000n,
        useCreditAmount: 0n,
      },
    });

    await compileSwapSettlement(
      tx,
      plan,
      CTX,
      ADDR_SENDER,
      null,
      makePrefixUsage({
        mutated: new Set([ADDR_PAYMENT_COIN]),
        reusableSplitSources: new Set([ADDR_PAYMENT_COIN]),
      }),
    );

    const data = tx.getData() as {
      commands: Array<{ $kind?: string; MergeCoins?: { destination?: { Input?: number } } }>;
      inputs: Array<{ UnresolvedObject?: { objectId?: string } }>;
    };
    const mergeCommand = data.commands.find((command) => command.$kind === 'MergeCoins');
    const destinationIndex = mergeCommand?.MergeCoins?.destination?.Input;
    expect(typeof destinationIndex).toBe('number');
    expect(data.inputs[destinationIndex!]?.UnresolvedObject?.objectId).toBe(ADDR_PAYMENT_COIN);
  });

  it('throws PAYMENT_COIN_CONFLICT when no usable coins', async () => {
    const tx = new Transaction();
    const plan = makeSwapPlan({
      funding: {
        source: 'mixed_topup',
        usableCoins: [],
        usableCoinTotal: 0n,
        addressBalance: 5_000_000n,
        redeemDelta: 5_000_000n,
        useCreditAmount: 0n,
      },
    });

    try {
      await compileSwapSettlement(tx, plan, CTX, ADDR_SENDER, null, makePrefixUsage());
      expect.fail('Expected PAYMENT_COIN_CONFLICT error');
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe('PAYMENT_COIN_CONFLICT');
    }
  });
});

// ─────────────────────────────────────────────
// Swap compilation — with_vault useCreditAmount
// ─────────────────────────────────────────────

describe('compileSwapSettlement — with_vault', () => {
  it('passes plan.funding.useCreditAmount to builder', async () => {
    const tx = new Transaction();
    const plan = makeSwapPlan({
      profile: 'with_vault',
      funding: {
        source: 'coin_object',
        usableCoins: [{ objectId: ADDR_USABLE_COIN, balance: '10000000' }],
        usableCoinTotal: 10_000_000n,
        addressBalance: 0n,
        redeemDelta: 0n,
        useCreditAmount: 2_500_000n,
      },
    });

    await compileSwapSettlement(tx, plan, CTX, ADDR_SENDER, ADDR_VAULT, makePrefixUsage());

    expect(mockBuildSwapAndSettlePtb).toHaveBeenCalledOnce();
    const builderArgs = mockBuildSwapAndSettlePtb.mock.calls[0][1];
    expect(builderArgs.variant).toBe('with_vault');
    expect(builderArgs.useCreditAmount).toBe(2_500_000n);
    expect(builderArgs.vaultId).toBe(ADDR_VAULT);
  });
});

// ─────────────────────────────────────────────
// Builder contract: settle entry must NOT receive a deep_fee_coin argument
// (Move entry creates coin::zero<DEEP>(ctx) internally).
// ─────────────────────────────────────────────

describe('compileSwapSettlement — no DEEP fee coin argument', () => {
  it('builder params must not include deepFeeCoinId', async () => {
    const tx = new Transaction();
    const plan = makeSwapPlan();

    await compileSwapSettlement(tx, plan, CTX, ADDR_SENDER, ADDR_VAULT, makePrefixUsage());

    expect(mockBuildSwapAndSettlePtb).toHaveBeenCalledOnce();
    const builderArgs = mockBuildSwapAndSettlePtb.mock.calls[0][1] as Record<string, unknown>;
    expect('deepFeeCoinId' in builderArgs).toBe(false);
  });
});
