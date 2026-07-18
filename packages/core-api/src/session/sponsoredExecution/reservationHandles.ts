/**
 * SponsoredExecution — branded reservation handles + sponsor-phase reconstruction.
 *
 * Reservation handles:
 *   - are issued only by their owning reservation's `acquire()`,
 *   - guard their consumers at compile time via brand,
 *   - fail closed at runtime after release,
 *   - can be reconstructed during sponsor processing from the validated
 *     prepared receipt (sponsor address, receipt ID, nonce, and Promotion
 *     reservation identity).
 *
 * Mint paths (issuing authority):
 *   - `internalReservationHandleFactory` — the ONLY in-process mint authority for
 *     prepare-side reservation handles. Imported by `reservations.ts` only; the factory
 *     key is not re-exported from the directory barrel. Tests under
 *     `packages/*\/tests/**` import it directly for coverage of the
 *     brand/guard contracts the runtime fan-out depends on.
 *   - `reconstructReservationHandles` — sponsor-phase reconstruction helper.
 *     Lifts validated durable identity into live typed handles before the
 *     atomic prepared-to-executing transition.
 *
 * Internal module. The internal `index.ts` barrel re-exports public types,
 * `reconstructReservationHandles`, and `createGasBoundBuildInput` only — never the raw
 * factory key or impl classes.
 */

import type { AddressBalanceGasTransaction } from '@stelis/core-relay/server';

// ─────────────────────────────────────────────
// Brand machinery
// ─────────────────────────────────────────────

/** Common brand interface — every reservation kind tags itself with a unique brand. */
export interface ReservationHandleBrand<TBrand extends string> {
  readonly reservationKind: TBrand;
}

/**
 * Module-private factory key. Reservation handle classes accept this only when invoked
 * by `internalReservationHandleFactory` (used by `reservations.ts`) or by
 * `reconstructReservationHandles` (used during sponsor processing after prepared-record
 * validation). Foreign-module construction is rejected at runtime by the
 * constructor's identity check on this symbol.
 *
 * NOT re-exported from the directory's `index.ts` barrel. Production source
 * outside `reservationHandles.ts` and `reservations.ts` cannot reach this symbol through
 * the supported barrel exports.
 */
const RESERVATION_HANDLE_FACTORY_KEY: unique symbol = Symbol(
  'SponsoredExecution.ReservationHandleFactoryKey',
);
type ReservationHandleFactoryKey = typeof RESERVATION_HANDLE_FACTORY_KEY;

/**
 * Thrown when a consumer reads from a handle after the issuing
 * reservation has been released. Fail-closed: the runner must
 * not silently fall through to a partially valid input.
 */
export class ReservationHandleClosedError extends Error {
  constructor(
    public readonly reservationKind: string,
    public readonly reason: 'released',
  ) {
    super(
      `${reservationKind} reservation handle already ${reason}; cannot be read by a downstream consumer`,
    );
    this.name = 'ReservationHandleClosedError';
  }
}

/**
 * Thrown when the constructor is invoked without the module-private factory
 * key. External callers cannot forge the symbol, so this throw is the
 * runtime half of the brand contract.
 */
export class ReservationHandleConstructionError extends Error {
  constructor(public readonly reservationKind: string) {
    super(
      `${reservationKind} reservation handle cannot be constructed outside its issuing reservation`,
    );
    this.name = 'ReservationHandleConstructionError';
  }
}

// ─────────────────────────────────────────────
// Base — runtime fail-closed guard
// ─────────────────────────────────────────────

/**
 * Shared base for all reservation handle kinds. Owns:
 *   - the runtime released flag,
 *   - the `requireValid()` getter that consumers MUST call before reading
 *     payload fields,
 *   - the factory-key check that enforces module ownership at construction.
 *
 * Subclasses expose payload fields through getters that delegate to
 * `requireValid()` first; reading any payload after release throws
 * `ReservationHandleClosedError` regardless of whether the consumer cached the
 * reference.
 */
abstract class ReservationHandleBase<
  TBrand extends string,
> implements ReservationHandleBrand<TBrand> {
  abstract readonly reservationKind: TBrand;
  private _state: 'live' | 'released' = 'live';

  protected constructor(factoryKey: ReservationHandleFactoryKey, kindForError: string) {
    if (factoryKey !== RESERVATION_HANDLE_FACTORY_KEY) {
      throw new ReservationHandleConstructionError(kindForError);
    }
  }

  /**
   * Throws `ReservationHandleClosedError` if the handle is no longer live.
   * Subclass payload getters must call this before returning data so that
   * post-release access fails closed at the read site.
   */
  protected requireValid(): void {
    if (this._state !== 'live') {
      throw new ReservationHandleClosedError(this.reservationKind, this._state);
    }
  }

  /** True iff the handle has not yet been released. */
  isLive(): boolean {
    return this._state === 'live';
  }

  /**
   * Mark the handle as released. Repeated calls are idempotent.
   */
  release(): void {
    this._state = 'released';
  }
}

// ─────────────────────────────────────────────
// SponsorSlotReservationHandle
// ─────────────────────────────────────────────

/**
 * Issued by `SponsorSlotReservation.acquire()`. Required by the gas-bound
 * build (`GasBoundBuildReservationHandles`), the lease commit step, the sponsor sign
 * call, and the slot checkin.
 */
export interface SponsorSlotReservationHandle extends ReservationHandleBrand<'SponsorSlot'> {
  readonly sponsorAddress: string;
  readonly receiptId: string;
  isLive(): boolean;
}

class SponsorSlotReservationHandleImpl
  extends ReservationHandleBase<'SponsorSlot'>
  implements SponsorSlotReservationHandle
{
  readonly reservationKind = 'SponsorSlot' as const;

  constructor(
    factoryKey: ReservationHandleFactoryKey,
    private readonly _sponsorAddress: string,
    private readonly _receiptId: string,
  ) {
    super(factoryKey, 'SponsorSlot');
  }

  get sponsorAddress(): string {
    this.requireValid();
    return this._sponsorAddress;
  }
  get receiptId(): string {
    this.requireValid();
    return this._receiptId;
  }
}

// ─────────────────────────────────────────────
// NonceReservationHandle
// ─────────────────────────────────────────────

/**
 * Issued by `NonceReservation.acquire()`. Required by the generic gas-bound
 * settlement build (the nonce is embedded in the settle PTB). The handle is
 * released on prepare-side failure or transferred to the durable prepared
 * receipt on success.
 */
export interface NonceReservationHandle extends ReservationHandleBrand<'Nonce'> {
  readonly nonce: bigint;
  readonly senderAddress: string;
  readonly receiptId: string;
  isLive(): boolean;
}

class NonceReservationHandleImpl
  extends ReservationHandleBase<'Nonce'>
  implements NonceReservationHandle
{
  readonly reservationKind = 'Nonce' as const;

  constructor(
    factoryKey: ReservationHandleFactoryKey,
    private readonly _nonce: bigint,
    private readonly _senderAddress: string,
    private readonly _receiptId: string,
  ) {
    super(factoryKey, 'Nonce');
  }

  get nonce(): bigint {
    this.requireValid();
    return this._nonce;
  }
  get senderAddress(): string {
    this.requireValid();
    return this._senderAddress;
  }
  get receiptId(): string {
    this.requireValid();
    return this._receiptId;
  }
}

// ─────────────────────────────────────────────
// LedgerReservationHandle
// ─────────────────────────────────────────────

/**
 * Issued by `LedgerBudgetReservation.acquire()` AFTER `GasBoundBuild`
 * because the reservation amount equals the measured gas. Required by
 * Promotion prepared commit and sponsor result classification. The handle
 * carries the reservation identity; the sponsored execution store performs
 * durable entitlement debit or release during receipt transitions.
 *
 * NOT carried in `GasBoundBuildReservationHandles` — the ledger reservation does not
 * exist before measured gas exists, and the gas-bound build cannot depend
 * on a handle issued by a later state.
 */
export interface LedgerReservationHandle extends ReservationHandleBrand<'LedgerReservation'> {
  readonly receiptId: string;
  readonly promotionId: string;
  readonly userId: string;
  readonly reservedGasMist: bigint;
  isLive(): boolean;
}

class LedgerReservationHandleImpl
  extends ReservationHandleBase<'LedgerReservation'>
  implements LedgerReservationHandle
{
  readonly reservationKind = 'LedgerReservation' as const;

  constructor(
    factoryKey: ReservationHandleFactoryKey,
    private readonly _receiptId: string,
    private readonly _promotionId: string,
    private readonly _userId: string,
    private readonly _reservedGasMist: bigint,
  ) {
    super(factoryKey, 'LedgerReservation');
  }

  get receiptId(): string {
    this.requireValid();
    return this._receiptId;
  }
  get promotionId(): string {
    this.requireValid();
    return this._promotionId;
  }
  get userId(): string {
    this.requireValid();
    return this._userId;
  }
  get reservedGasMist(): bigint {
    this.requireValid();
    return this._reservedGasMist;
  }
}

// ─────────────────────────────────────────────
// Internal reservation handle factory entry points
// ─────────────────────────────────────────────

/**
 * Module-internal mint authority for prepare-side reservation handles. Used by
 * `reservations.ts` only. Production callers outside this directory MUST
 * NOT import this symbol directly.
 *
 * Tests under `packages/*\/tests/**` may import this directly to verify
 * the brand/guard runtime contract. Tests are not subject to the
 * production-source restriction because they do not ship in any package
 * artifact.
 */
export const internalReservationHandleFactory = {
  newSponsorSlot(
    sponsorAddress: string,
    receiptId: string,
  ): SponsorSlotReservationHandle & { release(): void } {
    return new SponsorSlotReservationHandleImpl(
      RESERVATION_HANDLE_FACTORY_KEY,
      sponsorAddress,
      receiptId,
    );
  },
  newNonce(
    nonce: bigint,
    senderAddress: string,
    receiptId: string,
  ): NonceReservationHandle & { release(): void } {
    return new NonceReservationHandleImpl(
      RESERVATION_HANDLE_FACTORY_KEY,
      nonce,
      senderAddress,
      receiptId,
    );
  },
  newLedgerReservation(
    receiptId: string,
    promotionId: string,
    userId: string,
    reservedGasMist: bigint,
  ): LedgerReservationHandle & { release(): void } {
    return new LedgerReservationHandleImpl(
      RESERVATION_HANDLE_FACTORY_KEY,
      receiptId,
      promotionId,
      userId,
      reservedGasMist,
    );
  },
};

/**
 * Test-only access to the underlying constructors. The constant is a
 * named export from this module; tests import it via the direct
 * `reservationHandles.ts` path. The directory's `index.ts` barrel does NOT
 * re-export it, so package consumers using supported exports cannot reach
 * this helper. Tests under `packages/*\/tests/**` import it directly.
 *
 * The constructor identity check on `RESERVATION_HANDLE_FACTORY_KEY` still fires
 * here, so this helper cannot be used to mint a handle with a forged
 * key — it is intentionally a thin re-export of the impl classes plus
 * the symbol for the brand/guard contract tests.
 */
export const __testingReservationHandleInternals = {
  RESERVATION_HANDLE_FACTORY_KEY,
  SponsorSlotReservationHandleImpl,
  NonceReservationHandleImpl,
  LedgerReservationHandleImpl,
};

// ─────────────────────────────────────────────
// Sponsor-phase reconstruction shapes
// ─────────────────────────────────────────────

/**
 * Inputs needed to reconstruct `SponsorSlotReservationHandle` from the
 * validated prepared receipt. This handle carries lifecycle identity only.
 * The sponsor pool's later `sign()` call verifies the executing lease record's
 * transaction-bound HMAC against the submitted transaction bytes.
 */
export interface SponsorSlotReconstructionInputs {
  readonly sponsorAddress: string;
  readonly receiptId: string;
}

/** Sponsor-phase reconstruction inputs for the generic-only nonce reservation handle. */
export interface NonceReconstructionInputs {
  readonly nonce: bigint;
  readonly senderAddress: string;
  readonly receiptId: string;
  /**
   * `parseSettleArgs(submittedTxBytes).nonce === storedNonce` MUST be true
   * before this struct is built — the S-14 in-PTB nonce match is the
   * sponsor-phase authority for the embedded nonce, with the prepared-entry
   * value as the durable record.
   */
  readonly inPtbNonceMatch: true;
}

/** Sponsor-phase reconstruction inputs for Studio ledger reservation. */
export interface LedgerReservationReconstructionInputs {
  readonly receiptId: string;
  readonly promotionId: string;
  readonly userId: string;
  readonly reservedGasMist: bigint;
  /**
   * Studio's ledger read model MUST have verified an active reservation
   * whose receipt, promotion/user identity, and amount equal the
   * prepared-entry copy before this struct is built.
   */
  readonly ledgerLookupVerified: true;
}

/**
 * Reconstruct sponsor-phase reservation handles from validated durable inputs.
 * Nonce and ledger inputs are returned only after their owning checks; sponsor
 * lease HMAC verification remains at the later pool `sign()` boundary. Returns
 * fresh handles in the `live` state for policy type checks and result
 * projection. Durable release and accounting remain store transitions.
 *
 * The nonce and ledger verified-flag fields document — at the type level and
 * in the input shape — that those reconstructions are gated on their prior
 * boundary checks.
 */
export const reconstructReservationHandles = {
  sponsorSlot(
    inputs: SponsorSlotReconstructionInputs,
  ): SponsorSlotReservationHandle & { release(): void } {
    return internalReservationHandleFactory.newSponsorSlot(inputs.sponsorAddress, inputs.receiptId);
  },
  nonce(inputs: NonceReconstructionInputs): NonceReservationHandle & { release(): void } {
    return internalReservationHandleFactory.newNonce(
      inputs.nonce,
      inputs.senderAddress,
      inputs.receiptId,
    );
  },
  ledgerReservation(
    inputs: LedgerReservationReconstructionInputs,
  ): LedgerReservationHandle & { release(): void } {
    return internalReservationHandleFactory.newLedgerReservation(
      inputs.receiptId,
      inputs.promotionId,
      inputs.userId,
      inputs.reservedGasMist,
    );
  },
};

// ─────────────────────────────────────────────
// Per-stage reservation handle shapes
// ─────────────────────────────────────────────

/**
 * Required reservation handles at the `GasBoundBuild` boundary. `GasBoundBuild`
 * runs before the runner acquires a Studio ledger reservation, so the ledger
 * reservation handle is intentionally absent here — it does not yet exist.
 *
 *   - generic: { sponsorSlot, nonce } (nonce reserved before build)
 *   - studio:  { sponsorSlot } (no route reservation before build)
 */
export interface GasBoundBuildReservationHandles {
  readonly sponsorSlot: SponsorSlotReservationHandle;
  readonly nonce?: NonceReservationHandle;
}

/**
 * Required reservation handles at the `ClassifySponsorResult` boundary after
 * submission. Sponsor slot identity is required for result projection;
 * Promotion reservation identity is required for Promotion classification.
 * Nonce is not required because its in-transaction match already happened in
 * `SharedSponsorChecks`. Durable release and accounting are performed by
 * `finalizeSponsoredExecution()`.
 */
export interface SponsorResultReservationHandles {
  readonly sponsorSlot: SponsorSlotReservationHandle;
  readonly ledgerReservation?: LedgerReservationHandle;
}

/**
 * Build a `GasBoundBuildInput` from supplied reservation handles. Verifies that every
 * supplied handle is still live so a stale handle from an aborted
 * earlier transition cannot leak into a fresh build.
 *
 * This is the single input shape for `GasBoundBuild`. Adding
 * `ledgerReservation` here is intentionally unsupported because ledger
 * reservation happens after gas-bound build measurement.
 */
export interface GasBoundBuildInput {
  readonly reservationHandles: GasBoundBuildReservationHandles;
}

export function createGasBoundBuildInput(
  handles: GasBoundBuildReservationHandles,
): GasBoundBuildInput {
  requireHandleLive(handles.sponsorSlot);
  if (handles.nonce) requireHandleLive(handles.nonce);
  return { reservationHandles: handles };
}

function requireHandleLive(handle: { isLive(): boolean; reservationKind: string }): void {
  if (!handle.isLive()) {
    throw new ReservationHandleClosedError(handle.reservationKind, 'released');
  }
}

/**
 * Result returned by the `GasBoundBuild` policy hook. The runner consumes:
 *   - `addressBalanceGasTransaction` — opaque validated transaction. Only the
 *     runner obtains its user-signable bytes and `txBytesHash`.
 *   - `measuredGasMist` — used by the runner to reserve the matching Studio
 *     ledger amount after the build. Generic
 *     policies that do not reserve ledger may set this to `0n` (the
 *     value is unused on the generic path).
 *
 * The hook owns the route-specific build call
 * (`runGenericPrepareBuildPipeline` for generic,
 * `safeBuildAddressBalanceGasTransaction` for PromotionSponsored); the runner stays
 * route-agnostic and only consumes the typed result.
 */
export interface GasBoundBuildResult {
  readonly addressBalanceGasTransaction: AddressBalanceGasTransaction;
  readonly measuredGasMist: bigint;
}
