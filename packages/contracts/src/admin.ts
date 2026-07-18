// Admin-facing shared types and helpers used by app-api and app-admin.
//
// Scope policy:
// - cross-package request and response types
// - side-effect-free helpers that must stay byte-identical across the
//   browser/server boundary
// - no host wiring or framework-specific behavior

import type { SuiNetwork } from './types.js';

/**
 * Build the exact signed message for sponsor refill account withdrawal approval.
 *
 * This stays in `@stelis/contracts` because the browser and server must
 * reconstruct identical bytes before wallet signing and server-side
 * signature verification.
 */
export function buildSponsorRefillAccountWithdrawMessage(
  network: SuiNetwork,
  amountMist: string,
  nonce: string,
): string {
  return `sponsor_refill_account_withdraw:${network}:${amountMist}:${nonce}`;
}

const U64_MAX_DECIMAL = '18446744073709551615';

/** Exact positive-u64 decimal contract shared by Sponsor Refill Account spend boundaries. */
export function isPositiveU64DecimalString(value: string): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(value) || value === '0') return false;
  return (
    value.length < U64_MAX_DECIMAL.length ||
    (value.length === U64_MAX_DECIMAL.length && value <= U64_MAX_DECIMAL)
  );
}

// ─────────────────────────────────────────────
// Sponsor operations slot state (runtime-published)
// ─────────────────────────────────────────────

/**
 * Current state of one sponsor address. The Host derives it from the latest
 * balance observation and refill operation; Redis does not store this state.
 *
 * Gate-available state: `healthy`.
 * Gate-degraded states (counted as unavailable by the request gate):
 * `low_balance`, `refilling`, `rpc_unreachable`,
 * `refill_failed`.
 */
export const SPONSOR_SLOT_STATES = [
  'healthy',
  'low_balance',
  'refilling',
  'rpc_unreachable',
  'refill_failed',
] as const;

export type SponsorSlotState = (typeof SPONSOR_SLOT_STATES)[number];

/**
 * Sponsor operations availability gate error code. Emitted by the request gate.
 * HTTP-response enum aligned with the sponsor operations sub-range of the sponsor error
 * codes owned by the Host wire error vocabulary.
 *
 * `SPONSOR_REFILL_ACCOUNT_UNHEALTHY` is emitted only when no sponsor slot is
 * healthy and the sponsor refill account is unhealthy. Prepare admission can
 * also emit `SPONSOR_CAPACITY_UNAVAILABLE` when healthy slots exist but every
 * healthy slot is currently leased.
 */
export type SponsorAvailabilityErrorCode =
  | 'SPONSOR_CAPACITY_UNAVAILABLE'
  | 'SPONSOR_REFILL_ACCOUNT_UNHEALTHY';

/** Calculate the current public and prepare-admission availability code. */
export function calculateSponsorAvailabilityErrorCode(input: {
  readonly healthySlots: number;
  readonly hasFreeHealthySponsorSlot: boolean;
  readonly sponsorRefillAccountHealthy: boolean;
}): SponsorAvailabilityErrorCode | null {
  if (input.hasFreeHealthySponsorSlot) return null;
  return input.healthySlots === 0 && !input.sponsorRefillAccountHealthy
    ? 'SPONSOR_REFILL_ACCOUNT_UNHEALTHY'
    : 'SPONSOR_CAPACITY_UNAVAILABLE';
}

// ─────────────────────────────────────────────
// Admin-facing sponsor operations payload
// ─────────────────────────────────────────────

export interface SponsorSlotStatus {
  readonly address: string;
  readonly state: SponsorSlotState;
  readonly addressBalanceMist: string | null;
  readonly lastObservedAtMs: number | null;
  readonly lastError: string | null;
}

export interface SponsorSlotLeaseStatus {
  readonly address: string;
  readonly leased: boolean;
}

export interface SponsorSlotLeaseSummary {
  readonly leasedSlots: number;
  readonly freeSlots: number;
  readonly slots: readonly SponsorSlotLeaseStatus[];
}

export interface SponsorRefillAccountStatus {
  readonly address: string;
  readonly totalBalanceMist: string | null;
  readonly healthy: boolean;
  readonly lastObservedAtMs: number | null;
  readonly lastError: string | null;
}

/**
 * Composite sponsor operations payload returned by `/api/sponsor-operations` as the
 * `sponsorOperations` field. The route requests one bounded balance observation and reads the
 * shared state on every request, so the payload has no empty bootstrap
 * sentinel.
 */
export interface SponsorOperationsStatus {
  readonly gateErrorCode: SponsorAvailabilityErrorCode | null;
  readonly healthySlots: number;
  readonly degradedSlots: number;
  readonly slotLeases: SponsorSlotLeaseSummary;
  readonly slots: readonly SponsorSlotStatus[];
  readonly sponsorRefillAccount: SponsorRefillAccountStatus;
}
