/**
 * Session helpers — shared sponsor-session lifecycle functions.
 *
 * These functions extract the structural duplication between
 * handleSponsor (generic) and handlePromotionSponsor (promotion).
 *
 * Internal to core-api. Not exported from the package barrel.
 * Mode-specific policy (generic re-validation, promotion entitlement)
 * remains in each handler.
 */
import { createHash } from 'node:crypto';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
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

/**
 * gRPC simulation result shape for FailedTransaction parsing.
 * Internal — matches the transport shape from @mysten/sui/grpc.
 */
interface GrpcFailedTx {
  $kind: 'FailedTransaction';
  FailedTransaction: {
    digest?: string;
    status?: { error?: { message?: string; $kind?: string } };
    effects?: { gasUsed?: GasUsedFields };
  };
}

/** Effects shape that may contain status and gasUsed. */
interface GrpcEffectsWithStatus {
  status?: { success?: boolean; error?: { message?: string; $kind?: string } };
  gasUsed?: GasUsedFields;
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

  // Check for FailedTransaction $kind
  const simFailed = simResult as unknown as { $kind?: string } & Partial<GrpcFailedTx>;
  if (simFailed.$kind === 'FailedTransaction') {
    const f = simFailed.FailedTransaction;
    const reason = f?.status?.error?.message ?? f?.status?.error?.$kind ?? 'unknown';
    return { success: false, reason };
  }

  // Primary success path
  const simTx = simResult.Transaction;
  if (!simTx) {
    return { success: false, reason: 'Simulation returned no transaction result' };
  }
  if (!simTx.status?.success) {
    const reason = simTx.status?.error?.message ?? simTx.status?.error?.$kind ?? 'unknown';
    return { success: false, reason };
  }

  const simEffects = simTx.effects as unknown as GrpcEffectsWithStatus | null | undefined;
  if (!simEffects?.gasUsed) {
    return { success: false, reason: 'Simulation returned no gasUsed' };
  }

  return { success: true, gasUsed: simEffects.gasUsed };
}

// ─────────────────────────────────────────────
// Sign + Submit
// ─────────────────────────────────────────────

/**
 * Add the sponsor signature and submit a transaction on-chain.
 * Returns a normalized ExecResult.
 *
 * Infrastructure-level network errors (not on-chain reverts) are re-thrown.
 *
 * The pool `sign(slotId, receiptId, txBytes)` signature pins lease
 * verification to `HMAC(secret, receiptId || slotId || hash(txBytes))`,
 * compared against the committed proof the prepare runner installed at
 * `sponsorPool.commit(slot, receiptId, buildResult.txBytesHash)`.
 * `receiptId` is the lease identity carried through the HTTP contract; a
 * Redis-only attacker cannot produce a matching proof for any other
 * `txBytes` because the HMAC secret stays in process env.
 */
/**
 * Marker thrown by `signAndSubmit` ONLY when `sui.executeTransaction()`
 * raises a non-congestion exception, i.e. AFTER the sponsor signature
 * was already issued by `pool.sign()` and the TX may have reached the
 * network. Pre-signature failures from `pool.sign()` (such as
 * `SponsorLeaseExpiredError`) propagate unchanged and never wrap into
 * this marker, because the sponsor signature was never issued for
 * those — the leak-free post-signature consume policy must not apply.
 *
 * Handlers use `instanceof SponsorSubmitInfraError` to discriminate
 * post-signature submit-infra (stamp `submit_infra_unknown`, lock
 * sponsor result economics, promotion path consumes the reservation) from
 * pre-signature lease/HMAC failures (no marker, no consume — promotion
 * releases via the existing pre-submit cleanup; generic just rethrows
 * to the route catch-all).
 *
 * `cause` carries the original RPC error so callers can read its
 * `.message` for the marker payload without re-wrapping.
 */
export class SponsorSubmitInfraError extends Error {
  override readonly cause: unknown;
  constructor(submitErr: unknown) {
    const msg = submitErr instanceof Error ? submitErr.message : String(submitErr);
    super(msg);
    this.name = 'SponsorSubmitInfraError';
    this.cause = submitErr;
  }
}

export async function signAndSubmit(
  pool: SponsorPoolAdapter,
  sui: SuiGrpcClient,
  slotId: string,
  receiptId: string,
  txBytes: Uint8Array,
  userSignature: string,
): Promise<ExecResult> {
  // Pool throws SponsorLeaseExpiredError directly if the committed HMAC
  // lease proof for (receiptId, slotId, hash(txBytes)) does not match
  // the Redis value — including the case where `entry.txBytesHash` was
  // overwritten under a live committed lease, because the committed
  // Redis proof still references the original commit digest. Pre-sign
  // failures rethrow unchanged: the sponsor signature was NOT issued
  // for them, so post-signature submit-infra policies (consume,
  // recorder marker) must not apply.
  const sponsorSig = await pool.sign(slotId, receiptId, txBytes);

  let execResult: Awaited<ReturnType<typeof sui.executeTransaction>>;
  try {
    execResult = await sui.executeTransaction({
      transaction: txBytes,
      signatures: [userSignature, sponsorSig.signature],
      include: { effects: true, events: true },
    });
  } catch (submitErr) {
    const msg = submitErr instanceof Error ? submitErr.message : String(submitErr);
    if (msg.includes('ExecutionCancelledDueToSharedObjectCongestion')) {
      // Network-level cancellation — no on-chain execution → no paid gas.
      return { success: false, digest: '', reason: msg, isCongestion: true, gasUsed: null };
    }
    // Post-signature uncertainty — wrap the raw error in the marker
    // class so handlers can opt this single class into the
    // submit-infra cleanup path (and ONLY this class) without
    // pattern-matching on stack traces or message strings.
    throw new SponsorSubmitInfraError(submitErr);
  }

  // Check for FailedTransaction return value
  const execFailed = execResult as unknown as { $kind?: string } & Partial<GrpcFailedTx>;
  if (execFailed.$kind === 'FailedTransaction' && execFailed.FailedTransaction) {
    const failed = execFailed.FailedTransaction;
    const errMsg = failed.status?.error?.message ?? failed.status?.error?.$kind ?? 'unknown';
    const isCongestion =
      failed.status?.error?.$kind === 'ExecutionCancelledDueToSharedObjectCongestion' ||
      errMsg.includes('ExecutionCancelledDueToSharedObjectCongestion');
    // Try to preserve gas accounting for FailedTransaction reverts that
    // burned gas before failing. `effects.gasUsed` may be present even on
    // failure; absent on congestion-class returns.
    const failedGasUsed = failed.effects?.gasUsed ?? null;
    return {
      success: false,
      digest: failed.digest ?? '',
      reason: errMsg,
      isCongestion,
      gasUsed: failedGasUsed,
    };
  }

  const tx = execResult.Transaction;
  if (!tx) {
    throw new Error('Transaction execution returned no result');
  }

  // Fallback status check — execution returned a Transaction object whose
  // effects mark the run as failed. Effects may still carry gasUsed.
  const failedEffects = tx.effects as unknown as GrpcEffectsWithStatus | undefined;
  const status = failedEffects?.status;
  if (status?.success === false) {
    const reason = status.error?.message ?? status.error?.$kind ?? 'unknown';
    return {
      success: false,
      digest: tx.digest,
      reason,
      isCongestion: false,
      gasUsed: failedEffects?.gasUsed ?? null,
    };
  }

  // Extract gasUsed from successful execution (may be null — callers must handle)
  const txEffects = tx.effects as unknown as GrpcEffectsWithStatus | null | undefined;

  return {
    success: true,
    digest: tx.digest,
    effects: tx.effects,
    gasUsed: txEffects?.gasUsed ?? null,
  };
}

// ─────────────────────────────────────────────
// Slot checkin (finally-block helper)
// ─────────────────────────────────────────────

/**
 * Best-effort slot checkin with structured error logging.
 * Safe to call in finally blocks — never throws.
 *
 * The pool `checkin` signature is `(slotId, receiptId, txBytesHash | null)`.
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
  slotId: string,
  receiptId: string,
  txBytesHash: string | null,
): Promise<void> {
  try {
    await pool.checkin(slotId, receiptId, txBytesHash);
  } catch (checkinErr) {
    logStructuredEvent(
      SPONSOR_POOL_CHECKIN_FAILED,
      {
        slotId,
        error: checkinErr instanceof Error ? checkinErr.message : String(checkinErr),
      },
      'error',
    );
  }
}
