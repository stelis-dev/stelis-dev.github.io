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
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SuiClientTypes } from '@mysten/sui/client';
import type { DeepBookPoolHop } from '@stelis/contracts';
import { SUI_CLOCK_OBJECT_ID, SUI_ZERO_ADDRESS } from './constants.js';
import { SlippageQueryError } from './deepbookErrors.js';
import { bindCurrentSuiResultToBytes } from './suiResultBinding.js';
import { decodeExactU64Bytes } from './decodeU64.js';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Default slippage tolerance in basis points. */
export const DEFAULT_SLIPPAGE_BPS = 200;

type SimulationCommandResults = NonNullable<
  SuiClientTypes.SimulateTransactionResult<{ commandResults: true }>['commandResults']
>;

function requireSuccessfulSimulationCommandResults(
  result: unknown,
  transactionBytes: Uint8Array,
  operation: string,
): SimulationCommandResults {
  const bound = bindCurrentSuiResultToBytes(result, transactionBytes);
  if (!bound) {
    throw new SlippageQueryError(`${operation}: malformed or mismatched simulation result`);
  }
  if (bound.outcome === 'failure') {
    throw new SlippageQueryError(`${operation}: simulation failed (${bound.errorMessage})`);
  }
  if (!bound.commandResults) {
    throw new SlippageQueryError(`${operation}: simulation returned no command results`);
  }
  return bound.commandResults as SimulationCommandResults;
}

// ─────────────────────────────────────────────
// getHopMidPriceRaw — bigint native, per-hop
// ─────────────────────────────────────────────

/**
 * Query DeepBook pool mid-price as raw bigint (no Number conversion).
 * Per-hop query — does not depend on SingleHopSettlementSwapPath array position.
 *
 * Returns raw u64 mid_price, or null if the pool has no data (empty returnValues).
 * Used by slippage measurement path (bigint-only policy).
 *
 * @throws SlippageQueryError on RPC failure (tx.build, simulateTransaction) or BCS decode error.
 */
export async function getHopMidPriceRaw(
  client: SuiGrpcClient,
  deepbookPackageId: string,
  hop: DeepBookPoolHop,
): Promise<bigint | null> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${deepbookPackageId}::pool::mid_price`,
    typeArguments: [hop.baseType, hop.quoteType],
    arguments: [tx.object(hop.poolId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  tx.setSender(SUI_ZERO_ADDRESS);

  let txBytes: Uint8Array;
  try {
    txBytes = await tx.build({ client });
  } catch (err) {
    throw new SlippageQueryError(
      `mid_price tx.build failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let result: unknown;
  try {
    result = await client.simulateTransaction({
      transaction: txBytes,
      include: { commandResults: true },
    });
  } catch (err) {
    throw new SlippageQueryError(
      `mid_price simulateTransaction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Empty/missing return values = pool has no data → null (not an error)
  const cmdResults = requireSuccessfulSimulationCommandResults(result, txBytes, 'mid_price');
  if (!cmdResults?.[0]?.returnValues?.[0]?.bcs) {
    return null;
  }

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
 * Returns bigint[] (one per hop). Null mid-price → 0n (same as getHopMidPriceRaw convention).
 *
 * @throws SlippageQueryError on build/simulate/BCS failure
 */
export async function batchGetHopMidPrices(
  client: SuiGrpcClient,
  deepbookPackageId: string,
  hops: readonly DeepBookPoolHop[],
): Promise<bigint[]> {
  if (hops.length === 0) return [];

  // Single hop — delegate to existing per-hop function (no batching overhead)
  if (hops.length === 1) {
    const mp = await getHopMidPriceRaw(client, deepbookPackageId, hops[0]);
    return [mp ?? 0n];
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
  tx.setSender(SUI_ZERO_ADDRESS);

  let txBytes: Uint8Array;
  try {
    txBytes = await tx.build({ client });
  } catch (err) {
    throw new SlippageQueryError(
      `batch mid_price tx.build failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let result: unknown;
  try {
    result = await client.simulateTransaction({
      transaction: txBytes,
      include: { commandResults: true },
    });
  } catch (err) {
    throw new SlippageQueryError(
      `batch mid_price simulateTransaction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const cmdResults = requireSuccessfulSimulationCommandResults(result, txBytes, 'batch mid_price');
  const prices: bigint[] = [];
  for (let i = 0; i < hops.length; i++) {
    const bcsBytes = cmdResults?.[i]?.returnValues?.[0]?.bcs;
    if (!bcsBytes) {
      // Empty/missing = pool has no data → 0n (same convention as getHopMidPriceRaw null → 0n)
      prices.push(0n);
      continue;
    }
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
 * @throws SlippageQueryError on RPC failure or unexpected response shape
 */
export async function getQuantityOut(
  client: SuiGrpcClient,
  deepbookPackageId: string,
  hop: DeepBookPoolHop,
  inputAmountSmallest: bigint,
): Promise<bigint> {
  const isBaseForQuote = hop.swapDirection === 'baseForQuote';
  const moveFn = isBaseForQuote
    ? 'get_quote_quantity_out_input_fee'
    : 'get_base_quantity_out_input_fee';

  try {
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

    tx.setSender(SUI_ZERO_ADDRESS);
    const txBytes = await tx.build({ client });

    const result = await client.simulateTransaction({
      transaction: txBytes,
      include: { commandResults: true },
    });

    const commandResults = requireSuccessfulSimulationCommandResults(
      result,
      txBytes,
      'get_quantity_out',
    );
    const rv = commandResults[0]?.returnValues;
    if (!rv || rv.length < 3) {
      throw new SlippageQueryError(
        `get_quantity_out: expected 3 return values, got ${rv?.length ?? 0}`,
      );
    }

    // BCS decode each u64
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

    // Select output based on swap direction
    return isBaseForQuote ? quoteOut : baseOut;
  } catch (err) {
    if (err instanceof SlippageQueryError) throw err;
    throw new SlippageQueryError(
      `get_quantity_out RPC failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
 * @throws SlippageQueryError on RPC failure or unexpected response shape.
 */
export async function getInputForTargetOutput(
  client: SuiGrpcClient,
  deepbookPackageId: string,
  hop: DeepBookPoolHop,
  targetOutputAmountSmallest: bigint,
): Promise<QuantityInQuote> {
  const isBaseForQuote = hop.swapDirection === 'baseForQuote';
  const moveFn = isBaseForQuote ? 'get_base_quantity_in' : 'get_quote_quantity_in';

  try {
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

    tx.setSender(SUI_ZERO_ADDRESS);
    const txBytes = await tx.build({ client });

    const result = await client.simulateTransaction({
      transaction: txBytes,
      include: { commandResults: true },
    });

    const commandResults = requireSuccessfulSimulationCommandResults(result, txBytes, moveFn);
    const rv = commandResults[0]?.returnValues;
    if (!rv || rv.length < 3) {
      throw new SlippageQueryError(`${moveFn}: expected 3 return values, got ${rv?.length ?? 0}`);
    }

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
  } catch (err) {
    if (err instanceof SlippageQueryError) throw err;
    throw new SlippageQueryError(
      `${moveFn} RPC failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
    );
  }
}
