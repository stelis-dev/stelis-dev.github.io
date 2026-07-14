/**
 * Redis adapter for sponsored execution log + aggregate.
 *
 * All writes go through a single Lua script so that:
 *   - exact-replay / conflicting-result check by receipt (no TTL),
 *   - per-mode + all-mode aggregate updates (`HINCRBY` on int64 string fields),
 *   - recent-list append + createdAt sort + cap
 * are atomic per emit. This mirrors `RedisPromotionExecutionLedger`'s
 * Lua-atomic money update pattern.
 *
 * Reads also go through `eval`, so this adapter only depends on
 * `RedisClientLike.eval`.
 *
 * Key layout:
 *   stelis:sponsored_logs:agg:{all|generic|promotion}     HASH
 *     fields: sponsoredExecutions, cumulativeHostNetMist,
 *             cumulativeLossMist, lossCount   (int64 string)
 *   stelis:sponsored_logs:recent                           LIST
 *     createdAt newest-first JSON-serialised SponsoredExecutionLogEntry, capped.
 *   stelis:sponsored_logs:idem:{receiptId}                 STRING fingerprint (no TTL)
 *
 * Replay contract: the receipt key stores the accepted result fingerprint
 * with no TTL so the lifetime aggregate stays honest across restarts. The
 * adapter never expires or clears these keys; clearing them while retaining
 * the aggregate would remove its replay proof.
 *
 * Signed int64 headroom: -9_223_372_036_854_775_808 to
 * 9_223_372_036_854_775_807. Sufficient for lifetime totals at expected
 * sponsored TPS; switch to chunked aggregates or a DB primary if the
 * headroom is exceeded.
 */

import type { RedisClientLike } from '@stelis/core-api';
import type {
  SponsoredExecutionAggregate,
  SponsoredExecutionAggregateMode,
  SponsoredExecutionLogEntry,
  SponsoredExecutionMode,
} from './types.js';
import {
  parseSignedDecimalString,
  parseSponsoredExecutionLogEntry,
  parseUnsignedDecimalString,
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
 * Numeric ARGV are signed-decimal strings. HINCRBY accepts signed
 * decimal strings as the increment.
 *
 * The receipt fingerprint has no TTL so the aggregate stays honest for
 * the adapter's full lifetime. The script never expires entries.
 */
const APPEND_SCRIPT = `
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
redis.call('SET', idempotencyKey, fingerprint)

redis.call('HINCRBY', aggAllKey, 'sponsoredExecutions', execDelta)
redis.call('HINCRBY', aggModeKey, 'sponsoredExecutions', execDelta)

if isKnown == '1' then
  redis.call('HINCRBY', aggAllKey, 'cumulativeHostNetMist', netDelta)
  redis.call('HINCRBY', aggModeKey, 'cumulativeHostNetMist', netDelta)
  redis.call('HINCRBY', aggAllKey, 'cumulativeLossMist', lossAmountDelta)
  redis.call('HINCRBY', aggModeKey, 'cumulativeLossMist', lossAmountDelta)
  if tonumber(lossDelta) > 0 then
    redis.call('HINCRBY', aggAllKey, 'lossCount', lossDelta)
    redis.call('HINCRBY', aggModeKey, 'lossCount', lossDelta)
  end
end

redis.call('LPUSH', recentKey, entryJson)
local rows = redis.call('LRANGE', recentKey, 0, -1)
table.sort(rows, function(a, b)
  local okA, entryA = pcall(cjson.decode, a)
  local okB, entryB = pcall(cjson.decode, b)
  local createdA = ''
  local createdB = ''
  if okA and type(entryA) == 'table' and type(entryA.createdAt) == 'string' then
    createdA = entryA.createdAt
  end
  if okB and type(entryB) == 'table' and type(entryB.createdAt) == 'string' then
    createdB = entryB.createdAt
  end
  return createdA > createdB
end)
redis.call('DEL', recentKey)
local keep = math.min(#rows, recentCap)
for i = 1, keep do
  redis.call('RPUSH', recentKey, rows[i])
end

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

function compareCreatedAtDesc(
  a: SponsoredExecutionLogEntry,
  b: SponsoredExecutionLogEntry,
): number {
  return b.createdAt.localeCompare(a.createdAt);
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
    this.recentCap = options.recentCap ?? SPONSORED_LOGS_RECENT_DEFAULT_CAP;
  }

  async append(entry: SponsoredExecutionLogEntry): Promise<void> {
    const currentEntry = parseSponsoredExecutionLogEntry(entry);
    let isKnown = false;
    let netDelta = '0';
    let lossAmountDelta = '0';
    let lossDelta = '0';
    if (currentEntry.economicsStatus === 'known') {
      // Validate the signed-decimal shape so HINCRBY does not receive a
      // malformed argument; primary error preserved at the recorder's
      // try/catch boundary.
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
      JSON.stringify(currentEntry),
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
    return {
      mode,
      sponsoredExecutions: parseUnsignedDecimalString(exec, 'sponsoredExecutions').toString(),
      lossCount: parseUnsignedDecimalString(loss, 'lossCount').toString(),
      cumulativeHostNetMist: parseSignedDecimalString(
        cumulativeNet,
        'cumulativeHostNetMist',
      ).toString(),
      cumulativeLossMist: parseSignedDecimalString(cumulativeLoss, 'cumulativeLossMist').toString(),
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
    const entries: SponsoredExecutionLogEntry[] = [];
    for (const raw of result as readonly unknown[]) {
      if (typeof raw !== 'string') continue;
      try {
        entries.push(parseSponsoredExecutionLogEntry(JSON.parse(raw)));
      } catch {
        // Recent rows are best-effort. Malformed JSON and non-current
        // shapes are skipped rather than weakening the current decoder.
        continue;
      }
    }
    entries.sort(compareCreatedAtDesc);
    if (mode === 'all') {
      return entries.slice(0, limit);
    }
    return entries
      .filter((entry) => entry.mode === (mode as SponsoredExecutionMode))
      .slice(0, limit);
  }
}
