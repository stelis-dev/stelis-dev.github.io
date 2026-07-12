/**
 * SponsoredExecution — shared prepared-entry composer.
 *
 * This module owns the shared prepared-commit boundary. It exposes:
 *   - the discriminated input shape (`PreparedCommitInputs`),
 *   - one `composePreparedCommit()` function that both routes use to
 *     project execution policy output into a durable store entry.
 *
 * The `mode` discriminator on the output is the stored JSON shape and
 * stays `'generic'` / `'promotion'`. Mode-specific narrowing uses the store-layer
 * `GenericPreparedTxEntry` / `PromotionPreparedTxEntry` members directly;
 * those names are not re-exported from the public main barrel.
 *
 * Internal module. The directory's `index.ts` re-exports only the
 * public types and `composePreparedCommit()`; raw policy-specific
 * payload helpers (none today) would not be re-exported.
 */

import type {
  GenericPreparedTxEntry,
  PreparedTxEntry,
  PromotionPreparedTxEntry,
} from '../../store/prepareTypes.js';
import { type Clock, systemClock } from '../../clock.js';

// ─────────────────────────────────────────────
// Input shape: policy-discriminated, runner-friendly
// ─────────────────────────────────────────────

/**
 * Coordination fields shared by every policy. Each field maps 1:1 to
 * the corresponding field on the durable store entry, so re-typing here
 * cannot drift from the durable stored shape.
 *
 * `nonce` is included because the durable shape always carries it
 * (promotion entries persist `0n` per the existing Studio inline
 * assembly at `preparePromotionSponsoredHandler.ts:448`).
 */
export interface PreparedCommitCommonInputs {
  readonly receiptId: string;
  readonly senderAddress: string;
  readonly clientIp: string;
  readonly txBytesHash: string;
  readonly sponsorAddress: string;
  readonly executionPathKey: string;
  readonly orderId: string | null;
  readonly nonce: bigint;
  /** Optional issuance timestamp; defaults to `clock.nowMs()`. */
  readonly issuedAt?: number;
}

/**
 * Generic-policy commit inputs. The runner constructs this from a
 * generic `SponsoredExecutionPolicy.GasBoundBuild` hook output (`txBytesHash`)
 * plus the prepare-side `SponsorSlotReservationHandle` and `NonceReservationHandle`. No
 * policy-specific payload beyond the common fields — generic mode's
 * settle authority lives in `parseSettleArgs(txBytes)` at sponsor time.
 */
export interface GenericCommitInputs extends PreparedCommitCommonInputs {
  readonly mode: 'generic';
}

/**
 * Studio-policy commit inputs. The runner constructs this from the
 * promotion `SponsoredExecutionPolicy.RouteReservationAfterBuild` hook output
 * (`reservedGasMist` + `LedgerReservationHandle`) plus the
 * prepare-side `SponsorSlotReservationHandle`. `nonce` is `0n` for promotion
 * (no settle PTB).
 */
export interface PromotionCommitInputs extends PreparedCommitCommonInputs {
  readonly mode: 'promotion';
  readonly promotionId: string;
  readonly userId: string;
  readonly reservedGasMist: bigint;
}

/**
 * Discriminated input union. Both routes consume `composePreparedCommit`;
 * route-local projection is not allowed.
 */
export type PreparedCommitInputs = GenericCommitInputs | PromotionCommitInputs;

// ─────────────────────────────────────────────
// Composer
// ─────────────────────────────────────────────

/**
 * Project execution policy inputs into a durable `PreparedTxEntry`. This is
 * the SOLE prepare-store entry constructor for the new lifecycle.
 * Handler-local entry assembly is forbidden — both `/relay/prepare` and
 * `/studio/promotions/:id/prepare` route through this function.
 *
 * The output's `mode` field equals the input's `mode`; the durable JSON
 * stored shape is preserved across the rename.
 */
export function composePreparedCommit(
  input: PreparedCommitInputs,
  clock: Clock = systemClock,
): PreparedTxEntry {
  const issuedAt = input.issuedAt ?? clock.nowMs();
  const common = {
    issuedAt,
    receiptId: input.receiptId,
    senderAddress: input.senderAddress,
    clientIp: input.clientIp,
    txBytesHash: input.txBytesHash,
    sponsorAddress: input.sponsorAddress,
    executionPathKey: input.executionPathKey,
    orderId: input.orderId,
    nonce: input.nonce,
  } as const;

  if (input.mode === 'generic') {
    return { ...common, mode: 'generic' } satisfies GenericPreparedTxEntry;
  }

  return {
    ...common,
    mode: 'promotion',
    promotionId: input.promotionId,
    userId: input.userId,
    reservedGasMist: input.reservedGasMist,
  } satisfies PromotionPreparedTxEntry;
}

// ─────────────────────────────────────────────
// Helpers — narrow the discriminated union without re-importing
// repeated mode checks at every consumer.
// ─────────────────────────────────────────────

/** Type guard. Returns true iff `commit.mode === 'generic'`. */
export function isGenericPreparedCommit(commit: PreparedTxEntry): commit is GenericPreparedTxEntry {
  return commit.mode === 'generic';
}

/** Type guard. Returns true iff `commit.mode === 'promotion'`. */
export function isPromotionPreparedCommit(
  commit: PreparedTxEntry,
): commit is PromotionPreparedTxEntry {
  return commit.mode === 'promotion';
}
