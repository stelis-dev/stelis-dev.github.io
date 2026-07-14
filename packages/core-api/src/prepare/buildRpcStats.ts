import type { QuoteRpcStats } from '@stelis/core-relay/server';

/**
 * Per-pass RPC accounting captured during one `runPreparePass` invocation.
 * `midPriceCalls` is 0 or 1: one batchGetHopMidPrices fetch per pass at most,
 * and pass2 reuses pass1's prefetched prices. `quote` aggregates the
 * quantity-in / quantity-out_verify primitives from the wrapped market quote
 * port; it stays at zero values for credit branches that never reach the
 * solver.
 */
export interface PreparePassRpcStats {
  midPriceCalls: number;
  midPriceTotalMs: number;
  quote: QuoteRpcStats;
}

/** Current structured-log projection for one quote-stat snapshot. */
export interface QuoteRpcStatsLogFields {
  readonly quote_quantity_in_rpc_calls: number;
  readonly quote_quantity_out_verify_rpc_calls: number;
  readonly quote_total_rpc_calls: number;
  readonly quote_rpc_total_ms: number;
  readonly quote_rpc_max_ms: number;
  readonly quote_quantity_in_logical_calls: number;
  readonly quote_quantity_out_verify_logical_calls: number;
  readonly quote_cache_hits: number;
  readonly quote_rpc_stats_complete: boolean;
}

/**
 * Project the internal quote counters to their one structured-log shape.
 * Individual quote snapshots do not include the separately tracked mid-price RPC.
 */
export function quoteRpcStatsLogFields(
  stats: QuoteRpcStats,
  complete: boolean,
): QuoteRpcStatsLogFields {
  return {
    quote_quantity_in_rpc_calls: stats.quantityInCalls,
    quote_quantity_out_verify_rpc_calls: stats.quantityOutVerifyCalls,
    quote_total_rpc_calls: stats.quantityInCalls + stats.quantityOutVerifyCalls,
    quote_rpc_total_ms: stats.totalDurationMs,
    quote_rpc_max_ms: stats.maxDurationMs,
    quote_quantity_in_logical_calls: stats.quantityInLogicalCalls,
    quote_quantity_out_verify_logical_calls: stats.quantityOutVerifyLogicalCalls,
    quote_cache_hits: stats.cacheHits,
    quote_rpc_stats_complete: complete,
  };
}

export function emptyQuoteRpcStats(): QuoteRpcStats {
  return {
    quantityInCalls: 0,
    quantityOutVerifyCalls: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    quantityInLogicalCalls: 0,
    quantityOutVerifyLogicalCalls: 0,
    cacheHits: 0,
  };
}

export function emptyPreparePassRpcStats(): PreparePassRpcStats {
  return {
    midPriceCalls: 0,
    midPriceTotalMs: 0,
    quote: emptyQuoteRpcStats(),
  };
}

/**
 * Request-scoped RPC accumulator for one /prepare invocation. Tracks
 * mid-price calls separately from per-pass quantity-in / quantity-out_verify
 * counts so the emit at `two_pass_complete` can carry both the per-pass
 * numbers and the aggregate sum.
 */
export interface BuildRpcAccumulator {
  midPriceCalls: number;
  midPriceTotalMs: number;
  pass1Quote: QuoteRpcStats;
  pass1_5Quote: QuoteRpcStats;
  pass2Quote: QuoteRpcStats;
}

export function emptyBuildRpcAccumulator(): BuildRpcAccumulator {
  return {
    midPriceCalls: 0,
    midPriceTotalMs: 0,
    pass1Quote: emptyQuoteRpcStats(),
    pass1_5Quote: emptyQuoteRpcStats(),
    pass2Quote: emptyQuoteRpcStats(),
  };
}

export function absorbPassRpcStats(acc: BuildRpcAccumulator, passStats: PreparePassRpcStats): void {
  acc.midPriceCalls += passStats.midPriceCalls;
  acc.midPriceTotalMs += passStats.midPriceTotalMs;
}

export interface BuildRpcSummary {
  quoteQuantityInCalls: number;
  quoteQuantityOutVerifyCalls: number;
  quoteTotalRpcCalls: number;
  quoteRpcTotalMs: number;
  quoteRpcMaxMs: number;
  quoteQuantityInLogicalCalls: number;
  quoteQuantityOutVerifyLogicalCalls: number;
  quoteCacheHits: number;
}

export function summarizeRpcStats(acc: BuildRpcAccumulator): BuildRpcSummary {
  const quoteQuantityInCalls =
    acc.pass1Quote.quantityInCalls +
    acc.pass1_5Quote.quantityInCalls +
    acc.pass2Quote.quantityInCalls;
  const quoteQuantityOutVerifyCalls =
    acc.pass1Quote.quantityOutVerifyCalls +
    acc.pass1_5Quote.quantityOutVerifyCalls +
    acc.pass2Quote.quantityOutVerifyCalls;
  const quoteQuantityInLogicalCalls =
    acc.pass1Quote.quantityInLogicalCalls +
    acc.pass1_5Quote.quantityInLogicalCalls +
    acc.pass2Quote.quantityInLogicalCalls;
  const quoteQuantityOutVerifyLogicalCalls =
    acc.pass1Quote.quantityOutVerifyLogicalCalls +
    acc.pass1_5Quote.quantityOutVerifyLogicalCalls +
    acc.pass2Quote.quantityOutVerifyLogicalCalls;
  const quoteCacheHits =
    acc.pass1Quote.cacheHits + acc.pass1_5Quote.cacheHits + acc.pass2Quote.cacheHits;
  const quoteTotalRpcCalls = acc.midPriceCalls + quoteQuantityInCalls + quoteQuantityOutVerifyCalls;
  const quoteRpcTotalMs =
    acc.midPriceTotalMs +
    acc.pass1Quote.totalDurationMs +
    acc.pass1_5Quote.totalDurationMs +
    acc.pass2Quote.totalDurationMs;
  const quoteRpcMaxMs = Math.max(
    acc.midPriceTotalMs,
    acc.pass1Quote.maxDurationMs,
    acc.pass1_5Quote.maxDurationMs,
    acc.pass2Quote.maxDurationMs,
  );
  return {
    quoteQuantityInCalls,
    quoteQuantityOutVerifyCalls,
    quoteTotalRpcCalls,
    quoteRpcTotalMs,
    quoteRpcMaxMs,
    quoteQuantityInLogicalCalls,
    quoteQuantityOutVerifyLogicalCalls,
    quoteCacheHits,
  };
}

/** Project the complete request-level summary to the same log vocabulary. */
export function buildRpcSummaryLogFields(
  summary: BuildRpcSummary,
  complete: boolean,
): QuoteRpcStatsLogFields {
  return {
    quote_quantity_in_rpc_calls: summary.quoteQuantityInCalls,
    quote_quantity_out_verify_rpc_calls: summary.quoteQuantityOutVerifyCalls,
    quote_total_rpc_calls: summary.quoteTotalRpcCalls,
    quote_rpc_total_ms: summary.quoteRpcTotalMs,
    quote_rpc_max_ms: summary.quoteRpcMaxMs,
    quote_quantity_in_logical_calls: summary.quoteQuantityInLogicalCalls,
    quote_quantity_out_verify_logical_calls: summary.quoteQuantityOutVerifyLogicalCalls,
    quote_cache_hits: summary.quoteCacheHits,
    quote_rpc_stats_complete: complete,
  };
}
