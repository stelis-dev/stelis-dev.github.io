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

const DECIMAL_RE = /^(?:0|[1-9]\d*)$/;

export class HostWireParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostWireParseError';
  }
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
    throw new HostWireParseError(`${label}.${unexpected} is not a current field`);
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
