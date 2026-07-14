/**
 * Shared constants for sandbox UI.
 *
 * Settlement token type and decimals are derived from the connected host's
 * supported settlement swap paths at runtime, not from built-in DEEPBOOK_IDS
 * constants.
 */
import type { StelisSDK } from '@stelis/sdk';
import type { SingleHopSettlementSwapPath } from '@stelis/sdk';

/** Decimal places for SUI */
export const SUI_DECIMALS = 9;

/**
 * Get the selected settlement swap path from the SDK's current config.
 * Defaults to the first path for single-path hosts.
 * Throws if no paths are available.
 */
export function getSelectedSettlementSwapPath(
  sdk: StelisSDK,
  settlementSwapPathIndex = 0,
): SingleHopSettlementSwapPath {
  const settlementSwapPaths = sdk.supportedSettlementSwapPaths;
  if (settlementSwapPaths.length === 0) {
    throw new Error('Connected host has no supported settlement swap paths');
  }
  if (settlementSwapPathIndex < 0 || settlementSwapPathIndex >= settlementSwapPaths.length) {
    throw new Error(
      `Settlement swap path index ${settlementSwapPathIndex} out of range (${settlementSwapPaths.length} paths available)`,
    );
  }
  return settlementSwapPaths[settlementSwapPathIndex];
}

/** Why the sandbox direct-swap demo rejects a given settlement swap path (null if supported). */
export type SwapDemoRejectReason = 'unsupported_hop_count' | 'fee_bearing';

/**
 * Identify which (if any) sandbox swap demo prerequisite the settlement swap
 * path fails.
 * Returns null when the demo is supported.
 *
 * Two requirements:
 *   1. 1-hop only — the sandbox demo does not handle settlement swap paths whose hop count
 *      exceeds 1. This check also acts as a fail-closed guard against invalid
 *      runtime shapes (e.g. a misconfigured settlement-swap-paths.json with multiple hops).
 *   2. hop fee rate must be 0 (whitelisted path) — the sandbox demo now
 *      enforces a positive DeepBook output and minimum output, but fee-bearing
 *      paths still require additional input-fee accounting. Supporting
 *      fee-bearing pools in the demo is a separate UX/testing effort and is
 *      out of scope here.
 *
 * The sponsored settlement path (executeSponsored) handles fee-bearing 1-hop
 * pools natively via the SDK.
 */
export function swapDemoRejectReason(
  settlementSwapPath: SingleHopSettlementSwapPath,
): SwapDemoRejectReason | null {
  if (settlementSwapPath.hops.length !== 1) return 'unsupported_hop_count';
  if (settlementSwapPath.hops[0].feeBps !== 0) return 'fee_bearing';
  return null;
}

/**
 * Human-readable explanation for why a settlement swap path is rejected by the
 * sandbox demo.
 * Returns null when the demo is supported.
 */
export function getSwapDemoRejectMessage(
  settlementSwapPath: SingleHopSettlementSwapPath,
): string | null {
  const reason = swapDemoRejectReason(settlementSwapPath);
  if (reason === null) return null;
  if (reason === 'unsupported_hop_count') {
    return `Direct swap demo is available for 1-hop settlement swap paths only. This path reports ${settlementSwapPath.hops.length} hops.`;
  }
  // reason === 'fee_bearing'
  return `Direct swap demo is available for whitelisted settlement swap paths only (feeBps = 0). This path charges ${settlementSwapPath.hops[0].feeBps} bps under DeepBook's input-fee economics, which requires additional direct-swap fee accounting beyond the sandbox demo.`;
}
