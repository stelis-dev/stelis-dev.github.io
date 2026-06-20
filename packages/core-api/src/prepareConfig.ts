import type { SingleHopSettlementSwapPath } from '@stelis/contracts';
import { SETTLEMENT_SWAP_DIRECTION_VECTORS } from '@stelis/contracts';
import type { AllowedSettlementSwapPath } from '@stelis/core-relay';
import type {
  StaticSettlementSwapPathDescriptor,
  StaticSettlementSwapPathDescriptorMap,
} from '@stelis/core-relay/server';
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
export function deriveAllowedSettlementSwapPaths(
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

function assertDescriptorMatchesSettlementSwapPath(
  settlementSwapPath: SingleHopSettlementSwapPath,
  descriptor: StaticSettlementSwapPathDescriptor | undefined,
): void {
  if (!descriptor) {
    throw new Error(
      `[PREPARE_CONFIG] Missing StaticSettlementSwapPathDescriptor for ${settlementSwapPath.settlementTokenType}`,
    );
  }
  const mismatch = (field: string, expected: unknown, actual: unknown): Error =>
    new Error(
      `[PREPARE_CONFIG] StaticSettlementSwapPathDescriptor mismatch for ${settlementSwapPath.settlementTokenSymbol}: ` +
        `${field} expected ${String(expected)}, got ${String(actual)}`,
    );

  if (descriptor.settlementTokenType !== settlementSwapPath.settlementTokenType) {
    throw mismatch(
      'settlementTokenType',
      settlementSwapPath.settlementTokenType,
      descriptor.settlementTokenType,
    );
  }
  if (descriptor.settlementTokenSymbol !== settlementSwapPath.settlementTokenSymbol) {
    throw mismatch(
      'settlementTokenSymbol',
      settlementSwapPath.settlementTokenSymbol,
      descriptor.settlementTokenSymbol,
    );
  }
  if (descriptor.settlementTokenDecimals !== settlementSwapPath.settlementTokenDecimals) {
    throw mismatch(
      'settlementTokenDecimals',
      settlementSwapPath.settlementTokenDecimals,
      descriptor.settlementTokenDecimals,
    );
  }
  if (descriptor.effectiveFeeRateBps !== settlementSwapPath.effectiveFeeRateBps) {
    throw mismatch(
      'effectiveFeeRateBps',
      settlementSwapPath.effectiveFeeRateBps,
      descriptor.effectiveFeeRateBps,
    );
  }
  if (descriptor.settlementSwapDirection !== settlementSwapPath.settlementSwapDirection) {
    throw mismatch(
      'settlementSwapDirection',
      settlementSwapPath.settlementSwapDirection,
      descriptor.settlementSwapDirection,
    );
  }
  if (descriptor.lotSize !== settlementSwapPath.lotSize) {
    throw mismatch('lotSize', settlementSwapPath.lotSize.toString(), descriptor.lotSize.toString());
  }
  if (descriptor.minSize !== settlementSwapPath.minSize) {
    throw mismatch('minSize', settlementSwapPath.minSize.toString(), descriptor.minSize.toString());
  }
  if (descriptor.hops.length !== settlementSwapPath.hops.length) {
    throw mismatch('hops.length', settlementSwapPath.hops.length, descriptor.hops.length);
  }
  for (let i = 0; i < settlementSwapPath.hops.length; i++) {
    const expected = settlementSwapPath.hops[i];
    const actual = descriptor.hops[i];
    if (!actual) throw mismatch(`hops[${i}]`, JSON.stringify(expected), 'missing');
    if (actual.poolId !== expected.poolId) {
      throw mismatch(`hops[${i}].poolId`, expected.poolId, actual.poolId);
    }
    if (actual.baseType !== expected.baseType) {
      throw mismatch(`hops[${i}].baseType`, expected.baseType, actual.baseType);
    }
    if (actual.quoteType !== expected.quoteType) {
      throw mismatch(`hops[${i}].quoteType`, expected.quoteType, actual.quoteType);
    }
    if (actual.swapDirection !== expected.swapDirection) {
      throw mismatch(`hops[${i}].swapDirection`, expected.swapDirection, actual.swapDirection);
    }
    if (actual.feeBps !== expected.feeBps) {
      throw mismatch(`hops[${i}].feeBps`, expected.feeBps, actual.feeBps);
    }
  }
}

function assertSettlementSwapPathDescriptorCoverage(
  settlementSwapPaths: readonly SingleHopSettlementSwapPath[],
  descriptors: StaticSettlementSwapPathDescriptorMap,
): void {
  const expectedTokens = new Set(
    settlementSwapPaths.map((settlementSwapPath) => settlementSwapPath.settlementTokenType),
  );
  for (const settlementSwapPath of settlementSwapPaths) {
    assertDescriptorMatchesSettlementSwapPath(
      settlementSwapPath,
      descriptors.get(settlementSwapPath.settlementTokenType),
    );
  }
  for (const tokenType of descriptors.keys()) {
    if (!expectedTokens.has(tokenType)) {
      throw new Error(
        `[PREPARE_CONFIG] Unexpected StaticSettlementSwapPathDescriptor for ${tokenType}`,
      );
    }
  }
}

/**
 * Build the static settlement swap path descriptor map from host-loaded settlement swap paths.
 * `core-api` owns the descriptor shape because prepare handlers consume it.
 */
export function createPrepareSettlementSwapPathDescriptorMap(
  settlementSwapPaths: readonly SingleHopSettlementSwapPath[],
): StaticSettlementSwapPathDescriptorMap {
  return createStaticSettlementSwapPathDescriptorMap(settlementSwapPaths);
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
  descriptors: StaticSettlementSwapPathDescriptorMap;
  deepbookPackageId: string;
  /**
   * Host-quoted fee per TX (MIST) — from HOST_FEE_MIST env var.
   * 0n when not set (no host fee).
   */
  quotedHostFeeMist?: bigint;
}): PrepareHandlerConfig {
  assertSettlementSwapPathDescriptorCoverage(opts.settlementSwapPaths, opts.descriptors);

  return {
    deepbookPackageId: opts.deepbookPackageId,
    supportedSettlementSwapPaths: opts.settlementSwapPaths,
    settlementSwapPathDescriptors: opts.descriptors,
    allowedSettlementSwapPaths: deriveAllowedSettlementSwapPaths(opts.settlementSwapPaths),
    quotedHostFeeMist: opts.quotedHostFeeMist ?? 0n,
  };
}
