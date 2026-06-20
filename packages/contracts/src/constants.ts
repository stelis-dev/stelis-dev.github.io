// Cross-package runtime data tables, identifiers, and discriminator
// literals shared by multiple workspace packages.
//
// Scope policy: data tables + pure data-adjacent lookup functions only.
// No side-effectful runtime helpers, and no Node-only or browser-only deps.

import type {
  DeepBookSwapDirection,
  SettlementSwapDirection,
  SettleProfile,
  SuiNetwork,
} from './types.js';

// ─────────────────────────────────────────────
// Settle entrypoint names (discriminator literals)
// ─────────────────────────────────────────────

/** settle module identifier */
export const SETTLE_MODULE = 'settle';

// ── bfq (base_for_quote): Pool<Token, SUI> ──────────────────────────
export const SWAP_AND_SETTLE_NEW_USER_BFQ = 'swap_and_settle_new_user_bfq';
export const SWAP_AND_SETTLE_WITH_VAULT_BFQ = 'swap_and_settle_with_vault_bfq';

// ── qfb (quote_for_base): Pool<SUI, Token> ──────────────────────────
export const SWAP_AND_SETTLE_NEW_USER_QFB = 'swap_and_settle_new_user_qfb';
export const SWAP_AND_SETTLE_WITH_VAULT_QFB = 'swap_and_settle_with_vault_qfb';

/** credit-only settlement (no swap) */
export const SETTLE_WITH_CREDIT_FUNCTION = 'settle_with_credit';

/** All valid settle entry-point function names (L1 allowlist). */
export const SETTLE_FUNCTIONS = new Set([
  SWAP_AND_SETTLE_NEW_USER_BFQ,
  SWAP_AND_SETTLE_WITH_VAULT_BFQ,
  SWAP_AND_SETTLE_NEW_USER_QFB,
  SWAP_AND_SETTLE_WITH_VAULT_QFB,
  SETTLE_WITH_CREDIT_FUNCTION,
]);

// ─────────────────────────────────────────────
// Settlement swap direction data tables and lookups
// ─────────────────────────────────────────────

/**
 * Map settlementSwapDirection → [new_user function, with_vault function].
 * Used by PTB builders and parseSettleArgs to resolve function names.
 */
export const SETTLEMENT_SWAP_DIRECTION_FUNCTIONS: Record<
  SettlementSwapDirection,
  { newUser: string; withVault: string }
> = {
  baseForQuote: {
    newUser: SWAP_AND_SETTLE_NEW_USER_BFQ,
    withVault: SWAP_AND_SETTLE_WITH_VAULT_BFQ,
  },
  quoteForBase: {
    newUser: SWAP_AND_SETTLE_NEW_USER_QFB,
    withVault: SWAP_AND_SETTLE_WITH_VAULT_QFB,
  },
};

/**
 * Derive SettlementSwapDirection from a settle function name.
 * Returns undefined for credit-only settlement or unknown functions.
 */
export function settlementSwapDirectionFromFunctionName(
  fnName: string,
): SettlementSwapDirection | undefined {
  for (const [direction, fns] of Object.entries(SETTLEMENT_SWAP_DIRECTION_FUNCTIONS)) {
    if (fns.newUser === fnName || fns.withVault === fnName) {
      return direction as SettlementSwapDirection;
    }
  }
  return undefined;
}

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
// Settle profile ranking (cost order)
// ─────────────────────────────────────────────

/**
 * Profile rank: lower = cheaper settle path.
 * credit_general is rank 0 (exact debit, no swap).
 */
export const PROFILE_RANKS: Record<SettleProfile, number> = {
  credit_general: 0,
  with_vault: 1,
  new_user: 2,
};

// ─────────────────────────────────────────────
// Well-known coin types
// ─────────────────────────────────────────────

/** SUI coin type */
export const SUI_TYPE =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

// ─────────────────────────────────────────────
// Integrity policy version
// ─────────────────────────────────────────────

/**
 * Integrity policy version shared by SDK and server code.
 *
 * Both the SDK (client-side verification) and the server (/relay/config)
 * must reference this constant. Changing it in one place updates both.
 */
export const INTEGRITY_POLICY_VERSION = 1;

// ─────────────────────────────────────────────
// DeepBook IDs per network
// ─────────────────────────────────────────────

/** DeepBook-related contract IDs per network. */
export interface DeepBookIds {
  /** DeepBook v3 package ID */
  readonly packageId: string;
  /** DEEP token type (full Move type string) */
  readonly deepType: string;
}

/**
 * Canonical DeepBook IDs per network.
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
export interface StelisContractIds {
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
    packageId: '0xf5e47d8c1f7c842b3369ef77ea4bab19eafa71780a118e3fe3eaef9e76885d64',
    configId: '0x73793aa89f04420355738213b0a98d2a41a568588a42927e33a69f885b22fdb1',
    vaultRegistryId: '0x63ce68518baf0988418e9c49d147b349bb9d683f012ba100530980fd68e31e36',
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
