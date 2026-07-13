/**
 * [app-api] Sponsor operations request gate — pure-derivation layer.
 *
 * Shared gate-decision rules. The gate is a pure
 * function over the Redis-shared state view (see `redisState.ts`). Route
 * handlers read the state via `RedisSponsorOperationsState.readAll()` (or equivalent)
 * and hand the resulting view to `evaluateSponsorAvailability`.
 *
 * Gate error codes:
 *   - `SPONSOR_CAPACITY_UNAVAILABLE`              — every slot is non-healthy, or
 *     prepare admission requires a free sponsor slot and every healthy slot is leased.
 *   - `SPONSOR_REFILL_ACCOUNT_UNHEALTHY`   — every slot non-healthy AND
 *     the sponsor refill account's last observation flagged unhealthy.
 * Boot seeds the shared state before HTTP listen, and per-entity
 * `lastObservedAtMs` remains informational only.
 */

import type { SponsorAvailabilityErrorCode, SponsorSlotLeaseSummary } from '@stelis/contracts';
import type { SponsorRefillAccountRead, SlotRead } from './redisState.js';

export type SponsorAvailabilityDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly errorCode: SponsorAvailabilityErrorCode };

export interface SponsorAvailabilityView {
  readonly slots: readonly SlotRead[];
  readonly sponsorRefillAccount: SponsorRefillAccountRead;
}

export interface SponsorAvailabilitySummary {
  readonly availableSlots: number;
  readonly degradedSlots: number;
  readonly gateErrorCode: SponsorAvailabilityErrorCode | null;
}

export interface SponsorAvailabilityOptions {
  readonly requireFreeSponsorSlot?: boolean;
  readonly slotLeases?: SponsorSlotLeaseSummary;
}

function isHealthySlot(slot: SlotRead): boolean {
  const activeRefill =
    slot.refillOperationState === 'reserved' ||
    slot.refillOperationState === 'ready' ||
    slot.refillOperationState === 'reconciling';
  return slot.state === 'healthy' && !activeRefill;
}

/**
 * Derive the gate error code from a state view. Rules, in order:
 *   1. `availableSlots > 0`                                 → `null` (admitted).
 *   2. `availableSlots === 0 && sponsorRefillAccount.healthy === false`
 *                                                           → `SPONSOR_REFILL_ACCOUNT_UNHEALTHY`.
 *   3. `availableSlots === 0` otherwise                     → `SPONSOR_CAPACITY_UNAVAILABLE`.
 *
 * `sponsorRefillAccount.healthy === null` (bootstrap not yet completed for the sponsor refill account)
 * does NOT count as `false` here, because boot blocks HTTP listen until
 * bootstrap has written the sponsor refill account HASH. Treat `null` as "no signal yet"
 * and fall through to the plain-unavailable case if no slots are
 * healthy; that path is only reachable if state is intentionally reset
 * mid-runtime, which is operator-induced.
 */
export function deriveSponsorAvailabilitySummary(
  view: SponsorAvailabilityView,
): SponsorAvailabilitySummary {
  let availableSlots = 0;
  let degradedSlots = 0;
  for (const slot of view.slots) {
    if (isHealthySlot(slot)) {
      availableSlots += 1;
    } else {
      degradedSlots += 1;
    }
  }
  let gateErrorCode: SponsorAvailabilityErrorCode | null = null;
  if (availableSlots === 0) {
    gateErrorCode =
      view.sponsorRefillAccount.healthy === false
        ? 'SPONSOR_REFILL_ACCOUNT_UNHEALTHY'
        : 'SPONSOR_CAPACITY_UNAVAILABLE';
  }
  return { availableSlots, degradedSlots, gateErrorCode };
}

function hasFreeHealthySponsorSlot(
  view: SponsorAvailabilityView,
  slotLeases: SponsorSlotLeaseSummary | undefined,
): boolean {
  if (!slotLeases) return false;
  const leaseByAddress = new Map(slotLeases.slots.map((slot) => [slot.address, slot.leased]));
  return view.slots.some(
    (slot) => isHealthySlot(slot) && leaseByAddress.get(slot.address) === false,
  );
}

/**
 * Request-path gate decision. Derived purely from the state view; no
 * I/O, no clock. An unhealthy sponsor refill account with at least one healthy slot is
 * intentionally admitted — sponsor refill account health remains an admin-only signal in
 * that state. Prepare routes also pass `requireFreeSponsorSlot` with a
 * current lease snapshot so a fully leased sponsor slot pool is rejected
 * before expensive prepare build work. Sponsor routes do not require a
 * free slot because they complete an existing leased prepare receipt.
 */
export function evaluateSponsorAvailability(
  view: SponsorAvailabilityView,
  options: SponsorAvailabilityOptions = {},
): SponsorAvailabilityDecision {
  const { gateErrorCode } = deriveSponsorAvailabilitySummary(view);
  if (gateErrorCode !== null) return { allowed: false, errorCode: gateErrorCode };
  if (
    options.requireFreeSponsorSlot === true &&
    !hasFreeHealthySponsorSlot(view, options.slotLeases)
  ) {
    return { allowed: false, errorCode: 'SPONSOR_CAPACITY_UNAVAILABLE' };
  }
  return { allowed: true };
}
