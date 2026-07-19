/**
 * Redis-backed SponsorOperations observations and spend record codec.
 *
 * Redis stores three independent facts:
 *   - one raw balance observation per sponsor address,
 *   - one raw total-balance observation for the refill account,
 *   - one exact refill-account spend lifecycle.
 *
 * Availability and UI status are derived after these records are decoded.
 * Derived state is never persisted, so a policy change cannot leave stale
 * status fields in Redis.
 */

import { createHash } from 'node:crypto';
import {
  fromBase64,
  isValidSuiAddress,
  isValidTransactionDigest,
  normalizeSuiAddress,
  toBase64,
} from '@mysten/sui/utils';
import type { RedisClientLike } from '@stelis/core-api';
import {
  isPositiveU64DecimalString,
  type SponsorSlotState,
  type SuiNetwork,
} from '@stelis/contracts';
import {
  calculateSponsorOperationsStatus,
  SPONSOR_REFILL_OPERATION_STATES,
  type SponsorRefillOperationState,
} from './status.js';
import type { SponsorOperationsSettings } from './settings.js';

export const SPONSOR_OPERATIONS_KEY_PREFIX = 'stelis:app-api:sponsor-operations:';
export const slotKey = (address: string): string =>
  `${SPONSOR_OPERATIONS_KEY_PREFIX}slot:${address}`;
export const SPONSOR_REFILL_ACCOUNT_KEY = `${SPONSOR_OPERATIONS_KEY_PREFIX}sponsor-refill-account`;
export const SPONSOR_REFILL_ACCOUNT_SPEND_KEY = `${SPONSOR_OPERATIONS_KEY_PREFIX}sponsor-refill-account-spend`;

export const SPONSOR_OPERATIONS_MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
export const SPONSOR_OPERATIONS_SEQUENCE_LIMIT_RESULT = 'SEQUENCE_LIMIT_REACHED';

export function throwIfSponsorOperationsSequenceLimitReached(status: string | null): void {
  if (status === SPONSOR_OPERATIONS_SEQUENCE_LIMIT_RESULT) {
    throw new Error(
      `SponsorOperations sequence reached its maximum value ${SPONSOR_OPERATIONS_MAX_SEQUENCE}`,
    );
  }
}

export const SPONSOR_SLOT_HASH_FIELDS = [
  'addressBalanceMist',
  'lastError',
  'lastObservedAtMs',
  'writeSeq',
] as const;

export const SPONSOR_REFILL_ACCOUNT_HASH_FIELDS = [
  'totalBalanceMist',
  'lastError',
  'lastObservedAtMs',
  'writeSeq',
] as const;

export const SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS = [
  'network',
  'operationId',
  'kind',
  'sourceAddress',
  'destinationAddress',
  'slotAddress',
  'nonceKey',
  'amountMist',
  'gasBudgetMist',
  'transactionBytesBase64',
  'signature',
  'digest',
  'chainResult',
  'terminalFailureKind',
  'requiredSourceBalanceMist',
  'state',
  'lastError',
  'sequence',
] as const;

export interface SlotWriteFields {
  readonly addressBalanceMist?: string;
  readonly lastError?: string;
}

export interface SponsorRefillAccountWriteFields {
  readonly totalBalanceMist?: string;
  readonly lastError?: string;
}

export const SPONSOR_REFILL_ACCOUNT_SPEND_KINDS = ['refill', 'withdrawal'] as const;
export type SponsorRefillAccountSpendKind = (typeof SPONSOR_REFILL_ACCOUNT_SPEND_KINDS)[number];
export type SponsorRefillAccountSpendState = SponsorRefillOperationState;
export type SponsorRefillAccountSpendTerminalFailureKind = 'runway_blocked' | 'failed';

export function createSponsorRefillAccountWithdrawalOperationId(input: {
  readonly network: SuiNetwork;
  readonly sourceAddress: string;
  readonly destinationAddress: string;
  readonly amountMist: string;
  readonly nonceKey: string;
}): string {
  return `withdrawal:${createHash('sha256')
    .update(
      JSON.stringify([
        'withdrawal',
        input.network,
        input.sourceAddress,
        input.destinationAddress,
        input.amountMist,
        input.nonceKey,
      ]),
    )
    .digest('hex')}`;
}

interface SponsorRefillAccountSpendBase {
  readonly network: SuiNetwork;
  readonly operationId: string;
  readonly sourceAddress: string;
  readonly destinationAddress: string;
  readonly amountMist: string;
  readonly sequence: number;
}

type SponsorRefillAccountSpendKindFields =
  | { readonly kind: 'refill'; readonly slotAddress: string; readonly nonceKey: null }
  | { readonly kind: 'withdrawal'; readonly slotAddress: null; readonly nonceKey: string };

interface SponsorRefillAccountTransactionIdentity {
  readonly gasBudgetMist: string;
  readonly transactionBytesBase64: string;
  readonly signature: string;
  readonly digest: string;
}

export type ReservedSponsorRefillAccountSpend = SponsorRefillAccountSpendBase &
  SponsorRefillAccountSpendKindFields & { readonly state: 'reserved' };

export type ReadySponsorRefillAccountSpend = SponsorRefillAccountSpendBase &
  SponsorRefillAccountSpendKindFields &
  SponsorRefillAccountTransactionIdentity & { readonly state: 'ready' };

export type ReconcilingSponsorRefillAccountSpend = SponsorRefillAccountSpendBase &
  SponsorRefillAccountSpendKindFields &
  SponsorRefillAccountTransactionIdentity &
  (
    | { readonly state: 'reconciling'; readonly chainResult: 'succeeded' }
    | {
        readonly state: 'reconciling';
        readonly chainResult: 'failed';
        readonly error: string;
      }
  );

export type SucceededSponsorRefillAccountSpend = SponsorRefillAccountSpendBase &
  SponsorRefillAccountSpendKindFields & {
    readonly state: 'succeeded';
    readonly digest: string;
  };

export type FailedSponsorRefillAccountSpend = SponsorRefillAccountSpendBase &
  SponsorRefillAccountSpendKindFields & {
    readonly state: 'failed';
    readonly digest: string | null;
    readonly failureKind: SponsorRefillAccountSpendTerminalFailureKind;
    readonly requiredSourceBalanceMist: string | null;
    readonly error: string;
  };

export type ActiveSponsorRefillAccountSpend =
  | ReservedSponsorRefillAccountSpend
  | ReadySponsorRefillAccountSpend
  | ReconcilingSponsorRefillAccountSpend;
export type TerminalSponsorRefillAccountSpend =
  | SucceededSponsorRefillAccountSpend
  | FailedSponsorRefillAccountSpend;
export type SponsorRefillAccountSpend =
  | ActiveSponsorRefillAccountSpend
  | TerminalSponsorRefillAccountSpend;

interface SponsorSlotObservationRecord {
  readonly address: string;
  readonly addressBalanceMist: string | null;
  readonly lastError: string | null;
  readonly lastObservedAtMs: number | null;
  readonly writeSeq: number;
}

export interface SponsorSlotRecord extends SponsorSlotObservationRecord {
  readonly state: SponsorSlotState;
  readonly refillOperationId: string | null;
  readonly refillOperationSequence: number | null;
  readonly refillOperationState: SponsorRefillOperationState | null;
  readonly refillRequiredSourceBalanceMist: string | null;
}

export interface SponsorRefillAccountRecord {
  readonly totalBalanceMist: string | null;
  readonly healthy: boolean;
  readonly lastError: string | null;
  readonly lastObservedAtMs: number | null;
  readonly writeSeq: number;
}

export interface SponsorSlotAvailabilityRecord extends SponsorSlotRecord {
  readonly observationFresh: boolean;
}

export interface SponsorRefillAccountAvailabilityRecord extends SponsorRefillAccountRecord {
  readonly observationFresh: boolean;
}

function requiredField(hash: Readonly<Record<string, string>>, key: string, label: string): string {
  if (!Object.prototype.hasOwnProperty.call(hash, key)) {
    throw new Error(`${label}.${key} is missing`);
  }
  return hash[key]!;
}

function assertExactFields(
  hash: Readonly<Record<string, string>>,
  expectedFields: readonly string[],
  label: string,
): void {
  for (const field of expectedFields) {
    if (!Object.prototype.hasOwnProperty.call(hash, field)) {
      throw new Error(`${label}.${field} is missing`);
    }
  }
  if (Object.keys(hash).length !== expectedFields.length) {
    throw new Error(`${label} has an unexpected field set`);
  }
}

function isU64DecimalString(raw: string): boolean {
  return raw === '0' || isPositiveU64DecimalString(raw);
}

function parseMistString(raw: string, label: string, positive = false): string | null {
  if (raw === '') return null;
  if (positive ? !isPositiveU64DecimalString(raw) : !isU64DecimalString(raw)) {
    throw new Error(`${label} is malformed`);
  }
  return raw;
}

function parseSafeInteger(raw: string, label: string, nullable: boolean): number | null {
  if (nullable && raw === '') return null;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new Error(`${label} is malformed`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} exceeds safe integer range`);
  return value;
}

function parseString(raw: string): string | null {
  return raw === '' ? null : raw;
}

function parseCanonicalAddress(raw: string, label: string): string {
  if (!isValidSuiAddress(raw) || normalizeSuiAddress(raw) !== raw) {
    throw new Error(`${label} is not a canonical Sui address`);
  }
  return raw;
}

function parseCanonicalBase64(raw: string, label: string): string | null {
  if (raw === '') return null;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(raw);
  } catch {
    throw new Error(`${label} is malformed`);
  }
  if (bytes.length === 0 || toBase64(bytes) !== raw) {
    throw new Error(`${label} is not canonical base64`);
  }
  return raw;
}

export function decodeSponsorRefillAccountSpendRecord(
  hash: Readonly<Record<string, string>>,
  settings: SponsorOperationsSettings,
): SponsorRefillAccountSpend | null {
  if (Object.keys(hash).length === 0) return null;
  const label = 'SponsorRefillAccountSpend';
  assertExactFields(hash, SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS, label);
  const network = requiredField(hash, 'network', label);
  if (network !== settings.network) throw new Error(`${label}.network is invalid`);
  const operationId = requiredField(hash, 'operationId', label);
  if (operationId.length === 0) throw new Error(`${label}.operationId is empty`);
  const kindRaw = requiredField(hash, 'kind', label);
  if (!(SPONSOR_REFILL_ACCOUNT_SPEND_KINDS as readonly string[]).includes(kindRaw)) {
    throw new Error(`${label}.kind is invalid`);
  }
  const kind = kindRaw as SponsorRefillAccountSpendKind;
  const sourceAddress = parseCanonicalAddress(
    requiredField(hash, 'sourceAddress', label),
    `${label}.sourceAddress`,
  );
  const destinationAddress = parseCanonicalAddress(
    requiredField(hash, 'destinationAddress', label),
    `${label}.destinationAddress`,
  );
  if (sourceAddress !== settings.sponsorRefillAccountAddress) {
    throw new Error(`${label}.sourceAddress is not the configured refill account`);
  }
  const slotAddressRaw = requiredField(hash, 'slotAddress', label);
  const nonceKeyRaw = requiredField(hash, 'nonceKey', label);
  const slotAddress =
    slotAddressRaw === '' ? null : parseCanonicalAddress(slotAddressRaw, `${label}.slotAddress`);
  const nonceKey = nonceKeyRaw === '' ? null : nonceKeyRaw;
  if (kind === 'refill') {
    if (
      slotAddress === null ||
      destinationAddress !== slotAddress ||
      !settings.sponsorAddresses.includes(slotAddress) ||
      nonceKey !== null
    ) {
      throw new Error(`${label} has an invalid refill identity`);
    }
  } else if (slotAddress !== null || nonceKey === null) {
    throw new Error(`${label} has an invalid withdrawal identity`);
  }
  const amountMist = parseMistString(
    requiredField(hash, 'amountMist', label),
    `${label}.amountMist`,
    true,
  );
  const sequence = parseSafeInteger(
    requiredField(hash, 'sequence', label),
    `${label}.sequence`,
    false,
  );
  if (amountMist === null || sequence === null || sequence <= 0) {
    throw new Error(`${label} has an invalid amount or sequence`);
  }
  if (kind === 'refill') {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)
    ) {
      throw new Error(`${label}.operationId is not a UUID v4 refill identity`);
    }
  } else if (
    operationId !==
    createSponsorRefillAccountWithdrawalOperationId({
      network: settings.network,
      sourceAddress,
      destinationAddress,
      amountMist,
      nonceKey: nonceKey!,
    })
  ) {
    throw new Error(`${label}.operationId is not bound to the withdrawal request`);
  }
  const stateRaw = requiredField(hash, 'state', label);
  if (!(SPONSOR_REFILL_OPERATION_STATES as readonly string[]).includes(stateRaw)) {
    throw new Error(`${label}.state is invalid`);
  }
  const state = stateRaw as SponsorRefillAccountSpendState;
  const gasBudgetMist = parseMistString(
    requiredField(hash, 'gasBudgetMist', label),
    `${label}.gasBudgetMist`,
    true,
  );
  const transactionBytesBase64 = parseCanonicalBase64(
    requiredField(hash, 'transactionBytesBase64', label),
    `${label}.transactionBytesBase64`,
  );
  const signature = parseCanonicalBase64(
    requiredField(hash, 'signature', label),
    `${label}.signature`,
  );
  const digest = parseString(requiredField(hash, 'digest', label));
  if (digest !== null && !isValidTransactionDigest(digest)) {
    throw new Error(`${label}.digest is invalid`);
  }
  const chainResultRaw = requiredField(hash, 'chainResult', label);
  const chainResult = chainResultRaw === '' ? null : chainResultRaw;
  if (chainResult !== null && chainResult !== 'succeeded' && chainResult !== 'failed') {
    throw new Error(`${label}.chainResult is invalid`);
  }
  const failureKindRaw = requiredField(hash, 'terminalFailureKind', label);
  const failureKind = failureKindRaw === '' ? null : failureKindRaw;
  if (failureKind !== null && failureKind !== 'runway_blocked' && failureKind !== 'failed') {
    throw new Error(`${label}.terminalFailureKind is invalid`);
  }
  const requiredSourceBalanceMist = parseMistString(
    requiredField(hash, 'requiredSourceBalanceMist', label),
    `${label}.requiredSourceBalanceMist`,
    true,
  );
  const lastError = parseString(requiredField(hash, 'lastError', label));
  const hasCompleteIdentity =
    gasBudgetMist !== null &&
    transactionBytesBase64 !== null &&
    signature !== null &&
    digest !== null;
  const hasAnyIdentity =
    gasBudgetMist !== null ||
    transactionBytesBase64 !== null ||
    signature !== null ||
    digest !== null;
  const common = {
    network: settings.network,
    operationId,
    sourceAddress,
    destinationAddress,
    amountMist,
    sequence,
    ...(kind === 'refill'
      ? { kind, slotAddress: slotAddress!, nonceKey: null }
      : { kind, slotAddress: null, nonceKey: nonceKey! }),
  } as const;

  if (state === 'reserved') {
    if (
      sequence !== 1 ||
      hasAnyIdentity ||
      chainResult !== null ||
      failureKind !== null ||
      requiredSourceBalanceMist !== null ||
      lastError !== null
    ) {
      throw new Error(`${label} reserved state is inconsistent`);
    }
    return { ...common, state };
  }
  if (state === 'ready') {
    if (
      sequence !== 2 ||
      !hasCompleteIdentity ||
      chainResult !== null ||
      failureKind !== null ||
      requiredSourceBalanceMist !== null ||
      lastError !== null
    ) {
      throw new Error(`${label} ready state is inconsistent`);
    }
    return {
      ...common,
      state,
      gasBudgetMist: gasBudgetMist!,
      transactionBytesBase64: transactionBytesBase64!,
      signature: signature!,
      digest: digest!,
    };
  }
  if (state === 'reconciling') {
    if (
      sequence !== 3 ||
      !hasCompleteIdentity ||
      chainResult === null ||
      failureKind !== null ||
      requiredSourceBalanceMist !== null ||
      (chainResult === 'succeeded' ? lastError !== null : lastError === null)
    ) {
      throw new Error(`${label} reconciling state is inconsistent`);
    }
    const identity = {
      ...common,
      state,
      gasBudgetMist: gasBudgetMist!,
      transactionBytesBase64: transactionBytesBase64!,
      signature: signature!,
      digest: digest!,
    };
    return chainResult === 'succeeded'
      ? { ...identity, chainResult }
      : { ...identity, chainResult, error: lastError! };
  }
  if (state === 'succeeded') {
    if (
      sequence !== 4 ||
      gasBudgetMist !== null ||
      transactionBytesBase64 !== null ||
      signature !== null ||
      digest === null ||
      chainResult !== 'succeeded' ||
      failureKind !== null ||
      requiredSourceBalanceMist !== null ||
      lastError !== null
    ) {
      throw new Error(`${label} succeeded state is inconsistent`);
    }
    return { ...common, state, digest };
  }
  const validFailure =
    sequence === (chainResult === null ? 2 : 4) &&
    gasBudgetMist === null &&
    transactionBytesBase64 === null &&
    signature === null &&
    failureKind !== null &&
    lastError !== null &&
    ((chainResult === null && digest === null && failureKind === 'runway_blocked') ||
      (chainResult === null && digest === null && failureKind === 'failed') ||
      (chainResult === 'failed' && digest !== null && failureKind === 'failed')) &&
    (requiredSourceBalanceMist === null || (kind === 'refill' && failureKind === 'runway_blocked'));
  if (!validFailure) throw new Error(`${label} failed state is inconsistent`);
  return {
    ...common,
    state,
    digest,
    failureKind,
    requiredSourceBalanceMist,
    error: lastError,
  };
}

export function serializeSponsorRefillAccountSpendRecord(
  spend: SponsorRefillAccountSpend,
  settings: SponsorOperationsSettings,
): Readonly<Record<string, string>> {
  const hash = Object.freeze({
    network: spend.network,
    operationId: spend.operationId,
    kind: spend.kind,
    sourceAddress: spend.sourceAddress,
    destinationAddress: spend.destinationAddress,
    slotAddress: spend.slotAddress ?? '',
    nonceKey: spend.nonceKey ?? '',
    amountMist: spend.amountMist,
    gasBudgetMist: 'gasBudgetMist' in spend ? spend.gasBudgetMist : '',
    transactionBytesBase64: 'transactionBytesBase64' in spend ? spend.transactionBytesBase64 : '',
    signature: 'signature' in spend ? spend.signature : '',
    digest: 'digest' in spend ? (spend.digest ?? '') : '',
    chainResult:
      'chainResult' in spend ? spend.chainResult : spend.state === 'succeeded' ? 'succeeded' : '',
    terminalFailureKind: spend.state === 'failed' ? spend.failureKind : '',
    requiredSourceBalanceMist:
      spend.state === 'failed' ? (spend.requiredSourceBalanceMist ?? '') : '',
    state: spend.state,
    lastError: 'error' in spend ? spend.error : '',
    sequence: String(spend.sequence),
  });
  decodeSponsorRefillAccountSpendRecord(hash, settings);
  return hash;
}

function decodeSponsorSlotObservation(
  hash: Readonly<Record<string, string>>,
  address: string,
): SponsorSlotObservationRecord {
  const label = `SponsorSlotObservation(${address})`;
  assertExactFields(hash, SPONSOR_SLOT_HASH_FIELDS, label);
  const addressBalanceMist = parseMistString(
    requiredField(hash, 'addressBalanceMist', label),
    `${label}.addressBalanceMist`,
  );
  const lastObservedAtMs = parseSafeInteger(
    requiredField(hash, 'lastObservedAtMs', label),
    `${label}.lastObservedAtMs`,
    true,
  );
  if (addressBalanceMist !== null && lastObservedAtMs === null) {
    throw new Error(`${label} has a balance without an observation time`);
  }
  return {
    address,
    addressBalanceMist,
    lastError: parseString(requiredField(hash, 'lastError', label)),
    lastObservedAtMs,
    writeSeq: parseSafeInteger(requiredField(hash, 'writeSeq', label), `${label}.writeSeq`, false)!,
  };
}

function projectSponsorSlotRecord(
  observation: SponsorSlotObservationRecord,
  spend: SponsorRefillAccountSpend | null,
  settings: SponsorOperationsSettings,
): SponsorSlotRecord {
  const refill =
    spend?.kind === 'refill' && spend.slotAddress === observation.address ? spend : null;
  const calculated = calculateSponsorOperationsStatus({
    entity: 'sponsor_slot',
    settings,
    observation:
      observation.addressBalanceMist === null
        ? { status: 'failed' }
        : { status: 'succeeded', addressBalanceMist: BigInt(observation.addressBalanceMist) },
    refillOperationState: refill?.state ?? null,
  });
  return {
    ...observation,
    state: calculated.state,
    refillOperationId: refill?.operationId ?? null,
    refillOperationSequence: refill?.sequence ?? null,
    refillOperationState: refill?.state ?? null,
    refillRequiredSourceBalanceMist:
      refill?.state === 'failed' ? refill.requiredSourceBalanceMist : null,
    lastError: refill?.state === 'failed' ? refill.error : observation.lastError,
  };
}

export function decodeSponsorSlotRecord(
  hash: Readonly<Record<string, string>>,
  address: string,
  settings: SponsorOperationsSettings,
  spend: SponsorRefillAccountSpend | null = null,
): SponsorSlotRecord {
  return projectSponsorSlotRecord(decodeSponsorSlotObservation(hash, address), spend, settings);
}

export function serializeSponsorSlotRecord(
  record: Pick<
    SponsorSlotRecord,
    'address' | 'addressBalanceMist' | 'lastError' | 'lastObservedAtMs' | 'writeSeq'
  >,
): Readonly<Record<string, string>> {
  const hash = Object.freeze({
    addressBalanceMist: record.addressBalanceMist ?? '',
    lastError: record.lastError ?? '',
    lastObservedAtMs: record.lastObservedAtMs === null ? '' : String(record.lastObservedAtMs),
    writeSeq: String(record.writeSeq),
  });
  decodeSponsorSlotObservation(hash, record.address);
  return hash;
}

export function decodeSponsorRefillAccountRecord(
  hash: Readonly<Record<string, string>>,
  settings: SponsorOperationsSettings,
): SponsorRefillAccountRecord {
  const label = 'SponsorRefillAccountObservation';
  assertExactFields(hash, SPONSOR_REFILL_ACCOUNT_HASH_FIELDS, label);
  const totalBalanceMist = parseMistString(
    requiredField(hash, 'totalBalanceMist', label),
    `${label}.totalBalanceMist`,
  );
  const lastObservedAtMs = parseSafeInteger(
    requiredField(hash, 'lastObservedAtMs', label),
    `${label}.lastObservedAtMs`,
    true,
  );
  if (totalBalanceMist !== null && lastObservedAtMs === null) {
    throw new Error(`${label} has a balance without an observation time`);
  }
  const calculated = calculateSponsorOperationsStatus({
    entity: 'sponsor_refill_account',
    settings,
    observation:
      totalBalanceMist === null
        ? { status: 'failed' }
        : { status: 'succeeded', totalBalanceMist: BigInt(totalBalanceMist) },
  });
  return {
    totalBalanceMist,
    healthy: calculated.healthy,
    lastError: parseString(requiredField(hash, 'lastError', label)),
    lastObservedAtMs,
    writeSeq: parseSafeInteger(requiredField(hash, 'writeSeq', label), `${label}.writeSeq`, false)!,
  };
}

export function serializeSponsorRefillAccountRecord(
  record: Pick<
    SponsorRefillAccountRecord,
    'totalBalanceMist' | 'lastError' | 'lastObservedAtMs' | 'writeSeq'
  >,
  settings: SponsorOperationsSettings,
): Readonly<Record<string, string>> {
  const hash = Object.freeze({
    totalBalanceMist: record.totalBalanceMist ?? '',
    lastError: record.lastError ?? '',
    lastObservedAtMs: record.lastObservedAtMs === null ? '' : String(record.lastObservedAtMs),
    writeSeq: String(record.writeSeq),
  });
  decodeSponsorRefillAccountRecord(hash, settings);
  return hash;
}

function exactHashGuardLua(key: string, fields: readonly string[], indent = ''): readonly string[] {
  return [
    `${indent}if redis.call('HLEN', ${key}) ~= ${fields.length} then return { 'CORRUPT' } end`,
    ...fields.map(
      (field) =>
        `${indent}if redis.call('HEXISTS', ${key}, '${field}') ~= 1 then return { 'CORRUPT' } end`,
    ),
  ];
}

export const UPDATE_ENTITY_IF_SEQUENCE_LUA = [
  "local exists = redis.call('EXISTS', KEYS[1])",
  'if exists == 1 then',
  ...exactHashGuardLua('KEYS[1]', SPONSOR_SLOT_HASH_FIELDS, '  '),
  'end',
  "local current = redis.call('HGET', KEYS[1], 'writeSeq') or '0'",
  "if current ~= ARGV[1] then return { 'STALE' } end",
  `if current == '${SPONSOR_OPERATIONS_MAX_SEQUENCE}' then return { '${SPONSOR_OPERATIONS_SEQUENCE_LIMIT_RESULT}' } end`,
  'local nextSequence = tostring(tonumber(current) + 1)',
  "local time = redis.call('TIME')",
  'local nowMs = tostring(tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000))',
  "redis.call('HSET', KEYS[1], 'addressBalanceMist', ARGV[2], 'lastError', ARGV[3], 'writeSeq', nextSequence)",
  "if ARGV[2] ~= '' then",
  "  redis.call('HSET', KEYS[1], 'lastObservedAtMs', nowMs)",
  'elseif exists == 0 then',
  "  redis.call('HSET', KEYS[1], 'lastObservedAtMs', '')",
  'end',
  "return { 'UPDATED', nextSequence }",
].join('\n');

export const READ_ALL_LUA = [
  'local slotRows = {}',
  'for i = 1, #ARGV do',
  "  table.insert(slotRows, { ARGV[i], redis.call('HGETALL', KEYS[i]) })",
  'end',
  "local account = redis.call('HGETALL', KEYS[#KEYS - 1])",
  "local spend = redis.call('HGETALL', KEYS[#KEYS])",
  "local time = redis.call('TIME')",
  'local nowMs = tostring(tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000))',
  'return { slotRows, account, spend, nowMs }',
].join('\n');

export const READ_SLOT_LUA = [
  "local slot = redis.call('HGETALL', KEYS[1])",
  "local spend = redis.call('HGETALL', KEYS[2])",
  "local time = redis.call('TIME')",
  'local nowMs = tostring(tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000))',
  'return { slot, spend, nowMs }',
].join('\n');

function stringAt(row: readonly unknown[], index: number): string | undefined {
  const value = row[index];
  return typeof value === 'string' ? value : undefined;
}

function hashFromRedisRow(raw: unknown, label: string): Record<string, string> {
  if (!Array.isArray(raw) || raw.length % 2 !== 0) {
    throw new Error(`${label} has an unexpected Redis HASH response`);
  }
  const hash: Record<string, string> = {};
  for (let index = 0; index < raw.length; index += 2) {
    const field = stringAt(raw, index);
    const value = stringAt(raw, index + 1);
    if (field === undefined || value === undefined || Object.hasOwn(hash, field)) {
      throw new Error(`${label} has an unexpected Redis HASH response`);
    }
    hash[field] = value;
  }
  return hash;
}

function recordIsFresh(
  lastObservedAtMs: number | null,
  redisTimeMs: number,
  maxAgeMs: number,
): boolean {
  if (lastObservedAtMs === null) return false;
  if (lastObservedAtMs > redisTimeMs) {
    throw new Error('SponsorOperations observation time is later than Redis TIME');
  }
  return redisTimeMs - lastObservedAtMs <= maxAgeMs;
}

export interface RedisSponsorOperationsStateDeps {
  readonly client: RedisClientLike;
  readonly settings: SponsorOperationsSettings;
}

export interface RedisSponsorOperationsState {
  updateSlotIfWriteSeq(
    address: string,
    expectedWriteSeq: number,
    fields: SlotWriteFields,
  ): Promise<boolean>;
  readSlot(address: string): Promise<SponsorSlotRecord | null>;
  readSlotAvailability(address: string): Promise<SponsorSlotAvailabilityRecord | null>;
  readSponsorRefillAccount(): Promise<SponsorRefillAccountRecord | null>;
  readAll(): Promise<{
    readonly settings: SponsorOperationsSettings;
    readonly slots: readonly SponsorSlotAvailabilityRecord[];
    readonly sponsorRefillAccount: SponsorRefillAccountAvailabilityRecord;
  }>;
}

function assertSequence(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

export function createRedisSponsorOperationsState(
  deps: RedisSponsorOperationsStateDeps,
): RedisSponsorOperationsState {
  const { settings } = deps;
  const slotSet = new Set(settings.sponsorAddresses);
  const maxObservationAgeMs = settings.maxObservationAgeMs;

  async function readSlotSnapshot(address: string): Promise<{
    readonly record: SponsorSlotRecord | null;
    readonly redisTimeMs: number;
  }> {
    if (!slotSet.has(address)) throw new Error(`Unknown sponsor address ${address}`);
    const raw = await deps.client.eval(
      READ_SLOT_LUA,
      [slotKey(address), SPONSOR_REFILL_ACCOUNT_SPEND_KEY],
      [],
    );
    if (
      !Array.isArray(raw) ||
      !Array.isArray(raw[0]) ||
      !Array.isArray(raw[1]) ||
      typeof raw[2] !== 'string'
    ) {
      throw new Error('RedisSponsorOperationsState.readSlot: unexpected Redis response');
    }
    const hash = hashFromRedisRow(raw[0], `Sponsor slot ${address}`);
    const spend = decodeSponsorRefillAccountSpendRecord(
      hashFromRedisRow(raw[1], 'Sponsor Refill Account spend'),
      settings,
    );
    const redisTimeMs = parseSafeInteger(raw[2], 'Redis TIME', false)!;
    return {
      record:
        Object.keys(hash).length === 0
          ? null
          : decodeSponsorSlotRecord(hash, address, settings, spend),
      redisTimeMs,
    };
  }

  async function readSlot(address: string): Promise<SponsorSlotRecord | null> {
    return (await readSlotSnapshot(address)).record;
  }

  async function readSlotAvailability(
    address: string,
  ): Promise<SponsorSlotAvailabilityRecord | null> {
    const { record, redisTimeMs } = await readSlotSnapshot(address);
    if (record === null) return null;
    return {
      ...record,
      observationFresh: recordIsFresh(record.lastObservedAtMs, redisTimeMs, maxObservationAgeMs),
    };
  }

  async function readSponsorRefillAccount(): Promise<SponsorRefillAccountRecord | null> {
    const hash = await deps.client.hgetall(SPONSOR_REFILL_ACCOUNT_KEY);
    if (!hash || Object.keys(hash).length === 0) return null;
    return decodeSponsorRefillAccountRecord(hash, settings);
  }

  async function updateSlotIfWriteSeq(
    address: string,
    expectedWriteSeq: number,
    fields: SlotWriteFields,
  ): Promise<boolean> {
    if (!slotSet.has(address)) throw new Error(`Unknown sponsor address ${address}`);
    assertSequence(expectedWriteSeq, 'expectedWriteSeq');
    const addressBalanceMist = fields.addressBalanceMist ?? '';
    if (addressBalanceMist !== '' && !isU64DecimalString(addressBalanceMist)) {
      throw new Error('Sponsor slot balance must be a u64 decimal string');
    }
    const raw = await deps.client.eval(
      UPDATE_ENTITY_IF_SEQUENCE_LUA,
      [slotKey(address)],
      [String(expectedWriteSeq), addressBalanceMist, fields.lastError ?? ''],
    );
    const status = Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : null;
    if (status === 'STALE') return false;
    if (status === 'CORRUPT') throw new Error('Sponsor slot observation is corrupt');
    throwIfSponsorOperationsSequenceLimitReached(status);
    if (status !== 'UPDATED')
      throw new Error('Sponsor slot observation returned an invalid result');
    return true;
  }

  async function readAll(): Promise<{
    readonly settings: SponsorOperationsSettings;
    readonly slots: readonly SponsorSlotAvailabilityRecord[];
    readonly sponsorRefillAccount: SponsorRefillAccountAvailabilityRecord;
  }> {
    const slotAddresses = settings.sponsorAddresses;
    const raw = await deps.client.eval(
      READ_ALL_LUA,
      [
        ...slotAddresses.map((address) => slotKey(address)),
        SPONSOR_REFILL_ACCOUNT_KEY,
        SPONSOR_REFILL_ACCOUNT_SPEND_KEY,
      ],
      [...slotAddresses],
    );
    if (
      !Array.isArray(raw) ||
      !Array.isArray(raw[0]) ||
      !Array.isArray(raw[1]) ||
      !Array.isArray(raw[2]) ||
      typeof raw[3] !== 'string'
    ) {
      throw new Error('RedisSponsorOperationsState.readAll: unexpected Redis response');
    }
    const redisTimeMs = parseSafeInteger(raw[3], 'Redis TIME', false)!;
    const spend = decodeSponsorRefillAccountSpendRecord(
      hashFromRedisRow(raw[2], 'Sponsor Refill Account spend'),
      settings,
    );
    const rows = raw[0] as readonly unknown[];
    if (rows.length !== slotAddresses.length) throw new Error('Unexpected sponsor slot row count');
    const slots = rows.map((rawRow, index): SponsorSlotAvailabilityRecord => {
      if (!Array.isArray(rawRow) || rawRow.length !== 2 || rawRow[0] !== slotAddresses[index]) {
        throw new Error('Unexpected sponsor slot row');
      }
      const record = decodeSponsorSlotRecord(
        hashFromRedisRow(rawRow[1], `Sponsor slot ${slotAddresses[index]}`),
        slotAddresses[index]!,
        settings,
        spend,
      );
      return {
        ...record,
        observationFresh: recordIsFresh(record.lastObservedAtMs, redisTimeMs, maxObservationAgeMs),
      };
    });
    const accountRecord = decodeSponsorRefillAccountRecord(
      hashFromRedisRow(raw[1], 'Sponsor Refill Account observation'),
      settings,
    );
    return {
      settings,
      slots,
      sponsorRefillAccount: {
        ...accountRecord,
        observationFresh: recordIsFresh(
          accountRecord.lastObservedAtMs,
          redisTimeMs,
          maxObservationAgeMs,
        ),
      },
    };
  }

  return {
    updateSlotIfWriteSeq,
    readSlot,
    readSlotAvailability,
    readSponsorRefillAccount,
    readAll,
  };
}
