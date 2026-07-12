/**
 * PTB compiler tests use the real Transaction and settlement builders. The
 * assertions inspect the command/input graph so a selector or builder mock
 * cannot manufacture a successful funding path.
 */
import { describe, expect, it } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { settlementParameterIndex, type MoveCallCommand } from '@stelis/contracts';
import { convertSdkCommands, extractObjectIdFromInput } from '@stelis/core-relay';
import {
  extractSettlePaymentInputContract,
  validatePaymentInputIntegrity,
  type PaymentInputIntegrityExpectation,
} from '@stelis/core-relay/server';
import type { SettlementPlan, SwapFundingResolution } from '../src/prepare/settlePlanTypes.js';
import { compileCreditSettlement, compileSwapSettlement } from '../src/prepare/ptbCompiler.js';
import {
  ADDR_CONFIG,
  ADDR_DEEP_COIN,
  ADDR_PAYMENT_COIN,
  ADDR_PKG,
  ADDR_REGISTRY,
  ADDR_USABLE_COIN,
  ADDR_VAULT,
  BASE_AUDIT,
  SETTLEMENT_SWAP_PATH_BFQ,
} from './fixtures/prepareTestFixtures.js';

const SWAP_AMOUNT = 9_000_000n;

const COMPILE_CONTEXT = {
  packageId: ADDR_PKG,
  configId: ADDR_CONFIG,
  vaultRegistryId: ADDR_REGISTRY,
};

type NormalizedCommand = ReturnType<typeof convertSdkCommands>[number];

function makeSwapPlan(overrides: Partial<SettlementPlan> = {}): SettlementPlan {
  return {
    profile: 'with_vault',
    variant: 'with_vault',
    settlementSwapPath: SETTLEMENT_SWAP_PATH_BFQ,
    settlementSwapDirection: 'baseForQuote',
    funding: {
      source: 'coin_object',
      baseCoinId: ADDR_USABLE_COIN,
      mergeCoinIds: [ADDR_DEEP_COIN, ADDR_PAYMENT_COIN],
      remainingBalance: 12_000_000n,
    },
    useCreditAmount: 0n,
    swap: { swapAmountSmallest: SWAP_AMOUNT, minSuiOut: 400_000n },
    audit: BASE_AUDIT,
    ...overrides,
  };
}

function makeCreditPlan(useCreditAmount: bigint): SettlementPlan {
  return {
    profile: 'credit_general',
    settlementSwapPath: SETTLEMENT_SWAP_PATH_BFQ,
    settlementSwapDirection: 'baseForQuote',
    funding: { source: 'none_credit_only' },
    useCreditAmount,
    swap: { swapAmountSmallest: 0n, minSuiOut: 0n },
    audit: { ...BASE_AUDIT, slippageBufferMist: 0n },
  };
}

function normalizedTransaction(tx: Transaction): {
  commands: ReturnType<typeof convertSdkCommands>;
  inputs: unknown[];
} {
  const data = tx.getData() as { commands: unknown[]; inputs: unknown[] };
  return { commands: convertSdkCommands(data.commands), inputs: data.inputs };
}

function requireInputIndex(argument: unknown): number {
  const ref = argument as { $kind?: string; Input?: number } | undefined;
  if (ref?.$kind !== 'Input' || typeof ref.Input !== 'number') {
    throw new Error('Expected direct Input argument');
  }
  return ref.Input;
}

function objectIdForArgument(argument: unknown, inputs: unknown[]): string {
  const inputIndex = requireInputIndex(argument);
  const objectId = extractObjectIdFromInput(inputs[inputIndex] as Record<string, unknown>);
  if (!objectId) throw new Error(`Input ${inputIndex} has no object ID`);
  return objectId;
}

function requireMergePayload(command: NormalizedCommand): {
  destination: unknown;
  sources: unknown[];
} {
  if (command.kind !== 'MergeCoins') throw new Error(`Expected MergeCoins, got ${command.kind}`);
  const payload = command.arguments?.[0] as
    | { destination?: unknown; sources?: unknown[] }
    | undefined;
  if (!payload?.destination || !Array.isArray(payload.sources)) {
    throw new Error('Malformed MergeCoins payload');
  }
  return { destination: payload.destination, sources: payload.sources };
}

function requireSplitPayload(command: NormalizedCommand): { coin: unknown; amounts: unknown[] } {
  if (command.kind !== 'SplitCoins') throw new Error(`Expected SplitCoins, got ${command.kind}`);
  const payload = command.arguments?.[0] as { coin?: unknown; amounts?: unknown[] } | undefined;
  if (!payload?.coin || !Array.isArray(payload.amounts)) {
    throw new Error('Malformed SplitCoins payload');
  }
  return { coin: payload.coin, amounts: payload.amounts };
}

function decodePureU64(argument: unknown, inputs: unknown[]): bigint {
  const inputIndex = requireInputIndex(argument);
  const input = inputs[inputIndex] as { $kind?: string; Pure?: { bytes?: string } } | undefined;
  const encoded = input?.$kind === 'Pure' ? input.Pure?.bytes : undefined;
  if (!encoded) throw new Error(`Input ${inputIndex} is not Pure`);
  const bytes = fromBase64(encoded);
  if (bytes.length !== 8) throw new Error(`Expected exact u64 bytes, got ${bytes.length}`);
  let value = 0n;
  for (let index = 7; index >= 0; index--) {
    value = (value << 8n) | BigInt(bytes[index]!);
  }
  return value;
}

function withdrawalAmounts(inputs: unknown[]): string[] {
  return inputs.flatMap((input) => {
    const record = input as
      | {
          $kind?: string;
          FundsWithdrawal?: { reservation?: { MaxAmountU64?: string } };
        }
      | undefined;
    const amount =
      record?.$kind === 'FundsWithdrawal'
        ? record.FundsWithdrawal?.reservation?.MaxAmountU64
        : undefined;
    return amount === undefined ? [] : [amount];
  });
}

function findSettleCommand(commands: readonly NormalizedCommand[]): MoveCallCommand {
  const command = commands.find(
    (candidate): candidate is MoveCallCommand =>
      candidate.kind === 'MoveCall' && 'packageId' in candidate && candidate.packageId === ADDR_PKG,
  );
  if (!command) throw new Error('Settlement MoveCall not found');
  return command;
}

function extractUseCreditAmount(commands: readonly NormalizedCommand[], inputs: unknown[]): bigint {
  const settle = findSettleCommand(commands);
  const parameterIndex = settlementParameterIndex(settle.function, 'use_credit_amount');
  if (parameterIndex === undefined) throw new Error('Settle function has no use_credit_amount');
  return decodePureU64(settle.arguments[parameterIndex], inputs);
}

function expectFinalIntegrity(
  commands: ReturnType<typeof convertSdkCommands>,
  inputs: unknown[],
  expectation: PaymentInputIntegrityExpectation,
): void {
  const contract = extractSettlePaymentInputContract(commands, inputs, ADDR_PKG);
  expect(validatePaymentInputIntegrity(contract.paymentInputTrace, expectation)).toEqual({
    ok: true,
  });
}

describe('compileSwapSettlement exact materialization', () => {
  it('materializes the resolved coin base and merge IDs without discovery or reselection', () => {
    const tx = new Transaction();
    const plan = makeSwapPlan({ profile: 'new_user', variant: 'new_user', useCreditAmount: 0n });

    const expectation = compileSwapSettlement(tx, plan, COMPILE_CONTEXT, null);
    const { commands, inputs } = normalizedTransaction(tx);

    expect(commands.map((command) => command.kind)).toEqual([
      'MergeCoins',
      'SplitCoins',
      'MoveCall',
    ]);
    const merge = requireMergePayload(commands[0]!);
    expect(objectIdForArgument(merge.destination, inputs)).toBe(ADDR_USABLE_COIN);
    expect(merge.sources.map((source) => objectIdForArgument(source, inputs))).toEqual([
      ADDR_DEEP_COIN,
      ADDR_PAYMENT_COIN,
    ]);
    const split = requireSplitPayload(commands[1]!);
    expect(objectIdForArgument(split.coin, inputs)).toBe(ADDR_USABLE_COIN);
    expect(split.amounts).toHaveLength(1);
    expect(decodePureU64(split.amounts[0], inputs)).toBe(SWAP_AMOUNT);
    expect(expectation).toEqual({
      source: 'coin_object',
      swapAmountSmallest: SWAP_AMOUNT,
      userCommandCount: 0,
      userInputCount: 0,
      baseCoinObjectId: ADDR_USABLE_COIN,
      mergeCoinObjectIds: [ADDR_DEEP_COIN, ADDR_PAYMENT_COIN],
    });
    expectFinalIntegrity(commands, inputs, expectation);
  });

  it('materializes the exact address-balance redeem amount selected by the plan', () => {
    const tx = new Transaction();
    const plan = makeSwapPlan({
      funding: { source: 'address_balance', redeemAmount: SWAP_AMOUNT },
    });

    const expectation = compileSwapSettlement(tx, plan, COMPILE_CONTEXT, ADDR_VAULT);
    const { commands, inputs } = normalizedTransaction(tx);

    expect(commands.map((command) => command.kind)).toEqual(['MoveCall', 'MoveCall']);
    expect(commands[0]).toMatchObject({
      kind: 'MoveCall',
      module: 'coin',
      function: 'redeem_funds',
    });
    expect(withdrawalAmounts(inputs)).toEqual([SWAP_AMOUNT.toString()]);
    expect(expectation).toEqual({
      source: 'address_balance',
      swapAmountSmallest: SWAP_AMOUNT,
      userCommandCount: 0,
      userInputCount: 0,
      addressBalanceRedeemAmount: SWAP_AMOUNT,
    });
    expectFinalIntegrity(commands, inputs, expectation);
  });

  it('materializes the exact mixed base, merge IDs, remaining balance, and redeem delta', () => {
    const tx = new Transaction();
    const remainingBalance = 8_000_000n;
    const redeemAmount = SWAP_AMOUNT - remainingBalance;
    const plan = makeSwapPlan({
      funding: {
        source: 'mixed_topup',
        baseCoinId: ADDR_PAYMENT_COIN,
        mergeCoinIds: [ADDR_USABLE_COIN],
        remainingBalance,
        redeemAmount,
      },
    });

    const expectation = compileSwapSettlement(tx, plan, COMPILE_CONTEXT, ADDR_VAULT);
    const { commands, inputs } = normalizedTransaction(tx);

    expect(commands.map((command) => command.kind)).toEqual([
      'MergeCoins',
      'MoveCall',
      'MergeCoins',
      'SplitCoins',
      'MoveCall',
    ]);
    const directMerge = requireMergePayload(commands[0]!);
    expect(objectIdForArgument(directMerge.destination, inputs)).toBe(ADDR_PAYMENT_COIN);
    expect(directMerge.sources.map((source) => objectIdForArgument(source, inputs))).toEqual([
      ADDR_USABLE_COIN,
    ]);
    const redeemedMerge = requireMergePayload(commands[2]!);
    expect(objectIdForArgument(redeemedMerge.destination, inputs)).toBe(ADDR_PAYMENT_COIN);
    expect((redeemedMerge.sources[0] as { $kind?: string }).$kind).toBe('NestedResult');
    const split = requireSplitPayload(commands[3]!);
    expect(objectIdForArgument(split.coin, inputs)).toBe(ADDR_PAYMENT_COIN);
    expect(decodePureU64(split.amounts[0], inputs)).toBe(SWAP_AMOUNT);
    expect(withdrawalAmounts(inputs)).toEqual([redeemAmount.toString()]);
    expect(expectation).toEqual({
      source: 'mixed_topup',
      swapAmountSmallest: SWAP_AMOUNT,
      userCommandCount: 0,
      userInputCount: 0,
      baseCoinObjectId: ADDR_PAYMENT_COIN,
      mergeCoinObjectIds: [ADDR_USABLE_COIN],
      addressBalanceRedeemAmount: redeemAmount,
    });
    expectFinalIntegrity(commands, inputs, expectation);
  });

  it('reads with-vault credit from the plan root, not from funding', () => {
    const tx = new Transaction();
    const useCreditAmount = 2_500_000n;
    const plan = makeSwapPlan({ useCreditAmount });

    compileSwapSettlement(tx, plan, COMPILE_CONTEXT, ADDR_VAULT);
    const { commands, inputs } = normalizedTransaction(tx);

    expect(extractUseCreditAmount(commands, inputs)).toBe(useCreditAmount);
    expect('useCreditAmount' in plan.funding).toBe(false);
  });
});

describe('compileSwapSettlement fail-closed funding contract', () => {
  it('rejects a merge list that repeats the selected base coin', () => {
    const tx = new Transaction();
    const plan = makeSwapPlan({
      funding: {
        source: 'coin_object',
        baseCoinId: ADDR_USABLE_COIN,
        mergeCoinIds: [ADDR_USABLE_COIN],
        remainingBalance: SWAP_AMOUNT,
      },
    });

    expect(() => compileSwapSettlement(tx, plan, COMPILE_CONTEXT, ADDR_VAULT)).toThrow(
      /appears more than once/,
    );
    expect(tx.getData().commands).toHaveLength(0);
  });

  it('rejects coin-object funding below the exact split amount', () => {
    const tx = new Transaction();
    const plan = makeSwapPlan({
      funding: {
        source: 'coin_object',
        baseCoinId: ADDR_USABLE_COIN,
        mergeCoinIds: [],
        remainingBalance: SWAP_AMOUNT - 1n,
      },
    });

    expect(() => compileSwapSettlement(tx, plan, COMPILE_CONTEXT, ADDR_VAULT)).toThrow(
      /does not contain the resolved swap amount/,
    );
    expect(tx.getData().commands).toHaveLength(0);
  });

  it.each([
    {
      label: 'address-balance',
      funding: { source: 'address_balance', redeemAmount: SWAP_AMOUNT - 1n } as const,
      message: /must redeem the exact swap amount/,
    },
    {
      label: 'mixed',
      funding: {
        source: 'mixed_topup',
        baseCoinId: ADDR_USABLE_COIN,
        mergeCoinIds: [],
        remainingBalance: 4_000_000n,
        redeemAmount: SWAP_AMOUNT - 4_000_000n - 1n,
      } as const,
      message: /exact remaining coin balance with the exact redeem amount/,
    },
  ] satisfies ReadonlyArray<{
    label: string;
    funding: SwapFundingResolution;
    message: RegExp;
  }>)('rejects a wrong $label redeem amount', ({ funding, message }) => {
    const tx = new Transaction();
    const plan = makeSwapPlan({ funding });

    expect(() => compileSwapSettlement(tx, plan, COMPILE_CONTEXT, ADDR_VAULT)).toThrow(message);
    expect(tx.getData().commands).toHaveLength(0);
  });
});

describe('compileCreditSettlement', () => {
  it('materializes credit-only settlement from root useCreditAmount', () => {
    const tx = new Transaction();
    const useCreditAmount = 5_120_000n;
    const expectation = compileCreditSettlement(
      tx,
      makeCreditPlan(useCreditAmount),
      COMPILE_CONTEXT,
      ADDR_VAULT,
    );
    const { commands, inputs } = normalizedTransaction(tx);

    expect(commands.map((command) => command.kind)).toEqual(['MoveCall']);
    expect(extractUseCreditAmount(commands, inputs)).toBe(useCreditAmount);
    expect(expectation).toEqual({ source: 'none_credit_only', swapAmountSmallest: 0n });
    expectFinalIntegrity(commands, inputs, expectation);
  });

  it('rejects a non-zero credit-path slippage buffer before mutation', () => {
    const tx = new Transaction();
    const plan = makeCreditPlan(5_120_000n);
    const invalidPlan: SettlementPlan = {
      ...plan,
      audit: { ...plan.audit, slippageBufferMist: 1n },
    };

    expect(() => compileCreditSettlement(tx, invalidPlan, COMPILE_CONTEXT, ADDR_VAULT)).toThrow(
      /Credit-only PTB requires slippageBufferMist=0/,
    );
    expect(tx.getData().commands).toHaveLength(0);
  });
});
