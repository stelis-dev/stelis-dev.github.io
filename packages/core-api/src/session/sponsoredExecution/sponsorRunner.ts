/**
 * SponsoredExecution — sponsor runner.
 *
 * Walks the sponsor-side states (`DecodeSponsorSubmission` through
 * `Release`) defined in `states.ts` against an injected `SponsoredExecutionPolicy`.
 * The runner owns:
 *   - the atomic-consume sub-runner invocation
 *     (`runSponsorConsumePhase` from `sponsorLifecycle.ts`),
 *   - progressive sponsor-context construction across the consume
 *     boundary (pre-consume hooks see `PreConsumeSponsorContext`;
 *     post-consume hooks see `PostConsumeSponsorContext` once the
 *     runner reconstructs `sponsorSlot`; nonce/ledger reservation
 *     fields fill in as `SharedPostconsumeChecks` /
 *     `PolicyPostconsumeChecks` return reconstruction inputs),
 *   - the `safeSlotCheckin` boundary in `finally` (only fires after
 *     consume succeeds — pre-consume failures carry no slot to release),
 *   - swallowing throws from the post-checkin `Release` hook so the
 *     hook cannot mask the primary success path or the original error.
 *
 * Internal module. The public sponsor handlers now delegate to
 * `runSponsorStateMachine` while preserving their stable entrypoint
 * signatures.
 *
 * Current sponsor-runner rules:
 *   - `Consume` is the single authoritative stored-hash match; reconstruction
 *     starts only after this boundary clears.
 *   - the shared runner owns finally slot checkin.
 *   - sponsor-phase reservation handles is reconstructed from durable inputs after
 *     consume + boundary verification, not acquired afresh.
 */

import type {
  LedgerReservationHandle,
  NonceReservationHandle,
  PostConsumeSponsorContext,
  SponsoredExecutionPolicy,
  PreConsumeSponsorContext,
  SponsorSlotReservationHandle,
} from './index.js';
import { reconstructReservationHandles } from './index.js';
import type { ExecResult } from '../sessionTypes.js';
import type { PreparedTxEntry, PrepareStoreAdapter } from '../../store/prepareTypes.js';
import type { SponsorPoolAdapter } from '../../context.js';
import type { PromotionExecutionLedger } from '../../studio/executionLedger.js';
import { runSponsorConsumePhase, type SponsorConsumePolicyAdapter } from '../sponsorLifecycle.js';
import { safeSlotCheckin } from '../sessionPrimitives.js';

// ─────────────────────────────────────────────
// Host adapters + request shape
// ─────────────────────────────────────────────

/**
 * Sign-and-submit port the runner consumes for the
 * `SponsorSign` + `Submit` boundary. The production wiring binds this
 * to `signAndSubmit(pool, sui, slotId, receiptId, txBytes,
 * userSignature)` from `sessionPrimitives.ts`; tests pass a
 * deterministic mock.
 *
 * Failure semantics the port preserves:
 *   - `SponsorLeaseExpiredError` (or other `pool.sign` failures) throw
 *     before the sponsor signature is issued — the runner rethrows
 *     unchanged.
 *   - `SponsorSubmitInfraError` (post-signature submit-infra
 *     uncertainty) throws AFTER the sponsor signature was issued — the
 *     runner rethrows unchanged so the route handler can stamp
 *     `submit_infra_unknown` on sponsor result economics.
 *   - Any other thrown value propagates unchanged.
 *   - On a normalized failed `ExecResult`, the runner forwards the
 *     result to `ClassifySponsorResult` so the policy can classify
 *     congestion vs on-chain revert.
 */
export type SignAndSubmitPort = (
  slotId: string,
  receiptId: string,
  txBytes: Uint8Array,
  userSignature: string,
) => Promise<ExecResult>;

/**
 * Production-side adapters the sponsor runner consumes. The runner
 * does not construct fresh reservations — every resource the prepared
 * entry references is owned by the durable store from the
 * `/prepare` boundary. The runner only:
 *   - reads the prepared entry via `prepareStore` (through the
 *     consume sub-runner),
 *   - calls `sponsorPool.checkin` via `safeSlotCheckin` in `finally`,
 *   - reads ledger state via `executionLedger` for Studio policy
 *     verification (the policy hooks themselves call this; the runner
 *     just passes the adapter through the host shape).
 *
 * `executionLedger` is required for promotion policies (Studio
 * postconsume verification needs it) and ignored for generic. The
 * runner does NOT enforce its presence at construction time — a
 * generic policy that never asks for ledger reservation handle does not need a
 * ledger adapter, and a Studio policy hook will report a clear
 * runtime error if it dereferences a missing host.
 */
export interface SponsorStateMachineHost {
  readonly prepareStore: PrepareStoreAdapter;
  readonly sponsorPool: SponsorPoolAdapter;
  readonly executionLedger?: PromotionExecutionLedger;
  readonly signAndSubmit: SignAndSubmitPort;
}

/**
 * Snapshot handed to `request.projectResult` on the success path. The
 * runner builds this immediately after `ClassifySponsorResult` returns
 * (success-only); failure paths throw before reaching the projector.
 *
 * Route-specific public-result projection lives in `projectResult`,
 * not in this snapshot — the snapshot is the structured input the
 * projector reads to assemble its public response (digest + economics
 * for generic, digest + estimatedGas + reservedGas for promotion).
 */
export interface SponsorResultSnapshot {
  readonly receiptId: string;
  readonly clientIp: string;
  readonly prepared: PreparedTxEntry;
  readonly sponsorSlot: SponsorSlotReservationHandle;
  readonly nonce?: NonceReservationHandle;
  readonly ledgerReservation?: LedgerReservationHandle;
  readonly execResult: Extract<ExecResult, { success: true }>;
}

/**
 * Per-request inputs the runner does not derive from the policy
 * policy. The request is generic over `TResult` so each route
 * (generic / Studio) can return its own public response shape from
 * the projector.
 */
export interface SponsorStateMachineRequest<TResult> {
  readonly hookContext: PreConsumeSponsorContext;
  readonly txBytes: Uint8Array;
  readonly userSignature: string;
  /**
   * Builds the route-specific public result from the typed sponsor result
   * snapshot. Called only on the success path; failure paths throw
   * before this runs.
   */
  readonly projectResult: (snapshot: SponsorResultSnapshot) => TResult | Promise<TResult>;
}

// ─────────────────────────────────────────────
// Errors raised by the sponsor runner itself
// ─────────────────────────────────────────────

/**
 * Thrown when the execution policy declares an handle requirement at
 * the sponsor result boundary that the corresponding postconsume hook did
 * not produce. Specifically: the runner detects this BEFORE
 * `signAndSubmit` fires so the failure is surfaced before any
 * irreversible side-effect.
 *
 * Examples:
 *   - `handleRequirements.sponsorResult.ledgerReservation === true` but
 *     `PolicyPostconsumeChecks` returned no reconstruction inputs —
 *     the Studio sponsor result hook would dereference an undefined
 *     `ledgerReservation` token.
 *   - The execution policy's discriminator is `'promotion'` but
 *     `host.executionLedger` is missing.
 *
 * This is a runner / policy mis-sequencing (or host
 * misconfiguration) signal per Q5, NOT user-driven validation
 * failure.
 */
export class RunnerSponsorReservationHandleMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerSponsorReservationHandleMissingError';
  }
}

/**
 * Thrown when a policy hook returns in violation of its declared
 * runner contract. Distinct from
 * `RunnerSponsorReservationHandleMissingError`: that one signals a missing
 * reservation handle at a known boundary; this one signals a hook returned
 * (without throwing) under a state where the runner cannot proceed
 * coherently.
 *
 * Currently raised at one site:
 *   - `ClassifySponsorResult` returned without throwing on a failed
 *     `ExecResult`. The runner cannot project a success result from
 *     a failed ExecResult, and silently continuing would bypass the
 *     route's classified-error vocabulary
 *     (SponsorOnchainError / SponsorCongestionError).
 *
 * Like its sibling, this is a runner / policy contract violation
 * per Q5 — not user-driven validation failure.
 */
export class RunnerSponsorPolicyContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerSponsorPolicyContractError';
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function callHook<Args extends unknown[]>(
  hook: ((...args: Args) => Promise<unknown> | unknown) | undefined,
  ...args: Args
): Promise<void> {
  if (!hook) return;
  await hook(...args);
}

/**
 * Same as `callHook` but swallows + drops any thrown value. Used for
 * post-pivotal observability hooks (`Submit`, `Release`) where a
 * throw must not mask the primary classification or cleanup that the
 * runner is contractually obligated to perform next.
 *
 * Pure swallow: route-specific observability for callback failures
 * belongs in the policy hook that owns the callback contract. The
 * runner-level helper intentionally does not invent a shared log
 * payload for hook-local failures.
 */
async function callObservabilityHookSwallow<Args extends unknown[]>(
  hook: ((...args: Args) => Promise<unknown> | unknown) | undefined,
  ...args: Args
): Promise<void> {
  if (!hook) return;
  try {
    await hook(...args);
  } catch {
    // Swallow — observability hook is post-pivotal and must not
    // replace the primary success path or the original error.
  }
}

// ─────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────

/**
 * Run the sponsor state machine. Walks every sponsor-side
 * state in the order declared by `SPONSOR_STATE_ORDER`, dispatching
 * the execution policy hook at each state, and returns the
 * route-specific result built by `request.projectResult` on success.
 *
 * Cleanup contract:
 *   - Pre-consume failure paths (DecodeSponsorSubmission,
 *     UserSignatureValidation, Consume) carry no slot to release —
 *     the durable entry was not consumed, so the prepared store still
 *     owns the slot. `runSponsorConsumePhase` itself owns
 *     route-specific cleanup for `not_found` / `expired` /
 *     `hash_mismatch` / `corrupt` (via the consume adapter).
 *   - Post-consume failure paths run `safeSlotCheckin` in `finally`
 *     against the consumed entry's `(slotId, receiptId, txBytesHash)`
 *     — preserving the public sponsor-route cleanup semantics.
 *   - The post-checkin `Release` hook is swallowed if it throws so a
 *     buggy hook cannot replace the primary success path or the
 *     original error.
 */
export async function runSponsorStateMachine<TResult>(
  host: SponsorStateMachineHost,
  request: SponsorStateMachineRequest<TResult>,
  policy: SponsoredExecutionPolicy,
  consumeAdapter: SponsorConsumePolicyAdapter,
): Promise<TResult> {
  const preCtx = request.hookContext;

  // Tracked so the `finally` cleanup knows whether consume succeeded.
  // Undefined until `runSponsorConsumePhase` returns success.
  let preparedEntry: PreparedTxEntry | undefined;
  let postCtxSnapshot: PostConsumeSponsorContext | undefined;

  try {
    // ── State 1: DecodeSponsorSubmission ──────────────────────────────
    await callHook(policy.hooks.DecodeSponsorSubmission, preCtx);

    // ── State 2: UserSignatureValidation ──────────────────────────────
    await callHook(policy.hooks.UserSignatureValidation, preCtx);

    // ── State 3: Consume ──────────────────────────────────────────────
    // Atomic stored-hash match delegated to the existing shared sub-runner.
    // Consume errors (not_found / expired / hash_mismatch / corrupt)
    // propagate as adapter-classified errors — the runner does NOT
    // re-classify them. Per Q1, the sub-runner is reused as-is.
    preparedEntry = await runSponsorConsumePhase(
      host.prepareStore,
      preCtx.receiptId,
      request.txBytes,
      consumeAdapter,
    );

    // Reconstruct the sponsor slot reservation handle. The pool's HMAC commit
    // verification at consume time is the authority for `(slotId,
    // sponsorAddress, receiptId)`; reconstruction is gated on the
    // verified-flag input shape declared in `reservationHandles.ts`.
    const sponsorSlot = reconstructReservationHandles.sponsorSlot({
      slotId: preparedEntry.slotId,
      sponsorAddress: preparedEntry.sponsorAddress,
      receiptId: preparedEntry.receiptId,
      hmacCommitVerified: true,
    });

    let nonceHandle: NonceReservationHandle | undefined;
    let ledgerReservationHandle: LedgerReservationHandle | undefined;

    // Build the post-consume context. Optional fields fill in as the
    // postconsume hooks return reconstruction inputs.
    const buildPostCtx = (): PostConsumeSponsorContext => ({
      receiptId: preCtx.receiptId,
      clientIp: preCtx.clientIp,
      sponsorSlot,
      nonce: nonceHandle,
      ledgerReservation: ledgerReservationHandle,
    });
    postCtxSnapshot = buildPostCtx();

    // Consume hook fires here as observability-only — the consume
    // sub-runner already returned success.
    await callHook(policy.hooks.Consume, preCtx);

    // ── State 4: SharedPostconsumeChecks ──────────────────────────────
    // Hook performs route-shared verification (gas owner cross-check,
    // S-14 in-PTB nonce match for generic, etc.) and may return
    // `NonceReconstructionInputs` which the runner mints into a live
    // `NonceReservationHandle`.
    const sharedOut = await policy.hooks.SharedPostconsumeChecks(postCtxSnapshot);
    if (sharedOut.nonce) {
      nonceHandle = reconstructReservationHandles.nonce(sharedOut.nonce);
      postCtxSnapshot = buildPostCtx();
    }

    // ── State 5: PolicyPostconsumeChecks ──────────────────────────────
    // Hook performs route-specific verification (new-user User Vault drift
    // for generic; promotion ledger lookup verification for Studio)
    // and may return `LedgerReservationReconstructionInputs` which the
    // runner mints into a live `LedgerReservationHandle`.
    const policyOut = await policy.hooks.PolicyPostconsumeChecks(postCtxSnapshot);
    if (policyOut.ledgerReservation) {
      ledgerReservationHandle = reconstructReservationHandles.ledgerReservation(
        policyOut.ledgerReservation,
      );
      postCtxSnapshot = buildPostCtx();
    }

    // ── State 6: Preflight ────────────────────────────────────────────
    await callHook(policy.hooks.Preflight, postCtxSnapshot);

    // ── State 7: PolicyApproval ───────────────────────────────────────
    await callHook(policy.hooks.PolicyApproval, postCtxSnapshot);

    // Handle-requirement gate at the sponsor result boundary. The
    // `sponsorResult` requirements declare which
    // reservation handle kinds the upcoming Submit + ClassifySponsorResult hooks may
    // dereference. If a required handle was not produced by the
    // postconsume hooks, the runner fails closed here per Q5 —
    // dereferencing an undefined handle in ClassifySponsorResult would
    // otherwise produce a less-actionable error.
    if (policy.handleRequirements.sponsorResult.ledgerReservation && !ledgerReservationHandle) {
      throw new RunnerSponsorReservationHandleMissingError(
        'policy requires ledger reservation handle at sponsor result boundary, but PolicyPostconsumeChecks did not return reconstruction inputs',
      );
    }

    // ── State 8: SponsorSign ──────────────────────────────────────────
    // Observability before the runner invokes the signAndSubmit port.
    await callHook(policy.hooks.SponsorSign, postCtxSnapshot);

    // ── State 9: Submit ───────────────────────────────────────────────
    // Pre-sign failures (`SponsorLeaseExpiredError`) and post-sign
    // submit-infra failures (`SponsorSubmitInfraError`) propagate from
    // the port unchanged. On a normalized failed `ExecResult`, the
    // runner does NOT classify — it forwards the result to
    // `ClassifySponsorResult` so the policy can decide whether to throw
    // congestion vs on-chain revert.
    const execResult = await host.signAndSubmit(
      preparedEntry.slotId,
      preparedEntry.receiptId,
      request.txBytes,
      request.userSignature,
    );

    // Submit hook fires after both success and normalized-failure
    // results are available, but result classification stays owned by
    // ClassifySponsorResult. Submit is observability-only and a throw here
    // MUST NOT replace the result that ClassifySponsorResult will classify next.
    // Routed through `callObservabilityHookSwallow` so a buggy hook
    // cannot truncate the state walk before ClassifySponsorResult.
    await callObservabilityHookSwallow(policy.hooks.Submit, postCtxSnapshot);

    // ── State 10: ClassifySponsorResult ──────────────────────────────────────
    // Owns route-specific sponsor result classification. On
    // `result.success === false` the hook throws the classified error
    // (SponsorCongestionError, SponsorOnchainError, etc.). On
    // `result.success === true` the hook performs success-side
    // accounting (Studio ledger consume, generic economics log).
    await policy.hooks.ClassifySponsorResult(postCtxSnapshot, execResult);

    if (!execResult.success) {
      // Defensive: ClassifySponsorResult was supposed to throw on
      // `success === false`. If it did not, the runner does — we
      // cannot project a success result from a failed ExecResult,
      // and silently continuing would bypass the route's classified-
      // error vocabulary (SponsorOnchainError /
      // SponsorCongestionError).
      throw new RunnerSponsorPolicyContractError(
        'ClassifySponsorResult returned without throwing on a failed ExecResult — policy contract violated',
      );
    }

    // Build the success-only snapshot and project the route-specific
    // result. Both `success === true` narrowing and the field
    // requirements are encoded at the type level via the
    // `Extract<..., { success: true }>` shape on
    // `SponsorResultSnapshot`.
    const snapshot: SponsorResultSnapshot = {
      receiptId: preCtx.receiptId,
      clientIp: preCtx.clientIp,
      prepared: preparedEntry,
      sponsorSlot,
      nonce: nonceHandle,
      ledgerReservation: ledgerReservationHandle,
      execResult,
    };
    return await request.projectResult(snapshot);
  } finally {
    // Slot checkin only fires if consume succeeded — pre-consume
    // failure paths leave nothing to release. `safeSlotCheckin`
    // itself never throws (it logs `SPONSOR_POOL_CHECKIN_FAILED`
    // internally and swallows), so it cannot mask the original error
    // path.
    if (preparedEntry) {
      await safeSlotCheckin(
        host.sponsorPool,
        preparedEntry.slotId,
        preparedEntry.receiptId,
        preparedEntry.txBytesHash,
      );
      // ── State 11: Release ─────────────────────────────────────────
      // Post-checkin observability hook. Throws are swallowed per Q3
      // so a buggy Release hook cannot replace the primary success
      // path or the original error.
      if (postCtxSnapshot) {
        await callObservabilityHookSwallow(policy.hooks.Release, postCtxSnapshot);
      }
    }
  }
}
