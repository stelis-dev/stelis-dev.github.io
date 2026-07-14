/**
 * POST /sponsor — public adapter over the SponsoredExecution sponsor runner.
 *
 * The runner owns consume ordering, reservation handle reconstruction, submit dispatch,
 * sponsor result policy, and finally slot checkin. This module keeps the stable
 * public handler signature and error carrier classes consumed by app-api.
 */
import type { HostContext } from '../context.js';
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
  createGenericSponsorConsumeAdapter,
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
    public readonly subcode?: SponsorFailureSubcode,
    public readonly gasUsed?: GasUsedFields | null,
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

/** Known on-chain success whose Host-side terminal processing could not complete. */
export class SponsorTerminalProcessingError extends Error {
  readonly code = 'GAS_EFFECTS_MISSING' as const;

  constructor(
    message: string,
    public readonly digest: string,
  ) {
    super(message);
    this.name = 'SponsorTerminalProcessingError';
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
  /** Client IP for abuse detection — passed from host route */
  clientIp: string,
): Promise<SponsorResult> {
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
    sponsorTerminalProcessing: (message, digest) =>
      new SponsorTerminalProcessingError(message, digest),
  };

  const options = {
    hostContext: ctx,
    sponsor: {
      txBytes,
      userSignature: params.userSignature,
      errors,
    },
  } as const;
  const { policy, state } = createGenericExecutionPolicy(options);

  try {
    return await runSponsorStateMachine(
      {
        prepareStore: ctx.prepareStore,
        sponsorPool: ctx.sponsorPool,
        signAndSubmit: createGenericSignAndSubmitPort(options, state),
      },
      {
        hookContext: {
          receiptId: params.receiptId,
          clientIp,
        },
        txBytes,
        userSignature: params.userSignature,
        projectResult: () => projectGenericSponsorResult(options, state),
      },
      policy,
      createGenericSponsorConsumeAdapter({
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
