import type {
  DeepBookPoolHop,
  SettlementSwapDirection,
  SingleHopSettlementSwapPath,
} from '@stelis/contracts';
import type { QuantityInQuote } from '../deepbook.js';

/**
 * Server-only static settlement swap path descriptor derived from the public capability response.
 *
 * This keeps advertised capability and execution-policy inputs separate:
 * `/relay/config` continues to expose `SingleHopSettlementSwapPathResponse`, while the
 * prepare pipeline consumes this narrower descriptor internally.
 */
export interface StaticSettlementSwapPathDescriptor {
  readonly settlementTokenType: string;
  readonly settlementTokenSymbol: string;
  readonly settlementTokenDecimals: number;
  readonly effectiveFeeRateBps: number;
  readonly settlementSwapDirection: SettlementSwapDirection;
  readonly hops: readonly DeepBookPoolHop[];
  readonly lotSize: bigint;
  readonly minSize: bigint;
}

/**
 * Request for solving the smallest executable swap that satisfies a target SUI
 * output under current market conditions.
 */
export interface ExecutableSwapRequest {
  readonly descriptor: StaticSettlementSwapPathDescriptor;
  readonly targetOutputMist: bigint;
  readonly rawMidPrices: readonly bigint[];
  readonly enforceExecutionGapCap?: boolean;
}

/**
 * Canonical execution-gap assessment for one executable quote.
 *
 * `slippageBufferMist` in higher layers is sourced from `executionGapMist`.
 */
export interface ExecutionGapAssessment {
  readonly idealOutputMist: bigint;
  readonly actualOutputMist: bigint;
  readonly executionGapMist: bigint;
  readonly executionGapBps: bigint;
}

/**
 * Minimal executable swap quote plus its execution-gap assessment.
 */
export interface ExecutableSwapQuote extends ExecutionGapAssessment {
  readonly swapAmountSmallest: bigint;
  readonly targetOutputMist: bigint;
  readonly effectiveTargetOutputMist: bigint;
  readonly quotedHopOutputs: readonly bigint[];
  readonly rawMidPrices: readonly bigint[];
}

/**
 * Narrow port used by the solver to obtain executable DeepBook quotes.
 *
 * Stelis product path always calls DeepBook input-fee view. The port keeps
 * the quote object minimal and does not expose a fee-mode parameter.
 *
 * Responsibility split:
 *   - port: RPC primitive exposure + `SlippageQueryError → MarketQuoteUnavailableError` mapping.
 *   - solver: quantity-out verification policy, conservative retry, `ExecutableSwapQuote` construction.
 *
 * `quoteHopInputForTarget()` returns the raw quantity-in tuple only — verification
 * and `ExecutableSwapQuote` synthesis are not the port's responsibility.
 */
export interface MarketQuotePort {
  quoteHopOutput(hop: DeepBookPoolHop, inputAmountSmallest: bigint): Promise<bigint>;
  quoteHopInputForTarget(
    hop: DeepBookPoolHop,
    targetOutputAmountSmallest: bigint,
  ): Promise<QuantityInQuote>;
}

export type StaticSettlementSwapPathDescriptorMap = Map<string, StaticSettlementSwapPathDescriptor>;

/**
 * Internal input used when deriving descriptors from the advertised settlement
 * swap path contract. The descriptor keeps execution-critical fields only.
 */
export type StaticSettlementSwapPathDescriptorSource = Pick<
  SingleHopSettlementSwapPath,
  | 'settlementTokenType'
  | 'settlementTokenSymbol'
  | 'settlementTokenDecimals'
  | 'effectiveFeeRateBps'
  | 'settlementSwapDirection'
  | 'hops'
  | 'lotSize'
  | 'minSize'
>;
