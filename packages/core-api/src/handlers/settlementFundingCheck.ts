import type {
  RelaySettlementFundingCheckErrorCode,
  RelaySettlementFundingCheckResponse,
} from '@stelis/contracts';
import { RELAY_SETTLEMENT_FUNDING_CHECK_ERROR_CODES } from '@stelis/contracts';
import {
  CreditQueryInconsistentStateError,
  isSuiU64,
  queryUserCredit,
  validateGenericUserTransactionKind,
} from '@stelis/core-relay';
import type { HostContext } from '../context.js';
import {
  createSettlementFundingRunContext,
  evaluateCurrentSettlementFunding,
} from '../prepare/build.js';
import { deserializeUserTxKind, PrepareValidationError } from '../prepare/replay.js';
import { requireSettlementSwapPathConfig } from '../prepare/settlementSwapPathConfig.js';
import { deriveSettlementFundingProfile } from '../prepare/settlementPlanner.js';
import { InflightReservationImpl } from '../session/sponsoredExecution/reservations.js';
import type { PrepareHandlerConfig } from './prepare.js';

export interface SettlementFundingCheckParams {
  readonly txKindBytes: string;
  readonly senderAddress: string;
  readonly settlementTokenType: string;
  readonly estimatedExecutionCostClaimMist: bigint;
  readonly signal: AbortSignal;
}

function requireFundingCheckErrorCode(code: string): RelaySettlementFundingCheckErrorCode {
  if ((RELAY_SETTLEMENT_FUNDING_CHECK_ERROR_CODES as readonly string[]).includes(code)) {
    return code as RelaySettlementFundingCheckErrorCode;
  }
  throw new Error(`Settlement funding validation returned non-current code: ${code}`);
}

/**
 * Evaluate current settlement funding without reserving a sponsor, nonce, or
 * prepared receipt. The shared prepare in-flight lease is the only mutation.
 */
export async function handleSettlementFundingCheck(
  ctx: HostContext,
  params: SettlementFundingCheckParams,
  config: PrepareHandlerConfig,
): Promise<RelaySettlementFundingCheckResponse> {
  params.signal.throwIfAborted();
  if (!isSuiU64(params.estimatedExecutionCostClaimMist)) {
    throw new PrepareValidationError(
      'INVALID_AMOUNT',
      'estimatedExecutionCostClaimMist must be a non-negative Sui u64 bigint',
    );
  }

  const userTransaction = await deserializeUserTxKind(params.txKindBytes);
  const validation = validateGenericUserTransactionKind(
    userTransaction,
    {
      network: ctx.network,
      settlementPayoutRecipientAddress: ctx.settlementPayoutRecipientAddress,
      configId: ctx.configId,
      vaultRegistryId: ctx.vaultRegistryId,
      packageId: ctx.packageId,
    },
    params.settlementTokenType,
  );
  if (!validation.ok) {
    throw new PrepareValidationError(
      requireFundingCheckErrorCode(validation.code),
      validation.message,
    );
  }

  const { settlementSwapPath, descriptor } = requireSettlementSwapPathConfig(
    config.supportedSettlementSwapPaths,
    config.settlementSwapPathDescriptors,
    params.settlementTokenType,
  );

  const inflight = new InflightReservationImpl(ctx.prepareInflightLimiter);
  await inflight.acquire('settlement_funding_check');
  try {
    params.signal.throwIfAborted();
    let credit;
    let onchainConfig;
    try {
      [credit, onchainConfig] = await Promise.all([
        queryUserCredit(
          ctx.sui,
          ctx.packageId,
          ctx.vaultRegistryId,
          params.senderAddress,
          ctx.vaultsTableId,
        ),
        ctx.getConfig(),
      ]);
    } catch (error) {
      if (error instanceof CreditQueryInconsistentStateError) {
        throw new PrepareValidationError('VAULT_STATE_INCONSISTENT', error.message, {
          vaultId: error.vaultId,
          userAddress: error.userAddress,
        });
      }
      throw error;
    }

    params.signal.throwIfAborted();
    if (params.estimatedExecutionCostClaimMist > onchainConfig.maxClaimMist) {
      throw new PrepareValidationError(
        'CLAIM_WOULD_EXCEED_MAX',
        `Estimated execution cost claim ${params.estimatedExecutionCostClaimMist} exceeds maxClaimMist ${onchainConfig.maxClaimMist}`,
        {
          executionCostClaim: params.estimatedExecutionCostClaimMist.toString(),
          maxClaimMist: onchainConfig.maxClaimMist.toString(),
          isEstimate: true,
        },
      );
    }
    const fundingProfile = deriveSettlementFundingProfile(credit);
    const fundingRequest = {
      userTxKindBytes: params.txKindBytes,
      senderAddress: params.senderAddress,
      settlementSwapPath,
      descriptor,
      profile: fundingProfile.profile,
      vaultObjectId: fundingProfile.vaultObjectId,
      credit: credit.credit,
    };
    const fundingContext = {
      sui: ctx.sui,
      deepbookPackageId: config.deepbookPackageId,
      minSettleMist: onchainConfig.minSettleMist,
      quotedHostFeeMist: config.quotedHostFeeMist,
      protocolFlatFeeMist: onchainConfig.protocolFlatFeeMist,
    };
    const evaluation = await evaluateCurrentSettlementFunding(
      fundingContext,
      fundingRequest,
      params.estimatedExecutionCostClaimMist,
      createSettlementFundingRunContext(fundingContext, fundingRequest),
      params.signal,
    );
    params.signal.throwIfAborted();
    const estimatedExecutionCostClaimMist = params.estimatedExecutionCostClaimMist.toString();

    switch (evaluation.outcome) {
      case 'credit':
        return {
          status: 'likely_sufficient',
          source: 'vault_credit',
          estimatedExecutionCostClaimMist,
        };
      case 'funded':
        return {
          status: 'likely_sufficient',
          source: 'settlement_token',
          estimatedExecutionCostClaimMist,
          quotedRequiredSettlementTokenAmount:
            evaluation.executionQuote.swapAmountSmallest.toString(),
        };
      case 'insufficient':
        return {
          status: 'likely_insufficient',
          estimatedExecutionCostClaimMist,
          quotedRequiredSettlementTokenAmount:
            evaluation.executionQuote.swapAmountSmallest.toString(),
          availableSettlementTokenAmount: evaluation.availableSettlementTokenAmount.toString(),
        };
      case 'indeterminate':
        if (evaluation.reason === 'bounded_coin_discovery') {
          return {
            status: 'indeterminate',
            reason: 'bounded_coin_discovery',
            estimatedExecutionCostClaimMist,
            quotedRequiredSettlementTokenAmount:
              evaluation.executionQuote.swapAmountSmallest.toString(),
          };
        }
        return {
          status: 'indeterminate',
          reason: 'market_unavailable',
          estimatedExecutionCostClaimMist,
        };
    }
  } finally {
    await inflight.release();
  }
}
