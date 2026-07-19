// Cross-package request and response types shared by multiple workspace packages.
// Scope policy: types + literal unions only. Runtime helpers stay in
// interior packages.

// ─────────────────────────────────────────────
// Network
// ─────────────────────────────────────────────

export type SuiNetwork = 'mainnet' | 'testnet';

// ─────────────────────────────────────────────
// Settle profile (cost-path discriminator)
// ─────────────────────────────────────────────

/**
 * SettleProfile: identifies which settle path a PTB will take.
 *
 *   credit_general — credit-only settlement, with or without user commands
 *   with_vault     — vault-backed swap settlement, any settlement swap direction
 *   new_user       — first-use vault creation with swap settlement, any settlement swap direction
 *
 * rank: 0 (cheapest) → 2 (most expensive)
 */
export type SettleProfile = 'credit_general' | 'with_vault' | 'new_user';

// ─────────────────────────────────────────────
// Settlement swap path policy
// ─────────────────────────────────────────────

/**
 * SettlementSwapDirection: explicit swap direction identity for each settle entry.
 *
 *   baseForQuote — Pool<Token, SUI>: swap_exact_base_for_quote
 *   quoteForBase — Pool<SUI, Token>: swap_exact_quote_for_base
 *
 * This is a settlement swap direction type. Do not confuse with SettleProfile
 * (cost-path type: credit_general | with_vault | new_user).
 */
export type SettlementSwapDirection = 'baseForQuote' | 'quoteForBase';

/** Per-hop DeepBook swap direction. */
export type DeepBookSwapDirection = 'baseForQuote' | 'quoteForBase';

// ─────────────────────────────────────────────
// PTB command abstraction (parsed by app layer before passing in)
// ─────────────────────────────────────────────

/** MoveCall command within a PTB */
export interface MoveCallCommand {
  kind: 'MoveCall';
  packageId: string;
  module: string;
  function: string;
  /** Move generic type arguments e.g. ['0x...::deep::DEEP', '0x2::sui::SUI'] */
  typeArguments: string[];
  arguments: unknown[];
}

/**
 * Other (non-MoveCall) command within a PTB.
 *
 * S-15: arguments are preserved from the raw PTB so that
 * validatePtbStructure can reject commands that reference GasCoin.
 * In a sponsored transaction, GasCoin belongs to the sponsor.
 * Allowing PTB commands to reference it would let an attacker
 * steal sponsor funds.
 */
export interface OtherCommand {
  kind: string;
  /** Raw command arguments — needed for GasCoin reference detection (S-15). */
  arguments?: unknown[];
}

export type PtbCommand = MoveCallCommand | OtherCommand;

// ─────────────────────────────────────────────
// DeepBook pool config
// ─────────────────────────────────────────────

/** Configuration for a single DeepBook pool hop */
export interface DeepBookPoolHop {
  /** Pool<Base, Quote> object ID */
  poolId: string;
  /** Pool base coin type */
  baseType: string;
  /** Pool quote coin type */
  quoteType: string;
  /** Swap direction */
  swapDirection: 'baseForQuote' | 'quoteForBase';
  /**
   * Stelis execution fee in basis points for this hop.
   * 0 = whitelisted pool. Fee-bearing DeepBook pools are reported on the
   * input-fee basis used by settle.move (`coin::zero<DEEP>()`), not the lower
   * DEEP-fee baseline. Hosts derive this from DeepBook pool params plus the
   * deployed DeepBook fee constants.
   */
  feeBps: number;
}

/**
 * Settlement swap path configuration for a settlement token.
 * The host exposes one active 1-hop settlement swap path per settlementTokenType.
 * Clients select a settlement token, not a pool ID or path ID.
 *
 * Hosts derive feeBps at boot from DeepBook whitelisted status, pool params,
 * and the deployed DeepBook fee constants.
 */
export interface SingleHopSettlementSwapPath {
  /** Hop configs. Only 1 hop is supported. */
  hops: DeepBookPoolHop[];
  /** Settlement token full coin type (input token for the first hop) */
  settlementTokenType: string;
  /** UI display symbol e.g. "DEEP", "USDC" */
  settlementTokenSymbol: string;
  /** Decimal places for the settlement token */
  settlementTokenDecimals: number;
  /** DeepBook minimum order granularity (smallest unit of first-hop base token, on-chain u64) */
  lotSize: bigint;
  /** DeepBook minimum order size (smallest unit of first-hop base token, on-chain u64) */
  minSize: bigint;
  /**
   * Effective Stelis swap fee rate across all hops (basis points).
   * 0 for fully whitelisted paths, >0 for paths with fees.
   * Fee-bearing DeepBook pools use input-fee basis because Stelis does not
   * materialize a user DEEP fee coin. Hosts derive this from DeepBook pool
   * params plus the deployed DeepBook fee constants.
   */
  effectiveFeeRateBps: number;
  /**
   * Explicit settlement swap direction for structure and settlement-argument verification. Hop count is
   * separately fixed by hops.length === 1, not encoded here.
   */
  settlementSwapDirection: SettlementSwapDirection;
}

/**
 * JSON-safe HTTP projection of `SingleHopSettlementSwapPath`.
 *
 * `SingleHopSettlementSwapPath.lotSize` / `minSize` are `bigint` in runtime (u64 on-chain),
 * but JSON cannot encode BigInt. Host routes convert them to `number` at the HTTP
 * boundary (see app-api/routes/admin.ts safeBigintToNumber). Clients that parse
 * the JSON directly (e.g. admin dashboard) consume this shape, while the SDK
 * converts it back to BigInt through SDK settlement swap path validation + `BigInt(...)`.
 *
 * This is a JSON transport projection of `SingleHopSettlementSwapPath`.
 * Any new field added there that needs HTTP transport must also be added here.
 */
export type SingleHopSettlementSwapPathResponse = Omit<
  SingleHopSettlementSwapPath,
  'lotSize' | 'minSize'
> & {
  /** JSON-safe u64 (must satisfy Number.isSafeInteger — fail-closed at parse). */
  lotSize: number;
  /** JSON-safe u64 (must satisfy Number.isSafeInteger — fail-closed at parse). */
  minSize: number;
};

// ─────────────────────────────────────────────
// Prepare authorization
// ─────────────────────────────────────────────

/**
 * Fields signed by a wallet before `/relay/prepare` can reserve relay work.
 *
 * `txKindBytesHash` is the SHA-256 hash of the user-authored TransactionKind
 * bytes. `requestNonce` is a client-generated replay guard for the prepare
 * request; it is separate from the on-chain settlement nonce assigned by the
 * relay after admission.
 */
export interface PrepareAuthorizationFields {
  network: SuiNetwork;
  packageId: string;
  senderAddress: string;
  txKindBytesHash: string;
  settlementTokenType: string;
  slippageBps?: number;
  gasMarginBps?: number;
  orderId?: string;
  timestampMs: number;
  requestNonce: string;
}

// ─────────────────────────────────────────────
// Settlement event verification
// ─────────────────────────────────────────────

/**
 * Expected values required when a server verifies an on-chain SettleEvent.
 * A verifier must bind the event to the application order by either raw
 * `orderId` or a precomputed `orderIdHash`.
 */
export type ExpectedSettleEventFields = {
  /** Stelis-issued 32-byte receipt ID, encoded as `0x` plus 64 lowercase hex digits. */
  receiptId: string;
  /** User wallet address expected in the on-chain event. */
  user: string;
  /** Expected execution cost claim in MIST, when the integration tracks amounts. */
  executionCostClaimMist?: string;
  /** Expected quoted host fee in MIST, when the integration tracks amounts. */
  quotedHostFeeMist?: string;
  /** Expected protocol fee in MIST, when the integration tracks amounts. */
  protocolFeeMist?: string;
} & (
  | { orderId: string; orderIdHash?: never }
  | {
      orderId?: never;
      /** Precomputed 32-byte SHA-256 hash, with an optional `0x` prefix. */
      orderIdHash: string;
    }
);
