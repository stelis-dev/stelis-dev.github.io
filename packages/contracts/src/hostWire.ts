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
  isHostErrorCode,
  isHostErrorSubcode,
  isPaymentInputIntegritySubcode,
  isSponsorFailureSubcode,
  type HostErrorCode,
  type HostErrorMetaField,
  type HostErrorSubcode,
} from './hostError.js';

const DECIMAL_RE = /^(?:0|[1-9]\d*)$/;

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
  code?: HostErrorCode;
  retryAfterMs?: number;
  subcode?: HostErrorSubcode;
  digest?: string;
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

function nullableDecimalField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  if (value[key] === null) return null;
  return decimalField(value, key, label);
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

function decimalField(value: Record<string, unknown>, key: string, label: string): string {
  const field = stringField(value, key, label);
  if (!DECIMAL_RE.test(field)) {
    throw new HostWireParseError(`${label}.${key} must be a canonical non-negative decimal string`);
  }
  return field;
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

  const minSettleMist = optionalDecimalField(raw, 'minSettleMist', label);
  const requiredTotalIn = optionalDecimalField(raw, 'requiredTotalIn', label);
  const isEstimate = optionalBooleanField(raw, 'isEstimate', label);
  const code = raw.code === undefined ? undefined : nonEmptyStringField(raw, 'code', label);
  if (code !== undefined && !isHostErrorCode(code)) {
    throw new HostWireParseError(`${label}.code is not current`);
  }
  if (code !== undefined && !allowedCodes.includes(code)) {
    throw new HostWireParseError(`${label}.code is not valid for this route`);
  }
  if (code !== undefined && HOST_ERROR_HTTP_STATUS[code] !== status) {
    throw new HostWireParseError(`${label}.code does not match the HTTP status`);
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
  if (minSettleMist !== undefined) presentMetaFields.push('minSettleMist');
  if (requiredTotalIn !== undefined) presentMetaFields.push('requiredTotalIn');
  if (isEstimate !== undefined) presentMetaFields.push('isEstimate');

  if (code === undefined) {
    if (status !== 429 && status !== 500 && status !== 503) {
      throw new HostWireParseError(`${label} domain-status response must carry a current code`);
    }
    const allowedUncodedMeta = status === 429 ? new Set(['retryAfterMs']) : new Set<string>();
    if (presentMetaFields.some((field) => !allowedUncodedMeta.has(field))) {
      throw new HostWireParseError(`${label} uncoded response carries code-specific metadata`);
    }
  } else {
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
  }

  return {
    error: nonEmptyStringField(raw, 'error', label),
    ...(code === undefined ? {} : { code }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(subcode === undefined ? {} : { subcode }),
    ...(raw.digest === undefined ? {} : { digest: nonEmptyStringField(raw, 'digest', label) }),
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
    promotionId: stringField(raw, 'promotionId', label),
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
  onlyKeys(raw, ['promotions'], label);
  if (!Array.isArray(raw.promotions)) {
    throw new HostWireParseError(`${label}.promotions must be an array`);
  }
  return {
    promotions: raw.promotions.map((item, index) => parsePromotionListItem(item, index)),
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
  return { nonce: stringField(raw, 'nonce', 'AdminAuthChallengeResponse') };
}

export function parseAdminAuthVerifyRequest(value: unknown): AdminAuthVerifyRequest {
  const raw = record(value, 'AdminAuthVerifyRequest');
  onlyKeys(raw, ['nonce', 'signature', 'address'], 'AdminAuthVerifyRequest');
  return {
    nonce: stringField(raw, 'nonce', 'AdminAuthVerifyRequest'),
    signature: stringField(raw, 'signature', 'AdminAuthVerifyRequest'),
    address: stringField(raw, 'address', 'AdminAuthVerifyRequest'),
  };
}

export function parseAdminAuthSuccessResponse(value: unknown): AdminAuthSuccessResponse {
  const raw = record(value, 'AdminAuthSuccessResponse');
  onlyKeys(raw, ['ok'], 'AdminAuthSuccessResponse');
  if (raw.ok !== true) throw new HostWireParseError('AdminAuthSuccessResponse.ok must be true');
  return { ok: true };
}

export function parseSponsorRefillAccountWithdrawalChallengeResponse(
  value: unknown,
): SponsorRefillAccountWithdrawalChallengeResponse {
  const raw = record(value, 'SponsorRefillAccountWithdrawalChallengeResponse');
  onlyKeys(raw, ['nonce', 'expiresAt'], 'SponsorRefillAccountWithdrawalChallengeResponse');
  return {
    nonce: stringField(raw, 'nonce', 'SponsorRefillAccountWithdrawalChallengeResponse'),
    expiresAt: stringField(raw, 'expiresAt', 'SponsorRefillAccountWithdrawalChallengeResponse'),
  };
}

export function parseSponsorRefillAccountWithdrawalRequest(
  value: unknown,
): SponsorRefillAccountWithdrawalRequest {
  const raw = record(value, 'SponsorRefillAccountWithdrawalRequest');
  onlyKeys(raw, ['nonce', 'signature', 'amountMist'], 'SponsorRefillAccountWithdrawalRequest');
  return {
    nonce: stringField(raw, 'nonce', 'SponsorRefillAccountWithdrawalRequest'),
    signature: stringField(raw, 'signature', 'SponsorRefillAccountWithdrawalRequest'),
    amountMist: stringField(raw, 'amountMist', 'SponsorRefillAccountWithdrawalRequest'),
  };
}

export function parseSponsorRefillAccountWithdrawalResponse(
  value: unknown,
): SponsorRefillAccountWithdrawalResponse {
  const raw = record(value, 'SponsorRefillAccountWithdrawalResponse');
  onlyKeys(raw, ['digest', 'amountMist', 'recipient'], 'SponsorRefillAccountWithdrawalResponse');
  return {
    digest: stringField(raw, 'digest', 'SponsorRefillAccountWithdrawalResponse'),
    amountMist: decimalField(raw, 'amountMist', 'SponsorRefillAccountWithdrawalResponse'),
    recipient: stringField(raw, 'recipient', 'SponsorRefillAccountWithdrawalResponse'),
  };
}
