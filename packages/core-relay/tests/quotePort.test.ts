/**
 * createDeepbookQuotePort — port-level tests.
 *
 * Locks the wrapping responsibilities of the port:
 *   - dispatch each method to its underlying deepbook.ts helper
 *   - map `SlippageQueryError` → `MarketQuoteUnavailableError` preserving message
 *   - rethrow non-`SlippageQueryError` errors unwrapped
 *   - keep verification policy / retry / `ExecutableSwapQuote` construction OUT
 *     of the port (port returns raw primitive values only)
 *
 * Mocks `../src/deepbook.js` so the port wrapping branches can be exercised
 * without touching real RPC.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeepBookPoolHop } from '@stelis/contracts';

const helperState = vi.hoisted(() => ({
  getQuantityOut: vi.fn(),
  getInputForTargetOutput: vi.fn(),
}));

vi.mock('../src/deepbook.js', () => ({
  getQuantityOut: (...args: unknown[]) => helperState.getQuantityOut(...args),
  getInputForTargetOutput: (...args: unknown[]) => helperState.getInputForTargetOutput(...args),
}));

import {
  createDeepbookQuotePort,
  wrapQuotePortWithStats,
  wrapQuotePortWithCacheAndStats,
  createRequestQuoteCache,
} from '../src/market-policy/quotePort.js';
import { MarketQuoteUnavailableError } from '../src/market-policy/errors.js';
import { SlippageQueryError } from '../src/deepbookErrors.js';
import { SuiOperationError } from '../src/sui/suiOperation.js';
import type { MarketQuotePort } from '../src/market-policy/types.js';
import type { SuiEndpointSnapshot } from '../src/sui/suiOperation.js';

const FAKE_SNAPSHOT = {} as SuiEndpointSnapshot;
const FAKE_PKG = '0xdeepbook';

function makeHop(swapDirection: 'baseForQuote' | 'quoteForBase'): DeepBookPoolHop {
  return {
    poolId: '0xPOOL',
    baseType: '0xBASE',
    quoteType: '0xQUOTE',
    swapDirection,
    feeBps: 0,
  };
}

beforeEach(() => {
  helperState.getQuantityOut.mockReset();
  helperState.getInputForTargetOutput.mockReset();
});

describe('createDeepbookQuotePort.quoteHopOutput', () => {
  it('routes baseForQuote to getQuantityOut and returns the bigint result', async () => {
    helperState.getQuantityOut.mockResolvedValueOnce(27_000_000n);
    const port = createDeepbookQuotePort(FAKE_SNAPSHOT, FAKE_PKG);
    const hop = makeHop('baseForQuote');

    const result = await port.quoteHopOutput(hop, 1_000_000n);

    expect(result).toBe(27_000_000n);
    expect(helperState.getQuantityOut).toHaveBeenCalledTimes(1);
    expect(helperState.getQuantityOut).toHaveBeenCalledWith(
      FAKE_SNAPSHOT,
      FAKE_PKG,
      hop,
      1_000_000n,
    );
  });

  it('routes quoteForBase to getQuantityOut and returns the bigint result', async () => {
    helperState.getQuantityOut.mockResolvedValueOnce(37_000_000n);
    const port = createDeepbookQuotePort(FAKE_SNAPSHOT, FAKE_PKG);
    const hop = makeHop('quoteForBase');

    const result = await port.quoteHopOutput(hop, 2_000_000n);

    expect(result).toBe(37_000_000n);
    expect(helperState.getQuantityOut).toHaveBeenCalledWith(
      FAKE_SNAPSHOT,
      FAKE_PKG,
      hop,
      2_000_000n,
    );
  });

  it('maps SlippageQueryError to MarketQuoteUnavailableError and preserves the message', async () => {
    helperState.getQuantityOut.mockRejectedValueOnce(
      new SlippageQueryError('get_quantity_out: unexpected return tuple'),
    );
    const port = createDeepbookQuotePort(FAKE_SNAPSHOT, FAKE_PKG);

    let thrown: unknown = null;
    try {
      await port.quoteHopOutput(makeHop('baseForQuote'), 1_000n);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MarketQuoteUnavailableError);
    expect((thrown as Error).message).toBe('get_quantity_out: unexpected return tuple');
    expect((thrown as Error).cause).toBeInstanceOf(SlippageQueryError);
  });

  it('preserves typed Sui operation errors', async () => {
    const operationError = new SuiOperationError('transport_unavailable', {
      operation: 'simulate_move_view',
      attempt: 1,
      maxAttempts: 1,
    });
    helperState.getQuantityOut.mockRejectedValueOnce(operationError);
    const port = createDeepbookQuotePort(FAKE_SNAPSHOT, FAKE_PKG);

    let thrown: unknown = null;
    try {
      await port.quoteHopOutput(makeHop('baseForQuote'), 1_000n);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(operationError);
    expect(thrown).not.toBeInstanceOf(MarketQuoteUnavailableError);
  });
});

describe('createDeepbookQuotePort.quoteHopInputForTarget', () => {
  it('routes baseForQuote to getInputForTargetOutput and returns the QuantityInQuote', async () => {
    const expectedQuote = {
      inputAmountSmallest: 123_000n,
      quantityInActualOutputSmallest: 27_000_000n,
      deepRequiredAmount: 5_000n,
    };
    helperState.getInputForTargetOutput.mockResolvedValueOnce(expectedQuote);
    const port = createDeepbookQuotePort(FAKE_SNAPSHOT, FAKE_PKG);
    const hop = makeHop('baseForQuote');

    const result = await port.quoteHopInputForTarget(hop, 27_000_000n);

    expect(result).toBe(expectedQuote); // pass-through, no mutation
    expect(helperState.getInputForTargetOutput).toHaveBeenCalledTimes(1);
    expect(helperState.getInputForTargetOutput).toHaveBeenCalledWith(
      FAKE_SNAPSHOT,
      FAKE_PKG,
      hop,
      27_000_000n,
    );
  });

  it('routes quoteForBase to getInputForTargetOutput and returns the QuantityInQuote', async () => {
    const expectedQuote = {
      inputAmountSmallest: 956_193n,
      quantityInActualOutputSmallest: 37_000_000n,
      deepRequiredAmount: 0n,
    };
    helperState.getInputForTargetOutput.mockResolvedValueOnce(expectedQuote);
    const port = createDeepbookQuotePort(FAKE_SNAPSHOT, FAKE_PKG);
    const hop = makeHop('quoteForBase');

    const result = await port.quoteHopInputForTarget(hop, 37_000_000n);

    expect(result).toBe(expectedQuote);
    expect(helperState.getInputForTargetOutput).toHaveBeenCalledWith(
      FAKE_SNAPSHOT,
      FAKE_PKG,
      hop,
      37_000_000n,
    );
  });

  it('maps SlippageQueryError to MarketQuoteUnavailableError and preserves the message', async () => {
    helperState.getInputForTargetOutput.mockRejectedValueOnce(
      new SlippageQueryError('get_base_quantity_in: unexpected return tuple'),
    );
    const port = createDeepbookQuotePort(FAKE_SNAPSHOT, FAKE_PKG);

    let thrown: unknown = null;
    try {
      await port.quoteHopInputForTarget(makeHop('baseForQuote'), 1_000n);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MarketQuoteUnavailableError);
    expect((thrown as Error).message).toBe('get_base_quantity_in: unexpected return tuple');
    expect((thrown as Error).cause).toBeInstanceOf(SlippageQueryError);
  });

  it('rethrows non-SlippageQueryError errors unwrapped', async () => {
    const generic = new Error('boom');
    helperState.getInputForTargetOutput.mockRejectedValueOnce(generic);
    const port = createDeepbookQuotePort(FAKE_SNAPSHOT, FAKE_PKG);

    let thrown: unknown = null;
    try {
      await port.quoteHopInputForTarget(makeHop('quoteForBase'), 1_000n);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(generic);
    expect(thrown).not.toBeInstanceOf(MarketQuoteUnavailableError);
  });

  it('does not call getQuantityOut for input-target queries', async () => {
    helperState.getInputForTargetOutput.mockResolvedValueOnce({
      inputAmountSmallest: 1n,
      quantityInActualOutputSmallest: 1n,
      deepRequiredAmount: 0n,
    });
    const port = createDeepbookQuotePort(FAKE_SNAPSHOT, FAKE_PKG);

    await port.quoteHopInputForTarget(makeHop('baseForQuote'), 1n);

    expect(helperState.getQuantityOut).not.toHaveBeenCalled();
  });
});

describe('wrapQuotePortWithStats', () => {
  function makeFakePort(overrides?: Partial<MarketQuotePort>): MarketQuotePort {
    return {
      quoteHopOutput: overrides?.quoteHopOutput ?? vi.fn(async () => 0n),
      quoteHopInputForTarget:
        overrides?.quoteHopInputForTarget ??
        vi.fn(async () => ({
          inputAmountSmallest: 0n,
          quantityInActualOutputSmallest: 0n,
          deepRequiredAmount: 0n,
        })),
    };
  }

  it('returns a fresh stats object initialized to zeros', () => {
    const { stats } = wrapQuotePortWithStats(makeFakePort());

    expect(stats).toEqual({
      quantityInCalls: 0,
      quantityOutVerifyCalls: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      // logical / cache_hits fields are present even on the non-cached wrapper.
      quantityInLogicalCalls: 0,
      quantityOutVerifyLogicalCalls: 0,
      cacheHits: 0,
    });
  });

  it('mirrors logical = rpc and keeps cacheHits at 0 in the non-cached wrapper', async () => {
    const inner = makeFakePort();
    const { port, stats } = wrapQuotePortWithStats(inner);

    await port.quoteHopInputForTarget(makeHop('baseForQuote'), 1n);
    await port.quoteHopOutput(makeHop('baseForQuote'), 2n);
    await port.quoteHopOutput(makeHop('quoteForBase'), 3n);

    expect(stats.quantityInCalls).toBe(1);
    expect(stats.quantityOutVerifyCalls).toBe(2);
    expect(stats.quantityInLogicalCalls).toBe(1);
    expect(stats.quantityOutVerifyLogicalCalls).toBe(2);
    expect(stats.cacheHits).toBe(0);
  });

  it('counts each method dispatch and records duration via Date.now()', async () => {
    const inner = makeFakePort();
    const dateNowSpy = vi.spyOn(Date, 'now');
    // Sequence: quoteHopInputForTarget start=0 end=50; quoteHopOutput start=100 end=110.
    dateNowSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(50)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(110);

    const { port, stats } = wrapQuotePortWithStats(inner);

    await port.quoteHopInputForTarget(makeHop('baseForQuote'), 1n);
    await port.quoteHopOutput(makeHop('baseForQuote'), 1n);

    expect(stats.quantityInCalls).toBe(1);
    expect(stats.quantityOutVerifyCalls).toBe(1);
    expect(stats.totalDurationMs).toBe(60);
    expect(stats.maxDurationMs).toBe(50);

    dateNowSpy.mockRestore();
  });

  it('counts the call and records duration even when the underlying port throws', async () => {
    const inner = makeFakePort({
      quoteHopOutput: vi.fn(async () => {
        throw new MarketQuoteUnavailableError('boom');
      }),
    });
    const dateNowSpy = vi.spyOn(Date, 'now');
    dateNowSpy.mockReturnValueOnce(0).mockReturnValueOnce(25);

    const { port, stats } = wrapQuotePortWithStats(inner);

    await expect(port.quoteHopOutput(makeHop('baseForQuote'), 1n)).rejects.toBeInstanceOf(
      MarketQuoteUnavailableError,
    );

    expect(stats.quantityOutVerifyCalls).toBe(1);
    expect(stats.totalDurationMs).toBe(25);
    expect(stats.maxDurationMs).toBe(25);

    dateNowSpy.mockRestore();
  });

  it('keeps maxDurationMs as the largest single-call duration across mixed dispatches', async () => {
    const inner = makeFakePort();
    const dateNowSpy = vi.spyOn(Date, 'now');
    // Three calls: durations 10, 200, 5 — max should land on 200.
    dateNowSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(220)
      .mockReturnValueOnce(300)
      .mockReturnValueOnce(305);

    const { port, stats } = wrapQuotePortWithStats(inner);
    await port.quoteHopOutput(makeHop('baseForQuote'), 1n);
    await port.quoteHopInputForTarget(makeHop('baseForQuote'), 1n);
    await port.quoteHopOutput(makeHop('baseForQuote'), 1n);

    expect(stats.quantityOutVerifyCalls).toBe(2);
    expect(stats.quantityInCalls).toBe(1);
    expect(stats.totalDurationMs).toBe(215);
    expect(stats.maxDurationMs).toBe(200);

    dateNowSpy.mockRestore();
  });

  it('forwards arguments unchanged to the underlying port', async () => {
    const innerOutput = vi.fn(async () => 42n);
    const innerInput = vi.fn(async () => ({
      inputAmountSmallest: 7n,
      quantityInActualOutputSmallest: 0n,
      deepRequiredAmount: 0n,
    }));
    const inner = makeFakePort({
      quoteHopOutput: innerOutput,
      quoteHopInputForTarget: innerInput,
    });
    const hop = makeHop('quoteForBase');

    const { port } = wrapQuotePortWithStats(inner);
    const out = await port.quoteHopOutput(hop, 1_234n);
    const candidate = await port.quoteHopInputForTarget(hop, 5_678n);

    expect(out).toBe(42n);
    expect(candidate.inputAmountSmallest).toBe(7n);
    expect(innerOutput).toHaveBeenCalledWith(hop, 1_234n);
    expect(innerInput).toHaveBeenCalledWith(hop, 5_678n);
  });
});

// ─────────────────────────────────────────────
// createRequestQuoteCache + wrapQuotePortWithCacheAndStats
// ─────────────────────────────────────────────

function makeFakePort(overrides?: Partial<MarketQuotePort>): MarketQuotePort {
  return {
    quoteHopOutput: overrides?.quoteHopOutput ?? vi.fn(async () => 0n),
    quoteHopInputForTarget:
      overrides?.quoteHopInputForTarget ??
      vi.fn(async () => ({
        inputAmountSmallest: 0n,
        quantityInActualOutputSmallest: 0n,
        deepRequiredAmount: 0n,
      })),
  };
}

describe('createRequestQuoteCache', () => {
  it('returns an empty cache (both Maps zero size)', () => {
    const cache = createRequestQuoteCache();
    expect(cache.outputs.size).toBe(0);
    expect(cache.inputs.size).toBe(0);
  });

  it('creates an independent cache on each call (no module-level shared state)', () => {
    const a = createRequestQuoteCache();
    const b = createRequestQuoteCache();
    a.outputs.set('k', 1n);
    a.inputs.set('k', {
      inputAmountSmallest: 1n,
      quantityInActualOutputSmallest: 1n,
      deepRequiredAmount: 0n,
    });
    expect(b.outputs.size).toBe(0);
    expect(b.inputs.size).toBe(0);
  });
});

describe('wrapQuotePortWithCacheAndStats — cache miss path', () => {
  it('dispatches the underlying port on first call and stores the result', async () => {
    const innerOutput = vi.fn(async () => 27_000_000n);
    const inner = makeFakePort({ quoteHopOutput: innerOutput });
    const cache = createRequestQuoteCache();
    const { port, stats } = wrapQuotePortWithCacheAndStats(inner, cache);
    const hop = makeHop('baseForQuote');

    const result = await port.quoteHopOutput(hop, 1_000_000n);

    expect(result).toBe(27_000_000n);
    expect(innerOutput).toHaveBeenCalledTimes(1);
    expect(stats.quantityOutVerifyLogicalCalls).toBe(1);
    expect(stats.quantityOutVerifyCalls).toBe(1);
    expect(stats.cacheHits).toBe(0);
    expect(cache.outputs.size).toBe(1);
  });

  it('dispatches and stores on quoteHopInputForTarget miss', async () => {
    const expectedQuote = {
      inputAmountSmallest: 123n,
      quantityInActualOutputSmallest: 27_000_000n,
      deepRequiredAmount: 5_000n,
    };
    const innerInput = vi.fn(async () => expectedQuote);
    const inner = makeFakePort({ quoteHopInputForTarget: innerInput });
    const cache = createRequestQuoteCache();
    const { port, stats } = wrapQuotePortWithCacheAndStats(inner, cache);

    const result = await port.quoteHopInputForTarget(makeHop('baseForQuote'), 27_000_000n);

    expect(result).toBe(expectedQuote);
    expect(innerInput).toHaveBeenCalledTimes(1);
    expect(stats.quantityInLogicalCalls).toBe(1);
    expect(stats.quantityInCalls).toBe(1);
    expect(stats.cacheHits).toBe(0);
    expect(cache.inputs.size).toBe(1);
  });
});

describe('wrapQuotePortWithCacheAndStats — cache hit path', () => {
  it('does NOT dispatch the underlying port on cache hit (quoteHopOutput)', async () => {
    const innerOutput = vi.fn(async () => 27_000_000n);
    const inner = makeFakePort({ quoteHopOutput: innerOutput });
    const cache = createRequestQuoteCache();
    const { port, stats } = wrapQuotePortWithCacheAndStats(inner, cache);
    const hop = makeHop('baseForQuote');

    // First call dispatches, second hits cache.
    await port.quoteHopOutput(hop, 1_000_000n);
    const second = await port.quoteHopOutput(hop, 1_000_000n);

    expect(second).toBe(27_000_000n);
    expect(innerOutput).toHaveBeenCalledTimes(1); // only the first call dispatched
    expect(stats.quantityOutVerifyLogicalCalls).toBe(2);
    expect(stats.quantityOutVerifyCalls).toBe(1);
    expect(stats.cacheHits).toBe(1);
  });

  it('does NOT dispatch on cache hit for quoteHopInputForTarget', async () => {
    const expectedQuote = {
      inputAmountSmallest: 123n,
      quantityInActualOutputSmallest: 27_000_000n,
      deepRequiredAmount: 5_000n,
    };
    const innerInput = vi.fn(async () => expectedQuote);
    const inner = makeFakePort({ quoteHopInputForTarget: innerInput });
    const cache = createRequestQuoteCache();
    const { port, stats } = wrapQuotePortWithCacheAndStats(inner, cache);
    const hop = makeHop('baseForQuote');

    await port.quoteHopInputForTarget(hop, 27_000_000n);
    const second = await port.quoteHopInputForTarget(hop, 27_000_000n);

    expect(second).toBe(expectedQuote);
    expect(innerInput).toHaveBeenCalledTimes(1);
    expect(stats.quantityInLogicalCalls).toBe(2);
    expect(stats.quantityInCalls).toBe(1);
    expect(stats.cacheHits).toBe(1);
  });

  it('cache hit returns the SAME result reference (no clone)', async () => {
    // Identity preservation matters for solver verification — the cache
    // must not silently break referential equality of QuantityInQuote.
    const expectedQuote = {
      inputAmountSmallest: 123n,
      quantityInActualOutputSmallest: 27_000_000n,
      deepRequiredAmount: 5_000n,
    };
    const inner = makeFakePort({ quoteHopInputForTarget: vi.fn(async () => expectedQuote) });
    const cache = createRequestQuoteCache();
    const { port } = wrapQuotePortWithCacheAndStats(inner, cache);
    const hop = makeHop('baseForQuote');

    const first = await port.quoteHopInputForTarget(hop, 27_000_000n);
    const second = await port.quoteHopInputForTarget(hop, 27_000_000n);

    expect(first).toBe(second); // strict reference equality
    expect(first).toBe(expectedQuote);
  });

  it('two passes with identical args collapse to a single dispatch — floor-bound case lock', async () => {
    // This is the simplified analogue of the floor-binding case in
    // runGenericPrepareBuildPipeline: pass1 / pass1.5 / pass2 all bump effectiveTargetMist
    // to the same floor and dispatch the same quoteHopInputForTarget.
    // Without the cache this is 3 RPCs; with the cache it is 1.
    const innerInput = vi.fn(async () => ({
      inputAmountSmallest: 10_000_000n,
      quantityInActualOutputSmallest: 327_450_000n,
      deepRequiredAmount: 0n,
    }));
    const inner = makeFakePort({ quoteHopInputForTarget: innerInput });
    const cache = createRequestQuoteCache();
    const { port, stats } = wrapQuotePortWithCacheAndStats(inner, cache);
    const hop = makeHop('baseForQuote');

    await port.quoteHopInputForTarget(hop, 327_450_000n);
    await port.quoteHopInputForTarget(hop, 327_450_000n);
    await port.quoteHopInputForTarget(hop, 327_450_000n);

    expect(innerInput).toHaveBeenCalledTimes(1);
    expect(stats.quantityInLogicalCalls).toBe(3);
    expect(stats.quantityInCalls).toBe(1);
    expect(stats.cacheHits).toBe(2);
  });
});

describe('wrapQuotePortWithCacheAndStats — cache key composition', () => {
  // The cache key MUST distinguish entries that would otherwise dispatch to
  // different DeepBook calls. Each axis below is an axis at which a
  // collision would silently return a stale (wrong) quote.

  it('different inputAmountSmallest = independent cache entries', async () => {
    const innerOutput = vi
      .fn()
      .mockResolvedValueOnce(27_000_000n)
      .mockResolvedValueOnce(54_000_000n);
    const inner = makeFakePort({ quoteHopOutput: innerOutput });
    const cache = createRequestQuoteCache();
    const { port, stats } = wrapQuotePortWithCacheAndStats(inner, cache);
    const hop = makeHop('baseForQuote');

    const r1 = await port.quoteHopOutput(hop, 1_000_000n);
    const r2 = await port.quoteHopOutput(hop, 2_000_000n);

    expect(r1).toBe(27_000_000n);
    expect(r2).toBe(54_000_000n);
    expect(innerOutput).toHaveBeenCalledTimes(2);
    expect(stats.cacheHits).toBe(0);
  });

  it('different swapDirection = independent cache entries (direction matters)', async () => {
    const innerOutput = vi
      .fn()
      .mockResolvedValueOnce(27_000_000n) // bfq path
      .mockResolvedValueOnce(37_000_000n); // qfb path
    const inner = makeFakePort({ quoteHopOutput: innerOutput });
    const cache = createRequestQuoteCache();
    const { port, stats } = wrapQuotePortWithCacheAndStats(inner, cache);

    const r1 = await port.quoteHopOutput(makeHop('baseForQuote'), 1_000_000n);
    const r2 = await port.quoteHopOutput(makeHop('quoteForBase'), 1_000_000n);

    expect(r1).toBe(27_000_000n);
    expect(r2).toBe(37_000_000n);
    expect(innerOutput).toHaveBeenCalledTimes(2);
    expect(stats.cacheHits).toBe(0);
  });

  it('different poolId = independent cache entries', async () => {
    const innerOutput = vi.fn().mockResolvedValueOnce(11n).mockResolvedValueOnce(22n);
    const inner = makeFakePort({ quoteHopOutput: innerOutput });
    const cache = createRequestQuoteCache();
    const { port, stats } = wrapQuotePortWithCacheAndStats(inner, cache);
    const hopA = { ...makeHop('baseForQuote'), poolId: '0xPOOL_A' };
    const hopB = { ...makeHop('baseForQuote'), poolId: '0xPOOL_B' };

    const a = await port.quoteHopOutput(hopA, 1n);
    const b = await port.quoteHopOutput(hopB, 1n);

    expect(a).toBe(11n);
    expect(b).toBe(22n);
    expect(innerOutput).toHaveBeenCalledTimes(2);
    expect(stats.cacheHits).toBe(0);
  });

  it('output and input primitives use disjoint cache namespaces', async () => {
    // A `quoteHopInputForTarget(hop, 100)` must not pick up a
    // `quoteHopOutput(hop, 100)` value or vice-versa — different RPC, same
    // numeric argument is a collision risk.
    const inner = makeFakePort({
      quoteHopOutput: vi.fn(async () => 27_000_000n),
      quoteHopInputForTarget: vi.fn(async () => ({
        inputAmountSmallest: 999n,
        quantityInActualOutputSmallest: 27_000_000n,
        deepRequiredAmount: 0n,
      })),
    });
    const cache = createRequestQuoteCache();
    const { port, stats } = wrapQuotePortWithCacheAndStats(inner, cache);
    const hop = makeHop('baseForQuote');

    const out = await port.quoteHopOutput(hop, 100n);
    const candidate = await port.quoteHopInputForTarget(hop, 100n);

    expect(out).toBe(27_000_000n);
    expect(candidate.inputAmountSmallest).toBe(999n);
    expect(stats.cacheHits).toBe(0);
    expect(stats.quantityOutVerifyCalls).toBe(1);
    expect(stats.quantityInCalls).toBe(1);
  });
});

describe('wrapQuotePortWithCacheAndStats — failure handling', () => {
  it('does not cache a thrown error — next call retries', async () => {
    let attempts = 0;
    const innerOutput = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        throw new MarketQuoteUnavailableError('transient');
      }
      return 27_000_000n;
    });
    const inner = makeFakePort({ quoteHopOutput: innerOutput });
    const cache = createRequestQuoteCache();
    const { port, stats } = wrapQuotePortWithCacheAndStats(inner, cache);
    const hop = makeHop('baseForQuote');

    await expect(port.quoteHopOutput(hop, 1n)).rejects.toBeInstanceOf(MarketQuoteUnavailableError);
    // Second call with the same args should retry (no cached failure).
    const second = await port.quoteHopOutput(hop, 1n);

    expect(second).toBe(27_000_000n);
    expect(innerOutput).toHaveBeenCalledTimes(2);
    // Both attempts dispatched; the failed one still incremented rpc/logical
    // counters per the existing semantic (attempts counted, including throws).
    expect(stats.quantityOutVerifyLogicalCalls).toBe(2);
    expect(stats.quantityOutVerifyCalls).toBe(2);
    expect(stats.cacheHits).toBe(0);
  });

  it('records duration only on RPC dispatch, not on cache hit', async () => {
    const inner = makeFakePort({ quoteHopOutput: vi.fn(async () => 1n) });
    const cache = createRequestQuoteCache();
    const dateNowSpy = vi.spyOn(Date, 'now');
    // First (miss) start=0, end=20. Second (hit) does not consume Date.now
    // because the cached branch returns before the timer.
    dateNowSpy.mockReturnValueOnce(0).mockReturnValueOnce(20);

    const { port, stats } = wrapQuotePortWithCacheAndStats(inner, cache);
    const hop = makeHop('baseForQuote');

    await port.quoteHopOutput(hop, 1n);
    await port.quoteHopOutput(hop, 1n); // cache hit

    expect(stats.totalDurationMs).toBe(20);
    expect(stats.maxDurationMs).toBe(20);
    expect(stats.cacheHits).toBe(1);

    dateNowSpy.mockRestore();
  });
});

describe('wrapQuotePortWithCacheAndStats — cache scope (request-local)', () => {
  it('two separate caches do not share state — no cross-request leak', async () => {
    const innerOutput = vi
      .fn()
      .mockResolvedValueOnce(27_000_000n)
      .mockResolvedValueOnce(27_000_000n);
    const inner = makeFakePort({ quoteHopOutput: innerOutput });
    const cacheA = createRequestQuoteCache();
    const cacheB = createRequestQuoteCache();
    const wrapA = wrapQuotePortWithCacheAndStats(inner, cacheA);
    const wrapB = wrapQuotePortWithCacheAndStats(inner, cacheB);
    const hop = makeHop('baseForQuote');

    await wrapA.port.quoteHopOutput(hop, 1n);
    await wrapB.port.quoteHopOutput(hop, 1n);

    // Both must dispatch even though args are identical — each cache is
    // independent. This is the production invariant: two prepare requests
    // must not see each other's cached quotes.
    expect(innerOutput).toHaveBeenCalledTimes(2);
    expect(wrapA.stats.cacheHits).toBe(0);
    expect(wrapB.stats.cacheHits).toBe(0);
  });
});
