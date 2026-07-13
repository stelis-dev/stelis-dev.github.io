/**
 * Session helpers — shared sponsor-session lifecycle functions.
 *
 * These functions extract the structural duplication between
 * handleSponsor (generic) and handlePromotionSponsor (promotion).
 *
 * Mode-specific policy (generic re-validation, promotion entitlement)
 * remains internal. The narrow current-Sui result parser is also consumed by
 * app-api so Host execution boundaries share one fail-closed SDK-union authority.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SuiClientTypes } from '@mysten/sui/client';
import { logStructuredEvent } from '../structuredEventLog.js';
import { SPONSOR_POOL_CHECKIN_FAILED } from '../observability/events.js';
import type { SponsorPoolAdapter } from '../context.js';
import type { PrepareStoreAdapter } from '../store/prepareTypes.js';
import type { PreflightResult, ExecResult, ConsumeOutcome, GasUsedFields } from './sessionTypes.js';
// ─────────────────────────────────────────────
// txBytes decode
// ─────────────────────────────────────────────

/**
 * Decode base64-encoded txBytes into raw Uint8Array.
 * Fail-closed: throws on malformed input.
 */
export function decodeTxBytes(encodedTxBytes: string): Uint8Array {
  try {
    return fromBase64(encodedTxBytes);
  } catch {
    throw new SessionDecodeError('Invalid txBytes format');
  }
}

export class SessionDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionDecodeError';
  }
}

// ─────────────────────────────────────────────
// txBytes hash
// ─────────────────────────────────────────────

/** Compute SHA-256 hex digest of raw txBytes. File-local — only used by consumeEntry. */
function computeTxHash(txBytes: Uint8Array): string {
  return createHash('sha256').update(txBytes).digest('hex');
}

// ─────────────────────────────────────────────
// Sender signature verification
// ─────────────────────────────────────────────

/**
 * Extract the canonical `tx.sender` field from a parsed Sui Transaction.
 *
 * Server-owned code paths must derive the signing-authority address from the
 * submitted `txBytes` itself, not from any off-chain store copy. Pair this
 * with `verifySenderSignature` to enforce
 * `signature signer == canonical tx sender` in a visible, testable step.
 *
 * Throws `SenderSignatureError` if the parsed Transaction has no sender
 * (malformed txBytes).
 */
export function extractTxSender(tx: Transaction): string {
  const sender = (tx.getData() as { sender?: string | null }).sender;
  if (!sender) {
    throw new SenderSignatureError('Transaction has no sender — txBytes may be malformed');
  }
  return sender;
}

/**
 * Verify that the user signature is valid for the given txBytes AND
 * that the signer address matches the expected sender.
 *
 * The `expectedSender` argument MUST be the canonical sender derived from
 * the submitted txBytes (see `extractTxSender`). Passing a store-resident
 * sender here silently re-introduces the store-as-authority pattern this
 * module is meant to avoid.
 *
 * Supports ED25519, secp256k1, secp256r1, MultiSig, ZkLogin, Passkey.
 * Throws SenderSignatureError on failure.
 */
export async function verifySenderSignature(
  txBytes: Uint8Array,
  userSignature: string,
  expectedSender: string,
): Promise<void> {
  try {
    await verifyTransactionSignature(txBytes, userSignature, {
      address: expectedSender,
    });
  } catch {
    throw new SenderSignatureError(
      'userSignature is invalid or does not match the canonical tx sender',
    );
  }
}

export class SenderSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SenderSignatureError';
  }
}

// ─────────────────────────────────────────────
// Consume
// ─────────────────────────────────────────────

/**
 * Atomically consume a prepared entry from the store.
 * Returns a normalized ConsumeOutcome — callers map to mode-specific errors.
 */
export async function consumeEntry(
  store: PrepareStoreAdapter,
  receiptId: string,
  txBytes: Uint8Array,
): Promise<ConsumeOutcome> {
  const txHash = computeTxHash(txBytes);
  const result = await store.consume(receiptId, txHash);

  if (result === 'not_found') return { status: 'not_found' };
  if (result === 'expired') return { status: 'expired' };
  if (result === 'hash_mismatch') return { status: 'hash_mismatch' };

  return { status: 'ok', entry: result, txHash };
}

// ─────────────────────────────────────────────
// gasOwner cross-check
// ─────────────────────────────────────────────

/**
 * Extract and verify gasData.owner from a Transaction matches the expected sponsor.
 * Reuses an already-parsed Transaction to avoid redundant deserialization.
 *
 * Returns the gas budget alongside for callers that need it (e.g., L3 nonloss).
 * Throws GasOwnerMismatchError on mismatch.
 */
export function verifyGasOwner(
  tx: Transaction,
  expectedSponsorAddress: string,
): { owner: string; budget: bigint } {
  interface TxDataWithGas {
    gasData?: { owner?: string | null; budget?: string | number | bigint | null } | null;
  }
  const gasData = (tx.getData() as TxDataWithGas).gasData;
  const owner: string | undefined = gasData?.owner ?? undefined;
  if (!owner) {
    throw new GasOwnerMismatchError('Transaction has no gas owner — txBytes may be malformed');
  }
  const budget = gasData?.budget;
  if (budget == null) {
    throw new GasOwnerMismatchError('Transaction has no gas budget — txBytes may be malformed');
  }
  if (owner !== expectedSponsorAddress) {
    throw new GasOwnerMismatchError('gasOwner mismatch — txBytes may have been tampered with');
  }
  return { owner, budget: parseGasBudget(budget) };
}

function parseGasBudget(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new GasOwnerMismatchError('Transaction gas budget is negative');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new GasOwnerMismatchError('Transaction gas budget is not a non-negative safe integer');
    }
    return BigInt(value);
  }
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new GasOwnerMismatchError('Transaction gas budget is not a decimal integer string');
  }
  return BigInt(value);
}

export class GasOwnerMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GasOwnerMismatchError';
  }
}

// ─────────────────────────────────────────────
// Preflight simulation
// ─────────────────────────────────────────────

type RuntimeRecord = Record<string, unknown>;
type CurrentExecutionErrorKind = SuiClientTypes.ExecutionError['$kind'];

const CURRENT_EXECUTION_ERROR_KINDS = [
  'MoveAbort',
  'SizeError',
  'CommandArgumentError',
  'TypeArgumentError',
  'PackageUpgradeError',
  'IndexError',
  'CoinDenyListError',
  'CongestedObjects',
  'ObjectIdError',
  'Unknown',
] as const satisfies readonly CurrentExecutionErrorKind[];

type NormalizedExecutionError = {
  readonly kind: CurrentExecutionErrorKind;
  readonly message: string;
};

type NormalizedExecutionStatus =
  | { readonly success: true; readonly error: null }
  | { readonly success: false; readonly error: NormalizedExecutionError };

export type ParsedSuiTransactionResult =
  | {
      readonly kind: 'success';
      readonly digest: string;
      readonly effects: RuntimeRecord;
      readonly gasUsed: GasUsedFields | null;
    }
  | {
      readonly kind: 'failure';
      readonly digest: string;
      readonly effects: RuntimeRecord;
      readonly gasUsed: GasUsedFields | null;
      readonly error: NormalizedExecutionError;
    };

function isRuntimeRecord(value: unknown): value is RuntimeRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownExecutionErrorKind(_kind: never): false {
  return false;
}

function isCurrentExecutionErrorKind(value: unknown): value is CurrentExecutionErrorKind {
  if (typeof value !== 'string') return false;
  const kind = value as CurrentExecutionErrorKind;
  switch (kind) {
    case 'MoveAbort':
    case 'SizeError':
    case 'CommandArgumentError':
    case 'TypeArgumentError':
    case 'PackageUpgradeError':
    case 'IndexError':
    case 'CoinDenyListError':
    case 'CongestedObjects':
    case 'ObjectIdError':
    case 'Unknown':
      return true;
    default:
      return rejectUnknownExecutionErrorKind(kind);
  }
}

function readCurrentExecutionError(value: unknown): NormalizedExecutionError | null {
  if (!isRuntimeRecord(value) || typeof value.message !== 'string') return null;
  if (!isCurrentExecutionErrorKind(value.$kind)) return null;

  const kind = value.$kind;
  for (const candidate of CURRENT_EXECUTION_ERROR_KINDS) {
    const hasPayload = Object.prototype.hasOwnProperty.call(value, candidate);
    if ((candidate === kind) !== hasPayload) return null;
  }

  if (kind === 'Unknown') {
    if (value.Unknown !== null) return null;
  } else if (kind === 'CongestedObjects') {
    const payload = value.CongestedObjects;
    if (
      !isRuntimeRecord(payload) ||
      typeof payload.name !== 'string' ||
      !Array.isArray(payload.objects) ||
      !payload.objects.every((objectId) => typeof objectId === 'string')
    ) {
      return null;
    }
  } else if (value[kind] == null) {
    return null;
  }

  return { kind, message: value.message };
}

function readCurrentExecutionStatus(value: unknown): NormalizedExecutionStatus | null {
  if (!isRuntimeRecord(value)) return null;
  if (value.success === true) {
    return value.error === null ? { success: true, error: null } : null;
  }
  if (value.success !== false) return null;
  const error = readCurrentExecutionError(value.error);
  return error ? { success: false, error } : null;
}

function isCanonicalGasAmount(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value);
}

function normalizeGasUsed(value: unknown): GasUsedFields | null {
  if (!isRuntimeRecord(value)) return null;
  if (
    !isCanonicalGasAmount(value.computationCost) ||
    !isCanonicalGasAmount(value.storageCost) ||
    !isCanonicalGasAmount(value.storageRebate)
  ) {
    return null;
  }
  return {
    computationCost: value.computationCost,
    storageCost: value.storageCost,
    storageRebate: value.storageRebate,
  };
}

function readTerminalPayload(
  value: unknown,
  expectedSuccess: boolean,
): {
  readonly digest: string;
  readonly status: NormalizedExecutionStatus;
  readonly effects: RuntimeRecord;
  readonly gasUsed: GasUsedFields | null;
} | null {
  if (!isRuntimeRecord(value)) return null;
  if (typeof value.digest !== 'string' || value.digest.length === 0) return null;

  const status = readCurrentExecutionStatus(value.status);
  if (!status || status.success !== expectedSuccess) return null;
  if (!isRuntimeRecord(value.effects)) return null;

  const effectsStatus = readCurrentExecutionStatus(value.effects.status);
  if (!effectsStatus || !isDeepStrictEqual(value.status, value.effects.status)) return null;
  if (value.effects.transactionDigest !== value.digest) return null;

  return {
    digest: value.digest,
    status,
    effects: value.effects,
    gasUsed: normalizeGasUsed(value.effects.gasUsed),
  };
}

export function parseSuiTransactionResult(value: unknown): ParsedSuiTransactionResult | null {
  if (!isRuntimeRecord(value)) return null;

  if (value.$kind === 'Transaction') {
    if (value.FailedTransaction !== undefined) return null;
    const payload = readTerminalPayload(value.Transaction, true);
    if (!payload || !payload.status.success) return null;
    return {
      kind: 'success',
      digest: payload.digest,
      effects: payload.effects,
      gasUsed: payload.gasUsed,
    };
  }

  if (value.$kind === 'FailedTransaction') {
    if (value.Transaction !== undefined) return null;
    const payload = readTerminalPayload(value.FailedTransaction, false);
    if (!payload || payload.status.success) return null;
    return {
      kind: 'failure',
      digest: payload.digest,
      effects: payload.effects,
      gasUsed: payload.gasUsed,
      error: payload.status.error,
    };
  }

  return null;
}

function isConfirmedCongestion(kind: CurrentExecutionErrorKind): boolean {
  switch (kind) {
    case 'CongestedObjects':
      return true;
    case 'MoveAbort':
    case 'SizeError':
    case 'CommandArgumentError':
    case 'TypeArgumentError':
    case 'PackageUpgradeError':
    case 'IndexError':
    case 'CoinDenyListError':
    case 'ObjectIdError':
    case 'Unknown':
      return false;
    default:
      return rejectUnknownExecutionErrorKind(kind);
  }
}

/**
 * Run preflight simulation and return a normalized result.
 * Does NOT throw on simulation failure — returns `{ success: false, reason }`.
 * Throws only on infrastructure errors (network, RPC).
 */
export async function runPreflight(
  sui: SuiGrpcClient,
  txBytes: Uint8Array,
): Promise<PreflightResult> {
  const simResult = await sui.simulateTransaction({
    transaction: txBytes,
    include: { effects: true },
  });
  const terminal = parseSuiTransactionResult(simResult);
  if (!terminal) {
    return { success: false, reason: 'Simulation returned malformed terminal result' };
  }
  if (terminal.kind === 'failure') {
    return { success: false, reason: terminal.error.message };
  }
  if (!terminal.gasUsed) {
    return { success: false, reason: 'Simulation returned no valid gasUsed' };
  }
  return { success: true, gasUsed: terminal.gasUsed };
}

// ─────────────────────────────────────────────
// Sign + Submit
// ─────────────────────────────────────────────

/**
 * Add the sponsor signature and submit a transaction on-chain.
 * Returns a normalized ExecResult.
 *
 * Every exception after the sponsor signature is issued is re-thrown as
 * `SponsorPostSignatureUncertaintyError`. Only a validated terminal result can
 * establish congestion or on-chain execution.
 *
 * The pool `sign(sponsorAddress, receiptId, txBytes)` signature pins lease
 * verification to `HMAC(secret, receiptId || sponsorAddress || hash(txBytes))`,
 * compared against the committed proof the prepare runner installed at
 * `sponsorPool.commit(sponsorAddress, receiptId, buildResult.txBytesHash)`.
 * `sponsorAddress` is the lease identity; `receiptId` and the committed hash
 * bind that lease to one prepared transaction. A
 * Redis-only attacker cannot produce a matching proof for any other
 * `txBytes` because the HMAC secret stays in process env.
 */
/**
 * Typed post-signature uncertainty. Thrown after `pool.sign()` issued the
 * sponsor signature when the Host cannot prove a terminal on-chain result:
 * an RPC exception, a missing transaction union member, or a malformed
 * terminal status/digest.
 *
 * Pre-signature failures from `pool.sign()` propagate unchanged. Route
 * policies use this type, not message text, to distinguish the uncertain
 * post-signature branch from failures that cannot have submitted a sponsor-
 * signed transaction.
 *
 * `cause` carries the underlying RPC or terminal-shape error so callers can
 * preserve the original public error message after recording the typed stage.
 */
export class SponsorPostSignatureUncertaintyError extends Error {
  readonly executionStage = 'after_sponsor_signature' as const;
  override readonly cause: unknown;
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(msg);
    this.name = 'SponsorPostSignatureUncertaintyError';
    this.cause = cause;
  }
}

export async function signAndSubmit(
  pool: SponsorPoolAdapter,
  sui: SuiGrpcClient,
  sponsorAddress: string,
  receiptId: string,
  txBytes: Uint8Array,
  userSignature: string,
): Promise<ExecResult> {
  // Pool throws SponsorLeaseExpiredError directly if the committed HMAC
  // lease proof for (receiptId, sponsorAddress, hash(txBytes)) does not match
  // the Redis value — including the case where `entry.txBytesHash` was
  // overwritten under a live committed lease, because the committed
  // Redis proof still references the original commit digest. Pre-sign
  // failures rethrow unchanged: the sponsor signature was NOT issued
  // for them, so post-signature uncertainty policies (entitlement consume
  // and sponsored-execution recording) must not apply.
  const sponsorSig = await pool.sign(sponsorAddress, receiptId, txBytes);

  try {
    const execResult = await sui.executeTransaction({
      transaction: txBytes,
      signatures: [userSignature, sponsorSig.signature],
      include: { effects: true, events: true },
    });

    const terminal = parseSuiTransactionResult(execResult);
    if (!terminal) {
      throw new Error('Transaction execution returned malformed terminal result');
    }

    if (terminal.kind === 'failure') {
      if (isConfirmedCongestion(terminal.error.kind)) {
        return {
          success: false,
          executionStage: 'after_sponsor_signature',
          digest: terminal.digest,
          reason: terminal.error.message,
          isCongestion: true,
          gasUsed: null,
        };
      }
      return {
        success: false,
        executionStage: 'on_chain',
        digest: terminal.digest,
        reason: terminal.error.message,
        isCongestion: false,
        gasUsed: terminal.gasUsed,
      };
    }

    return {
      success: true,
      executionStage: 'on_chain',
      digest: terminal.digest,
      effects: terminal.effects,
      gasUsed: terminal.gasUsed,
    };
  } catch (submitErr) {
    if (submitErr instanceof SponsorPostSignatureUncertaintyError) {
      throw submitErr;
    }
    throw new SponsorPostSignatureUncertaintyError(submitErr);
  }
}

// ─────────────────────────────────────────────
// Slot checkin (finally-block helper)
// ─────────────────────────────────────────────

/**
 * Best-effort slot checkin with structured error logging.
 * Safe to call in finally blocks — never throws.
 *
 * The pool `checkin` signature is `(sponsorAddress, receiptId, txBytesHash | null)`.
 * Callers pass the prepare commit hash (`txBytesHash`) when releasing a
 * committed lease, and `null` when releasing a lease that only reached the
 * reservation window (for example build/commit failure before
 * `prepareStore.store()`).
 *
 * The pool verifies the appropriate stage-specific HMAC proof before
 * deleting the slot; a forged receipt or hash silently no-ops rather
 * than stealing the slot.
 */
export async function safeSlotCheckin(
  pool: SponsorPoolAdapter,
  sponsorAddress: string,
  receiptId: string,
  txBytesHash: string | null,
): Promise<void> {
  try {
    await pool.checkin(sponsorAddress, receiptId, txBytesHash);
  } catch (checkinErr) {
    logStructuredEvent(
      SPONSOR_POOL_CHECKIN_FAILED,
      {
        sponsor_address: sponsorAddress,
        error: checkinErr instanceof Error ? checkinErr.message : String(checkinErr),
      },
      'error',
    );
  }
}
