import { describe, expect, test, vi } from 'vitest';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { TestSwapPair } from '../src/pages/sandbox/testSwapPairs';

const TRANSACTION_BYTES = new Uint8Array([5, 6, 7, 8]);

vi.mock('@mysten/sui/transactions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mysten/sui/transactions')>();
  class Transaction {
    pure = { u64: (value: bigint) => value };
    moveCall() {}
    object(value: string) {
      return value;
    }
    setSender() {}
    async build() {
      return new Uint8Array([5, 6, 7, 8]);
    }
  }
  return { ...actual, Transaction };
});

import { quoteDirectSwapOutput } from '../src/pages/sandbox/deepbookDirectSwap';

const PAIR: TestSwapPair = {
  settlementTokenType: '0x1::coin::COIN',
  label: 'COIN',
  poolId: '0x2',
  baseType: '0x2::sui::SUI',
  quoteType: '0x1::coin::COIN',
  swapDirection: 'swap_exact_base_for_quote',
};

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number((value >> BigInt(index * 8)) & 0xffn);
  }
  return bytes;
}

function simulationResult(digest: string) {
  return {
    $kind: 'Transaction' as const,
    Transaction: { digest, status: { success: true as const, error: null } },
    commandResults: [
      { returnValues: [{ bcs: u64(0n) }, { bcs: u64(1_000_000n) }, { bcs: u64(0n) }] },
    ],
  };
}

function failedSimulationResult(digest: string, message: string) {
  return {
    $kind: 'FailedTransaction' as const,
    FailedTransaction: {
      digest,
      status: {
        success: false as const,
        error: { $kind: 'Unknown', message, Unknown: null },
      },
    },
    commandResults: [
      { returnValues: [{ bcs: u64(0n) }, { bcs: u64(1_000_000n) }, { bcs: u64(0n) }] },
    ],
  };
}

describe('direct DeepBook quote identity', () => {
  test('uses command results bound to the simulated transaction bytes', async () => {
    const digest = TransactionDataBuilder.getDigestFromBytes(TRANSACTION_BYTES);
    const client = {
      simulateTransaction: vi.fn(async () => simulationResult(digest)),
    } as unknown as SuiGrpcClient;

    await expect(
      quoteDirectSwapOutput({
        client,
        deepbookPackageId: '0x3',
        testPair: PAIR,
        inputAmountSmallest: 1_000n,
      }),
    ).resolves.toMatchObject({ expectedOutputSmallest: 1_000_000n });
  });

  test('rejects command results for another transaction', async () => {
    const client = {
      simulateTransaction: vi.fn(async () => simulationResult('different-digest')),
    } as unknown as SuiGrpcClient;

    await expect(
      quoteDirectSwapOutput({
        client,
        deepbookPackageId: '0x3',
        testPair: PAIR,
        inputAmountSmallest: 1_000n,
      }),
    ).rejects.toThrow('malformed or mismatched result');
  });

  test('rejects decodable command results carried by a failed quote transaction', async () => {
    const digest = TransactionDataBuilder.getDigestFromBytes(TRANSACTION_BYTES);
    const client = {
      simulateTransaction: vi.fn(async () => failedSimulationResult(digest, 'quote aborted')),
    } as unknown as SuiGrpcClient;

    await expect(
      quoteDirectSwapOutput({
        client,
        deepbookPackageId: '0x3',
        testPair: PAIR,
        inputAmountSmallest: 1_000n,
      }),
    ).rejects.toThrow('DeepBook quote simulation failed: quote aborted');
  });

  test('rejects a trailing-byte u64 result through the shared exact decoder', async () => {
    const digest = TransactionDataBuilder.getDigestFromBytes(TRANSACTION_BYTES);
    const malformed = simulationResult(digest);
    malformed.commandResults[0].returnValues[1].bcs = new Uint8Array(9);
    const client = {
      simulateTransaction: vi.fn(async () => malformed),
    } as unknown as SuiGrpcClient;

    await expect(
      quoteDirectSwapOutput({
        client,
        deepbookPackageId: '0x3',
        testPair: PAIR,
        inputAmountSmallest: 1_000n,
      }),
    ).rejects.toThrow('exactly 8 bytes, got 9');
  });
});
