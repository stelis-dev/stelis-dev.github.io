/**
 * Sponsor result host callback contract.
 *
 * Generic and promotion sponsor sponsored execution policies invoke the host-provided
 * callback from their `Release` hooks, after the sponsor runner's
 * `safeSlotCheckin()` boundary. The callback is the supported API for
 * per-action sponsor operations state update AND for the sponsored-execution
 * recorder.
 *
 * Contract:
 *   - Invoked on every sponsor result path (success and throw), exactly once per
 *     sponsor request that reached the post-consume stage (where
 *     `prepared.slotId` / `prepared.sponsorAddress` are known).
 *   - Runs after `safeSlotCheckin()` so slot-release invariants are
 *     independent of callback outcome.
 *   - Must be best-effort: it must catch its own errors internally and
 *     never throw. SponsoredExecutionPolicy Release hooks also wrap the call in
 *     try/catch as defence-in-depth.
 *   - May be awaited by Release hooks so cleanup ordering is deterministic.
 *     Callbacks that need to avoid primary-response latency must return
 *     fast (typical shape: one bounded probe + one Redis write).
 */

/** Final outcome of a sponsor run, matching existing error classification rules. */
export type SponsorResultOutcome =
  | 'success'
  | 'onchain_revert'
  | 'preflight_failure'
  | 'congestion'
  | 'validation_failure'
  | 'internal_error';

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
 * such a row is written at all is the recorder's outcome-filter
 * decision (see `packages/app-api/src/sponsoredLogs/recorder.ts`); a
 * `failureReason` carrying the `submit_infra_unknown` marker prefix
 * is the contract this core-api side stamps for the post-signature
 * submit-infra branches on both routes (generic and promotion) so the
 * recorder can opt those rows in.
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
  /** Slot identifier consumed by this sponsor run. */
  readonly slotId: string;
  /** Sponsor address associated with `slotId` (pool-adapter-resolved). */
  readonly sponsorAddress: string;
  /** Classified sponsor result outcome. */
  readonly outcome: SponsorResultOutcome;
  /** Which sponsor route produced this event. */
  readonly route: SponsorResultRoute;
  /** Transaction digest when the sponsor run reached submit (success or on-chain revert). */
  readonly digest?: string;

  // ── Identity block (recorder input) ─────────────────────────────────
  /** Receipt ID consumed by the sponsor run. */
  readonly receiptId: string;
  /** Stored-hash-verified sender address after consume succeeds. */
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
 * Host-provided post-result hook. `void | Promise<void>` so hosts can
 * choose sync or async implementations; SponsoredExecutionPolicy Release hooks always
 * `await` the return.
 * Implementations MUST NOT throw — see contract note above.
 */
export type SponsorResultCallback = (metadata: SponsorResultMetadata) => void | Promise<void>;
