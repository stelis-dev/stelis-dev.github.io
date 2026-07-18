import type { SponsorSlotState } from '@stelis/contracts';
import type { SponsorOperationsSettings } from './settings.js';

export const SPONSOR_REFILL_OPERATION_STATES = [
  'reserved',
  'ready',
  'reconciling',
  'succeeded',
  'failed',
] as const;

export type SponsorRefillOperationState = (typeof SPONSOR_REFILL_OPERATION_STATES)[number];

export const ACTIVE_SPONSOR_REFILL_OPERATION_STATES = [
  'reserved',
  'ready',
  'reconciling',
] as const satisfies readonly SponsorRefillOperationState[];

export function isActiveSponsorRefillOperationState(
  state: SponsorRefillOperationState | null,
): boolean {
  return (
    state !== null &&
    (ACTIVE_SPONSOR_REFILL_OPERATION_STATES as readonly SponsorRefillOperationState[]).includes(
      state,
    )
  );
}

export type SponsorSlotAddressBalanceObservation =
  | { readonly status: 'succeeded'; readonly addressBalanceMist: bigint }
  | { readonly status: 'failed' };

export type SponsorRefillAccountTotalBalanceObservation =
  | { readonly status: 'succeeded'; readonly totalBalanceMist: bigint }
  | { readonly status: 'failed' };

export interface SponsorSlotStatusCalculationInput {
  readonly entity: 'sponsor_slot';
  readonly settings: SponsorOperationsSettings;
  readonly observation: SponsorSlotAddressBalanceObservation;
  readonly refillOperationState: SponsorRefillOperationState | null;
}

export interface SponsorRefillAccountStatusCalculationInput {
  readonly entity: 'sponsor_refill_account';
  readonly settings: SponsorOperationsSettings;
  readonly observation: SponsorRefillAccountTotalBalanceObservation;
}

export type SponsorOperationsStatusCalculationInput =
  | SponsorSlotStatusCalculationInput
  | SponsorRefillAccountStatusCalculationInput;

export interface SponsorSlotStatusCalculation {
  readonly entity: 'sponsor_slot';
  readonly state: SponsorSlotState;
  readonly available: boolean;
}

export interface SponsorRefillAccountStatusCalculation {
  readonly entity: 'sponsor_refill_account';
  readonly healthy: boolean;
}

export type SponsorOperationsStatusCalculation =
  | SponsorSlotStatusCalculation
  | SponsorRefillAccountStatusCalculation;

/**
 * The sole SponsorOperations status calculation.
 *
 * Callers provide a successful balance observation or an explicit failed
 * observation. The availability gate converts a stale stored observation into
 * a failed observation before calling this function.
 */
export function calculateSponsorOperationsStatus(
  input: SponsorSlotStatusCalculationInput,
): SponsorSlotStatusCalculation;
export function calculateSponsorOperationsStatus(
  input: SponsorRefillAccountStatusCalculationInput,
): SponsorRefillAccountStatusCalculation;
export function calculateSponsorOperationsStatus(
  input: SponsorOperationsStatusCalculationInput,
): SponsorOperationsStatusCalculation {
  if (input.entity === 'sponsor_slot') {
    const activeRefill = isActiveSponsorRefillOperationState(input.refillOperationState);
    const state: SponsorSlotState = activeRefill
      ? 'refilling'
      : input.observation.status === 'failed'
        ? 'rpc_unreachable'
        : input.observation.addressBalanceMist >= input.settings.warnMist
          ? 'healthy'
          : input.refillOperationState === 'failed'
            ? 'refill_failed'
            : 'low_balance';
    return { entity: 'sponsor_slot', state, available: state === 'healthy' };
  }

  if (input.observation.status === 'failed') {
    return {
      entity: 'sponsor_refill_account',
      healthy: false,
    };
  }
  return {
    entity: 'sponsor_refill_account',
    healthy: true,
  };
}
