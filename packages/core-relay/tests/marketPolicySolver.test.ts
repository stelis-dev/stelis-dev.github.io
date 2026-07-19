import { describe, expect, it, vi } from 'vitest';
import { createStaticSettlementSwapPathDescriptor } from '../src/market-policy/descriptor.js';
import { solveExecutableSwap } from '../src/market-policy/solver.js';
import {
  ExecutionGapExceededError,
  MarketQuoteUnavailableError,
  SwapUnviableUnderPolicyError,
} from '../src/market-policy/errors.js';
import type { MarketQuotePort } from '../src/market-policy/types.js';

/**
 * Build a minimal MarketQuotePort mock that satisfies the structural
 * interface. Each test injects the methods it actually exercises; methods
 * left undefined fall back to a fail-loud throw so an unintended call
 * reports immediately rather than silently resolving undefined.
 */
function makeMockPort(
  quoteHopOutput?: MarketQuotePort['quoteHopOutput'],
  quoteHopInputForTarget?: MarketQuotePort['quoteHopInputForTarget'],
): MarketQuotePort {
  return {
    quoteHopOutput:
      quoteHopOutput ??
      vi.fn(async () => {
        throw new Error('makeMockPort: quoteHopOutput is not exercised by this test');
      }),
    quoteHopInputForTarget:
      quoteHopInputForTarget ??
      vi.fn(async () => {
        throw new Error('makeMockPort: quoteHopInputForTarget is not exercised by this test');
      }),
  };
}

const SUI_TYPE = '0x2::sui::SUI';
const TOKEN_TYPE = '0x1::token::TOKEN';

function makeDescriptor(
  swapDirection: 'baseForQuote' | 'quoteForBase',
  overrides?: { lotSize?: bigint; minSize?: bigint },
) {
  return createStaticSettlementSwapPathDescriptor({
    settlementTokenType: TOKEN_TYPE,
    settlementTokenSymbol: 'TOKEN',
    settlementTokenDecimals: 6,
    effectiveFeeRateBps: 0,
    settlementSwapDirection: swapDirection === 'baseForQuote' ? 'baseForQuote' : 'quoteForBase',
    lotSize: overrides?.lotSize ?? 1_000n,
    minSize: overrides?.minSize ?? 10_000n,
    hops: [
      {
        poolId: '0xpool',
        baseType: swapDirection === 'baseForQuote' ? TOKEN_TYPE : SUI_TYPE,
        quoteType: swapDirection === 'baseForQuote' ? SUI_TYPE : TOKEN_TYPE,
        swapDirection,
        feeBps: 0,
      },
    ],
  });
}

describe('solveExecutableSwap', () => {
  it('bfq: returns the DeepBook quantity-in candidate when verified output meets target', async () => {
    const descriptor = makeDescriptor('baseForQuote');
    const candidate = 20_000n;
    const target = 600_000n;

    const quoteHopInputForTarget = vi.fn(async () => ({
      inputAmountSmallest: candidate,
      quantityInActualOutputSmallest: target,
      deepRequiredAmount: 0n,
    }));
    const quoteHopOutput = vi.fn(async (_hop, input: bigint) => input * 30n);

    const result = await solveExecutableSwap(
      {
        descriptor,
        targetOutputMist: target,
        rawMidPrices: [30_000_000_000n],
      },
      makeMockPort(quoteHopOutput, quoteHopInputForTarget),
    );

    expect(result.swapAmountSmallest).toBe(candidate);
    expect(result.actualOutputMist).toBe(target);
    expect(result.executionGapMist).toBe(0n);
    expect(result.quotedHopOutputs).toEqual([target]);
    expect(quoteHopInputForTarget).toHaveBeenCalledTimes(1);
    expect(quoteHopInputForTarget).toHaveBeenCalledWith(descriptor.hops[0], target);
    expect(quoteHopOutput).toHaveBeenCalledTimes(1);
    expect(quoteHopOutput).toHaveBeenCalledWith(descriptor.hops[0], candidate);
  });

  it('verified quantity-out is canonical: ignores quantity-in actualOutput even when it is larger', async () => {
    // Fixture chosen so idealOutput differs from verifiedOutput: midPrice=31e9
    // gives idealOutput = 20_000 * 31e9 / 1e9 = 620_000n while quoteHopOutput
    // returns 600_000n (verified). The candidate's quantityInActualOutputSmallest
    // is set far above both. The solver must use verifiedOutput everywhere —
    // actualOutputMist, quotedHopOutputs, and the execution-gap math. A leak
    // into actualOutputMist would force executionGapMist to 0n (ideal<actual);
    // the verified path produces exactly 20_000n.
    const descriptor = makeDescriptor('baseForQuote');
    const candidate = 20_000n;
    const target = 600_000n;
    const optimisticActual = 999_999_999n;

    const quoteHopInputForTarget = vi.fn(async () => ({
      inputAmountSmallest: candidate,
      quantityInActualOutputSmallest: optimisticActual,
      deepRequiredAmount: 0n,
    }));
    const quoteHopOutput = vi.fn(async (_hop, input: bigint) => input * 30n);

    const result = await solveExecutableSwap(
      {
        descriptor,
        targetOutputMist: target,
        rawMidPrices: [31_000_000_000n],
      },
      makeMockPort(quoteHopOutput, quoteHopInputForTarget),
    );

    expect(result.actualOutputMist).toBe(target);
    expect(result.actualOutputMist).not.toBe(optimisticActual);
    expect(result.quotedHopOutputs).toEqual([target]);
    expect(result.idealOutputMist).toBe(620_000n);
    expect(result.executionGapMist).toBe(20_000n);
  });

  it('qfb: bumps the verification target to descriptor.minSize when the request target is below it', async () => {
    const descriptor = makeDescriptor('quoteForBase', {
      lotSize: 1n,
      minSize: 1_000_000_000n,
    });
    const target = 100_000n;
    const effective = 1_000_000_000n;

    const quoteHopInputForTarget = vi.fn(async (_hop, askedTarget: bigint) => ({
      inputAmountSmallest: askedTarget,
      quantityInActualOutputSmallest: askedTarget,
      deepRequiredAmount: 0n,
    }));
    const quoteHopOutput = vi.fn(async (_hop, input: bigint) => input);

    const result = await solveExecutableSwap(
      {
        descriptor,
        targetOutputMist: target,
        rawMidPrices: [1_000_000_000n],
      },
      makeMockPort(quoteHopOutput, quoteHopInputForTarget),
    );

    expect(result.effectiveTargetOutputMist).toBe(effective);
    expect(result.swapAmountSmallest).toBe(effective);
    expect(result.actualOutputMist).toBe(effective);
    expect(quoteHopInputForTarget).toHaveBeenCalledWith(descriptor.hops[0], effective);
  });

  it('quote port methods receive no fee-mode parameter (input-fee only by contract)', async () => {
    const descriptor = makeDescriptor('baseForQuote');
    const quoteHopInputForTarget = vi.fn(async () => ({
      inputAmountSmallest: 1_000_000n,
      quantityInActualOutputSmallest: 1_000_000n,
      deepRequiredAmount: 0n,
    }));
    const quoteHopOutput = vi.fn(async () => 1_000_000n);

    await solveExecutableSwap(
      {
        descriptor,
        targetOutputMist: 1_000_000n,
        rawMidPrices: [1_000_000_000n],
      },
      makeMockPort(quoteHopOutput, quoteHopInputForTarget),
    );

    // Every call to either port method must be (hop, amount) — no 3rd arg.
    for (const call of quoteHopOutput.mock.calls) {
      expect(call.length).toBe(2);
    }
    for (const call of quoteHopInputForTarget.mock.calls) {
      expect(call.length).toBe(2);
    }
  });

  it('throws ExecutionGapExceededError when the verified output deviates beyond cap', async () => {
    // Verified output = 90% of input with midPrice 1.0 → 10% gap, > 500 BPS cap.
    const descriptor = makeDescriptor('baseForQuote');
    const quoteHopInputForTarget = vi.fn(async () => ({
      inputAmountSmallest: 1_000_000n,
      quantityInActualOutputSmallest: 900_000n,
      deepRequiredAmount: 0n,
    }));
    const quoteHopOutput = vi.fn(async () => 900_000n);

    await expect(
      solveExecutableSwap(
        {
          descriptor,
          targetOutputMist: 900_000n,
          rawMidPrices: [1_000_000_000n],
        },
        makeMockPort(quoteHopOutput, quoteHopInputForTarget),
      ),
    ).rejects.toThrow(ExecutionGapExceededError);
  });

  it('enforceExecutionGapCap=false returns a quote whose execution gap exceeds the cap', async () => {
    // Cap-exceeded quote with the opt-out flag set. The solver must skip
    // assertExecutionGapWithinPolicy and hand the verified quote back. Locks
    // the production opt-out used by pass1 of the prepare orchestration.
    const descriptor = makeDescriptor('baseForQuote');
    const quoteHopInputForTarget = vi.fn(async () => ({
      inputAmountSmallest: 1_000_000n,
      quantityInActualOutputSmallest: 900_000n,
      deepRequiredAmount: 0n,
    }));
    const quoteHopOutput = vi.fn(async () => 900_000n);

    const result = await solveExecutableSwap(
      {
        descriptor,
        targetOutputMist: 900_000n,
        rawMidPrices: [1_000_000_000n],
        enforceExecutionGapCap: false,
      },
      makeMockPort(quoteHopOutput, quoteHopInputForTarget),
    );

    expect(result.swapAmountSmallest).toBe(1_000_000n);
    expect(result.actualOutputMist).toBe(900_000n);
    expect(result.executionGapMist).toBe(100_000n);
    // Cap is 500 BPS; this quote's gap of 1000 BPS would have failed the
    // default-enforced path.
    expect(result.executionGapBps).toBeGreaterThan(500n);
  });

  it('qfb retry-once: re-quotes at candidate+1 when initial verified output is below target', async () => {
    // Mirrors testnet DBUSDC probe shape: candidate=956_193 verifies as 0n;
    // candidate+1 verifies as the target. The mock's < candidate+1 branch also
    // proves minimality at candidate-1 — it likewise verifies below target.
    const descriptor = makeDescriptor('quoteForBase', { lotSize: 1n, minSize: 0n });
    const candidate = 956_193n;
    const target = 1_000_000_000n;

    const quoteHopInputForTarget = vi.fn(async () => ({
      inputAmountSmallest: candidate,
      quantityInActualOutputSmallest: 0n,
      deepRequiredAmount: 0n,
    }));
    const quoteHopOutput = vi.fn(async (_hop, input: bigint) =>
      input >= candidate + 1n ? target : 0n,
    );

    const result = await solveExecutableSwap(
      {
        descriptor,
        targetOutputMist: target,
        // midPrice chosen so that idealOutput at finalInput=candidate+1 ≈ target.
        rawMidPrices: [956_194n],
      },
      makeMockPort(quoteHopOutput, quoteHopInputForTarget),
    );

    expect(result.swapAmountSmallest).toBe(candidate + 1n);
    expect(result.actualOutputMist).toBe(target);
    expect(quoteHopOutput).toHaveBeenCalledTimes(2);
    expect(quoteHopOutput.mock.calls[0]![1]).toBe(candidate);
    expect(quoteHopOutput.mock.calls[1]![1]).toBe(candidate + 1n);

    // Minimality witness: candidate-1 also verifies below target.
    const earlier = await quoteHopOutput(descriptor.hops[0], candidate - 1n);
    expect(earlier).toBeLessThan(target);
  });

  it('bfq retry-once: re-quotes at candidate+lotSize when initial verified output is below target', async () => {
    const descriptor = makeDescriptor('baseForQuote');
    const candidate = 10_000n;
    const lotSize = descriptor.lotSize;
    const target = 30_000n;

    const quoteHopInputForTarget = vi.fn(async () => ({
      inputAmountSmallest: candidate,
      quantityInActualOutputSmallest: 0n,
      deepRequiredAmount: 0n,
    }));
    const quoteHopOutput = vi.fn(async (_hop, input: bigint) =>
      input >= candidate + lotSize ? target : 0n,
    );

    const result = await solveExecutableSwap(
      {
        descriptor,
        targetOutputMist: target,
        // midPrice chosen so idealOutput at finalInput=11_000 ≈ target.
        rawMidPrices: [2_727_272_728n],
      },
      makeMockPort(quoteHopOutput, quoteHopInputForTarget),
    );

    expect(result.swapAmountSmallest).toBe(candidate + lotSize);
    expect(result.actualOutputMist).toBe(target);
    expect(quoteHopOutput).toHaveBeenCalledTimes(2);
    expect(quoteHopOutput.mock.calls[1]![1]).toBe(candidate + lotSize);

    // Minimality witness: candidate-lotSize also verifies below target.
    const earlier = await quoteHopOutput(descriptor.hops[0], candidate - lotSize);
    expect(earlier).toBeLessThan(target);
  });

  it('throws SwapUnviableUnderPolicyError when retry-once still leaves verified output below target', async () => {
    const descriptor = makeDescriptor('baseForQuote');
    const quoteHopInputForTarget = vi.fn(async () => ({
      inputAmountSmallest: 1_000n,
      quantityInActualOutputSmallest: 0n,
      deepRequiredAmount: 0n,
    }));
    const quoteHopOutput = vi.fn(async () => 1n);

    await expect(
      solveExecutableSwap(
        {
          descriptor,
          targetOutputMist: 9_999_999_999n,
          rawMidPrices: [1_000_000_000n],
        },
        makeMockPort(quoteHopOutput, quoteHopInputForTarget),
      ),
    ).rejects.toThrow(SwapUnviableUnderPolicyError);

    // Exactly two verification calls — candidate then retry — and no further search.
    expect(quoteHopOutput).toHaveBeenCalledTimes(2);
  });

  it('throws MarketQuoteUnavailableError on zero-tuple quantity-in candidate (does not call quoteHopOutput)', async () => {
    const descriptor = makeDescriptor('baseForQuote');
    const quoteHopInputForTarget = vi.fn(async () => ({
      inputAmountSmallest: 0n,
      quantityInActualOutputSmallest: 0n,
      deepRequiredAmount: 0n,
    }));
    const quoteHopOutput = vi.fn(async () => 0n);

    await expect(
      solveExecutableSwap(
        {
          descriptor,
          targetOutputMist: 1_000n,
          rawMidPrices: [1_000_000_000n],
        },
        makeMockPort(quoteHopOutput, quoteHopInputForTarget),
      ),
    ).rejects.toThrow(MarketQuoteUnavailableError);

    expect(quoteHopOutput).not.toHaveBeenCalled();
  });

  it('throws MarketQuoteUnavailableError when mid-price is missing', async () => {
    const descriptor = makeDescriptor('baseForQuote');

    await expect(
      solveExecutableSwap(
        {
          descriptor,
          targetOutputMist: 1_000n,
          rawMidPrices: [0n],
        },
        makeMockPort(),
      ),
    ).rejects.toThrow(MarketQuoteUnavailableError);
  });

  // ── baseForQuote market-executable target floor (mid-price-derived) ───
  //
  // The baseForQuote output side is quote (SUI). The pool's executable boundary is
  // expressed in base units via descriptor.minSize, so the SUI-target floor
  // is the quote-equivalent of minSize at mid-price, ceil-rounded.
  //
  //     floor = ceil(minSize * midPrice / 1e9)
  //
  // Without this bump, requests where the economic SUI target is below the
  // floor produce a zero-tuple quantity-in candidate from DeepBook and the
  // request fails with MARKET_QUOTE_UNAVAILABLE. The bump pushes the target
  // up to the executable boundary; surplus SUI is later absorbed into
  // user-vault credit by `settle_internal`.
  //
  // The bfq mocks below match DeepBook input-fee semantics at mid-price:
  // `quoteHopInputForTarget(t)` returns ceil(t · 1e9 / midPrice) base units;
  // `quoteHopOutput(input)` returns floor(input · midPrice / 1e9) quote out.
  // This keeps `idealOutputMist == actualOutputMist` for the verified pair,
  // so the solver's execution-gap math reads zero gap and the cap-enforced
  // path is exercised cleanly.
  // ─────────────────────────────────────────────────────────────────────

  function makeBfqMidPriceMocks(midPrice: bigint) {
    const quoteHopInputForTarget = vi.fn(async (_hop, askedTarget: bigint) => {
      const numerator = askedTarget * 1_000_000_000n;
      const input = midPrice > 0n ? (numerator + midPrice - 1n) / midPrice : 0n;
      return {
        inputAmountSmallest: input,
        quantityInActualOutputSmallest: askedTarget,
        deepRequiredAmount: 0n,
      };
    });
    const quoteHopOutput = vi.fn(async (_hop, input: bigint) => {
      return (input * midPrice) / 1_000_000_000n;
    });
    return { quoteHopInputForTarget, quoteHopOutput };
  }

  it('bfq: bumps the verification target to ceil(minSize * midPrice / 1e9) when the request target is below it', async () => {
    // descriptor: minSize = 1_000_000n base units (DEEP-equivalent).
    // midPrice = 32_745_000_000n (SUI scaled by 1e9 per base unit).
    // floor = ceil(1_000_000 * 32_745_000_000 / 1_000_000_000) = 32_745_000n SUI MIST.
    const descriptor = makeDescriptor('baseForQuote', {
      lotSize: 1n,
      minSize: 1_000_000n,
    });
    const target = 5_000_000n;
    const expectedFloor = 32_745_000n;
    const midPrice = 32_745_000_000n;

    const { quoteHopInputForTarget, quoteHopOutput } = makeBfqMidPriceMocks(midPrice);

    const result = await solveExecutableSwap(
      {
        descriptor,
        targetOutputMist: target,
        rawMidPrices: [midPrice],
      },
      makeMockPort(quoteHopOutput, quoteHopInputForTarget),
    );

    expect(result.targetOutputMist).toBe(target);
    expect(result.effectiveTargetOutputMist).toBe(expectedFloor);
    expect(quoteHopInputForTarget).toHaveBeenCalledWith(descriptor.hops[0], expectedFloor);
  });

  it('bfq: leaves the target unchanged when it already exceeds the minSize-derived floor', async () => {
    const descriptor = makeDescriptor('baseForQuote', {
      lotSize: 1n,
      minSize: 1_000_000n,
    });
    // floor at midPrice 32_745e9 = 32_745_000n SUI MIST. target above floor → no bump.
    const target = 100_000_000n;
    const midPrice = 32_745_000_000n;

    const { quoteHopInputForTarget, quoteHopOutput } = makeBfqMidPriceMocks(midPrice);

    const result = await solveExecutableSwap(
      {
        descriptor,
        targetOutputMist: target,
        rawMidPrices: [midPrice],
      },
      makeMockPort(quoteHopOutput, quoteHopInputForTarget),
    );

    expect(result.targetOutputMist).toBe(target);
    expect(result.effectiveTargetOutputMist).toBe(target);
    expect(quoteHopInputForTarget).toHaveBeenCalledWith(descriptor.hops[0], target);
  });

  it('bfq: ceil-rounds when minSize * midPrice is not divisible by 1e9 (under-bump prevention)', async () => {
    // Pick fixture where minSize * midPrice / 1e9 has a non-zero remainder so
    // floor-div would produce a target one MIST below the executable boundary.
    //
    //   minSize  = 7n
    //   midPrice = 1_000_000_001n
    //   product  = 7_000_000_007n
    //   product / 1e9         = 7n  (floor — would under-bump)
    //   ceil(product / 1e9)   = 8n
    const descriptor = makeDescriptor('baseForQuote', {
      lotSize: 1n,
      minSize: 7n,
    });
    const midPrice = 1_000_000_001n;

    const { quoteHopInputForTarget, quoteHopOutput } = makeBfqMidPriceMocks(midPrice);

    const result = await solveExecutableSwap(
      {
        descriptor,
        targetOutputMist: 1n,
        rawMidPrices: [midPrice],
      },
      makeMockPort(quoteHopOutput, quoteHopInputForTarget),
    );

    expect(result.effectiveTargetOutputMist).toBe(8n);
    expect(result.targetOutputMist).toBe(1n);
    expect(quoteHopInputForTarget).toHaveBeenCalledWith(descriptor.hops[0], 8n);
  });

  it('bfq: raised target still fails closed when DeepBook returns a zero-tuple candidate', async () => {
    // Wide-spread residual: even after bumping target to the mid-price-derived
    // floor, discrete bid-side tick depth or lot rounding at top of book can
    // leave the candidate base one unit short of `minSize`, and DeepBook then
    // returns a zero quantity-in tuple. (bfq matches bids per book.move:140 +
    // pool.move:206-224; the on-chain spread guard at settle.move:60 enforces
    // `best_ask > best_bid` on every executed swap, so any non-crossed book
    // satisfies `mid > best_bid` and the mid-derived floor is already strictly
    // above the bid-side floor — no side-correct stronger floor exists.) The
    // solver must keep its existing fail-closed behavior.
    const descriptor = makeDescriptor('baseForQuote', {
      lotSize: 1n,
      minSize: 1_000_000n,
    });
    const target = 5_000_000n;

    const quoteHopInputForTarget = vi.fn(async () => ({
      inputAmountSmallest: 0n,
      quantityInActualOutputSmallest: 0n,
      deepRequiredAmount: 0n,
    }));
    const quoteHopOutput = vi.fn(async () => 0n);

    await expect(
      solveExecutableSwap(
        {
          descriptor,
          targetOutputMist: target,
          rawMidPrices: [32_745_000_000n],
        },
        makeMockPort(quoteHopOutput, quoteHopInputForTarget),
      ),
    ).rejects.toThrow(MarketQuoteUnavailableError);

    // Verifies the solver did ask DeepBook with the *raised* target, not the
    // original below-floor target — the fail came from DeepBook's response,
    // not from skipping the bump.
    expect(quoteHopInputForTarget).toHaveBeenCalledWith(descriptor.hops[0], 32_745_000n);
    expect(quoteHopOutput).not.toHaveBeenCalled();
  });

  it('bfq production-scale lock: DEEP/SUI 10-DEEP minSize at 32.745e9 mid-price raises 75M target to 327.45M floor', async () => {
    // Production-scale fixture:
    //
    //   settlementSwapDirection = baseForQuote (DEEP -> SUI)
    //   credit_mist = 0
    //   max_claim_mist = 75_000_000n  (initial probe target)
    //   raw_mid_prices = [32_745_000_000n]
    //   descriptor.minSize = 10_000_000n  (DeepBook DEEP/SUI = 10 DEEP at 6 decimals)
    //
    // Current behavior:
    //   floor = ceil(10_000_000 × 32_745_000_000 / 1e9) = 327_450_000n
    //   75_000_000 < 327_450_000  → bump fires
    //   solver asks DeepBook with the raised target.
    //
    // This lock is NOT a duplicate of the smaller-fixture bump test above;
    // the smaller fixture documents the formula at a synthetic scale, while
    // this one pins formula and unit handling against real DEEP/SUI numbers.
    const descriptor = makeDescriptor('baseForQuote', {
      lotSize: 1n,
      minSize: 10_000_000n,
    });
    const target = 75_000_000n;
    const expectedFloor = 327_450_000n;
    const midPrice = 32_745_000_000n;

    const { quoteHopInputForTarget, quoteHopOutput } = makeBfqMidPriceMocks(midPrice);

    const result = await solveExecutableSwap(
      {
        descriptor,
        targetOutputMist: target,
        rawMidPrices: [midPrice],
      },
      makeMockPort(quoteHopOutput, quoteHopInputForTarget),
    );

    expect(result.targetOutputMist).toBe(target);
    expect(result.effectiveTargetOutputMist).toBe(expectedFloor);
    expect(quoteHopInputForTarget).toHaveBeenCalledWith(descriptor.hops[0], expectedFloor);
  });

  it('preserves both raw `targetOutputMist` and raised `effectiveTargetOutputMist` on the returned quote', async () => {
    // Lock the contract that the quote object exposes the original economic
    // target *and* the bumped market-executable target. Observability and
    // diagnostic payloads upstream rely on both fields being present.
    const descriptor = makeDescriptor('baseForQuote', {
      lotSize: 1n,
      minSize: 1_000_000n,
    });
    const rawTarget = 1_000n;
    const expectedFloor = 32_745_000n;
    const midPrice = 32_745_000_000n;

    const { quoteHopInputForTarget, quoteHopOutput } = makeBfqMidPriceMocks(midPrice);

    const result = await solveExecutableSwap(
      {
        descriptor,
        targetOutputMist: rawTarget,
        rawMidPrices: [midPrice],
      },
      makeMockPort(quoteHopOutput, quoteHopInputForTarget),
    );

    expect(result.targetOutputMist).toBe(rawTarget);
    expect(result.effectiveTargetOutputMist).toBe(expectedFloor);
    expect(result.targetOutputMist).not.toBe(result.effectiveTargetOutputMist);
  });
});
