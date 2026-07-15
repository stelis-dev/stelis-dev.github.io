/**
 * Promotion Registry Store — CRUD store for promotion definitions.
 *
 * Stores operator-configured promotion records and lifecycle state.
 * Adapter-only module: value types live in `domain.ts`, Admin request shapes
 * come from `@stelis/contracts`, and this file owns persistence plus current
 * lifecycle transitions.
 *
 * Key layout (Redis):
 *   stelis:promo:{promotionId}         → JSON(Promotion)
 *   stelis:promo:index:all             → Redis ZSET of promotionIds (score 0)
 *   stelis:promo:index:status:{status} → Redis ZSET of promotionIds (score 0)
 *
 * The same-score sorted indexes provide Redis byte-lexicographic page order
 * without scanning the keyspace or iterating the complete Promotion catalog.
 *
 * @module promotionStore
 */

import type {
  AdminPromotionCreateRequest,
  AdminPromotionUpdateRequest,
  PromotionPageParams,
} from '@stelis/contracts';
import {
  comparePromotionIds,
  parseAdminPromotionCreateRequest,
  parseAdminPromotionUpdateRequest,
  parsePromotionId,
  parsePromotionPageQuery,
} from '@stelis/contracts';
import type { RedisClientLike } from '../store/redisClient.js';
import type { Promotion, PromotionStatus } from './domain.js';
import { parsePromotionLedgerBudget } from './executionLedgerValueGuards.js';

// ─────────────────────────────────────────────
// Store contract
// ─────────────────────────────────────────────

/** Atomic outcome of deleting the current Promotion record. */
export type PromotionDeleteResult =
  { status: 'deleted' } | { status: 'not_found' } | { status: 'not_deletable' };

/** Optional lifecycle filter applied to the ordered Promotion index. */
export interface PromotionStoreFilter {
  readonly status?: PromotionStatus;
}

/** Bounded page returned by every Promotion store adapter. */
export interface PromotionStorePage {
  readonly promotions: Promotion[];
  readonly nextCursor: string | null;
}

// ─────────────────────────────────────────────
// Store Interface
// ─────────────────────────────────────────────

export interface PromotionStoreAdapter {
  /** Create a new promotion. Returns the created record. */
  create(input: AdminPromotionCreateRequest): Promise<Promotion>;

  /** Get a promotion by ID. Returns null if not found. */
  get(promotionId: string): Promise<Promotion | null>;

  /** Read one deterministic, bounded page. */
  listPage(params: PromotionPageParams, filter?: PromotionStoreFilter): Promise<PromotionStorePage>;

  /** Update mutable fields. Returns updated record or null if not found. */
  update(promotionId: string, input: AdminPromotionUpdateRequest): Promise<Promotion | null>;

  /**
   * Transition promotion status.
   * Returns updated record or null if promotion not found.
   * Throws if the transition is invalid.
   */
  transitionStatus(
    promotionId: string,
    newStatus: PromotionStatus,
    reason?: string,
  ): Promise<Promotion | null>;

  /** Delete a draft promotion without collapsing absence and lifecycle rejection. */
  delete(promotionId: string): Promise<PromotionDeleteResult>;
}

// ─────────────────────────────────────────────
// Status transition rules
// ─────────────────────────────────────────────

/**
 * Valid status transitions.
 * - draft → active
 * - active → paused
 * - active → archived
 * - paused → active
 * - paused → archived
 *
 * Co-located with the store because transition validation and persistence
 * must apply as one record mutation.
 */
export const VALID_STATUS_TRANSITIONS: Readonly<
  Record<PromotionStatus, readonly PromotionStatus[]>
> = {
  draft: ['active'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: [], // final state
};

export function isValidTransition(from: PromotionStatus, to: PromotionStatus): boolean {
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export class InvalidStatusTransitionError extends Error {
  constructor(from: PromotionStatus, to: PromotionStatus) {
    super(`Invalid status transition: ${from} → ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

/**
 * Economic and temporal fields that are frozen once a promotion leaves `draft`.
 * Presentational fields (`displayName`, `description`) remain mutable.
 */
export const IMMUTABLE_AFTER_DRAFT_FIELDS = [
  'maxParticipants',
  'perUserGasAllowanceMist',
  'claimDeadlineAt',
  'postClaimUseWindowMs',
  'startAt',
] as const satisfies readonly (keyof AdminPromotionUpdateRequest)[];

export type ImmutableAfterDraftField = (typeof IMMUTABLE_AFTER_DRAFT_FIELDS)[number];

export class PromotionFieldImmutableError extends Error {
  constructor(
    public readonly fields: readonly ImmutableAfterDraftField[],
    public readonly currentStatus: PromotionStatus,
  ) {
    super(
      `Cannot modify ${fields.join(', ')} on ${currentStatus} promotion: ` +
        `economic and temporal fields are frozen once a promotion leaves draft`,
    );
    this.name = 'PromotionFieldImmutableError';
  }
}

export class PromotionCurrentConflictError extends Error {
  constructor(
    public readonly promotionId: string,
    public readonly operation: 'create' | 'update' | 'status' | 'delete',
  ) {
    super(`Promotion ${promotionId} changed while attempting ${operation}`);
    this.name = 'PromotionCurrentConflictError';
  }
}

/**
 * Enforce immutable-after-draft economic and temporal fields.
 * Throws `PromotionFieldImmutableError` if any immutable field is present in
 * `input` while the existing record is past the `draft` status.
 *
 * The contracts wire parser owns request grammar. The store independently
 * applies the shared ledger-budget invariant after this freeze check.
 */
export function ensureUpdatableFields(
  existing: Promotion,
  input: AdminPromotionUpdateRequest,
): void {
  if (existing.status === 'draft') return;
  const attempted: ImmutableAfterDraftField[] = [];
  for (const field of IMMUTABLE_AFTER_DRAFT_FIELDS) {
    if (input[field] !== undefined) attempted.push(field);
  }
  if (attempted.length > 0) {
    throw new PromotionFieldImmutableError(attempted, existing.status);
  }
}

function createPromotionRecord(
  input: AdminPromotionCreateRequest,
  promotionId: string,
  now: string,
): Promotion {
  const currentInput = parseAdminPromotionCreateRequest(input);
  const record: Promotion = {
    promotionId,
    type: currentInput.type,
    displayName: currentInput.displayName,
    description: currentInput.description ?? '',
    status: 'draft',
    maxParticipants: currentInput.maxParticipants,
    perUserGasAllowanceMist: currentInput.perUserGasAllowanceMist,
    claimDeadlineAt: currentInput.claimDeadlineAt ?? null,
    postClaimUseWindowMs: currentInput.postClaimUseWindowMs ?? 0,
    startAt: currentInput.startAt ?? null,
    pauseReason: null,
    archiveReason: null,
    createdAt: now,
    updatedAt: now,
  };
  parsePromotionLedgerBudget(record.maxParticipants, record.perUserGasAllowanceMist);
  return record;
}

function snapshotUpdatePromotionInput(
  input: AdminPromotionUpdateRequest,
): AdminPromotionUpdateRequest {
  return parseAdminPromotionUpdateRequest(input);
}

function updatePromotionRecord(
  existing: Promotion,
  input: AdminPromotionUpdateRequest,
  now: string,
): Promotion {
  ensureUpdatableFields(existing, input);
  const updated: Promotion = {
    ...existing,
    ...input,
    updatedAt: now,
  };
  parsePromotionLedgerBudget(updated.maxParticipants, updated.perUserGasAllowanceMist);
  return updated;
}

function transitionPromotionRecord(
  existing: Promotion,
  newStatus: PromotionStatus,
  reason: string | undefined,
  now: string,
): Promotion {
  if (!isValidTransition(existing.status, newStatus)) {
    throw new InvalidStatusTransitionError(existing.status, newStatus);
  }
  if (newStatus === 'active') {
    parsePromotionLedgerBudget(existing.maxParticipants, existing.perUserGasAllowanceMist);
  }
  return {
    ...existing,
    status: newStatus,
    updatedAt: now,
    pauseReason: newStatus === 'paused' ? (reason ?? null) : existing.pauseReason,
    archiveReason: newStatus === 'archived' ? (reason ?? null) : existing.archiveReason,
  };
}

function clonePromotion(record: Promotion): Promotion {
  return { ...record };
}

function decidePromotionDelete(record: Promotion | null): 'delete' | 'not_deletable' | 'not_found' {
  if (record === null) return 'not_found';
  return record.status === 'draft' ? 'delete' : 'not_deletable';
}

function currentPromotionPageParams(params: PromotionPageParams): PromotionPageParams {
  return parsePromotionPageQuery({
    ...(params.cursor === null ? {} : { cursor: params.cursor }),
    limit: params.limit,
  });
}

/** Find the first insertion point whose current ID is not less than `promotionId`. */
function lowerBoundPromotionId(ids: readonly string[], promotionId: string): number {
  let low = 0;
  let high = ids.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (comparePromotionIds(ids[mid]!, promotionId) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Find the first ID strictly greater than an exclusive cursor. */
function firstPromotionIdAfter(ids: readonly string[], cursor: string): number {
  let low = 0;
  let high = ids.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (comparePromotionIds(ids[mid]!, cursor) <= 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

function hasSortedPromotionId(ids: readonly string[], promotionId: string): boolean {
  const index = lowerBoundPromotionId(ids, promotionId);
  return index < ids.length && comparePromotionIds(ids[index]!, promotionId) === 0;
}

function insertSortedPromotionId(ids: string[], promotionId: string): void {
  ids.splice(lowerBoundPromotionId(ids, promotionId), 0, promotionId);
}

function removeSortedPromotionId(ids: string[], promotionId: string): void {
  const index = lowerBoundPromotionId(ids, promotionId);
  if (index >= ids.length || comparePromotionIds(ids[index]!, promotionId) !== 0) {
    throw new Error(`Promotion index is missing ${promotionId}`);
  }
  ids.splice(index, 1);
}

// ─────────────────────────────────────────────
// Memory Implementation (testing)
// ─────────────────────────────────────────────

export class MemoryPromotionStore implements PromotionStoreAdapter {
  private readonly _records = new Map<string, Promotion>();
  private readonly _allIds: string[] = [];
  private readonly _statusIds: Record<PromotionStatus, string[]> = {
    draft: [],
    active: [],
    paused: [],
    archived: [],
  };
  private _counter = 0;

  /** Generate a deterministic test ID. Override for custom IDs. */
  protected generateId(): string {
    this._counter++;
    const suffix = this._counter.toString(16).padStart(12, '0');
    if (suffix.length > 12) {
      throw new Error('MemoryPromotionStore deterministic UUID space is exhausted');
    }
    return `00000000-0000-4000-8000-${suffix}`;
  }

  async create(input: AdminPromotionCreateRequest): Promise<Promotion> {
    const promotionId = parsePromotionId(
      this.generateId(),
      'MemoryPromotionStore generated promotionId',
    );
    const now = new Date().toISOString();
    const record = createPromotionRecord(input, promotionId, now);
    if (
      this._records.has(promotionId) ||
      hasSortedPromotionId(this._allIds, promotionId) ||
      Object.values(this._statusIds).some((ids) => hasSortedPromotionId(ids, promotionId))
    ) {
      throw new PromotionCurrentConflictError(promotionId, 'create');
    }
    this._records.set(promotionId, clonePromotion(record));
    insertSortedPromotionId(this._allIds, promotionId);
    insertSortedPromotionId(this._statusIds.draft, promotionId);
    return clonePromotion(record);
  }

  async get(promotionId: string): Promise<Promotion | null> {
    const record = this._records.get(promotionId);
    return record === undefined ? null : clonePromotion(record);
  }

  async listPage(
    params: PromotionPageParams,
    filter?: PromotionStoreFilter,
  ): Promise<PromotionStorePage> {
    const currentParams = currentPromotionPageParams(params);
    const ids = filter?.status ? this._statusIds[filter.status] : this._allIds;
    const start =
      currentParams.cursor === null ? 0 : firstPromotionIdAfter(ids, currentParams.cursor);
    const pageIds = ids.slice(start, start + currentParams.limit + 1);
    const records = pageIds.map((promotionId) => {
      const record = this._records.get(promotionId);
      if (record === undefined) {
        throw new Error(`Promotion index references missing record ${promotionId}`);
      }
      return record;
    });
    const hasMore = records.length > currentParams.limit;
    const promotions = records.slice(0, currentParams.limit).map(clonePromotion);
    return {
      promotions,
      nextCursor: hasMore ? promotions[promotions.length - 1]!.promotionId : null,
    };
  }

  async update(promotionId: string, input: AdminPromotionUpdateRequest): Promise<Promotion | null> {
    const now = new Date().toISOString();
    const patch = snapshotUpdatePromotionInput(input);
    const existing = this._records.get(promotionId);
    if (!existing) return null;
    const updated = updatePromotionRecord(existing, patch, now);
    this._records.set(promotionId, clonePromotion(updated));
    return clonePromotion(updated);
  }

  async transitionStatus(
    promotionId: string,
    newStatus: PromotionStatus,
    reason?: string,
  ): Promise<Promotion | null> {
    const now = new Date().toISOString();
    const existing = this._records.get(promotionId);
    if (!existing) return null;
    const updated = transitionPromotionRecord(existing, newStatus, reason, now);
    const oldStatusIds = this._statusIds[existing.status];
    const newStatusIds = this._statusIds[newStatus];
    if (
      !hasSortedPromotionId(this._allIds, promotionId) ||
      !hasSortedPromotionId(oldStatusIds, promotionId) ||
      hasSortedPromotionId(newStatusIds, promotionId)
    ) {
      throw new Error(`Promotion status index is inconsistent for ${promotionId}`);
    }
    removeSortedPromotionId(oldStatusIds, promotionId);
    insertSortedPromotionId(newStatusIds, promotionId);
    this._records.set(promotionId, clonePromotion(updated));
    return clonePromotion(updated);
  }

  async delete(promotionId: string): Promise<PromotionDeleteResult> {
    const decision = decidePromotionDelete(this._records.get(promotionId) ?? null);
    if (decision === 'not_found') return { status: 'not_found' };
    if (decision === 'not_deletable') return { status: 'not_deletable' };
    if (
      !hasSortedPromotionId(this._allIds, promotionId) ||
      !hasSortedPromotionId(this._statusIds.draft, promotionId)
    ) {
      throw new Error(`Promotion index is inconsistent for ${promotionId}`);
    }
    this._records.delete(promotionId);
    removeSortedPromotionId(this._allIds, promotionId);
    removeSortedPromotionId(this._statusIds.draft, promotionId);
    return { status: 'deleted' };
  }
}

// ─────────────────────────────────────────────
// Redis Implementation (production)
// ─────────────────────────────────────────────

export interface RedisPromotionStoreOptions {
  keyPrefix?: string;
}

/**
 * Redis-backed Promotion Store.
 *
 * Uses explicit same-score ZSET indexes for bounded lexicographic pages (no SCAN).
 * All writes maintain index consistency atomically via Lua.
 */
export class RedisPromotionStore implements PromotionStoreAdapter {
  private readonly _client: RedisClientLike;
  private readonly _prefix: string;

  constructor(client: RedisClientLike, options: RedisPromotionStoreOptions = {}) {
    this._client = client;
    this._prefix = options.keyPrefix ?? 'stelis:promo:';
  }

  private _recordKey(id: string): string {
    return `${this._prefix}${id}`;
  }

  /**
   * Canonical Redis key for the promotion record, exposed for callers that
   * need to pass the key into an adjacent atomic Lua script (e.g. the
   * execution ledger's claim CAS re-reading `status`). The key shape is
   * owned here — the ledger must not duplicate the prefix logic.
   */
  recordKey(id: string): string {
    return this._recordKey(id);
  }

  private get _allIndexKey(): string {
    return `${this._prefix}index:all`;
  }

  private _statusIndexKey(status: PromotionStatus): string {
    return `${this._prefix}index:status:${status}`;
  }

  private async _readSerialized(
    promotionId: string,
  ): Promise<{ readonly raw: string; readonly record: Promotion } | null> {
    const raw = await this._client.get(this._recordKey(promotionId));
    return raw === null ? null : { raw, record: JSON.parse(raw) as Promotion };
  }

  async create(input: AdminPromotionCreateRequest): Promise<Promotion> {
    const promotionId = parsePromotionId(crypto.randomUUID(), 'generated promotionId');
    const now = new Date().toISOString();
    const record = createPromotionRecord(input, promotionId, now);

    const json = JSON.stringify(record);
    const result = await this._client.eval(
      CREATE_LUA,
      [
        this._recordKey(promotionId),
        this._allIndexKey,
        this._statusIndexKey('draft'),
        this._statusIndexKey('active'),
        this._statusIndexKey('paused'),
        this._statusIndexKey('archived'),
      ],
      [json, promotionId],
    );
    if (result === 'CURRENT_CONFLICT') {
      throw new PromotionCurrentConflictError(promotionId, 'create');
    }
    if (result === 'INDEX_CONFLICT') {
      throw new Error(`Promotion index conflict while creating ${promotionId}`);
    }
    if (result !== 'OK') throw new Error(`Unexpected CREATE_LUA result: ${String(result)}`);
    return record;
  }

  async get(promotionId: string): Promise<Promotion | null> {
    return (await this._readSerialized(promotionId))?.record ?? null;
  }

  async listPage(
    params: PromotionPageParams,
    filter?: PromotionStoreFilter,
  ): Promise<PromotionStorePage> {
    const currentParams = currentPromotionPageParams(params);
    const indexKey = filter?.status ? this._statusIndexKey(filter.status) : this._allIndexKey;
    const result = await this._client.eval(
      PAGE_LUA,
      [indexKey],
      [this._prefix, currentParams.cursor ?? '', String(currentParams.limit + 1)],
    );

    if (!Array.isArray(result) || result.length === 0) {
      throw new Error('Unexpected PAGE_LUA result');
    }
    if (result[0] === 'INDEX_RECORD_MISSING') {
      throw new Error(`Promotion index references missing record ${String(result[1])}`);
    }
    if (result[0] !== 'OK') {
      throw new Error(`Unexpected PAGE_LUA result: ${String(result[0])}`);
    }
    if ((result.length - 1) % 2 !== 0) {
      throw new Error('PAGE_LUA returned an incomplete ID/record pair');
    }
    const rows: Array<{ readonly promotionId: string; readonly record: Promotion }> = [];
    for (let index = 1; index < result.length; index += 2) {
      const promotionId = result[index];
      const raw = result[index + 1];
      if (typeof promotionId !== 'string' || typeof raw !== 'string') {
        throw new Error('PAGE_LUA returned a non-string ID/record pair');
      }
      const record = JSON.parse(raw) as Promotion;
      if (record.promotionId !== promotionId) {
        throw new Error(`Promotion index identity mismatch for ${promotionId}`);
      }
      rows.push({ promotionId, record });
    }
    const hasMore = rows.length > currentParams.limit;
    const returnedRows = rows.slice(0, currentParams.limit);
    const promotions = returnedRows.map(({ record }) => record);
    return {
      promotions,
      nextCursor: hasMore ? returnedRows[returnedRows.length - 1]!.promotionId : null,
    };
  }

  async update(promotionId: string, input: AdminPromotionUpdateRequest): Promise<Promotion | null> {
    const now = new Date().toISOString();
    const patch = snapshotUpdatePromotionInput(input);
    const current = await this._readSerialized(promotionId);
    if (current === null) return null;
    const updated = updatePromotionRecord(current.record, patch, now);
    const result = await this._client.eval(
      UPDATE_LUA,
      [this._recordKey(promotionId)],
      [current.raw, JSON.stringify(updated)],
    );
    if (result === 'CURRENT_CONFLICT') {
      throw new PromotionCurrentConflictError(promotionId, 'update');
    }
    if (result !== 'OK') throw new Error(`Unexpected UPDATE_LUA result: ${String(result)}`);
    return updated;
  }

  async transitionStatus(
    promotionId: string,
    newStatus: PromotionStatus,
    reason?: string,
  ): Promise<Promotion | null> {
    const now = new Date().toISOString();
    const current = await this._readSerialized(promotionId);
    if (current === null) return null;
    const updated = transitionPromotionRecord(current.record, newStatus, reason, now);
    const result = await this._client.eval(
      STATUS_LUA,
      [
        this._recordKey(promotionId),
        this._statusIndexKey(current.record.status),
        this._statusIndexKey(newStatus),
        this._allIndexKey,
      ],
      [current.raw, JSON.stringify(updated), promotionId],
    );
    if (result === 'OK') return updated;
    if (result === 'CURRENT_CONFLICT') {
      throw new PromotionCurrentConflictError(promotionId, 'status');
    }
    if (result === 'INDEX_CONFLICT') {
      throw new Error(`Promotion index conflict while changing status for ${promotionId}`);
    }
    throw new Error(`Unexpected STATUS_LUA result: ${String(result)}`);
  }

  async delete(promotionId: string): Promise<PromotionDeleteResult> {
    const expectedRaw = await this._client.get(this._recordKey(promotionId));
    const decision = decidePromotionDelete(
      expectedRaw === null ? null : (JSON.parse(expectedRaw) as Promotion),
    );
    const result = await this._client.eval(
      DELETE_LUA,
      [this._recordKey(promotionId), this._allIndexKey, this._statusIndexKey('draft')],
      [expectedRaw ?? '', promotionId],
    );
    if (result === 'OK') {
      if (decision !== 'delete') throw new Error('DELETE_LUA contradicted the current record');
      return { status: 'deleted' };
    }
    if (result === 'NOT_FOUND') {
      if (decision !== 'not_found') {
        throw new PromotionCurrentConflictError(promotionId, 'delete');
      }
      return { status: 'not_found' };
    }
    if (result === 'NOT_DELETABLE') {
      if (decision !== 'not_deletable') {
        throw new Error('DELETE_LUA contradicted the current record');
      }
      return { status: 'not_deletable' };
    }
    if (result === 'CURRENT_CONFLICT') {
      throw new PromotionCurrentConflictError(promotionId, 'delete');
    }
    if (result === 'INDEX_CONFLICT') {
      throw new Error(`Promotion index conflict while deleting ${promotionId}`);
    }
    throw new Error(`Unexpected DELETE_LUA result: ${String(result)}`);
  }
}

// ─────────────────────────────────────────────
// Lua Scripts
// ─────────────────────────────────────────────

/**
 * CREATE — atomic SET + ZADD (all index + status index).
 *
 * KEYS[1] = record key
 * KEYS[2] = all index key
 * KEYS[3] = status index key (draft)
 * KEYS[4..6] = remaining status index keys
 * ARGV[1] = JSON record
 * ARGV[2] = promotionId
 */
const CREATE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 'CURRENT_CONFLICT' end
for i = 2, #KEYS do
  if redis.call('ZSCORE', KEYS[i], ARGV[2]) then return 'INDEX_CONFLICT' end
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], 0, ARGV[2])
redis.call('ZADD', KEYS[3], 0, ARGV[2])
return 'OK'
`;

/**
 * PAGE — bounded exclusive lex read followed by MGET in one Redis snapshot.
 *
 * Every member has score zero, so ZRANGEBYLEX applies raw byte ordering.
 * Missing indexed records fail closed instead of shortening or shifting a page.
 *
 * KEYS[1] = sorted index key (all or status-specific)
 * ARGV[1] = record key prefix
 * ARGV[2] = exclusive cursor, or empty string for the first page
 * ARGV[3] = bounded ID read count (`limit + 1`)
 */
const PAGE_LUA = `
local min = '-'
if ARGV[2] ~= '' then min = '(' .. ARGV[2] end
local ids = redis.call('ZRANGEBYLEX', KEYS[1], min, '+', 'LIMIT', 0, tonumber(ARGV[3]))
if #ids == 0 then return {'OK'} end
local keys = {}
for i, id in ipairs(ids) do
  keys[i] = ARGV[1] .. id
end
local records = redis.call('MGET', unpack(keys))
local result = {'OK'}
for i = 1, #ids do
  local raw = records[i]
  if not raw then return {'INDEX_RECORD_MISSING', ids[i]} end
  result[#result + 1] = ids[i]
  result[#result + 1] = raw
end
return result
`;

/**
 * UPDATE — exact-current-record CAS followed by record replacement.
 *
 * KEYS[1] = record key
 * ARGV[1] = exact serialized record observed by the caller
 * ARGV[2] = serialized target record
 */
const UPDATE_LUA = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw or currentRaw ~= ARGV[1] then return 'CURRENT_CONFLICT' end
redis.call('SET', KEYS[1], ARGV[2])
return 'OK'
`;

/**
 * STATUS — exact-current-record CAS, record update, and status-index move.
 *
 * KEYS[1] = record key
 * KEYS[2] = old status index key
 * KEYS[3] = new status index key
 * KEYS[4] = all-promotions index key
 * ARGV[1] = exact serialized record observed by the caller
 * ARGV[2] = serialized target record
 * ARGV[3] = promotionId
 */
const STATUS_LUA = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw or currentRaw ~= ARGV[1] then return 'CURRENT_CONFLICT' end
if tonumber(redis.call('ZSCORE', KEYS[2], ARGV[3]) or '-1') ~= 0 or
   redis.call('ZSCORE', KEYS[3], ARGV[3]) or
   tonumber(redis.call('ZSCORE', KEYS[4], ARGV[3]) or '-1') ~= 0 then
  return 'INDEX_CONFLICT'
end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[3])
redis.call('ZADD', KEYS[3], 0, ARGV[3])
return 'OK'
`;

/**
 * DELETE — exact-current-record CAS, draft check, and atomic index removal.
 *
 * KEYS[1] = record key
 * KEYS[2] = all index key
 * KEYS[3] = status index key (draft)
 * ARGV[1] = exact serialized record observed by the caller, or empty if absent
 * ARGV[2] = promotionId
 */
const DELETE_LUA = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  if ARGV[1] == '' then
    if redis.call('ZSCORE', KEYS[2], ARGV[2]) or redis.call('ZSCORE', KEYS[3], ARGV[2]) then
      return 'INDEX_CONFLICT'
    end
    return 'NOT_FOUND'
  end
  return 'CURRENT_CONFLICT'
end
if ARGV[1] == '' or currentRaw ~= ARGV[1] then return 'CURRENT_CONFLICT' end
local current = cjson.decode(currentRaw)
local allScore = tonumber(redis.call('ZSCORE', KEYS[2], ARGV[2]) or '-1')
local draftScore = redis.call('ZSCORE', KEYS[3], ARGV[2])
if current.status ~= 'draft' then
  if allScore ~= 0 or draftScore then return 'INDEX_CONFLICT' end
  return 'NOT_DELETABLE'
end
if allScore ~= 0 or tonumber(draftScore or '-1') ~= 0 then return 'INDEX_CONFLICT' end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZREM', KEYS[3], ARGV[2])
return 'OK'
`;
