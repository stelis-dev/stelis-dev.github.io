import { describe, expect, it } from 'vitest';
import { NODE_TIMER_MAX_DELAY_MS } from '@stelis/contracts';
import {
  createSponsorOperationsSettings,
  type SponsorOperationsSettingsInput,
} from '../../src/sponsor-operations/settings.js';

const SPONSOR = `0x${'11'.repeat(32)}`;
const REFILL_ACCOUNT = `0x${'22'.repeat(32)}`;
const PAYOUT = `0x${'33'.repeat(32)}`;

function input(
  overrides: Partial<SponsorOperationsSettingsInput> = {},
): SponsorOperationsSettingsInput {
  return {
    network: 'testnet',
    sponsorAddresses: [SPONSOR],
    sponsorRefillAccountAddress: REFILL_ACCOUNT,
    settlementPayoutRecipientAddress: PAYOUT,
    refillEnabled: true,
    refillTargetMist: 1_000n,
    runwayTargetMist: 1_000n,
    warnMist: 100n,
    slotBalanceTimeoutMs: 5_000,
    sponsorRefillAccountBalanceTimeoutMs: 5_000,
    refillTimeoutMs: 30_000,
    confirmationTimeoutMs: 15_000,
    reconciliationIntervalMs: 15_000,
    withdrawalReceiptTtlMs: 60_000,
    ...overrides,
  };
}

describe('SponsorOperations settings', () => {
  it('owns every timeout and derives freshness and dispatch-lock TTL once', () => {
    const settings = createSponsorOperationsSettings(input());

    expect(settings).toMatchObject({
      slotBalanceTimeoutMs: 5_000,
      sponsorRefillAccountBalanceTimeoutMs: 5_000,
      refillTimeoutMs: 30_000,
      confirmationTimeoutMs: 15_000,
      reconciliationIntervalMs: 15_000,
      maxObservationAgeMs: 30_000,
      refillLockTtlMs: 35_000,
    });
    expect(Object.isFrozen(settings)).toBe(true);
    expect(Object.isFrozen(settings.sponsorAddresses)).toBe(true);
  });

  it.each([
    'slotBalanceTimeoutMs',
    'sponsorRefillAccountBalanceTimeoutMs',
    'refillTimeoutMs',
    'confirmationTimeoutMs',
    'reconciliationIntervalMs',
  ] as const)('rejects %s outside the shared Node timer range', (field) => {
    expect(() =>
      createSponsorOperationsSettings(input({ [field]: NODE_TIMER_MAX_DELAY_MS + 1 })),
    ).toThrow(String(NODE_TIMER_MAX_DELAY_MS));
  });

  it('requires each balance probe to finish within one observation interval', () => {
    expect(() =>
      createSponsorOperationsSettings(
        input({ slotBalanceTimeoutMs: 15_001, reconciliationIntervalMs: 15_000 }),
      ),
    ).toThrow('balance timeouts must not exceed reconciliationIntervalMs');
    expect(() =>
      createSponsorOperationsSettings(
        input({
          sponsorRefillAccountBalanceTimeoutMs: 15_001,
          reconciliationIntervalMs: 15_000,
        }),
      ),
    ).toThrow('balance timeouts must not exceed reconciliationIntervalMs');
  });
});
