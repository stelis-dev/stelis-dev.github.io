import { describe, expect, test, vi } from 'vitest';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { signAndExecuteLocalTransaction } from '../src/pages/sandbox/localSuiExecution';

const TRANSACTION_BYTES = new Uint8Array([1, 2, 3, 4]);
const TRANSACTION_DIGEST = TransactionDataBuilder.getDigestFromBytes(TRANSACTION_BYTES);

function transactionStub(): Transaction {
  return {
    setSenderIfNotSet: vi.fn(),
    build: vi.fn(async () => TRANSACTION_BYTES),
  } as unknown as Transaction;
}

function successfulResult(digest: string) {
  return {
    $kind: 'Transaction' as const,
    Transaction: {
      digest,
      status: { success: true as const, error: null },
      effects: {
        transactionDigest: digest,
        status: { success: true as const, error: null },
      },
    },
  };
}

function failedResult(digest: string, message: string) {
  return {
    $kind: 'FailedTransaction' as const,
    FailedTransaction: {
      digest,
      status: {
        success: false as const,
        error: { $kind: 'Unknown', message, Unknown: null },
      },
    },
  };
}

describe('local SUI execution identity', () => {
  test('waits for the digest bound to the submitted bytes', async () => {
    const waitForTransaction = vi.fn();
    const client = {
      executeTransaction: vi.fn(async () => successfulResult(TRANSACTION_DIGEST)),
      waitForTransaction,
    } as unknown as SuiGrpcClient;

    await expect(
      signAndExecuteLocalTransaction({
        transaction: transactionStub(),
        client,
        signer: { signTransaction: vi.fn(async () => ({ signature: 'signature' })) },
        senderAddress: '0x1',
      }),
    ).resolves.toMatchObject({ digest: TRANSACTION_DIGEST });
    expect(waitForTransaction).toHaveBeenCalledWith({ digest: TRANSACTION_DIGEST });
  });

  test('does not wait on a self-consistent result for another transaction', async () => {
    const waitForTransaction = vi.fn();
    const client = {
      executeTransaction: vi.fn(async () => successfulResult('different-digest')),
      waitForTransaction,
    } as unknown as SuiGrpcClient;

    await expect(
      signAndExecuteLocalTransaction({
        transaction: transactionStub(),
        client,
        signer: { signTransaction: vi.fn(async () => ({ signature: 'signature' })) },
        senderAddress: '0x1',
      }),
    ).rejects.toThrow('malformed or mismatched result');
    expect(waitForTransaction).not.toHaveBeenCalled();
  });

  test('does not wait on a bound failed transaction and reports its validated reason', async () => {
    const waitForTransaction = vi.fn();
    const client = {
      executeTransaction: vi.fn(async () => failedResult(TRANSACTION_DIGEST, 'MoveAbort')),
      waitForTransaction,
    } as unknown as SuiGrpcClient;

    await expect(
      signAndExecuteLocalTransaction({
        transaction: transactionStub(),
        client,
        signer: { signTransaction: vi.fn(async () => ({ signature: 'signature' })) },
        senderAddress: '0x1',
      }),
    ).rejects.toThrow('SUI execution failed: MoveAbort');
    expect(waitForTransaction).not.toHaveBeenCalled();
  });

  test('does not report success when the requested effects are missing', async () => {
    const waitForTransaction = vi.fn();
    const client = {
      executeTransaction: vi.fn(async () => ({
        $kind: 'Transaction',
        Transaction: {
          digest: TRANSACTION_DIGEST,
          status: { success: true, error: null },
        },
      })),
      waitForTransaction,
    } as unknown as SuiGrpcClient;

    await expect(
      signAndExecuteLocalTransaction({
        transaction: transactionStub(),
        client,
        signer: { signTransaction: vi.fn(async () => ({ signature: 'signature' })) },
        senderAddress: '0x1',
      }),
    ).rejects.toThrow('no requested effects');
    expect(waitForTransaction).not.toHaveBeenCalled();
  });
});
