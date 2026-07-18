/**
 * /prepare handler — public adapter over the SponsoredExecution prepare runner.
 *
 * The app-api route owns HTTP body validation and route-local gates. This
 * handler preserves the public `handlePrepare(ctx, params, extraCfg)` API
 * while delegating lifecycle order, reservation ownership, prepared-draft
 * construction, store commit, and cleanup to `runPrepareStateMachine`.
 */
import {
  GAS_MARGIN_CAP_BPS,
  SLIPPAGE_CAP_BPS,
  type SettleProfile,
  type SingleHopSettlementSwapPath,
} from '@stelis/contracts';
import type { AllowedSettlementSwapPath } from '@stelis/core-relay';
import type { StaticSettlementSwapPathDescriptorMap } from '@stelis/core-relay/server';
import type { HostContext } from '../context.js';
import { checkBlockedRequest } from '../abuseBlocking.js';
import { PrepareValidationError } from '../prepare/replay.js';
import { verifyPrepareAuthorization } from '../prepare/prepareAuthorization.js';
import { SponsorLeaseCommitError } from '../store/sponsorLeaseProof.js';
import { logStructuredEvent } from '../structuredEventLog.js';
import { PREPARE_SLOT_EXHAUSTED } from '../observability/events.js';
import {
  buildGenericPreparedDraftFields,
  createGenericExecutionPolicy,
  projectGenericPrepareResult,
} from '../session/sponsoredExecution/genericExecutionPolicy.js';
import {
  runPrepareStateMachine,
  RunnerSponsorSlotExhaustedError,
} from '../session/sponsoredExecution/runner.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface PrepareParams {
  /** User commands only — TransactionKind (base64). NO settle command. */
  txKindBytes: string;
  /** User wallet address */
  senderAddress: string;
  /** Settlement token type string (e.g. "0x...::deep::DEEP"). */
  settlementTokenType: string;
  /** Slippage tolerance in BPS. Default: `DEFAULT_SLIPPAGE_BPS`. */
  slippageBps?: number;
  /** Gas margin in BPS. Default: `DEFAULT_GAS_MARGIN_BPS`. */
  gasMarginBps?: number;
  /** Client IP address (for IP concurrency tracking) */
  clientIp: string;
  /** Optional order ID — external reference for payment tracking. Max 128 UTF-8 bytes. */
  orderId?: string;
  /** SHA-256 hash of txKindBytes, encoded as hex. */
  txKindBytesHash: string;
  /** Timestamp included in the signed prepare authorization message. */
  prepareAuthorizationTimestampMs: number;
  /** Client-generated nonce included in the signed prepare authorization message. */
  prepareAuthorizationRequestNonce: string;
  /** Wallet personal-message signature over the canonical prepare authorization message. */
  prepareAuthorizationSignature: string;
}

/** Additional config needed by /prepare but not in OnchainConfig. */
export interface PrepareHandlerConfig {
  deepbookPackageId: string;
  supportedSettlementSwapPaths: SingleHopSettlementSwapPath[];
  settlementSwapPathDescriptors: StaticSettlementSwapPathDescriptorMap;
  /** Pre-registered settlement swap paths for L2 validation. */
  allowedSettlementSwapPaths: AllowedSettlementSwapPath[];
  /**
   * Host-quoted fee per TX (MIST) — set from HOST_FEE_MIST env var.
   * Embedded in the settle PTB as `quoted_host_fee_mist`.
   * On-chain validates this <= max_host_fee_mist (EHostFeeCapExceeded).
   */
  quotedHostFeeMist: bigint;
}

export interface PrepareResult {
  /** Full transaction bytes — user-signable (base64) */
  txBytes: string;
  /** Unique receipt ID */
  receiptId: string;
  /** S-14: monotonic nonce assigned for this prepare */
  nonce: string;
  /** Transparent cost breakdown (all in MIST) */
  cost: {
    /** Simulated gas: computation + storage - rebate */
    simGas: string;
    /** Fixed gas variance margin (GAS_VARIANCE_FIXED_MIST) embedded on-chain */
    gasVarianceFixedMist: string;
    /** Slippage buffer MIST (0 for credit-only settle) */
    slippageBufferMist: string;
    /** Host-quoted fee per TX (MIST) */
    quotedHostFee: string;
    /** Protocol flat fee */
    protocolFee: string;
    /** executionCostClaim = simGas + gasVarianceFixedMist + slippageBufferMist (on-chain settle arg) */
    executionCostClaim: string;
    /** grossGas = computation + storage (before rebate) */
    grossGas: string;
  };
  profile: SettleProfile;
  quoteTimestampMs: number;
  policyHash: string;
  /** Echoed orderId if provided. */
  orderId?: string;
}

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

export async function handlePrepare(
  ctx: HostContext,
  params: PrepareParams,
  extraCfg: PrepareHandlerConfig,
): Promise<PrepareResult> {
  validatePrepareRequestShape(params);

  await verifyPrepareAuthorization(ctx, params);
  const blockedBySender = await checkBlockedRequest(ctx.abuseBlocker, params.clientIp, {
    kind: 'address',
    address: params.senderAddress,
  });
  if (blockedBySender.blocked) {
    throw new PrepareValidationError('ABUSE_BLOCKED', 'Request temporarily blocked');
  }

  const options = {
    hostContext: ctx,
    prepare: {
      params,
      config: extraCfg,
    },
  } as const;
  const { policy, state } = createGenericExecutionPolicy(options);

  try {
    return await runPrepareStateMachine(
      {
        inflightLimiter: ctx.prepareInflightLimiter,
        sponsorPool: ctx.sponsorPool,
        sponsoredExecutionStore: ctx.sponsoredExecutionStore,
      },
      {
        senderAddress: params.senderAddress,
        clientIp: params.clientIp,
        preparedDraftFields: () => buildGenericPreparedDraftFields(options, state),
        projectResponse: (input) => projectGenericPrepareResult(options, state, input),
      },
      policy,
    );
  } catch (err) {
    if (err instanceof RunnerSponsorSlotExhaustedError) {
      logStructuredEvent(PREPARE_SLOT_EXHAUSTED, {
        route: 'generic',
        pool_size: ctx.sponsorPool.size,
      });
      throw new PrepareValidationError(
        'NO_SPONSOR_SLOT',
        'All sponsor slots are currently in use. Try again shortly.',
      );
    }
    if (err instanceof SponsorLeaseCommitError) {
      throw new PrepareValidationError(
        'SPONSOR_LEASE_COMMIT_FAILED',
        `sponsor lease commit failed: ${err.message}`,
      );
    }
    throw err;
  }
}

function validatePrepareRequestShape(params: PrepareParams): void {
  if (params.orderId !== undefined) {
    const orderIdBytes = new TextEncoder().encode(params.orderId);
    if (orderIdBytes.length === 0 || orderIdBytes.length > 128) {
      throw new PrepareValidationError(
        'INVALID_ORDER_ID',
        `orderId must be 1-128 UTF-8 bytes, got ${orderIdBytes.length}`,
      );
    }
  }
  validateOptionalBps('slippageBps', params.slippageBps, SLIPPAGE_CAP_BPS, 'INVALID_SLIPPAGE_BPS');
  validateOptionalBps(
    'gasMarginBps',
    params.gasMarginBps,
    GAS_MARGIN_CAP_BPS,
    'INVALID_GAS_MARGIN_BPS',
  );
}

function validateOptionalBps(
  field: string,
  value: number | undefined,
  cap: number,
  code: 'INVALID_SLIPPAGE_BPS' | 'INVALID_GAS_MARGIN_BPS',
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0 || value > cap) {
    throw new PrepareValidationError(code, `${field} must be an integer between 0 and ${cap}`);
  }
}
