/**
 * failurePolicy.ts — server-side failure code inventory.
 *
 * Owns the policy table and related code/type vocabulary used by
 * failures.ts runtime predicates, abuse-blocker adapters, and app-api
 * error mapping.
 */
import type {
  KnownPrepareErrorCode,
  KnownSponsorErrorCode,
  KnownPromotionPrepareErrorCode,
  KnownPromotionSponsorErrorCode,
} from '@stelis/core-relay';

// ─────────────────────────────────────────────
// Public type exports
// ─────────────────────────────────────────────

/**
 * Studio promotion-specific abuse codes.
 *
 * Transport-non-public sentinel codes recorded against the abuse blocker via
 * `recordPromotionAbuseEvent`. These never appear in HTTP response bodies
 * (those carry route-bound transport codes from `errorCode.ts` instead);
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

export const ADMISSION_FAILURE_CODES = {
  CLIENT_IP_UNRESOLVED: 'CLIENT_IP_UNRESOLVED',
} as const;

export type AdmissionFailureCode =
  (typeof ADMISSION_FAILURE_CODES)[keyof typeof ADMISSION_FAILURE_CODES];

/**
 * Server-side failure code union covering both the four route-bound transport
 * codes (locked to `docs/schemas/relay-api.schema.json` via
 * `errorCode.ts`), server-owned host admission codes
 * (`ADMISSION_FAILURE_CODES`), and the promotion-specific abuse codes
 * (`PROMOTION_ABUSE_CODES`). Classification, HTTP status (where applicable),
 * and abuse-impact policy live in `FAILURE_TABLE` for every group; the table
 * is consumed by abuse-blocker adapters and the host error mapper.
 */
export type FailureCode =
  | KnownPrepareErrorCode
  | KnownSponsorErrorCode
  | KnownPromotionPrepareErrorCode
  | KnownPromotionSponsorErrorCode
  | AdmissionFailureCode
  | PromotionAbuseCode;

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
 * Single row of the failure inventory. The public error-code list comes from
 * `errorCode.ts`; each entry pins its code-level classification, default
 * HTTP status, abuse-impact policy, and the optional dynamic body fields
 * the matching error class is allowed to carry.
 *
 * Body fields that may appear in the public response when set on the
 * thrown class (no policy is encoded here for whether they MUST appear —
 * the class either passes the field through or omits it):
 *   - `digest`: SponsorOnchainError.digest
 *   - `subcode`: SponsorPreflightError / SponsorOnchainError /
 *     PromotionSponsorError sub-classification
 *   - `meta`: PrepareValidationError diagnostic dictionary (spread
 *     verbatim into the response body)
 */
export interface FailurePolicy {
  readonly code: FailureCode;
  readonly classification: FailureClassification;
  readonly httpStatus: number;
  readonly abuseImpact: AbuseImpact;
  /** Dynamic body field names that the HTTP response may carry. */
  readonly bodyFields: readonly ('digest' | 'subcode' | 'meta')[];
  /** Free-form note for operator triage / docs cross-reference. */
  readonly notes?: string;
}

// ─────────────────────────────────────────────
// Failure inventory table
// ─────────────────────────────────────────────

/**
 * `normal` rows whose subject counter has a storage family
 * (`subjectCounterFamily` returns `'sim_tier'` or `'revert'`). Currently
 * five entries: DRY_RUN_FAILED / PREFLIGHT_FAILED /
 * SPONSOR_PREFLIGHT_FAILED (sim_tier) and ONCHAIN_REVERT /
 * SPONSOR_ONCHAIN_FAILED (revert).
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
 * (BAD_REQUEST, L3_* server-side math, PREPARE_STUDIO_USER_QUOTA_EXCEEDED).
 * For manipulation rows specifically, long-block is applied via the
 * classification predicate, not via this field.
 */
const SKIP_BOTH: AbuseImpact = { ip: 'skip', subject: 'skip' };
/** Empty body extension — most codes only carry `error` + `code`. */
const NO_BODY_EXTRAS: readonly ('digest' | 'subcode' | 'meta')[] = [];

/**
 * Authoritative server-side policy table.
 *
 * Every entry is an error code that may appear in a public HTTP response
 * body produced by `/relay/*` or `/studio/promotions/*`. The table covers
 * each route-mapped error class's `code` literal (locked by
 * `errorCode.ts` against the JSON schema).
 *
 * `httpStatus` is the default. Some error classes (PrepareValidationError,
 * SponsorValidationError) accept a runtime `statusHint` override to
 * promote a typically-422 code into 500 for server-bug paths
 * (SPONSOR_LEASE_COMMIT_FAILED, gasUsed-missing post-success). The
 * mapper preserves the override; the table records the default.
 */
export const FAILURE_TABLE: Readonly<Record<FailureCode, FailurePolicy>> = {
  // ── Body / parse failures (host-route boundary) ───────────────────
  BAD_REQUEST: {
    code: 'BAD_REQUEST',
    classification: 'normal',
    httpStatus: 400,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Body validation rejection from host route or RequestBodyParseError.',
  },
  REQUEST_BODY_TOO_LARGE: {
    code: 'REQUEST_BODY_TOO_LARGE',
    classification: 'infra',
    httpStatus: 413,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
  },
  CLIENT_IP_UNRESOLVED: {
    code: 'CLIENT_IP_UNRESOLVED',
    classification: 'normal',
    httpStatus: 400,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Client IP resolution failed before abuse-block and rate-limit keys were selected.',
  },

  // ── /relay/prepare authorization ─────────────────────────────────
  PREPARE_AUTH_TIMESTAMP_INVALID: {
    code: 'PREPARE_AUTH_TIMESTAMP_INVALID',
    classification: 'normal',
    httpStatus: 400,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  PREPARE_AUTH_NONCE_INVALID: {
    code: 'PREPARE_AUTH_NONCE_INVALID',
    classification: 'normal',
    httpStatus: 400,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  PREPARE_AUTH_TX_KIND_HASH_INVALID: {
    code: 'PREPARE_AUTH_TX_KIND_HASH_INVALID',
    classification: 'normal',
    httpStatus: 400,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  PREPARE_AUTH_TX_KIND_HASH_MISMATCH: {
    code: 'PREPARE_AUTH_TX_KIND_HASH_MISMATCH',
    classification: 'manipulation',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
  },
  PREPARE_AUTH_SIGNATURE_INVALID: {
    code: 'PREPARE_AUTH_SIGNATURE_INVALID',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  PREPARE_AUTH_EXPIRED: {
    code: 'PREPARE_AUTH_EXPIRED',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  PREPARE_AUTH_NONCE_REUSED: {
    code: 'PREPARE_AUTH_NONCE_REUSED',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  PREPARE_SENDER_QUOTA_EXCEEDED: {
    code: 'PREPARE_SENDER_QUOTA_EXCEEDED',
    classification: 'normal',
    httpStatus: 429,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },

  // ── /relay/prepare P0 (txKindBytes decode) ────────────────────────
  P0_INVALID_BASE64: {
    code: 'P0_INVALID_BASE64',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  P0_TX_KIND_TOO_LARGE: {
    code: 'P0_TX_KIND_TOO_LARGE',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  P0_INVALID_TX_KIND: {
    code: 'P0_INVALID_TX_KIND',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },

  // ── BPS HTTP-body input ───────────────────────────────────────────
  INVALID_SLIPPAGE_BPS: {
    code: 'INVALID_SLIPPAGE_BPS',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  INVALID_GAS_MARGIN_BPS: {
    code: 'INVALID_GAS_MARGIN_BPS',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },

  // ── /relay/prepare P1 (user-command pre-check) ────────────────────
  P1_TOO_MANY_COMMANDS: {
    code: 'P1_TOO_MANY_COMMANDS',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  P1_GASCOIN_FORBIDDEN: {
    code: 'P1_GASCOIN_FORBIDDEN',
    classification: 'manipulation',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'S-15 GasCoin theft attempt at prepare time.',
  },
  P1_USER_SETTLE_FORBIDDEN: {
    code: 'P1_USER_SETTLE_FORBIDDEN',
    classification: 'manipulation',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'User TX embedded settle call.',
  },
  P1_UNAUTHORIZED_STELIS_CALL: {
    code: 'P1_UNAUTHORIZED_STELIS_CALL',
    classification: 'manipulation',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
  },
  P1_FORBIDDEN_COMMAND: {
    code: 'P1_FORBIDDEN_COMMAND',
    classification: 'manipulation',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
  },
  P1_SPONSOR_WITHDRAWAL_FORBIDDEN: {
    code: 'P1_SPONSOR_WITHDRAWAL_FORBIDDEN',
    classification: 'manipulation',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'S-15 companion: FundsWithdrawal(Sponsor) input rejected.',
  },

  // ── Pool / token / order-id config ────────────────────────────────
  UNSUPPORTED_SETTLEMENT_TOKEN: {
    code: 'UNSUPPORTED_SETTLEMENT_TOKEN',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  INVALID_ORDER_ID: {
    code: 'INVALID_ORDER_ID',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },

  // ── /relay/prepare build-time validation ─────────────────────────
  INSUFFICIENT_BALANCE: {
    code: 'INSUFFICIENT_BALANCE',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: ['meta'],
  },
  CLAIM_WOULD_EXCEED_MAX: {
    code: 'CLAIM_WOULD_EXCEED_MAX',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: ['meta'],
  },
  INSUFFICIENT_SETTLE_INPUT: {
    code: 'INSUFFICIENT_SETTLE_INPUT',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: ['meta'],
  },
  SPREAD_EXCEEDED: {
    code: 'SPREAD_EXCEEDED',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: ['meta'],
    notes: 'Market condition; subcode-level carve-out applies at sponsor time.',
  },
  NO_COINS_FOUND: {
    code: 'NO_COINS_FOUND',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: ['meta'],
  },
  PAYMENT_COIN_CONFLICT: {
    code: 'PAYMENT_COIN_CONFLICT',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: ['meta'],
  },
  DRY_RUN_FAILED: {
    code: 'DRY_RUN_FAILED',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: COUNT_BOTH,
    bodyFields: ['meta'],
    notes: 'Build-time dry-run rejection; subcode-level carve-out may apply.',
  },
  DRY_RUN_NO_GAS: {
    code: 'DRY_RUN_NO_GAS',
    classification: 'infra',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Sui simulation returned no gasUsed — server-observed RPC anomaly.',
  },
  UNACCOUNTABLE_WITHDRAWAL: {
    code: 'UNACCOUNTABLE_WITHDRAWAL',
    classification: 'manipulation',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: ['meta'],
    notes: 'R-9 prefix-coin withdrawal mismatch.',
  },
  SLIPPAGE_QUERY_FAILED: {
    code: 'SLIPPAGE_QUERY_FAILED',
    classification: 'infra',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: ['meta'],
    notes: 'DeepBook query RPC failure at build time.',
  },
  SLIPPAGE_EXCEEDED: {
    code: 'SLIPPAGE_EXCEEDED',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: ['meta'],
    notes: 'Build-time execution-gap exceeded; sponsor-time subcode carve-out applies.',
  },
  SLIPPAGE_CONVERGENCE_FAILED: {
    code: 'SLIPPAGE_CONVERGENCE_FAILED',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: ['meta'],
  },

  // ── /relay/prepare L1 / L2 self-check on built TX ────────────────
  L1_TOO_MANY_COMMANDS: {
    code: 'L1_TOO_MANY_COMMANDS',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  L1_FORBIDDEN_COMMAND: {
    code: 'L1_FORBIDDEN_COMMAND',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  L1_NO_SETTLE: {
    code: 'L1_NO_SETTLE',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  L1_MULTIPLE_SETTLE: {
    code: 'L1_MULTIPLE_SETTLE',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  L1_PARSE_FAILED: {
    code: 'L1_PARSE_FAILED',
    classification: 'infra',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Built-TX deserialize failure — server-side bug.',
  },
  L2_EXTRACT_FAILED: {
    code: 'L2_EXTRACT_FAILED',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: ['meta'],
  },
  L2_WRONG_CONFIG: {
    code: 'L2_WRONG_CONFIG',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  L2_WRONG_REGISTRY: {
    code: 'L2_WRONG_REGISTRY',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  L2_WRONG_RECIPIENT: {
    code: 'L2_WRONG_RECIPIENT',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  L2_EXCESSIVE_CLAIM: {
    code: 'L2_EXCESSIVE_CLAIM',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  L2_HOST_FEE_CAP: {
    code: 'L2_HOST_FEE_CAP',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  L2_PROTOCOL_FEE_MISMATCH: {
    code: 'L2_PROTOCOL_FEE_MISMATCH',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  L2_CONFIG_VERSION_MISMATCH: {
    code: 'L2_CONFIG_VERSION_MISMATCH',
    classification: 'drift',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Config drifted between fetch and self-check; not user-driven.',
  },
  L2_CREDIT_SLIPPAGE_NONZERO: {
    code: 'L2_CREDIT_SLIPPAGE_NONZERO',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  L2_SETTLEMENT_SWAP_PATH_INTEGRITY: {
    code: 'L2_SETTLEMENT_SWAP_PATH_INTEGRITY',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED: {
    code: 'L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED',
    classification: 'infra',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Operator misconfiguration — empty allowedSettlementSwapPaths.',
  },
  L2_UNAUTHORIZED_SETTLEMENT_SWAP_PATH: {
    code: 'L2_UNAUTHORIZED_SETTLEMENT_SWAP_PATH',
    classification: 'manipulation',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes:
      'Settlement swap path not in allowedSettlementSwapPaths[] — pre-registered allowlist breach.',
  },
  L2_POLICY_HASH_MISMATCH: {
    code: 'L2_POLICY_HASH_MISMATCH',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'S-16 policy_hash mismatch (prepare or sponsor).',
  },
  L2_ORDER_ID_HASH_MISMATCH: {
    code: 'L2_ORDER_ID_HASH_MISMATCH',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },

  // ── Sponsor operations gate / slot ────────────────────────────────
  SPONSOR_CAPACITY_UNAVAILABLE: {
    code: 'SPONSOR_CAPACITY_UNAVAILABLE',
    classification: 'infra',
    httpStatus: 503,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
  },
  SPONSOR_REFILL_ACCOUNT_UNHEALTHY: {
    code: 'SPONSOR_REFILL_ACCOUNT_UNHEALTHY',
    classification: 'infra',
    httpStatus: 503,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
  },
  NO_SPONSOR_SLOT: {
    code: 'NO_SPONSOR_SLOT',
    classification: 'ignored',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Pool exhausted; transient, not user-driven.',
  },
  PREPARE_OVERLOADED: {
    code: 'PREPARE_OVERLOADED',
    classification: 'infra',
    httpStatus: 503,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'In-flight limiter capacity reached.',
  },
  SPONSOR_LEASE_COMMIT_FAILED: {
    code: 'SPONSOR_LEASE_COMMIT_FAILED',
    classification: 'infra',
    httpStatus: 500,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Two-stage HMAC lease commit failed at PrepareValidationError statusHint=500.',
  },

  // ── Cross-route abuse / availability ──────────────────────────────
  ABUSE_BLOCKED: {
    code: 'ABUSE_BLOCKED',
    classification: 'ignored',
    httpStatus: 429,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Already-blocked subject; never recorded again.',
  },
  BLOCK_CHECK_UNAVAILABLE: {
    code: 'BLOCK_CHECK_UNAVAILABLE',
    classification: 'infra',
    httpStatus: 503,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Abuse blocker adapter throw — fail-closed availability defect.',
  },
  VAULT_STATE_INCONSISTENT: {
    code: 'VAULT_STATE_INCONSISTENT',
    classification: 'drift',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: ['meta'],
    notes:
      'Dual-use literal: prepare-time public transport error + sponsor-time vault drift subcode.',
  },
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    classification: 'infra',
    httpStatus: 500,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Generic 500 fallback for prepare path.',
  },

  // ── /relay/sponsor consume / decode ──────────────────────────────
  PREPARED_TX_NOT_FOUND: {
    code: 'PREPARED_TX_NOT_FOUND',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  PREPARED_TX_EXPIRED: {
    code: 'PREPARED_TX_EXPIRED',
    classification: 'normal',
    httpStatus: 410,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  SENDER_SIGNATURE_INVALID: {
    code: 'SENDER_SIGNATURE_INVALID',
    classification: 'manipulation',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes:
      'Pre-consume — txSender not yet stored-hash-verified. IP-only abuse attribution; subject counter skipped.',
  },
  RECEIPT_SESSION_MISMATCH: {
    code: 'RECEIPT_SESSION_MISMATCH',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  MODE_MISMATCH: {
    code: 'MODE_MISMATCH',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  REPREPARE_REQUIRED: {
    code: 'REPREPARE_REQUIRED',
    classification: 'drift',
    httpStatus: 409,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes:
      'Stored-hash-verified server-side drift after consume — emits SPONSOR_DRIFT_OBSERVED, no abuse counter.',
  },
  TAMPERING_DETECTED: {
    code: 'TAMPERING_DETECTED',
    classification: 'manipulation',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Pre-consume hash mismatch — submitted bytes did not match stored hash.',
  },

  // ── /relay/sponsor L3 non-loss math ──────────────────────────────
  L3_NONLOSS_VIOLATION: {
    code: 'L3_NONLOSS_VIOLATION',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes:
      'Post-consume server-side buffer insufficiency vs preflight simGas; no abuse, no drift event.',
  },
  L3_GAS_BUDGET_EXCEEDED: {
    code: 'L3_GAS_BUDGET_EXCEEDED',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
  },
  L3_SIM_GAS_OUT_OF_RANGE: {
    code: 'L3_SIM_GAS_OUT_OF_RANGE',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
  },

  // ── /relay/sponsor preflight / submit ────────────────────────────
  SPONSOR_PREFLIGHT_FAILED: {
    code: 'SPONSOR_PREFLIGHT_FAILED',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: COUNT_BOTH,
    bodyFields: ['subcode'],
    notes:
      'Sim-tier counter; subcode-level carve-out via ADDRESS_CARVE_OUT_SUBCODES + MARKET_VOLATILITY_CARVE_OUT_SUBCODES skips non-IP.',
  },
  SPONSOR_ONCHAIN_FAILED: {
    code: 'SPONSOR_ONCHAIN_FAILED',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: COUNT_BOTH,
    bodyFields: ['digest', 'subcode'],
    notes:
      'On-chain revert counter; subcode-level carve-out also applies (ADDRESS_CARVE_OUT_SUBCODES + MARKET_VOLATILITY_CARVE_OUT_SUBCODES).',
  },
  SPONSOR_CONGESTION: {
    code: 'SPONSOR_CONGESTION',
    classification: 'infra',
    httpStatus: 503,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Sui shared-object congestion; no gas burned per protocol.',
  },
  LEASE_EXPIRED: {
    code: 'LEASE_EXPIRED',
    classification: 'infra',
    httpStatus: 503,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Sponsor-pool HMAC lease TTL elapsed; client must retry /prepare.',
  },
  SPONSOR_FAILED: {
    code: 'SPONSOR_FAILED',
    classification: 'infra',
    httpStatus: 500,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Sponsor-route 500 fallback (e.g. gasUsed missing post-success).',
  },

  // ── /studio promotion auth ───────────────────────────────────────
  AUTH_FAILED: {
    code: 'AUTH_FAILED',
    classification: 'manipulation',
    httpStatus: 401,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'JWT verification failure; subject not yet bound, IP-only counter.',
  },
  AUTH_JWT_INVALID: {
    code: 'AUTH_JWT_INVALID',
    classification: 'manipulation',
    httpStatus: 401,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
  },

  // ── /studio promotion-prepare specific ───────────────────────────
  BAD_TX_KIND: {
    code: 'BAD_TX_KIND',
    classification: 'normal',
    httpStatus: 400,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Promotion-route P0 wrap of generic P0_* errors.',
  },
  SENDER_ADDRESS_MISMATCH: {
    code: 'SENDER_ADDRESS_MISMATCH',
    classification: 'manipulation',
    httpStatus: 403,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Verified-JWT senderAddress vs request senderAddress mismatch.',
  },
  PROMOTION_NOT_FOUND: {
    code: 'PROMOTION_NOT_FOUND',
    classification: 'normal',
    httpStatus: 404,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  PROMOTION_NOT_ACTIVE: {
    code: 'PROMOTION_NOT_ACTIVE',
    classification: 'normal',
    httpStatus: 409,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  NOT_CLAIMED: {
    code: 'NOT_CLAIMED',
    classification: 'normal',
    httpStatus: 403,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  USE_WINDOW_EXPIRED: {
    code: 'USE_WINDOW_EXPIRED',
    classification: 'normal',
    httpStatus: 403,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  FORBIDDEN_COMMAND: {
    code: 'FORBIDDEN_COMMAND',
    classification: 'manipulation',
    httpStatus: 403,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Promotion-only PtbStructure rejection (non-MoveCall command).',
  },
  GASCOIN_FORBIDDEN: {
    code: 'GASCOIN_FORBIDDEN',
    classification: 'manipulation',
    httpStatus: 403,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Promotion S-15 GasCoin reference rejected.',
  },
  SPONSOR_WITHDRAWAL_FORBIDDEN: {
    code: 'SPONSOR_WITHDRAWAL_FORBIDDEN',
    classification: 'manipulation',
    httpStatus: 403,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
  },
  DISALLOWED_TARGET: {
    code: 'DISALLOWED_TARGET',
    classification: 'manipulation',
    httpStatus: 403,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'R-10 STUDIO_ALLOWED_TARGETS allowlist breach.',
  },
  GAS_EXCEEDS_TX_CAP: {
    code: 'GAS_EXCEEDS_TX_CAP',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  BUDGET_INSUFFICIENT: {
    code: 'BUDGET_INSUFFICIENT',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  ENTITLEMENT_NOT_FOUND: {
    code: 'ENTITLEMENT_NOT_FOUND',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  ENTITLEMENT_NOT_ACTIVE: {
    code: 'ENTITLEMENT_NOT_ACTIVE',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  ENTITLEMENT_INSUFFICIENT: {
    code: 'ENTITLEMENT_INSUFFICIENT',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  ENTITLEMENT_CONCURRENT_RESERVATION: {
    code: 'ENTITLEMENT_CONCURRENT_RESERVATION',
    classification: 'normal',
    httpStatus: 409,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  PREPARE_STUDIO_USER_QUOTA_EXCEEDED: {
    code: 'PREPARE_STUDIO_USER_QUOTA_EXCEEDED',
    classification: 'normal',
    httpStatus: 429,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Outstanding-prepare quota; quota itself is the protection.',
  },

  // ── /studio promotion-sponsor specific ───────────────────────────
  USER_ID_MISMATCH: {
    code: 'USER_ID_MISMATCH',
    classification: 'manipulation',
    httpStatus: 403,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Verified JWT userId vs prepared entry userId mismatch.',
  },
  PROMOTION_ID_MISMATCH: {
    code: 'PROMOTION_ID_MISMATCH',
    classification: 'manipulation',
    httpStatus: 403,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
  },
  PREFLIGHT_FAILED: {
    code: 'PREFLIGHT_FAILED',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: COUNT_BOTH,
    bodyFields: ['subcode'],
    notes: 'Promotion-route preflight code (mirror of generic SPONSOR_PREFLIGHT_FAILED).',
  },
  ONCHAIN_REVERT: {
    code: 'ONCHAIN_REVERT',
    classification: 'normal',
    httpStatus: 422,
    abuseImpact: COUNT_BOTH,
    bodyFields: ['subcode'],
    notes: 'Promotion-route revert code (mirror of generic SPONSOR_ONCHAIN_FAILED).',
  },
  GAS_EFFECTS_MISSING: {
    code: 'GAS_EFFECTS_MISSING',
    classification: 'infra',
    httpStatus: 500,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Promotion-route post-success gasUsed missing.',
  },
  CONSUME_FAILED: {
    code: 'CONSUME_FAILED',
    classification: 'infra',
    httpStatus: 500,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Promotion-route prepare-store consume infra failure.',
  },

  // ── Promotion-specific abuse codes (not public HTTP codes) ───────
  // These never appear in HTTP response bodies; they are recorded
  // against the abuse blocker via `recordPromotionAbuseEvent`.
  // `httpStatus` is held at 0 because the codes have no HTTP
  // projection (the response body carries a route-bound HTTP code from
  // `errorCode.ts` instead).
  PROMO_SENDER_SIGNATURE_INVALID: {
    code: 'PROMO_SENDER_SIGNATURE_INVALID',
    classification: 'manipulation',
    httpStatus: 0,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'JWT-bound sender signature mismatch on promotion route.',
  },
  PROMO_DUPLICATE_CLAIM: {
    code: 'PROMO_DUPLICATE_CLAIM',
    classification: 'manipulation',
    httpStatus: 0,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
  },
  PROMO_DISALLOWED_TARGET: {
    code: 'PROMO_DISALLOWED_TARGET',
    classification: 'manipulation',
    httpStatus: 0,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Promotion-side R-10 STUDIO_ALLOWED_TARGETS allowlist breach.',
  },
  PROMO_FORBIDDEN_COMMAND: {
    code: 'PROMO_FORBIDDEN_COMMAND',
    classification: 'manipulation',
    httpStatus: 0,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
  },
  PROMO_GASCOIN_FORBIDDEN: {
    code: 'PROMO_GASCOIN_FORBIDDEN',
    classification: 'manipulation',
    httpStatus: 0,
    abuseImpact: SKIP_BOTH,
    bodyFields: NO_BODY_EXTRAS,
    notes: 'Promotion-side S-15 GasCoin reference rejected.',
  },
  PROMO_DEADLINE_PASSED: {
    code: 'PROMO_DEADLINE_PASSED',
    classification: 'normal',
    httpStatus: 0,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  PROMO_CAPACITY_EXCEEDED: {
    code: 'PROMO_CAPACITY_EXCEEDED',
    classification: 'normal',
    httpStatus: 0,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  PROMO_NOT_CLAIMED: {
    code: 'PROMO_NOT_CLAIMED',
    classification: 'normal',
    httpStatus: 0,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
  PROMO_NOT_ACTIVE: {
    code: 'PROMO_NOT_ACTIVE',
    classification: 'normal',
    httpStatus: 0,
    abuseImpact: IP_ONLY,
    bodyFields: NO_BODY_EXTRAS,
  },
};
