/**
 * Redis adapter for sponsored execution log + aggregate.
 *
 * All writes go through a single Lua script so that:
 *   - idempotency check (`SET NX`, no TTL),
 *   - per-mode + all-mode aggregate updates (`HINCRBY` on int64 string fields),
 *   - recent-list append + createdAt sort + cap
 * are atomic per emit. This mirrors `RedisPromotionExecutionLedger`'s
 * Lua-atomic money update pattern.
 *
 * Reads also go through `eval` so the adapter only depends on
 * `RedisClientLike.eval`. No additional Redis API (lrange / hincrby /
 * lpush) is required from the client interface.
 *
 * Key layout:
 *   stelis:sponsored_logs:agg:{all|generic|promotion}     HASH
 *     fields: sponsoredExecutions, cumulativeHostNetMist,
 *             cumulativeLossMist, lossCount   (int64 string)
 *   stelis:sponsored_logs:recent                           LIST
 *     createdAt newest-first JSON-serialised SponsoredExecutionLogEntry, capped.
 *   stelis:sponsored_logs:idem:{mode|receiptId|outcome}    STRING (NX, no TTL)
 *
 * Idempotency contract: the idem key is set with `NX` and no TTL so the
 * lifetime aggregate stays honest across restarts. Operators may flush
 * the `stelis:sponsored_logs:idem:*` namespace during scheduled maintenance;
 * the adapter never expires keys on its own.
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
  SPONSORED_LOGS_RECENT_DEFAULT_CAP,
  parseSignedMistString,
  sponsoredLogIdempotencyKey,
  type SponsoredLogsStoreAdapter,
} from './store.js';

const KEY_PREFIX = 'stelis:sponsored_logs';
const RECENT_KEY = `${KEY_PREFIX}:recent`;
const IDEM_PREFIX = `${KEY_PREFIX}:idem`;
const AGG_PREFIX = `${KEY_PREFIX}:agg`;

/**
 * Lua script — atomic append. Returns `1` on first append, `0` on
 * duplicate (idempotency hit; no aggregate or recent change).
 *
 * Numeric ARGV are signed-decimal strings. HINCRBY accepts signed
 * decimal strings as the increment.
 *
 * The idempotency key is set with `NX` and no TTL so the aggregate stays
 * honest for the adapter's full lifetime. The key set is operator-flushable
 * out-of-band; the script never expires entries.
 */
const APPEND_SCRIPT = `
local idempotencyKey = KEYS[1]
local aggAllKey = KEYS[2]
local aggModeKey = KEYS[3]
local recentKey = KEYS[4]

local entryJson = ARGV[1]
local execDelta = ARGV[2]
local isKnown = ARGV[3]
local netDelta = ARGV[4]
local lossAmountDelta = ARGV[5]
local lossDelta = ARGV[6]
local recentCap = tonumber(ARGV[7])

local set = redis.call('SET', idempotencyKey, '1', 'NX')
if not set then
  return 0
end

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

return 1
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

function idemKey(entry: SponsoredExecutionLogEntry): string {
  return `${IDEM_PREFIX}:${sponsoredLogIdempotencyKey(entry)}`;
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
    let isKnown = false;
    let netDelta = '0';
    let lossAmountDelta = '0';
    let lossDelta = '0';
    if (entry.economicsStatus === 'known') {
      if (entry.hostNetMist === null) {
        throw new Error('sponsoredLogs.redisStore: known economics entry missing hostNetMist');
      }
      // Validate the signed-decimal shape so HINCRBY does not receive a
      // malformed argument; primary error preserved at the recorder's
      // try/catch boundary.
      const hostNet = parseSignedMistString(entry.hostNetMist, 'hostNetMist');
      isKnown = true;
      netDelta = hostNet.toString();
      lossAmountDelta = hostNet < 0n ? hostNet.toString() : '0';
      lossDelta = hostNet < 0n ? '1' : '0';
    }
    const keys = [idemKey(entry), aggKey('all'), aggKey(entry.mode), RECENT_KEY];
    const args = [
      JSON.stringify(entry),
      '1',
      isKnown ? '1' : '0',
      netDelta,
      lossAmountDelta,
      lossDelta,
      this.recentCap.toString(),
    ];
    await this.client.eval(APPEND_SCRIPT, keys, args);
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
      sponsoredExecutions: typeof exec === 'string' ? exec : '0',
      lossCount: typeof loss === 'string' ? loss : '0',
      cumulativeHostNetMist: typeof cumulativeNet === 'string' ? cumulativeNet : '0',
      cumulativeLossMist: typeof cumulativeLoss === 'string' ? cumulativeLoss : '0',
    };
  }

  async getRecent(
    mode: SponsoredExecutionAggregateMode,
    limit: number,
  ): Promise<readonly SponsoredExecutionLogEntry[]> {
    if (limit <= 0) return [];
    // mode-filtered reads must scan the full retained list so that a
    // matching row outside the first `limit * k` window is not silently
    // hidden. Memory adapter walks the entire retained list; this
    // adapter mirrors that contract to avoid host-visible drift.
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Skip malformed JSON rather than throwing — Redis recent list
        // is best-effort and a corrupt entry must not block reads.
        continue;
      }
      if (!isLogEntry(parsed)) continue;
      entries.push(parsed);
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

function isLogEntry(value: unknown): value is SponsoredExecutionLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<SponsoredExecutionLogEntry>;
  return (
    v.schemaVersion === 1 &&
    typeof v.createdAt === 'string' &&
    typeof v.mode === 'string' &&
    (v.mode === 'generic' || v.mode === 'promotion') &&
    typeof v.outcome === 'string' &&
    typeof v.receiptId === 'string' &&
    typeof v.economicsStatus === 'string' &&
    (v.economicsStatus === 'known' || v.economicsStatus === 'unknown')
  );
}
