import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { AbuseBlockReason } from '@stelis/contracts';
import { DEFAULT_ABUSE_BLOCKER_CONFIG } from '../abuseBlocking.js';
import {
  getFailurePolicy,
  isManipulationAttemptCode,
  shouldCarveOutNonIpCounter,
  shouldIgnoreSponsorFailureForAbuse,
  subjectCounterFamily,
} from '../failures.js';
import { ABUSE_BLOCK_EXPIRY_TASK_FAILED } from '../observability/events.js';
import { logStructuredEvent } from '../structuredEventLog.js';
import type {
  AbuseBlockStatus,
  AbuseBlockerConfig,
  AbuseSubject,
  SponsorFailureMeta,
} from './abuseBlockTypes.js';
import {
  ABUSE_BLOCK_DEADLINE_INDEX_KEY,
  ABUSE_BLOCK_EXPIRY_BATCH_SIZE,
  ABUSE_BLOCK_EXPIRY_INTERVAL_MS,
  ABUSE_BLOCK_RECORD_PREFIX,
  AbuseBlockCurrentConflictError,
  AbuseBlockStorageCorruptionError,
  abuseBlockIdentityFromSubject,
  abuseBlockMember,
  abuseBlockRecordKey,
  compareAbuseBlockPosition,
  decideAbuseBlockRemoval,
  decideAbuseBlockWrite,
  decodeAbuseBlockCursor,
  decodeAbuseBlockMember,
  decodeAbuseBlockRecord,
  encodeAbuseBlockCursor,
  isLiveAbuseBlock,
  normalizeAbuseBlockIdentity,
  serializeAbuseBlockRecord,
  validateAbuseBlockPageParams,
  type AbuseBlockIdentity,
  type AbuseBlockPage,
  type AbuseBlockPageParams,
  type AbuseBlockRecord,
  type AbuseBlockStore,
} from './abuseBlockStore.js';
import { validateAbuseBlockerConfig } from './abuseBlockConfig.js';
import type { RedisClientLike } from './redisClient.js';
import { FIXED_WINDOW_INCR_SCRIPT, parseFixedWindowResult } from './redisFixedWindowCounter.js';

const COUNTER_PREFIX = 'stelis:abuse:counter:';

const LUA_EXACT_BLOCK_SNAPSHOT_HELPER = `
local function readExactBlockSnapshot(
  recordKey,
  indexKey,
  member,
  expectedRawPresent,
  expectedRaw,
  expectedScorePresent,
  expectedScore)
  local currentRaw = redis.call('GET', recordKey)
  local currentScore = redis.call('ZSCORE', indexKey, member)
  local rawMatches =
    (expectedRawPresent == '0' and not currentRaw)
    or (expectedRawPresent == '1' and currentRaw == expectedRaw)
  local scoreMatches =
    (expectedScorePresent == '0' and not currentScore)
    or (expectedScorePresent == '1' and currentScore == expectedScore)
  return rawMatches and scoreMatches, currentRaw, currentScore
end
`;

const READ_BLOCK_SNAPSHOT_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local raw = redis.call('GET', KEYS[1])
local score = redis.call('ZSCORE', KEYS[2], ARGV[1])
return {'ok', string.format('%.0f', now),
  raw and '1' or '0', raw or '',
  score and '1' or '0', score or ''}
`;

const APPLY_BLOCK_CAS_SCRIPT = `
${LUA_EXACT_BLOCK_SNAPSHOT_HELPER}
local snapshotMatches, current_raw, current_score = readExactBlockSnapshot(
  KEYS[1], KEYS[2], ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5])
if not snapshotMatches then return {'changed'} end

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if ARGV[6] == 'preserve' then
  if not current_score or tonumber(current_score) <= now then
    return {'deadline_elapsed', string.format('%.0f', now)}
  end
  return {'preserved', string.format('%.0f', now)}
end
if ARGV[6] ~= 'store' then return {'invalid_action'} end

local deadline = tonumber(ARGV[8])
if not deadline or deadline <= now then
  return {'deadline_elapsed', string.format('%.0f', now)}
end
redis.call('SET', KEYS[1], ARGV[7])
redis.call('PEXPIREAT', KEYS[1], ARGV[8])
redis.call('ZADD', KEYS[2], ARGV[8], ARGV[1])
return {'stored', string.format('%.0f', now)}
`;

const DELETE_BLOCK_CAS_SCRIPT = `
${LUA_EXACT_BLOCK_SNAPSHOT_HELPER}
local snapshotMatches, current_raw, current_score = readExactBlockSnapshot(
  KEYS[1], KEYS[2], ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5])
if not snapshotMatches then return {'changed'} end

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
if current_raw and current_score and tonumber(current_score) > now then
  return {'removed', string.format('%.0f', now)}
end
return {'missing', string.format('%.0f', now)}
`;

const PAGE_BLOCK_SNAPSHOT_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local cursor_raw = false
local cursor_score = false
local start = 0
if ARGV[1] ~= '' then
  cursor_raw = redis.call('GET', ARGV[4] .. ARGV[1])
  cursor_score = redis.call('ZSCORE', KEYS[1], ARGV[1])
  local anchor = ARGV[1] .. string.char(0)
  if redis.call('ZSCORE', KEYS[1], anchor) then return {'anchor_conflict'} end
  redis.call('ZADD', KEYS[1], ARGV[2], anchor)
  start = redis.call('ZRANK', KEYS[1], anchor)
  redis.call('ZREM', KEYS[1], anchor)
  if not start then return {'anchor_conflict'} end
end

local limit = tonumber(ARGV[3])
local values = redis.call('ZRANGE', KEYS[1], start, start + limit, 'WITHSCORES')
local examined = math.min(limit, math.floor(#values / 2))
local rows = {}
for i = 1, examined do
  local member = values[(i - 1) * 2 + 1]
  local score = values[(i - 1) * 2 + 2]
  local raw = redis.call('GET', ARGV[4] .. member)
  table.insert(rows, {member, score, raw and '1' or '0', raw or ''})
end

local has_more = #values > limit * 2 and '1' or '0'
local next_member = ''
local next_score = ''
if has_more == '1' and examined > 0 then
  next_member = values[(examined - 1) * 2 + 1]
  next_score = values[(examined - 1) * 2 + 2]
end
return {'ok', string.format('%.0f', now),
  cursor_raw and '1' or '0', cursor_raw or '',
  cursor_score and '1' or '0', cursor_score or '',
  has_more, next_member, next_score, rows}
`;

const DUE_BLOCK_SNAPSHOT_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local values = redis.call(
  'ZRANGEBYSCORE', KEYS[1], '-inf', now, 'WITHSCORES', 'LIMIT', 0, tonumber(ARGV[1])
)
local rows = {}
for i = 1, #values, 2 do
  local member = values[i]
  local score = values[i + 1]
  local raw = redis.call('GET', ARGV[2] .. member)
  table.insert(rows, {member, score, raw and '1' or '0', raw or ''})
end
return {'ok', string.format('%.0f', now), rows}
`;

const DELETE_STALE_BLOCKS_CAS_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local removed = 0
for i = 2, #ARGV, 4 do
  local member = ARGV[i]
  local expected_score = ARGV[i + 1]
  local expected_raw_present = ARGV[i + 2]
  local expected_raw = ARGV[i + 3]
  local current_score = redis.call('ZSCORE', KEYS[1], member)
  local current_raw = redis.call('GET', ARGV[1] .. member)
  local raw_matches =
    (expected_raw_present == '0' and not current_raw)
    or (expected_raw_present == '1' and current_raw == expected_raw)
  if current_score == expected_score
     and tonumber(current_score) <= now
     and raw_matches then
    redis.call('DEL', ARGV[1] .. member)
    redis.call('ZREM', KEYS[1], member)
    removed = removed + 1
  end
end
return {'ok', string.format('%.0f', now), tostring(removed)}
`;

interface BlockSnapshot {
  readonly nowMs: number;
  readonly raw: string | null;
  readonly scoreRaw: string | null;
  readonly score: number | null;
  readonly record: AbuseBlockRecord | null;
}

interface IndexedBlockSnapshot {
  readonly identity: AbuseBlockIdentity;
  readonly member: string;
  readonly scoreRaw: string;
  readonly blockedUntilMs: number;
  readonly raw: string | null;
  readonly record: AbuseBlockRecord | null;
}

function blockSnapshotCompareArgs(
  identity: AbuseBlockIdentity,
  snapshot: Pick<BlockSnapshot, 'raw' | 'scoreRaw'>,
): string[] {
  return [
    abuseBlockMember(identity),
    snapshot.raw === null ? '0' : '1',
    snapshot.raw ?? '',
    snapshot.scoreRaw === null ? '0' : '1',
    snapshot.scoreRaw ?? '',
  ];
}

export class RedisAbuseBlocker implements AbuseBlockStore {
  private readonly config: AbuseBlockerConfig;
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private expiryRun: Promise<void> | null = null;
  private readonly expiryAbort = new AbortController();

  constructor(
    private readonly client: RedisClientLike,
    config: Partial<AbuseBlockerConfig> = {},
  ) {
    this.config = validateAbuseBlockerConfig({ ...DEFAULT_ABUSE_BLOCKER_CONFIG, ...config });
    this.expiryTimer = setInterval(() => this.startExpiryRun(), ABUSE_BLOCK_EXPIRY_INTERVAL_MS);
    this.expiryTimer.unref?.();
  }

  async checkIp(ip: string): Promise<AbuseBlockStatus> {
    return this.checkBlock({ scope: 'ip', subject: ip });
  }

  async checkSubject(subject: AbuseSubject): Promise<AbuseBlockStatus> {
    return this.checkBlock(abuseBlockIdentityFromSubject(subject));
  }

  async recordSponsorFailure(
    ip: string,
    subject: AbuseSubject | undefined,
    code: string,
    meta?: SponsorFailureMeta,
  ): Promise<void> {
    if (shouldIgnoreSponsorFailureForAbuse(code)) return;
    const ipIdentity = normalizeAbuseBlockIdentity({ scope: 'ip', subject: ip });

    if (isManipulationAttemptCode(code)) {
      await this.setBlock(ipIdentity, 'manipulation', this.config.manipulationBlockDurationMs);
      if (subject) {
        await this.setBlock(
          abuseBlockIdentityFromSubject(subject),
          'manipulation',
          this.config.manipulationBlockDurationMs,
        );
      }
      return;
    }

    const policy = getFailurePolicy(code);
    if ((policy?.abuseImpact.ip ?? 'count') === 'count') {
      const count = await this.incrementWindowCounter(
        this.counterKey('ip', ipIdentity),
        this.config.ipFailureWindowMs,
      );
      if (count > this.config.ipFailureThreshold) {
        await this.setBlock(ipIdentity, 'sponsor_failure_threshold', this.config.ipBlockDurationMs);
      }
    }

    const family = subjectCounterFamily(code);
    if (
      subject &&
      (policy?.abuseImpact.subject ?? 'count') === 'count' &&
      family !== null &&
      !shouldCarveOutNonIpCounter(code, meta)
    ) {
      const subjectId = abuseBlockIdentityFromSubject(subject);
      const count = await this.incrementWindowCounter(
        this.counterKey(family, subjectId),
        family === 'sim_tier'
          ? this.config.addressDryRunWindowMs
          : this.config.addressOnchainRevertWindowMs,
      );
      const threshold =
        family === 'sim_tier'
          ? this.config.addressDryRunThreshold
          : this.config.addressOnchainRevertThreshold;
      if (count > threshold) {
        await this.setBlock(
          subjectId,
          family === 'sim_tier' ? 'dry_run_failure_threshold' : 'onchain_revert_threshold',
          this.config.addressBlockDurationMs,
        );
      }
    }
  }

  async listBlocks(params: AbuseBlockPageParams): Promise<AbuseBlockPage> {
    validateAbuseBlockPageParams(params);
    const cursor = params.cursor === null ? null : decodeAbuseBlockCursor(params.cursor);
    const cursorIdentity =
      cursor === null ? null : { scope: cursor.scope, subject: cursor.subject };
    const result = await this.client.eval(
      PAGE_BLOCK_SNAPSHOT_SCRIPT,
      [ABUSE_BLOCK_DEADLINE_INDEX_KEY],
      [
        cursorIdentity === null ? '' : abuseBlockMember(cursorIdentity),
        cursor === null ? '' : String(cursor.blockedUntilMs),
        String(params.limit),
        ABUSE_BLOCK_RECORD_PREFIX,
      ],
    );
    const page = parsePageSnapshot(result, params);
    if (page.stale.length > 0) {
      await this.deleteStaleSnapshots(page.stale);
    }
    return { blocks: page.blocks, nextCursor: page.nextCursor };
  }

  async removeBlock(identity: AbuseBlockIdentity): Promise<boolean> {
    const current = normalizeAbuseBlockIdentity(identity);
    const snapshot = await this.readBlockSnapshot(current);
    if (snapshot.raw === null && snapshot.scoreRaw === null) return false;
    const result = await this.deleteBlockSnapshot(current, snapshot);
    if (result === 'changed') throw new AbuseBlockCurrentConflictError('remove');
    return result === 'removed';
  }

  async stop(): Promise<void> {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.expiryAbort.abort();
    await this.expiryRun;
  }

  private async checkBlock(identity: AbuseBlockIdentity): Promise<AbuseBlockStatus> {
    const current = normalizeAbuseBlockIdentity(identity);
    const snapshot = await this.readBlockSnapshot(current);
    if (snapshot.record !== null && isLiveAbuseBlock(snapshot.record, snapshot.nowMs)) {
      return {
        blocked: true,
        scope: snapshot.record.identity.scope,
        reason: snapshot.record.reason,
        retryAfterMs: snapshot.record.blockedUntilMs - snapshot.nowMs,
      };
    }
    return { blocked: false };
  }

  private async setBlock(
    identity: AbuseBlockIdentity,
    reason: AbuseBlockReason,
    durationMs: number,
  ): Promise<void> {
    const current = normalizeAbuseBlockIdentity(identity);
    let retryAvailable = true;
    while (true) {
      const snapshot = await this.readBlockSnapshot(current);
      const requested = {
        identity: current,
        reason,
        blockedUntilMs: snapshot.nowMs + durationMs,
      };
      if (!Number.isSafeInteger(requested.blockedUntilMs)) {
        throw new Error('Abuse block deadline exceeds the safe integer range');
      }
      const decision = decideAbuseBlockWrite(snapshot.record, requested);
      const finalRaw = serializeAbuseBlockRecord(decision.record);
      const result = requireTuple(
        await this.client.eval(
          APPLY_BLOCK_CAS_SCRIPT,
          [abuseBlockRecordKey(current), ABUSE_BLOCK_DEADLINE_INDEX_KEY],
          [
            ...blockSnapshotCompareArgs(current, snapshot),
            decision.kind === 'preserved' ? 'preserve' : 'store',
            finalRaw,
            String(decision.record.blockedUntilMs),
          ],
        ),
        'set',
      );
      if (result.length === 1 && result[0] === 'changed') {
        if (retryAvailable) {
          retryAvailable = false;
          continue;
        }
        throw new AbuseBlockCurrentConflictError('set');
      }
      if (result.length === 2 && result[0] === 'deadline_elapsed') {
        parseNonNegativeRedisInteger(result[1], 'set current time');
        if (retryAvailable) {
          retryAvailable = false;
          continue;
        }
        throw new AbuseBlockCurrentConflictError('set');
      }
      if (
        result.length !== 2 ||
        (result[0] !== 'stored' && result[0] !== 'preserved') ||
        result[0] !== decision.kind
      ) {
        throw storageCorruption('set');
      }
      const appliedAtMs = parseNonNegativeRedisInteger(result[1], 'set current time');
      if (!isLiveAbuseBlock(decision.record, appliedAtMs)) {
        throw storageCorruption('set deadline');
      }
      return;
    }
  }

  private async readBlockSnapshot(identity: AbuseBlockIdentity): Promise<BlockSnapshot> {
    const member = abuseBlockMember(identity);
    const result = requireTuple(
      await this.client.eval(
        READ_BLOCK_SNAPSHOT_SCRIPT,
        [abuseBlockRecordKey(identity), ABUSE_BLOCK_DEADLINE_INDEX_KEY],
        [member],
      ),
      'read snapshot',
    );
    if (result.length !== 6 || result[0] !== 'ok') {
      throw storageCorruption('read snapshot');
    }
    const nowMs = parseNonNegativeRedisInteger(result[1], 'read snapshot current time');
    const raw = parseOptionalString(result[2], result[3], 'read snapshot record');
    const scoreRaw = parseOptionalString(result[4], result[5], 'read snapshot score');
    const score =
      scoreRaw === null ? null : parsePositiveRedisInteger(scoreRaw, 'read snapshot score');
    if (raw === null) {
      if (score !== null && score > nowMs) throw storageCorruption('read snapshot live index');
      return { nowMs, raw: null, scoreRaw, score, record: null };
    }
    if (score === null) throw storageCorruption('read snapshot missing index');
    const record = decodeStoredBlockRecord(raw, 'read snapshot record');
    if (abuseBlockMember(record.identity) !== member || record.blockedUntilMs !== score) {
      throw storageCorruption('read snapshot identity');
    }
    return { nowMs, raw, scoreRaw, score, record };
  }

  private async deleteBlockSnapshot(
    identity: AbuseBlockIdentity,
    snapshot: BlockSnapshot,
  ): Promise<'changed' | 'removed' | 'missing'> {
    const result = requireTuple(
      await this.client.eval(
        DELETE_BLOCK_CAS_SCRIPT,
        [abuseBlockRecordKey(identity), ABUSE_BLOCK_DEADLINE_INDEX_KEY],
        blockSnapshotCompareArgs(identity, snapshot),
      ),
      'delete',
    );
    if (result.length === 1 && result[0] === 'changed') return 'changed';
    if (result.length !== 2 || (result[0] !== 'removed' && result[0] !== 'missing')) {
      throw storageCorruption('delete');
    }
    const nowMs = parseNonNegativeRedisInteger(result[1], 'delete current time');
    const expected = decideAbuseBlockRemoval(snapshot.record, nowMs);
    if (result[0] !== expected) throw storageCorruption('delete transition');
    return expected;
  }

  private async deleteStaleSnapshots(rows: readonly IndexedBlockSnapshot[]): Promise<void> {
    if (rows.length === 0 || rows.length > ABUSE_BLOCK_EXPIRY_BATCH_SIZE) {
      if (rows.length === 0) return;
      throw storageCorruption('stale delete batch');
    }
    const args = [ABUSE_BLOCK_RECORD_PREFIX];
    for (const row of rows) {
      args.push(row.member, row.scoreRaw, row.raw === null ? '0' : '1', row.raw ?? '');
    }
    const result = requireTuple(
      await this.client.eval(
        DELETE_STALE_BLOCKS_CAS_SCRIPT,
        [ABUSE_BLOCK_DEADLINE_INDEX_KEY],
        args,
      ),
      'stale delete',
    );
    if (result.length !== 3 || result[0] !== 'ok') {
      throw storageCorruption('stale delete');
    }
    parseNonNegativeRedisInteger(result[1], 'stale delete current time');
    const removed = parseNonNegativeRedisInteger(result[2], 'stale delete count');
    if (removed > rows.length) throw storageCorruption('stale delete count');
  }

  private async incrementWindowCounter(key: string, windowMs: number): Promise<number> {
    return parseFixedWindowResult(
      await this.client.eval(FIXED_WINDOW_INCR_SCRIPT, [key], [String(windowMs)]),
    ).current;
  }

  private counterKey(family: 'ip' | 'sim_tier' | 'revert', identity: AbuseBlockIdentity): string {
    return `${COUNTER_PREFIX}${family}:${abuseBlockMember(identity)}`;
  }

  private startExpiryRun(): void {
    if (this.expiryRun || this.expiryAbort.signal.aborted) return;
    this.expiryRun = this.runExpirySweep()
      .catch((error) => {
        if (!this.expiryAbort.signal.aborted) {
          logStructuredEvent(
            ABUSE_BLOCK_EXPIRY_TASK_FAILED,
            { error: error instanceof Error ? error.message : String(error) },
            'error',
          );
        }
      })
      .finally(() => {
        this.expiryRun = null;
      });
  }

  private async runExpirySweep(): Promise<void> {
    while (!this.expiryAbort.signal.aborted) {
      const result = requireTuple(
        await this.client.eval(
          DUE_BLOCK_SNAPSHOT_SCRIPT,
          [ABUSE_BLOCK_DEADLINE_INDEX_KEY],
          [String(ABUSE_BLOCK_EXPIRY_BATCH_SIZE), ABUSE_BLOCK_RECORD_PREFIX],
        ),
        'expiry snapshot',
      );
      if (result.length !== 3 || result[0] !== 'ok' || !Array.isArray(result[2])) {
        throw storageCorruption('expiry snapshot');
      }
      const nowMs = parseNonNegativeRedisInteger(result[1], 'expiry snapshot current time');
      const rows = (result[2] as unknown[]).map((row) =>
        parseIndexedSnapshot(row, nowMs, 'expiry snapshot row'),
      );
      if (rows.length > ABUSE_BLOCK_EXPIRY_BATCH_SIZE) {
        throw storageCorruption('expiry snapshot count');
      }
      for (let index = 1; index < rows.length; index++) {
        if (compareAbuseBlockPosition(rows[index - 1]!, rows[index]!) >= 0) {
          throw storageCorruption('expiry snapshot order');
        }
      }
      for (const row of rows) {
        if (
          row.blockedUntilMs > nowMs ||
          (row.record !== null && isLiveAbuseBlock(row.record, nowMs))
        ) {
          throw storageCorruption('expiry snapshot live record');
        }
      }
      if (rows.length > 0) await this.deleteStaleSnapshots(rows);
      if (rows.length < ABUSE_BLOCK_EXPIRY_BATCH_SIZE) return;
      await yieldToEventLoop(undefined, { signal: this.expiryAbort.signal }).catch((error) => {
        if (!this.expiryAbort.signal.aborted) throw error;
      });
    }
  }
}

function parsePageSnapshot(
  value: unknown,
  params: AbuseBlockPageParams,
): {
  readonly blocks: readonly AbuseBlockRecord[];
  readonly nextCursor: string | null;
  readonly stale: readonly IndexedBlockSnapshot[];
} {
  const result = requireTuple(value, 'page snapshot');
  if (result.length !== 10 || result[0] !== 'ok' || !Array.isArray(result[9])) {
    throw storageCorruption('page snapshot');
  }
  const nowMs = parseNonNegativeRedisInteger(result[1], 'page snapshot current time');
  const cursorRaw = parseOptionalString(result[2], result[3], 'page snapshot cursor record');
  const cursorScoreRaw = parseOptionalString(result[4], result[5], 'page snapshot cursor score');
  const inputCursor =
    params.cursor === null
      ? null
      : (() => {
          const decoded = decodeAbuseBlockCursor(params.cursor);
          return {
            identity: { scope: decoded.scope, subject: decoded.subject },
            blockedUntilMs: decoded.blockedUntilMs,
          };
        })();
  if (inputCursor === null) {
    if (cursorRaw !== null || cursorScoreRaw !== null) {
      throw storageCorruption('page snapshot unexpected cursor state');
    }
  } else {
    validateCursorSnapshot(inputCursor.identity, cursorRaw, cursorScoreRaw, nowMs);
  }

  const rows = (result[9] as unknown[]).map((row) =>
    parseIndexedSnapshot(row, nowMs, 'page snapshot row'),
  );
  if (rows.length > params.limit) throw storageCorruption('page snapshot limit');
  for (let index = 1; index < rows.length; index++) {
    if (compareAbuseBlockPosition(rows[index - 1]!, rows[index]!) >= 0) {
      throw storageCorruption('page snapshot order');
    }
  }
  if (
    inputCursor !== null &&
    rows.some((row) => compareAbuseBlockPosition(row, inputCursor) <= 0)
  ) {
    throw storageCorruption('page snapshot cursor order');
  }

  const hasMore = result[6] === '1';
  if (!hasMore && result[6] !== '0') throw storageCorruption('page snapshot hasMore');
  const nextMember = requireString(result[7], 'page snapshot next member');
  const nextScoreRaw = requireString(result[8], 'page snapshot next score');
  let nextCursor: string | null = null;
  if (hasMore) {
    if (rows.length !== params.limit || rows.length === 0) {
      throw storageCorruption('page snapshot next cursor count');
    }
    const last = rows[rows.length - 1]!;
    if (last.member !== nextMember || last.scoreRaw !== nextScoreRaw) {
      throw storageCorruption('page snapshot next cursor');
    }
    nextCursor = encodeAbuseBlockCursor({
      identity: decodeAbuseBlockMember(nextMember),
      blockedUntilMs: last.blockedUntilMs,
    });
  } else if (nextMember !== '' || nextScoreRaw !== '') {
    throw storageCorruption('page snapshot next cursor');
  }

  return {
    blocks: rows.flatMap((row) =>
      row.record === null || row.blockedUntilMs <= nowMs ? [] : [row.record],
    ),
    nextCursor,
    stale: rows.filter((row) => row.record === null || row.blockedUntilMs <= nowMs),
  };
}

function validateCursorSnapshot(
  identity: AbuseBlockIdentity,
  raw: string | null,
  scoreRaw: string | null,
  nowMs: number,
): void {
  const member = abuseBlockMember(identity);
  if (raw === null) {
    if (scoreRaw !== null && parsePositiveRedisInteger(scoreRaw, 'page cursor score') > nowMs) {
      throw storageCorruption('page live cursor record');
    }
    return;
  }
  if (scoreRaw === null) throw storageCorruption('page cursor index');
  const score = parsePositiveRedisInteger(scoreRaw, 'page cursor score');
  const record = decodeStoredBlockRecord(raw, 'page cursor record');
  if (abuseBlockMember(record.identity) !== member || record.blockedUntilMs !== score) {
    throw storageCorruption('page cursor identity');
  }
}

function parseIndexedSnapshot(value: unknown, nowMs: number, label: string): IndexedBlockSnapshot {
  const row = requireTuple(value, label);
  if (row.length !== 4) throw storageCorruption(label);
  const member = requireString(row[0], `${label} member`);
  const identity = decodeAbuseBlockMember(member);
  const scoreRaw = requireString(row[1], `${label} score`);
  const score = parsePositiveRedisInteger(scoreRaw, `${label} score`);
  const raw = parseOptionalString(row[2], row[3], `${label} record`);
  if (raw === null) {
    if (score > nowMs) throw storageCorruption(`${label} live index`);
    return { identity, member, scoreRaw, blockedUntilMs: score, raw: null, record: null };
  }
  const record = decodeStoredBlockRecord(raw, label);
  if (abuseBlockMember(record.identity) !== member || record.blockedUntilMs !== score) {
    throw storageCorruption(`${label} identity`);
  }
  return { identity, member, scoreRaw, blockedUntilMs: score, raw, record };
}

function parseOptionalString(marker: unknown, value: unknown, label: string): string | null {
  if (marker === '0') {
    if (value !== '') throw storageCorruption(label);
    return null;
  }
  if (marker !== '1' || typeof value !== 'string') throw storageCorruption(label);
  return value;
}

function decodeStoredBlockRecord(raw: string, operation: string): AbuseBlockRecord {
  try {
    return decodeAbuseBlockRecord(raw);
  } catch {
    throw storageCorruption(operation);
  }
}

function requireTuple(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw storageCorruption(label);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw storageCorruption(label);
  return value;
}

function parsePositiveRedisInteger(value: unknown, label: string): number {
  const parsed = parseNonNegativeRedisInteger(value, label);
  if (parsed <= 0) throw storageCorruption(label);
  return parsed;
}

function parseNonNegativeRedisInteger(value: unknown, label: string): number {
  const raw =
    typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === 'string'
        ? value
        : '';
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw storageCorruption(label);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw storageCorruption(label);
  return parsed;
}

function storageCorruption(operation: string): AbuseBlockStorageCorruptionError {
  return new AbuseBlockStorageCorruptionError(
    `Redis abuse block storage is corrupt during ${operation}`,
  );
}
