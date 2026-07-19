/**
 * POST /sponsor — public adapter over the SponsoredExecution sponsor runner.
 *
 * The runner owns the prepared-to-executing transition, reservation reconstruction,
 * one submit, final accounting, and callback delivery. This module keeps the stable
 * public handler signature and error carrier classes consumed by app-api.
 */
import type { HostContext } from '../context.js';
import { readAdmittedClientIp, type AdmittedClientIp } from '../abuseBlocking.js';
import type { RelaySponsorErrorCode, SponsorFailureSubcode } from '@stelis/contracts';
import {
  decodeTxBytes,
  SessionDecodeError,
  SponsorPostSignatureUncertaintyError,
} from '../session/sessionPrimitives.js';
import type { GasUsedFields } from '../session/sessionTypes.js';
import {
  createGenericExecutionPolicy,
  createGenericSignAndSubmitPort,
  createGenericSponsorReceiptPolicy,
  buildGenericExecutionRecoveryContext,
  buildGenericSponsorResultMetadata,
  projectGenericSponsorResult,
  type GenericSponsorErrorFactory,
} from '../session/sponsoredExecution/genericExecutionPolicy.js';
import { runSponsorStateMachine } from '../session/sponsoredExecution/sponsorRunner.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface SponsorParams {
  /** Full transaction bytes (base64) — from /prepare response */
  txBytes: string;
  /** User signature (base64) */
  userSignature: string;
  /** Receipt ID from /prepare response */
  receiptId: string;
}

export interface SponsorResult {
  digest: string;
  effects: unknown;
  executionCostClaim: string;
  /** Echoed orderId from /prepare (undefined if not provided). */
  orderId?: string;
}

// ─────────────────────────────────────────────
// Error classes
// ─────────────────────────────────────────────

/**
 * Thrown when the receiptId is not found, expired, hash mismatch,
 * or the sender is abuse-blocked.
 */
export class SponsorValidationError extends Error {
  constructor(
    public readonly code: RelaySponsorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SponsorValidationError';
  }
}

/**
 * Thrown when the sender is abuse-blocked.
 * Carries retryAfterMs for HTTP 429 Retry-After header.
 * NOT recorded as abuse failure (already-blocked senders don't accumulate counts).
 */
export class SponsorBlockedError extends Error {
  constructor(public readonly retryAfterMs: number | undefined) {
    super('Request temporarily blocked');
    this.name = 'SponsorBlockedError';
  }
}

/**
 * Thrown when preflight simulation predicts the transaction will revert.
 * No gas is burned. Maps to HTTP 422.
 */
export class SponsorPreflightError extends Error {
  constructor(
    public readonly reason: string,
    public readonly subcode?: SponsorFailureSubcode,
  ) {
    super(`Preflight simulation failed: ${reason}`);
    this.name = 'SponsorPreflightError';
  }
}

/**
 * Thrown when a transaction is submitted successfully but reverts on-chain.
 * Includes the digest so clients can look up the failed TX for debugging.
 * Maps to HTTP 422.
 */
export class SponsorOnchainError extends Error {
  constructor(
    public readonly digest: string,
    public readonly onchainError: string,
    public readonly subcode: SponsorFailureSubcode | undefined,
    public readonly gasUsed: GasUsedFields,
  ) {
    super(`Transaction reverted on-chain: ${onchainError}`);
    this.name = 'SponsorOnchainError';
  }
}

/**
 * Thrown when a shared-object transaction is cancelled due to network congestion.
 * No gas is burned (Sui protocol guarantee). Maps to HTTP 503.
 */
export class SponsorCongestionError extends Error {
  constructor(
    message: string,
    public readonly digest: string,
  ) {
    super(message);
    this.name = 'SponsorCongestionError';
  }
}

/**
 * The sponsor signed the exact transaction and submission may have reached
 * Sui, but the Host could not prove a current terminal result. The digest is
 * the reconciliation identity derived before signing.
 */
export class SponsorSubmissionUncertainError extends Error {
  readonly code = 'SPONSOR_SUBMISSION_UNCERTAIN' as const;

  constructor(
    public readonly digest: string,
    public readonly cause: unknown,
  ) {
    super('Sponsor transaction submission outcome is uncertain');
    this.name = 'SponsorSubmissionUncertainError';
  }
}

// Re-export from shared file — pools throw this directly, no string matching needed.
export { SponsorLeaseExpiredError } from '../store/sponsorPoolErrors.js';

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

export async function handleSponsor(
  ctx: HostContext,
  params: SponsorParams,
  /** Opaque proof of successful Host IP admission. */
  admittedClientIp: AdmittedClientIp,
): Promise<SponsorResult> {
  const clientIp = readAdmittedClientIp(admittedClientIp);
  let txBytes: Uint8Array;
  try {
    txBytes = decodeTxBytes(params.txBytes);
  } catch (err) {
    if (err instanceof SessionDecodeError) {
      throw new SponsorPreflightError(err.message);
    }
    throw err;
  }

  const errors: GenericSponsorErrorFactory = {
    sponsorValidation: (code, message) => new SponsorValidationError(code, message),
    sponsorBlocked: (retryAfterMs) => new SponsorBlockedError(retryAfterMs),
    sponsorPreflight: (reason, subcode) => new SponsorPreflightError(reason, subcode),
    sponsorOnchain: (digest, reason, subcode, gasUsed) =>
      new SponsorOnchainError(digest, reason, subcode, gasUsed),
    sponsorCongestion: (message, digest) => new SponsorCongestionError(message, digest),
  };

  const options = {
    hostContext: ctx,
    sponsor: {
      admittedClientIp,
      txBytes,
      userSignature: params.userSignature,
      errors,
    },
  } as const;
  const { policy, state } = createGenericExecutionPolicy(options);

  try {
    return await runSponsorStateMachine(
      {
        store: ctx.sponsoredExecutionStore,
        signAndSubmit: createGenericSignAndSubmitPort(options, state),
        endpointCount: ctx.sui.endpointCount,
        onSponsorResult: ctx.onSponsorResult,
        isSponsorAddressAvailable: ctx.isSponsorAddressAvailable,
      },
      {
        hookContext: {
          receiptId: params.receiptId,
          clientIp,
        },
        txBytes,
        userSignature: params.userSignature,
        buildRecoveryContext: () => buildGenericExecutionRecoveryContext(state),
        buildResultMetadata: (stage) => buildGenericSponsorResultMetadata(state, stage),
        stateChangedError: () =>
          new SponsorValidationError(
            'REPREPARE_REQUIRED',
            'Prepared receipt state changed — retry /prepare',
          ),
        projectResult: () => projectGenericSponsorResult(options, state),
      },
      policy,
      createGenericSponsorReceiptPolicy({
        hostContext: ctx,
        clientIp,
        state,
        errors,
      }),
    );
  } catch (err) {
    if (err instanceof SponsorPostSignatureUncertaintyError) {
      throw new SponsorSubmissionUncertainError(err.expectedDigest, err);
    }
    throw err;
  }
}
