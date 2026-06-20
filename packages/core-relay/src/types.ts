// Server-interior domain types.
// Cross-package / SDK-crossing request and response types live in @stelis/contracts.
// This module keeps core-relay-local types used by validation, pricing,
// and server-side helpers.

import type { SettlementSwapDirection, SuiNetwork } from '@stelis/contracts';

// ─────────────────────────────────────────────
// OnchainConfig — read-only snapshot of the deployed Config object
// ─────────────────────────────────────────────

export interface OnchainConfig {
  /** Deployed package ID (0x...) */
  packageId: string;
  /** Shared Config object ID */
  configId: string;

  maxClaimMist: bigint;
  minSettleMist: bigint;
  /**
   * On-chain cap for the host-quoted fee per TX (MIST).
   * Not the quoted fee itself — that is set per Host via HOST_FEE_MIST env.
   * Mirrors on-chain Config.max_host_fee_mist.
   */
  maxHostFeeMist: bigint;
  /** Per-TX fixed protocol fee (MIST). Directly mirrors on-chain Config.protocol_flat_fee_mist. */
  protocolFlatFeeMist: bigint;
  /**
   * Monotonically increasing config version counter.
   * Incremented when an on-chain config change is applied.
   * Used by settle_core to detect config drift between quote time and settlement.
   */
  configVersion: bigint;
  /**
   * Maximum bid-ask spread (BPS) allowed for DeepBook swap paths.
   * Mirrors on-chain Config.max_spread_bps.
   * Mirrors on-chain Config.max_spread_bps; L2 re-validation at sponsor time detects drift.
   */
  maxSpreadBps: bigint;
}

// ─────────────────────────────────────────────
// Allowed settlement swap path
// ─────────────────────────────────────────────

/**
 * A single pre-registered settlement swap path.
 *
 * Security invariant: hops.length === 1 for all active settlement swap paths.
 * L2 validation enforces this.
 */
export interface AllowedSettlementSwapPath {
  /** Payment token full coin type (input of the single hop) */
  tokenType: string;
  /**
   * Pool object ID for this settlement swap path (single-element array).
   * Validated as array equality in L2.
   */
  hops: string[];
  /**
   * Explicit settlement swap direction. Hop count is separately fixed by
   * hops.length === 1, not encoded here.
   */
  settlementSwapDirection: SettlementSwapDirection;
}

/**
 * Server-internal settlement swap path authority type.
 *
 * The settlement swap paths server-side validation (`validateSettleArgs` L2,
 * `deriveAllowedSettlementSwapPaths` boot barrier) accepts as pre-registered. Distinct
 * from the relayer config advertised to clients via `/relay/config`, even
 * though both originate from the same `settlement-swap-paths.json` at boot time.
 *
 * `readonly` marks this as a read-only authority view: downstream consumers
 * iterate but never mutate.
 */
export type AllowedSettlementSwapPaths = readonly AllowedSettlementSwapPath[];

// ─────────────────────────────────────────────
// RelayerEnv — relayer operational environment configuration
// ─────────────────────────────────────────────

export interface RelayerEnv {
  /** Target network (testnet or mainnet) */
  network: SuiNetwork;
  /** Configured settlement payout recipient address */
  relayerAddress: string;
  /** Known Config object ID */
  configId: string;
  /** Known VaultRegistry shared object ID */
  vaultRegistryId: string;
  /** Deployed package ID */
  packageId: string;
  /**
   * Pre-registered settlement swap paths. All pool IDs and settlement swap directions
   * are validated against this list in L2.
   * Derived from the host settlement-swap-paths.json settlement swap path file at context initialization.
   */
  allowedSettlementSwapPaths?: AllowedSettlementSwapPaths;
}

// ─────────────────────────────────────────────
// Validation result (server-interior)
// ─────────────────────────────────────────────

export type ValidationResult = { ok: true } | { ok: false; code: string; message: string };

export const ok = (): ValidationResult => ({ ok: true });
export const fail = (code: string, message: string): ValidationResult => ({
  ok: false,
  code,
  message,
});

// ─────────────────────────────────────────────
// SettleArgs — extracted settle() call arguments (server-interior)
// ─────────────────────────────────────────────

/** Layer 2: extracted settle() call arguments.
 *
 * All 13 fields from the canonical `SETTLE_FIELD_SCHEMA`
 * (see `settlePayloadContract.ts`) are exposed here so that sponsor-side
 * execution logic can read every on-chain-committed audit field directly
 * from `txBytes` without relying on any off-chain store cache. The parser
 * in `parseSettleArgs.ts` is the canonical source — do not introduce a
 * second extractor.
 */
export interface SettleArgs {
  configObjectId: string;
  /**
   * VaultRegistry object ID — present for vault-backed settlement variants.
   */
  registryObjectId?: string;
  settlementPayoutRecipient: string;
  executionCostClaim: bigint;
  /**
   * The settlement swap path extracted from the PTB, used for L2 validation.
   *
   * Invariant: hops.length === 1. L2 validates this + ordered array equality
   * against RelayerEnv.allowedSettlementSwapPaths[]. Omitted for credit-only settlement.
   */
  extractedSettlementSwapPath?: {
    tokenType: string;
    hops: string[]; // ordered pool object IDs
    settlementSwapDirection: SettlementSwapDirection;
  };
  /**
   * BCS-decoded policy_hash from the settle MoveCall (S-16).
   * On-chain S-11 allows 0 or 32 bytes.
   * Off-chain: `/prepare` enforces exactly 32 bytes (S-16 assert).
   * L2 validates this matches the server-computed expectedPolicyHash.
   */
  policyHash: Uint8Array;
  /**
   * Relayer's quoted fee (MIST) — exact value embedded in the PTB.
   * On-chain checks: quoted_host_fee_mist <= max_host_fee_mist (L2 EHostFeeCapExceeded).
   */
  quotedHostFeeMist: bigint;
  /**
   * Expected on-chain protocol fee (MIST) at prepare time.
   * On-chain asserts this equals Config.protocol_flat_fee_mist (L2 EProtocolFeeMismatch).
   */
  expectedProtocolFeeMist: bigint;
  /**
   * Expected config_version at prepare time.
   * On-chain asserts this equals Config.config_version (L2 EConfigVersionMismatch).
   */
  expectedConfigVersion: bigint;
  /**
   * BCS-decoded order_id_hash from the settle MoveCall.
   * On-chain allows 0 or 32 bytes (S-10b).
   * Parsed and passed through; semantic equality is checked by the
   * current sponsor-side validation pipeline rather than this parser.
   */
  orderIdHash: Uint8Array;
  /**
   * S-14: Monotonic nonce for on-chain replay prevention.
   * On-chain asserts nonce > vault.last_nonce.
   * Assigned by /prepare, embedded in PTB, verified in /sponsor.
   */
  nonce: bigint;
  /**
   * BCS-decoded receipt_id from the settle MoveCall.
   * On-chain S-10 allows 0 or 32 bytes.
   * Not used for replay prevention (see S-14); retained for SettleEvent audit trail.
   */
  receiptId: Uint8Array;
  /**
   * Simulated gas cost at quote time (MIST), as written into the on-chain
   * settle PTB. Audit-trail field — S-12 guarantees this does not affect
   * on-chain payout, but sponsor-side L3 uses it as a tamper-proof input.
   */
  simGasReported: bigint;
  /**
   * Fixed gas variance margin (`GAS_VARIANCE_FIXED_MIST` at prepare time)
   * embedded in the on-chain settle PTB. Audit-trail per S-12; used
   * off-chain by sponsor L3 non-loss validation as a tx-derived input.
   */
  gasVarianceFixedMist: bigint;
  /**
   * DEX slippage buffer (MIST) embedded in the on-chain settle PTB.
   * 0 for credit-only settlement. Audit-trail per S-12; used off-chain by
   * sponsor L3 non-loss validation as a tx-derived input.
   */
  slippageBufferMist: bigint;
  /**
   * Quote timestamp (ms since epoch) embedded in the settle PTB.
   * Used for observability and audit trail only. Not used for expiry
   * enforcement — the prepare store TTL owns that concern.
   */
  quoteTimestampMs: bigint;
}
