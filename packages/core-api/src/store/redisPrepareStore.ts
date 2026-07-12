/**
 * RedisPrepareStore — Redis-backed PrepareStoreAdapter for horizontal scaling.
 *
 * Implements the same semantics as MemoryPrepareStore:
 *   - Single-use consume (atomic via Lua)
 *   - IP concurrency enforcement (max outstanding per IP)
 *   - Verified sender outstanding-prepare quota at nonce reservation
 *   - TTL-based expiry (Lua-side + Redis PX fallback)
 *
 * Key layout:
 *   {prefix}{receiptId}             → JSON(SerializedEntry)
 *                                      PX = ttlMs + PREPARE_STORE_KEY_TTL_GRACE_MS
 *   {prefix}ip:{clientIp}           → JSON([{pid, t}])
 *                                      PX = ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER
 *   {prefix}sender:{senderAddress}  → JSON([{pid, t, nonce}] plus
 *                                      pending [{pid, nonce, pending, t}])
 *                                      PX = ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER
 *   {prefix}user:{userId}           → JSON([{pid, t}]) for promotion mode
 *                                      PX = ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER
 *
 * TTL expiry slot release policy:
 *   STORE stamps issuedAt from Redis TIME. Peek/consume compare that value
 *   against Redis TIME, so no Host-local wall clock participates.
 *   On abandon (no consume call), RedisSponsorPool lease TTL auto-releases the
 *   slot after the prepare TTL plus sponsor-lease grace. See operations.md for
 *   details.
 *
 * References:
 *   prepareTypes.ts — PrepareStoreAdapter interface
 *   memoryPrepareStore.ts — Memory reference implementation
 *   redisSponsorPool.ts — Redis adapter pattern
 */
import {
  assertCurrentPreparedTxEntryKeys,
  parseCurrentPreparedTxDraft,
  parseCurrentPreparedTxEntry,
  type PreparedTxDraft,
  type PreparedTxEntry,
  type PrepareStoreAdapter,
} from './prepareTypes.js';
import type { RedisClientLike } from './redisClient.js';
import { logSponsorPoolEvent } from '../sponsorPoolEventLog.js';
import { SPONSOR_POOL_SLOT_INFO_UNRECOVERABLE } from '../observability/events.js';
import {
  invokeEvictCallback,
  invokeReleaseCallback,
  type OnEntryEvictCallback,
  type OnReleaseCallback,
} from './prepareStoreCallbacks.js';
import { PREPARE_TTL_MS } from '../preparePolicy.js';
import {
  MAX_CONCURRENT_PER_IP,
  MAX_OUTSTANDING_PER_SENDER,
  MAX_OUTSTANDING_PER_STUDIO_USER,
} from './memoryPrepareStore.js';
import { PrepareSenderQuotaError, PrepareStudioUserQuotaError } from './prepareErrors.js';

/** Extra physical receipt-key TTL after logical prepare expiry. */
const PREPARE_STORE_KEY_TTL_GRACE_MS = 5_000;
/** Physical TTL multiplier for Redis prepare-store index keys. */
const PREPARE_STORE_INDEX_TTL_MULTIPLIER = 2;

// ─────────────────────────────────────────────
// Lua scripts
// ─────────────────────────────────────────────

/**
 * STORE_SCRIPT — atomically stores an entry and enforces IP plus the
 * promotion-only studio-user outstanding-prepare quota. The sender index
 * is live-compacted on every store regardless of mode. Verified sender
 * outstanding-prepare quota is enforced by the reserveNonce script after
 * prepare authorization and before adding a pending reservation.
 *
 * KEYS[1] = entry key, KEYS[2] = ip key, KEYS[3] = sender key,
 * KEYS[4] = user key (promotion-only; pass empty string for generic)
 * ARGV[1] = draft JSON, ARGV[2] = entryPxMs, ARGV[3] = maxPerIp
 * ARGV[4] = ipPxMs, ARGV[5] = prefix
 * ARGV[6] = maxPerStudioUser, ARGV[7] = senderPxMs
 * ARGV[8] = ttlMs, ARGV[9] = userPxMs
 *
 * The sponsor pool commits
 * `HMAC(secret, receiptId || sponsorAddress || commitDigest)` to its lease
 * store — reserved at `checkout()` and then replaced with the
 * prepare-commit hash (`txBytesHash`) by the prepare runner's
 * `sponsorPool.commit()` call — so the prepare store does not persist
 * any lease material itself. Release callbacks use
 * `(sponsorAddress, receiptId, txBytesHash)` so the pool CAS can verify the
 * committed HMAC proof before deleting the slot; `receiptId` is already
 * tracked as `pid` in each IP/sender entry, and the committed
 * `txBytesHash` is read from the stored entry (or the raw JSON in
 * corrupt-entry recovery) by the TS layer before forwarding.
 *
 * Returns:
 *   '__user_quota__'                  if promotion-mode user quota exceeded (entry NOT stored)
 *   {issuedAt, JSON array of evicted [{pid, entryJson}]} on success
 */
const STORE_SCRIPT = `
-- RedisPrepareStore STORE_SCRIPT
local entryKey = KEYS[1]
local ipKey = KEYS[2]
local senderKey = KEYS[3]
local userKey = KEYS[4]
local draftJson = ARGV[1]
local entryPx = tonumber(ARGV[2])
local maxPerIp = tonumber(ARGV[3])
local ipPx = tonumber(ARGV[4])
local prefix = ARGV[5]
local maxPerStudioUser = tonumber(ARGV[6])
local senderPx = tonumber(ARGV[7])
local ttlMs = tonumber(ARGV[8])
local userPx = tonumber(ARGV[9])

-- Decode and validate every caller-controlled value before the first write.
-- Redis does not roll back writes that precede a Lua runtime error.
local draft = cjson.decode(draftJson)
if type(draft) ~= 'table'
  or type(draft.receiptId) ~= 'string'
  or type(draft.nonce) ~= 'string'
  or (draft.mode ~= 'generic' and draft.mode ~= 'promotion') then
  error('invalid prepared draft')
end
local pid = draft.receiptId
local nonce = draft.nonce
local entryMode = draft.mode

local timeResult = redis.call('TIME')
local nowMs = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)
local issuedAt = nowMs

-- Sender index — live-compact regardless of mode. The sender index
-- carries S-14 nonce coordination and replay protection; it is keyed by
-- Sui address and updated for every entry.
local senderRaw = redis.call('GET', senderKey)
local senderList = {}
if senderRaw then
  senderList = cjson.decode(senderRaw)
end
local liveSender = {}
for _, item in ipairs(senderList) do
  if type(item) == 'table'
    and type(item.pid) == 'string'
    and type(item.t) == 'number'
    and type(item.nonce) == 'string' then
    if item.pending == true then
      if item.t + ttlMs < nowMs then
        -- Stale pending reservation — drop
      else
        liveSender[#liveSender + 1] = {
          pid = item.pid,
          nonce = item.nonce,
          pending = true,
          t = item.t,
        }
      end
    elseif item.pending == nil then
      if item.t + ttlMs < nowMs then
        -- Logical TTL expired — drop even if physical key still exists
      elseif redis.call('EXISTS', prefix .. item.pid) == 1 then
        liveSender[#liveSender + 1] = { pid = item.pid, nonce = item.nonce, t = item.t }
      end
    end
  end
end

-- Studio user quota — only enforced for promotion mode. The user index
-- is keyed by verified developer JWT userId and only contains promotion
-- entries. Generic mode never populates this index, so cross-mode
-- contamination is structurally impossible.
local liveUser = {}
if entryMode == 'promotion' and userKey ~= '' then
  local userRaw = redis.call('GET', userKey)
  if userRaw then
    local userList = cjson.decode(userRaw)
    for _, item in ipairs(userList) do
      if type(item) == 'table' and type(item.pid) == 'string' and type(item.t) == 'number' then
        if item.t + ttlMs < nowMs then
          -- Logical TTL expired — drop
        elseif redis.call('EXISTS', prefix .. item.pid) == 1 then
          liveUser[#liveUser + 1] = { pid = item.pid, t = item.t }
        end
      end
    end
  end
  if #liveUser >= maxPerStudioUser then
    return '__user_quota__'
  end
end

-- IP concurrency index. Decode and determine every eviction before any
-- durable mutation so corrupt JSON cannot leave an entry without indexes.
local ipRaw = redis.call('GET', ipKey)
local list = {}
if ipRaw then
  list = cjson.decode(ipRaw)
end

local live = {}
for _, item in ipairs(list) do
  if type(item) == 'table'
    and type(item.pid) == 'string'
    and type(item.t) == 'number'
    and redis.call('EXISTS', prefix .. item.pid) == 1 then
    live[#live + 1] = { pid = item.pid, t = item.t }
  end
end

local evicted = {}
while #live >= maxPerIp do
  local oldest = table.remove(live, 1)
  -- GET can fail with WRONGTYPE under Redis corruption, so it also belongs
  -- to the read-only preflight section.
  local evictedEntryJson = redis.call('GET', prefix .. oldest.pid)
  evicted[#evicted + 1] = { pid = oldest.pid, entryJson = evictedEntryJson or '' }
end

live[#live + 1] = { pid = pid, t = issuedAt }

local evictedPids = {}
for _, ev in ipairs(evicted) do
  evictedPids[ev.pid] = true
end

-- Build every derived projection in memory before the first write.
local updatedSender = {}
for _, item in ipairs(liveSender) do
  if item.pid ~= pid and not evictedPids[item.pid] then
    updatedSender[#updatedSender + 1] = item
  end
end
updatedSender[#updatedSender + 1] = { pid = pid, t = issuedAt, nonce = nonce }

local updatedUser = nil
if entryMode == 'promotion' and userKey ~= '' then
  updatedUser = {}
  for _, item in ipairs(liveUser) do
    if item.pid ~= pid and not evictedPids[item.pid] then
      updatedUser[#updatedUser + 1] = item
    end
  end
  updatedUser[#updatedUser + 1] = { pid = pid, t = issuedAt }
end

draft.issuedAt = issuedAt
local entryJson = cjson.encode(draft)
local encodedIp = cjson.encode(live)
local encodedSender = cjson.encode(updatedSender)
local encodedUser = nil
if updatedUser then
  encodedUser = cjson.encode(updatedUser)
end
local encodedEvicted = cjson.encode(evicted)

-- Mutation section. All data-dependent decode/read/encode work completed
-- above, so corrupt derived state rejects without a partial commit.
for _, ev in ipairs(evicted) do
  redis.call('DEL', prefix .. ev.pid)
end
redis.call('SET', entryKey, entryJson, 'PX', entryPx)
redis.call('SET', ipKey, encodedIp, 'PX', ipPx)
redis.call('SET', senderKey, encodedSender, 'PX', senderPx)

-- Update user index for promotion entries (Studio outstanding-prepare quota).
if encodedUser then
  redis.call('SET', userKey, encodedUser, 'PX', userPx)
end

return { tostring(issuedAt), encodedEvicted }
`;

/**
 * PEEK_SCRIPT — one Redis-clock-authoritative logical TTL read.
 *
 * Corrupt JSON or an invalid/missing issuedAt is returned unchanged so the
 * TypeScript current-shape decoder throws and the sponsor lifecycle can call
 * evictPreparedEntry() for best-effort lease release.
 */
const PEEK_SCRIPT = `
-- RedisPrepareStore PEEK_SCRIPT
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end

local decoded, entry = pcall(cjson.decode, raw)
if not decoded or type(entry) ~= 'table' or type(entry.issuedAt) ~= 'number' then
  return raw
end

local ttlMs = tonumber(ARGV[1])
local timeResult = redis.call('TIME')
local nowMs = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)
if entry.issuedAt + ttlMs < nowMs then
  return nil
end
return raw
`;

/**
 * CHECK_USER_QUOTA_SCRIPT — counts live promotion-mode entries for a
 * userId using the same live-entry semantics as STORE_SCRIPT, so the
 * precheck and the authoritative store-time quota agree on which
 * entries count when reading the same Redis snapshot. Concurrent
 * stores between precheck and `store()` remain possible —
 * STORE_SCRIPT is the only authoritative gate, this script is a
 * best-effort guard before slot/RPC resources are consumed.
 *
 * Live condition (matches STORE_SCRIPT's `liveUser` build):
 *   - `item.t + ttlMs >= nowMs`  (logical TTL not exceeded), AND
 *   - `EXISTS prefix .. item.pid` (entry key still present).
 *
 * Entries whose physical key survives the logical TTL inside the
 * `PREPARE_STORE_KEY_TTL_GRACE_MS` window MUST NOT count toward the
 * quota, otherwise the precheck false-rejects new prepares that
 * STORE_SCRIPT would accept.
 *
 * Cost: returns as soon as `live >= maxPerStudioUser`. Logically
 * expired and missing-entry-key items do not advance `live`, so the
 * worst case (e.g. the entire index is stale) still iterates the full
 * user-index list.
 *
 * KEYS[1] = user key (caller resolves the empty-userKey case in TS)
 * ARGV[1] = prefix, ARGV[2] = ttlMs, ARGV[3] = maxPerStudioUser
 * Returns: integer live count (capped at maxPerStudioUser when exceeded).
 */
const CHECK_USER_QUOTA_SCRIPT = `
local userKey = KEYS[1]
local prefix = ARGV[1]
local ttlMs = tonumber(ARGV[2])
local maxPerStudioUser = tonumber(ARGV[3])

local userRaw = redis.call('GET', userKey)
if not userRaw then return 0 end

local userList = cjson.decode(userRaw)
local timeResult = redis.call('TIME')
local nowMs = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)

local live = 0
for _, item in ipairs(userList) do
  if item.t and (item.t + ttlMs < nowMs) then
    -- Logical TTL expired — drop even if physical key still exists
  elseif redis.call('EXISTS', prefix .. item.pid) == 1 then
    live = live + 1
    if live >= maxPerStudioUser then
      return live
    end
  end
end

return live
`;

/**
 * EVICT_PREPARED_ENTRY_SCRIPT — atomically removes one prepared entry
 * and all Redis-side index references recoverable from its JSON.
 *
 * KEYS[1] = entry key
 * ARGV[1] = receiptId, ARGV[2] = prefix, ARGV[3] = ttlMs
 *
 * Returns the raw entry JSON for slot release evidence, or nil when the
 * entry is already absent. Malformed JSON still deletes the entry key;
 * parseable current/unsupported shapes also clean IP, sender, and
 * promotion-user indexes in the same Redis snapshot.
 */
const EVICT_PREPARED_ENTRY_SCRIPT = `
local entryKey = KEYS[1]
local pid = ARGV[1]
local prefix = ARGV[2]
local ttlMs = tonumber(ARGV[3])

local raw = redis.call('GET', entryKey)
if not raw then return nil end
redis.call('DEL', entryKey)

local ok, entry = pcall(cjson.decode, raw)
if not ok or type(entry) ~= 'table' then
  return raw
end

local timeResult = redis.call('TIME')
local nowMs = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)

local function rewriteList(key, removePid, indexKind)
  if not key or key == '' then return end
  local listRaw = redis.call('GET', key)
  if not listRaw then return end
  local decodedOk, list = pcall(cjson.decode, listRaw)
  if not decodedOk or type(list) ~= 'table' then return end

  local updated = {}
  for _, item in ipairs(list) do
    if type(item) == 'table'
      and type(item.pid) == 'string'
      and item.pid ~= removePid
      and type(item.t) == 'number' then
      if indexKind == 'sender' then
        if item.pending == true and type(item.nonce) == 'string' then
          if item.t + ttlMs >= nowMs then
            updated[#updated + 1] = {
              pid = item.pid,
              nonce = item.nonce,
              pending = true,
              t = item.t,
            }
          end
        elseif item.pending == nil and type(item.nonce) == 'string' then
          if item.t + ttlMs < nowMs then
            -- Logical TTL expired — drop
          elseif redis.call('EXISTS', prefix .. item.pid) == 1 then
            updated[#updated + 1] = { pid = item.pid, nonce = item.nonce, t = item.t }
          end
        end
      elseif item.t + ttlMs < nowMs then
        -- Logical TTL expired — drop
      elseif redis.call('EXISTS', prefix .. item.pid) == 1 then
        updated[#updated + 1] = { pid = item.pid, t = item.t }
      end
    end
  end

  if #updated == 0 then
    redis.call('DEL', key)
  else
    redis.call('SET', key, cjson.encode(updated), 'KEEPTTL')
  end
end

-- The entry has already been deleted, so cleanup of derived indexes must
-- never prevent the raw lease evidence from being returned. Invalid field
-- types and malformed index rows are simply not recoverable here; pcall
-- contains any remaining Redis/Lua error to this best-effort cleanup.
if type(entry.clientIp) == 'string' then
  pcall(rewriteList, prefix .. 'ip:' .. entry.clientIp, pid, 'ip')
end
if type(entry.senderAddress) == 'string' then
  pcall(rewriteList, prefix .. 'sender:' .. entry.senderAddress, pid, 'sender')
end
if entry.mode == 'promotion' and type(entry.userId) == 'string' then
  pcall(rewriteList, prefix .. 'user:' .. entry.userId, pid, 'user')
end

return raw
`;

// CONSUME_SCRIPT is defined at the bottom of the file as CONSUME_SCRIPT_WITH_IP
// because it needs to extract clientIp from the entry JSON to build the ip key.

// ─────────────────────────────────────────────
// Serialization helpers
// ─────────────────────────────────────────────

const DECIMAL_BIGINT_RE = /^(?:0|[1-9]\d*)$/;

function parseSerializedBigInt(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !DECIMAL_BIGINT_RE.test(value)) {
    throw new Error(`RedisPrepareStore: ${field} must be a canonical unsigned decimal string`);
  }
  return BigInt(value);
}

function parseRedisBigIntResult(value: unknown, field: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`RedisPrepareStore: ${field} must be a non-negative safe integer`);
    }
    return BigInt(value);
  }
  return parseSerializedBigInt(value, field);
}

/**
 * Validate a Lua integer return value (e.g. a quota count) from
 * `_client.eval()`. node-redis (v4, v5) and ioredis both return Lua
 * integers as JS `number` today, so the `number` branch is the only
 * one observed in current production wiring. The `bigint` and numeric
 * `string` branches keep callers from coupling to one client's
 * Lua-result encoding.
 *
 * Throws on anything else (null, NaN, fractional, negative, non-numeric
 * string). The precheck path interprets the parsed value against the
 * quota threshold, so silently coercing garbage to `0` would mask a
 * malformed Lua result as 'ok' and let store() be reached on bad state.
 */
function parseRedisIntegerResult(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`RedisPrepareStore: ${field} must be a non-negative safe integer`);
    }
    return value;
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `RedisPrepareStore: ${field} bigint must fit in non-negative safe-integer range`,
      );
    }
    return Number(value);
  }
  if (typeof value === 'string' && DECIMAL_BIGINT_RE.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new Error(`RedisPrepareStore: ${field} must be a non-negative safe integer`);
    }
    return n;
  }
  throw new Error(
    `RedisPrepareStore: ${field} must be a non-negative integer Lua result (got ${typeof value})`,
  );
}

function serializeDraft(draft: PreparedTxDraft): string {
  const common = {
    mode: draft.mode,
    receiptId: draft.receiptId,
    senderAddress: draft.senderAddress,
    txBytesHash: draft.txBytesHash,
    sponsorAddress: draft.sponsorAddress,
    clientIp: draft.clientIp,
    executionPathKey: draft.executionPathKey,
    orderId: draft.orderId,
    nonce: draft.nonce.toString(),
  };
  if (draft.mode === 'generic') {
    return JSON.stringify(common);
  }
  return JSON.stringify({
    ...common,
    mode: 'promotion',
    promotionId: draft.promotionId,
    userId: draft.userId,
    reservedGasMist: draft.reservedGasMist.toString(),
  });
}

interface StoreScriptResult {
  readonly issuedAt: number;
  readonly evictedRaw: unknown;
}

function parseStoreScriptResult(value: unknown): StoreScriptResult {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error('RedisPrepareStore: STORE script returned an invalid result');
  }
  const rawIssuedAt = value[0];
  const issuedAt =
    typeof rawIssuedAt === 'number'
      ? rawIssuedAt
      : typeof rawIssuedAt === 'string'
        ? Number(rawIssuedAt)
        : Number.NaN;
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    throw new Error('RedisPrepareStore: STORE script returned an invalid issuedAt');
  }
  return { issuedAt, evictedRaw: value[1] };
}

interface StoreEvictedEntry {
  readonly pid: string;
  readonly entryJson: string;
}

/**
 * Decode derived eviction evidence without changing the committed store result.
 * The Lua script generated this value before mutation; an unexpected client
 * result is operational corruption, not grounds to turn a durable success into
 * a failed prepare response.
 */
function parseStoreEvictedEntries(value: unknown): StoreEvictedEntry[] {
  if (value === '[]' || value === '{}') return [];
  if (typeof value !== 'string') {
    logUnrecoverableStoreEvictionResult();
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    logUnrecoverableStoreEvictionResult();
    return [];
  }
  if (!Array.isArray(parsed)) {
    logUnrecoverableStoreEvictionResult();
    return [];
  }

  const entries: StoreEvictedEntry[] = [];
  let malformed = false;
  for (const item of parsed) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as { pid?: unknown }).pid !== 'string' ||
      typeof (item as { entryJson?: unknown }).entryJson !== 'string'
    ) {
      malformed = true;
      continue;
    }
    entries.push(item as StoreEvictedEntry);
  }
  if (malformed) logUnrecoverableStoreEvictionResult();
  return entries;
}

function logUnrecoverableStoreEvictionResult(): void {
  try {
    logSponsorPoolEvent(
      SPONSOR_POOL_SLOT_INFO_UNRECOVERABLE,
      {
        adapter: 'redis-prepare',
        reason: 'ip_concurrent_eviction_result_unrecoverable',
      },
      'warn',
    );
  } catch {
    // Observability failure after the Lua commit must not change success.
  }
}

/**
 * Best-effort recovery of sponsor identity from a raw JSON entry that we
 * cannot fully deserialize.
 *
 * This is the lease-cleanup safety net. Even if `deserializeEntry()` throws,
 * consume()/peek() callers still release a recoverable sponsor-address lease.
 *
 * Extracts `sponsorAddress` and `txBytesHash`; `receiptId` comes from the
 * Redis key/method argument that selected the row, never from corrupt JSON.
 * `txBytesHash` is returned as a string when present on the raw JSON and
 * as `null` when absent. Callers pass the
 * returned `txBytesHash` straight into `checkin()`; the pool's HMAC CAS
 * will silently no-op for stale values and the Redis lease PX TTL
 * covers the residual state.
 *
 * Returns null if `sponsorAddress` cannot be extracted from the raw shape.
 * JSON-level parse failure also yields null.
 */
function extractSponsorInfoFromRawEntry(
  json: string,
  authoritativeReceiptId: string,
): { sponsorAddress: string; receiptId: string; txBytesHash: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const sponsorAddress = obj.sponsorAddress;
  if (typeof sponsorAddress !== 'string' || sponsorAddress.length === 0) return null;
  const txBytesHash = typeof obj.txBytesHash === 'string' ? obj.txBytesHash : null;
  return { sponsorAddress, receiptId: authoritativeReceiptId, txBytesHash };
}

function deserializeEntry(json: string, expectedReceiptId: string): PreparedTxEntry {
  const raw: unknown = JSON.parse(json);
  const mode = assertCurrentPreparedTxEntryKeys(raw);
  const obj = raw as Record<string, unknown>;
  if (obj.receiptId !== expectedReceiptId) {
    throw new Error('RedisPrepareStore: stored receiptId does not match its Redis key');
  }
  const converted: Record<string, unknown> = {
    ...obj,
    nonce: parseSerializedBigInt(obj.nonce, 'nonce'),
  };
  if (mode === 'promotion') {
    converted.reservedGasMist = parseSerializedBigInt(obj.reservedGasMist, 'reservedGasMist');
  }
  return parseCurrentPreparedTxEntry(converted);
}

// ─────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────

export interface RedisPrepareStoreOptions {
  keyPrefix?: string;
  ttlMs?: number;
  maxPerIp?: number;
  maxPerStudioUser?: number;
  maxOutstandingPerSender?: number;
}

// ─────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────

/**
 * Redis-backed PrepareStoreAdapter for horizontal scaling.
 *
 * Uses Lua scripts via `eval` for atomic operations.
 * Does NOT require ZSET or other commands beyond `RedisClientLike`.
 */
export class RedisPrepareStore implements PrepareStoreAdapter {
  private readonly _client: RedisClientLike;
  private readonly _onRelease: OnReleaseCallback;
  private readonly _onEntryEvict?: OnEntryEvictCallback;
  private readonly _keyPrefix: string;
  private readonly _ttlMs: number;
  private readonly _maxPerIp: number;
  private readonly _maxPerStudioUser: number;
  private readonly _maxOutstandingPerSender: number;

  /**
   * @param onRelease Two-stage lease signature:
   *                  `(sponsorAddress, receiptId, txBytesHash) =>
   *                     sponsorPool.checkin(sponsorAddress, receiptId, txBytesHash)`.
   *                  Store release paths always pass the committed
   *                  `txBytesHash` from the deserialized entry (or
   *                  whatever the raw-entry extractor can recover),
   *                  which is the prepare commit the lease was
   *                  promoted to via `sponsorPool.commit()`. The
   *                  corrupt-entry safety net may pass `null` if the
   *                  raw JSON has no recoverable `txBytesHash`; the
   *                  pool's CAS then silently no-ops and the Redis
   *                  lease PX TTL covers residual state.
   */
  constructor(
    client: RedisClientLike,
    onRelease: OnReleaseCallback,
    options: RedisPrepareStoreOptions = {},
    onEntryEvict?: OnEntryEvictCallback,
  ) {
    const ttlMs = options.ttlMs ?? PREPARE_TTL_MS;
    const maxPerIp = options.maxPerIp ?? MAX_CONCURRENT_PER_IP;
    const maxPerStudioUser = options.maxPerStudioUser ?? MAX_OUTSTANDING_PER_STUDIO_USER;
    const maxOutstandingPerSender = options.maxOutstandingPerSender ?? MAX_OUTSTANDING_PER_SENDER;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('RedisPrepareStore: ttlMs must be > 0 and a safe integer');
    }
    if (ttlMs > Math.floor(Number.MAX_SAFE_INTEGER / PREPARE_STORE_INDEX_TTL_MULTIPLIER)) {
      throw new Error('RedisPrepareStore: ttlMs overflows derived TTL range');
    }
    if (!Number.isSafeInteger(maxPerIp) || maxPerIp < 1) {
      throw new Error('RedisPrepareStore: maxPerIp must be >= 1 and a safe integer');
    }
    if (!Number.isSafeInteger(maxPerStudioUser) || maxPerStudioUser < 1) {
      throw new Error('RedisPrepareStore: maxPerStudioUser must be >= 1 and a safe integer');
    }
    if (!Number.isSafeInteger(maxOutstandingPerSender) || maxOutstandingPerSender < 1) {
      throw new Error('RedisPrepareStore: maxOutstandingPerSender must be >= 1 and a safe integer');
    }

    this._client = client;
    this._onRelease = onRelease;
    this._onEntryEvict = onEntryEvict;
    this._keyPrefix = options.keyPrefix ?? 'stelis:prepare:';
    this._ttlMs = ttlMs;
    this._maxPerIp = maxPerIp;
    this._maxPerStudioUser = maxPerStudioUser;
    this._maxOutstandingPerSender = maxOutstandingPerSender;
  }

  // ── Key helpers ──────────────────────────────────────────────────

  private entryKey(receiptId: string): string {
    return `${this._keyPrefix}${receiptId}`;
  }

  private ipKey(clientIp: string): string {
    return `${this._keyPrefix}ip:${clientIp}`;
  }

  private senderKey(senderAddress: string): string {
    return `${this._keyPrefix}sender:${senderAddress}`;
  }

  private userKey(userId: string): string {
    return `${this._keyPrefix}user:${userId}`;
  }

  // ── PrepareStoreAdapter methods ──────────────────────────────────

  async store(draft: PreparedTxDraft): Promise<PreparedTxEntry> {
    const currentDraft = parseCurrentPreparedTxDraft(draft);
    const receiptId = currentDraft.receiptId;
    const draftJson = serializeDraft(currentDraft);
    const entryPxMs = this._ttlMs + PREPARE_STORE_KEY_TTL_GRACE_MS;
    const ipPxMs = this._ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER;
    const senderPxMs = this._ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER;
    const userPxMs = this._ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER;
    // Empty userKey for non-promotion entries — Lua skips the user-index
    // branches when userKey == ''. The KEYS array length stays uniform so
    // shared-key naming stays deterministic regardless of runtime mode.
    const userKey = currentDraft.mode === 'promotion' ? this.userKey(currentDraft.userId) : '';

    const result = await this._client.eval(
      STORE_SCRIPT,
      [
        this.entryKey(receiptId),
        this.ipKey(currentDraft.clientIp),
        this.senderKey(currentDraft.senderAddress),
        userKey,
      ],
      [
        draftJson,
        String(entryPxMs),
        String(this._maxPerIp),
        String(ipPxMs),
        this._keyPrefix,
        String(this._maxPerStudioUser),
        String(senderPxMs),
        String(this._ttlMs),
        String(userPxMs),
      ],
    );

    // User quota exceeded — slot NOT released here (outer catch owns cleanup).
    if (result === '__user_quota__') {
      // Promotion-only path; userId is present.
      const userId =
        currentDraft.mode === 'promotion' ? currentDraft.userId : currentDraft.senderAddress;
      throw new PrepareStudioUserQuotaError(userId, this._maxPerStudioUser);
    }

    const storeResult = parseStoreScriptResult(result);
    const committed = parseCurrentPreparedTxEntry({
      ...currentDraft,
      issuedAt: storeResult.issuedAt,
    });

    // Release slots for IP-evicted entries
    // Derived evidence decoding is intentionally non-throwing: the new entry
    // is already durably committed when eval returns.
    const evicted = parseStoreEvictedEntries(storeResult.evictedRaw);
    for (const item of evicted) {
      // Slot release — best effort, independent of coordinator cleanup.
      // `item.pid` is the evicted entry's receiptId. We also need the
      // committed `txBytesHash` to satisfy the pool's CAS.
      // The evictedEntry JSON carries it, so parse once and pass.
      let evictedEntry: PreparedTxEntry | null = null;
      if (item.entryJson) {
        try {
          evictedEntry = deserializeEntry(item.entryJson, item.pid);
        } catch {
          void this._releaseSponsorFromRawEntry(item.entryJson, item.pid, 'ip_concurrent_eviction');
        }
      } else {
        void this._releaseSponsorFromRawEntry('', item.pid, 'ip_concurrent_eviction');
      }
      if (evictedEntry) {
        void invokeReleaseCallback({
          onRelease: this._onRelease,
          sponsorAddress: evictedEntry.sponsorAddress,
          receiptId: evictedEntry.receiptId,
          txBytesHash: evictedEntry.txBytesHash,
          adapter: 'redis-prepare',
          reason: 'ip_concurrent_eviction',
          extraFields: { evicted_receipt_id: item.pid },
        });
      }

      // Coordinator cleanup — runs independently of slot release outcome.
      if (this._onEntryEvict && evictedEntry) {
        invokeEvictCallback({
          onEntryEvict: this._onEntryEvict,
          entry: evictedEntry,
          adapter: 'redis-prepare',
          reason: 'ip_concurrent_eviction',
        });
      }
    }
    return committed;
  }

  /**
   * Best-effort sponsor-address release for entries we cannot fully deserialize.
   * Used by consume() and peek() to keep lease cleanup safe even when
   * `deserializeEntry()` rejects the current shape.
   *
   * The Lua CONSUME script has already removed the entry from Redis at
   * this point, so without this fallback the held sponsor lease would
   * remain locked until its lease TTL expires.
   */
  private _releaseSponsorFromRawEntry(
    rawJson: string,
    authoritativeReceiptId: string,
    reason:
      | 'ip_concurrent_eviction'
      | 'prepare_expired_undeserializable'
      | 'hash_mismatch_undeserializable'
      | 'consume_success_undeserializable'
      | 'undeserializable_eviction',
  ): Promise<void> {
    const sponsor = extractSponsorInfoFromRawEntry(rawJson, authoritativeReceiptId);
    if (!sponsor) {
      // Cannot find sponsor identity — lease will only be reclaimed by TTL.
      // This is semantically distinct from a _LEASE_RELEASE_FAILED event:
      // there was no release attempt to succeed or fail. Keep it on a
      // separate structured event so operators can correlate with
      // lease-TTL reclamation without conflating failure families.
      try {
        logSponsorPoolEvent(
          SPONSOR_POOL_SLOT_INFO_UNRECOVERABLE,
          {
            adapter: 'redis-prepare',
            reason,
          },
          'warn',
        );
      } catch {
        // This helper is used only after Redis has already deleted or committed
        // durable state. Observability failure must not escape that boundary.
      }
      return Promise.resolve();
    }
    return invokeReleaseCallback({
      onRelease: this._onRelease,
      sponsorAddress: sponsor.sponsorAddress,
      receiptId: sponsor.receiptId,
      txBytesHash: sponsor.txBytesHash,
      adapter: 'redis-prepare',
      reason,
    });
  }

  async consume(
    receiptId: string,
    txBytesHash: string,
  ): Promise<PreparedTxEntry | 'not_found' | 'expired' | 'hash_mismatch'> {
    const entryKey = this.entryKey(receiptId);
    // We need the clientIp to build the ip key, but we don't have it.
    // The Lua script finds it from the entry JSON.
    // However, KEYS must be known at call time. We read the entry first
    // to get clientIp... but that breaks atomicity.
    //
    // Alternative: store clientIp in a secondary key or derive ip key
    // from entry. Since CONSUME needs the ip key but we don't have
    // clientIp at call time, we use a two-step approach:
    //   1. Lua GETs the entry, extracts clientIp, builds ip key internally
    //
    // Keep every Redis key reference explicit in KEYS[] for Lua reviewability.
    // For single-node Redis (our target), accessing dynamic keys in Lua is OK.
    // We pass a placeholder KEYS[2] and let Lua compute the real ip key.

    const result = await this._client.eval(
      CONSUME_SCRIPT_WITH_IP,
      [entryKey],
      [txBytesHash, String(this._ttlMs), receiptId, this._keyPrefix],
    );

    if (result === null || result === undefined) {
      return 'not_found';
    }

    const str = result as string;

    if (str.startsWith('__expired_entry__:')) {
      const entryJson = str.slice('__expired_entry__:'.length);
      // Slot cleanup must happen even if deserializeEntry throws.
      try {
        const expiredEntry = deserializeEntry(entryJson, receiptId);
        void invokeReleaseCallback({
          onRelease: this._onRelease,
          sponsorAddress: expiredEntry.sponsorAddress,
          receiptId: expiredEntry.receiptId,
          txBytesHash: expiredEntry.txBytesHash,
          adapter: 'redis-prepare',
          reason: 'prepare_expired',
        });
        if (this._onEntryEvict) {
          invokeEvictCallback({
            onEntryEvict: this._onEntryEvict,
            entry: expiredEntry,
            adapter: 'redis-prepare',
            reason: 'prepare_expired',
          });
        }
      } catch {
        void this._releaseSponsorFromRawEntry(
          entryJson,
          receiptId,
          'prepare_expired_undeserializable',
        );
      }
      return 'expired';
    }

    if (str.startsWith('__hash_mismatch_entry__:')) {
      const entryJson = str.slice('__hash_mismatch_entry__:'.length);
      try {
        const mismatchEntry = deserializeEntry(entryJson, receiptId);
        void invokeReleaseCallback({
          onRelease: this._onRelease,
          sponsorAddress: mismatchEntry.sponsorAddress,
          receiptId: mismatchEntry.receiptId,
          txBytesHash: mismatchEntry.txBytesHash,
          adapter: 'redis-prepare',
          reason: 'hash_mismatch',
        });
        if (this._onEntryEvict) {
          invokeEvictCallback({
            onEntryEvict: this._onEntryEvict,
            entry: mismatchEntry,
            adapter: 'redis-prepare',
            reason: 'hash_mismatch',
          });
        }
      } catch {
        void this._releaseSponsorFromRawEntry(
          entryJson,
          receiptId,
          'hash_mismatch_undeserializable',
        );
      }
      return 'hash_mismatch';
    }

    // Success branch: Lua already removed the entry, so the slot is owned
    // by the sponsor caller. If deserialization fails here, the
    // slot would be orphaned — release it best-effort and re-throw so the
    // caller still reports the error.
    try {
      return deserializeEntry(str, receiptId);
    } catch (err) {
      void this._releaseSponsorFromRawEntry(str, receiptId, 'consume_success_undeserializable');
      throw err;
    }
  }

  async peek(receiptId: string): Promise<PreparedTxEntry | null> {
    const raw = (await this._client.eval(
      PEEK_SCRIPT,
      [this.entryKey(receiptId)],
      [String(this._ttlMs)],
    )) as string | null | undefined;
    if (!raw) return null;
    // Deserialization failure must propagate so sponsor processing can
    // release the held slot via evictPreparedEntry(). Silently returning
    // null would route control to a generic "not found" early-return that
    // never touches the slot.
    return deserializeEntry(raw, receiptId);
  }

  /**
   * Best-effort invalidation of a stored prepared entry.
   *
   * Reads the raw JSON, pulls sponsor-address identity without going through
   * `deserializeEntry()`, releases the slot, and atomically removes the
   * entry from Redis. Idempotent and never throws. Covers both corrupt-
   * entry eviction (deserialize failure on peek/consume) and post-`peek`
   * sponsor result rejection invalidation; see the interface docstring.
   */
  async evictPreparedEntry(receiptId: string): Promise<void> {
    const entryKey = this.entryKey(receiptId);
    let raw: string | null | undefined;
    try {
      raw = (await this._client.eval(
        EVICT_PREPARED_ENTRY_SCRIPT,
        [entryKey],
        [receiptId, this._keyPrefix, String(this._ttlMs)],
      )) as string | null | undefined;
    } catch {
      // Failure path contract: eviction must not mask the primary
      // sponsor error. The entry keeps its physical TTL if Redis is
      // unavailable during this best-effort cleanup.
      return;
    }
    if (!raw) return;

    // Lua already deleted the entry and cleaned recoverable indexes in
    // one Redis operation. The returned raw entry is the slot-release
    // evidence; malformed JSON simply falls through to the unrecoverable
    // slot-info path.
    await this._releaseSponsorFromRawEntry(raw, receiptId, 'undeserializable_eviction');
  }

  /**
   * Pre-check Studio user quota before slot checkout (best-effort).
   *
   * Delegates to `CHECK_USER_QUOTA_SCRIPT` so the precheck applies the
   * same live-entry semantics as the authoritative `STORE_SCRIPT`
   * quota check: logical TTL (`item.t + ttlMs`) gates live counting,
   * and physical entry-key existence inside the
   * `PREPARE_STORE_KEY_TTL_GRACE_MS` window alone does NOT keep an
   * entry live. Without the Lua's `redis.call('TIME')` baseline, the
   * precheck could false-reject under conditions where store() would
   * accept.
   *
   * Generic `/relay/prepare` has no analogous precheck because no
   * pre-verified identity exists there; only promotion entries
   * populate the user index.
   */
  async checkUserQuota(userId: string): Promise<'ok' | { exceeded: true; limit: number }> {
    const result = await this._client.eval(
      CHECK_USER_QUOTA_SCRIPT,
      [this.userKey(userId)],
      [this._keyPrefix, String(this._ttlMs), String(this._maxPerStudioUser)],
    );
    const live = parseRedisIntegerResult(result, 'checkUserQuota live count');
    return live >= this._maxPerStudioUser
      ? { exceeded: true, limit: this._maxPerStudioUser }
      : 'ok';
  }

  /**
   * S-14: Reserve the next monotonic nonce for a sender.
   *
   * Derives max nonce from sender-local metadata (live entries + pending reservations)
   * in one atomic Lua operation. No standalone HWM key.
   */
  async reserveNonce(
    senderAddress: string,
    onchainLastNonce: bigint,
    reservationId: string,
  ): Promise<bigint> {
    const script = `
      local function normalizeDec(raw)
        if raw == nil or raw == false then return '0' end
        local s = tostring(raw)
        if s == '' then return '0' end
        local trimmed = string.gsub(s, '^0+', '')
        if trimmed == '' then return '0' end
        if not string.match(trimmed, '^%d+$') then
          error('invalid decimal string: ' .. s)
        end
        return trimmed
      end

      local function compareDecStrings(a, b)
        local na = normalizeDec(a)
        local nb = normalizeDec(b)
        if string.len(na) < string.len(nb) then return -1 end
        if string.len(na) > string.len(nb) then return 1 end
        if na < nb then return -1 end
        if na > nb then return 1 end
        return 0
      end

      local function maxDecStrings(a, b)
        if compareDecStrings(a, b) >= 0 then
          return normalizeDec(a)
        end
        return normalizeDec(b)
      end

      local function addOneDecString(raw)
        local s = normalizeDec(raw)
        local out = {}
        local carry = 1
        for i = string.len(s), 1, -1 do
          local digit = string.byte(s, i) - 48 + carry
          if digit >= 10 then
            digit = digit - 10
            carry = 1
          else
            carry = 0
          end
          out[i] = string.char(48 + digit)
        end
        if carry == 1 then
          table.insert(out, 1, '1')
        end
        return table.concat(out)
      end

      local senderKey = KEYS[1]
      local onchain = ARGV[1]
      local resId = ARGV[2]
      local senderPx = tonumber(ARGV[3])
      local prefix = ARGV[4]
      local ttlMs = tonumber(ARGV[5])
      local maxOutstandingPerSender = tonumber(ARGV[6])

      local timeResult = redis.call('TIME')
      local nowMs = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)

      -- Compact sender-local metadata: keep non-expired pending + logically-live entries only.
      -- Logical TTL (issuedAt + ttlMs) takes precedence over physical key existence.
      local senderMax = '0'
      local senderRaw = redis.call('GET', senderKey)
      local compacted = {}
      if senderRaw then
        local senderList = cjson.decode(senderRaw)
        for _, item in ipairs(senderList) do
          if type(item) == 'table'
            and type(item.pid) == 'string'
            and type(item.t) == 'number'
            and type(item.nonce) == 'string' then
            local currentNonce = normalizeDec(item.nonce)
            if item.pending == true then
              if item.t + ttlMs >= nowMs then
                compacted[#compacted + 1] = {
                  pid = item.pid,
                  nonce = currentNonce,
                  pending = true,
                  t = item.t,
                }
                senderMax = maxDecStrings(senderMax, currentNonce)
              end
            elseif item.pending == nil then
              if item.t + ttlMs < nowMs then
                -- Logical TTL expired — drop even if physical key still exists
              elseif redis.call('EXISTS', prefix .. item.pid) == 1 then
                compacted[#compacted + 1] = {
                  pid = item.pid,
                  nonce = currentNonce,
                  t = item.t,
                }
                senderMax = maxDecStrings(senderMax, currentNonce)
              end
            end
          end
        end
      end

      if #compacted >= maxOutstandingPerSender then
        return '__sender_quota__'
      end

      local base = maxDecStrings(onchain, senderMax)
      local nextNonce = addOneDecString(base)

      -- Add pending reservation to sender-local metadata
      compacted[#compacted + 1] = { pid = resId, nonce = nextNonce, pending = true, t = nowMs }
      redis.call('SET', senderKey, cjson.encode(compacted), 'PX', senderPx)

      return nextNonce
    `;
    const senderPxMs = this._ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER;
    const result = (await this._client.eval(
      script,
      [this.senderKey(senderAddress)],
      [
        onchainLastNonce.toString(),
        reservationId,
        String(senderPxMs),
        this._keyPrefix,
        String(this._ttlMs),
        String(this._maxOutstandingPerSender),
      ],
    )) as string;
    if (result === '__sender_quota__') {
      throw new PrepareSenderQuotaError(senderAddress, this._maxOutstandingPerSender);
    }
    return parseRedisBigIntResult(result, 'reserved nonce');
  }

  /**
   * Release a pending nonce reservation from sender-local metadata.
   * Called on pre-store failure path.
   *
   * Removes only pending reservations whose `pid` matches `resId`. Live
   * entries (no `pending` flag) MUST be preserved even when their `pid`
   * matches, because `store()` promotes a pending reservation to a live
   * entry under the same receiptId. The runner's `store()` →
   * `transferOwnership()` boundary normally prevents this method from
   * being called after promotion, but the contract still keeps Memory
   * and Redis aligned: pre-store failure cleans up pending; post-store
   * is a no-op for that receiptId's live entry.
   */
  async releaseReservation(reservationId: string, senderAddress: string): Promise<void> {
    const script = `
      local senderKey = KEYS[1]
      local resId = ARGV[1]
      local senderPx = tonumber(ARGV[2])

      local senderRaw = redis.call('GET', senderKey)
      if not senderRaw then return 0 end

      local senderList = cjson.decode(senderRaw)
      local updated = {}
      for _, item in ipairs(senderList) do
        if type(item) == 'table'
          and type(item.pid) == 'string'
          and type(item.t) == 'number'
          and type(item.nonce) == 'string' then
          if item.pending == true then
            -- Drop the matching pending reservation only.
            if item.pid ~= resId then
              updated[#updated + 1] = {
                pid = item.pid,
                nonce = item.nonce,
                pending = true,
                t = item.t,
              }
            end
          elseif item.pending == nil then
            -- A live entry with the same pid (post-store promotion) is preserved.
            updated[#updated + 1] = { pid = item.pid, nonce = item.nonce, t = item.t }
          end
        end
      end

      if #updated == 0 then
        redis.call('DEL', senderKey)
      else
        redis.call('SET', senderKey, cjson.encode(updated), 'PX', senderPx)
      end
      return 1
    `;
    const senderPxMs = this._ttlMs * PREPARE_STORE_INDEX_TTL_MULTIPLIER;
    await this._client.eval(
      script,
      [this.senderKey(senderAddress)],
      [reservationId, String(senderPxMs)],
    );
  }
}

// ─────────────────────────────────────────────
// CONSUME variant that extracts clientIp from entry
// ─────────────────────────────────────────────

/**
 * CONSUME_SCRIPT_WITH_IP — variant that reads clientIp from the entry JSON
 * to build the ip key dynamically. Single-node Redis only.
 *
 * KEYS[1] = entry key
 * ARGV[1] = expected txBytesHash, ARGV[2] = ttlMs, ARGV[3] = receiptId, ARGV[4] = prefix
 */
const CONSUME_SCRIPT_WITH_IP = `
local entryKey = KEYS[1]
local expectedHash = ARGV[1]
local ttlMs = tonumber(ARGV[2])
local pid = ARGV[3]
local prefix = ARGV[4]

local raw = redis.call('GET', entryKey)
if not raw then return nil end

local decoded, entry = pcall(cjson.decode, raw)
local entryIsTable = decoded and type(entry) == 'table'

local timeResult = redis.call('TIME')
local nowMs = tonumber(timeResult[1]) * 1000 + math.floor(tonumber(timeResult[2]) / 1000)

local function removeFromIndex(key, indexKind)
  if type(key) ~= 'string' or key == '' then return end
  local indexRaw = redis.call('GET', key)
  if not indexRaw then return end
  local ok, list = pcall(cjson.decode, indexRaw)
  if not ok or type(list) ~= 'table' then return end
  local updated = {}
  for _, item in ipairs(list) do
    if type(item) == 'table'
      and type(item.pid) == 'string'
      and item.pid ~= pid
      and type(item.t) == 'number' then
      if indexKind == 'sender' then
        if item.pending == true and type(item.nonce) == 'string' then
          updated[#updated + 1] = {
            pid = item.pid,
            nonce = item.nonce,
            pending = true,
            t = item.t,
          }
        elseif item.pending == nil and type(item.nonce) == 'string' then
          updated[#updated + 1] = { pid = item.pid, nonce = item.nonce, t = item.t }
        end
      else
        updated[#updated + 1] = { pid = item.pid, t = item.t }
      end
    end
  end
  if #updated > 0 then
    redis.call('SET', key, cjson.encode(updated), 'KEEPTTL')
  else
    redis.call('DEL', key)
  end
end

local resultKind = 'success'
if entryIsTable and type(entry.issuedAt) == 'number' and entry.issuedAt + ttlMs < nowMs then
  resultKind = 'expired'
elseif entryIsTable and type(entry.txBytesHash) == 'string' and entry.txBytesHash ~= expectedHash then
  resultKind = 'hash_mismatch'
end

redis.call('DEL', entryKey)

-- Indexes are derived cleanup. Once the entry is deleted, malformed entry
-- fields or index rows must not suppress the raw lease evidence returned to
-- the TypeScript layer. Only safe string keys are used, and pcall isolates
-- any remaining cleanup error.
if entryIsTable and type(entry.clientIp) == 'string' then
  pcall(removeFromIndex, prefix .. 'ip:' .. entry.clientIp, 'ip')
end
if entryIsTable and type(entry.senderAddress) == 'string' then
  pcall(removeFromIndex, prefix .. 'sender:' .. entry.senderAddress, 'sender')
end

if resultKind == 'expired' then
  return '__expired_entry__:' .. raw
end
if resultKind == 'hash_mismatch' then
  return '__hash_mismatch_entry__:' .. raw
end
return raw
`;
