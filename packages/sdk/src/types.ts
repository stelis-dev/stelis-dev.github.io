import { SuiGrpcClient } from '@mysten/sui/grpc';

// ─────────────────────────────────────────────
// Client configuration
// ─────────────────────────────────────────────

export interface StelisClientConfig {
  /** Relay API base URL (e.g. "http://localhost:3200/relay") */
  endpoint: string;
  /**
   * Optional per-operation HTTP timeout overrides in milliseconds.
   * Each field must be a positive integer when provided.
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
// /status response
// ─────────────────────────────────────────────

export interface StatusResponse {
  ok: boolean;
}

// ─────────────────────────────────────────────
// Settle profile (re-export from @stelis/contracts)
// ─────────────────────────────────────────────

export type { SettleProfile } from '@stelis/contracts';
import type { SettleProfile } from '@stelis/contracts';

// ─────────────────────────────────────────────
// /prepare request & response
// ─────────────────────────────────────────────

export interface PrepareParams {
  /** Serialized TransactionKind bytes (base64) */
  txKindBytes: string;
  /** Sender address */
  senderAddress: string;
  /** Settlement token type from supportedSettlementSwapPaths. Selects the host's single active settlement swap path for that token. */
  settlementTokenType: string;
  /** Slippage tolerance in basis points (optional) */
  slippageBps?: number;
  /** Gas margin in basis points (optional) */
  gasMarginBps?: number;
  /** Optional order ID — external reference for payment tracking. Max 128 UTF-8 bytes. */
  orderId?: string;
  /** SHA-256 hash of txKindBytes, encoded as hex. */
  txKindBytesHash: string;
  /** Timestamp included in the signed prepare authorization message. */
  prepareAuthorizationTimestampMs: number;
  /** Client-generated nonce included in the signed prepare authorization message. */
  prepareAuthorizationRequestNonce: string;
  /** Wallet personal-message signature over the canonical prepare authorization message. */
  prepareAuthorizationSignature: string;
}

export interface PrepareResponse {
  /** Full transaction bytes (base64) — ready for user signing */
  txBytes: string;
  /** Receipt ID — pass to /sponsor */
  receiptId: string;
  /** S-14: monotonic nonce assigned for this prepare (string for SDK-safe u64) */
  nonce: string;
  /** Cost breakdown */
  cost: {
    /** Simulated gas: computation + storage - rebate (MIST) */
    simGas: string;
    /** Fixed gas variance margin embedded on-chain (MIST) */
    gasVarianceFixedMist: string;
    /** Slippage buffer: 0 for credit-only settle (MIST) */
    slippageBufferMist: string;
    /** Host-quoted fee per TX (MIST) */
    quotedHostFee: string;
    /** Protocol flat fee (MIST) */
    protocolFee: string;
    /** Gas-recovery claim in settlement arguments: simGas + gasVarianceFixedMist + slippageBufferMist (MIST). */
    executionCostClaim: string;
    /** grossGas = computation + storage before rebate (MIST) */
    grossGas: string;
  };
  /** Effective settle path: 'credit_general' | 'with_vault' | 'new_user' */
  profile: SettleProfile;
  /** Quote timestamp (epoch ms) */
  quoteTimestampMs: number;
  /** Policy hash (hex) */
  policyHash: string;
  /** Echoed orderId if provided in the request. */
  orderId?: string;
}

// ─────────────────────────────────────────────
// /sponsor request & response
// ─────────────────────────────────────────────

export interface SponsorParams {
  /** Full transaction bytes (base64) — from /prepare response */
  txBytes: string;
  /** User signature (base64) */
  userSignature: string;
  /** Receipt ID from /prepare */
  receiptId: string;
}

export interface SponsorResponse {
  /** Transaction digest (hash) */
  digest: string;
  /** Transaction effects (raw) */
  effects: unknown;
  /** Transaction-derived gas-recovery claim in MIST. */
  executionCostClaim: string;
  /** Echoed orderId if provided during /prepare. */
  orderId?: string;
}

// ─────────────────────────────────────────────
// API error
// ─────────────────────────────────────────────

export interface StelisApiError {
  error: string;
  code: string;
}

// ─────────────────────────────────────────────
// DeepBook pool config (re-export from @stelis/contracts)
// ─────────────────────────────────────────────

export type { DeepBookPoolHop, SingleHopSettlementSwapPath } from '@stelis/contracts';
import type { SingleHopSettlementSwapPath } from '@stelis/contracts';

/** Static Relay config response served via GET /relay/config */
export interface RelayConfigResponse {
  network: 'testnet' | 'mainnet';
  /**
   * Host-advertised packageId (from /relay/config response).
   * SDK verifies this matches the expected package ID from @stelis/contracts.
   * Not used for construction; SDK reads contract IDs from @stelis/contracts.
   */
  packageId: string;
  /** Settlement payout recipient address for executionCostClaim plus quotedHostFeeMist. */
  settlementPayoutRecipient: string;
  /** One active settlement swap path per settlementTokenType. */
  supportedSettlementSwapPaths: SingleHopSettlementSwapPath[];
  /** Host-quoted fee per TX in MIST (from HOST_FEE_MIST env). */
  quotedHostFeeMist: string;
  /** Protocol flat fee in MIST (from on-chain Config). */
  protocolFlatFeeMist: string;
  /** S-16: Integrity policy version for client-side PTB verification handshake. Integer >= 1. */
  integrityPolicyVersion: number;
}

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
   * Declare this endpoint as a studio relay (promotion endpoint).
   * Required for promotion-specific methods (executePromotionSponsored,
   * preparePromotionSponsored, sponsorPromotionSponsored).
   */
  studioEndpoint?: boolean;
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
  /**
   * Amount in human-readable units (e.g. '5').
   * If omitted, the SDK auto-calculates from the quote (recommended).
   */
  amount?: string;
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
  /** Intended gas budget in MIST. Default: `DEFAULT_ESTIMATE_GAS_INTENT_BUDGET_MIST`. */
  intentGasBudget?: number;
  /** Slippage tolerance in basis points. Default: `DEFAULT_SLIPPAGE_BPS`. */
  slippageBps?: number;
  /**
   * Extra margin added to the auto-calculated gas amount, in basis points.
   * Default: `DEFAULT_GAS_MARGIN_BPS`.
   * Only applies when settlementToken.amount is not explicitly set.
   * Covers price movement between quote time and swap execution.
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
  cost: PrepareResponse['cost'];
  /** Vault object ID if user has one, null if new user */
  vaultId: string | null;
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
  cost: PrepareResponse['cost'];
  /** Effective settle path for prepared tx — 'credit_general' | 'with_vault' | 'new_user' */
  profile: SettleProfile;
  /** Vault object ID if user has one (null = new user, vault will be created on-chain) */
  vaultId: string | null;
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
// Promotion prepare/sponsor (promotion-specific path)
// ─────────────────────────────────────────────

/** POST /studio/promotions/:id/prepare request body. */
export interface PromotionPrepareParams {
  /** Sender address. */
  senderAddress: string;
  /** Serialized TransactionKind bytes (base64). */
  txKindBytes: string;
}

/** POST /studio/promotions/:id/prepare response. */
export interface PromotionPrepareResponse {
  /** Full transaction bytes — user-signable (base64). */
  txBytes: string;
  /** Unique receipt ID — pass to promotion sponsor. */
  receiptId: string;
  /** Estimated gas cost (MIST) — the amount reserved from budget+allowance. */
  estimatedGasMist: string;
}

/** POST /studio/promotions/:id/sponsor request body. */
export interface PromotionSponsorParams {
  /** Receipt ID from promotion prepare. */
  receiptId: string;
  /** Full transaction bytes (base64). */
  txBytes: string;
  /** User signature (base64). */
  userSignature: string;
}

/** POST /studio/promotions/:id/sponsor response. */
export interface PromotionSponsorResponse {
  /** Transaction digest. */
  digest: string;
  /** Transaction effects. */
  effects: unknown;
  /** Actual gas consumed (MIST). */
  actualGasMist: string;
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

// ─────────────────────────────────────────────
// Promotion discovery (server-to-server, developer JWT)
// ─────────────────────────────────────────────

/** Unavailable reason for promotion sponsored actions. */
export type PromotionUnavailableReason =
  | 'not_claimed'
  | 'promotion_unavailable'
  | 'promotion_not_started'
  | 'claim_deadline_passed'
  | 'use_window_expired'
  | 'allowance_exhausted'
  | 'action_in_flight';

/** Single promotion item from GET /studio/promotions. */
export interface PromotionListItem {
  promotionId: string;
  displayName: string;
  type: string;
  status: string;
  canClaim: boolean;
  canUseSponsoredAction: boolean;
  promotionRemainingBudgetMist: string;
  remainingParticipantSlots: number | null;
  userRemainingGasAllowanceMist: string | null;
  unavailableReason: PromotionUnavailableReason | null;
}

/** GET /studio/promotions response wrapper. */
export interface PromotionListResponse {
  promotions: PromotionListItem[];
}

/** User promotion detail from GET /studio/promotions/:id. */
export interface UserPromotionDetail {
  claimStatus: 'claimed' | 'not_claimed';
  userRemainingGasAllowanceMist: string | null;
  claimDeadlineAt: string | null;
  useUntilAt: string | null;
  canClaim: boolean;
  canUseSponsoredAction: boolean;
  unavailableReason: PromotionUnavailableReason | null;
}

/** GET /studio/promotions/:id response wrapper. */
export interface PromotionDetailResponse {
  promotionId: string;
  displayName: string;
  type: string;
  promotionRemainingBudgetMist: string;
  detail: UserPromotionDetail;
}
