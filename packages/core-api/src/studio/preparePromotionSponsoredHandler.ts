/**
 * preparePromotionSponsoredHandler — public Studio prepare adapter over the
 * SponsoredExecution prepare runner.
 */
import type {
  PromotionPrepareErrorCode,
  PromotionPrepareRequest,
  PromotionPrepareResponse,
} from '@stelis/contracts';
import type { ChainBoundSuiEndpointSnapshot, OnchainConfig } from '@stelis/core-relay';
import type { PromotionStoreAdapter } from './promotionStore.js';
import type { PromotionExecutionLedger } from './executionLedger.js';
import type { SponsorPoolAdapter } from '../context.js';
import type { SponsoredExecutionStoreAdapter } from '../store/sponsoredExecutionStore.js';
import type { PrepareInflightLimiter } from '../store/prepareInflightTypes.js';
import type { VerifiedDeveloperIdentity } from './developerJwtVerifier.js';
import type { ReserveFailureReason } from './domain.js';
import { SponsorLeaseCommitError } from '../store/sponsorLeaseProof.js';
import { logStructuredEvent } from '../structuredEventLog.js';
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
  /** Qualified Sui endpoint snapshot for dry-run / simulation. */
  sui: ChainBoundSuiEndpointSnapshot;
  /** Promotion store — loads promotion record. */
  promotionStore: PromotionStoreAdapter;
  /** Execution ledger — entitlement read + atomic reserve/release. */
  executionLedger: PromotionExecutionLedger;
  /** Sponsor pool — slot checkout/checkin/sign. */
  sponsorPool: SponsorPoolAdapter;
  /** Receipt lifecycle store. */
  sponsoredExecutionStore: SponsoredExecutionStoreAdapter;
  /** In-flight gate for expensive prepare work. */
  prepareInflightLimiter: PrepareInflightLimiter;
  /**
   * Returns fresh on-chain Config. Called after inflight admission succeeds.
   * Consistent with how generic prepare handles the config dependency.
   */
  getConfig: () => Promise<OnchainConfig>;
  /** Canonical STUDIO_ALLOWED_TARGETS entries for Host-level MoveCall enforcement. */
  globalAllowedTargets: ReadonlySet<string>;
}

/** Request parameters for promotion prepare. */
interface PromotionPrepareParams extends PromotionPrepareRequest {
  /** Promotion ID (from path parameter). */
  promotionId: string;
  /** Pre-verified developer identity (route owns crypto verification). */
  verifiedIdentity: VerifiedDeveloperIdentity;
  /** Client IP for tracking. */
  clientIp: string;
}

// ─────────────────────────────────────────────
// Error class
// ─────────────────────────────────────────────

export class PromotionPrepareError extends Error {
  constructor(
    message: string,
    public readonly code: PromotionPrepareErrorCode,
  ) {
    super(message);
    this.name = 'PromotionPrepareError';
  }
}

function reservationFailureCode(reason: ReserveFailureReason): PromotionPrepareErrorCode {
  switch (reason) {
    case 'budget_insufficient':
      return 'BUDGET_INSUFFICIENT';
    case 'entitlement_not_found':
      return 'ENTITLEMENT_NOT_FOUND';
    case 'entitlement_not_active':
      return 'ENTITLEMENT_NOT_ACTIVE';
    case 'entitlement_insufficient':
      return 'ENTITLEMENT_INSUFFICIENT';
    case 'concurrent_reservation':
      return 'ENTITLEMENT_CONCURRENT_RESERVATION';
    case 'record_changed':
      return 'PROMOTION_CURRENT_CONFLICT';
    case 'promotion_not_active':
      return 'PROMOTION_NOT_ACTIVE';
  }
}

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

export async function handlePromotionPrepare(
  ctx: PromotionPrepareContext,
  params: PromotionPrepareParams,
): Promise<PromotionPrepareResponse> {
  const options = {
    context: {
      sui: ctx.sui,
      promotionStore: ctx.promotionStore,
      executionLedger: ctx.executionLedger,
      sponsorPool: ctx.sponsorPool,
      sponsoredExecutionStore: ctx.sponsoredExecutionStore,
      globalAllowedTargets: ctx.globalAllowedTargets,
      getConfig: ctx.getConfig,
    },
    prepare: {
      params,
      errors: {
        prepare: (message: string, code: PromotionPrepareErrorCode) =>
          new PromotionPrepareError(message, code),
      },
    },
  } as const;
  const { policy, state } = createStudioExecutionPolicy(options);

  try {
    return await runPrepareStateMachine(
      {
        inflightLimiter: ctx.prepareInflightLimiter,
        sponsorPool: ctx.sponsorPool,
        sponsoredExecutionStore: ctx.sponsoredExecutionStore,
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
      logStructuredEvent(PREPARE_SLOT_EXHAUSTED, {
        route: 'promotion',
        promotion_id: params.promotionId,
      });
      throw new PromotionPrepareError(
        'All sponsor slots are currently in use. Try again shortly.',
        'NO_SPONSOR_SLOT',
      );
    }
    if (err instanceof RunnerLedgerReservationRejectedError) {
      if (err.reason === 'unknown') {
        throw new Error('Promotion ledger rejected a reservation without a current reason');
      }
      const code = reservationFailureCode(err.reason);
      throw new PromotionPrepareError(`Reservation failed: ${err.reason}`, code);
    }
    if (err instanceof SponsorLeaseCommitError) {
      throw new PromotionPrepareError(
        `sponsor lease commit failed: ${err.message}`,
        'SPONSOR_LEASE_COMMIT_FAILED',
      );
    }
    throw err;
  }
}
