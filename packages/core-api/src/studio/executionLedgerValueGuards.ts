/**
 * ExecutionLedger value-guard helpers — internal shared module.
 *
 * Owns the small parse + assertion helpers that the Memory and Redis
 * adapters apply to MIST money inputs. Centralising the helpers here
 * keeps the two adapters in lock-step on parse semantics and error
 * messages — `executionLedger.conformance.ts` exercises both adapters
 * against the same expectations, so any divergence in these helpers
 * would appear as a conformance fail.
 *
 * Scope and call sites (current runtime):
 *   - `parseNonNegativeDecimalBigInt` — used by both adapters in
 *     `claim()` to parse `opts.perUserGasAllowanceMist`. The Memory
 *     adapter also uses it on the lazy-budget read path
 *     (`getBudgetSummary` / `ensureBudget`) to materialise stored
 *     `promoConfig.perUserGasAllowanceMist`. Single error string
 *     (`"${label} must be a non-negative decimal integer string"`)
 *     across both adapters, locked by the conformance test
 *     `rejects non-safe participant counts and non-decimal allowance
 *     strings`.
 *   - `assertPositiveMist` — used in `reserve()` on `amountMist`.
 *   - `assertNonNegativeMist` — used in `consume()` on `actualGasMist`.
 *   - `assertWithinLedgerBound` — used in `reserve()` and `consume()`
 *     ONLY. The `claim()` upper-bound check on per-user and on the
 *     `maxParticipants × perUserGasAllowanceMist` product is
 *     intentionally inline in each adapter (Memory and Redis both
 *     carry the same two inline blocks) because those messages
 *     embed branch-specific context — `total budget (maxParticipants
 *     × perUserGasAllowanceMist = ${product}) exceeds ...` — that
 *     this helper's generic `${label} (${value}) exceeds ...` shape
 *     would lose. Conformance test `rejects perUserGasAllowanceMist
 *     > MAX_PROMOTION_LEDGER_VALUE_MIST` and `rejects maxParticipants
 *     × perUserGasAllowanceMist > MAX_PROMOTION_LEDGER_VALUE_MIST`
 *     match the inline messages with regex (not exact-string),
 *     reflecting the intentional message divergence.
 *
 * Adapter-local (NOT shared): Redis adapter keeps its own
 * `parseNonNegativeSafeInteger` because it is used only for
 * Redis-local return-shape coercion (`SCARD` claimed count, `TIME`
 * milliseconds), not for ledger-money inputs.
 *
 * Visibility: this module is internal to `core-api/studio` and is
 * NOT re-exported from `studio/index.ts` or any package / browser /
 * SDK API. Bound policy lives at
 * `MAX_PROMOTION_LEDGER_VALUE_MIST` in `executionLedger.ts`; this
 * module only enforces it on the `reserve()` / `consume()` paths.
 *
 * @module studio/executionLedgerValueGuards
 */

import { MAX_PROMOTION_LEDGER_VALUE_MIST } from './executionLedger.js';

const DECIMAL_MIST_RE = /^(?:0|[1-9]\d*)$/;

/**
 * Parse a non-negative decimal integer string into `bigint`.
 *
 * Throws on any non-decimal shape (scientific notation, hex, leading
 * zeros, signs, whitespace). The error message stays exactly
 * `"${label} must be a non-negative decimal integer string"` because
 * the conformance suite matches it literally on both adapters.
 */
export function parseNonNegativeDecimalBigInt(value: string, label: string): bigint {
  if (!DECIMAL_MIST_RE.test(value)) {
    throw new Error(`${label} must be a non-negative decimal integer string`);
  }
  return BigInt(value);
}

/**
 * Reject zero or negative MIST values. Used on `reserve(amountMist)`.
 *
 * Error message stays exactly `"${label} must be greater than zero"`.
 */
export function assertPositiveMist(value: bigint, label: string): void {
  if (value <= 0n) {
    throw new Error(`${label} must be greater than zero`);
  }
}

/**
 * Reject negative MIST values. Used on `consume(actualGasMist)` where
 * a successful zero-net revert produces `actualGasMist === 0n` (the
 * canonical 0-clamp from `computeExecutionCostClaim(...).simGas`).
 *
 * Error message stays exactly `"${label} must be non-negative"`.
 */
export function assertNonNegativeMist(value: bigint, label: string): void {
  if (value < 0n) {
    throw new Error(`${label} must be non-negative`);
  }
}

/**
 * Defensive upper-bound check on the MIST value that flows into the
 * `reserve()` and `consume()` money-mutating ledger ops (reserve's
 * `amountMist`, consume's `actualGasMist`). The activation gate
 * (`validateActivationPrerequisites`) is the main validation point;
 * this guard is the defense-in-depth layer for any out-of-band
 * caller that bypasses activation. Without it, values above
 * `MAX_PROMOTION_LEDGER_VALUE_MIST = Number.MAX_SAFE_INTEGER` would
 * push `LUA_RESERVE` / `LUA_CONSUME` / `LUA_RELEASE` arithmetic above
 * the Lua-double precision boundary and silently misbehave on the
 * comparison + clamp logic.
 *
 * NOT used by `claim()`: the claim-side per-user and product upper-
 * bound checks are inline in both adapters because their error
 * messages embed branch-specific context (`total budget
 * (maxParticipants × perUserGasAllowanceMist = ${product}) exceeds
 * ...`) that this helper's generic `${label}` shape would lose.
 *
 * Error message stays exactly
 * `"${label} (${value}) exceeds MAX_PROMOTION_LEDGER_VALUE_MIST (${bound})"`.
 */
export function assertWithinLedgerBound(value: bigint, label: string): void {
  if (value > MAX_PROMOTION_LEDGER_VALUE_MIST) {
    throw new Error(
      `${label} (${value.toString()}) exceeds MAX_PROMOTION_LEDGER_VALUE_MIST (${MAX_PROMOTION_LEDGER_VALUE_MIST.toString()})`,
    );
  }
}
