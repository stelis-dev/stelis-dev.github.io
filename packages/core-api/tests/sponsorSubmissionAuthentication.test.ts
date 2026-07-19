import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { toBase58 } from '@mysten/sui/utils';
import { describe, expect, test, vi } from 'vitest';
import {
  authenticateSponsorSubmission,
  readAuthenticatedSponsorSubmission,
  type AuthenticatedSponsorSubmission,
} from '../src/session/sponsoredExecution/sponsorSubmissionAuthentication.js';

async function signedTransaction(keypair: Ed25519Keypair) {
  const tx = new Transaction();
  tx.setSender(keypair.toSuiAddress());
  tx.setGasOwner(`0x${'22'.repeat(32)}`);
  tx.setGasBudget(5_000);
  tx.setGasPrice(1);
  tx.setGasPayment([
    {
      objectId: `0x${'44'.repeat(32)}`,
      version: '1',
      digest: toBase58(new Uint8Array(32).fill(1)),
    },
  ]);
  const txBytes = await tx.build({ onlyTransactionKind: false });
  const userSignature = (await keypair.signTransaction(txBytes)).signature;
  return { txBytes, userSignature };
}

describe('sponsor submission authentication owner', () => {
  test('binds the original bytes, one parsed transaction, and its canonical sender', async () => {
    const keypair = Ed25519Keypair.generate();
    const input = await signedTransaction(keypair);
    const transactionFrom = vi.spyOn(Transaction, 'from');

    try {
      const result = await authenticateSponsorSubmission(input);

      expect(result.outcome).toBe('authenticated');
      if (result.outcome !== 'authenticated') throw new Error(result.message);
      const value = readAuthenticatedSponsorSubmission(result.submission);
      expect(Object.isFrozen(value)).toBe(true);
      expect(value.txBytes).toBe(input.txBytes);
      expect(value.senderAddress).toBe(keypair.toSuiAddress());
      expect(value.transaction).toBeInstanceOf(Transaction);
      expect(transactionFrom).toHaveBeenCalledTimes(1);
    } finally {
      transactionFrom.mockRestore();
    }
  });

  test('returns closed rejection reasons for malformed bytes and a mismatched signer', async () => {
    const keypair = Ed25519Keypair.generate();
    const input = await signedTransaction(keypair);
    const wrongSignature = (await Ed25519Keypair.generate().signTransaction(input.txBytes))
      .signature;

    await expect(
      authenticateSponsorSubmission({ txBytes: new Uint8Array([1, 2, 3]), userSignature: 'x' }),
    ).resolves.toMatchObject({ outcome: 'rejected', reason: 'malformed_transaction' });
    await expect(
      authenticateSponsorSubmission({ txBytes: input.txBytes, userSignature: wrongSignature }),
    ).resolves.toMatchObject({ outcome: 'rejected', reason: 'invalid_signature' });
  });

  test('rejects an object that was not issued by the authentication owner', () => {
    expect(() =>
      readAuthenticatedSponsorSubmission(Object.freeze({}) as AuthenticatedSponsorSubmission),
    ).toThrow('was not issued by its owner');
  });
});
