/**
 * Sponsored execution log + aggregate — store types owned by app-api.
 *
 * Internal to app-api. core-api is recorder-blind: it ships
 * `SponsorResultMetadata` to the host callback, and the host translates
 * that metadata into one of these entries before calling the store.
 *
 * Store-shape contract:
 *   - Only the current exact shape is accepted. There is no versioned or
 *     compatibility reader.
 *   - `receiptId` is the one sponsored-execution identity. Persistent
 *     stores accept an exact replay of the same result but reject a
 *     different result for an already-recorded receipt.
 *   - Log-entry economic amount fields are exact MIST decimal strings
 *     (`hostNetMist` is signed). Accounting paths must never coerce them
 *     to JS `number`.
 *   - All numeric fields are `null` when `economicsStatus === "unknown"`,
 *     including `hostFeeMist` — the recorder MUST NOT coerce an
 *     unknown fee to `"0"` (numeric honesty: do not invent values).
 *     `hostFeeMist` is `"0"` only on a known row that explicitly
 *     carries a zero fee; otherwise it is the exact MIST decimal string.
 */

export type SponsoredExecutionMode = 'generic' | 'promotion';
export type SponsoredExecutionLogOutcome = 'success' | 'onchain_revert' | 'internal_error';

export function isSponsoredExecutionLogOutcome(
  value: unknown,
): value is SponsoredExecutionLogOutcome {
  return value === 'success' || value === 'onchain_revert' || value === 'internal_error';
}

/** Filter scope for aggregate / list queries. */
export type SponsoredExecutionAggregateMode = 'all' | SponsoredExecutionMode;

export type SponsoredExecutionEconomicsStatus = 'known' | 'unknown';

export interface SponsoredExecutionLogEntry {
  /** ISO-8601 timestamp at recorder write time. */
  readonly createdAt: string;
  readonly mode: SponsoredExecutionMode;
  /** On-chain or post-signature terminal outcome persisted by the recorder. */
  readonly outcome: SponsoredExecutionLogOutcome;
  /**
   * Receipt id consumed during sponsor processing. Always present — the
   * sponsored-execution recorder is invoked from the SponsoredExecutionPolicy `Release`
   * hook after `consume()`, where `prepared.receiptId` is required by the
   * sponsor result callback contract (`SponsorResultMetadata.receiptId`).
   * Store identity relies on this non-null guarantee.
   */
  readonly receiptId: string;
  readonly digest: string | null;
  readonly senderAddress: string;
  readonly sponsorAddress: string;
  readonly executionPathKey: string;
  /** Generic settlement orderId hash (sha256 hex) or null. */
  readonly orderIdHash: string | null;
  /** Promotion id — set only for `mode === 'promotion'`. */
  readonly promotionId: string | null;
  /** Promotion developer userId — set only for `mode === 'promotion'`. */
  readonly userId: string | null;

  // ── Economics fields ─────────────────────────────────────────────────
  /** Unsigned decimal MIST string. `null` when economicsStatus = unknown. */
  readonly recoveredGasMist: string | null;
  /** Unsigned decimal MIST string. `null` when economicsStatus = unknown. */
  readonly hostPaidGasMist: string | null;
  /** Signed decimal MIST string. `null` when economicsStatus = unknown. */
  readonly hostNetMist: string | null;
  /**
   * Unsigned decimal MIST string for known rows (`"0"` when fee is
   * explicitly zero). `null` when `economicsStatus === "unknown"` —
   * the recorder MUST NOT coerce an unknown fee to `"0"`.
   */
  readonly hostFeeMist: string | null;
  /**
   * Unsigned decimal MIST string for known rows (`"0"` when protocol fee is
   * explicitly zero). `null` when `economicsStatus === "unknown"`.
   * Protocol fee is protocol revenue and does NOT enter `hostNetMist`.
   */
  readonly protocolFeeMist: string | null;
  readonly grossGasMist: string | null;
  readonly storageRebateMist: string | null;
  readonly economicsStatus: SponsoredExecutionEconomicsStatus;
  readonly failureReason: string | null;
}

const SPONSORED_EXECUTION_LOG_KEYS = [
  'createdAt',
  'mode',
  'outcome',
  'receiptId',
  'digest',
  'senderAddress',
  'sponsorAddress',
  'executionPathKey',
  'orderIdHash',
  'promotionId',
  'userId',
  'recoveredGasMist',
  'hostPaidGasMist',
  'hostNetMist',
  'hostFeeMist',
  'protocolFeeMist',
  'grossGasMist',
  'storageRebateMist',
  'economicsStatus',
  'failureReason',
] as const;

const SIGNED_DECIMAL_RE = /^(?:0|-?[1-9]\d*)$/;
const UNSIGNED_DECIMAL_RE = /^(?:0|[1-9]\d*)$/;

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`sponsoredLogs: ${field} must be a string`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') {
    throw new Error(`sponsoredLogs: ${field} must be a string or null`);
  }
  return value;
}

function requireDecimal(value: unknown, field: string, signed: boolean): string {
  const pattern = signed ? SIGNED_DECIMAL_RE : UNSIGNED_DECIMAL_RE;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(
      `sponsoredLogs: ${field} must be a canonical ${signed ? 'signed' : 'unsigned'} decimal string`,
    );
  }
  return value;
}

function requireNullableDecimal(value: unknown, field: string, signed: boolean): string | null {
  if (value === null) return null;
  return requireDecimal(value, field, signed);
}

/** Validate and parse a canonical signed decimal string into a bigint. */
export function parseSignedDecimalString(value: unknown, field: string): bigint {
  return BigInt(requireDecimal(value, field, true));
}

/** Validate and parse a canonical unsigned decimal string into a bigint. */
export function parseUnsignedDecimalString(value: unknown, field: string): bigint {
  return BigInt(requireDecimal(value, field, false));
}

/**
 * Parse the one current sponsored-log shape.
 *
 * The returned object is an explicit projection rather than the caller's
 * object, so adapters cannot persist undeclared runtime keys or mutable
 * aliases. Generic and Promotion identity fields are checked as distinct
 * current shapes, and unknown economics may not carry invented numbers.
 */
export function parseSponsoredExecutionLogEntry(value: unknown): SponsoredExecutionLogEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('sponsoredLogs: entry must be an object');
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (
    keys.length !== SPONSORED_EXECUTION_LOG_KEYS.length ||
    !SPONSORED_EXECUTION_LOG_KEYS.every((key) => Object.hasOwn(source, key))
  ) {
    throw new Error('sponsoredLogs: entry must match the exact current shape');
  }

  const mode = source.mode;
  if (mode !== 'generic' && mode !== 'promotion') {
    throw new Error('sponsoredLogs: mode must be generic or promotion');
  }
  const outcome = source.outcome;
  if (!isSponsoredExecutionLogOutcome(outcome)) {
    throw new Error('sponsoredLogs: outcome must be a persisted terminal outcome');
  }
  const economicsStatus = source.economicsStatus;
  if (economicsStatus !== 'known' && economicsStatus !== 'unknown') {
    throw new Error('sponsoredLogs: economicsStatus must be known or unknown');
  }

  const orderIdHash = requireNullableString(source.orderIdHash, 'orderIdHash');
  const promotionId = requireNullableString(source.promotionId, 'promotionId');
  const userId = requireNullableString(source.userId, 'userId');
  if (mode === 'generic' && (promotionId !== null || userId !== null)) {
    throw new Error('sponsoredLogs: generic entry cannot carry Promotion identity');
  }
  if (mode === 'promotion' && (promotionId === null || userId === null || orderIdHash !== null)) {
    throw new Error(
      'sponsoredLogs: promotion entry requires promotionId/userId and no orderIdHash',
    );
  }

  let recoveredGasMist: string | null;
  let hostPaidGasMist: string | null;
  let hostNetMist: string | null;
  let hostFeeMist: string | null;
  let protocolFeeMist: string | null;
  let grossGasMist: string | null;
  let storageRebateMist: string | null;
  if (economicsStatus === 'known') {
    recoveredGasMist = requireDecimal(source.recoveredGasMist, 'recoveredGasMist', false);
    hostPaidGasMist = requireDecimal(source.hostPaidGasMist, 'hostPaidGasMist', false);
    hostNetMist = requireDecimal(source.hostNetMist, 'hostNetMist', true);
    hostFeeMist = requireDecimal(source.hostFeeMist, 'hostFeeMist', false);
    protocolFeeMist = requireNullableDecimal(source.protocolFeeMist, 'protocolFeeMist', false);
    grossGasMist = requireNullableDecimal(source.grossGasMist, 'grossGasMist', false);
    storageRebateMist = requireNullableDecimal(
      source.storageRebateMist,
      'storageRebateMist',
      false,
    );
  } else {
    const numericFields = [
      'recoveredGasMist',
      'hostPaidGasMist',
      'hostNetMist',
      'hostFeeMist',
      'protocolFeeMist',
      'grossGasMist',
      'storageRebateMist',
    ] as const;
    if (numericFields.some((field) => source[field] !== null)) {
      throw new Error('sponsoredLogs: unknown economics requires null numeric fields');
    }
    recoveredGasMist = null;
    hostPaidGasMist = null;
    hostNetMist = null;
    hostFeeMist = null;
    protocolFeeMist = null;
    grossGasMist = null;
    storageRebateMist = null;
  }

  return {
    createdAt: requireString(source.createdAt, 'createdAt'),
    mode,
    outcome,
    receiptId: requireString(source.receiptId, 'receiptId'),
    digest: requireNullableString(source.digest, 'digest'),
    senderAddress: requireString(source.senderAddress, 'senderAddress'),
    sponsorAddress: requireString(source.sponsorAddress, 'sponsorAddress'),
    executionPathKey: requireString(source.executionPathKey, 'executionPathKey'),
    orderIdHash,
    promotionId,
    userId,
    recoveredGasMist,
    hostPaidGasMist,
    hostNetMist,
    hostFeeMist,
    protocolFeeMist,
    grossGasMist,
    storageRebateMist,
    economicsStatus,
    failureReason: requireNullableString(source.failureReason, 'failureReason'),
  };
}

/**
 * Lifetime aggregate per mode. Recorder updates `all` and the entry's
 * specific mode atomically on append; readers select by `mode`.
 */
export interface SponsoredExecutionAggregate {
  readonly mode: SponsoredExecutionAggregateMode;
  /** Unsigned count of accepted recorder rows, with at most one row per receipt. */
  readonly sponsoredExecutions: string;
  /** Unsigned subset count whose known `hostNetMist` is negative. */
  readonly lossCount: string;
  /** Sum of known `hostNetMist` values in MIST. */
  readonly cumulativeHostNetMist: string;
  /** Sum of negative known `hostNetMist` values in MIST. */
  readonly cumulativeLossMist: string;
}
