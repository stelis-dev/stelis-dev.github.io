import {
  SETTLEMENT_SWAP_DIRECTION_VECTORS,
  VALID_SETTLEMENT_SWAP_DIRECTIONS,
} from './constants.js';
import type {
  DeepBookPoolHop,
  SettlementSwapDirection,
  SettleProfile,
  SingleHopSettlementSwapPathResponse,
  SuiNetwork,
} from './types.js';
import {
  HOST_ERROR_HTTP_STATUS,
  HOST_ERROR_META_POLICY,
  hostErrorPublicMessage,
  isHostErrorCode,
  isHostErrorSubcode,
  isPaymentInputIntegritySubcode,
  isSponsorFailureSubcode,
  type HostErrorCode,
  type HostErrorMetaField,
  type HostErrorSubcode,
} from './hostError.js';
import {
  isPositiveU64DecimalString,
  SPONSOR_SLOT_STATES,
  type SponsorOperationsStatus,
} from './admin.js';

const DECIMAL_RE = /^(?:0|[1-9]\d*)$/;
const SIGNED_DECIMAL_RE = /^(?:0|-?[1-9]\d*)$/;
const PROMOTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const U64_MAX = (1n << 64n) - 1n;

const PROMOTION_PAGE_DEFAULT_LIMIT = 50;
export const PROMOTION_PAGE_MAX_LIMIT = 100;

export class HostWireParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostWireParseError';
  }
}

export interface RelayStatusResponse {
  ok: true;
}

export interface RelayConfigResponse {
  network: SuiNetwork;
  packageId: string;
  settlementPayoutRecipient: string;
  supportedSettlementSwapPaths: SingleHopSettlementSwapPathResponse[];
  quotedHostFeeMist: string;
  protocolFlatFeeMist: string;
}

export interface RelayPrepareRequest {
  txKindBytes: string;
  senderAddress: string;
  settlementTokenType: string;
  slippageBps?: number;
  gasMarginBps?: number;
  orderId?: string;
  txKindBytesHash: string;
  prepareAuthorizationTimestampMs: number;
  prepareAuthorizationRequestNonce: string;
  prepareAuthorizationSignature: string;
}

export interface RelayPrepareResponse {
  txBytes: string;
  receiptId: string;
  nonce: string;
  cost: {
    simGas: string;
    gasVarianceFixedMist: string;
    slippageBufferMist: string;
    quotedHostFee: string;
    protocolFee: string;
    executionCostClaim: string;
    grossGas: string;
  };
  profile: SettleProfile;
  quoteTimestampMs: number;
  policyHash: string;
  orderId?: string;
}

export interface RelaySponsorRequest {
  txBytes: string;
  userSignature: string;
  receiptId: string;
}

export interface RelaySponsorResponse {
  digest: string;
  effects: unknown;
  executionCostClaim: string;
  orderId?: string;
}

/**
 * Closed error shape shared by every current Host HTTP surface and consumer.
 *
 * The three settlement diagnostics are meaningful only when a failure policy
 * elects to expose them. Keeping the transport vocabulary closed prevents an
 * internal diagnostic dictionary from silently becoming public API.
 */
export interface HostErrorResponse {
  error: string;
  code: HostErrorCode;
  retryAfterMs?: number;
  subcode?: HostErrorSubcode;
  digest?: string;
  operationId?: string;
  minSettleMist?: string;
  requiredTotalIn?: string;
  isEstimate?: boolean;
}

export type HostErrorMeta = Omit<HostErrorResponse, 'error' | 'code'>;

const PROMOTION_TYPES = ['gas_sponsorship'] as const;
const PROMOTION_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
const PROMOTION_UNAVAILABLE_REASONS = [
  'not_claimed',
  'promotion_unavailable',
  'promotion_not_started',
  'claim_deadline_passed',
  'use_window_expired',
  'allowance_exhausted',
  'action_in_flight',
] as const;
const PROMOTION_CLAIM_STATUSES = ['claimed', 'not_claimed'] as const;
const PROMOTION_ENTITLEMENT_STATUSES = ['active', 'exhausted', 'expired'] as const;

export type PromotionType = (typeof PROMOTION_TYPES)[number];
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

/** Optional public query shared by every current Promotion-list boundary. */
export interface PromotionPageQuery {
  cursor?: string;
  limit?: number;
}

/** Validated parameters consumed by Promotion page handlers and stores. */
export interface PromotionPageParams {
  cursor: string | null;
  limit: number;
}

export interface AdminPromotionListQuery extends PromotionPageQuery {
  status?: PromotionStatus;
}

export interface AdminPromotionListParams extends PromotionPageParams {
  status?: PromotionStatus;
}

export function isPromotionId(value: unknown): value is string {
  return typeof value === 'string' && PROMOTION_ID_RE.test(value);
}

export function parsePromotionId(value: unknown, label = 'promotionId'): string {
  if (!isPromotionId(value)) {
    throw new HostWireParseError(`${label} must be a canonical lowercase UUID-v4`);
  }
  return value;
}

/** Ascending ASCII order for canonical Promotion IDs. */
export function comparePromotionIds(left: string, right: string): number {
  const currentLeft = parsePromotionId(left, 'left promotionId');
  const currentRight = parsePromotionId(right, 'right promotionId');
  return currentLeft < currentRight ? -1 : currentLeft > currentRight ? 1 : 0;
}

export function isPromotionStatus(value: unknown): value is PromotionStatus {
  return typeof value === 'string' && (PROMOTION_STATUSES as readonly string[]).includes(value);
}
export type PromotionUnavailableReason = (typeof PROMOTION_UNAVAILABLE_REASONS)[number];

export interface PromotionListItem {
  promotionId: string;
  displayName: string;
  type: PromotionType;
  status: PromotionStatus;
  canClaim: boolean;
  canUseSponsoredAction: boolean;
  promotionRemainingBudgetMist: string;
  remainingParticipantSlots: number;
  userRemainingGasAllowanceMist: string | null;
  unavailableReason: PromotionUnavailableReason | null;
}

export interface PromotionListResponse {
  promotions: PromotionListItem[];
  nextCursor: string | null;
}

export interface UserPromotionDetail {
  claimStatus: (typeof PROMOTION_CLAIM_STATUSES)[number];
  userRemainingGasAllowanceMist: string | null;
  claimDeadlineAt: string | null;
  useUntilAt: string | null;
  canClaim: boolean;
  canUseSponsoredAction: boolean;
  unavailableReason: PromotionUnavailableReason | null;
}

export interface PromotionDetailResponse {
  promotionId: string;
  displayName: string;
  type: PromotionType;
  promotionRemainingBudgetMist: string;
  detail: UserPromotionDetail;
}

export type PromotionEntitlementStatus = (typeof PROMOTION_ENTITLEMENT_STATUSES)[number];

export interface PromotionEntitlement {
  promotionId: string;
  userId: string;
  claimedAt: string;
  useUntilAt: string | null;
  remainingGasAllowanceMist: string;
  consumedGasAllowanceMist: string;
  status: PromotionEntitlementStatus;
  activeReservationReceiptId: string | null;
  activeReservationAmountMist: string | null;
  lastUsedAt: string | null;
}

export interface PromotionClaimResponse {
  entitlement: PromotionEntitlement;
}

export interface PromotionPrepareRequest {
  senderAddress: string;
  txKindBytes: string;
}

export interface PromotionPrepareResponse {
  txBytes: string;
  receiptId: string;
  estimatedGasMist: string;
}

export interface PromotionSponsorRequest {
  receiptId: string;
  txBytes: string;
  userSignature: string;
}

export interface PromotionSponsorResponse {
  digest: string;
  effects: unknown;
  actualGasMist: string;
}

export interface AdminAuthChallengeResponse {
  nonce: string;
}

export interface AdminAuthVerifyRequest {
  nonce: string;
  signature: string;
  address: string;
}

export interface AdminAuthSuccessResponse {
  ok: true;
}

export interface AdminSessionResponse {
  address: string;
  exp: number;
  iat: number;
}

export interface AdminAuditLogEntry {
  ts: string;
  event: string;
  ip: string;
  address?: string;
  reason?: string;
  error?: string;
  detail?: string;
}

export interface AdminAuditLogsResponse {
  logs: AdminAuditLogEntry[];
}

export interface AdminBlocklistEntry {
  key: string;
  /** Redis TTL in seconds; `-1` means no expiry and `-2` means no current key. */
  ttl: number;
}

export interface AdminBlocklistResponse {
  blocklist: AdminBlocklistEntry[];
}

export interface AdminBlocklistDeleteRequest {
  key: string;
}

export interface AdminBlocklistDeleteResponse {
  ok: true;
  deleted: string;
}

export type AdminStudioResponse =
  | { enabled: false }
  | {
      enabled: true;
      config: {
        developerJwtTrustConfigured: boolean;
        developerJwtVerifyUrlConfigured: boolean;
      };
    };

/** Current operator-facing Promotion projection returned by Admin routes. */
export interface AdminPromotionRecord {
  promotionId: string;
  type: PromotionType;
  displayName: string;
  description: string;
  status: PromotionStatus;
  maxParticipants: number;
  perUserGasAllowanceMist: string;
  totalRequiredBudgetMist: string;
  claimDeadlineAt: string | null;
  postClaimUseWindowMs: number;
  startAt: string | null;
  pauseReason: string | null;
  archiveReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminPromotionListResponse {
  promotions: AdminPromotionRecord[];
  nextCursor: string | null;
}

export interface AdminPromotionSummary {
  claimedUsers: number;
  remainingParticipantSlots: number;
  totalConsumedBudgetMist: string;
  totalReservedBudgetMist: string;
  totalRemainingBudgetMist: string;
  totalRequiredBudgetMist: string;
}

export interface AdminClaimedUser {
  userId: string;
  claimedAt: string;
  remainingGasAllowanceMist: string | null;
  consumedGasAllowanceMist: string | null;
  status: PromotionEntitlementStatus | null;
  activeReservationReceiptId: string | null;
}

export interface AdminPromotionDetailResponse {
  promotion: AdminPromotionRecord;
  summary: AdminPromotionSummary | null;
}

export interface AdminPromotionUsersResponse {
  promotionId: string;
  users: AdminClaimedUser[];
  total: number;
}

export interface AdminPromotionSummaryResponse {
  promotionId: string;
  summary: AdminPromotionSummary;
}

export type AdminSettlementSwapPath = SingleHopSettlementSwapPathResponse & { hopCount: number };

export interface AdminSettlementSwapPathsResponse {
  count: number;
  settlementSwapPaths: AdminSettlementSwapPath[];
}

export interface AdminPromotionCreateRequest {
  type: PromotionType;
  displayName: string;
  description?: string;
  maxParticipants: number;
  perUserGasAllowanceMist: string;
  claimDeadlineAt?: string | null;
  postClaimUseWindowMs?: number;
  startAt?: string | null;
}

export interface AdminPromotionUpdateRequest {
  displayName?: string;
  description?: string;
  maxParticipants?: number;
  perUserGasAllowanceMist?: string;
  claimDeadlineAt?: string | null;
  postClaimUseWindowMs?: number;
  startAt?: string | null;
}

export interface AdminPromotionStatusRequest {
  status: PromotionStatus;
  reason?: string;
}

export interface AdminPromotionResponse {
  promotion: AdminPromotionRecord;
}

export interface AdminPromotionDeleteResponse {
  ok: true;
}

export type AdminSponsoredLogsMode = 'all' | 'generic' | 'promotion';

export interface AdminSponsoredLogsQuery {
  mode: AdminSponsoredLogsMode;
  limit: number;
}

export type AdminSponsoredExecutionMode = Exclude<AdminSponsoredLogsMode, 'all'>;
export type AdminSponsoredExecutionOutcome = 'success' | 'onchain_revert' | 'internal_error';
export type AdminSponsoredExecutionEconomicsStatus = 'known' | 'unknown';

export interface AdminSponsoredExecutionAggregate {
  mode: AdminSponsoredLogsMode;
  sponsoredExecutions: string;
  lossCount: string;
  cumulativeHostNetMist: string;
  cumulativeLossMist: string;
}

interface AdminSponsoredExecutionLogEntryBase {
  createdAt: string;
  mode: AdminSponsoredExecutionMode;
  outcome: AdminSponsoredExecutionOutcome;
  receiptId: string;
  digest: string | null;
  senderAddress: string;
  sponsorAddress: string;
  executionPathKey: string;
  orderIdHash: string | null;
  promotionId: string | null;
  userId: string | null;
  failureReason: string | null;
}

export type AdminSponsoredExecutionLogEntry = AdminSponsoredExecutionLogEntryBase &
  (
    | {
        economicsStatus: 'known';
        recoveredGasMist: string;
        hostPaidGasMist: string;
        hostNetMist: string;
        hostFeeMist: string;
        protocolFeeMist: string | null;
        grossGasMist: string | null;
        storageRebateMist: string | null;
      }
    | {
        economicsStatus: 'unknown';
        recoveredGasMist: null;
        hostPaidGasMist: null;
        hostNetMist: null;
        hostFeeMist: null;
        protocolFeeMist: null;
        grossGasMist: null;
        storageRebateMist: null;
      }
  );

export interface AdminSponsoredLogsSummaryResponse {
  summary: AdminSponsoredExecutionAggregate;
}

export interface AdminSponsoredLogsResponse {
  summary: AdminSponsoredExecutionAggregate;
  entries: AdminSponsoredExecutionLogEntry[];
}

export interface SponsorRefillAccountWithdrawalChallengeResponse {
  nonce: string;
  expiresAt: string;
}

export interface SponsorRefillAccountWithdrawalRequest {
  nonce: string;
  signature: string;
  amountMist: string;
}

export interface SponsorRefillAccountWithdrawalResponse {
  digest: string;
  amountMist: string;
  recipient: string;
}

/** Public, credential-free view of the boot-qualified Sui RPC fleet. */
export interface SuiRpcFleetStatus {
  readonly endpoints: readonly {
    readonly origin: string;
    readonly role: 'primary' | 'secondary';
  }[];
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Canonical public origin for one current Sui RPC endpoint.
 *
 * This validates the credential-free Admin projection only. The private
 * transport base URL is app-api-owned and may include a provider path.
 */
export function canonicalizeSuiRpcOrigin(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value !== value.trim() ||
    containsAsciiControl(value)
  ) {
    throw new TypeError('Sui RPC endpoint must be a non-empty HTTP(S) origin');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Sui RPC endpoint must be a valid HTTP(S) origin');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('Sui RPC endpoint must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('Sui RPC endpoint must not contain embedded credentials');
  }
  if (parsed.pathname !== '/') {
    throw new TypeError('Sui RPC endpoint must use the origin root path');
  }
  if (parsed.search !== '') {
    throw new TypeError('Sui RPC endpoint must not contain a query');
  }
  if (parsed.hash !== '') {
    throw new TypeError('Sui RPC endpoint must not contain a fragment');
  }
  return parsed.origin;
}

export interface AdminSponsorOperationsResponse {
  sponsorOperations: SponsorOperationsStatus;
  primaryAddress: string | null;
  settlementPayoutRecipientAddress: string;
  network: SuiNetwork;
  sponsorBalanceWarnMist: string;
  sponsorBalanceRefillTargetMist: string;
  refillEnabled: boolean;
  quotedHostFeeMist: string;
  feeConfig: {
    maxHostFeeMist: string;
    protocolFlatFeeMist: string;
    maxClaimMist: string;
    minSettleMist: string;
    configVersion: string;
  } | null;
  supportedSettlementSwapPaths: SingleHopSettlementSwapPathResponse[];
  onChainIds: {
    packageId: string | null;
    configId: string | null;
    vaultRegistryId: string | null;
    deepbookPackageId: string | null;
  };
  studioEnabled: boolean;
  rpcFleet: SuiRpcFleetStatus;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HostWireParseError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected !== undefined) {
    throw new HostWireParseError(`${label} contains a non-current field`);
  }
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== 'string') {
    throw new HostWireParseError(`${label}.${key} must be a string`);
  }
  return field;
}

function nonEmptyStringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = stringField(value, key, label);
  if (field.length === 0) {
    throw new HostWireParseError(`${label}.${key} must be a non-empty string`);
  }
  return field;
}

function promotionIdField(value: Record<string, unknown>, key: string, label: string): string {
  return parsePromotionId(value[key], `${label}.${key}`);
}

function optionalStringField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  return stringField(value, key, label);
}

function safeIntegerField(value: Record<string, unknown>, key: string, label: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isSafeInteger(field)) {
    throw new HostWireParseError(`${label}.${key} must be a safe integer`);
  }
  return field;
}

function optionalSafeIntegerField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  return safeIntegerField(value, key, label);
}

function optionalBooleanField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  const field = value[key];
  if (typeof field !== 'boolean') {
    throw new HostWireParseError(`${label}.${key} must be a boolean`);
  }
  return field;
}

function booleanField(value: Record<string, unknown>, key: string, label: string): boolean {
  const field = value[key];
  if (typeof field !== 'boolean') {
    throw new HostWireParseError(`${label}.${key} must be a boolean`);
  }
  return field;
}

function nullableStringField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  if (value[key] === null) return null;
  return stringField(value, key, label);
}

function nullableNonEmptyStringField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  if (value[key] === null) return null;
  return nonEmptyStringField(value, key, label);
}

function nullableSafeIntegerField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): number | null {
  if (value[key] === null) return null;
  return safeIntegerField(value, key, label);
}

function nullableDecimalField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  if (value[key] === null) return null;
  return decimalField(value, key, label);
}

function nullableU64Field(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  if (value[key] === null) return null;
  return u64DecimalField(value, key, label);
}

function closedStringField<const Values extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  label: string,
  allowed: Values,
): Values[number] {
  const field = stringField(value, key, label);
  if (!(allowed as readonly string[]).includes(field)) {
    throw new HostWireParseError(`${label}.${key} is not current`);
  }
  return field as Values[number];
}

function optionalDecimalField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  return decimalField(value, key, label);
}

function optionalU64Field(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  return u64DecimalField(value, key, label);
}

function decimalField(value: Record<string, unknown>, key: string, label: string): string {
  const field = stringField(value, key, label);
  if (!DECIMAL_RE.test(field)) {
    throw new HostWireParseError(`${label}.${key} must be a canonical non-negative decimal string`);
  }
  return field;
}

function u64DecimalField(value: Record<string, unknown>, key: string, label: string): string {
  const field = decimalField(value, key, label);
  if (BigInt(field) > U64_MAX) {
    throw new HostWireParseError(`${label}.${key} must fit in u64`);
  }
  return field;
}

function positiveU64DecimalField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const field = stringField(value, key, label);
  if (!isPositiveU64DecimalString(field)) {
    throw new HostWireParseError(`${label}.${key} must be a canonical positive u64 decimal string`);
  }
  return field;
}

function signedDecimalField(value: Record<string, unknown>, key: string, label: string): string {
  const field = stringField(value, key, label);
  if (!SIGNED_DECIMAL_RE.test(field)) {
    throw new HostWireParseError(`${label}.${key} must be a canonical signed decimal string`);
  }
  return field;
}

function signedU64MagnitudeField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const field = signedDecimalField(value, key, label);
  const magnitude = field.startsWith('-') ? field.slice(1) : field;
  if (BigInt(magnitude) > U64_MAX) {
    throw new HostWireParseError(`${label}.${key} magnitude must fit in u64`);
  }
  return field;
}

function nonNegativeSafeIntegerField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const field = safeIntegerField(value, key, label);
  if (field < 0) {
    throw new HostWireParseError(`${label}.${key} must be non-negative`);
  }
  return field;
}

function positiveSafeIntegerField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const field = safeIntegerField(value, key, label);
  if (field <= 0) {
    throw new HostWireParseError(`${label}.${key} must be positive`);
  }
  return field;
}

function parsePromotionPageLimit(value: unknown, label: string): number {
  if (value === undefined) return PROMOTION_PAGE_DEFAULT_LIMIT;

  const limit =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROMOTION_PAGE_MAX_LIMIT) {
    throw new HostWireParseError(
      `${label}.limit must be an integer from 1 through ${PROMOTION_PAGE_MAX_LIMIT}`,
    );
  }
  return limit;
}

function parsePromotionPageFields(
  raw: Record<string, unknown>,
  label: string,
): PromotionPageParams {
  return {
    cursor: raw.cursor === undefined ? null : parsePromotionId(raw.cursor, `${label}.cursor`),
    limit: parsePromotionPageLimit(raw.limit, label),
  };
}

/** Parse and normalize the exact current Promotion-page query. */
export function parsePromotionPageQuery(value: unknown): PromotionPageParams {
  const label = 'PromotionPageQuery';
  const raw = record(value, label);
  onlyKeys(raw, ['cursor', 'limit'], label);
  return parsePromotionPageFields(raw, label);
}

/** Parse the Admin Promotion-list query without changing shared page semantics. */
export function parseAdminPromotionListQuery(value: unknown): AdminPromotionListParams {
  const label = 'AdminPromotionListQuery';
  const raw = record(value, label);
  onlyKeys(raw, ['cursor', 'limit', 'status'], label);
  const page = parsePromotionPageFields(raw, label);
  if (raw.status === undefined) return page;
  if (!isPromotionStatus(raw.status)) {
    throw new HostWireParseError(`${label}.status is not current`);
  }
  return { ...page, status: raw.status };
}

function bpsField(value: Record<string, unknown>, key: string, label: string): number {
  const field = safeIntegerField(value, key, label);
  if (field < 0 || field > 10_000) {
    throw new HostWireParseError(`${label}.${key} must be in [0, 10000]`);
  }
  return field;
}

function parsePoolHop(value: unknown, label: string): DeepBookPoolHop {
  const raw = record(value, label);
  onlyKeys(raw, ['poolId', 'baseType', 'quoteType', 'swapDirection', 'feeBps'], label);
  const swapDirection = raw.swapDirection;
  if (swapDirection !== 'baseForQuote' && swapDirection !== 'quoteForBase') {
    throw new HostWireParseError(`${label}.swapDirection is invalid`);
  }
  return {
    poolId: nonEmptyStringField(raw, 'poolId', label),
    baseType: nonEmptyStringField(raw, 'baseType', label),
    quoteType: nonEmptyStringField(raw, 'quoteType', label),
    swapDirection,
    feeBps: bpsField(raw, 'feeBps', label),
  };
}

function parseSettlementSwapPath(
  value: unknown,
  index: number,
): SingleHopSettlementSwapPathResponse {
  const label = `RelayConfigResponse.supportedSettlementSwapPaths[${index}]`;
  const raw = record(value, label);
  onlyKeys(
    raw,
    [
      'hops',
      'settlementTokenType',
      'settlementTokenSymbol',
      'settlementTokenDecimals',
      'lotSize',
      'minSize',
      'effectiveFeeRateBps',
      'settlementSwapDirection',
    ],
    label,
  );
  if (!Array.isArray(raw.hops) || raw.hops.length === 0) {
    throw new HostWireParseError(`${label}.hops must be a non-empty array`);
  }
  const direction = raw.settlementSwapDirection;
  if (
    typeof direction !== 'string' ||
    !(VALID_SETTLEMENT_SWAP_DIRECTIONS as ReadonlySet<string>).has(direction)
  ) {
    throw new HostWireParseError(`${label}.settlementSwapDirection is invalid`);
  }
  const settlementSwapDirection = direction as SettlementSwapDirection;
  const hops = raw.hops.map((hop, hopIndex) => parsePoolHop(hop, `${label}.hops[${hopIndex}]`));
  const expected = SETTLEMENT_SWAP_DIRECTION_VECTORS[settlementSwapDirection];
  if (
    hops.length !== expected.length ||
    !hops.every((hop, hopIndex) => hop.swapDirection === expected[hopIndex])
  ) {
    throw new HostWireParseError(`${label}.hops do not match settlementSwapDirection`);
  }
  const lotSize = safeIntegerField(raw, 'lotSize', label);
  const minSize = safeIntegerField(raw, 'minSize', label);
  if (lotSize < 0 || minSize < 0) {
    throw new HostWireParseError(`${label}.lotSize and minSize must be non-negative`);
  }
  const effectiveFeeRateBps = bpsField(raw, 'effectiveFeeRateBps', label);
  if (hops.length === 1 && hops[0]?.feeBps !== effectiveFeeRateBps) {
    throw new HostWireParseError(`${label}.hops[0].feeBps must equal effectiveFeeRateBps`);
  }
  const settlementTokenDecimals = safeIntegerField(raw, 'settlementTokenDecimals', label);
  if (settlementTokenDecimals < 0) {
    throw new HostWireParseError(`${label}.settlementTokenDecimals must be non-negative`);
  }
  return {
    hops,
    settlementTokenType: nonEmptyStringField(raw, 'settlementTokenType', label),
    settlementTokenSymbol: nonEmptyStringField(raw, 'settlementTokenSymbol', label),
    settlementTokenDecimals,
    lotSize,
    minSize,
    effectiveFeeRateBps,
    settlementSwapDirection,
  };
}

export function parseRelayStatusResponse(value: unknown): RelayStatusResponse {
  const label = 'RelayStatusResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['ok'], label);
  if (raw.ok !== true) {
    throw new HostWireParseError(`${label}.ok must be true`);
  }
  return { ok: true };
}

export function parseRelayConfigResponse(value: unknown): RelayConfigResponse {
  const raw = record(value, 'RelayConfigResponse');
  onlyKeys(
    raw,
    [
      'network',
      'packageId',
      'settlementPayoutRecipient',
      'supportedSettlementSwapPaths',
      'quotedHostFeeMist',
      'protocolFlatFeeMist',
    ],
    'RelayConfigResponse',
  );
  const network = raw.network;
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new HostWireParseError('RelayConfigResponse.network is invalid');
  }
  if (!Array.isArray(raw.supportedSettlementSwapPaths)) {
    throw new HostWireParseError(
      'RelayConfigResponse.supportedSettlementSwapPaths must be an array',
    );
  }
  const paths = raw.supportedSettlementSwapPaths.map(parseSettlementSwapPath);
  const tokenTypes = new Set<string>();
  for (const path of paths) {
    if (tokenTypes.has(path.settlementTokenType)) {
      throw new HostWireParseError(
        `RelayConfigResponse has duplicate settlementTokenType: ${path.settlementTokenType}`,
      );
    }
    tokenTypes.add(path.settlementTokenType);
  }
  return {
    network,
    packageId: nonEmptyStringField(raw, 'packageId', 'RelayConfigResponse'),
    settlementPayoutRecipient: nonEmptyStringField(
      raw,
      'settlementPayoutRecipient',
      'RelayConfigResponse',
    ),
    supportedSettlementSwapPaths: paths,
    quotedHostFeeMist: decimalField(raw, 'quotedHostFeeMist', 'RelayConfigResponse'),
    protocolFlatFeeMist: decimalField(raw, 'protocolFlatFeeMist', 'RelayConfigResponse'),
  };
}

export function parseRelayPrepareRequest(value: unknown): RelayPrepareRequest {
  const raw = record(value, 'RelayPrepareRequest');
  onlyKeys(
    raw,
    [
      'txKindBytes',
      'senderAddress',
      'settlementTokenType',
      'slippageBps',
      'gasMarginBps',
      'orderId',
      'txKindBytesHash',
      'prepareAuthorizationTimestampMs',
      'prepareAuthorizationRequestNonce',
      'prepareAuthorizationSignature',
    ],
    'RelayPrepareRequest',
  );
  return {
    txKindBytes: stringField(raw, 'txKindBytes', 'RelayPrepareRequest'),
    senderAddress: stringField(raw, 'senderAddress', 'RelayPrepareRequest'),
    settlementTokenType: nonEmptyStringField(raw, 'settlementTokenType', 'RelayPrepareRequest'),
    slippageBps: optionalSafeIntegerField(raw, 'slippageBps', 'RelayPrepareRequest'),
    gasMarginBps: optionalSafeIntegerField(raw, 'gasMarginBps', 'RelayPrepareRequest'),
    orderId: optionalStringField(raw, 'orderId', 'RelayPrepareRequest'),
    txKindBytesHash: stringField(raw, 'txKindBytesHash', 'RelayPrepareRequest'),
    prepareAuthorizationTimestampMs: safeIntegerField(
      raw,
      'prepareAuthorizationTimestampMs',
      'RelayPrepareRequest',
    ),
    prepareAuthorizationRequestNonce: stringField(
      raw,
      'prepareAuthorizationRequestNonce',
      'RelayPrepareRequest',
    ),
    prepareAuthorizationSignature: stringField(
      raw,
      'prepareAuthorizationSignature',
      'RelayPrepareRequest',
    ),
  };
}

export function parseRelayPrepareResponse(value: unknown): RelayPrepareResponse {
  const raw = record(value, 'RelayPrepareResponse');
  onlyKeys(
    raw,
    [
      'txBytes',
      'receiptId',
      'nonce',
      'cost',
      'profile',
      'quoteTimestampMs',
      'policyHash',
      'orderId',
    ],
    'RelayPrepareResponse',
  );
  const cost = record(raw.cost, 'RelayPrepareResponse.cost');
  onlyKeys(
    cost,
    [
      'simGas',
      'gasVarianceFixedMist',
      'slippageBufferMist',
      'quotedHostFee',
      'protocolFee',
      'executionCostClaim',
      'grossGas',
    ],
    'RelayPrepareResponse.cost',
  );
  const profile = raw.profile;
  if (profile !== 'credit_general' && profile !== 'with_vault' && profile !== 'new_user') {
    throw new HostWireParseError('RelayPrepareResponse.profile is invalid');
  }
  return {
    txBytes: stringField(raw, 'txBytes', 'RelayPrepareResponse'),
    receiptId: stringField(raw, 'receiptId', 'RelayPrepareResponse'),
    nonce: decimalField(raw, 'nonce', 'RelayPrepareResponse'),
    cost: {
      simGas: decimalField(cost, 'simGas', 'RelayPrepareResponse.cost'),
      gasVarianceFixedMist: decimalField(cost, 'gasVarianceFixedMist', 'RelayPrepareResponse.cost'),
      slippageBufferMist: decimalField(cost, 'slippageBufferMist', 'RelayPrepareResponse.cost'),
      quotedHostFee: decimalField(cost, 'quotedHostFee', 'RelayPrepareResponse.cost'),
      protocolFee: decimalField(cost, 'protocolFee', 'RelayPrepareResponse.cost'),
      executionCostClaim: decimalField(cost, 'executionCostClaim', 'RelayPrepareResponse.cost'),
      grossGas: decimalField(cost, 'grossGas', 'RelayPrepareResponse.cost'),
    },
    profile,
    quoteTimestampMs: safeIntegerField(raw, 'quoteTimestampMs', 'RelayPrepareResponse'),
    policyHash: stringField(raw, 'policyHash', 'RelayPrepareResponse'),
    orderId: optionalStringField(raw, 'orderId', 'RelayPrepareResponse'),
  };
}

export function parseRelaySponsorRequest(value: unknown): RelaySponsorRequest {
  const raw = record(value, 'RelaySponsorRequest');
  onlyKeys(raw, ['txBytes', 'userSignature', 'receiptId'], 'RelaySponsorRequest');
  return {
    txBytes: stringField(raw, 'txBytes', 'RelaySponsorRequest'),
    userSignature: stringField(raw, 'userSignature', 'RelaySponsorRequest'),
    receiptId: stringField(raw, 'receiptId', 'RelaySponsorRequest'),
  };
}

export function parseRelaySponsorResponse(value: unknown): RelaySponsorResponse {
  const raw = record(value, 'RelaySponsorResponse');
  onlyKeys(raw, ['digest', 'effects', 'executionCostClaim', 'orderId'], 'RelaySponsorResponse');
  if (!Object.prototype.hasOwnProperty.call(raw, 'effects')) {
    throw new HostWireParseError('RelaySponsorResponse.effects is required');
  }
  return {
    digest: stringField(raw, 'digest', 'RelaySponsorResponse'),
    effects: raw.effects,
    executionCostClaim: decimalField(raw, 'executionCostClaim', 'RelaySponsorResponse'),
    orderId: optionalStringField(raw, 'orderId', 'RelaySponsorResponse'),
  };
}

export function parseHostErrorResponse(
  value: unknown,
  allowedCodes: readonly HostErrorCode[],
  status: number,
): HostErrorResponse {
  const label = 'HostErrorResponse';
  if (!Number.isSafeInteger(status) || status < 400 || status > 599) {
    throw new HostWireParseError(`${label} HTTP status must be an error status`);
  }
  const raw = record(value, label);
  onlyKeys(
    raw,
    [
      'error',
      'code',
      'retryAfterMs',
      'subcode',
      'digest',
      'operationId',
      'minSettleMist',
      'requiredTotalIn',
      'isEstimate',
    ],
    label,
  );

  const retryAfterMs = optionalSafeIntegerField(raw, 'retryAfterMs', label);
  if (retryAfterMs !== undefined && retryAfterMs < 0) {
    throw new HostWireParseError(`${label}.retryAfterMs must be non-negative`);
  }

  const minSettleMist = optionalU64Field(raw, 'minSettleMist', label);
  const requiredTotalIn = optionalU64Field(raw, 'requiredTotalIn', label);
  const isEstimate = optionalBooleanField(raw, 'isEstimate', label);
  const code = nonEmptyStringField(raw, 'code', label);
  if (!isHostErrorCode(code)) {
    throw new HostWireParseError(`${label}.code is not current`);
  }
  if (!allowedCodes.includes(code)) {
    throw new HostWireParseError(`${label}.code is not valid for this route`);
  }
  if (HOST_ERROR_HTTP_STATUS[code] !== status) {
    throw new HostWireParseError(`${label}.code does not match the HTTP status`);
  }
  const error = nonEmptyStringField(raw, 'error', label);
  if (error !== hostErrorPublicMessage(code)) {
    throw new HostWireParseError(`${label}.error does not match the current code`);
  }
  const subcode =
    raw.subcode === undefined ? undefined : nonEmptyStringField(raw, 'subcode', label);
  if (subcode !== undefined && !isHostErrorSubcode(subcode)) {
    throw new HostWireParseError(`${label}.subcode is not current`);
  }

  const presentMetaFields: HostErrorMetaField[] = [];
  if (retryAfterMs !== undefined) presentMetaFields.push('retryAfterMs');
  if (subcode !== undefined) presentMetaFields.push('subcode');
  if (raw.digest !== undefined) presentMetaFields.push('digest');
  if (raw.operationId !== undefined) presentMetaFields.push('operationId');
  if (minSettleMist !== undefined) presentMetaFields.push('minSettleMist');
  if (requiredTotalIn !== undefined) presentMetaFields.push('requiredTotalIn');
  if (isEstimate !== undefined) presentMetaFields.push('isEstimate');

  const metaPolicy = HOST_ERROR_META_POLICY[code];
  const allowedMeta = new Set(metaPolicy?.allowed ?? []);
  if (presentMetaFields.some((field) => !allowedMeta.has(field))) {
    throw new HostWireParseError(`${label}.${code} carries metadata not allowed for the code`);
  }
  if (metaPolicy?.required?.some((field) => !presentMetaFields.includes(field))) {
    throw new HostWireParseError(`${label}.${code} is missing required metadata`);
  }
  if (
    subcode !== undefined &&
    ((metaPolicy?.subcodeKind === 'sponsor' && !isSponsorFailureSubcode(subcode)) ||
      (metaPolicy?.subcodeKind === 'payment_input' && !isPaymentInputIntegritySubcode(subcode)))
  ) {
    throw new HostWireParseError(`${label}.${code} carries the wrong subcode kind`);
  }

  return {
    error,
    code,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(subcode === undefined ? {} : { subcode }),
    ...(raw.digest === undefined ? {} : { digest: nonEmptyStringField(raw, 'digest', label) }),
    ...(raw.operationId === undefined
      ? {}
      : { operationId: nonEmptyStringField(raw, 'operationId', label) }),
    ...(minSettleMist === undefined ? {} : { minSettleMist }),
    ...(requiredTotalIn === undefined ? {} : { requiredTotalIn }),
    ...(isEstimate === undefined ? {} : { isEstimate }),
  };
}

function promotionUnavailableReasonField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): PromotionUnavailableReason | null {
  if (value[key] === null) return null;
  return closedStringField(value, key, label, PROMOTION_UNAVAILABLE_REASONS);
}

function validatePromotionPage<Item>(
  items: readonly Item[],
  promotionIdOf: (item: Item) => string,
  nextCursorValue: unknown,
  label: string,
): string | null {
  if (items.length > PROMOTION_PAGE_MAX_LIMIT) {
    throw new HostWireParseError(
      `${label}.promotions must contain at most ${PROMOTION_PAGE_MAX_LIMIT} items`,
    );
  }
  for (let index = 1; index < items.length; index += 1) {
    if (comparePromotionIds(promotionIdOf(items[index - 1]!), promotionIdOf(items[index]!)) >= 0) {
      throw new HostWireParseError(
        `${label}.promotions must be in strictly ascending promotionId order`,
      );
    }
  }

  const nextCursor =
    nextCursorValue === null ? null : parsePromotionId(nextCursorValue, `${label}.nextCursor`);
  if (
    nextCursor !== null &&
    (items.length === 0 || nextCursor !== promotionIdOf(items[items.length - 1]!))
  ) {
    throw new HostWireParseError(`${label}.nextCursor must equal the final returned promotionId`);
  }
  return nextCursor;
}

function parsePromotionListItem(value: unknown, index: number): PromotionListItem {
  const label = `PromotionListResponse.promotions[${index}]`;
  const raw = record(value, label);
  onlyKeys(
    raw,
    [
      'promotionId',
      'displayName',
      'type',
      'status',
      'canClaim',
      'canUseSponsoredAction',
      'promotionRemainingBudgetMist',
      'remainingParticipantSlots',
      'userRemainingGasAllowanceMist',
      'unavailableReason',
    ],
    label,
  );
  const remainingParticipantSlots = safeIntegerField(raw, 'remainingParticipantSlots', label);
  if (remainingParticipantSlots < 0) {
    throw new HostWireParseError(`${label}.remainingParticipantSlots must be non-negative`);
  }
  return {
    promotionId: promotionIdField(raw, 'promotionId', label),
    displayName: stringField(raw, 'displayName', label),
    type: closedStringField(raw, 'type', label, PROMOTION_TYPES),
    status: closedStringField(raw, 'status', label, PROMOTION_STATUSES),
    canClaim: booleanField(raw, 'canClaim', label),
    canUseSponsoredAction: booleanField(raw, 'canUseSponsoredAction', label),
    promotionRemainingBudgetMist: decimalField(raw, 'promotionRemainingBudgetMist', label),
    remainingParticipantSlots,
    userRemainingGasAllowanceMist: nullableDecimalField(
      raw,
      'userRemainingGasAllowanceMist',
      label,
    ),
    unavailableReason: promotionUnavailableReasonField(raw, 'unavailableReason', label),
  };
}

export function parsePromotionListResponse(value: unknown): PromotionListResponse {
  const label = 'PromotionListResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['promotions', 'nextCursor'], label);
  if (!Array.isArray(raw.promotions)) {
    throw new HostWireParseError(`${label}.promotions must be an array`);
  }
  const promotions = raw.promotions.map((item, index) => parsePromotionListItem(item, index));
  return {
    promotions,
    nextCursor: validatePromotionPage(
      promotions,
      (promotion) => promotion.promotionId,
      raw.nextCursor,
      label,
    ),
  };
}

function parseUserPromotionDetail(value: unknown): UserPromotionDetail {
  const label = 'UserPromotionDetail';
  const raw = record(value, label);
  onlyKeys(
    raw,
    [
      'claimStatus',
      'userRemainingGasAllowanceMist',
      'claimDeadlineAt',
      'useUntilAt',
      'canClaim',
      'canUseSponsoredAction',
      'unavailableReason',
    ],
    label,
  );
  return {
    claimStatus: closedStringField(raw, 'claimStatus', label, PROMOTION_CLAIM_STATUSES),
    userRemainingGasAllowanceMist: nullableDecimalField(
      raw,
      'userRemainingGasAllowanceMist',
      label,
    ),
    claimDeadlineAt: nullableStringField(raw, 'claimDeadlineAt', label),
    useUntilAt: nullableStringField(raw, 'useUntilAt', label),
    canClaim: booleanField(raw, 'canClaim', label),
    canUseSponsoredAction: booleanField(raw, 'canUseSponsoredAction', label),
    unavailableReason: promotionUnavailableReasonField(raw, 'unavailableReason', label),
  };
}

export function parsePromotionDetailResponse(value: unknown): PromotionDetailResponse {
  const label = 'PromotionDetailResponse';
  const raw = record(value, label);
  onlyKeys(
    raw,
    ['promotionId', 'displayName', 'type', 'promotionRemainingBudgetMist', 'detail'],
    label,
  );
  return {
    promotionId: stringField(raw, 'promotionId', label),
    displayName: stringField(raw, 'displayName', label),
    type: closedStringField(raw, 'type', label, PROMOTION_TYPES),
    promotionRemainingBudgetMist: decimalField(raw, 'promotionRemainingBudgetMist', label),
    detail: parseUserPromotionDetail(raw.detail),
  };
}

function parsePromotionEntitlement(value: unknown): PromotionEntitlement {
  const label = 'PromotionEntitlement';
  const raw = record(value, label);
  onlyKeys(
    raw,
    [
      'promotionId',
      'userId',
      'claimedAt',
      'useUntilAt',
      'remainingGasAllowanceMist',
      'consumedGasAllowanceMist',
      'status',
      'activeReservationReceiptId',
      'activeReservationAmountMist',
      'lastUsedAt',
    ],
    label,
  );
  return {
    promotionId: stringField(raw, 'promotionId', label),
    userId: stringField(raw, 'userId', label),
    claimedAt: stringField(raw, 'claimedAt', label),
    useUntilAt: nullableStringField(raw, 'useUntilAt', label),
    remainingGasAllowanceMist: decimalField(raw, 'remainingGasAllowanceMist', label),
    consumedGasAllowanceMist: decimalField(raw, 'consumedGasAllowanceMist', label),
    status: closedStringField(raw, 'status', label, PROMOTION_ENTITLEMENT_STATUSES),
    activeReservationReceiptId: nullableStringField(raw, 'activeReservationReceiptId', label),
    activeReservationAmountMist: nullableDecimalField(raw, 'activeReservationAmountMist', label),
    lastUsedAt: nullableStringField(raw, 'lastUsedAt', label),
  };
}

export function parsePromotionClaimResponse(value: unknown): PromotionClaimResponse {
  const label = 'PromotionClaimResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['entitlement'], label);
  return { entitlement: parsePromotionEntitlement(raw.entitlement) };
}

export function parsePromotionPrepareRequest(value: unknown): PromotionPrepareRequest {
  const raw = record(value, 'PromotionPrepareRequest');
  onlyKeys(raw, ['senderAddress', 'txKindBytes'], 'PromotionPrepareRequest');
  return {
    senderAddress: stringField(raw, 'senderAddress', 'PromotionPrepareRequest'),
    txKindBytes: stringField(raw, 'txKindBytes', 'PromotionPrepareRequest'),
  };
}

export function parsePromotionPrepareResponse(value: unknown): PromotionPrepareResponse {
  const raw = record(value, 'PromotionPrepareResponse');
  onlyKeys(raw, ['txBytes', 'receiptId', 'estimatedGasMist'], 'PromotionPrepareResponse');
  return {
    txBytes: stringField(raw, 'txBytes', 'PromotionPrepareResponse'),
    receiptId: stringField(raw, 'receiptId', 'PromotionPrepareResponse'),
    estimatedGasMist: decimalField(raw, 'estimatedGasMist', 'PromotionPrepareResponse'),
  };
}

export function parsePromotionSponsorRequest(value: unknown): PromotionSponsorRequest {
  const raw = record(value, 'PromotionSponsorRequest');
  onlyKeys(raw, ['receiptId', 'txBytes', 'userSignature'], 'PromotionSponsorRequest');
  return {
    receiptId: stringField(raw, 'receiptId', 'PromotionSponsorRequest'),
    txBytes: stringField(raw, 'txBytes', 'PromotionSponsorRequest'),
    userSignature: stringField(raw, 'userSignature', 'PromotionSponsorRequest'),
  };
}

export function parsePromotionSponsorResponse(value: unknown): PromotionSponsorResponse {
  const raw = record(value, 'PromotionSponsorResponse');
  onlyKeys(raw, ['digest', 'effects', 'actualGasMist'], 'PromotionSponsorResponse');
  if (!Object.prototype.hasOwnProperty.call(raw, 'effects')) {
    throw new HostWireParseError('PromotionSponsorResponse.effects is required');
  }
  return {
    digest: stringField(raw, 'digest', 'PromotionSponsorResponse'),
    effects: raw.effects,
    actualGasMist: decimalField(raw, 'actualGasMist', 'PromotionSponsorResponse'),
  };
}

export function parseAdminAuthChallengeResponse(value: unknown): AdminAuthChallengeResponse {
  const raw = record(value, 'AdminAuthChallengeResponse');
  onlyKeys(raw, ['nonce'], 'AdminAuthChallengeResponse');
  return { nonce: nonEmptyStringField(raw, 'nonce', 'AdminAuthChallengeResponse') };
}

export function parseAdminAuthVerifyRequest(value: unknown): AdminAuthVerifyRequest {
  const raw = record(value, 'AdminAuthVerifyRequest');
  onlyKeys(raw, ['nonce', 'signature', 'address'], 'AdminAuthVerifyRequest');
  return {
    nonce: nonEmptyStringField(raw, 'nonce', 'AdminAuthVerifyRequest'),
    signature: nonEmptyStringField(raw, 'signature', 'AdminAuthVerifyRequest'),
    address: nonEmptyStringField(raw, 'address', 'AdminAuthVerifyRequest'),
  };
}

export function parseAdminAuthSuccessResponse(value: unknown): AdminAuthSuccessResponse {
  const raw = record(value, 'AdminAuthSuccessResponse');
  onlyKeys(raw, ['ok'], 'AdminAuthSuccessResponse');
  if (raw.ok !== true) throw new HostWireParseError('AdminAuthSuccessResponse.ok must be true');
  return { ok: true };
}

export function parseAdminSessionResponse(value: unknown): AdminSessionResponse {
  const label = 'AdminSessionResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['address', 'exp', 'iat'], label);
  return {
    address: nonEmptyStringField(raw, 'address', label),
    exp: nonNegativeSafeIntegerField(raw, 'exp', label),
    iat: nonNegativeSafeIntegerField(raw, 'iat', label),
  };
}

function parseAdminAuditLogEntryAt(value: unknown, label: string): AdminAuditLogEntry {
  const entry = record(value, label);
  onlyKeys(entry, ['ts', 'event', 'ip', 'address', 'reason', 'error', 'detail'], label);
  const address = optionalStringField(entry, 'address', label);
  const reason = optionalStringField(entry, 'reason', label);
  const error = optionalStringField(entry, 'error', label);
  const detail = optionalStringField(entry, 'detail', label);
  return {
    ts: isoStringField(entry, 'ts', label),
    event: nonEmptyStringField(entry, 'event', label),
    ip: nonEmptyStringField(entry, 'ip', label),
    ...(address === undefined ? {} : { address }),
    ...(reason === undefined ? {} : { reason }),
    ...(error === undefined ? {} : { error }),
    ...(detail === undefined ? {} : { detail }),
  };
}

export function parseAdminAuditLogEntry(value: unknown): AdminAuditLogEntry {
  return parseAdminAuditLogEntryAt(value, 'AdminAuditLogEntry');
}

export function parseAdminAuditLogsResponse(value: unknown): AdminAuditLogsResponse {
  const label = 'AdminAuditLogsResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['logs'], label);
  if (!Array.isArray(raw.logs)) {
    throw new HostWireParseError(`${label}.logs must be an array`);
  }
  return {
    logs: raw.logs.map((entryValue, index) =>
      parseAdminAuditLogEntryAt(entryValue, `${label}.logs[${index}]`),
    ),
  };
}

export function parseAdminBlocklistResponse(value: unknown): AdminBlocklistResponse {
  const label = 'AdminBlocklistResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['blocklist'], label);
  if (!Array.isArray(raw.blocklist)) {
    throw new HostWireParseError(`${label}.blocklist must be an array`);
  }
  return {
    blocklist: raw.blocklist.map((entryValue, index) => {
      const entryLabel = `${label}.blocklist[${index}]`;
      const entry = record(entryValue, entryLabel);
      onlyKeys(entry, ['key', 'ttl'], entryLabel);
      const ttl = safeIntegerField(entry, 'ttl', entryLabel);
      if (ttl < -2) {
        throw new HostWireParseError(`${entryLabel}.ttl must be a current Redis TTL`);
      }
      return { key: nonEmptyStringField(entry, 'key', entryLabel), ttl };
    }),
  };
}

export function parseAdminBlocklistDeleteRequest(value: unknown): AdminBlocklistDeleteRequest {
  const label = 'AdminBlocklistDeleteRequest';
  const raw = record(value, label);
  onlyKeys(raw, ['key'], label);
  return { key: nonEmptyStringField(raw, 'key', label) };
}

export function parseAdminBlocklistDeleteResponse(value: unknown): AdminBlocklistDeleteResponse {
  const label = 'AdminBlocklistDeleteResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['ok', 'deleted'], label);
  if (raw.ok !== true) {
    throw new HostWireParseError(`${label}.ok must be true`);
  }
  return { ok: true, deleted: nonEmptyStringField(raw, 'deleted', label) };
}

export function parseAdminStudioResponse(value: unknown): AdminStudioResponse {
  const label = 'AdminStudioResponse';
  const raw = record(value, label);
  const enabled = booleanField(raw, 'enabled', label);
  if (!enabled) {
    onlyKeys(raw, ['enabled'], label);
    return { enabled: false };
  }
  onlyKeys(raw, ['enabled', 'config'], label);
  const configLabel = `${label}.config`;
  const config = record(raw.config, configLabel);
  onlyKeys(config, ['developerJwtTrustConfigured', 'developerJwtVerifyUrlConfigured'], configLabel);
  return {
    enabled: true,
    config: {
      developerJwtTrustConfigured: booleanField(config, 'developerJwtTrustConfigured', configLabel),
      developerJwtVerifyUrlConfigured: booleanField(
        config,
        'developerJwtVerifyUrlConfigured',
        configLabel,
      ),
    },
  };
}

function isoStringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = stringField(value, key, label);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(field);
  if (match === null) {
    throw new HostWireParseError(`${label}.${key} must be an ISO-8601 timestamp`);
  }
  const parsed = Date.parse(field);
  const normalized = `${match[1]!}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new HostWireParseError(`${label}.${key} must be an ISO-8601 timestamp`);
  }
  return field;
}

function nullableIsoStringField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  if (value[key] === null) return null;
  return isoStringField(value, key, label);
}

function optionalNullableIsoStringField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  return nullableIsoStringField(value, key, label);
}

function parseAdminPromotionRecord(value: unknown, label: string): AdminPromotionRecord {
  const raw = record(value, label);
  onlyKeys(
    raw,
    [
      'promotionId',
      'type',
      'displayName',
      'description',
      'status',
      'maxParticipants',
      'perUserGasAllowanceMist',
      'totalRequiredBudgetMist',
      'claimDeadlineAt',
      'postClaimUseWindowMs',
      'startAt',
      'pauseReason',
      'archiveReason',
      'createdAt',
      'updatedAt',
    ],
    label,
  );
  const maxParticipants = positiveSafeIntegerField(raw, 'maxParticipants', label);
  const perUserGasAllowanceMist = positiveU64DecimalField(raw, 'perUserGasAllowanceMist', label);
  const totalRequiredBudgetMist = u64DecimalField(raw, 'totalRequiredBudgetMist', label);
  if (
    BigInt(totalRequiredBudgetMist) !==
    BigInt(maxParticipants) * BigInt(perUserGasAllowanceMist)
  ) {
    throw new HostWireParseError(
      `${label}.totalRequiredBudgetMist must equal maxParticipants * perUserGasAllowanceMist`,
    );
  }
  return {
    promotionId: promotionIdField(raw, 'promotionId', label),
    type: closedStringField(raw, 'type', label, PROMOTION_TYPES),
    displayName: nonEmptyStringField(raw, 'displayName', label),
    description: stringField(raw, 'description', label),
    status: closedStringField(raw, 'status', label, PROMOTION_STATUSES),
    maxParticipants,
    perUserGasAllowanceMist,
    totalRequiredBudgetMist,
    claimDeadlineAt: nullableIsoStringField(raw, 'claimDeadlineAt', label),
    postClaimUseWindowMs: nonNegativeSafeIntegerField(raw, 'postClaimUseWindowMs', label),
    startAt: nullableIsoStringField(raw, 'startAt', label),
    pauseReason: nullableStringField(raw, 'pauseReason', label),
    archiveReason: nullableStringField(raw, 'archiveReason', label),
    createdAt: isoStringField(raw, 'createdAt', label),
    updatedAt: isoStringField(raw, 'updatedAt', label),
  };
}

export function parseAdminPromotionListResponse(value: unknown): AdminPromotionListResponse {
  const label = 'AdminPromotionListResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['promotions', 'nextCursor'], label);
  if (!Array.isArray(raw.promotions)) {
    throw new HostWireParseError(`${label}.promotions must be an array`);
  }
  const promotions = raw.promotions.map((promotion, index) =>
    parseAdminPromotionRecord(promotion, `${label}.promotions[${index}]`),
  );
  return {
    promotions,
    nextCursor: validatePromotionPage(
      promotions,
      (promotion) => promotion.promotionId,
      raw.nextCursor,
      label,
    ),
  };
}

function parseAdminPromotionSummaryAt(value: unknown, label: string): AdminPromotionSummary {
  const raw = record(value, label);
  onlyKeys(
    raw,
    [
      'claimedUsers',
      'remainingParticipantSlots',
      'totalConsumedBudgetMist',
      'totalReservedBudgetMist',
      'totalRemainingBudgetMist',
      'totalRequiredBudgetMist',
    ],
    label,
  );
  return {
    claimedUsers: nonNegativeSafeIntegerField(raw, 'claimedUsers', label),
    remainingParticipantSlots: nonNegativeSafeIntegerField(raw, 'remainingParticipantSlots', label),
    totalConsumedBudgetMist: u64DecimalField(raw, 'totalConsumedBudgetMist', label),
    totalReservedBudgetMist: u64DecimalField(raw, 'totalReservedBudgetMist', label),
    totalRemainingBudgetMist: u64DecimalField(raw, 'totalRemainingBudgetMist', label),
    totalRequiredBudgetMist: u64DecimalField(raw, 'totalRequiredBudgetMist', label),
  };
}

export function parseAdminPromotionDetailResponse(value: unknown): AdminPromotionDetailResponse {
  const label = 'AdminPromotionDetailResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['promotion', 'summary'], label);
  return {
    promotion: parseAdminPromotionRecord(raw.promotion, `${label}.promotion`),
    summary:
      raw.summary === null ? null : parseAdminPromotionSummaryAt(raw.summary, `${label}.summary`),
  };
}

export function parseAdminPromotionUsersResponse(value: unknown): AdminPromotionUsersResponse {
  const label = 'AdminPromotionUsersResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['promotionId', 'users', 'total'], label);
  if (!Array.isArray(raw.users)) {
    throw new HostWireParseError(`${label}.users must be an array`);
  }
  const users = raw.users.map((userValue, index): AdminClaimedUser => {
    const userLabel = `${label}.users[${index}]`;
    const user = record(userValue, userLabel);
    onlyKeys(
      user,
      [
        'userId',
        'claimedAt',
        'remainingGasAllowanceMist',
        'consumedGasAllowanceMist',
        'status',
        'activeReservationReceiptId',
      ],
      userLabel,
    );
    const status =
      user.status === null
        ? null
        : closedStringField(user, 'status', userLabel, PROMOTION_ENTITLEMENT_STATUSES);
    return {
      userId: nonEmptyStringField(user, 'userId', userLabel),
      claimedAt: isoStringField(user, 'claimedAt', userLabel),
      remainingGasAllowanceMist: nullableU64Field(user, 'remainingGasAllowanceMist', userLabel),
      consumedGasAllowanceMist: nullableU64Field(user, 'consumedGasAllowanceMist', userLabel),
      status,
      activeReservationReceiptId: nullableNonEmptyStringField(
        user,
        'activeReservationReceiptId',
        userLabel,
      ),
    };
  });
  const total = nonNegativeSafeIntegerField(raw, 'total', label);
  if (total !== users.length) {
    throw new HostWireParseError(`${label}.total must equal users.length`);
  }
  return {
    promotionId: nonEmptyStringField(raw, 'promotionId', label),
    users,
    total,
  };
}

export function parseAdminPromotionSummaryResponse(value: unknown): AdminPromotionSummaryResponse {
  const label = 'AdminPromotionSummaryResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['promotionId', 'summary'], label);
  return {
    promotionId: nonEmptyStringField(raw, 'promotionId', label),
    summary: parseAdminPromotionSummaryAt(raw.summary, `${label}.summary`),
  };
}

export function parseAdminSettlementSwapPathsResponse(
  value: unknown,
): AdminSettlementSwapPathsResponse {
  const label = 'AdminSettlementSwapPathsResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['count', 'settlementSwapPaths'], label);
  if (!Array.isArray(raw.settlementSwapPaths)) {
    throw new HostWireParseError(`${label}.settlementSwapPaths must be an array`);
  }
  const settlementSwapPaths = raw.settlementSwapPaths.map((pathValue, index) => {
    const pathLabel = `${label}.settlementSwapPaths[${index}]`;
    const path = record(pathValue, pathLabel);
    onlyKeys(
      path,
      [
        'hops',
        'settlementTokenType',
        'settlementTokenSymbol',
        'settlementTokenDecimals',
        'lotSize',
        'minSize',
        'effectiveFeeRateBps',
        'settlementSwapDirection',
        'hopCount',
      ],
      pathLabel,
    );
    const hopCount = nonNegativeSafeIntegerField(path, 'hopCount', pathLabel);
    const currentPath = parseSettlementSwapPath(
      Object.fromEntries(Object.entries(path).filter(([key]) => key !== 'hopCount')),
      index,
    );
    if (hopCount !== currentPath.hops.length) {
      throw new HostWireParseError(`${pathLabel}.hopCount must equal hops.length`);
    }
    return { ...currentPath, hopCount };
  });
  const count = nonNegativeSafeIntegerField(raw, 'count', label);
  if (count !== settlementSwapPaths.length) {
    throw new HostWireParseError(`${label}.count must equal settlementSwapPaths.length`);
  }
  return { count, settlementSwapPaths };
}

export function parseAdminPromotionCreateRequest(value: unknown): AdminPromotionCreateRequest {
  const label = 'AdminPromotionCreateRequest';
  const raw = record(value, label);
  onlyKeys(
    raw,
    [
      'type',
      'displayName',
      'description',
      'maxParticipants',
      'perUserGasAllowanceMist',
      'claimDeadlineAt',
      'postClaimUseWindowMs',
      'startAt',
    ],
    label,
  );
  const description = optionalStringField(raw, 'description', label);
  const claimDeadlineAt = optionalNullableIsoStringField(raw, 'claimDeadlineAt', label);
  const postClaimUseWindowMs = optionalSafeIntegerField(raw, 'postClaimUseWindowMs', label);
  if (postClaimUseWindowMs !== undefined && postClaimUseWindowMs < 0) {
    throw new HostWireParseError(`${label}.postClaimUseWindowMs must be non-negative`);
  }
  const startAt = optionalNullableIsoStringField(raw, 'startAt', label);
  return {
    type: closedStringField(raw, 'type', label, PROMOTION_TYPES),
    displayName: nonEmptyStringField(raw, 'displayName', label),
    maxParticipants: positiveSafeIntegerField(raw, 'maxParticipants', label),
    perUserGasAllowanceMist: positiveU64DecimalField(raw, 'perUserGasAllowanceMist', label),
    ...(description === undefined ? {} : { description }),
    ...(claimDeadlineAt === undefined ? {} : { claimDeadlineAt }),
    ...(postClaimUseWindowMs === undefined ? {} : { postClaimUseWindowMs }),
    ...(startAt === undefined ? {} : { startAt }),
  };
}

export function parseAdminPromotionUpdateRequest(value: unknown): AdminPromotionUpdateRequest {
  const label = 'AdminPromotionUpdateRequest';
  const raw = record(value, label);
  onlyKeys(
    raw,
    [
      'displayName',
      'description',
      'maxParticipants',
      'perUserGasAllowanceMist',
      'claimDeadlineAt',
      'postClaimUseWindowMs',
      'startAt',
    ],
    label,
  );
  const displayName = optionalStringField(raw, 'displayName', label);
  if (displayName !== undefined && displayName.length === 0) {
    throw new HostWireParseError(`${label}.displayName must be non-empty`);
  }
  const description = optionalStringField(raw, 'description', label);
  const maxParticipants = optionalSafeIntegerField(raw, 'maxParticipants', label);
  if (maxParticipants !== undefined && maxParticipants <= 0) {
    throw new HostWireParseError(`${label}.maxParticipants must be positive`);
  }
  const perUserGasAllowanceMist = Object.prototype.hasOwnProperty.call(
    raw,
    'perUserGasAllowanceMist',
  )
    ? positiveU64DecimalField(raw, 'perUserGasAllowanceMist', label)
    : undefined;
  const claimDeadlineAt = optionalNullableIsoStringField(raw, 'claimDeadlineAt', label);
  const postClaimUseWindowMs = optionalSafeIntegerField(raw, 'postClaimUseWindowMs', label);
  if (postClaimUseWindowMs !== undefined && postClaimUseWindowMs < 0) {
    throw new HostWireParseError(`${label}.postClaimUseWindowMs must be non-negative`);
  }
  const startAt = optionalNullableIsoStringField(raw, 'startAt', label);
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(description === undefined ? {} : { description }),
    ...(maxParticipants === undefined ? {} : { maxParticipants }),
    ...(perUserGasAllowanceMist === undefined ? {} : { perUserGasAllowanceMist }),
    ...(claimDeadlineAt === undefined ? {} : { claimDeadlineAt }),
    ...(postClaimUseWindowMs === undefined ? {} : { postClaimUseWindowMs }),
    ...(startAt === undefined ? {} : { startAt }),
  };
}

export function parseAdminPromotionStatusRequest(value: unknown): AdminPromotionStatusRequest {
  const label = 'AdminPromotionStatusRequest';
  const raw = record(value, label);
  onlyKeys(raw, ['status', 'reason'], label);
  const reason = optionalStringField(raw, 'reason', label);
  return {
    status: closedStringField(raw, 'status', label, PROMOTION_STATUSES),
    ...(reason === undefined ? {} : { reason }),
  };
}

export function parseAdminPromotionResponse(value: unknown): AdminPromotionResponse {
  const label = 'AdminPromotionResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['promotion'], label);
  return { promotion: parseAdminPromotionRecord(raw.promotion, `${label}.promotion`) };
}

export function parseAdminPromotionDeleteResponse(value: unknown): AdminPromotionDeleteResponse {
  const label = 'AdminPromotionDeleteResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['ok'], label);
  if (raw.ok !== true) {
    throw new HostWireParseError(`${label}.ok must be true`);
  }
  return { ok: true };
}

const ADMIN_SPONSORED_LOGS_DEFAULT_LIMIT = 50;
const ADMIN_SPONSORED_LOGS_MAX_LIMIT = 200;

/** Parse the exact current Admin sponsored-log query contract. */
export function parseAdminSponsoredLogsQuery(value: unknown): AdminSponsoredLogsQuery {
  const label = 'AdminSponsoredLogsQuery';
  const raw = record(value, label);
  onlyKeys(raw, ['mode', 'limit'], label);
  const modeRaw = raw.mode;
  const mode =
    modeRaw === undefined || modeRaw === ''
      ? 'all'
      : modeRaw === 'all' || modeRaw === 'generic' || modeRaw === 'promotion'
        ? modeRaw
        : null;
  if (mode === null) {
    throw new HostWireParseError(`${label}.mode is not current`);
  }
  const limitRaw = raw.limit;
  if (limitRaw === undefined || limitRaw === '') {
    return { mode, limit: ADMIN_SPONSORED_LOGS_DEFAULT_LIMIT };
  }
  if (typeof limitRaw !== 'string' || !/^[1-9]\d*$/.test(limitRaw)) {
    throw new HostWireParseError(`${label}.limit must be a canonical positive decimal string`);
  }
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit > ADMIN_SPONSORED_LOGS_MAX_LIMIT) {
    throw new HostWireParseError(
      `${label}.limit must be at most ${ADMIN_SPONSORED_LOGS_MAX_LIMIT}`,
    );
  }
  return { mode, limit };
}

function parseAdminSponsoredExecutionAggregate(
  value: unknown,
  label: string,
): AdminSponsoredExecutionAggregate {
  const raw = record(value, label);
  onlyKeys(
    raw,
    ['mode', 'sponsoredExecutions', 'lossCount', 'cumulativeHostNetMist', 'cumulativeLossMist'],
    label,
  );
  const mode = raw.mode;
  if (mode !== 'all' && mode !== 'generic' && mode !== 'promotion') {
    throw new HostWireParseError(`${label}.mode is not current`);
  }
  const sponsoredExecutions = decimalField(raw, 'sponsoredExecutions', label);
  const lossCount = decimalField(raw, 'lossCount', label);
  const cumulativeHostNetMist = signedDecimalField(raw, 'cumulativeHostNetMist', label);
  const cumulativeLossMist = signedDecimalField(raw, 'cumulativeLossMist', label);
  if (BigInt(lossCount) > BigInt(sponsoredExecutions)) {
    throw new HostWireParseError(`${label}.lossCount cannot exceed sponsoredExecutions`);
  }
  if (BigInt(cumulativeLossMist) > 0n) {
    throw new HostWireParseError(`${label}.cumulativeLossMist cannot be positive`);
  }
  return { mode, sponsoredExecutions, lossCount, cumulativeHostNetMist, cumulativeLossMist };
}

function parseAdminSponsoredExecutionLogEntry(
  value: unknown,
  index: number,
): AdminSponsoredExecutionLogEntry {
  const label = `AdminSponsoredLogsResponse.entries[${index}]`;
  const raw = record(value, label);
  onlyKeys(
    raw,
    [
      'createdAt',
      'mode',
      'outcome',
      'receiptId',
      'digest',
      'senderAddress',
      'sponsorAddress',
      'executionPathKey',
      'orderIdHash',
      'promotionId',
      'userId',
      'recoveredGasMist',
      'hostPaidGasMist',
      'hostNetMist',
      'hostFeeMist',
      'protocolFeeMist',
      'grossGasMist',
      'storageRebateMist',
      'economicsStatus',
      'failureReason',
    ],
    label,
  );
  const mode = raw.mode;
  if (mode !== 'generic' && mode !== 'promotion') {
    throw new HostWireParseError(`${label}.mode is not current`);
  }
  const outcome = raw.outcome;
  if (outcome !== 'success' && outcome !== 'onchain_revert' && outcome !== 'internal_error') {
    throw new HostWireParseError(`${label}.outcome is not current`);
  }
  const economicsStatus = raw.economicsStatus;
  if (economicsStatus !== 'known' && economicsStatus !== 'unknown') {
    throw new HostWireParseError(`${label}.economicsStatus is not current`);
  }
  const orderIdHash = nullableNonEmptyStringField(raw, 'orderIdHash', label);
  const promotionId = nullableNonEmptyStringField(raw, 'promotionId', label);
  const userId = nullableNonEmptyStringField(raw, 'userId', label);
  if (mode === 'generic' && (promotionId !== null || userId !== null)) {
    throw new HostWireParseError(`${label} generic mode cannot carry Promotion identity`);
  }
  if (mode === 'promotion' && (promotionId === null || userId === null || orderIdHash !== null)) {
    throw new HostWireParseError(
      `${label} promotion mode requires promotionId/userId and no orderIdHash`,
    );
  }
  const numericFields = [
    'recoveredGasMist',
    'hostPaidGasMist',
    'hostNetMist',
    'hostFeeMist',
    'protocolFeeMist',
    'grossGasMist',
    'storageRebateMist',
  ] as const;
  if (economicsStatus === 'unknown' && numericFields.some((field) => raw[field] !== null)) {
    throw new HostWireParseError(`${label} unknown economics requires null numeric fields`);
  }
  const base: AdminSponsoredExecutionLogEntryBase = {
    createdAt: isoStringField(raw, 'createdAt', label),
    mode,
    outcome,
    receiptId: nonEmptyStringField(raw, 'receiptId', label),
    digest: nullableNonEmptyStringField(raw, 'digest', label),
    senderAddress: nonEmptyStringField(raw, 'senderAddress', label),
    sponsorAddress: nonEmptyStringField(raw, 'sponsorAddress', label),
    executionPathKey: nonEmptyStringField(raw, 'executionPathKey', label),
    orderIdHash,
    promotionId,
    userId,
    failureReason: nullableStringField(raw, 'failureReason', label),
  };
  if (economicsStatus === 'unknown') {
    return {
      ...base,
      economicsStatus,
      recoveredGasMist: null,
      hostPaidGasMist: null,
      hostNetMist: null,
      hostFeeMist: null,
      protocolFeeMist: null,
      grossGasMist: null,
      storageRebateMist: null,
    };
  }
  return {
    ...base,
    economicsStatus,
    recoveredGasMist: u64DecimalField(raw, 'recoveredGasMist', label),
    hostPaidGasMist: u64DecimalField(raw, 'hostPaidGasMist', label),
    hostNetMist: signedU64MagnitudeField(raw, 'hostNetMist', label),
    hostFeeMist: u64DecimalField(raw, 'hostFeeMist', label),
    protocolFeeMist: nullableU64Field(raw, 'protocolFeeMist', label),
    grossGasMist: nullableU64Field(raw, 'grossGasMist', label),
    storageRebateMist: nullableU64Field(raw, 'storageRebateMist', label),
  };
}

export function parseAdminSponsoredLogsSummaryResponse(
  value: unknown,
): AdminSponsoredLogsSummaryResponse {
  const label = 'AdminSponsoredLogsSummaryResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['summary'], label);
  return { summary: parseAdminSponsoredExecutionAggregate(raw.summary, `${label}.summary`) };
}

export function parseAdminSponsoredLogsResponse(value: unknown): AdminSponsoredLogsResponse {
  const label = 'AdminSponsoredLogsResponse';
  const raw = record(value, label);
  onlyKeys(raw, ['summary', 'entries'], label);
  if (!Array.isArray(raw.entries)) {
    throw new HostWireParseError(`${label}.entries must be an array`);
  }
  const summary = parseAdminSponsoredExecutionAggregate(raw.summary, `${label}.summary`);
  const entries = raw.entries.map(parseAdminSponsoredExecutionLogEntry);
  if (summary.mode !== 'all' && entries.some((entry) => entry.mode !== summary.mode)) {
    throw new HostWireParseError(`${label}.entries do not match summary.mode`);
  }
  return { summary, entries };
}

export function parseSponsorRefillAccountWithdrawalChallengeResponse(
  value: unknown,
): SponsorRefillAccountWithdrawalChallengeResponse {
  const raw = record(value, 'SponsorRefillAccountWithdrawalChallengeResponse');
  onlyKeys(raw, ['nonce', 'expiresAt'], 'SponsorRefillAccountWithdrawalChallengeResponse');
  return {
    nonce: nonEmptyStringField(raw, 'nonce', 'SponsorRefillAccountWithdrawalChallengeResponse'),
    expiresAt: isoStringField(raw, 'expiresAt', 'SponsorRefillAccountWithdrawalChallengeResponse'),
  };
}

export function parseSponsorRefillAccountWithdrawalRequest(
  value: unknown,
): SponsorRefillAccountWithdrawalRequest {
  const raw = record(value, 'SponsorRefillAccountWithdrawalRequest');
  onlyKeys(raw, ['nonce', 'signature', 'amountMist'], 'SponsorRefillAccountWithdrawalRequest');
  return {
    nonce: nonEmptyStringField(raw, 'nonce', 'SponsorRefillAccountWithdrawalRequest'),
    signature: nonEmptyStringField(raw, 'signature', 'SponsorRefillAccountWithdrawalRequest'),
    amountMist: positiveU64DecimalField(raw, 'amountMist', 'SponsorRefillAccountWithdrawalRequest'),
  };
}

export function parseSponsorRefillAccountWithdrawalResponse(
  value: unknown,
): SponsorRefillAccountWithdrawalResponse {
  const raw = record(value, 'SponsorRefillAccountWithdrawalResponse');
  onlyKeys(raw, ['digest', 'amountMist', 'recipient'], 'SponsorRefillAccountWithdrawalResponse');
  return {
    digest: nonEmptyStringField(raw, 'digest', 'SponsorRefillAccountWithdrawalResponse'),
    amountMist: u64DecimalField(raw, 'amountMist', 'SponsorRefillAccountWithdrawalResponse'),
    recipient: nonEmptyStringField(raw, 'recipient', 'SponsorRefillAccountWithdrawalResponse'),
  };
}

/** Parse the full current `/api/sponsor-operations` Admin response. */
export function parseAdminSponsorOperationsResponse(
  value: unknown,
): AdminSponsorOperationsResponse {
  const label = 'AdminSponsorOperationsResponse';
  const raw = record(value, label);
  onlyKeys(
    raw,
    [
      'sponsorOperations',
      'primaryAddress',
      'settlementPayoutRecipientAddress',
      'network',
      'sponsorBalanceWarnMist',
      'sponsorBalanceRefillTargetMist',
      'refillEnabled',
      'quotedHostFeeMist',
      'feeConfig',
      'supportedSettlementSwapPaths',
      'onChainIds',
      'studioEnabled',
      'rpcFleet',
    ],
    label,
  );

  const operationsLabel = `${label}.sponsorOperations`;
  const operations = record(raw.sponsorOperations, operationsLabel);
  onlyKeys(
    operations,
    [
      'gateErrorCode',
      'availableSlots',
      'degradedSlots',
      'slotLeases',
      'slots',
      'sponsorRefillAccount',
    ],
    operationsLabel,
  );
  const availableSlots = nonNegativeSafeIntegerField(operations, 'availableSlots', operationsLabel);
  const degradedSlots = nonNegativeSafeIntegerField(operations, 'degradedSlots', operationsLabel);
  const gateErrorCode = operations.gateErrorCode;
  if (
    gateErrorCode !== null &&
    gateErrorCode !== 'SPONSOR_CAPACITY_UNAVAILABLE' &&
    gateErrorCode !== 'SPONSOR_REFILL_ACCOUNT_UNHEALTHY'
  ) {
    throw new HostWireParseError(`${operationsLabel}.gateErrorCode is not current`);
  }

  if (!Array.isArray(operations.slots)) {
    throw new HostWireParseError(`${operationsLabel}.slots must be an array`);
  }
  const slots = operations.slots.map((slotValue, index) => {
    const slotLabel = `${operationsLabel}.slots[${index}]`;
    const slot = record(slotValue, slotLabel);
    onlyKeys(slot, ['address', 'state', 'balanceMist', 'lastObservedAtMs', 'lastError'], slotLabel);
    const state = slot.state;
    if (state !== null && !(SPONSOR_SLOT_STATES as readonly unknown[]).includes(state)) {
      throw new HostWireParseError(`${slotLabel}.state is not current`);
    }
    const lastObservedAtMs = nullableSafeIntegerField(slot, 'lastObservedAtMs', slotLabel);
    if (lastObservedAtMs !== null && lastObservedAtMs < 0) {
      throw new HostWireParseError(`${slotLabel}.lastObservedAtMs must be non-negative`);
    }
    return {
      address: nonEmptyStringField(slot, 'address', slotLabel),
      state: state as (typeof SPONSOR_SLOT_STATES)[number] | null,
      balanceMist: nullableU64Field(slot, 'balanceMist', slotLabel),
      lastObservedAtMs,
      lastError: nullableStringField(slot, 'lastError', slotLabel),
    };
  });

  const leasesLabel = `${operationsLabel}.slotLeases`;
  const leases = record(operations.slotLeases, leasesLabel);
  onlyKeys(leases, ['leasedSlots', 'freeSlots', 'slots'], leasesLabel);
  const leasedSlots = nonNegativeSafeIntegerField(leases, 'leasedSlots', leasesLabel);
  const freeSlots = nonNegativeSafeIntegerField(leases, 'freeSlots', leasesLabel);
  if (!Array.isArray(leases.slots)) {
    throw new HostWireParseError(`${leasesLabel}.slots must be an array`);
  }
  const leaseSlots = leases.slots.map((leaseValue, index) => {
    const leaseLabel = `${leasesLabel}.slots[${index}]`;
    const lease = record(leaseValue, leaseLabel);
    onlyKeys(lease, ['address', 'leased'], leaseLabel);
    return {
      address: nonEmptyStringField(lease, 'address', leaseLabel),
      leased: booleanField(lease, 'leased', leaseLabel),
    };
  });
  if (
    availableSlots + degradedSlots !== slots.length ||
    leasedSlots + freeSlots !== leaseSlots.length ||
    leasedSlots !== leaseSlots.filter((slot) => slot.leased).length ||
    freeSlots !== leaseSlots.filter((slot) => !slot.leased).length ||
    new Set(slots.map((slot) => slot.address)).size !== slots.length ||
    new Set(leaseSlots.map((slot) => slot.address)).size !== leaseSlots.length ||
    slots.some((slot) => !leaseSlots.some((lease) => lease.address === slot.address)) ||
    leaseSlots.some((lease) => !slots.some((slot) => slot.address === lease.address))
  ) {
    throw new HostWireParseError(`${operationsLabel} counts contradict their slots`);
  }

  const refillLabel = `${operationsLabel}.sponsorRefillAccount`;
  const refill = record(operations.sponsorRefillAccount, refillLabel);
  onlyKeys(
    refill,
    ['address', 'balanceMist', 'healthy', 'refillsRemaining', 'lastObservedAtMs', 'lastError'],
    refillLabel,
  );
  const refillsRemaining = nullableSafeIntegerField(refill, 'refillsRemaining', refillLabel);
  const refillObservedAtMs = nullableSafeIntegerField(refill, 'lastObservedAtMs', refillLabel);
  const refillHealthy = booleanField(refill, 'healthy', refillLabel);
  if (
    (refillsRemaining !== null && refillsRemaining < 0) ||
    (refillObservedAtMs !== null && refillObservedAtMs < 0)
  ) {
    throw new HostWireParseError(`${refillLabel} counters must be non-negative`);
  }
  const expectedGateErrorCode =
    availableSlots > 0
      ? null
      : refillHealthy
        ? 'SPONSOR_CAPACITY_UNAVAILABLE'
        : 'SPONSOR_REFILL_ACCOUNT_UNHEALTHY';
  if (gateErrorCode !== expectedGateErrorCode) {
    throw new HostWireParseError(`${operationsLabel}.gateErrorCode contradicts current state`);
  }

  const feeLabel = `${label}.feeConfig`;
  const fee = raw.feeConfig === null ? null : record(raw.feeConfig, feeLabel);
  if (fee !== null) {
    onlyKeys(
      fee,
      ['maxHostFeeMist', 'protocolFlatFeeMist', 'maxClaimMist', 'minSettleMist', 'configVersion'],
      feeLabel,
    );
  }

  if (!Array.isArray(raw.supportedSettlementSwapPaths)) {
    throw new HostWireParseError(`${label}.supportedSettlementSwapPaths must be an array`);
  }
  const supportedSettlementSwapPaths =
    raw.supportedSettlementSwapPaths.map(parseSettlementSwapPath);
  const settlementTokenTypes = new Set<string>();
  for (const path of supportedSettlementSwapPaths) {
    if (settlementTokenTypes.has(path.settlementTokenType)) {
      throw new HostWireParseError(
        `${label}.supportedSettlementSwapPaths has duplicate token type`,
      );
    }
    settlementTokenTypes.add(path.settlementTokenType);
  }

  const idsLabel = `${label}.onChainIds`;
  const onChainIds = record(raw.onChainIds, idsLabel);
  onlyKeys(onChainIds, ['packageId', 'configId', 'vaultRegistryId', 'deepbookPackageId'], idsLabel);

  const fleetLabel = `${label}.rpcFleet`;
  const fleet = record(raw.rpcFleet, fleetLabel);
  onlyKeys(fleet, ['endpoints'], fleetLabel);
  if (!Array.isArray(fleet.endpoints)) {
    throw new HostWireParseError(`${fleetLabel}.endpoints must be an array`);
  }
  const endpoints = fleet.endpoints.map((endpointValue, index) => {
    const endpointLabel = `${fleetLabel}.endpoints[${index}]`;
    const endpoint = record(endpointValue, endpointLabel);
    onlyKeys(endpoint, ['origin', 'role'], endpointLabel);
    if (endpoint.role !== 'primary' && endpoint.role !== 'secondary') {
      throw new HostWireParseError(`${endpointLabel}.role is invalid`);
    }
    const role: 'primary' | 'secondary' = endpoint.role;
    const rawOrigin = nonEmptyStringField(endpoint, 'origin', endpointLabel);
    let origin: string;
    try {
      origin = canonicalizeSuiRpcOrigin(rawOrigin);
    } catch {
      throw new HostWireParseError(`${endpointLabel}.origin is not a current Sui RPC origin`);
    }
    if (origin !== rawOrigin) {
      throw new HostWireParseError(`${endpointLabel}.origin is not canonical`);
    }
    return {
      origin,
      role,
    };
  });
  if (
    endpoints.length === 0 ||
    endpoints[0]?.role !== 'primary' ||
    endpoints.slice(1).some((endpoint) => endpoint.role !== 'secondary')
  ) {
    throw new HostWireParseError(`${fleetLabel}.endpoints must be non-empty and role-ordered`);
  }

  const network = raw.network;
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new HostWireParseError(`${label}.network is invalid`);
  }

  return {
    sponsorOperations: {
      gateErrorCode,
      availableSlots,
      degradedSlots,
      slotLeases: { leasedSlots, freeSlots, slots: leaseSlots },
      slots,
      sponsorRefillAccount: {
        address: nonEmptyStringField(refill, 'address', refillLabel),
        balanceMist: nullableU64Field(refill, 'balanceMist', refillLabel),
        healthy: refillHealthy,
        refillsRemaining,
        lastObservedAtMs: refillObservedAtMs,
        lastError: nullableStringField(refill, 'lastError', refillLabel),
      },
    },
    primaryAddress: nullableNonEmptyStringField(raw, 'primaryAddress', label),
    settlementPayoutRecipientAddress: nonEmptyStringField(
      raw,
      'settlementPayoutRecipientAddress',
      label,
    ),
    network,
    sponsorBalanceWarnMist: u64DecimalField(raw, 'sponsorBalanceWarnMist', label),
    sponsorBalanceRefillTargetMist: u64DecimalField(raw, 'sponsorBalanceRefillTargetMist', label),
    refillEnabled: booleanField(raw, 'refillEnabled', label),
    quotedHostFeeMist: u64DecimalField(raw, 'quotedHostFeeMist', label),
    feeConfig:
      fee === null
        ? null
        : {
            maxHostFeeMist: u64DecimalField(fee, 'maxHostFeeMist', feeLabel),
            protocolFlatFeeMist: u64DecimalField(fee, 'protocolFlatFeeMist', feeLabel),
            maxClaimMist: u64DecimalField(fee, 'maxClaimMist', feeLabel),
            minSettleMist: u64DecimalField(fee, 'minSettleMist', feeLabel),
            configVersion: u64DecimalField(fee, 'configVersion', feeLabel),
          },
    supportedSettlementSwapPaths,
    onChainIds: {
      packageId: nullableNonEmptyStringField(onChainIds, 'packageId', idsLabel),
      configId: nullableNonEmptyStringField(onChainIds, 'configId', idsLabel),
      vaultRegistryId: nullableNonEmptyStringField(onChainIds, 'vaultRegistryId', idsLabel),
      deepbookPackageId: nullableNonEmptyStringField(onChainIds, 'deepbookPackageId', idsLabel),
    },
    studioEnabled: booleanField(raw, 'studioEnabled', label),
    rpcFleet: { endpoints },
  };
}
