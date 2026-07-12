/**
 * Generic prepare build pipeline for /prepare.
 *
 * Implements the multi-stage build strategy:
 *   Credit probe: for credit_general candidates, dry-run a credit-only
 *             settlement PTB before settlement-token resolution.
 *   Pass 1:   Build with maxClaimMist → dry-run → extract actual gas
 *   Path decision: the pre-swap credit probe either selects final credit with
 *             zero slippage or leaves pass 1 / 1.5 / 2 on the swap path.
 *   Pass 2:   Rebuild with path-canonical executionCostClaim + slippageBuffer → final txBytes
 *
 * The Sui SDK does not allow modifying MoveCall arguments after construction,
 * so each pass creates a fresh Transaction.
 */
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import type { ExecutionCostClaimEstimate, SimulationGasUsed } from '@stelis/core-relay';
import type { PtbCommand, SingleHopSettlementSwapPath, SettleProfile } from '@stelis/contracts';
import type {
  ExecutableSwapQuote,
  PaymentInputIntegrityExpectation,
  PaymentInputSource,
  StaticSettlementSwapPathDescriptor,
} from '@stelis/core-relay/server';
import {
  batchGetHopMidPrices,
  convertSdkCommands,
  computeExecutionCostClaim,
  CONVERGENCE_TOLERANCE_BPS,
  PrefixValueTraceError,
  SlippageQueryError,
  traceUserPrefixValue,
  type PrefixValueTrace,
} from '@stelis/core-relay';
import {
  createDeepbookQuotePort,
  extractSettlePaymentInputContract,
  solveExecutableSwap,
  validatePaymentInputIntegrity,
  wrapQuotePortWithStats,
  wrapQuotePortWithCacheAndStats,
  createRequestQuoteCache,
  ExecutionGapExceededError,
  MarketQuoteUnavailableError,
  SwapUnviableUnderPolicyError,
} from '@stelis/core-relay/server';
import type { QuoteRpcStats, QuoteCache } from '@stelis/core-relay/server';
import { resolvePaymentSource } from './coinSelection.js';
import { PrepareValidationError } from './replay.js';
import {
  classifyDryRunFailure,
  safeBuild,
  buildSettleMeta as _buildSettleMeta,
} from './prepareErrors.js';
import {
  checkCreditOnlyEligibility,
  calculateRequiredSwapOutput,
  calculateSwapOutputGuards,
  assembleSwapSettlementPlan,
  assembleCreditSettlementPlan,
} from './settlementPlanner.js';
import type { PlannerConfig, PlannerInput } from './settlementPlanner.js';
import { compileCreditSettlement, compileSwapSettlement } from './ptbCompiler.js';
import type { SettlePlanAuditFields } from './settlePlanTypes.js';
import { logStructuredEvent } from '../structuredEventLog.js';
import { PREPARE_BUILD_STAGE } from '../observability/events.js';
import { createHash } from 'crypto';
import { mist, unBps, type Mist } from '../internal/brand.js';
import type {
  BuildContext,
  GenericPrepareBuildOutput,
  GenericPrepareBuildRequest,
} from './buildTypes.js';
export type {
  BuildContext,
  GenericPrepareBuildOutput,
  GenericPrepareBuildRequest,
} from './buildTypes.js';
import {
  absorbPassRpcStats,
  emptyBuildRpcAccumulator,
  emptyPreparePassRpcStats,
  emptyQuoteRpcStats,
  summarizeRpcStats,
  type BuildRpcAccumulator,
  type PreparePassRpcStats,
} from './buildRpcStats.js';

const DECIMAL_MIST_RE = /^(?:0|[1-9]\d*)$/;

function parseMistString(value: string, label: string): bigint {
  if (!DECIMAL_MIST_RE.test(value)) {
    throw new PrepareValidationError(
      'INVALID_AMOUNT_FORMAT',
      `${label} must be a non-negative decimal integer string.`,
    );
  }
  return BigInt(value);
}

function logPrepareBuildStage(stage: string, payload: Record<string, unknown> = {}): void {
  logStructuredEvent(PREPARE_BUILD_STAGE, {
    stage,
    ...payload,
  });
}

/**
 * Build the baseForQuote market-executable floor diagnostic payload from a solver
 * quote. Emitted in `PREPARE_BUILD_STAGE` events so operators can correlate
 * any downstream `INSUFFICIENT_BALANCE` (raised swap input vs. user's
 * settlement-token funding) with the floor that triggered the raise.
 *
 * `bfq_floor_raised` is true only on the baseForQuote branch and only when the solver
 * lifted the target. quoteForBase's existing minSize bump path keeps the field at
 * `false` so the diagnostic stays scoped to baseForQuote.
 */
function buildBfqFloorPayload(
  quote: { targetOutputMist: bigint; effectiveTargetOutputMist: bigint } | null,
  swapDirection?: 'baseForQuote' | 'quoteForBase',
): {
  bfq_floor_raised: boolean;
  target_output_mist: string;
  effective_target_output_mist: string;
} {
  if (!quote) {
    return {
      bfq_floor_raised: false,
      target_output_mist: '0',
      effective_target_output_mist: '0',
    };
  }
  return {
    bfq_floor_raised:
      swapDirection === 'baseForQuote' && quote.effectiveTargetOutputMist > quote.targetOutputMist,
    target_output_mist: quote.targetOutputMist.toString(),
    effective_target_output_mist: quote.effectiveTargetOutputMist.toString(),
  };
}

/**
 * Build diagnostic meta for INSUFFICIENT_SETTLE_INPUT errors.
 * Thin wrapper that unpacks BuildContext fields for prepareErrors.buildSettleMeta.
 */
function buildSettleMeta(
  ctx: BuildContext,
  claimEstimate: bigint,
  isEstimate: boolean,
): Record<string, string> {
  return _buildSettleMeta(
    ctx.minSettleMist,
    ctx.quotedHostFeeMist,
    ctx.protocolFlatFeeMist,
    claimEstimate,
    isEstimate,
  );
}

/**
 * Map BuildContext + GenericPrepareBuildRequest to planner-native types.
 * File-local dedup helper.
 */
function buildPlannerInputs(
  ctx: BuildContext,
  input: GenericPrepareBuildRequest,
): { config: PlannerConfig; input: PlannerInput } {
  return {
    config: {
      minSettleMist: ctx.minSettleMist,
      quotedHostFeeMist: ctx.quotedHostFeeMist,
      protocolFlatFeeMist: ctx.protocolFlatFeeMist,
    },
    input: {
      settlementSwapPath: input.settlementSwapPath,
      profile: input.profile,
      vaultObjectId: input.vaultObjectId,
      creditMist: parseMistString(input.credit, 'credit'),
    },
  };
}

type FinalSettlePath = 'credit' | 'swap';
type CreditProbeMeasurement =
  | { outcome: 'selected'; costs: ExecutionCostClaimEstimate }
  | { outcome: 'rejected' }
  | { outcome: 'skipped' };

function extractSuccessfulDryRunGas(
  simResult: unknown,
  stelisPackageId: string,
  commands: readonly PtbCommand[],
  meta: Record<string, string>,
): SimulationGasUsed {
  const simTx = (
    simResult as {
      Transaction?: {
        status?: { success?: boolean; error?: { message?: string } };
        effects?: { gasUsed?: SimulationGasUsed };
      };
    }
  ).Transaction;
  if (!simTx) {
    const simFailed = simResult as unknown as {
      $kind?: string;
      FailedTransaction?: { status?: { error?: { message?: string } } };
    };
    if (simFailed.$kind === 'FailedTransaction') {
      const reason = simFailed.FailedTransaction?.status?.error?.message ?? 'unknown';
      throw classifyDryRunFailure(reason, stelisPackageId, commands, meta);
    }
    throw new PrepareValidationError('DRY_RUN_FAILED', 'Dry-run returned no transaction result');
  }

  if (!simTx.status?.success) {
    const reason = (simTx.status as { error?: { message?: string } })?.error?.message ?? 'unknown';
    throw classifyDryRunFailure(reason, stelisPackageId, commands, meta);
  }

  const gasUsed = simTx.effects?.gasUsed;
  if (!gasUsed) {
    throw new PrepareValidationError('DRY_RUN_NO_GAS', 'Dry-run returned no gas usage');
  }

  return gasUsed as SimulationGasUsed;
}

async function dryRunForGas(
  ctx: BuildContext,
  tx: Transaction,
  meta: Record<string, string>,
  completedStage: string,
  pass: 'credit_preswap' | 'pass1',
  failureContext: { poolId: string; settlementTokenSymbol: string },
  quoteStats: QuoteRpcStats = emptyQuoteRpcStats(),
): Promise<SimulationGasUsed> {
  // Schema-shared invariant: dryrun_*_failed are lifecycle phase failures that
  // can carry partial quote stats. Per `pass_aborted_post_solve` (single-pass
  // shape, not aggregate), one `QuoteRpcStats` snapshot accompanies the emit.
  // `credit_preswap` callers omit `quoteStats` (path is upstream of any quote
  // solve so stats are zero). `pass1` callers pass `rpcAcc.pass1Quote` because
  // pass1 quote-solve has already accumulated by the time dryRunForGas runs.
  // `quote_rpc_stats_complete: false` because request-level quote work is not
  // complete yet (pass1.5 / pass2 unstarted, or credit-only path with no
  // remaining quote work).
  //
  // Quote-stat fields and the marker are inlined at each emit site rather than
  // spread from a shared object so `scripts/check-prepare-stage-schema.mjs`
  // can detect them via direct field-name regex (the lint does not follow
  // `...identifier` spreads).
  const poolId = failureContext.poolId;
  const settlementTokenSymbol = failureContext.settlementTokenSymbol;
  const commands = convertSdkCommands(tx.getData().commands as unknown[]);

  let dryRunBytes: Uint8Array;
  try {
    dryRunBytes = await safeBuild(tx, ctx.sui, ctx.packageId, meta);
  } catch (err) {
    logPrepareBuildStage('dryrun_safebuild_failed', {
      pass,
      pool_id: poolId,
      settlement_token_symbol: settlementTokenSymbol,
      error_code: err instanceof PrepareValidationError ? err.code : 'UNKNOWN',
      quote_quantity_in_rpc_calls: quoteStats.quantityInCalls,
      quote_quantity_out_verify_rpc_calls: quoteStats.quantityOutVerifyCalls,
      quote_total_rpc_calls: quoteStats.quantityInCalls + quoteStats.quantityOutVerifyCalls,
      quote_rpc_total_ms: quoteStats.totalDurationMs,
      quote_rpc_max_ms: quoteStats.maxDurationMs,
      quote_quantity_in_logical_calls: quoteStats.quantityInLogicalCalls,
      quote_quantity_out_verify_logical_calls: quoteStats.quantityOutVerifyLogicalCalls,
      quote_cache_hits: quoteStats.cacheHits,
      quote_rpc_stats_complete: false,
      phase_complete: false,
    });
    throw err;
  }

  let simResult: Awaited<ReturnType<typeof ctx.sui.simulateTransaction>>;
  try {
    simResult = await ctx.sui.simulateTransaction({
      transaction: dryRunBytes,
      include: { effects: true },
    });
  } catch (err) {
    logPrepareBuildStage('dryrun_simulate_failed', {
      pass,
      pool_id: poolId,
      settlement_token_symbol: settlementTokenSymbol,
      error_code: err instanceof PrepareValidationError ? err.code : 'UNKNOWN',
      quote_quantity_in_rpc_calls: quoteStats.quantityInCalls,
      quote_quantity_out_verify_rpc_calls: quoteStats.quantityOutVerifyCalls,
      quote_total_rpc_calls: quoteStats.quantityInCalls + quoteStats.quantityOutVerifyCalls,
      quote_rpc_total_ms: quoteStats.totalDurationMs,
      quote_rpc_max_ms: quoteStats.maxDurationMs,
      quote_quantity_in_logical_calls: quoteStats.quantityInLogicalCalls,
      quote_quantity_out_verify_logical_calls: quoteStats.quantityOutVerifyLogicalCalls,
      quote_cache_hits: quoteStats.cacheHits,
      quote_rpc_stats_complete: false,
      phase_complete: false,
    });
    throw err;
  }

  // `*_dryrun_simulated` marks "simulate returned"; classification by
  // `extractSuccessfulDryRunGas` may still throw below. Dual emit on extract
  // failure (simulated + dryrun_extract_failed) is intentional.
  logPrepareBuildStage(completedStage, {
    has_transaction: Boolean(simResult.Transaction),
  });

  try {
    return extractSuccessfulDryRunGas(simResult, ctx.packageId, commands, meta);
  } catch (err) {
    logPrepareBuildStage('dryrun_extract_failed', {
      pass,
      pool_id: poolId,
      settlement_token_symbol: settlementTokenSymbol,
      error_code: err instanceof PrepareValidationError ? err.code : 'UNKNOWN',
      has_transaction: Boolean(simResult.Transaction),
      completed_stage_emitted: true,
      quote_quantity_in_rpc_calls: quoteStats.quantityInCalls,
      quote_quantity_out_verify_rpc_calls: quoteStats.quantityOutVerifyCalls,
      quote_total_rpc_calls: quoteStats.quantityInCalls + quoteStats.quantityOutVerifyCalls,
      quote_rpc_total_ms: quoteStats.totalDurationMs,
      quote_rpc_max_ms: quoteStats.maxDurationMs,
      quote_quantity_in_logical_calls: quoteStats.quantityInLogicalCalls,
      quote_quantity_out_verify_logical_calls: quoteStats.quantityOutVerifyLogicalCalls,
      quote_cache_hits: quoteStats.cacheHits,
      quote_rpc_stats_complete: false,
      phase_complete: false,
    });
    throw err;
  }
}

function assertSingleHopOnly(settlementSwapPath: SingleHopSettlementSwapPath): void {
  if (settlementSwapPath.hops.length !== 1) {
    throw new PrepareValidationError(
      'SLIPPAGE_QUERY_FAILED',
      `Unsupported hop count ${settlementSwapPath.hops.length} (only one-hop settlement swap paths are supported)`,
      { stage: 'hop_validation', poolId: settlementSwapPath.hops[0]?.poolId ?? 'unknown' },
    );
  }
}

function materializePrefixValueTrace(
  tx: Transaction,
  settlementTokenType: string,
): PrefixValueTrace {
  let trace: PrefixValueTrace;
  try {
    trace = traceUserPrefixValue(tx, settlementTokenType);
  } catch (error) {
    if (error instanceof PrefixValueTraceError) {
      throw new PrepareValidationError('PAYMENT_COIN_CONFLICT', error.message);
    }
    throw error;
  }
  if (trace.unaccountableSenderWithdrawal) {
    throw new PrepareValidationError(
      'UNACCOUNTABLE_WITHDRAWAL',
      'Transaction contains a FundsWithdrawal(Sender) input that cannot be safely interpreted for address-balance accounting.',
    );
  }
  return trace;
}

/** Verify the resolver/compiler contract against the final command list once. */
function assertFinalPaymentInputIntegrity(
  tx: Transaction,
  packageId: string,
  expected: PaymentInputIntegrityExpectation,
): void {
  try {
    const data = tx.getData();
    const contract = extractSettlePaymentInputContract(
      convertSdkCommands(data.commands as unknown[]),
      data.inputs,
      packageId,
    );
    const result = validatePaymentInputIntegrity(contract.paymentInputTrace, expected);
    if (!result.ok) {
      throw new PrepareValidationError(
        'L2_EXTRACT_FAILED',
        `Final payment-input integrity failed: ${result.message}`,
        { subcode: result.subcode },
      );
    }
  } catch (error) {
    if (error instanceof PrepareValidationError) throw error;
    throw new PrepareValidationError(
      'L2_EXTRACT_FAILED',
      `Final payment-input extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadRawMidPrices(
  ctx: BuildContext,
  descriptor: StaticSettlementSwapPathDescriptor,
  stage: string,
): Promise<bigint[]> {
  try {
    return await batchGetHopMidPrices(ctx.sui, ctx.deepbookPackageId, descriptor.hops);
  } catch (err) {
    if (err instanceof SlippageQueryError) {
      throw new PrepareValidationError(
        'SLIPPAGE_QUERY_FAILED',
        `Mid-price query failed: ${err.message}`,
        {
          stage,
          poolId: descriptor.hops[0]?.poolId ?? 'unknown',
        },
      );
    }
    throw err;
  }
}

function normalizeMarketPolicyError(
  err: unknown,
  descriptor: StaticSettlementSwapPathDescriptor,
  stage: string,
): never {
  const poolId = descriptor.hops[0]?.poolId ?? 'unknown';
  if (err instanceof MarketQuoteUnavailableError) {
    throw new PrepareValidationError('SLIPPAGE_QUERY_FAILED', err.message, { stage, poolId });
  }
  if (err instanceof ExecutionGapExceededError) {
    throw new PrepareValidationError('SLIPPAGE_EXCEEDED', err.message, { stage, poolId });
  }
  if (err instanceof SwapUnviableUnderPolicyError) {
    throw new PrepareValidationError('SLIPPAGE_EXCEEDED', err.message, { stage, poolId });
  }
  throw err;
}

// Classify a quote-solve failure for the failure-path observability emit.
// Mirrors the routing in normalizeMarketPolicyError but returns the public
// error code string (not a thrown error) so the catch site can emit before
// rethrowing. UNKNOWN covers errors that normalizeMarketPolicyError rethrows
// as-is (network glitches, unexpected throw types, etc.).
function classifyQuoteFailure(
  err: unknown,
): 'SLIPPAGE_QUERY_FAILED' | 'SLIPPAGE_EXCEEDED' | 'UNKNOWN' {
  if (err instanceof MarketQuoteUnavailableError) return 'SLIPPAGE_QUERY_FAILED';
  if (err instanceof ExecutionGapExceededError) return 'SLIPPAGE_EXCEEDED';
  if (err instanceof SwapUnviableUnderPolicyError) return 'SLIPPAGE_EXCEEDED';
  return 'UNKNOWN';
}

// File-local pass-label set. `runPreparePass` accepts the base set;
// `solveSwapForClaim` additionally reaches the direct `'pass1_5'` callsite.
// `credit_preswap` is included in the base set for type alignment with the
// caller; control flow inside `runPreparePass` short-circuits the credit-only
// path before reaching `solveSwapForClaim`, so it does not appear at runtime
// today but the type stays honest with the caller signature.
type PreparePassLabel = 'credit_preswap' | 'pass1' | 'pass2';
type QuoteSolvePass = PreparePassLabel | 'pass1_5';

interface SolveSwapResult {
  quote: ExecutableSwapQuote;
  rpcStats: QuoteRpcStats;
}

async function solveSwapForClaim(
  ctx: BuildContext,
  input: GenericPrepareBuildRequest,
  executionCostClaim: bigint,
  rawMidPrices: readonly bigint[],
  stage: string,
  pass: QuoteSolvePass,
  enforceExecutionGapCap = true,
  quoteCache?: QuoteCache,
): Promise<SolveSwapResult> {
  const { config: plannerConfig, input: plannerInput } = buildPlannerInputs(ctx, input);
  const targetOutputMist = calculateRequiredSwapOutput(
    plannerConfig,
    plannerInput,
    executionCostClaim,
  );
  const basePort = createDeepbookQuotePort(ctx.sui, ctx.deepbookPackageId);
  const { port, stats } = quoteCache
    ? wrapQuotePortWithCacheAndStats(basePort, quoteCache)
    : wrapQuotePortWithStats(basePort);
  try {
    const quote = await solveExecutableSwap(
      {
        descriptor: input.descriptor,
        targetOutputMist,
        rawMidPrices,
        enforceExecutionGapCap,
      },
      port,
    );
    return { quote, rpcStats: stats };
  } catch (err) {
    // Failure-path observability: emit partial quote-RPC stats before
    // normalizeMarketPolicyError throws. Stats are scoped to this solve
    // (mid-price RPC counts live on the request-level accumulator and are
    // not aggregated here), so the payload is flagged partial.
    //
    // `target_output_mist` is the planner-computed economic target that the
    // solver attempted before throwing. The solver throws before
    // `effectiveTargetOutputMist` is exposed, so `effective_target_output_mist`
    // is intentionally absent on this path — the symmetric counterpart on
    // success-path stages already carries both fields. Operators triaging a
    // failed quote can correlate this target with the request's economic
    // claim and any subsequent `INSUFFICIENT_BALANCE` retry.
    //
    // Logical / cache-hit fields mirror the success-path emit. They are
    // best-effort partial — the solve threw before completion, so they
    // reflect only the dispatches and cache lookups that occurred before
    // the throw. `quote_rpc_stats_complete: false` continues to flag the
    // partial state.
    logPrepareBuildStage('quote_rpc_failed', {
      pass,
      error_code: classifyQuoteFailure(err),
      pool_id: input.descriptor.hops[0]?.poolId ?? 'unknown',
      settlement_token_symbol: input.settlementSwapPath.settlementTokenSymbol,
      target_output_mist: targetOutputMist.toString(),
      quote_quantity_in_rpc_calls: stats.quantityInCalls,
      quote_quantity_out_verify_rpc_calls: stats.quantityOutVerifyCalls,
      quote_total_rpc_calls: stats.quantityInCalls + stats.quantityOutVerifyCalls,
      quote_quantity_in_logical_calls: stats.quantityInLogicalCalls,
      quote_quantity_out_verify_logical_calls: stats.quantityOutVerifyLogicalCalls,
      quote_cache_hits: stats.cacheHits,
      quote_rpc_total_ms: stats.totalDurationMs,
      quote_rpc_max_ms: stats.maxDurationMs,
      quote_rpc_stats_complete: false,
    });
    return normalizeMarketPolicyError(err, input.descriptor, stage);
  }
}

function findCreditSafeSeedClaim(
  ctx: BuildContext,
  input: GenericPrepareBuildRequest,
): bigint | null {
  const { config: plannerConfig, input: plannerInput } = buildPlannerInputs(ctx, input);
  const isEligible = (claim: bigint): boolean =>
    checkCreditOnlyEligibility(plannerConfig, plannerInput, claim) !== null;

  if (!isEligible(0n)) {
    return null;
  }
  if (isEligible(ctx.maxClaimMist)) {
    return ctx.maxClaimMist;
  }

  let low = 0n;
  let high = ctx.maxClaimMist;
  let best = 0n;
  while (low <= high) {
    const mid = (low + high) / 2n;
    if (isEligible(mid)) {
      best = mid;
      low = mid + 1n;
    } else {
      high = mid - 1n;
    }
  }
  return best;
}

function shouldAttemptPreSwapCreditProbe(input: GenericPrepareBuildRequest): boolean {
  return input.profile === 'credit_general' && Boolean(input.vaultObjectId);
}

async function dryRunPreSwapCreditPathCosts(
  ctx: BuildContext,
  input: GenericPrepareBuildRequest,
  runContext: GenericPrepareBuildRunContext,
): Promise<CreditProbeMeasurement> {
  const seedClaim = findCreditSafeSeedClaim(ctx, input);
  if (seedClaim === null) {
    logPrepareBuildStage('credit_preswap_probe_skipped', {
      reason: 'no_credit_safe_seed',
      credit_mist: input.credit,
      max_claim_mist: ctx.maxClaimMist.toString(),
    });
    return { outcome: 'skipped' };
  }

  logPrepareBuildStage('credit_preswap_probe_seed_selected', {
    seed_execution_cost_claim_mist: seedClaim.toString(),
    max_claim_mist: ctx.maxClaimMist.toString(),
  });

  const { tx, effectiveProfile, swapAmountSmallest, paymentInputSource } = await runPreparePass(
    ctx,
    input,
    runContext.prefixTrace,
    {
      executionCostClaim: seedClaim,
      simGasReported: seedClaim,
      gasVarianceFixedMist: 0n,
      slippageBufferMist: 0n,
      quotedHostFeeMist: ctx.quotedHostFeeMist,
      expectedProtocolFeeMist: ctx.protocolFlatFeeMist,
      expectedConfigVersion: ctx.configVersion,
    },
    undefined,
    'credit_preswap',
    'credit',
  );

  if (
    effectiveProfile !== 'credit_general' ||
    paymentInputSource !== 'none_credit_only' ||
    swapAmountSmallest !== 0n
  ) {
    throw new PrepareValidationError(
      'DRY_RUN_FAILED',
      'Pre-swap credit probe did not produce a credit-only settlement path',
      {
        effectiveProfile,
        paymentInputSource,
        swapAmountSmallest: swapAmountSmallest.toString(),
      },
    );
  }

  tx.setSender(input.senderAddress);
  tx.setGasOwner(input.sponsorAddress);
  tx.setGasBudget(ctx.maxClaimMist);

  const meta = buildSettleMeta(ctx, seedClaim, false);
  const gasUsed = await dryRunForGas(
    ctx,
    tx,
    meta,
    'credit_preswap_dryrun_simulated',
    'credit_preswap',
    {
      poolId: input.descriptor.hops[0]?.poolId ?? 'unknown',
      settlementTokenSymbol: input.settlementSwapPath.settlementTokenSymbol,
    },
  );
  const creditCosts = computeExecutionCostClaim(gasUsed);
  logPrepareBuildStage('credit_preswap_costs_extracted', {
    seed_execution_cost_claim_mist: seedClaim.toString(),
    sim_gas_mist: creditCosts.simGas.toString(),
    gross_gas_mist: creditCosts.grossGas.toString(),
    gas_variance_fixed_mist: creditCosts.gasVarianceFixedMist.toString(),
    execution_cost_claim_mist: creditCosts.executionCostClaim.toString(),
  });

  if (creditCosts.executionCostClaim > ctx.maxClaimMist) {
    throwClaimWouldExceedMax(ctx, creditCosts);
  }

  const { config: plannerConfig, input: plannerInput } = buildPlannerInputs(ctx, input);
  const verifiedCreditCheck = checkCreditOnlyEligibility(
    plannerConfig,
    plannerInput,
    creditCosts.executionCostClaim,
  );
  if (!verifiedCreditCheck) {
    logPrepareBuildStage('credit_preswap_rejected_after_dryrun', {
      seed_execution_cost_claim_mist: seedClaim.toString(),
      measured_execution_cost_claim_mist: creditCosts.executionCostClaim.toString(),
      credit_mist: input.credit,
    });
    return { outcome: 'rejected' };
  }

  logPrepareBuildStage('credit_preswap_final_path_selected', {
    seed_execution_cost_claim_mist: seedClaim.toString(),
    measured_execution_cost_claim_mist: creditCosts.executionCostClaim.toString(),
    use_credit_amount_mist: verifiedCreditCheck.useCreditAmount.toString(),
    slippage_buffer_mist: creditCosts.slippageBufferMist.toString(),
  });
  return { outcome: 'selected', costs: creditCosts };
}

function throwClaimWouldExceedMax(ctx: BuildContext, costs: ExecutionCostClaimEstimate): never {
  logPrepareBuildStage('claim_exceeds_max', {
    execution_cost_claim_mist: costs.executionCostClaim.toString(),
    max_claim_mist: ctx.maxClaimMist.toString(),
    sim_gas_mist: costs.simGas.toString(),
    slippage_buffer_mist: costs.slippageBufferMist.toString(),
  });
  throw new PrepareValidationError(
    'CLAIM_WOULD_EXCEED_MAX',
    `Computed execution cost claim ${costs.executionCostClaim} exceeds maxClaimMist ${ctx.maxClaimMist}`,
    {
      executionCostClaim: costs.executionCostClaim.toString(),
      maxClaimMist: ctx.maxClaimMist.toString(),
      simGas: costs.simGas.toString(),
      gasVarianceFixedMist: costs.gasVarianceFixedMist.toString(),
      slippageBufferMist: costs.slippageBufferMist.toString(),
    },
  );
}

async function buildFinalGenericPrepareResult(
  ctx: BuildContext,
  input: GenericPrepareBuildRequest,
  finalCosts: ExecutionCostClaimEstimate,
  finalSettlePath: FinalSettlePath,
  prefetchedMidPrices: bigint[] | undefined,
  probeQuote: ExecutableSwapQuote | null,
  runContext: GenericPrepareBuildRunContext,
): Promise<GenericPrepareBuildOutput> {
  const { prefixTrace, quoteCache, rpcAcc } = runContext;
  const settlementSwapPath = input.settlementSwapPath;
  const { grossGas, gasVarianceFixedMist, slippageBufferMist } = finalCosts;
  // Tag the two fields consumed by downstream sponsor / store code.
  // Other bigint fields are co-located audit data and stay untagged.
  const simGas: Mist = mist(finalCosts.simGas);
  const executionCostClaim: Mist = mist(finalCosts.executionCostClaim);
  logPrepareBuildStage('final_costs_ready', {
    final_settle_path: finalSettlePath,
    sim_gas_mist: simGas.toString(),
    gross_gas_mist: grossGas.toString(),
    gas_variance_fixed_mist: gasVarianceFixedMist.toString(),
    slippage_buffer_mist: slippageBufferMist.toString(),
    execution_cost_claim_mist: executionCostClaim.toString(),
    max_claim_mist: ctx.maxClaimMist.toString(),
  });

  // Fail-closed before pass2 build: on-chain settle enforces execution_cost_claim_mist <= max_claim_mist
  // (`settle::EClaimTooHigh`). Reject here with an explicit typed error so
  // we do not rely on downstream MoveAbort parsing for this deterministic boundary.
  if (executionCostClaim > ctx.maxClaimMist) {
    throwClaimWouldExceedMax(ctx, finalCosts);
  }

  // ── Pass 2: Final build with confirmed executionCostClaim + actual audit fields ─

  const {
    tx: pass2Tx,
    effectiveProfile,
    swapAmountSmallest: swapFinal,
    paymentInputSource,
    paymentInputIntegrityExpectation,
    executionQuote: pass2ExecutionQuote,
    rpcStats: pass2RpcStats,
  } = await runPreparePass(
    ctx,
    input,
    prefixTrace,
    {
      executionCostClaim,
      simGasReported: simGas,
      gasVarianceFixedMist,
      slippageBufferMist,
      quotedHostFeeMist: ctx.quotedHostFeeMist,
      expectedProtocolFeeMist: ctx.protocolFlatFeeMist,
      expectedConfigVersion: ctx.configVersion,
    },
    prefetchedMidPrices,
    'pass2',
    finalSettlePath,
    quoteCache,
  );
  absorbPassRpcStats(rpcAcc, pass2RpcStats);
  rpcAcc.pass2Quote = pass2RpcStats.quote;

  logPrepareBuildStage('pass2_compiled', {
    effective_profile: effectiveProfile,
    swap_amount_smallest: swapFinal.toString(),
    payment_input_source: paymentInputSource,
    pass2_quantity_in_rpc_calls: rpcAcc.pass2Quote.quantityInCalls,
  });

  // ── Pass 2 convergence re-verification (swap paths only) ────────────────

  if (probeQuote && pass2ExecutionQuote) {
    const residualSlippage = pass2ExecutionQuote.executionGapMist;
    logPrepareBuildStage('pass2_convergence_measured', {
      swap_probe_amount_smallest: probeQuote.swapAmountSmallest.toString(),
      swap_final_amount_smallest: swapFinal.toString(),
      residual_slippage_mist: residualSlippage.toString(),
      initial_slippage_buffer_mist: finalCosts.slippageBufferMist.toString(),
    });

    const slippageBuffer0 = finalCosts.slippageBufferMist;
    // Convergence check: does the residual slippage diverge from the initial measurement?
    //
    // Two cases:
    // (a) buffer₀ > 0: ratio check — residual must not exceed buffer₀ × (1 + tolerance)
    // (b) buffer₀ = 0 but residual > 0: initial measurement said "no slippage"
    //     and residual slippage is present — fail-closed to prevent
    //     under-collateralized swap.
    if (slippageBuffer0 === 0n && residualSlippage > 0n) {
      throw new PrepareValidationError(
        'SLIPPAGE_CONVERGENCE_FAILED',
        'Execution gap appeared after initial measurement showed zero',
        {
          stage: 'pass2',
          poolId: settlementSwapPath.hops[0].poolId,
          swapAmount: String(swapFinal),
          residualSlippage: String(residualSlippage),
        },
      );
    }
    if (
      slippageBuffer0 > 0n &&
      residualSlippage * 10_000n > slippageBuffer0 * BigInt(10_000 + CONVERGENCE_TOLERANCE_BPS)
    ) {
      throw new PrepareValidationError(
        'SLIPPAGE_CONVERGENCE_FAILED',
        'Execution gap re-verification exceeded tolerance',
        {
          stage: 'pass2',
          poolId: settlementSwapPath.hops[0].poolId,
          swapAmount: String(swapFinal),
          convergenceRatio: String((residualSlippage * 10_000n) / slippageBuffer0),
          capBps: String(CONVERGENCE_TOLERANCE_BPS),
        },
      );
    }
  }

  pass2Tx.setSender(input.senderAddress);
  pass2Tx.setGasOwner(input.sponsorAddress);

  // gasBudget = grossGas × (1 + gasMarginBps / 10000), capped at maxClaimMist.
  // `unBps()` marks the explicit drop of the Bps brand at the
  // arithmetic boundary. The result is a raw bigint because gasBudget
  // is not persisted on the store entry; it is read back from the PTB.
  const rawGasBudget = (grossGas * BigInt(10000 + unBps(input.gasMarginBps))) / 10000n;
  const gasBudget = rawGasBudget > ctx.maxClaimMist ? ctx.maxClaimMist : rawGasBudget;
  pass2Tx.setGasBudget(gasBudget);

  const settleMeta = buildSettleMeta(ctx, executionCostClaim, false);
  let txBytes: Uint8Array;
  try {
    txBytes = await safeBuild(pass2Tx, ctx.sui, ctx.packageId, settleMeta);
  } catch (err) {
    // Final-build failure is the last gap before `two_pass_complete`. Without
    // this emit the request loses phase-local context for the failure (the
    // handler-level `prepare_failed_after_checkout` log still fires but is
    // coarser). At this point all quote work has already completed, so include
    // the complete request-level quote-stats payload even though the final build
    // phase itself failed.
    const rpcSummary = summarizeRpcStats(rpcAcc);
    logPrepareBuildStage('pass2_safebuild_failed', {
      pass: 'pass2',
      error_code: err instanceof PrepareValidationError ? err.code : 'UNKNOWN',
      pool_id: input.descriptor.hops[0]?.poolId ?? 'unknown',
      settlement_token_symbol: input.settlementSwapPath.settlementTokenSymbol,
      quote_quantity_in_rpc_calls: rpcSummary.quoteQuantityInCalls,
      quote_quantity_out_verify_rpc_calls: rpcSummary.quoteQuantityOutVerifyCalls,
      quote_total_rpc_calls: rpcSummary.quoteTotalRpcCalls,
      quote_rpc_total_ms: rpcSummary.quoteRpcTotalMs,
      quote_rpc_max_ms: rpcSummary.quoteRpcMaxMs,
      quote_quantity_in_logical_calls: rpcSummary.quoteQuantityInLogicalCalls,
      quote_quantity_out_verify_logical_calls: rpcSummary.quoteQuantityOutVerifyLogicalCalls,
      quote_cache_hits: rpcSummary.quoteCacheHits,
      quote_rpc_stats_complete: true,
      phase_complete: false,
      ...buildBfqFloorPayload(pass2ExecutionQuote, input.settlementSwapPath.hops[0]?.swapDirection),
    });
    throw err;
  }

  // ── Tamper-proof hash ───────────────────────────────────────────────────

  // `safeBuild` has accepted the final PTB. Before hashing it, confirm that
  // the suffix still contains the exact objects and amounts selected by the
  // funding resolver.
  assertFinalPaymentInputIntegrity(pass2Tx, ctx.packageId, paymentInputIntegrityExpectation);

  const txBytesHash = sha256Hex(txBytes);
  const rpcSummary = summarizeRpcStats(rpcAcc);
  logPrepareBuildStage('two_pass_complete', {
    tx_bytes_hash: txBytesHash,
    execution_cost_claim_mist: executionCostClaim.toString(),
    sim_gas_mist: simGas.toString(),
    slippage_buffer_mist: slippageBufferMist.toString(),
    gross_gas_mist: grossGas.toString(),
    effective_profile: effectiveProfile,
    payment_input_source: paymentInputSource,
    // RPC dispatch counts. Cache hits do NOT increment these.
    quote_quantity_in_rpc_calls: rpcSummary.quoteQuantityInCalls,
    quote_quantity_out_verify_rpc_calls: rpcSummary.quoteQuantityOutVerifyCalls,
    quote_total_rpc_calls: rpcSummary.quoteTotalRpcCalls,
    quote_rpc_total_ms: rpcSummary.quoteRpcTotalMs,
    quote_rpc_max_ms: rpcSummary.quoteRpcMaxMs,
    // Logical solve counts (cache hit + miss). Equal to RPC counts when no
    // cache fires; strictly greater when the cache absorbs identical-target
    // dispatches across pass1 / pass1.5 / pass2.
    quote_quantity_in_logical_calls: rpcSummary.quoteQuantityInLogicalCalls,
    quote_quantity_out_verify_logical_calls: rpcSummary.quoteQuantityOutVerifyLogicalCalls,
    // Cache hit count summed across both primitives. Equals
    //   (logical_in - rpc_in) + (logical_out_verify - rpc_out_verify).
    // Stays at 0 when the cache is empty or every solve produces a unique
    // (hop, direction, argument) tuple.
    quote_cache_hits: rpcSummary.quoteCacheHits,
    // Symmetry marker with `quote_rpc_failed` (which carries `false`):
    // success-aggregate emits all four RPC dimensions (mid_price, quantity_in,
    // quantity_out_verify) summed over the request, so this is the complete
    // count.
    quote_rpc_stats_complete: true,
    ...buildBfqFloorPayload(pass2ExecutionQuote, input.settlementSwapPath.hops[0]?.swapDirection),
  });

  return {
    txBytes,
    txBytesHash,
    executionCostClaim,
    simGas,
    gasVarianceFixedMist,
    slippageBufferMist,
    grossGas,
    profile: effectiveProfile,
    paymentInputSource,
    swapAmountSmallest: swapFinal,
  };
}

// ─────────────────────────────────────────────
// Prepare build pipeline
// ─────────────────────────────────────────────

/**
 * Execute the generic prepare build pipeline in code order:
 *   Credit probe: for eligible credit_general requests, measure a credit-only
 *             candidate before requiring settlement-token funding for a swap probe.
 *   Pass 1:   dry-run with maxClaimMist to extract actual gas.
 *   Path decision: if the pre-swap credit probe did not select credit, the
 *             remaining final path is swap and must measure execution gap.
 *   Pass 2:   rebuild with confirmed executionCostClaim + actual audit fields.
 *   Pass 2 convergence recheck: compare residual execution gap for the
 *             final executable quote against the pass 1.5 embedded buffer
 *             (swap paths only).
 */
interface GenericPrepareBuildRunContext {
  readonly rpcAcc: BuildRpcAccumulator;
  readonly quoteCache: QuoteCache;
  readonly prefixTrace: PrefixValueTrace;
}

interface MaxClaimGasProbeResult {
  readonly baseCosts: ExecutionCostClaimEstimate;
  readonly gasUsed: SimulationGasUsed;
  readonly pass1MidPrices: bigint[];
  readonly pass1ExecutionQuote: ExecutableSwapQuote | null;
}

interface SwapExecutionGapMeasurement {
  readonly finalCosts: ExecutionCostClaimEstimate;
  readonly probeQuote: ExecutableSwapQuote;
}

function createGenericPrepareBuildRunContext(
  input: GenericPrepareBuildRequest,
): GenericPrepareBuildRunContext {
  // Request-local quote cache shared across pass1 / pass1.5 / pass2 so that
  // floor-bound paths collapse to a single underlying RPC. The cache is not
  // passed to the credit pre-swap probe because that path returns before the
  // swap solver and would only pollute swap-path measurements.
  return {
    rpcAcc: emptyBuildRpcAccumulator(),
    quoteCache: createRequestQuoteCache(),
    prefixTrace: materializePrefixValueTrace(
      Transaction.fromKind(fromBase64(input.userTxKindBytes)),
      input.settlementSwapPath.settlementTokenType,
    ),
  };
}

function logGenericPrepareBuildStart(input: GenericPrepareBuildRequest): void {
  logPrepareBuildStage('two_pass_start', {
    sender: input.senderAddress,
    requested_profile: input.profile,
    slippage_bps: input.slippageBps,
    gas_margin_bps: input.gasMarginBps,
    settlement_swap_direction: input.settlementSwapPath.settlementSwapDirection,
    hop_count: input.settlementSwapPath.hops.length,
    sponsor_address: input.sponsorAddress,
  });
}

async function runMaxClaimGasProbe(
  ctx: BuildContext,
  input: GenericPrepareBuildRequest,
  runContext: GenericPrepareBuildRunContext,
): Promise<MaxClaimGasProbeResult> {
  // ── Pass 1: Dry-run with max claim ──────────────────────────────────────
  // Audit fields are placeholders — dry-run only measures gas, not settle logic.
  // Pass 1 probes with maxClaimMist after any eligible pre-swap credit
  // candidate has been rejected or skipped.
  const pass1Claim = ctx.maxClaimMist;

  const {
    tx: pass1Tx,
    effectiveProfile: pass1Profile,
    swapAmountSmallest: pass1SwapAmount,
    rawMidPrices: pass1MidPrices,
    paymentInputSource: pass1PaymentInputSource,
    executionQuote: pass1ExecutionQuote,
    rpcStats: pass1RpcStats,
  } = await runPreparePass(
    ctx,
    input,
    runContext.prefixTrace,
    {
      executionCostClaim: pass1Claim,
      simGasReported: pass1Claim,
      gasVarianceFixedMist: 0n,
      slippageBufferMist: 0n,
      quotedHostFeeMist: ctx.quotedHostFeeMist,
      expectedProtocolFeeMist: ctx.protocolFlatFeeMist,
      expectedConfigVersion: ctx.configVersion,
    },
    undefined,
    'pass1',
    undefined,
    runContext.quoteCache,
  );
  absorbPassRpcStats(runContext.rpcAcc, pass1RpcStats);
  runContext.rpcAcc.pass1Quote = pass1RpcStats.quote;

  logPrepareBuildStage('pass1_compiled', {
    pass1_claim_mist: pass1Claim.toString(),
    effective_profile: pass1Profile,
    swap_amount_smallest: pass1SwapAmount.toString(),
    payment_input_source: pass1PaymentInputSource,
    mid_price_count: pass1MidPrices.length,
    execution_gap_mist: pass1ExecutionQuote?.executionGapMist.toString() ?? '0',
    pass1_quantity_in_rpc_calls: runContext.rpcAcc.pass1Quote.quantityInCalls,
  });
  pass1Tx.setSender(input.senderAddress);
  pass1Tx.setGasOwner(input.sponsorAddress);
  // Set explicit gasBudget so the SDK's core-resolver skips its internal
  // setGasBudget simulation (which can fail with fragmented sponsor gas coins).
  // Our own simulateTransaction below measures actual gas usage.
  pass1Tx.setGasBudget(ctx.maxClaimMist);

  const pass1Meta = buildSettleMeta(ctx, pass1Claim, true);

  // ── Extract gas metrics ─────────────────────────────────────────────────

  const gasUsed = await dryRunForGas(
    ctx,
    pass1Tx,
    pass1Meta,
    'pass1_dryrun_simulated',
    'pass1',
    {
      poolId: input.descriptor.hops[0]?.poolId ?? 'unknown',
      settlementTokenSymbol: input.settlementSwapPath.settlementTokenSymbol,
    },
    runContext.rpcAcc.pass1Quote,
  );
  const baseCosts = computeExecutionCostClaim(gasUsed);
  logPrepareBuildStage('pass1_costs_extracted', {
    sim_gas_mist: baseCosts.simGas.toString(),
    gross_gas_mist: baseCosts.grossGas.toString(),
    gas_variance_fixed_mist: baseCosts.gasVarianceFixedMist.toString(),
    execution_cost_claim_mist: baseCosts.executionCostClaim.toString(),
  });

  return {
    baseCosts,
    gasUsed,
    pass1MidPrices,
    pass1ExecutionQuote,
  };
}

async function measureSwapExecutionGap(
  ctx: BuildContext,
  input: GenericPrepareBuildRequest,
  maxClaimProbe: MaxClaimGasProbeResult,
  runContext: GenericPrepareBuildRunContext,
): Promise<SwapExecutionGapMeasurement> {
  // The pre-swap credit probe is the only active credit measurement path.
  // If it did not select credit, the remaining canonical path is swap.
  // ── Swap execution gap solve ────────────────────────────────────────────

  let finalCosts = maxClaimProbe.baseCosts;
  let probeQuote: ExecutableSwapQuote;

  // pass1MidPrices: reuse mid-prices from pass 1 (request-local snapshot).
  // Use pure swap-amount calculation instead of calling runPreparePass again,
  // eliminating repeated coin queries / TX construction.
  const rawMidPrices = maxClaimProbe.pass1MidPrices;
  logPrepareBuildStage('pass1_5_probe_amount_computed', {
    swap_probe_amount_smallest:
      maxClaimProbe.pass1ExecutionQuote?.swapAmountSmallest.toString() ?? '0',
    has_mid_prices: rawMidPrices.length > 0,
  });

  if (rawMidPrices.length > 0) {
    const probeSolve = await solveSwapForClaim(
      ctx,
      input,
      maxClaimProbe.baseCosts.executionCostClaim,
      rawMidPrices,
      'pass1_5',
      'pass1_5',
      true,
      runContext.quoteCache,
    );
    probeQuote = probeSolve.quote;
    runContext.rpcAcc.pass1_5Quote = probeSolve.rpcStats;

    finalCosts = computeExecutionCostClaim(maxClaimProbe.gasUsed, {
      slippageBufferMist: probeQuote.executionGapMist,
    });
    logPrepareBuildStage('pass1_5_slippage_measured', {
      swap_probe_amount_smallest: probeQuote.swapAmountSmallest.toString(),
      slippage_buffer_mist: probeQuote.executionGapMist.toString(),
      execution_cost_claim_mist: finalCosts.executionCostClaim.toString(),
      actual_sui_out: probeQuote.actualOutputMist.toString(),
      pass1_5_quantity_in_rpc_calls: runContext.rpcAcc.pass1_5Quote.quantityInCalls,
      ...buildBfqFloorPayload(probeQuote, input.settlementSwapPath.hops[0]?.swapDirection),
    });

    // Pass 2 will use adjusted executionCostClaim — verify convergence below
  } else {
    if (finalCosts.executionCostClaim > ctx.maxClaimMist) {
      throwClaimWouldExceedMax(ctx, finalCosts);
    }
    throw new PrepareValidationError(
      'INSUFFICIENT_BALANCE',
      'Pre-swap credit measurement did not select credit and no swap quote is available',
      {
        executionCostClaim: finalCosts.executionCostClaim.toString(),
        credit: input.credit,
      },
    );
  }

  return { finalCosts, probeQuote };
}

export async function runGenericPrepareBuildPipeline(
  ctx: BuildContext,
  input: GenericPrepareBuildRequest,
): Promise<GenericPrepareBuildOutput> {
  logGenericPrepareBuildStart(input);
  const runContext = createGenericPrepareBuildRunContext(input);

  // A credit_general request can be credit-coverable after measurement even
  // when it cannot cover maxClaimMist. Measure that candidate without first
  // requiring a settlement-token source for a max-claim swap probe.
  const preSwapCreditProbe = shouldAttemptPreSwapCreditProbe(input)
    ? await dryRunPreSwapCreditPathCosts(ctx, input, runContext)
    : ({ outcome: 'skipped' } as const);
  if (preSwapCreditProbe.outcome === 'selected') {
    return buildFinalGenericPrepareResult(
      ctx,
      input,
      preSwapCreditProbe.costs,
      'credit',
      undefined,
      null,
      runContext,
    );
  }

  const maxClaimProbe = await runMaxClaimGasProbe(ctx, input, runContext);
  const swapMeasurement = await measureSwapExecutionGap(ctx, input, maxClaimProbe, runContext);

  return buildFinalGenericPrepareResult(
    ctx,
    input,
    swapMeasurement.finalCosts,
    'swap',
    maxClaimProbe.pass1MidPrices,
    swapMeasurement.probeQuote,
    runContext,
  );
}

/**
 * Test-only access to the named build stages. This is intentionally not
 * re-exported from any package or internal barrel; production callers must use
 * `runGenericPrepareBuildPipeline`.
 */
export const __testingGenericPrepareBuildStages = {
  createGenericPrepareBuildRunContext,
  runMaxClaimGasProbe,
  measureSwapExecutionGap,
  buildFinalGenericPrepareResult,
} as const;

// ─────────────────────────────────────────────
// Internal: Build settle transaction
// ─────────────────────────────────────────────

/**
 * Settle audit fields passed into the on-chain MoveCall.
 * Pass 1 uses placeholder values; Pass 2 uses actual dry-run results.
 */
interface SettleAuditFields {
  executionCostClaim: bigint;
  /** Actual simulation gas (computation + storage - rebate) from dry-run */
  simGasReported: bigint;
  /** Fixed gas variance (GAS_VARIANCE_FIXED_MIST). */
  gasVarianceFixedMist: bigint;
  /** Slippage buffer (MIST). 0 for credit-only paths. */
  slippageBufferMist: bigint;
  /** Host-quoted fee (MIST) — exact value embedded in PTB. */
  quotedHostFeeMist: bigint;
  /** Expected on-chain protocol fee at quote time — tamper detection. */
  expectedProtocolFeeMist: bigint;
  /** Expected config_version at quote time — drift detection. */
  expectedConfigVersion: bigint;
}

/** Result of a single planner/compiler pass — tx + the effective settle path. */
interface PreparePassResult {
  tx: Transaction;
  /** Effective profile based on actual execution branch, not pre-selected input.profile */
  effectiveProfile: SettleProfile;
  /** Swap input amount in smallest unit (bigint). 0n for credit paths. */
  swapAmountSmallest: bigint;
  /** Per-hop raw u64 mid_price from getHopMidPriceRaw (bigint[]). Empty for credit paths. */
  rawMidPrices: bigint[];
  /** How settlement token was sourced. */
  paymentInputSource: PaymentInputSource;
  /** Exact funding facts that the final PTB self-check must confirm. */
  paymentInputIntegrityExpectation: PaymentInputIntegrityExpectation;
  /** Canonical market-policy result for swap paths. */
  executionQuote: ExecutableSwapQuote | null;
  /** RPC accounting for this pass — mid-price + quote primitives. */
  rpcStats: PreparePassRpcStats;
}

/**
 * Build a Transaction containing user commands + settle MoveCall.
 *
 * Uses the planner/compiler pipeline:
 *   1. Deserialize user TX
 *   2. Local prefix accounting validation
 *   3. Check credit-only eligibility (planner)
 *   4. Trace the user-prefix value and load the market snapshot
 *   5. Solve minimal executable swap via server-side market policy
 *   6. Resolve funding + assemble swap plan
 *   7. Compile plan onto TX (compiler)
 */
async function runPreparePass(
  ctx: BuildContext,
  input: GenericPrepareBuildRequest,
  prefixTrace: PrefixValueTrace,
  audit: SettleAuditFields,
  prefetchedMidPrices?: bigint[],
  passLabel: PreparePassLabel = 'pass2',
  forcedSettlePath?: FinalSettlePath,
  quoteCache?: QuoteCache,
): Promise<PreparePassResult> {
  const rpcStats: PreparePassRpcStats = emptyPreparePassRpcStats();

  logPrepareBuildStage('run_prepare_pass_start', {
    pass: passLabel,
    forced_settle_path: forcedSettlePath ?? 'auto',
    requested_profile: input.profile,
    execution_cost_claim_mist: audit.executionCostClaim.toString(),
  });

  const tx = Transaction.fromKind(fromBase64(input.userTxKindBytes));

  const settlementSwapPath = input.settlementSwapPath;

  // ── Build planner config + input from orchestrator context ─────────────
  const { config: plannerConfig, input: plannerInput } = buildPlannerInputs(ctx, input);

  const auditFields: SettlePlanAuditFields = {
    executionCostClaim: audit.executionCostClaim,
    settlementPayoutRecipient: ctx.settlementPayoutRecipientAddress,
    receiptId: input.receiptId,
    nonce: input.nonce,
    simGasReported: audit.simGasReported,
    gasVarianceFixedMist: audit.gasVarianceFixedMist,
    slippageBufferMist: audit.slippageBufferMist,
    quotedHostFeeMist: audit.quotedHostFeeMist,
    expectedProtocolFeeMist: audit.expectedProtocolFeeMist,
    expectedConfigVersion: audit.expectedConfigVersion,
    quoteTimestampMs: input.quoteTimestampMs,
    policyHash: input.policyHash,
    orderIdHash: input.orderIdHash ?? new Uint8Array(0),
  };

  // ── Step 1: Credit-only eligibility (planner) ─────────────────────────
  const creditCheck = checkCreditOnlyEligibility(
    plannerConfig,
    plannerInput,
    audit.executionCostClaim,
  );
  if (creditCheck && forcedSettlePath !== 'swap') {
    const plan = assembleCreditSettlementPlan(
      plannerInput,
      auditFields,
      creditCheck.useCreditAmount,
    );
    const paymentInputIntegrityExpectation = compileCreditSettlement(
      tx,
      plan,
      { packageId: ctx.packageId, configId: ctx.configId, vaultRegistryId: ctx.vaultRegistryId },
      input.vaultObjectId!,
    );
    logPrepareBuildStage('run_prepare_pass_credit_path', {
      pass: passLabel,
      use_credit_amount_mist: creditCheck.useCreditAmount.toString(),
    });
    return {
      tx,
      effectiveProfile: 'credit_general',
      swapAmountSmallest: 0n,
      rawMidPrices: [],
      paymentInputSource: 'none_credit_only',
      paymentInputIntegrityExpectation,
      executionQuote: null,
      rpcStats,
    };
  }

  if (forcedSettlePath === 'credit') {
    throw new PrepareValidationError(
      'INSUFFICIENT_BALANCE',
      'Forced credit settlement path is not credit-coverable for the current audit claim',
      {
        executionCostClaim: audit.executionCostClaim.toString(),
        credit: input.credit,
      },
    );
  }

  // ── Swap-only prefix value evidence ─────────────────────────────────────────
  assertSingleHopOnly(settlementSwapPath);
  const prefixStateCounts = { surviving: 0, consumed: 0, opaque: 0 };
  for (const state of prefixTrace.directCoins.values()) {
    prefixStateCounts[state.status] += 1;
  }
  logPrepareBuildStage('run_prepare_pass_prefix_value_traced', {
    pass: passLabel,
    survivor_count: prefixStateCounts.surviving,
    consumed_count: prefixStateCounts.consumed,
    opaque_in_use_count: prefixStateCounts.opaque,
    prefix_ab_consumed_smallest: prefixTrace.senderWithdrawalDebit.toString(),
  });

  // ── Step 3: Mid-price snapshot ────────────────────────────────────────
  let rawMidPrices: bigint[];
  if (prefetchedMidPrices && prefetchedMidPrices.length === settlementSwapPath.hops.length) {
    rawMidPrices = prefetchedMidPrices;
  } else {
    const midPriceStartedAt = Date.now();
    try {
      rawMidPrices = await loadRawMidPrices(ctx, input.descriptor, 'mid_price_collection');
      rpcStats.midPriceCalls += 1;
      rpcStats.midPriceTotalMs += Date.now() - midPriceStartedAt;
    } catch (err) {
      // Mid-price RPC failed before any quote-solve work. Without this emit
      // the request would have zero failure-stage observability for the
      // mid-price axis. Partial timing reflects the elapsed duration of the
      // failed attempt; mid_price_calls is 0 because the success-path
      // increment never ran.
      logPrepareBuildStage('mid_price_rpc_failed', {
        pass: passLabel,
        error_code: err instanceof PrepareValidationError ? err.code : 'UNKNOWN',
        pool_id: input.descriptor.hops[0]?.poolId ?? 'unknown',
        settlement_token_symbol: settlementSwapPath.settlementTokenSymbol,
        mid_price_total_ms: Date.now() - midPriceStartedAt,
        mid_price_stats_complete: false,
      });
      throw err;
    }
  }
  logPrepareBuildStage('run_prepare_pass_market_loaded', {
    pass: passLabel,
    raw_mid_prices: rawMidPrices.map((p) => p.toString()),
  });

  // ── Step 4: Canonical market-policy solve ─────────────────────────────
  const { quote: executionQuote, rpcStats: solveRpcStats } = await solveSwapForClaim(
    ctx,
    input,
    audit.executionCostClaim,
    rawMidPrices,
    `${passLabel}_market_policy`,
    passLabel,
    passLabel !== 'pass1',
    quoteCache,
  );
  rpcStats.quote = solveRpcStats;
  const swapAmountSmallest = executionQuote.swapAmountSmallest;
  logPrepareBuildStage('run_prepare_pass_swap_amount_computed', {
    pass: passLabel,
    swap_amount_smallest: swapAmountSmallest.toString(),
    execution_gap_mist: executionQuote.executionGapMist.toString(),
    actual_sui_out: executionQuote.actualOutputMist.toString(),
    ...buildBfqFloorPayload(executionQuote, settlementSwapPath.hops[0]?.swapDirection),
  });

  // ── Steps 5-7: post-solve work (resolve payment, assemble plan, compile)
  //
  // `solveSwapForClaim` already populated `rpcStats.quote`, but caller-side
  // absorption (`rpcAcc.passXQuote = result.rpcStats.quote`) only happens
  // after this function returns. If any throw fires here the local quote
  // stats are dropped on the floor. Wrap the post-solve segment so the
  // stats are emitted as a `pass_aborted_post_solve` stage(partial payload)
  // before the throw propagates.
  try {
    // ── Step 5: Funding resolution (chain query) ──────────────────────────
    const funding = await resolvePaymentSource(
      ctx.sui,
      input.senderAddress,
      settlementSwapPath.settlementTokenType,
      swapAmountSmallest,
      settlementSwapPath.settlementTokenSymbol,
      prefixTrace,
    );
    logPrepareBuildStage('run_prepare_pass_funding_resolved', {
      pass: passLabel,
      funding_source: funding.source,
      usable_coin_total_smallest:
        funding.source === 'address_balance' ? '0' : funding.remainingBalance.toString(),
      redeem_delta_smallest:
        funding.source === 'coin_object' ? '0' : funding.redeemAmount.toString(),
    });

    // ── Step 6: Assemble swap settlement plan ───────────────────────────
    const quotedHopOutputs = [...executionQuote.quotedHopOutputs];
    const swap = calculateSwapOutputGuards(
      swapAmountSmallest,
      executionQuote.targetOutputMist,
      executionQuote.actualOutputMist,
      input.slippageBps,
    );
    const plan = assembleSwapSettlementPlan(plannerInput, auditFields, funding, swap);
    logPrepareBuildStage('run_prepare_pass_minout_quoted', {
      pass: passLabel,
      quoted_hop_outputs: quotedHopOutputs.map((p) => p.toString()),
      required_swap_output_mist: swap.requiredSwapOutputMist.toString(),
      min_sui_out: swap.minSuiOut.toString(),
      slippage_bps: input.slippageBps,
    });

    // ── Step 7: Compile plan onto TX (compiler) ─────────────────────────
    const paymentInputIntegrityExpectation = compileSwapSettlement(
      tx,
      plan,
      {
        packageId: ctx.packageId,
        configId: ctx.configId,
        vaultRegistryId: ctx.vaultRegistryId,
      },
      input.vaultObjectId,
    );
    logPrepareBuildStage('run_prepare_pass_compiled', {
      pass: passLabel,
      effective_profile: plan.profile,
      payment_input_source: plan.funding.source,
      swap_amount_smallest: plan.swap.swapAmountSmallest.toString(),
    });
    return {
      tx,
      effectiveProfile: plan.profile as SettleProfile,
      swapAmountSmallest: plan.swap.swapAmountSmallest,
      rawMidPrices,
      paymentInputSource: plan.funding.source,
      paymentInputIntegrityExpectation,
      executionQuote,
      rpcStats,
    };
  } catch (err) {
    // Solve already succeeded (rpcStats.quote populated). Caller absorption
    // will not run because we are about to rethrow. Emit the partial quote
    // stats so the request still has request-level observability.
    const quoteStats = rpcStats.quote;
    logPrepareBuildStage('pass_aborted_post_solve', {
      pass: passLabel,
      error_code: err instanceof PrepareValidationError ? err.code : 'UNKNOWN',
      pool_id: input.descriptor.hops[0]?.poolId ?? 'unknown',
      settlement_token_symbol: settlementSwapPath.settlementTokenSymbol,
      quote_quantity_in_rpc_calls: quoteStats.quantityInCalls,
      quote_quantity_out_verify_rpc_calls: quoteStats.quantityOutVerifyCalls,
      quote_total_rpc_calls: quoteStats.quantityInCalls + quoteStats.quantityOutVerifyCalls,
      // Post-solve failure carries the same logical / cache_hits fields as
      // `quote_rpc_failed` and `two_pass_complete` so the payload shape stays
      // consistent across all three quote-stats emit sites
      // (`quote_rpc_stats_complete: false` flags partial state).
      quote_quantity_in_logical_calls: quoteStats.quantityInLogicalCalls,
      quote_quantity_out_verify_logical_calls: quoteStats.quantityOutVerifyLogicalCalls,
      quote_cache_hits: quoteStats.cacheHits,
      quote_rpc_total_ms: quoteStats.totalDurationMs,
      quote_rpc_max_ms: quoteStats.maxDurationMs,
      quote_rpc_stats_complete: false,
      ...buildBfqFloorPayload(executionQuote, settlementSwapPath.hops[0]?.swapDirection),
    });
    throw err;
  }
}

/**
 * SHA-256 hex digest of raw bytes.
 * Uses Node.js crypto module.
 */
function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
