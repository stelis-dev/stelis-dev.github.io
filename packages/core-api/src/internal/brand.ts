/**
 * Internal-only nominal types for execution-critical units.
 *
 * NOT exported from `@stelis/core-api` (`../index.ts`). Import via
 * relative paths only, strictly within the core-api package. The
 * goal is to make wrong-unit plumbing a TS compile error in
 * core-api execution code without widening the package's public
 * API.
 *
 * Design:
 *   - `Mist` is a bigint subtype (`bigint & { __brand: 'Mist' }`).
 *     A `Mist` is assignable anywhere a `bigint` is expected (read
 *     paths work unchanged). A raw `bigint` is NOT assignable to a
 *     function parameter typed `Mist` without an explicit `mist()`
 *     tag — this is the nominal property we want.
 *   - `Bps` uses the same discipline over `number`.
 *   - `mist()` / `bps()` / `unBps()` are identity tags at runtime.
 *     `Mist` remains assignable to `bigint`, so it needs no unwrapping
 *     helper.
 *   - `parseBps()` delegates input validation to the shared
 *     `validateBps()`, then tags the accepted number. No second
 *     validator is introduced.
 *
 * Intentional non-goals:
 *   - No arithmetic helpers (`addMist`, `mulMist`, …). Internal
 *     arithmetic on `Mist` operands returns `bigint`; call sites can
 *     retag with `mist()` where the result is semantically a Mist.
 *     Helpers are added only if a duplicated retag pattern appears.
 *   - No public or package-barrel re-export. This module must not be
 *     added to `../index.ts`.
 */

import { validateBps, type BpsValidationError } from '../validateBps.js';

// ─────────────────────────────────────────────
// Nominal types
// ─────────────────────────────────────────────

/** Execution-critical amount in MIST. */
export type Mist = bigint & { readonly __brand: 'Mist' };

/** Basis points (0-10_000). */
export type Bps = number & { readonly __brand: 'Bps' };

// ─────────────────────────────────────────────
// Tag / untag
// ─────────────────────────────────────────────

/** Tag a raw bigint as Mist. Identity at runtime. */
export function mist(value: bigint): Mist {
  return value as Mist;
}

/** Tag a raw number as Bps. Identity at runtime. Prefer `parseBps` at HTTP boundaries. */
export function bps(value: number): Bps {
  return value as Bps;
}

/** Remove the Bps tag. Use at HTTP or serialization boundaries only. */
export function unBps(value: Bps): number {
  return value as number;
}

// ─────────────────────────────────────────────
// Validated parse (delegates to validateBps)
// ─────────────────────────────────────────────

export type BpsParseResult = { ok: true; value: Bps } | BpsValidationError;

/**
 * Validate and tag a BPS value from untrusted input.
 *
 * Delegates entirely to `validateBps()` for validation; only tags
 * the accepted numeric value. If the validator rejects, the same
 * `BpsValidationError` shape is returned verbatim.
 */
export function parseBps(name: string, value: unknown, cap: number, code: string): BpsParseResult {
  const r = validateBps(name, value, cap, code);
  if (!r.ok) return r;
  return { ok: true, value: bps(r.value) };
}
