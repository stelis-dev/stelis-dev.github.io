/**
 * [app-api] Sponsor operations 503 response builder.
 *
 * Thin adapter over `evaluateSponsorAvailability`. Returns the coded body +
 * headers when the gate denies, or `null` when the gate admits
 * the request. Prepare routes pass a lease snapshot to require one free
 * healthy sponsor slot; sponsor routes do not, because they complete an
 * existing leased prepare receipt.
 *
 * The only sponsor operations gate error codes are:
 *   - `SPONSOR_CAPACITY_UNAVAILABLE`            — no healthy slot, or no free healthy slot for prepare admission
 *   - `SPONSOR_REFILL_ACCOUNT_UNHEALTHY` — `availableSlots === 0` with sponsor refill account unhealthy
 */

import type { HostErrorResponse, SponsorAvailabilityErrorCode } from '@stelis/contracts';
import {
  evaluateSponsorAvailability,
  type SponsorAvailabilityOptions,
  type SponsorAvailabilityView,
} from './gate.js';

const ERROR_MESSAGES: Record<SponsorAvailabilityErrorCode, string> = {
  SPONSOR_CAPACITY_UNAVAILABLE: 'No sponsor slots currently available',
  SPONSOR_REFILL_ACCOUNT_UNHEALTHY:
    'Sponsor refill account is unhealthy and no healthy sponsor slot remains',
};

export interface SponsorOperationsBlockedResponse {
  readonly body: HostErrorResponse & { readonly code: SponsorAvailabilityErrorCode };
  readonly headers: Record<string, string>;
}

export function buildSponsorUnavailableResponse(
  view: SponsorAvailabilityView,
  options: SponsorAvailabilityOptions = {},
): SponsorOperationsBlockedResponse | null {
  const decision = evaluateSponsorAvailability(view, options);
  if (decision.allowed) return null;
  return {
    body: {
      error: ERROR_MESSAGES[decision.errorCode],
      code: decision.errorCode,
    },
    headers: {},
  };
}
