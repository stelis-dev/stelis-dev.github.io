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
export type PrepareState = 'Intent' | 'RequestValidation' | 'ChainSnapshot' | 'GasBoundBuild';

/** Sponsor-side states (run inside the `/sponsor` request). */
export type SponsorState =
  | 'DecodeSponsorSubmission'
  | 'UserSignatureValidation'
  | 'SharedSponsorChecks'
  | 'PolicySponsorChecks'
  | 'Preflight'
  | 'ClassifySponsorResult';

/** Discriminated union of every named state on the SponsoredExecution machine. */
export type SponsoredExecutionState = PrepareState | SponsorState;
