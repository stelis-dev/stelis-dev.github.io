/**
 * Sponsored execution log + aggregate — store types owned by app-api.
 *
 * Internal to app-api. core-api is recorder-blind: it ships
 * `SponsorResultMetadata` to the host callback, and the host translates
 * that metadata into one of these entries before calling the store.
 *
 * Store-shape contract:
 *   - `schemaVersion` identifies the log shape; bump together with reader
 *     updates.
 *   - Idempotency key is `(mode, receiptId, outcome)`. Persistent stores
 *     must enforce this as a unique constraint so retries do not
 *     double-count.
 *   - Numeric fields are exact MIST decimal strings (`hostNetMist`,
 *     `cumulativeHostNetMist`, and `cumulativeLossMist` are signed).
 *     Accounting paths must never coerce them to JS `number`.
 *   - All numeric fields are `null` when `economicsStatus === "unknown"`,
 *     including `hostFeeMist` — the recorder MUST NOT coerce an
 *     unknown fee to `"0"` (numeric honesty: do not invent values).
 *     `hostFeeMist` is `"0"` only on a known row that explicitly
 *     carries a zero fee; otherwise it is the exact MIST decimal string.
 */

export type SponsoredExecutionMode = 'generic' | 'promotion';

/** Filter scope for aggregate / list queries. */
export type SponsoredExecutionAggregateMode = 'all' | SponsoredExecutionMode;

export type SponsoredExecutionEconomicsStatus = 'known' | 'unknown';

export interface SponsoredExecutionLogEntry {
  /** Schema version for reader coordination. Bump on shape change. */
  readonly schemaVersion: 1;
  /** ISO-8601 timestamp at recorder write time. */
  readonly createdAt: string;
  readonly mode: SponsoredExecutionMode;
  /** Terminal outcome string carried from `SponsorResultMetadata.outcome`. */
  readonly outcome: string;
  /**
   * Receipt id consumed during sponsor processing. Always present — the
   * sponsored-execution recorder is invoked from the SponsoredExecutionPolicy `Release`
   * hook after `consume()`, where `prepared.receiptId` is required by the
   * sponsor result callback contract (`SponsorResultMetadata.receiptId`).
   * Idempotency key composition relies on this non-null guarantee.
   */
  readonly receiptId: string;
  readonly digest: string | null;
  readonly senderAddress: string | null;
  readonly sponsorAddress: string | null;
  readonly slotId: string | null;
  readonly executionPathKey: string | null;
  /** Generic settlement orderId hash (sha256 hex) or null. */
  readonly orderIdHash: string | null;
  /** Promotion id — set only for `mode === 'promotion'`. */
  readonly promotionId: string | null;
  /** Promotion developer userId — set only for `mode === 'promotion'`. */
  readonly userId: string | null;

  // ── Economics fields ─────────────────────────────────────────────────
  /** Signed decimal MIST string. `null` when economicsStatus = unknown. */
  readonly recoveredGasMist: string | null;
  /** Signed decimal MIST string. `null` when economicsStatus = unknown. */
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

/**
 * Lifetime aggregate per mode. Recorder updates `all` and the entry's
 * specific mode atomically on append; readers select by `mode`.
 */
export interface SponsoredExecutionAggregate {
  readonly mode: SponsoredExecutionAggregateMode;
  /** Unsigned count of sponsored executions in the aggregate. */
  readonly sponsoredExecutions: string;
  /** Unsigned cumulative `Loss Count`. */
  readonly lossCount: string;
  /** Sum of known `hostNetMist` values in MIST. */
  readonly cumulativeHostNetMist: string;
  /** Sum of negative known `hostNetMist` values in MIST. */
  readonly cumulativeLossMist: string;
}
