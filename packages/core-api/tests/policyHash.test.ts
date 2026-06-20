/**
 * policyHash — golden tests for the server-only S-16 policy hash.
 *
 * The helper is the Host's single owner of the hash; SDK consumers never
 * compute it.
 */
import { describe, it, expect } from 'vitest';
import { computePolicyHash } from '../src/policyHash.js';
import type { PolicyFields } from '../src/policyHash.js';

const BASE: PolicyFields = {
  maxClaimMist: 50_000_000n,
  maxHostFeeMist: 50_000n,
  protocolFeeMist: 0n,
  quoteTtlMs: 60_000,
  gasVarianceFixedMist: 100_000n,
  slippageCapBps: 500,
};

describe('computePolicyHash', () => {
  it('returns a 64-char hex string', () => {
    const hash = computePolicyHash(BASE);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input always yields same hash', () => {
    expect(computePolicyHash(BASE)).toBe(computePolicyHash(BASE));
  });

  it('changes when any field changes — maxClaimMist', () => {
    const h1 = computePolicyHash(BASE);
    const h2 = computePolicyHash({ ...BASE, maxClaimMist: 10_000_000n });
    expect(h1).not.toBe(h2);
  });

  it('changes when any field changes — maxHostFeeMist', () => {
    expect(computePolicyHash(BASE)).not.toBe(
      computePolicyHash({ ...BASE, maxHostFeeMist: 100_000n }),
    );
  });

  it('changes when any field changes — protocolFeeMist', () => {
    expect(computePolicyHash(BASE)).not.toBe(computePolicyHash({ ...BASE, protocolFeeMist: 1n }));
  });

  it('changes when any field changes — quoteTtlMs', () => {
    expect(computePolicyHash(BASE)).not.toBe(computePolicyHash({ ...BASE, quoteTtlMs: 120_000 }));
  });

  it('changes when gasVarianceFixedMist changes', () => {
    expect(computePolicyHash(BASE)).not.toBe(
      computePolicyHash({ ...BASE, gasVarianceFixedMist: 200_000n }),
    );
  });

  it('changes when slippageCapBps changes', () => {
    expect(computePolicyHash(BASE)).not.toBe(computePolicyHash({ ...BASE, slippageCapBps: 1000 }));
  });

  // ── Key-insertion-order independence ───────────────────────────────────────

  it('key insertion order does not affect hash (explicit sort guarantee)', () => {
    const fieldsA: PolicyFields = {
      maxClaimMist: 50_000_000n,
      maxHostFeeMist: 50_000n,
      protocolFeeMist: 0n,
      quoteTtlMs: 60_000,
      gasVarianceFixedMist: 100_000n,
      slippageCapBps: 500,
    };
    const fieldsB: PolicyFields = {
      slippageCapBps: 500,
      gasVarianceFixedMist: 100_000n,
      quoteTtlMs: 60_000,
      protocolFeeMist: 0n,
      maxHostFeeMist: 50_000n,
      maxClaimMist: 50_000_000n,
    };
    expect(computePolicyHash(fieldsA)).toBe(computePolicyHash(fieldsB));
  });

  // ── Zero / boundary values ────────────────────────────────────────────────

  it('all-zero fields produce a stable hash', () => {
    const zero: PolicyFields = {
      maxClaimMist: 0n,
      maxHostFeeMist: 0n,
      protocolFeeMist: 0n,
      quoteTtlMs: 0,
      gasVarianceFixedMist: 0n,
      slippageCapBps: 0,
    };
    const hash = computePolicyHash(zero);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(computePolicyHash(zero));
    expect(hash).not.toBe(computePolicyHash(BASE));
  });
});
