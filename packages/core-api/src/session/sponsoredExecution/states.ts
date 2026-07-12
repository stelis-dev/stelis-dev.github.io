/**
 * SponsoredExecution hook vocabulary.
 *
 * These unions are type contracts for the policy hook registry. Runtime order,
 * optional execution, and resource ownership belong to the procedural prepare
 * and sponsor runners; this module intentionally declares no parallel runtime
 * order, phase, or transition data.
 *
 * Internal module. Do not export from the package main barrel.
 */

/** Prepare-side policy hook names. */
export type PrepareState =
  | 'Intent'
  | 'RequestValidation'
  | 'InflightAdmission'
  | 'ChainSnapshot'
  | 'ExecutionPolicySelected'
  | 'SlotFreePlan'
  | 'SponsorSlotReservationAcquired'
  | 'RouteReservationBeforeBuild'
  | 'GasBoundBuild'
  | 'RouteReservationAfterBuild'
  | 'SelfCheck'
  | 'SponsorLeaseCommitted';

/** Sponsor-side states (run inside the `/sponsor` request). */
export type SponsorState =
  | 'DecodeSponsorSubmission'
  | 'UserSignatureValidation'
  | 'Consume'
  | 'SharedPostconsumeChecks'
  | 'PolicyPostconsumeChecks'
  | 'Preflight'
  | 'PolicyApproval'
  | 'SponsorSign'
  | 'Submit'
  | 'ClassifySponsorResult'
  | 'Release';

/** Discriminated union of every named state on the SponsoredExecution machine. */
export type SponsoredExecutionState = PrepareState | SponsorState;
