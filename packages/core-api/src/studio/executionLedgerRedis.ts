import type { RedisClientLike } from '../store/redisClient.js';
import { logStructuredEvent } from '../structuredEventLog.js';
import { PROMOTION_EXECUTION_LEDGER_REAPER_ERROR } from '../observability/events.js';
import type {
  PromotionExecutionLedger,
  PromotionLedgerStatus,
  PromotionListLedgerStatus,
} from './executionLedger.js';
import {
  assertPromotionListLedgerBatchBound,
  PROMOTION_EXECUTION_LEDGER_DEFAULT_REAPER_INTERVAL_MS,
  PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS,
  PROMOTION_EXECUTION_LEDGER_SWEEP_BATCH_SIZE,
} from './executionLedger.js';
import type {
  ClaimOpts,
  ClaimResult,
  ConsumeResult,
  Entitlement,
  ReleaseResult,
  ReserveParams,
  ReserveResult,
} from './domain.js';
import {
  assertNonNegativeMist,
  assertPositiveMist,
  assertWithinLedgerBound,
} from './executionLedgerValueGuards.js';
import type { CurrentPromotionRecord, PromotionEntitlementRecord } from './promotionRecords.js';
import {
  assertPromotionAccountingMatchesPromotion,
  assertPromotionAccountingIdentity,
  assertPromotionEntitlementAccountingState,
  assertPromotionEntitlementIdentity,
  assertPromotionLedgerReadState,
  assertPromotionOperationResultIdentity,
  assertPromotionReservationAccountingState,
  assertPromotionReservationIdentity,
  createPromotionClaimTransition,
  createPromotionFinalizeTransition,
  createPromotionReserveStateChange,
  createPromotionReserveTransition,
  decodePromotionAccountingRecord,
  decodePromotionEntitlementRecord,
  decodePromotionOperationResultRecord,
  decodePromotionRecord,
  decodePromotionReservationRecord,
  promotionAccountingKey,
  promotionEntitlementFromRecord,
  promotionEntitlementKey,
  promotionOperationResultKey,
  promotionOperationResultKeyPrefix,
  promotionReservationDeadlineIndexKey,
  promotionReservationDeadlineMember,
  promotionReservationKey,
  promotionReservationKeyPrefix,
  PROMOTION_ACCOUNTING_RECORD_FIELD_COUNT,
  PROMOTION_ENTITLEMENT_RECORD_FIELD_COUNT,
  samePromotionAccountingRecord,
  samePromotionEntitlementRecord,
  serializePromotionAccountingRecord,
  serializePromotionEntitlementRecord,
  serializePromotionOperationResultRecord,
  serializePromotionReservationRecord,
  type PromotionAccountingRecord,
  type PromotionOperationResultRecord,
  type PromotionReservationRecord,
  type PromotionReserveTransition,
  PromotionRecordCorruptionError,
  PROMOTION_ENTITLEMENT_WITHOUT_ACCOUNTING_MESSAGE,
} from './promotionRecords.js';

const ACCOUNTING_PAIR_LENGTH = PROMOTION_ACCOUNTING_RECORD_FIELD_COUNT * 2;
const ENTITLEMENT_PAIR_LENGTH = PROMOTION_ENTITLEMENT_RECORD_FIELD_COUNT * 2;

const CLAIM_EXPECTED_ACCOUNTING_START = 5;
const CLAIM_EXPECTED_ENTITLEMENT_START = CLAIM_EXPECTED_ACCOUNTING_START + ACCOUNTING_PAIR_LENGTH;
const CLAIM_NEXT_ACCOUNTING_START = CLAIM_EXPECTED_ENTITLEMENT_START + ENTITLEMENT_PAIR_LENGTH;
const CLAIM_NEXT_ENTITLEMENT_START = CLAIM_NEXT_ACCOUNTING_START + ACCOUNTING_PAIR_LENGTH;
const CLAIM_ARGUMENT_COUNT = CLAIM_NEXT_ENTITLEMENT_START + ENTITLEMENT_PAIR_LENGTH - 1;

const RESERVE_DEADLINE_MEMBER_INDEX = 2;
const RESERVE_RESERVATION_RAW_INDEX = RESERVE_DEADLINE_MEMBER_INDEX + 1;
const RESERVE_DEADLINE_INDEX = RESERVE_RESERVATION_RAW_INDEX + 1;
const RESERVE_EXPECTED_ACCOUNTING_START = RESERVE_DEADLINE_INDEX + 1;
const RESERVE_EXPECTED_ENTITLEMENT_START =
  RESERVE_EXPECTED_ACCOUNTING_START + ACCOUNTING_PAIR_LENGTH;
const RESERVE_RESERVATION_PREFIX_INDEX =
  RESERVE_EXPECTED_ENTITLEMENT_START + ENTITLEMENT_PAIR_LENGTH;
const RESERVE_RESULT_PREFIX_INDEX = RESERVE_RESERVATION_PREFIX_INDEX + 1;
const RESERVE_DECISION_INDEX = RESERVE_RESULT_PREFIX_INDEX + 1;
const RESERVE_ACTIVE_MEMBER_INDEX = RESERVE_DECISION_INDEX + 1;
const RESERVE_ACTIVE_RESERVATION_INDEX = RESERVE_ACTIVE_MEMBER_INDEX + 1;
const RESERVE_ACTIVE_SCORE_INDEX = RESERVE_ACTIVE_RESERVATION_INDEX + 1;
const RESERVE_NEXT_ACCOUNTING_START = RESERVE_ACTIVE_SCORE_INDEX + 1;
const RESERVE_NEXT_ENTITLEMENT_START = RESERVE_NEXT_ACCOUNTING_START + ACCOUNTING_PAIR_LENGTH;
const RESERVE_ARGUMENT_COUNT = RESERVE_NEXT_ENTITLEMENT_START + ENTITLEMENT_PAIR_LENGTH - 1;

const FINALIZE_EXPECTED_ACCOUNTING_START = 2;
const FINALIZE_EXPECTED_ENTITLEMENT_START =
  FINALIZE_EXPECTED_ACCOUNTING_START + ACCOUNTING_PAIR_LENGTH;
const FINALIZE_NEXT_ACCOUNTING_START =
  FINALIZE_EXPECTED_ENTITLEMENT_START + ENTITLEMENT_PAIR_LENGTH;
const FINALIZE_NEXT_ENTITLEMENT_START = FINALIZE_NEXT_ACCOUNTING_START + ACCOUNTING_PAIR_LENGTH;
const FINALIZE_DEADLINE_INDEX = FINALIZE_NEXT_ENTITLEMENT_START + ENTITLEMENT_PAIR_LENGTH;
const FINALIZE_RECEIPT_INDEX = FINALIZE_DEADLINE_INDEX + 1;
const FINALIZE_RESULT_INDEX = FINALIZE_RECEIPT_INDEX + 1;
const FINALIZE_ARGUMENT_COUNT = FINALIZE_RESULT_INDEX;

interface SweepBatchResult {
  readonly swept: number;
  readonly examined: number;
}

type ReceiptState =
  | { readonly status: 'missing' }
  | {
      readonly status: 'reserved';
      readonly reservation: PromotionReservationRecord;
      readonly score: number;
    }
  | {
      readonly status: 'finalized';
      readonly result: PromotionOperationResultRecord;
    };

export interface RedisPromotionRecordAccess {
  readCurrent(promotionId: string): Promise<CurrentPromotionRecord | null>;
  recordKey(promotionId: string): string;
}

function isEmptyHash(fields: Record<string, string>): boolean {
  return Object.keys(fields).length === 0;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new PromotionRecordCorruptionError(`${label} must be a canonical integer string`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PromotionRecordCorruptionError(`${label} must be a non-negative safe integer`);
  }
  return parsed;
}

function unreachableResult(value: never, label: string): never {
  throw new PromotionRecordCorruptionError(
    `${label} returned an unhandled result ${String(value)}`,
  );
}

function taggedRecord<Tag extends string>(
  value: unknown,
  allowed: readonly Tag[],
  label: string,
): { tag: Tag; serialized: string } {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    typeof value[1] !== 'string' ||
    !allowed.includes(value[0] as Tag)
  ) {
    throw new PromotionRecordCorruptionError(`${label} returned a malformed result`);
  }
  return { tag: value[0] as Tag, serialized: value[1] };
}

function hashRecordFromResult(
  value: unknown,
  startIndex: number,
  pairLength: number,
  label: string,
): Record<string, string> {
  if (!Array.isArray(value) || value.length < startIndex + pairLength) {
    throw new PromotionRecordCorruptionError(`${label} returned a malformed stored record`);
  }
  const pairs = value.slice(startIndex, startIndex + pairLength);
  if (pairs.some((field) => typeof field !== 'string')) {
    throw new PromotionRecordCorruptionError(`${label} returned a malformed stored record`);
  }
  const fields: Record<string, string> = {};
  for (let index = 0; index < pairs.length; index += 2) {
    fields[pairs[index] as string] = pairs[index + 1] as string;
  }
  return fields;
}

function ledgerStateRecord<StateTag extends string, BareTag extends string>(
  value: unknown,
  stateTags: readonly StateTag[],
  bareTags: readonly BareTag[],
  label: string,
): {
  tag: StateTag | BareTag;
  serialized: string;
  accounting: PromotionAccountingRecord | null;
  entitlement: PromotionEntitlementRecord | null;
} {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    typeof value[0] !== 'string' ||
    typeof value[1] !== 'string'
  ) {
    throw new PromotionRecordCorruptionError(`${label} returned a malformed result`);
  }
  if (!stateTags.includes(value[0] as StateTag)) {
    if (!bareTags.includes(value[0] as BareTag) || value.length !== 2) {
      throw new PromotionRecordCorruptionError(`${label} returned a malformed result`);
    }
    return {
      tag: value[0] as BareTag,
      serialized: value[1],
      accounting: null,
      entitlement: null,
    };
  }
  if (value.length !== 2 + ACCOUNTING_PAIR_LENGTH + ENTITLEMENT_PAIR_LENGTH) {
    throw new PromotionRecordCorruptionError(`${label} returned a malformed ledger snapshot`);
  }
  return {
    tag: value[0] as StateTag,
    serialized: value[1],
    accounting: decodePromotionAccountingRecord(
      hashRecordFromResult(value, 2, ACCOUNTING_PAIR_LENGTH, label),
    ),
    entitlement: decodePromotionEntitlementRecord(
      hashRecordFromResult(value, 2 + ACCOUNTING_PAIR_LENGTH, ENTITLEMENT_PAIR_LENGTH, label),
    ),
  };
}

type ClaimRecordTag =
  | 'CLAIMED'
  | 'DUPLICATE'
  | 'CAPACITY'
  | 'STATE_CHANGED'
  | 'PROMOTION_CHANGED'
  | 'CORRUPT';

function claimRecord(value: unknown): {
  tag: ClaimRecordTag;
  accounting: PromotionAccountingRecord | null;
  entitlement: PromotionEntitlementRecord | null;
} {
  if (Array.isArray(value) && (value[0] === 'CAPACITY' || value[0] === 'STATE_CHANGED')) {
    if (value[1] !== '') {
      throw new PromotionRecordCorruptionError('Promotion claim returned a malformed snapshot');
    }
    if (value.length === 2) {
      return { tag: value[0], accounting: null, entitlement: null };
    }
    if (value.length === 2 + ACCOUNTING_PAIR_LENGTH) {
      return {
        tag: value[0],
        accounting: decodePromotionAccountingRecord(
          hashRecordFromResult(value, 2, ACCOUNTING_PAIR_LENGTH, 'Promotion claim'),
        ),
        entitlement: null,
      };
    }
    if (value.length === 2 + ACCOUNTING_PAIR_LENGTH + ENTITLEMENT_PAIR_LENGTH) {
      return ledgerStateRecord(
        value,
        [value[0] as 'CAPACITY' | 'STATE_CHANGED'],
        [],
        'Promotion claim',
      );
    }
    throw new PromotionRecordCorruptionError('Promotion claim returned a malformed snapshot');
  }
  if (Array.isArray(value) && value[0] === 'DUPLICATE') {
    return ledgerStateRecord(value, ['DUPLICATE'], [], 'Promotion claim');
  }
  if (Array.isArray(value) && value[0] === 'CLAIMED') {
    return ledgerStateRecord(value, ['CLAIMED'], [], 'Promotion claim');
  }
  const record = taggedRecord(value, ['PROMOTION_CHANGED', 'CORRUPT'], 'Promotion claim');
  return {
    tag: record.tag,
    accounting: null,
    entitlement: null,
  };
}

type ReserveRecordTag =
  | 'RESERVED'
  | 'RESERVATION'
  | 'RESULT'
  | 'PROMOTION_CHANGED'
  | 'CORRUPT'
  | 'ENTITLEMENT_NOT_ACTIVE'
  | 'CONCURRENT_RESERVATION'
  | 'BUDGET_INSUFFICIENT'
  | 'ENTITLEMENT_INSUFFICIENT'
  | 'STATE_CHANGED';

function reserveRecord(value: unknown): {
  tag: ReserveRecordTag;
  serialized: string;
  score: string | null;
  accounting: PromotionAccountingRecord | null;
  entitlement: PromotionEntitlementRecord | null;
} {
  if (Array.isArray(value) && value[0] === 'RESERVATION') {
    if (
      value.length !== 3 + ACCOUNTING_PAIR_LENGTH + ENTITLEMENT_PAIR_LENGTH ||
      typeof value[1] !== 'string' ||
      typeof value[2] !== 'string'
    ) {
      throw new PromotionRecordCorruptionError(
        'Promotion reserve returned a malformed current reservation',
      );
    }
    return {
      tag: 'RESERVATION',
      serialized: value[1],
      score: value[2],
      accounting: decodePromotionAccountingRecord(
        hashRecordFromResult(value, 3, ACCOUNTING_PAIR_LENGTH, 'Promotion reserve'),
      ),
      entitlement: decodePromotionEntitlementRecord(
        hashRecordFromResult(
          value,
          3 + ACCOUNTING_PAIR_LENGTH,
          ENTITLEMENT_PAIR_LENGTH,
          'Promotion reserve',
        ),
      ),
    };
  }
  if (Array.isArray(value) && value[0] === 'CONCURRENT_RESERVATION') {
    if (
      value.length !== 3 + ACCOUNTING_PAIR_LENGTH + ENTITLEMENT_PAIR_LENGTH ||
      typeof value[1] !== 'string' ||
      typeof value[2] !== 'string'
    ) {
      throw new PromotionRecordCorruptionError(
        'Promotion reserve returned a malformed active reservation',
      );
    }
    return {
      tag: 'CONCURRENT_RESERVATION',
      serialized: value[1],
      score: value[2],
      accounting: decodePromotionAccountingRecord(
        hashRecordFromResult(value, 3, ACCOUNTING_PAIR_LENGTH, 'Promotion reserve'),
      ),
      entitlement: decodePromotionEntitlementRecord(
        hashRecordFromResult(
          value,
          3 + ACCOUNTING_PAIR_LENGTH,
          ENTITLEMENT_PAIR_LENGTH,
          'Promotion reserve',
        ),
      ),
    };
  }
  const record = ledgerStateRecord(
    value,
    [
      'RESERVED',
      'STATE_CHANGED',
      'ENTITLEMENT_NOT_ACTIVE',
      'ENTITLEMENT_INSUFFICIENT',
      'BUDGET_INSUFFICIENT',
    ],
    ['RESULT', 'PROMOTION_CHANGED', 'CORRUPT'],
    'Promotion reserve',
  );
  return { ...record, score: null };
}

type FinalizeRecordTag = 'STATE_CHANGED' | 'APPLIED' | 'RESULT' | 'MISSING' | 'CHANGED' | 'CORRUPT';

function finalizeRecord(value: unknown): {
  tag: FinalizeRecordTag;
  serialized: string;
  accounting: PromotionAccountingRecord | null;
  entitlement: PromotionEntitlementRecord | null;
} {
  return ledgerStateRecord(
    value,
    ['STATE_CHANGED', 'APPLIED'],
    ['RESULT', 'MISSING', 'CHANGED', 'CORRUPT'],
    'Promotion final operation',
  );
}

type LedgerReadRecordTag =
  | 'COMPLETE'
  | 'ACCOUNTING_ONLY'
  | 'MISSING'
  | 'ENTITLEMENT_WITHOUT_ACCOUNTING'
  | 'CORRUPT';

function ledgerReadRecord(value: unknown): {
  tag: LedgerReadRecordTag;
  accounting: PromotionAccountingRecord | null;
  entitlement: PromotionEntitlementRecord | null;
} {
  if (Array.isArray(value) && value[0] === 'COMPLETE') {
    const record = ledgerStateRecord(value, ['COMPLETE'], [], 'Promotion ledger read');
    return {
      tag: record.tag,
      accounting: record.accounting,
      entitlement: record.entitlement,
    };
  }
  if (Array.isArray(value) && value[0] === 'ACCOUNTING_ONLY') {
    if (value.length !== 2 + ACCOUNTING_PAIR_LENGTH || value[1] !== '') {
      throw new PromotionRecordCorruptionError(
        'Promotion ledger read returned a malformed accounting snapshot',
      );
    }
    return {
      tag: 'ACCOUNTING_ONLY',
      accounting: decodePromotionAccountingRecord(
        hashRecordFromResult(value, 2, ACCOUNTING_PAIR_LENGTH, 'Promotion ledger read'),
      ),
      entitlement: null,
    };
  }
  const record = taggedRecord(
    value,
    ['MISSING', 'ENTITLEMENT_WITHOUT_ACCOUNTING', 'CORRUPT'],
    'Promotion ledger read',
  );
  return { tag: record.tag, accounting: null, entitlement: null };
}

function promotionListLedgerRecords(
  value: unknown,
  promotionIds: readonly string[],
  userId: string,
): PromotionListLedgerStatus[] {
  if (!Array.isArray(value) || value.length !== promotionIds.length) {
    throw new PromotionRecordCorruptionError(
      'Promotion list ledger read returned a malformed result',
    );
  }
  return value.map((rowValue, index) => {
    const promotionId = promotionIds[index]!;
    if (
      !Array.isArray(rowValue) ||
      rowValue.length < 2 ||
      typeof rowValue[0] !== 'string' ||
      typeof rowValue[1] !== 'string'
    ) {
      throw new PromotionRecordCorruptionError(
        'Promotion list ledger read returned a malformed row',
      );
    }
    const current =
      rowValue[1] === ''
        ? null
        : (() => {
            const promotion = decodePromotionRecord(rowValue[1]);
            if (promotion.promotionId !== promotionId) {
              throw new PromotionRecordCorruptionError(
                'Promotion list record does not match its requested ID',
              );
            }
            return { promotion, serialized: rowValue[1] } satisfies CurrentPromotionRecord;
          })();
    let accounting: PromotionAccountingRecord | null = null;
    let entitlement: PromotionEntitlementRecord | null = null;
    if (rowValue[0] === 'COMPLETE') {
      const record = ledgerStateRecord(rowValue, ['COMPLETE'], [], 'Promotion list ledger read');
      accounting = record.accounting;
      entitlement = record.entitlement;
    } else if (rowValue[0] === 'ACCOUNTING_ONLY') {
      if (rowValue.length !== 2 + ACCOUNTING_PAIR_LENGTH) {
        throw new PromotionRecordCorruptionError(
          'Promotion list ledger read returned a malformed accounting row',
        );
      }
      accounting = decodePromotionAccountingRecord(
        hashRecordFromResult(rowValue, 2, ACCOUNTING_PAIR_LENGTH, 'Promotion list ledger read'),
      );
    } else if (rowValue[0] === 'ENTITLEMENT_WITHOUT_ACCOUNTING') {
      if (rowValue.length !== 2) {
        throw new PromotionRecordCorruptionError(
          'Promotion list ledger read returned a malformed partial row',
        );
      }
      throw new PromotionRecordCorruptionError(PROMOTION_ENTITLEMENT_WITHOUT_ACCOUNTING_MESSAGE);
    } else if (rowValue[0] === 'CORRUPT') {
      if (rowValue.length !== 2) {
        throw new PromotionRecordCorruptionError(
          'Promotion list ledger read returned a malformed corrupt row',
        );
      }
      throw new PromotionRecordCorruptionError(
        'Promotion list ledger read found corrupt stored state',
      );
    } else if (rowValue[0] !== 'MISSING' || rowValue.length !== 2) {
      throw new PromotionRecordCorruptionError(
        `Promotion list ledger read returned unknown tag ${rowValue[0]}`,
      );
    }
    assertPromotionLedgerReadState(current, promotionId, userId, accounting, entitlement);
    return {
      promotionId,
      entitlement: entitlement ? promotionEntitlementFromRecord(entitlement) : null,
      claimedCount: accounting?.claimedCount ?? 0,
      availableBudgetMist: BigInt(accounting?.availableMist ?? '0'),
    };
  });
}

function exactOperationRetry(
  serialized: string,
  receiptId: string,
  operation: 'consume' | 'release',
  amountMist?: bigint,
): PromotionOperationResultRecord | null {
  const result = decodePromotionOperationResultRecord(serialized);
  assertPromotionOperationResultIdentity(result, receiptId);
  if (result.operation !== operation) return null;
  if (amountMist !== undefined && result.amountMist !== amountMist.toString()) return null;
  return result;
}

function operationRetryResult(
  serialized: string,
  receiptId: string,
  operation: 'consume' | 'release',
  amountMist?: bigint,
): ConsumeResult | ReleaseResult {
  const retry = exactOperationRetry(serialized, receiptId, operation, amountMist);
  return retry
    ? { ok: true, entitlement: promotionEntitlementFromRecord(retry.entitlement) }
    : { ok: false, reason: 'record_changed' };
}

function receiptStateRecord(value: unknown, receiptId: string): ReceiptState {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    typeof value[0] !== 'string' ||
    typeof value[1] !== 'string' ||
    typeof value[2] !== 'string'
  ) {
    throw new PromotionRecordCorruptionError('Promotion receipt state returned a malformed result');
  }
  if (value[0] === 'CORRUPT') {
    throw new PromotionRecordCorruptionError(
      'Promotion receipt has contradictory reservation, result, or deadline state',
    );
  }
  if (value[0] === 'MISSING') return { status: 'missing' };
  const score =
    value[2] === ''
      ? null
      : (() => {
          const parsed = Number(value[2]);
          if (!Number.isSafeInteger(parsed) || parsed <= 0) {
            throw new PromotionRecordCorruptionError(
              'Promotion receipt deadline score must be a positive safe integer',
            );
          }
          return parsed;
        })();
  if (value[0] === 'RESERVED') {
    const reservation = decodePromotionReservationRecord(value[1]);
    assertPromotionReservationIdentity(reservation, receiptId);
    if (score === null || reservation.deadlineMs !== score) {
      throw new PromotionRecordCorruptionError(
        'Promotion reservation and deadline index are inconsistent',
      );
    }
    return { status: 'reserved', reservation, score };
  }
  if (value[0] === 'FINALIZED') {
    if (score !== null) {
      throw new PromotionRecordCorruptionError(
        'Promotion final result must not retain a reservation deadline',
      );
    }
    const result = decodePromotionOperationResultRecord(value[1]);
    assertPromotionOperationResultIdentity(result, receiptId);
    return { status: 'finalized', result };
  }
  throw new PromotionRecordCorruptionError(
    `Promotion receipt state returned unknown tag ${value[0]}`,
  );
}

function hashWriteArgs(fields: Record<string, string>): string[] {
  return Object.entries(fields).flatMap(([field, value]) => [field, value]);
}

function hashWriteArgsOrEmpty(fields: Record<string, string> | null, fieldCount: number): string[] {
  return fields === null ? Array<string>(fieldCount * 2).fill('') : hashWriteArgs(fields);
}

const LUA_EXACT_RECORD_HELPERS = `
local function isExactHash(key, startIndex, fieldCount)
  if redis.call('HLEN', key) ~= fieldCount then
    return false
  end
  for fieldIndex = 0, fieldCount - 1 do
    local argumentIndex = startIndex + fieldIndex * 2
    if redis.call('HGET', key, ARGV[argumentIndex]) ~= ARGV[argumentIndex + 1] then
      return false
    end
  end
  return true
end
`;

const LUA_LEDGER_STATE_RESULT_HELPER = `
local function appendHash(result, key)
  local fields = redis.call('HGETALL', key)
  for _, field in ipairs(fields) do
    result[#result + 1] = field
  end
end

local function ledgerStateResult(tag, serialized, accountingKey, entitlementKey)
  local result = {tag, serialized}
  appendHash(result, accountingKey)
  appendHash(result, entitlementKey)
  return result
end
`;

const LUA_READ_RECEIPT_STATE = `
local reservationRaw = redis.call('GET', KEYS[1])
local resultRaw = redis.call('GET', KEYS[2])
local deadlineScore = redis.call('ZSCORE', KEYS[3], ARGV[1])
if reservationRaw and resultRaw then return {'CORRUPT', '', deadlineScore or ''} end
if reservationRaw then return {'RESERVED', reservationRaw, deadlineScore or ''} end
if resultRaw and deadlineScore then return {'CORRUPT', '', deadlineScore} end
if resultRaw then return {'FINALIZED', resultRaw, ''} end
if deadlineScore then return {'CORRUPT', '', deadlineScore} end
return {'MISSING', '', ''}
`;

const LUA_READ_REDIS_TIME = `
local now = redis.call('TIME')
return string.format(
  '%.0f',
  tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000))
`;

const LUA_READ_LEDGER_STATE = `
${LUA_LEDGER_STATE_RESULT_HELPER}

if ARGV[1] ~= '0' and ARGV[1] ~= '1' then return {'CORRUPT', ''} end
local includeEntitlement = ARGV[1] == '1'
local accountingExists = redis.call('EXISTS', KEYS[1])
local entitlementExists = includeEntitlement and redis.call('EXISTS', KEYS[2]) or 0

if accountingExists == 0 then
  if entitlementExists == 1 then
    return {'ENTITLEMENT_WITHOUT_ACCOUNTING', ''}
  end
  return {'MISSING', ''}
end
if not includeEntitlement or entitlementExists == 0 then
  local result = {'ACCOUNTING_ONLY', ''}
  appendHash(result, KEYS[1])
  return result
end
return ledgerStateResult('COMPLETE', '', KEYS[1], KEYS[2])
`;

const LUA_READ_PROMOTION_LIST_LEDGER_STATES = `
${LUA_LEDGER_STATE_RESULT_HELPER}

local count = tonumber(ARGV[1])
if not count or count < 0 or #KEYS ~= count * 3 then return {'CORRUPT'} end
local result = {}
for index = 1, count do
  local offset = (index - 1) * 3
  local promotionRaw = redis.call('GET', KEYS[offset + 1]) or ''
  local accountingKey = KEYS[offset + 2]
  local entitlementKey = KEYS[offset + 3]
  local accountingExists = redis.call('EXISTS', accountingKey)
  local entitlementExists = redis.call('EXISTS', entitlementKey)
  local row = nil
  if accountingExists == 0 then
    row = {
      entitlementExists == 1 and 'ENTITLEMENT_WITHOUT_ACCOUNTING' or 'MISSING',
      promotionRaw,
    }
  elseif entitlementExists == 0 then
    row = {'ACCOUNTING_ONLY', promotionRaw}
    appendHash(row, accountingKey)
  else
    row = ledgerStateResult('COMPLETE', promotionRaw, accountingKey, entitlementKey)
  end
  result[#result + 1] = row
end
return result
`;

const LUA_CLAIM = `
${LUA_EXACT_RECORD_HELPERS}
${LUA_LEDGER_STATE_RESULT_HELPER}

local function currentClaimState(tag)
  local accountingExists = redis.call('EXISTS', KEYS[2])
  local entitlementExists = redis.call('EXISTS', KEYS[3])
  if accountingExists == 0 and
     (entitlementExists == 1 or ARGV[2] == '1') then
    return {'CORRUPT', ''}
  end
  if accountingExists == 0 then return {tag, ''} end
  if entitlementExists == 0 and ARGV[3] == '1' then return {'CORRUPT', ''} end
  if entitlementExists == 0 then
    local result = {tag, ''}
    appendHash(result, KEYS[2])
    return result
  end
  return ledgerStateResult(tag, '', KEYS[2], KEYS[3])
end

if #ARGV ~= ${CLAIM_ARGUMENT_COUNT} then return {'CORRUPT', ''} end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {'PROMOTION_CHANGED', ''} end
if (ARGV[2] ~= '0' and ARGV[2] ~= '1') or
   (ARGV[3] ~= '0' and ARGV[3] ~= '1') then
  return {'CORRUPT', ''}
end

local accountingExists = redis.call('EXISTS', KEYS[2])
local entitlementExists = redis.call('EXISTS', KEYS[3])
local accountingMatches =
  (ARGV[2] == '0' and accountingExists == 0)
  or (ARGV[2] == '1' and accountingExists == 1
      and isExactHash(
        KEYS[2],
        ${CLAIM_EXPECTED_ACCOUNTING_START},
        ${PROMOTION_ACCOUNTING_RECORD_FIELD_COUNT}))
local entitlementMatches =
  (ARGV[3] == '0' and entitlementExists == 0)
  or (ARGV[3] == '1' and entitlementExists == 1
      and isExactHash(
        KEYS[3],
        ${CLAIM_EXPECTED_ENTITLEMENT_START},
        ${PROMOTION_ENTITLEMENT_RECORD_FIELD_COUNT}))
if not accountingMatches or not entitlementMatches then
  return currentClaimState('STATE_CHANGED')
end

local decision = ARGV[4]
if decision == 'duplicate' then
  if ARGV[2] ~= '1' or ARGV[3] ~= '1' then return {'CORRUPT', ''} end
  return ledgerStateResult('DUPLICATE', '', KEYS[2], KEYS[3])
end
if decision == 'capacity_exceeded' then
  if ARGV[2] ~= '1' or ARGV[3] ~= '0' then return {'CORRUPT', ''} end
  local result = {'CAPACITY', ''}
  appendHash(result, KEYS[2])
  return result
end
if decision ~= 'claim' or ARGV[3] ~= '0' then return {'CORRUPT', ''} end

redis.call(
  'HSET',
  KEYS[2],
  unpack(
    ARGV,
    ${CLAIM_NEXT_ACCOUNTING_START},
    ${CLAIM_NEXT_ACCOUNTING_START + ACCOUNTING_PAIR_LENGTH - 1}))
redis.call(
  'HSET',
  KEYS[3],
  unpack(
    ARGV,
    ${CLAIM_NEXT_ENTITLEMENT_START},
    ${CLAIM_NEXT_ENTITLEMENT_START + ENTITLEMENT_PAIR_LENGTH - 1}))
if not isExactHash(
     KEYS[2],
     ${CLAIM_NEXT_ACCOUNTING_START},
     ${PROMOTION_ACCOUNTING_RECORD_FIELD_COUNT})
   or not isExactHash(
     KEYS[3],
     ${CLAIM_NEXT_ENTITLEMENT_START},
     ${PROMOTION_ENTITLEMENT_RECORD_FIELD_COUNT}) then
  if ARGV[2] == '1' then
    redis.call(
      'HSET',
      KEYS[2],
      unpack(
        ARGV,
        ${CLAIM_EXPECTED_ACCOUNTING_START},
        ${CLAIM_EXPECTED_ACCOUNTING_START + ACCOUNTING_PAIR_LENGTH - 1}))
  else
    redis.call('DEL', KEYS[2])
  end
  if ARGV[3] == '1' then
    redis.call(
      'HSET',
      KEYS[3],
      unpack(
        ARGV,
        ${CLAIM_EXPECTED_ENTITLEMENT_START},
        ${CLAIM_EXPECTED_ENTITLEMENT_START + ENTITLEMENT_PAIR_LENGTH - 1}))
  else
    redis.call('DEL', KEYS[3])
  end
  return {'CORRUPT', ''}
end
return ledgerStateResult('CLAIMED', '', KEYS[2], KEYS[3])
`;

const LUA_RESERVE = `
${LUA_EXACT_RECORD_HELPERS}
${LUA_LEDGER_STATE_RESULT_HELPER}

local function reservationStateResult(tag, serialized, score, accountingKey, entitlementKey)
  local result = {tag, serialized, score}
  appendHash(result, accountingKey)
  appendHash(result, entitlementKey)
  return result
end

if #ARGV ~= ${RESERVE_ARGUMENT_COUNT} then return {'CORRUPT', ''} end
local promotionRaw = redis.call('GET', KEYS[1])
local finalRaw = redis.call('GET', KEYS[5])
local reservationRaw = redis.call('GET', KEYS[4])
local deadlineScore =
  redis.call('ZSCORE', KEYS[6], ARGV[${RESERVE_DEADLINE_MEMBER_INDEX}])
if finalRaw and reservationRaw then return {'CORRUPT', ''} end
if finalRaw and deadlineScore then return {'CORRUPT', ''} end
if finalRaw then return {'RESULT', finalRaw} end
if reservationRaw then
  if not promotionRaw or not deadlineScore or
     redis.call('EXISTS', KEYS[2]) == 0 or
     redis.call('EXISTS', KEYS[3]) == 0 then
    return {'CORRUPT', ''}
  end
  return reservationStateResult(
    'RESERVATION',
    reservationRaw,
    deadlineScore,
    KEYS[2],
    KEYS[3])
end
if deadlineScore then return {'CORRUPT', ''} end
if promotionRaw ~= ARGV[1] then return {'PROMOTION_CHANGED', ''} end
if redis.call('EXISTS', KEYS[2]) == 0 or redis.call('EXISTS', KEYS[3]) == 0 then
  return {'CORRUPT', ''}
end
if not isExactHash(
     KEYS[2],
     ${RESERVE_EXPECTED_ACCOUNTING_START},
     ${PROMOTION_ACCOUNTING_RECORD_FIELD_COUNT})
   or not isExactHash(
     KEYS[3],
     ${RESERVE_EXPECTED_ENTITLEMENT_START},
     ${PROMOTION_ENTITLEMENT_RECORD_FIELD_COUNT}) then
  return ledgerStateResult('STATE_CHANGED', '', KEYS[2], KEYS[3])
end

local decision = ARGV[${RESERVE_DECISION_INDEX}]
if decision == 'entitlement_not_active' then
  return ledgerStateResult('ENTITLEMENT_NOT_ACTIVE', '', KEYS[2], KEYS[3])
end
if decision == 'entitlement_insufficient' then
  return ledgerStateResult('ENTITLEMENT_INSUFFICIENT', '', KEYS[2], KEYS[3])
end
if decision == 'budget_insufficient' then
  return ledgerStateResult('BUDGET_INSUFFICIENT', '', KEYS[2], KEYS[3])
end
if decision == 'concurrent_reservation' then
  local activeMember = ARGV[${RESERVE_ACTIVE_MEMBER_INDEX}]
  if activeMember == ''
     or ARGV[${RESERVE_ACTIVE_RESERVATION_INDEX}] == ''
     or ARGV[${RESERVE_ACTIVE_SCORE_INDEX}] == '' then
    return {'CORRUPT', ''}
  end
  local activeReservationRaw =
    redis.call('GET', ARGV[${RESERVE_RESERVATION_PREFIX_INDEX}] .. activeMember)
  local activeResultRaw =
    redis.call('GET', ARGV[${RESERVE_RESULT_PREFIX_INDEX}] .. activeMember)
  local activeScore = redis.call('ZSCORE', KEYS[6], activeMember)
  if activeReservationRaw ~= ARGV[${RESERVE_ACTIVE_RESERVATION_INDEX}]
     or activeResultRaw
     or activeScore ~= ARGV[${RESERVE_ACTIVE_SCORE_INDEX}] then
    return {'CORRUPT', ''}
  end
  return reservationStateResult(
    'CONCURRENT_RESERVATION',
    activeReservationRaw,
    activeScore,
    KEYS[2],
    KEYS[3])
end
if decision ~= 'reserve' then return {'CORRUPT', ''} end

local deadline = tonumber(ARGV[${RESERVE_DEADLINE_INDEX}])
if ARGV[${RESERVE_RESERVATION_RAW_INDEX}] == '' or
   not deadline or
   deadline <= 0 or
   deadline > ${Number.MAX_SAFE_INTEGER} or
   string.format('%.0f', deadline) ~= ARGV[${RESERVE_DEADLINE_INDEX}] then
  return {'CORRUPT', ''}
end

redis.call(
  'HSET',
  KEYS[2],
  unpack(
    ARGV,
    ${RESERVE_NEXT_ACCOUNTING_START},
    ${RESERVE_NEXT_ACCOUNTING_START + ACCOUNTING_PAIR_LENGTH - 1}))
redis.call(
  'HSET',
  KEYS[3],
  unpack(
    ARGV,
    ${RESERVE_NEXT_ENTITLEMENT_START},
    ${RESERVE_NEXT_ENTITLEMENT_START + ENTITLEMENT_PAIR_LENGTH - 1}))
if not isExactHash(
     KEYS[2],
     ${RESERVE_NEXT_ACCOUNTING_START},
     ${PROMOTION_ACCOUNTING_RECORD_FIELD_COUNT})
   or not isExactHash(
     KEYS[3],
     ${RESERVE_NEXT_ENTITLEMENT_START},
     ${PROMOTION_ENTITLEMENT_RECORD_FIELD_COUNT}) then
  redis.call(
    'HSET',
    KEYS[2],
    unpack(
      ARGV,
      ${RESERVE_EXPECTED_ACCOUNTING_START},
      ${RESERVE_EXPECTED_ACCOUNTING_START + ACCOUNTING_PAIR_LENGTH - 1}))
  redis.call(
    'HSET',
    KEYS[3],
    unpack(
      ARGV,
      ${RESERVE_EXPECTED_ENTITLEMENT_START},
      ${RESERVE_EXPECTED_ENTITLEMENT_START + ENTITLEMENT_PAIR_LENGTH - 1}))
  return {'CORRUPT', ''}
end

redis.call('SET', KEYS[4], ARGV[${RESERVE_RESERVATION_RAW_INDEX}])
redis.call('ZADD', KEYS[6], deadline, ARGV[${RESERVE_DEADLINE_MEMBER_INDEX}])
return ledgerStateResult(
  'RESERVED',
  ARGV[${RESERVE_RESERVATION_RAW_INDEX}],
  KEYS[2],
  KEYS[3])
`;

const LUA_FINALIZE = `
${LUA_EXACT_RECORD_HELPERS}
${LUA_LEDGER_STATE_RESULT_HELPER}

if #ARGV ~= ${FINALIZE_ARGUMENT_COUNT} then return {'CORRUPT', ''} end
local currentReservation = redis.call('GET', KEYS[1])
local finalRaw = redis.call('GET', KEYS[2])
local deadlineScore = redis.call('ZSCORE', KEYS[3], ARGV[${FINALIZE_RECEIPT_INDEX}])
if finalRaw and (currentReservation or deadlineScore) then return {'CORRUPT', ''} end
if finalRaw then return {'RESULT', finalRaw} end
if not currentReservation then
  if deadlineScore then return {'CORRUPT', ''} end
  return {'MISSING', ''}
end
if currentReservation ~= ARGV[1] then return {'CHANGED', ''} end
if not deadlineScore or deadlineScore ~= ARGV[${FINALIZE_DEADLINE_INDEX}] then
  return {'CORRUPT', ''}
end
if redis.call('EXISTS', KEYS[4]) == 0 or redis.call('EXISTS', KEYS[5]) == 0 then
  return {'CORRUPT', ''}
end
if not isExactHash(
     KEYS[4],
     ${FINALIZE_EXPECTED_ACCOUNTING_START},
     ${PROMOTION_ACCOUNTING_RECORD_FIELD_COUNT})
   or not isExactHash(
     KEYS[5],
     ${FINALIZE_EXPECTED_ENTITLEMENT_START},
     ${PROMOTION_ENTITLEMENT_RECORD_FIELD_COUNT}) then
  return ledgerStateResult('STATE_CHANGED', '', KEYS[4], KEYS[5])
end

redis.call(
  'HSET',
  KEYS[4],
  unpack(
    ARGV,
    ${FINALIZE_NEXT_ACCOUNTING_START},
    ${FINALIZE_NEXT_ACCOUNTING_START + ACCOUNTING_PAIR_LENGTH - 1}))
redis.call(
  'HSET',
  KEYS[5],
  unpack(
    ARGV,
    ${FINALIZE_NEXT_ENTITLEMENT_START},
    ${FINALIZE_NEXT_ENTITLEMENT_START + ENTITLEMENT_PAIR_LENGTH - 1}))
if not isExactHash(
     KEYS[4],
     ${FINALIZE_NEXT_ACCOUNTING_START},
     ${PROMOTION_ACCOUNTING_RECORD_FIELD_COUNT})
   or not isExactHash(
     KEYS[5],
     ${FINALIZE_NEXT_ENTITLEMENT_START},
     ${PROMOTION_ENTITLEMENT_RECORD_FIELD_COUNT}) then
  redis.call(
    'HSET',
    KEYS[4],
    unpack(
      ARGV,
      ${FINALIZE_EXPECTED_ACCOUNTING_START},
      ${FINALIZE_EXPECTED_ACCOUNTING_START + ACCOUNTING_PAIR_LENGTH - 1}))
  redis.call(
    'HSET',
    KEYS[5],
    unpack(
      ARGV,
      ${FINALIZE_EXPECTED_ENTITLEMENT_START},
      ${FINALIZE_EXPECTED_ENTITLEMENT_START + ENTITLEMENT_PAIR_LENGTH - 1}))
  return {'CORRUPT', ''}
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[3], ARGV[${FINALIZE_RECEIPT_INDEX}])
redis.call('SET', KEYS[2], ARGV[${FINALIZE_RESULT_INDEX}])
return ledgerStateResult('APPLIED', ARGV[${FINALIZE_RESULT_INDEX}], KEYS[4], KEYS[5])
`;

const LUA_DUE_RESERVATIONS = `
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local due = redis.call(
  'ZRANGEBYSCORE',
  KEYS[1],
  '-inf',
  nowMs,
  'WITHSCORES',
  'LIMIT',
  0,
  tonumber(ARGV[1]))
local result = {string.format('%.0f', nowMs), tostring(#due / 2)}
for index = 1, #due, 2 do
  local receiptId = due[index]
  local score = due[index + 1]
  local raw = redis.call('GET', ARGV[2] .. receiptId)
  local finalRaw = redis.call('GET', ARGV[3] .. receiptId)
  if raw and finalRaw then
    result[#result + 1] = 'CORRUPT'
    result[#result + 1] = receiptId
    result[#result + 1] = score
    result[#result + 1] = ''
  elseif raw then
    result[#result + 1] = 'RESERVATION'
    result[#result + 1] = receiptId
    result[#result + 1] = score
    result[#result + 1] = raw
  elseif finalRaw then
    result[#result + 1] = 'CORRUPT'
    result[#result + 1] = receiptId
    result[#result + 1] = score
    result[#result + 1] = ''
  else
    result[#result + 1] = 'MISSING'
    result[#result + 1] = receiptId
    result[#result + 1] = score
    result[#result + 1] = ''
  end
end
return result
`;

export class RedisPromotionExecutionLedger implements PromotionExecutionLedger {
  private timer: ReturnType<typeof setInterval> | null = null;
  private runningSweep: Promise<void> | null = null;
  private runningBatch: Promise<SweepBatchResult> | null = null;
  private stopping = false;

  constructor(
    private readonly redis: RedisClientLike,
    private readonly promotionStore: RedisPromotionRecordAccess,
    private readonly ttlMs: number = PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS,
    reaperIntervalMs: number = PROMOTION_EXECUTION_LEDGER_DEFAULT_REAPER_INTERVAL_MS,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
      throw new Error('RedisPromotionExecutionLedger: ttlMs must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(reaperIntervalMs) || reaperIntervalMs < 0) {
      throw new Error(
        'RedisPromotionExecutionLedger: reaperIntervalMs must be a non-negative safe integer',
      );
    }
    if (reaperIntervalMs !== 0) {
      this.timer = setInterval(() => this.startScheduledSweep(), reaperIntervalMs);
      this.timer.unref?.();
    }
  }

  private async requireActivePromotion(
    promotionId: string,
  ): Promise<CurrentPromotionRecord | null> {
    const current = await this.promotionStore.readCurrent(promotionId);
    return current?.promotion.status === 'active' ? current : null;
  }

  private async readReceiptState(receiptId: string): Promise<ReceiptState> {
    return receiptStateRecord(
      await this.redis.eval(
        LUA_READ_RECEIPT_STATE,
        [
          promotionReservationKey(receiptId),
          promotionOperationResultKey(receiptId),
          promotionReservationDeadlineIndexKey(),
        ],
        [promotionReservationDeadlineMember(receiptId)],
      ),
      receiptId,
    );
  }

  private async readRedisTimeMs(): Promise<number> {
    return nonNegativeSafeInteger(
      await this.redis.eval(LUA_READ_REDIS_TIME, [], []),
      'Redis current time',
    );
  }

  private async validateFinalResultState(result: PromotionOperationResultRecord): Promise<void> {
    const { accounting, entitlement } = await this.readLedgerState(
      result.promotionId,
      result.userId,
    );
    if (!accounting || !entitlement) {
      throw new PromotionRecordCorruptionError(
        'Promotion final result is missing accounting or entitlement state',
      );
    }
    assertPromotionEntitlementIdentity(entitlement, result.promotionId, result.userId);
    assertPromotionEntitlementAccountingState(accounting, entitlement);
  }

  private async validateReservedReceiptState(state: Extract<ReceiptState, { status: 'reserved' }>) {
    const { accounting, entitlement } = await this.readLedgerState(
      state.reservation.promotionId,
      state.reservation.userId,
    );
    if (!accounting || !entitlement) {
      throw new PromotionRecordCorruptionError(
        'Promotion reservation is missing accounting or entitlement state',
      );
    }
    assertPromotionReservationAccountingState(accounting, entitlement, state.reservation);
    return { accounting, entitlement };
  }

  async claim(promotionId: string, userId: string, opts: ClaimOpts): Promise<ClaimResult> {
    const current = await this.requireActivePromotion(promotionId);
    if (!current) return { ok: false, reason: 'promotion_not_active' };
    const claimedAt = new Date().toISOString();
    const observed = ledgerReadRecord(
      await this.redis.eval(
        LUA_READ_LEDGER_STATE,
        [promotionAccountingKey(promotionId), promotionEntitlementKey(promotionId, userId)],
        ['1'],
      ),
    );
    if (observed.tag === 'ENTITLEMENT_WITHOUT_ACCOUNTING') {
      throw new PromotionRecordCorruptionError(PROMOTION_ENTITLEMENT_WITHOUT_ACCOUNTING_MESSAGE);
    }
    if (observed.tag === 'CORRUPT') {
      throw new PromotionRecordCorruptionError('Promotion claim read found corrupt stored state');
    }
    assertPromotionLedgerReadState(
      current,
      promotionId,
      userId,
      observed.accounting,
      observed.entitlement,
    );
    const transition = createPromotionClaimTransition({
      promotion: current.promotion,
      accounting: observed.accounting,
      entitlement: observed.entitlement,
      userId,
      claimedAt,
      useUntilAt: opts.useUntilAt,
    });
    const decision = 'status' in transition ? transition.status : 'claim';
    const nextAccounting = 'status' in transition ? observed.accounting : transition.accounting;
    const nextEntitlement = 'status' in transition ? observed.entitlement : transition.entitlement;
    const claim = claimRecord(
      await this.redis.eval(
        LUA_CLAIM,
        [
          this.promotionStore.recordKey(promotionId),
          promotionAccountingKey(promotionId),
          promotionEntitlementKey(promotionId, userId),
        ],
        [
          current.serialized,
          observed.accounting === null ? '0' : '1',
          observed.entitlement === null ? '0' : '1',
          decision,
          ...hashWriteArgsOrEmpty(
            observed.accounting === null
              ? null
              : serializePromotionAccountingRecord(observed.accounting),
            PROMOTION_ACCOUNTING_RECORD_FIELD_COUNT,
          ),
          ...hashWriteArgsOrEmpty(
            observed.entitlement === null
              ? null
              : serializePromotionEntitlementRecord(observed.entitlement),
            PROMOTION_ENTITLEMENT_RECORD_FIELD_COUNT,
          ),
          ...hashWriteArgsOrEmpty(
            nextAccounting === null ? null : serializePromotionAccountingRecord(nextAccounting),
            PROMOTION_ACCOUNTING_RECORD_FIELD_COUNT,
          ),
          ...hashWriteArgsOrEmpty(
            nextEntitlement === null ? null : serializePromotionEntitlementRecord(nextEntitlement),
            PROMOTION_ENTITLEMENT_RECORD_FIELD_COUNT,
          ),
        ],
      ),
    );
    const { tag } = claim;
    if (tag === 'PROMOTION_CHANGED') {
      const latest = await this.promotionStore.readCurrent(promotionId);
      return latest?.promotion.status === 'active'
        ? { ok: false, reason: 'record_changed' }
        : { ok: false, reason: 'promotion_not_active' };
    }
    if (tag === 'STATE_CHANGED') {
      assertPromotionLedgerReadState(
        current,
        promotionId,
        userId,
        claim.accounting,
        claim.entitlement,
      );
      return { ok: false, reason: 'record_changed' };
    }
    if (tag === 'DUPLICATE') {
      if (!claim.accounting || !claim.entitlement) {
        throw new PromotionRecordCorruptionError(
          'Promotion duplicate claim omitted its ledger snapshot',
        );
      }
      assertPromotionAccountingIdentity(claim.accounting, promotionId);
      assertPromotionEntitlementIdentity(claim.entitlement, promotionId, userId);
      assertPromotionAccountingMatchesPromotion(current.promotion, claim.accounting);
      assertPromotionEntitlementAccountingState(claim.accounting, claim.entitlement);
      if (
        decision !== 'duplicate' ||
        observed.accounting === null ||
        observed.entitlement === null ||
        !samePromotionAccountingRecord(claim.accounting, observed.accounting) ||
        !samePromotionEntitlementRecord(claim.entitlement, observed.entitlement)
      ) {
        throw new PromotionRecordCorruptionError(
          'Promotion duplicate claim contradicts the TypeScript-owned transition',
        );
      }
      return { ok: false, reason: 'duplicate' };
    }
    if (tag === 'CAPACITY') {
      if (!claim.accounting || claim.entitlement) {
        throw new PromotionRecordCorruptionError(
          'Promotion capacity result omitted its accounting snapshot',
        );
      }
      assertPromotionAccountingIdentity(claim.accounting, promotionId);
      assertPromotionAccountingMatchesPromotion(current.promotion, claim.accounting);
      if (
        decision !== 'capacity_exceeded' ||
        observed.accounting === null ||
        !samePromotionAccountingRecord(claim.accounting, observed.accounting)
      ) {
        throw new PromotionRecordCorruptionError(
          'Promotion claim capacity result contradicts the TypeScript-owned transition',
        );
      }
      return { ok: false, reason: 'capacity_exceeded' };
    }
    if (tag === 'CORRUPT') {
      throw new PromotionRecordCorruptionError('Promotion claim found corrupt accounting state');
    }
    if (tag !== 'CLAIMED' || !claim.accounting || !claim.entitlement) {
      throw new PromotionRecordCorruptionError(`Promotion claim returned unknown tag ${tag}`);
    }
    assertPromotionAccountingIdentity(claim.accounting, promotionId);
    assertPromotionEntitlementIdentity(claim.entitlement, promotionId, userId);
    assertPromotionAccountingMatchesPromotion(current.promotion, claim.accounting);
    assertPromotionEntitlementAccountingState(claim.accounting, claim.entitlement);
    if (
      decision !== 'claim' ||
      'status' in transition ||
      !samePromotionAccountingRecord(transition.accounting, claim.accounting) ||
      !samePromotionEntitlementRecord(transition.entitlement, claim.entitlement)
    ) {
      throw new PromotionRecordCorruptionError(
        'Promotion claim did not apply the TypeScript-owned state transition',
      );
    }
    return { ok: true, entitlement: promotionEntitlementFromRecord(claim.entitlement) };
  }

  async reserve(params: ReserveParams): Promise<ReserveResult> {
    const { promotionId, userId, receiptId, amountMist } = params;
    assertPositiveMist(amountMist, 'amountMist');
    assertWithinLedgerBound(amountMist, 'amountMist');
    const current = await this.promotionStore.readCurrent(promotionId);
    const [receiptState, accountingFields, entitlementFields] = await Promise.all([
      this.readReceiptState(receiptId),
      this.redis.hgetall(promotionAccountingKey(promotionId)),
      this.redis.hgetall(promotionEntitlementKey(promotionId, userId)),
    ]);
    if (receiptState.status === 'finalized') {
      await this.validateFinalResultState(receiptState.result);
      return { ok: false, reason: 'record_changed' };
    }
    const existingReservation =
      receiptState.status === 'reserved' ? receiptState.reservation : null;
    if (existingReservation) {
      assertPromotionReservationIdentity(existingReservation, receiptId);
      if (!current) {
        throw new PromotionRecordCorruptionError('Reservation exists without its Promotion record');
      }
      if (
        existingReservation.promotionId !== promotionId ||
        existingReservation.userId !== userId ||
        existingReservation.amountMist !== amountMist.toString()
      ) {
        return { ok: false, reason: 'record_changed' };
      }
    } else if (!current || current.promotion.status !== 'active') {
      return { ok: false, reason: 'promotion_not_active' };
    }
    if (isEmptyHash(accountingFields)) {
      if (!isEmptyHash(entitlementFields)) {
        throw new PromotionRecordCorruptionError(PROMOTION_ENTITLEMENT_WITHOUT_ACCOUNTING_MESSAGE);
      }
      if (existingReservation) {
        throw new PromotionRecordCorruptionError(
          'Reservation exists without its accounting record',
        );
      }
      return { ok: false, reason: 'entitlement_not_found' };
    }
    const accounting = decodePromotionAccountingRecord(accountingFields);
    const storedEntitlement = isEmptyHash(entitlementFields)
      ? null
      : decodePromotionEntitlementRecord(entitlementFields);
    assertPromotionLedgerReadState(current, promotionId, userId, accounting, storedEntitlement);
    if (storedEntitlement === null) {
      if (existingReservation) {
        throw new PromotionRecordCorruptionError(
          'Reservation exists without its entitlement record',
        );
      }
      return { ok: false, reason: 'entitlement_not_found' };
    }
    if (receiptState.status === 'reserved') {
      assertPromotionReservationAccountingState(
        accounting,
        storedEntitlement,
        receiptState.reservation,
      );
      if (receiptState.reservation.deadlineMs !== receiptState.score) {
        throw new PromotionRecordCorruptionError(
          'Promotion reservation and deadline index are inconsistent',
        );
      }
    } else {
      assertPromotionEntitlementAccountingState(accounting, storedEntitlement);
    }
    const stateChange =
      existingReservation === null
        ? createPromotionReserveStateChange({
            promotion: current.promotion,
            accounting,
            entitlement: storedEntitlement,
            receiptId,
            amountMist,
          })
        : null;
    const expectedDecision =
      stateChange === null
        ? 'existing_reservation'
        : 'status' in stateChange
          ? stateChange.status
          : 'reserve';
    let reserveTransition: PromotionReserveTransition | null = null;
    if (stateChange !== null && !('status' in stateChange)) {
      const nowMs = await this.readRedisTimeMs();
      const deadlineMs = nowMs + this.ttlMs;
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
        throw new Error(
          'RedisPromotionExecutionLedger: reservation deadline exceeds the safe integer range',
        );
      }
      const planned = createPromotionReserveTransition({
        promotion: current.promotion,
        accounting,
        entitlement: storedEntitlement,
        receiptId,
        amountMist,
        deadlineMs,
      });
      if ('status' in planned) {
        throw new PromotionRecordCorruptionError(
          'Promotion reserve transition changed after its state decision',
        );
      }
      reserveTransition = planned;
    }
    let activeReservationRaw = '';
    let activeReservationScore = '';
    let activeReservationMember = '';
    if (expectedDecision === 'concurrent_reservation') {
      const activeReceiptId = storedEntitlement.activeReservationReceiptId;
      if (activeReceiptId === null) {
        throw new PromotionRecordCorruptionError(
          'Promotion reserve decision omitted its active reservation receipt',
        );
      }
      const activeState = await this.readReceiptState(activeReceiptId);
      if (activeState.status !== 'reserved') {
        throw new PromotionRecordCorruptionError(
          'Promotion entitlement points to a missing or finalized reservation',
        );
      }
      assertPromotionReservationAccountingState(
        accounting,
        storedEntitlement,
        activeState.reservation,
      );
      activeReservationMember = promotionReservationDeadlineMember(activeReceiptId);
      activeReservationRaw = serializePromotionReservationRecord(activeState.reservation);
      activeReservationScore = String(activeState.score);
    }
    const expectedAccounting =
      reserveTransition === null ? accounting : reserveTransition.accounting;
    const expectedEntitlement =
      reserveTransition === null ? storedEntitlement : reserveTransition.entitlement;
    const expectedReservationRaw =
      reserveTransition === null
        ? ''
        : serializePromotionReservationRecord(reserveTransition.reservation);
    const expectedDeadlineRaw =
      reserveTransition === null ? '' : String(reserveTransition.reservation.deadlineMs);
    const result = reserveRecord(
      await this.redis.eval(
        LUA_RESERVE,
        [
          this.promotionStore.recordKey(promotionId),
          promotionAccountingKey(promotionId),
          promotionEntitlementKey(promotionId, userId),
          promotionReservationKey(receiptId),
          promotionOperationResultKey(receiptId),
          promotionReservationDeadlineIndexKey(),
        ],
        [
          current.serialized,
          promotionReservationDeadlineMember(receiptId),
          expectedReservationRaw,
          expectedDeadlineRaw,
          ...hashWriteArgs(serializePromotionAccountingRecord(accounting)),
          ...hashWriteArgs(serializePromotionEntitlementRecord(storedEntitlement)),
          promotionReservationKeyPrefix(),
          promotionOperationResultKeyPrefix(),
          expectedDecision === 'reserve' ? 'reserve' : expectedDecision,
          activeReservationMember,
          activeReservationRaw,
          activeReservationScore,
          ...hashWriteArgs(serializePromotionAccountingRecord(expectedAccounting)),
          ...hashWriteArgs(serializePromotionEntitlementRecord(expectedEntitlement)),
        ],
      ),
    );
    if (result.tag === 'PROMOTION_CHANGED') {
      const latest = await this.promotionStore.readCurrent(promotionId);
      return latest?.promotion.status === 'active'
        ? { ok: false, reason: 'record_changed' }
        : { ok: false, reason: 'promotion_not_active' };
    }
    if (result.tag === 'RESULT') {
      const finalResult = decodePromotionOperationResultRecord(result.serialized);
      assertPromotionOperationResultIdentity(finalResult, receiptId);
      await this.validateFinalResultState(finalResult);
      return { ok: false, reason: 'record_changed' };
    }
    if (result.tag === 'RESERVATION') {
      const existing = decodePromotionReservationRecord(result.serialized);
      assertPromotionReservationIdentity(existing, receiptId);
      if (
        existing.promotionId !== promotionId ||
        existing.userId !== userId ||
        existing.amountMist !== amountMist.toString()
      ) {
        return { ok: false, reason: 'record_changed' };
      }
      if (!result.accounting || !result.entitlement || result.score === null) {
        throw new PromotionRecordCorruptionError(
          'Promotion reserve omitted its current reservation state',
        );
      }
      const score = Number(result.score);
      if (!Number.isSafeInteger(score) || score <= 0 || existing.deadlineMs !== score) {
        throw new PromotionRecordCorruptionError(
          'Promotion reservation and deadline index are inconsistent',
        );
      }
      assertPromotionAccountingMatchesPromotion(current.promotion, result.accounting);
      assertPromotionReservationAccountingState(result.accounting, result.entitlement, existing);
      return { ok: true, entitlement: promotionEntitlementFromRecord(result.entitlement) };
    }
    if (result.tag === 'RESERVED') {
      const reservation = decodePromotionReservationRecord(result.serialized);
      assertPromotionReservationIdentity(reservation, receiptId);
      if (!result.accounting || !result.entitlement) {
        throw new PromotionRecordCorruptionError('Promotion reserve omitted its ledger snapshot');
      }
      assertPromotionAccountingIdentity(result.accounting, promotionId);
      assertPromotionEntitlementIdentity(result.entitlement, promotionId, userId);
      assertPromotionAccountingMatchesPromotion(current.promotion, result.accounting);
      assertPromotionReservationAccountingState(result.accounting, result.entitlement, reservation);
      if (expectedDecision !== 'reserve' || reserveTransition === null) {
        throw new PromotionRecordCorruptionError(
          'Promotion reserve mutated despite a TypeScript-owned failure decision',
        );
      }
      if (
        serializePromotionReservationRecord(reserveTransition.reservation) !== result.serialized ||
        !samePromotionAccountingRecord(reserveTransition.accounting, result.accounting) ||
        !samePromotionEntitlementRecord(reserveTransition.entitlement, result.entitlement)
      ) {
        throw new PromotionRecordCorruptionError(
          'Promotion reserve did not apply the TypeScript-owned state transition',
        );
      }
      return { ok: true, entitlement: promotionEntitlementFromRecord(result.entitlement) };
    }
    if (result.tag === 'CORRUPT') {
      throw new PromotionRecordCorruptionError('Promotion reserve found corrupt stored state');
    }
    if (result.tag === 'CONCURRENT_RESERVATION') {
      const activeReservation = decodePromotionReservationRecord(result.serialized);
      const score = Number(result.score);
      if (
        !result.accounting ||
        !result.entitlement ||
        !Number.isSafeInteger(score) ||
        score <= 0 ||
        activeReservation.deadlineMs !== score ||
        activeReservation.receiptId !== storedEntitlement.activeReservationReceiptId
      ) {
        throw new PromotionRecordCorruptionError(
          'Promotion entitlement points to an inconsistent active reservation',
        );
      }
      if (expectedDecision !== 'concurrent_reservation') {
        throw new PromotionRecordCorruptionError(
          'Promotion concurrent-reservation result contradicts the TypeScript-owned decision',
        );
      }
      assertPromotionReservationAccountingState(
        result.accounting,
        result.entitlement,
        activeReservation,
      );
      if (
        !samePromotionAccountingRecord(result.accounting, accounting) ||
        !samePromotionEntitlementRecord(result.entitlement, storedEntitlement)
      ) {
        throw new PromotionRecordCorruptionError(
          'Promotion concurrent-reservation result changed its ledger snapshot',
        );
      }
      return { ok: false, reason: 'concurrent_reservation' };
    }
    if (
      result.tag === 'ENTITLEMENT_NOT_ACTIVE' ||
      result.tag === 'ENTITLEMENT_INSUFFICIENT' ||
      result.tag === 'BUDGET_INSUFFICIENT'
    ) {
      const failureReason =
        result.tag === 'ENTITLEMENT_NOT_ACTIVE'
          ? 'entitlement_not_active'
          : result.tag === 'ENTITLEMENT_INSUFFICIENT'
            ? 'entitlement_insufficient'
            : 'budget_insufficient';
      if (
        expectedDecision !== failureReason ||
        !result.accounting ||
        !result.entitlement ||
        !samePromotionAccountingRecord(result.accounting, accounting) ||
        !samePromotionEntitlementRecord(result.entitlement, storedEntitlement)
      ) {
        throw new PromotionRecordCorruptionError(
          'Promotion reserve failure contradicts the TypeScript-owned decision',
        );
      }
      return { ok: false, reason: failureReason };
    }
    if (result.tag === 'STATE_CHANGED') {
      if (!result.accounting || !result.entitlement) {
        throw new PromotionRecordCorruptionError(
          'Promotion reserve state change omitted its ledger snapshot',
        );
      }
      assertPromotionLedgerReadState(
        current,
        promotionId,
        userId,
        result.accounting,
        result.entitlement,
      );
      return { ok: false, reason: 'record_changed' };
    }
    return unreachableResult(result.tag, 'Promotion reserve');
  }

  async consume(receiptId: string, actualGasMist: bigint): Promise<ConsumeResult> {
    assertNonNegativeMist(actualGasMist, 'actualGasMist');
    assertWithinLedgerBound(actualGasMist, 'actualGasMist');
    const state = await this.readReceiptState(receiptId);
    if (state.status === 'finalized') {
      await this.validateFinalResultState(state.result);
      return operationRetryResult(
        serializePromotionOperationResultRecord(state.result),
        receiptId,
        'consume',
        actualGasMist,
      );
    }
    if (state.status === 'missing') return { ok: false, reason: 'reservation_not_found' };
    await this.validateReservedReceiptState(state);
    return this.finalize(state.reservation, 'consume', actualGasMist);
  }

  async release(receiptId: string): Promise<ReleaseResult> {
    const state = await this.readReceiptState(receiptId);
    if (state.status === 'finalized') {
      await this.validateFinalResultState(state.result);
      return operationRetryResult(
        serializePromotionOperationResultRecord(state.result),
        receiptId,
        'release',
      );
    }
    if (state.status === 'missing') return { ok: false, reason: 'reservation_not_found' };
    await this.validateReservedReceiptState(state);
    return this.finalize(state.reservation, 'release', 0n);
  }

  private async finalize(
    reservation: PromotionReservationRecord,
    operation: 'consume' | 'release',
    actualGasMist: bigint,
  ): Promise<ConsumeResult | ReleaseResult> {
    const { accounting, entitlement } = await this.readLedgerState(
      reservation.promotionId,
      reservation.userId,
    );
    if (!accounting || !entitlement) {
      throw new PromotionRecordCorruptionError(
        'Promotion reservation is missing accounting or entitlement state',
      );
    }
    try {
      assertPromotionReservationAccountingState(accounting, entitlement, reservation);
    } catch (error) {
      const latest = await this.readReceiptState(reservation.receiptId);
      if (latest.status === 'finalized') {
        await this.validateFinalResultState(latest.result);
        return operationRetryResult(
          serializePromotionOperationResultRecord(latest.result),
          reservation.receiptId,
          operation,
          operation === 'consume' ? actualGasMist : undefined,
        );
      }
      throw error;
    }

    const chargedMist = operation === 'consume' ? actualGasMist : 0n;
    const transition = createPromotionFinalizeTransition({
      accounting,
      entitlement,
      reservation,
      operation,
      chargedMist,
      usedAt: operation === 'consume' ? new Date().toISOString() : null,
    });
    const resultRaw = serializePromotionOperationResultRecord(transition.result);
    const result = finalizeRecord(
      await this.redis.eval(
        LUA_FINALIZE,
        [
          promotionReservationKey(reservation.receiptId),
          promotionOperationResultKey(reservation.receiptId),
          promotionReservationDeadlineIndexKey(),
          promotionAccountingKey(reservation.promotionId),
          promotionEntitlementKey(reservation.promotionId, reservation.userId),
        ],
        [
          serializePromotionReservationRecord({
            receiptId: reservation.receiptId,
            promotionId: reservation.promotionId,
            userId: reservation.userId,
            amountMist: reservation.amountMist,
            deadlineMs: reservation.deadlineMs,
          }),
          ...hashWriteArgs(serializePromotionAccountingRecord(accounting)),
          ...hashWriteArgs(serializePromotionEntitlementRecord(entitlement)),
          ...hashWriteArgs(serializePromotionAccountingRecord(transition.accounting)),
          ...hashWriteArgs(serializePromotionEntitlementRecord(transition.entitlement)),
          String(reservation.deadlineMs),
          promotionReservationDeadlineMember(reservation.receiptId),
          resultRaw,
        ],
      ),
    );
    if (result.tag === 'RESULT') {
      const retry = exactOperationRetry(
        result.serialized,
        reservation.receiptId,
        operation,
        operation === 'consume' ? actualGasMist : undefined,
      );
      if (retry) await this.validateFinalResultState(retry);
      return retry
        ? { ok: true, entitlement: promotionEntitlementFromRecord(retry.entitlement) }
        : { ok: false, reason: 'record_changed' };
    }
    if (result.tag === 'MISSING') return { ok: false, reason: 'reservation_not_found' };
    if (result.tag === 'STATE_CHANGED') {
      if (!result.accounting || !result.entitlement) {
        throw new PromotionRecordCorruptionError(
          'Promotion final operation state change omitted its ledger snapshot',
        );
      }
      const current = await this.promotionStore.readCurrent(reservation.promotionId);
      assertPromotionLedgerReadState(
        current,
        reservation.promotionId,
        reservation.userId,
        result.accounting,
        result.entitlement,
      );
      assertPromotionReservationAccountingState(result.accounting, result.entitlement, reservation);
      return { ok: false, reason: 'record_changed' };
    }
    if (result.tag === 'CHANGED') return { ok: false, reason: 'record_changed' };
    if (result.tag === 'CORRUPT') {
      throw new PromotionRecordCorruptionError('Promotion final operation found corrupt state');
    }
    const applied = decodePromotionOperationResultRecord(result.serialized);
    assertPromotionOperationResultIdentity(applied, reservation.receiptId);
    if (!result.accounting || !result.entitlement) {
      throw new PromotionRecordCorruptionError(
        'Promotion final operation omitted its applied ledger snapshot',
      );
    }
    if (
      serializePromotionOperationResultRecord(applied) !== resultRaw ||
      !samePromotionAccountingRecord(result.accounting, transition.accounting) ||
      !samePromotionEntitlementRecord(result.entitlement, transition.entitlement)
    ) {
      throw new PromotionRecordCorruptionError(
        'Promotion final operation did not apply the TypeScript-owned state transition',
      );
    }
    return { ok: true, entitlement: promotionEntitlementFromRecord(applied.entitlement) };
  }

  async getEntitlement(promotionId: string, userId: string): Promise<Entitlement | null> {
    const { entitlement } = await this.readLedgerState(promotionId, userId);
    return entitlement ? promotionEntitlementFromRecord(entitlement) : null;
  }

  private async readLedgerState(
    promotionId: string,
    userId: string | null,
  ): Promise<{
    accounting: PromotionAccountingRecord | null;
    entitlement: PromotionEntitlementRecord | null;
  }> {
    const result = ledgerReadRecord(
      await this.redis.eval(
        LUA_READ_LEDGER_STATE,
        userId === null
          ? [promotionAccountingKey(promotionId)]
          : [promotionAccountingKey(promotionId), promotionEntitlementKey(promotionId, userId)],
        [userId === null ? '0' : '1'],
      ),
    );
    if (result.tag === 'ENTITLEMENT_WITHOUT_ACCOUNTING') {
      throw new PromotionRecordCorruptionError(PROMOTION_ENTITLEMENT_WITHOUT_ACCOUNTING_MESSAGE);
    }
    if (result.tag === 'CORRUPT') {
      throw new PromotionRecordCorruptionError('Promotion ledger read found corrupt stored state');
    }
    const current = result.accounting ? await this.promotionStore.readCurrent(promotionId) : null;
    assertPromotionLedgerReadState(
      current,
      promotionId,
      userId,
      result.accounting,
      result.entitlement,
    );
    return { accounting: result.accounting, entitlement: result.entitlement };
  }

  async getPromotionLedgerStatus(
    promotionId: string,
    userId: string | null,
  ): Promise<PromotionLedgerStatus> {
    const { accounting, entitlement } = await this.readLedgerState(promotionId, userId);
    return {
      promotionId,
      entitlement: entitlement ? promotionEntitlementFromRecord(entitlement) : null,
      claimedCount: accounting?.claimedCount ?? 0,
      budget: {
        availableMist: BigInt(accounting?.availableMist ?? '0'),
        reservedMist: BigInt(accounting?.reservedMist ?? '0'),
        consumedMist: BigInt(accounting?.consumedMist ?? '0'),
      },
    };
  }

  async getPromotionListLedgerStatuses(
    promotionIds: readonly string[],
    userId: string,
  ): Promise<PromotionListLedgerStatus[]> {
    assertPromotionListLedgerBatchBound(promotionIds);
    if (promotionIds.length === 0) return [];
    const keys = promotionIds.flatMap((promotionId) => [
      this.promotionStore.recordKey(promotionId),
      promotionAccountingKey(promotionId),
      promotionEntitlementKey(promotionId, userId),
    ]);
    return promotionListLedgerRecords(
      await this.redis.eval(LUA_READ_PROMOTION_LIST_LEDGER_STATES, keys, [
        String(promotionIds.length),
      ]),
      promotionIds,
      userId,
    );
  }

  async sweepExpiredReservations(): Promise<number> {
    return (await this.runSweepBatch()).swept;
  }

  private runSweepBatch(): Promise<SweepBatchResult> {
    if (this.runningBatch) return this.runningBatch;
    this.runningBatch = this.sweepExpiredReservationsBatch().finally(() => {
      this.runningBatch = null;
    });
    return this.runningBatch;
  }

  private async sweepExpiredReservationsBatch(): Promise<SweepBatchResult> {
    const value = await this.redis.eval(
      LUA_DUE_RESERVATIONS,
      [promotionReservationDeadlineIndexKey()],
      [
        String(PROMOTION_EXECUTION_LEDGER_SWEEP_BATCH_SIZE),
        promotionReservationKeyPrefix(),
        promotionOperationResultKeyPrefix(),
      ],
    );
    if (
      !Array.isArray(value) ||
      value.length < 2 ||
      typeof value[0] !== 'string' ||
      typeof value[1] !== 'string'
    ) {
      throw new PromotionRecordCorruptionError('Reservation deadline read returned malformed data');
    }
    const nowMs = Number(value[0]);
    const examined = Number(value[1]);
    if (
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0 ||
      !Number.isSafeInteger(examined) ||
      examined < 0 ||
      examined > PROMOTION_EXECUTION_LEDGER_SWEEP_BATCH_SIZE ||
      value.length !== 2 + examined * 4
    ) {
      throw new PromotionRecordCorruptionError('Reservation deadline read returned malformed data');
    }
    let swept = 0;
    for (let index = 2; index < value.length; index += 4) {
      const kind = value[index];
      const receiptId = value[index + 1];
      const scoreRaw = value[index + 2];
      const raw = value[index + 3];
      if (
        (kind !== 'RESERVATION' && kind !== 'MISSING' && kind !== 'CORRUPT') ||
        typeof receiptId !== 'string' ||
        typeof scoreRaw !== 'string' ||
        typeof raw !== 'string'
      ) {
        throw new PromotionRecordCorruptionError(
          'Reservation deadline member must be a tagged receipt/record tuple',
        );
      }
      const score = Number(scoreRaw);
      if (!Number.isSafeInteger(score) || score <= 0) {
        throw new PromotionRecordCorruptionError(
          'Reservation deadline index score must be a positive safe integer',
        );
      }
      if (kind === 'MISSING') {
        throw new PromotionRecordCorruptionError(
          `Reservation deadline index has no record or operation result for ${receiptId}`,
        );
      }
      if (kind === 'CORRUPT') {
        throw new PromotionRecordCorruptionError(
          `Reservation deadline receipt ${receiptId} has contradictory reservation or final result state`,
        );
      }
      const reservation = decodePromotionReservationRecord(raw);
      assertPromotionReservationIdentity(reservation, receiptId);
      promotionReservationDeadlineMember(receiptId);
      if (reservation.deadlineMs !== score || reservation.deadlineMs > nowMs) {
        throw new PromotionRecordCorruptionError(
          'Reservation deadline index contradicts its record',
        );
      }
      const result = await this.finalize(reservation, 'release', 0n);
      if (result.ok) swept += 1;
      else if (result.reason !== 'record_changed') {
        throw new PromotionRecordCorruptionError(
          `Expired reservation could not be released: ${result.reason}`,
        );
      }
    }
    return { swept, examined };
  }

  private startScheduledSweep(): void {
    if (this.stopping || this.runningSweep) return;
    this.runningSweep = this.drainExpiredReservations()
      .catch((error) => {
        logStructuredEvent(
          PROMOTION_EXECUTION_LEDGER_REAPER_ERROR,
          { error: error instanceof Error ? error.message : String(error) },
          'error',
        );
      })
      .finally(() => {
        this.runningSweep = null;
      });
  }

  private async drainExpiredReservations(): Promise<void> {
    while (!this.stopping) {
      const { examined } = await this.runSweepBatch();
      if (examined < PROMOTION_EXECUTION_LEDGER_SWEEP_BATCH_SIZE) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.all([this.runningSweep, this.runningBatch]);
  }
}
