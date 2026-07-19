/** Current machine-readable error vocabulary exposed by a Stelis Host. */

const HOST_REQUEST_ADMISSION_ERROR_CODES = [
  'CLIENT_IP_UNRESOLVED',
  'ABUSE_BLOCKED',
  'BLOCK_CHECK_UNAVAILABLE',
] as const;

export const ADMIN_REQUEST_ADMISSION_ERROR_CODES = [
  ...HOST_REQUEST_ADMISSION_ERROR_CODES,
  'BAD_REQUEST',
  'REQUEST_BODY_TOO_LARGE',
  'ADMIN_UNAUTHORIZED',
  'INTERNAL_ERROR',
] as const;

const ADMIN_ROUTE_BASE_ERROR_CODES = [
  ...HOST_REQUEST_ADMISSION_ERROR_CODES,
  'ADMIN_UNAVAILABLE',
  'ADMIN_UNAUTHORIZED',
  'INTERNAL_ERROR',
] as const;

const ADMIN_PROMOTION_ROUTE_BASE_ERROR_CODES = [
  ...ADMIN_ROUTE_BASE_ERROR_CODES,
  'STUDIO_UNAVAILABLE',
] as const;

export const RELAY_STATUS_ERROR_CODES = [
  ...HOST_REQUEST_ADMISSION_ERROR_CODES,
  'INTERNAL_ERROR',
] as const;

export const RELAY_CONFIG_ERROR_CODES = [
  ...HOST_REQUEST_ADMISSION_ERROR_CODES,
  'CONFIG_UNAVAILABLE',
] as const;

const STUDIO_AUTH_ERROR_CODES = [
  ...HOST_REQUEST_ADMISSION_ERROR_CODES,
  'AUTH_FAILED',
  'AUTH_JWT_INVALID',
  'AUTH_UNAVAILABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export const STUDIO_LIST_ERROR_CODES = [
  ...STUDIO_AUTH_ERROR_CODES,
  'STUDIO_UNAVAILABLE',
  'BAD_REQUEST',
] as const;

export const STUDIO_DETAIL_ERROR_CODES = [
  ...STUDIO_AUTH_ERROR_CODES,
  'STUDIO_UNAVAILABLE',
  'BAD_REQUEST',
  'PROMOTION_NOT_FOUND',
] as const;

export const STUDIO_CLAIM_ERROR_CODES = [
  ...STUDIO_AUTH_ERROR_CODES,
  'STUDIO_UNAVAILABLE',
  'BAD_REQUEST',
  'REQUEST_BODY_TOO_LARGE',
  'PROMOTION_NOT_FOUND',
  'PROMOTION_NOT_ACTIVE',
  'CLAIM_DEADLINE_PASSED',
  'PROMOTION_CAPACITY_REACHED',
  'ALREADY_CLAIMED',
  'PROMOTION_CURRENT_CONFLICT',
] as const;

export const RELAY_PREPARE_ERROR_CODES = [
  ...HOST_REQUEST_ADMISSION_ERROR_CODES,
  'BAD_REQUEST',
  'REQUEST_BODY_TOO_LARGE',
  'PREPARE_AUTH_TIMESTAMP_INVALID',
  'PREPARE_AUTH_NONCE_INVALID',
  'PREPARE_AUTH_TX_KIND_HASH_INVALID',
  'PREPARE_AUTH_TX_KIND_HASH_MISMATCH',
  'PREPARE_AUTH_SIGNATURE_INVALID',
  'PREPARE_AUTH_EXPIRED',
  'PREPARE_AUTH_NONCE_REUSED',
  'PREPARE_SENDER_QUOTA_EXCEEDED',
  'P0_INVALID_BASE64',
  'P0_TX_KIND_TOO_LARGE',
  'P0_INVALID_TX_KIND',
  'INVALID_SLIPPAGE_BPS',
  'INVALID_GAS_MARGIN_BPS',
  'P1_TOO_MANY_COMMANDS',
  'P1_GASCOIN_FORBIDDEN',
  'P1_USER_SETTLE_FORBIDDEN',
  'P1_UNAUTHORIZED_STELIS_CALL',
  'P1_FORBIDDEN_COMMAND',
  'P1_SPONSOR_WITHDRAWAL_FORBIDDEN',
  'UNSUPPORTED_SETTLEMENT_TOKEN',
  'INVALID_ORDER_ID',
  'INSUFFICIENT_BALANCE',
  'CLAIM_WOULD_EXCEED_MAX',
  'INSUFFICIENT_SETTLE_INPUT',
  'SPREAD_EXCEEDED',
  'PAYMENT_COIN_CONFLICT',
  'PAYMENT_COIN_LIMIT_EXCEEDED',
  'DRY_RUN_FAILED',
  'UNACCOUNTABLE_WITHDRAWAL',
  'MARKET_QUOTE_UNAVAILABLE',
  'SLIPPAGE_EXCEEDED',
  'SLIPPAGE_CONVERGENCE_FAILED',
  'L1_TOO_MANY_COMMANDS',
  'L1_FORBIDDEN_COMMAND',
  'L1_NO_SETTLE',
  'L1_MULTIPLE_SETTLE',
  'L1_PARSE_FAILED',
  'L2_EXTRACT_FAILED',
  'L2_WRONG_CONFIG',
  'L2_WRONG_REGISTRY',
  'L2_WRONG_RECIPIENT',
  'L2_EXCESSIVE_CLAIM',
  'L2_HOST_FEE_CAP',
  'L2_PROTOCOL_FEE_MISMATCH',
  'L2_CONFIG_VERSION_MISMATCH',
  'L2_CREDIT_SLIPPAGE_NONZERO',
  'L2_SETTLEMENT_SWAP_PATH_INTEGRITY',
  'L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED',
  'L2_UNAUTHORIZED_SETTLEMENT_SWAP_PATH',
  'L2_POLICY_HASH_MISMATCH',
  'L2_ORDER_ID_HASH_MISMATCH',
  'SPONSOR_CAPACITY_UNAVAILABLE',
  'SPONSOR_REFILL_ACCOUNT_UNHEALTHY',
  'NO_SPONSOR_SLOT',
  'PREPARE_OVERLOADED',
  'SPONSOR_LEASE_COMMIT_FAILED',
  'RATE_LIMITED',
  'VAULT_STATE_INCONSISTENT',
  'INTERNAL_ERROR',
] as const;

export const RELAY_SPONSOR_ERROR_CODES = [
  ...HOST_REQUEST_ADMISSION_ERROR_CODES,
  'BAD_REQUEST',
  'REQUEST_BODY_TOO_LARGE',
  'PREPARED_TX_NOT_FOUND',
  'PREPARED_TX_EXPIRED',
  'SENDER_SIGNATURE_INVALID',
  'RECEIPT_SESSION_MISMATCH',
  'MODE_MISMATCH',
  'REPREPARE_REQUIRED',
  'TAMPERING_DETECTED',
  'L3_NONLOSS_VIOLATION',
  'L3_GAS_BUDGET_EXCEEDED',
  'L3_SIM_GAS_OUT_OF_RANGE',
  'SPONSOR_CAPACITY_UNAVAILABLE',
  'SPONSOR_PREFLIGHT_FAILED',
  'SPONSOR_ONCHAIN_FAILED',
  'SPONSOR_CONGESTION',
  'SPONSOR_SUBMISSION_UNCERTAIN',
  'LEASE_EXPIRED',
  'SPONSOR_FAILED',
  'RATE_LIMITED',
] as const;

export const PROMOTION_PREPARE_ERROR_CODES = [
  ...STUDIO_AUTH_ERROR_CODES,
  'BAD_REQUEST',
  'REQUEST_BODY_TOO_LARGE',
  'STUDIO_UNAVAILABLE',
  'BAD_TX_KIND',
  'SENDER_ADDRESS_MISMATCH',
  'PROMOTION_NOT_FOUND',
  'PROMOTION_NOT_ACTIVE',
  'NOT_CLAIMED',
  'USE_WINDOW_EXPIRED',
  'FORBIDDEN_COMMAND',
  'GASCOIN_FORBIDDEN',
  'SPONSOR_WITHDRAWAL_FORBIDDEN',
  'DISALLOWED_TARGET',
  'PREPARE_OVERLOADED',
  'SPONSOR_CAPACITY_UNAVAILABLE',
  'SPONSOR_REFILL_ACCOUNT_UNHEALTHY',
  'NO_SPONSOR_SLOT',
  'GAS_EXCEEDS_TX_CAP',
  'DRY_RUN_FAILED',
  'BUDGET_INSUFFICIENT',
  'ENTITLEMENT_NOT_FOUND',
  'ENTITLEMENT_NOT_ACTIVE',
  'ENTITLEMENT_INSUFFICIENT',
  'ENTITLEMENT_CONCURRENT_RESERVATION',
  'PROMOTION_CURRENT_CONFLICT',
  'PREPARE_STUDIO_USER_QUOTA_EXCEEDED',
  'SPONSOR_LEASE_COMMIT_FAILED',
] as const;

export const PROMOTION_SPONSOR_ERROR_CODES = [
  ...STUDIO_AUTH_ERROR_CODES,
  'BAD_REQUEST',
  'REQUEST_BODY_TOO_LARGE',
  'STUDIO_UNAVAILABLE',
  'SPONSOR_CAPACITY_UNAVAILABLE',
  'SPONSOR_CONGESTION',
  'LEASE_EXPIRED',
  'PREPARED_TX_NOT_FOUND',
  'PREPARED_TX_EXPIRED',
  'SENDER_ADDRESS_MISMATCH',
  'USER_ID_MISMATCH',
  'PROMOTION_NOT_ACTIVE',
  'NOT_CLAIMED',
  'USE_WINDOW_EXPIRED',
  'FORBIDDEN_COMMAND',
  'GASCOIN_FORBIDDEN',
  'DISALLOWED_TARGET',
  'MODE_MISMATCH',
  'PROMOTION_ID_MISMATCH',
  'SENDER_SIGNATURE_INVALID',
  'REPREPARE_REQUIRED',
  'TAMPERING_DETECTED',
  'PREFLIGHT_FAILED',
  'ONCHAIN_REVERT',
  'SPONSOR_SUBMISSION_UNCERTAIN',
  'SPONSOR_FAILED',
] as const;

/** Current errors for `POST /admin/auth/nonce`. */
export const ADMIN_AUTH_NONCE_ERROR_CODES = [
  ...ADMIN_ROUTE_BASE_ERROR_CODES,
  'RATE_LIMITED',
] as const;

/** Current errors shared by `POST /admin/auth/verify` and `POST /admin/auth/renew`. */
export const ADMIN_AUTH_VERIFY_ERROR_CODES = [
  ...ADMIN_ROUTE_BASE_ERROR_CODES,
  'BAD_REQUEST',
  'REQUEST_BODY_TOO_LARGE',
  'RATE_LIMITED',
] as const;

/** Current errors for `POST /admin/auth/logout`. */
export const ADMIN_AUTH_LOGOUT_ERROR_CODES = [...ADMIN_ROUTE_BASE_ERROR_CODES] as const;

/** Current errors for `GET /admin/auth/session`. */
export const ADMIN_SESSION_ERROR_CODES = [...ADMIN_ROUTE_BASE_ERROR_CODES] as const;

/** Current errors for Admin reads without route parameters. */
export const ADMIN_READ_ERROR_CODES = [...ADMIN_ROUTE_BASE_ERROR_CODES] as const;

/** Current errors for `GET /admin/blocklist`. */
export const ADMIN_BLOCKLIST_READ_ERROR_CODES = [
  ...ADMIN_ROUTE_BASE_ERROR_CODES,
  'BAD_REQUEST',
] as const;

/** Current errors for `DELETE /admin/blocklist`. */
export const ADMIN_BLOCKLIST_DELETE_ERROR_CODES = [
  ...ADMIN_ROUTE_BASE_ERROR_CODES,
  'BAD_REQUEST',
  'REQUEST_BODY_TOO_LARGE',
  'ADMIN_CONFLICT',
] as const;

/** Current errors for sponsored-log reads. */
export const ADMIN_SPONSORED_LOGS_ERROR_CODES = [
  ...ADMIN_ROUTE_BASE_ERROR_CODES,
  'BAD_REQUEST',
] as const;

/** Current errors for `GET /admin/promotions`. */
export const ADMIN_PROMOTION_LIST_ERROR_CODES = [
  ...ADMIN_PROMOTION_ROUTE_BASE_ERROR_CODES,
  'BAD_REQUEST',
] as const;

/** Current errors for Admin promotion reads with an ID route parameter. */
export const ADMIN_PROMOTION_READ_ERROR_CODES = [
  ...ADMIN_PROMOTION_ROUTE_BASE_ERROR_CODES,
  'BAD_REQUEST',
  'ADMIN_NOT_FOUND',
] as const;

/** Current errors for `POST /admin/promotions`. */
export const ADMIN_PROMOTION_CREATE_ERROR_CODES = [
  ...ADMIN_PROMOTION_ROUTE_BASE_ERROR_CODES,
  'BAD_REQUEST',
  'REQUEST_BODY_TOO_LARGE',
  'ADMIN_UNPROCESSABLE',
  'PROMOTION_CURRENT_CONFLICT',
] as const;

/** Current errors for `PUT /admin/promotions/:id`. */
export const ADMIN_PROMOTION_UPDATE_ERROR_CODES = [
  ...ADMIN_PROMOTION_ROUTE_BASE_ERROR_CODES,
  'BAD_REQUEST',
  'REQUEST_BODY_TOO_LARGE',
  'ADMIN_NOT_FOUND',
  'ADMIN_CONFLICT',
  'ADMIN_UNPROCESSABLE',
  'PROMOTION_CURRENT_CONFLICT',
] as const;

/** Current errors for `POST /admin/promotions/:id/status`. */
export const ADMIN_PROMOTION_STATUS_ERROR_CODES = [
  ...ADMIN_PROMOTION_ROUTE_BASE_ERROR_CODES,
  'BAD_REQUEST',
  'REQUEST_BODY_TOO_LARGE',
  'ADMIN_NOT_FOUND',
  'ADMIN_CONFLICT',
  'ADMIN_UNPROCESSABLE',
  'PROMOTION_CURRENT_CONFLICT',
] as const;

/** Current errors for `DELETE /admin/promotions/:id`. */
export const ADMIN_PROMOTION_DELETE_ERROR_CODES = [
  ...ADMIN_PROMOTION_ROUTE_BASE_ERROR_CODES,
  'BAD_REQUEST',
  'ADMIN_NOT_FOUND',
  'ADMIN_CONFLICT',
  'PROMOTION_CURRENT_CONFLICT',
] as const;

/** Current errors for the Sponsor Refill Account withdrawal challenge. */
export const ADMIN_WITHDRAWAL_CHALLENGE_ERROR_CODES = [...ADMIN_ROUTE_BASE_ERROR_CODES] as const;

/** Current errors for Sponsor Refill Account withdrawal execution. */
export const ADMIN_WITHDRAWAL_ERROR_CODES = [
  ...ADMIN_ROUTE_BASE_ERROR_CODES,
  'BAD_REQUEST',
  'REQUEST_BODY_TOO_LARGE',
  'RATE_LIMITED',
  'WITHDRAWAL_SIGNATURE_INVALID',
  'WITHDRAWAL_NONCE_MISSING',
  'WITHDRAWAL_RUNWAY_BLOCKED',
  'WITHDRAWAL_NOT_ACCEPTED',
  'WITHDRAWAL_PENDING',
  'WITHDRAWAL_FAILED',
] as const;

export type RelayStatusErrorCode = (typeof RELAY_STATUS_ERROR_CODES)[number];
export type RelayConfigErrorCode = (typeof RELAY_CONFIG_ERROR_CODES)[number];
export type StudioListErrorCode = (typeof STUDIO_LIST_ERROR_CODES)[number];
export type StudioDetailErrorCode = (typeof STUDIO_DETAIL_ERROR_CODES)[number];
export type StudioClaimErrorCode = (typeof STUDIO_CLAIM_ERROR_CODES)[number];
export type RelayPrepareErrorCode = (typeof RELAY_PREPARE_ERROR_CODES)[number];
export type RelaySponsorErrorCode = (typeof RELAY_SPONSOR_ERROR_CODES)[number];
export type PromotionPrepareErrorCode = (typeof PROMOTION_PREPARE_ERROR_CODES)[number];
export type PromotionSponsorErrorCode = (typeof PROMOTION_SPONSOR_ERROR_CODES)[number];
type AdminAuthNonceErrorCode = (typeof ADMIN_AUTH_NONCE_ERROR_CODES)[number];
type AdminAuthVerifyErrorCode = (typeof ADMIN_AUTH_VERIFY_ERROR_CODES)[number];
type AdminAuthLogoutErrorCode = (typeof ADMIN_AUTH_LOGOUT_ERROR_CODES)[number];
type AdminSessionErrorCode = (typeof ADMIN_SESSION_ERROR_CODES)[number];
type AdminReadErrorCode = (typeof ADMIN_READ_ERROR_CODES)[number];
type AdminBlocklistReadErrorCode = (typeof ADMIN_BLOCKLIST_READ_ERROR_CODES)[number];
type AdminBlocklistDeleteErrorCode = (typeof ADMIN_BLOCKLIST_DELETE_ERROR_CODES)[number];
type AdminSponsoredLogsErrorCode = (typeof ADMIN_SPONSORED_LOGS_ERROR_CODES)[number];
type AdminPromotionListErrorCode = (typeof ADMIN_PROMOTION_LIST_ERROR_CODES)[number];
type AdminPromotionReadErrorCode = (typeof ADMIN_PROMOTION_READ_ERROR_CODES)[number];
type AdminPromotionCreateErrorCode = (typeof ADMIN_PROMOTION_CREATE_ERROR_CODES)[number];
type AdminPromotionUpdateErrorCode = (typeof ADMIN_PROMOTION_UPDATE_ERROR_CODES)[number];
type AdminPromotionStatusErrorCode = (typeof ADMIN_PROMOTION_STATUS_ERROR_CODES)[number];
type AdminPromotionDeleteErrorCode = (typeof ADMIN_PROMOTION_DELETE_ERROR_CODES)[number];
type AdminWithdrawalChallengeErrorCode = (typeof ADMIN_WITHDRAWAL_CHALLENGE_ERROR_CODES)[number];
type AdminWithdrawalErrorCode = (typeof ADMIN_WITHDRAWAL_ERROR_CODES)[number];
export type HostErrorCode =
  | RelayStatusErrorCode
  | RelayConfigErrorCode
  | StudioListErrorCode
  | StudioDetailErrorCode
  | StudioClaimErrorCode
  | RelayPrepareErrorCode
  | RelaySponsorErrorCode
  | PromotionPrepareErrorCode
  | PromotionSponsorErrorCode
  | AdminAuthNonceErrorCode
  | AdminAuthVerifyErrorCode
  | AdminAuthLogoutErrorCode
  | AdminSessionErrorCode
  | AdminReadErrorCode
  | AdminBlocklistReadErrorCode
  | AdminBlocklistDeleteErrorCode
  | AdminSponsoredLogsErrorCode
  | AdminPromotionListErrorCode
  | AdminPromotionReadErrorCode
  | AdminPromotionCreateErrorCode
  | AdminPromotionUpdateErrorCode
  | AdminPromotionStatusErrorCode
  | AdminPromotionDeleteErrorCode
  | AdminWithdrawalChallengeErrorCode
  | AdminWithdrawalErrorCode;

const HOST_ERROR_CODE_SET: ReadonlySet<string> = new Set([
  ...RELAY_STATUS_ERROR_CODES,
  ...RELAY_CONFIG_ERROR_CODES,
  ...STUDIO_LIST_ERROR_CODES,
  ...STUDIO_DETAIL_ERROR_CODES,
  ...STUDIO_CLAIM_ERROR_CODES,
  ...RELAY_PREPARE_ERROR_CODES,
  ...RELAY_SPONSOR_ERROR_CODES,
  ...PROMOTION_PREPARE_ERROR_CODES,
  ...PROMOTION_SPONSOR_ERROR_CODES,
  ...ADMIN_AUTH_NONCE_ERROR_CODES,
  ...ADMIN_AUTH_VERIFY_ERROR_CODES,
  ...ADMIN_AUTH_LOGOUT_ERROR_CODES,
  ...ADMIN_SESSION_ERROR_CODES,
  ...ADMIN_READ_ERROR_CODES,
  ...ADMIN_BLOCKLIST_READ_ERROR_CODES,
  ...ADMIN_BLOCKLIST_DELETE_ERROR_CODES,
  ...ADMIN_SPONSORED_LOGS_ERROR_CODES,
  ...ADMIN_PROMOTION_LIST_ERROR_CODES,
  ...ADMIN_PROMOTION_READ_ERROR_CODES,
  ...ADMIN_PROMOTION_CREATE_ERROR_CODES,
  ...ADMIN_PROMOTION_UPDATE_ERROR_CODES,
  ...ADMIN_PROMOTION_STATUS_ERROR_CODES,
  ...ADMIN_PROMOTION_DELETE_ERROR_CODES,
  ...ADMIN_WITHDRAWAL_CHALLENGE_ERROR_CODES,
  ...ADMIN_WITHDRAWAL_ERROR_CODES,
]);

export function isHostErrorCode(value: unknown): value is HostErrorCode {
  return typeof value === 'string' && HOST_ERROR_CODE_SET.has(value);
}

export const SPONSOR_FAILURE_SUBCODES = [
  'CLAIM_WOULD_EXCEED_MAX',
  'INSUFFICIENT_SETTLE_INPUT',
  'INSUFFICIENT_FUNDS',
  'INVALID_RECEIPT_ID',
  'INVALID_POLICY_HASH',
  'SPREAD_EXCEEDED',
  'SLIPPAGE_EXCEEDED',
  'PAUSED',
  'VAULT_ALREADY_REGISTERED',
  'REPLAY_NONCE',
] as const;

export const PAYMENT_INPUT_INTEGRITY_SUBCODES = [
  'payment_input_missing',
  'payment_input_invalid_shape',
  'payment_input_source_mismatch',
  'payment_input_swap_amount_invalid',
  'payment_input_swap_amount_mismatch',
  'payment_input_split_amount_mismatch',
  'payment_input_withdrawal_amount_mismatch',
  'payment_input_topup_amount_invalid',
  'payment_input_base_coin_mismatch',
  'payment_input_merge_coin_ids_mismatch',
  'payment_input_unexpected_merge_source',
  'payment_input_funding_use_mismatch',
  'payment_input_redeem_use_mismatch',
  'payment_input_redeem_amount_mismatch',
  'payment_input_command_boundary_mismatch',
] as const;

export type SponsorFailureSubcode = (typeof SPONSOR_FAILURE_SUBCODES)[number];
export type PaymentInputIntegritySubcode = (typeof PAYMENT_INPUT_INTEGRITY_SUBCODES)[number];
export type HostErrorSubcode = SponsorFailureSubcode | PaymentInputIntegritySubcode;

const HOST_ERROR_SUBCODE_SET: ReadonlySet<string> = new Set([
  ...SPONSOR_FAILURE_SUBCODES,
  ...PAYMENT_INPUT_INTEGRITY_SUBCODES,
]);

const SPONSOR_FAILURE_SUBCODE_SET: ReadonlySet<string> = new Set(SPONSOR_FAILURE_SUBCODES);
const PAYMENT_INPUT_INTEGRITY_SUBCODE_SET: ReadonlySet<string> = new Set(
  PAYMENT_INPUT_INTEGRITY_SUBCODES,
);

export function isHostErrorSubcode(value: unknown): value is HostErrorSubcode {
  return typeof value === 'string' && HOST_ERROR_SUBCODE_SET.has(value);
}

export function isSponsorFailureSubcode(value: unknown): value is SponsorFailureSubcode {
  return typeof value === 'string' && SPONSOR_FAILURE_SUBCODE_SET.has(value);
}

export function isPaymentInputIntegritySubcode(
  value: unknown,
): value is PaymentInputIntegritySubcode {
  return typeof value === 'string' && PAYMENT_INPUT_INTEGRITY_SUBCODE_SET.has(value);
}

export type HostErrorMetaField =
  | 'retryAfterMs'
  | 'subcode'
  | 'digest'
  | 'operationId'
  | 'minSettleMist'
  | 'requiredTotalIn'
  | 'isEstimate';

export type HostErrorHttpStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 503;

/**
 * Single public authority for the HTTP status of every current Host error
 * code. Producers and consumers must not override these values at runtime.
 */
export const HOST_ERROR_HTTP_STATUS = {
  CONFIG_UNAVAILABLE: 503,
  BAD_REQUEST: 400,
  REQUEST_BODY_TOO_LARGE: 413,
  CLIENT_IP_UNRESOLVED: 400,
  PREPARE_AUTH_TIMESTAMP_INVALID: 400,
  PREPARE_AUTH_NONCE_INVALID: 400,
  PREPARE_AUTH_TX_KIND_HASH_INVALID: 400,
  PREPARE_AUTH_TX_KIND_HASH_MISMATCH: 422,
  PREPARE_AUTH_SIGNATURE_INVALID: 422,
  PREPARE_AUTH_EXPIRED: 422,
  PREPARE_AUTH_NONCE_REUSED: 422,
  PREPARE_SENDER_QUOTA_EXCEEDED: 429,
  P0_INVALID_BASE64: 422,
  P0_TX_KIND_TOO_LARGE: 422,
  P0_INVALID_TX_KIND: 422,
  INVALID_SLIPPAGE_BPS: 422,
  INVALID_GAS_MARGIN_BPS: 422,
  P1_TOO_MANY_COMMANDS: 422,
  P1_GASCOIN_FORBIDDEN: 422,
  P1_USER_SETTLE_FORBIDDEN: 422,
  P1_UNAUTHORIZED_STELIS_CALL: 422,
  P1_FORBIDDEN_COMMAND: 422,
  P1_SPONSOR_WITHDRAWAL_FORBIDDEN: 422,
  UNSUPPORTED_SETTLEMENT_TOKEN: 422,
  INVALID_ORDER_ID: 422,
  INSUFFICIENT_BALANCE: 422,
  CLAIM_WOULD_EXCEED_MAX: 422,
  INSUFFICIENT_SETTLE_INPUT: 422,
  SPREAD_EXCEEDED: 422,
  PAYMENT_COIN_CONFLICT: 422,
  PAYMENT_COIN_LIMIT_EXCEEDED: 422,
  DRY_RUN_FAILED: 422,
  UNACCOUNTABLE_WITHDRAWAL: 422,
  MARKET_QUOTE_UNAVAILABLE: 422,
  SLIPPAGE_EXCEEDED: 422,
  SLIPPAGE_CONVERGENCE_FAILED: 422,
  L1_TOO_MANY_COMMANDS: 422,
  L1_FORBIDDEN_COMMAND: 422,
  L1_NO_SETTLE: 422,
  L1_MULTIPLE_SETTLE: 422,
  L1_PARSE_FAILED: 422,
  L2_EXTRACT_FAILED: 422,
  L2_WRONG_CONFIG: 422,
  L2_WRONG_REGISTRY: 422,
  L2_WRONG_RECIPIENT: 422,
  L2_EXCESSIVE_CLAIM: 422,
  L2_HOST_FEE_CAP: 422,
  L2_PROTOCOL_FEE_MISMATCH: 422,
  L2_CONFIG_VERSION_MISMATCH: 422,
  L2_CREDIT_SLIPPAGE_NONZERO: 422,
  L2_SETTLEMENT_SWAP_PATH_INTEGRITY: 422,
  L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED: 422,
  L2_UNAUTHORIZED_SETTLEMENT_SWAP_PATH: 422,
  L2_POLICY_HASH_MISMATCH: 422,
  L2_ORDER_ID_HASH_MISMATCH: 422,
  SPONSOR_CAPACITY_UNAVAILABLE: 503,
  SPONSOR_REFILL_ACCOUNT_UNHEALTHY: 503,
  NO_SPONSOR_SLOT: 503,
  PREPARE_OVERLOADED: 503,
  SPONSOR_LEASE_COMMIT_FAILED: 500,
  ABUSE_BLOCKED: 429,
  BLOCK_CHECK_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  STUDIO_UNAVAILABLE: 503,
  VAULT_STATE_INCONSISTENT: 422,
  INTERNAL_ERROR: 500,
  PREPARED_TX_NOT_FOUND: 422,
  PREPARED_TX_EXPIRED: 410,
  SENDER_SIGNATURE_INVALID: 422,
  RECEIPT_SESSION_MISMATCH: 422,
  MODE_MISMATCH: 422,
  REPREPARE_REQUIRED: 409,
  TAMPERING_DETECTED: 422,
  L3_NONLOSS_VIOLATION: 422,
  L3_GAS_BUDGET_EXCEEDED: 422,
  L3_SIM_GAS_OUT_OF_RANGE: 422,
  SPONSOR_PREFLIGHT_FAILED: 422,
  SPONSOR_ONCHAIN_FAILED: 422,
  SPONSOR_CONGESTION: 503,
  SPONSOR_SUBMISSION_UNCERTAIN: 503,
  LEASE_EXPIRED: 503,
  SPONSOR_FAILED: 500,
  AUTH_FAILED: 401,
  AUTH_JWT_INVALID: 401,
  AUTH_UNAVAILABLE: 503,
  BAD_TX_KIND: 400,
  SENDER_ADDRESS_MISMATCH: 403,
  PROMOTION_NOT_FOUND: 404,
  PROMOTION_NOT_ACTIVE: 409,
  CLAIM_DEADLINE_PASSED: 409,
  PROMOTION_CAPACITY_REACHED: 409,
  ALREADY_CLAIMED: 409,
  NOT_CLAIMED: 403,
  USE_WINDOW_EXPIRED: 403,
  FORBIDDEN_COMMAND: 403,
  GASCOIN_FORBIDDEN: 403,
  SPONSOR_WITHDRAWAL_FORBIDDEN: 403,
  DISALLOWED_TARGET: 403,
  GAS_EXCEEDS_TX_CAP: 422,
  BUDGET_INSUFFICIENT: 422,
  ENTITLEMENT_NOT_FOUND: 422,
  ENTITLEMENT_NOT_ACTIVE: 422,
  ENTITLEMENT_INSUFFICIENT: 422,
  ENTITLEMENT_CONCURRENT_RESERVATION: 409,
  PREPARE_STUDIO_USER_QUOTA_EXCEEDED: 429,
  USER_ID_MISMATCH: 403,
  PROMOTION_ID_MISMATCH: 403,
  PREFLIGHT_FAILED: 422,
  ONCHAIN_REVERT: 422,
  ADMIN_UNAUTHORIZED: 401,
  ADMIN_NOT_FOUND: 404,
  ADMIN_CONFLICT: 409,
  ADMIN_UNPROCESSABLE: 422,
  ADMIN_UNAVAILABLE: 503,
  PROMOTION_CURRENT_CONFLICT: 409,
  WITHDRAWAL_SIGNATURE_INVALID: 401,
  WITHDRAWAL_NONCE_MISSING: 401,
  WITHDRAWAL_RUNWAY_BLOCKED: 400,
  WITHDRAWAL_NOT_ACCEPTED: 409,
  WITHDRAWAL_PENDING: 503,
  WITHDRAWAL_FAILED: 422,
} as const satisfies Readonly<Record<HostErrorCode, HostErrorHttpStatus>>;

const HOST_ERROR_PUBLIC_MESSAGE_BY_STATUS = {
  400: 'Invalid request',
  401: 'Authentication failed',
  403: 'Request forbidden',
  404: 'Resource not found',
  409: 'Request conflicts with current state',
  410: 'Resource expired',
  413: 'Request body too large',
  422: 'Request rejected',
  429: 'Request temporarily blocked',
  500: 'Internal server error',
  503: 'Service temporarily unavailable',
} as const satisfies Readonly<Record<HostErrorHttpStatus, string>>;

const HOST_ERROR_PUBLIC_MESSAGE_BY_CODE: Readonly<Partial<Record<HostErrorCode, string>>> = {
  PAYMENT_COIN_CONFLICT: 'Settlement-token payment could not be resolved safely',
  PAYMENT_COIN_LIMIT_EXCEEDED: 'Consolidate settlement-token Coin objects and try again',
};

/** Single public-message authority for every current coded Host error. */
export function hostErrorPublicMessage(code: HostErrorCode): string {
  return (
    HOST_ERROR_PUBLIC_MESSAGE_BY_CODE[code] ??
    HOST_ERROR_PUBLIC_MESSAGE_BY_STATUS[HOST_ERROR_HTTP_STATUS[code]]
  );
}

export interface HostErrorMetaPolicy {
  readonly allowed: readonly HostErrorMetaField[];
  readonly required?: readonly HostErrorMetaField[];
  readonly subcodeKind?: 'sponsor' | 'payment_input';
}

const SETTLEMENT_DIAGNOSTIC_FIELDS = [
  'minSettleMist',
  'requiredTotalIn',
  'isEstimate',
] as const satisfies readonly HostErrorMetaField[];

/** Sparse metadata policy; every code not listed here permits no metadata. */
export const HOST_ERROR_META_POLICY: Readonly<Partial<Record<HostErrorCode, HostErrorMetaPolicy>>> =
  {
    ABUSE_BLOCKED: { allowed: ['retryAfterMs'] },
    RATE_LIMITED: { allowed: ['retryAfterMs'], required: ['retryAfterMs'] },
    INSUFFICIENT_BALANCE: { allowed: SETTLEMENT_DIAGNOSTIC_FIELDS },
    CLAIM_WOULD_EXCEED_MAX: { allowed: SETTLEMENT_DIAGNOSTIC_FIELDS },
    INSUFFICIENT_SETTLE_INPUT: { allowed: SETTLEMENT_DIAGNOSTIC_FIELDS },
    SPREAD_EXCEEDED: { allowed: SETTLEMENT_DIAGNOSTIC_FIELDS },
    DRY_RUN_FAILED: { allowed: SETTLEMENT_DIAGNOSTIC_FIELDS },
    SLIPPAGE_EXCEEDED: { allowed: SETTLEMENT_DIAGNOSTIC_FIELDS },
    L2_EXTRACT_FAILED: { allowed: ['subcode'], subcodeKind: 'payment_input' },
    SPONSOR_PREFLIGHT_FAILED: { allowed: ['subcode'], subcodeKind: 'sponsor' },
    SPONSOR_ONCHAIN_FAILED: {
      allowed: ['digest', 'subcode'],
      required: ['digest'],
      subcodeKind: 'sponsor',
    },
    SPONSOR_CONGESTION: { allowed: ['digest'], required: ['digest'] },
    SPONSOR_SUBMISSION_UNCERTAIN: { allowed: ['digest'], required: ['digest'] },
    PREFLIGHT_FAILED: { allowed: ['subcode'], subcodeKind: 'sponsor' },
    ONCHAIN_REVERT: {
      allowed: ['digest', 'subcode'],
      required: ['digest'],
      subcodeKind: 'sponsor',
    },
    WITHDRAWAL_NOT_ACCEPTED: {
      allowed: ['operationId', 'digest'],
      required: ['operationId'],
    },
    WITHDRAWAL_PENDING: {
      allowed: ['operationId', 'digest'],
      required: ['operationId'],
    },
  };
