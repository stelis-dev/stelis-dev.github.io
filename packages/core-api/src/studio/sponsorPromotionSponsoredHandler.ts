/**
 * sponsorPromotionSponsoredHandler — public Studio sponsor adapter over the
 * SponsoredExecution sponsor runner.
 */
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SponsorResultCallback } from '../handlers/sponsorResult.js';
import { SponsorCongestionError } from '../handlers/sponsor.js';
import type { GasUsedFields } from '../session/index.js';
import { decodeTxBytes, SessionDecodeError } from '../session/index.js';
import type { PromotionStoreAdapter } from './promotionStore.js';
import type { PromotionExecutionLedger } from './executionLedger.js';
import type { PromotionUsageStoreAdapter } from './promotionUsageStore.js';
import type { SponsorPoolAdapter } from '../context.js';
import type { PrepareStoreAdapter } from '../store/prepareTypes.js';
import type { AbuseBlockerAdapter } from '../store/abuseBlockTypes.js';
import type { VerifiedDeveloperIdentity } from './developerJwtVerifier.js';
import type { SponsorFailureSubcode } from '../prepare/prepareErrors.js';
import {
  createStudioExecutionPolicy,
  createStudioSignAndSubmitPort,
  createStudioSponsorConsumeAdapter,
  projectStudioSponsorResult,
} from '../session/sponsoredExecution/studioExecutionPolicy.js';
import { runSponsorStateMachine } from '../session/sponsoredExecution/sponsorRunner.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Dependencies injected by the host (app-api context). */
export interface PromotionSponsorContext {
  /** Sui gRPC client for preflight simulation + TX submission. */
  sui: SuiGrpcClient;
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
  /** Prepare store — consume receipt. */
  prepareStore: PrepareStoreAdapter;
  /** Abuse blocker — for recording sponsor failures. */
  abuseBlocker: AbuseBlockerAdapter;
  /** Usage store — record completed sponsor events. */
  usageStore?: PromotionUsageStoreAdapter | null;
  /** Pre-computed sha256 hex hashes of STUDIO_ALLOWED_TARGETS entries. */
  globalTargetHashes: Set<string>;
  /** Optional host-provided sponsor result callback. */
  onSponsorResult?: SponsorResultCallback;
}

/** Request parameters for promotion sponsor. */
export interface PromotionSponsorParams {
  /** Promotion ID (from path parameter). */
  promotionId: string;
  /** Receipt ID from promotion prepare response. */
  receiptId: string;
  /** Full transaction bytes (base64). */
  txBytes: string;
  /** User's signature (base64). */
  userSignature: string;
  /** Pre-verified developer identity (route owns crypto verification). */
  verifiedIdentity: VerifiedDeveloperIdentity;
  /** Client IP for abuse tracking. */
  clientIp: string;
}

/** Successful promotion sponsor result. */
export interface PromotionSponsorResult {
  /** Transaction digest. */
  digest: string;
  /** Transaction effects. */
  effects: unknown;
  /** Actual gas consumed (MIST). */
  actualGasMist: string;
}

// ─────────────────────────────────────────────
// Error class
// ─────────────────────────────────────────────

export class PromotionSponsorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusHint: number = 400,
    /**
     * Gas burned by an on-chain attempt when retrievable. Set on
     * `code === 'ONCHAIN_REVERT'` when the failure-path effects carry
     * gasUsed; `null` otherwise.
     */
    public readonly gasUsed: GasUsedFields | null = null,
    /**
     * Classified sponsor failure subcode from `classifySponsorFailureSubcode()`.
     */
    public readonly subcode: SponsorFailureSubcode | undefined = undefined,
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
): Promise<PromotionSponsorResult> {
  let txBytes: Uint8Array;
  try {
    txBytes = decodeTxBytes(params.txBytes);
  } catch (err) {
    if (err instanceof SessionDecodeError) {
      throw new PromotionSponsorError(err.message, 'BAD_REQUEST', 400);
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
          code: string,
          statusHint?: number,
          gasUsed?: GasUsedFields | null,
          subcode?: SponsorFailureSubcode,
        ) => new PromotionSponsorError(message, code, statusHint, gasUsed ?? null, subcode),
        sponsorCongestion: (message: string) => new SponsorCongestionError(message),
      },
    },
  } as const;
  const { policy, state } = createStudioExecutionPolicy(options);

  return await runSponsorStateMachine(
    {
      prepareStore: ctx.prepareStore,
      sponsorPool: ctx.sponsorPool,
      executionLedger: ctx.executionLedger,
      signAndSubmit: createStudioSignAndSubmitPort(options, state),
    },
    {
      hookContext: {
        receiptId: params.receiptId,
        clientIp: params.clientIp,
      },
      txBytes,
      userSignature: params.userSignature,
      projectResult: () => projectStudioSponsorResult(options, state),
    },
    policy,
    createStudioSponsorConsumeAdapter({
      context: ctx,
      params,
      state,
      errors: options.sponsor.errors,
    }),
  );
}
