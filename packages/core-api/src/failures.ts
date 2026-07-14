/**
 * failures.ts — runtime predicates and event helpers for server-side failures.
 *
 * Failure code vocabulary and table data live in failurePolicy.ts. This file
 * keeps runtime lookup, carve-out predicates, and drift event emission together.
 */
import type { SponsorFailureMeta } from './store/abuseBlockTypes.js';
import { logStructuredEvent } from './structuredEventLog.js';
import { SPONSOR_DRIFT_OBSERVED } from './observability/events.js';
import { FAILURE_TABLE, type FailurePolicy } from './failurePolicy.js';
export { FAILURE_TABLE, PROMOTION_ABUSE_CODES } from './failurePolicy.js';
export type {
  AbuseImpact,
  FailureClassification,
  FailureCode,
  FailurePolicy,
  PromotionAbuseCode,
} from './failurePolicy.js';

// ─────────────────────────────────────────────
// Code-level classification predicates
// ─────────────────────────────────────────────

/** Backstop guard for codes constructed dynamically from string parameters. */
function lookupPolicy(code: string): FailurePolicy | undefined {
  return (FAILURE_TABLE as Record<string, FailurePolicy>)[code];
}

/**
 * Returns the failure policy for `code`, or `undefined` when the code is
 * outside the public HTTP and promotion-abuse unions. Adapters consult the
 * `abuseImpact` field to decide whether to increment IP / subject
 * counters; `classification === 'manipulation'` triggers the long-block
 * branch.
 */
export function getFailurePolicy(code: string): FailurePolicy | undefined {
  return lookupPolicy(code);
}

/**
 * Whether the failure code is `ignored` or `drift` (no abuse counter at
 * any level). Equivalent to `policy.abuseImpact.ip === 'skip' &&
 * policy.abuseImpact.subject === 'skip'` for the canonical entries; callers
 * use this predicate before reaching the adapter (`recordSponsorFailureForAbuse`).
 */
export function shouldIgnoreSponsorFailureForAbuse(code: string): boolean {
  const policy = lookupPolicy(code);
  if (!policy) return false;
  return policy.classification === 'ignored' || policy.classification === 'drift';
}

/**
 * Whether the failure code is `manipulation` (long-block in the abuse
 * adapter).
 */
export function isManipulationAttemptCode(code: string): boolean {
  return lookupPolicy(code)?.classification === 'manipulation';
}

/**
 * Storage-tier mapping for subject counters.
 *
 * `abuseImpact.subject` says whether the subject counter should
 * increment at all; this helper resolves which counter family the
 * increment goes into. The two families are persisted separately by
 * `MemoryAbuseBlocker` / `RedisAbuseBlocker` because they carry
 * different windows and thresholds:
 *
 *   - `'sim_tier'`: DRY_RUN_FAILED + PREFLIGHT_FAILED
 *     (`addressDryRunWindowMs` / `addressDryRunThreshold`).
 *   - `'revert'`: ONCHAIN_REVERT
 *     (`addressOnchainRevertWindowMs` / `addressOnchainRevertThreshold`).
 *
 * `SPONSOR_PREFLIGHT_FAILED` and `SPONSOR_ONCHAIN_FAILED` are generic
 * Relay API transport projections. Generic and Promotion sponsor paths both
 * record the underlying event through `PREFLIGHT_FAILED` / `ONCHAIN_REVERT`,
 * so the public generic codes do not own a second counter family.
 *
 * Codes whose family is `null` increment only the IP counter (the
 * subject counter has nowhere to go in the current adapter shape).
 * Most `normal`-classified codes — including the promotion abuse
 * codes routed through the same blocker — fall here.
 */
export type SubjectCounterFamily = 'sim_tier' | 'revert' | null;

const SUBJECT_COUNTER_FAMILY: Readonly<Record<string, SubjectCounterFamily>> = {
  DRY_RUN_FAILED: 'sim_tier',
  PREFLIGHT_FAILED: 'sim_tier',
  ONCHAIN_REVERT: 'revert',
};

export function subjectCounterFamily(code: string): SubjectCounterFamily {
  return SUBJECT_COUNTER_FAMILY[code] ?? null;
}

// ─────────────────────────────────────────────
// Subcode-level carve-out policy
// ─────────────────────────────────────────────

/**
 * Benign retry/concurrency Move-abort subcodes that skip every non-IP
 * temporary-block counter (sim-tier and on-chain-revert). The IP counter
 * still increments. Vocabulary is stable because both
 * abuse-blocker adapters (`memoryAbuseBlocker.ts`,
 * `redisAbuseBlocker.ts`) match against `meta.subcode` literals via
 * `shouldCarveOutNonIpCounter`.
 *
 * Members:
 *   - `PAUSED` — `settle::EPaused`. Operator-driven pause.
 *   - `VAULT_ALREADY_REGISTERED` — `vault::EVaultAlreadyRegistered`.
 *     New-user User Vault race; benign duplicate registration.
 *   - `REPLAY_NONCE` — `vault::EReplayNonce`. S-14 monotonic gap from
 *     out-of-order land; benign retry.
 *
 */
export const ADDRESS_CARVE_OUT_SUBCODES = [
  'PAUSED',
  'VAULT_ALREADY_REGISTERED',
  'REPLAY_NONCE',
] as const;

/**
 * Market-volatility Move-abort subcodes that skip the non-IP
 * `PREFLIGHT_FAILED` simulation-tier counter. Once the same condition
 * reaches an on-chain revert it counts in the separate revert family.
 *
 * Members:
 *   - `SPREAD_EXCEEDED` — `settle::ESpreadTooWide`. Spread widened past
 *     `max_spread_bps` between prepare and execution.
 *   - `SLIPPAGE_EXCEEDED` — DeepBook
 *     `pool::swap_exact_quantity::EMinimumQuantityOutNotMet`. Pool depth
 *     moved enough that min-out is no longer met.
 */
export const MARKET_VOLATILITY_CARVE_OUT_SUBCODES = [
  'SPREAD_EXCEEDED',
  'SLIPPAGE_EXCEEDED',
] as const;

/**
 * Failure-code + subcode carve-out predicate. The IP counter is unaffected.
 * Benign retry/concurrency subcodes keep their existing cross-family policy;
 * market-volatility subcodes carve out only the exact sponsor preflight code.
 * Accepting the failure code here avoids reconstructing execution stage from
 * a free-form string in `SponsorFailureMeta`.
 */
export function shouldCarveOutNonIpCounter(code: string, meta?: SponsorFailureMeta): boolean {
  const subcode = meta?.subcode;
  if (typeof subcode !== 'string') return false;
  if ((ADDRESS_CARVE_OUT_SUBCODES as readonly string[]).includes(subcode)) return true;
  return (
    code === 'PREFLIGHT_FAILED' &&
    (MARKET_VOLATILITY_CARVE_OUT_SUBCODES as readonly string[]).includes(subcode)
  );
}

// ─────────────────────────────────────────────
// Sponsor-time vault-drift vocabulary
// ─────────────────────────────────────────────

/**
 * Sponsor-time new-user User Vault re-query result pairs emitted via
 * `SPONSOR_DRIFT_OBSERVED`. `VAULT_STATE_INCONSISTENT` is a dual-use
 * literal — it is also a public prepare-time transport error code owned by
 * the current Host wire vocabulary in `@stelis/contracts`. This module owns
 * the sponsor-time drift subcode meaning only.
 */
export const VAULT_DRIFT_NEW_USER_VAULT_EXISTS = {
  stage: 'new_user_vault_exists',
  subcode: 'NEW_USER_VAULT_EXISTS',
} as const;

export const VAULT_DRIFT_QUERY_FAILED = {
  stage: 'new_user_vault_query_failed',
  subcode: 'VAULT_QUERY_FAILED',
} as const;

export const VAULT_DRIFT_STATE_INCONSISTENT = {
  stage: 'new_user_vault_state_inconsistent',
  subcode: 'VAULT_STATE_INCONSISTENT',
} as const;

// ─────────────────────────────────────────────
// SPONSOR_DRIFT_OBSERVED emit
// ─────────────────────────────────────────────

interface SponsorDriftBaseContext {
  /** Phase-stage identifier, e.g. `l1_ptb_structure`, `gas_owner_mismatch`. */
  stage: string;
  /** Original failure subcode propagated for operator triage. */
  subcode: string;
  /** Prepared-entry receiptId; stored-hash-verified, safe to include in logs. */
  receiptId: string;
  /** Tx-derived sender; proven equal to prepare-time commit post-consume. */
  sender: string;
  /** Client IP from the request context. */
  clientIp: string;
}

export type SponsorDriftContext =
  | (SponsorDriftBaseContext & {
      /** `/relay/sponsor` */
      route: 'generic';
    })
  | (SponsorDriftBaseContext & {
      /** `/studio/promotions/:id/sponsor` */
      route: 'promotion';
      /** Required when `route === 'promotion'`. */
      promotionId: string;
    });

/**
 * Emit `SPONSOR_DRIFT_OBSERVED`. Used by both sponsor lifecycles when a
 * post-consume stored-hash-verified drift is observed. Default level is `info`;
 * `L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED` is escalated to `warn` because it indicates
 * operator misconfiguration rather than a transient per-request
 * condition.
 */
export function emitSponsorDriftObserved(ctx: SponsorDriftContext): void {
  const level = ctx.subcode === 'L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED' ? 'warn' : 'info';
  const payload: Record<string, unknown> = {
    stage: ctx.stage,
    subcode: ctx.subcode,
    route: ctx.route,
    receipt_id: ctx.receiptId,
    sender: ctx.sender,
    client_ip: ctx.clientIp,
  };
  if (ctx.route === 'promotion') {
    payload['promotion_id'] = ctx.promotionId;
  }
  logStructuredEvent(SPONSOR_DRIFT_OBSERVED, payload, level);
}
