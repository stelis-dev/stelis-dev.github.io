/**
 * failurePolicy.ts — server-side failure code inventory.
 *
 * Owns the policy table and related code/type vocabulary used by
 * failures.ts runtime predicates, abuse-blocker adapters, and app-api
 * error mapping.
 */
import type {
  PromotionPrepareErrorCode,
  PromotionSponsorErrorCode,
  RelayConfigErrorCode,
  RelayPrepareErrorCode,
  RelaySponsorErrorCode,
  RelayStatusErrorCode,
  StudioClaimErrorCode,
  StudioDetailErrorCode,
  StudioListErrorCode,
} from '@stelis/contracts';

// ─────────────────────────────────────────────
// Public type exports
// ─────────────────────────────────────────────

/**
 * Studio promotion-specific abuse codes.
 *
 * Transport-non-public sentinel codes recorded against the abuse blocker via
 * `recordPromotionAbuseEvent`. These never appear in HTTP response bodies
 * (those carry route-bound transport codes from `@stelis/contracts` instead);
 * they identify the abuse-recording reason inside the blocker store.
 *
 * Classification + abuse-impact policy lives in `FAILURE_TABLE`
 * below, alongside the transport-code rows. The failure-policy design keeps
 * generic-sponsor and promotion event emitters separate; the shared
 * classification flows through this single table.
 */
export const PROMOTION_ABUSE_CODES = {
  /** Sender signature verification failed (cryptographic mismatch). */
  SENDER_SIGNATURE_INVALID: 'PROMO_SENDER_SIGNATURE_INVALID',
  /** User attempted a duplicate claim on the same promotion. */
  DUPLICATE_CLAIM: 'PROMO_DUPLICATE_CLAIM',
  /** Request targets not in the global STUDIO_ALLOWED_TARGETS policy. */
  DISALLOWED_TARGET: 'PROMO_DISALLOWED_TARGET',
  /** Non-MoveCall command in promotion TX. */
  FORBIDDEN_COMMAND: 'PROMO_FORBIDDEN_COMMAND',
  /** GasCoin reference in promotion TX (S-15). */
  GASCOIN_FORBIDDEN: 'PROMO_GASCOIN_FORBIDDEN',
  /** Claim deadline has passed. */
  DEADLINE_PASSED: 'PROMO_DEADLINE_PASSED',
  /** Promotion at maximum capacity. */
  CAPACITY_EXCEEDED: 'PROMO_CAPACITY_EXCEEDED',
  /** User without entitlement (not yet claimed). */
  NOT_CLAIMED: 'PROMO_NOT_CLAIMED',
  /** Promotion not in active status. */
  NOT_ACTIVE: 'PROMO_NOT_ACTIVE',
} as const;

export type PromotionAbuseCode = (typeof PROMOTION_ABUSE_CODES)[keyof typeof PROMOTION_ABUSE_CODES];

/**
 * Server-side failure code union covering contracts-owned Host error codes and
 * promotion-specific internal abuse codes. Public HTTP projection belongs to
 * `@stelis/contracts`; this module owns classification and abuse impact.
 */
type RelayAndStudioFailureCode =
  | RelayStatusErrorCode
  | RelayConfigErrorCode
  | RelayPrepareErrorCode
  | RelaySponsorErrorCode
  | StudioListErrorCode
  | StudioDetailErrorCode
  | StudioClaimErrorCode
  | PromotionPrepareErrorCode
  | PromotionSponsorErrorCode;

export type FailureCode = RelayAndStudioFailureCode | PromotionAbuseCode;

/**
 * Code-level classification (orthogonal to subcode-level carve-out).
 *
 * - `manipulation`: cryptographic/policy-violation evidence that the
 *   request was crafted to attack the Host (TAMPERING_DETECTED,
 *   GasCoin/sponsor-withdrawal references, unauthorized route, JWT
 *   forgery, …). The blocker adapter applies a long-duration block via
 *   `setBlock` and returns immediately. Long-block enforcement is owned
 *   by `classification === 'manipulation'` (and the
 *   `isManipulationAttemptCode` predicate), not by `abuseImpact`. The
 *   `abuseImpact` field on these rows is `SKIP_BOTH` because the
 *   windowed counter branch is not reached at runtime for manipulation
 *   codes.
 * - `ignored`: server-side coordination outcomes that must not feed
 *   abuse counters at all (slot exhausted, reprepare-required
 *   server-drift signal). Recording is short-circuited before any
 *   counter increments. `abuseImpact` is `SKIP_BOTH`.
 * - `drift`: server-state inconsistency observed at sponsor or prepare
 *   time. Treated like `ignored` for abuse counters (the subject did
 *   not cause the drift), but additionally emits
 *   `SPONSOR_DRIFT_OBSERVED` for operator visibility when the drift
 *   was stored-hash-verified (post-consume). `abuseImpact` is `SKIP_BOTH`.
 * - `infra`: 5xx-class infrastructure outcomes (Redis outages, pool
 *   manager unhealthy, sponsor lease commit failures, internal errors).
 *   Counters skip; the call site typically maps to HTTP 503/500.
 *   `abuseImpact` is `SKIP_BOTH`.
 * - `normal`: regular validation/preflight/on-chain-revert outcomes.
 *   IP counter increments unless `abuseImpact.ip === 'skip'` (e.g.
 *   server-side L3 buffer math, BAD_REQUEST). Non-IP counter increments
 *   only when `abuseImpact.subject === 'count'` AND
 *   `subjectCounterFamily(code)` resolves to a storage tier
 *   (`sim_tier` / `revert`). For `normal` codes without a storage
 *   family the row uses `IP_ONLY` (`{ ip: 'count', subject: 'skip' }`)
 *   so the table truthfully matches runtime behavior.
 */
export type FailureClassification = 'manipulation' | 'ignored' | 'drift' | 'infra' | 'normal';

/**
 * Windowed counter-impact policy consulted by
 * `recordSponsorFailureForAbuse` when the call falls into the
 * non-manipulation, non-ignored, non-drift, non-infra branch. The IP
 * counter is per-request-source; the subject counter is
 * per-typed-subject (Sui address for generic route, verified developer
 * JWT `userId` for promotion route).
 *
 * Reading rules:
 *   - `manipulation` rows: this field is unread at runtime — long-block
 *     is dispatched via `isManipulationAttemptCode`. The table records
 *     `SKIP_BOTH` for these rows because no windowed counter
 *     increments. Do not infer block behavior from this field for
 *     manipulation rows; consult `classification` instead.
 *   - `ignored` / `drift` / `infra` rows: this field is unread at
 *     runtime — early returns happen before the counter branch.
 *     Recorded as `SKIP_BOTH` for table-level consistency.
 *   - `normal` rows: this field controls
 *     whether `recordCounter` is called. `subject: 'count'` requires
 *     `subjectCounterFamily(code) !== null` so a storage tier exists;
 *     otherwise the `failures.test.ts` invariant lock fails. Subcode
 *     carve-out (`shouldCarveOutNonIpCounter`) can further skip the
 *     non-IP increment without affecting the IP counter.
 */
export interface AbuseImpact {
  readonly ip: 'count' | 'skip';
  readonly subject: 'count' | 'skip';
}

/**
 * Single row of the server-side failure inventory.
 */
export interface FailurePolicy {
  readonly classification: FailureClassification;
  readonly abuseImpact: AbuseImpact;
  /** Free-form note for operator triage / docs cross-reference. */
  readonly notes?: string;
}

// ─────────────────────────────────────────────
// Failure inventory table
// ─────────────────────────────────────────────

/**
 * `normal` rows whose subject counter has a storage family
 * (`subjectCounterFamily` returns `'sim_tier'` or `'revert'`). Currently
 * three entries: DRY_RUN_FAILED / PREFLIGHT_FAILED (sim_tier) and
 * ONCHAIN_REVERT (revert). Generic Relay API result codes
 * (`SPONSOR_PREFLIGHT_FAILED`, `SPONSOR_ONCHAIN_FAILED`) are transport
 * projections; the underlying event has already been recorded under the
 * shared sponsor recorder code.
 */
const COUNT_BOTH: AbuseImpact = { ip: 'count', subject: 'count' };
/**
 * `normal` rows that drive the IP windowed counter only. Used when no
 * `subjectCounterFamily` storage tier is mapped for the code, so
 * incrementing a subject counter would have no effect at runtime.
 */
const IP_ONLY: AbuseImpact = { ip: 'count', subject: 'skip' };
/**
 * `manipulation` / `ignored` / `drift` / `infra` rows, plus a small set
 * of `normal` rows that intentionally bypass abuse counters
 * (BAD_REQUEST, L3_* server-side math, PREPARE_STUDIO_USER_QUOTA_EXCEEDED,
 * and generic sponsor result codes that are transport projections of an
 * event already recorded under the shared recorder vocabulary).
 * For manipulation rows specifically, long-block is applied via the
 * classification predicate, not via this field.
 */
const SKIP_BOTH: AbuseImpact = { ip: 'skip', subject: 'skip' };
/**
 * Authoritative server-side policy table.
 *
 * Every entry is an error code that may appear in a public HTTP response
 * body produced by `/relay/*` or `/studio/promotions/*`. The table covers
 * each current contracts-owned route error code.
 *
 * HTTP status and public metadata policy are deliberately absent; the
 * contracts-owned Host error descriptor is the single transport authority.
 */
export const FAILURE_TABLE: Readonly<Record<FailureCode, FailurePolicy>> = {
  CONFIG_UNAVAILABLE: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
    notes: 'Relay config could not be produced by the Host.',
  },
  // ── Request-shape failures ────────────────────────────────────────
  BAD_REQUEST: {
    classification: 'normal',
    abuseImpact: SKIP_BOTH,
    notes: 'Request body, parse, or normal command-admission rejection.',
  },
  REQUEST_BODY_TOO_LARGE: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
  },
  CLIENT_IP_UNRESOLVED: {
    classification: 'normal',
    abuseImpact: SKIP_BOTH,
    notes: 'Client IP resolution failed before abuse-block and rate-limit keys were selected.',
  },

  // ── /relay/prepare authorization ─────────────────────────────────
  PREPARE_AUTH_TIMESTAMP_INVALID: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PREPARE_AUTH_NONCE_INVALID: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PREPARE_AUTH_TX_KIND_HASH_INVALID: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PREPARE_AUTH_TX_KIND_HASH_MISMATCH: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
  },
  PREPARE_AUTH_SIGNATURE_INVALID: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PREPARE_AUTH_EXPIRED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PREPARE_AUTH_NONCE_REUSED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PREPARE_SENDER_QUOTA_EXCEEDED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },

  // ── /relay/prepare P0 (txKindBytes decode) ────────────────────────
  P0_INVALID_BASE64: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  P0_TX_KIND_TOO_LARGE: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  P0_INVALID_TX_KIND: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },

  // ── BPS HTTP-body input ───────────────────────────────────────────
  INVALID_SLIPPAGE_BPS: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  INVALID_GAS_MARGIN_BPS: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },

  // ── /relay/prepare P1 (user-command pre-check) ────────────────────
  P1_TOO_MANY_COMMANDS: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  P1_GASCOIN_FORBIDDEN: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes: 'S-15 GasCoin theft attempt at prepare time.',
  },
  P1_USER_SETTLE_FORBIDDEN: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes: 'User TX embedded settle call.',
  },
  P1_UNAUTHORIZED_STELIS_CALL: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
  },
  P1_FORBIDDEN_COMMAND: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
  },
  P1_SPONSOR_WITHDRAWAL_FORBIDDEN: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes: 'S-15 companion: FundsWithdrawal(Sponsor) input rejected.',
  },

  // ── Pool / token / order-id config ────────────────────────────────
  UNSUPPORTED_SETTLEMENT_TOKEN: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  INVALID_ORDER_ID: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },

  // ── /relay/prepare build-time validation ─────────────────────────
  INSUFFICIENT_BALANCE: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  CLAIM_WOULD_EXCEED_MAX: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  INSUFFICIENT_SETTLE_INPUT: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  SPREAD_EXCEEDED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
    notes: 'Market condition; subcode-level carve-out applies at sponsor time.',
  },
  PAYMENT_COIN_CONFLICT: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PAYMENT_COIN_LIMIT_EXCEEDED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
    notes: 'Bounded settlement-token Coin discovery could not prove a safe funding source.',
  },
  DRY_RUN_FAILED: {
    classification: 'normal',
    abuseImpact: COUNT_BOTH,
    notes: 'Build-time dry-run rejection; subcode-level carve-out may apply.',
  },
  UNACCOUNTABLE_WITHDRAWAL: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes: 'User-prefix address-balance withdrawal cannot be accounted exactly.',
  },
  MARKET_QUOTE_UNAVAILABLE: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
    notes:
      'A completed DeepBook view did not provide a usable current quote; Sui operation failures remain internal errors.',
  },
  SLIPPAGE_EXCEEDED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
    notes: 'Build-time execution-gap exceeded; sponsor-time subcode carve-out applies.',
  },
  SLIPPAGE_CONVERGENCE_FAILED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },

  // ── /relay/prepare L1 / L2 self-check on built TX ────────────────
  L1_TOO_MANY_COMMANDS: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  L1_FORBIDDEN_COMMAND: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  L1_NO_SETTLE: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  L1_MULTIPLE_SETTLE: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  L1_PARSE_FAILED: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
    notes: 'Built-TX deserialize failure — server-side bug.',
  },
  L2_EXTRACT_FAILED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  L2_WRONG_CONFIG: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  L2_WRONG_REGISTRY: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  L2_WRONG_RECIPIENT: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  L2_EXCESSIVE_CLAIM: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  L2_HOST_FEE_CAP: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  L2_PROTOCOL_FEE_MISMATCH: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  L2_CONFIG_VERSION_MISMATCH: {
    classification: 'drift',
    abuseImpact: SKIP_BOTH,
    notes: 'Config drifted between fetch and self-check; not user-driven.',
  },
  L2_CREDIT_SLIPPAGE_NONZERO: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  L2_SETTLEMENT_SWAP_PATH_INTEGRITY: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
    notes: 'Operator misconfiguration — empty allowedSettlementSwapPaths.',
  },
  L2_UNAUTHORIZED_SETTLEMENT_SWAP_PATH: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes:
      'Settlement swap path not in allowedSettlementSwapPaths[] — pre-registered allowlist breach.',
  },
  L2_POLICY_HASH_MISMATCH: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
    notes: 'S-16 policy_hash mismatch (prepare or sponsor).',
  },
  L2_ORDER_ID_HASH_MISMATCH: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },

  // ── Sponsor operations gate / slot ────────────────────────────────
  SPONSOR_CAPACITY_UNAVAILABLE: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
  },
  SPONSOR_REFILL_ACCOUNT_UNHEALTHY: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
  },
  NO_SPONSOR_SLOT: {
    classification: 'ignored',
    abuseImpact: SKIP_BOTH,
    notes: 'Pool exhausted; transient, not user-driven.',
  },
  PREPARE_OVERLOADED: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
    notes: 'In-flight limiter capacity reached.',
  },
  SPONSOR_LEASE_COMMIT_FAILED: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
    notes: 'Two-stage HMAC lease commit failed while committing the prepared entry.',
  },

  // ── Cross-route abuse / availability ──────────────────────────────
  ABUSE_BLOCKED: {
    classification: 'ignored',
    abuseImpact: SKIP_BOTH,
    notes: 'Already-blocked subject; never recorded again.',
  },
  RATE_LIMITED: {
    classification: 'ignored',
    abuseImpact: SKIP_BOTH,
    notes: 'The active rate limit is already the protection; do not count the rejection again.',
  },
  BLOCK_CHECK_UNAVAILABLE: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
    notes: 'Abuse blocker adapter throw — fail-closed availability defect.',
  },
  STUDIO_UNAVAILABLE: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
    notes: 'The current Host has no usable Studio runtime for the requested route.',
  },
  VAULT_STATE_INCONSISTENT: {
    classification: 'drift',
    abuseImpact: SKIP_BOTH,
    notes:
      'Dual-use literal: prepare-time public transport error + sponsor-time vault drift subcode.',
  },
  INTERNAL_ERROR: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
    notes: 'Generic 500 fallback for prepare path.',
  },

  // ── /relay/sponsor consume / decode ──────────────────────────────
  PREPARED_TX_NOT_FOUND: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PREPARED_TX_EXPIRED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  SENDER_SIGNATURE_INVALID: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes:
      'Pre-consume — txSender not yet stored-hash-verified. IP-only abuse attribution; subject counter skipped.',
  },
  RECEIPT_SESSION_MISMATCH: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  MODE_MISMATCH: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  REPREPARE_REQUIRED: {
    classification: 'drift',
    abuseImpact: SKIP_BOTH,
    notes:
      'Stored-hash-verified server-side drift after consume — emits SPONSOR_DRIFT_OBSERVED, no abuse counter.',
  },
  TAMPERING_DETECTED: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes: 'Pre-consume hash mismatch — submitted bytes did not match stored hash.',
  },

  // ── /relay/sponsor L3 non-loss math ──────────────────────────────
  L3_NONLOSS_VIOLATION: {
    classification: 'normal',
    abuseImpact: SKIP_BOTH,
    notes:
      'Post-consume server-side buffer insufficiency vs preflight simGas; no abuse, no drift event.',
  },
  L3_GAS_BUDGET_EXCEEDED: {
    classification: 'normal',
    abuseImpact: SKIP_BOTH,
  },
  L3_SIM_GAS_OUT_OF_RANGE: {
    classification: 'normal',
    abuseImpact: SKIP_BOTH,
  },

  // ── /relay/sponsor preflight / submit ────────────────────────────
  SPONSOR_PREFLIGHT_FAILED: {
    classification: 'normal',
    abuseImpact: SKIP_BOTH,
    notes:
      'Generic Relay API transport projection. Abuse was already recorded under the shared PREFLIGHT_FAILED recorder code.',
  },
  SPONSOR_ONCHAIN_FAILED: {
    classification: 'normal',
    abuseImpact: SKIP_BOTH,
    notes:
      'Generic Relay API transport projection. Abuse was already recorded under the shared ONCHAIN_REVERT recorder code.',
  },
  SPONSOR_CONGESTION: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
    notes: 'Sui shared-object congestion; no gas burned per protocol.',
  },
  SPONSOR_SUBMISSION_UNCERTAIN: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
    notes:
      'Sponsor signature exists and submission may have reached Sui, but no current terminal result was proven; digest is required for reconciliation.',
  },
  LEASE_EXPIRED: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
    notes: 'Sponsor-pool HMAC lease TTL elapsed; client must retry /prepare.',
  },
  SPONSOR_FAILED: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
    notes: 'Sponsor-route fallback whose submission stage and transaction identity are unknown.',
  },

  // ── /studio promotion auth ───────────────────────────────────────
  AUTH_FAILED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
    notes: 'Missing or malformed Authorization credential; no verified subject is bound.',
  },
  AUTH_JWT_INVALID: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
  },
  AUTH_UNAVAILABLE: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
  },

  // ── /studio promotion-prepare specific ───────────────────────────
  BAD_TX_KIND: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
    notes: 'Promotion-route P0 wrap of generic P0_* errors.',
  },
  SENDER_ADDRESS_MISMATCH: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes: 'Verified-JWT senderAddress vs request senderAddress mismatch.',
  },
  PROMOTION_NOT_FOUND: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PROMOTION_NOT_ACTIVE: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  CLAIM_DEADLINE_PASSED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PROMOTION_CAPACITY_REACHED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  ALREADY_CLAIMED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PROMOTION_CURRENT_CONFLICT: {
    classification: 'ignored',
    abuseImpact: SKIP_BOTH,
    notes: 'Exact current Promotion or ledger state changed during one atomic operation.',
  },
  NOT_CLAIMED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  USE_WINDOW_EXPIRED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  FORBIDDEN_COMMAND: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes: 'Promotion-only PtbStructure rejection (non-MoveCall command).',
  },
  GASCOIN_FORBIDDEN: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes: 'Promotion S-15 GasCoin reference rejected.',
  },
  SPONSOR_WITHDRAWAL_FORBIDDEN: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
  },
  DISALLOWED_TARGET: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes: 'R-10 STUDIO_ALLOWED_TARGETS allowlist breach.',
  },
  GAS_EXCEEDS_TX_CAP: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  BUDGET_INSUFFICIENT: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  ENTITLEMENT_NOT_FOUND: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  ENTITLEMENT_NOT_ACTIVE: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  ENTITLEMENT_INSUFFICIENT: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  ENTITLEMENT_CONCURRENT_RESERVATION: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PREPARE_STUDIO_USER_QUOTA_EXCEEDED: {
    classification: 'normal',
    abuseImpact: SKIP_BOTH,
    notes: 'Outstanding-prepare quota; quota itself is the protection.',
  },

  // ── /studio promotion-sponsor specific ───────────────────────────
  USER_ID_MISMATCH: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes: 'Verified JWT userId vs prepared entry userId mismatch.',
  },
  PROMOTION_ID_MISMATCH: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
  },
  PREFLIGHT_FAILED: {
    classification: 'normal',
    abuseImpact: COUNT_BOTH,
    notes:
      'Shared sponsor recorder code for both routes; market subcodes skip the subject sim-tier only here.',
  },
  ONCHAIN_REVERT: {
    classification: 'normal',
    abuseImpact: COUNT_BOTH,
    notes:
      'Shared sponsor recorder code for both routes; market subcodes increment the subject revert family.',
  },
  CONSUME_FAILED: {
    classification: 'infra',
    abuseImpact: SKIP_BOTH,
    notes: 'Promotion-route prepare-store consume infra failure.',
  },

  // ── Promotion-specific abuse codes (not public HTTP codes) ───────
  // These never appear in HTTP response bodies; they are recorded
  // against the abuse blocker via `recordPromotionAbuseEvent`.
  // These codes have no HTTP representation.
  PROMO_SENDER_SIGNATURE_INVALID: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes: 'JWT-bound sender signature mismatch on promotion route.',
  },
  PROMO_DUPLICATE_CLAIM: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
  },
  PROMO_DISALLOWED_TARGET: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes: 'Promotion-side R-10 STUDIO_ALLOWED_TARGETS allowlist breach.',
  },
  PROMO_FORBIDDEN_COMMAND: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
  },
  PROMO_GASCOIN_FORBIDDEN: {
    classification: 'manipulation',
    abuseImpact: SKIP_BOTH,
    notes: 'Promotion-side S-15 GasCoin reference rejected.',
  },
  PROMO_DEADLINE_PASSED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PROMO_CAPACITY_EXCEEDED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PROMO_NOT_CLAIMED: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
  PROMO_NOT_ACTIVE: {
    classification: 'normal',
    abuseImpact: IP_ONLY,
  },
};
