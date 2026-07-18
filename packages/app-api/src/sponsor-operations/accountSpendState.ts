import {
  isValidSuiAddress,
  isValidTransactionDigest,
  normalizeSuiAddress,
} from '@mysten/sui/utils';
import type { RedisClientLike } from '@stelis/core-api';
import { isPositiveU64DecimalString, type SuiNetwork } from '@stelis/contracts';
import {
  decodeSponsorRefillAccountSpendRecord,
  decodeSponsorRefillAccountRecord,
  createSponsorRefillAccountWithdrawalOperationId,
  serializeSponsorRefillAccountSpendRecord,
  SPONSOR_REFILL_ACCOUNT_HASH_FIELDS,
  SPONSOR_REFILL_ACCOUNT_KEY,
  SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS,
  SPONSOR_REFILL_ACCOUNT_SPEND_KEY,
  SPONSOR_OPERATIONS_MAX_SEQUENCE,
  SPONSOR_OPERATIONS_SEQUENCE_LIMIT_RESULT,
  SPONSOR_SLOT_HASH_FIELDS,
  slotKey,
  throwIfSponsorOperationsSequenceLimitReached,
  type ActiveSponsorRefillAccountSpend,
  type FailedSponsorRefillAccountSpend,
  type ReadySponsorRefillAccountSpend,
  type ReconcilingSponsorRefillAccountSpend,
  type ReservedSponsorRefillAccountSpend,
  type SponsorRefillAccountSpend,
  type SponsorRefillAccountSpendKind,
  type SponsorRefillAccountSpendState,
  type SponsorRefillAccountSpendTerminalFailureKind,
  type SponsorRefillAccountWriteFields,
  type TerminalSponsorRefillAccountSpend,
} from './redisState.js';
import type { SponsorOperationsSettings } from './settings.js';
import {
  ACTIVE_SPONSOR_REFILL_OPERATION_STATES,
  isActiveSponsorRefillOperationState,
} from './status.js';

export type {
  ActiveSponsorRefillAccountSpend,
  FailedSponsorRefillAccountSpend,
  ReadySponsorRefillAccountSpend,
  ReconcilingSponsorRefillAccountSpend,
  ReservedSponsorRefillAccountSpend,
  SponsorRefillAccountSpend,
  SponsorRefillAccountSpendKind,
  SponsorRefillAccountSpendState,
  SponsorRefillAccountSpendTerminalFailureKind,
  SucceededSponsorRefillAccountSpend,
  TerminalSponsorRefillAccountSpend,
} from './redisState.js';
export { SPONSOR_REFILL_ACCOUNT_SPEND_KINDS } from './redisState.js';
export { createSponsorRefillAccountWithdrawalOperationId } from './redisState.js';

export type SponsorRefillAccountWithdrawalTerminalResult =
  | {
      readonly status: 'succeeded';
      readonly operationId: string;
      readonly sourceAddress: string;
      readonly destinationAddress: string;
      readonly amountMist: string;
      readonly digest: string;
    }
  | {
      readonly status: SponsorRefillAccountSpendTerminalFailureKind;
      readonly operationId: string;
      readonly sourceAddress: string;
      readonly destinationAddress: string;
      readonly amountMist: string;
      readonly digest: string | null;
      readonly error: string;
    };

export type SponsorRefillAccountWithdrawalReceipt =
  | { readonly type: 'issued'; readonly network: SuiNetwork }
  | {
      readonly type: 'accepted';
      readonly network: SuiNetwork;
      readonly operationId: string;
      readonly sourceAddress: string;
      readonly destinationAddress: string;
      readonly amountMist: string;
    }
  | {
      readonly type: 'terminal';
      readonly network: SuiNetwork;
      readonly result: SponsorRefillAccountWithdrawalTerminalResult;
    };

const WITHDRAWAL_RECEIPT_TAG = 'stelis:sponsor-refill-account-withdrawal-receipt';

function encodeWithdrawalReceipt(receipt: SponsorRefillAccountWithdrawalReceipt): string {
  if (receipt.type === 'issued') {
    return JSON.stringify([WITHDRAWAL_RECEIPT_TAG, 'issued', receipt.network]);
  }
  if (receipt.type === 'accepted') {
    return JSON.stringify([
      WITHDRAWAL_RECEIPT_TAG,
      'accepted',
      receipt.network,
      receipt.operationId,
      receipt.sourceAddress,
      receipt.destinationAddress,
      receipt.amountMist,
    ]);
  }
  return JSON.stringify([
    WITHDRAWAL_RECEIPT_TAG,
    'terminal',
    receipt.network,
    receipt.result.operationId,
    receipt.result.sourceAddress,
    receipt.result.destinationAddress,
    receipt.result.amountMist,
    receipt.result.status,
    receipt.result.digest,
    receipt.result.status === 'succeeded' ? null : receipt.result.error,
  ]);
}

export function encodeSponsorRefillAccountWithdrawalIssuedReceipt(network: SuiNetwork): string {
  return encodeWithdrawalReceipt({ type: 'issued', network });
}

function canonicalAddress(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !isValidSuiAddress(raw)) {
    throw new Error(`${label} is not a Sui address`);
  }
  const normalized = normalizeSuiAddress(raw);
  if (normalized !== raw) throw new Error(`${label} is not canonical`);
  return normalized;
}

function parseWithdrawalReceipt(
  raw: string,
  expectedNetwork: SuiNetwork,
  expectedNonceKey?: string,
): SponsorRefillAccountWithdrawalReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Sponsor Refill Account withdrawal receipt is malformed');
  }
  if (
    !Array.isArray(value) ||
    value[0] !== WITHDRAWAL_RECEIPT_TAG ||
    value[2] !== expectedNetwork
  ) {
    throw new Error('Sponsor Refill Account withdrawal receipt has an invalid network or schema');
  }
  let receipt: SponsorRefillAccountWithdrawalReceipt;
  if (value[1] === 'issued' && value.length === 3) {
    receipt = { type: 'issued', network: expectedNetwork };
  } else {
    const operationId = value[3];
    const amountMist = value[6];
    if (
      typeof operationId !== 'string' ||
      operationId.length === 0 ||
      typeof amountMist !== 'string' ||
      !isPositiveU64DecimalString(amountMist)
    ) {
      throw new Error(
        'Sponsor Refill Account withdrawal receipt has an invalid operation identity',
      );
    }
    const sourceAddress = canonicalAddress(value[4], 'Withdrawal receipt sourceAddress');
    const destinationAddress = canonicalAddress(value[5], 'Withdrawal receipt destinationAddress');
    if (
      expectedNonceKey !== undefined &&
      operationId !==
        createSponsorRefillAccountWithdrawalOperationId({
          network: expectedNetwork,
          sourceAddress,
          destinationAddress,
          amountMist,
          nonceKey: expectedNonceKey,
        })
    ) {
      throw new Error('Sponsor Refill Account withdrawal receipt operation identity is invalid');
    }
    if (value[1] === 'accepted' && value.length === 7) {
      receipt = {
        type: 'accepted',
        network: expectedNetwork,
        operationId,
        sourceAddress,
        destinationAddress,
        amountMist,
      };
    } else {
      if (value[1] !== 'terminal' || value.length !== 10) {
        throw new Error('Sponsor Refill Account withdrawal receipt has an invalid state');
      }
      const status = value[7];
      const digest = value[8];
      const error = value[9];
      if (
        (status !== 'succeeded' && status !== 'failed' && status !== 'runway_blocked') ||
        (digest !== null && (typeof digest !== 'string' || !isValidTransactionDigest(digest))) ||
        (error !== null && (typeof error !== 'string' || error.length === 0)) ||
        (status === 'succeeded' && (digest === null || error !== null)) ||
        (status === 'runway_blocked' && (digest !== null || error === null)) ||
        (status === 'failed' && error === null)
      ) {
        throw new Error('Sponsor Refill Account withdrawal terminal receipt is inconsistent');
      }
      receipt = {
        type: 'terminal',
        network: expectedNetwork,
        result:
          status === 'succeeded'
            ? {
                status,
                operationId,
                sourceAddress,
                destinationAddress,
                amountMist,
                digest: digest!,
              }
            : {
                status,
                operationId,
                sourceAddress,
                destinationAddress,
                amountMist,
                digest,
                error: error!,
              },
      };
    }
  }
  if (encodeWithdrawalReceipt(receipt) !== raw) {
    throw new Error('Sponsor Refill Account withdrawal receipt is not canonical');
  }
  return receipt;
}

export interface ReserveSponsorRefillAccountSpendInput {
  readonly operationId: string;
  readonly kind: SponsorRefillAccountSpendKind;
  readonly sourceAddress: string;
  readonly destinationAddress: string;
  readonly slotAddress: string | null;
  readonly amountMist: string;
  readonly observedSlotAddressBalanceMist: string | null;
  readonly expectedSlotWriteSequence: number | null;
  readonly expectedSourceObservationWriteSequence: number | null;
  readonly nonceKey: string | null;
}

export type ReserveSponsorRefillAccountSpendResult =
  | { readonly status: 'created'; readonly spend: SponsorRefillAccountSpend }
  | { readonly status: 'receipt'; readonly receipt: SponsorRefillAccountWithdrawalReceipt }
  | { readonly status: 'nonce_missing' }
  | { readonly status: 'slot_changed' }
  | { readonly status: 'source_changed' }
  | { readonly status: 'active'; readonly spend: SponsorRefillAccountSpend };

export interface MarkSponsorRefillAccountSpendReadyInput {
  readonly operationId: string;
  readonly expectedSequence: number;
  readonly expectedAccountWriteSequence: number;
  readonly gasBudgetMist: string;
  readonly transactionBytesBase64: string;
  readonly signature: string;
  readonly digest: string;
  readonly sourceBalanceMist: string;
}

export interface CompleteSponsorRefillAccountSpendInput {
  readonly operationId: string;
  readonly expectedSequence: number;
  readonly expectedAccountWriteSequence: number;
  readonly state: 'succeeded' | 'failed';
  readonly lastError: string;
  readonly account: SponsorRefillAccountWriteFields;
  readonly slot: {
    readonly address: string;
    readonly addressBalanceMist: string;
    readonly lastError: string;
    readonly expectedWriteSequence: number;
  } | null;
}

export interface ReconcileSponsorRefillAccountSpendInput {
  readonly operationId: string;
  readonly expectedSequence: number;
  readonly chainResult: 'succeeded' | 'failed';
  readonly lastError: string;
}

export interface FailReservedSponsorRefillAccountSpendInput {
  readonly operationId: string;
  readonly expectedSequence: number;
  readonly lastError: string;
  readonly failureKind: SponsorRefillAccountSpendTerminalFailureKind;
  readonly requiredSourceBalanceMist: string | null;
}

export interface SponsorRefillAccountObservationCursor {
  readonly operationId: string | null;
  readonly spendState: SponsorRefillAccountSpendState | null;
  readonly spendSequence: number;
  readonly writeSequence: number;
}

function isPositiveU64(raw: string | undefined): raw is string {
  return raw !== undefined && isPositiveU64DecimalString(raw);
}

function isU64(raw: string | undefined): raw is string {
  return raw === '0' || isPositiveU64(raw);
}

function assertSequence(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function exactHashGuardLua(key: string, fields: readonly string[], indent = ''): readonly string[] {
  return [
    `${indent}if redis.call('HLEN', ${key}) ~= ${fields.length} then return { 'MALFORMED' } end`,
    ...fields.map(
      (field) =>
        `${indent}if redis.call('HEXISTS', ${key}, '${field}') ~= 1 then return { 'MALFORMED' } end`,
    ),
  ];
}

function expectedHashGuardLua(
  key: string,
  fields: readonly string[],
  firstArg: number,
): readonly string[] {
  return [
    ...exactHashGuardLua(key, fields),
    ...fields.map(
      (field, index) =>
        `if (redis.call('HGET', ${key}, '${field}') or '') ~= ARGV[${firstArg + index}] then return { 'STALE' } end`,
    ),
  ];
}

function writeHashLua(
  key: string,
  fields: readonly string[],
  firstArg: number,
  indent = '',
): string {
  const pairs = fields.flatMap((field, index) => [`'${field}'`, `ARGV[${firstArg + index}]`]);
  return `${indent}redis.call('HSET', ${key}, ${pairs.join(', ')})`;
}

const SPEND_FIELD_COUNT = SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS.length;
const NEXT_SPEND_FIRST_ARG = SPEND_FIELD_COUNT + 1;
const AFTER_NEXT_SPEND_ARG = SPEND_FIELD_COUNT * 2 + 1;

const RESERVE_USES_NONCE_ARG = 1;
const RESERVE_SPEND_FIRST_ARG = 2;
const RESERVE_SLOT_BALANCE_ARG = RESERVE_SPEND_FIRST_ARG + SPEND_FIELD_COUNT;
const RESERVE_SLOT_SEQUENCE_ARG = RESERVE_SLOT_BALANCE_ARG + 1;
const RESERVE_ISSUED_RECEIPT_ARG = RESERVE_SLOT_SEQUENCE_ARG + 1;
const RESERVE_ACCEPTED_RECEIPT_ARG = RESERVE_ISSUED_RECEIPT_ARG + 1;
const RESERVE_RECEIPT_TTL_ARG = RESERVE_ACCEPTED_RECEIPT_ARG + 1;
const RESERVE_ACCOUNT_SEQUENCE_ARG = RESERVE_RECEIPT_TTL_ARG + 1;

export const RESERVE_SPONSOR_REFILL_ACCOUNT_SPEND_LUA = [
  "local spendExists = redis.call('EXISTS', KEYS[1])",
  'if spendExists == 1 then',
  ...exactHashGuardLua('KEYS[1]', SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS, '  '),
  "  local currentState = redis.call('HGET', KEYS[1], 'state') or ''",
  "  if currentState ~= 'succeeded' and currentState ~= 'failed' then return { 'ACTIVE' } end",
  'end',
  `if ARGV[${RESERVE_USES_NONCE_ARG}] == '1' then`,
  "  local receipt = redis.call('GET', KEYS[3])",
  "  if not receipt then return { 'NONCE_MISSING' } end",
  `  if receipt ~= ARGV[${RESERVE_ISSUED_RECEIPT_ARG}] then return { 'RECEIPT', receipt } end`,
  'end',
  `if ARGV[${RESERVE_ACCOUNT_SEQUENCE_ARG}] ~= '' then`,
  ...exactHashGuardLua('KEYS[2]', SPONSOR_REFILL_ACCOUNT_HASH_FIELDS, '  '),
  `  if (redis.call('HGET', KEYS[2], 'writeSeq') or '') ~= ARGV[${RESERVE_ACCOUNT_SEQUENCE_ARG}] then return { 'SOURCE_CHANGED' } end`,
  'end',
  `if ARGV[${RESERVE_SLOT_SEQUENCE_ARG}] ~= '' then`,
  ...exactHashGuardLua('KEYS[4]', SPONSOR_SLOT_HASH_FIELDS, '  '),
  `  if (redis.call('HGET', KEYS[4], 'writeSeq') or '') ~= ARGV[${RESERVE_SLOT_SEQUENCE_ARG}] then return { 'SLOT_CHANGED' } end`,
  `  if (redis.call('HGET', KEYS[4], 'addressBalanceMist') or '') ~= ARGV[${RESERVE_SLOT_BALANCE_ARG}] then return { 'SLOT_CHANGED' } end`,
  `  if ARGV[${RESERVE_SLOT_SEQUENCE_ARG}] == '${SPONSOR_OPERATIONS_MAX_SEQUENCE}' then return { '${SPONSOR_OPERATIONS_SEQUENCE_LIMIT_RESULT}' } end`,
  'end',
  `if ARGV[${RESERVE_USES_NONCE_ARG}] == '1' then redis.call('SET', KEYS[3], ARGV[${RESERVE_ACCEPTED_RECEIPT_ARG}], 'PX', ARGV[${RESERVE_RECEIPT_TTL_ARG}]) end`,
  `if ARGV[${RESERVE_SLOT_SEQUENCE_ARG}] ~= '' then redis.call('HSET', KEYS[4], 'writeSeq', tostring(tonumber(ARGV[${RESERVE_SLOT_SEQUENCE_ARG}]) + 1)) end`,
  writeHashLua('KEYS[1]', SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS, RESERVE_SPEND_FIRST_ARG),
  "return { 'CREATED' }",
].join('\n');

const READY_ACCOUNT_SEQUENCE_ARG = AFTER_NEXT_SPEND_ARG;
const READY_ACCOUNT_BALANCE_ARG = READY_ACCOUNT_SEQUENCE_ARG + 1;

export const MARK_SPONSOR_REFILL_ACCOUNT_SPEND_READY_LUA = [
  ...expectedHashGuardLua('KEYS[1]', SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS, 1),
  "if redis.call('HGET', KEYS[1], 'state') ~= 'reserved' then return { 'STALE' } end",
  "local accountExists = redis.call('EXISTS', KEYS[2])",
  'if accountExists == 1 then',
  ...exactHashGuardLua('KEYS[2]', SPONSOR_REFILL_ACCOUNT_HASH_FIELDS, '  '),
  'end',
  "local currentAccountSequence = redis.call('HGET', KEYS[2], 'writeSeq') or '0'",
  `local updateAccount = currentAccountSequence == ARGV[${READY_ACCOUNT_SEQUENCE_ARG}]`,
  `if updateAccount and currentAccountSequence == '${SPONSOR_OPERATIONS_MAX_SEQUENCE}' then return { '${SPONSOR_OPERATIONS_SEQUENCE_LIMIT_RESULT}' } end`,
  "local nextAccountSequence = updateAccount and tostring(tonumber(currentAccountSequence) + 1) or ''",
  "local nowMs = ''",
  'if updateAccount then',
  "  local time = redis.call('TIME')",
  '  nowMs = tostring(tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000))',
  'end',
  writeHashLua('KEYS[1]', SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS, NEXT_SPEND_FIRST_ARG),
  'if updateAccount then',
  `  redis.call('HSET', KEYS[2], 'totalBalanceMist', ARGV[${READY_ACCOUNT_BALANCE_ARG}], 'lastError', '', 'lastObservedAtMs', nowMs, 'writeSeq', nextAccountSequence)`,
  'end',
  "return { 'READY' }",
].join('\n');

export const RECONCILE_SPONSOR_REFILL_ACCOUNT_SPEND_LUA = [
  ...expectedHashGuardLua('KEYS[1]', SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS, 1),
  "if redis.call('HGET', KEYS[1], 'state') ~= 'ready' then return { 'STALE' } end",
  writeHashLua('KEYS[1]', SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS, NEXT_SPEND_FIRST_ARG),
  "return { 'RECONCILING' }",
].join('\n');

const FAIL_RECEIPT_ARG = AFTER_NEXT_SPEND_ARG;
const FAIL_RECEIPT_TTL_ARG = FAIL_RECEIPT_ARG + 1;

export const FAIL_RESERVED_SPONSOR_REFILL_ACCOUNT_SPEND_LUA = [
  ...expectedHashGuardLua('KEYS[1]', SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS, 1),
  "if redis.call('HGET', KEYS[1], 'state') ~= 'reserved' then return { 'STALE' } end",
  "local nonceKey = redis.call('HGET', KEYS[1], 'nonceKey') or ''",
  "if nonceKey ~= '' and nonceKey ~= KEYS[2] then return { 'RECEIPT_MISMATCH' } end",
  writeHashLua('KEYS[1]', SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS, NEXT_SPEND_FIRST_ARG),
  `if nonceKey ~= '' then redis.call('SET', KEYS[2], ARGV[${FAIL_RECEIPT_ARG}], 'PX', ARGV[${FAIL_RECEIPT_TTL_ARG}]) end`,
  "return { 'FAILED' }",
].join('\n');

const COMPLETE_ACCOUNT_SEQUENCE_ARG = AFTER_NEXT_SPEND_ARG;
const COMPLETE_ACCOUNT_BALANCE_ARG = COMPLETE_ACCOUNT_SEQUENCE_ARG + 1;
const COMPLETE_ACCOUNT_ERROR_ARG = COMPLETE_ACCOUNT_BALANCE_ARG + 1;
const COMPLETE_HAS_SLOT_ARG = COMPLETE_ACCOUNT_ERROR_ARG + 1;
const COMPLETE_SLOT_SEQUENCE_ARG = COMPLETE_HAS_SLOT_ARG + 1;
const COMPLETE_SLOT_BALANCE_ARG = COMPLETE_SLOT_SEQUENCE_ARG + 1;
const COMPLETE_SLOT_ERROR_ARG = COMPLETE_SLOT_BALANCE_ARG + 1;
const COMPLETE_RECEIPT_ARG = COMPLETE_SLOT_ERROR_ARG + 1;
const COMPLETE_RECEIPT_TTL_ARG = COMPLETE_RECEIPT_ARG + 1;

export const COMPLETE_SPONSOR_REFILL_ACCOUNT_SPEND_LUA = [
  ...expectedHashGuardLua('KEYS[1]', SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS, 1),
  "if redis.call('HGET', KEYS[1], 'state') ~= 'reconciling' then return { 'STALE' } end",
  "local nonceKey = redis.call('HGET', KEYS[1], 'nonceKey') or ''",
  "if nonceKey ~= '' and nonceKey ~= KEYS[4] then return { 'RECEIPT_MISMATCH' } end",
  "local accountExists = redis.call('EXISTS', KEYS[2])",
  'if accountExists == 1 then',
  ...exactHashGuardLua('KEYS[2]', SPONSOR_REFILL_ACCOUNT_HASH_FIELDS, '  '),
  'end',
  "local currentAccountSequence = redis.call('HGET', KEYS[2], 'writeSeq') or '0'",
  `local updateAccount = currentAccountSequence == ARGV[${COMPLETE_ACCOUNT_SEQUENCE_ARG}]`,
  `if updateAccount and currentAccountSequence == '${SPONSOR_OPERATIONS_MAX_SEQUENCE}' then return { '${SPONSOR_OPERATIONS_SEQUENCE_LIMIT_RESULT}' } end`,
  "local nextAccountSequence = updateAccount and tostring(tonumber(currentAccountSequence) + 1) or ''",
  `local updateSlot = ARGV[${COMPLETE_HAS_SLOT_ARG}] == '1'`,
  "local nextSlotSequence = ''",
  'if updateSlot then',
  ...exactHashGuardLua('KEYS[3]', SPONSOR_SLOT_HASH_FIELDS, '  '),
  `  if redis.call('HGET', KEYS[3], 'writeSeq') ~= ARGV[${COMPLETE_SLOT_SEQUENCE_ARG}] then return { 'STALE' } end`,
  `  if ARGV[${COMPLETE_SLOT_SEQUENCE_ARG}] == '${SPONSOR_OPERATIONS_MAX_SEQUENCE}' then return { '${SPONSOR_OPERATIONS_SEQUENCE_LIMIT_RESULT}' } end`,
  `  nextSlotSequence = tostring(tonumber(ARGV[${COMPLETE_SLOT_SEQUENCE_ARG}]) + 1)`,
  'end',
  "local observationNowMs = ''",
  'if updateAccount or updateSlot then',
  "  local time = redis.call('TIME')",
  '  observationNowMs = tostring(tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000))',
  'end',
  writeHashLua('KEYS[1]', SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS, NEXT_SPEND_FIRST_ARG),
  'if updateAccount then',
  `  redis.call('HSET', KEYS[2], 'totalBalanceMist', ARGV[${COMPLETE_ACCOUNT_BALANCE_ARG}], 'lastError', ARGV[${COMPLETE_ACCOUNT_ERROR_ARG}], 'lastObservedAtMs', ARGV[${COMPLETE_ACCOUNT_BALANCE_ARG}] ~= '' and observationNowMs or '', 'writeSeq', nextAccountSequence)`,
  'end',
  'if updateSlot then',
  `  redis.call('HSET', KEYS[3], 'addressBalanceMist', ARGV[${COMPLETE_SLOT_BALANCE_ARG}], 'lastError', ARGV[${COMPLETE_SLOT_ERROR_ARG}], 'lastObservedAtMs', ARGV[${COMPLETE_SLOT_BALANCE_ARG}] ~= '' and observationNowMs or '', 'writeSeq', nextSlotSequence)`,
  'end',
  `if nonceKey ~= '' then redis.call('SET', KEYS[4], ARGV[${COMPLETE_RECEIPT_ARG}], 'PX', ARGV[${COMPLETE_RECEIPT_TTL_ARG}]) end`,
  "return { 'COMPLETED' }",
].join('\n');

export const UPDATE_SPONSOR_REFILL_ACCOUNT_OBSERVATION_LUA = [
  "local spendExists = redis.call('EXISTS', KEYS[1])",
  'if spendExists == 1 then',
  ...exactHashGuardLua('KEYS[1]', SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS, '  '),
  'end',
  "local operationId = spendExists == 1 and (redis.call('HGET', KEYS[1], 'operationId') or '') or ''",
  "local spendSequence = spendExists == 1 and (redis.call('HGET', KEYS[1], 'sequence') or '0') or '0'",
  "local spendState = spendExists == 1 and (redis.call('HGET', KEYS[1], 'state') or '') or ''",
  `if spendExists == 1 and (${ACTIVE_SPONSOR_REFILL_OPERATION_STATES.map((state) => `spendState == '${state}'`).join(' or ')}) then return { 'STALE' } end`,
  "if operationId ~= ARGV[1] or spendSequence ~= ARGV[2] then return { 'STALE' } end",
  "local accountExists = redis.call('EXISTS', KEYS[2])",
  'if accountExists == 1 then',
  ...exactHashGuardLua('KEYS[2]', SPONSOR_REFILL_ACCOUNT_HASH_FIELDS, '  '),
  'end',
  "local currentAccountSequence = redis.call('HGET', KEYS[2], 'writeSeq') or '0'",
  "if currentAccountSequence ~= ARGV[3] then return { 'STALE' } end",
  `if currentAccountSequence == '${SPONSOR_OPERATIONS_MAX_SEQUENCE}' then return { '${SPONSOR_OPERATIONS_SEQUENCE_LIMIT_RESULT}' } end`,
  'local nextAccountSequence = tostring(tonumber(currentAccountSequence) + 1)',
  "local time = redis.call('TIME')",
  'local nowMs = tostring(tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000))',
  "redis.call('HSET', KEYS[2], 'totalBalanceMist', ARGV[4], 'lastError', ARGV[5], 'lastObservedAtMs', ARGV[4] ~= '' and nowMs or '', 'writeSeq', nextAccountSequence)",
  "return { 'UPDATED' }",
].join('\n');

const READ_CURSOR_LUA = [
  "return { redis.call('HGETALL', KEYS[1]), redis.call('HGETALL', KEYS[2]) }",
].join('\n');

function firstResult(raw: unknown): string | null {
  return Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : null;
}

function hashFromRedisRow(raw: unknown, label: string): Record<string, string> {
  if (!Array.isArray(raw) || raw.length % 2 !== 0) throw new Error(`${label} is malformed`);
  const hash: Record<string, string> = {};
  for (let index = 0; index < raw.length; index += 2) {
    const field = raw[index];
    const value = raw[index + 1];
    if (typeof field !== 'string' || typeof value !== 'string' || Object.hasOwn(hash, field)) {
      throw new Error(`${label} is malformed`);
    }
    hash[field] = value;
  }
  return hash;
}

function flattenSpend(
  spend: SponsorRefillAccountSpend,
  settings: SponsorOperationsSettings,
): string[] {
  const hash = serializeSponsorRefillAccountSpendRecord(spend, settings);
  return SPONSOR_REFILL_ACCOUNT_SPEND_HASH_FIELDS.map((field) => hash[field]!);
}

function terminalReceipt(
  spend: SponsorRefillAccountSpend,
  result:
    | { readonly status: 'succeeded'; readonly digest: string }
    | {
        readonly status: SponsorRefillAccountSpendTerminalFailureKind;
        readonly digest: string | null;
        readonly error: string;
      },
  settings: SponsorOperationsSettings,
): string {
  if (spend.kind !== 'withdrawal') return '';
  return encodeWithdrawalReceipt({
    type: 'terminal',
    network: settings.network,
    result: {
      ...result,
      operationId: spend.operationId,
      sourceAddress: spend.sourceAddress,
      destinationAddress: spend.destinationAddress,
      amountMist: spend.amountMist,
    } as SponsorRefillAccountWithdrawalTerminalResult,
  });
}

export interface SponsorRefillAccountSpendStateStore {
  read(): Promise<SponsorRefillAccountSpend | null>;
  readWithdrawalReceipt(nonceKey: string): Promise<SponsorRefillAccountWithdrawalReceipt | null>;
  readAccountObservationCursor(): Promise<SponsorRefillAccountObservationCursor>;
  reserve(
    input: ReserveSponsorRefillAccountSpendInput,
  ): Promise<ReserveSponsorRefillAccountSpendResult>;
  markReady(
    input: MarkSponsorRefillAccountSpendReadyInput,
  ): Promise<SponsorRefillAccountSpend | null>;
  markReconciling(
    input: ReconcileSponsorRefillAccountSpendInput,
  ): Promise<SponsorRefillAccountSpend | null>;
  complete(
    input: CompleteSponsorRefillAccountSpendInput,
  ): Promise<TerminalSponsorRefillAccountSpend | null>;
  failReserved(
    input: FailReservedSponsorRefillAccountSpendInput,
  ): Promise<FailedSponsorRefillAccountSpend | null>;
  updateAccountObservation(
    cursor: SponsorRefillAccountObservationCursor,
    fields: SponsorRefillAccountWriteFields,
  ): Promise<boolean>;
}

export interface SponsorRefillAccountSpendStateOptions {
  readonly settings: SponsorOperationsSettings;
}

export function createSponsorRefillAccountSpendState(
  client: RedisClientLike,
  options: SponsorRefillAccountSpendStateOptions,
): SponsorRefillAccountSpendStateStore {
  const { settings } = options;

  async function read(): Promise<SponsorRefillAccountSpend | null> {
    return decodeSponsorRefillAccountSpendRecord(
      await client.hgetall(SPONSOR_REFILL_ACCOUNT_SPEND_KEY),
      settings,
    );
  }

  async function readWithdrawalReceipt(
    nonceKey: string,
  ): Promise<SponsorRefillAccountWithdrawalReceipt | null> {
    if (!nonceKey) throw new Error('Withdrawal receipt key must be non-empty');
    const raw = await client.get(nonceKey);
    return raw === null ? null : parseWithdrawalReceipt(raw, settings.network, nonceKey);
  }

  async function readAccountObservationCursor(): Promise<SponsorRefillAccountObservationCursor> {
    const raw = await client.eval(
      READ_CURSOR_LUA,
      [SPONSOR_REFILL_ACCOUNT_SPEND_KEY, SPONSOR_REFILL_ACCOUNT_KEY],
      [],
    );
    if (!Array.isArray(raw) || !Array.isArray(raw[0]) || !Array.isArray(raw[1])) {
      throw new Error('Sponsor Refill Account observation cursor is malformed');
    }
    const spend = decodeSponsorRefillAccountSpendRecord(
      hashFromRedisRow(raw[0], 'Sponsor Refill Account spend'),
      settings,
    );
    const accountHash = hashFromRedisRow(raw[1], 'Sponsor Refill Account observation');
    const account =
      Object.keys(accountHash).length === 0
        ? null
        : decodeSponsorRefillAccountRecord(accountHash, settings);
    return {
      operationId: spend?.operationId ?? null,
      spendState: spend?.state ?? null,
      spendSequence: spend?.sequence ?? 0,
      writeSequence: account?.writeSeq ?? 0,
    };
  }

  function assertReserveInput(input: ReserveSponsorRefillAccountSpendInput): void {
    if (!input.operationId || !isPositiveU64(input.amountMist)) {
      throw new Error('Sponsor Refill Account reservation is malformed');
    }
    if (
      canonicalAddress(input.sourceAddress, 'Reservation sourceAddress') !==
      settings.sponsorRefillAccountAddress
    ) {
      throw new Error('Reservation sourceAddress is not the configured refill account');
    }
    const destination = canonicalAddress(
      input.destinationAddress,
      'Reservation destinationAddress',
    );
    if (input.kind === 'refill') {
      if (
        input.slotAddress === null ||
        canonicalAddress(input.slotAddress, 'Reservation slotAddress') !== destination ||
        !settings.sponsorAddresses.includes(destination) ||
        input.nonceKey !== null ||
        !isU64(input.observedSlotAddressBalanceMist ?? undefined) ||
        input.expectedSlotWriteSequence === null
      ) {
        throw new Error('Refill reservation is not bound to one configured sponsor address');
      }
      assertSequence(input.expectedSlotWriteSequence, 'expectedSlotWriteSequence');
    } else if (
      input.slotAddress !== null ||
      input.nonceKey === null ||
      input.nonceKey.length === 0 ||
      input.observedSlotAddressBalanceMist !== null ||
      input.expectedSlotWriteSequence !== null ||
      input.expectedSourceObservationWriteSequence !== null
    ) {
      throw new Error('Withdrawal reservation is not bound to one verified request');
    }
    if (input.expectedSourceObservationWriteSequence !== null) {
      assertSequence(
        input.expectedSourceObservationWriteSequence,
        'expectedSourceObservationWriteSequence',
      );
    }
  }

  async function reserve(
    input: ReserveSponsorRefillAccountSpendInput,
  ): Promise<ReserveSponsorRefillAccountSpendResult> {
    assertReserveInput(input);
    const usesNonce = input.nonceKey !== null;
    const next: ReservedSponsorRefillAccountSpend =
      input.kind === 'refill'
        ? {
            network: settings.network,
            operationId: input.operationId,
            kind: input.kind,
            sourceAddress: input.sourceAddress,
            destinationAddress: input.destinationAddress,
            slotAddress: input.slotAddress!,
            nonceKey: null,
            amountMist: input.amountMist,
            state: 'reserved',
            sequence: 1,
          }
        : {
            network: settings.network,
            operationId: input.operationId,
            kind: input.kind,
            sourceAddress: input.sourceAddress,
            destinationAddress: input.destinationAddress,
            slotAddress: null,
            nonceKey: input.nonceKey!,
            amountMist: input.amountMist,
            state: 'reserved',
            sequence: 1,
          };
    const nextFields = flattenSpend(next, settings);
    const issuedReceipt = usesNonce
      ? encodeSponsorRefillAccountWithdrawalIssuedReceipt(settings.network)
      : '';
    const acceptedReceipt = usesNonce
      ? encodeWithdrawalReceipt({
          type: 'accepted',
          network: settings.network,
          operationId: input.operationId,
          sourceAddress: input.sourceAddress,
          destinationAddress: input.destinationAddress,
          amountMist: input.amountMist,
        })
      : '';
    const raw = await client.eval(
      RESERVE_SPONSOR_REFILL_ACCOUNT_SPEND_LUA,
      [
        SPONSOR_REFILL_ACCOUNT_SPEND_KEY,
        SPONSOR_REFILL_ACCOUNT_KEY,
        input.nonceKey ?? SPONSOR_REFILL_ACCOUNT_SPEND_KEY,
        input.slotAddress === null ? SPONSOR_REFILL_ACCOUNT_SPEND_KEY : slotKey(input.slotAddress),
      ],
      [
        usesNonce ? '1' : '0',
        ...nextFields,
        input.observedSlotAddressBalanceMist ?? '',
        input.expectedSlotWriteSequence === null ? '' : String(input.expectedSlotWriteSequence),
        issuedReceipt,
        acceptedReceipt,
        String(settings.withdrawalReceiptTtlMs),
        input.expectedSourceObservationWriteSequence === null
          ? ''
          : String(input.expectedSourceObservationWriteSequence),
      ],
    );
    const status = firstResult(raw);
    if (status === 'NONCE_MISSING') return { status: 'nonce_missing' };
    if (status === 'SLOT_CHANGED') return { status: 'slot_changed' };
    if (status === 'SOURCE_CHANGED') return { status: 'source_changed' };
    if (status === 'MALFORMED')
      throw new Error('Sponsor Refill Account durable record is malformed');
    throwIfSponsorOperationsSequenceLimitReached(status);
    if (status === 'RECEIPT') {
      const receiptRaw = Array.isArray(raw) && typeof raw[1] === 'string' ? raw[1] : null;
      if (receiptRaw === null) throw new Error('Withdrawal receipt result is malformed');
      return {
        status: 'receipt',
        receipt: parseWithdrawalReceipt(receiptRaw, settings.network, input.nonceKey ?? undefined),
      };
    }
    const spend = await read();
    if (spend === null) throw new Error('Sponsor Refill Account reservation did not persist');
    if (status === 'ACTIVE') return { status: 'active', spend };
    if (status !== 'CREATED' || spend.operationId !== input.operationId) {
      throw new Error('Sponsor Refill Account reservation returned an invalid result');
    }
    return { status: 'created', spend };
  }

  async function markReady(
    input: MarkSponsorRefillAccountSpendReadyInput,
  ): Promise<SponsorRefillAccountSpend | null> {
    assertSequence(input.expectedSequence, 'expectedSequence');
    assertSequence(input.expectedAccountWriteSequence, 'expectedAccountWriteSequence');
    if (
      !isPositiveU64(input.gasBudgetMist) ||
      !isU64(input.sourceBalanceMist) ||
      !input.transactionBytesBase64 ||
      !input.signature ||
      !input.digest
    ) {
      throw new Error('Ready transition identity is malformed');
    }
    const before = await read();
    if (
      before === null ||
      before.operationId !== input.operationId ||
      before.sequence !== input.expectedSequence ||
      before.state !== 'reserved'
    )
      return null;
    const next: ReadySponsorRefillAccountSpend = {
      ...before,
      state: 'ready',
      gasBudgetMist: input.gasBudgetMist,
      transactionBytesBase64: input.transactionBytesBase64,
      signature: input.signature,
      digest: input.digest,
      sequence: 2,
    };
    const raw = await client.eval(
      MARK_SPONSOR_REFILL_ACCOUNT_SPEND_READY_LUA,
      [SPONSOR_REFILL_ACCOUNT_SPEND_KEY, SPONSOR_REFILL_ACCOUNT_KEY],
      [
        ...flattenSpend(before, settings),
        ...flattenSpend(next, settings),
        String(input.expectedAccountWriteSequence),
        input.sourceBalanceMist,
      ],
    );
    const status = firstResult(raw);
    if (status === 'STALE') return null;
    if (status === 'MALFORMED')
      throw new Error('Sponsor Refill Account durable record is malformed');
    throwIfSponsorOperationsSequenceLimitReached(status);
    if (status !== 'READY') throw new Error('Ready transition returned an invalid result');
    return read();
  }

  async function markReconciling(
    input: ReconcileSponsorRefillAccountSpendInput,
  ): Promise<SponsorRefillAccountSpend | null> {
    assertSequence(input.expectedSequence, 'expectedSequence');
    if ((input.chainResult === 'succeeded') !== (input.lastError === '')) {
      throw new Error('Reconciliation result and error disagree');
    }
    const before = await read();
    if (
      before === null ||
      before.operationId !== input.operationId ||
      before.sequence !== input.expectedSequence ||
      before.state !== 'ready'
    )
      return null;
    const next: ReconcilingSponsorRefillAccountSpend =
      input.chainResult === 'succeeded'
        ? { ...before, state: 'reconciling', chainResult: 'succeeded', sequence: 3 }
        : {
            ...before,
            state: 'reconciling',
            chainResult: 'failed',
            error: input.lastError,
            sequence: 3,
          };
    const raw = await client.eval(
      RECONCILE_SPONSOR_REFILL_ACCOUNT_SPEND_LUA,
      [SPONSOR_REFILL_ACCOUNT_SPEND_KEY],
      [...flattenSpend(before, settings), ...flattenSpend(next, settings)],
    );
    const status = firstResult(raw);
    if (status === 'STALE') return null;
    if (status === 'MALFORMED')
      throw new Error('Sponsor Refill Account durable record is malformed');
    throwIfSponsorOperationsSequenceLimitReached(status);
    if (status !== 'RECONCILING')
      throw new Error('Reconciliation transition returned an invalid result');
    return read();
  }

  async function complete(
    input: CompleteSponsorRefillAccountSpendInput,
  ): Promise<TerminalSponsorRefillAccountSpend | null> {
    assertSequence(input.expectedSequence, 'expectedSequence');
    assertSequence(input.expectedAccountWriteSequence, 'expectedAccountWriteSequence');
    if ((input.state === 'succeeded') !== (input.lastError === '')) {
      throw new Error('Terminal state and error disagree');
    }
    const before = await read();
    if (
      before === null ||
      before.operationId !== input.operationId ||
      before.sequence !== input.expectedSequence ||
      before.state !== 'reconciling'
    )
      return null;
    if (before.chainResult !== input.state)
      throw new Error('Terminal state disagrees with chain result');
    if (
      (input.slot === null) !== (before.kind === 'withdrawal') ||
      (input.slot !== null && input.slot.address !== before.slotAddress)
    ) {
      throw new Error('Terminal slot identity changed');
    }
    if (
      (input.account.totalBalanceMist !== undefined && !isU64(input.account.totalBalanceMist)) ||
      (input.slot !== null && !isU64(input.slot.addressBalanceMist))
    ) {
      throw new Error('Terminal balance observation is malformed');
    }
    if (input.slot !== null)
      assertSequence(input.slot.expectedWriteSequence, 'slot.expectedWriteSequence');
    const terminalBase =
      before.kind === 'refill'
        ? {
            network: before.network,
            operationId: before.operationId,
            kind: before.kind,
            sourceAddress: before.sourceAddress,
            destinationAddress: before.destinationAddress,
            slotAddress: before.slotAddress,
            nonceKey: null,
            amountMist: before.amountMist,
            sequence: 4,
          }
        : {
            network: before.network,
            operationId: before.operationId,
            kind: before.kind,
            sourceAddress: before.sourceAddress,
            destinationAddress: before.destinationAddress,
            slotAddress: null,
            nonceKey: before.nonceKey,
            amountMist: before.amountMist,
            sequence: 4,
          };
    const next: TerminalSponsorRefillAccountSpend =
      input.state === 'succeeded'
        ? { ...terminalBase, state: 'succeeded', digest: before.digest }
        : {
            ...terminalBase,
            state: 'failed',
            digest: before.digest,
            failureKind: 'failed',
            requiredSourceBalanceMist: null,
            error: input.lastError,
          };
    const receipt = terminalReceipt(
      before,
      input.state === 'succeeded'
        ? { status: 'succeeded', digest: before.digest }
        : { status: 'failed', digest: before.digest, error: input.lastError },
      settings,
    );
    const raw = await client.eval(
      COMPLETE_SPONSOR_REFILL_ACCOUNT_SPEND_LUA,
      [
        SPONSOR_REFILL_ACCOUNT_SPEND_KEY,
        SPONSOR_REFILL_ACCOUNT_KEY,
        input.slot === null ? SPONSOR_REFILL_ACCOUNT_SPEND_KEY : slotKey(input.slot.address),
        before.nonceKey ?? SPONSOR_REFILL_ACCOUNT_SPEND_KEY,
      ],
      [
        ...flattenSpend(before, settings),
        ...flattenSpend(next, settings),
        String(input.expectedAccountWriteSequence),
        input.account.totalBalanceMist ?? '',
        input.account.lastError ?? '',
        input.slot === null ? '0' : '1',
        input.slot === null ? '' : String(input.slot.expectedWriteSequence),
        input.slot?.addressBalanceMist ?? '',
        input.slot?.lastError ?? '',
        receipt,
        String(settings.withdrawalReceiptTtlMs),
      ],
    );
    const status = firstResult(raw);
    if (status === 'STALE') return null;
    if (status === 'MALFORMED')
      throw new Error('Sponsor Refill Account durable record is malformed');
    if (status === 'RECEIPT_MISMATCH') throw new Error('Terminal receipt identity changed');
    throwIfSponsorOperationsSequenceLimitReached(status);
    if (status !== 'COMPLETED') throw new Error('Terminal transition returned an invalid result');
    const after = await read();
    return after !== null && (after.state === 'succeeded' || after.state === 'failed')
      ? after
      : null;
  }

  async function failReserved(
    input: FailReservedSponsorRefillAccountSpendInput,
  ): Promise<FailedSponsorRefillAccountSpend | null> {
    assertSequence(input.expectedSequence, 'expectedSequence');
    if (!input.lastError) throw new Error('Reserved failure requires an error');
    if (
      input.requiredSourceBalanceMist !== null &&
      !isPositiveU64(input.requiredSourceBalanceMist)
    ) {
      throw new Error('Required source balance is malformed');
    }
    const before = await read();
    if (
      before === null ||
      before.operationId !== input.operationId ||
      before.sequence !== input.expectedSequence ||
      before.state !== 'reserved'
    )
      return null;
    if (
      (input.requiredSourceBalanceMist !== null) !==
      (before.kind === 'refill' && input.failureKind === 'runway_blocked')
    ) {
      throw new Error('Required source balance does not match the failure');
    }
    const next: FailedSponsorRefillAccountSpend = {
      ...before,
      state: 'failed',
      digest: null,
      failureKind: input.failureKind,
      requiredSourceBalanceMist: input.requiredSourceBalanceMist,
      error: input.lastError,
      sequence: 2,
    };
    const receipt = terminalReceipt(
      before,
      { status: input.failureKind, digest: null, error: input.lastError },
      settings,
    );
    const raw = await client.eval(
      FAIL_RESERVED_SPONSOR_REFILL_ACCOUNT_SPEND_LUA,
      [SPONSOR_REFILL_ACCOUNT_SPEND_KEY, before.nonceKey ?? SPONSOR_REFILL_ACCOUNT_SPEND_KEY],
      [
        ...flattenSpend(before, settings),
        ...flattenSpend(next, settings),
        receipt,
        String(settings.withdrawalReceiptTtlMs),
      ],
    );
    const status = firstResult(raw);
    if (status === 'STALE') return null;
    if (status === 'MALFORMED')
      throw new Error('Sponsor Refill Account durable record is malformed');
    if (status === 'RECEIPT_MISMATCH') throw new Error('Reserved failure receipt identity changed');
    throwIfSponsorOperationsSequenceLimitReached(status);
    if (status !== 'FAILED') throw new Error('Reserved failure returned an invalid result');
    const after = await read();
    return after?.state === 'failed' ? after : null;
  }

  async function updateAccountObservation(
    cursor: SponsorRefillAccountObservationCursor,
    fields: SponsorRefillAccountWriteFields,
  ): Promise<boolean> {
    assertSequence(cursor.spendSequence, 'cursor.spendSequence');
    assertSequence(cursor.writeSequence, 'cursor.writeSequence');
    if (isActiveSponsorRefillOperationState(cursor.spendState)) return false;
    const totalBalanceMist = fields.totalBalanceMist ?? '';
    if (totalBalanceMist !== '' && !isU64(totalBalanceMist)) {
      throw new Error('Sponsor Refill Account balance is malformed');
    }
    const raw = await client.eval(
      UPDATE_SPONSOR_REFILL_ACCOUNT_OBSERVATION_LUA,
      [SPONSOR_REFILL_ACCOUNT_SPEND_KEY, SPONSOR_REFILL_ACCOUNT_KEY],
      [
        cursor.operationId ?? '',
        String(cursor.spendSequence),
        String(cursor.writeSequence),
        totalBalanceMist,
        fields.lastError ?? '',
      ],
    );
    const status = firstResult(raw);
    if (status === 'STALE') return false;
    if (status === 'MALFORMED') throw new Error('Sponsor Refill Account record is malformed');
    throwIfSponsorOperationsSequenceLimitReached(status);
    if (status !== 'UPDATED')
      throw new Error('Sponsor Refill Account observation returned an invalid result');
    return true;
  }

  return {
    read,
    readWithdrawalReceipt,
    readAccountObservationCursor,
    reserve,
    markReady,
    markReconciling,
    complete,
    failReserved,
    updateAccountObservation,
  };
}

export function isActiveSponsorRefillAccountSpend(
  spend: SponsorRefillAccountSpend | null,
): spend is ActiveSponsorRefillAccountSpend {
  return spend !== null && isActiveSponsorRefillOperationState(spend.state);
}
