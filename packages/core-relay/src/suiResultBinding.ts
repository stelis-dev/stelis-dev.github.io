import { TransactionDataBuilder } from '@mysten/sui/transactions';

type RuntimeRecord = Record<string, unknown>;

/**
 * Current Sui result identity after it has been bound to the request that
 * produced it.
 *
 * The RPC response is not authoritative merely because its union is
 * internally self-consistent. A result for another transaction must not drive
 * execution accounting, quote selection, reconciliation, or user-visible
 * success. This type is returned only after both the current result union and
 * its request digest have been checked.
 */
interface BoundCurrentSuiResultBase {
  readonly digest: string;
  readonly transaction: Readonly<RuntimeRecord>;
  readonly commandResults: readonly unknown[] | undefined;
}

interface BoundCurrentSuiSuccess extends BoundCurrentSuiResultBase {
  readonly outcome: 'success';
}

interface BoundCurrentSuiFailure extends BoundCurrentSuiResultBase {
  readonly outcome: 'failure';
  /** Current Sui failure message validated at the shared RPC boundary. */
  readonly errorMessage: string;
}

type BoundCurrentSuiResult = BoundCurrentSuiSuccess | BoundCurrentSuiFailure;

function isRuntimeRecord(value: unknown): value is RuntimeRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function effectsAgreeWithTransaction(
  transaction: RuntimeRecord,
  expectedSuccess: boolean,
  expectedErrorMessage?: string,
): boolean {
  if (transaction.effects === undefined) return true;
  if (!isRuntimeRecord(transaction.effects)) return false;
  if (transaction.effects.transactionDigest !== transaction.digest) return false;
  if (!isRuntimeRecord(transaction.effects.status)) return false;

  if (expectedSuccess) {
    return transaction.effects.status.success === true && transaction.effects.status.error === null;
  }
  if (
    transaction.effects.status.success !== false ||
    !isRuntimeRecord(transaction.effects.status.error)
  ) {
    return false;
  }
  return transaction.effects.status.error.message === expectedErrorMessage;
}

function bindCurrentSuiResult(
  value: unknown,
  expectedDigest: string,
): BoundCurrentSuiResult | null {
  if (!isRuntimeRecord(value)) return null;

  const commandResults = value.commandResults;
  if (commandResults !== undefined && !Array.isArray(commandResults)) return null;

  let transaction: RuntimeRecord;
  if (value.$kind === 'Transaction') {
    if (value.FailedTransaction !== undefined) return null;
    if (!isRuntimeRecord(value.Transaction)) return null;
    transaction = value.Transaction;
  } else if (value.$kind === 'FailedTransaction') {
    if (value.Transaction !== undefined) return null;
    if (!isRuntimeRecord(value.FailedTransaction)) return null;
    transaction = value.FailedTransaction;
  } else {
    return null;
  }

  if (transaction.digest !== expectedDigest) return null;
  if (!isRuntimeRecord(transaction.status)) return null;
  if (value.$kind === 'Transaction') {
    if (transaction.status.success !== true || transaction.status.error !== null) return null;
    if (!effectsAgreeWithTransaction(transaction, true)) return null;
    return {
      outcome: 'success',
      digest: expectedDigest,
      transaction,
      commandResults,
    };
  }

  if (transaction.status.success !== false || !isRuntimeRecord(transaction.status.error)) {
    return null;
  }
  const errorMessage = transaction.status.error.message;
  if (typeof errorMessage !== 'string' || errorMessage.length === 0) return null;
  if (!effectsAgreeWithTransaction(transaction, false, errorMessage)) return null;
  return {
    outcome: 'failure',
    digest: expectedDigest,
    transaction,
    commandResults,
    errorMessage,
  };
}

/** Bind a current Sui transaction result to a digest-owned RPC request. */
export function bindCurrentSuiResultToDigest(
  value: unknown,
  expectedDigest: string,
): BoundCurrentSuiResult | null {
  if (typeof expectedDigest !== 'string' || expectedDigest.length === 0) return null;
  return bindCurrentSuiResult(value, expectedDigest);
}

/**
 * Bind a current Sui simulation or execution result to the exact transaction
 * bytes sent to the RPC endpoint.
 */
export function bindCurrentSuiResultToBytes(
  value: unknown,
  transactionBytes: Uint8Array,
): BoundCurrentSuiResult | null {
  const expectedDigest = TransactionDataBuilder.getDigestFromBytes(transactionBytes);
  return bindCurrentSuiResult(value, expectedDigest);
}
