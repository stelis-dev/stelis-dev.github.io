import { describe, expect, it } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { convertSdkCommands, projectSuiInputIdentity } from '@stelis/core-relay';
import {
  extractSettlePaymentInputContract,
  validatePaymentInputIntegrity,
} from '@stelis/core-relay/server';
import type { SettlementPlan } from '../src/prepare/settlePlanTypes.js';
import { compileSwapSettlement } from '../src/prepare/ptbCompiler.js';
import {
  ADDR_CONFIG,
  ADDR_PAYMENT_COIN,
  ADDR_PKG,
  ADDR_REGISTRY,
  ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
  ADDR_VAULT,
  BASE_AUDIT,
  SETTLEMENT_SWAP_PATH_BFQ,
} from './fixtures/prepareTestFixtures.js';

const PREFIX_SPLIT_AMOUNT = 1_000_000n;
const SWAP_AMOUNT = 10_000_000n;

const COMPILE_CONTEXT = {
  packageId: ADDR_PKG,
  configId: ADDR_CONFIG,
  vaultRegistryId: ADDR_REGISTRY,
};

function makePlan(): SettlementPlan {
  return {
    profile: 'with_vault',
    variant: 'with_vault',
    settlementSwapPath: SETTLEMENT_SWAP_PATH_BFQ,
    settlementSwapDirection: 'baseForQuote',
    funding: {
      source: 'coin_object',
      baseCoinId: ADDR_PAYMENT_COIN,
      mergeCoinIds: [],
      remainingBalance: SWAP_AMOUNT,
    },
    useCreditAmount: 0n,
    swap: {
      swapAmountSmallest: SWAP_AMOUNT,
      requiredSwapOutputMist: 350_000n,
      minSuiOut: 400_000n,
    },
    audit: BASE_AUDIT,
  };
}

function splitSourceObjectId(
  command: ReturnType<typeof convertSdkCommands>[number],
  inputs: unknown[],
): string | null {
  if (command.kind !== 'SplitCoins') throw new Error(`Expected SplitCoins, got ${command.kind}`);
  const payload = command.arguments?.[0] as
    | { coin?: { $kind?: string; Input?: number } }
    | undefined;
  const inputIndex = payload?.coin?.Input;
  if (typeof inputIndex !== 'number') return null;
  const identity = projectSuiInputIdentity(inputs[inputIndex]);
  return identity.startsWith('Object:') ? identity.slice('Object:'.length) : null;
}

describe('single-coin prefix value to final payment', () => {
  it('reuses the exact post-prefix coin without a selector, requery, or extra merge', () => {
    const tx = new Transaction();
    const [prefixSplitResult] = tx.splitCoins(tx.object(ADDR_PAYMENT_COIN), [PREFIX_SPLIT_AMOUNT]);
    tx.transferObjects([prefixSplitResult], ADDR_SETTLEMENT_PAYOUT_RECIPIENT);
    const userInputCount = tx.getData().inputs.length;

    const expectation = compileSwapSettlement(tx, makePlan(), COMPILE_CONTEXT, ADDR_VAULT);
    const data = tx.getData() as { commands: unknown[]; inputs: unknown[] };
    const commands = convertSdkCommands(data.commands);

    expect(commands.map((command) => command.kind)).toEqual([
      'SplitCoins',
      'TransferObjects',
      'SplitCoins',
      'MoveCall',
    ]);
    expect(commands.filter((command) => command.kind === 'MergeCoins')).toHaveLength(0);
    expect(splitSourceObjectId(commands[0]!, data.inputs)).toBe(ADDR_PAYMENT_COIN);
    expect(splitSourceObjectId(commands[2]!, data.inputs)).toBe(ADDR_PAYMENT_COIN);
    expect(expectation).toEqual({
      source: 'coin_object',
      swapAmountSmallest: SWAP_AMOUNT,
      userCommandCount: 2,
      userInputCount,
      baseCoinObjectId: ADDR_PAYMENT_COIN,
      mergeCoinObjectIds: [],
    });

    const contract = extractSettlePaymentInputContract(commands, data.inputs, ADDR_PKG);
    expect(validatePaymentInputIntegrity(contract.paymentInputTrace, expectation)).toEqual({
      ok: true,
    });
  });
});
