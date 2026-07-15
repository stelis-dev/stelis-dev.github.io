/**
 * RedisPromotionExecutionLedger — Redis-backed production implementation.
 *
 * Each mutation (claim, reserve, consume, release) executes its
 * dedupe / capacity / entitlement-gate / budget-deduction logic inside a
 * single Lua EVAL so the rollback unit is atomic. Promotion-budget keys
 * (`budget:avail`, `budget:res_total`, `budget:con_total`) are installed
 * by idempotent pre-Lua NX writes immediately before the claim Lua
 * script — they sit outside the rollback unit because NX writes never
 * overwrite an already-installed value, so a repeat or partial claim is
 * safe. Read paths (`getBudgetSummary`) are read-only. A failed pre-claim
 * `reserve()` cannot install `budget:avail = 0` because reserve-side NX
 * init runs inside the entitlement-gated Lua script.
 *
 * Key namespace: `stelis:promotion_execution_ledger:`.
 *
 * Key layout:
 *   stelis:promotion_execution_ledger:claim:{promotionId}:{userId}    → claimedAt ISO string
 *   stelis:promotion_execution_ledger:claim:idx:{promotionId}          → SET of userIds
 *   stelis:promotion_execution_ledger:ent:{promotionId}:{userId}:meta  → JSON(meta: useUntilAt, lastUsedAt, status)
 *   stelis:promotion_execution_ledger:ent:{promotionId}:{userId}:rem   → int64 (remaining MIST)
 *   stelis:promotion_execution_ledger:ent:{promotionId}:{userId}:con   → int64 (consumed MIST)
 *   stelis:promotion_execution_ledger:ent:{promotionId}:{userId}:res   → "{receiptId}:{amount}" or nil
 *   stelis:promotion_execution_ledger:budget:{promotionId}:avail       → int64 (available)
 *   stelis:promotion_execution_ledger:budget:{promotionId}:res_total   → int64 (reserved total)
 *   stelis:promotion_execution_ledger:budget:{promotionId}:con_total   → int64 (consumed total)
 *   stelis:promotion_execution_ledger:res:{receiptId}                   → JSON({promotionId,userId,amountMist,expiresAt}) with PX
 *   stelis:promotion_execution_ledger:terminal:{receiptId}              → "consumed"|"released" (with PX)
 *
 * Precision: All money arithmetic uses DECRBY/INCRBY (int64).
 *            Scratch keys for delta comparison. No tonumber() on money.
 *
 * @module studio/executionLedgerRedis
 */

import type { PromotionExecutionLedger, PromotionListLedgerStatus } from './executionLedger.js';
import {
  assertPromotionListLedgerBatchBound,
  PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS,
  PROMOTION_EXECUTION_LEDGER_DEFAULT_REAPER_INTERVAL_MS,
} from './executionLedger.js';
import type {
  Entitlement,
  EntitlementStatus,
  BudgetSummary,
  ClaimedUserProjection,
  ClaimOpts,
  ClaimResult,
  ReserveParams,
  ReserveResult,
  ConsumeResult,
  ReleaseResult,
} from './domain.js';
import type { RedisClientLike } from '../store/redisClient.js';
import { type Clock, systemClock } from '../clock.js';
import { logStructuredEvent } from '../structuredEventLog.js';
import { PROMOTION_EXECUTION_LEDGER_REAPER_ERROR } from '../observability/events.js';
import {
  parseNonNegativeDecimalBigInt,
  parsePromotionLedgerBudget,
  assertPositiveMist,
  assertNonNegativeMist,
  assertWithinLedgerBound,
} from './executionLedgerValueGuards.js';

// ─────────────────────────────────────────────
// Prefix
// ─────────────────────────────────────────────

const PFX = 'stelis:promotion_execution_ledger:';
const DECIMAL_MIST_RE = /^(?:0|[1-9]\d*)$/;
const TERMINAL_GUARD_TTL_GRACE_MS = 120_000;

function parseNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw new Error(`${label} must be a non-negative safe integer`);
  }

  if (typeof value === 'string' && DECIMAL_MIST_RE.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }

  throw new Error(`${label} must be a non-negative safe integer`);
}

function parseNullableRedisString(value: unknown, label: string): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new Error(`${label} must be a string or null`);
}

// Money-input parse + assertion helpers live in
// `executionLedgerValueGuards.ts` so the Memory and Redis adapters
// stay in lock-step on bound semantics and error messages.
// `parseNonNegativeSafeInteger` above is intentionally Redis-local
// — it coerces Redis return shapes (`SCARD` claimed count, `TIME`
// milliseconds) and is not a money-input guard.

// ─────────────────────────────────────────────
// Key helpers
// ─────────────────────────────────────────────

const claimKey = (pid: string, uid: string) => `${PFX}claim:${pid}:${uid}`;
const claimIdxKey = (pid: string) => `${PFX}claim:idx:${pid}`;
const entMetaKey = (pid: string, uid: string) => `${PFX}ent:${pid}:${uid}:meta`;
const entRemKey = (pid: string, uid: string) => `${PFX}ent:${pid}:${uid}:rem`;
const entConKey = (pid: string, uid: string) => `${PFX}ent:${pid}:${uid}:con`;
const entResKey = (pid: string, uid: string) => `${PFX}ent:${pid}:${uid}:res`;
const budgetAvailKey = (pid: string) => `${PFX}budget:${pid}:avail`;
const budgetResTotalKey = (pid: string) => `${PFX}budget:${pid}:res_total`;
const budgetConTotalKey = (pid: string) => `${PFX}budget:${pid}:con_total`;
const resKey = (receiptId: string) => `${PFX}res:${receiptId}`;
const terminalKey = (receiptId: string) => `${PFX}terminal:${receiptId}`;

// ─────────────────────────────────────────────
// Lua: CLAIM (dedupe + capacity + entitlement)
// ─────────────────────────────────────────────

/**
 * Atomic: dedupe check + capacity guard + entitlement creation.
 *
 * Variant without promotion-record status re-check. Used when the ledger
 * is constructed without a `canonicalRecordKeyFor` getter (tests, or
 * wiring that does not require race closure).
 *
 * KEYS: [claimKey, claimIdxKey, entMetaKey, entRemKey, entConKey]
 * ARGV: [userId, maxParticipants, initialAllowanceMist, metaJson, claimedAt]
 *
 * Returns: 0 = created, -1 = capacity_exceeded, JSON string = duplicate
 */
const LUA_CLAIM = `
local existing = redis.call('GET', KEYS[1])
if existing then return existing end

local maxP = tonumber(ARGV[2])
local cnt = redis.call('SCARD', KEYS[2])
if cnt >= maxP then return -1 end

-- Create claim record
redis.call('SET', KEYS[1], ARGV[5])
redis.call('SADD', KEYS[2], ARGV[1])

-- Create entitlement (split-key)
redis.call('SET', KEYS[3], ARGV[4])
redis.call('SET', KEYS[4], ARGV[3])
redis.call('SET', KEYS[5], '0')

return 0
`;

/**
 * Atomic: promotion-status re-check + dedupe + capacity + entitlement.
 *
 * Race-closure variant. Used when the ledger is wired with a
 * `canonicalRecordKeyFor` getter, which supplies the promotion record
 * key owned by `RedisPromotionStore` (no second Redis key owner here).
 * The script re-reads the canonical promotion record inside the same
 * Redis round-trip as the capacity CAS and refuses to create the
 * entitlement when the current `status` is not `'active'` — closing the
 * admin pause/archive race between `promotionStore.get()` at the claim route
 * and the ledger's `claim` call.
 *
 * `claimDeadlineAt` is intentionally not inspected here. Deadline freeze
 * is upheld by the claim-route pre-check; this Lua contract re-checks
 * status only and avoids ISO/time parsing.
 *
 * KEYS: [claimKey, claimIdxKey, entMetaKey, entRemKey, entConKey, promotionRecordKey]
 * ARGV: [userId, maxParticipants, initialAllowanceMist, metaJson, claimedAt]
 *
 * Returns: 0 = created, -1 = capacity_exceeded, -2 = promotion_not_active,
 *          JSON string = duplicate
 */
const LUA_CLAIM_WITH_STATUS_CHECK = `
local existing = redis.call('GET', KEYS[1])
if existing then return existing end

-- Re-read canonical promotion record; refuse if not active.
local recordRaw = redis.call('GET', KEYS[6])
if not recordRaw then return -2 end
local ok, record = pcall(cjson.decode, recordRaw)
if not ok or type(record) ~= 'table' or record.status ~= 'active' then
  return -2
end

local maxP = tonumber(ARGV[2])
local cnt = redis.call('SCARD', KEYS[2])
if cnt >= maxP then return -1 end

-- Create claim record
redis.call('SET', KEYS[1], ARGV[5])
redis.call('SADD', KEYS[2], ARGV[1])

-- Create entitlement (split-key)
redis.call('SET', KEYS[3], ARGV[4])
redis.call('SET', KEYS[4], ARGV[3])
redis.call('SET', KEYS[5], '0')

return 0
`;

// ─────────────────────────────────────────────
// Lua: RESERVE (budget + entitlement + reservation)
// ─────────────────────────────────────────────

/**
 * Atomic: budget deduct + entitlement deduct + reservation record.
 *
 * KEYS: [budgetAvail, entMeta, entRem, entRes, resKey, terminalKey, budgetResTotal]
 * ARGV: [amountMist, receiptId, promotionId, userId, ttlMs, reservationKeyTtlMs]
 *
 * Returns: 'OK' | 0(budget_insufficient) | 10(ent_not_found) | 11(ent_not_active)
 *          | 12(concurrent_reservation) | 13(ent_insufficient)
 */
const LUA_RESERVE = `
-- Terminal guard
if redis.call('EXISTS', KEYS[6]) == 1 then return 0 end

-- Entitlement: meta exists + active
local metaRaw = redis.call('GET', KEYS[2])
if not metaRaw then return 10 end
local meta = cjson.decode(metaRaw)
if meta.status ~= 'active' then return 11 end

-- Entitlement: no concurrent reservation
local existingRes = redis.call('GET', KEYS[4])
if existingRes then return 12 end

-- Budget keys are initialized only after entitlement validation passes.
-- A pre-claim reserve returns entitlement_not_found before reaching this
-- point, so failed reserves cannot create budget accounting keys.
redis.call('SET', KEYS[1], '0', 'NX')
redis.call('SET', KEYS[7], '0', 'NX')

-- Budget: deduct available
local newAvail = redis.call('DECRBY', KEYS[1], ARGV[1])
if newAvail < 0 then
  redis.call('INCRBY', KEYS[1], ARGV[1])
  return 0
end

-- Entitlement: deduct remaining
local newRem = redis.call('DECRBY', KEYS[3], ARGV[1])
if newRem < 0 then
  redis.call('INCRBY', KEYS[3], ARGV[1])
  redis.call('INCRBY', KEYS[1], ARGV[1])
  return 13
end

-- Use Redis TIME for clock integrity
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local expiresAt = nowMs + tonumber(ARGV[5])

-- Commit: reservation record
local coordData = cjson.encode({
  promotionId = ARGV[3],
  userId = ARGV[4],
  amountMist = ARGV[1],
  expiresAt = expiresAt
})
redis.call('SET', KEYS[5], coordData)
redis.call('PEXPIRE', KEYS[5], ARGV[6])

-- Commit: entitlement reservation marker
redis.call('SET', KEYS[4], ARGV[2] .. ':' .. ARGV[1])

-- Commit: budget aggregate
redis.call('INCRBY', KEYS[7], ARGV[1])

return 'OK'
`;

// ─────────────────────────────────────────────
// Lua: CONSUME (receipt-keyed, delta-release)
// ─────────────────────────────────────────────

/**
 * Atomic: resolve owner from reservation, delta-release budget+entitlement.
 * Returns JSON with owner info so TS can read back entitlement after consume.
 *
 * KEYS: [resKey, terminalKey]
 * ARGV: [actualAmountMist, terminalTtlMs, receiptId, timestamp,
 *        budgetPrefix, entPrefix]
 *
 * Returns: JSON({status,promotionId,userId}) | 20(reservation_not_found)
 */
const LUA_CONSUME = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 20 end

local coordRaw = redis.call('GET', KEYS[1])
if not coordRaw then return 20 end

local coord = cjson.decode(coordRaw)
local pid = coord.promotionId
local uid = coord.userId
local reservedAmt = coord.amountMist

local budgetAvail = ARGV[5] .. pid .. ':avail'
local budgetResTotal = ARGV[5] .. pid .. ':res_total'
local budgetConTotal = ARGV[5] .. pid .. ':con_total'
local entMeta = ARGV[6] .. pid .. ':' .. uid .. ':meta'
local entRem = ARGV[6] .. pid .. ':' .. uid .. ':rem'
local entCon = ARGV[6] .. pid .. ':' .. uid .. ':con'
local entRes = ARGV[6] .. pid .. ':' .. uid .. ':res'

local entResRaw = redis.call('GET', entRes)
if not entResRaw then return 20 end
local sep = string.find(entResRaw, ':')
if not sep then return 20 end
local entResReceipt = string.sub(entResRaw, 1, sep - 1)
if entResReceipt ~= ARGV[3] then return 20 end

-- Delta (int64-safe scratch key)
local scratchKey = KEYS[1] .. ':scratch'
redis.call('SET', scratchKey, reservedAmt)
local delta = redis.call('DECRBY', scratchKey, ARGV[1])
redis.call('DEL', scratchKey)

-- Budget delta with 0-clamp -- parity with the memory ledger
-- (executionLedgerMemory.ts): an overrun that would drive
-- budget.available negative is floored at 0 so admin summaries
-- and subsequent reserve()s never observe a negative total.
if delta > 0 then
  redis.call('INCRBY', budgetAvail, tostring(delta))
elseif delta < 0 then
  local absD = -delta
  local clampScratch = budgetAvail .. ':clamp'
  redis.call('SET', clampScratch, redis.call('GET', budgetAvail) or '0')
  local afterDeduct = redis.call('DECRBY', clampScratch, tostring(absD))
  redis.call('DEL', clampScratch)
  if afterDeduct < 0 then
    redis.call('SET', budgetAvail, '0')
  else
    redis.call('DECRBY', budgetAvail, tostring(absD))
  end
end

redis.call('DECRBY', budgetResTotal, reservedAmt)
redis.call('INCRBY', budgetConTotal, ARGV[1])

-- Entitlement delta with clamp
local entScratch = entRes .. ':scratch'
redis.call('SET', entScratch, reservedAmt)
local entDelta = redis.call('DECRBY', entScratch, ARGV[1])
redis.call('DEL', entScratch)

if entDelta > 0 then
  redis.call('INCRBY', entRem, tostring(entDelta))
elseif entDelta < 0 then
  local absD = -entDelta
  local clampScratch = entRem .. ':clamp'
  redis.call('SET', clampScratch, redis.call('GET', entRem) or '0')
  local afterDeduct = redis.call('DECRBY', clampScratch, tostring(absD))
  redis.call('DEL', clampScratch)
  if afterDeduct < 0 then
    redis.call('SET', entRem, '0')
  else
    redis.call('DECRBY', entRem, tostring(absD))
  end
end

redis.call('INCRBY', entCon, ARGV[1])
redis.call('DEL', entRes)

local resultStatus = 'ok'
local metaRaw = redis.call('GET', entMeta)
if metaRaw then
  local meta = cjson.decode(metaRaw)
  meta.lastUsedAt = ARGV[4]
  local newRem = redis.call('GET', entRem)
  if newRem == '0' then
    meta.status = 'exhausted'
    resultStatus = 'exhausted'
  end
  redis.call('SET', entMeta, cjson.encode(meta))
end

redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], 'consumed', 'PX', ARGV[2])

return cjson.encode({status = resultStatus, promotionId = pid, userId = uid})
`;

// ─────────────────────────────────────────────
// Lua: RELEASE (receipt-keyed, full restore)
// ─────────────────────────────────────────────

/**
 * KEYS: [resKey, terminalKey]
 * ARGV: [terminalTtlMs, receiptId, budgetPrefix, entPrefix]
 *
 * Returns: JSON({status:'ok',promotionId,userId}) | 20(reservation_not_found)
 */
const LUA_RELEASE = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 20 end

local coordRaw = redis.call('GET', KEYS[1])
if not coordRaw then return 20 end

local coord = cjson.decode(coordRaw)
local pid = coord.promotionId
local uid = coord.userId
local reservedAmt = coord.amountMist

local budgetAvail = ARGV[3] .. pid .. ':avail'
local budgetResTotal = ARGV[3] .. pid .. ':res_total'
local entRem = ARGV[4] .. pid .. ':' .. uid .. ':rem'
local entRes = ARGV[4] .. pid .. ':' .. uid .. ':res'

redis.call('INCRBY', budgetAvail, reservedAmt)
redis.call('DECRBY', budgetResTotal, reservedAmt)

redis.call('INCRBY', entRem, reservedAmt)
redis.call('DEL', entRes)

redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], 'released', 'PX', ARGV[1])

return cjson.encode({status = 'ok', promotionId = pid, userId = uid})
`;

/**
 * Read every ledger field needed by one bounded Studio Promotion list page.
 *
 * ARGV: [keyPrefix, userId, promotionId...]
 * Returns one JSON array whose row order exactly matches the input IDs.
 */
const LUA_PROMOTION_LIST_LEDGER_STATUS = `
local prefix = ARGV[1]
local userId = ARGV[2]
local rows = {}

local function nullable(value)
  if not value then return cjson.null end
  return value
end

for i = 3, #ARGV do
  local promotionId = ARGV[i]
  local entitlementPrefix = prefix .. 'ent:' .. promotionId .. ':' .. userId
  local metaRaw = redis.call('GET', entitlementPrefix .. ':meta')

  rows[#rows + 1] = {
    promotionId = promotionId,
    entitlementMetaRaw = nullable(metaRaw),
    entitlementRemainingRaw = nullable(redis.call('GET', entitlementPrefix .. ':rem')),
    entitlementConsumedRaw = nullable(redis.call('GET', entitlementPrefix .. ':con')),
    entitlementReservationRaw = nullable(redis.call('GET', entitlementPrefix .. ':res')),
    claimedAtRaw = nullable(redis.call('GET', prefix .. 'claim:' .. promotionId .. ':' .. userId)),
    claimedCount = redis.call('SCARD', prefix .. 'claim:idx:' .. promotionId),
    availableBudgetMist = redis.call('GET', prefix .. 'budget:' .. promotionId .. ':avail') or '0'
  }
end

return cjson.encode(rows)
`;

// ─────────────────────────────────────────────
// Internal meta type (stored in Redis as JSON)
// ─────────────────────────────────────────────

interface EntitlementMeta {
  useUntilAt: string | null;
  lastUsedAt: string | null;
  status: EntitlementStatus;
}

interface StoredEntitlementFields {
  metaRaw: string | null;
  remainingRaw: string | null;
  consumedRaw: string | null;
  reservationRaw: string | null;
  claimedAtRaw: string | null;
}

function entitlementFromStoredFields(
  promotionId: string,
  userId: string,
  fields: StoredEntitlementFields,
): Entitlement | null {
  if (fields.metaRaw === null) return null;

  const meta: EntitlementMeta = JSON.parse(fields.metaRaw);
  let activeReservationReceiptId: string | null = null;
  let activeReservationAmountMist: string | null = null;
  if (fields.reservationRaw !== null) {
    const separator = fields.reservationRaw.indexOf(':');
    if (separator > 0) {
      activeReservationReceiptId = fields.reservationRaw.substring(0, separator);
      activeReservationAmountMist = fields.reservationRaw.substring(separator + 1);
    }
  }

  return {
    promotionId,
    userId,
    claimedAt: fields.claimedAtRaw ?? '',
    useUntilAt: meta.useUntilAt,
    remainingGasAllowanceMist: fields.remainingRaw ?? '0',
    consumedGasAllowanceMist: fields.consumedRaw ?? '0',
    status: meta.status,
    activeReservationReceiptId,
    activeReservationAmountMist,
    lastUsedAt: meta.lastUsedAt,
  };
}

// ─────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────

/**
 * Optional getter that returns the canonical Redis key for a given
 * promotion record. Supplied by wiring (`app-api/src/context.ts`) using
 * `RedisPromotionStore.recordKey(id)` so the promotion-record key shape
 * stays owned by the store. When provided, `claim()` runs the Lua
 * variant that re-reads the record and refuses inactive promotions.
 */
export type CanonicalPromotionRecordKeyGetter = (promotionId: string) => string;

export class RedisPromotionExecutionLedger implements PromotionExecutionLedger {
  private readonly redis: RedisClientLike;
  private readonly ttlMs: number;
  private readonly _clock: Clock;
  private readonly canonicalRecordKeyFor: CanonicalPromotionRecordKeyGetter | null;
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    redis: RedisClientLike,
    ttlMs: number = PROMOTION_EXECUTION_LEDGER_DEFAULT_RESERVATION_TTL_MS,
    reaperIntervalMs: number = PROMOTION_EXECUTION_LEDGER_DEFAULT_REAPER_INTERVAL_MS,
    clock: Clock = systemClock,
    canonicalRecordKeyFor: CanonicalPromotionRecordKeyGetter | null = null,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
      throw new Error('RedisPromotionExecutionLedger: ttlMs must be a non-negative safe integer');
    }
    if (ttlMs > Number.MAX_SAFE_INTEGER - TERMINAL_GUARD_TTL_GRACE_MS) {
      throw new Error('RedisPromotionExecutionLedger: ttlMs overflows terminal TTL range');
    }
    if (!Number.isSafeInteger(reaperIntervalMs) || reaperIntervalMs < 0) {
      throw new Error(
        'RedisPromotionExecutionLedger: reaperIntervalMs must be a non-negative safe integer',
      );
    }
    this.redis = redis;
    this.ttlMs = ttlMs;
    this._clock = clock;
    this.canonicalRecordKeyFor = canonicalRecordKeyFor;

    if (reaperIntervalMs > 0 && reaperIntervalMs < 999_999_000) {
      this.reaperTimer = setInterval(() => {
        this.sweepExpiredReservations().catch((err) => {
          logStructuredEvent(
            PROMOTION_EXECUTION_LEDGER_REAPER_ERROR,
            {
              error: err instanceof Error ? err.message : String(err),
            },
            'error',
          );
        });
      }, reaperIntervalMs);
      if (this.reaperTimer.unref) this.reaperTimer.unref();
    }
  }

  private get terminalTtlMs(): number {
    return this.ttlMs + TERMINAL_GUARD_TTL_GRACE_MS;
  }

  // ── Claim ──────────────────────────────────

  async claim(promotionId: string, userId: string, opts: ClaimOpts): Promise<ClaimResult> {
    const { perUserGasAllowanceMist: perUserBigInt, totalBudgetMist } = parsePromotionLedgerBudget(
      opts.maxParticipants,
      opts.perUserGasAllowanceMist,
    );
    const perUserGasAllowanceMist = perUserBigInt.toString();
    const now = new Date().toISOString();
    const meta: EntitlementMeta = {
      useUntilAt: opts.useUntilAt,
      lastUsedAt: null,
      status: 'active',
    };

    // Budget lazy-init (NX-safe): set available to the finite configured total.
    const totalBudget = totalBudgetMist.toString();
    await this.redis.set(budgetAvailKey(promotionId), totalBudget, { nx: true });
    // Ensure aggregate keys exist (NX-safe)
    await this.redis.set(budgetResTotalKey(promotionId), '0', { nx: true });
    await this.redis.set(budgetConTotalKey(promotionId), '0', { nx: true });

    const useStatusCheck = this.canonicalRecordKeyFor !== null;
    const script = useStatusCheck ? LUA_CLAIM_WITH_STATUS_CHECK : LUA_CLAIM;
    const keys = [
      claimKey(promotionId, userId),
      claimIdxKey(promotionId),
      entMetaKey(promotionId, userId),
      entRemKey(promotionId, userId),
      entConKey(promotionId, userId),
    ];
    if (useStatusCheck) {
      keys.push(this.canonicalRecordKeyFor!(promotionId));
    }

    const result = await this.redis.eval(script, keys, [
      userId,
      opts.maxParticipants.toString(),
      perUserGasAllowanceMist,
      JSON.stringify(meta),
      now,
    ]);

    if (result === 0) {
      const ent = await this.readEntitlement(promotionId, userId);
      return { ok: true, entitlement: ent! };
    }
    if (result === -1) {
      return { ok: false, reason: 'capacity_exceeded' };
    }
    if (result === -2) {
      return { ok: false, reason: 'promotion_not_active' };
    }
    // String result = duplicate (existing claimedAt)
    return { ok: false, reason: 'duplicate' };
  }

  // ── Reserve ────────────────────────────────

  async reserve(params: ReserveParams): Promise<ReserveResult> {
    const { promotionId, userId, receiptId, amountMist } = params;
    assertPositiveMist(amountMist, 'amountMist');
    assertWithinLedgerBound(amountMist, 'amountMist');

    // Budget keys NX init happens inside LUA_RESERVE after the
    // entitlement gate passes, so failed pre-claim reserves leave budget
    // keys untouched.
    const result = await this.redis.eval(
      LUA_RESERVE,
      [
        budgetAvailKey(promotionId),
        entMetaKey(promotionId, userId),
        entRemKey(promotionId, userId),
        entResKey(promotionId, userId),
        resKey(receiptId),
        terminalKey(receiptId),
        budgetResTotalKey(promotionId),
      ],
      [
        amountMist.toString(),
        receiptId,
        promotionId,
        userId,
        this.ttlMs.toString(),
        this.terminalTtlMs.toString(),
      ],
    );

    if (result === 'OK') {
      const ent = await this.readEntitlement(promotionId, userId);
      return { ok: true, entitlement: ent! };
    }

    const code = result as number;
    if (code === 0) return { ok: false, reason: 'budget_insufficient' };
    if (code === 10) return { ok: false, reason: 'entitlement_not_found' };
    if (code === 11) return { ok: false, reason: 'entitlement_not_active' };
    if (code === 12) return { ok: false, reason: 'concurrent_reservation' };
    if (code === 13) return { ok: false, reason: 'entitlement_insufficient' };
    return { ok: false, reason: 'budget_insufficient' };
  }

  // ── Consume ────────────────────────────────

  async consume(receiptId: string, actualGasMist: bigint): Promise<ConsumeResult> {
    assertNonNegativeMist(actualGasMist, 'actualGasMist');
    assertWithinLedgerBound(actualGasMist, 'actualGasMist');
    const result = await this.redis.eval(
      LUA_CONSUME,
      [resKey(receiptId), terminalKey(receiptId)],
      [
        actualGasMist.toString(),
        this.terminalTtlMs.toString(),
        receiptId,
        new Date().toISOString(),
        `${PFX}budget:`,
        `${PFX}ent:`,
      ],
    );

    if (result === 20) {
      return { ok: false, reason: 'reservation_not_found' };
    }

    // Lua returns JSON with owner info
    const parsed = JSON.parse(result as string) as {
      status: string;
      promotionId: string;
      userId: string;
    };
    const ent = await this.readEntitlement(parsed.promotionId, parsed.userId);
    return { ok: true, entitlement: ent! };
  }

  // ── Release ────────────────────────────────

  async release(receiptId: string): Promise<ReleaseResult> {
    const result = await this.redis.eval(
      LUA_RELEASE,
      [resKey(receiptId), terminalKey(receiptId)],
      [this.terminalTtlMs.toString(), receiptId, `${PFX}budget:`, `${PFX}ent:`],
    );

    if (result === 20) {
      return { ok: false, reason: 'reservation_not_found' };
    }

    const parsed = JSON.parse(result as string) as {
      status: string;
      promotionId: string;
      userId: string;
    };
    const ent = await this.readEntitlement(parsed.promotionId, parsed.userId);
    return { ok: true, entitlement: ent! };
  }

  // Read models and reservation sweep.

  async getEntitlement(promotionId: string, userId: string): Promise<Entitlement | null> {
    return this.readEntitlement(promotionId, userId);
  }

  async getBudgetSummary(promotionId: string): Promise<BudgetSummary> {
    // Read-only: missing keys are reported as zero without creating them.
    // Claim installs the first real budget total; reserve may initialize
    // aggregate keys only after entitlement validation passes.
    const [avail, reserved, consumed] = await Promise.all([
      this.redis.get(budgetAvailKey(promotionId)),
      this.redis.get(budgetResTotalKey(promotionId)),
      this.redis.get(budgetConTotalKey(promotionId)),
    ]);

    return {
      availableMist: parseNonNegativeDecimalBigInt(avail ?? '0', 'budget available MIST'),
      reservedMist: parseNonNegativeDecimalBigInt(reserved ?? '0', 'budget reserved MIST'),
      consumedMist: parseNonNegativeDecimalBigInt(consumed ?? '0', 'budget consumed MIST'),
    };
  }

  async getClaimedCount(promotionId: string): Promise<number> {
    const result = await this.redis.eval(
      'return redis.call("SCARD", KEYS[1])',
      [claimIdxKey(promotionId)],
      [],
    );
    return parseNonNegativeSafeInteger(result ?? 0, 'Redis claimed count');
  }

  async getPromotionListLedgerStatuses(
    promotionIds: readonly string[],
    userId: string,
  ): Promise<PromotionListLedgerStatus[]> {
    assertPromotionListLedgerBatchBound(promotionIds);
    if (promotionIds.length === 0) return [];

    const result = await this.redis.eval(
      LUA_PROMOTION_LIST_LEDGER_STATUS,
      [],
      [PFX, userId, ...promotionIds],
    );
    if (typeof result !== 'string') {
      throw new Error('Redis Promotion list ledger status must be JSON');
    }

    const rows: unknown = JSON.parse(result);
    if (!Array.isArray(rows) || rows.length !== promotionIds.length) {
      throw new Error('Redis Promotion list ledger status length mismatch');
    }

    return rows.map((rowValue, index) => {
      if (typeof rowValue !== 'object' || rowValue === null || Array.isArray(rowValue)) {
        throw new Error('Redis Promotion list ledger status row must be an object');
      }
      const row = rowValue as Record<string, unknown>;
      const promotionId = promotionIds[index];
      if (row.promotionId !== promotionId) {
        throw new Error('Redis Promotion list ledger status ID mismatch');
      }
      if (typeof row.availableBudgetMist !== 'string') {
        throw new Error('Redis Promotion list available budget must be a decimal string');
      }
      return {
        promotionId,
        entitlement: entitlementFromStoredFields(promotionId, userId, {
          metaRaw: parseNullableRedisString(
            row.entitlementMetaRaw,
            'Redis Promotion list entitlement meta',
          ),
          remainingRaw: parseNullableRedisString(
            row.entitlementRemainingRaw,
            'Redis Promotion list entitlement remaining allowance',
          ),
          consumedRaw: parseNullableRedisString(
            row.entitlementConsumedRaw,
            'Redis Promotion list entitlement consumed allowance',
          ),
          reservationRaw: parseNullableRedisString(
            row.entitlementReservationRaw,
            'Redis Promotion list entitlement reservation',
          ),
          claimedAtRaw: parseNullableRedisString(
            row.claimedAtRaw,
            'Redis Promotion list claim time',
          ),
        }),
        claimedCount: parseNonNegativeSafeInteger(
          row.claimedCount,
          'Redis Promotion list claimed count',
        ),
        availableBudgetMist: parseNonNegativeDecimalBigInt(
          row.availableBudgetMist,
          'Redis Promotion list available budget MIST',
        ),
      };
    });
  }

  async listClaimedUsers(promotionId: string): Promise<ClaimedUserProjection[]> {
    // Get all userIds from claim index
    const userIds = (await this.redis.eval(
      'return redis.call("SMEMBERS", KEYS[1])',
      [claimIdxKey(promotionId)],
      [],
    )) as string[] | null;

    if (!userIds || userIds.length === 0) return [];

    // Batch read entitlements
    const results: ClaimedUserProjection[] = [];
    for (const userId of userIds) {
      const [claimedAt, ent] = await Promise.all([
        this.redis.get(claimKey(promotionId, userId)),
        this.readEntitlement(promotionId, userId),
      ]);
      results.push({
        userId,
        claimedAt: claimedAt ?? '',
        remainingGasAllowanceMist: ent?.remainingGasAllowanceMist ?? null,
        consumedGasAllowanceMist: ent?.consumedGasAllowanceMist ?? null,
        status: ent?.status ?? null,
        activeReservationReceiptId: ent?.activeReservationReceiptId ?? null,
      });
    }
    return results;
  }

  async sweepExpiredReservations(): Promise<number> {
    const keys = await this.redis.scan(`${PFX}res:*`);
    let swept = 0;

    const now = await this.getRedisTimeMs();

    for (const key of keys) {
      const raw = await this.redis.get(key);
      if (!raw) continue;

      let data: { expiresAt?: number };
      try {
        data = JSON.parse(raw);
      } catch {
        continue;
      }

      if (!data.expiresAt || data.expiresAt > now) continue;

      // Extract receiptId from key: stelis:promotion_execution_ledger:res:{receiptId}
      const receiptId = key.slice(`${PFX}res:`.length);

      // Release expired reservation (same as release)
      const result = await this.redis.eval(
        LUA_RELEASE,
        [resKey(receiptId), terminalKey(receiptId)],
        [this.terminalTtlMs.toString(), receiptId, `${PFX}budget:`, `${PFX}ent:`],
      );
      if (result !== 20) swept++;
    }

    return swept;
  }

  dispose(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  // ── Private helpers ────────────────────────

  private async readEntitlement(promotionId: string, userId: string): Promise<Entitlement | null> {
    const [metaRaw, rem, con, resRaw, claimedAt] = await Promise.all([
      this.redis.get(entMetaKey(promotionId, userId)),
      this.redis.get(entRemKey(promotionId, userId)),
      this.redis.get(entConKey(promotionId, userId)),
      this.redis.get(entResKey(promotionId, userId)),
      this.redis.get(claimKey(promotionId, userId)),
    ]);

    return entitlementFromStoredFields(promotionId, userId, {
      metaRaw,
      remainingRaw: rem,
      consumedRaw: con,
      reservationRaw: resRaw,
      claimedAtRaw: claimedAt,
    });
  }

  private async getRedisTimeMs(): Promise<number> {
    try {
      const result = await this.redis.eval(
        'local t = redis.call("TIME"); return tostring(tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000))',
        [],
        [],
      );
      return parseNonNegativeSafeInteger(result, 'Redis TIME milliseconds');
    } catch {
      return this._clock.nowMs();
    }
  }
}
