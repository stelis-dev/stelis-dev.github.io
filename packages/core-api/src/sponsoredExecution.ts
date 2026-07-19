/**
 * Sponsored execution economics — internal core-api types and derivation
 * helpers shared between generic and Studio sponsor sponsored execution policies.
 * Not exported from the package barrel; the host (app-api) consumes the
 * already-serialized result via `SponsorResultMetadata.economics`.
 *
 * Canonical formulas (see `docs/economics-formal.md`):
 *
 *   recovered    = value transferred back to the Host for this execution.
 *                  Generic settlement uses executionCostClaim; promotion
 *                  entitlement consumption transfers no value, so it is 0.
 *   paid         = host-paid net gas on chain, CLAMPED:
 *                  max(0, storage_cost + computation_cost - storage_rebate).
 *                  Identical to `simGas` in `docs/economics-formal.md`.
 *                  The signed raw delta `gross - rebate` is NOT what
 *                  `paid` carries; the recorder clamps so
 *                  `hostPaidGasMist >= 0` and `hostNetMist` does not
 *                  inflate by the rebate-overshoot amount on rebate-heavy TXs.
 *   hostFee   = quotedHostFeeMist
 *
 *   hostNetMist = recovered + hostFee - paid                 (signed, excludes protocol_fee)
 *
 * `hostNetMist` is the single sponsored-execution profit/loss value
 * recorded by the host. Negative values are host loss.
 */
import {
  buildSettlementEconomicsSnapshot,
  type GasUsedLike,
  type SettlementEconomicsSnapshot,
} from './economicsLogging.js';
import type { SponsorResultEconomics } from './handlers/sponsorResult.js';

// ─────────────────────────────────────────────
// Sponsored execution economics shape
// ─────────────────────────────────────────────

/**
 * Known economics — every numeric field is exact MIST. Set when the
 * sponsor result path can prove both the recovered amount and the host-paid
 * amount.
 *
 * `protocolFeeMist`, `grossGasMist`, `storageRebateMist` are auxiliary
 * context the recorder may persist but does NOT enter `hostNetMist`.
 */
export interface SponsoredExecutionEconomicsKnown {
  readonly economicsStatus: 'known';
  readonly recoveredGasMist: bigint;
  readonly hostPaidGasMist: bigint;
  readonly hostFeeMist: bigint;
  readonly hostNetMist: bigint;
  readonly grossGasMist: bigint | null;
  readonly storageRebateMist: bigint | null;
  readonly protocolFeeMist: bigint | null;
  readonly failureReason: string | null;
}

/**
 * Unknown economics — set when the sponsor result path cannot prove the
 * host-paid amount (e.g. preflight failure, congestion, post-submit
 * `gasUsed` missing, post-signature uncertainty). Whether
 * a row is persisted at all is the host recorder's outcome-filter
 * decision; when the recorder does persist the row, every monetary
 * field is `null` and the row is excluded from aggregate net/loss
 * counters.
 */
export interface SponsoredExecutionEconomicsUnknown {
  readonly economicsStatus: 'unknown';
  readonly failureReason: string | null;
}

export type SponsoredExecutionEconomics =
  | SponsoredExecutionEconomicsKnown
  | SponsoredExecutionEconomicsUnknown;

/** Build an unknown-economics object with an explicit failureReason. */
export function unknownSponsoredExecutionEconomics(
  failureReason: string | null,
): SponsoredExecutionEconomicsUnknown {
  return { economicsStatus: 'unknown', failureReason };
}

/** Canonical internal reason stored when congestion prevents a terminal gas proof. */
export const SPONSOR_CONGESTION_FAILURE_REASON = 'congestion' as const;

/** Canonical internal reason stored for a proven on-chain revert. */
export function sponsorOnchainRevertFailureReason(message: string): string {
  return `onchain_revert: ${message}`;
}

/**
 * Derive a `SponsoredExecutionEconomicsKnown` from raw inputs. The
 * derived field `hostNetMist` is the canonical profit/loss value
 * surfaced to the recorder.
 *
 *   hostNetMist = recoveredGasMist + hostFeeMist - hostPaidGasMist
 *
 * `protocolFeeMist` is intentionally NOT subtracted from
 * `hostNetMist`. Protocol fee flows from user surplus to the
 * protocol treasury and is not Host fee revenue (see
 * `docs/economics-formal.md` `Profit and Loss Equations`).
 */
export function deriveSponsoredExecutionEconomics(input: {
  recoveredGasMist: bigint;
  hostPaidGasMist: bigint;
  hostFeeMist: bigint;
  grossGasMist?: bigint | null;
  storageRebateMist?: bigint | null;
  protocolFeeMist?: bigint | null;
  failureReason?: string | null;
}): SponsoredExecutionEconomicsKnown {
  const hostNetMist = input.recoveredGasMist + input.hostFeeMist - input.hostPaidGasMist;
  return {
    economicsStatus: 'known',
    recoveredGasMist: input.recoveredGasMist,
    hostPaidGasMist: input.hostPaidGasMist,
    hostFeeMist: input.hostFeeMist,
    hostNetMist,
    grossGasMist: input.grossGasMist ?? null,
    storageRebateMist: input.storageRebateMist ?? null,
    protocolFeeMist: input.protocolFeeMist ?? null,
    failureReason: input.failureReason ?? null,
  };
}

/**
 * Derive economics for a generic settlement that returned a proven on-chain
 * terminal result. The snapshot is returned for structured logging; the same
 * calculation is used by foreground execution and crash recovery.
 */
export function deriveSettlementExecutionEconomics(input: {
  readonly gasUsed: GasUsedLike;
  readonly recoveredGasMist: bigint;
  readonly hostFeeMist: bigint;
  readonly protocolFeeMist: bigint;
}): {
  readonly snapshot: SettlementEconomicsSnapshot;
  readonly economics: SponsoredExecutionEconomicsKnown;
} {
  const snapshot = buildSettlementEconomicsSnapshot({
    gasUsed: input.gasUsed,
    executionCostClaim: input.recoveredGasMist,
    feeCharged: input.hostFeeMist,
    protocolFee: input.protocolFeeMist,
  });
  return {
    snapshot,
    economics: deriveSponsoredExecutionEconomics({
      recoveredGasMist: snapshot.executionCostClaim,
      hostPaidGasMist: snapshot.netGas,
      hostFeeMist: snapshot.feeCharged,
      grossGasMist: snapshot.grossGas,
      storageRebateMist: snapshot.storageRebate,
      protocolFeeMist: snapshot.protocolFee,
    }),
  };
}

/**
 * Derive economics when gas was paid but no settlement value was recovered.
 * Promotion execution and generic on-chain reverts share this rule.
 */
export function deriveHostPaidGasEconomics(
  gasUsed: GasUsedLike,
  failureReason: string | null,
): SponsoredExecutionEconomicsKnown {
  const snapshot = buildSettlementEconomicsSnapshot({
    gasUsed,
    executionCostClaim: 0n,
    feeCharged: 0n,
    protocolFee: 0n,
  });
  return deriveSponsoredExecutionEconomics({
    recoveredGasMist: 0n,
    hostPaidGasMist: snapshot.netGas,
    hostFeeMist: 0n,
    grossGasMist: snapshot.grossGas,
    storageRebateMist: snapshot.storageRebate,
    protocolFeeMist: null,
    failureReason,
  });
}

// ─────────────────────────────────────────────
// HTTP/log serialization for SponsorResultMetadata.economics
// ─────────────────────────────────────────────

/**
 * Convert internal bigint-valued economics into the string-valued shape
 * carried on `SponsorResultMetadata.economics`. Numeric fields are
 * exact MIST decimal strings; null fields stay null.
 */
export function serializeSponsoredExecutionEconomics(
  econ: SponsoredExecutionEconomics,
): SponsorResultEconomics {
  if (econ.economicsStatus === 'unknown') {
    return { economicsStatus: 'unknown', failureReason: econ.failureReason };
  }
  return {
    economicsStatus: 'known',
    recoveredGasMist: econ.recoveredGasMist.toString(),
    hostPaidGasMist: econ.hostPaidGasMist.toString(),
    hostFeeMist: econ.hostFeeMist.toString(),
    hostNetMist: econ.hostNetMist.toString(),
    grossGasMist: econ.grossGasMist === null ? null : econ.grossGasMist.toString(),
    storageRebateMist: econ.storageRebateMist === null ? null : econ.storageRebateMist.toString(),
    protocolFeeMist: econ.protocolFeeMist === null ? null : econ.protocolFeeMist.toString(),
    failureReason: econ.failureReason,
  };
}

/** Pre-built unknown serialized economics for default callback metadata. */
export const SERIALIZED_UNKNOWN_ECONOMICS: SponsorResultEconomics = Object.freeze({
  economicsStatus: 'unknown' as const,
  failureReason: null,
});
