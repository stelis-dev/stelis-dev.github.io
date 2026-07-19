/**
 * SponsoredExecution - Studio promotion SponsoredExecutionPolicy implementation.
 *
 * Studio promotion SponsoredExecutionPolicy used by the public prepare/sponsor
 * adapters through the prepare and sponsor runners. The policy is per-request:
 * hooks close over request-local runtime state while the
 * runners keep ownership of lifecycle order, reservation acquisition,
 * the atomic prepared-to-executing transition, one normalized sign/submit
 * call, finalization, and callback delivery.
 *
 * Internal module. Not re-exported from the package main barrel.
 */

import { Transaction } from '@mysten/sui/transactions';
import {
  computeExecutionCostClaim,
  convertSdkCommands,
  GAS_VARIANCE_FIXED_MIST,
  MAX_FINAL_COMMANDS,
  suiExecutionErrorMessage,
} from '@stelis/core-relay';
import type { OnchainConfig, SuiSimulationResult } from '@stelis/core-relay';
import type { ChainBoundSuiEndpointSnapshot } from '@stelis/core-relay';
import { simulateAddressBalanceGasTransaction } from '@stelis/core-relay/server';
import { PrepareValidationError, deserializeUserTxKind } from '../../prepare/replay.js';
import {
  classifySponsorFailureSubcode,
  safeBuildAddressBalanceGasTransaction,
} from '../../prepare/prepareErrors.js';
import type {
  PromotionPrepareErrorCode,
  PromotionSponsorErrorCode,
  SponsorFailureSubcode,
} from '@stelis/contracts';
import { PrepareStudioUserQuotaError } from '../../store/prepareErrors.js';
import { SponsorLeaseExpiredError } from '../../store/sponsorPoolErrors.js';
import type { PromotionPreparedTxEntry } from '../../store/prepareTypes.js';
import type { AbuseBlockerAdapter } from '../../store/abuseBlockTypes.js';
import { logStructuredEvent } from '../../structuredEventLog.js';
import {
  PREPARE_ENTRY_CORRUPT,
  PREPARE_STAGE,
  PROMOTION_GAS_OVERRUN_WARNING,
  PROMOTION_SPONSOR_EXECUTION,
} from '../../observability/events.js';
import { emitSponsorDriftObserved } from '../../failures.js';
import {
  SERIALIZED_UNKNOWN_ECONOMICS,
  SPONSOR_CONGESTION_FAILURE_REASON,
  deriveHostPaidGasEconomics,
  serializeSponsoredExecutionEconomics,
  sponsorOnchainRevertFailureReason,
  unknownSponsoredExecutionEconomics,
} from '../../sponsoredExecution.js';
import type {
  SponsorExecutionStage,
  SponsorResultCallback,
  SponsorResultEconomics,
  SponsorResultMetadata,
  SponsorResultOutcome,
} from '../../handlers/sponsorResult.js';
import type { PromotionExecutionRecoveryContext } from '../../store/sponsoredExecutionRecords.js';
import type { SponsorPoolAdapter } from '../../context.js';
import type { PromotionStoreAdapter } from '../../studio/promotionStore.js';
import type { PromotionExecutionLedger } from '../../studio/executionLedger.js';
import type { VerifiedDeveloperIdentity } from '../../studio/developerJwtVerifier.js';
import {
  PromotionSponsorPolicyError,
  validatePromotionPreparedPolicy,
  validatePromotionSponsorSubmissionPolicy,
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
  runPreflight,
  SenderSignatureError,
  signAndSubmit,
  verifyGasOwner,
  verifySenderSignature,
} from '../sessionPrimitives.js';
import type { ExecResult, GasUsedFields } from '../sessionTypes.js';
import type { SignAndSubmitPort, SponsorReceiptPolicyAdapter } from './sponsorRunner.js';
import type {
  GasBoundBuildInput,
  GasBoundBuildResult,
  LedgerReservationReconstructionInputs,
} from './reservationHandles.js';
import type {
  SponsoredExecutionPolicy,
  SponsorValidatedContext,
  PromotionPrepareChainSnapshot,
  SponsorSubmissionContext,
  SharedSponsorReconstruction,
} from './executionPolicy.js';
import type { PrepareDraftPolicyFields, PrepareResponseProjectionInput } from './runner.js';

// -------------------------------------------------------------
// Public factory input shapes
// -------------------------------------------------------------

export interface StudioPolicyContext {
  readonly sui: ChainBoundSuiEndpointSnapshot;
  readonly packageId?: string;
  readonly deepbookPackageId?: string;
  readonly promotionStore: PromotionStoreAdapter;
  readonly executionLedger: PromotionExecutionLedger;
  readonly sponsorPool: SponsorPoolAdapter;
  readonly sponsoredExecutionStore: {
    checkUserQuota(userId: string): Promise<'ok' | { exceeded: true; limit: number }>;
  };
  readonly abuseBlocker?: AbuseBlockerAdapter;
  readonly globalAllowedTargets: ReadonlySet<string>;
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
  prepare(message: string, code: PromotionPrepareErrorCode): Error;
}

export interface StudioSponsorErrorMeta {
  readonly gasUsed?: GasUsedFields;
  readonly digest?: string;
  readonly subcode?: SponsorFailureSubcode;
}

export interface StudioSponsorErrorFactory {
  sponsor(message: string, code: PromotionSponsorErrorCode, meta?: StudioSponsorErrorMeta): Error;
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
  readonly deserializeUserTxKind: typeof deserializeUserTxKind;
  readonly recordPromotionAbuseEvent: typeof recordPromotionAbuseEvent;
  readonly recordSponsorFailureForAbuse: typeof recordSponsorFailureForAbuse;
  readonly runPreflight: typeof runPreflight;
  readonly signAndSubmit: typeof signAndSubmit;
  readonly validatePromotionPreparedPolicy: typeof validatePromotionPreparedPolicy;
  readonly validatePromotionSponsorSubmissionPolicy: typeof validatePromotionSponsorSubmissionPolicy;
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
  deserializeUserTxKind,
  recordPromotionAbuseEvent,
  recordSponsorFailureForAbuse,
  runPreflight,
  signAndSubmit,
  validatePromotionPreparedPolicy,
  validatePromotionSponsorSubmissionPolicy,
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
      ChainSnapshot: async () => runStudioChainSnapshot(options, state),
      GasBoundBuild: async (_ctx, input) => runStudioGasBoundBuild(options, state, input),
      DecodeSponsorSubmission: async (ctx) => runStudioDecodeSponsorSubmission(options, state, ctx),
      UserSignatureValidation: async (ctx) => runStudioUserSignatureValidation(options, state, ctx),
      SharedSponsorChecks: async (ctx) => runStudioSharedSponsorChecks(options, state, ctx),
      PolicySponsorChecks: async (ctx) => runStudioPolicySponsorChecks(options, state, ctx),
      Preflight: async (ctx) => runStudioPreflight(options, state, ctx),
      ClassifySponsorResult: async (ctx, result) =>
        classifyStudioSponsorResult(options, state, ctx, result),
    },
  };

  return { policy, state };
}

export function createStudioSponsorReceiptPolicy(input: {
  readonly context: StudioPolicyContext;
  readonly params: StudioSponsorPolicyParams;
  readonly state: StudioExecutionPolicyState;
  readonly errors: StudioSponsorErrorFactory;
  readonly deps?: Partial<StudioExecutionPolicyDependencies>;
}): SponsorReceiptPolicyAdapter {
  const promotionExecutionPathKey = `promotion:${input.params.promotionId}`;
  const sponsorContext = requirePromotionPolicyContext(input.context);
  return {
    route: 'promotion',
    onNotFound: () =>
      input.errors.sponsor(
        'Unknown or expired receipt ID - retry promotion prepare',
        'PREPARED_TX_NOT_FOUND',
      ),
    onExpired: () =>
      input.errors.sponsor(
        'Prepared transaction expired - retry promotion prepare',
        'PREPARED_TX_EXPIRED',
      ),
    onHashMismatch: async () => {
      const state = requireSponsorState(input.state);
      const peekedPromotion = requireValue(
        state.peekedPromotion,
        'peeked promotion prepared entry',
      );
      const d = getDeps(input);
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
      );
    },
    onPromotionNotActive: () =>
      input.errors.sponsor('Promotion is not active', 'PROMOTION_NOT_ACTIVE'),
    onSponsorUnavailable: () =>
      input.errors.sponsor(
        'The sponsor assigned to this receipt is unavailable',
        'SPONSOR_CAPACITY_UNAVAILABLE',
      ),
    onStateChanged: () =>
      input.errors.sponsor('Prepared receipt state changed - retry prepare', 'REPREPARE_REQUIRED'),
    onCorrupt: ({ receiptId, error }) =>
      handleStudioCorruptPreparedEntry(input.params, input.errors, { receiptId, error }),
    validatePreparedEntry: (entry) => {
      if (entry.mode !== 'promotion') {
        throw input.errors.sponsor('Receipt was not created by Promotion prepare', 'MODE_MISMATCH');
      }
      if (entry.promotionId !== input.params.promotionId) {
        throw input.errors.sponsor(
          'Receipt Promotion does not match the requested Promotion',
          'PROMOTION_ID_MISMATCH',
        );
      }
      if (entry.senderAddress !== input.params.verifiedIdentity.senderAddress) {
        throw input.errors.sponsor(
          'Verified identity senderAddress does not match prepared senderAddress',
          'SENDER_ADDRESS_MISMATCH',
        );
      }
      if (entry.userId !== input.params.verifiedIdentity.userId) {
        throw input.errors.sponsor(
          'Verified identity userId does not match prepared userId',
          'USER_ID_MISMATCH',
        );
      }
      const state = requireSponsorState(input.state);
      state.prepared = entry;
      state.peekedPromotion = entry;
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

export function buildStudioExecutionRecoveryContext(
  state: StudioExecutionPolicyState,
): PromotionExecutionRecoveryContext {
  const sponsorState = requireSponsorState(state);
  const prepared = requireValue(sponsorState.prepared, 'promotion prepared entry');
  return {
    route: 'promotion',
    senderAddress: prepared.senderAddress,
    executionPathKey: prepared.executionPathKey,
    promotionId: prepared.promotionId,
    userId: prepared.userId,
    reservedGasMist: prepared.reservedGasMist.toString(),
  };
}

export function buildStudioSponsorResultMetadata(
  state: StudioExecutionPolicyState,
  executionStage: SponsorExecutionStage,
): SponsorResultMetadata {
  const sponsorState = requireSponsorState(state);
  const prepared = requireValue(sponsorState.prepared, 'promotion prepared entry');
  return {
    sponsorAddress: prepared.sponsorAddress,
    outcome: sponsorState.sponsorResultOutcome,
    executionStage,
    route: 'promotion',
    digest: sponsorState.sponsorResultDigest,
    receiptId: prepared.receiptId,
    senderAddress: prepared.senderAddress,
    executionPathKey: prepared.executionPathKey,
    orderIdHash: null,
    promotionId: prepared.promotionId,
    userId: prepared.userId,
    economics: sponsorState.sponsorResultEconomics,
  };
}

export function createStudioSignAndSubmitPort(
  options: StudioExecutionPolicyOptions,
  state: StudioExecutionPolicyState,
): SignAndSubmitPort {
  const d = getDeps(options);
  return async (sponsorAddress, receiptId, txBytes, userSignature, expectedDigest) => {
    try {
      return await d.signAndSubmit(
        options.context.sponsorPool,
        options.context.sui,
        sponsorAddress,
        receiptId,
        txBytes,
        userSignature,
        expectedDigest,
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
    );
  }

  try {
    state.kindTx = await d.deserializeUserTxKind(prepare.params.txKindBytes);
  } catch (err) {
    if (err instanceof PrepareValidationError) {
      throw prepare.errors.prepare(err.message, 'BAD_TX_KIND');
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
    );
  }

  const targetFailure = validatePromotionTargets(
    normalizedCommands,
    options.context.globalAllowedTargets,
  );
  if (targetFailure) {
    throw prepare.errors.prepare(
      `Disallowed MoveCall targets: ${targetFailure.disallowedTargets.join(', ')}`,
      'DISALLOWED_TARGET',
    );
  }

  const commandCountFailure = validatePromotionCommandCount(normalizedCommands);
  if (commandCountFailure) {
    throw prepare.errors.prepare(
      `Promotion transaction must contain 1 to ${MAX_FINAL_COMMANDS} commands; received ${commandCountFailure.commandCount}`,
      'BAD_REQUEST',
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

  const quotaCheck = await options.context.sponsoredExecutionStore.checkUserQuota(identity.userId);
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
  const dryRunTransaction = await safeBuildAddressBalanceGasTransaction(
    userTx,
    options.context.sui,
    sponsorSlot.sponsorAddress,
    config.maxClaimMist,
    config.packageId,
  );
  const simResult = await simulateAddressBalanceGasTransaction(dryRunTransaction);
  const simGasUsed = readDryRunGasUsed(simResult, prepare.errors);
  const { simGas } = computeExecutionCostClaim(simGasUsed);
  const reserveAmount: Mist = mist(simGas + GAS_VARIANCE_FIXED_MIST);

  if (reserveAmount > config.maxClaimMist) {
    throw prepare.errors.prepare(
      `Estimated gas ${reserveAmount} exceeds per-TX cap ${config.maxClaimMist}`,
      'GAS_EXCEEDS_TX_CAP',
    );
  }

  const addressBalanceGasTransaction = await safeBuildAddressBalanceGasTransaction(
    userTx,
    options.context.sui,
    sponsorSlot.sponsorAddress,
    reserveAmount,
    config.packageId,
  );
  state.buildResult = {
    addressBalanceGasTransaction,
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
  ctx: SponsorSubmissionContext,
): Promise<void> {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  try {
    state.builtTxForValidation = Transaction.from(sponsor.txBytes);
    state.txSender = extractTxSender(state.builtTxForValidation);
  } catch (err) {
    throw sponsor.errors.sponsor(
      `Malformed txBytes — cannot deserialize TransactionData: ${err instanceof Error ? err.message : String(err)}`,
      'BAD_REQUEST',
    );
  }
  void ctx;
}

async function runStudioUserSignatureValidation(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
  ctx: SponsorSubmissionContext,
): Promise<void> {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  const d = getDeps(options);
  const sponsorContext = requirePromotionPolicyContext(options.context);
  const builtTx = requireValue(state.builtTxForValidation, 'studio builtTxForValidation');
  const identity = sponsor.params.verifiedIdentity;
  const txSender = requireValue(state.txSender, 'tx sender');

  try {
    await d.verifySenderSignature(sponsor.txBytes, sponsor.userSignature, txSender);
  } catch (err) {
    if (err instanceof SenderSignatureError) {
      await d.recordPromotionAbuseEvent(
        sponsorContext.abuseBlocker,
        ctx.clientIp,
        { kind: 'studio_user', userId: identity.userId },
        'PROMO_SENDER_SIGNATURE_INVALID',
        {
          promotionId: sponsor.params.promotionId,
          userId: identity.userId,
          detail: 'sender_signature_invalid',
        },
      );
      throw sponsor.errors.sponsor(err.message, 'SENDER_SIGNATURE_INVALID');
    }
    throw err;
  }

  if (txSender !== identity.senderAddress) {
    await d.recordPromotionAbuseEvent(
      sponsorContext.abuseBlocker,
      ctx.clientIp,
      { kind: 'studio_user', userId: identity.userId },
      'PROMO_SENDER_SIGNATURE_INVALID',
      {
        promotionId: sponsor.params.promotionId,
        userId: identity.userId,
        detail: 'verified_identity_sender_mismatch',
      },
    );
    throw sponsor.errors.sponsor(
      'canonical tx.sender does not match verified identity senderAddress',
      'SENDER_SIGNATURE_INVALID',
    );
  }

  try {
    await d.validatePromotionSponsorSubmissionPolicy(
      sponsorContext,
      {
        promotionId: sponsor.params.promotionId,
        clientIp: sponsor.params.clientIp,
        verifiedIdentity: identity,
      },
      builtTx,
    );
  } catch (err) {
    if (err instanceof PromotionSponsorPolicyError) {
      throw sponsor.errors.sponsor(err.message, err.code);
    }
    throw err;
  }
}

async function runStudioSharedSponsorChecks(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
  ctx: SponsorValidatedContext,
): Promise<SharedSponsorReconstruction> {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  const d = getDeps(options);
  const sponsorContext = requirePromotionPolicyContext(options.context);
  const prepared = requireValue(state.prepared, 'consumed promotion prepared entry');
  const peekedPromotion = requireValue(state.peekedPromotion, 'peeked promotion prepared entry');
  const builtTx = requireValue(state.builtTxForValidation, 'studio builtTxForValidation');

  try {
    await d.validatePromotionPreparedPolicy(
      sponsorContext,
      {
        promotionId: sponsor.params.promotionId,
        clientIp: sponsor.params.clientIp,
        verifiedIdentity: sponsor.params.verifiedIdentity,
      },
      prepared,
      builtTx,
    );
  } catch (err) {
    if (err instanceof PromotionSponsorPolicyError) {
      throw sponsor.errors.sponsor(err.message, err.code);
    }
    throw err;
  }

  let gasBudget: bigint;
  try {
    ({ budget: gasBudget } = d.verifyGasOwner(builtTx, prepared.sponsorAddress));
  } catch (err) {
    if (err instanceof GasOwnerMismatchError) {
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
      throw sponsor.errors.sponsor(err.message, 'REPREPARE_REQUIRED');
    }
    throw err;
  }

  if (gasBudget !== prepared.reservedGasMist) {
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
    throw sponsor.errors.sponsor(message, 'REPREPARE_REQUIRED');
  }

  return {};
}

async function runStudioPolicySponsorChecks(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
  ctx: SponsorValidatedContext,
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
    throw sponsor.errors.sponsor(message, 'REPREPARE_REQUIRED');
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
  ctx: SponsorValidatedContext,
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
    const failureMessage = suiExecutionErrorMessage(preflight.error);
    const subcode = d.classifySponsorFailureSubcode(preflight.error, sponsorContext.packageId, {
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
    setUnknownTerminal(state, 'preflight_failure', `preflight_failure: ${failureMessage}`);
    throw sponsor.errors.sponsor(
      `Preflight simulation failed: ${failureMessage}`,
      'PREFLIGHT_FAILED',
      { subcode },
    );
  }
}

async function classifyStudioSponsorResult(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
  ctx: SponsorValidatedContext,
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
    const failureMessage = suiExecutionErrorMessage(result.error);
    if (result.isCongestion) {
      setUnknownTerminal(state, 'congestion', SPONSOR_CONGESTION_FAILURE_REASON);
      state.sponsorResultDigest = result.digest;
      throw sponsor.errors.sponsor(failureMessage, 'SPONSOR_CONGESTION', {
        digest: result.digest,
      });
    }

    const classifiedSubcode = d.classifySponsorFailureSubcode(
      result.error,
      sponsorContext.packageId,
      {
        kind: 'direct',
        commands,
        deepbookPackageId: sponsorContext.deepbookPackageId,
      },
    );
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
    state.sponsorResultEconomics = serializeSponsoredExecutionEconomics(
      deriveHostPaidGasEconomics(result.gasUsed, sponsorOnchainRevertFailureReason(failureMessage)),
    );

    throw sponsor.errors.sponsor(
      `Transaction reverted on-chain: ${failureMessage}`,
      'ONCHAIN_REVERT',
      { gasUsed: result.gasUsed, digest: result.digest, subcode: classifiedSubcode },
    );
  }

  state.sponsorResultOutcome = 'success';
  state.sponsorResultDigest = result.digest;
  state.lastSuccessResult = result;

  const actualGasMist: Mist = mist(computeExecutionCostClaim(result.gasUsed).simGas);
  state.actualGasMist = actualGasMist;
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
    deriveHostPaidGasEconomics(result.gasUsed, null),
  );
}

function handleStudioSignAndSubmitThrow(
  options: StudioExecutionPolicyOptions,
  runtime: StudioExecutionPolicyState,
  err: unknown,
): unknown {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  setUnknownTerminal(
    state,
    'validation_failure',
    err instanceof Error ? err.message : 'validation_failure',
  );
  if (err instanceof SponsorLeaseExpiredError) {
    return sponsor.errors.sponsor(err.message, 'LEASE_EXPIRED');
  }
  return err;
}

// -------------------------------------------------------------
// Shared helpers
// -------------------------------------------------------------

function handleStudioCorruptPreparedEntry(
  params: StudioSponsorPolicyParams,
  errors: StudioSponsorErrorFactory,
  input: { readonly receiptId: string; readonly error: unknown },
): Error {
  logStructuredEvent(PREPARE_ENTRY_CORRUPT, {
    stage: 'sponsor_read',
    route: 'promotion',
    promotion_id: params.promotionId,
    receipt_id: input.receiptId,
    error: input.error instanceof Error ? input.error.message : String(input.error),
  });
  return errors.sponsor('Prepared transaction storage is corrupt', 'SPONSOR_FAILED');
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
      );
    case 'GASCOIN_FORBIDDEN':
      return errors.prepare(
        'MoveCall references GasCoin - rejected to protect sponsor funds',
        'GASCOIN_FORBIDDEN',
      );
  }
}

function promotionPrepareErrorForEligibility(
  errors: StudioPrepareErrorFactory,
  failure: EligibilityFailure,
): Error {
  switch (failure.code) {
    case 'PROMOTION_NOT_FOUND':
      return errors.prepare('Promotion not found', 'PROMOTION_NOT_FOUND');
    case 'PROMOTION_NOT_ACTIVE':
      return errors.prepare('Promotion is not active', 'PROMOTION_NOT_ACTIVE');
    case 'PROMOTION_NOT_STARTED':
      return errors.prepare(
        `Promotion has not started yet (starts at ${failure.startAt})`,
        'PROMOTION_NOT_ACTIVE',
      );
    case 'NOT_CLAIMED':
      return errors.prepare(
        'User must claim the promotion before requesting a sponsored action.',
        'NOT_CLAIMED',
      );
    case 'USE_WINDOW_EXPIRED':
      return errors.prepare(`Use window expired at ${failure.useUntilAt}`, 'USE_WINDOW_EXPIRED');
  }
}

function readDryRunGasUsed(
  simResult: SuiSimulationResult,
  errors: StudioPrepareErrorFactory,
): GasUsedFields {
  if (simResult.outcome === 'failure') {
    throw errors.prepare(
      `Dry-run failed: ${suiExecutionErrorMessage(simResult.error)}`,
      'DRY_RUN_FAILED',
    );
  }
  return simResult.effects.gasUsed;
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
