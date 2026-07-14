import { SLIPPAGE_CAP_BPS } from '@stelis/contracts';
import type { ExecutionGapAssessment } from './types.js';
import { ExecutionGapExceededError, MarketQuoteUnavailableError } from './errors.js';

const FLOAT_SCALING = 1_000_000_000n;
const BPS = 10_000n;

function computeIdealOutputMist(
  inputAmountSmallest: bigint,
  midPrice: bigint,
  swapDirection: 'baseForQuote' | 'quoteForBase',
): bigint {
  if (midPrice <= 0n) return 0n;
  if (swapDirection === 'baseForQuote') {
    return (inputAmountSmallest * midPrice) / FLOAT_SCALING;
  }
  return (inputAmountSmallest * FLOAT_SCALING) / midPrice;
}

/**
 * Ceiling-rounded SUI-output for `baseForQuote` only.
 *
 * Used by the baseForQuote market-executable target floor: the floor must be at least
 * the SUI output that exactly minSize base would yield at mid-price, with no
 * truncation. Floor truncation can leave the candidate one unit below
 * `minSize` and DeepBook returns a zero quantity-in candidate. The ceil
 * variant guarantees raised target ≥ minSize-derived ideal output, so
 * `quoteHopInputForTarget()` lands on or above the executable boundary.
 *
 * Scope: baseForQuote only. The quoteForBase floor is `descriptor.minSize` directly (already
 * in SUI base units, no unit conversion needed), so the exported helper is
 * narrow to the current baseForQuote consumer.
 *
 * `midPrice <= 0n` returns `0n` for symmetry with `computeIdealOutputMist`'s
 * defensive zero return; the caller (`solver.effectiveTargetOutputMist`)
 * additionally guards `midPrice > 0n` before invoking. bigint-only.
 */
export function computeBaseForQuoteIdealOutputMistCeil(
  baseInputAmountSmallest: bigint,
  midPrice: bigint,
): bigint {
  if (midPrice <= 0n) return 0n;
  const numerator = baseInputAmountSmallest * midPrice;
  return (numerator + FLOAT_SCALING - 1n) / FLOAT_SCALING;
}

export function buildExecutionGapAssessment(
  inputAmountSmallest: bigint,
  actualOutputMist: bigint,
  rawMidPrice: bigint,
  swapDirection: 'baseForQuote' | 'quoteForBase',
): ExecutionGapAssessment {
  const idealOutputMist = computeIdealOutputMist(inputAmountSmallest, rawMidPrice, swapDirection);
  if (idealOutputMist <= 0n) {
    throw new MarketQuoteUnavailableError('idealOutput is 0 (midPrice too low or input too small)');
  }

  const executionGapMist =
    idealOutputMist > actualOutputMist ? idealOutputMist - actualOutputMist : 0n;
  const executionGapBps = (executionGapMist * BPS) / idealOutputMist;
  return {
    idealOutputMist,
    actualOutputMist,
    executionGapMist,
    executionGapBps,
  };
}

export function assertExecutionGapWithinPolicy(
  assessment: ExecutionGapAssessment,
  capBps = SLIPPAGE_CAP_BPS,
): void {
  if (!Number.isSafeInteger(capBps) || capBps < 0 || capBps > 10_000) {
    throw new Error('execution gap capBps must be a safe integer in [0, 10000]');
  }
  if (assessment.executionGapBps > BigInt(capBps)) {
    throw new ExecutionGapExceededError(
      `Execution gap ${assessment.executionGapBps} BPS exceeds cap ${capBps} BPS`,
    );
  }
}
