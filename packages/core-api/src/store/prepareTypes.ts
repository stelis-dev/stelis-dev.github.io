/** Current prepared receipt records shared by the prepare and sponsor runners. */
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';
import {
  isValidStudioUserId,
  isReceiptId,
  MAX_PROMOTION_LEDGER_VALUE_MIST,
  parsePromotionId,
} from '@stelis/contracts';
import { canonicalizeIpAddress } from '../clientIp.js';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const U64_MAX = (1n << 64n) - 1n;
const ORDER_ID_MAX_UTF8_BYTES = 128;
// ─────────────────────────────────────────────
// Draft and committed fields shared by all modes
// ─────────────────────────────────────────────

/**
 * Common caller-projected fields present in every prepared draft.
 * `issuedAt` is intentionally absent: the selected store is the sole clock
 * authority and adds it exactly once when the draft becomes committed.
 * Not exported — use the discriminated union `PreparedTxDraft` instead.
 *
 * Gas estimation fields are intentionally absent:
 *   - Generic: the sponsor path re-derives every settle value from
 *     `parseSettleArgs(txBytes)` at /relay/sponsor time
 *     (`ExtractedSettleArgs` is the execution authority), so the
 *     generic entry carries no settle observability copies.
 *   - Promotion: `reservedGasMist` lives on `PromotionPreparedTxEntry`.
 *     It is the ceiling passed to `ExecutionLedger.reserve()` and
 *     compared against actual execution gas in the Studio sponsor
 *     SponsoredExecutionPolicy sponsor result accounting (consume → structured log).
 */
interface PreparedTxDraftBase {
  // ── Binding (from QuoteStore pattern) ─────────────────────────
  /** Unique receipt ID */
  receiptId: string;
  /** User wallet address */
  senderAddress: string;

  // ── Anti-tampering ────────────────────────────────────────────
  /** SHA-256 hex of the full txBytes — verified in /sponsor */
  txBytesHash: string;

  // ── Slot reservation (from ExecuteTicketStore pattern) ────────
  /** Sponsor address that identifies the leased pool entry. */
  sponsorAddress: string;
  // The sponsor execution store atomically advances the stage-separated
  // sponsor lease proof with this prepared receipt. `sign()` verifies the
  // committed proof against `txBytesHash`. `sponsorAddress` is the lease
  // identity, `receiptId` binds it to one prepare operation, and no duplicate
  // lease material lives in this record.

  // ── IP tracking (for max concurrent enforcement) ─────────────
  /** Client IP that issued this prepare request */
  clientIp: string;

  // ── Execution path key (for structured error logging) ───────────────
  /**
   * Canonical execution path identifier: `{tokenType}:{hop1,hop2,...}:{settlementSwapDirection}`.
   * Derived from the matched AllowedSettlementSwapPath at /prepare time. Attached to sponsor
   * failure records so that ONCHAIN_REVERT logs can be correlated to a specific execution path.
   */
  executionPathKey: string;

  // ── Order ID (payment tracking) ─────────────────────────────────
  /** Original orderId from /prepare request (null if not provided). */
  orderId: string | null;
}

/** Store-committed fields shared by both modes. */
interface PreparedTxEntryBase extends PreparedTxDraftBase {
  /** Unix timestamp (ms) assigned by the store's clock authority. */
  issuedAt: number;
}

// ─────────────────────────────────────────────
// Mode-specific draft and committed entry types
// ─────────────────────────────────────────────

/** Generic prepare draft accepted by the sponsored execution store. */
export interface GenericPreparedTxDraft extends PreparedTxDraftBase {
  mode: 'generic';
  /** Server-assigned monotonic nonce for on-chain replay prevention. */
  nonce: bigint;
  promotionId?: never;
  userId?: never;
}

/** Promotion prepare draft accepted by the sponsored execution store. */
export interface PromotionPreparedTxDraft extends PreparedTxDraftBase {
  mode: 'promotion';
  promotionId: string;
  userId: string;
  reservedGasMist: bigint;
}

/** Exact current caller-to-store draft shape. */
export type PreparedTxDraft = GenericPreparedTxDraft | PromotionPreparedTxDraft;

/**
 * Generic relay prepare entry — `/relay/prepare` → `/relay/sponsor`.
 *
 * Coordination-only at `/relay/sponsor`. Every execution-critical settle
 * value (executionCostClaim, fee components, profile, policyHash,
 * quoteTimestampMs) is derived from the submitted `txBytes` via
 * `parseSettleArgs(...)` at sponsor time; `beginSponsoredExecution()` verifies
 * the submitted bytes' SHA-256 against `txBytesHash` from the prepare commit.
 * The store therefore carries
 * only the coordination fields the sponsor lifecycle needs (slot
 * identity, hash binding, receipt identity, IP/execution-path observability echo,
 * monotonic nonce compaction key, optional orderId echo for L2
 * reconstruction).
 *
 * Build-derived observability fields (`executionCostClaim`, `simGas`,
 * `gasVarianceFixedMist`, `slippageBufferMist`, `grossGas`, `profile`,
 * `quoteTimestampMs`, `policyHash`, `quotedHostFeeMist`) are not
 * persisted — sponsor authority never reads them from the store, and
 * keeping copies would invite drift. See
 * architecture/prepare-sponsor-session.md for the full coordination-only
 * contract.
 */
export interface GenericPreparedTxEntry extends PreparedTxEntryBase {
  mode: 'generic';
  /** Server-assigned monotonic nonce for on-chain replay prevention. */
  nonce: bigint;
  // Generic mode never carries promotion fields.
  promotionId?: never;
  userId?: never;
}

/**
 * Promotion prepare entry — `/studio/promotions/:id/prepare` → `.../sponsor`.
 *
 * Contains promotion-specific fields for ExecutionLedger reserve/consume/release.
 * Does NOT carry generic settle-specific fields (no settle PTB, no policy hash,
 * no host fee, no config drift detection, no GenericPrepareBuildOutput gas estimation fields).
 *
 * `reservedGasMist` is the amount passed to `ExecutionLedger.reserve()` at prepare
 * time and used as the ceiling for actual gas comparison in the Studio sponsor
 * SponsoredExecutionPolicy sponsor result accounting. It is the dry-run simGas +
 * GAS_VARIANCE_FIXED_MIST, not a "execution cost claim" in the generic settle sense.
 */
export interface PromotionPreparedTxEntry extends PreparedTxEntryBase {
  mode: 'promotion';

  /** Promotion ID — used to re-verify at sponsor time. */
  promotionId: string;
  /** Developer's userId — used for sponsor-side identity binding (security gate) and ledger audit. */
  userId: string;
  /**
   * Gas ceiling reserved via `ExecutionLedger.reserve()` at prepare time (MIST).
   * = dry-run simGas + GAS_VARIANCE_FIXED_MIST.
   * Compared to actual gas in the Studio sponsor SponsoredExecutionPolicy sponsor result
   * accounting to compute the delta released back to the ledger when actual <
   * reserved.
   *
   * Persisted as raw `bigint`. Internal computation paths keep the package's
   * internal nominal unit brand; the brand is dropped at the public store
   * boundary so that `@stelis/core-api`'s public declaration graph stays free
   * of package-internal types.
   */
  reservedGasMist: bigint;
}

/**
 * Discriminated union of all prepare entry modes.
 *
 * Use `entry.mode` to narrow:
 * ```ts
 * if (entry.mode === 'generic') {
 *   entry.promotionId;       // never — TS error
 * }
 * if (entry.mode === 'promotion') {
 *   entry.promotionId;       // string — accessible
 * }
 * ```
 */
export type PreparedTxEntry = GenericPreparedTxEntry | PromotionPreparedTxEntry;

const GENERIC_PREPARED_DRAFT_KEYS = [
  'mode',
  'receiptId',
  'senderAddress',
  'txBytesHash',
  'sponsorAddress',
  'clientIp',
  'executionPathKey',
  'orderId',
  'nonce',
] as const;

const PROMOTION_PREPARED_DRAFT_KEYS = [
  'mode',
  'receiptId',
  'senderAddress',
  'txBytesHash',
  'sponsorAddress',
  'clientIp',
  'executionPathKey',
  'orderId',
  'promotionId',
  'userId',
  'reservedGasMist',
] as const;

const GENERIC_PREPARED_ENTRY_KEYS = [...GENERIC_PREPARED_DRAFT_KEYS, 'issuedAt'] as const;

const PROMOTION_PREPARED_ENTRY_KEYS = [...PROMOTION_PREPARED_DRAFT_KEYS, 'issuedAt'] as const;

type PreparedShapeName = 'PreparedTxDraft' | 'PreparedTxEntry';

function requireRecord(value: unknown, shapeName: PreparedShapeName): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${shapeName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactPreparedKeys(
  value: unknown,
  shapeName: PreparedShapeName,
  genericKeys: readonly string[],
  promotionKeys: readonly string[],
): 'generic' | 'promotion' {
  const record = requireRecord(value, shapeName);
  const mode = record.mode;
  if (mode !== 'generic' && mode !== 'promotion') {
    throw new Error(`${shapeName}.mode must be "generic" or "promotion"`);
  }
  const expected = mode === 'generic' ? genericKeys : promotionKeys;
  const actual = Object.keys(record);
  if (actual.length !== expected.length) {
    throw new Error(`${shapeName}.${mode} has an unexpected field set`);
  }
  const expectedSet = new Set(expected);
  for (const key of actual) {
    if (!expectedSet.has(key)) {
      throw new Error(`${shapeName}.${mode} has an unexpected field: ${key}`);
    }
  }
  return mode;
}

/** Assert the exact current draft field set and return its discriminator. */
function assertCurrentPreparedTxDraftKeys(value: unknown): 'generic' | 'promotion' {
  return assertExactPreparedKeys(
    value,
    'PreparedTxDraft',
    GENERIC_PREPARED_DRAFT_KEYS,
    PROMOTION_PREPARED_DRAFT_KEYS,
  );
}

/**
 * Assert the exact current field set and return its discriminator.
 *
 * Redis calls this before converting decimal strings to bigint; Memory calls
 * it as part of the full runtime parser. Keeping the key authority here makes
 * unexpected, dual-identity, and cross-mode records fail in both adapters.
 * This symbol is store-internal and is not re-exported from the package barrel.
 */
export function assertCurrentPreparedTxEntryKeys(value: unknown): 'generic' | 'promotion' {
  return assertExactPreparedKeys(
    value,
    'PreparedTxEntry',
    GENERIC_PREPARED_ENTRY_KEYS,
    PROMOTION_PREPARED_ENTRY_KEYS,
  );
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  field: string,
  shapeName: PreparedShapeName,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${shapeName}.${field} must be a non-empty string`);
  }
  return value;
}

function requireCanonicalReceiptId(
  record: Record<string, unknown>,
  shapeName: PreparedShapeName,
): string {
  const value = requireNonEmptyString(record, 'receiptId', shapeName);
  if (!isReceiptId(value)) {
    throw new Error(`${shapeName}.receiptId must be a canonical receipt ID`);
  }
  return value;
}

function requireCanonicalAddress(
  record: Record<string, unknown>,
  field: 'senderAddress' | 'sponsorAddress',
  shapeName: PreparedShapeName,
): string {
  const value = requireNonEmptyString(record, field, shapeName);
  if (!isValidSuiAddress(value) || normalizeSuiAddress(value) !== value) {
    throw new Error(`${shapeName}.${field} must be a canonical Sui address`);
  }
  return value;
}

function requireSha256Hex(record: Record<string, unknown>, shapeName: PreparedShapeName): string {
  const value = requireNonEmptyString(record, 'txBytesHash', shapeName);
  if (!SHA256_HEX_RE.test(value)) {
    throw new Error(`${shapeName}.txBytesHash must be a lowercase SHA-256 hex string`);
  }
  return value;
}

function requireCanonicalClientIp(
  record: Record<string, unknown>,
  shapeName: PreparedShapeName,
): string {
  const value = requireNonEmptyString(record, 'clientIp', shapeName);
  if (canonicalizeIpAddress(value) !== value) {
    throw new Error(`${shapeName}.clientIp must be a canonical IP address`);
  }
  return value;
}

function requireBigIntRange(
  record: Record<string, unknown>,
  field: string,
  shapeName: PreparedShapeName,
  minimum: bigint,
  maximum: bigint,
): bigint {
  const value = record[field];
  if (typeof value !== 'bigint' || value < minimum || value > maximum) {
    throw new Error(
      `${shapeName}.${field} must be a bigint from ${minimum.toString()} to ${maximum.toString()}`,
    );
  }
  return value;
}

function requireOrderId(value: unknown, shapeName: PreparedShapeName): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${shapeName}.orderId must be a string or null`);
  }
  const length = Buffer.byteLength(value, 'utf8');
  if (length === 0 || length > ORDER_ID_MAX_UTF8_BYTES) {
    throw new Error(`${shapeName}.orderId must be 1-${ORDER_ID_MAX_UTF8_BYTES} UTF-8 bytes`);
  }
  return value;
}

function parsePreparedTxFields(
  record: Record<string, unknown>,
  mode: 'generic' | 'promotion',
  shapeName: PreparedShapeName,
): PreparedTxDraft {
  const common = {
    receiptId: requireCanonicalReceiptId(record, shapeName),
    senderAddress: requireCanonicalAddress(record, 'senderAddress', shapeName),
    txBytesHash: requireSha256Hex(record, shapeName),
    sponsorAddress: requireCanonicalAddress(record, 'sponsorAddress', shapeName),
    clientIp: requireCanonicalClientIp(record, shapeName),
    executionPathKey: requireNonEmptyString(record, 'executionPathKey', shapeName),
    orderId: requireOrderId(record.orderId, shapeName),
  } as const;

  if (mode === 'generic') {
    return {
      ...common,
      mode: 'generic',
      nonce: requireBigIntRange(record, 'nonce', shapeName, 1n, U64_MAX),
    };
  }
  const promotionId = requireNonEmptyString(record, 'promotionId', shapeName);
  try {
    parsePromotionId(promotionId, `${shapeName}.promotionId`);
  } catch {
    throw new Error(`${shapeName}.promotionId must be a canonical Promotion ID`);
  }
  const userId = requireNonEmptyString(record, 'userId', shapeName);
  if (!isValidStudioUserId(userId)) {
    throw new Error(`${shapeName}.userId must be a valid Studio user ID`);
  }
  return {
    ...common,
    mode: 'promotion',
    promotionId,
    userId,
    reservedGasMist: requireBigIntRange(
      record,
      'reservedGasMist',
      shapeName,
      1n,
      MAX_PROMOTION_LEDGER_VALUE_MIST,
    ),
  };
}

/** Validate and clone the exact current caller-to-store draft shape. */
export function parseCurrentPreparedTxDraft(value: unknown): PreparedTxDraft {
  const mode = assertCurrentPreparedTxDraftKeys(value);
  return parsePreparedTxFields(value as Record<string, unknown>, mode, 'PreparedTxDraft');
}

/**
 * Validate and clone the exact current in-memory prepared-entry shape.
 *
 * The returned object contains only declared fields. Both adapters use this
 * at their write/read boundaries so callers cannot mutate Memory storage by
 * retaining an input or `peek()` reference, and runtime-only extra fields can
 * never leak into Redis JSON.
 */
export function parseCurrentPreparedTxEntry(value: unknown): PreparedTxEntry {
  const mode = assertCurrentPreparedTxEntryKeys(value);
  const record = value as Record<string, unknown>;
  const issuedAt = record.issuedAt;
  if (!Number.isSafeInteger(issuedAt) || (issuedAt as number) <= 0) {
    throw new Error('PreparedTxEntry.issuedAt must be a positive safe integer');
  }
  const draft = parsePreparedTxFields(record, mode, 'PreparedTxEntry');
  return { ...draft, issuedAt: issuedAt as number };
}

const SERIALIZED_DECIMAL_RE = /^(?:0|[1-9]\d*)$/;

function serializedBigInt(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !SERIALIZED_DECIMAL_RE.test(value)) {
    throw new Error(`PreparedTxEntry.${field} must be a canonical decimal string`);
  }
  return BigInt(value);
}

/**
 * Serialize the one supported prepared-transaction record format.
 *
 * Redis coordination code exact-compares this returned byte string. It must
 * not reconstruct a second JSON shape or partially decode a malformed record
 * to invent cleanup identities.
 */
export function serializePreparedTxEntry(value: PreparedTxEntry): string {
  const entry = parseCurrentPreparedTxEntry(value);
  const common = {
    mode: entry.mode,
    receiptId: entry.receiptId,
    senderAddress: entry.senderAddress,
    txBytesHash: entry.txBytesHash,
    sponsorAddress: entry.sponsorAddress,
    clientIp: entry.clientIp,
    executionPathKey: entry.executionPathKey,
    orderId: entry.orderId,
  } as const;
  if (entry.mode === 'generic') {
    return JSON.stringify({ ...common, nonce: entry.nonce.toString(), issuedAt: entry.issuedAt });
  }
  return JSON.stringify({
    ...common,
    mode: 'promotion',
    promotionId: entry.promotionId,
    userId: entry.userId,
    reservedGasMist: entry.reservedGasMist.toString(),
    issuedAt: entry.issuedAt,
  });
}

/** Decode and validate the one supported serialized prepared record. */
export function decodePreparedTxEntry(
  serialized: string,
  expectedReceiptId?: string,
): PreparedTxEntry {
  if (typeof serialized !== 'string' || serialized.length === 0) {
    throw new Error('PreparedTxEntry must be non-empty JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('PreparedTxEntry must be valid JSON');
  }
  const mode = assertCurrentPreparedTxEntryKeys(parsed);
  const raw = parsed as Record<string, unknown>;
  if (expectedReceiptId !== undefined && raw.receiptId !== expectedReceiptId) {
    throw new Error('PreparedTxEntry receiptId does not match its storage key');
  }
  const converted: Record<string, unknown> = { ...raw };
  if (mode === 'generic') {
    converted.nonce = serializedBigInt(raw.nonce, 'nonce');
  } else {
    converted.reservedGasMist = serializedBigInt(raw.reservedGasMist, 'reservedGasMist');
  }
  const entry = parseCurrentPreparedTxEntry(converted);
  if (serializePreparedTxEntry(entry) !== serialized) {
    throw new Error('PreparedTxEntry must use canonical JSON');
  }
  return entry;
}
