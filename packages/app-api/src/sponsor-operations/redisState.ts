/**
 * [app-api] Redis-shared sponsor operations state store.
 *
 * Shared cross-instance state for per-slot and per-sponsor refill account operational
 * state. Slot observations compare the sampled `writeSeq` before Redis
 * authors `lastObservedAtMs` and the next sequence. Sponsor Refill Account
 * observations and spend transitions are owned by `accountSpendState.ts`.
 *
 * This matches the Redis server-time pattern used by
 * `packages/core-api/src/store/redisPrepareStore.ts`.
 *
 * Keyspace:
 *   - `stelis:app-api:sponsor-operations:slot:<address>` → HASH per slot.
 *   - `stelis:app-api:sponsor-operations:sponsor-refill-account` → HASH for sponsor refill account.
 *
 * Instance-local wall clocks and unconditional observation writes are not
 * accepted, so an older RPC sample cannot overwrite a newer operation.
 */

import type { RedisClientLike } from '@stelis/core-api';
import {
  isPositiveU64DecimalString,
  SPONSOR_SLOT_STATES,
  type SponsorSlotState,
} from '@stelis/contracts';

export const REFILL_RECONCILIATION_RESULTS = [
  'not_needed',
  'dispatch_started',
  'dispatch_ready',
  'dispatch_submitted',
  'dispatch_succeeded',
  'dispatch_failed',
] as const;

export type RefillReconciliationResult = (typeof REFILL_RECONCILIATION_RESULTS)[number];

// ─────────────────────────────────────────────
// Keyspace
// ─────────────────────────────────────────────

export const SPONSOR_OPERATIONS_KEY_PREFIX = 'stelis:app-api:sponsor-operations:';
export const slotKey = (address: string): string =>
  `${SPONSOR_OPERATIONS_KEY_PREFIX}slot:${address}`;
export const SPONSOR_REFILL_ACCOUNT_KEY = `${SPONSOR_OPERATIONS_KEY_PREFIX}sponsor-refill-account`;

// ─────────────────────────────────────────────
// Write-field contracts
// ─────────────────────────────────────────────

/**
 * Fields a caller may update on a slot HASH. Server-authored fields
 * (`lastObservedAtMs`, `writeSeq`) are intentionally absent.
 */
export interface SlotWriteFields {
  /** Current slot state, matching the SponsorSlotState enum. */
  state?: SponsorSlotState;
  /**
   * Last observed balance (decimal mist, as string). Empty string `""`
   * represents "unknown" (bootstrap pending or RPC unreachable).
   */
  balanceMist?: string;
  /** Last observed error. Normalized by sponsor operations writers. Empty means none. */
  lastError?: string;
  /** Refill transaction digest while the attempt still needs balance reconciliation. */
  pendingRefillDigest?: string;
  /** Refill transfer amount attempted for the current/last refill lifecycle. */
  refillAttemptedAmountMist?: string;
  /** Slot balance observed by the refill lifecycle before or during reconciliation. */
  refillObservedBalanceMist?: string;
  /** Current refill reconciliation status. Empty string clears stale status. */
  refillReconciliationResult?: RefillReconciliationResult | '';
  /** Durable Sponsor Refill Account spend that owns the refill projection. */
  refillOperationId?: string;
  /** Spend-local CAS sequence for the owning refill operation. */
  refillOperationSequence?: string;
  /** Current durable state of the owning refill spend. */
  refillOperationState?: string;
  /** Source balance required before a runway-blocked refill may be attempted again. */
  refillRequiredSourceBalanceMist?: string;
}

/** Fields a caller may update on the sponsor refill account HASH. */
export interface SponsorRefillAccountWriteFields {
  /** Last observed sponsor refill account balance (decimal mist string, or empty for unknown). */
  balanceMist?: string;
  /** `'1'` when sponsor refill account observation succeeded, `'0'` when it did not. */
  healthy?: '1' | '0';
  /** `floor(balance / refillTargetMist)` as decimal string, or empty when unknown. */
  refillsRemaining?: string;
  /** Last observed error. Normalized by sponsor operations writers. Empty means none. */
  lastError?: string;
}

// ─────────────────────────────────────────────
// Read shapes
// ─────────────────────────────────────────────

export interface SlotRead {
  readonly address: string;
  readonly state: SponsorSlotState | null;
  readonly balanceMist: string | null;
  readonly lastError: string | null;
  readonly lastObservedAtMs: number | null;
  readonly writeSeq: number | null;
  readonly pendingRefillDigest: string | null;
  readonly refillAttemptedAmountMist: string | null;
  readonly refillObservedBalanceMist: string | null;
  readonly refillReconciliationResult: RefillReconciliationResult | null;
  readonly refillOperationId: string | null;
  readonly refillOperationSequence: number | null;
  readonly refillOperationState: string | null;
  readonly refillRequiredSourceBalanceMist: string | null;
}

export interface SponsorRefillAccountRead {
  readonly balanceMist: string | null;
  readonly healthy: boolean | null;
  readonly refillsRemaining: number | null;
  readonly lastError: string | null;
  readonly lastObservedAtMs: number | null;
  readonly writeSeq: number | null;
}

// ─────────────────────────────────────────────
// Lua script — shared observation writer for slot and Sponsor Refill Account HASHes
// ─────────────────────────────────────────────

/** Apply an observation only when the sampled entity write sequence is still current. */
export const UPDATE_ENTITY_IF_SEQUENCE_LUA = [
  "local current = redis.call('HGET', KEYS[1], 'writeSeq') or '0'",
  "if current ~= ARGV[1] then return { 'STALE' } end",
  "local refillState = redis.call('HGET', KEYS[1], 'refillOperationState') or ''",
  "if refillState == 'reserved' or refillState == 'ready' or refillState == 'reconciling' then return { 'ACTIVE_REFILL' } end",
  "local time = redis.call('TIME')",
  'local nowMs = tostring(tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000))',
  "local seq = redis.call('HINCRBY', KEYS[1], 'writeSeq', 1)",
  "redis.call('HSET', KEYS[1], 'lastObservedAtMs', nowMs)",
  'local i = 2',
  'while i <= #ARGV do',
  "  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])",
  '  i = i + 2',
  'end',
  "return { 'UPDATED', tostring(seq) }",
].join('\n');

/**
 * Reads every slot HASH and the sponsor refill account HASH in one Redis
 * round trip. Missing HASH fields are returned as empty strings so the
 * TypeScript parser can keep positional fields stable.
 *
 * KEYS[1..N]  slot HASH keys followed by sponsor refill account HASH key.
 * ARGV[1..N]  slot addresses in the same order as the slot keys.
 */
export const READ_ALL_LUA = [
  'local slotRows = {}',
  'for i = 1, #ARGV do',
  '  local key = KEYS[i]',
  '  table.insert(slotRows, {',
  '    ARGV[i],',
  "    redis.call('HGET', key, 'state') or '',",
  "    redis.call('HGET', key, 'balanceMist') or '',",
  "    redis.call('HGET', key, 'lastError') or '',",
  "    redis.call('HGET', key, 'lastObservedAtMs') or '',",
  "    redis.call('HGET', key, 'writeSeq') or '',",
  "    redis.call('HGET', key, 'pendingRefillDigest') or '',",
  "    redis.call('HGET', key, 'refillAttemptedAmountMist') or '',",
  "    redis.call('HGET', key, 'refillObservedBalanceMist') or '',",
  "    redis.call('HGET', key, 'refillReconciliationResult') or '',",
  "    redis.call('HGET', key, 'refillOperationId') or '',",
  "    redis.call('HGET', key, 'refillOperationSequence') or '',",
  "    redis.call('HGET', key, 'refillOperationState') or '',",
  "    redis.call('HGET', key, 'refillRequiredSourceBalanceMist') or ''",
  '  })',
  'end',
  'local sponsorKey = KEYS[#KEYS]',
  'local sponsorRefillAccount = {',
  "  redis.call('HGET', sponsorKey, 'balanceMist') or '',",
  "  redis.call('HGET', sponsorKey, 'healthy') or '',",
  "  redis.call('HGET', sponsorKey, 'refillsRemaining') or '',",
  "  redis.call('HGET', sponsorKey, 'lastError') or '',",
  "  redis.call('HGET', sponsorKey, 'lastObservedAtMs') or '',",
  "  redis.call('HGET', sponsorKey, 'writeSeq') or ''",
  '}',
  'return { slotRows, sponsorRefillAccount }',
].join('\n');

// ─────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────

export interface RedisSponsorOperationsStateDeps {
  readonly client: RedisClientLike;
  /** Known slot addresses (for reject-unknown-address validation). */
  readonly slotAddresses: readonly string[];
}

export interface RedisSponsorOperationsState {
  /** Apply a sampled slot observation only if no intervening writer changed it. */
  updateSlotIfWriteSeq(
    address: string,
    expectedWriteSeq: number,
    fields: SlotWriteFields,
  ): Promise<boolean>;
  /** Read a slot HASH. Returns `null` if the key is missing. */
  readSlot(address: string): Promise<SlotRead | null>;
  /** Read the sponsor refill account HASH. Returns `null` if the key is missing. */
  readSponsorRefillAccount(): Promise<SponsorRefillAccountRead | null>;
  /**
   * Batched read of every slot HASH and the sponsor refill account HASH. Returned slots are in
   * the same order as `deps.slotAddresses`. Missing slot keys yield an
   * entry with `state === null` etc.; missing sponsor refill account key yields `null`
   * fields. This is the hot-path read used by the request gate and the
   * admin `/api/sponsor-operations` endpoint.
   */
  readAll(): Promise<{
    readonly slots: readonly SlotRead[];
    readonly sponsorRefillAccount: SponsorRefillAccountRead;
  }>;
}

function parseSlotState(raw: string | undefined): SponsorSlotState | null {
  if (raw === undefined) return null;
  return (SPONSOR_SLOT_STATES as readonly string[]).includes(raw)
    ? (raw as SponsorSlotState)
    : null;
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function parseStringOrNull(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  return raw === '' ? null : raw;
}

function parseRefillReconciliationResultOrNull(
  raw: string | undefined,
): RefillReconciliationResult | null {
  if (raw === undefined || raw === '') return null;
  return (REFILL_RECONCILIATION_RESULTS as readonly string[]).includes(raw)
    ? (raw as RefillReconciliationResult)
    : null;
}

function parseMistStringOrNull(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  return /^(?:0|[1-9]\d*)$/.test(raw) ? raw : null;
}

function parseRefillRequiredSourceBalanceMist(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  if (!isPositiveU64DecimalString(raw)) {
    throw new Error('Sponsor slot refill source balance threshold is malformed');
  }
  return raw;
}

function parseHealthyOrNull(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

function stringAt(row: readonly unknown[], index: number): string | undefined {
  const value = row[index];
  return typeof value === 'string' ? value : undefined;
}

function flattenWriteFields(fields: Record<string, string | undefined>): string[] {
  const argv: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    argv.push(k, v);
  }
  return argv;
}

function validateSlotRead(slot: SlotRead): SlotRead {
  if (slot.state === 'healthy' && slot.refillRequiredSourceBalanceMist !== null) {
    throw new Error('Healthy sponsor slot cannot retain a refill source balance threshold');
  }
  return slot;
}

export function createRedisSponsorOperationsState(
  deps: RedisSponsorOperationsStateDeps,
): RedisSponsorOperationsState {
  const slotSet = new Set(deps.slotAddresses);

  async function readSlot(address: string): Promise<SlotRead | null> {
    if (!slotSet.has(address)) {
      throw new Error(`RedisSponsorOperationsState.readSlot: unknown slot address ${address}`);
    }
    const hash = await deps.client.hgetall(slotKey(address));
    if (!hash || Object.keys(hash).length === 0) return null;
    return validateSlotRead({
      address,
      state: parseSlotState(hash.state),
      balanceMist: parseMistStringOrNull(hash.balanceMist),
      lastError: parseStringOrNull(hash.lastError),
      lastObservedAtMs: parseIntOrNull(hash.lastObservedAtMs),
      writeSeq: parseIntOrNull(hash.writeSeq),
      pendingRefillDigest: parseStringOrNull(hash.pendingRefillDigest),
      refillAttemptedAmountMist: parseMistStringOrNull(hash.refillAttemptedAmountMist),
      refillObservedBalanceMist: parseMistStringOrNull(hash.refillObservedBalanceMist),
      refillReconciliationResult: parseRefillReconciliationResultOrNull(
        hash.refillReconciliationResult,
      ),
      refillOperationId: parseStringOrNull(hash.refillOperationId),
      refillOperationSequence: parseIntOrNull(hash.refillOperationSequence),
      refillOperationState: parseStringOrNull(hash.refillOperationState),
      refillRequiredSourceBalanceMist: parseRefillRequiredSourceBalanceMist(
        hash.refillRequiredSourceBalanceMist,
      ),
    });
  }

  async function readSponsorRefillAccount(): Promise<SponsorRefillAccountRead | null> {
    const hash = await deps.client.hgetall(SPONSOR_REFILL_ACCOUNT_KEY);
    if (!hash || Object.keys(hash).length === 0) return null;
    return {
      balanceMist: parseMistStringOrNull(hash.balanceMist),
      healthy: parseHealthyOrNull(hash.healthy),
      refillsRemaining: parseIntOrNull(hash.refillsRemaining),
      lastError: parseStringOrNull(hash.lastError),
      lastObservedAtMs: parseIntOrNull(hash.lastObservedAtMs),
      writeSeq: parseIntOrNull(hash.writeSeq),
    };
  }

  async function updateSlotIfWriteSeq(
    address: string,
    expectedWriteSeq: number,
    fields: SlotWriteFields,
  ): Promise<boolean> {
    if (!slotSet.has(address)) {
      throw new Error(
        `RedisSponsorOperationsState.updateSlotIfWriteSeq: unknown slot address ${address}`,
      );
    }
    if (!Number.isSafeInteger(expectedWriteSeq) || expectedWriteSeq < 0) {
      throw new Error(
        'RedisSponsorOperationsState.updateSlotIfWriteSeq: expectedWriteSeq must be a non-negative safe integer',
      );
    }
    const normalizedFields: SlotWriteFields =
      fields.state === 'healthy' ? { ...fields, refillRequiredSourceBalanceMist: '' } : fields;
    const requiredSourceBalanceMist = normalizedFields.refillRequiredSourceBalanceMist;
    if (
      requiredSourceBalanceMist !== undefined &&
      requiredSourceBalanceMist !== '' &&
      !isPositiveU64DecimalString(requiredSourceBalanceMist)
    ) {
      throw new Error(
        'RedisSponsorOperationsState.updateSlotIfWriteSeq: refill source balance threshold must be a positive u64 decimal string',
      );
    }
    const argv = flattenWriteFields(normalizedFields as Record<string, string | undefined>);
    const raw = await deps.client.eval(
      UPDATE_ENTITY_IF_SEQUENCE_LUA,
      [slotKey(address)],
      [String(expectedWriteSeq), ...argv],
    );
    if (!Array.isArray(raw) || typeof raw[0] !== 'string') {
      throw new Error(
        'RedisSponsorOperationsState.updateSlotIfWriteSeq: unexpected Redis response',
      );
    }
    if (raw[0] === 'STALE' || raw[0] === 'ACTIVE_REFILL') return false;
    if (raw[0] !== 'UPDATED') {
      throw new Error('RedisSponsorOperationsState.updateSlotIfWriteSeq: invalid Redis result');
    }
    return true;
  }

  async function readAll(): Promise<{
    readonly slots: readonly SlotRead[];
    readonly sponsorRefillAccount: SponsorRefillAccountRead;
  }> {
    const slotAddresses = deps.slotAddresses;
    const raw = await deps.client.eval(
      READ_ALL_LUA,
      [...slotAddresses.map((addr) => slotKey(addr)), SPONSOR_REFILL_ACCOUNT_KEY],
      [...slotAddresses],
    );

    if (!Array.isArray(raw) || !Array.isArray(raw[0]) || !Array.isArray(raw[1])) {
      throw new Error('RedisSponsorOperationsState.readAll: unexpected Redis response shape');
    }

    const rawSlots = raw[0] as readonly unknown[];
    const sponsorRefillAccountRow = raw[1] as readonly unknown[];
    if (rawSlots.length !== slotAddresses.length) {
      throw new Error('RedisSponsorOperationsState.readAll: unexpected slot row count');
    }

    const slots: SlotRead[] = rawSlots.map((rawSlot, i) => {
      if (!Array.isArray(rawSlot)) {
        throw new Error('RedisSponsorOperationsState.readAll: unexpected slot row shape');
      }
      const row = rawSlot as readonly unknown[];
      const address = slotAddresses[i]!;
      const rowAddress = stringAt(row, 0);
      if (rowAddress !== address) {
        throw new Error('RedisSponsorOperationsState.readAll: unexpected slot row address');
      }

      return validateSlotRead({
        address,
        state: parseSlotState(stringAt(row, 1)),
        balanceMist: parseMistStringOrNull(stringAt(row, 2)),
        lastError: parseStringOrNull(stringAt(row, 3)),
        lastObservedAtMs: parseIntOrNull(stringAt(row, 4)),
        writeSeq: parseIntOrNull(stringAt(row, 5)),
        pendingRefillDigest: parseStringOrNull(stringAt(row, 6)),
        refillAttemptedAmountMist: parseMistStringOrNull(stringAt(row, 7)),
        refillObservedBalanceMist: parseMistStringOrNull(stringAt(row, 8)),
        refillReconciliationResult: parseRefillReconciliationResultOrNull(stringAt(row, 9)),
        refillOperationId: parseStringOrNull(stringAt(row, 10)),
        refillOperationSequence: parseIntOrNull(stringAt(row, 11)),
        refillOperationState: parseStringOrNull(stringAt(row, 12)),
        refillRequiredSourceBalanceMist: parseRefillRequiredSourceBalanceMist(stringAt(row, 13)),
      });
    });

    const sponsorRefillAccount: SponsorRefillAccountRead = {
      balanceMist: parseMistStringOrNull(stringAt(sponsorRefillAccountRow, 0)),
      healthy: parseHealthyOrNull(stringAt(sponsorRefillAccountRow, 1)),
      refillsRemaining: parseIntOrNull(stringAt(sponsorRefillAccountRow, 2)),
      lastError: parseStringOrNull(stringAt(sponsorRefillAccountRow, 3)),
      lastObservedAtMs: parseIntOrNull(stringAt(sponsorRefillAccountRow, 4)),
      writeSeq: parseIntOrNull(stringAt(sponsorRefillAccountRow, 5)),
    };

    return { slots, sponsorRefillAccount };
  }

  return {
    updateSlotIfWriteSeq,
    readSlot,
    readSponsorRefillAccount,
    readAll,
  };
}
