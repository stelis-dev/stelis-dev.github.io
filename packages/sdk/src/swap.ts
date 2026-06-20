/**
 * DeepBook v3 Swap utilities for the Stelis SDK.
 *
 * SDK-specific functions:
 *   - checkSettlementSwapPathLiquidity(): UX helper for settlement swap path status display
 */
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SingleHopSettlementSwapPath } from './types.js';

import { batchGetHopMidPrices } from '@stelis/core-relay/browser';
import { bigintToSafeNumberOrNull, formatRatioDecimal } from './numberFormat.js';

// ── checkSettlementSwapPathLiquidity ───────────────────────────────────────

/** Liquidity check result codes */
export type LiquidityStatusCode =
  /** Pool is active and can fill swaps */
  | 'ok'
  /** No bid or ask orders exist (mid_price = 0) */
  | 'no_orders';

/** Per-hop pool status for diagnostic display. */
export interface HopStatus {
  /** Hop index (0-based) */
  hop: number;
  /** DeepBook pool object ID */
  poolId: string;
  /** e.g. "DBUSDC → DEEP" or "DEEP → SUI" */
  label: string;
  /** Swap direction: baseForQuote or quoteForBase */
  swapDirection: 'baseForQuote' | 'quoteForBase';
  /** Base coin type */
  baseType: string;
  /** Quote coin type */
  quoteType: string;
  /** Raw mid_price (1e9 scaled). 0 = no liquidity. */
  midPriceRaw: bigint;
  /** Has liquidity (mid_price > 0) */
  hasLiquidity: boolean;
}

export interface SettlementSwapPathLiquidityStatus {
  /** True if the settlement swap path can fill swaps */
  hasLiquidity: boolean;
  /** Machine-readable status code */
  status: LiquidityStatusCode;
  /** Path-wide mid_price as a JSON-safe display number. null if no liquidity or outside safe range. */
  midPrice: number | null;
  /** Exact path-wide DeepBook mid_price (FLOAT_SCALING=1e9). null if no liquidity. */
  midPriceRaw: bigint | null;
  /**
   * Approximate display number: SUI per settlement token.
   * Example: a DEEP/SUI display price.
   */
  priceHuman: number | null;
  /** Exact rounded display string for SUI per settlement token. */
  priceDisplay: string | null;
  /** e.g. "DEEP/SUI" */
  label: string;
  /** Per-hop breakdown (empty if query failed before hop resolution) */
  hops: HopStatus[];
}

/**
 * Check settlement swap path liquidity from the current DeepBook mid_price snapshot.
 *
 * Only 1-hop settlement swap paths are supported. Checks each hop in the path —
 * reports no liquidity if any hop has mid_price <= 0 (no orders on that pool).
 *
 * This helper intentionally does not perform a dry-run swap simulation.
 * `mid_price > 0` means bid+ask orders exist on both sides of the book,
 * which is the liquidity signal used by the current SDK flow.
 */
export async function checkSettlementSwapPathLiquidity(
  client: SuiGrpcClient,
  deepbookPackageId: string,
  settlementSwapPath: SingleHopSettlementSwapPath,
): Promise<SettlementSwapPathLiquidityStatus> {
  const label = `${settlementSwapPath.settlementTokenSymbol}/SUI`;

  // Query all hop mid-prices in a single batch call
  const hopPrices = await batchGetHopMidPrices(client, deepbookPackageId, settlementSwapPath.hops);

  // Build per-hop status for diagnostic display
  const hopStatuses: HopStatus[] = settlementSwapPath.hops.map((hop, i) => {
    const baseSymbol = extractSymbol(hop.baseType);
    const quoteSymbol = extractSymbol(hop.quoteType);
    const hopLabel =
      hop.swapDirection === 'baseForQuote'
        ? `${baseSymbol} → ${quoteSymbol}`
        : `${quoteSymbol} → ${baseSymbol}`;
    return {
      hop: i,
      poolId: hop.poolId,
      label: hopLabel,
      swapDirection: hop.swapDirection,
      baseType: hop.baseType,
      quoteType: hop.quoteType,
      midPriceRaw: hopPrices[i],
      hasLiquidity: hopPrices[i] > 0n,
    };
  });

  // Any hop with mid_price <= 0 means no liquidity on that leg
  if (hopPrices.some((p) => p <= 0n)) {
    return {
      hasLiquidity: false,
      status: 'no_orders',
      midPrice: null,
      midPriceRaw: null,
      priceHuman: null,
      priceDisplay: null,
      label,
      hops: hopStatuses,
    };
  }

  // Compose path-wide mid-price: direction-aware per-hop composition.
  // Same pattern as getExchangeRate — each hop applies its direction.
  const FLOAT_SCALING = 1_000_000_000n;
  const REF_INPUT = 1_000_000_000_000_000_000n; // 1e18 reference
  let chainedOutput = REF_INPUT;
  for (let i = 0; i < settlementSwapPath.hops.length; i++) {
    if (settlementSwapPath.hops[i].swapDirection === 'baseForQuote') {
      chainedOutput = (chainedOutput * hopPrices[i]) / FLOAT_SCALING;
    } else {
      chainedOutput = hopPrices[i] > 0n ? (chainedOutput * FLOAT_SCALING) / hopPrices[i] : 0n;
    }
  }
  const composedMidPriceRaw = (chainedOutput * FLOAT_SCALING) / REF_INPUT;
  const composedMidPrice = bigintToSafeNumberOrNull(composedMidPriceRaw);
  const inputDecimals = settlementSwapPath.settlementTokenDecimals ?? 6;
  const SUI_DECIMALS = 9;
  // composedMidPrice is always settlementToken→SUI direction
  const priceDisplay = formatRatioDecimal(
    composedMidPriceRaw * 10n ** BigInt(inputDecimals),
    FLOAT_SCALING * 10n ** BigInt(SUI_DECIMALS),
    6,
  );
  const priceHumanNumber = Number(priceDisplay);
  const priceHuman = Number.isFinite(priceHumanNumber) ? priceHumanNumber : null;

  return {
    hasLiquidity: true,
    status: 'ok',
    midPrice: composedMidPrice,
    midPriceRaw: composedMidPriceRaw,
    priceHuman,
    priceDisplay,
    label,
    hops: hopStatuses,
  };
}

/** Extract short symbol from a full coin type string (e.g. "0x...::DBUSDC::DBUSDC" → "DBUSDC") */
function extractSymbol(coinType: string): string {
  const parts = coinType.split('::');
  return parts.length >= 2 ? parts[parts.length - 1] : coinType.slice(0, 10);
}
