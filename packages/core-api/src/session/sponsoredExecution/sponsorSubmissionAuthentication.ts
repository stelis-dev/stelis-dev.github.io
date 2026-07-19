import { Transaction } from '@mysten/sui/transactions';
import {
  extractTxSender,
  SenderSignatureError,
  verifySenderSignature,
} from '../sessionPrimitives.js';

const AUTHENTICATED_SUBMISSION = Symbol('AuthenticatedSponsorSubmission');

export interface AuthenticatedSponsorSubmission {
  readonly [AUTHENTICATED_SUBMISSION]: true;
}

export interface AuthenticatedSponsorSubmissionValue {
  readonly txBytes: Uint8Array;
  readonly transaction: Transaction;
  readonly senderAddress: string;
}

export type SponsorSubmissionAuthenticationResult =
  | {
      readonly outcome: 'authenticated';
      readonly submission: AuthenticatedSponsorSubmission;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: 'malformed_transaction' | 'invalid_signature';
      readonly message: string;
    };

const authenticatedValues = new WeakMap<
  AuthenticatedSponsorSubmission,
  AuthenticatedSponsorSubmissionValue
>();

function mintAuthenticatedSubmission(
  value: AuthenticatedSponsorSubmissionValue,
): AuthenticatedSponsorSubmission {
  const submission = Object.freeze({
    [AUTHENTICATED_SUBMISSION]: true as const,
  });
  authenticatedValues.set(submission, Object.freeze({ ...value }));
  return submission;
}

export function readAuthenticatedSponsorSubmission(
  submission: AuthenticatedSponsorSubmission,
): AuthenticatedSponsorSubmissionValue {
  const value = authenticatedValues.get(submission);
  if (!value) {
    throw new TypeError('Authenticated sponsor submission was not issued by its owner');
  }
  return value;
}

/**
 * Authenticate the exact submitted TransactionData once.
 *
 * The returned opaque value binds the original byte-array reference to the
 * single decoded Transaction and its canonical sender. Route policies may
 * inspect that value, but cannot manufacture or replace it.
 */
export async function authenticateSponsorSubmission(input: {
  readonly txBytes: Uint8Array;
  readonly userSignature: string;
}): Promise<SponsorSubmissionAuthenticationResult> {
  let transaction: Transaction;
  let senderAddress: string;
  try {
    transaction = Transaction.from(input.txBytes);
    senderAddress = extractTxSender(transaction);
  } catch (error) {
    return {
      outcome: 'rejected',
      reason: 'malformed_transaction',
      message:
        error instanceof Error ? error.message : 'Submitted transaction could not be deserialized',
    };
  }

  try {
    await verifySenderSignature(input.txBytes, input.userSignature, senderAddress);
  } catch (error) {
    if (error instanceof SenderSignatureError) {
      return {
        outcome: 'rejected',
        reason: 'invalid_signature',
        message: error.message,
      };
    }
    throw error;
  }

  return {
    outcome: 'authenticated',
    submission: mintAuthenticatedSubmission({
      txBytes: input.txBytes,
      transaction,
      senderAddress,
    }),
  };
}
