import { describe, it, expect } from 'vitest';
import { requireContractId, STELIS_CONTRACT_IDS, DEEPBOOK_IDS } from '@stelis/contracts';

describe('requireContractId', () => {
  it('returns constant when present', () => {
    expect(requireContractId('0xBBB', 'TEST')).toBe('0xBBB');
  });

  it('throws when constant is undefined', () => {
    expect(() => requireContractId(undefined, 'SOME_ID')).toThrow(
      'SOME_ID: not configured in @stelis/contracts constants',
    );
  });

  it('throws when constant is empty string', () => {
    expect(() => requireContractId('', 'SOME_ID')).toThrow(
      'SOME_ID: not configured in @stelis/contracts constants',
    );
  });
});

describe('STELIS_CONTRACT_IDS', () => {
  it('testnet has all required fields', () => {
    const ids = STELIS_CONTRACT_IDS.testnet;
    expect(ids).not.toBeNull();
    if (!ids) throw new Error('testnet Stelis contract IDs must be configured');
    expect(ids.packageId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ids.configId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ids.vaultRegistryId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('mainnet package IDs are null in the current constants', () => {
    expect(STELIS_CONTRACT_IDS.mainnet).toBeNull();
  });
});

describe('DEEPBOOK_IDS', () => {
  it('testnet has all required fields', () => {
    const ids = DEEPBOOK_IDS.testnet;
    expect(ids).not.toBeNull();
    if (!ids) throw new Error('testnet DeepBook IDs must be configured');
    expect(ids.packageId).toMatch(/^0x/);
    expect(ids.deepType).toContain('::deep::DEEP');
  });

  it('mainnet has all required fields (DeepBook is a public protocol deployed on mainnet)', () => {
    const ids = DEEPBOOK_IDS.mainnet;
    expect(ids).not.toBeNull();
    if (!ids) throw new Error('mainnet DeepBook IDs must be configured');
    expect(ids.packageId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ids.deepType).toContain('::deep::DEEP');
  });
});
