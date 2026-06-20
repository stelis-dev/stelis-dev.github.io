/**
 * preparePolicy — shared prepare-time policy constants and
 * the canonical `OnchainConfig → PolicyFields` assembly.
 *
 * This module owns:
 *   1. `PREPARE_TTL_MS` — how long a /prepare receipt is valid. Consumed
 *      by prepare store adapters, sponsor policy, inflight limiter, and
 *      the barrel re-export.
 *   2. `buildPolicyFields()` — shared assembly from `OnchainConfig`
 *      to `PolicyFields`. `/prepare` issuance and `/sponsor`
 *      revalidation both use this function.
 *
 * `PolicyFields` type and `computePolicyHash()` live in
 * `./policyHash.ts` (server-only owner). The hash is the Host's
 * private S-16 binding; SDK and browser consumers receive it from the
 * `/relay/prepare` response and never compute it themselves.
 */
import type { OnchainConfig } from '@stelis/core-relay';
import { GAS_VARIANCE_FIXED_MIST } from '@stelis/core-relay';
import { SLIPPAGE_CAP_BPS } from '@stelis/contracts';
import type { PolicyFields } from './policyHash.js';

/**
 * Prepare TTL: how long a /prepare response is valid (ms).
 *
 * Baked into the policy hash (`computePolicyHash` `quoteTtlMs`), so
 * `/prepare` issuance and `/sponsor` revalidation MUST use the same
 * value. Changing it requires redeploying both together.
 */
export const PREPARE_TTL_MS = 60_000;

/**
 * Assemble `PolicyFields` from the current on-chain config.
 *
 * This is the single place where the `OnchainConfig` field names
 * (e.g. `protocolFlatFeeMist`) are mapped to the `PolicyFields`
 * canonical names (e.g. `protocolFeeMist`). Both `/prepare` and
 * `/sponsor` call this instead of inline assembly.
 */
export function buildPolicyFields(config: OnchainConfig): PolicyFields {
  return {
    maxClaimMist: config.maxClaimMist,
    maxHostFeeMist: config.maxHostFeeMist,
    protocolFeeMist: config.protocolFlatFeeMist,
    quoteTtlMs: PREPARE_TTL_MS,
    gasVarianceFixedMist: GAS_VARIANCE_FIXED_MIST,
    slippageCapBps: SLIPPAGE_CAP_BPS,
  };
}
