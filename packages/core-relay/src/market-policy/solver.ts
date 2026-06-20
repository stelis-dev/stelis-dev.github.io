import { MarketQuoteUnavailableError, SwapUnviableUnderPolicyError } from './errors.js';
import {
  assertExecutionGapWithinPolicy,
  buildExecutionGapAssessment,
  computeBaseForQuoteIdealOutputMistCeil,
} from './risk.js';
import type {
  ExecutableSwapQuote,
  ExecutableSwapRequest,
  MarketQuotePort,
  StaticSettlementSwapPathDescriptor,
} from './types.js';

/**
 * Bump the verification target up to the pool's minimum executable output:
 *
 *   - qfb (output side is base): SUI output target lives in base units, so the
 *     floor is descriptor.minSize directly.
 *   - bfq (output side is quote): SUI output target lives in quote units, so
 *     the floor is the quote-equivalent of `descriptor.minSize` base units at
 *     the current mid-price. Computed via ceil(minSize * midPrice / 1e9) using
 *     the bfq-only `computeBaseForQuoteIdealOutputMistCeil` helper in
 *     `risk.ts` to avoid duplicating the unit-conversion formula.
 *
 * The bumped value is what we ask DeepBook for via quantity-in, so the
 * candidate input lands inside the pool's executable range. mid-price-derived
 * floors are necessary but not sufficient — bfq matches the bid side
 * (`book.move:140` + `pool.move:206-224`), so even after raising the target
 * to `ceil(minSize × mid / 1e9)`, discrete bid-side tick depth or lot
 * rounding can still leave the candidate one unit short and DeepBook returns
 * a zero quantity-in tuple. That residual case is preserved as a fail-closed
 * `MarketQuoteUnavailableError` by the caller.
 *
 * No side-correct stronger floor exists for bfq. Note the execution order:
 * the solver runs during prepare against the `mid_price` RPC, which only
 * asserts non-empty book (`book.move:281` — `EEmptyOrderbook`) and accepts
 * crossed or zero-width books without error. Stelis' on-chain spread guard
 * (`settle.move:60` — `assert!(best_ask > best_bid, ESpreadTooWide)`) runs
 * later, inside the swap entry, and rejects crossed / zero-width books with
 * abort 110 there. So a crossed book can reach this helper, but the swap
 * itself will never settle through it. For the executable subset — books
 * that pass the on-chain guard, which are the only ones that ever settle —
 * `best_ask > best_bid` holds, so `mid = (best_bid + best_ask) / 2 >
 * best_bid`. The bid-side-derived floor `ceil(minSize × best_bid / 1e9)` is
 * therefore strictly below the mid-derived floor on every settleable book;
 * replacing the mid-derived floor with a bid-side floor would only weaken
 * the floor on the cases that actually settle. A best-ask-derived floor
 * would be on the wrong side of the book entirely (bfq does not consume
 * asks). The mid-derived floor is the minimal conservative target this
 * helper can compute without an additional level2 RPC.
 *
 * `midPrice <= 0n` causes the bfq branch to fall through to the request
 * target unchanged. `solveExecutableSwap` validates mid-price > 0 before
 * calling, so this is defensive — kept so the helper is total over its
 * inputs.
 */
function effectiveTargetOutputMist(
  targetOutputMist: bigint,
  descriptor: StaticSettlementSwapPathDescriptor,
  midPrice: bigint,
): bigint {
  const hop = descriptor.hops[0];
  if (!hop) return targetOutputMist;
  if (hop.swapDirection === 'quoteForBase' && descriptor.minSize > targetOutputMist) {
    return descriptor.minSize;
  }
  if (hop.swapDirection === 'baseForQuote' && midPrice > 0n && descriptor.minSize > 0n) {
    const floor = computeBaseForQuoteIdealOutputMistCeil(descriptor.minSize, midPrice);
    if (floor > targetOutputMist) {
      return floor;
    }
  }
  return targetOutputMist;
}

/**
 * Conservative retry step applied when the quantity-in candidate's verified
 * quantity-out is still below the effective target. qfb increments by one
 * smallest unit; bfq increments by one lot. The solver applies this step at
 * most once per call.
 */
function conservativeRetryInput(
  candidateInput: bigint,
  descriptor: StaticSettlementSwapPathDescriptor,
): bigint {
  const hop = descriptor.hops[0];
  if (!hop) return candidateInput;
  if (hop.swapDirection === 'quoteForBase') return candidateInput + 1n;
  const step = descriptor.lotSize > 1n ? descriptor.lotSize : 1n;
  return candidateInput + step;
}

/**
 * Solve for the smallest executable swap whose verified quantity-out meets
 * the target.
 *
 * Flow:
 *   1. Resolve effective target (qfb base-minSize bump or bfq mid-price-derived
 *      ceil floor).
 *   2. Ask the port for a quantity-in candidate (DeepBook view, input-fee mode).
 *   3. Verify with quantity-out — same fee mode used at settlement.
 *   4. If verified output < target, run one conservative retry
 *      (qfb input+1 / bfq input+lotSize) and re-verify.
 *   5. Build the execution-gap assessment from the verified output and
 *      enforce the cap unless the caller opts out.
 *
 * Stelis does not search inputs; DeepBook's quantity-in is authoritative for
 * minimal executable input. The single retry exists because pool-side
 * rounding can leave the candidate marginally short by one lot or unit
 * relative to the requested target.
 */
export async function solveExecutableSwap(
  request: ExecutableSwapRequest,
  quotePort: MarketQuotePort,
): Promise<ExecutableSwapQuote> {
  const { descriptor, rawMidPrices } = request;
  if (descriptor.hops.length !== 1) {
    throw new MarketQuoteUnavailableError(
      `Unsupported hop count ${descriptor.hops.length} (only one-hop settlement swap paths are supported)`,
    );
  }
  if (rawMidPrices.length !== descriptor.hops.length) {
    throw new MarketQuoteUnavailableError(
      `midPrices length ${rawMidPrices.length} does not match hops length ${descriptor.hops.length}`,
    );
  }

  const midPrice = rawMidPrices[0] ?? 0n;
  if (midPrice <= 0n) {
    throw new MarketQuoteUnavailableError('Mid-price unavailable (empty orderbook)');
  }

  const hop = descriptor.hops[0];
  const effectiveTargetMist = effectiveTargetOutputMist(
    request.targetOutputMist,
    descriptor,
    midPrice,
  );

  const candidate = await quotePort.quoteHopInputForTarget(hop, effectiveTargetMist);
  if (candidate.inputAmountSmallest <= 0n) {
    throw new MarketQuoteUnavailableError(
      `quantity-in returned zero candidate for target ${effectiveTargetMist.toString()} (insufficient liquidity or below min-size)`,
    );
  }

  let finalInput = candidate.inputAmountSmallest;
  let verifiedOutput = await quotePort.quoteHopOutput(hop, finalInput);

  if (verifiedOutput < effectiveTargetMist) {
    const retryInput = conservativeRetryInput(finalInput, descriptor);
    finalInput = retryInput;
    verifiedOutput = await quotePort.quoteHopOutput(hop, retryInput);
  }

  if (verifiedOutput < effectiveTargetMist) {
    throw new SwapUnviableUnderPolicyError(
      `Verified output ${verifiedOutput.toString()} is below target ${effectiveTargetMist.toString()} after retry`,
    );
  }

  const assessment = buildExecutionGapAssessment(
    finalInput,
    verifiedOutput,
    midPrice,
    hop.swapDirection,
  );

  if (request.enforceExecutionGapCap !== false) {
    assertExecutionGapWithinPolicy(assessment);
  }

  return {
    swapAmountSmallest: finalInput,
    targetOutputMist: request.targetOutputMist,
    effectiveTargetOutputMist: effectiveTargetMist,
    quotedHopOutputs: [verifiedOutput],
    rawMidPrices: [...rawMidPrices],
    ...assessment,
  };
}
