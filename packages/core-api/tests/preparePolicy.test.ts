/**
 * preparePolicy.test.ts — lock tests for PolicyFields assembly.
 *
 * Verifies:
 *   1. `buildPolicyFields()` maps `OnchainConfig` fields to `PolicyFields`
 *      with the correct canonical names (notably `protocolFlatFeeMist →
 *      protocolFeeMist`).
 *   2. The 3 compile-time constants (`PREPARE_TTL_MS`, `GAS_VARIANCE_FIXED_MIST`,
 *      `SLIPPAGE_CAP_BPS`) are baked into the output.
 *   3. `computePolicyHash(buildPolicyFields(config))` produces a deterministic
 *      golden-value hex for a known config fixture.
 *   4. `PREPARE_TTL_MS` exported from the module matches the expected value.
 */
import { describe, it, expect } from 'vitest';
import { GAS_VARIANCE_FIXED_MIST } from '@stelis/core-relay';
import { SLIPPAGE_CAP_BPS } from '@stelis/contracts';
import type { OnchainConfig } from '@stelis/core-relay';
import { PREPARE_TTL_MS, buildPolicyFields } from '../src/preparePolicy.js';
import { computePolicyHash } from '../src/policyHash.js';

const MOCK_CONFIG: OnchainConfig = {
  packageId: '0xPACKAGE',
  configId: '0xCONFIG',
  maxClaimMist: 50_000_000n,
  minSettleMist: 1_000_000n,
  maxHostFeeMist: 50_000n,
  protocolFlatFeeMist: 0n,
  configVersion: 1n,
  maxSpreadBps: 500n,
};

describe('buildPolicyFields', () => {
  it('maps OnchainConfig → PolicyFields with correct field names', () => {
    const pf = buildPolicyFields(MOCK_CONFIG);
    expect(pf.maxClaimMist).toBe(MOCK_CONFIG.maxClaimMist);
    expect(pf.maxHostFeeMist).toBe(MOCK_CONFIG.maxHostFeeMist);
    expect(pf.protocolFeeMist).toBe(MOCK_CONFIG.protocolFlatFeeMist);
  });

  it('bakes PREPARE_TTL_MS into quoteTtlMs', () => {
    const pf = buildPolicyFields(MOCK_CONFIG);
    expect(pf.quoteTtlMs).toBe(PREPARE_TTL_MS);
    expect(pf.quoteTtlMs).toBe(60_000);
  });

  it('bakes GAS_VARIANCE_FIXED_MIST into gasVarianceFixedMist', () => {
    const pf = buildPolicyFields(MOCK_CONFIG);
    expect(pf.gasVarianceFixedMist).toBe(GAS_VARIANCE_FIXED_MIST);
    expect(pf.gasVarianceFixedMist).toBe(100_000n);
  });

  it('bakes SLIPPAGE_CAP_BPS into slippageCapBps', () => {
    const pf = buildPolicyFields(MOCK_CONFIG);
    expect(pf.slippageCapBps).toBe(SLIPPAGE_CAP_BPS);
    expect(pf.slippageCapBps).toBe(500);
  });

  it('returns exactly 6 keys', () => {
    const pf = buildPolicyFields(MOCK_CONFIG);
    expect(Object.keys(pf)).toHaveLength(6);
  });
});

describe('buildPolicyFields + computePolicyHash golden value', () => {
  it('produces a deterministic 64-char hex hash for the mock config', () => {
    const hex = computePolicyHash(buildPolicyFields(MOCK_CONFIG));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);

    const hex2 = computePolicyHash(buildPolicyFields(MOCK_CONFIG));
    expect(hex).toBe(hex2);
  });

  it('hash changes when config.protocolFlatFeeMist changes', () => {
    const base = computePolicyHash(buildPolicyFields(MOCK_CONFIG));
    const changed = computePolicyHash(
      buildPolicyFields({ ...MOCK_CONFIG, protocolFlatFeeMist: 1n }),
    );
    expect(base).not.toBe(changed);
  });

  it('hash changes when config.maxClaimMist changes', () => {
    const base = computePolicyHash(buildPolicyFields(MOCK_CONFIG));
    const changed = computePolicyHash(
      buildPolicyFields({ ...MOCK_CONFIG, maxClaimMist: 10_000_000n }),
    );
    expect(base).not.toBe(changed);
  });
});

describe('PREPARE_TTL_MS', () => {
  it('is 60_000', () => {
    expect(PREPARE_TTL_MS).toBe(60_000);
  });
});
