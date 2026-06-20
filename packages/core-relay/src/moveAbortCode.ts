/**
 * Move abort numeric constants mirrored from `packages/contracts/move/sources/`.
 *
 * Locked to Move source by `packages/core-relay/tests/errorCodeLock.test.ts`.
 * Any drift between Move source and this file fails per-constant at test
 * time, localizing the diverging name / value.
 *
 * - `SETTLE_ABORT`  mirrors `packages/contracts/move/sources/settle.move`
 * - `VAULT_ABORT`   mirrors `packages/contracts/move/sources/vault.move`
 * - `CONFIG_ABORT`  mirrors `packages/contracts/move/sources/config.move`
 * - `DEEPBOOK_ABORT` tracks external DeepBook abort codes that the Stelis
 *   off-chain classifier maps into prepare error subcodes. DeepBook source
 *   is not in this repo, so it is not locked by the Move-source lock test.
 *
 * Consumers must reference these constants rather than hard-coding numeric
 * literals. Regex builders in the prepare classifier read `.code` off these
 * objects so Move-source renumbering appears as a test failure instead of
 * a silent classifier miss.
 *
 * @module moveAbortCode
 */

// ─────────────────────────────────────────────
// settle.move — runtime settlement aborts (100-110)
// ─────────────────────────────────────────────

export const SETTLE_ABORT = {
  EPaused: 100,
  EClaimTooHigh: 101,
  ETotalInTooLow: 102,
  EInsufficientFunds: 103,
  EInvalidReceiptId: 104,
  EInvalidPolicyHash: 105,
  EConfigVersionMismatch: 106,
  EProtocolFeeMismatch: 107,
  EHostFeeCapExceeded: 108,
  EInvalidOrderIdHash: 109,
  ESpreadTooWide: 110,
} as const satisfies Record<string, number>;

export type SettleAbortName = keyof typeof SETTLE_ABORT;

// ─────────────────────────────────────────────
// vault.move — vault registry + nonce aborts (0-4)
// ─────────────────────────────────────────────

export const VAULT_ABORT = {
  EInsufficientBalance: 0,
  EReplayNonce: 1,
  EVaultAlreadyRegistered: 2,
  EVaultNotRegistered: 3,
  EVaultMismatch: 4,
} as const satisfies Record<string, number>;

export type VaultAbortName = keyof typeof VAULT_ABORT;

// ─────────────────────────────────────────────
// config.move — admin / config guard aborts (2-18)
// ─────────────────────────────────────────────

export const CONFIG_ABORT = {
  EInvalidMaxClaim: 2,
  ENotAdmin: 3,
  EInvalidMinSettle: 4,
  ENotPendingAdmin: 5,
  ENoPendingAdmin: 6,
  EInvalidHostFeeCap: 7,
  EInvalidSpreadBps: 8,
  EPendingAdminExists: 9,
  EPendingConfigExists: 10,
  ENoPendingConfig: 11,
  EConfigUpdateNotReady: 12,
  EPendingTreasuryExists: 13,
  ENoPendingTreasury: 14,
  ETreasuryUpdateNotReady: 15,
  EPendingPauseExists: 16,
  ENoPendingPause: 17,
  EPauseUpdateNotReady: 18,
} as const satisfies Record<string, number>;

export type ConfigAbortName = keyof typeof CONFIG_ABORT;

// ─────────────────────────────────────────────
// External DeepBook aborts that the off-chain classifier maps
// ─────────────────────────────────────────────

/**
 * DeepBook `pool::swap_exact_quantity` abort codes surfaced through Sui
 * MoveAbort messages during dry-run. External dependency — not locked to
 * a Move source in this repo; keep values in sync with the DeepBook
 * package version pinned in `packages/contracts/move/Move.toml`.
 */
export const DEEPBOOK_ABORT = {
  /** `EMinimumQuantityOutNotMet` — emitted when swap min-out is not met. */
  EMinimumQuantityOutNotMet: 12,
} as const satisfies Record<string, number>;

export type DeepbookAbortName = keyof typeof DEEPBOOK_ABORT;
