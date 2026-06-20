/**
 * Transaction replay for /prepare — deserializes user txKindBytes.
 *
 * txKindBytes is a base64-encoded TransactionKind that contains
 * only user commands (no settle). The Host decodes it, validates
 * via P1, then replays the commands into a new Transaction that
 * also includes settle calls.
 *
 * Uses Sui SDK's Transaction.fromKind() for deserialization.
 */
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { fromBase64 } from '@mysten/sui/utils';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Maximum txKindBytes size for the P0 size check. */
export const MAX_TX_KIND_BYTES = 64 * 1024;

// ─────────────────────────────────────────────
// deserializeUserTxKind
// ─────────────────────────────────────────────

/**
 * Deserialize user's txKindBytes to a Transaction object.
 *
 * Returns a Transaction with only user commands (no gas info, no sender).
 * The caller is responsible for adding settle commands, setting sender/gas.
 *
 * @param txKindBytesBase64  Base64-encoded TransactionKind bytes
 * @param client             SuiGrpcClient for Transaction.fromKind() resolution
 * @throws if txKindBytes exceed MAX_TX_KIND_BYTES or are invalid
 */
export async function deserializeUserTxKind(
  txKindBytesBase64: string,
  _client: SuiGrpcClient,
): Promise<Transaction> {
  // P0: Size check
  let rawBytes: Uint8Array;
  try {
    rawBytes = fromBase64(txKindBytesBase64);
  } catch {
    throw new PrepareValidationError('P0_INVALID_BASE64', 'Malformed base64 in txKindBytes');
  }
  if (rawBytes.length > MAX_TX_KIND_BYTES) {
    throw new PrepareValidationError(
      'P0_TX_KIND_TOO_LARGE',
      `txKindBytes size ${rawBytes.length} exceeds max ${MAX_TX_KIND_BYTES}`,
    );
  }

  // Deserialize TransactionKind → Transaction
  try {
    return Transaction.fromKind(rawBytes);
  } catch (error) {
    throw new PrepareValidationError(
      'P0_INVALID_TX_KIND',
      `Failed to deserialize txKindBytes: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

// ─────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────

/** Thrown when /prepare rejects due to validation (→ HTTP 422 by default). */
export class PrepareValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** Optional diagnostic fields surfaced in the HTTP response body. */
    public readonly meta?: Record<string, string>,
    /** Override the fallback HTTP status when the failure is not a validation issue. */
    public readonly statusHint?: number,
  ) {
    super(message);
    this.name = 'PrepareValidationError';
  }
}
