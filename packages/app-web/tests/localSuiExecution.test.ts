import { describe, expect, test, vi } from 'vitest';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SuiTransactionWithEventsResult } from '@stelis/core-relay/browser';

const TRANSACTION_BYTES = new Uint8Array([1, 2, 3, 4]);
const TRANSACTION_DIGEST = TransactionDataBuilder.getDigestFromBytes(TRANSACTION_BYTES);
const { buildSuiTransactionMock, executeSuiTransactionMock } = vi.hoisted(() => ({
  buildSuiTransactionMock: vi.fn(),
  executeSuiTransactionMock: vi.fn(),
}));

vi.mock('@stelis/core-relay/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stelis/core-relay/browser')>();
  return {
    ...actual,
    buildSuiTransaction: buildSuiTransactionMock,
    executeSuiTransaction: executeSuiTransactionMock,
  };
});

import { signAndExecuteLocalTransaction } from '../src/pages/sandbox/localSuiExecution';

function transactionStub(): Transaction {
  return {
    setSenderIfNotSet: vi.fn(),
  } as unknown as Transaction;
}

function result(success: true): SuiTransactionWithEventsResult;
function result(success: false): SuiTransactionWithEventsResult;
function result(success: boolean): SuiTransactionWithEventsResult {
  const error = { kind: 'MoveAbortRaw' as const };
  const effects = {
    version: 2 as const,
    transactionDigest: TRANSACTION_DIGEST,
    status: success
      ? ({ success: true as const, error: null } as const)
      : ({ success: false as const, error } as const),
    gasUsed: {
      computationCost: '1',
      storageCost: '0',
      storageRebate: '0',
      nonRefundableStorageFee: '0',
    },
    eventsDigest: null,
  };
  return success
    ? { outcome: 'success', digest: TRANSACTION_DIGEST, effects, events: [] }
    : { outcome: 'failure', digest: TRANSACTION_DIGEST, effects, events: [], error };
}

function client(): SuiGrpcClient {
  return { network: 'testnet' } as unknown as SuiGrpcClient;
}

describe('local SUI execution', () => {
  test('submits the signed bytes through the shared exact execution gateway', async () => {
    const currentClient = client();
    buildSuiTransactionMock.mockResolvedValueOnce(TRANSACTION_BYTES);
    executeSuiTransactionMock.mockResolvedValueOnce(result(true));

    await expect(
      signAndExecuteLocalTransaction({
        transaction: transactionStub(),
        client: currentClient,
        signer: { signTransaction: vi.fn(async () => ({ signature: 'c2lnbmF0dXJl' })) },
        senderAddress: '0x1',
      }),
    ).resolves.toMatchObject({ digest: TRANSACTION_DIGEST });

    expect(executeSuiTransactionMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpointCount: 1, network: 'testnet' }),
      { transaction: TRANSACTION_BYTES, signatures: ['c2lnbmF0dXJl'] },
    );
    expect(buildSuiTransactionMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpointCount: 1, network: 'testnet' }),
      { transaction: expect.anything() },
    );
  });

  test('reports a validated failed execution without manufacturing success', async () => {
    buildSuiTransactionMock.mockResolvedValueOnce(TRANSACTION_BYTES);
    executeSuiTransactionMock.mockResolvedValueOnce(result(false));

    await expect(
      signAndExecuteLocalTransaction({
        transaction: transactionStub(),
        client: client(),
        signer: { signTransaction: vi.fn(async () => ({ signature: 'c2lnbmF0dXJl' })) },
        senderAddress: '0x1',
      }),
    ).rejects.toThrow('SUI execution failed: Sui execution failed (MoveAbortRaw)');
  });
});
