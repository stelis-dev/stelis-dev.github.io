/**
 * Redis adapter for sponsored execution log + aggregate.
 *
 * All writes go through a single Lua script so that:
 *   - exact-replay / conflicting-result check by receipt (no TTL),
 *   - per-mode + all-mode aggregate updates on exact decimal strings,
 *   - recent-list append + cap
 * are atomic per emit. This mirrors `RedisPromotionExecutionLedger`'s
 * Lua-atomic money update pattern.
 *
 * Reads also go through `eval`, so this adapter only depends on
 * `RedisClientLike.eval`.
 *
 * Key layout:
 *   stelis:sponsored_logs:agg:{all|generic|promotion}     HASH
 *     fields: sponsoredExecutions, cumulativeHostNetMist,
 *             cumulativeLossMist, lossCount   (exact decimal string)
 *   stelis:sponsored_logs:recent                           LIST
 *     most recently accepted entries first, capped.
 *   stelis:sponsored_logs:idem:{receiptId}                 STRING fingerprint (no TTL)
 *
 * Replay contract: the receipt key stores the accepted result fingerprint
 * with no TTL so the lifetime aggregate stays honest across restarts. The
 * adapter never expires or clears these keys; clearing them while retaining
 * the aggregate would remove its replay proof.
 *
 * Aggregate arithmetic is implemented on decimal strings in Lua. MIST values
 * and lifetime totals never pass through Lua numbers or Redis's signed-int64
 * `HINCRBY` boundary.
 */

import type { RedisClientLike } from '@stelis/core-api';
import type {
  SponsoredExecutionAggregate,
  SponsoredExecutionAggregateMode,
  SponsoredExecutionLogEntry,
} from './types.js';
import {
  parseStoredSponsoredExecutionLogEntry,
  parseSignedDecimalString,
  parseSponsoredExecutionLogEntry,
  parseUnsignedDecimalString,
  serializeSponsoredExecutionLogEntry,
} from './types.js';
import {
  SPONSORED_LOGS_RECENT_DEFAULT_CAP,
  sponsoredLogReceiptConflict,
  sponsoredLogReplayFingerprint,
  type SponsoredLogsStoreAdapter,
} from './store.js';

const KEY_PREFIX = 'stelis:sponsored_logs';
const RECENT_KEY = `${KEY_PREFIX}:recent`;
const IDEM_PREFIX = `${KEY_PREFIX}:idem`;
const AGG_PREFIX = `${KEY_PREFIX}:agg`;

/**
 * Lua script — atomic append. Returns `APPENDED` on first append,
 * `DUPLICATE` for an exact replay, and `CONFLICT` when the receipt was
 * already recorded with different result data.
 *
 * Numeric ARGV are canonical decimal strings. Arithmetic stays on strings so
 * no MIST total crosses Lua floating point or Redis signed-int64 arithmetic.
 *
 * The receipt fingerprint has no TTL so the aggregate stays honest for
 * the adapter's full lifetime. The script never expires entries.
 */
const APPEND_SCRIPT = `
local function stripLeadingZeroes(value)
  local stripped = string.gsub(value, '^0+', '')
  if stripped == '' then return '0' end
  return stripped
end

local function splitSign(value)
  if string.sub(value, 1, 1) == '-' then
    return -1, stripLeadingZeroes(string.sub(value, 2))
  end
  return 1, stripLeadingZeroes(value)
end

local function compareMagnitude(left, right)
  if string.len(left) ~= string.len(right) then
    return string.len(left) < string.len(right) and -1 or 1
  end
  if left == right then return 0 end
  return left < right and -1 or 1
end

local function reverseDigits(digits)
  local result = {}
  for index = #digits, 1, -1 do
    result[#result + 1] = digits[index]
  end
  return table.concat(result)
end

local function addMagnitude(left, right)
  local digits = {}
  local leftIndex = string.len(left)
  local rightIndex = string.len(right)
  local carry = 0
  while leftIndex > 0 or rightIndex > 0 or carry > 0 do
    local leftDigit = leftIndex > 0 and tonumber(string.sub(left, leftIndex, leftIndex)) or 0
    local rightDigit = rightIndex > 0 and tonumber(string.sub(right, rightIndex, rightIndex)) or 0
    local sum = leftDigit + rightDigit + carry
    digits[#digits + 1] = tostring(sum % 10)
    carry = math.floor(sum / 10)
    leftIndex = leftIndex - 1
    rightIndex = rightIndex - 1
  end
  return reverseDigits(digits)
end

local function subtractMagnitude(left, right)
  local digits = {}
  local leftIndex = string.len(left)
  local rightIndex = string.len(right)
  local borrow = 0
  while leftIndex > 0 do
    local leftDigit = tonumber(string.sub(left, leftIndex, leftIndex)) - borrow
    local rightDigit = rightIndex > 0 and tonumber(string.sub(right, rightIndex, rightIndex)) or 0
    if leftDigit < rightDigit then
      leftDigit = leftDigit + 10
      borrow = 1
    else
      borrow = 0
    end
    digits[#digits + 1] = tostring(leftDigit - rightDigit)
    leftIndex = leftIndex - 1
    rightIndex = rightIndex - 1
  end
  return stripLeadingZeroes(reverseDigits(digits))
end

local function addDecimal(left, right)
  local leftSign, leftMagnitude = splitSign(left)
  local rightSign, rightMagnitude = splitSign(right)
  if leftSign == rightSign then
    local magnitude = addMagnitude(leftMagnitude, rightMagnitude)
    if leftSign < 0 and magnitude ~= '0' then return '-' .. magnitude end
    return magnitude
  end
  local comparison = compareMagnitude(leftMagnitude, rightMagnitude)
  if comparison == 0 then return '0' end
  if comparison > 0 then
    local magnitude = subtractMagnitude(leftMagnitude, rightMagnitude)
    if leftSign < 0 then return '-' .. magnitude end
    return magnitude
  end
  local magnitude = subtractMagnitude(rightMagnitude, leftMagnitude)
  if rightSign < 0 then return '-' .. magnitude end
  return magnitude
end

local function addAggregate(key, field, delta)
  local current = redis.call('HGET', key, field) or '0'
  redis.call('HSET', key, field, addDecimal(current, delta))
end

local idempotencyKey = KEYS[1]
local aggAllKey = KEYS[2]
local aggModeKey = KEYS[3]
local recentKey = KEYS[4]

local entryJson = ARGV[1]
local fingerprint = ARGV[2]
local execDelta = ARGV[3]
local isKnown = ARGV[4]
local netDelta = ARGV[5]
local lossAmountDelta = ARGV[6]
local lossDelta = ARGV[7]
local recentCap = tonumber(ARGV[8])

local recordedFingerprint = redis.call('GET', idempotencyKey)
if recordedFingerprint then
  if recordedFingerprint == fingerprint then
    return 'DUPLICATE'
  end
  return 'CONFLICT'
end
addAggregate(aggAllKey, 'sponsoredExecutions', execDelta)
addAggregate(aggModeKey, 'sponsoredExecutions', execDelta)

if isKnown == '1' then
  addAggregate(aggAllKey, 'cumulativeHostNetMist', netDelta)
  addAggregate(aggModeKey, 'cumulativeHostNetMist', netDelta)
  addAggregate(aggAllKey, 'cumulativeLossMist', lossAmountDelta)
  addAggregate(aggModeKey, 'cumulativeLossMist', lossAmountDelta)
  if lossDelta == '1' then
    addAggregate(aggAllKey, 'lossCount', lossDelta)
    addAggregate(aggModeKey, 'lossCount', lossDelta)
  end
end

redis.call('LPUSH', recentKey, entryJson)
redis.call('LTRIM', recentKey, 0, recentCap - 1)

redis.call('SET', idempotencyKey, fingerprint)
return 'APPENDED'
`.trim();

/**
 * Lua script — atomic read of an aggregate hash. Returns the four fields
 * in a deterministic order so the caller can reconstruct without
 * round-tripping HGETALL keys.
 */
const SUMMARY_SCRIPT = `
local key = KEYS[1]
return {
  redis.call('HGET', key, 'sponsoredExecutions') or '0',
  redis.call('HGET', key, 'cumulativeHostNetMist') or '0',
  redis.call('HGET', key, 'lossCount') or '0',
  redis.call('HGET', key, 'cumulativeLossMist') or '0',
}
`.trim();

/**
 * Lua script — atomic read of recent entries. Returns the JSON strings
 * newest-first up to `limit`.
 */
const LRANGE_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
return redis.call('LRANGE', key, 0, limit - 1)
`.trim();

function aggKey(mode: SponsoredExecutionAggregateMode): string {
  return `${AGG_PREFIX}:${mode}`;
}

function idemKey(receiptId: string): string {
  return `${IDEM_PREFIX}:${receiptId}`;
}

export interface RedisSponsoredLogsStoreOptions {
  readonly recentCap?: number;
}

export class RedisSponsoredLogsStore implements SponsoredLogsStoreAdapter {
  private readonly recentCap: number;

  constructor(
    private readonly client: RedisClientLike,
    options: RedisSponsoredLogsStoreOptions = {},
  ) {
    const recentCap = options.recentCap ?? SPONSORED_LOGS_RECENT_DEFAULT_CAP;
    if (!Number.isSafeInteger(recentCap) || recentCap <= 0) {
      throw new Error('sponsoredLogs.redisStore: recentCap must be a positive safe integer');
    }
    this.recentCap = recentCap;
  }

  async append(entry: SponsoredExecutionLogEntry): Promise<void> {
    const currentEntry = parseSponsoredExecutionLogEntry(entry);
    let isKnown = false;
    let netDelta = '0';
    let lossAmountDelta = '0';
    let lossDelta = '0';
    if (currentEntry.economicsStatus === 'known') {
      // Validate and normalize the signed decimal before passing it to the
      // string-arithmetic script; the recorder preserves the primary error.
      const hostNet = parseSignedDecimalString(currentEntry.hostNetMist!, 'hostNetMist');
      isKnown = true;
      netDelta = hostNet.toString();
      lossAmountDelta = hostNet < 0n ? hostNet.toString() : '0';
      lossDelta = hostNet < 0n ? '1' : '0';
    }
    const keys = [
      idemKey(currentEntry.receiptId),
      aggKey('all'),
      aggKey(currentEntry.mode),
      RECENT_KEY,
    ];
    const args = [
      serializeSponsoredExecutionLogEntry(currentEntry),
      sponsoredLogReplayFingerprint(currentEntry),
      '1',
      isKnown ? '1' : '0',
      netDelta,
      lossAmountDelta,
      lossDelta,
      this.recentCap.toString(),
    ];
    const result = await this.client.eval(APPEND_SCRIPT, keys, args);
    if (result === 'APPENDED' || result === 'DUPLICATE') return;
    if (result === 'CONFLICT') {
      throw sponsoredLogReceiptConflict(currentEntry.receiptId);
    }
    throw new Error(
      `sponsoredLogs.redisStore: unexpected append script return: ${JSON.stringify(result)}`,
    );
  }

  async getSummary(mode: SponsoredExecutionAggregateMode): Promise<SponsoredExecutionAggregate> {
    const result = await this.client.eval(SUMMARY_SCRIPT, [aggKey(mode)], []);
    if (!Array.isArray(result) || result.length !== 4) {
      throw new Error(
        `sponsoredLogs.redisStore: unexpected summary script return: ${JSON.stringify(result)}`,
      );
    }
    const [exec, cumulativeNet, loss, cumulativeLoss] = result as readonly unknown[];
    const sponsoredExecutions = parseUnsignedDecimalString(exec, 'sponsoredExecutions');
    const lossCount = parseUnsignedDecimalString(loss, 'lossCount');
    const cumulativeHostNetMist = parseSignedDecimalString(cumulativeNet, 'cumulativeHostNetMist');
    const cumulativeLossMist = parseSignedDecimalString(cumulativeLoss, 'cumulativeLossMist');
    if (lossCount > sponsoredExecutions) {
      throw new Error('sponsoredLogs.redisStore: lossCount cannot exceed sponsoredExecutions');
    }
    if (cumulativeLossMist > 0n) {
      throw new Error('sponsoredLogs.redisStore: cumulativeLossMist cannot be positive');
    }
    return {
      mode,
      sponsoredExecutions: sponsoredExecutions.toString(),
      lossCount: lossCount.toString(),
      cumulativeHostNetMist: cumulativeHostNetMist.toString(),
      cumulativeLossMist: cumulativeLossMist.toString(),
    };
  }

  async getRecent(
    mode: SponsoredExecutionAggregateMode,
    limit: number,
  ): Promise<readonly SponsoredExecutionLogEntry[]> {
    if (limit <= 0) return [];
    // mode-filtered reads must scan the full retained list so that a
    // matching row outside the first `limit * k` window is not silently
    // hidden. Scan the entire retained list before applying the mode
    // filter and caller limit.
    const fetchCount = mode === 'all' ? limit : this.recentCap;
    const result = await this.client.eval(LRANGE_SCRIPT, [RECENT_KEY], [fetchCount.toString()]);
    if (!Array.isArray(result)) {
      throw new Error(
        `sponsoredLogs.redisStore: unexpected lrange script return: ${JSON.stringify(result)}`,
      );
    }
    const entries = (result as readonly unknown[]).map((raw) => {
      if (typeof raw !== 'string') {
        throw new Error('sponsoredLogs.redisStore: recent entry must be stored JSON');
      }
      return parseStoredSponsoredExecutionLogEntry(raw);
    });
    if (mode === 'all') {
      return entries.slice(0, limit);
    }
    return entries.filter((entry) => entry.mode === mode).slice(0, limit);
  }
}
