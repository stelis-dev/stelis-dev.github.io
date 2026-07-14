import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  bindCurrentSuiResultToBytes,
  decodeExactU64Bytes,
  SUI_CLOCK_OBJECT_ID,
  SUI_ZERO_ADDRESS,
} from '@stelis/core-relay/browser';
import type { TestSwapPair } from './testSwapPairs';

const BPS_DENOMINATOR = 10_000n;

export const DIRECT_SWAP_SLIPPAGE_BPS = 200;

interface DirectSwapReturnValue {
  bcs?: Uint8Array | number[];
}

interface DirectSwapCommandResult {
  returnValues?: DirectSwapReturnValue[];
}

export interface DirectSwapQuote {
  expectedOutputSmallest: bigint;
  minOutputSmallest: bigint;
}

export function directSwapQuantityOutSpec(testPair: TestSwapPair): {
  moveFunction: 'get_quote_quantity_out_input_fee' | 'get_base_quantity_out_input_fee';
  outputIndex: 0 | 1;
} {
  if (testPair.swapDirection === 'swap_exact_base_for_quote') {
    return { moveFunction: 'get_quote_quantity_out_input_fee', outputIndex: 1 };
  }
  return { moveFunction: 'get_base_quantity_out_input_fee', outputIndex: 0 };
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

  const { moveFunction, outputIndex } = directSwapQuantityOutSpec(input.testPair);
  const tx = new Transaction();
  tx.moveCall({
    target: `${input.deepbookPackageId}::pool::${moveFunction}`,
    typeArguments: [input.testPair.baseType, input.testPair.quoteType],
    arguments: [
      tx.object(input.testPair.poolId),
      tx.pure.u64(input.inputAmountSmallest),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  tx.setSender(SUI_ZERO_ADDRESS);

  const txBytes = await tx.build({ client: input.client });
  const result = await input.client.simulateTransaction({
    transaction: txBytes,
    include: { commandResults: true },
  });

  const bound = bindCurrentSuiResultToBytes(result, txBytes);
  if (!bound) throw new Error('DeepBook quote returned a malformed or mismatched result');
  if (bound.outcome === 'failure') {
    throw new Error(`DeepBook quote simulation failed: ${bound.errorMessage}`);
  }
  const commandResults = bound.commandResults as DirectSwapCommandResult[] | undefined;
  const returnValues = commandResults?.[0]?.returnValues;
  if (!returnValues || returnValues.length < 3) {
    throw new Error(`DeepBook quote returned ${returnValues?.length ?? 0} values; expected 3`);
  }

  const outputBcs = returnValues[outputIndex]?.bcs;
  if (!outputBcs) {
    throw new Error(`DeepBook quote is missing output at return index ${outputIndex}`);
  }

  const expectedOutputSmallest = decodeExactU64Bytes(
    outputBcs instanceof Uint8Array ? outputBcs : new Uint8Array(outputBcs),
  );
  return {
    expectedOutputSmallest,
    minOutputSmallest: calculateMinOutputSmallest(
      expectedOutputSmallest,
      input.slippageBps ?? DIRECT_SWAP_SLIPPAGE_BPS,
    ),
  };
}
