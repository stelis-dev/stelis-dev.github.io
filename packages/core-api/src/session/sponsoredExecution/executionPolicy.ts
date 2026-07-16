/**
 * SponsoredExecution — `SponsoredExecutionPolicy` interface and typed hook registry.
 *
 * The current implementation uses a data + function registry:
 *   - data selects reservation kinds, check kinds, sponsor result branch table,
 *     route identity, and public error vocabulary,
 *   - registry-backed functions implement checks whose behavior is
 *     executable code (L3 non-loss math, ledger consume/release, preflight
 *     classification, route extraction, drift handling, economics logging).
 *
 * Hook rules:
 *   - a hook MUST NOT execute the next lifecycle state directly;
 *   - each hook registers against ONE lifecycle state through a typed
 *     registry; the registry key is the state literal so a hook cannot be
 *     unowned or shared across unrelated lifecycle phases.
 *
 * This registry is consumed by the generic and Studio execution policies.
 * Public prepare/sponsor handlers delegate to the prepare and sponsor runners,
 * and the runners dispatch to the route policy selected by the
 * prepared-entry policy/mode.
 *
 * Internal module. Not re-exported from the package barrel.
 */

import type { PrepareState, SponsorState, SponsoredExecutionState } from './states.js';
import type {
  GasBoundBuildInput,
  GasBoundBuildResult,
  LedgerReservationHandle,
  LedgerReservationReconstructionInputs,
  NonceReservationHandle,
  NonceReconstructionInputs,
  SponsorSlotReservationHandle,
} from './reservationHandles.js';
import type { ExecResult } from '../sessionTypes.js';
import type { SponsorExecutionStage } from '../../handlers/sponsorResult.js';

type MaybePromise<T> = Promise<T> | T;

// ─────────────────────────────────────────────
// Discriminator + per-stage handle requirements
// ─────────────────────────────────────────────

/**
 * Public discriminator for a sponsored execution policy. Matches the prepared-store
 * entry's policy/mode field so a single dispatch keys both prepare-side
 * registration and sponsor-side lookup. New policies require a new
 * discriminant literal AND a corresponding registration.
 */
export type PolicyDiscriminator = 'generic' | 'promotion';

/**
 * Per-stage handle requirement shapes. Different lifecycle boundaries carry
 * different reservation handle kinds:
 *
 *   - GasBoundBuild — generic requires `Nonce` before build; Studio does not.
 *   - PrepareStoreCommit — Studio requires `LedgerReservation` after build;
 *     generic does not acquire another route-specific handle there.
 *   - SponsorResult — Studio requires `LedgerReservation` for entitlement
 *     consume/release; generic does not.
 *
 * Sponsor slot is unconditional in both runners, so it is not repeated as a
 * policy requirement. Each declared value below is read by a runner and can
 * change runtime acquisition or validation behavior.
 */
export interface GasBoundBuildHandleRequirements {
  readonly nonce?: true;
  // ledgerReservation is intentionally absent because the reservation is
  // acquired after GasBoundBuild, once the measured amount exists.
}

export interface PreparedCommitHandleRequirements {
  readonly ledgerReservation?: true;
}

export interface SponsorResultHandleRequirements {
  readonly ledgerReservation?: true;
  // nonce is intentionally absent — the in-PTB nonce match runs at
  // SharedPostconsumeChecks; nonce reservation handle has no sponsor result verb.
}

/**
 * Per-policy route-specific handle requirements keyed by lifecycle boundary.
 * Unconditional handles are absent; the runners consult every field declared
 * here.
 */
export interface SponsoredExecutionPolicyHandleRequirements {
  readonly gasBoundBuild: GasBoundBuildHandleRequirements;
  readonly preparedCommit: PreparedCommitHandleRequirements;
  readonly sponsorResult: SponsorResultHandleRequirements;
}

// ─────────────────────────────────────────────
// Hook context shapes
// ─────────────────────────────────────────────

/**
 * Read-only state supplied to every prepare-side hook. The runner derives
 * these fields from the request + chain snapshot before invoking any hook
 * so hooks do not re-fetch upstream state.
 */
export interface PreparePolicyHookContext {
  readonly receiptId: string;
  readonly senderAddress: string;
  readonly clientIp: string;
}

/**
 * Typed prepare-side snapshot output returned by `ChainSnapshot`. The
 * runner owns later reservation acquisition, so policy hooks return only
 * the read-model fields the runner needs at those named boundaries.
 * Generic snapshots must include `nonceAcquire` from the on-chain
 * `last_nonce`; promotion snapshots prohibit that field because
 * promotion prepare has no nonce reservation.
 */
export interface GenericPrepareChainSnapshot {
  readonly nonceAcquire: {
    readonly onchainLastNonce: bigint;
  };
}

export interface PromotionPrepareChainSnapshot {
  readonly nonceAcquire?: never;
}

export type PrepareChainSnapshot<D extends PolicyDiscriminator = PolicyDiscriminator> =
  D extends 'generic'
    ? GenericPrepareChainSnapshot
    : D extends 'promotion'
      ? PromotionPrepareChainSnapshot
      : never;

/**
 * Read-only state supplied to sponsor-side hooks that fire BEFORE the
 * atomic consume succeeds (`DecodeSponsorSubmission`,
 * `UserSignatureValidation`, `Consume`). At this point the prepared
 * entry has not been stored-hash-verified to the submitted `txBytes` yet, so no
 * phase-local reservation handles can be reconstructed — `txSender` is still
 * attacker-choosable and the sponsor-address lease identity is not yet authoritative.
 *
 * `Consume` runs immediately after `UserSignatureValidation`;
 * reconstruction begins only after that boundary clears.
 */
export interface PreConsumeSponsorContext {
  readonly receiptId: string;
  readonly clientIp: string;
}

/**
 * Read-only state supplied to sponsor-side hooks that fire AFTER the
 * atomic consume succeeds. The runner reconstructs `sponsorSlot`
 * immediately after `runSponsorConsumePhase` returns success. The handle
 * carries the consumed entry's sponsor-address lease identity; the pool's
 * `sign()` boundary later performs the committed HMAC verification against
 * the submitted transaction bytes.
 *
 * `nonce` and `ledgerReservation` are minted progressively by the
 * runner from typed reconstruction inputs returned by the
 * `SharedPostconsumeChecks` and `PolicyPostconsumeChecks` hooks
 * respectively. Both fields are optional at the type level: a generic
 * policy never produces `ledgerReservation`; a Studio policy never
 * produces `nonce`. The runner enforces presence at the corresponding
 * `handleRequirements.sponsorResult` boundary via
 * `RunnerSponsorReservationHandleMissingError`.
 */
export interface PostConsumeSponsorContext {
  readonly receiptId: string;
  readonly clientIp: string;
  /** Runner-owned irreversible execution boundary; never inferred by a policy. */
  readonly executionStage: SponsorExecutionStage;
  readonly sponsorSlot: SponsorSlotReservationHandle;
  readonly nonce?: NonceReservationHandle;
  readonly ledgerReservation?: LedgerReservationHandle;
}

/**
 * Reconstruction inputs returned by `SharedPostconsumeChecks` so the
 * runner can mint `NonceReservationHandle` after the S-14 in-PTB nonce match
 * verifies. Generic policies populate this; Studio returns an empty
 * object because there is no nonce on the promotion path.
 */
export interface SharedPostconsumeReconstruction {
  readonly nonce?: NonceReconstructionInputs;
}

/**
 * Reconstruction inputs returned by `PolicyPostconsumeChecks` so the
 * runner can mint `LedgerReservationHandle` after the Studio ledger
 * read model verifies the active reservation matches the prepared-entry
 * copy. Studio populates this; generic returns an empty object.
 */
export interface PolicyPostconsumeReconstruction {
  readonly ledgerReservation?: LedgerReservationReconstructionInputs;
}

// ─────────────────────────────────────────────
// Hook signatures keyed by state
// ─────────────────────────────────────────────

/**
 * Per-state hook signature map. Adding a new state literal requires a
 * matching entry here; missing a state is a compile-time error in any
 * `SponsoredExecutionPolicy` registration.
 *
 * Inputs and outputs are intentionally narrow: a hook reads its named
 * payload, returns a typed verdict, and CANNOT trigger the next
 * lifecycle state. The runner — not the hook — drives the next
 * transition.
 */
export interface StateHookSignatures<D extends PolicyDiscriminator = PolicyDiscriminator> {
  readonly Intent: (ctx: PreparePolicyHookContext) => Promise<void> | void;
  readonly RequestValidation: (ctx: PreparePolicyHookContext) => Promise<void> | void;
  readonly InflightAdmission: (ctx: PreparePolicyHookContext) => Promise<void> | void;
  readonly ChainSnapshot: (ctx: PreparePolicyHookContext) => MaybePromise<PrepareChainSnapshot<D>>;
  readonly ExecutionPolicySelected: (ctx: PreparePolicyHookContext) => Promise<void> | void;
  readonly SlotFreePlan: (ctx: PreparePolicyHookContext) => Promise<void> | void;
  readonly SponsorSlotReservationAcquired: (
    ctx: PreparePolicyHookContext,
    sponsorSlot: SponsorSlotReservationHandle,
  ) => Promise<void> | void;
  // The runner — not the hook — owns reservation acquisition. After
  // the runner acquires the nonce reservation (when
  // `handleRequirements.gasBoundBuild.nonce === true`), it passes the
  // resulting `NonceReservationHandle` to this hook for any policy-side
  // verification (signature parity, audit log, etc.). The hook returns
  // `void`; ownership of the reservation stays with the runner so
  // reverse-cleanup is correct on every failure path.
  readonly RouteReservationBeforeBuild: (
    ctx: PreparePolicyHookContext,
    sponsorSlot: SponsorSlotReservationHandle,
    nonce: NonceReservationHandle,
  ) => Promise<void> | void;
  // The hook drives the route-specific gas-bound build
  // (`runGenericPrepareBuildPipeline` for generic, sponsor-ready
  // Transaction.build for Studio) and returns the durable build result.
  // The runner consumes `txBytesHash` for sponsor-pool commit +
  // prepared-store entry; `measuredGasMist` is forwarded to
  // `RouteReservationAfterBuild` for Studio ledger reservation amount.
  readonly GasBoundBuild: (
    ctx: PreparePolicyHookContext,
    input: GasBoundBuildInput,
  ) => Promise<GasBoundBuildResult> | GasBoundBuildResult;
  // After the runner acquires the ledger reservation (when
  // `handleRequirements.preparedCommit.ledgerReservation === true`),
  // it passes the `LedgerReservationHandle` to this hook for any
  // policy-side verification. Same ownership contract as
  // `RouteReservationBeforeBuild`.
  readonly RouteReservationAfterBuild: (
    ctx: PreparePolicyHookContext,
    sponsorSlot: SponsorSlotReservationHandle,
    ledgerReservation: LedgerReservationHandle,
  ) => Promise<void> | void;
  readonly SelfCheck: (ctx: PreparePolicyHookContext) => Promise<void> | void;
  readonly SponsorLeaseCommitted: (ctx: PreparePolicyHookContext) => Promise<void> | void;
  // Pre-consume hooks: fire BEFORE the atomic consume succeeds, so they
  // see a context that carries no phase-local reservation handles. `txSender` is
  // still attacker-choosable at this point — abuse attribution is
  // IP-only (generic) or studio-user (promotion, via the route-verified
  // developer JWT principal).
  readonly DecodeSponsorSubmission: (ctx: PreConsumeSponsorContext) => Promise<void> | void;
  readonly UserSignatureValidation: (ctx: PreConsumeSponsorContext) => Promise<void> | void;
  // The `Consume` hook is observability-only by contract: the runner
  // delegates the atomic stored-hash match to `runSponsorConsumePhase`
  // (`sponsorLifecycle.ts`) using the route-supplied
  // `SponsorConsumePolicyAdapter`. The hook fires only after the
  // sub-runner returns success.
  readonly Consume: (ctx: PreConsumeSponsorContext) => Promise<void> | void;
  // Post-consume hooks: fire AFTER the runner has reconstructed
  // `sponsorSlot` from the consumed entry's sponsor-address lease identity.
  // The later `sign()` boundary remains the committed HMAC authority.
  //
  // `SharedPostconsumeChecks` performs route-shared verification (gas
  // owner cross-check, S-14 in-PTB nonce match for generic, etc.). It
  // returns optional reconstruction inputs so the runner can mint
  // `NonceReservationHandle` after the S-14 verification clears. Generic
  // policies populate `nonce`; Studio omits it.
  readonly SharedPostconsumeChecks: (
    ctx: PostConsumeSponsorContext,
  ) => MaybePromise<SharedPostconsumeReconstruction>;
  // `PolicyPostconsumeChecks` performs route-specific verification
  // (new-user User Vault drift for generic; promotion ledger lookup
  // verification for Studio). It returns optional reconstruction inputs
  // so the runner can mint `LedgerReservationHandle` after Studio's
  // ledger read model verifies the active reservation matches the
  // prepared-entry copy. Generic policies omit it.
  readonly PolicyPostconsumeChecks: (
    ctx: PostConsumeSponsorContext,
  ) => MaybePromise<PolicyPostconsumeReconstruction>;
  readonly Preflight: (ctx: PostConsumeSponsorContext) => Promise<void> | void;
  readonly PolicyApproval: (ctx: PostConsumeSponsorContext) => Promise<void> | void;
  // `SponsorSign` fires BEFORE the runner invokes the
  // `signAndSubmit` host port. Observability-only — the actual sign +
  // submit call is owned by the runner via the host port.
  readonly SponsorSign: (ctx: PostConsumeSponsorContext) => Promise<void> | void;
  // `Submit` fires AFTER `signAndSubmit` returns a normalized result,
  // but before `ClassifySponsorResult` receives that result for route-specific
  // classification. Observability-only: a throw is swallowed by the
  // runner so it cannot replace the result that `ClassifySponsorResult`
  // will classify next. The hook receives only the post-consume context;
  // `ClassifySponsorResult` is the single owner of result classification and
  // accounting. Pre-sign failures (e.g. `SponsorLeaseExpiredError`) and
  // post-signature uncertainty (`SponsorPostSignatureUncertaintyError`) propagates
  // from the port without invoking this hook — the public route adapter's
  // outer catch handles those.
  readonly Submit: (ctx: PostConsumeSponsorContext) => Promise<void> | void;
  // `ClassifySponsorResult` owns route-specific sponsor result classification:
  //   - on `result.success === true`: success-side accounting (Studio
  //     ledger consume, generic economics log).
  //   - on `result.success === false`: failure-side accounting (Studio
  //     ledger release on congestion, ledger consume on on-chain revert,
  //     structured execution log, `SponsorOnchainError` /
  //     `SponsorCongestionError` classified throw).
  // The runner does not classify the failure itself — it propagates
  // any throw the hook raises so the public route adapter's outer catch can
  // map runner output to its public error vocabulary.
  readonly ClassifySponsorResult: (
    ctx: PostConsumeSponsorContext,
    result: ExecResult,
  ) => Promise<void> | void;
  // The `Release` hook fires AFTER the runner's `finally` already ran
  // `safeSlotCheckin`. Observability-only: a throw is swallowed by
  // the runner — a Release hook fault must not mask the primary
  // success path or the original error. The runner intentionally emits
  // no shared hook-failure event; route-owned callback failures that
  // have a verified consumer are logged inside the policy hook that
  // owns that callback contract.
  readonly Release: (ctx: PostConsumeSponsorContext) => Promise<void> | void;
}

/** Compile-time guarantee: every state literal has a corresponding hook signature. */
type _AssertExhaustive = SponsoredExecutionState extends keyof StateHookSignatures ? true : never;
type _AssertNoExtras = keyof StateHookSignatures extends SponsoredExecutionState ? true : never;
const _exhaustiveCheck: _AssertExhaustive = true;
const _noExtrasCheck: _AssertNoExtras = true;
void _exhaustiveCheck;
void _noExtrasCheck;

/**
 * Subset of prepare hooks required in every execution policy. The two
 * route-reservation hooks may be omitted; the procedural runner decides whether
 * to execute those actions from the policy's actual handle requirements.
 */
export type MandatoryPrepareState = Exclude<
  PrepareState,
  'RouteReservationBeforeBuild' | 'RouteReservationAfterBuild'
>;

// ─────────────────────────────────────────────
// SponsoredExecutionPolicy interface
// ─────────────────────────────────────────────

/**
 * One SponsoredExecutionPolicy owns one route. The interface separates DATA from
 * FUNCTION REGISTRY so the data half can be inspected statically (route
 * identity, handle requirements, public error vocabulary) without
 * resolving any executable hook.
 */
export interface SponsoredExecutionPolicy<D extends PolicyDiscriminator = PolicyDiscriminator> {
  /** Route discriminator written into the prepared entry. */
  readonly discriminator: D;
  /**
   * Route-specific handle requirements. The runners read these values to
   * decide optional acquisition or validation behavior.
   */
  readonly handleRequirements: SponsoredExecutionPolicyHandleRequirements;
  /**
   * Hook function registry, keyed by lifecycle state. Mandatory states
   * MUST have a registered hook; optional states MAY omit the entry.
   */
  readonly hooks: PolicyHooks<D>;
}

/**
 * Hook registry shape: required mandatory keys + optional state keys.
 * Forwarded as the value of `SponsoredExecutionPolicy.hooks`.
 */
export type PolicyHooks<D extends PolicyDiscriminator = PolicyDiscriminator> = {
  readonly [K in MandatoryPrepareState]: StateHookSignatures<D>[K];
} & {
  readonly [K in SponsorState]: StateHookSignatures<D>[K];
} & {
  readonly RouteReservationBeforeBuild?: StateHookSignatures<D>['RouteReservationBeforeBuild'];
  readonly RouteReservationAfterBuild?: StateHookSignatures<D>['RouteReservationAfterBuild'];
};

// ─────────────────────────────────────────────
// Registry — exact-key policy lookup
// ─────────────────────────────────────────────

/** All policy discriminator literals, listed once for runtime + type checks. */
const POLICY_DISCRIMINATORS = [
  'generic',
  'promotion',
] as const satisfies readonly PolicyDiscriminator[];

/**
 * Typed `discriminator → policy` registry. Construction guarantees the
 * registry covers EXACTLY one policy per discriminator literal — missing
 * a discriminator, registering two policies for the same discriminator,
 * or registering a key outside `PolicyDiscriminator` is rejected at both
 * compile time and runtime.
 */
export type SponsoredExecutionPolicyRegistry = {
  readonly [D in PolicyDiscriminator]: SponsoredExecutionPolicy<D>;
};

/**
 * Raised when `createSponsoredExecutionPolicyRegistry` detects a runtime mismatch:
 *   - a key outside `PolicyDiscriminator` (`reason: 'unknown_key'`),
 *   - a missing discriminator (`reason: 'missing_key'`),
 *   - a policy whose `discriminator` does not match its registry key
 *     (`reason: 'discriminator_mismatch'`).
 */
export class SponsoredExecutionPolicyRegistryError extends Error {
  constructor(
    message: string,
    public readonly reason: 'unknown_key' | 'missing_key' | 'discriminator_mismatch',
  ) {
    super(message);
    this.name = 'SponsoredExecutionPolicyRegistryError';
  }
}

/**
 * Compile-time exact-key shape. `Policies` must have ONLY the discriminator
 * keys; any extra key falls through to `never` and reports a type
 * error at the call site.
 */
type ExactSponsoredExecutionPolicyMap<Policies> = {
  [K in keyof Policies]: K extends PolicyDiscriminator ? SponsoredExecutionPolicy<K> : never;
} & { readonly [D in PolicyDiscriminator]: SponsoredExecutionPolicy<D> };

/**
 * Construct a `SponsoredExecutionPolicyRegistry`. Type-level: `Policies` must equal the
 * `PolicyDiscriminator` key set exactly; extra keys produce a `never`
 * value type at the offending key and fail to type-check. Runtime: a
 * defensive shield re-checks the key set in case an `as` cast bypassed
 * the compile-time gate.
 *
 * The runtime body returns a freshly-constructed object containing only
 * the documented keys, so a caller that managed to slip an extra key
 * past the type gate cannot cause that key to land on the returned
 * registry.
 */
export function createSponsoredExecutionPolicyRegistry<
  Policies extends ExactSponsoredExecutionPolicyMap<Policies>,
>(policies: Policies): SponsoredExecutionPolicyRegistry {
  const inputKeys = Object.keys(policies);
  for (const key of inputKeys) {
    if (!(POLICY_DISCRIMINATORS as readonly string[]).includes(key)) {
      throw new SponsoredExecutionPolicyRegistryError(
        `SponsoredExecutionPolicyRegistry: unknown discriminator key '${key}' (allowed: ${POLICY_DISCRIMINATORS.join(', ')})`,
        'unknown_key',
      );
    }
  }
  const typedPolicies = policies as SponsoredExecutionPolicyRegistry;
  for (const d of POLICY_DISCRIMINATORS) {
    const policy = (policies as { [k: string]: SponsoredExecutionPolicy | undefined })[d];
    if (!policy) {
      throw new SponsoredExecutionPolicyRegistryError(
        `SponsoredExecutionPolicyRegistry missing policy for discriminator '${d}'`,
        'missing_key',
      );
    }
    if (policy.discriminator !== d) {
      throw new SponsoredExecutionPolicyRegistryError(
        `SponsoredExecutionPolicyRegistry: policy for '${d}' carries discriminator '${policy.discriminator}'`,
        'discriminator_mismatch',
      );
    }
  }
  return {
    generic: typedPolicies.generic,
    promotion: typedPolicies.promotion,
  };
}
