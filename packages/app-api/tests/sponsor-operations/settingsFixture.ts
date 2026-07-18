import {
  createSponsorOperationsSettings,
  type SponsorOperationsSettings,
  type SponsorOperationsSettingsInput,
} from '../../src/sponsor-operations/settings.js';

const ADDRESS_1 = `0x${'1'.padStart(64, '0')}`;
const ADDRESS_2 = `0x${'2'.padStart(64, '0')}`;
const ADDRESS_3 = `0x${'3'.padStart(64, '0')}`;

export function createTestSponsorOperationsSettings(
  overrides: Partial<SponsorOperationsSettingsInput> = {},
): SponsorOperationsSettings {
  return createSponsorOperationsSettings({
    network: 'testnet',
    sponsorAddresses: [ADDRESS_1],
    sponsorRefillAccountAddress: ADDRESS_2,
    settlementPayoutRecipientAddress: ADDRESS_3,
    refillEnabled: true,
    refillTargetMist: 1_000n,
    runwayTargetMist: 1_000n,
    warnMist: 100n,
    slotBalanceTimeoutMs: 5_000,
    sponsorRefillAccountBalanceTimeoutMs: 5_000,
    refillTimeoutMs: 30_000,
    confirmationTimeoutMs: 15_000,
    reconciliationIntervalMs: 10_000,
    withdrawalReceiptTtlMs: 60_000,
    ...overrides,
  });
}
