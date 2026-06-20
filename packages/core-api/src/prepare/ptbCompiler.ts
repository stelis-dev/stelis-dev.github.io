/**
 * ptbCompiler — PTB assembly from a fully determined SettlementPlan.
 *
 * Receives a SettlementPlan (produced by SettlementPlanner) and materializes
 * the settlement suffix onto the user's Transaction.
 *
 * This module must NOT:
 *   - Infer settlement swap path shape
 *   - Recalculate swap amounts
 *   - Make funding-source decisions
 *
 * Coin discovery (selectPaymentCoin) requires chain queries (sui.listCoins) and
 * is co-located here because coin selection is tightly coupled with PTB mutation
 * (merge/split/withdrawal). The orchestrator calls compileSwapSettlement which
 * encapsulates both discovery and mutation as a single atomic step. The
 * SettlementPlan.funding field provides the pre-decided funding source so the
 * compiler does not re-decide the funding path.
 *
 * DEEP fee coin is not materialized in the PTB. The Move swap entrypoint
 * creates `coin::zero<DEEP>(ctx)` internally, so DeepBook always takes the
 * input-fee path.
 */

import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { buildSwapAndSettlePtb, buildSettleWithCreditPtb } from '@stelis/core-relay';
import type { PrefixUsage, SettlementPlan } from './settlePlanTypes.js';
import { pickPreferredPaymentBaseCoin, selectPaymentCoin } from './coinSelection.js';
import { PrepareValidationError } from './replay.js';

// ─────────────────────────────────────────────
// Compiler: credit-only path
// ─────────────────────────────────────────────

/**
 * Compile a credit-only settlement onto the Transaction.
 */
export function compileCreditSettlement(
  tx: Transaction,
  plan: SettlementPlan,
  config: { packageId: string; configId: string; vaultRegistryId: string },
  vaultId: string,
): void {
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
    useCreditAmount: plan.funding.useCreditAmount,
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
    quoteTimestampMs: plan.audit.quoteTimestampMs,
    policyHash: plan.audit.policyHash,
    orderIdHash: plan.audit.orderIdHash,
  });
}

// ─────────────────────────────────────────────
// Compiler: swap path
// ─────────────────────────────────────────────

/** Context needed for swap compilation (coin selection requires chain queries). */
export interface SwapCompileContext {
  readonly sui: SuiGrpcClient;
  readonly packageId: string;
  readonly configId: string;
  readonly vaultRegistryId: string;
}

/**
 * Compile a swap settlement onto the Transaction.
 *
 * Steps:
 *   1. Select/create payment coin (coin_object | address_balance | mixed_topup)
 *   2. Call buildSwapAndSettlePtb with the plan's settlement swap path + audit fields
 *
 * Payment-coin selection is the only remaining async/chain-dependent step in the compiler.
 * This is acceptable because coin object selection requires real-time balance data
 * that cannot be pre-fetched at planning time without TOCTOU risk.
 *
 * DEEP fee coin is not materialized in the PTB: the Move entry creates
 * `coin::zero<DEEP>(ctx)` internally so DeepBook always runs the input-fee path.
 */
export async function compileSwapSettlement(
  tx: Transaction,
  plan: SettlementPlan,
  ctx: SwapCompileContext,
  senderAddress: string,
  vaultObjectId: string | null,
  prefixUsage: PrefixUsage,
): Promise<void> {
  const settlementSwapPath = plan.settlementSwapPath;

  // ── Payment coin selection ──────────────────────────────────────────────
  let paymentCoin: TransactionObjectArgument;

  if (plan.funding.source === 'coin_object') {
    ({ paymentCoin } = await selectPaymentCoin(
      ctx.sui,
      tx,
      senderAddress,
      settlementSwapPath.paymentTokenType,
      plan.swap.swapAmountSmallest,
      settlementSwapPath.paymentTokenSymbol,
      prefixUsage,
    ));
  } else if (plan.funding.source === 'address_balance') {
    const withdrawalInput = tx.withdrawal({
      amount: plan.swap.swapAmountSmallest,
      type: settlementSwapPath.paymentTokenType,
    });
    [paymentCoin] = tx.moveCall({
      target: '0x2::coin::redeem_funds',
      typeArguments: [settlementSwapPath.paymentTokenType],
      arguments: [withdrawalInput],
    });
  } else {
    // mixed_topup
    const usable = plan.funding.usableCoins;
    if (usable.length === 0) {
      throw new PrepareValidationError(
        'PAYMENT_COIN_CONFLICT',
        `Mixed topup selected but no usable ${settlementSwapPath.paymentTokenSymbol} coin objects remain after R-9 filtering.`,
      );
    }
    const baseCoin = pickPreferredPaymentBaseCoin(usable, prefixUsage);
    const baseCoinId = baseCoin.objectId;
    const toMerge = usable.filter((c) => c.objectId !== baseCoinId);
    if (toMerge.length > 0) {
      tx.mergeCoins(
        tx.object(baseCoinId),
        toMerge.map((c) => tx.object(c.objectId)),
      );
    }
    const withdrawalInput = tx.withdrawal({
      amount: plan.funding.redeemDelta,
      type: settlementSwapPath.paymentTokenType,
    });
    const [redeemedCoin] = tx.moveCall({
      target: '0x2::coin::redeem_funds',
      typeArguments: [settlementSwapPath.paymentTokenType],
      arguments: [withdrawalInput],
    });
    tx.mergeCoins(tx.object(baseCoinId), [redeemedCoin]);
    [paymentCoin] = tx.splitCoins(tx.object(baseCoinId), [plan.swap.swapAmountSmallest]);
  }

  // ── Settlement swap path args + PTB builder ────────────────────────────
  const variant = plan.variant!;

  const settlementSwapPathArgs = {
    settlementSwapDirection: settlementSwapPath.settlementSwapDirection,
    paymentTokenType: settlementSwapPath.paymentTokenType,
    poolId: settlementSwapPath.hops[0].poolId,
  };

  const sharedParams = {
    packageId: ctx.packageId,
    configId: ctx.configId,
    vaultRegistryId: ctx.vaultRegistryId,
    paymentCoinId: paymentCoin,
    swapAmount: plan.swap.swapAmountSmallest,
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
    quoteTimestampMs: plan.audit.quoteTimestampMs,
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
      useCreditAmount: plan.funding.useCreditAmount,
    });
  }
}
