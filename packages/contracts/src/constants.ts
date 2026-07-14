// Cross-package runtime data tables, identifiers, and discriminator
// literals shared by multiple workspace packages.
//
// Scope policy: data tables + pure data-adjacent lookup functions only.
// No side-effectful runtime helpers, and no Node-only or browser-only deps.

import type { DeepBookSwapDirection, SettlementSwapDirection, SuiNetwork } from './types.js';

// ─────────────────────────────────────────────
// Settlement swap direction data tables and lookups
// ─────────────────────────────────────────────

/**
 * Canonical SettlementSwapDirection ↔ ordered per-hop swapDirection vector mapping.
 *
 * Shared settlement swap direction table for downstream consumers:
 *   - `core-api/prepareConfig.ts` boot barrier (server-side fail-closed)
 *   - `sdk/sdk.ts` response-shape defense (client-side parse guard)
 *   - `app-api/settlementSwapPathRegistry.ts` derives settlementSwapDirection from hop swapDirections
 *
 * Adding a new SettlementSwapDirection requires updating only this table (and its type).
 * The mapping matches the on-chain Move entry signatures and pool orientation
 * constraints declared in `packages/contracts/move/sources/settle.move`.
 */
export const SETTLEMENT_SWAP_DIRECTION_VECTORS: Record<
  SettlementSwapDirection,
  readonly DeepBookSwapDirection[]
> = {
  baseForQuote: ['baseForQuote'],
  quoteForBase: ['quoteForBase'],
};

/** All valid SettlementSwapDirection values (runtime set for parsers/validators). */
export const VALID_SETTLEMENT_SWAP_DIRECTIONS: ReadonlySet<SettlementSwapDirection> = new Set(
  Object.keys(SETTLEMENT_SWAP_DIRECTION_VECTORS) as SettlementSwapDirection[],
);

/**
 * Derive SettlementSwapDirection from an ordered swapDirection vector.
 * Returns undefined when the vector does not match any known profile.
 * Inverse of `SETTLEMENT_SWAP_DIRECTION_VECTORS` lookup.
 */
export function settlementSwapDirectionFromSwapDirections(
  swapDirections: readonly DeepBookSwapDirection[],
): SettlementSwapDirection | undefined {
  for (const [direction, expected] of Object.entries(SETTLEMENT_SWAP_DIRECTION_VECTORS)) {
    if (expected.length !== swapDirections.length) continue;
    if (expected.every((v, i) => v === swapDirections[i])) {
      return direction as SettlementSwapDirection;
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────
// Well-known coin types
// ─────────────────────────────────────────────

/** SUI coin type */
export const SUI_TYPE =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

// ─────────────────────────────────────────────
// Sui network identities
// ─────────────────────────────────────────────

/** Canonical genesis chain identifier returned by each Sui network. */
export const SUI_CHAIN_IDENTIFIERS: Record<SuiNetwork, string> = {
  testnet: '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD',
  mainnet: '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S',
};

// ─────────────────────────────────────────────
// DeepBook IDs per network
// ─────────────────────────────────────────────

/** DeepBook-related contract IDs per network. */
interface DeepBookIds {
  /** Current published storage/call-target package ID. */
  readonly packageId: string;
  /** DEEP token type (full Move type string) */
  readonly deepType: string;
}

/**
 * Canonical DeepBook published IDs per network.
 *
 * `packageId` is the current storage/call target for PTB and read-only Move
 * calls. Compiled ModuleIds and MoveAbort locations use DeepBook's distinct
 * original/runtime identity, generated in `settlementContract.ts`.
 *
 * - `testnet`: deployed testnet IDs.
 * - `mainnet`: deployed DeepBook mainnet IDs.
 *
 * No env overrides, constants only.
 */
export const DEEPBOOK_IDS: Record<SuiNetwork, DeepBookIds | null> = {
  testnet: {
    packageId: '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
    deepType: '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP',
  },
  mainnet: {
    packageId: '0xcaf6ba059d539a97646d47f0b9ddf843e138d215e2a12ca1f4585d386f7aec3a',
    deepType: '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP',
  },
};

// ─────────────────────────────────────────────
// Stelis on-chain contract IDs
// ─────────────────────────────────────────────

/** Canonical Stelis contract object IDs per network. */
interface StelisContractIds {
  readonly packageId: string;
  readonly configId: string;
  readonly vaultRegistryId: string;
}

/**
 * Canonical Stelis contract IDs per network.
 *
 * - `testnet`: deployed testnet contract IDs.
 * - `mainnet`: `null` until mainnet deployment — host boot will fail-closed.
 *
 * These are the ONLY source for contract IDs. Environment variable overrides
 * are intentionally not supported — hardcoded or intermediate values are a
 * security risk.
 */
export const STELIS_CONTRACT_IDS: Record<SuiNetwork, StelisContractIds | null> = {
  testnet: {
    packageId: '0x70443a6eec189037f310bb764e21717d78bb47ace8a1d9aba291c0f72ad15738',
    configId: '0xb727aa48b94e4710c13d527963460e44e3ab0973e341c4892fed8559e29d015c',
    vaultRegistryId: '0x2eb04cf3625fb68d2d6c452952b24989f1aa8be4a1f72235c1d791267197459f',
  },
  mainnet: null,
};

// ─────────────────────────────────────────────
// requireContractId — pure data-adjacent lookup validator
// ─────────────────────────────────────────────

/**
 * Require a contract ID from canonical constants.
 *
 * Throws if the constant value is undefined or empty (e.g. a network-specific
 * state before deployment). Environment variable overrides are NOT supported
 * — this is intentional to prevent hardcoded or intermediate values from
 * bypassing the shared contract constants.
 *
 * Pure lookup: no Node-only or browser-only side effects,
 * no runtime state, tightly coupled to STELIS_CONTRACT_IDS / DEEPBOOK_IDS
 * above.
 *
 * @param constantValue STELIS_CONTRACT_IDS / DEEPBOOK_IDS value for the network
 * @param name          Human-readable name for error messages
 * @returns resolved ID string
 * @throws Error if constant is falsy
 */
export function requireContractId(constantValue: string | undefined, name: string): string {
  if (!constantValue) {
    throw new Error(
      `${name}: not configured in @stelis/contracts constants. ` +
        `Update the contract constants for this network.`,
    );
  }
  return constantValue;
}

// ─────────────────────────────────────────────
// Economic caps (cross-package policy constants)
// ─────────────────────────────────────────────

/**
 * Maximum slippage tolerance (BPS).
 * If measured slippage exceeds this cap, the transaction is rejected (fail-closed).
 * The percentage equivalent is cataloged with `SLIPPAGE_CAP_BPS` in docs/parameters.md.
 */
export const SLIPPAGE_CAP_BPS = 500;

/**
 * Maximum allowed gas margin BPS.
 * Requests specifying gasMarginBps above this cap are rejected.
 * The percentage equivalent and production default are cataloged in docs/parameters.md.
 */
export const GAS_MARGIN_CAP_BPS = 10_000;
