import { getQuantityOut, getInputForTargetOutput, type QuantityInQuote } from '../deepbook.js';
import { SlippageQueryError } from '../deepbookErrors.js';
import type { SuiEndpointSnapshot } from '../sui/suiOperation.js';
import type { MarketQuotePort } from './types.js';
import { MarketQuoteUnavailableError } from './errors.js';

export function createDeepbookQuotePort(
  snapshot: SuiEndpointSnapshot,
  deepbookPackageId: string,
): MarketQuotePort {
  return {
    async quoteHopOutput(hop, inputAmountSmallest) {
      try {
        return await getQuantityOut(snapshot, deepbookPackageId, hop, inputAmountSmallest);
      } catch (err) {
        if (err instanceof SlippageQueryError) {
          throw new MarketQuoteUnavailableError(err.message, { cause: err });
        }
        throw err;
      }
    },
    async quoteHopInputForTarget(hop, targetOutputAmountSmallest) {
      try {
        return await getInputForTargetOutput(
          snapshot,
          deepbookPackageId,
          hop,
          targetOutputAmountSmallest,
        );
      } catch (err) {
        if (err instanceof SlippageQueryError) {
          throw new MarketQuoteUnavailableError(err.message, { cause: err });
        }
        throw err;
      }
    },
  };
}

/**
 * Per-port quote-RPC stats accumulated by `wrapQuotePortWithStats` and
 * `wrapQuotePortWithCacheAndStats`.
 *
 * Two distinct counts are tracked per primitive:
 *
 *   - `quantityInCalls` / `quantityOutVerifyCalls` — RPC dispatch counts.
 *     These increment only when a request is actually dispatched to the
 *     underlying port (i.e., on cache miss for the cached wrapper, or on
 *     every call for the non-cached wrapper). Counters increment on attempt,
 *     including dispatches that throw, so the timing fields stay aligned
 *     with the dispatch counts.
 *   - `quantityInLogicalCalls` / `quantityOutVerifyLogicalCalls` — logical
 *     call counts. These increment on every invocation, regardless of cache
 *     state, so they represent the number of solves the caller performed.
 *
 * In the non-cached wrapper, logical counts equal RPC counts and `cacheHits`
 * stays at 0. In the cached wrapper, `cacheHits` is the difference between
 * logical and RPC counts summed over both primitives:
 *   `cacheHits = (logicalIn - rpcIn) + (logicalOut - rpcOut)`.
 *
 * `totalDurationMs` and `maxDurationMs` measure RPC dispatch time only —
 * cache hits contribute 0 to both.
 */
export interface QuoteRpcStats {
  quantityInCalls: number;
  quantityOutVerifyCalls: number;
  totalDurationMs: number;
  maxDurationMs: number;
  quantityInLogicalCalls: number;
  quantityOutVerifyLogicalCalls: number;
  cacheHits: number;
}

function emptyStats(): QuoteRpcStats {
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

function recordDuration(stats: QuoteRpcStats, durationMs: number): void {
  stats.totalDurationMs += durationMs;
  if (durationMs > stats.maxDurationMs) {
    stats.maxDurationMs = durationMs;
  }
}

type QuotePrimitive = 'quantity_in' | 'quantity_out_verify';

function recordLogicalCall(stats: QuoteRpcStats, primitive: QuotePrimitive): void {
  if (primitive === 'quantity_in') {
    stats.quantityInLogicalCalls += 1;
  } else {
    stats.quantityOutVerifyLogicalCalls += 1;
  }
}

async function dispatchAndRecord<T>(
  stats: QuoteRpcStats,
  primitive: QuotePrimitive,
  dispatch: () => Promise<T>,
): Promise<T> {
  if (primitive === 'quantity_in') {
    stats.quantityInCalls += 1;
  } else {
    stats.quantityOutVerifyCalls += 1;
  }
  const startedAt = Date.now();
  try {
    return await dispatch();
  } finally {
    recordDuration(stats, Date.now() - startedAt);
  }
}

/**
 * Wrap a `MarketQuotePort` to record per-call counts and durations without
 * caching. Logical and RPC counts always match; `cacheHits` stays at 0.
 *
 * Returns the wrapped port plus the live `stats` object — callers retain a
 * reference to `stats` to read post-solve. Counters increment on attempt;
 * on throw, the call is still counted and its duration still applied.
 */
export function wrapQuotePortWithStats(port: MarketQuotePort): {
  port: MarketQuotePort;
  stats: QuoteRpcStats;
} {
  const stats = emptyStats();

  return {
    stats,
    port: {
      async quoteHopOutput(hop, inputAmountSmallest) {
        recordLogicalCall(stats, 'quantity_out_verify');
        return dispatchAndRecord(stats, 'quantity_out_verify', () =>
          port.quoteHopOutput(hop, inputAmountSmallest),
        );
      },
      async quoteHopInputForTarget(hop, targetOutputAmountSmallest) {
        recordLogicalCall(stats, 'quantity_in');
        return dispatchAndRecord(stats, 'quantity_in', () =>
          port.quoteHopInputForTarget(hop, targetOutputAmountSmallest),
        );
      },
    },
  };
}

/**
 * Request-local cache for DeepBook quote primitives.
 *
 * `outputs` keys `quoteHopOutput` results. `inputs` keys `quoteHopInputForTarget`
 * results. Keys are constructed inside `wrapQuotePortWithCacheAndStats` and
 * include the primitive name, pool identity, base/quote types, swap
 * direction, and the variant argument so that no two distinct DeepBook
 * dispatches collapse onto the same entry.
 *
 * Scope: a single `/relay/prepare` invocation. Callers MUST allocate one cache
 * per request via `createRequestQuoteCache()` and discard it at request
 * completion. There is no cross-request reuse, no module-level singleton,
 * and no Redis/DB persistence — the on-chain order book and orders fluctuate
 * between prepare invocations, so cross-request reuse would yield stale
 * quotes and break the prepare/sponsor commit binding.
 */
export interface QuoteCache {
  readonly outputs: Map<string, bigint>;
  readonly inputs: Map<string, QuantityInQuote>;
}

export function createRequestQuoteCache(): QuoteCache {
  return {
    outputs: new Map(),
    inputs: new Map(),
  };
}

function outputCacheKey(
  hop: { poolId: string; baseType: string; quoteType: string; swapDirection: string },
  inputAmountSmallest: bigint,
): string {
  return `output|${hop.poolId}|${hop.baseType}|${hop.quoteType}|${hop.swapDirection}|${inputAmountSmallest}`;
}

function inputCacheKey(
  hop: { poolId: string; baseType: string; quoteType: string; swapDirection: string },
  targetOutputAmountSmallest: bigint,
): string {
  return `input|${hop.poolId}|${hop.baseType}|${hop.quoteType}|${hop.swapDirection}|${targetOutputAmountSmallest}`;
}

/**
 * Wrap a `MarketQuotePort` with a request-local cache plus stats accounting.
 *
 * On cache hit:
 *   - logical counter ++, `cacheHits` ++.
 *   - RPC counter and duration unchanged (no underlying dispatch).
 *
 * On cache miss:
 *   - logical counter ++, RPC counter ++.
 *   - duration recorded as for `wrapQuotePortWithStats`.
 *   - cache entry stored ONLY on success — thrown errors are not cached, so
 *     transient failures retry on the next call rather than locking in a
 *     stale failure.
 *
 * The cache is shared across multiple wrap invocations that pass the same
 * `cache` instance. This is intentional: `runGenericPrepareBuildPipeline`
 * allocates one cache per request and shares it across pass1 / pass1.5 /
 * pass2, so the floor-bound case (where all three passes resolve to identical
 * effective targets) collapses to a single underlying RPC.
 */
export function wrapQuotePortWithCacheAndStats(
  port: MarketQuotePort,
  cache: QuoteCache,
): { port: MarketQuotePort; stats: QuoteRpcStats } {
  const stats = emptyStats();

  return {
    stats,
    port: {
      async quoteHopOutput(hop, inputAmountSmallest) {
        recordLogicalCall(stats, 'quantity_out_verify');
        const key = outputCacheKey(hop, inputAmountSmallest);
        const cached = cache.outputs.get(key);
        if (cached !== undefined) {
          stats.cacheHits += 1;
          return cached;
        }
        return dispatchAndRecord(stats, 'quantity_out_verify', async () => {
          const result = await port.quoteHopOutput(hop, inputAmountSmallest);
          cache.outputs.set(key, result);
          return result;
        });
      },
      async quoteHopInputForTarget(hop, targetOutputAmountSmallest) {
        recordLogicalCall(stats, 'quantity_in');
        const key = inputCacheKey(hop, targetOutputAmountSmallest);
        const cached = cache.inputs.get(key);
        if (cached !== undefined) {
          stats.cacheHits += 1;
          return cached;
        }
        return dispatchAndRecord(stats, 'quantity_in', async () => {
          const result = await port.quoteHopInputForTarget(hop, targetOutputAmountSmallest);
          cache.inputs.set(key, result);
          return result;
        });
      },
    },
  };
}
