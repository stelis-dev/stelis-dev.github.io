import { describe, expect, test } from 'vitest';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import {
  bindCurrentSuiResultToBytes,
  bindCurrentSuiResultToDigest,
} from '../src/suiResultBinding.js';

const REQUEST_BYTES = new Uint8Array([1, 2, 3, 4]);
const REQUEST_DIGEST = TransactionDataBuilder.getDigestFromBytes(REQUEST_BYTES);

function successResult(digest: string) {
  return {
    $kind: 'Transaction',
    Transaction: {
      digest,
      status: { success: true, error: null },
    },
    commandResults: [],
  };
}

describe('current Sui request/result binding', () => {
  test('accepts the current success union only for the requested transaction bytes', () => {
    expect(bindCurrentSuiResultToBytes(successResult(REQUEST_DIGEST), REQUEST_BYTES)).toMatchObject(
      {
        outcome: 'success',
        digest: REQUEST_DIGEST,
      },
    );

    expect(
      bindCurrentSuiResultToBytes(successResult('self-consistent-other-digest'), REQUEST_BYTES),
    ).toBeNull();
  });

  test('accepts a current failure only when its digest matches the digest-owned lookup', () => {
    const failure = {
      $kind: 'FailedTransaction',
      FailedTransaction: {
        digest: REQUEST_DIGEST,
        status: {
          success: false,
          error: { $kind: 'Unknown', message: 'failed', Unknown: null },
        },
      },
      commandResults: [],
    };

    expect(bindCurrentSuiResultToDigest(failure, REQUEST_DIGEST)).toMatchObject({
      outcome: 'failure',
      errorMessage: 'failed',
    });
    expect(bindCurrentSuiResultToDigest(failure, 'different-digest')).toBeNull();
  });

  test('rejects a failure without the current error-message contract', () => {
    expect(
      bindCurrentSuiResultToDigest(
        {
          $kind: 'FailedTransaction',
          FailedTransaction: {
            digest: REQUEST_DIGEST,
            status: { success: false, error: { $kind: 'Unknown', Unknown: null } },
          },
        },
        REQUEST_DIGEST,
      ),
    ).toBeNull();
  });

  test('rejects partial and contradictory union lookalikes', () => {
    expect(bindCurrentSuiResultToBytes({ commandResults: [] }, REQUEST_BYTES)).toBeNull();
    expect(
      bindCurrentSuiResultToBytes(
        {
          ...successResult(REQUEST_DIGEST),
          FailedTransaction: {
            digest: REQUEST_DIGEST,
            status: { success: false, error: { message: 'also failed' } },
          },
        },
        REQUEST_BYTES,
      ),
    ).toBeNull();
  });

  test('rejects effects whose digest or terminal status contradicts the transaction', () => {
    expect(
      bindCurrentSuiResultToBytes(
        {
          ...successResult(REQUEST_DIGEST),
          Transaction: {
            ...successResult(REQUEST_DIGEST).Transaction,
            effects: {
              transactionDigest: 'different-digest',
              status: { success: true, error: null },
            },
          },
        },
        REQUEST_BYTES,
      ),
    ).toBeNull();
    expect(
      bindCurrentSuiResultToBytes(
        {
          ...successResult(REQUEST_DIGEST),
          Transaction: {
            ...successResult(REQUEST_DIGEST).Transaction,
            effects: {
              transactionDigest: REQUEST_DIGEST,
              status: {
                success: false,
                error: { $kind: 'Unknown', message: 'contradiction', Unknown: null },
              },
            },
          },
        },
        REQUEST_BYTES,
      ),
    ).toBeNull();
  });
});
