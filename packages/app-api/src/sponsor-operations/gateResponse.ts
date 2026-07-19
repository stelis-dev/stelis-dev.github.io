/**
 * [app-api] Sponsor operations 503 response builder.
 *
 * Thin adapter over `evaluateSponsorAvailability`. Returns the current code +
 * headers when the gate denies, or `null` when the gate admits
 * the request. Prepare routes pass a lease snapshot to require one free
 * healthy sponsor address. Sponsor routes use their receipt-bound address and
 * do not call this aggregate gate.
 *
 * The only sponsor operations gate error codes are:
 *   - `SPONSOR_CAPACITY_UNAVAILABLE`            — no healthy slot, or no free healthy slot for prepare admission
 *   - `SPONSOR_REFILL_ACCOUNT_UNHEALTHY` — `healthySlots === 0` with sponsor refill account unhealthy
 */

import type { SponsorAvailabilityErrorCode, SponsorSlotLeaseSummary } from '@stelis/contracts';
import { evaluateSponsorAvailability, type SponsorAvailabilityView } from './gate.js';

export interface SponsorOperationsBlockedResponse {
  readonly errorCode: SponsorAvailabilityErrorCode;
  readonly headers: Record<string, string>;
}

export function buildSponsorUnavailableResponse(
  view: SponsorAvailabilityView,
  slotLeases: SponsorSlotLeaseSummary,
): SponsorOperationsBlockedResponse | null {
  const decision = evaluateSponsorAvailability(view, slotLeases);
  if (decision.allowed) return null;
  return {
    errorCode: decision.errorCode,
    headers: {},
  };
}
