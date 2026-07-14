/**
 * Sponsor lifecycle — explicit phase contract + shared `consume` phase
 * runner for both `/relay/sponsor` and
 * `/studio/promotions/:id/sponsor`. Internal to core-api; not
 * re-exported from the package barrel.
 *
 * Phases:
 *   preconsume   — route-owned. Produces the data needed by consume
 *                  (raw `txBytes`, tx-derived sender, peeked entry).
 *                  Attribution is route-specific: generic is IP-only
 *                  (tx sender unbound until the stored hash match). Promotion is
 *                  studio-user (typed `AbuseSubject` of kind
 *                  `studio_user`, keyed by the route-verified developer
 *                  JWT `userId`); `senderAddress` is a mutable execution
 *                  credential bound by the JWT for the current action
 *                  only and is not the long-lived enforcement principal.
 *   consume      — SHARED runner (`runSponsorConsumePhase`). Owns the
 *                  atomic stored-hash match and `not_found` / `expired` /
 *                  `hash_mismatch` branching. Each route supplies a
 *                  `SponsorConsumePolicyAdapter` that encapsulates its
 *                  classification, cleanup, and abuse attribution.
 *   postconsume  — route-owned. After the stored hash match the canonical
 *                  `tx.sender` is authoritative against the prepare
 *                  commit, so abuse attribution may flow into a non-IP
 *                  counter — but the kind differs by route. Generic
 *                  uses `{ kind: 'address' }` keyed by the stored-hash-verified
 *                  `senderAddress`; promotion uses
 *                  `{ kind: 'studio_user', userId }` keyed by the
 *                  verified developer JWT principal. Two carve-out
 *                  vocabularies in `failures.ts` keep distinct policies
 *                  while the IP counter always increments —
 *                  `ADDRESS_CARVE_OUT_SUBCODES` for benign
 *                  retry/concurrency (`PAUSED`,
 *                  `VAULT_ALREADY_REGISTERED`, `REPLAY_NONCE`) across
 *                  preflight and revert families, and
 *                  `MARKET_VOLATILITY_CARVE_OUT_SUBCODES` for
 *                  market-driven movement (`SPREAD_EXCEEDED`,
 *                  `SLIPPAGE_EXCEEDED`) only at `PREFLIGHT_FAILED`;
 *                  the same market subcodes count once they become
 *                  `ONCHAIN_REVERT`. Both feed
 *                  `shouldCarveOutNonIpCounter`. Failures split into
 *                  three classes:
 *                    - server-side drift (generic L1 / L2 / extraction
 *                      / payment-integrity; both routes' gas-owner
 *                      mismatch): throw `REPREPARE_REQUIRED`, emit
 *                      `SPONSOR_DRIFT_OBSERVED`, NO abuse recorded.
 *                      Promotion additionally releases the ledger
 *                      reservation on gas-owner mismatch.
 *                    - preflight simulation failure: throw
 *                      `PREFLIGHT_FAILED`, record non-IP abuse keyed
 *                      by the route's typed subject — generic uses
 *                      `{ kind: 'address' }`, promotion uses
 *                      `{ kind: 'studio_user', userId }`.
 *                      Promotion additionally releases the ledger
 *                      reservation.
 *                    - generic non-loss failure: throw the specific
 *                      `L3_*` code. No abuse recorded and no drift event —
 *                      non-loss validation reflects post-consume server-side buffer
 *                      insufficiency against preflight `simGas`.
 *   result       — sponsor runner owned. Sign/submit, route-specific accounting
 *                  (generic economics log; promotion ledger consume +
 *                  usage append + overrun warning), `finally` slot
 *                  checkin. Runs only after every postconsume gate
 *                  passes.
 *
 * The adapter captures the only genuinely symmetric phase: consume.
 * Preconsume, postconsume, and sponsor result handling are now SponsoredExecutionPolicy hooks
 * coordinated by `session/sponsoredExecution/sponsorRunner.ts`.
 */
import { consumeEntry } from './sessionPrimitives.js';
import type { PrepareStoreAdapter, PreparedTxEntry } from '../store/prepareTypes.js';

// ─────────────────────────────────────────────
// Phase vocabulary
// ─────────────────────────────────────────────

export type SponsorRoute = 'generic' | 'promotion';

// ─────────────────────────────────────────────
// Consume policy adapter
// ─────────────────────────────────────────────

/**
 * Route-specific policy for the `consume` phase.
 *
 * The shared `runSponsorConsumePhase` runner invokes these hooks as
 * the atomic consume resolves. Each hook returns the classified
 * `Error` the runner should throw; for hooks that also perform
 * side-effects (abuse record, ledger release, structured log) those
 * happen before the returned Error is handed back.
 *
 * Handlers construct this adapter per-request with their local
 * `clientIp`, `abuseBlocker`, `ledger`, and other context captured
 * by closure. The runner itself does not know any route-specific
 * state.
 */
export interface SponsorConsumePolicyAdapter {
  readonly route: SponsorRoute;
  /**
   * Classified error when the stored entry is absent (never stored,
   * already consumed, or evicted). Synchronous — no side effects.
   */
  onNotFound(receiptId: string): Error;
  /**
   * Classified error when the entry exists but has expired. Promotion
   * route uses this hook to release the ledger reservation before
   * rejecting; generic route returns synchronously.
   */
  onExpired(receiptId: string): Promise<Error> | Error;
  /**
   * Called when the atomic consume detects a `txBytes` hash mismatch
   * against the stored `txBytesHash`. Route-specific abuse recording
   * happens here (generic: IP-only TAMPERING; promotion: IP +
   * studio-user TAMPERING keyed by `peekedPromotion.userId` via
   * promotionAbusePolicy, plus ledger release). Returns the
   * classified error the runner will throw.
   */
  onHashMismatch(receiptId: string): Promise<Error> | Error;
  /**
   * Called when `peek` (caller-owned, pre-consume) or the atomic
   * `consume` call throws because the stored entry cannot be
   * deserialized. Implementation must:
   *   - emit a `PREPARE_ENTRY_CORRUPT` structured log,
   *   - call `store.evictPreparedEntry(receiptId)` (idempotent),
   *   - perform route-specific additional cleanup (e.g. promotion
   *     ledger release),
   *   - return the classified error the caller should throw.
   */
  onCorrupt(input: { receiptId: string; err: unknown; stage: 'peek' | 'consume' }): Promise<Error>;
  /**
   * Optional post-consume-tail guard invoked after a successful
   * consume returns an entry, before the runner hands control back.
   * Used for route-specific sanity checks on the entry's `mode` /
   * `promotionId` that cannot fail inside the consume helper
   * (for example: the generic consume adapter rejects
   * `mode === 'promotion'` entries and must also slot-checkin before
   * throwing).
   *
   * Implementations that need to release a sponsor slot or a ledger
   * reservation before throwing own that side-effect here; the
   * runner only rethrows.
   */
  validateConsumedEntry?(entry: PreparedTxEntry): Promise<void>;
}

// ─────────────────────────────────────────────
// Shared consume runner
// ─────────────────────────────────────────────

/**
 * Atomically consume the prepared entry bound to `receiptId`.
 *
 * This is the ONLY phase that is genuinely uniform across generic
 * and promotion sponsor paths. The runner owns:
 *   - the call to `consumeEntry` (which internally hashes txBytes
 *     and performs the atomic `store.consume`),
 *   - the status-branching (`not_found` / `expired` / `hash_mismatch`
 *     / success),
 *   - the corrupt-entry capture at the consume step.
 *
 * Route-specific behaviour — classified errors, abuse recording,
 * ledger release — is delegated to the `adapter` param. See
 * `SponsorConsumePolicyAdapter` for the hook contract.
 *
 * Returns the `PreparedTxEntry` on success. Throws the adapter-
 * classified `Error` on any failure path.
 */
export async function runSponsorConsumePhase(
  store: PrepareStoreAdapter,
  receiptId: string,
  txBytes: Uint8Array,
  adapter: SponsorConsumePolicyAdapter,
): Promise<PreparedTxEntry> {
  let outcome: Awaited<ReturnType<typeof consumeEntry>>;
  try {
    outcome = await consumeEntry(store, receiptId, txBytes);
  } catch (err) {
    throw await adapter.onCorrupt({ receiptId, err, stage: 'consume' });
  }

  if (outcome.status === 'not_found') {
    throw adapter.onNotFound(receiptId);
  }
  if (outcome.status === 'expired') {
    throw await Promise.resolve(adapter.onExpired(receiptId));
  }
  if (outcome.status === 'hash_mismatch') {
    throw await Promise.resolve(adapter.onHashMismatch(receiptId));
  }

  if (adapter.validateConsumedEntry) {
    await adapter.validateConsumedEntry(outcome.entry);
  }
  return outcome.entry;
}
