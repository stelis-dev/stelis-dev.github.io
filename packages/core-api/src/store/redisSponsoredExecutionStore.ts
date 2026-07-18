import { createHash } from 'node:crypto';
import { TransactionDataBuilder } from '@mysten/sui/transactions';
import type { SponsorPoolRecordAdapter } from '../context.js';
import type { SponsorResultEconomics, SponsorResultMetadata } from '../handlers/sponsorResult.js';
import type {
  PromotionFinalizationPlan,
  PromotionReceiptTransitionAccess,
} from '../studio/executionLedger.js';
import {
  promotionOperationResultMatchesExpectation,
  serializePromotionAccountingRecord,
  serializePromotionEntitlementRecord,
} from '../studio/promotionRecords.js';
import { PREPARE_TTL_MS } from '../preparePolicy.js';
import {
  PrepareOverloadError,
  PrepareSenderQuotaError,
  PrepareStudioUserQuotaError,
} from './prepareErrors.js';
import {
  decodePreparedTxEntry,
  parseCurrentPreparedTxDraft,
  serializePreparedTxEntry,
  type PreparedTxDraft,
  type PreparedTxEntry,
} from './prepareTypes.js';
import type { RedisClientLike } from './redisClient.js';
import {
  createExecutingSponsoredExecutionRecordParts,
  decodeSponsoredExecutionRecord,
  materializeExecutingSponsoredExecutionRecord,
  SPONSORED_EXECUTION_REDIS_KEY_PREFIX,
  serializeSponsoredExecutionRecord,
  sponsorResultMetadata,
  SponsoredExecutionRecordCorruptionError,
  storeSponsorResult,
  storedSponsorResultMatchesMetadata,
  type ExecutingSponsoredExecutionRecord,
  type FinalSponsoredExecutionRecord,
} from './sponsoredExecutionRecords.js';
import {
  MAX_CONCURRENT_PREPARED_PER_IP,
  MAX_OUTSTANDING_PREPARED_PER_SENDER,
  MAX_OUTSTANDING_PREPARED_PER_STUDIO_USER,
  SPONSORED_EXECUTION_RECOVERY_BATCH_SIZE,
  assertFinalResultMatchesExecution,
  assertPreparedResultMatchesReceipt,
  assertRecoveryMatchesPreparedReceipt,
  sponsoredExecutionOrderIdHash,
  type BeginSponsoredExecutionInput,
  type BeginSponsoredExecutionResult,
  type DiscardPreparedReceiptInput,
  type DiscardPreparedReceiptResult,
  type FinalizeSponsoredExecutionInput,
  type FinalizeSponsoredExecutionResult,
  type SponsoredExecutionRecoveryCursor,
  type SponsoredExecutionRecoveryPage,
  type SponsoredExecutionStoreAdapter,
} from './sponsoredExecutionStore.js';

const U64_MAX = (1n << 64n) - 1n;
const U64_MAX_DECIMAL = U64_MAX.toString();

const REDIS_TIME_MS_SCRIPT = `
local now = redis.call('TIME')
return tostring(tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000))
`;

const REDIS_KEY_TYPE_HELPER = `
local function redisKeyType(key)
  local value = redis.call('TYPE', key)
  if type(value) == 'table' then return value.ok end
  return value
end
`;

const COMMIT_PREPARED_SCRIPT = `${REDIS_KEY_TYPE_HELPER}
local preparedKey = KEYS[1]
local executionKey = KEYS[2]
local finalKey = KEYS[3]
local leaseKey = KEYS[4]
local preparedDeadlineKey = KEYS[5]
local ipKey = KEYS[6]
local senderKey = KEYS[7]
local userKey = KEYS[8]
local nonceKey = KEYS[9]

local preparedDeadlineType = redisKeyType(preparedDeadlineKey)
if preparedDeadlineType ~= 'none' and preparedDeadlineType ~= 'zset' then
  return 'CORRUPT_INDEX'
end

if redis.call('EXISTS', preparedKey) == 1
  or redis.call('EXISTS', executionKey) == 1
  or redis.call('EXISTS', finalKey) == 1 then
  return 'RECEIPT_EXISTS'
end
if redis.call('GET', leaseKey) ~= ARGV[1] then return 'LEASE_CHANGED' end
if redis.call('ZCARD', ipKey) >= tonumber(ARGV[6]) then return 'IP_LIMIT' end

local mode = ARGV[8]
if mode == 'generic' then
  if redis.call('GET', nonceKey) ~= ARGV[9] then return 'NONCE_CHANGED' end
  if redis.call('ZSCORE', senderKey, ARGV[4]) == false then return 'NONCE_CHANGED' end
else
  if redis.call('ZCARD', senderKey) >= tonumber(ARGV[7]) then return 'SENDER_LIMIT' end
  if redis.call('ZCARD', userKey) >= tonumber(ARGV[10]) then return 'USER_LIMIT' end
end

if ARGV[12] == '1' then
  if redis.call('GET', KEYS[10]) ~= ARGV[13] then return 'PROMOTION_CHANGED' end
  if redis.call('GET', KEYS[11]) ~= ARGV[14] then return 'PROMOTION_CHANGED' end
  if redis.call('EXISTS', KEYS[12]) == 1 then return 'PROMOTION_CHANGED' end
  if redis.call('ZSCORE', KEYS[13], ARGV[4]) ~= ARGV[15] then
    return 'PROMOTION_CHANGED'
  end
end

redis.call('SET', preparedKey, ARGV[3])
redis.call('SET', leaseKey, ARGV[2])
redis.call('ZADD', preparedDeadlineKey, ARGV[5], ARGV[4])
redis.call('ZADD', ipKey, ARGV[11], ARGV[4])
redis.call('ZADD', senderKey, ARGV[11], ARGV[4])
if mode == 'promotion' then
  redis.call('ZADD', userKey, ARGV[11], ARGV[4])
end
return 'OK'
`;

const BEGIN_EXECUTION_SCRIPT = `${REDIS_KEY_TYPE_HELPER}
local executionDeadlineType = redisKeyType(KEYS[14])
if executionDeadlineType ~= 'none' and executionDeadlineType ~= 'zset' then
  return {'CORRUPT_INDEX', '', ''}
end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {'PREPARED_CHANGED', '', ''} end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return {'LEASE_CHANGED', '', ''} end
if redis.call('EXISTS', KEYS[3]) == 1 then return {'EXECUTION_EXISTS', '', ''} end
if redis.call('EXISTS', KEYS[4]) == 1 then return {'FINAL_EXISTS', '', ''} end
if redis.call('ZSCORE', KEYS[5], ARGV[3]) ~= ARGV[4] then return {'PREPARED_CHANGED', '', ''} end
if redis.call('ZSCORE', KEYS[6], ARGV[3]) ~= ARGV[17]
  or redis.call('ZSCORE', KEYS[7], ARGV[3]) ~= ARGV[17] then
  return {'PREPARED_CHANGED', '', ''}
end
if ARGV[16] == 'generic' then
  if redis.call('GET', KEYS[9]) ~= ARGV[18] then return {'PREPARED_CHANGED', '', ''} end
elseif redis.call('ZSCORE', KEYS[8], ARGV[3]) ~= ARGV[17] then
  return {'PREPARED_CHANGED', '', ''}
end

if ARGV[8] == '1' then
  if redis.call('GET', KEYS[10]) ~= ARGV[9] then return {'PROMOTION_CHANGED', '', ''} end
  if redis.call('GET', KEYS[11]) ~= ARGV[10] then return {'PROMOTION_CHANGED', '', ''} end
  if redis.call('EXISTS', KEYS[12]) == 1 then return {'PROMOTION_CHANGED', '', ''} end
  if redis.call('ZSCORE', KEYS[13], ARGV[3]) ~= ARGV[11] then return {'PROMOTION_CHANGED', '', ''} end
end

local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
if nowMs >= tonumber(ARGV[4]) then return {'EXPIRED', '', ''} end
local budgetMs = tonumber(ARGV[7])
local deadlineMs = nowMs + budgetMs
if budgetMs == nil or budgetMs <= 0 or math.floor(budgetMs) ~= budgetMs
  or deadlineMs <= nowMs or deadlineMs > ${Number.MAX_SAFE_INTEGER} then
  return {'INVALID_DEADLINE', '', ''}
end
local deadlineRaw = string.format('%.0f', deadlineMs)
local executionRaw = ARGV[5] .. deadlineRaw .. ARGV[6]
local leaseRaw = ARGV[12] .. deadlineRaw .. ARGV[13]
local reservationRaw = ''
if ARGV[8] == '1' then
  reservationRaw = ARGV[14] .. deadlineRaw .. ARGV[15]
end

redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[5], ARGV[3])
redis.call('ZREM', KEYS[6], ARGV[3])
redis.call('ZREM', KEYS[7], ARGV[3])
if ARGV[16] == 'generic' then
  redis.call('DEL', KEYS[9])
else
  redis.call('ZREM', KEYS[8], ARGV[3])
end
redis.call('SET', KEYS[3], executionRaw)
redis.call('ZADD', KEYS[14], deadlineRaw, ARGV[3])
redis.call('SET', KEYS[2], leaseRaw)
if ARGV[8] == '1' then
  redis.call('SET', KEYS[11], reservationRaw)
  redis.call('ZREM', KEYS[13], ARGV[3])
end
return {'OK', deadlineRaw, executionRaw}
`;

const HASH_HELPERS = `${REDIS_KEY_TYPE_HELPER}
local function exactHash(key, startAt, count)
  if redis.call('HLEN', key) ~= count then return false end
  for index = 0, count - 1 do
    local field = ARGV[startAt + index * 2]
    local value = ARGV[startAt + index * 2 + 1]
    if redis.call('HGET', key, field) ~= value then return false end
  end
  return true
end

local function writeHash(key, startAt, count)
  if count == 0 then return end
  redis.call('HSET', key, unpack(ARGV, startAt, startAt + count * 2 - 1))
end
`;

const DISCARD_PREPARED_SCRIPT = `${HASH_HELPERS}
local finalRaw = redis.call('GET', KEYS[3])
if finalRaw then return {'FINAL', finalRaw} end
local pendingCallbackType = redisKeyType(KEYS[9])
if pendingCallbackType ~= 'none' and pendingCallbackType ~= 'zset' then
  return {'CORRUPT_INDEX', ''}
end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {'CHANGED', ''} end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return {'CHANGED', ''} end
if redis.call('ZSCORE', KEYS[4], ARGV[3]) ~= ARGV[4] then return {'CHANGED', ''} end
if redis.call('ZSCORE', KEYS[5], ARGV[3]) ~= ARGV[14]
  or redis.call('ZSCORE', KEYS[6], ARGV[3]) ~= ARGV[14] then
  return {'CHANGED', ''}
end
if ARGV[13] == 'generic' then
  if redis.call('GET', KEYS[8]) ~= ARGV[15] then return {'CHANGED', ''} end
elseif redis.call('ZSCORE', KEYS[7], ARGV[3]) ~= ARGV[14] then
  return {'CHANGED', ''}
end

local accountingCount = tonumber(ARGV[10])
local entitlementCount = tonumber(ARGV[11])
local expectedAccountingStart = 16
local expectedEntitlementStart = expectedAccountingStart + accountingCount * 2
local nextAccountingStart = expectedEntitlementStart + entitlementCount * 2
local nextEntitlementStart = nextAccountingStart + accountingCount * 2

if ARGV[7] == '1' then
  if redis.call('GET', KEYS[10]) ~= ARGV[8] then return {'CHANGED', ''} end
  if redis.call('EXISTS', KEYS[11]) == 1 then return {'CHANGED', ''} end
  if redis.call('ZSCORE', KEYS[12], ARGV[3]) ~= ARGV[9] then return {'CHANGED', ''} end
  if not exactHash(KEYS[13], expectedAccountingStart, accountingCount)
    or not exactHash(KEYS[14], expectedEntitlementStart, entitlementCount) then
    return {'CHANGED', ''}
  end
end

redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[4], ARGV[3])
redis.call('ZREM', KEYS[5], ARGV[3])
redis.call('ZREM', KEYS[6], ARGV[3])
if ARGV[13] == 'generic' then
  redis.call('DEL', KEYS[8])
else
  redis.call('ZREM', KEYS[7], ARGV[3])
end
if ARGV[7] == '1' then
  writeHash(KEYS[13], nextAccountingStart, accountingCount)
  writeHash(KEYS[14], nextEntitlementStart, entitlementCount)
  redis.call('DEL', KEYS[10])
  redis.call('SET', KEYS[11], ARGV[12])
  redis.call('ZREM', KEYS[12], ARGV[3])
end
redis.call('SET', KEYS[3], ARGV[5])
redis.call('ZADD', KEYS[9], ARGV[6], ARGV[3])
return {'APPLIED', ARGV[5]}
`;

const FINALIZE_EXECUTION_SCRIPT = `${HASH_HELPERS}
local finalRaw = redis.call('GET', KEYS[2])
if finalRaw then return {'FINAL', finalRaw} end
local pendingCallbackType = redisKeyType(KEYS[5])
if pendingCallbackType ~= 'none' and pendingCallbackType ~= 'zset' then
  return {'CORRUPT_INDEX', ''}
end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {'CHANGED', ''} end
if redis.call('GET', KEYS[3]) ~= ARGV[2] then return {'CHANGED', ''} end
if redis.call('ZSCORE', KEYS[4], ARGV[3]) ~= ARGV[4] then return {'CHANGED', ''} end

local accountingCount = tonumber(ARGV[10])
local entitlementCount = tonumber(ARGV[11])
local expectedAccountingStart = 13
local expectedEntitlementStart = expectedAccountingStart + accountingCount * 2
local nextAccountingStart = expectedEntitlementStart + entitlementCount * 2
local nextEntitlementStart = nextAccountingStart + accountingCount * 2

if ARGV[7] == '1' then
  if redis.call('GET', KEYS[6]) ~= ARGV[8] then return {'CHANGED', ''} end
  if redis.call('EXISTS', KEYS[7]) == 1 then return {'CHANGED', ''} end
  if redis.call('ZSCORE', KEYS[8], ARGV[3]) ~= false then return {'CHANGED', ''} end
  if not exactHash(KEYS[9], expectedAccountingStart, accountingCount)
    or not exactHash(KEYS[10], expectedEntitlementStart, entitlementCount) then
    return {'CHANGED', ''}
  end
end

redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[3])
redis.call('ZREM', KEYS[4], ARGV[3])
if ARGV[7] == '1' then
  writeHash(KEYS[9], nextAccountingStart, accountingCount)
  writeHash(KEYS[10], nextEntitlementStart, entitlementCount)
  redis.call('DEL', KEYS[6])
  redis.call('SET', KEYS[7], ARGV[12])
end
redis.call('SET', KEYS[2], ARGV[5])
redis.call('ZADD', KEYS[5], ARGV[6], ARGV[3])
return {'APPLIED', ARGV[5]}
`;

const READ_RECOVERY_PAGE_SCRIPT = `
local throughMs
local start = 0
if ARGV[3] ~= '' then
  throughMs = tonumber(ARGV[3])
  local cursorScore = tonumber(ARGV[4])
  if not throughMs or throughMs <= 0 or throughMs > ${Number.MAX_SAFE_INTEGER}
     or not cursorScore or cursorScore <= 0 or cursorScore > throughMs then
    return {'INVALID_CURSOR'}
  end
  local anchor = ARGV[5] .. string.char(0)
  if redis.call('ZSCORE', KEYS[1], anchor) then return {'ANCHOR_CONFLICT'} end
  redis.call('ZADD', KEYS[1], ARGV[4], anchor)
  start = redis.call('ZRANK', KEYS[1], anchor)
  redis.call('ZREM', KEYS[1], anchor)
  if not start then return {'ANCHOR_CONFLICT'} end
else
  local now = redis.call('TIME')
  throughMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
end

local limit = tonumber(ARGV[2])
local members = redis.call('ZRANGE', KEYS[1], start, start + limit - 1, 'WITHSCORES')
local result = {'OK', string.format('%.0f', throughMs), '0'}
local count = 0
for index = 1, #members, 2 do
  local score = tonumber(members[index + 1])
  if score > throughMs then break end
  local receiptId = members[index]
  count = count + 1
  result[#result + 1] = receiptId
  result[#result + 1] = members[index + 1]
  result[#result + 1] = redis.call('GET', ARGV[1] .. receiptId) or ''
end
result[3] = tostring(count)
return result
`;

const MARK_CALLBACK_DELIVERED_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('ZSCORE', KEYS[2], ARGV[3]) ~= ARGV[4] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[3])
return 1
`;

const CHECK_USER_QUOTA_SCRIPT = `
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
local live = 0
for _, receiptId in ipairs(members) do
  if redis.call('EXISTS', ARGV[1] .. receiptId) == 1 then
    live = live + 1
  else
    redis.call('ZREM', KEYS[1], receiptId)
  end
end
return tostring(live)
`;

const RESERVE_NONCE_SCRIPT = `
local function normalizeDecimal(value)
  if type(value) ~= 'string' or string.len(value) == 0 or string.len(value) > 20 then
    error('invalid decimal length')
  end
  if not string.match(value, '^%d+$') then error('invalid decimal') end
  local normalized = string.gsub(value, '^0+', '')
  if normalized == '' then return '0' end
  if string.len(normalized) > 20 then error('invalid decimal length') end
  return normalized
end
local function greater(left, right)
  left = normalizeDecimal(left)
  right = normalizeDecimal(right)
  if string.len(left) ~= string.len(right) then return string.len(left) > string.len(right) end
  return left > right
end
local function increment(value)
  local carry = 1
  local output = ''
  for index = string.len(value), 1, -1 do
    local digit = tonumber(string.sub(value, index, index)) + carry
    if digit >= 10 then digit = digit - 10; carry = 1 else carry = 0 end
    output = tostring(digit) .. output
  end
  if carry == 1 then output = '1' .. output end
  return normalizeDecimal(output)
end

local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local existing = redis.call('GET', KEYS[2])
if existing then
  if redis.call('ZSCORE', KEYS[1], ARGV[6]) == false then error('nonce identity changed') end
  if normalizeDecimal(existing) ~= existing then error('non-canonical nonce') end
  return {'OK', existing}
end
local members = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
local live = 0
local maximum = normalizeDecimal(ARGV[1])
for index = 1, #members, 2 do
  local receiptId = members[index]
  local score = tonumber(members[index + 1])
  local preparedExists = redis.call('EXISTS', ARGV[5] .. receiptId) == 1
  local nonce = redis.call('GET', ARGV[4] .. receiptId)
  if not preparedExists and nonce and score + tonumber(ARGV[3]) <= nowMs then
    redis.call('DEL', ARGV[4] .. receiptId)
    redis.call('ZREM', KEYS[1], receiptId)
  elseif preparedExists or nonce then
    live = live + 1
    if nonce then
      local canonicalNonce = normalizeDecimal(nonce)
      if canonicalNonce ~= nonce then error('non-canonical nonce') end
      if greater(nonce, maximum) then maximum = nonce end
    end
  else
    redis.call('ZREM', KEYS[1], receiptId)
  end
end
if live >= tonumber(ARGV[2]) then return {'LIMIT', tostring(live)} end
if greater(maximum, ARGV[7]) then error('nonce exceeds u64') end
if not greater(ARGV[7], maximum) then return {'EXHAUSTED', ''} end
local nextNonce = increment(maximum)
redis.call('SET', KEYS[2], nextNonce)
redis.call('ZADD', KEYS[1], tostring(nowMs), ARGV[6])
return {'OK', nextNonce}
`;

const RELEASE_NONCE_SCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
local deleted = redis.call('DEL', KEYS[2])
return deleted
`;

export interface RedisSponsoredExecutionStoreOptions {
  readonly keyPrefix?: string;
  readonly prepareTtlMs?: number;
  readonly maxPerIp?: number;
  readonly maxPerStudioUser?: number;
  readonly maxOutstandingPerSender?: number;
}

function safePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function safeDeadline(nowMs: number, durationMs: number, label: string): number {
  const deadline = nowMs + durationMs;
  if (!Number.isSafeInteger(deadline) || deadline <= nowMs)
    throw new Error(`${label} overflows the safe time range`);
  return deadline;
}

function redisInteger(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value))
    throw new Error(`${label} is not a canonical integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${label} is outside the safe integer range`);
  return parsed;
}

function scriptTag(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} returned a non-string result`);
  return value;
}

function scriptPair(value: unknown, label: string): readonly [string, string] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    typeof value[1] !== 'string'
  ) {
    throw new Error(`${label} returned an invalid result`);
  }
  return [value[0], value[1]];
}

function scriptTriple(value: unknown, label: string): readonly [string, string, string] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    typeof value[0] !== 'string' ||
    typeof value[1] !== 'string' ||
    typeof value[2] !== 'string'
  ) {
    throw new Error(`${label} returned an invalid result`);
  }
  return [value[0], value[1], value[2]];
}

function hashArguments(fields: Record<string, string>): string[] {
  return Object.entries(fields).flatMap(([field, value]) => [field, value]);
}

function unknownEconomics(reason: string): SponsorResultEconomics {
  return { economicsStatus: 'unknown', failureReason: reason };
}

function preparedDiscardResult(entry: PreparedTxEntry, reason: string): SponsorResultMetadata {
  return {
    sponsorAddress: entry.sponsorAddress,
    outcome: 'validation_failure',
    executionStage: 'before_sponsor_signature',
    route: entry.mode,
    receiptId: entry.receiptId,
    senderAddress: entry.senderAddress,
    executionPathKey: entry.executionPathKey,
    orderIdHash: entry.mode === 'generic' ? sponsoredExecutionOrderIdHash(entry.orderId) : null,
    promotionId: entry.mode === 'promotion' ? entry.promotionId : null,
    userId: entry.mode === 'promotion' ? entry.userId : null,
    economics: unknownEconomics(reason),
  };
}

interface PromotionFinalExpectation {
  readonly promotionId: string;
  readonly userId: string;
  readonly operation: 'consume' | 'release';
  readonly amountMist: string;
  readonly reservationStage: 'prepared' | 'executing';
}

export class RedisSponsoredExecutionStore implements SponsoredExecutionStoreAdapter {
  private readonly prefix: string;
  private readonly prepareTtlMs: number;
  private readonly maxPerIp: number;
  private readonly maxPerStudioUser: number;
  private readonly maxOutstandingPerSender: number;

  constructor(
    private readonly redis: RedisClientLike,
    private readonly sponsorPool: SponsorPoolRecordAdapter,
    private readonly promotionLedger: PromotionReceiptTransitionAccess | undefined,
    options: RedisSponsoredExecutionStoreOptions = {},
  ) {
    this.prefix = options.keyPrefix ?? SPONSORED_EXECUTION_REDIS_KEY_PREFIX;
    this.prepareTtlMs = safePositiveInteger(options.prepareTtlMs ?? PREPARE_TTL_MS, 'prepareTtlMs');
    this.maxPerIp = safePositiveInteger(
      options.maxPerIp ?? MAX_CONCURRENT_PREPARED_PER_IP,
      'maxPerIp',
    );
    this.maxPerStudioUser = safePositiveInteger(
      options.maxPerStudioUser ?? MAX_OUTSTANDING_PREPARED_PER_STUDIO_USER,
      'maxPerStudioUser',
    );
    this.maxOutstandingPerSender = safePositiveInteger(
      options.maxOutstandingPerSender ?? MAX_OUTSTANDING_PREPARED_PER_SENDER,
      'maxOutstandingPerSender',
    );
  }

  private preparedKey(receiptId: string): string {
    return `${this.prefix}prepared:${receiptId}`;
  }
  private executionKey(receiptId: string): string {
    return `${this.prefix}executing:${receiptId}`;
  }
  private finalKey(receiptId: string): string {
    return `${this.prefix}final:${receiptId}`;
  }
  private nonceKey(receiptId: string): string {
    return `${this.prefix}nonce:${receiptId}`;
  }
  private ipKey(clientIp: string): string {
    return `${this.prefix}prepared:ip:${clientIp}`;
  }
  private senderKey(sender: string): string {
    return `${this.prefix}prepared:sender:${sender}`;
  }
  private userKey(userId: string): string {
    return `${this.prefix}prepared:user:${userId}`;
  }
  private preparedDeadlineKey(): string {
    return `${this.prefix}prepared:deadlines`;
  }
  private executionDeadlineKey(): string {
    return `${this.prefix}executing:deadlines`;
  }
  private pendingCallbackKey(): string {
    return `${this.prefix}callback:pending`;
  }
  private unusedKey(label: string): string {
    return `${this.prefix}unused:${label}`;
  }

  private async nowMs(): Promise<number> {
    return redisInteger(await this.redis.eval(REDIS_TIME_MS_SCRIPT, [], []), 'Redis TIME');
  }

  private requirePromotionLedger(): PromotionReceiptTransitionAccess {
    if (!this.promotionLedger) throw new Error('Promotion receipt transition access is required');
    return this.promotionLedger;
  }

  private async validateExistingFinal(
    raw: string,
    receiptId: string,
    expectedTransactionDigest: string | null,
    result: SponsorResultMetadata,
    promotion: PromotionFinalExpectation | null,
  ): Promise<FinalSponsoredExecutionRecord | null> {
    const record = this.parseFinal(raw, receiptId);
    if (
      record.transactionDigest !== expectedTransactionDigest ||
      !storedSponsorResultMatchesMetadata(record.result, result)
    ) {
      return null;
    }
    if (promotion === null) return record;
    const prepared = await this.requirePromotionLedger().prepareFinalization({
      receiptId,
      operation: promotion.operation,
      chargedMist: promotion.operation === 'consume' ? BigInt(promotion.amountMist) : 0n,
      usedAtMs: await this.nowMs(),
      reservationStage: promotion.reservationStage,
    });
    if (prepared.status !== 'already_final') {
      throw new SponsoredExecutionRecordCorruptionError(
        'Final sponsored receipt is missing its Promotion operation result',
      );
    }
    return promotionOperationResultMatchesExpectation(prepared.result, {
      receiptId,
      promotionId: promotion.promotionId,
      userId: promotion.userId,
      operation: promotion.operation,
      amountMist: promotion.amountMist,
    })
      ? record
      : null;
  }

  async commitPreparedReceipt(draftValue: PreparedTxDraft): Promise<PreparedTxEntry> {
    const draft = parseCurrentPreparedTxDraft(draftValue);
    for (let attempt = 0; attempt < 2; attempt++) {
      const nowMs = await this.nowMs();
      const deadlineMs = safeDeadline(nowMs, this.prepareTtlMs, 'Prepared receipt deadline');
      const entry = decodePreparedTxEntry(
        serializePreparedTxEntry({ ...draft, issuedAt: nowMs }),
        draft.receiptId,
      );
      const entryRaw = serializePreparedTxEntry(entry);
      const promotionCommit =
        entry.mode === 'promotion'
          ? await this.requirePromotionLedger().preparePreparedReceiptCommit({
              receiptId: entry.receiptId,
              promotionId: entry.promotionId,
              userId: entry.userId,
            })
          : null;
      if (promotionCommit !== null && promotionCommit.status !== 'ready') {
        throw new Error(
          `Promotion reservation cannot commit prepared receipt: ${promotionCommit.status}`,
        );
      }
      const promotionPlan = promotionCommit?.status === 'ready' ? promotionCommit.plan : null;
      const lease = await this.sponsorPool.readSponsorLeaseRecord(draft.sponsorAddress);
      if (!lease) throw new Error('Reserved sponsor lease is missing');
      const leaseTransition = this.sponsorPool.prepareCommittedSponsorLeaseRecord(
        lease,
        draft.receiptId,
        draft.txBytesHash,
        deadlineMs,
      );
      const userKey =
        draft.mode === 'promotion' ? this.userKey(draft.userId) : this.unusedKey('user');
      let result: string;
      try {
        result = scriptTag(
          await this.redis.eval(
            COMMIT_PREPARED_SCRIPT,
            [
              this.preparedKey(draft.receiptId),
              this.executionKey(draft.receiptId),
              this.finalKey(draft.receiptId),
              leaseTransition.key,
              this.preparedDeadlineKey(),
              this.ipKey(draft.clientIp),
              this.senderKey(draft.senderAddress),
              userKey,
              draft.mode === 'generic' ? this.nonceKey(draft.receiptId) : this.unusedKey('nonce'),
              promotionPlan?.keys.promotion ?? this.unusedKey('promotion'),
              promotionPlan?.keys.reservation ?? this.unusedKey('promotion-reservation'),
              promotionPlan?.keys.result ?? this.unusedKey('promotion-result'),
              promotionPlan?.keys.reservationDeadlineIndex ?? this.unusedKey('promotion-deadline'),
            ],
            [
              leaseTransition.expectedRaw,
              leaseTransition.nextRaw,
              entryRaw,
              draft.receiptId,
              String(deadlineMs),
              String(this.maxPerIp),
              String(this.maxOutstandingPerSender),
              draft.mode,
              draft.mode === 'generic' ? draft.nonce.toString() : '',
              String(this.maxPerStudioUser),
              String(nowMs),
              promotionPlan ? '1' : '0',
              promotionPlan?.promotionRaw ?? '',
              promotionPlan?.expectedReservationRaw ?? '',
              promotionPlan ? String(promotionPlan.expectedDeadlineMs) : '',
            ],
          ),
          'commit prepared receipt',
        );
      } catch (commitError) {
        let committedRaw: string | null;
        try {
          committedRaw = await this.redis.get(this.preparedKey(draft.receiptId));
        } catch (readError) {
          throw new AggregateError(
            [commitError, readError],
            'Prepared receipt commit outcome and exact durable state are both unavailable',
          );
        }
        if (committedRaw === null) throw commitError;
        if (committedRaw !== entryRaw) {
          throw new SponsoredExecutionRecordCorruptionError(
            'Prepared receipt commit response was uncertain and the durable receipt differs from the attempted record',
          );
        }
        return entry;
      }
      if (result === 'OK') return entry;
      if (result === 'USER_LIMIT')
        throw new PrepareStudioUserQuotaError(
          draft.mode === 'promotion' ? draft.userId : draft.senderAddress,
          this.maxPerStudioUser,
        );
      if (result === 'SENDER_LIMIT')
        throw new PrepareSenderQuotaError(draft.senderAddress, this.maxOutstandingPerSender);
      if (result === 'IP_LIMIT' && attempt === 0) {
        const oldest = await this.readOldestPreparedForIp(draft.clientIp);
        if (oldest) {
          await this.discardPreparedReceipt({
            expected: oldest,
            result: preparedDiscardResult(
              oldest,
              'Replaced by a newer prepared transaction from the same client IP',
            ),
          });
          continue;
        }
      }
      if (result === 'IP_LIMIT') throw new PrepareOverloadError(this.maxPerIp, this.maxPerIp);
      if (result === 'CORRUPT_INDEX') {
        throw new SponsoredExecutionRecordCorruptionError(
          'Prepared receipt deadline index has the wrong Redis type',
        );
      }
      throw new Error(`Prepared receipt commit failed: ${result}`);
    }
    throw new Error('Prepared receipt commit exhausted its bounded retry');
  }

  private async readOldestPreparedForIp(clientIp: string): Promise<PreparedTxEntry | null> {
    const raw = await this.redis.eval(
      `local ids = redis.call('ZRANGE', KEYS[1], 0, 0); if #ids == 0 then return {} end; return {ids[1], redis.call('GET', ARGV[1] .. ids[1]) or ''}`,
      [this.ipKey(clientIp)],
      [`${this.prefix}prepared:`],
    );
    if (!Array.isArray(raw) || raw.length === 0) return null;
    if (
      raw.length !== 2 ||
      typeof raw[0] !== 'string' ||
      typeof raw[1] !== 'string' ||
      raw[1] === ''
    ) {
      throw new Error('Prepared IP index points to a missing record');
    }
    return decodePreparedTxEntry(raw[1], raw[0]);
  }

  async readPreparedReceipt(receiptId: string): Promise<PreparedTxEntry | null> {
    const raw = await this.redis.get(this.preparedKey(receiptId));
    return raw === null ? null : decodePreparedTxEntry(raw, receiptId);
  }

  async beginSponsoredExecution(
    input: BeginSponsoredExecutionInput,
  ): Promise<BeginSponsoredExecutionResult> {
    const raw = await this.redis.get(this.preparedKey(input.receiptId));
    if (raw === null) return { status: 'not_found' };
    const prepared = decodePreparedTxEntry(raw, input.receiptId);
    if (prepared.mode !== input.expectedMode)
      return { status: 'mode_mismatch', actualMode: prepared.mode };
    assertRecoveryMatchesPreparedReceipt(prepared, input.recovery);
    const txBytesHash = createHash('sha256').update(input.txBytes).digest('hex');
    if (txBytesHash !== prepared.txBytesHash) return { status: 'hash_mismatch' };
    const transactionDigest = TransactionDataBuilder.getDigestFromBytes(input.txBytes);
    const preparedDeadlineMs = safeDeadline(
      prepared.issuedAt,
      this.prepareTtlMs,
      'Prepared receipt deadline',
    );
    const executionBudgetMs = safePositiveInteger(input.executionBudgetMs, 'Execution budget');
    const lease = await this.sponsorPool.readSponsorLeaseRecord(prepared.sponsorAddress);
    if (!lease) return { status: 'state_changed' };
    const leaseTransition = this.sponsorPool.prepareExecutingSponsorLeaseRecord(
      lease,
      prepared.receiptId,
      prepared.txBytesHash,
      transactionDigest,
    );
    const executionParts = createExecutingSponsoredExecutionRecordParts({
      state: 'executing',
      receiptId: prepared.receiptId,
      sponsorAddress: prepared.sponsorAddress,
      txBytesHash: prepared.txBytesHash,
      transactionDigest,
      recovery: input.recovery,
    });
    let promotionPlan: Awaited<
      ReturnType<PromotionReceiptTransitionAccess['prepareExecutionStart']>
    > | null = null;
    if (prepared.mode === 'promotion') {
      promotionPlan = await this.requirePromotionLedger().prepareExecutionStart({
        receiptId: prepared.receiptId,
        promotionId: prepared.promotionId,
        userId: prepared.userId,
      });
      if (promotionPlan.status !== 'ready') return { status: promotionPlan.status };
    }
    const plan = promotionPlan?.status === 'ready' ? promotionPlan.plan : null;
    const result = scriptTriple(
      await this.redis.eval(
        BEGIN_EXECUTION_SCRIPT,
        [
          this.preparedKey(prepared.receiptId),
          leaseTransition.key,
          this.executionKey(prepared.receiptId),
          this.finalKey(prepared.receiptId),
          this.preparedDeadlineKey(),
          this.ipKey(prepared.clientIp),
          this.senderKey(prepared.senderAddress),
          prepared.mode === 'promotion' ? this.userKey(prepared.userId) : this.unusedKey('user'),
          prepared.mode === 'generic' ? this.nonceKey(prepared.receiptId) : this.unusedKey('nonce'),
          plan?.keys.promotion ?? this.unusedKey('promotion'),
          plan?.keys.reservation ?? this.unusedKey('promotion-reservation'),
          plan?.keys.result ?? this.unusedKey('promotion-result'),
          plan?.keys.reservationDeadlineIndex ?? this.unusedKey('promotion-deadline'),
          this.executionDeadlineKey(),
        ],
        [
          raw,
          leaseTransition.expectedRaw,
          prepared.receiptId,
          String(preparedDeadlineMs),
          executionParts.prefix,
          executionParts.suffix,
          String(executionBudgetMs),
          plan ? '1' : '0',
          plan?.promotionRaw ?? '',
          plan?.expectedReservationRaw ?? '',
          plan ? String(plan.expectedDeadlineMs) : '',
          leaseTransition.nextRawPrefix,
          leaseTransition.nextRawSuffix,
          plan?.nextReservationParts.prefix ?? '',
          plan?.nextReservationParts.suffix ?? '',
          prepared.mode,
          String(prepared.issuedAt),
          prepared.mode === 'generic' ? prepared.nonce.toString() : '',
        ],
      ),
      'begin sponsored execution',
    );
    if (result[0] === 'EXPIRED') return { status: 'expired' };
    if (result[0] === 'CORRUPT_INDEX' || result[0] === 'INVALID_DEADLINE') {
      throw new SponsoredExecutionRecordCorruptionError(
        `Begin sponsored execution failed: ${result[0]}`,
      );
    }
    if (result[0] !== 'OK') return { status: 'state_changed' };
    const executionDeadlineMs = redisInteger(result[1], 'Execution deadline');
    const materialized = materializeExecutingSponsoredExecutionRecord(
      executionParts,
      executionDeadlineMs,
    );
    if (materialized.raw !== result[2]) {
      throw new SponsoredExecutionRecordCorruptionError(
        'Redis returned non-canonical executing sponsored receipt bytes',
      );
    }
    const execution = materialized.record;
    return { status: 'executing', prepared, execution };
  }

  async discardPreparedReceipt(
    input: DiscardPreparedReceiptInput,
  ): Promise<DiscardPreparedReceiptResult> {
    const expected = decodePreparedTxEntry(
      serializePreparedTxEntry(input.expected),
      input.expected.receiptId,
    );
    assertPreparedResultMatchesReceipt(expected, input.result);
    const expectedRaw = serializePreparedTxEntry(expected);
    const promotionExpectation: PromotionFinalExpectation | null =
      expected.mode === 'promotion'
        ? {
            promotionId: expected.promotionId,
            userId: expected.userId,
            operation: 'release',
            amountMist: expected.reservedGasMist.toString(),
            reservationStage: 'prepared',
          }
        : null;
    const existingRaw = await this.redis.get(this.finalKey(expected.receiptId));
    if (existingRaw !== null) {
      const existing = await this.validateExistingFinal(
        existingRaw,
        expected.receiptId,
        null,
        input.result,
        promotionExpectation,
      );
      return existing === null
        ? { status: 'state_changed' }
        : { status: 'already_final', record: existing };
    }
    const nowMs = await this.nowMs();
    const lease = await this.sponsorPool.readSponsorLeaseRecord(expected.sponsorAddress);
    if (!lease) {
      const concurrentRaw = await this.redis.get(this.finalKey(expected.receiptId));
      if (concurrentRaw === null) return { status: 'state_changed' };
      const concurrent = await this.validateExistingFinal(
        concurrentRaw,
        expected.receiptId,
        null,
        input.result,
        promotionExpectation,
      );
      return concurrent === null
        ? { status: 'state_changed' }
        : { status: 'already_final', record: concurrent };
    }
    const leaseRemoval = this.sponsorPool.prepareSponsorLeaseRecordRemoval(lease, {
      stage: 'committed',
      receiptId: expected.receiptId,
      txBytesHash: expected.txBytesHash,
    });
    let promotionPlan: PromotionFinalizationPlan | null = null;
    if (expected.mode === 'promotion') {
      const prepared = await this.requirePromotionLedger().prepareFinalization({
        receiptId: expected.receiptId,
        operation: 'release',
        chargedMist: 0n,
        usedAtMs: nowMs,
        reservationStage: 'prepared',
      });
      if (prepared.status === 'already_final') {
        const concurrentRaw = await this.redis.get(this.finalKey(expected.receiptId));
        if (concurrentRaw === null) {
          throw new SponsoredExecutionRecordCorruptionError(
            'Promotion operation result exists without a final sponsored receipt',
          );
        }
        const concurrent = await this.validateExistingFinal(
          concurrentRaw,
          expected.receiptId,
          null,
          input.result,
          promotionExpectation,
        );
        return concurrent === null
          ? { status: 'state_changed' }
          : { status: 'already_final', record: concurrent };
      }
      if (prepared.status !== 'ready') return { status: 'state_changed' };
      promotionPlan = prepared.plan;
    }
    const finalRecord: FinalSponsoredExecutionRecord = {
      state: 'final',
      receiptId: expected.receiptId,
      sponsorAddress: expected.sponsorAddress,
      transactionDigest: null,
      finalizedAtMs: nowMs,
      callbackDelivery: 'pending',
      result: storeSponsorResult(input.result),
    };
    const accounting = promotionPlan
      ? serializePromotionAccountingRecord(promotionPlan.expectedAccounting)
      : {};
    const entitlement = promotionPlan
      ? serializePromotionEntitlementRecord(promotionPlan.expectedEntitlement)
      : {};
    const nextAccounting = promotionPlan
      ? serializePromotionAccountingRecord(promotionPlan.nextAccounting)
      : {};
    const nextEntitlement = promotionPlan
      ? serializePromotionEntitlementRecord(promotionPlan.nextEntitlement)
      : {};
    const result = scriptPair(
      await this.redis.eval(
        DISCARD_PREPARED_SCRIPT,
        [
          this.preparedKey(expected.receiptId),
          leaseRemoval.key,
          this.finalKey(expected.receiptId),
          this.preparedDeadlineKey(),
          this.ipKey(expected.clientIp),
          this.senderKey(expected.senderAddress),
          expected.mode === 'promotion' ? this.userKey(expected.userId) : this.unusedKey('user'),
          this.nonceKey(expected.receiptId),
          this.pendingCallbackKey(),
          promotionPlan?.keys.reservation ?? this.unusedKey('promotion-reservation'),
          promotionPlan?.keys.result ?? this.unusedKey('promotion-result'),
          promotionPlan?.keys.reservationDeadlineIndex ?? this.unusedKey('promotion-deadline'),
          promotionPlan?.keys.accounting ?? this.unusedKey('promotion-accounting'),
          promotionPlan?.keys.entitlement ?? this.unusedKey('promotion-entitlement'),
        ],
        [
          expectedRaw,
          leaseRemoval.expectedRaw,
          expected.receiptId,
          String(safeDeadline(expected.issuedAt, this.prepareTtlMs, 'Prepared receipt deadline')),
          serializeSponsoredExecutionRecord(finalRecord),
          String(nowMs),
          promotionPlan ? '1' : '0',
          promotionPlan?.expectedReservationRaw ?? '',
          promotionPlan?.expectedDeadlineMs === null || promotionPlan === null
            ? ''
            : String(promotionPlan.expectedDeadlineMs),
          String(Object.keys(accounting).length),
          String(Object.keys(entitlement).length),
          promotionPlan?.resultRaw ?? '',
          expected.mode,
          String(expected.issuedAt),
          expected.mode === 'generic' ? expected.nonce.toString() : '',
          ...hashArguments(accounting),
          ...hashArguments(entitlement),
          ...hashArguments(nextAccounting),
          ...hashArguments(nextEntitlement),
        ],
      ),
      'discard prepared receipt',
    );
    if (result[0] === 'FINAL') {
      const concurrent = await this.validateExistingFinal(
        result[1],
        expected.receiptId,
        null,
        input.result,
        promotionExpectation,
      );
      return concurrent === null
        ? { status: 'state_changed' }
        : { status: 'already_final', record: concurrent };
    }
    if (result[0] === 'CORRUPT_INDEX') {
      throw new SponsoredExecutionRecordCorruptionError(
        'Pending callback index has the wrong Redis type',
      );
    }
    if (result[0] !== 'APPLIED') return { status: 'state_changed' };
    return { status: 'discarded', record: this.parseFinal(result[1], expected.receiptId) };
  }

  async finalizeSponsoredExecution(
    input: FinalizeSponsoredExecutionInput,
  ): Promise<FinalizeSponsoredExecutionResult> {
    assertFinalResultMatchesExecution(input.expected, input.result, input.promotion);
    if (
      input.result.digest !== undefined &&
      input.result.digest !== input.expected.transactionDigest
    ) {
      throw new Error('Sponsor result digest does not match the executing transaction digest');
    }
    const expectedRaw = serializeSponsoredExecutionRecord(input.expected);
    const recovery = input.expected.recovery;
    const promotionExpectation: PromotionFinalExpectation | null =
      input.promotion.operation === 'none'
        ? null
        : recovery.route === 'promotion'
          ? {
              promotionId: recovery.promotionId,
              userId: recovery.userId,
              operation: input.promotion.operation,
              amountMist:
                input.promotion.operation === 'consume'
                  ? input.promotion.chargedMist.toString()
                  : recovery.reservedGasMist,
              reservationStage: 'executing',
            }
          : (() => {
              throw new SponsoredExecutionRecordCorruptionError(
                'Promotion finalization does not match the execution recovery route',
              );
            })();
    const existingRaw = await this.redis.get(this.finalKey(input.expected.receiptId));
    if (existingRaw !== null) {
      const existing = await this.validateExistingFinal(
        existingRaw,
        input.expected.receiptId,
        input.expected.transactionDigest,
        input.result,
        promotionExpectation,
      );
      return existing === null
        ? { status: 'state_changed' }
        : { status: 'already_final', record: existing };
    }
    const nowMs = await this.nowMs();
    const lease = await this.sponsorPool.readSponsorLeaseRecord(input.expected.sponsorAddress);
    if (!lease) {
      const concurrentRaw = await this.redis.get(this.finalKey(input.expected.receiptId));
      if (concurrentRaw === null) return { status: 'state_changed' };
      const concurrent = await this.validateExistingFinal(
        concurrentRaw,
        input.expected.receiptId,
        input.expected.transactionDigest,
        input.result,
        promotionExpectation,
      );
      return concurrent === null
        ? { status: 'state_changed' }
        : { status: 'already_final', record: concurrent };
    }
    const leaseRemoval = this.sponsorPool.prepareSponsorLeaseRecordRemoval(lease, {
      stage: 'executing',
      receiptId: input.expected.receiptId,
      txBytesHash: input.expected.txBytesHash,
      transactionDigest: input.expected.transactionDigest,
    });
    let promotionPlan: PromotionFinalizationPlan | null = null;
    if (input.promotion.operation !== 'none') {
      const prepared = await this.requirePromotionLedger().prepareFinalization({
        receiptId: input.expected.receiptId,
        operation: input.promotion.operation,
        chargedMist: input.promotion.operation === 'consume' ? input.promotion.chargedMist : 0n,
        usedAtMs: nowMs,
        reservationStage: 'executing',
      });
      if (prepared.status === 'already_final') {
        const concurrentRaw = await this.redis.get(this.finalKey(input.expected.receiptId));
        if (concurrentRaw === null) {
          throw new SponsoredExecutionRecordCorruptionError(
            'Promotion operation result exists without a final sponsored receipt',
          );
        }
        const concurrent = await this.validateExistingFinal(
          concurrentRaw,
          input.expected.receiptId,
          input.expected.transactionDigest,
          input.result,
          promotionExpectation,
        );
        return concurrent === null
          ? { status: 'state_changed' }
          : { status: 'already_final', record: concurrent };
      }
      if (prepared.status !== 'ready') return { status: 'state_changed' };
      promotionPlan = prepared.plan;
    }
    const finalRecord: FinalSponsoredExecutionRecord = {
      state: 'final',
      receiptId: input.expected.receiptId,
      sponsorAddress: input.expected.sponsorAddress,
      transactionDigest: input.expected.transactionDigest,
      finalizedAtMs: nowMs,
      callbackDelivery: 'pending',
      result: storeSponsorResult(input.result),
    };
    const accounting = promotionPlan
      ? serializePromotionAccountingRecord(promotionPlan.expectedAccounting)
      : {};
    const entitlement = promotionPlan
      ? serializePromotionEntitlementRecord(promotionPlan.expectedEntitlement)
      : {};
    const nextAccounting = promotionPlan
      ? serializePromotionAccountingRecord(promotionPlan.nextAccounting)
      : {};
    const nextEntitlement = promotionPlan
      ? serializePromotionEntitlementRecord(promotionPlan.nextEntitlement)
      : {};
    const result = scriptPair(
      await this.redis.eval(
        FINALIZE_EXECUTION_SCRIPT,
        [
          this.executionKey(input.expected.receiptId),
          this.finalKey(input.expected.receiptId),
          leaseRemoval.key,
          this.executionDeadlineKey(),
          this.pendingCallbackKey(),
          promotionPlan?.keys.reservation ?? this.unusedKey('promotion-reservation'),
          promotionPlan?.keys.result ?? this.unusedKey('promotion-result'),
          promotionPlan?.keys.reservationDeadlineIndex ?? this.unusedKey('promotion-deadline'),
          promotionPlan?.keys.accounting ?? this.unusedKey('promotion-accounting'),
          promotionPlan?.keys.entitlement ?? this.unusedKey('promotion-entitlement'),
        ],
        [
          expectedRaw,
          leaseRemoval.expectedRaw,
          input.expected.receiptId,
          String(input.expected.deadlineMs),
          serializeSponsoredExecutionRecord(finalRecord),
          String(nowMs),
          promotionPlan ? '1' : '0',
          promotionPlan?.expectedReservationRaw ?? '',
          '',
          String(Object.keys(accounting).length),
          String(Object.keys(entitlement).length),
          promotionPlan?.resultRaw ?? '',
          ...hashArguments(accounting),
          ...hashArguments(entitlement),
          ...hashArguments(nextAccounting),
          ...hashArguments(nextEntitlement),
        ],
      ),
      'finalize sponsored execution',
    );
    if (result[0] === 'FINAL') {
      const concurrent = await this.validateExistingFinal(
        result[1],
        input.expected.receiptId,
        input.expected.transactionDigest,
        input.result,
        promotionExpectation,
      );
      return concurrent === null
        ? { status: 'state_changed' }
        : { status: 'already_final', record: concurrent };
    }
    if (result[0] === 'CORRUPT_INDEX') {
      throw new SponsoredExecutionRecordCorruptionError(
        'Pending callback index has the wrong Redis type',
      );
    }
    if (result[0] !== 'APPLIED') return { status: 'state_changed' };
    return { status: 'finalized', record: this.parseFinal(result[1], input.expected.receiptId) };
  }

  private parseFinal(raw: string, receiptId: string): FinalSponsoredExecutionRecord {
    const record = decodeSponsoredExecutionRecord(raw);
    if (record.state !== 'final' || record.receiptId !== receiptId)
      throw new Error('Stored final sponsored execution record has the wrong identity');
    return record;
  }

  private async readRecoveryPage(
    indexKey: string,
    recordPrefix: string,
    limit: number,
    cursor: SponsoredExecutionRecoveryCursor | null,
  ): Promise<{
    readonly rows: readonly [receiptId: string, scoreMs: number, raw: string][];
    readonly nextCursor: SponsoredExecutionRecoveryCursor | null;
  }> {
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > SPONSORED_EXECUTION_RECOVERY_BATCH_SIZE
    ) {
      throw new Error(
        `Recovery read limit must be between 1 and ${SPONSORED_EXECUTION_RECOVERY_BATCH_SIZE}`,
      );
    }
    if (
      cursor !== null &&
      (!Number.isSafeInteger(cursor.throughMs) ||
        cursor.throughMs <= 0 ||
        !Number.isSafeInteger(cursor.scoreMs) ||
        cursor.scoreMs <= 0 ||
        cursor.scoreMs > cursor.throughMs ||
        cursor.receiptId.length === 0 ||
        cursor.receiptId.includes('\0'))
    ) {
      throw new Error('Recovery cursor is invalid');
    }
    const raw = await this.redis.eval(
      READ_RECOVERY_PAGE_SCRIPT,
      [indexKey],
      [
        recordPrefix,
        String(limit),
        cursor === null ? '' : String(cursor.throughMs),
        cursor === null ? '' : String(cursor.scoreMs),
        cursor?.receiptId ?? '',
      ],
    );
    if (Array.isArray(raw) && raw.length === 1 && raw[0] === 'INVALID_CURSOR') {
      throw new Error('Recovery cursor was rejected by Redis');
    }
    if (Array.isArray(raw) && raw.length === 1 && raw[0] === 'ANCHOR_CONFLICT') {
      throw new SponsoredExecutionRecordCorruptionError(
        'Recovery index contains the reserved cursor anchor member',
      );
    }
    if (
      !Array.isArray(raw) ||
      raw.length < 3 ||
      raw[0] !== 'OK' ||
      typeof raw[1] !== 'string' ||
      typeof raw[2] !== 'string'
    )
      throw new Error('Recovery index read returned an invalid result');
    const throughMs = redisInteger(raw[1], 'Recovery page through time');
    const count = redisInteger(raw[2], 'Recovery record count');
    if (
      throughMs <= 0 ||
      count > limit ||
      raw.length !== 3 + count * 3 ||
      (cursor !== null && throughMs !== cursor.throughMs)
    )
      throw new Error('Recovery index read returned an invalid record count');
    const rows: [string, number, string][] = [];
    let previous = cursor;
    for (let i = 0; i < count; i++) {
      const offset = 3 + i * 3;
      const id = raw[offset];
      const scoreRaw = raw[offset + 1];
      const record = raw[offset + 2];
      if (
        typeof id !== 'string' ||
        id.length === 0 ||
        id.includes('\0') ||
        typeof scoreRaw !== 'string' ||
        typeof record !== 'string' ||
        record === ''
      )
        throw new Error('Recovery index points to a missing record');
      const scoreMs = redisInteger(scoreRaw, 'Recovery record score');
      if (
        scoreMs <= 0 ||
        scoreMs > throughMs ||
        (previous !== null &&
          (scoreMs < previous.scoreMs ||
            (scoreMs === previous.scoreMs && id <= previous.receiptId)))
      ) {
        throw new Error('Recovery index page is not in exclusive stable order');
      }
      rows.push([id, scoreMs, record]);
      previous = { throughMs, scoreMs, receiptId: id };
    }
    const last = rows.at(-1);
    return {
      rows,
      nextCursor:
        rows.length === limit && last ? { throughMs, scoreMs: last[1], receiptId: last[0] } : null,
    };
  }

  async readExpiredPreparedReceipts(
    limit: number,
    cursor: SponsoredExecutionRecoveryCursor | null,
  ): Promise<SponsoredExecutionRecoveryPage<PreparedTxEntry>> {
    const page = await this.readRecoveryPage(
      this.preparedDeadlineKey(),
      `${this.prefix}prepared:`,
      limit,
      cursor,
    );
    const records = page.rows.map(([receiptId, scoreMs, raw]) => {
      const entry = decodePreparedTxEntry(raw, receiptId);
      if (safeDeadline(entry.issuedAt, this.prepareTtlMs, 'Prepared receipt deadline') !== scoreMs)
        throw new Error('Prepared receipt deadline index is inconsistent');
      return entry;
    });
    return { records, nextCursor: page.nextCursor };
  }

  async readDueExecutions(
    limit: number,
    cursor: SponsoredExecutionRecoveryCursor | null,
  ): Promise<SponsoredExecutionRecoveryPage<ExecutingSponsoredExecutionRecord>> {
    const page = await this.readRecoveryPage(
      this.executionDeadlineKey(),
      `${this.prefix}executing:`,
      limit,
      cursor,
    );
    const records = page.rows.map(([receiptId, scoreMs, raw]) => {
      const record = decodeSponsoredExecutionRecord(raw);
      if (
        record.state !== 'executing' ||
        record.receiptId !== receiptId ||
        record.deadlineMs !== scoreMs
      )
        throw new Error('Executing receipt deadline index is inconsistent');
      return record;
    });
    return { records, nextCursor: page.nextCursor };
  }

  async readPendingCallbacks(
    limit: number,
    cursor: SponsoredExecutionRecoveryCursor | null,
  ): Promise<SponsoredExecutionRecoveryPage<FinalSponsoredExecutionRecord>> {
    const page = await this.readRecoveryPage(
      this.pendingCallbackKey(),
      `${this.prefix}final:`,
      limit,
      cursor,
    );
    const records = page.rows.map(([receiptId, scoreMs, recordRaw]) => {
      const record = this.parseFinal(recordRaw, receiptId);
      if (record.callbackDelivery !== 'pending' || record.finalizedAtMs !== scoreMs)
        throw new Error('Pending callback index is inconsistent');
      return record;
    });
    return { records, nextCursor: page.nextCursor };
  }

  async markCallbackDelivered(expected: FinalSponsoredExecutionRecord): Promise<boolean> {
    if (expected.callbackDelivery !== 'pending') return false;
    const next: FinalSponsoredExecutionRecord = { ...expected, callbackDelivery: 'delivered' };
    const result = await this.redis.eval(
      MARK_CALLBACK_DELIVERED_SCRIPT,
      [this.finalKey(expected.receiptId), this.pendingCallbackKey()],
      [
        serializeSponsoredExecutionRecord(expected),
        serializeSponsoredExecutionRecord(next),
        expected.receiptId,
        String(expected.finalizedAtMs),
      ],
    );
    return result === 1 || result === '1';
  }

  async checkUserQuota(userId: string): Promise<'ok' | { exceeded: true; limit: number }> {
    const live = redisInteger(
      await this.redis.eval(
        CHECK_USER_QUOTA_SCRIPT,
        [this.userKey(userId)],
        [`${this.prefix}prepared:`],
      ),
      'Studio user prepared receipt count',
    );
    return live >= this.maxPerStudioUser ? { exceeded: true, limit: this.maxPerStudioUser } : 'ok';
  }

  async reserveNonce(
    senderAddress: string,
    onchainLastNonce: bigint,
    receiptId: string,
  ): Promise<bigint> {
    if (onchainLastNonce < 0n || onchainLastNonce > U64_MAX) {
      throw new Error('On-chain nonce must be a u64 value');
    }
    const result = await this.redis.eval(
      RESERVE_NONCE_SCRIPT,
      [this.senderKey(senderAddress), this.nonceKey(receiptId)],
      [
        onchainLastNonce.toString(),
        String(this.maxOutstandingPerSender),
        String(this.prepareTtlMs),
        `${this.prefix}nonce:`,
        `${this.prefix}prepared:`,
        receiptId,
        U64_MAX_DECIMAL,
      ],
    );
    const [tag, nonce] = scriptPair(result, 'reserve nonce');
    if (tag === 'LIMIT')
      throw new PrepareSenderQuotaError(senderAddress, this.maxOutstandingPerSender);
    if (tag === 'EXHAUSTED') throw new Error('No u64 nonce remains for this sender');
    if (tag !== 'OK' || !/^(?:0|[1-9]\d*)$/.test(nonce))
      throw new Error('Nonce reservation returned an invalid result');
    const parsed = BigInt(nonce);
    if (parsed > U64_MAX) throw new Error('Nonce reservation exceeds u64');
    return parsed;
  }

  async releaseNonceReservation(receiptId: string, senderAddress: string): Promise<void> {
    await this.redis.eval(
      RELEASE_NONCE_SCRIPT,
      [this.senderKey(senderAddress), this.nonceKey(receiptId), this.preparedKey(receiptId)],
      [receiptId],
    );
  }

  async dispose(): Promise<void> {}

  /** Metadata exposed only to the recovery task after strict record decoding. */
  static callbackMetadata(record: FinalSponsoredExecutionRecord): SponsorResultMetadata {
    return sponsorResultMetadata(record.result);
  }
}
