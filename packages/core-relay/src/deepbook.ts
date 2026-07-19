/**
 * DeepBook v3 shared utilities.
 *
 * Contains:
 *   - getHopMidPriceRaw / batchGetHopMidPrices: bigint-native per-hop mid-price queries
 *   - getQuantityOut: view-call expected swap output for a given input
 *   - getInputForTargetOutput: view-call quantity-in candidate for a target output
 *   - DEFAULT_SLIPPAGE_BPS: shared slippage tolerance constant
 */
import { Transaction } from '@mysten/sui/transactions';
import type { DeepBookPoolHop } from '@stelis/contracts';
import { SUI_CLOCK_OBJECT_ID } from './constants.js';
import { SlippageQueryError } from './deepbookErrors.js';
import { decodeExactU64Bytes } from './decodeU64.js';
import { simulateSuiMoveView } from './sui/suiTransactionGateways.js';
import { suiExecutionErrorMessage } from './sui/suiTransactionShape.js';
import type { SuiCommandResult, SuiMoveViewResult } from './sui/suiTransactionShape.js';
import type { SuiEndpointSnapshot } from './sui/suiOperation.js';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Default slippage tolerance in basis points. */
export const DEFAULT_SLIPPAGE_BPS = 200;

function requireSuccessfulSimulationCommandResults(
  result: SuiMoveViewResult,
  operation: string,
): readonly SuiCommandResult[] {
  if (result.outcome === 'failure') {
    throw new SlippageQueryError(
      `${operation}: simulation failed (${suiExecutionErrorMessage(result.error)})`,
    );
  }
  return result.commandResults;
}

function requireExactViewResults(
  result: SuiMoveViewResult,
  operation: string,
  commandCount: number,
  returnCount: number,
): readonly SuiCommandResult[] {
  const commandResults = requireSuccessfulSimulationCommandResults(result, operation);
  if (commandResults.length !== commandCount) {
    throw new SlippageQueryError(
      `${operation}: expected ${commandCount} command results, got ${commandResults.length}`,
    );
  }
  commandResults.forEach((command, index) => {
    if (command.returnValues.length !== returnCount) {
      throw new SlippageQueryError(
        `${operation}: command ${index} expected ${returnCount} return values, got ${command.returnValues.length}`,
      );
    }
    if (command.mutatedReferences.length !== 0) {
      throw new SlippageQueryError(
        `${operation}: command ${index} unexpectedly returned mutated references`,
      );
    }
  });
  return commandResults;
}

// ─────────────────────────────────────────────
// getHopMidPriceRaw — bigint native, per-hop
// ─────────────────────────────────────────────

/**
 * Query DeepBook pool mid-price as raw bigint (no Number conversion).
 * Per-hop query — does not depend on SingleHopSettlementSwapPath array position.
 *
 * Returns the exact raw u64 mid_price. DeepBook represents no orders as zero.
 * Used by slippage measurement path (bigint-only policy).
 *
 * @throws SuiOperationError when resolution/simulation fails.
 * @throws SlippageQueryError when the completed view result violates the DeepBook ABI.
 */
export async function getHopMidPriceRaw(
  snapshot: SuiEndpointSnapshot,
  deepbookPackageId: string,
  hop: DeepBookPoolHop,
): Promise<bigint> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${deepbookPackageId}::pool::mid_price`,
    typeArguments: [hop.baseType, hop.quoteType],
    arguments: [tx.object(hop.poolId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  const result: SuiMoveViewResult = await simulateSuiMoveView(snapshot, {
    transaction: tx,
  });

  const cmdResults = requireExactViewResults(result, 'mid_price', 1, 1);

  // BCS decode — the boundary translates exact-width decoder failures to the
  // DeepBook query error contract.
  const bcsBytes = cmdResults[0].returnValues[0].bcs;
  const buf = bcsBytes instanceof Uint8Array ? bcsBytes : new Uint8Array(bcsBytes);
  return decodeDeepBookU64(buf);
}

/**
 * Batch-query per-hop mid-prices in a single simulateTransaction round-trip.
 *
 * Packs one mid_price MoveCall per hop into a single Transaction.
 * For 1-hop pools this is equivalent to getHopMidPriceRaw.
 *
 * Returns one exact bigint mid-price per hop. DeepBook represents no orders as zero.
 *
 * @throws SuiOperationError when resolution/simulation fails.
 * @throws SlippageQueryError when a completed result violates the DeepBook ABI.
 */
export async function batchGetHopMidPrices(
  snapshot: SuiEndpointSnapshot,
  deepbookPackageId: string,
  hops: readonly DeepBookPoolHop[],
): Promise<bigint[]> {
  if (hops.length === 0) return [];

  // Single hop — delegate to existing per-hop function (no batching overhead)
  if (hops.length === 1) {
    const mp = await getHopMidPriceRaw(snapshot, deepbookPackageId, hops[0]);
    return [mp];
  }

  // Hop count > 1: batch all mid_price calls into one TX
  const tx = new Transaction();
  for (const hop of hops) {
    tx.moveCall({
      target: `${deepbookPackageId}::pool::mid_price`,
      typeArguments: [hop.baseType, hop.quoteType],
      arguments: [tx.object(hop.poolId), tx.object(SUI_CLOCK_OBJECT_ID)],
    });
  }
  const result: SuiMoveViewResult = await simulateSuiMoveView(snapshot, {
    transaction: tx,
  });

  const cmdResults = requireExactViewResults(result, 'batch mid_price', hops.length, 1);
  const prices: bigint[] = [];
  for (let i = 0; i < hops.length; i++) {
    const bcsBytes = cmdResults[i]!.returnValues[0]!.bcs;
    const buf = bcsBytes instanceof Uint8Array ? bcsBytes : new Uint8Array(bcsBytes);
    prices.push(decodeDeepBookU64(buf));
  }
  return prices;
}

// ─────────────────────────────────────────────
// getQuantityOut — BCS 3-tuple, per-hop
// ─────────────────────────────────────────────

/**
 * Query DeepBook expected swap output via view function.
 * No coin objects needed — pure simulateTransaction call.
 *
 * Input-fee only: Stelis settle always runs DeepBook in input-fee mode
 * (the Move swap entrypoint materializes `coin::zero<DEEP>` internally),
 * so there is no fee-mode parameter. Hop direction determines function +
 * output field:
 *   baseForQuote → get_quote_quantity_out_input_fee(pool, inputQty, clock) → returnValues[1]
 *   quoteForBase → get_base_quantity_out_input_fee(pool, inputQty, clock) → returnValues[0]
 *
 * Returns: (u64, u64, u64) = (base_out, quote_out, deep_required)
 *
 * Source: pool.move:869, pool.move:921
 *
 * @throws SuiOperationError when resolution/simulation fails.
 * @throws SlippageQueryError when a completed result violates the DeepBook ABI.
 */
export async function getQuantityOut(
  snapshot: SuiEndpointSnapshot,
  deepbookPackageId: string,
  hop: Pick<DeepBookPoolHop, 'poolId' | 'baseType' | 'quoteType' | 'swapDirection'>,
  inputAmountSmallest: bigint,
): Promise<bigint> {
  const isBaseForQuote = hop.swapDirection === 'baseForQuote';
  const moveFn = isBaseForQuote
    ? 'get_quote_quantity_out_input_fee'
    : 'get_base_quantity_out_input_fee';

  const tx = new Transaction();
  tx.moveCall({
    target: `${deepbookPackageId}::pool::${moveFn}`,
    typeArguments: [hop.baseType, hop.quoteType],
    arguments: [
      tx.object(hop.poolId),
      tx.pure.u64(inputAmountSmallest),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await simulateSuiMoveView(snapshot, { transaction: tx });

  const commandResults = requireExactViewResults(result, 'get_quantity_out', 1, 3);
  const rv = commandResults[0]!.returnValues;

  const decode = (idx: number): bigint => {
    const bcs = rv[idx]?.bcs;
    if (!bcs) {
      throw new SlippageQueryError(`get_quantity_out: missing BCS at index ${idx}`);
    }
    const buf = bcs instanceof Uint8Array ? bcs : new Uint8Array(bcs);
    return decodeDeepBookU64(buf);
  };

  const baseOut = decode(0);
  const quoteOut = decode(1);
  decode(2); // deep_required — not used but decoded for shape validation

  return isBaseForQuote ? quoteOut : baseOut;
}

// ─────────────────────────────────────────────
// getInputForTargetOutput — quantity-in BCS 3-tuple, per-hop
// ─────────────────────────────────────────────

/**
 * Result of a DeepBook quantity-in view call, direction-resolved.
 *
 * `inputAmountSmallest` is the input token (base for `baseForQuote`, quote for
 * `quoteForBase`). `quantityInActualOutputSmallest` is the output the call
 * reports the candidate input would yield; this is **diagnostic only** —
 * canonical actual output is the result of a separate `getQuantityOut`
 * verification call. `deepRequiredAmount` is decoded for shape validation
 * and audit, but is meaningless under input-fee mode.
 */
export interface QuantityInQuote {
  readonly inputAmountSmallest: bigint;
  readonly quantityInActualOutputSmallest: bigint;
  readonly deepRequiredAmount: bigint;
}

/**
 * Query DeepBook quantity-in view for the input required to reach a target
 * output. No coin objects needed — pure simulateTransaction call.
 *
 * Hop direction selects function and tuple-field interpretation:
 *   baseForQuote → get_base_quantity_in;  input = pos 0, actualOutput = pos 1
 *   quoteForBase → get_quote_quantity_in; input = pos 1, actualOutput = pos 0
 *
 * `pay_with_deep` is hardcoded to `false` to match Stelis settlement swap
 * input-fee mode (zero DEEP coin). The public API intentionally does not
 * expose a fee-mode parameter.
 *
 * Tuple shape (verified against deployed testnet ABI):
 *   (u64, u64, u64) = (base_value, quote_value, deep_required)
 *
 * Zero-tuple `(0, 0, 0)` (insufficient liquidity / below min-size) is
 * returned as-is. Caller policy decides fail-closed handling — the helper
 * does not fail on zero values.
 *
 * @throws SuiOperationError when resolution/simulation fails.
 * @throws SlippageQueryError when a completed result violates the DeepBook ABI.
 */
export async function getInputForTargetOutput(
  snapshot: SuiEndpointSnapshot,
  deepbookPackageId: string,
  hop: DeepBookPoolHop,
  targetOutputAmountSmallest: bigint,
): Promise<QuantityInQuote> {
  const isBaseForQuote = hop.swapDirection === 'baseForQuote';
  const moveFn = isBaseForQuote ? 'get_base_quantity_in' : 'get_quote_quantity_in';

  const tx = new Transaction();
  tx.moveCall({
    target: `${deepbookPackageId}::pool::${moveFn}`,
    typeArguments: [hop.baseType, hop.quoteType],
    arguments: [
      tx.object(hop.poolId),
      tx.pure.u64(targetOutputAmountSmallest),
      tx.pure.bool(false),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const result = await simulateSuiMoveView(snapshot, { transaction: tx });

  const commandResults = requireExactViewResults(result, moveFn, 1, 3);
  const rv = commandResults[0]!.returnValues;

  const decode = (idx: number): bigint => {
    const bcs = rv[idx]?.bcs;
    if (!bcs) {
      throw new SlippageQueryError(`${moveFn}: missing BCS at index ${idx}`);
    }
    const buf = bcs instanceof Uint8Array ? bcs : new Uint8Array(bcs);
    return decodeDeepBookU64(buf);
  };

  const baseValue = decode(0);
  const quoteValue = decode(1);
  const deepRequiredAmount = decode(2);

  return {
    inputAmountSmallest: isBaseForQuote ? baseValue : quoteValue,
    quantityInActualOutputSmallest: isBaseForQuote ? quoteValue : baseValue,
    deepRequiredAmount,
  };
}

// ─────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────

function decodeDeepBookU64(bytes: Uint8Array): bigint {
  try {
    return decodeExactU64Bytes(bytes);
  } catch (error) {
    throw new SlippageQueryError(
      `u64 BCS decode failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
