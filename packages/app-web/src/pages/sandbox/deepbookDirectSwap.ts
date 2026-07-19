import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { createSuiEndpointSnapshot, getQuantityOut } from '@stelis/core-relay/browser';
import type { TestSwapPair } from './testSwapPairs';

const BPS_DENOMINATOR = 10_000n;

export const DIRECT_SWAP_SLIPPAGE_BPS = 200;

export interface DirectSwapQuote {
  expectedOutputSmallest: bigint;
  minOutputSmallest: bigint;
}

export function calculateMinOutputSmallest(
  expectedOutputSmallest: bigint,
  slippageBps: number,
): bigint {
  if (expectedOutputSmallest <= 0n) {
    throw new Error('DeepBook quote returned no settlement token output');
  }
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error('Direct swap slippage must be a safe integer in [0, 10000)');
  }

  const minOutput =
    (expectedOutputSmallest * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
  if (minOutput <= 0n) {
    throw new Error('DeepBook quote is too small to set a positive minimum output');
  }
  return minOutput;
}

export async function quoteDirectSwapOutput(input: {
  client: SuiGrpcClient;
  deepbookPackageId: string;
  testPair: TestSwapPair;
  inputAmountSmallest: bigint;
  slippageBps?: number;
}): Promise<DirectSwapQuote> {
  if (input.inputAmountSmallest <= 0n) {
    throw new Error('SUI amount must be greater than 0');
  }

  const endpoints = createSuiEndpointSnapshot([input.client]);
  const expectedOutputSmallest = await getQuantityOut(
    endpoints,
    input.deepbookPackageId,
    {
      poolId: input.testPair.poolId,
      baseType: input.testPair.baseType,
      quoteType: input.testPair.quoteType,
      swapDirection:
        input.testPair.swapDirection === 'swap_exact_base_for_quote'
          ? 'baseForQuote'
          : 'quoteForBase',
    },
    input.inputAmountSmallest,
  );
  return {
    expectedOutputSmallest,
    minOutputSmallest: calculateMinOutputSmallest(
      expectedOutputSmallest,
      input.slippageBps ?? DIRECT_SWAP_SLIPPAGE_BPS,
    ),
  };
}
