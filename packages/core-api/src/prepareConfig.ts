import type { SingleHopSettlementSwapPath } from '@stelis/contracts';
import { SETTLEMENT_SWAP_DIRECTION_VECTORS } from '@stelis/contracts';
import type { AllowedSettlementSwapPath } from '@stelis/core-relay';
import { createStaticSettlementSwapPathDescriptorMap } from '@stelis/core-relay/server';
import type { PrepareHandlerConfig } from './handlers/prepare.js';

/**
 * Parse the HOST_FEE_MIST environment variable into a bigint.
 *
 * Centralises env parsing so the host app uses the same
 * logic. Throws a descriptive error at boot time (not request time) if
 * the value is set but invalid.
 *
 * @param envValue  process.env.HOST_FEE_MIST (string | undefined)
 * @returns 0n when not set, parsed bigint when set
 * @throws Error with human-readable message when set to a non-integer string
 */
export function parseHostFeeEnv(envValue: string | undefined): bigint {
  if (!envValue) return 0n;
  if (!/^(?:0|[1-9]\d*)$/.test(envValue)) {
    throw new Error(
      `[HOST_FEE_MIST] Invalid value "${envValue}": expected a non-negative integer string. ` +
        `Set to 0 or remove the env var to disable the host fee.`,
    );
  }
  try {
    const parsed = BigInt(envValue);
    if (parsed < 0n) throw new Error('must be non-negative');
    return parsed;
  } catch {
    throw new Error(
      `[HOST_FEE_MIST] Invalid value "${envValue}": expected a non-negative integer string. ` +
        `Set to 0 or remove the env var to disable the host fee.`,
    );
  }
}

/**
 * Derive AllowedSettlementSwapPath[] from settlement swap path configs.
 *
 * Canonical boot-time fail-closed barrier for settlement swap direction integrity:
 *   - settlementSwapDirection ↔ hops.length
 *   - settlementSwapDirection ↔ ordered per-hop swapDirection vector (from SETTLEMENT_SWAP_DIRECTION_VECTORS)
 *
 * Any mismatch aborts boot, so downstream consumers (L2, prepare/build, sponsor)
 * can treat `AllowedSettlementSwapPath[]` and the originating `supportedSettlementSwapPaths[]` as a trusted,
 * invariant-consistent set. L2 only matches PTB-extracted settlement swap paths against this set;
 * it does not re-verify the boot invariants. The SDK runs an equivalent
 * client-side check over the same settlement swap path table.
 */
function deriveAllowedSettlementSwapPaths(
  settlementSwapPaths: SingleHopSettlementSwapPath[],
): AllowedSettlementSwapPath[] {
  assertUniqueSettlementTokenTypes(settlementSwapPaths);
  return settlementSwapPaths.map((settlementSwapPath) => {
    const expectedDeepBookSwapDirections =
      SETTLEMENT_SWAP_DIRECTION_VECTORS[settlementSwapPath.settlementSwapDirection];
    if (settlementSwapPath.hops.length !== expectedDeepBookSwapDirections.length) {
      throw new Error(
        `Settlement swap path ${settlementSwapPath.settlementTokenSymbol}: settlementSwapDirection '${settlementSwapPath.settlementSwapDirection}' requires ` +
          `${expectedDeepBookSwapDirections.length} hop(s), got ${settlementSwapPath.hops.length}`,
      );
    }
    for (let i = 0; i < expectedDeepBookSwapDirections.length; i++) {
      const actual = settlementSwapPath.hops[i].swapDirection;
      const expected = expectedDeepBookSwapDirections[i];
      if (actual !== expected) {
        throw new Error(
          `Settlement swap path ${settlementSwapPath.settlementTokenSymbol}: settlementSwapDirection '${settlementSwapPath.settlementSwapDirection}' requires ` +
            `hops[${i}].swapDirection='${expected}', got '${actual}'`,
        );
      }
    }
    return {
      tokenType: settlementSwapPath.settlementTokenType,
      hops: settlementSwapPath.hops.map((h) => h.poolId),
      settlementSwapDirection: settlementSwapPath.settlementSwapDirection,
    };
  });
}

function assertUniqueSettlementTokenTypes(
  settlementSwapPaths: readonly SingleHopSettlementSwapPath[],
): void {
  const seen = new Set<string>();
  for (const settlementSwapPath of settlementSwapPaths) {
    if (seen.has(settlementSwapPath.settlementTokenType)) {
      throw new Error(
        `[PREPARE_CONFIG] Duplicate settlementTokenType in supported settlement swap paths: ${settlementSwapPath.settlementTokenType}`,
      );
    }
    seen.add(settlementSwapPath.settlementTokenType);
  }
}

/**
 * Build a PrepareHandlerConfig from resolved runtime values.
 *
 * Settlement swap path set is provided by the host (app-api) at boot time via
 * the settlement-swap-paths.json file. This function is source-agnostic.
 *
 * @param opts.settlementSwapPaths  Resolved configs from the host settlement swap path registry file.
 */
export function resolvePrepareConfig(opts: {
  settlementSwapPaths: SingleHopSettlementSwapPath[];
  deepbookPackageId: string;
  /**
   * Host-quoted fee per TX (MIST) — from HOST_FEE_MIST env var.
   * 0n when not set (no host fee).
   */
  quotedHostFeeMist?: bigint;
}): PrepareHandlerConfig {
  const allowedSettlementSwapPaths = deriveAllowedSettlementSwapPaths(opts.settlementSwapPaths);
  const settlementSwapPathDescriptors = createStaticSettlementSwapPathDescriptorMap(
    opts.settlementSwapPaths,
  );

  return {
    deepbookPackageId: opts.deepbookPackageId,
    supportedSettlementSwapPaths: opts.settlementSwapPaths,
    settlementSwapPathDescriptors,
    allowedSettlementSwapPaths,
    quotedHostFeeMist: opts.quotedHostFeeMist ?? 0n,
  };
}
