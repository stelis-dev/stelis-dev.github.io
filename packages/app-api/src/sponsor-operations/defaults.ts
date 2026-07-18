/**
 * [app-api] Sponsor operations app-api-private defaults.
 *
 * Owns the two balance thresholds used by `boot.ts` env validation,
 * `routes/admin.ts` threshold fallbacks, and the shared-state
 * slot-state classification.
 *
 * The five `SPONSOR_OPERATIONS_*` timing values named in
 * `docs/parameters.md` are NOT carried here. They are injected as
 * required env-driven parameters by `boot.ts`. The repository
 * documents them as deployment-defined required env values with no
 * code-side numeric default.
 */

export const SPONSOR_BALANCE_WARN_MIST = 5_000_000_000n;

export const SPONSOR_BALANCE_REFILL_TARGET_MIST = 10_000_000_000n;
