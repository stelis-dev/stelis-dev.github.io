import { describe, expect, it } from 'vitest';
import { canonicalizeAddress, validateAddressConstraints } from '../src/addressConstraints.js';

const ADDR_A = '0x' + 'a'.repeat(64);
const ADDR_B = '0x' + 'b'.repeat(64);
const ADDR_C = '0x' + 'c'.repeat(64);
const ADDR_R = '0x' + '0'.repeat(62) + '01'; // TEST_RECIPIENT

describe('canonicalizeAddress', () => {
  it('normalizes a short address to canonical 66-char form', () => {
    const result = canonicalizeAddress('0x1', 'test');
    expect(result).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result).toBe('0x0000000000000000000000000000000000000000000000000000000000000001');
  });

  it('rejects non-hex garbage', () => {
    expect(() => canonicalizeAddress('not-an-address', 'test')).toThrow();
  });
});

describe('validateAddressConstraints', () => {
  it('passes when all constraints satisfied', () => {
    expect(() =>
      validateAddressConstraints({
        sponsorAddresses: [ADDR_A, ADDR_B],
        settlementPayoutRecipientAddress: ADDR_R,
        sponsorRefillAccountAddress: ADDR_C,
      }),
    ).not.toThrow();
  });

  it('[1] throws on duplicate sponsor addresses', () => {
    expect(() =>
      validateAddressConstraints({
        sponsorAddresses: [ADDR_A, ADDR_A],
        settlementPayoutRecipientAddress: ADDR_R,
      }),
    ).toThrow(/Duplicate sponsor address/);
  });

  it('[2] throws when sponsor == settlementPayoutRecipient', () => {
    expect(() =>
      validateAddressConstraints({
        sponsorAddresses: [ADDR_R],
        settlementPayoutRecipientAddress: ADDR_R,
      }),
    ).toThrow(/must not equal SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS/);
  });

  it('[3] throws when sponsor == sponsorRefillAccount (explicit)', () => {
    expect(() =>
      validateAddressConstraints({
        sponsorAddresses: [ADDR_A],
        settlementPayoutRecipientAddress: ADDR_R,
        sponsorRefillAccountAddress: ADDR_A,
      }),
    ).toThrow(/must not equal sponsor refill account/);
  });

  it('[3] skipped when sponsorRefillAccountAddress is undefined', () => {
    expect(() =>
      validateAddressConstraints({
        sponsorAddresses: [ADDR_A],
        settlementPayoutRecipientAddress: ADDR_R,
        sponsorRefillAccountAddress: undefined,
      }),
    ).not.toThrow();
  });

  it('[4] sponsorRefillAccount == settlementPayoutRecipient is allowed', () => {
    expect(() =>
      validateAddressConstraints({
        sponsorAddresses: [ADDR_A],
        settlementPayoutRecipientAddress: ADDR_R,
        sponsorRefillAccountAddress: ADDR_R, // same as recipient — OK
      }),
    ).not.toThrow();
  });
});
