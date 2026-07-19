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
  PROMOTION_STATUSES,
} from '@stelis/contracts';
import type { RedisClientLike } from '../store/redisClient.js';
import type { Promotion, PromotionStatus } from './domain.js';
import { parsePromotionLedgerBudget } from './executionLedgerValueGuards.js';
import {
  decodePromotionAccountingRecord,
  decodePromotionRecord,
  promotionAccountingKey,
  PromotionRecordCorruptionError,
  serializePromotionRecord,
  type CurrentPromotionRecord,
} from './promotionRecords.js';

// ─────────────────────────────────────────────
// Store contract
// ─────────────────────────────────────────────

/** Atomic outcome of deleting the current Promotion record. */
export type PromotionDeleteResult =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'not_deletable' };

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

  /** Read the strict current Promotion and its exact stored representation. */
  readCurrent(promotionId: string): Promise<CurrentPromotionRecord | null>;

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

const PROMOTION_STATUS_INDEX_FIRST_KEY = 3;
const PROMOTION_STATUS_INDEX_LAST_KEY =
  PROMOTION_STATUS_INDEX_FIRST_KEY + PROMOTION_STATUSES.length - 1;
const PROMOTION_PAGE_STATUS_MEMBERSHIP_OFFSET = 3;
const PROMOTION_PAGE_ROW_WIDTH =
  PROMOTION_PAGE_STATUS_MEMBERSHIP_OFFSET + PROMOTION_STATUSES.length;
const PROMOTION_ACCOUNTING_DELETE_KEY = PROMOTION_STATUS_INDEX_LAST_KEY + 1;

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

interface PromotionIndexProjection {
  readonly all: boolean;
  readonly statuses: Readonly<Record<PromotionStatus, boolean>>;
}

function assertPromotionIndexProjection(
  record: Promotion,
  projection: PromotionIndexProjection,
): void {
  const currentStatusPresent = projection.statuses[record.status];
  const statusMembershipCount = PROMOTION_STATUSES.filter(
    (status) => projection.statuses[status],
  ).length;
  if (!projection.all || !currentStatusPresent || statusMembershipCount !== 1) {
    throw new PromotionRecordCorruptionError(
      `Promotion index projection is inconsistent with ${record.promotionId} status ${record.status}`,
    );
  }
}

function hasPromotionIndexMembership(projection: PromotionIndexProjection): boolean {
  return projection.all || PROMOTION_STATUSES.some((status) => projection.statuses[status]);
}

function statusIndexKeyPosition(status: PromotionStatus): number {
  return PROMOTION_STATUSES.indexOf(status) + PROMOTION_STATUS_INDEX_FIRST_KEY;
}

function parseIndexMembership(value: unknown, label: string): boolean {
  if (value === '1') return true;
  if (value === '0') return false;
  throw new PromotionRecordCorruptionError(`${label} is not a current index membership`);
}

function parseStatusIndexMembership(
  row: readonly unknown[],
  rowStart: number,
  status: PromotionStatus,
): boolean {
  const statusOffset = PROMOTION_STATUSES.indexOf(status);
  return parseIndexMembership(
    row[rowStart + PROMOTION_PAGE_STATUS_MEMBERSHIP_OFFSET + statusOffset],
    `Promotion ${status}-index membership`,
  );
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
  private _accountingExists: (promotionId: string) => boolean = () => false;

  /** Bind the matching Memory ledger's accounting-existence authority. */
  bindAccountingExists(probe: (promotionId: string) => boolean): void {
    this._accountingExists = probe;
  }

  /** Generate a deterministic test ID. Override for custom IDs. */
  protected generateId(): string {
    this._counter++;
    const suffix = this._counter.toString(16).padStart(12, '0');
    if (suffix.length > 12) {
      throw new Error('MemoryPromotionStore deterministic UUID space is exhausted');
    }
    return `00000000-0000-4000-8000-${suffix}`;
  }

  private indexProjection(promotionId: string): PromotionIndexProjection {
    return {
      all: hasSortedPromotionId(this._allIds, promotionId),
      statuses: {
        draft: hasSortedPromotionId(this._statusIds.draft, promotionId),
        active: hasSortedPromotionId(this._statusIds.active, promotionId),
        paused: hasSortedPromotionId(this._statusIds.paused, promotionId),
        archived: hasSortedPromotionId(this._statusIds.archived, promotionId),
      },
    };
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
      hasPromotionIndexMembership(this.indexProjection(promotionId))
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

  /**
   * Read the exact current record without yielding the JavaScript event loop.
   *
   * The adjacent memory ledger uses this method so its Promotion check and
   * ledger Map mutation execute in one synchronous turn, matching the Redis
   * adapter's atomic script boundary.
   */
  readCurrentSync(promotionId: string): CurrentPromotionRecord | null {
    const record = this._records.get(promotionId);
    if (record === undefined) return null;
    const promotion = decodePromotionRecord(serializePromotionRecord(record));
    if (promotion.promotionId !== promotionId) {
      throw new PromotionRecordCorruptionError(
        'Promotion record identity does not match its store key',
      );
    }
    return { promotion, serialized: serializePromotionRecord(promotion) };
  }

  async readCurrent(promotionId: string): Promise<CurrentPromotionRecord | null> {
    return this.readCurrentSync(promotionId);
  }

  async listPage(
    params: PromotionPageParams,
    filter?: PromotionStoreFilter,
  ): Promise<PromotionStorePage> {
    const currentParams = currentPromotionPageParams(params);
    const status = filter?.status;
    const ids = status ? this._statusIds[status] : this._allIds;
    const start =
      currentParams.cursor === null ? 0 : firstPromotionIdAfter(ids, currentParams.cursor);
    const pageIds = ids.slice(start, start + currentParams.limit + 1);
    const records = pageIds.map((promotionId) => {
      const record = this._records.get(promotionId);
      if (record === undefined) {
        throw new Error(`Promotion index references missing record ${promotionId}`);
      }
      assertPromotionIndexProjection(record, this.indexProjection(promotionId));
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
    assertPromotionIndexProjection(existing, this.indexProjection(promotionId));
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
    assertPromotionIndexProjection(existing, this.indexProjection(promotionId));
    const oldStatusIds = this._statusIds[existing.status];
    const newStatusIds = this._statusIds[newStatus];
    removeSortedPromotionId(oldStatusIds, promotionId);
    insertSortedPromotionId(newStatusIds, promotionId);
    this._records.set(promotionId, clonePromotion(updated));
    return clonePromotion(updated);
  }

  async delete(promotionId: string): Promise<PromotionDeleteResult> {
    const record = this._records.get(promotionId) ?? null;
    const decision = decidePromotionDelete(record);
    const projection = this.indexProjection(promotionId);
    const accountingExists = this._accountingExists(promotionId);
    if (accountingExists && (record === null || record.status === 'draft')) {
      throw new PromotionRecordCorruptionError(
        'A missing or draft Promotion must not have accounting state',
      );
    }
    if (record === null) {
      if (hasPromotionIndexMembership(projection)) {
        throw new PromotionRecordCorruptionError(
          `Promotion indexes exist without record ${promotionId}`,
        );
      }
      return { status: 'not_found' };
    }
    assertPromotionIndexProjection(record, projection);
    if (decision === 'not_deletable') return { status: 'not_deletable' };
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

  private get _statusIndexKeys(): readonly string[] {
    return PROMOTION_STATUSES.map((status) => this._statusIndexKey(status));
  }

  private async _readSerialized(
    promotionId: string,
  ): Promise<{ readonly raw: string; readonly record: Promotion } | null> {
    const raw = await this._client.get(this._recordKey(promotionId));
    if (raw === null) return null;
    const record = decodePromotionRecord(raw);
    if (record.promotionId !== promotionId) {
      throw new PromotionRecordCorruptionError(
        'Promotion record identity does not match its Redis key',
      );
    }
    return { raw, record };
  }

  async create(input: AdminPromotionCreateRequest): Promise<Promotion> {
    const promotionId = parsePromotionId(crypto.randomUUID(), 'generated promotionId');
    const now = new Date().toISOString();
    const record = createPromotionRecord(input, promotionId, now);

    const json = serializePromotionRecord(record);
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

  async readCurrent(promotionId: string): Promise<CurrentPromotionRecord | null> {
    const current = await this._readSerialized(promotionId);
    return current === null ? null : { promotion: current.record, serialized: current.raw };
  }

  async listPage(
    params: PromotionPageParams,
    filter?: PromotionStoreFilter,
  ): Promise<PromotionStorePage> {
    const currentParams = currentPromotionPageParams(params);
    const status = filter?.status;
    const indexKey = status ? this._statusIndexKey(status) : this._allIndexKey;
    const result = await this._client.eval(
      PAGE_LUA,
      [indexKey, this._allIndexKey, ...this._statusIndexKeys],
      [this._prefix, currentParams.cursor ?? '', String(currentParams.limit + 1)],
    );

    if (!Array.isArray(result) || result.length === 0) {
      throw new Error('Unexpected PAGE_LUA result');
    }
    if (result[0] === 'INDEX_RECORD_MISSING') {
      throw new Error(`Promotion index references missing record ${String(result[1])}`);
    }
    if (result[0] === 'INDEX_SCORE_INVALID') {
      throw new PromotionRecordCorruptionError(
        `Promotion index has a nonzero score for ${String(result[1])}`,
      );
    }
    if (result[0] !== 'OK') {
      throw new Error(`Unexpected PAGE_LUA result: ${String(result[0])}`);
    }
    if ((result.length - 1) % PROMOTION_PAGE_ROW_WIDTH !== 0) {
      throw new Error('PAGE_LUA returned an incomplete Promotion index row');
    }
    const rows: Array<{ readonly promotionId: string; readonly record: Promotion }> = [];
    for (let index = 1; index < result.length; index += PROMOTION_PAGE_ROW_WIDTH) {
      const promotionId = result[index];
      const raw = result[index + 1];
      if (typeof promotionId !== 'string' || typeof raw !== 'string') {
        throw new Error('PAGE_LUA returned a non-string ID/record pair');
      }
      const record = decodePromotionRecord(raw);
      if (record.promotionId !== promotionId) {
        throw new Error(`Promotion index identity mismatch for ${promotionId}`);
      }
      assertPromotionIndexProjection(record, {
        all: parseIndexMembership(result[index + 2], 'Promotion all-index membership'),
        statuses: {
          draft: parseStatusIndexMembership(result, index, 'draft'),
          active: parseStatusIndexMembership(result, index, 'active'),
          paused: parseStatusIndexMembership(result, index, 'paused'),
          archived: parseStatusIndexMembership(result, index, 'archived'),
        },
      });
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
      [this._recordKey(promotionId), this._allIndexKey, ...this._statusIndexKeys],
      [
        current.raw,
        serializePromotionRecord(updated),
        promotionId,
        String(statusIndexKeyPosition(current.record.status)),
      ],
    );
    if (result === 'CURRENT_CONFLICT') {
      throw new PromotionCurrentConflictError(promotionId, 'update');
    }
    if (result === 'INDEX_CONFLICT') {
      throw new Error(`Promotion index conflict while updating ${promotionId}`);
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
      [this._recordKey(promotionId), this._allIndexKey, ...this._statusIndexKeys],
      [
        current.raw,
        serializePromotionRecord(updated),
        promotionId,
        String(statusIndexKeyPosition(current.record.status)),
        String(statusIndexKeyPosition(newStatus)),
      ],
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
    const [current, accountingFields] = await Promise.all([
      this._readSerialized(promotionId),
      this._client.hgetall(promotionAccountingKey(promotionId)),
    ]);
    const expectedRaw = current?.raw ?? null;
    const decision = decidePromotionDelete(current?.record ?? null);
    if (Object.keys(accountingFields).length > 0) {
      const accounting = decodePromotionAccountingRecord(accountingFields);
      if (accounting.promotionId !== promotionId) {
        throw new PromotionRecordCorruptionError(
          'Promotion accounting identity does not match its Redis key',
        );
      }
      if (decision === 'not_found' || decision === 'delete') {
        throw new PromotionRecordCorruptionError(
          'A missing or draft Promotion must not have accounting state',
        );
      }
    }
    const result = await this._client.eval(
      DELETE_LUA,
      [
        this._recordKey(promotionId),
        this._allIndexKey,
        ...this._statusIndexKeys,
        promotionAccountingKey(promotionId),
      ],
      [
        expectedRaw ?? '',
        promotionId,
        decision,
        current === null ? '' : String(statusIndexKeyPosition(current.record.status)),
      ],
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
    if (result === 'ACCOUNTING_PRESENT') {
      throw new PromotionRecordCorruptionError(
        'A missing or draft Promotion acquired accounting state during deletion',
      );
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
 * Remaining KEYS = status indexes in `PROMOTION_STATUSES` order
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
redis.call('ZADD', KEYS[${statusIndexKeyPosition('draft')}], 0, ARGV[2])
return 'OK'
`;

/**
 * PAGE — bounded exclusive lex read followed by MGET in one Redis snapshot.
 *
 * Every member has score zero, so ZRANGEBYLEX applies raw byte ordering.
 * Missing indexed records fail closed instead of shortening or shifting a page.
 *
 * KEYS[1] = sorted index key (all or status-specific)
 * KEYS[2] = all-promotions index
 * Remaining KEYS = status indexes in `PROMOTION_STATUSES` order
 * ARGV[1] = record key prefix
 * ARGV[2] = exclusive cursor, or empty string for the first page
 * ARGV[3] = bounded ID read count (`limit + 1`)
 */
const PAGE_LUA = `
local function membership(key, id)
  local score = redis.call('ZSCORE', key, id)
  if not score then return '0' end
  if tonumber(score) ~= 0 then return nil end
  return '1'
end
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
  local allMember = membership(KEYS[2], ids[i])
  local statusMembers = {}
  for statusIndex = ${PROMOTION_STATUS_INDEX_FIRST_KEY}, ${PROMOTION_STATUS_INDEX_LAST_KEY} do
    local statusMember = membership(KEYS[statusIndex], ids[i])
    if not statusMember then return {'INDEX_SCORE_INVALID', ids[i]} end
    statusMembers[#statusMembers + 1] = statusMember
  end
  if not allMember then
    return {'INDEX_SCORE_INVALID', ids[i]}
  end
  result[#result + 1] = ids[i]
  result[#result + 1] = raw
  result[#result + 1] = allMember
  for _, statusMember in ipairs(statusMembers) do
    result[#result + 1] = statusMember
  end
end
return result
`;

/**
 * UPDATE — exact-current-record and index-projection CAS followed by record
 * replacement.
 *
 * KEYS[1] = record key
 * KEYS[2] = all-promotions index
 * Remaining KEYS = status indexes in `PROMOTION_STATUSES` order
 * ARGV[1] = exact serialized record observed by the caller
 * ARGV[2] = serialized target record
 * ARGV[3] = promotionId
 * ARGV[4] = current status-index key position
 */
const UPDATE_LUA = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw or currentRaw ~= ARGV[1] then return 'CURRENT_CONFLICT' end
local currentIndex = tonumber(ARGV[4])
if not currentIndex or
   currentIndex < ${PROMOTION_STATUS_INDEX_FIRST_KEY} or
   currentIndex > ${PROMOTION_STATUS_INDEX_LAST_KEY} then
  return 'INDEX_CONFLICT'
end
if tonumber(redis.call('ZSCORE', KEYS[2], ARGV[3]) or '-1') ~= 0 then
  return 'INDEX_CONFLICT'
end
for i = ${PROMOTION_STATUS_INDEX_FIRST_KEY}, ${PROMOTION_STATUS_INDEX_LAST_KEY} do
  local score = redis.call('ZSCORE', KEYS[i], ARGV[3])
  if i == currentIndex then
    if tonumber(score or '-1') ~= 0 then return 'INDEX_CONFLICT' end
  elseif score then
    return 'INDEX_CONFLICT'
  end
end
redis.call('SET', KEYS[1], ARGV[2])
return 'OK'
`;

/**
 * STATUS — exact-current-record CAS, record update, and status-index move.
 *
 * KEYS[1] = record key
 * KEYS[2] = all-promotions index
 * Remaining KEYS = status indexes in `PROMOTION_STATUSES` order
 * ARGV[1] = exact serialized record observed by the caller
 * ARGV[2] = serialized target record
 * ARGV[3] = promotionId
 * ARGV[4] = current status-index key position
 * ARGV[5] = target status-index key position
 */
const STATUS_LUA = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw or currentRaw ~= ARGV[1] then return 'CURRENT_CONFLICT' end
local currentIndex = tonumber(ARGV[4])
local targetIndex = tonumber(ARGV[5])
if not currentIndex or
   currentIndex < ${PROMOTION_STATUS_INDEX_FIRST_KEY} or
   currentIndex > ${PROMOTION_STATUS_INDEX_LAST_KEY} or
   not targetIndex or
   targetIndex < ${PROMOTION_STATUS_INDEX_FIRST_KEY} or
   targetIndex > ${PROMOTION_STATUS_INDEX_LAST_KEY} or
   currentIndex == targetIndex then
  return 'INDEX_CONFLICT'
end
if tonumber(redis.call('ZSCORE', KEYS[2], ARGV[3]) or '-1') ~= 0 then
  return 'INDEX_CONFLICT'
end
for i = ${PROMOTION_STATUS_INDEX_FIRST_KEY}, ${PROMOTION_STATUS_INDEX_LAST_KEY} do
  local score = redis.call('ZSCORE', KEYS[i], ARGV[3])
  if i == currentIndex then
    if tonumber(score or '-1') ~= 0 then return 'INDEX_CONFLICT' end
  elseif score then
    return 'INDEX_CONFLICT'
  end
end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('ZREM', KEYS[currentIndex], ARGV[3])
redis.call('ZADD', KEYS[targetIndex], 0, ARGV[3])
return 'OK'
`;

/**
 * DELETE — exact-current-record CAS, draft check, and atomic index removal.
 *
 * KEYS[1] = record key
 * KEYS[2] = all index key
 * Status-index KEYS follow in `PROMOTION_STATUSES` order
 * Final KEY = Promotion accounting record
 * ARGV[1] = exact serialized record observed by the caller, or empty if absent
 * ARGV[2] = promotionId
 * ARGV[3] = TypeScript-decoded delete decision
 * ARGV[4] = current status-index key position, or empty when absent
 */
const DELETE_LUA = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  if ARGV[1] == '' then
    for i = 2, ${PROMOTION_STATUS_INDEX_LAST_KEY} do
      if redis.call('ZSCORE', KEYS[i], ARGV[2]) then return 'INDEX_CONFLICT' end
    end
    if redis.call('EXISTS', KEYS[${PROMOTION_ACCOUNTING_DELETE_KEY}]) == 1 then
      return 'ACCOUNTING_PRESENT'
    end
    return 'NOT_FOUND'
  end
  return 'CURRENT_CONFLICT'
end
if ARGV[1] == '' or currentRaw ~= ARGV[1] then return 'CURRENT_CONFLICT' end
local currentIndex = tonumber(ARGV[4])
if not currentIndex or
   currentIndex < ${PROMOTION_STATUS_INDEX_FIRST_KEY} or
   currentIndex > ${PROMOTION_STATUS_INDEX_LAST_KEY} then
  return 'INDEX_CONFLICT'
end
if tonumber(redis.call('ZSCORE', KEYS[2], ARGV[2]) or '-1') ~= 0 then
  return 'INDEX_CONFLICT'
end
for i = ${PROMOTION_STATUS_INDEX_FIRST_KEY}, ${PROMOTION_STATUS_INDEX_LAST_KEY} do
  local score = redis.call('ZSCORE', KEYS[i], ARGV[2])
  if i == currentIndex then
    if tonumber(score or '-1') ~= 0 then return 'INDEX_CONFLICT' end
  elseif score then
    return 'INDEX_CONFLICT'
  end
end
if ARGV[3] ~= 'delete' then return 'NOT_DELETABLE' end
if currentIndex ~= ${statusIndexKeyPosition('draft')} then return 'INDEX_CONFLICT' end
if redis.call('EXISTS', KEYS[${PROMOTION_ACCOUNTING_DELETE_KEY}]) == 1 then
  return 'ACCOUNTING_PRESENT'
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZREM', KEYS[currentIndex], ARGV[2])
return 'OK'
`;
