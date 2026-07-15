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

// Host-only PTB materialization consumed by core-api's settlement compiler.
export { buildSwapAndSettlePtb, buildSettleWithCreditPtb } from './ptb/builders.js';
export { SUI_OPERATION_ATTEMPT_TIMEOUT_MS } from './sui/suiOperation.js';
export {
  getSuiTransactionBalanceChanges,
  getSuiTransactionEffects,
  simulateSuiMoveView,
} from './sui/suiTransactionGateways.js';
export type {
  SuiCommandResult,
  SuiExecutionError,
  SuiExecutionErrorKind,
  SuiMoveViewResult,
  SuiTransactionResult,
} from './sui/suiTransactionShape.js';
export {
  getSuiChainIdentifier,
  getSuiCoinMetadata,
  getSuiObject,
  getSuiObjects,
} from './sui/suiStateGateways.js';
export type { SuiObject } from './sui/suiStateGateways.js';
export { decodeExactU64Bytes } from './decodeU64.js';

export { MAX_FINAL_COMMANDS } from './constants.js';
export type {
  AllowedSettlementSwapPath,
  OnchainConfig,
  HostValidationEnv,
  SettleArgs,
} from './types.js';
export { validateSettleArgs } from './validate/static.js';
export { validateNonlossSponsor } from './validate/nonloss.js';
export { CONVERGENCE_TOLERANCE_BPS, GAS_VARIANCE_FIXED_MIST } from './gasEstimate.js';
export type { ExecutionCostClaimEstimate } from './gasEstimate.js';
export { parseSettleArgs, ParseSettleArgsError } from './parseSettleArgs.js';

// Shared cross-package economic caps live in @stelis/contracts. Import
// GAS_MARGIN_CAP_BPS from that package directly when needed.

// Main-barrel-only defaults/errors consumed by core-api server code.
export { DEFAULT_SLIPPAGE_BPS } from './deepbook.js';
export { SlippageQueryError } from './deepbookErrors.js';
export { validateGenericSettlementTransaction } from './validate/transactionKind.js';

// Prefix value trace: used in the core-api prepare path, not in the browser.
export {
  PrefixValueTraceError,
  traceUserPrefixValue,
  containsSponsorWithdrawal,
} from './prefixValueTrace.js';
export type { PrefixValueTrace } from './prefixValueTrace.js';
