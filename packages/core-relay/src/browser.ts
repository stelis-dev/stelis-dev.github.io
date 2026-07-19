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
export { SUI_CLOCK_OBJECT_ID } from './constants.js';

// ── Hash utilities (browser-safe, uses SubtleCrypto) ────────────────────────
export { sha256Bytes } from './hash.js';

// ── Exact current Sui operation authority ──────────────────────────────────
export { SuiOperationError, createSuiEndpointSnapshot } from './sui/suiOperation.js';
export type { SuiEndpointSnapshot } from './sui/suiOperation.js';
export {
  executeSuiTransaction,
  getSuiTransactionEvents,
  simulateSuiTransaction,
} from './sui/suiTransactionGateways.js';
export { buildSuiTransaction } from './sui/suiTransactionResolution.js';
export { suiExecutionErrorMessage } from './sui/suiTransactionShape.js';
export type {
  SuiSimulationResult,
  SuiTransactionWithEventsResult,
} from './sui/suiTransactionShape.js';
export {
  assertSuiNetwork,
  getSuiBalance,
  MAX_SUI_COIN_OBJECTS_PER_OPERATION,
  readBoundedSuiCoins,
} from './sui/suiStateGateways.js';
export type { SuiCoinReadResult } from './sui/suiStateGateways.js';
export { selectSuiCoinSubset } from './sui/suiCoinSelection.js';

// ── Prepare authorization message (browser-safe) ────────────────────────────
export { encodePrepareAuthorizationMessage } from './prepareAuthorization.js';

// ── Validation ──────────────────────────────────────────────────────────────
export { isMoveCall } from './validate/static.js';
export { validateGenericUserTransactionKind } from './validate/transactionKind.js';

// ── Gas estimation ──────────────────────────────────────────────────────────
export { computeExecutionCostClaim, DEFAULT_GAS_MARGIN_BPS } from './gasEstimate.js';
export type { SimulationGasUsed } from './gasEstimate.js';

// ── Credit query ────────────────────────────────────────────────────────────
export { queryUserCredit, CreditQueryInconsistentStateError } from './creditQuery.js';
export type { CreditResult } from './creditQuery.js';

// ── DeepBook utilities ──────────────────────────────────────────────────────
// SDK consumes batch mid-prices; app-web consumes the exact quantity-out view
// rather than maintaining a second DeepBook ABI decoder.
export { batchGetHopMidPrices, getQuantityOut } from './deepbook.js';

// ── SDK command conversion (S-16 integrity) ─────────────────────────────────
export { convertSdkCommands } from './convert.js';
export { projectSuiInputIdentity } from './sui/suiTransactionShape.js';

// ── Structural command comparator (S-16 integrity) ──────────────────────────
// Used by SDK integrity verification.
export { integrityCompare } from './integrityCompare.js';

// ── GasCoin reference detection (S-15/S-16) ─────────────────────────────────
export { containsGasCoinReference } from './validate/static.js';

// ── tx gas preset guard ─────────────────────────────────────────────────────
export { assertNoGasPreset } from './validate/txGuard.js';

// ── Fail-closed settle field extractor ──────────────────────────────────────
export {
  extractSettleTransactionFieldsFromTxBytes,
  validateSettleTransactionFields,
} from './settleTransactionFields.js';

// NOTE: `computePolicyHash` / `PolicyFields` were moved out of this
// package because policy hashing is server-only. The current owner is
// core-api's internal `src/policyHash.ts` server module (no public
// package subpath). They are not exported from this package at any
// subpath — browser, main, or server. SDK consumers receive the hash
// from `/relay/prepare` and never compute it themselves.
