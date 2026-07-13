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
 * Runtime state of a single sponsor slot as persisted in the shared
 * sponsor operations Redis state store.
 *
 * `null` represents the pre-write bootstrap/reset state at the admin
 * payload boundary; the request gate never sees `null` because boot
 * blocks HTTP listen until `bootstrapSponsorOperations()` has written every
 * slot HASH.
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
 * codes tracked in docs/schemas/relay-api.schema.json.
 *
 * `SPONSOR_REFILL_ACCOUNT_UNHEALTHY` is emitted only when no sponsor slot is
 * healthy and the sponsor refill account is unhealthy. Prepare admission can
 * also emit `SPONSOR_CAPACITY_UNAVAILABLE` when healthy slots exist but every
 * healthy slot is currently leased.
 */
export type SponsorAvailabilityErrorCode =
  | 'SPONSOR_CAPACITY_UNAVAILABLE'
  | 'SPONSOR_REFILL_ACCOUNT_UNHEALTHY';

// ─────────────────────────────────────────────
// Admin-facing sponsor operations payload
// ─────────────────────────────────────────────

export interface SponsorSlotStatus {
  readonly address: string;
  /**
   * `null` when the slot HASH is absent before bootstrap writes land or
   * after an intentional state reset. In normal runtime the request
   * gate never observes `null` because HTTP listen begins only after
   * bootstrap writes finish.
   */
  readonly state: SponsorSlotState | null;
  readonly balanceMist: string | null;
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
  readonly balanceMist: string | null;
  readonly healthy: boolean;
  readonly refillsRemaining: number | null;
  readonly lastObservedAtMs: number | null;
  readonly lastError: string | null;
}

/**
 * Composite sponsor operations payload returned by `/api/sponsor-operations` as the
 * `sponsorOperations` field. The route does a bounded sponsor refill account probe and reads the
 * shared state on every request, so the payload has no empty bootstrap
 * sentinel.
 */
export interface SponsorOperationsStatus {
  readonly gateErrorCode: SponsorAvailabilityErrorCode | null;
  readonly availableSlots: number;
  readonly degradedSlots: number;
  readonly slotLeases: SponsorSlotLeaseSummary;
  readonly slots: readonly SponsorSlotStatus[];
  readonly sponsorRefillAccount: SponsorRefillAccountStatus;
}
