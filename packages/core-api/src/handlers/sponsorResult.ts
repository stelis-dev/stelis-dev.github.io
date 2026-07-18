/**
 * Sponsor result host callback contract.
 *
 * The sponsored execution store persists this value with the receipt's final
 * state before the runner or recovery task invokes the host callback. The callback is the supported API for
 * per-action sponsor operations state update AND for the sponsored-execution
 * recorder.
 *
 * Contract:
 *   - The durable final record is the delivery source of truth.
 *   - A callback failure leaves delivery pending for bounded recovery; it never
 *     changes the primary execution result.
 *   - Successful delivery is acknowledged by an exact compare-and-set.
 */

/** Final outcome of a sponsor run, matching existing error classification rules. */
export type SponsorResultOutcome =
  | 'success'
  | 'onchain_revert'
  | 'preflight_failure'
  | 'congestion'
  | 'validation_failure'
  | 'internal_error';

/**
 * Furthest irreversible execution boundary reached by the sponsor run.
 *
 * This is produced by the signing/submission boundary and carried as
 * structured metadata. Consumers must not reconstruct it from error text.
 */
export type SponsorExecutionStage =
  | 'before_sponsor_signature'
  | 'after_sponsor_signature'
  | 'on_chain';

/** Route that produced the sponsor result event. */
export type SponsorResultRoute = 'generic' | 'promotion';

/**
 * Economics block carried with the sponsor result metadata. Whether a row is
 * persisted at all is owned by the host callback (the
 * `sponsoredLogs` recorder in `app-api`); core-api emits this block
 * for every sponsor result event regardless of recorder filter. When the
 * host recorder does persist the row, monetary fields and aggregates
 * are derived strictly from this block.
 *
 * Numeric fields are exact MIST decimal strings (`hostNetMist` is
 * signed and may be negative).
 *
 * `protocolFeeMist` is auxiliary context — recorder must NOT subtract
 * it from `hostNetMist`; protocol fee flows from user surplus to
 * protocol treasury, not to the Host.
 *
 * `economicsStatus = "unknown"` means the sponsor result path could not
 * prove both the recovered amount and the host-paid amount. When
 * the host recorder writes such a row, every monetary field on it is
 * `null` and the row is excluded from net/loss aggregates. Whether
 * such a row is written at all is the recorder's outcome-and-stage
 * decision (see `packages/app-api/src/sponsoredLogs/recorder.ts`).
 * `failureReason` is diagnostic text only; it is never an execution-stage
 * discriminator.
 */
export type SponsorResultEconomics =
  | {
      readonly economicsStatus: 'unknown';
      readonly failureReason: string | null;
    }
  | {
      readonly economicsStatus: 'known';
      readonly recoveredGasMist: string;
      readonly hostPaidGasMist: string;
      readonly hostFeeMist: string;
      readonly hostNetMist: string;
      readonly grossGasMist: string | null;
      readonly storageRebateMist: string | null;
      readonly protocolFeeMist: string | null;
      readonly failureReason: string | null;
    };

/**
 * Metadata handed to the host after sponsor processing. Fields are the union of what
 * generic and promotion sponsor sponsored execution policies can meaningfully provide at
 * their respective `Release` hooks.
 *
 * The contract layers two responsibilities for the host callback:
 *   1. Sponsor operations state update (slot/digest/outcome — fields below).
 *   2. Sponsored-execution recorder input (identity + economics block).
 *
 * Both responsibilities run from one callback so the host does not need
 * to coordinate two parallel hooks per sponsor result.
 */
export interface SponsorResultMetadata {
  /** Sponsor address consumed by this sponsor run (pool-adapter-resolved). */
  readonly sponsorAddress: string;
  /** Classified sponsor result outcome. */
  readonly outcome: SponsorResultOutcome;
  /** Furthest irreversible execution boundary reached by this run. */
  readonly executionStage: SponsorExecutionStage;
  /** Which sponsor route produced this event. */
  readonly route: SponsorResultRoute;
  /** Transaction digest when the sponsor run reached submit (success or on-chain revert). */
  readonly digest?: string;

  // ── Identity block (recorder input) ─────────────────────────────────
  /** Durable receipt ID owned by the sponsor run. */
  readonly receiptId: string;
  /** Sender address bound by the validated prepared transaction record. */
  readonly senderAddress: string;
  /** Canonical execution path key carried through the prepare entry. */
  readonly executionPathKey: string;
  /** Generic settlement orderId hash (sha256-hex), or null if absent / non-generic. */
  readonly orderIdHash: string | null;
  /** Promotion identifier — populated for `route === 'promotion'`. */
  readonly promotionId: string | null;
  /** Promotion developer userId — populated for `route === 'promotion'`. */
  readonly userId: string | null;

  // ── Economics block (recorder input) ────────────────────────────────
  /** Canonical economics for sponsored-execution recorder. */
  readonly economics: SponsorResultEconomics;
}

/**
 * Host-provided final-result hook. Recovery passes its lifecycle signal so
 * callback-owned RPC work stops during disposal. Foreground delivery has no
 * recovery signal. A throw is retained as pending delivery and retried by
 * recovery; it never rolls back the durable final state.
 */
export type SponsorResultCallback = (
  metadata: SponsorResultMetadata,
  signal?: AbortSignal,
) => void | Promise<void>;
