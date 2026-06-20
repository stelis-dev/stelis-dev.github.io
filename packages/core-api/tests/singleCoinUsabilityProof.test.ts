import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { convertSdkCommands, extractObjectIdFromInput } from '@stelis/core-relay';
import {
  extractSettlePaymentInputContract,
  validatePaymentInputIntegrity,
} from '@stelis/core-relay/server';
import type { PrefixUsage, SettlementPlan } from '../src/prepare/settlePlanTypes.js';
import {
  ADDR_CONFIG,
  ADDR_PKG,
  ADDR_PAYMENT_COIN,
  ADDR_REGISTRY,
  ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
  ADDR_SENDER,
  ADDR_USABLE_COIN,
  ADDR_VAULT,
  BASE_AUDIT,
  SETTLEMENT_SWAP_PATH_BFQ,
} from './fixtures/prepareTestFixtures.js';

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

const { compileSwapSettlement } = await import('../src/prepare/ptbCompiler.js');

const PREFIX_SPLIT_AMOUNT = 1_000_000n;
const SWAP_AMOUNT = 10_000_000n;

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
      usableCoins: [{ objectId: ADDR_PAYMENT_COIN, balance: '11000000' }],
      usableCoinTotal: 11_000_000n,
      addressBalance: 0n,
      redeemDelta: 0n,
      useCreditAmount: 0n,
    },
    swap: { swapAmountSmallest: SWAP_AMOUNT, minSuiOut: 400_000n },
    audit: BASE_AUDIT,
    ...overrides,
  };
}

function getNormalizedTx(tx: Transaction): {
  commands: ReturnType<typeof convertSdkCommands>;
  inputs: unknown[];
} {
  const data = tx.getData() as { commands: unknown[]; inputs: unknown[] };
  return {
    commands: convertSdkCommands(data.commands),
    inputs: data.inputs,
  };
}

function findSplitSourceObjectId(
  splitCommand: ReturnType<typeof convertSdkCommands>[number],
  inputs: unknown[],
): string | null {
  if (splitCommand.kind !== 'SplitCoins') {
    throw new Error(`Expected SplitCoins command, got ${splitCommand.kind}`);
  }
  const payload = splitCommand.arguments[0] as
    | {
        coin?: { $kind?: string; Input?: number };
      }
    | undefined;
  const inputIndex = payload?.coin?.Input;
  if (typeof inputIndex !== 'number') {
    return null;
  }
  return extractObjectIdFromInput(inputs[inputIndex] as Record<string, unknown>);
}

describe('single-coin R-9 usability proof — compiler/PTB behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('direct-input split source can be re-materialized as an exact coin_object payment input', async () => {
    mockSelectPaymentCoin.mockImplementationOnce(
      async (_sui: unknown, tx: Transaction, _owner: string, _coinType: string, amount: bigint) => {
        const [paymentCoin] = tx.splitCoins(tx.object(ADDR_PAYMENT_COIN), [amount]);
        return { paymentCoin, leftoverCoin: null };
      },
    );

    const tx = new Transaction();
    const [prefixSplitResult] = tx.splitCoins(tx.object(ADDR_PAYMENT_COIN), [PREFIX_SPLIT_AMOUNT]);
    tx.transferObjects([prefixSplitResult], ADDR_SETTLEMENT_PAYOUT_RECIPIENT);

    await compileSwapSettlement(
      tx,
      makeSwapPlan(),
      CTX,
      ADDR_SENDER,
      ADDR_VAULT,
      makePrefixUsage(),
    );

    const { commands, inputs } = getNormalizedTx(tx);
    const splitCommands = commands.filter((cmd) => cmd.kind === 'SplitCoins');
    expect(splitCommands).toHaveLength(2);
    expect(findSplitSourceObjectId(splitCommands[1]!, inputs)).toBe(ADDR_PAYMENT_COIN);

    const contract = extractSettlePaymentInputContract(commands, inputs, ADDR_PKG);
    expect(
      validatePaymentInputIntegrity(contract.paymentInputTrace, {
        source: 'coin_object',
        swapAmountSmallest: SWAP_AMOUNT,
      }),
    ).toEqual({ ok: true });
  });

  it('address_balance path still materializes exact required amount in the existing contract shape', async () => {
    const tx = new Transaction();
    const swapAmountSmallest = 5_000_000n;

    await compileSwapSettlement(
      tx,
      makeSwapPlan({
        funding: {
          source: 'address_balance',
          usableCoins: [],
          usableCoinTotal: 0n,
          addressBalance: 8_000_000n,
          redeemDelta: swapAmountSmallest,
          useCreditAmount: 0n,
        },
        swap: { swapAmountSmallest, minSuiOut: 400_000n },
      }),
      CTX,
      ADDR_SENDER,
      ADDR_VAULT,
      makePrefixUsage(),
    );

    const { commands, inputs } = getNormalizedTx(tx);
    const contract = extractSettlePaymentInputContract(commands, inputs, ADDR_PKG);
    expect(
      validatePaymentInputIntegrity(contract.paymentInputTrace, {
        source: 'address_balance',
        swapAmountSmallest,
      }),
    ).toEqual({ ok: true });
  });

  it('mixed_topup path still materializes exact required amount in the existing contract shape', async () => {
    const tx = new Transaction();
    const swapAmountSmallest = 9_000_000n;

    await compileSwapSettlement(
      tx,
      makeSwapPlan({
        funding: {
          source: 'mixed_topup',
          usableCoins: [
            { objectId: ADDR_PAYMENT_COIN, balance: '7000000' },
            { objectId: ADDR_USABLE_COIN, balance: '1000000' },
          ],
          usableCoinTotal: 8_000_000n,
          addressBalance: 5_000_000n,
          redeemDelta: 2_000_000n,
          useCreditAmount: 0n,
        },
        swap: { swapAmountSmallest, minSuiOut: 400_000n },
      }),
      CTX,
      ADDR_SENDER,
      ADDR_VAULT,
      makePrefixUsage({ survivors: new Set([ADDR_PAYMENT_COIN]) }),
    );

    const { commands, inputs } = getNormalizedTx(tx);
    const contract = extractSettlePaymentInputContract(commands, inputs, ADDR_PKG);
    expect(
      validatePaymentInputIntegrity(contract.paymentInputTrace, {
        source: 'mixed_topup',
        swapAmountSmallest,
      }),
    ).toEqual({ ok: true });
  });
});
