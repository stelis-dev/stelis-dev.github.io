/**
 * Session helpers — shared sponsor-session lifecycle functions.
 *
 * These functions extract the structural duplication between
 * handleSponsor (generic) and handlePromotionSponsor (promotion).
 *
 * Mode-specific policy (generic re-validation, promotion entitlement)
 * remains internal. Current Sui responses reach these helpers only after the
 * core-relay operation gateways validate their exact SDK unions.
 */
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import {
  executeSuiTransaction,
  simulateSuiTransaction,
  type SuiEndpointSnapshot,
  type SuiExecutionErrorKind,
} from '@stelis/core-relay';
import { assertSuiTransactionDigest } from '@stelis/core-relay/server';
import { logStructuredEvent } from '../structuredEventLog.js';
import { SPONSOR_POOL_CHECKIN_FAILED } from '../observability/events.js';
import type { SponsorPoolAdapter } from '../context.js';
import type { PreflightResult, ExecResult } from './sessionTypes.js';
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

function isConfirmedCongestion(kind: SuiExecutionErrorKind): boolean {
  return kind === 'CongestedObjects' || kind === 'ExecutionCanceledDueToConsensusObjectCongestion';
}

/**
 * Run preflight simulation and return a normalized result.
 * Does NOT throw on simulation failure — returns the structured execution error.
 * Throws only on infrastructure errors (network, RPC).
 */
export async function runPreflight(
  sui: SuiEndpointSnapshot,
  txBytes: Uint8Array,
): Promise<PreflightResult> {
  const result = await simulateSuiTransaction(sui, { transaction: txBytes });
  if (result.outcome === 'failure') {
    return { success: false, error: result.error };
  }
  return { success: true, gasUsed: result.effects.gasUsed };
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
 * The pool `sign(sponsorAddress, receiptId, txBytes)` call verifies the
 * stage-separated executing lease proof installed atomically immediately
 * before signing. The proof binds the stage, receipt, sponsor, validated
 * transaction-bytes hash, and expected Sui transaction digest. A
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
 * `cause` is retained only for internal reconciliation and diagnostics. Public
 * route errors are fixed typed errors and must not expose or parse this text.
 */
export class SponsorPostSignatureUncertaintyError extends Error {
  readonly executionStage = 'after_sponsor_signature' as const;
  readonly expectedDigest: string;
  override readonly cause: unknown;
  constructor(expectedDigest: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(msg);
    this.name = 'SponsorPostSignatureUncertaintyError';
    this.expectedDigest = expectedDigest;
    this.cause = cause;
  }
}

export async function signAndSubmit(
  pool: SponsorPoolAdapter,
  sui: SuiEndpointSnapshot,
  sponsorAddress: string,
  receiptId: string,
  txBytes: Uint8Array,
  userSignature: string,
  expectedDigest: string,
): Promise<ExecResult> {
  // The receipt store authored this durable identity while atomically entering
  // execution. Verify that it still matches these exact bytes before issuing
  // either the sponsor signature or the irreversible execution RPC.
  assertSuiTransactionDigest(txBytes, expectedDigest);

  // Pool throws SponsorLeaseExpiredError directly if the executing lease HMAC
  // lease proof for (receiptId, sponsorAddress, hash(txBytes)) does not match
  // the Redis value — including the case where `entry.txBytesHash` was
  // overwritten under a live executing lease, because the stored
  // Redis proof still references the original transaction-bytes hash. Pre-sign
  // failures rethrow unchanged: the sponsor signature was NOT issued
  // for them, so post-signature uncertainty policies (entitlement consume
  // and sponsored-execution recording) must not apply.
  const sponsorSig = await pool.sign(sponsorAddress, receiptId, txBytes);

  try {
    const result = await executeSuiTransaction(sui, {
      transaction: txBytes,
      expectedDigest,
      signatures: [userSignature, sponsorSig.signature],
    });

    if (result.outcome === 'failure') {
      if (isConfirmedCongestion(result.error.kind)) {
        return {
          success: false,
          executionStage: 'after_sponsor_signature',
          digest: result.digest,
          error: result.error,
          isCongestion: true,
          gasUsed: null,
        };
      }
      return {
        success: false,
        executionStage: 'on_chain',
        digest: result.digest,
        error: result.error,
        isCongestion: false,
        gasUsed: result.effects.gasUsed,
      };
    }

    return {
      success: true,
      executionStage: 'on_chain',
      digest: result.digest,
      effects: result.effects,
      gasUsed: result.effects.gasUsed,
    };
  } catch (submitErr) {
    if (submitErr instanceof SponsorPostSignatureUncertaintyError) {
      throw submitErr;
    }
    throw new SponsorPostSignatureUncertaintyError(expectedDigest, submitErr);
  }
}

// ─────────────────────────────────────────────
// Slot checkin (finally-block helper)
// ─────────────────────────────────────────────

/**
 * Best-effort slot checkin with structured error logging.
 * Safe to call in finally blocks — never throws.
 *
 * This path releases only a lease that remains in the reservation window
 * (for example build failure before `commitPreparedReceipt()`). Committed and
 * executing leases are removed only by the receipt store's atomic mutation.
 *
 * The pool verifies the appropriate stage-specific HMAC proof before
 * deleting the slot; a forged receipt or hash silently no-ops rather
 * than stealing the slot.
 */
export async function safeSlotCheckin(
  pool: SponsorPoolAdapter,
  sponsorAddress: string,
  receiptId: string,
): Promise<void> {
  try {
    await pool.checkin(sponsorAddress, receiptId);
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
