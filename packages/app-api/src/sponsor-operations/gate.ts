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
 * Boot seeds the shared state before HTTP listen. Redis-time freshness is a
 * required part of every availability decision.
 */

import {
  calculateSponsorAvailabilityErrorCode,
  type SponsorAvailabilityErrorCode,
  type SponsorSlotLeaseSummary,
} from '@stelis/contracts';
import type {
  SponsorRefillAccountAvailabilityRecord,
  SponsorSlotAvailabilityRecord,
} from './redisState.js';
import type { SponsorOperationsSettings } from './settings.js';
import { calculateSponsorOperationsStatus } from './status.js';

export type SponsorAvailabilityDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly errorCode: SponsorAvailabilityErrorCode };

export interface SponsorAvailabilityView {
  readonly settings: SponsorOperationsSettings;
  readonly slots: readonly SponsorSlotAvailabilityRecord[];
  readonly sponsorRefillAccount: SponsorRefillAccountAvailabilityRecord;
}

export interface CalculatedSponsorAvailability {
  readonly slots: readonly SponsorSlotAvailabilityRecord[];
  readonly sponsorRefillAccount: SponsorRefillAccountAvailabilityRecord;
  readonly healthySlots: number;
  readonly degradedSlots: number;
  readonly gateErrorCode: SponsorAvailabilityErrorCode | null;
}

function calculateCurrentSponsorSlotStatus(
  settings: SponsorOperationsSettings,
  slot: SponsorSlotAvailabilityRecord,
) {
  return calculateSponsorOperationsStatus({
    entity: 'sponsor_slot',
    settings,
    observation:
      slot.observationFresh && slot.addressBalanceMist !== null
        ? { status: 'succeeded', addressBalanceMist: BigInt(slot.addressBalanceMist) }
        : { status: 'failed' },
    refillOperationState: slot.refillOperationState,
  });
}

/** Derive availability for one exact sponsor-address observation. */
export function isSponsorSlotAvailable(
  settings: SponsorOperationsSettings,
  slot: SponsorSlotAvailabilityRecord,
): boolean {
  return calculateCurrentSponsorSlotStatus(settings, slot).available;
}

function calculateCurrentSponsorRefillAccountStatus(view: SponsorAvailabilityView) {
  const account = view.sponsorRefillAccount;
  return calculateSponsorOperationsStatus({
    entity: 'sponsor_refill_account',
    settings: view.settings,
    observation:
      account.observationFresh && account.totalBalanceMist !== null
        ? { status: 'succeeded', totalBalanceMist: BigInt(account.totalBalanceMist) }
        : { status: 'failed' },
  });
}

/**
 * Calculate the one current availability view used by prepare admission and
 * the Admin response. Stored balance observations do not carry current health:
 * Redis-time freshness and the current lease snapshot are applied here.
 *
 * Boot completes the initial observations before HTTP listen. Missing or
 * malformed current records are storage errors rather than alternate health
 * states.
 */
export function calculateSponsorAvailability(
  view: SponsorAvailabilityView,
  slotLeases: SponsorSlotLeaseSummary,
): CalculatedSponsorAvailability {
  const slots = view.slots.map(
    (slot): SponsorSlotAvailabilityRecord => ({
      ...slot,
      state: calculateCurrentSponsorSlotStatus(view.settings, slot).state,
    }),
  );
  const sponsorRefillAccount = {
    ...view.sponsorRefillAccount,
    healthy: calculateCurrentSponsorRefillAccountStatus(view).healthy,
  };
  const healthySlots = slots.filter((slot) => slot.state === 'healthy').length;
  const degradedSlots = slots.length - healthySlots;
  const leaseByAddress = new Map(slotLeases.slots.map((slot) => [slot.address, slot.leased]));
  const hasFreeHealthySponsorSlot = slots.some(
    (slot) => slot.state === 'healthy' && leaseByAddress.get(slot.address) === false,
  );
  const gateErrorCode = calculateSponsorAvailabilityErrorCode({
    healthySlots,
    hasFreeHealthySponsorSlot,
    sponsorRefillAccountHealthy: sponsorRefillAccount.healthy,
  });
  return {
    slots,
    sponsorRefillAccount,
    healthySlots,
    degradedSlots,
    gateErrorCode,
  };
}

/**
 * Request-path gate decision. Derived purely from the state view; no
 * I/O, no clock. An unhealthy sponsor refill account with at least one healthy slot is
 * intentionally admitted — sponsor refill account health remains an admin-only signal in
 * that state. This aggregate gate is prepare-only and requires a current lease
 * snapshot so a fully leased sponsor-address set is rejected before expensive
 * transaction construction. Sponsor routes use the exact sponsor address bound
 * to their receipt instead of this aggregate decision.
 */
export function evaluateSponsorAvailability(
  view: SponsorAvailabilityView,
  slotLeases: SponsorSlotLeaseSummary,
): SponsorAvailabilityDecision {
  const { gateErrorCode } = calculateSponsorAvailability(view, slotLeases);
  return gateErrorCode === null ? { allowed: true } : { allowed: false, errorCode: gateErrorCode };
}
