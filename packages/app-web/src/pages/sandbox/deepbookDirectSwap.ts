import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { TestSwapPair } from './testSwapPairs';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000000000000000000000000000';
const SUI_CLOCK_OBJECT_ID = '0x6';
const BPS_DENOMINATOR = 10_000n;

export const DIRECT_SWAP_SLIPPAGE_BPS = 200;

interface DirectSwapReturnValue {
  bcs?: Uint8Array | number[];
}

interface DirectSwapCommandResult {
  returnValues?: DirectSwapReturnValue[];
}

interface DirectSwapSimResult {
  commandResults?: DirectSwapCommandResult[];
  Transaction?: {
    commandResults?: DirectSwapCommandResult[];
  };
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

export function decodeLittleEndianU64(bytes: Uint8Array): bigint {
  if (bytes.length !== 8) {
    throw new Error(`Expected u64 BCS bytes to be 8 bytes, got ${bytes.length}`);
  }

  let value = 0n;
  for (let i = 0; i < bytes.length; i += 1) {
    value |= BigInt(bytes[i]) << (8n * BigInt(i));
  }
  return value;
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
  tx.setSender(ZERO_ADDRESS);

  const txBytes = await tx.build({ client: input.client });
  const result = await input.client.simulateTransaction({
    transaction: txBytes,
    include: { commandResults: true },
  });

  const quoteResult = result as unknown as DirectSwapSimResult;
  const returnValues =
    quoteResult.commandResults?.[0]?.returnValues ??
    quoteResult.Transaction?.commandResults?.[0]?.returnValues;
  if (!returnValues || returnValues.length < 3) {
    throw new Error(`DeepBook quote returned ${returnValues?.length ?? 0} values; expected 3`);
  }

  const outputBcs = returnValues[outputIndex]?.bcs;
  if (!outputBcs) {
    throw new Error(`DeepBook quote is missing output at return index ${outputIndex}`);
  }

  const expectedOutputSmallest = decodeLittleEndianU64(
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
