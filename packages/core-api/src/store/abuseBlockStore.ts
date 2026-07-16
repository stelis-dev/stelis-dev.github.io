import { TextDecoder } from 'node:util';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';
import {
  ADMIN_BLOCKLIST_CURSOR_MAX_LENGTH,
  ADMIN_BLOCKLIST_MAX_LIMIT,
  ABUSE_BLOCK_REASONS,
  ABUSE_BLOCK_SCOPES,
  isValidStudioUserId,
  STUDIO_USER_ID_MAX_LENGTH,
  type AbuseBlockReason,
  type AdminBlocklistDeleteRequest,
  type AdminBlocklistParams,
  type AdminBlockScope,
} from '@stelis/contracts';
import { canonicalizeIpAddress } from '../clientIp.js';
import type { AbuseBlockerAdapter, AbuseSubject } from './abuseBlockTypes.js';

export const ABUSE_BLOCK_EXPIRY_BATCH_SIZE = 100;
export const ABUSE_BLOCK_EXPIRY_INTERVAL_MS = 60_000;
export const ABUSE_BLOCK_RECORD_PREFIX = 'stelis:abuse:block:record:';

const CURSOR_DECODER = new TextDecoder('utf-8', { fatal: true });

export class AbuseBlockInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbuseBlockInputError';
  }
}

export class AbuseBlockStorageCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbuseBlockStorageCorruptionError';
  }
}

export class AbuseBlockCurrentConflictError extends Error {
  constructor(operation: 'set' | 'remove') {
    super(`Abuse block changed during ${operation}`);
    this.name = 'AbuseBlockCurrentConflictError';
  }
}

export type AbuseBlockIdentity = AdminBlocklistDeleteRequest;

export interface AbuseBlockRecord {
  readonly identity: AbuseBlockIdentity;
  readonly reason: AbuseBlockReason;
  readonly blockedUntilMs: number;
}

export type AbuseBlockPageParams = AdminBlocklistParams;

export interface AbuseBlockPage {
  readonly blocks: readonly AbuseBlockRecord[];
  readonly nextCursor: string | null;
}

export interface AbuseBlockStore extends AbuseBlockerAdapter {
  listBlocks(params: AbuseBlockPageParams): Promise<AbuseBlockPage>;
  removeBlock(identity: AbuseBlockIdentity): Promise<boolean>;
  stop(): Promise<void>;
}

interface StoredAbuseBlockRecordValue {
  readonly member: string;
  readonly reason: AbuseBlockReason;
  readonly blockedUntilMs: string;
}

interface AbuseBlockCursorValue {
  readonly blockedUntilMs: number;
  readonly scope: AdminBlockScope;
  readonly subject: string;
}

export function normalizeAbuseBlockIdentity(identity: AbuseBlockIdentity): AbuseBlockIdentity {
  if (identity.scope === 'ip') {
    return { scope: 'ip', subject: normalizeIp(identity.subject) };
  }
  if (identity.scope === 'address') {
    let subject: string;
    try {
      subject = normalizeSuiAddress(identity.subject);
    } catch {
      throw new AbuseBlockInputError('Abuse block address is not a current Sui address');
    }
    if (!isValidSuiAddress(subject)) {
      throw new AbuseBlockInputError('Abuse block address is not a current Sui address');
    }
    return { scope: 'address', subject };
  }
  if (identity.scope !== 'studio_user') {
    throw new AbuseBlockInputError('Abuse block scope is not current');
  }
  if (!isValidStudioUserId(identity.subject)) {
    throw new AbuseBlockInputError(
      `Abuse block studio_user subject must contain 1-${STUDIO_USER_ID_MAX_LENGTH} ASCII letters, digits, or _ : . -`,
    );
  }
  return { scope: 'studio_user', subject: identity.subject };
}

export function abuseBlockIdentityFromSubject(subject: AbuseSubject): AbuseBlockIdentity {
  return subject.kind === 'address'
    ? normalizeAbuseBlockIdentity({ scope: 'address', subject: subject.address })
    : normalizeAbuseBlockIdentity({ scope: 'studio_user', subject: subject.userId });
}

function normalizeIp(value: string): string {
  const current = canonicalizeIpAddress(value);
  if (current === null) {
    throw new AbuseBlockInputError('Abuse block IP subject is not a current IP address');
  }
  return current;
}

export function abuseBlockMember(identity: AbuseBlockIdentity): string {
  const current = normalizeAbuseBlockIdentity(identity);
  return `${current.scope}:${Buffer.from(current.subject, 'utf8').toString('base64url')}`;
}

export function decodeAbuseBlockMember(value: string): AbuseBlockIdentity {
  try {
    const separator = value.indexOf(':');
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error('index member is malformed');
    }
    const scope = value.slice(0, separator);
    const encodedSubject = value.slice(separator + 1);
    if (!isAdminBlockScope(scope) || !/^[A-Za-z0-9_-]+$/.test(encodedSubject)) {
      throw new Error('index member is malformed');
    }
    const bytes = Buffer.from(encodedSubject, 'base64url');
    if (bytes.toString('base64url') !== encodedSubject) {
      throw new Error('index member is not canonical');
    }
    const subject = CURSOR_DECODER.decode(bytes);
    const identity = normalizeAbuseBlockIdentity({ scope, subject });
    if (identity.subject !== subject || abuseBlockMember(identity) !== value) {
      throw new Error('index member identity is not canonical');
    }
    return identity;
  } catch (error) {
    throw storedCorruption(error);
  }
}

export function abuseBlockRecordKey(identity: AbuseBlockIdentity): string {
  return `${ABUSE_BLOCK_RECORD_PREFIX}${abuseBlockMember(identity)}`;
}

export const ABUSE_BLOCK_DEADLINE_INDEX_KEY = 'stelis:abuse:block:deadline';

export function serializeAbuseBlockRecord(record: AbuseBlockRecord): string {
  const identity = normalizeAbuseBlockIdentity(record.identity);
  if (!isAbuseBlockReason(record.reason)) {
    throw new Error('Abuse block reason is not current');
  }
  if (!Number.isSafeInteger(record.blockedUntilMs) || record.blockedUntilMs <= 0) {
    throw new Error('Abuse block deadline must be a positive safe integer');
  }
  return encodeStoredAbuseBlockRecord({
    member: abuseBlockMember(identity),
    reason: record.reason,
    blockedUntilMs: String(record.blockedUntilMs),
  });
}

export function decodeAbuseBlockRecord(value: unknown): AbuseBlockRecord {
  try {
    if (typeof value !== 'string') {
      throw new Error('Abuse block record must be a canonical serialized string');
    }
    const parsed = JSON.parse(value) as unknown;
    const record = decodeAbuseBlockRecordValue(parsed);
    if (serializeAbuseBlockRecord(record) !== value) {
      throw new Error('Abuse block record is not canonical');
    }
    return record;
  } catch (error) {
    throw storedCorruption(error);
  }
}

export function cloneAbuseBlockRecord(record: AbuseBlockRecord): AbuseBlockRecord {
  try {
    return decodeAbuseBlockRecord(serializeAbuseBlockRecord(record));
  } catch (error) {
    throw storedCorruption(error);
  }
}

function decodeAbuseBlockRecordValue(value: unknown): AbuseBlockRecord {
  if (!isRecord(value)) {
    throw new Error('Abuse block record must be an object');
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'blockedUntilMs' ||
    keys[1] !== 'member' ||
    keys[2] !== 'reason'
  ) {
    throw new Error('Abuse block record has an invalid field set');
  }
  const member = value.member;
  const reason = value.reason;
  const blockedUntilMsRaw = value.blockedUntilMs;
  if (typeof member !== 'string') {
    throw new Error('Abuse block record has an invalid identity');
  }
  const identity = decodeAbuseBlockMember(member);
  if (!isAbuseBlockReason(reason)) {
    throw new Error('Abuse block record reason is not current');
  }
  const blockedUntilMs = parseCanonicalPositiveInteger(
    blockedUntilMsRaw,
    'Abuse block record deadline',
  );
  return { identity, reason, blockedUntilMs };
}

function encodeStoredAbuseBlockRecord(record: StoredAbuseBlockRecordValue): string {
  return (
    `{"member":${JSON.stringify(record.member)},` +
    `"reason":${JSON.stringify(record.reason)},` +
    `"blockedUntilMs":${JSON.stringify(record.blockedUntilMs)}}`
  );
}

export type AbuseBlockWriteDecision =
  | { readonly kind: 'stored'; readonly record: AbuseBlockRecord }
  | { readonly kind: 'preserved'; readonly record: AbuseBlockRecord };

export function decideAbuseBlockWrite(
  current: AbuseBlockRecord | null,
  requested: AbuseBlockRecord,
): AbuseBlockWriteDecision {
  const next = decodeAbuseBlockRecord(serializeAbuseBlockRecord(requested));
  if (current === null) return { kind: 'stored', record: next };
  const existing = decodeAbuseBlockRecord(serializeAbuseBlockRecord(current));
  assertSameAbuseBlockIdentity(existing.identity, next.identity);
  return existing.blockedUntilMs >= next.blockedUntilMs
    ? { kind: 'preserved', record: existing }
    : { kind: 'stored', record: next };
}

export function isLiveAbuseBlock(record: AbuseBlockRecord, nowMs: number): boolean {
  assertNonNegativeSafeInteger(nowMs, 'Abuse block current time');
  return record.blockedUntilMs > nowMs;
}

export function decideAbuseBlockRemoval(
  current: AbuseBlockRecord | null,
  nowMs: number,
): 'removed' | 'missing' {
  return current !== null && isLiveAbuseBlock(current, nowMs) ? 'removed' : 'missing';
}

export function compareAbuseBlockPosition(
  left: Pick<AbuseBlockRecord, 'identity' | 'blockedUntilMs'>,
  right: Pick<AbuseBlockRecord, 'identity' | 'blockedUntilMs'>,
): number {
  if (left.blockedUntilMs !== right.blockedUntilMs) {
    return left.blockedUntilMs < right.blockedUntilMs ? -1 : 1;
  }
  const leftMember = abuseBlockMember(left.identity);
  const rightMember = abuseBlockMember(right.identity);
  return leftMember < rightMember ? -1 : leftMember > rightMember ? 1 : 0;
}

export function encodeAbuseBlockCursor(
  value: Pick<AbuseBlockRecord, 'identity' | 'blockedUntilMs'>,
): string {
  const identity = normalizeAbuseBlockIdentity(value.identity);
  if (!Number.isSafeInteger(value.blockedUntilMs) || value.blockedUntilMs <= 0) {
    throw new Error('Abuse block cursor deadline must be a positive safe integer');
  }
  const encoded = Buffer.from(
    JSON.stringify({
      blockedUntilMs: value.blockedUntilMs,
      scope: identity.scope,
      subject: identity.subject,
    } satisfies AbuseBlockCursorValue),
    'utf8',
  ).toString('base64url');
  if (encoded.length > ADMIN_BLOCKLIST_CURSOR_MAX_LENGTH) {
    throw new Error('Abuse block cursor exceeds the current Host contract limit');
  }
  return encoded;
}

export function decodeAbuseBlockCursor(value: string): AbuseBlockCursorValue {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > ADMIN_BLOCKLIST_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error('Abuse block cursor is not canonical base64url');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) {
    throw new Error('Abuse block cursor is not canonical base64url');
  }
  let text: string;
  try {
    text = CURSOR_DECODER.decode(bytes);
  } catch {
    throw new Error('Abuse block cursor is not UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Abuse block cursor is not JSON');
  }
  if (!isRecord(parsed)) {
    throw new Error('Abuse block cursor must be an object');
  }
  const keys = Object.keys(parsed);
  if (
    keys.length !== 3 ||
    keys[0] !== 'blockedUntilMs' ||
    keys[1] !== 'scope' ||
    keys[2] !== 'subject'
  ) {
    throw new Error('Abuse block cursor has an invalid field set');
  }
  if (
    !Number.isSafeInteger(parsed.blockedUntilMs) ||
    (parsed.blockedUntilMs as number) <= 0 ||
    !isAdminBlockScope(parsed.scope) ||
    typeof parsed.subject !== 'string'
  ) {
    throw new Error('Abuse block cursor has invalid values');
  }
  const identity = normalizeAbuseBlockIdentity({
    scope: parsed.scope,
    subject: parsed.subject,
  });
  if (identity.subject !== parsed.subject || JSON.stringify(parsed) !== text) {
    throw new Error('Abuse block cursor is not canonical');
  }
  return {
    blockedUntilMs: parsed.blockedUntilMs as number,
    scope: parsed.scope,
    subject: parsed.subject,
  };
}

export function validateAbuseBlockPageParams(params: AbuseBlockPageParams): AbuseBlockPageParams {
  if (
    !Number.isSafeInteger(params.limit) ||
    params.limit < 1 ||
    params.limit > ADMIN_BLOCKLIST_MAX_LIMIT
  ) {
    throw new AbuseBlockInputError(
      `Abuse block page limit must be from 1 through ${ADMIN_BLOCKLIST_MAX_LIMIT}`,
    );
  }
  if (params.cursor !== null) {
    try {
      decodeAbuseBlockCursor(params.cursor);
    } catch (error) {
      throw new AbuseBlockInputError(
        error instanceof Error ? error.message : 'Abuse block cursor is invalid',
      );
    }
  }
  return params;
}

function isAbuseBlockReason(value: unknown): value is AbuseBlockReason {
  return typeof value === 'string' && (ABUSE_BLOCK_REASONS as readonly string[]).includes(value);
}

function isAdminBlockScope(value: unknown): value is AdminBlockScope {
  return typeof value === 'string' && (ABUSE_BLOCK_SCOPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCanonicalPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${label} must be a canonical positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return parsed;
}

function assertSameAbuseBlockIdentity(left: AbuseBlockIdentity, right: AbuseBlockIdentity): void {
  if (abuseBlockMember(left) !== abuseBlockMember(right)) {
    throw new Error('Abuse block transition identity changed');
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function storedCorruption(error: unknown): AbuseBlockStorageCorruptionError {
  if (error instanceof AbuseBlockStorageCorruptionError) return error;
  return new AbuseBlockStorageCorruptionError(
    error instanceof Error ? error.message : 'Abuse block storage is corrupt',
  );
}
