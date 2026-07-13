/**
 * preparePromotionSponsoredHandler — public Studio prepare adapter over the
 * SponsoredExecution prepare runner.
 */
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { OnchainConfig } from '@stelis/core-relay';
import type { PromotionStoreAdapter } from './promotionStore.js';
import type { PromotionExecutionLedger } from './executionLedger.js';
import type { SponsorPoolAdapter } from '../context.js';
import type { PrepareStoreAdapter } from '../store/prepareTypes.js';
import type { PrepareInflightLimiter } from '../store/prepareInflightTypes.js';
import type { VerifiedDeveloperIdentity } from './developerJwtVerifier.js';
import { SponsorLeaseCommitError } from '../store/sponsorLeaseProof.js';
import { logSponsorPoolEvent } from '../sponsorPoolEventLog.js';
import { PREPARE_SLOT_EXHAUSTED } from '../observability/events.js';
import {
  buildStudioPreparedDraftFields,
  createStudioExecutionPolicy,
  projectStudioPrepareResult,
} from '../session/sponsoredExecution/studioExecutionPolicy.js';
import {
  runPrepareStateMachine,
  RunnerLedgerReservationRejectedError,
  RunnerSponsorSlotExhaustedError,
} from '../session/sponsoredExecution/runner.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Dependencies injected by the host (app-api context). */
export interface PromotionPrepareContext {
  /** Sui gRPC client for dry-run / simulation. */
  sui: SuiGrpcClient;
  /** Promotion store — loads promotion record. */
  promotionStore: PromotionStoreAdapter;
  /** Execution ledger — entitlement read + atomic reserve/release. */
  executionLedger: PromotionExecutionLedger;
  /** Sponsor pool — slot checkout/checkin/sign. */
  sponsorPool: SponsorPoolAdapter;
  /** Prepare store — receipt binding. */
  prepareStore: PrepareStoreAdapter;
  /** In-flight gate for expensive prepare work. */
  prepareInflightLimiter: PrepareInflightLimiter;
  /**
   * Returns fresh on-chain Config. Called after inflight admission succeeds.
   * Consistent with how generic prepare handles the config dependency.
   */
  getConfig: () => Promise<OnchainConfig>;
  /**
   * Pre-computed sha256 hex hashes of STUDIO_ALLOWED_TARGETS entries.
   * Global host-level MoveCall target enforcement.
   */
  globalTargetHashes: Set<string>;
}

/** Request parameters for promotion prepare. */
export interface PromotionPrepareParams {
  /** Promotion ID (from path parameter). */
  promotionId: string;
  /** User's Sui wallet address. */
  senderAddress: string;
  /** User's TransactionKind (base64). */
  txKindBytes: string;
  /** Pre-verified developer identity (route owns crypto verification). */
  verifiedIdentity: VerifiedDeveloperIdentity;
  /** Client IP for tracking. */
  clientIp: string;
}

/** Successful promotion prepare result. */
export interface PromotionPrepareResult {
  /** Full transaction bytes — user-signable (base64). */
  txBytes: string;
  /** Unique receipt ID. */
  receiptId: string;
  /** Estimated gas cost (MIST) — the amount reserved from budget+allowance. */
  estimatedGasMist: string;
}

// ─────────────────────────────────────────────
// Error class
// ─────────────────────────────────────────────

export class PromotionPrepareError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusHint: number = 400,
  ) {
    super(message);
    this.name = 'PromotionPrepareError';
  }
}

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

export async function handlePromotionPrepare(
  ctx: PromotionPrepareContext,
  params: PromotionPrepareParams,
): Promise<PromotionPrepareResult> {
  const options = {
    context: {
      sui: ctx.sui,
      promotionStore: ctx.promotionStore,
      executionLedger: ctx.executionLedger,
      sponsorPool: ctx.sponsorPool,
      prepareStore: ctx.prepareStore,
      globalTargetHashes: ctx.globalTargetHashes,
      getConfig: ctx.getConfig,
    },
    prepare: {
      params,
      errors: {
        prepare: (message: string, code: string, statusHint?: number) =>
          new PromotionPrepareError(message, code, statusHint),
      },
    },
  } as const;
  const { policy, state } = createStudioExecutionPolicy(options);

  try {
    return await runPrepareStateMachine(
      {
        inflightLimiter: ctx.prepareInflightLimiter,
        sponsorPool: ctx.sponsorPool,
        prepareStore: ctx.prepareStore,
        executionLedger: ctx.executionLedger,
      },
      {
        senderAddress: params.senderAddress,
        clientIp: params.clientIp,
        ledgerAcquireParams: {
          promotionId: params.promotionId,
          userId: params.verifiedIdentity.userId,
        },
        preparedDraftFields: () => buildStudioPreparedDraftFields(options, state),
        projectResponse: (input) => projectStudioPrepareResult(options, state, input),
      },
      policy,
    );
  } catch (err) {
    if (err instanceof RunnerSponsorSlotExhaustedError) {
      logSponsorPoolEvent(PREPARE_SLOT_EXHAUSTED, {
        route: 'promotion',
        promotion_id: params.promotionId,
      });
      throw new PromotionPrepareError(
        'All sponsor slots are currently in use. Try again shortly.',
        'NO_SPONSOR_SLOT',
        503,
      );
    }
    if (err instanceof RunnerLedgerReservationRejectedError) {
      const code = err.reason === 'unknown' ? 'RESERVATION_REJECTED' : err.reason.toUpperCase();
      const reason = err.reason === 'unknown' ? 'ledger_rejected' : err.reason;
      throw new PromotionPrepareError(`Reservation failed: ${reason}`, code, 422);
    }
    if (err instanceof SponsorLeaseCommitError) {
      throw new PromotionPrepareError(
        `sponsor lease commit failed: ${err.message}`,
        'SPONSOR_LEASE_COMMIT_FAILED',
        500,
      );
    }
    throw err;
  }
}
