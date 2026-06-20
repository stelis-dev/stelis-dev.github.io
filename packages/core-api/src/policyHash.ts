/**
 * computePolicyHash — deterministic SHA-256 of relayer policy fields.
 *
 * Server-only owner of the S-16 policy hash. Both `/relay/prepare`
 * (issuance via `session/sponsoredExecution/genericExecutionPolicy.ts`) and
 * `/relay/sponsor` (verification via the same generic SponsoredExecutionPolicy) use this
 * function to ensure the policy embedded in the PTB matches the server's
 * current policy.
 *
 * SDK consumers receive the hash from the `/prepare` response and pass
 * it through to the PTB. They do NOT need to compute it themselves and
 * the helper is intentionally not exposed on `@stelis/core-relay/browser`
 * or `@stelis/core-relay`. The Node `crypto.createHash` dependency is the
 * structural reason; the policy decision is that the relayer is the only
 * API allowed to compute the hash.
 */
import { createHash } from 'crypto';

export interface PolicyFields {
  maxClaimMist: bigint;
  /** On-chain cap for host-quoted fee (max_host_fee_mist). Used in policyHash binding. */
  maxHostFeeMist: bigint;
  protocolFeeMist: bigint;
  quoteTtlMs: number;
  gasVarianceFixedMist: bigint;
  slippageCapBps: number;
}

/**
 * Compute SHA-256 of the canonical JSON representation of policy fields.
 *
 * Canonical form: JSON object with sorted keys, bigint → decimal string.
 * Returns hex string WITHOUT 0x prefix (matches PTB vector<u8> hex encoding).
 *
 * @example
 * computePolicyHash({
 *   maxClaimMist: 50_000_000n,
 *   hostFeeMist: 50_000n,
 *   protocolFeeMist: 0n,
 *   quoteTtlMs: 60_000,
 *   gasVarianceFixedMist: 100_000n,
 *   slippageCapBps: 500,
 * }) // → '3a7f...' (64-char hex)
 */
export function computePolicyHash(fields: PolicyFields): string {
  // Serialize each field as a string (bigint → decimal, number → as-is).
  const raw: Record<string, string | number> = {
    gasVarianceFixedMist: fields.gasVarianceFixedMist.toString(),
    maxClaimMist: fields.maxClaimMist.toString(),
    maxHostFeeMist: fields.maxHostFeeMist.toString(),
    protocolFeeMist: fields.protocolFeeMist.toString(),
    quoteTtlMs: fields.quoteTtlMs,
    slippageCapBps: fields.slippageCapBps,
  };

  // Explicit key sort → canonical form is insertion-order-independent.
  const canonical = Object.fromEntries(Object.entries(raw).sort(([a], [b]) => a.localeCompare(b)));

  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json).digest('hex');
}
