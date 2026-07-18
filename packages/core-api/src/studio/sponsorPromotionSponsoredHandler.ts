/**
 * sponsorPromotionSponsoredHandler — public Studio sponsor adapter over the
 * SponsoredExecution sponsor runner.
 */
import type { ChainBoundSuiEndpointSnapshot } from '@stelis/core-relay';
import type { SponsorResultCallback } from '../handlers/sponsorResult.js';
import type { GasUsedFields } from '../session/sessionTypes.js';
import {
  decodeTxBytes,
  SessionDecodeError,
  SponsorPostSignatureUncertaintyError,
} from '../session/sessionPrimitives.js';
import type { PromotionStoreAdapter } from './promotionStore.js';
import type { PromotionExecutionLedger } from './executionLedger.js';
import type { SponsorPoolAdapter } from '../context.js';
import type { SponsoredExecutionStoreAdapter } from '../store/sponsoredExecutionStore.js';
import type { AbuseBlockerAdapter } from '../store/abuseBlockTypes.js';
import type { VerifiedDeveloperIdentity } from './developerJwtVerifier.js';
import type {
  PromotionSponsorErrorCode,
  PromotionSponsorRequest,
  PromotionSponsorResponse,
  SponsorFailureSubcode,
} from '@stelis/contracts';
import {
  createStudioExecutionPolicy,
  createStudioSignAndSubmitPort,
  createStudioSponsorReceiptPolicy,
  buildStudioExecutionRecoveryContext,
  buildStudioSponsorResultMetadata,
  projectStudioSponsorResult,
} from '../session/sponsoredExecution/studioExecutionPolicy.js';
import { runSponsorStateMachine } from '../session/sponsoredExecution/sponsorRunner.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Dependencies injected by the host (app-api context). */
export interface PromotionSponsorContext {
  /** Qualified Sui endpoint snapshot for preflight simulation + TX submission. */
  sui: ChainBoundSuiEndpointSnapshot;
  /**
   * Trusted Stelis package ID for the active network.
   *
   * Used by sponsor-time abort classification so external packages
   * with module `vault` / `settle` and matching abort code cannot be
   * misclassified as Stelis benign subcodes.
   */
  packageId: string;
  /** Current DeepBook published call target used only for abort-command provenance. */
  deepbookPackageId: string;
  /** Promotion store — validate promotion status at sponsor time. */
  promotionStore: PromotionStoreAdapter;
  /** Execution ledger — entitlement read + consume/release. */
  executionLedger: PromotionExecutionLedger;
  /** Sponsor pool — sign TX + checkin. */
  sponsorPool: SponsorPoolAdapter;
  /** Fresh availability check for the sponsor already assigned to the receipt. */
  isSponsorAddressAvailable(sponsorAddress: string): Promise<boolean>;
  /** Receipt store — owns prepared, executing, and final state. */
  sponsoredExecutionStore: SponsoredExecutionStoreAdapter;
  /** Abuse blocker — for recording sponsor failures. */
  abuseBlocker: AbuseBlockerAdapter;
  /** Canonical STUDIO_ALLOWED_TARGETS entries for Host-level MoveCall enforcement. */
  globalAllowedTargets: ReadonlySet<string>;
  /** Host-provided sponsor result callback. */
  onSponsorResult: SponsorResultCallback;
}

/** Request parameters for promotion sponsor. */
interface PromotionSponsorParams extends PromotionSponsorRequest {
  /** Promotion ID (from path parameter). */
  promotionId: string;
  /** Pre-verified developer identity (route owns crypto verification). */
  verifiedIdentity: VerifiedDeveloperIdentity;
  /** Client IP for abuse tracking. */
  clientIp: string;
}

// ─────────────────────────────────────────────
// Error class
// ─────────────────────────────────────────────

export class PromotionSponsorError extends Error {
  constructor(
    message: string,
    public readonly code: PromotionSponsorErrorCode,
    public readonly meta: {
      readonly gasUsed?: GasUsedFields;
      readonly digest?: string;
      readonly subcode?: SponsorFailureSubcode;
    } = {},
  ) {
    super(message);
    this.name = 'PromotionSponsorError';
  }
}

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

export async function handlePromotionSponsor(
  ctx: PromotionSponsorContext,
  params: PromotionSponsorParams,
): Promise<PromotionSponsorResponse> {
  let txBytes: Uint8Array;
  try {
    txBytes = decodeTxBytes(params.txBytes);
  } catch (err) {
    if (err instanceof SessionDecodeError) {
      throw new PromotionSponsorError(err.message, 'BAD_REQUEST');
    }
    throw err;
  }

  const options = {
    context: ctx,
    sponsor: {
      params,
      txBytes,
      userSignature: params.userSignature,
      errors: {
        sponsor: (
          message: string,
          code: PromotionSponsorErrorCode,
          meta?: {
            readonly gasUsed?: GasUsedFields;
            readonly digest?: string;
            readonly subcode?: SponsorFailureSubcode;
          },
        ) => new PromotionSponsorError(message, code, meta),
      },
    },
  } as const;
  const { policy, state } = createStudioExecutionPolicy(options);

  try {
    return await runSponsorStateMachine(
      {
        store: ctx.sponsoredExecutionStore,
        signAndSubmit: createStudioSignAndSubmitPort(options, state),
        endpointCount: ctx.sui.endpointCount,
        onSponsorResult: ctx.onSponsorResult,
        isSponsorAddressAvailable: ctx.isSponsorAddressAvailable,
      },
      {
        hookContext: {
          receiptId: params.receiptId,
          clientIp: params.clientIp,
        },
        txBytes,
        userSignature: params.userSignature,
        buildRecoveryContext: () => buildStudioExecutionRecoveryContext(state),
        buildResultMetadata: (stage) => buildStudioSponsorResultMetadata(state, stage),
        stateChangedError: () =>
          new PromotionSponsorError(
            'Prepared receipt state changed - retry promotion prepare',
            'REPREPARE_REQUIRED',
          ),
        projectResult: () => projectStudioSponsorResult(options, state),
      },
      policy,
      createStudioSponsorReceiptPolicy({
        context: ctx,
        params,
        state,
        errors: options.sponsor.errors,
      }),
    );
  } catch (err) {
    if (err instanceof SponsorPostSignatureUncertaintyError) {
      throw new PromotionSponsorError(
        'Sponsor transaction submission outcome is uncertain',
        'SPONSOR_SUBMISSION_UNCERTAIN',
        { digest: err.expectedDigest },
      );
    }
    throw err;
  }
}
