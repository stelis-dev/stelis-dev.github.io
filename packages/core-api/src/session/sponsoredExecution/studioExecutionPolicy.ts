/**
 * SponsoredExecution - Studio promotion SponsoredExecutionPolicy implementation.
 *
 * Studio promotion SponsoredExecutionPolicy used by the public prepare/sponsor
 * adapters through the prepare and sponsor runners. The policy is per-request:
 * hooks close over request-local runtime state while the
 * runners keep ownership of lifecycle order, reservation
 * acquisition, consume, normalized sign/submit dispatch, and finally
 * slot checkin.
 *
 * Internal module. Not re-exported from the package main barrel.
 */

import { createHash } from 'node:crypto';
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  computeExecutionCostClaim,
  convertSdkCommands,
  GAS_VARIANCE_FIXED_MIST,
  MAX_FINAL_COMMANDS,
} from '@stelis/core-relay';
import type { OnchainConfig } from '@stelis/core-relay';
import { PrepareValidationError, deserializeUserTxKind } from '../../prepare/replay.js';
import {
  classifySponsorFailureSubcode,
  type SponsorFailureSubcode,
} from '../../prepare/prepareErrors.js';
import { PrepareStudioUserQuotaError } from '../../store/prepareErrors.js';
import type { PreparedTxEntry, PromotionPreparedTxEntry } from '../../store/prepareTypes.js';
import type { AbuseBlockerAdapter } from '../../store/abuseBlockTypes.js';
import { logStructuredEvent } from '../../structuredEventLog.js';
import {
  PREPARE_ENTRY_CORRUPT,
  PREPARE_STAGE,
  PROMOTION_GAS_OVERRUN_WARNING,
  PROMOTION_SPONSOR_EXECUTION,
  PROMOTION_SPONSOR_POST_SIGNATURE_UNCERTAINTY,
  PROMOTION_USAGE_RECORDER_FAILED,
  SPONSOR_RESULT_CALLBACK_FAILED,
} from '../../observability/events.js';
import { emitSponsorDriftObserved } from '../../failures.js';
import {
  SERIALIZED_UNKNOWN_ECONOMICS,
  deriveSponsoredExecutionEconomics,
  serializeSponsoredExecutionEconomics,
  unknownSponsoredExecutionEconomics,
} from '../../sponsoredExecution.js';
import type {
  SponsorResultCallback,
  SponsorResultEconomics,
  SponsorResultOutcome,
} from '../../handlers/sponsorResult.js';
import type { SponsorPoolAdapter } from '../../context.js';
import type { PromotionStoreAdapter } from '../../studio/promotionStore.js';
import type { PromotionExecutionLedger } from '../../studio/executionLedger.js';
import type { PromotionUsageStoreAdapter } from '../../studio/promotionUsageStore.js';
import type { VerifiedDeveloperIdentity } from '../../studio/developerJwtVerifier.js';
import {
  PromotionSponsorPolicyError,
  consumeLedgerReservationWithLog,
  releaseLedgerReservationWithLog,
  validatePromotionPreconsumePolicy,
} from '../../studio/promotionSponsorPolicy.js';
import { recordPromotionAbuseEvent } from '../../studio/promotionAbusePolicy.js';
import {
  validatePromotionCommandCount,
  validatePromotionEligibility,
  validatePromotionPtbStructure,
  validatePromotionSponsorWithdrawal,
  validatePromotionTargets,
  type EligibilityFailure,
  type PtbStructureFailure,
} from '../../studio/validation.js';
import { recordSponsorFailureForAbuse } from '../../abuseBlocking.js';
import { mist, type Mist } from '../../internal/brand.js';
import {
  extractTxSender,
  GasOwnerMismatchError,
  parseSuiTransactionResult,
  runPreflight,
  SenderSignatureError,
  signAndSubmit,
  SponsorPostSignatureUncertaintyError,
  verifyGasOwner,
  verifySenderSignature,
} from '../sessionPrimitives.js';
import { safeSlotCheckin } from '../sessionPrimitives.js';
import type { ExecResult, GasUsedFields } from '../sessionTypes.js';
import type { SponsorConsumePolicyAdapter } from '../sponsorLifecycle.js';
import type { SignAndSubmitPort } from './sponsorRunner.js';
import type {
  GasBoundBuildInput,
  GasBoundBuildResult,
  LedgerReservationReconstructionInputs,
  SponsoredExecutionPolicy,
  PostConsumeSponsorContext,
  PromotionPrepareChainSnapshot,
  PreConsumeSponsorContext,
  SharedPostconsumeReconstruction,
} from './index.js';
import type { PrepareDraftPolicyFields, PrepareResponseProjectionInput } from './runner.js';

// -------------------------------------------------------------
// Public factory input shapes
// -------------------------------------------------------------

export interface StudioPolicyContext {
  readonly sui: SuiGrpcClient;
  readonly packageId?: string;
  readonly deepbookPackageId?: string;
  readonly promotionStore: PromotionStoreAdapter;
  readonly executionLedger: PromotionExecutionLedger;
  readonly sponsorPool: SponsorPoolAdapter;
  readonly prepareStore: {
    peek(receiptId: string): Promise<PreparedTxEntry | null>;
    evictPreparedEntry(receiptId: string): Promise<void>;
    checkUserQuota(userId: string): Promise<'ok' | { exceeded: true; limit: number }>;
  };
  readonly abuseBlocker?: AbuseBlockerAdapter;
  readonly usageStore?: PromotionUsageStoreAdapter | null;
  readonly globalTargetHashes: Set<string>;
  readonly getConfig?: () => Promise<OnchainConfig>;
  readonly onSponsorResult?: SponsorResultCallback;
}

export interface StudioPreparePolicyParams {
  readonly promotionId: string;
  readonly senderAddress: string;
  readonly txKindBytes: string;
  readonly verifiedIdentity: VerifiedDeveloperIdentity;
  readonly clientIp: string;
}

export interface StudioSponsorPolicyParams {
  readonly promotionId: string;
  readonly receiptId: string;
  readonly verifiedIdentity: VerifiedDeveloperIdentity;
  readonly clientIp: string;
}

export interface StudioPrepareErrorFactory {
  prepare(message: string, code: string, statusHint?: number): Error;
}

export interface StudioSponsorErrorFactory {
  sponsor(
    message: string,
    code: string,
    statusHint?: number,
    gasUsed?: GasUsedFields | null,
    subcode?: SponsorFailureSubcode,
  ): Error;
  sponsorCongestion(message: string): Error;
}

export interface StudioExecutionPolicyOptions {
  readonly context: StudioPolicyContext;
  readonly prepare?: {
    readonly params: StudioPreparePolicyParams;
    readonly errors: StudioPrepareErrorFactory;
  };
  readonly sponsor?: {
    readonly params: StudioSponsorPolicyParams;
    readonly txBytes: Uint8Array;
    readonly userSignature: string;
    readonly errors: StudioSponsorErrorFactory;
  };
  readonly deps?: Partial<StudioExecutionPolicyDependencies>;
}

export interface StudioExecutionPolicyDependencies {
  readonly classifySponsorFailureSubcode: typeof classifySponsorFailureSubcode;
  readonly consumeLedgerReservationWithLog: typeof consumeLedgerReservationWithLog;
  readonly deserializeUserTxKind: typeof deserializeUserTxKind;
  readonly recordPromotionAbuseEvent: typeof recordPromotionAbuseEvent;
  readonly recordSponsorFailureForAbuse: typeof recordSponsorFailureForAbuse;
  readonly releaseLedgerReservationWithLog: typeof releaseLedgerReservationWithLog;
  readonly runPreflight: typeof runPreflight;
  readonly signAndSubmit: typeof signAndSubmit;
  readonly validatePromotionPreconsumePolicy: typeof validatePromotionPreconsumePolicy;
  readonly verifyGasOwner: typeof verifyGasOwner;
  readonly verifySenderSignature: typeof verifySenderSignature;
}

export interface StudioExecutionPolicyState {
  prepare?: StudioPrepareRuntimeState;
  sponsor?: StudioSponsorRuntimeState;
}

export interface StudioPrepareRuntimeState {
  kindTx?: Transaction;
  config?: OnchainConfig;
  buildResult?: GasBoundBuildResult;
}

export interface StudioSponsorRuntimeState {
  txSender?: string;
  peeked?: PreparedTxEntry;
  peekedPromotion?: PromotionPreparedTxEntry;
  builtTxForValidation?: Transaction;
  prepared?: PromotionPreparedTxEntry;
  sponsorResultOutcome: SponsorResultOutcome;
  sponsorResultDigest?: string;
  sponsorResultEconomics: SponsorResultEconomics;
  actualGasMist?: Mist;
  lastSuccessResult?: Extract<ExecResult, { success: true }>;
}

export class StudioExecutionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioExecutionPolicyError';
  }
}

export interface StudioPreparePolicyResult {
  readonly txBytes: string;
  readonly receiptId: string;
  readonly estimatedGasMist: string;
}

const DEFAULT_DEPS: StudioExecutionPolicyDependencies = {
  classifySponsorFailureSubcode,
  consumeLedgerReservationWithLog,
  deserializeUserTxKind,
  recordPromotionAbuseEvent,
  recordSponsorFailureForAbuse,
  releaseLedgerReservationWithLog,
  runPreflight,
  signAndSubmit,
  validatePromotionPreconsumePolicy,
  verifyGasOwner,
  verifySenderSignature,
};

// -------------------------------------------------------------
// Factory
// -------------------------------------------------------------

export function createStudioExecutionPolicy(options: StudioExecutionPolicyOptions): {
  readonly policy: SponsoredExecutionPolicy<'promotion'>;
  readonly state: StudioExecutionPolicyState;
} {
  const state: StudioExecutionPolicyState = {};
  if (options.prepare) state.prepare = {};
  if (options.sponsor) {
    state.sponsor = {
      sponsorResultOutcome: 'internal_error',
      sponsorResultEconomics: SERIALIZED_UNKNOWN_ECONOMICS,
    };
  }

  const policy: SponsoredExecutionPolicy<'promotion'> = {
    discriminator: 'promotion',
    handleRequirements: {
      gasBoundBuild: {},
      preparedCommit: { ledgerReservation: true },
      sponsorResult: { ledgerReservation: true },
    },
    hooks: {
      Intent: (ctx) => {
        const prepare = requirePrepare(options);
        if (
          ctx.senderAddress !== prepare.params.senderAddress ||
          ctx.clientIp !== prepare.params.clientIp
        ) {
          throw new StudioExecutionPolicyError(
            'studio prepare hook context does not match request-local policy params',
          );
        }
        logPrepareStage('request_received', {
          promotion_id: prepare.params.promotionId,
          sender: prepare.params.senderAddress,
        });
      },
      RequestValidation: async () => runStudioRequestValidation(options, state),
      InflightAdmission: () => {
        logPrepareStage('inflight_admitted');
      },
      ChainSnapshot: async () => runStudioChainSnapshot(options, state),
      ExecutionPolicySelected: () => {},
      SlotFreePlan: () => {},
      SponsorSlotReservationAcquired: (_ctx, sponsorSlot) => {
        logPrepareStage('sponsor_slot_checked_out', {
          sponsor_address: sponsorSlot.sponsorAddress,
        });
      },
      GasBoundBuild: async (_ctx, input) => runStudioGasBoundBuild(options, state, input),
      RouteReservationAfterBuild: (_ctx, _sponsorSlot, ledgerReservation) => {
        const prepare = requirePrepare(options);
        if (
          ledgerReservation.promotionId !== prepare.params.promotionId ||
          ledgerReservation.userId !== prepare.params.verifiedIdentity.userId
        ) {
          throw new StudioExecutionPolicyError(
            'studio ledger reservation handle does not match request identity',
          );
        }
        logPrepareStage('ledger_reserved', {
          promotion_id: ledgerReservation.promotionId,
          receipt_id: ledgerReservation.receiptId,
          reserved_mist: ledgerReservation.reservedGasMist.toString(),
        });
      },
      SelfCheck: () => {
        const prepareState = requirePrepareState(state);
        requireValue(prepareState.buildResult, 'studio buildResult');
      },
      SponsorLeaseCommitted: () => {},
      DecodeSponsorSubmission: async (ctx) => runStudioDecodeSponsorSubmission(options, state, ctx),
      UserSignatureValidation: async (ctx) => runStudioUserSignatureValidation(options, state, ctx),
      Consume: () => {},
      SharedPostconsumeChecks: async (ctx) => runStudioSharedPostconsumeChecks(options, state, ctx),
      PolicyPostconsumeChecks: async (ctx) => runStudioPolicyPostconsumeChecks(options, state, ctx),
      Preflight: async (ctx) => runStudioPreflight(options, state, ctx),
      PolicyApproval: () => {},
      SponsorSign: () => {},
      Submit: () => {},
      ClassifySponsorResult: async (ctx, result) =>
        classifyStudioSponsorResult(options, state, ctx, result),
      Release: async (ctx) => runStudioRelease(options, state, ctx),
    },
  };

  return { policy, state };
}

export function createStudioSponsorConsumeAdapter(input: {
  readonly context: StudioPolicyContext;
  readonly params: StudioSponsorPolicyParams;
  readonly state: StudioExecutionPolicyState;
  readonly errors: StudioSponsorErrorFactory;
  readonly deps?: Partial<StudioExecutionPolicyDependencies>;
}): SponsorConsumePolicyAdapter {
  const promotionExecutionPathKey = `promotion:${input.params.promotionId}`;
  const sponsorContext = requirePromotionPolicyContext(input.context);
  return {
    route: 'promotion',
    onNotFound: () =>
      input.errors.sponsor(
        'Unknown or expired receipt ID - retry promotion prepare',
        'PREPARED_TX_NOT_FOUND',
        404,
      ),
    onExpired: async () => {
      await getDeps(input).releaseLedgerReservationWithLog(
        input.context.executionLedger,
        input.params.receiptId,
        'prepare_expired',
      );
      return input.errors.sponsor(
        'Prepared transaction expired - retry promotion prepare',
        'PREPARED_TX_EXPIRED',
        410,
      );
    },
    onHashMismatch: async () => {
      const state = requireSponsorState(input.state);
      const peekedPromotion = requireValue(
        state.peekedPromotion,
        'peeked promotion prepared entry',
      );
      const d = getDeps(input);
      await d.releaseLedgerReservationWithLog(
        input.context.executionLedger,
        input.params.receiptId,
        'hash_mismatch',
      );
      await d.recordSponsorFailureForAbuse(
        sponsorContext.abuseBlocker,
        input.params.clientIp,
        { kind: 'studio_user', userId: peekedPromotion.userId },
        'TAMPERING_DETECTED',
        { subcode: 'tx_bytes_hash_mismatch', executionPathKey: promotionExecutionPathKey },
      );
      return input.errors.sponsor(
        'txBytes hash mismatch - possible tampering',
        'TAMPERING_DETECTED',
        422,
      );
    },
    onCorrupt: ({ receiptId, err, stage }) =>
      handleStudioCorruptPreparedEntry(input.context, input.params, input.errors, {
        receiptId,
        err,
        stage,
      }),
    validateConsumedEntry: async (entry) => {
      if (entry.mode !== 'promotion') {
        await safeSlotCheckin(
          input.context.sponsorPool,
          entry.sponsorAddress,
          entry.receiptId,
          entry.txBytesHash,
        );
        throw input.errors.sponsor(
          'Consumed entry is not promotion mode - data race or store corruption',
          'MODE_MISMATCH',
          500,
        );
      }
      requireSponsorState(input.state).prepared = entry;
    },
  };
}

export function buildStudioPreparedDraftFields(
  options: StudioExecutionPolicyOptions,
  _state: StudioExecutionPolicyState,
): PrepareDraftPolicyFields {
  const prepare = requirePrepare(options);
  return {
    executionPathKey: `promotion:${prepare.params.promotionId}`,
    orderId: null,
  };
}

export function projectStudioPrepareResult(
  _options: StudioExecutionPolicyOptions,
  state: StudioExecutionPolicyState,
  input: PrepareResponseProjectionInput,
): StudioPreparePolicyResult {
  const prepareState = requirePrepareState(state);
  const buildResult = requireValue(prepareState.buildResult, 'studio buildResult');
  if (input.draft.mode !== 'promotion') {
    throw new StudioExecutionPolicyError('studio prepare projector received non-promotion draft');
  }
  const result = {
    txBytes: input.txBytesBase64,
    receiptId: input.draft.receiptId,
    estimatedGasMist: buildResult.measuredGasMist.toString(),
  };
  logPrepareStage('response_ready');
  return result;
}

export function projectStudioSponsorResult(
  options: StudioExecutionPolicyOptions,
  state: StudioExecutionPolicyState,
): {
  readonly digest: string;
  readonly effects: unknown;
  readonly actualGasMist: string;
} {
  requireSponsor(options);
  const sponsorState = requireSponsorState(state);
  const result = requireValue(sponsorState.lastSuccessResult, 'success ExecResult');
  const actualGasMist = requireValue(sponsorState.actualGasMist, 'actualGasMist');
  return {
    digest: result.digest,
    effects: result.effects,
    actualGasMist: actualGasMist.toString(),
  };
}

export function createStudioSignAndSubmitPort(
  options: StudioExecutionPolicyOptions,
  state: StudioExecutionPolicyState,
): SignAndSubmitPort {
  const d = getDeps(options);
  return async (sponsorAddress, receiptId, txBytes, userSignature) => {
    try {
      return await d.signAndSubmit(
        options.context.sponsorPool,
        options.context.sui,
        sponsorAddress,
        receiptId,
        txBytes,
        userSignature,
      );
    } catch (err) {
      throw await handleStudioSignAndSubmitThrow(options, state, err);
    }
  };
}

// -------------------------------------------------------------
// Prepare hooks
// -------------------------------------------------------------

async function runStudioRequestValidation(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
): Promise<void> {
  const prepare = requirePrepare(options);
  const state = requirePrepareState(runtime);
  const d = getDeps(options);
  const identity = prepare.params.verifiedIdentity;

  if (identity.senderAddress !== prepare.params.senderAddress) {
    throw prepare.errors.prepare(
      'Verified identity senderAddress does not match request senderAddress',
      'SENDER_ADDRESS_MISMATCH',
      403,
    );
  }

  const promotion = await options.context.promotionStore.get(prepare.params.promotionId);
  const entitlement = promotion
    ? await options.context.executionLedger.getEntitlement(
        prepare.params.promotionId,
        identity.userId,
      )
    : null;
  const eligibilityFailure = validatePromotionEligibility(promotion, entitlement);
  if (eligibilityFailure) {
    throw promotionPrepareErrorForEligibility(prepare.errors, eligibilityFailure);
  }

  try {
    state.kindTx = await d.deserializeUserTxKind(prepare.params.txKindBytes, options.context.sui);
  } catch (err) {
    if (err instanceof PrepareValidationError) {
      throw prepare.errors.prepare(err.message, 'BAD_TX_KIND', 400);
    }
    throw err;
  }

  const kindTx = requireValue(state.kindTx, 'studio tx kind');
  const normalizedCommands = convertSdkCommands(kindTx.getData().commands as unknown[]);

  const ptbFailure = validatePromotionPtbStructure(normalizedCommands);
  if (ptbFailure) {
    throw promotionPrepareErrorForPtbStructure(prepare.errors, ptbFailure);
  }

  if (validatePromotionSponsorWithdrawal(kindTx)) {
    throw prepare.errors.prepare(
      'TX contains FundsWithdrawal(Sponsor) - rejected to protect sponsor funds',
      'SPONSOR_WITHDRAWAL_FORBIDDEN',
      403,
    );
  }

  const targetFailure = validatePromotionTargets(
    normalizedCommands,
    options.context.globalTargetHashes,
  );
  if (targetFailure) {
    throw prepare.errors.prepare(
      `Disallowed MoveCall targets: ${targetFailure.disallowedTargets.join(', ')}`,
      'DISALLOWED_TARGET',
      403,
    );
  }

  const commandCountFailure = validatePromotionCommandCount(normalizedCommands);
  if (commandCountFailure) {
    throw prepare.errors.prepare(
      `Promotion transaction must contain 1 to ${MAX_FINAL_COMMANDS} commands; received ${commandCountFailure.commandCount}`,
      'BAD_REQUEST',
      400,
    );
  }

  const quotaCheck = await options.context.prepareStore.checkUserQuota(identity.userId);
  if (quotaCheck !== 'ok') {
    throw new PrepareStudioUserQuotaError(identity.userId, quotaCheck.limit);
  }
}

async function runStudioChainSnapshot(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
): Promise<PromotionPrepareChainSnapshot> {
  const prepare = requirePrepare(options);
  const state = requirePrepareState(runtime);
  if (!options.context.getConfig) {
    throw new StudioExecutionPolicyError('studio prepare requires context.getConfig');
  }
  state.config = await options.context.getConfig();
  logPrepareStage('onchain_snapshot_loaded', {
    promotion_id: prepare.params.promotionId,
    max_claim_mist: state.config.maxClaimMist.toString(),
  });
  return {};
}

async function runStudioGasBoundBuild(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
  input: GasBoundBuildInput,
): Promise<GasBoundBuildResult> {
  const prepare = requirePrepare(options);
  const state = requirePrepareState(runtime);
  const config = requireValue(state.config, 'on-chain config');
  const userTx = requireValue(state.kindTx, 'studio tx kind');
  const sponsorSlot = input.reservationHandles.sponsorSlot;

  userTx.setSender(prepare.params.senderAddress);
  userTx.setGasOwner(sponsorSlot.sponsorAddress);
  userTx.setGasBudget(config.maxClaimMist);
  const dryRunBytes = await userTx.build({ client: options.context.sui });
  const simResult = await options.context.sui.simulateTransaction({
    transaction: dryRunBytes,
    include: { effects: true },
  });
  const simGasUsed = readDryRunGasUsed(simResult);
  const { simGas } = computeExecutionCostClaim(simGasUsed);
  const reserveAmount: Mist = mist(simGas + GAS_VARIANCE_FIXED_MIST);

  if (reserveAmount > config.maxClaimMist) {
    throw prepare.errors.prepare(
      `Estimated gas ${reserveAmount} exceeds per-TX cap ${config.maxClaimMist}`,
      'GAS_EXCEEDS_TX_CAP',
      422,
    );
  }

  userTx.setGasBudget(reserveAmount);
  const finalTxBytes = await userTx.build({ client: options.context.sui });
  const txBytesHash = createHash('sha256').update(finalTxBytes).digest('hex');
  state.buildResult = {
    txBytes: finalTxBytes,
    txBytesHash,
    measuredGasMist: reserveAmount,
  };
  logPrepareStage('gas_bound_build_done', {
    promotion_id: prepare.params.promotionId,
    measured_gas_mist: reserveAmount.toString(),
  });
  return state.buildResult;
}

// -------------------------------------------------------------
// Sponsor hooks
// -------------------------------------------------------------

async function runStudioDecodeSponsorSubmission(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
  ctx: PreConsumeSponsorContext,
): Promise<void> {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  const d = getDeps(options);
  const sponsorContext = requirePromotionPolicyContext(options.context);

  let peeked: PreparedTxEntry | null;
  try {
    peeked = await options.context.prepareStore.peek(ctx.receiptId);
  } catch (err) {
    throw await handleStudioCorruptPreparedEntry(options.context, sponsor.params, sponsor.errors, {
      receiptId: ctx.receiptId,
      err,
      stage: 'peek',
    });
  }

  if (!peeked) {
    throw sponsor.errors.sponsor(
      'Unknown or expired receipt ID - retry promotion prepare',
      'PREPARED_TX_NOT_FOUND',
      404,
    );
  }
  state.peeked = peeked;

  if (peeked.mode !== 'promotion') {
    throw sponsor.errors.sponsor(
      'Receipt was not created via promotion prepare',
      'MODE_MISMATCH',
      422,
    );
  }
  if (peeked.promotionId !== sponsor.params.promotionId) {
    throw sponsor.errors.sponsor(
      `Receipt promotionId "${peeked.promotionId}" does not match path "${sponsor.params.promotionId}"`,
      'PROMOTION_ID_MISMATCH',
      422,
    );
  }
  state.peekedPromotion = peeked;

  try {
    const { builtTx } = await d.validatePromotionPreconsumePolicy(
      sponsorContext,
      {
        promotionId: sponsor.params.promotionId,
        clientIp: sponsor.params.clientIp,
        verifiedIdentity: sponsor.params.verifiedIdentity,
      },
      peeked,
      sponsor.txBytes,
    );
    state.builtTxForValidation = builtTx;
  } catch (err) {
    if (err instanceof PromotionSponsorPolicyError) {
      throw sponsor.errors.sponsor(err.message, err.code, err.statusHint);
    }
    throw err;
  }
}

async function runStudioUserSignatureValidation(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
  ctx: PreConsumeSponsorContext,
): Promise<void> {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  const d = getDeps(options);
  const sponsorContext = requirePromotionPolicyContext(options.context);
  const builtTx = requireValue(state.builtTxForValidation, 'studio builtTxForValidation');
  const peekedPromotion = requireValue(state.peekedPromotion, 'peeked promotion prepared entry');
  const identity = sponsor.params.verifiedIdentity;

  try {
    state.txSender = extractTxSender(builtTx);
  } catch (err) {
    if (err instanceof SenderSignatureError) {
      throw sponsor.errors.sponsor(err.message, 'SENDER_SIGNATURE_INVALID', 422);
    }
    throw err;
  }

  const txSender = requireValue(state.txSender, 'tx sender');
  if (txSender !== peekedPromotion.senderAddress) {
    await d.recordPromotionAbuseEvent(
      sponsorContext.abuseBlocker,
      ctx.clientIp,
      { kind: 'studio_user', userId: peekedPromotion.userId },
      'PROMO_SENDER_SIGNATURE_INVALID',
      {
        promotionId: sponsor.params.promotionId,
        userId: identity.userId,
        detail: 'canonical_sender_mismatch',
      },
    );
    throw sponsor.errors.sponsor(
      'canonical tx.sender does not match prepared senderAddress',
      'SENDER_SIGNATURE_INVALID',
      422,
    );
  }

  try {
    await d.verifySenderSignature(sponsor.txBytes, sponsor.userSignature, txSender);
  } catch (err) {
    if (err instanceof SenderSignatureError) {
      await d.recordPromotionAbuseEvent(
        sponsorContext.abuseBlocker,
        ctx.clientIp,
        { kind: 'studio_user', userId: peekedPromotion.userId },
        'PROMO_SENDER_SIGNATURE_INVALID',
        {
          promotionId: sponsor.params.promotionId,
          userId: identity.userId,
          detail: 'sender_signature_invalid',
        },
      );
      throw sponsor.errors.sponsor(err.message, 'SENDER_SIGNATURE_INVALID', 422);
    }
    throw err;
  }
}

async function runStudioSharedPostconsumeChecks(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
  ctx: PostConsumeSponsorContext,
): Promise<SharedPostconsumeReconstruction> {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  const d = getDeps(options);
  const prepared = requireValue(state.prepared, 'consumed promotion prepared entry');
  const peekedPromotion = requireValue(state.peekedPromotion, 'peeked promotion prepared entry');
  const builtTx = requireValue(state.builtTxForValidation, 'studio builtTxForValidation');

  let gasBudget: bigint;
  try {
    ({ budget: gasBudget } = d.verifyGasOwner(builtTx, prepared.sponsorAddress));
  } catch (err) {
    if (err instanceof GasOwnerMismatchError) {
      await d.releaseLedgerReservationWithLog(
        options.context.executionLedger,
        sponsor.params.receiptId,
        'gas_owner_mismatch',
      );
      emitSponsorDriftObserved({
        stage: 'gas_owner_mismatch',
        subcode: 'GAS_OWNER_MISMATCH',
        route: 'promotion',
        promotionId: sponsor.params.promotionId,
        receiptId: prepared.receiptId,
        sender: peekedPromotion.senderAddress,
        clientIp: ctx.clientIp,
      });
      setUnknownTerminal(state, 'validation_failure', err.message);
      throw sponsor.errors.sponsor(err.message, 'REPREPARE_REQUIRED', 422);
    }
    throw err;
  }

  if (gasBudget !== prepared.reservedGasMist) {
    await d.releaseLedgerReservationWithLog(
      options.context.executionLedger,
      sponsor.params.receiptId,
      'gas_budget_parity_mismatch',
    );
    emitSponsorDriftObserved({
      stage: 'gas_budget_parity_mismatch',
      subcode: 'GAS_BUDGET_PARITY_MISMATCH',
      route: 'promotion',
      promotionId: sponsor.params.promotionId,
      receiptId: prepared.receiptId,
      sender: peekedPromotion.senderAddress,
      clientIp: ctx.clientIp,
    });
    const message = `Gas budget drift: built tx budget ${gasBudget} mismatches reserved ${prepared.reservedGasMist}`;
    setUnknownTerminal(state, 'validation_failure', message);
    throw sponsor.errors.sponsor(message, 'REPREPARE_REQUIRED', 422);
  }

  return {};
}

async function runStudioPolicyPostconsumeChecks(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
  ctx: PostConsumeSponsorContext,
): Promise<{ readonly ledgerReservation: LedgerReservationReconstructionInputs }> {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  const prepared = requireValue(state.prepared, 'consumed promotion prepared entry');
  const peekedPromotion = requireValue(state.peekedPromotion, 'peeked promotion prepared entry');

  const entitlement = await options.context.executionLedger.getEntitlement(
    prepared.promotionId,
    prepared.userId,
  );
  const amountMatches =
    entitlement?.activeReservationAmountMist === prepared.reservedGasMist.toString();
  const receiptMatches = entitlement?.activeReservationReceiptId === prepared.receiptId;
  if (!entitlement || !receiptMatches || !amountMatches) {
    if (receiptMatches) {
      await getDeps(options).releaseLedgerReservationWithLog(
        options.context.executionLedger,
        prepared.receiptId,
        'ledger_reservation_mismatch',
      );
    }
    emitSponsorDriftObserved({
      stage: 'ledger_reservation_mismatch',
      subcode: 'LEDGER_RESERVATION_MISMATCH',
      route: 'promotion',
      promotionId: sponsor.params.promotionId,
      receiptId: prepared.receiptId,
      sender: peekedPromotion.senderAddress,
      clientIp: ctx.clientIp,
    });
    const message = 'Promotion ledger reservation no longer matches the consumed prepared entry';
    setUnknownTerminal(state, 'validation_failure', message);
    throw sponsor.errors.sponsor(message, 'REPREPARE_REQUIRED', 422);
  }

  return {
    ledgerReservation: {
      receiptId: prepared.receiptId,
      promotionId: prepared.promotionId,
      userId: prepared.userId,
      reservedGasMist: prepared.reservedGasMist,
      ledgerLookupVerified: true,
    },
  };
}

async function runStudioPreflight(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
  ctx: PostConsumeSponsorContext,
): Promise<void> {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  const d = getDeps(options);
  const sponsorContext = requireSponsorPolicyContext(options.context);
  const prepared = requireValue(state.prepared, 'consumed promotion prepared entry');
  const peekedPromotion = requireValue(state.peekedPromotion, 'peeked promotion prepared entry');
  const builtTx = requireValue(state.builtTxForValidation, 'validated promotion transaction');
  const commands = convertSdkCommands(builtTx.getData().commands as unknown[]);
  const preflight = await d.runPreflight(options.context.sui, sponsor.txBytes);

  if (!preflight.success) {
    await d.releaseLedgerReservationWithLog(
      options.context.executionLedger,
      sponsor.params.receiptId,
      'preflight_simulation_failed',
    );
    const subcode = d.classifySponsorFailureSubcode(preflight.reason, sponsorContext.packageId, {
      kind: 'direct',
      commands,
      deepbookPackageId: sponsorContext.deepbookPackageId,
    });
    await d.recordSponsorFailureForAbuse(
      sponsorContext.abuseBlocker,
      ctx.clientIp,
      { kind: 'studio_user', userId: peekedPromotion.userId },
      'PREFLIGHT_FAILED',
      {
        subcode: subcode ?? 'simulation_failed',
        executionPathKey: prepared.executionPathKey,
      },
    );
    setUnknownTerminal(state, 'preflight_failure', `preflight_failure: ${preflight.reason}`);
    throw sponsor.errors.sponsor(
      `Preflight simulation failed: ${preflight.reason}`,
      'PREFLIGHT_FAILED',
      422,
      null,
      subcode,
    );
  }
}

async function classifyStudioSponsorResult(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
  ctx: PostConsumeSponsorContext,
  result: ExecResult,
): Promise<void> {
  requireValue(ctx.ledgerReservation, 'ledger reservation handle');
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  const d = getDeps(options);
  const sponsorContext = requireSponsorPolicyContext(options.context);
  const prepared = requireValue(state.prepared, 'consumed promotion prepared entry');
  const peekedPromotion = requireValue(state.peekedPromotion, 'peeked promotion prepared entry');
  const builtTx = requireValue(state.builtTxForValidation, 'validated promotion transaction');
  const commands = convertSdkCommands(builtTx.getData().commands as unknown[]);
  const identity = sponsor.params.verifiedIdentity;

  if (!result.success) {
    if (result.isCongestion) {
      await d.releaseLedgerReservationWithLog(
        options.context.executionLedger,
        sponsor.params.receiptId,
        'congestion',
      );
      setUnknownTerminal(state, 'congestion', `congestion: ${result.reason}`);
      state.sponsorResultDigest = result.digest;
      throw sponsor.errors.sponsorCongestion(result.reason);
    }

    const classifiedSubcode = d.classifySponsorFailureSubcode(
      result.reason,
      sponsorContext.packageId,
      {
        kind: 'direct',
        commands,
        deepbookPackageId: sponsorContext.deepbookPackageId,
      },
    );
    const revert = computeRevertAccounting(result.gasUsed, prepared.reservedGasMist);
    const consumeOutcome = await d.consumeLedgerReservationWithLog(
      options.context.executionLedger,
      sponsor.params.receiptId,
      revert.consumeAmount,
      revert.triggerReason,
      {
        promotionId: sponsor.params.promotionId,
        userId: identity.userId,
        senderAddress: peekedPromotion.senderAddress,
        txDigest: result.digest || null,
      },
    );
    const releasedMist =
      revert.actualMist !== null &&
      consumeOutcome.ok &&
      revert.actualMist <= prepared.reservedGasMist
        ? prepared.reservedGasMist - revert.actualMist
        : 0n;
    await appendFailedUsageRow(options.context.usageStore, {
      promotionId: sponsor.params.promotionId,
      receiptId: sponsor.params.receiptId,
      userId: identity.userId,
      senderAddress: peekedPromotion.senderAddress,
      txDigest: result.digest || null,
      reservedGasMist: prepared.reservedGasMist,
      consumedGasMist: consumeOutcome.ok ? revert.consumeAmount : 0n,
      releasedGasMist: releasedMist,
      failureReason: revert.triggerReason,
    });
    await d.recordSponsorFailureForAbuse(
      sponsorContext.abuseBlocker,
      ctx.clientIp,
      { kind: 'studio_user', userId: peekedPromotion.userId },
      'ONCHAIN_REVERT',
      {
        subcode: classifiedSubcode ?? 'onchain_revert',
        executionPathKey: prepared.executionPathKey,
      },
    );

    state.sponsorResultOutcome = 'onchain_revert';
    state.sponsorResultDigest = result.digest;
    const ledgerNote = consumeOutcome.ok ? '' : ` (ledger consume ${consumeOutcome.kind})`;
    if (
      revert.actualMist !== null &&
      revert.grossGasMist !== null &&
      revert.storageRebateMist !== null
    ) {
      state.sponsorResultEconomics = serializeSponsoredExecutionEconomics(
        deriveSponsoredExecutionEconomics({
          // Promotion entitlement consumption is budget accounting, not
          // settlement recovery paid back to the Host.
          recoveredGasMist: 0n,
          hostPaidGasMist: revert.actualMist,
          hostFeeMist: 0n,
          grossGasMist: revert.grossGasMist,
          storageRebateMist: revert.storageRebateMist,
          protocolFeeMist: null,
          failureReason: `onchain_revert${ledgerNote}: ${result.reason}`,
        }),
      );
    } else {
      state.sponsorResultEconomics = serializeSponsoredExecutionEconomics(
        unknownSponsoredExecutionEconomics(
          `${revert.triggerReason}${ledgerNote}: ${result.reason}`,
        ),
      );
    }

    throw sponsor.errors.sponsor(
      `Transaction reverted on-chain: ${result.reason}`,
      'ONCHAIN_REVERT',
      422,
      result.gasUsed,
      classifiedSubcode,
    );
  }

  state.sponsorResultOutcome = 'success';
  state.sponsorResultDigest = result.digest;
  state.lastSuccessResult = result;

  if (!result.gasUsed) {
    const consumeOutcome = await d.consumeLedgerReservationWithLog(
      options.context.executionLedger,
      sponsor.params.receiptId,
      prepared.reservedGasMist,
      'gas_used_missing',
      {
        promotionId: sponsor.params.promotionId,
        userId: identity.userId,
        senderAddress: peekedPromotion.senderAddress,
        txDigest: result.digest || null,
      },
    );
    await appendFailedUsageRow(options.context.usageStore, {
      promotionId: sponsor.params.promotionId,
      receiptId: sponsor.params.receiptId,
      userId: identity.userId,
      senderAddress: peekedPromotion.senderAddress,
      txDigest: result.digest || null,
      reservedGasMist: prepared.reservedGasMist,
      consumedGasMist: consumeOutcome.ok ? prepared.reservedGasMist : 0n,
      releasedGasMist: 0n,
      failureReason: 'gas_used_missing',
    });
    state.sponsorResultEconomics = serializeSponsoredExecutionEconomics(
      unknownSponsoredExecutionEconomics(
        consumeOutcome.ok
          ? 'GAS_EFFECTS_MISSING'
          : `GAS_EFFECTS_MISSING (ledger consume ${consumeOutcome.kind})`,
      ),
    );
    throw sponsor.errors.sponsor(
      `Execution succeeded but gasUsed missing - cannot determine actual gas. Digest: ${result.digest}`,
      'GAS_EFFECTS_MISSING',
      500,
    );
  }

  const actualGasMist: Mist = mist(computeExecutionCostClaim(result.gasUsed).simGas);
  state.actualGasMist = actualGasMist;
  const grossGasMist = BigInt(result.gasUsed.computationCost) + BigInt(result.gasUsed.storageCost);
  const storageRebateMist = BigInt(result.gasUsed.storageRebate);
  if (actualGasMist > prepared.reservedGasMist) {
    logStructuredEvent(
      PROMOTION_GAS_OVERRUN_WARNING,
      {
        promotionId: sponsor.params.promotionId,
        userId: identity.userId,
        digest: result.digest,
        reserved_mist: prepared.reservedGasMist.toString(),
        actual_mist: actualGasMist.toString(),
        overrun_mist: (actualGasMist - prepared.reservedGasMist).toString(),
      },
      'warn',
    );
  }

  const deltaReleasedMist =
    actualGasMist <= prepared.reservedGasMist ? prepared.reservedGasMist - actualGasMist : 0n;
  const consumeOutcome = await d.consumeLedgerReservationWithLog(
    options.context.executionLedger,
    sponsor.params.receiptId,
    actualGasMist,
    'success',
    {
      promotionId: sponsor.params.promotionId,
      userId: identity.userId,
      senderAddress: peekedPromotion.senderAddress,
      txDigest: result.digest,
    },
  );
  if (!consumeOutcome.ok) {
    const consumeFailure =
      consumeOutcome.kind === 'failed' ? consumeOutcome.reason : consumeOutcome.error;
    const consumeFailureCode =
      consumeOutcome.kind === 'failed'
        ? 'PROMOTION_LEDGER_CONSUME_FAILED'
        : 'PROMOTION_LEDGER_CONSUME_THREW';
    state.sponsorResultEconomics = serializeSponsoredExecutionEconomics(
      deriveSponsoredExecutionEconomics({
        recoveredGasMist: 0n,
        hostPaidGasMist: actualGasMist,
        hostFeeMist: 0n,
        grossGasMist,
        storageRebateMist,
        protocolFeeMist: null,
        failureReason: `${consumeFailureCode}: ${consumeFailure}`,
      }),
    );
    throw sponsor.errors.sponsor(
      `Budget consume failed after successful TX: ${consumeFailure}. Digest: ${result.digest}`,
      'CONSUME_FAILED',
      500,
    );
  }

  if (options.context.usageStore) {
    try {
      await options.context.usageStore.append({
        promotionId: sponsor.params.promotionId,
        receiptId: sponsor.params.receiptId,
        result: 'consumed',
        userId: identity.userId,
        senderAddress: peekedPromotion.senderAddress,
        txDigest: result.digest,
        reservedGasMist: prepared.reservedGasMist.toString(),
        consumedGasMist: actualGasMist.toString(),
        releasedGasMist: deltaReleasedMist.toString(),
        failureReason: null,
        policyCheckResult: null,
      });
    } catch (err) {
      logStructuredEvent(
        PROMOTION_USAGE_RECORDER_FAILED,
        {
          promotionId: sponsor.params.promotionId,
          receiptId: sponsor.params.receiptId,
          userId: identity.userId,
          digest: result.digest,
          error: err instanceof Error ? err.message : String(err),
        },
        'warn',
      );
    }
  }

  logStructuredEvent(PROMOTION_SPONSOR_EXECUTION, {
    promotionId: sponsor.params.promotionId,
    userId: identity.userId,
    digest: result.digest,
    sponsorAddress: prepared.sponsorAddress,
    reserved_mist: prepared.reservedGasMist.toString(),
    actual_gas_mist: actualGasMist.toString(),
    delta_released_mist: deltaReleasedMist.toString(),
  });

  state.sponsorResultEconomics = serializeSponsoredExecutionEconomics(
    deriveSponsoredExecutionEconomics({
      // Consuming promotion allowance proves entitlement usage only. It does
      // not transfer settlement value back to the Host.
      recoveredGasMist: 0n,
      hostPaidGasMist: actualGasMist,
      hostFeeMist: 0n,
      grossGasMist,
      storageRebateMist,
      protocolFeeMist: null,
    }),
  );
}

async function runStudioRelease(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
  ctx: PostConsumeSponsorContext,
): Promise<void> {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  const prepared = requireValue(state.prepared, 'consumed promotion prepared entry');
  const peekedPromotion = requireValue(state.peekedPromotion, 'peeked promotion prepared entry');
  const callback = options.context.onSponsorResult;
  if (!callback) return;

  try {
    await callback({
      sponsorAddress: prepared.sponsorAddress,
      outcome: state.sponsorResultOutcome,
      executionStage: ctx.executionStage,
      route: 'promotion',
      digest: state.sponsorResultDigest,
      receiptId: prepared.receiptId,
      senderAddress: peekedPromotion.senderAddress,
      executionPathKey: prepared.executionPathKey,
      orderIdHash: null,
      promotionId: sponsor.params.promotionId,
      userId: sponsor.params.verifiedIdentity.userId,
      economics: state.sponsorResultEconomics,
    });
  } catch (err) {
    logStructuredEvent(
      SPONSOR_RESULT_CALLBACK_FAILED,
      {
        source: 'sponsor_handler',
        route: 'promotion',
        sponsor_address: prepared.sponsorAddress,
        digest: state.sponsorResultDigest ?? null,
        outcome: state.sponsorResultOutcome,
        error: err instanceof Error ? err.message : String(err),
      },
      'warn',
    );
  }
}

// -------------------------------------------------------------
// Sign/submit throw handling for the host port
// -------------------------------------------------------------

async function handleStudioSignAndSubmitThrow(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
  err: unknown,
): Promise<unknown> {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  const d = getDeps(options);
  const prepared = requireValue(state.prepared, 'consumed promotion prepared entry');
  const peekedPromotion = requireValue(state.peekedPromotion, 'peeked promotion prepared entry');
  const identity = sponsor.params.verifiedIdentity;

  if (!(err instanceof SponsorPostSignatureUncertaintyError)) {
    await d.releaseLedgerReservationWithLog(
      options.context.executionLedger,
      sponsor.params.receiptId,
      'sign_lease_expired',
    );
    setUnknownTerminal(
      state,
      'validation_failure',
      err instanceof Error ? err.message : 'validation_failure',
    );
    return err;
  }

  const consumeOutcome = await d.consumeLedgerReservationWithLog(
    options.context.executionLedger,
    sponsor.params.receiptId,
    prepared.reservedGasMist,
    'post_signature_uncertainty',
    {
      promotionId: sponsor.params.promotionId,
      userId: identity.userId,
      senderAddress: peekedPromotion.senderAddress,
      txDigest: null,
    },
  );
  await appendFailedUsageRow(options.context.usageStore, {
    promotionId: sponsor.params.promotionId,
    receiptId: sponsor.params.receiptId,
    userId: identity.userId,
    senderAddress: peekedPromotion.senderAddress,
    txDigest: null,
    reservedGasMist: prepared.reservedGasMist,
    consumedGasMist: consumeOutcome.ok ? prepared.reservedGasMist : 0n,
    releasedGasMist: 0n,
    failureReason: 'post_signature_uncertainty',
  });
  logStructuredEvent(
    PROMOTION_SPONSOR_POST_SIGNATURE_UNCERTAINTY,
    {
      promotionId: sponsor.params.promotionId,
      receiptId: sponsor.params.receiptId,
      userId: identity.userId,
      senderAddress: peekedPromotion.senderAddress,
      sponsorAddress: prepared.sponsorAddress,
      reservedMist: prepared.reservedGasMist.toString(),
      submittedAt: new Date().toISOString(),
      error: err.message,
      consumeOutcome: consumeOutcome.ok ? 'ok' : consumeOutcome.kind,
    },
    'error',
  );
  state.sponsorResultOutcome = 'internal_error';
  state.sponsorResultDigest = undefined;
  state.sponsorResultEconomics = serializeSponsoredExecutionEconomics(
    unknownSponsoredExecutionEconomics(
      consumeOutcome.ok
        ? `post_signature_uncertainty: ${err.message}`
        : `post_signature_uncertainty (ledger consume ${consumeOutcome.kind}): ${err.message}`,
    ),
  );
  return err;
}

// -------------------------------------------------------------
// Shared helpers
// -------------------------------------------------------------

async function appendFailedUsageRow(
  usageStore: PromotionUsageStoreAdapter | null | undefined,
  row: {
    readonly promotionId: string;
    readonly receiptId: string;
    readonly userId: string;
    readonly senderAddress: string;
    readonly txDigest: string | null;
    readonly reservedGasMist: bigint;
    readonly consumedGasMist: bigint;
    readonly releasedGasMist: bigint;
    readonly failureReason: string;
  },
): Promise<void> {
  if (!usageStore) return;
  try {
    await usageStore.append({
      promotionId: row.promotionId,
      receiptId: row.receiptId,
      result: 'failed',
      userId: row.userId,
      senderAddress: row.senderAddress,
      txDigest: row.txDigest,
      reservedGasMist: row.reservedGasMist.toString(),
      consumedGasMist: row.consumedGasMist.toString(),
      releasedGasMist: row.releasedGasMist.toString(),
      failureReason: row.failureReason,
      policyCheckResult: null,
    });
  } catch (err) {
    logStructuredEvent(
      PROMOTION_USAGE_RECORDER_FAILED,
      {
        promotionId: row.promotionId,
        receiptId: row.receiptId,
        userId: row.userId,
        digest: row.txDigest,
        failureReason: row.failureReason,
        error: err instanceof Error ? err.message : String(err),
      },
      'warn',
    );
  }
}

async function handleStudioCorruptPreparedEntry(
  context: StudioPolicyContext,
  params: StudioSponsorPolicyParams,
  errors: StudioSponsorErrorFactory,
  input: { readonly receiptId: string; readonly err: unknown; readonly stage: 'peek' | 'consume' },
): Promise<Error> {
  logStructuredEvent(PREPARE_ENTRY_CORRUPT, {
    stage: input.stage === 'peek' ? 'sponsor_peek' : 'sponsor_consume',
    route: 'promotion',
    promotion_id: params.promotionId,
    receipt_id: input.receiptId,
    error: input.err instanceof Error ? input.err.message : String(input.err),
  });
  await context.prepareStore.evictPreparedEntry(input.receiptId);
  await releaseLedgerReservationWithLog(
    context.executionLedger,
    input.receiptId,
    'prepare_entry_corrupt',
  );
  return errors.sponsor(
    'Unknown or expired receipt ID - retry promotion prepare',
    'PREPARED_TX_NOT_FOUND',
    404,
  );
}

function promotionPrepareErrorForPtbStructure(
  errors: StudioPrepareErrorFactory,
  failure: PtbStructureFailure,
): Error {
  switch (failure.code) {
    case 'FORBIDDEN_COMMAND':
      return errors.prepare(
        `Forbidden command kind "${failure.kind}" in promotion TX - only MoveCall is allowed`,
        'FORBIDDEN_COMMAND',
        403,
      );
    case 'GASCOIN_FORBIDDEN':
      return errors.prepare(
        'MoveCall references GasCoin - rejected to protect sponsor funds',
        'GASCOIN_FORBIDDEN',
        403,
      );
  }
}

function promotionPrepareErrorForEligibility(
  errors: StudioPrepareErrorFactory,
  failure: EligibilityFailure,
): Error {
  switch (failure.code) {
    case 'PROMOTION_NOT_FOUND':
      return errors.prepare('Promotion not found', 'PROMOTION_NOT_FOUND', 404);
    case 'PROMOTION_NOT_ACTIVE':
      return errors.prepare('Promotion is not active', 'PROMOTION_NOT_ACTIVE', 409);
    case 'PROMOTION_NOT_STARTED':
      return errors.prepare(
        `Promotion has not started yet (starts at ${failure.startAt})`,
        'PROMOTION_NOT_STARTED',
        409,
      );
    case 'NOT_CLAIMED':
      return errors.prepare(
        'User must claim the promotion before requesting a sponsored action.',
        'NOT_CLAIMED',
        403,
      );
    case 'USE_WINDOW_EXPIRED':
      return errors.prepare(
        `Use window expired at ${failure.useUntilAt}`,
        'USE_WINDOW_EXPIRED',
        403,
      );
  }
}

function readDryRunGasUsed(simResult: unknown): GasUsedFields {
  const terminal = parseSuiTransactionResult(simResult);
  if (!terminal) {
    throw new PrepareValidationError(
      'DRY_RUN_FAILED',
      'Dry-run returned a malformed terminal result',
    );
  }
  if (terminal.kind === 'failure') {
    throw new PrepareValidationError('DRY_RUN_FAILED', `Dry-run failed: ${terminal.error.message}`);
  }
  if (!terminal.gasUsed) {
    throw new PrepareValidationError('DRY_RUN_NO_GAS', 'Dry-run returned no gas usage');
  }
  return terminal.gasUsed;
}

function computeRevertAccounting(
  gasUsed: GasUsedFields | null,
  reservedGasMist: bigint,
): {
  readonly grossGasMist: bigint | null;
  readonly storageRebateMist: bigint | null;
  readonly actualMist: bigint | null;
  readonly consumeAmount: bigint;
  readonly triggerReason: 'onchain_revert' | 'onchain_revert_gas_unknown';
} {
  if (!gasUsed) {
    return {
      grossGasMist: null,
      storageRebateMist: null,
      actualMist: null,
      consumeAmount: reservedGasMist,
      triggerReason: 'onchain_revert_gas_unknown',
    };
  }

  try {
    const grossGasMist = BigInt(gasUsed.computationCost) + BigInt(gasUsed.storageCost);
    const storageRebateMist = BigInt(gasUsed.storageRebate);
    const actualMist = computeExecutionCostClaim(gasUsed).simGas;
    return {
      grossGasMist,
      storageRebateMist,
      actualMist,
      consumeAmount: actualMist,
      triggerReason: 'onchain_revert',
    };
  } catch {
    return {
      grossGasMist: null,
      storageRebateMist: null,
      actualMist: null,
      consumeAmount: reservedGasMist,
      triggerReason: 'onchain_revert_gas_unknown',
    };
  }
}

function setUnknownTerminal(
  state: StudioSponsorRuntimeState,
  outcome: SponsorResultOutcome,
  failureReason: string,
): void {
  state.sponsorResultOutcome = outcome;
  state.sponsorResultEconomics = serializeSponsoredExecutionEconomics(
    unknownSponsoredExecutionEconomics(failureReason),
  );
}

function requirePrepare(
  options: StudioExecutionPolicyOptions,
): NonNullable<StudioExecutionPolicyOptions['prepare']> {
  if (!options.prepare) {
    throw new StudioExecutionPolicyError('studio prepare policy runtime is not configured');
  }
  return options.prepare;
}

function requireSponsor(
  options: StudioExecutionPolicyOptions,
): NonNullable<StudioExecutionPolicyOptions['sponsor']> {
  if (!options.sponsor) {
    throw new StudioExecutionPolicyError('studio sponsor policy runtime is not configured');
  }
  return options.sponsor;
}

interface StudioSponsorRequiredContext extends StudioPolicyContext {
  readonly packageId: string;
  readonly deepbookPackageId: string;
  readonly abuseBlocker: AbuseBlockerAdapter;
}

interface StudioPromotionPolicyRequiredContext extends StudioPolicyContext {
  readonly abuseBlocker: AbuseBlockerAdapter;
}

function requirePromotionPolicyContext(
  context: StudioPolicyContext,
): StudioPromotionPolicyRequiredContext {
  if (!context.abuseBlocker) {
    throw new StudioExecutionPolicyError('studio promotion policy requires abuseBlocker');
  }
  return context as StudioPromotionPolicyRequiredContext;
}

function requireSponsorPolicyContext(context: StudioPolicyContext): StudioSponsorRequiredContext {
  if (!context.packageId || !context.deepbookPackageId || !context.abuseBlocker) {
    throw new StudioExecutionPolicyError(
      'studio sponsor policy requires packageId, deepbookPackageId, and abuseBlocker',
    );
  }
  return context as StudioSponsorRequiredContext;
}

function requirePrepareState(runtime: StudioExecutionPolicyState): StudioPrepareRuntimeState {
  if (!runtime.prepare) {
    throw new StudioExecutionPolicyError('studio prepare runtime state is not configured');
  }
  return runtime.prepare;
}

function requireSponsorState(runtime: StudioExecutionPolicyState): StudioSponsorRuntimeState {
  if (!runtime.sponsor) {
    throw new StudioExecutionPolicyError('studio sponsor runtime state is not configured');
  }
  return runtime.sponsor;
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new StudioExecutionPolicyError(`missing ${label}`);
  }
  return value;
}

function getDeps(input: {
  readonly deps?: Partial<StudioExecutionPolicyDependencies>;
}): StudioExecutionPolicyDependencies {
  return { ...DEFAULT_DEPS, ...input.deps };
}

function logPrepareStage(stage: string, payload: Record<string, unknown> = {}): void {
  logStructuredEvent(PREPARE_STAGE, {
    route: 'promotion',
    stage,
    ...payload,
  });
}
