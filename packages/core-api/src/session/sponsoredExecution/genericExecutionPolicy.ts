/**
 * SponsoredExecution - generic SponsoredExecutionPolicy implementation.
 *
 * Generic SponsoredExecutionPolicy used by the public prepare/sponsor
 * adapters through the prepare and sponsor runners. The policy is per-request:
 * hooks close over the request-local prepare/sponsor
 * runtime state while the runner keeps ownership of lifecycle order,
 * reservation acquisition, the atomic prepared-to-executing transition,
 * one sign/submit call, finalization, and callback delivery.
 *
 * Internal module. Not re-exported from the package main barrel.
 */

import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';
import type {
  PtbCommand,
  RelayPrepareErrorCode,
  RelaySponsorErrorCode,
  SettleProfile,
  SingleHopSettlementSwapPath,
  SponsorFailureSubcode,
} from '@stelis/contracts';
import { GAS_MARGIN_CAP_BPS, isReceiptId, SLIPPAGE_CAP_BPS } from '@stelis/contracts';
import { RELAY_PREPARE_ERROR_CODES } from '@stelis/contracts';
import {
  convertSdkCommands,
  CreditQueryInconsistentStateError,
  DEFAULT_GAS_MARGIN_BPS,
  DEFAULT_SLIPPAGE_BPS,
  computeExecutionCostClaim,
  queryUserCredit,
  sha256Bytes,
  suiExecutionErrorMessage,
  validateNonlossSponsor,
  validateGenericSettlementTransaction,
  validateGenericUserTransactionKind,
  validateSettleArgs,
} from '@stelis/core-relay';
import type {
  AllowedSettlementSwapPath,
  OnchainConfig,
  HostValidationEnv,
} from '@stelis/core-relay';
import { validatePaymentInputIntegrity } from '@stelis/core-relay/server';
import type {
  StaticSettlementSwapPathDescriptor,
  StaticSettlementSwapPathDescriptorMap,
} from '@stelis/core-relay/server';
import { classifySponsorFailureSubcode } from '../../prepare/prepareErrors.js';
import { deserializeUserTxKind, PrepareValidationError } from '../../prepare/replay.js';
import {
  extractSettleArgsFromBuiltTx,
  isNewUserSettleMoveCall,
} from '../../prepare/extractSettleArgs.js';
import type { ExtractedSettleArgs } from '../../prepare/extractSettleArgs.js';
import { runGenericPrepareBuildPipeline } from '../../prepare/build.js';
import type { GenericPrepareBuildOutput } from '../../prepare/build.js';
import { buildPolicyFields } from '../../preparePolicy.js';
import { computePolicyHash } from '../../policyHash.js';
import {
  checkBlockedSubject,
  recordSponsorFailureForAbuse,
  type AdmittedClientIp,
} from '../../abuseBlocking.js';
import {
  SERIALIZED_UNKNOWN_ECONOMICS,
  SPONSOR_CONGESTION_FAILURE_REASON,
  deriveHostPaidGasEconomics,
  deriveSettlementExecutionEconomics,
  serializeSponsoredExecutionEconomics,
  sponsorOnchainRevertFailureReason,
  unknownSponsoredExecutionEconomics,
} from '../../sponsoredExecution.js';
import { logStructuredEvent } from '../../structuredEventLog.js';
import {
  PREPARE_ENTRY_CORRUPT,
  PREPARE_STAGE,
  SETTLEMENT_ECONOMICS_EXECUTION,
  SETTLEMENT_ECONOMICS_LOG_FAILED,
  SPONSOR_SENDER_STORE_DIVERGENCE,
} from '../../observability/events.js';
import {
  emitSponsorDriftObserved,
  VAULT_DRIFT_NEW_USER_VAULT_EXISTS,
  VAULT_DRIFT_QUERY_FAILED,
  VAULT_DRIFT_STATE_INCONSISTENT,
} from '../../failures.js';
import type { HostContext } from '../../context.js';
import type { GenericPreparedTxEntry } from '../../store/prepareTypes.js';
import { SponsorLeaseExpiredError } from '../../store/sponsorPoolErrors.js';
import {
  GasOwnerMismatchError,
  runPreflight,
  signAndSubmit,
  SponsorPostSignatureUncertaintyError,
  verifyGasOwner,
} from '../sessionPrimitives.js';
import type { GasUsedFields } from '../sessionTypes.js';
import type {
  SponsorExecutionStage,
  SponsorResultEconomics,
  SponsorResultMetadata,
  SponsorResultOutcome,
} from '../../handlers/sponsorResult.js';
import type { GenericExecutionRecoveryContext } from '../../store/sponsoredExecutionRecords.js';
import type { PrepareDraftPolicyFields, PrepareResponseProjectionInput } from './runner.js';
import type { SignAndSubmitPort, SponsorReceiptPolicyAdapter } from './sponsorRunner.js';
import type { GasBoundBuildInput, GasBoundBuildResult } from './reservationHandles.js';
import type {
  GenericPrepareChainSnapshot,
  SponsoredExecutionPolicy,
  PolicySponsorReconstruction,
  SponsorValidatedContext,
  SponsorSubmissionContext,
} from './executionPolicy.js';
import { readAuthenticatedSponsorSubmission } from './sponsorSubmissionAuthentication.js';
import { parseBps, mist, type Bps, type Mist } from '../../internal/brand.js';
import { requireSettlementSwapPathConfig } from '../../prepare/settlementSwapPathConfig.js';
import { deriveSettlementFundingProfile } from '../../prepare/settlementPlanner.js';

// -------------------------------------------------------------
// Public factory input shapes
// -------------------------------------------------------------

export interface GenericPreparePolicyParams {
  readonly txKindBytes: string;
  readonly senderAddress: string;
  readonly settlementTokenType: string;
  readonly slippageBps?: number;
  readonly gasMarginBps?: number;
  readonly clientIp: string;
  readonly orderId?: string;
}

export interface GenericPreparePolicyConfig {
  readonly deepbookPackageId: string;
  readonly supportedSettlementSwapPaths: readonly SingleHopSettlementSwapPath[];
  readonly settlementSwapPathDescriptors: StaticSettlementSwapPathDescriptorMap;
  readonly allowedSettlementSwapPaths: readonly AllowedSettlementSwapPath[];
  readonly quotedHostFeeMist: bigint;
}

export interface GenericSponsorErrorFactory {
  sponsorValidation(code: RelaySponsorErrorCode, message: string): Error;
  sponsorBlocked(retryAfterMs: number | undefined): Error;
  sponsorPreflight(reason: string, subcode?: SponsorFailureSubcode): Error;
  sponsorOnchain(
    digest: string,
    reason: string,
    subcode: SponsorFailureSubcode | undefined,
    gasUsed: GasUsedFields,
  ): Error;
  sponsorCongestion(message: string, digest: string): Error;
}

export interface GenericExecutionPolicyOptions {
  readonly hostContext: HostContext;
  readonly prepare?: {
    readonly params: GenericPreparePolicyParams;
    readonly config: GenericPreparePolicyConfig;
    readonly nowMs?: () => number;
  };
  readonly sponsor?: {
    readonly admittedClientIp: AdmittedClientIp;
    readonly errors: GenericSponsorErrorFactory;
  };
  readonly deps?: Partial<GenericExecutionPolicyDependencies>;
}

export interface GenericExecutionPolicyDependencies {
  readonly checkBlockedSubject: typeof checkBlockedSubject;
  readonly deserializeUserTxKind: typeof deserializeUserTxKind;
  readonly queryUserCredit: typeof queryUserCredit;
  readonly recordSponsorFailureForAbuse: typeof recordSponsorFailureForAbuse;
  readonly revalidateGenericSponsorPolicy: typeof revalidateGenericSponsorPolicy;
  readonly runPreflight: typeof runPreflight;
  readonly signAndSubmit: typeof signAndSubmit;
  readonly runGenericPrepareBuildPipeline: typeof runGenericPrepareBuildPipeline;
  readonly validateGenericSponsorNonloss: typeof validateGenericSponsorNonloss;
  readonly verifyGasOwner: typeof verifyGasOwner;
}

export interface GenericExecutionPolicyState {
  prepare?: GenericPrepareRuntimeState;
  sponsor?: GenericSponsorRuntimeState;
}

export interface GenericPrepareRuntimeState {
  slippageBps?: Bps;
  gasMarginBps?: Bps;
  orderIdHash?: Uint8Array;
  settlementSwapPath?: SingleHopSettlementSwapPath;
  descriptor?: StaticSettlementSwapPathDescriptor;
  credit?: Awaited<ReturnType<typeof queryUserCredit>>;
  config?: OnchainConfig;
  profile?: SettleProfile;
  quoteTimestampMs?: number;
  policyHashBytes?: Uint8Array;
  policyHashHex?: string;
  buildResult?: GenericPrepareBuildOutput;
  executionPathKey?: string;
}

export interface GenericSponsorRuntimeState {
  prepared?: GenericPreparedTxEntry;
  revalidation?: RevalidateGenericResult;
  gasBudget?: bigint;
  sponsorResultOutcome: SponsorResultOutcome;
  sponsorResultDigest?: string;
  sponsorResultOrderIdHash: string | null;
  sponsorResultEconomics: SponsorResultEconomics;
  lastSuccessResult?: Extract<import('../sessionTypes.js').ExecResult, { success: true }>;
}

export class GenericExecutionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenericExecutionPolicyError';
  }
}

export class GenericSponsorPolicyError extends Error {
  constructor(
    public readonly code: RelaySponsorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GenericSponsorPolicyError';
  }
}

const RELAY_PREPARE_ERROR_CODE_SET: ReadonlySet<string> = new Set(RELAY_PREPARE_ERROR_CODES);

function isRelayPrepareErrorCode(code: string): code is RelayPrepareErrorCode {
  return RELAY_PREPARE_ERROR_CODE_SET.has(code);
}

function requireRelayPrepareErrorCode(code: string): RelayPrepareErrorCode {
  if (!isRelayPrepareErrorCode(code)) {
    throw new GenericExecutionPolicyError(
      `Prepare validator returned non-current Relay prepare code: ${code}`,
    );
  }
  return code;
}

export interface RevalidateGenericResult {
  readonly builtTx: Transaction;
  readonly commands: readonly PtbCommand[];
  readonly freshConfig: OnchainConfig;
  readonly settleArgs: ExtractedSettleArgs;
  readonly isNewUserSettle: boolean;
}

export interface GenericPreparePolicyResult {
  readonly txBytes: string;
  readonly receiptId: string;
  readonly nonce: string;
  readonly cost: {
    readonly simGas: string;
    readonly gasVarianceFixedMist: string;
    readonly slippageBufferMist: string;
    readonly quotedHostFee: string;
    readonly protocolFee: string;
    readonly executionCostClaim: string;
    readonly grossGas: string;
  };
  readonly profile: SettleProfile;
  readonly quoteTimestampMs: number;
  readonly policyHash: string;
  readonly orderId?: string;
}

const DEFAULT_DEPS: GenericExecutionPolicyDependencies = {
  checkBlockedSubject,
  deserializeUserTxKind,
  queryUserCredit,
  recordSponsorFailureForAbuse,
  revalidateGenericSponsorPolicy,
  runPreflight,
  signAndSubmit,
  runGenericPrepareBuildPipeline,
  validateGenericSponsorNonloss,
  verifyGasOwner,
};

// -------------------------------------------------------------
// Factory
// -------------------------------------------------------------

export function createGenericExecutionPolicy(options: GenericExecutionPolicyOptions): {
  readonly policy: SponsoredExecutionPolicy<'generic'>;
  readonly state: GenericExecutionPolicyState;
} {
  const state: GenericExecutionPolicyState = {};
  if (options.prepare) state.prepare = {};
  if (options.sponsor) {
    state.sponsor = {
      sponsorResultOutcome: 'internal_error',
      sponsorResultOrderIdHash: null,
      sponsorResultEconomics: SERIALIZED_UNKNOWN_ECONOMICS,
    };
  }

  const policy: SponsoredExecutionPolicy<'generic'> = {
    discriminator: 'generic',
    handleRequirements: {
      gasBoundBuild: { nonce: true },
      preparedCommit: {},
      sponsorResult: {},
    },
    hooks: {
      Intent: (ctx) => {
        const prepare = requirePrepare(options);
        logPrepareStage('request_received', {
          sender: prepare.params.senderAddress,
          settlement_token_type: prepare.params.settlementTokenType,
          has_order_id: prepare.params.orderId !== undefined,
        });
        assertPrepareCtx(ctx, prepare.params);
      },
      RequestValidation: async () => runGenericRequestValidation(options, state),
      ChainSnapshot: async () => runGenericChainSnapshot(options, state),
      GasBoundBuild: async (ctx, input) =>
        runGenericGasBoundBuild(options, state, ctx.receiptId, input),
      SponsorSubmissionAdmission: async (ctx) => runGenericSponsorSubmissionAdmission(options, ctx),
      SharedSponsorChecks: async (ctx) => runGenericSharedSponsorChecks(options, state, ctx),
      PolicySponsorChecks: async (ctx) => runGenericPolicySponsorChecks(options, state, ctx),
      Preflight: async (ctx) => runGenericPreflight(options, state, ctx),
      ClassifySponsorResult: async (ctx, result) =>
        classifyGenericSponsorResult(options, state, ctx, result),
    },
  };

  return { policy, state };
}

export function createGenericSponsorReceiptPolicy(input: {
  readonly hostContext: HostContext;
  readonly clientIp: string;
  readonly state: GenericExecutionPolicyState;
  readonly errors: GenericSponsorErrorFactory;
  readonly deps?: Partial<GenericExecutionPolicyDependencies>;
}): SponsorReceiptPolicyAdapter {
  return {
    route: 'generic',
    onNotFound: () =>
      input.errors.sponsorValidation(
        'PREPARED_TX_NOT_FOUND',
        'Unknown or expired receipt ID — retry /prepare',
      ),
    onExpired: () =>
      input.errors.sponsorValidation(
        'PREPARED_TX_EXPIRED',
        'Prepared transaction expired — retry /prepare',
      ),
    onHashMismatch: async () => {
      await getDeps(input).recordSponsorFailureForAbuse(
        input.hostContext.abuseBlocker,
        input.clientIp,
        undefined,
        'TAMPERING_DETECTED',
      );
      return input.errors.sponsorValidation(
        'TAMPERING_DETECTED',
        'txBytes hash mismatch — possible tampering',
      );
    },
    onPromotionNotActive: () =>
      input.errors.sponsorValidation(
        'MODE_MISMATCH',
        'Generic sponsored execution cannot use a Promotion receipt',
      ),
    onSponsorUnavailable: () =>
      input.errors.sponsorValidation(
        'SPONSOR_CAPACITY_UNAVAILABLE',
        'The sponsor assigned to this receipt is unavailable',
      ),
    onStateChanged: () =>
      input.errors.sponsorValidation(
        'REPREPARE_REQUIRED',
        'Prepared receipt state changed — retry /prepare',
      ),
    onCorrupt: ({ receiptId, error }) => handleCorruptPreparedEntry(input.errors, receiptId, error),
    validatePreparedEntry: (entry) => {
      if (entry.mode === 'promotion') {
        throw input.errors.sponsorValidation(
          'MODE_MISMATCH',
          'Promotion receipt cannot be used by generic relay sponsor — use /studio/promotions/:id/sponsor',
        );
      }
      requireSponsorState(input.state).prepared = entry;
    },
  };
}

export function buildGenericPreparedDraftFields(
  options: GenericExecutionPolicyOptions,
  state: GenericExecutionPolicyState,
): PrepareDraftPolicyFields {
  const prepare = requirePrepare(options);
  const prepareState = requirePrepareState(state);
  const executionPathKey = requireValue(prepareState.executionPathKey, 'executionPathKey');
  return {
    executionPathKey,
    orderId: prepare.params.orderId ?? null,
  };
}

export function projectGenericPrepareResult(
  options: GenericExecutionPolicyOptions,
  state: GenericExecutionPolicyState,
  input: PrepareResponseProjectionInput,
): GenericPreparePolicyResult {
  const prepare = requirePrepare(options);
  const prepareState = requirePrepareState(state);
  const buildResult = requireValue(prepareState.buildResult, 'prepare buildResult');
  const config = requireValue(prepareState.config, 'on-chain config');
  const quoteTimestampMs = requireValue(prepareState.quoteTimestampMs, 'quoteTimestampMs');
  const policyHashHex = requireValue(prepareState.policyHashHex, 'policyHashHex');
  if (input.draft.mode !== 'generic') {
    throw new GenericExecutionPolicyError('generic prepare projector received non-generic draft');
  }
  const result = {
    txBytes: input.txBytesBase64,
    receiptId: input.draft.receiptId,
    nonce: input.draft.nonce.toString(),
    cost: {
      simGas: buildResult.simGas.toString(),
      gasVarianceFixedMist: buildResult.gasVarianceFixedMist.toString(),
      slippageBufferMist: buildResult.slippageBufferMist.toString(),
      quotedHostFee: prepare.config.quotedHostFeeMist.toString(),
      protocolFee: config.protocolFlatFeeMist.toString(),
      executionCostClaim: buildResult.executionCostClaim.toString(),
      grossGas: buildResult.grossGas.toString(),
    },
    profile: buildResult.profile,
    quoteTimestampMs,
    policyHash: `0x${policyHashHex}`,
    orderId: prepare.params.orderId,
  };
  logPrepareStage('response_ready', {
    execution_path_key: prepareState.executionPathKey ?? 'unknown',
    execution_cost_claim_mist: buildResult.executionCostClaim.toString(),
  });
  return result;
}

export function projectGenericSponsorResult(
  options: GenericExecutionPolicyOptions,
  state: GenericExecutionPolicyState,
): {
  readonly digest: string;
  readonly effects: unknown;
  readonly executionCostClaim: string;
  readonly orderId?: string;
} {
  requireSponsor(options);
  const sponsorState = requireSponsorState(state);
  const revalidation = requireValue(sponsorState.revalidation, 'sponsor revalidation');
  const result = requireValue(sponsorState.lastSuccessResult, 'success ExecResult');
  const prepared = requireValue(sponsorState.prepared, 'consumed generic prepared entry');
  return {
    digest: result.digest,
    effects: result.effects,
    executionCostClaim: revalidation.settleArgs.executionCostClaim.toString(),
    orderId: prepared.orderId ?? undefined,
  };
}

/** Durable inputs needed when the signed result must be recovered after restart. */
export function buildGenericExecutionRecoveryContext(
  state: GenericExecutionPolicyState,
): GenericExecutionRecoveryContext {
  const sponsorState = requireSponsorState(state);
  const prepared = requireValue(sponsorState.prepared, 'generic prepared entry');
  const revalidation = requireValue(sponsorState.revalidation, 'sponsor revalidation');
  const orderHash =
    revalidation.settleArgs.orderIdHash.length === 32
      ? Buffer.from(revalidation.settleArgs.orderIdHash).toString('hex')
      : null;
  return {
    route: 'generic',
    senderAddress: prepared.senderAddress,
    executionPathKey: prepared.executionPathKey,
    orderIdHash: orderHash,
    recoveredGasMist: revalidation.settleArgs.executionCostClaim.toString(),
    hostFeeMist: revalidation.settleArgs.quotedHostFeeMist.toString(),
    protocolFeeMist: revalidation.freshConfig.protocolFlatFeeMist.toString(),
  };
}

/** Build the exact durable result after policy classification has updated state. */
export function buildGenericSponsorResultMetadata(
  state: GenericExecutionPolicyState,
  executionStage: SponsorExecutionStage,
): SponsorResultMetadata {
  const sponsorState = requireSponsorState(state);
  const prepared = requireValue(sponsorState.prepared, 'generic prepared entry');
  return {
    sponsorAddress: prepared.sponsorAddress,
    outcome: sponsorState.sponsorResultOutcome,
    executionStage,
    route: 'generic',
    digest: sponsorState.sponsorResultDigest,
    receiptId: prepared.receiptId,
    senderAddress: prepared.senderAddress,
    executionPathKey: prepared.executionPathKey,
    orderIdHash: sponsorState.sponsorResultOrderIdHash,
    promotionId: null,
    userId: null,
    economics: sponsorState.sponsorResultEconomics,
  };
}

export function createGenericSignAndSubmitPort(
  options: GenericExecutionPolicyOptions,
  state: GenericExecutionPolicyState,
): SignAndSubmitPort {
  const d = getDeps(options);
  return async (sponsorAddress, receiptId, txBytes, userSignature, expectedDigest) => {
    try {
      return await d.signAndSubmit(
        options.hostContext.sponsorPool,
        options.hostContext.sui,
        sponsorAddress,
        receiptId,
        txBytes,
        userSignature,
        expectedDigest,
      );
    } catch (err) {
      if (err instanceof SponsorPostSignatureUncertaintyError) {
        const sponsorState = requireSponsorState(state);
        sponsorState.sponsorResultOutcome = 'internal_error';
        sponsorState.sponsorResultDigest = err.expectedDigest;
        sponsorState.sponsorResultEconomics = serializeSponsoredExecutionEconomics(
          unknownSponsoredExecutionEconomics(`post_signature_uncertainty: ${err.message}`),
        );
        throw err;
      }
      if (err instanceof SponsorLeaseExpiredError) {
        const sponsorState = requireSponsorState(state);
        sponsorState.sponsorResultOutcome = 'validation_failure';
        sponsorState.sponsorResultEconomics = serializeSponsoredExecutionEconomics(
          unknownSponsoredExecutionEconomics(err.message),
        );
      }
      throw err;
    }
  };
}

// -------------------------------------------------------------
// Prepare hooks
// -------------------------------------------------------------

async function runGenericRequestValidation(
  options: GenericExecutionPolicyOptions,
  runtime: GenericExecutionPolicyState,
): Promise<void> {
  const prepare = requirePrepare(options);
  const state = requirePrepareState(runtime);
  const d = getDeps(options);
  const rawSlippageBps = prepare.params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const rawGasMarginBps = prepare.params.gasMarginBps ?? DEFAULT_GAS_MARGIN_BPS;

  const slippageResult = parseBps(
    'slippageBps',
    rawSlippageBps,
    SLIPPAGE_CAP_BPS,
    'INVALID_SLIPPAGE_BPS',
  );
  if (!slippageResult.ok) {
    throw new PrepareValidationError(
      requireRelayPrepareErrorCode(slippageResult.code),
      slippageResult.message,
    );
  }
  const gasMarginResult = parseBps(
    'gasMarginBps',
    rawGasMarginBps,
    GAS_MARGIN_CAP_BPS,
    'INVALID_GAS_MARGIN_BPS',
  );
  if (!gasMarginResult.ok) {
    throw new PrepareValidationError(
      requireRelayPrepareErrorCode(gasMarginResult.code),
      gasMarginResult.message,
    );
  }
  state.slippageBps = slippageResult.value;
  state.gasMarginBps = gasMarginResult.value;

  const userTx = await d.deserializeUserTxKind(prepare.params.txKindBytes);
  const env = buildPrepareEnv(options.hostContext);
  const validationResult = validateGenericUserTransactionKind(
    userTx,
    env,
    prepare.params.settlementTokenType,
  );
  if (!validationResult.ok) {
    throw new PrepareValidationError(
      requireRelayPrepareErrorCode(validationResult.code),
      `P1 validation failed: ${validationResult.message}`,
    );
  }

  const settlementSwapPathConfig = requireSettlementSwapPathConfig(
    prepare.config.supportedSettlementSwapPaths,
    prepare.config.settlementSwapPathDescriptors,
    prepare.params.settlementTokenType,
  );
  state.settlementSwapPath = settlementSwapPathConfig.settlementSwapPath;
  state.descriptor = settlementSwapPathConfig.descriptor;

  if (prepare.params.orderId !== undefined) {
    const orderIdBytes = new TextEncoder().encode(prepare.params.orderId);
    if (orderIdBytes.length === 0 || orderIdBytes.length > 128) {
      throw new PrepareValidationError(
        'INVALID_ORDER_ID',
        `orderId must be 1-128 UTF-8 bytes, got ${orderIdBytes.length}`,
      );
    }
  }
  state.orderIdHash = prepare.params.orderId
    ? await sha256Bytes(new TextEncoder().encode(prepare.params.orderId))
    : new Uint8Array(0);

  logPrepareStage('order_id_processed', {
    has_order_id: prepare.params.orderId !== undefined,
  });
}

async function runGenericChainSnapshot(
  options: GenericExecutionPolicyOptions,
  runtime: GenericExecutionPolicyState,
): Promise<GenericPrepareChainSnapshot> {
  const prepare = requirePrepare(options);
  const state = requirePrepareState(runtime);
  const d = getDeps(options);
  try {
    const [credit, config] = await Promise.all([
      d.queryUserCredit(
        options.hostContext.sui,
        options.hostContext.packageId,
        options.hostContext.vaultRegistryId,
        prepare.params.senderAddress,
        options.hostContext.vaultsTableId,
      ),
      options.hostContext.getConfig(),
    ]);
    state.credit = credit;
    state.config = config;
  } catch (err) {
    if (err instanceof CreditQueryInconsistentStateError) {
      throw new PrepareValidationError(VAULT_DRIFT_STATE_INCONSISTENT.subcode, err.message, {
        vaultId: err.vaultId,
        userAddress: err.userAddress,
      });
    }
    throw err;
  }

  const credit = requireValue(state.credit, 'credit snapshot');
  const config = requireValue(state.config, 'on-chain config');
  const fundingProfile = deriveSettlementFundingProfile(credit);
  state.profile = fundingProfile.profile;
  state.quoteTimestampMs = prepare.nowMs?.() ?? Date.now();
  state.policyHashHex = computePolicyHash(buildPolicyFields(config));
  state.policyHashBytes = fromHex(state.policyHashHex);

  logPrepareStage('onchain_snapshot_loaded', {
    has_vault: fundingProfile.vaultObjectId !== null,
    profile: state.profile,
    credit_mist: credit.credit,
    config_version: config.configVersion.toString(),
    max_claim_mist: config.maxClaimMist.toString(),
    min_settle_mist: config.minSettleMist.toString(),
  });

  return {
    nonceAcquire: {
      onchainLastNonce: BigInt(credit.lastNonce),
    },
  };
}

async function runGenericGasBoundBuild(
  options: GenericExecutionPolicyOptions,
  runtime: GenericExecutionPolicyState,
  receiptId: string,
  input: GasBoundBuildInput,
): Promise<GasBoundBuildResult> {
  const prepare = requirePrepare(options);
  const state = requirePrepareState(runtime);
  const d = getDeps(options);
  const config = requireValue(state.config, 'on-chain config');
  const credit = requireValue(state.credit, 'credit snapshot');
  const settlementSwapPath = requireValue(state.settlementSwapPath, 'settlement swap path config');
  const descriptor = requireValue(state.descriptor, 'settlement swap path descriptor');
  const slippageBps = requireValue(state.slippageBps, 'slippageBps');
  const gasMarginBps = requireValue(state.gasMarginBps, 'gasMarginBps');
  const profile = requireValue(state.profile, 'profile');
  const policyHashBytes = requireValue(state.policyHashBytes, 'policyHashBytes');
  const quoteTimestampMs = requireValue(state.quoteTimestampMs, 'quoteTimestampMs');
  const orderIdHash = requireValue(state.orderIdHash, 'orderIdHash');
  const nonce = requireValue(input.reservationHandles.nonce, 'nonce reservation handle');

  const buildResult = await d.runGenericPrepareBuildPipeline(
    {
      sui: options.hostContext.sui,
      network: options.hostContext.network,
      allowedSettlementSwapPaths: options.hostContext.allowedSettlementSwapPaths,
      packageId: config.packageId,
      configId: config.configId,
      vaultRegistryId: options.hostContext.vaultRegistryId,
      deepbookPackageId: prepare.config.deepbookPackageId,
      settlementPayoutRecipientAddress: options.hostContext.settlementPayoutRecipientAddress,
      maxClaimMist: config.maxClaimMist,
      minSettleMist: config.minSettleMist,
      quotedHostFeeMist: prepare.config.quotedHostFeeMist,
      protocolFlatFeeMist: config.protocolFlatFeeMist,
      configVersion: config.configVersion,
    },
    {
      userTxKindBytes: prepare.params.txKindBytes,
      senderAddress: prepare.params.senderAddress,
      settlementSwapPath,
      descriptor,
      sponsorAddress: input.reservationHandles.sponsorSlot.sponsorAddress,
      slippageBps,
      gasMarginBps,
      profile,
      vaultObjectId: credit.vaultObjectId,
      credit: credit.credit,
      receiptId: parseReceiptIdBytes(receiptId),
      nonce: nonce.nonce,
      policyHash: policyHashBytes,
      orderIdHash,
      quoteTimestampMs,
    },
  );
  validateGenericBuildResult(options, state, buildResult);
  state.buildResult = buildResult;

  logPrepareStage('two_pass_build_done', {
    execution_cost_claim_mist: buildResult.executionCostClaim.toString(),
    sim_gas_mist: buildResult.simGas.toString(),
    gas_variance_fixed_mist: buildResult.gasVarianceFixedMist.toString(),
    slippage_buffer_mist: buildResult.slippageBufferMist.toString(),
    gross_gas_mist: buildResult.grossGas.toString(),
    effective_profile: buildResult.profile,
    payment_input_source: buildResult.paymentInputSource,
  });

  return {
    addressBalanceGasTransaction: buildResult.addressBalanceGasTransaction,
    measuredGasMist: buildResult.simGas,
  };
}

function validateGenericBuildResult(
  options: GenericExecutionPolicyOptions,
  state: GenericPrepareRuntimeState,
  buildResult: GenericPrepareBuildOutput,
): void {
  const prepare = requirePrepare(options);
  const config = requireValue(state.config, 'on-chain config');
  const policyHashBytes = requireValue(state.policyHashBytes, 'policyHashBytes');
  const orderIdHash = requireValue(state.orderIdHash, 'orderIdHash');

  try {
    const builtEnv: HostValidationEnv = {
      ...buildPrepareEnv(options.hostContext),
      allowedSettlementSwapPaths: [...prepare.config.allowedSettlementSwapPaths],
    };
    const l1 = buildResult.l1Validation;
    if (!l1.ok) {
      throw new PrepareValidationError(requireRelayPrepareErrorCode(l1.code), l1.message);
    }

    const settleArgs = requireValue(buildResult.settleArgs, 'validated settle arguments');
    const paymentIntegrity = validatePaymentInputIntegrity(settleArgs.paymentInputTrace, {
      source: buildResult.paymentInputSource,
      swapAmountSmallest: buildResult.swapAmountSmallest,
    });
    if (!paymentIntegrity.ok) {
      throw new PrepareValidationError(
        'L2_EXTRACT_FAILED',
        `Payment-input integrity failed: ${paymentIntegrity.message}`,
        { subcode: paymentIntegrity.subcode },
      );
    }
    if (policyHashBytes.length !== 32) {
      throw new PrepareValidationError(
        'L2_POLICY_HASH_MISMATCH',
        'policyHashBytes must be 32 bytes (S-16)',
      );
    }
    const l2 = validateSettleArgs(settleArgs, config, builtEnv, policyHashBytes, orderIdHash);
    if (!l2.ok) {
      throw new PrepareValidationError(requireRelayPrepareErrorCode(l2.code), l2.message);
    }

    state.executionPathKey = buildGenericExecutionPathKey(settleArgs.extractedSettlementSwapPath);
    logPrepareStage('l1_l2_validated', { execution_path_key: state.executionPathKey });
  } catch (err) {
    if (err instanceof PrepareValidationError) throw err;
    throw new PrepareValidationError(
      'L1_PARSE_FAILED',
      `Built transaction self-check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// -------------------------------------------------------------
// Sponsor hooks
// -------------------------------------------------------------

async function runGenericSponsorSubmissionAdmission(
  options: GenericExecutionPolicyOptions,
  ctx: SponsorSubmissionContext,
): Promise<void> {
  const sponsor = requireSponsor(options);
  const d = getDeps(options);
  if (ctx.authentication.outcome === 'rejected') {
    if (ctx.authentication.reason === 'malformed_transaction') {
      throw sponsor.errors.sponsorPreflight(
        `Failed to parse txBytes for sender extraction: ${ctx.authentication.message}`,
      );
    }
    await d.recordSponsorFailureForAbuse(
      options.hostContext.abuseBlocker,
      ctx.clientIp,
      undefined,
      'SENDER_SIGNATURE_INVALID',
    );
    throw sponsor.errors.sponsorValidation('SENDER_SIGNATURE_INVALID', ctx.authentication.message);
  }

  const { senderAddress } = readAuthenticatedSponsorSubmission(ctx.authentication.submission);
  const blocked = await d.checkBlockedSubject(
    options.hostContext.abuseBlocker,
    sponsor.admittedClientIp,
    { kind: 'address', address: senderAddress },
  );
  if (blocked.blocked) {
    throw sponsor.errors.sponsorBlocked(blocked.retryAfterMs);
  }
}

async function runGenericSharedSponsorChecks(
  options: GenericExecutionPolicyOptions,
  runtime: GenericExecutionPolicyState,
  ctx: SponsorValidatedContext,
): Promise<{ readonly nonce: NonNullable<ReturnType<typeof buildNonceReconstruction>> }> {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  const d = getDeps(options);
  const prepared = requireValue(state.prepared, 'consumed generic prepared entry');
  const { transaction: builtTx, senderAddress: txSender } = readAuthenticatedSponsorSubmission(
    ctx.authenticatedSubmission,
  );

  if (txSender !== prepared.senderAddress) {
    logStructuredEvent(SPONSOR_SENDER_STORE_DIVERGENCE, {
      route: 'generic',
      receipt_id: ctx.receiptId,
      tx_sender: txSender,
      stored_sender: prepared.senderAddress,
      outcome: 'rejected',
    });
    await d.recordSponsorFailureForAbuse(
      options.hostContext.abuseBlocker,
      ctx.clientIp,
      { kind: 'address', address: txSender },
      'RECEIPT_SESSION_MISMATCH',
    );
    throw sponsor.errors.sponsorValidation(
      'RECEIPT_SESSION_MISMATCH',
      'tx.sender does not match the prepared session sender — retry /prepare',
    );
  }

  try {
    state.revalidation = await d.revalidateGenericSponsorPolicy(
      options.hostContext,
      prepared,
      builtTx,
      txSender,
      ctx.clientIp,
    );
  } catch (err) {
    if (err instanceof GenericSponsorPolicyError) {
      setValidationFailure(state, err.message);
      throw sponsor.errors.sponsorValidation(err.code, err.message);
    }
    throw err;
  }

  try {
    const gasMetadata = d.verifyGasOwner(state.revalidation.builtTx, prepared.sponsorAddress);
    state.gasBudget = gasMetadata.budget;
  } catch (err) {
    if (err instanceof GasOwnerMismatchError) {
      emitSponsorDriftObserved({
        stage: 'gas_owner_mismatch',
        subcode: 'GAS_OWNER_MISMATCH',
        route: 'generic',
        receiptId: prepared.receiptId,
        sender: txSender,
        clientIp: ctx.clientIp,
      });
      setValidationFailure(state, err.message);
      throw sponsor.errors.sponsorValidation('REPREPARE_REQUIRED', err.message);
    }
    throw err;
  }

  if (state.revalidation.settleArgs.nonce !== prepared.nonce) {
    emitSponsorDriftObserved({
      stage: 's14_nonce_mismatch',
      subcode: 'S14_NONCE_MISMATCH',
      route: 'generic',
      receiptId: prepared.receiptId,
      sender: txSender,
      clientIp: ctx.clientIp,
    });
    const message =
      'Prepared nonce does not match the stored-hash-verified PTB nonce — retry /prepare';
    setValidationFailure(state, message);
    throw sponsor.errors.sponsorValidation('REPREPARE_REQUIRED', message);
  }

  return { nonce: buildNonceReconstruction(prepared) };
}

async function runGenericPolicySponsorChecks(
  options: GenericExecutionPolicyOptions,
  runtime: GenericExecutionPolicyState,
  ctx: SponsorValidatedContext,
): Promise<PolicySponsorReconstruction> {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  const d = getDeps(options);
  const prepared = requireValue(state.prepared, 'consumed generic prepared entry');
  const revalidation = requireValue(state.revalidation, 'sponsor revalidation');
  const { senderAddress: txSender } = readAuthenticatedSponsorSubmission(
    ctx.authenticatedSubmission,
  );

  if (!revalidation.isNewUserSettle) return {};

  let credit;
  try {
    credit = await d.queryUserCredit(
      options.hostContext.sui,
      options.hostContext.packageId,
      options.hostContext.vaultRegistryId,
      txSender,
      options.hostContext.vaultsTableId,
    );
  } catch (err) {
    if (err instanceof CreditQueryInconsistentStateError) {
      emitSponsorDriftObserved({
        ...VAULT_DRIFT_STATE_INCONSISTENT,
        route: 'generic',
        receiptId: prepared.receiptId,
        sender: txSender,
        clientIp: ctx.clientIp,
      });
      const message = `Vault registry state inconsistent for ${err.userAddress}: ${err.message}`;
      setValidationFailure(state, message);
      throw sponsor.errors.sponsorValidation('SPONSOR_FAILED', message);
    }
    emitSponsorDriftObserved({
      ...VAULT_DRIFT_QUERY_FAILED,
      route: 'generic',
      receiptId: prepared.receiptId,
      sender: txSender,
      clientIp: ctx.clientIp,
    });
    const message = `Vault re-query failed before signing: ${
      err instanceof Error ? err.message : String(err)
    }`;
    setValidationFailure(state, message);
    throw sponsor.errors.sponsorValidation('SPONSOR_FAILED', message);
  }

  if (credit.vaultObjectId && !credit.needsCreate) {
    emitSponsorDriftObserved({
      ...VAULT_DRIFT_NEW_USER_VAULT_EXISTS,
      route: 'generic',
      receiptId: prepared.receiptId,
      sender: txSender,
      clientIp: ctx.clientIp,
    });
    const message = 'Vault registered after /prepare — retry /prepare with credit profile';
    setValidationFailure(state, message);
    throw sponsor.errors.sponsorValidation('REPREPARE_REQUIRED', message);
  }

  return {};
}

async function runGenericPreflight(
  options: GenericExecutionPolicyOptions,
  runtime: GenericExecutionPolicyState,
  ctx: SponsorValidatedContext,
): Promise<void> {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  const d = getDeps(options);
  const prepared = requireValue(state.prepared, 'consumed generic prepared entry');
  const revalidation = requireValue(state.revalidation, 'sponsor revalidation');
  const { senderAddress: txSender, txBytes } = readAuthenticatedSponsorSubmission(
    ctx.authenticatedSubmission,
  );
  const preflight = await d.runPreflight(options.hostContext.sui, txBytes);

  if (!preflight.success) {
    const failureMessage = suiExecutionErrorMessage(preflight.error);
    const subcode = classifySponsorFailureSubcode(preflight.error, options.hostContext.packageId, {
      kind: 'settlement',
      commands: revalidation.commands,
    });
    await d.recordSponsorFailureForAbuse(
      options.hostContext.abuseBlocker,
      ctx.clientIp,
      { kind: 'address', address: txSender },
      'PREFLIGHT_FAILED',
      { subcode, executionPathKey: prepared.executionPathKey },
    );
    state.sponsorResultOutcome = 'preflight_failure';
    state.sponsorResultEconomics = serializeSponsoredExecutionEconomics(
      unknownSponsoredExecutionEconomics(`preflight_failure: ${failureMessage}`),
    );
    throw sponsor.errors.sponsorPreflight(failureMessage, subcode);
  }

  const gasBudget = requireValue(state.gasBudget, 'gas budget');

  try {
    d.validateGenericSponsorNonloss(
      revalidation.settleArgs,
      preflight.gasUsed,
      mist(gasBudget),
      revalidation.freshConfig,
    );
  } catch (err) {
    if (err instanceof GenericSponsorPolicyError) {
      setValidationFailure(state, err.message);
      throw sponsor.errors.sponsorValidation(err.code, err.message);
    }
    throw err;
  }
}

async function classifyGenericSponsorResult(
  options: GenericExecutionPolicyOptions,
  runtime: GenericExecutionPolicyState,
  ctx: SponsorValidatedContext,
  result: import('../sessionTypes.js').ExecResult,
): Promise<void> {
  const sponsor = requireSponsor(options);
  const state = requireSponsorState(runtime);
  const d = getDeps(options);
  const prepared = requireValue(state.prepared, 'consumed generic prepared entry');
  const revalidation = requireValue(state.revalidation, 'sponsor revalidation');
  const { senderAddress: txSender } = readAuthenticatedSponsorSubmission(
    ctx.authenticatedSubmission,
  );

  if (!result.success) {
    const failureMessage = suiExecutionErrorMessage(result.error);
    if (result.isCongestion) {
      state.sponsorResultOutcome = 'congestion';
      state.sponsorResultDigest = result.digest;
      state.sponsorResultEconomics = serializeSponsoredExecutionEconomics(
        unknownSponsoredExecutionEconomics(SPONSOR_CONGESTION_FAILURE_REASON),
      );
      throw sponsor.errors.sponsorCongestion(failureMessage, result.digest);
    }

    const subcode = classifySponsorFailureSubcode(result.error, options.hostContext.packageId, {
      kind: 'settlement',
      commands: revalidation.commands,
    });
    await d.recordSponsorFailureForAbuse(
      options.hostContext.abuseBlocker,
      ctx.clientIp,
      { kind: 'address', address: txSender },
      'ONCHAIN_REVERT',
      { subcode, executionPathKey: prepared.executionPathKey },
    );
    state.sponsorResultOutcome = 'onchain_revert';
    state.sponsorResultDigest = result.digest;
    state.sponsorResultEconomics = deriveOnchainRevertEconomics(
      sponsorOnchainRevertFailureReason(failureMessage),
      result.gasUsed,
    );
    throw sponsor.errors.sponsorOnchain(result.digest, failureMessage, subcode, result.gasUsed);
  }

  state.sponsorResultOutcome = 'success';
  state.sponsorResultDigest = result.digest;
  state.lastSuccessResult = result;

  if (revalidation.settleArgs.orderIdHash.length === 32) {
    state.sponsorResultOrderIdHash = Buffer.from(revalidation.settleArgs.orderIdHash).toString(
      'hex',
    );
  }

  try {
    const { snapshot: economics, economics: resultEconomics } = deriveSettlementExecutionEconomics({
      gasUsed: result.gasUsed,
      recoveredGasMist: revalidation.settleArgs.executionCostClaim,
      hostFeeMist: revalidation.settleArgs.quotedHostFeeMist,
      protocolFeeMist: revalidation.freshConfig.protocolFlatFeeMist,
    });
    logStructuredEvent(SETTLEMENT_ECONOMICS_EXECUTION, {
      digest: result.digest,
      sponsorAddress: prepared.sponsorAddress,
      execution_cost_claim_mist: economics.executionCostClaim.toString(),
      fee_charged: economics.feeCharged.toString(),
      protocol_fee: economics.protocolFee.toString(),
      gross_gas: economics.grossGas.toString(),
      storage_rebate: economics.storageRebate.toString(),
      net_gas: economics.netGas.toString(),
      payout: economics.payout.toString(),
      payout_net: economics.payoutNet.toString(),
    });
    state.sponsorResultEconomics = serializeSponsoredExecutionEconomics(resultEconomics);
  } catch (err) {
    logStructuredEvent(
      SETTLEMENT_ECONOMICS_LOG_FAILED,
      {
        digest: result.digest,
        error: err instanceof Error ? err.message : String(err),
      },
      'warn',
    );
    state.sponsorResultEconomics = serializeSponsoredExecutionEconomics(
      unknownSponsoredExecutionEconomics(
        err instanceof Error ? err.message : 'economics_derivation_failed',
      ),
    );
  }
}

// -------------------------------------------------------------
// Shared helpers
// -------------------------------------------------------------

function handleCorruptPreparedEntry(
  errors: GenericSponsorErrorFactory,
  receiptId: string,
  error: unknown,
): Error {
  logStructuredEvent(PREPARE_ENTRY_CORRUPT, {
    stage: 'sponsor_read',
    route: 'generic',
    receipt_id: receiptId,
    error: error instanceof Error ? error.message : String(error),
  });
  return errors.sponsorValidation('SPONSOR_FAILED', 'Prepared transaction storage is corrupt');
}

function buildNonceReconstruction(prepared: GenericPreparedTxEntry) {
  return {
    nonce: prepared.nonce,
    senderAddress: prepared.senderAddress,
    receiptId: prepared.receiptId,
    inPtbNonceMatch: true,
  } as const;
}

function deriveOnchainRevertEconomics(
  reason: string,
  gasUsed: GasUsedFields,
): SponsorResultEconomics {
  try {
    return serializeSponsoredExecutionEconomics(deriveHostPaidGasEconomics(gasUsed, reason));
  } catch (err) {
    return serializeSponsoredExecutionEconomics(
      unknownSponsoredExecutionEconomics(
        `onchain_revert (gas parse failed: ${
          err instanceof Error ? err.message : String(err)
        }): ${reason}`,
      ),
    );
  }
}

function setValidationFailure(state: GenericSponsorRuntimeState, message: string): void {
  state.sponsorResultOutcome = 'validation_failure';
  state.sponsorResultEconomics = serializeSponsoredExecutionEconomics(
    unknownSponsoredExecutionEconomics(message),
  );
}

function buildPrepareEnv(ctx: HostContext): HostValidationEnv {
  return {
    network: ctx.network,
    settlementPayoutRecipientAddress: ctx.settlementPayoutRecipientAddress,
    configId: ctx.configId,
    vaultRegistryId: ctx.vaultRegistryId,
    packageId: ctx.packageId,
  };
}

function buildGenericSponsorEnv(ctx: HostContext): HostValidationEnv {
  return {
    ...buildPrepareEnv(ctx),
    allowedSettlementSwapPaths: ctx.allowedSettlementSwapPaths,
  };
}

function emitGenericDriftEvent(
  stage: string,
  subcode: string,
  receiptId: string,
  sender: string,
  clientIp: string,
): void {
  emitSponsorDriftObserved({
    stage,
    subcode,
    receiptId,
    sender,
    clientIp,
    route: 'generic',
  });
}

async function revalidateGenericSponsorPolicy(
  ctx: HostContext,
  prepared: GenericPreparedTxEntry,
  builtTx: Transaction,
  txSender: string,
  clientIp: string,
): Promise<RevalidateGenericResult> {
  ctx.invalidateConfigCache();
  const freshConfig = await ctx.getConfig();

  const env = buildGenericSponsorEnv(ctx);
  const builtTxData = builtTx.getData();
  const builtCommands = convertSdkCommands(builtTxData.commands);
  const l1 = validateGenericSettlementTransaction(builtTx, env);
  if (!l1.ok) {
    emitGenericDriftEvent(
      'l1_ptb_structure',
      l1.code ?? 'L1_UNKNOWN',
      prepared.receiptId,
      txSender,
      clientIp,
    );
    throw new GenericSponsorPolicyError(
      'REPREPARE_REQUIRED',
      `L1 validation failed (config drift): ${l1.message}`,
    );
  }

  let settleArgs: ExtractedSettleArgs;
  try {
    settleArgs = extractSettleArgsFromBuiltTx(builtCommands, builtTxData.inputs, env, {
      requirePaymentInputTrace: true,
    });
  } catch (err) {
    if (err instanceof PrepareValidationError) {
      const sub =
        typeof err.meta?.subcode === 'string' && err.meta.subcode !== ''
          ? err.meta.subcode
          : 'extraction_failed';
      emitGenericDriftEvent('settle_extraction', sub, prepared.receiptId, txSender, clientIp);
      throw new GenericSponsorPolicyError(
        'REPREPARE_REQUIRED',
        `Settle extraction failed (config drift): ${err.message}`,
      );
    }
    throw err;
  }

  const freshPolicyHashBytes = fromHex(computePolicyHash(buildPolicyFields(freshConfig)));
  const expectedOrderIdHash = prepared.orderId
    ? await sha256Bytes(new TextEncoder().encode(prepared.orderId))
    : new Uint8Array(0);
  const l2 = validateSettleArgs(
    settleArgs,
    freshConfig,
    env,
    freshPolicyHashBytes,
    expectedOrderIdHash,
  );
  if (!l2.ok) {
    emitGenericDriftEvent('l2_settle_args', l2.code, prepared.receiptId, txSender, clientIp);
    throw new GenericSponsorPolicyError(
      'REPREPARE_REQUIRED',
      `${l2.code} (config drift): ${l2.message}`,
    );
  }

  const paymentIntegrity = validatePaymentInputIntegrity(settleArgs.paymentInputTrace, {});
  if (!paymentIntegrity.ok) {
    const sub = paymentIntegrity.subcode ?? 'payment_integrity_failed';
    emitGenericDriftEvent('payment_integrity', sub, prepared.receiptId, txSender, clientIp);
    throw new GenericSponsorPolicyError(
      'REPREPARE_REQUIRED',
      `Payment-input integrity failed (config drift): ${paymentIntegrity.message}`,
    );
  }

  const isNewUserSettle = isNewUserSettleMoveCall(builtCommands, env.packageId);

  return { builtTx, commands: builtCommands, freshConfig, settleArgs, isNewUserSettle };
}

function validateGenericSponsorNonloss(
  settleArgs: ExtractedSettleArgs,
  gasUsed: GasUsedFields,
  gasBudget: Mist,
  onchainConfig: OnchainConfig,
): void {
  const simGas: Mist = mist(computeExecutionCostClaim(gasUsed).simGas);
  const executionCostClaim: Mist = mist(settleArgs.executionCostClaim);
  const l3 = validateNonlossSponsor(
    {
      simGas,
      gasVarianceFixedMist: settleArgs.gasVarianceFixedMist,
      slippageBufferMist: settleArgs.slippageBufferMist,
      executionCostClaim,
      gasBudget,
    },
    onchainConfig,
  );
  if (!l3.ok) {
    switch (l3.code) {
      case 'L3_NONLOSS_VIOLATION':
      case 'L3_GAS_BUDGET_EXCEEDED':
      case 'L3_SIM_GAS_OUT_OF_RANGE':
        throw new GenericSponsorPolicyError(l3.code, l3.message);
      default:
        throw new GenericExecutionPolicyError(
          `Nonloss validator returned non-current sponsor code: ${l3.code}`,
        );
    }
  }
}

function buildGenericExecutionPathKey(
  settlementSwapPath: AllowedSettlementSwapPath | undefined,
): string {
  if (settlementSwapPath) {
    return `${settlementSwapPath.tokenType}:${settlementSwapPath.hops.join(',')}:${settlementSwapPath.settlementSwapDirection}`;
  }
  return 'credit';
}

function parseReceiptIdBytes(receiptId: string): Uint8Array {
  if (!isReceiptId(receiptId)) {
    throw new GenericExecutionPolicyError('generic prepare receiptId is not canonical');
  }
  return fromHex(receiptId.slice(2));
}

function assertPrepareCtx(
  ctx: { readonly senderAddress: string; readonly clientIp: string },
  params: GenericPreparePolicyParams,
): void {
  if (ctx.senderAddress !== params.senderAddress || ctx.clientIp !== params.clientIp) {
    throw new GenericExecutionPolicyError(
      'generic prepare hook context does not match request-local policy params',
    );
  }
}

function requirePrepare(
  options: GenericExecutionPolicyOptions,
): NonNullable<GenericExecutionPolicyOptions['prepare']> {
  if (!options.prepare) {
    throw new GenericExecutionPolicyError('generic prepare policy runtime is not configured');
  }
  return options.prepare;
}

function requireSponsor(
  options: GenericExecutionPolicyOptions,
): NonNullable<GenericExecutionPolicyOptions['sponsor']> {
  if (!options.sponsor) {
    throw new GenericExecutionPolicyError('generic sponsor policy runtime is not configured');
  }
  return options.sponsor;
}

function requirePrepareState(runtime: GenericExecutionPolicyState): GenericPrepareRuntimeState {
  if (!runtime.prepare) {
    throw new GenericExecutionPolicyError('generic prepare runtime state is not configured');
  }
  return runtime.prepare;
}

function requireSponsorState(runtime: GenericExecutionPolicyState): GenericSponsorRuntimeState {
  if (!runtime.sponsor) {
    throw new GenericExecutionPolicyError('generic sponsor runtime state is not configured');
  }
  return runtime.sponsor;
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new GenericExecutionPolicyError(`missing ${label}`);
  }
  return value;
}

function getDeps(input: {
  readonly deps?: Partial<GenericExecutionPolicyDependencies>;
}): GenericExecutionPolicyDependencies {
  return { ...DEFAULT_DEPS, ...input.deps };
}

function logPrepareStage(stage: string, payload: Record<string, unknown> = {}): void {
  logStructuredEvent(PREPARE_STAGE, {
    route: 'generic',
    stage,
    ...payload,
  });
}
