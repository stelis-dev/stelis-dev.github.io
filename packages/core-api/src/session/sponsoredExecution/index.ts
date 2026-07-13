/**
 * SponsoredExecution — internal barrel.
 *
 * This module is the type/contract foundation for the shared lifecycle.
 *
 * Internal to `core-api`. NOT re-exported from
 * `packages/core-api/src/index.ts`. Production source under
 * `packages/core-api/src/` may consume the public types and the public
 * mint helpers (`reconstructReservationHandles`, `createGasBoundBuildInput`) through
 * this barrel; the raw factory key, factory, and implementation classes
 * that live in `reservationHandles.ts` are not re-exported here.
 *
 * Test suites under `packages/*\/tests/**` are exempt from the static
 * guard and may import from `reservationHandles.ts` directly to verify the
 * brand/guard runtime contract.
 */

// ─────────────────────────────────────────────
// Public types + helpers from each module.
// Raw factory key, internal factory, and *Impl classes are NOT re-exported.
// ─────────────────────────────────────────────

export type { PrepareState, SponsorState, SponsoredExecutionState } from './states.js';

export type {
  ReservationHandleBrand,
  SponsorSlotReservationHandle,
  NonceReservationHandle,
  LedgerReservationHandle,
  SponsorSlotReconstructionInputs,
  NonceReconstructionInputs,
  LedgerReservationReconstructionInputs,
  GasBoundBuildReservationHandles,
  SponsorResultReservationHandles,
  GasBoundBuildInput,
  GasBoundBuildResult,
} from './reservationHandles.js';
export {
  ReservationHandleClosedError,
  ReservationHandleConstructionError,
  reconstructReservationHandles,
  createGasBoundBuildInput,
} from './reservationHandles.js';

export type {
  PolicyDiscriminator,
  SponsoredExecutionPolicyHandleRequirements,
  GasBoundBuildHandleRequirements,
  PreparedCommitHandleRequirements,
  SponsorResultHandleRequirements,
  PreparePolicyHookContext,
  GenericPrepareChainSnapshot,
  PromotionPrepareChainSnapshot,
  PrepareChainSnapshot,
  PreConsumeSponsorContext,
  PostConsumeSponsorContext,
  SharedPostconsumeReconstruction,
  PolicyPostconsumeReconstruction,
  StateHookSignatures,
  MandatoryPrepareState,
  SponsoredExecutionPolicy,
  PolicyHooks,
  SponsoredExecutionPolicyRegistry,
} from './executionPolicy.js';
export {
  createSponsoredExecutionPolicyRegistry,
  SponsoredExecutionPolicyRegistryError,
} from './executionPolicy.js';

export type {
  PrepareStateMachineHost,
  PrepareStateMachineRequest,
  PrepareResponseProjectionInput,
  PrepareDraftPolicyFields,
} from './runner.js';
export {
  runPrepareStateMachine,
  RunnerHostMisconfiguredError,
  RunnerSponsorSlotExhaustedError,
  RunnerLedgerReservationRejectedError,
} from './runner.js';

export type {
  SignAndSubmitPort,
  SponsorStateMachineHost,
  SponsorStateMachineRequest,
  SponsorResultSnapshot,
} from './sponsorRunner.js';
export {
  runSponsorStateMachine,
  RunnerSponsorReservationHandleMissingError,
  RunnerSponsorPolicyContractError,
} from './sponsorRunner.js';
