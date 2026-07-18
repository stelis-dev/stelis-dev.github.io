import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';
import { isNodeTimerDelayMs, NODE_TIMER_MAX_DELAY_MS, type SuiNetwork } from '@stelis/contracts';

const U64_MAX = (1n << 64n) - 1n;
const REFILL_LOCK_SAFETY_MARGIN_MS = 5_000;

export interface SponsorOperationsSettingsInput {
  readonly network: SuiNetwork;
  readonly sponsorAddresses: readonly string[];
  readonly sponsorRefillAccountAddress: string;
  readonly settlementPayoutRecipientAddress: string;
  readonly refillEnabled: boolean;
  readonly refillTargetMist: bigint | null;
  readonly runwayTargetMist: bigint;
  readonly warnMist: bigint;
  readonly slotBalanceTimeoutMs: number;
  readonly sponsorRefillAccountBalanceTimeoutMs: number;
  readonly refillTimeoutMs: number;
  readonly confirmationTimeoutMs: number;
  readonly reconciliationIntervalMs: number;
  readonly withdrawalReceiptTtlMs: number;
}

/**
 * The one normalized settings value shared by SponsorOperations.
 *
 * The object and its ordered sponsor-address list are frozen. MIST values stay
 * as bigint until a storage or transport boundary explicitly serializes them.
 */
export interface SponsorOperationsSettings extends SponsorOperationsSettingsInput {
  readonly sponsorAddresses: readonly string[];
  /** Observation freshness limit derived once from the observation interval. */
  readonly maxObservationAgeMs: number;
  /** Dispatch-lock TTL derived once from the refill timeout. */
  readonly refillLockTtlMs: number;
}

function normalizeAddress(value: string, field: string): string {
  if (typeof value !== 'string' || !isValidSuiAddress(value)) {
    throw new Error(`SponsorOperationsSettings.${field} must be a valid Sui address`);
  }
  return normalizeSuiAddress(value);
}

function requirePositiveMist(value: bigint, field: string): void {
  if (typeof value !== 'bigint' || value <= 0n || value > U64_MAX) {
    throw new Error(`SponsorOperationsSettings.${field} must be positive u64 MIST`);
  }
}

function requirePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`SponsorOperationsSettings.${field} must be a positive safe integer`);
  }
}

function requireNodeTimerDelay(value: number, field: string): void {
  if (!isNodeTimerDelayMs(value)) {
    throw new Error(
      `SponsorOperationsSettings.${field} must be an integer from 1 through ${NODE_TIMER_MAX_DELAY_MS}`,
    );
  }
}

export function createSponsorOperationsSettings(
  input: SponsorOperationsSettingsInput,
): SponsorOperationsSettings {
  if (input.network !== 'testnet' && input.network !== 'mainnet') {
    throw new Error('SponsorOperationsSettings.network must be testnet or mainnet');
  }
  if (!Array.isArray(input.sponsorAddresses) || input.sponsorAddresses.length === 0) {
    throw new Error('SponsorOperationsSettings.sponsorAddresses must not be empty');
  }

  const sponsorAddresses = input.sponsorAddresses.map((address, index) =>
    normalizeAddress(address, `sponsorAddresses[${index}]`),
  );
  if (new Set(sponsorAddresses).size !== sponsorAddresses.length) {
    throw new Error('SponsorOperationsSettings.sponsorAddresses must be unique');
  }

  const sponsorRefillAccountAddress = normalizeAddress(
    input.sponsorRefillAccountAddress,
    'sponsorRefillAccountAddress',
  );
  if (sponsorAddresses.includes(sponsorRefillAccountAddress)) {
    throw new Error(
      'SponsorOperationsSettings.sponsorRefillAccountAddress must differ from every sponsor address',
    );
  }
  const settlementPayoutRecipientAddress = normalizeAddress(
    input.settlementPayoutRecipientAddress,
    'settlementPayoutRecipientAddress',
  );

  if (typeof input.refillEnabled !== 'boolean') {
    throw new Error('SponsorOperationsSettings.refillEnabled must be boolean');
  }
  requirePositiveMist(input.warnMist, 'warnMist');
  requirePositiveMist(input.runwayTargetMist, 'runwayTargetMist');
  if (input.runwayTargetMist * BigInt(sponsorAddresses.length) > U64_MAX) {
    throw new Error(
      'SponsorOperationsSettings.runwayTargetMist multiplied by sponsor address count must fit u64',
    );
  }
  if (input.refillTargetMist !== null) {
    requirePositiveMist(input.refillTargetMist, 'refillTargetMist');
    if (input.refillTargetMist <= input.warnMist) {
      throw new Error('SponsorOperationsSettings.refillTargetMist must be greater than warnMist');
    }
  } else if (input.refillEnabled) {
    throw new Error(
      'SponsorOperationsSettings.refillTargetMist is required when refillEnabled is true',
    );
  }
  requireNodeTimerDelay(input.slotBalanceTimeoutMs, 'slotBalanceTimeoutMs');
  requireNodeTimerDelay(
    input.sponsorRefillAccountBalanceTimeoutMs,
    'sponsorRefillAccountBalanceTimeoutMs',
  );
  requireNodeTimerDelay(input.refillTimeoutMs, 'refillTimeoutMs');
  requireNodeTimerDelay(input.confirmationTimeoutMs, 'confirmationTimeoutMs');
  requireNodeTimerDelay(input.reconciliationIntervalMs, 'reconciliationIntervalMs');
  if (
    input.slotBalanceTimeoutMs > input.reconciliationIntervalMs ||
    input.sponsorRefillAccountBalanceTimeoutMs > input.reconciliationIntervalMs
  ) {
    throw new Error(
      'SponsorOperationsSettings balance timeouts must not exceed reconciliationIntervalMs',
    );
  }
  const maxObservationAgeMs = input.reconciliationIntervalMs * 2;
  if (!Number.isSafeInteger(maxObservationAgeMs)) {
    throw new Error('SponsorOperationsSettings freshness calculation exceeds safe integer range');
  }
  const refillLockTtlMs = input.refillTimeoutMs + REFILL_LOCK_SAFETY_MARGIN_MS;
  if (!Number.isSafeInteger(refillLockTtlMs)) {
    throw new Error('SponsorOperationsSettings refill lock TTL exceeds safe integer range');
  }
  requirePositiveSafeInteger(input.withdrawalReceiptTtlMs, 'withdrawalReceiptTtlMs');

  const frozenSponsorAddresses = Object.freeze([...sponsorAddresses]);
  return Object.freeze({
    network: input.network,
    sponsorAddresses: frozenSponsorAddresses,
    sponsorRefillAccountAddress,
    settlementPayoutRecipientAddress,
    refillEnabled: input.refillEnabled,
    refillTargetMist: input.refillTargetMist,
    runwayTargetMist: input.runwayTargetMist,
    warnMist: input.warnMist,
    slotBalanceTimeoutMs: input.slotBalanceTimeoutMs,
    sponsorRefillAccountBalanceTimeoutMs: input.sponsorRefillAccountBalanceTimeoutMs,
    refillTimeoutMs: input.refillTimeoutMs,
    confirmationTimeoutMs: input.confirmationTimeoutMs,
    reconciliationIntervalMs: input.reconciliationIntervalMs,
    withdrawalReceiptTtlMs: input.withdrawalReceiptTtlMs,
    maxObservationAgeMs,
    refillLockTtlMs,
  });
}
