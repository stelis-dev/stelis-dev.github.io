/**
 * @stelis/core-relay/browser — browser-safe subset of the core-relay API.
 *
 * This entry re-exports everything that is safe to load from a browser
 * runtime. Use this entry when bundling for browser environments (Vite,
 * webpack, etc.) to avoid pulling Node-only modules into the browser
 * bundle. Server-side code (core-api, app-api) should import from the
 * main barrel '@stelis/core-relay'.
 *
 * Cross-package request and response types, runtime data tables, identifiers, and
 * discriminator literals live in `@stelis/contracts`. This browser
 * barrel intentionally keeps runtime helpers only; import shared
 * data/types from `@stelis/contracts` directly.
 *
 * Note: `computePolicyHash` and `PolicyFields` are owned by the Host policy layer
 * server. They live in core-api's internal `src/policyHash.ts` server
 * module (no public package subpath; consumers within `core-api` import
 * via a relative path) and are not exported from this package at all.
 * SDK and browser consumers receive the policy hash from the
 * `/relay/prepare` response and pass it through to the PTB without
 * recomputing it.
 */

// ── Constants (browser-safe, core-relay-interior) ───────────────────────────
export { MAX_COMMANDS, SUI_CLOCK_OBJECT_ID } from './constants.js';

// ── Hash utilities (browser-safe, uses SubtleCrypto) ────────────────────────
export { sha256Bytes } from './hash.js';

// ── Prepare authorization message (browser-safe) ────────────────────────────
export {
  serializePrepareAuthorizationMessage,
  encodePrepareAuthorizationMessage,
  hashPrepareAuthorizationMessage,
  PrepareAuthorizationMessageError,
} from './prepareAuthorization.js';

// ── Server-interior types (kept in core-relay) ──────────────────────────────
export type {
  OnchainConfig,
  AllowedSettlementSwapPath,
  HostValidationEnv,
  ValidationResult,
  SettleArgs,
} from './types.js';
export { ok, fail } from './types.js';

// ── Validation ──────────────────────────────────────────────────────────────
export {
  validatePtbStructure,
  validateUserCommands,
  validateSettleArgs,
  isMoveCall,
} from './validate/static.js';
export { validateGenericUserTransactionKind } from './validate/transactionKind.js';
export { validateNonlossSponsor } from './validate/nonloss.js';
export type { SponsorNonlossContext } from './validate/nonloss.js';

export { buildSwapAndSettlePtb, buildSettleWithCreditPtb } from './ptb/builders.js';
export type {
  SwapAndSettleCommonParams,
  SwapAndSettleWithVaultParams,
  SwapAndSettleParams,
  SettleWithCreditPtbParams,
} from './ptb/builders.js';

// ── Gas estimation ──────────────────────────────────────────────────────────
export {
  computeExecutionCostClaim,
  GAS_VARIANCE_FIXED_MIST,
  CONVERGENCE_TOLERANCE_BPS,
  DEFAULT_GAS_MARGIN_BPS,
} from './gasEstimate.js';
export type {
  SimulationGasUsed,
  ExecutionCostClaimEstimate,
  ComputeExecutionCostClaimOpts,
} from './gasEstimate.js';

// ── Credit query ────────────────────────────────────────────────────────────
export { queryUserCredit, CreditQueryInconsistentStateError } from './creditQuery.js';
export type { CreditResult } from './creditQuery.js';

// ── DeepBook utilities ──────────────────────────────────────────────────────
// `getQuantityOut`, `getHopMidPriceRaw`, and `getInputForTargetOutput` are
// intentionally not re-exported here. None has a verified browser/SDK consumer
// in this repo: `getQuantityOut` and `getInputForTargetOutput` are wrapped by
// `MarketQuotePort` server-side, and `getHopMidPriceRaw` is reached only as an
// internal shortcut inside `batchGetHopMidPrices` for 1-hop pools. SDK + server
// consumers (sdk.ts, swap.ts, core-api/prepare/build.ts) call
// `batchGetHopMidPrices` directly.
export { batchGetHopMidPrices } from './deepbook.js';

// ── SDK command conversion (S-16 integrity) ─────────────────────────────────
export { convertSdkCommands } from './convert.js';

// ── Structural command comparator (S-16 integrity) ──────────────────────────
// Used by SDK integrity verification.
export { integrityCompare } from './integrityCompare.js';
export type { IntegrityVerdict } from './integrityCompare.js';

// ── GasCoin reference detection (S-15/S-16) ─────────────────────────────────
export { containsGasCoinReference } from './validate/static.js';

// ── PTB input object ID extraction (integrity + prefix value tracing) ────────
export { extractObjectIdFromInput } from './ptbInputUtils.js';

// ── tx gas preset guard ─────────────────────────────────────────────────────
export { assertNoGasPreset } from './validate/txGuard.js';

// ── Settle fee extractor ────────────────────────────────────────────────────
export { extractCostFromTxBytes } from './settleArgsCost.js';
export type { SettleArgsCost } from './settleArgsCost.js';

// ── Fail-closed settle field extractor ──────────────────────────────────────
export {
  extractSettleTransactionFieldsFromData,
  extractSettleTransactionFieldsFromTxBytes,
  validateSettleTransactionFields,
  SettleTransactionFieldsError,
} from './settleTransactionFields.js';
export type {
  SettleTransactionFields,
  ExpectedSettleTransactionFields,
} from './settleTransactionFields.js';

// ── Full settle arg parser ──────────────────────────────────────────────────
export { parseSettleArgs, ParseSettleArgsError, ARG_INDEX_MAP } from './parseSettleArgs.js';
export type { ArgIndexMap } from './parseSettleArgs.js';

// ── R-10 target canonicalization (browser-safe) ──────────────────────────────
export { canonicalizeTarget } from './canonicalizeTarget.js';

// NOTE: `computePolicyHash` / `PolicyFields` were moved out of this
// package because policy hashing is server-only. The current owner is
// core-api's internal `src/policyHash.ts` server module (no public
// package subpath). They are not exported from this package at any
// subpath — browser, main, or server. SDK consumers receive the hash
// from `/relay/prepare` and never compute it themselves.
