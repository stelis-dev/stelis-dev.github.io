// @stelis/core-relay — public API
//
// Browser-safe exports are maintained in browser.ts.
// This barrel re-exports all browser-safe symbols and adds server-only extras.
//
// To add a new export:
//   - browser-safe:   add to browser.ts only; it appears here automatically.
//   - server-only:    add explicitly below (with a comment explaining why).

export * from './browser.js';

// ── Server-side only (not in browser barrel) ─────────────────────────────────

// Shared cross-package economic caps live in @stelis/contracts. Import
// GAS_MARGIN_CAP_BPS from that package directly when needed.

// Main-barrel-only defaults/errors consumed by core-api server code.
export { DEFAULT_SLIPPAGE_BPS } from './deepbook.js';
export { SlippageQueryError } from './deepbookErrors.js';
export { validateGenericSettlementTransaction } from './validate/transactionKind.js';

// Vault object-field extractors are needed by core-api host context, but have
// no verified browser/SDK consumer.
export { extractVaultTableId, extractMoveObjectFields } from './creditQuery.js';

// Prefix value trace: used in the core-api prepare path, not in the browser.
export {
  PrefixValueTraceError,
  traceUserPrefixValue,
  containsSponsorWithdrawal,
} from './prefixValueTrace.js';
export type { PrefixValueTrace } from './prefixValueTrace.js';

// Transport error-code unions: type-only re-export so the server-side failure
// policy (`packages/core-api/src/failures.ts`) can narrow `FailureCode` against
// the schema-locked response contracts. Runtime tuples (`KNOWN_*_ERROR_CODES`)
// remain internal to this package; tests reach them via relative import.
export type {
  KnownPrepareErrorCode,
  KnownSponsorErrorCode,
  KnownPromotionPrepareErrorCode,
  KnownPromotionSponsorErrorCode,
} from './errorCode.js';
