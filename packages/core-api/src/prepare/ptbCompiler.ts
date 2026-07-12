/**
 * Materialize a fully determined SettlementPlan onto the user's Transaction.
 * Funding discovery, object selection, and amount calculation are forbidden in
 * this module; they are complete in `SettlementPlan.funding`.
 */
import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { buildSwapAndSettlePtb, buildSettleWithCreditPtb } from '@stelis/core-relay';
import type { PaymentInputIntegrityExpectation } from '@stelis/core-relay/server';
import type { SettlementPlan, SwapFundingResolution } from './settlePlanTypes.js';
import { PrepareValidationError } from './replay.js';

function compiledQuoteTimestampMs(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `[SETTLEMENT_PLAN] quoteTimestampMs must be a non-negative safe integer, got ${value}`,
    );
  }
  return BigInt(value);
}

function assertUniqueFundingCoinIds(
  funding: Extract<SwapFundingResolution, { source: 'coin_object' | 'mixed_topup' }>,
): void {
  let normalizedBaseCoinId: string;
  try {
    normalizedBaseCoinId = normalizeSuiAddress(funding.baseCoinId);
  } catch {
    throw new PrepareValidationError(
      'PAYMENT_COIN_CONFLICT',
      `Funding base ${funding.baseCoinId} is not a valid Sui object ID.`,
    );
  }
  const seen = new Set([normalizedBaseCoinId]);
  for (const objectId of funding.mergeCoinIds) {
    let normalizedObjectId: string;
    try {
      normalizedObjectId = normalizeSuiAddress(objectId);
    } catch {
      throw new PrepareValidationError(
        'PAYMENT_COIN_CONFLICT',
        `Funding merge source ${objectId} is not a valid Sui object ID.`,
      );
    }
    if (seen.has(normalizedObjectId)) {
      throw new PrepareValidationError(
        'PAYMENT_COIN_CONFLICT',
        `Funding object ${objectId} appears more than once in the resolved coin set.`,
      );
    }
    seen.add(normalizedObjectId);
  }
}

function assertFundingMatchesSwap(funding: SwapFundingResolution, swapAmount: bigint): void {
  if (swapAmount <= 0n) {
    throw new PrepareValidationError(
      'INVALID_AMOUNT',
      `Swap funding requires a positive bigint amount, got ${swapAmount}.`,
    );
  }
  if (funding.source === 'address_balance') {
    if (funding.redeemAmount !== swapAmount) {
      throw new PrepareValidationError(
        'PAYMENT_COIN_CONFLICT',
        'Address-balance funding must redeem the exact swap amount.',
      );
    }
    return;
  }

  assertUniqueFundingCoinIds(funding);
  if (funding.source === 'coin_object') {
    if (funding.remainingBalance < swapAmount) {
      throw new PrepareValidationError(
        'PAYMENT_COIN_CONFLICT',
        'Coin-object funding does not contain the resolved swap amount.',
      );
    }
    return;
  }

  if (
    funding.remainingBalance <= 0n ||
    funding.remainingBalance >= swapAmount ||
    funding.redeemAmount !== swapAmount - funding.remainingBalance
  ) {
    throw new PrepareValidationError(
      'PAYMENT_COIN_CONFLICT',
      'Mixed funding must combine the exact remaining coin balance with the exact redeem amount.',
    );
  }
}

function mergeResolvedCoinObjects(
  tx: Transaction,
  funding: Extract<SwapFundingResolution, { source: 'coin_object' | 'mixed_topup' }>,
): TransactionObjectArgument {
  const baseCoin = tx.object(funding.baseCoinId);
  if (funding.mergeCoinIds.length > 0) {
    tx.mergeCoins(
      baseCoin,
      funding.mergeCoinIds.map((objectId) => tx.object(objectId)),
    );
  }
  return baseCoin;
}

/** Compile a credit-only settlement and return its one integrity expectation. */
export function compileCreditSettlement(
  tx: Transaction,
  plan: SettlementPlan,
  config: { packageId: string; configId: string; vaultRegistryId: string },
  vaultId: string,
): PaymentInputIntegrityExpectation {
  if (plan.funding.source !== 'none_credit_only') {
    throw new Error('[SETTLEMENT_PLAN] Credit compiler requires none_credit_only funding');
  }
  const quoteTimestampMs = compiledQuoteTimestampMs(plan.audit.quoteTimestampMs);
  if (plan.audit.slippageBufferMist !== 0n) {
    throw new Error(
      `[SETTLEMENT_PLAN] Credit-only PTB requires slippageBufferMist=0, got ${plan.audit.slippageBufferMist}`,
    );
  }
  buildSettleWithCreditPtb(tx, {
    packageId: config.packageId,
    configId: config.configId,
    vaultRegistryId: config.vaultRegistryId,
    vaultId,
    useCreditAmount: plan.useCreditAmount,
    executionCostClaim: plan.audit.executionCostClaim,
    settlementPayoutRecipient: plan.audit.settlementPayoutRecipient,
    receiptId: plan.audit.receiptId,
    nonce: plan.audit.nonce,
    simGasReported: plan.audit.simGasReported,
    gasVarianceFixedMist: plan.audit.gasVarianceFixedMist,
    slippageBufferMist: plan.audit.slippageBufferMist,
    quotedHostFeeMist: plan.audit.quotedHostFeeMist,
    expectedProtocolFeeMist: plan.audit.expectedProtocolFeeMist,
    expectedConfigVersion: plan.audit.expectedConfigVersion,
    quoteTimestampMs,
    policyHash: plan.audit.policyHash,
    orderIdHash: plan.audit.orderIdHash,
  });
  return { source: 'none_credit_only', swapAmountSmallest: 0n };
}

export interface SwapCompileContext {
  readonly packageId: string;
  readonly configId: string;
  readonly vaultRegistryId: string;
}

/** Compile the exact resolved funding and settlement suffix without I/O. */
export function compileSwapSettlement(
  tx: Transaction,
  plan: SettlementPlan,
  ctx: SwapCompileContext,
  vaultObjectId: string | null,
): PaymentInputIntegrityExpectation {
  if (plan.funding.source === 'none_credit_only') {
    throw new Error('[SETTLEMENT_PLAN] Swap compiler requires swap funding');
  }
  const funding = plan.funding;
  const swapAmount = plan.swap.swapAmountSmallest;
  assertFundingMatchesSwap(funding, swapAmount);
  const variant = plan.variant;
  if (!variant) {
    throw new Error('[SETTLEMENT_PLAN] Swap plan has no compiled variant');
  }
  if (variant === 'with_vault' && !vaultObjectId) {
    throw new Error('[SETTLEMENT_PLAN] with_vault settlement requires a vault object ID');
  }

  const userData = tx.getData();
  const userCommandCount = userData.commands.length;
  const userInputCount = userData.inputs.length;
  const quoteTimestampMs = compiledQuoteTimestampMs(plan.audit.quoteTimestampMs);
  const settlementSwapPath = plan.settlementSwapPath;
  let paymentCoin: TransactionObjectArgument;

  if (funding.source === 'address_balance') {
    const withdrawalInput = tx.withdrawal({
      amount: funding.redeemAmount,
      type: settlementSwapPath.settlementTokenType,
    });
    [paymentCoin] = tx.moveCall({
      target: '0x2::coin::redeem_funds',
      typeArguments: [settlementSwapPath.settlementTokenType],
      arguments: [withdrawalInput],
    });
  } else {
    const baseCoin = mergeResolvedCoinObjects(tx, funding);
    if (funding.source === 'mixed_topup') {
      const withdrawalInput = tx.withdrawal({
        amount: funding.redeemAmount,
        type: settlementSwapPath.settlementTokenType,
      });
      const [redeemedCoin] = tx.moveCall({
        target: '0x2::coin::redeem_funds',
        typeArguments: [settlementSwapPath.settlementTokenType],
        arguments: [withdrawalInput],
      });
      tx.mergeCoins(baseCoin, [redeemedCoin]);
    }
    [paymentCoin] = tx.splitCoins(baseCoin, [swapAmount]);
  }

  const settlementSwapPathArgs = {
    settlementSwapDirection: settlementSwapPath.settlementSwapDirection,
    settlementTokenType: settlementSwapPath.settlementTokenType,
    poolId: settlementSwapPath.hops[0].poolId,
  };
  const sharedParams = {
    packageId: ctx.packageId,
    configId: ctx.configId,
    vaultRegistryId: ctx.vaultRegistryId,
    paymentCoinId: paymentCoin,
    swapAmount,
    minSuiOut: plan.swap.minSuiOut,
    executionCostClaim: plan.audit.executionCostClaim,
    settlementPayoutRecipient: plan.audit.settlementPayoutRecipient,
    receiptId: plan.audit.receiptId,
    nonce: plan.audit.nonce,
    simGasReported: plan.audit.simGasReported,
    gasVarianceFixedMist: plan.audit.gasVarianceFixedMist,
    slippageBufferMist: plan.audit.slippageBufferMist,
    quotedHostFeeMist: plan.audit.quotedHostFeeMist,
    expectedProtocolFeeMist: plan.audit.expectedProtocolFeeMist,
    expectedConfigVersion: plan.audit.expectedConfigVersion,
    quoteTimestampMs,
    policyHash: plan.audit.policyHash,
    orderIdHash: plan.audit.orderIdHash,
  };

  if (variant === 'new_user') {
    buildSwapAndSettlePtb(tx, { variant: 'new_user', ...settlementSwapPathArgs, ...sharedParams });
  } else {
    buildSwapAndSettlePtb(tx, {
      variant: 'with_vault',
      ...settlementSwapPathArgs,
      ...sharedParams,
      vaultId: vaultObjectId!,
      useCreditAmount: plan.useCreditAmount,
    });
  }

  return {
    source: funding.source,
    swapAmountSmallest: swapAmount,
    userCommandCount,
    userInputCount,
    ...(funding.source === 'address_balance'
      ? { addressBalanceRedeemAmount: funding.redeemAmount }
      : {
          baseCoinObjectId: funding.baseCoinId,
          mergeCoinObjectIds: [...funding.mergeCoinIds],
          ...(funding.source === 'mixed_topup'
            ? { addressBalanceRedeemAmount: funding.redeemAmount }
            : {}),
        }),
  };
}
