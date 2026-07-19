import {
  isValidSuiAddress,
  isValidTransactionDigest,
  normalizeSuiAddress,
} from '@mysten/sui/utils';
import { isReceiptId, isValidStudioUserId, parsePromotionId } from '@stelis/contracts';
import type {
  SponsorExecutionStage,
  SponsorResultEconomics,
  SponsorResultMetadata,
  SponsorResultOutcome,
  SponsorResultRoute,
} from '../handlers/sponsorResult.js';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const UNSIGNED_DECIMAL_RE = /^(?:0|[1-9]\d*)$/;
const SIGNED_DECIMAL_RE = /^(?:0|-?[1-9]\d*)$/;
const U64_MAX = (1n << 64n) - 1n;

export const SPONSORED_EXECUTION_REDIS_KEY_PREFIX = 'stelis:{sponsored-execution}:';

export function sponsoredExecutionPreparedRecordKeyPrefix(
  keyPrefix: string = SPONSORED_EXECUTION_REDIS_KEY_PREFIX,
): string {
  return `${keyPrefix}prepared:`;
}

export class SponsoredExecutionRecordCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SponsoredExecutionRecordCorruptionError';
  }
}

export interface GenericExecutionRecoveryContext {
  readonly route: 'generic';
  readonly senderAddress: string;
  readonly executionPathKey: string;
  readonly orderIdHash: string | null;
  readonly recoveredGasMist: string;
  readonly hostFeeMist: string;
  readonly protocolFeeMist: string;
}

export interface PromotionExecutionRecoveryContext {
  readonly route: 'promotion';
  readonly senderAddress: string;
  readonly executionPathKey: string;
  readonly promotionId: string;
  readonly userId: string;
  readonly reservedGasMist: string;
}

export type SponsoredExecutionRecoveryContext =
  | GenericExecutionRecoveryContext
  | PromotionExecutionRecoveryContext;

/**
 * Durable state written immediately before the sponsor signature is issued.
 *
 * The record deliberately does not contain a user signature or a sponsor
 * signature. Recovery never submits again; it only looks up the one digest
 * calculated from the already validated TransactionData BCS bytes.
 */
export interface ExecutingSponsoredExecutionRecord {
  readonly state: 'executing';
  readonly receiptId: string;
  readonly sponsorAddress: string;
  readonly txBytesHash: string;
  readonly transactionDigest: string;
  readonly deadlineMs: number;
  readonly recovery: SponsoredExecutionRecoveryContext;
}

/** Current durable final result. Callback delivery is at-least-once. */
export interface FinalSponsoredExecutionRecord {
  readonly state: 'final';
  readonly receiptId: string;
  readonly sponsorAddress: string;
  readonly transactionDigest: string | null;
  readonly finalizedAtMs: number;
  readonly callbackDelivery: 'pending' | 'delivered';
  readonly result: StoredSponsorResult;
}

export type SponsoredExecutionRecord =
  | ExecutingSponsoredExecutionRecord
  | FinalSponsoredExecutionRecord;

/**
 * Canonical executing-record JSON split around its one Redis-authored
 * `deadlineMs` value. Redis inserts only the decimal deadline; this module
 * remains the sole owner of the record field set and serialization order.
 */
export interface ExecutingSponsoredExecutionRecordParts {
  readonly prefix: string;
  readonly suffix: string;
}

/**
 * JSON-safe form of SponsorResultMetadata. Optional digest is represented by
 * an explicit null so the stored record has one exact current field set.
 */
export interface StoredSponsorResult {
  readonly sponsorAddress: string;
  readonly outcome: SponsorResultOutcome;
  readonly executionStage: SponsorExecutionStage;
  readonly route: SponsorResultRoute;
  readonly digest: string | null;
  readonly receiptId: string;
  readonly senderAddress: string;
  readonly executionPathKey: string;
  readonly orderIdHash: string | null;
  readonly promotionId: string | null;
  readonly userId: string | null;
  readonly economics: SponsorResultEconomics;
}

const EXECUTING_KEYS = [
  'state',
  'receiptId',
  'sponsorAddress',
  'txBytesHash',
  'transactionDigest',
  'deadlineMs',
  'recovery',
] as const;

const FINAL_KEYS = [
  'state',
  'receiptId',
  'sponsorAddress',
  'transactionDigest',
  'finalizedAtMs',
  'callbackDelivery',
  'result',
] as const;

const GENERIC_RECOVERY_KEYS = [
  'route',
  'senderAddress',
  'executionPathKey',
  'orderIdHash',
  'recoveredGasMist',
  'hostFeeMist',
  'protocolFeeMist',
] as const;

const PROMOTION_RECOVERY_KEYS = [
  'route',
  'senderAddress',
  'executionPathKey',
  'promotionId',
  'userId',
  'reservedGasMist',
] as const;

const RESULT_KEYS = [
  'sponsorAddress',
  'outcome',
  'executionStage',
  'route',
  'digest',
  'receiptId',
  'senderAddress',
  'executionPathKey',
  'orderIdHash',
  'promotionId',
  'userId',
  'economics',
] as const;

const UNKNOWN_ECONOMICS_KEYS = ['economicsStatus', 'failureReason'] as const;
const KNOWN_ECONOMICS_KEYS = [
  'economicsStatus',
  'recoveredGasMist',
  'hostPaidGasMist',
  'hostFeeMist',
  'hostNetMist',
  'grossGasMist',
  'storageRebateMist',
  'protocolFeeMist',
  'failureReason',
] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SponsoredExecutionRecordCorruptionError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length) {
    throw new SponsoredExecutionRecordCorruptionError(`${label} has an unexpected field set`);
  }
  const expectedSet = new Set(expected);
  for (const key of actual) {
    if (!expectedSet.has(key)) {
      throw new SponsoredExecutionRecordCorruptionError(`${label} has an unexpected field: ${key}`);
    }
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SponsoredExecutionRecordCorruptionError(`${label} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

function safeTime(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new SponsoredExecutionRecordCorruptionError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function receiptId(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!isReceiptId(parsed)) {
    throw new SponsoredExecutionRecordCorruptionError(`${label} must be a canonical receipt ID`);
  }
  return parsed;
}

function address(value: unknown, label: string): string {
  const parsed = string(value, label);
  const normalized = normalizeSuiAddress(parsed);
  if (normalized !== parsed || !isValidSuiAddress(normalized)) {
    throw new SponsoredExecutionRecordCorruptionError(`${label} must be a canonical Sui address`);
  }
  return parsed;
}

function sha256(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!SHA256_HEX_RE.test(parsed)) {
    throw new SponsoredExecutionRecordCorruptionError(`${label} must be a SHA-256 hex string`);
  }
  return parsed;
}

function transactionDigest(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!isValidTransactionDigest(parsed)) {
    throw new SponsoredExecutionRecordCorruptionError(
      `${label} must be a valid Sui transaction digest`,
    );
  }
  return parsed;
}

function unsignedDecimal(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!UNSIGNED_DECIMAL_RE.test(parsed) || BigInt(parsed) > U64_MAX) {
    throw new SponsoredExecutionRecordCorruptionError(
      `${label} must be a canonical u64 decimal string`,
    );
  }
  return parsed;
}

function signedDecimal(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!SIGNED_DECIMAL_RE.test(parsed)) {
    throw new SponsoredExecutionRecordCorruptionError(
      `${label} must be a canonical signed decimal string`,
    );
  }
  return parsed;
}

function nullableUnsignedDecimal(value: unknown, label: string): string | null {
  if (value === null) return null;
  return unsignedDecimal(value, label);
}

function nullableSha256(value: unknown, label: string): string | null {
  if (value === null) return null;
  return sha256(value, label);
}

function parseRecovery(value: unknown): SponsoredExecutionRecoveryContext {
  const raw = record(value, 'Sponsored execution recovery context');
  if (raw.route === 'generic') {
    exactKeys(raw, GENERIC_RECOVERY_KEYS, 'Generic execution recovery context');
    return {
      route: 'generic',
      senderAddress: address(raw.senderAddress, 'Generic recovery senderAddress'),
      executionPathKey: string(raw.executionPathKey, 'Generic recovery executionPathKey'),
      orderIdHash: nullableSha256(raw.orderIdHash, 'Generic recovery orderIdHash'),
      recoveredGasMist: unsignedDecimal(raw.recoveredGasMist, 'Generic recovery recoveredGasMist'),
      hostFeeMist: unsignedDecimal(raw.hostFeeMist, 'Generic recovery hostFeeMist'),
      protocolFeeMist: unsignedDecimal(raw.protocolFeeMist, 'Generic recovery protocolFeeMist'),
    };
  }
  if (raw.route === 'promotion') {
    exactKeys(raw, PROMOTION_RECOVERY_KEYS, 'Promotion execution recovery context');
    const promotionId = string(raw.promotionId, 'Promotion recovery promotionId');
    try {
      parsePromotionId(promotionId);
    } catch {
      throw new SponsoredExecutionRecordCorruptionError(
        'Promotion recovery promotionId must be current',
      );
    }
    const userId = string(raw.userId, 'Promotion recovery userId');
    if (!isValidStudioUserId(userId)) {
      throw new SponsoredExecutionRecordCorruptionError('Promotion recovery userId is invalid');
    }
    return {
      route: 'promotion',
      senderAddress: address(raw.senderAddress, 'Promotion recovery senderAddress'),
      executionPathKey: string(raw.executionPathKey, 'Promotion recovery executionPathKey'),
      promotionId,
      userId,
      reservedGasMist: unsignedDecimal(raw.reservedGasMist, 'Promotion recovery reservedGasMist'),
    };
  }
  throw new SponsoredExecutionRecordCorruptionError(
    'Sponsored execution recovery context has an unknown route',
  );
}

function parseEconomics(value: unknown): SponsorResultEconomics {
  const raw = record(value, 'Sponsor result economics');
  if (raw.economicsStatus === 'unknown') {
    exactKeys(raw, UNKNOWN_ECONOMICS_KEYS, 'Unknown sponsor result economics');
    return {
      economicsStatus: 'unknown',
      failureReason: nullableString(raw.failureReason, 'Sponsor result failureReason'),
    };
  }
  if (raw.economicsStatus !== 'known') {
    throw new SponsoredExecutionRecordCorruptionError(
      'Sponsor result economics has an unknown status',
    );
  }
  exactKeys(raw, KNOWN_ECONOMICS_KEYS, 'Known sponsor result economics');
  const recoveredGasMist = unsignedDecimal(raw.recoveredGasMist, 'recoveredGasMist');
  const hostPaidGasMist = unsignedDecimal(raw.hostPaidGasMist, 'hostPaidGasMist');
  const hostFeeMist = unsignedDecimal(raw.hostFeeMist, 'hostFeeMist');
  const hostNetMist = signedDecimal(raw.hostNetMist, 'hostNetMist');
  const grossGasMist = nullableUnsignedDecimal(raw.grossGasMist, 'grossGasMist');
  const storageRebateMist = nullableUnsignedDecimal(raw.storageRebateMist, 'storageRebateMist');
  if (
    BigInt(hostNetMist) !==
    BigInt(recoveredGasMist) + BigInt(hostFeeMist) - BigInt(hostPaidGasMist)
  ) {
    throw new SponsoredExecutionRecordCorruptionError(
      'Known sponsor result economics does not satisfy hostNetMist = recoveredGasMist + hostFeeMist - hostPaidGasMist',
    );
  }
  if ((grossGasMist === null) !== (storageRebateMist === null)) {
    throw new SponsoredExecutionRecordCorruptionError(
      'Known sponsor result economics must store gross gas and storage rebate together',
    );
  }
  if (grossGasMist !== null && storageRebateMist !== null) {
    const rawHostPaid = BigInt(grossGasMist) - BigInt(storageRebateMist);
    const expectedHostPaid = rawHostPaid > 0n ? rawHostPaid : 0n;
    if (BigInt(hostPaidGasMist) !== expectedHostPaid) {
      throw new SponsoredExecutionRecordCorruptionError(
        'Known sponsor result economics does not match gross gas and storage rebate',
      );
    }
  }
  return {
    economicsStatus: 'known',
    recoveredGasMist,
    hostPaidGasMist,
    hostFeeMist,
    hostNetMist,
    grossGasMist,
    storageRebateMist,
    protocolFeeMist: nullableUnsignedDecimal(raw.protocolFeeMist, 'protocolFeeMist'),
    failureReason: nullableString(raw.failureReason, 'failureReason'),
  };
}

function parseOutcome(value: unknown): SponsorResultOutcome {
  if (
    value === 'success' ||
    value === 'onchain_revert' ||
    value === 'preflight_failure' ||
    value === 'congestion' ||
    value === 'validation_failure' ||
    value === 'internal_error'
  ) {
    return value;
  }
  throw new SponsoredExecutionRecordCorruptionError('Sponsor result outcome is invalid');
}

function parseStage(value: unknown): SponsorExecutionStage {
  if (
    value === 'before_sponsor_signature' ||
    value === 'after_sponsor_signature' ||
    value === 'on_chain'
  ) {
    return value;
  }
  throw new SponsoredExecutionRecordCorruptionError('Sponsor result executionStage is invalid');
}

function parseStoredResult(value: unknown): StoredSponsorResult {
  const raw = record(value, 'Stored sponsor result');
  exactKeys(raw, RESULT_KEYS, 'Stored sponsor result');
  const route = raw.route;
  if (route !== 'generic' && route !== 'promotion') {
    throw new SponsoredExecutionRecordCorruptionError('Stored sponsor result route is invalid');
  }
  const promotionId = nullableString(raw.promotionId, 'Stored sponsor result promotionId');
  const userId = nullableString(raw.userId, 'Stored sponsor result userId');
  if (route === 'generic' && (promotionId !== null || userId !== null)) {
    throw new SponsoredExecutionRecordCorruptionError(
      'Generic sponsor result must not contain Promotion identity',
    );
  }
  if (route === 'promotion') {
    if (promotionId === null || userId === null || !isValidStudioUserId(userId)) {
      throw new SponsoredExecutionRecordCorruptionError(
        'Promotion sponsor result identity is incomplete',
      );
    }
    try {
      parsePromotionId(promotionId);
    } catch {
      throw new SponsoredExecutionRecordCorruptionError(
        'Promotion sponsor result promotionId must be current',
      );
    }
  }
  const parsed: StoredSponsorResult = {
    sponsorAddress: address(raw.sponsorAddress, 'Stored sponsor result sponsorAddress'),
    outcome: parseOutcome(raw.outcome),
    executionStage: parseStage(raw.executionStage),
    route,
    digest:
      raw.digest === null ? null : transactionDigest(raw.digest, 'Stored sponsor result digest'),
    receiptId: receiptId(raw.receiptId, 'Stored sponsor result receiptId'),
    senderAddress: address(raw.senderAddress, 'Stored sponsor result senderAddress'),
    executionPathKey: string(raw.executionPathKey, 'Stored sponsor result executionPathKey'),
    orderIdHash: nullableSha256(raw.orderIdHash, 'Stored sponsor result orderIdHash'),
    promotionId,
    userId,
    economics: parseEconomics(raw.economics),
  };
  if (parsed.executionStage === 'before_sponsor_signature' && parsed.digest !== null) {
    throw new SponsoredExecutionRecordCorruptionError(
      'A result before the sponsor signature must not contain a transaction digest',
    );
  }
  if (parsed.executionStage !== 'before_sponsor_signature' && parsed.digest === null) {
    throw new SponsoredExecutionRecordCorruptionError(
      'A result after the sponsor signature must contain its transaction digest',
    );
  }
  if (route === 'promotion' && parsed.orderIdHash !== null) {
    throw new SponsoredExecutionRecordCorruptionError(
      'Promotion sponsor result must not contain an orderIdHash',
    );
  }
  if (
    (parsed.outcome === 'success' || parsed.outcome === 'onchain_revert') &&
    (parsed.executionStage !== 'on_chain' || parsed.digest === null)
  ) {
    throw new SponsoredExecutionRecordCorruptionError(
      `${parsed.outcome} sponsor result must contain an on-chain digest`,
    );
  }
  if (
    parsed.outcome === 'congestion' &&
    (parsed.executionStage !== 'after_sponsor_signature' || parsed.digest === null)
  ) {
    throw new SponsoredExecutionRecordCorruptionError(
      'Congestion sponsor result must contain its submitted transaction digest',
    );
  }
  if (
    (parsed.outcome === 'preflight_failure' || parsed.outcome === 'validation_failure') &&
    (parsed.executionStage !== 'before_sponsor_signature' || parsed.digest !== null)
  ) {
    throw new SponsoredExecutionRecordCorruptionError(
      `${parsed.outcome} sponsor result must precede the sponsor signature`,
    );
  }
  return parsed;
}

export function parseSponsoredExecutionRecord(value: unknown): SponsoredExecutionRecord {
  const raw = record(value, 'Sponsored execution record');
  if (raw.state === 'executing') {
    exactKeys(raw, EXECUTING_KEYS, 'Executing sponsored execution record');
    return {
      state: 'executing',
      receiptId: receiptId(raw.receiptId, 'Executing record receiptId'),
      sponsorAddress: address(raw.sponsorAddress, 'Executing record sponsorAddress'),
      txBytesHash: sha256(raw.txBytesHash, 'Executing record txBytesHash'),
      transactionDigest: transactionDigest(
        raw.transactionDigest,
        'Executing record transactionDigest',
      ),
      deadlineMs: safeTime(raw.deadlineMs, 'Executing record deadlineMs'),
      recovery: parseRecovery(raw.recovery),
    };
  }
  if (raw.state === 'final') {
    exactKeys(raw, FINAL_KEYS, 'Final sponsored execution record');
    const callbackDelivery = raw.callbackDelivery;
    if (callbackDelivery !== 'pending' && callbackDelivery !== 'delivered') {
      throw new SponsoredExecutionRecordCorruptionError('Final record callbackDelivery is invalid');
    }
    const result = parseStoredResult(raw.result);
    const storedReceiptId = receiptId(raw.receiptId, 'Final record receiptId');
    const sponsorAddress = address(raw.sponsorAddress, 'Final record sponsorAddress');
    const storedTransactionDigest =
      raw.transactionDigest === null
        ? null
        : transactionDigest(raw.transactionDigest, 'Final record transactionDigest');
    if (
      result.receiptId !== storedReceiptId ||
      result.sponsorAddress !== sponsorAddress ||
      (result.digest !== null && result.digest !== storedTransactionDigest) ||
      (result.executionStage !== 'before_sponsor_signature' && storedTransactionDigest === null)
    ) {
      throw new SponsoredExecutionRecordCorruptionError(
        'Final record identity does not match its stored sponsor result',
      );
    }
    return {
      state: 'final',
      receiptId: storedReceiptId,
      sponsorAddress,
      transactionDigest: storedTransactionDigest,
      finalizedAtMs: safeTime(raw.finalizedAtMs, 'Final record finalizedAtMs'),
      callbackDelivery,
      result,
    };
  }
  throw new SponsoredExecutionRecordCorruptionError(
    'Sponsored execution record has an unknown state',
  );
}

export function serializeSponsoredExecutionRecord(recordValue: SponsoredExecutionRecord): string {
  return JSON.stringify(parseSponsoredExecutionRecord(recordValue));
}

export function createExecutingSponsoredExecutionRecordParts(
  recordValue: Omit<ExecutingSponsoredExecutionRecord, 'deadlineMs'>,
): ExecutingSponsoredExecutionRecordParts {
  const serialized = serializeSponsoredExecutionRecord({ ...recordValue, deadlineMs: 1 });
  const marker = '"deadlineMs":1';
  const markerStart = serialized.indexOf(marker);
  if (markerStart < 0 || serialized.indexOf(marker, markerStart + marker.length) >= 0) {
    throw new SponsoredExecutionRecordCorruptionError(
      'Executing record must contain exactly one deadlineMs field',
    );
  }
  const valueStart = markerStart + '"deadlineMs":'.length;
  return Object.freeze({
    prefix: serialized.slice(0, valueStart),
    suffix: serialized.slice(markerStart + marker.length),
  });
}

export function materializeExecutingSponsoredExecutionRecord(
  parts: ExecutingSponsoredExecutionRecordParts,
  deadlineMs: number,
): { readonly raw: string; readonly record: ExecutingSponsoredExecutionRecord } {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new SponsoredExecutionRecordCorruptionError(
      'Executing record deadlineMs must be a positive safe integer',
    );
  }
  const raw = `${parts.prefix}${deadlineMs}${parts.suffix}`;
  const record = decodeSponsoredExecutionRecord(raw);
  if (record.state !== 'executing') {
    throw new SponsoredExecutionRecordCorruptionError(
      'Executing record deadline parts produced the wrong record state',
    );
  }
  return Object.freeze({ raw, record });
}

export function decodeSponsoredExecutionRecord(serialized: string): SponsoredExecutionRecord {
  if (typeof serialized !== 'string' || serialized.length === 0) {
    throw new SponsoredExecutionRecordCorruptionError(
      'Sponsored execution record must be non-empty JSON',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new SponsoredExecutionRecordCorruptionError(
      'Sponsored execution record must be valid JSON',
    );
  }
  const current = parseSponsoredExecutionRecord(parsed);
  if (serializeSponsoredExecutionRecord(current) !== serialized) {
    throw new SponsoredExecutionRecordCorruptionError(
      'Sponsored execution record must use canonical JSON',
    );
  }
  return current;
}

export function storeSponsorResult(metadata: SponsorResultMetadata): StoredSponsorResult {
  return parseStoredResult({ ...metadata, digest: metadata.digest ?? null });
}

/** Canonical equality between one stored result and current callback metadata. */
export function storedSponsorResultMatchesMetadata(
  stored: StoredSponsorResult,
  metadata: SponsorResultMetadata,
): boolean {
  return JSON.stringify(parseStoredResult(stored)) === JSON.stringify(storeSponsorResult(metadata));
}

export function sponsorResultMetadata(recordValue: StoredSponsorResult): SponsorResultMetadata {
  const current = parseStoredResult(recordValue);
  return {
    sponsorAddress: current.sponsorAddress,
    outcome: current.outcome,
    executionStage: current.executionStage,
    route: current.route,
    ...(current.digest === null ? {} : { digest: current.digest }),
    receiptId: current.receiptId,
    senderAddress: current.senderAddress,
    executionPathKey: current.executionPathKey,
    orderIdHash: current.orderIdHash,
    promotionId: current.promotionId,
    userId: current.userId,
    economics: current.economics,
  };
}
