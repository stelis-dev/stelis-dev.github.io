import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { RelayConfigResponse, RelayPrepareResponse } from '@stelis/contracts';

export type {
  PromotionPrepareRequest,
  PromotionPrepareResponse,
  PromotionSponsorRequest,
  PromotionSponsorResponse,
  RelayConfigResponse,
  RelayPrepareRequest,
  RelayPrepareResponse,
  RelaySponsorRequest,
  RelaySponsorResponse,
  PromotionUnavailableReason,
  PromotionPageQuery,
  PromotionListItem,
  PromotionListResponse,
  UserPromotionDetail,
  PromotionDetailResponse,
} from '@stelis/contracts';

// ─────────────────────────────────────────────
// Client configuration
// ─────────────────────────────────────────────

export interface StelisClientConfig {
  /** Relay API base URL (e.g. "http://localhost:3200/relay") */
  endpoint: string;
  /**
   * Optional per-operation HTTP timeout overrides in milliseconds.
   * Each field must be an integer from 1 through 2,147,483,647 when provided.
   */
  requestTimeouts?: StelisRequestTimeouts;
}

/** Per-operation HTTP timeout overrides (milliseconds). */
export interface StelisRequestTimeouts {
  /** GET /relay/status timeout. Default: `DEFAULT_REQUEST_TIMEOUTS.statusMs`. */
  statusMs?: number;
  /** GET /relay/config timeout used by connect(). Default: `DEFAULT_REQUEST_TIMEOUTS.configMs`. */
  configMs?: number;
  /** POST /relay/prepare timeout. Default: `DEFAULT_REQUEST_TIMEOUTS.prepareMs`. */
  prepareMs?: number;
  /** POST /relay/sponsor timeout. Default: `DEFAULT_REQUEST_TIMEOUTS.sponsorMs`. */
  sponsorMs?: number;
  /** GET /studio/* timeout. Default: `DEFAULT_REQUEST_TIMEOUTS.studioReadMs`. */
  studioReadMs?: number;
  /** POST /studio/* timeout. Default: `DEFAULT_REQUEST_TIMEOUTS.studioWriteMs`. */
  studioWriteMs?: number;
}

// ─────────────────────────────────────────────
// Settle profile (re-export from @stelis/contracts)
// ─────────────────────────────────────────────

export type { SettleProfile } from '@stelis/contracts';
import type { SettleProfile } from '@stelis/contracts';

// ─────────────────────────────────────────────
// /prepare request & response
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// /sponsor request & response
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// DeepBook pool config (re-export from @stelis/contracts)
// ─────────────────────────────────────────────

export type { DeepBookPoolHop, SingleHopSettlementSwapPath } from '@stelis/contracts';
import type { SingleHopSettlementSwapPath } from '@stelis/contracts';

/** Parsed Relay config used internally after JSON-safe integers become bigint. */
export type RelayConfig = Omit<RelayConfigResponse, 'supportedSettlementSwapPaths'> & {
  /** One active settlement swap path per settlementTokenType. */
  supportedSettlementSwapPaths: SingleHopSettlementSwapPath[];
};

// ─────────────────────────────────────────────
// SDK connect options
// ─────────────────────────────────────────────

/** Options for StelisSDK.connect() */
export interface StelisConnectOptions {
  /**
   * S-16: Known-good package ID. If set, SDK verifies at connect time:
   *   1. Host-advertised packageId matches @stelis/contracts
   *   2. pinnedPackageId matches @stelis/contracts
   * Rejects the Host if either check fails.
   */
  pinnedPackageId?: string;
  /**
   * Optional per-operation HTTP timeout overrides in milliseconds.
   * Applies to SDK calls that go through the internal StelisClient and
   * to /relay/config fetch in connect().
   */
  requestTimeouts?: StelisRequestTimeouts;
}

// ─────────────────────────────────────────────
// executeSponsored options
// ─────────────────────────────────────────────

/** Settlement token configuration for sponsored settlement. */
export interface SettlementToken {
  /** Full coin type string from supportedSettlementSwapPaths. */
  type: string;
}

/** Options for sdk.prepareSponsored() */
export interface PrepareSponsoredOptions {
  /** SuiGrpcClient for coin queries and TX building */
  client: SuiGrpcClient;
  /** User wallet address */
  addr: string;
  /** Wallet personal-message sign function for the prepare authorization message. */
  prepareAuthorizationSigner: (messageBytes: Uint8Array) => Promise<string>;
  /** Settlement token to swap to SUI internally. Required. */
  settlementToken: SettlementToken;
  /** Slippage tolerance in basis points. Default: `DEFAULT_SLIPPAGE_BPS`. */
  slippageBps?: number;
  /**
   * Extra margin applied by the Host while preparing settlement funding, in
   * basis points. When omitted, the Host applies its current default.
   */
  gasMarginBps?: number;
  /** Optional order ID — external reference for payment tracking. Max 128 UTF-8 bytes. */
  orderId?: string;
  /**
   * Called after gas cost is determined from /prepare response, before signing.
   * Use to show the user the total cost.
   *
   * @param amount - Total cost in MIST (executionCostClaim + quotedHostFee + protocolFee)
   * @param amountHuman - Total cost in SUI, human-readable (e.g. '0.005370000')
   * @param symbol - Always 'SUI' (native unit)
   */
  onGasEstimate?: (amount: bigint, amountHuman: string, symbol: string) => void;
}

/** Options for sdk.executeSponsored() — extends PrepareSponsoredOptions with signing capability */
export interface ExecuteSponsoredOptions extends PrepareSponsoredOptions {
  /** Wallet sign function: receives base64 txBytes, returns base64 signature */
  signer: (txBytes: string) => Promise<string>;
}

/** Result of sdk.executeSponsored() */
export interface ExecuteSponsoredResult {
  /** Transaction digest (hash) */
  digest: string;
  /** Transaction effects */
  effects: unknown;
  /** Cost breakdown from /prepare */
  cost: RelayPrepareResponse['cost'];
  /** Total cost in MIST (executionCostClaim + quotedHostFee + protocolFee) */
  totalCostMist: bigint;
  /** Total cost in SUI, human-readable (e.g. '0.005370') */
  totalCostSui: string;
  /** Echoed orderId if provided. */
  orderId?: string;
}

/**
 * Result of prepareSponsored() — PTB built and ready for user signing.
 *
 * Used internally by executeSponsored/executeSuiFirst.
 * Also used in advanced 2-step flows (prepare → sign → sponsor)
 * for debug tooling or custom sponsor handling.
 *
 * ⚠️ WARNING: Do NOT modify txBytes after this point.
 * The PTB already includes swap + settle commands. Any modification will break
 * the receiptId binding established during /prepare.
 */
export interface PrepareSponsoredResult {
  /** Full transaction bytes (base64) — ready for user signing. Do NOT modify. */
  txBytes: string;
  /** Receipt ID — pass to /sponsor */
  receiptId: string;
  /** Cost breakdown from /prepare */
  cost: RelayPrepareResponse['cost'];
  /** Effective settle path for prepared tx — 'credit_general' | 'with_vault' | 'new_user' */
  profile: SettleProfile;
  /** Total cost in MIST (executionCostClaim + quotedHostFee + protocolFee) */
  totalCostMist: bigint;
  /** Total cost in SUI, human-readable (e.g. '0.005370') */
  totalCostSui: string;
  /** Echoed orderId if provided. */
  orderId?: string;
  /** Policy hash (hex) — from /prepare response. */
  policyHash: string;
}

/**
 * Non-authoritative gas estimate for UX display.
 *
 * This is a budget-based pre-estimate. It does not reflect the actual
 * settle TX that `/prepare` builds via dry-run. All fields are UX hints:
 * `profile` is a classification for display purposes, not an eligibility check.
 */
export interface GasEstimateResult {
  /** Display unit: 'SUI' for credit_general, pool symbol (e.g. 'DEEP') otherwise */
  displayUnit: string;
  /** Amount in display unit, human-readable */
  amountHuman: string;
  /** SUI equivalent, always provided */
  suiAmountHuman: string;
  /** Settle profile — UX classification, not authoritative eligibility determination */
  profile: SettleProfile;
  /** Whether pool has active liquidity */
  hasLiquidity: boolean;
  /** True when credit_general profile AND fee fields are available — swap not needed */
  canSkipLiquidity: boolean;
}

// ─────────────────────────────────────────────
// executeSuiFirst
// ─────────────────────────────────────────────

/**
 * Result of sdk.executeSuiFirst().
 * `path` is for debug/tracing only — the caller need not branch on it.
 */
export interface ExecuteSuiFirstResult {
  /** 'sui' = executed directly with user SUI | 'sponsored' = Stelis Host-sponsored path */
  path: 'sui' | 'sponsored';
  /** Transaction digest */
  digest: string;
  /** Transaction effects */
  effects: unknown;
  /** Echoed orderId — only available on sponsored path, undefined for direct SUI. */
  orderId?: string;
}

// ─────────────────────────────────────────────
// executePromotionSponsored
// ─────────────────────────────────────────────

/** Options for sdk.executePromotionSponsored(). */
export interface ExecutePromotionSponsoredOptions {
  /** SuiGrpcClient for TX building. */
  client: SuiGrpcClient;
  /** Promotion ID to execute against. */
  promotionId: string;
  /** Wallet sign function: receives base64 txBytes, returns base64 signature. */
  signer: (txBytes: string) => Promise<string>;
  /** User wallet address. */
  addr: string;
  /** Developer JWT token for this promotion + user identity. */
  developerJwt: string;
}

/** Result of sdk.executePromotionSponsored(). */
export interface ExecutePromotionSponsoredResult {
  /** Transaction digest. */
  digest: string;
  /** Transaction effects. */
  effects: unknown;
  /** Full transaction bytes (base64). */
  txBytes: string;
  /** Receipt ID. */
  receiptId: string;
  /** Estimated gas (MIST) from prepare. */
  estimatedGasMist: string;
  /** Actual gas consumed (MIST) from sponsor. */
  actualGasMist: string;
}
