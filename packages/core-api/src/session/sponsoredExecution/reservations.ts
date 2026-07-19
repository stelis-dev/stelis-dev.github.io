/**
 * SponsoredExecution — typed reservation contracts.
 *
 * Four concrete reservations are supported:
 *   - `InflightReservation`
 *   - `SponsorSlotReservation`
 *   - `NonceReservation`
 *   - `LedgerBudgetReservation`
 *
 * Each reservation owns its own acquire/release semantics.
 *
 * The prepare runner binds these reservations directly to the sponsor pool,
 * sponsored execution store, Promotion ledger, and in-flight limiter.
 *
 * Internal module. Not re-exported from the package barrel.
 */

import type {
  SponsorSlotReservationHandle,
  NonceReservationHandle,
  LedgerReservationHandle,
} from './reservationHandles.js';
import { internalReservationHandleFactory } from './reservationHandles.js';

import type { SponsorPoolAdapter } from '../../context.js';
import type { SponsoredExecutionStoreAdapter } from '../../store/sponsoredExecutionStore.js';
import type { InflightHandle, PrepareInflightLimiter } from '../../store/prepareInflightTypes.js';
import type { PromotionExecutionLedger } from '../../studio/executionLedger.js';
import type { ReserveFailureReason, ReserveParams } from '../../studio/domain.js';
import { PrepareOverloadError } from '../../store/prepareErrors.js';
import {
  LEDGER_RELEASE_FAILED_IN_HANDLER,
  LEDGER_RELEASE_THREW_IN_HANDLER,
  PREPARE_INFLIGHT_RELEASE_FAILED,
} from '../../observability/events.js';
import { logStructuredEvent } from '../../structuredEventLog.js';
import { safeSlotCheckin } from '../sessionPrimitives.js';

// ─────────────────────────────────────────────
// Common lifecycle marker
// ─────────────────────────────────────────────

/**
 * Lifecycle ownership marker shared by every concrete reservation. This is
 * NOT a uniform acquire signature — concrete acquire methods take
 * resource-specific inputs and return resource-specific reservation handles.
 *
 * The runner depends on `release()` only, so reverse-order cleanup can
 * iterate without inspecting concrete reservation types.
 */
export interface ReservationLifecycle {
  /**
   * Release the reservation in a non-throwing manner. Any exception from
   * the subclass `releaseImpl()` is captured and routed to
   * `onReleaseError(err)` so a single failing cleanup step does not
   * propagate, masking the original error or replacing a successful
   * prepare result. Idempotent after the first successful release.
   */
  release(): Promise<void>;
}

/**
 * Subset of the lifecycle for reservations whose handles outlive the
 * prepare scope: ownership transfers to the durable prepared receipt on
 * success and `release()` becomes a no-op. Implemented ONLY by the
 * reservation kinds whose resource lives on the durable store after
 * prepared receipt commit — sponsor slot, nonce, ledger budget.
 *
 * Inflight admission is intentionally NOT transferable: the inflight
 * gate caps in-process concurrency and MUST release on every path,
 * matching the current runner shape where the inflight handle is dropped
 * regardless of transferable reservation ownership. The cleanup order is
 * `route-specific reservations → sponsor slot checkin → inflight release`;
 * there is no transfer step for inflight.
 */
export interface OwnershipTransfer {
  transferOwnership(): void;
}

abstract class ReservationBase implements ReservationLifecycle {
  protected _state: 'pending' | 'acquired' | 'released' | 'transferred' = 'pending';

  /**
   * Reverse-order cleanup. NEVER throws — any subclass `releaseImpl()`
   * exception is routed to `onReleaseError()` and swallowed. This contract
   * matches the runner's reverse-release skeleton: a
   * single failing cleanup step must not replace a successful result or
   * mask the original error that triggered the cleanup.
   *
   * Idempotent: calling release() on an already-released reservation is
   * a no-op. For transferable reservations (see
   * `TransferableReservationBase`), `release()` is also a no-op after
   * `transferOwnership()` — ownership has moved to the durable store
   * and the in-process resource is no longer ours to free.
   */
  async release(): Promise<void> {
    if (this._state !== 'acquired') {
      return;
    }
    let caught: unknown;
    try {
      await this.releaseImpl();
    } catch (err) {
      caught = err;
    } finally {
      this._state = 'released';
    }
    if (caught !== undefined) {
      try {
        this.onReleaseError(caught);
      } catch {
        // Swallow — the error reporter itself must never throw out of
        // release(). Subclasses use route-owned structured logging
        // where a concrete cleanup failure has a verified consumer.
      }
    }
  }

  /**
   * Subclass-specific cleanup. Implementations should still aim for
   * idempotence and minimal external dependencies, but the runner-level
   * `release()` will catch any exception and route it to
   * `onReleaseError()`. The subclass is not required to internally
   * swallow.
   */
  protected abstract releaseImpl(): Promise<void>;

  /**
   * Hook invoked when `releaseImpl()` throws. The base class default is a
   * no-op; concrete adapters used by handlers override
   * this to emit `LEDGER_RELEASE_FAILED_IN_HANDLER` /
   * `PREPARE_INFLIGHT_RELEASE_FAILED` structured events.
   *
   * `onReleaseError()` is wrapped in a try/catch by `release()` so a
   * misbehaving subclass cannot escape this swallow.
   */
  protected onReleaseError(_err: unknown): void {
    // No-op by default. Overridable by concrete adapters.
  }
}

/**
 * Specialized base for reservations whose resource ownership transfers
 * to the durable prepared receipt after store success. Sponsor
 * slot, nonce, and ledger reservation are the three kinds that sit on this
 * boundary.
 *
 * `InflightReservation` extends `ReservationBase` directly, NOT this
 * class. Inflight admission is process-local and must release on every
 * path (success or failure) so concurrency caps stay accurate.
 */
abstract class TransferableReservationBase extends ReservationBase implements OwnershipTransfer {
  /**
   * Mark the reservation as transferred. The base-class `release()`
   * early-returns for any state other than `'acquired'`, so a later
   * `release()` call is a no-op — ownership has moved to the durable
   * store and the in-process resource is no longer ours to free.
   *
   * This method is intentionally non-throwing: it runs after the durable
   * store commit, where an exception would turn a successful commit into a
   * public failure. The runner only calls it for successfully acquired
   * reservations; duplicate calls are harmless.
   */
  transferOwnership(): void {
    if (this._state === 'acquired') this._state = 'transferred';
  }
}

// ─────────────────────────────────────────────
// InflightReservation — slot-free admission gate
// ─────────────────────────────────────────────

/**
 * Inflight admission gate. Issues no reservation handle — the runner's outer
 * boundary uses inflight presence as a binary admission signal. Released
 * last in the cleanup chain so concurrency caps stay accurate even on
 * partial failure.
 *
 * Non-transferable by design. `InflightReservation` extends the plain
 * `ReservationBase` (not `TransferableReservationBase`) so it has no
 * `transferOwnership()` method. The inflight handle is process-local
 * and MUST release on every path — success or failure — to keep
 * concurrency caps accurate. The cleanup order is `route-specific
 * reservations → sponsor slot checkin → inflight release` with NO
 * transfer step for inflight. Transferable reservations move to the durable
 * prepared commit, but
 * the inflight handle still drops unconditionally.
 */
export abstract class InflightReservation extends ReservationBase {
  /**
   * Acquire admission for the given route. Throws on capacity exhaustion.
   * Concrete subclasses bind to a specific limiter implementation in the
   * handler layer.
   */
  abstract acquire(route: string): Promise<void>;
}

// ─────────────────────────────────────────────
// SponsorSlotReservation — issues SponsorSlotReservationHandle
// ─────────────────────────────────────────────

/**
 * Sponsor slot reservation. `acquire()` checks out a slot from the sponsor
 * pool and issues `SponsorSlotReservationHandle` that the gas-bound build and
 * receipt store uses. The sponsored execution store owns the atomic lease commit.
 */
export abstract class SponsorSlotReservation extends TransferableReservationBase {
  protected issuedHandle: ReturnType<
    typeof internalReservationHandleFactory.newSponsorSlot
  > | null = null;

  /**
   * Check out a sponsor slot reserved against `receiptId`. On success the
   * reservation issues `SponsorSlotReservationHandle` keyed to the chosen
   * `sponsorAddress`. Returns null when the pool is exhausted —
   * the caller decides the route-specific domain error
   * (`NO_SPONSOR_SLOT` etc.).
   */
  abstract acquire(receiptId: string): Promise<SponsorSlotReservationHandle | null>;
}

// ─────────────────────────────────────────────
// NonceReservation — issues NonceReservationHandle (generic only)
// ─────────────────────────────────────────────

/**
 * Sender-scoped monotonic nonce reservation. Required by the generic
 * gas-bound settlement build because the nonce is embedded in the settle
 * PTB at build time.
 *
 * Ownership transfers to the durable prepared receipt on success
 * (`transferOwnership()`); reverse cleanup calls `release()`. There is no
 * nonce-specific commit operation.
 */
export abstract class NonceReservation extends TransferableReservationBase {
  protected issuedHandle: ReturnType<typeof internalReservationHandleFactory.newNonce> | null =
    null;

  /**
   * Reserve `max(onchainLastNonce, …) + 1` for `senderAddress`. Returns
   * `NonceReservationHandle` carrying the reserved value. Implementations bind
   * to the sponsored execution store's `reserveNonce()` implementation.
   */
  abstract acquire(
    senderAddress: string,
    onchainLastNonce: bigint,
    receiptId: string,
  ): Promise<NonceReservationHandle>;
}

// ─────────────────────────────────────────────
// LedgerBudgetReservation — issues LedgerReservationHandle (Studio only)
// ─────────────────────────────────────────────

/**
 * Studio promotion ledger reservation. Required by Studio prepared commit
 * and sponsor result policy. The amount is the gas-measured ceiling, so this
 * reservation is acquired after `GasBoundBuild`, unlike the nonce which
 * runs before build. The prepare runner owns this acquisition step; the
 * policy's `GasBoundBuild` hook never acquires the ledger reservation.
 *
 * Final entitlement debit or release is owned by the atomic
 * sponsored-execution store. This prepare-side reservation only acquires and
 * reverses an uncommitted reservation.
 */
export abstract class LedgerBudgetReservation extends TransferableReservationBase {
  protected issuedHandle: ReturnType<
    typeof internalReservationHandleFactory.newLedgerReservation
  > | null = null;

  /**
   * Atomically reserve `amountMist` against the promotion's entitlement
   * budget. Returns `LedgerReservationHandle` on success or null when
   * the entitlement cannot cover the amount (caller raises the
   * domain-specific error).
   */
  abstract acquire(params: {
    receiptId: string;
    promotionId: string;
    userId: string;
    amountMist: bigint;
  }): Promise<LedgerReservationHandle | null>;
}

// ═════════════════════════════════════════════════════════════════════
// Concrete reservations — runtime adapter bindings
//
// Each concrete class binds an abstract reservation to its production
// adapter and preserves the runner cleanup behavior:
//   - InflightReservationImpl    → `PrepareInflightLimiter`
//                                   `PREPARE_INFLIGHT_RELEASE_FAILED`
//                                   on release error.
//   - SponsorSlotReservationImpl → `SponsorPoolAdapter`. Release is
//                                   delegated to `safeSlotCheckin`,
//                                   which already swallows + emits
//                                   `SPONSOR_POOL_CHECKIN_FAILED`
//                                   internally.
//   - NonceReservationImpl        → `SponsoredExecutionStoreAdapter` (`reserveNonce`
//                                   / `releaseNonceReservation`). Release
//                                   errors are silently swallowed. The
//                                   pending reservation falls out via
//                                   sender-metadata TTL compaction.
//   - LedgerBudgetReservationImpl → `PromotionExecutionLedger`. Emits
//                                   `LEDGER_RELEASE_FAILED_IN_HANDLER`
//                                   on `result.ok === false` and
//                                   `LEDGER_RELEASE_THREW_IN_HANDLER`
//                                   on throw.
//
// These classes are the concrete resource adapters used by
// `runPrepareStateMachine`.
// ═════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────
// InflightReservationImpl
// ─────────────────────────────────────────────

/**
 * Concrete inflight reservation that binds to a `PrepareInflightLimiter`.
 * `acquire()` throws `PrepareOverloadError` when the limiter is at
 * capacity.
 */
export class InflightReservationImpl extends InflightReservation {
  private handle: InflightHandle | null = null;
  private route: string | null = null;

  constructor(private readonly limiter: PrepareInflightLimiter) {
    super();
  }

  async acquire(route: string): Promise<void> {
    const handle = await this.limiter.tryAcquire(route);
    if (!handle) {
      throw new PrepareOverloadError(this.limiter.inflight, this.limiter.capacity);
    }
    this.handle = handle;
    this.route = route;
    this._state = 'acquired';
  }

  protected async releaseImpl(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (handle) await handle.release();
  }

  protected override onReleaseError(err: unknown): void {
    logStructuredEvent(
      PREPARE_INFLIGHT_RELEASE_FAILED,
      {
        route: this.route ?? 'unknown',
        error: err instanceof Error ? err.message : String(err),
      },
      'error',
    );
  }
}

// ─────────────────────────────────────────────
// SponsorSlotReservationImpl
// ─────────────────────────────────────────────

/**
 * Concrete sponsor-slot reservation that binds to a `SponsorPoolAdapter`.
 *
 * `acquire(receiptId)` calls `pool.checkout(receiptId)`. On success the
 * reservation issues `SponsorSlotReservationHandle` keyed to the chosen
 * `sponsorAddress`; on null (pool exhausted) the reservation
 * stays in the `pending` state so reverse cleanup is a no-op.
 *
 * `releaseImpl` delegates to `safeSlotCheckin`, which is internally
 * non-throwing and emits `SPONSOR_POOL_CHECKIN_FAILED` on its own —
 * `onReleaseError` is therefore not overridden.
 */
export class SponsorSlotReservationImpl extends SponsorSlotReservation {
  private receiptId: string | null = null;

  constructor(private readonly pool: SponsorPoolAdapter) {
    super();
  }

  async acquire(receiptId: string): Promise<SponsorSlotReservationHandle | null> {
    const slot = await this.pool.checkout(receiptId);
    if (!slot) return null;
    this.issuedHandle = internalReservationHandleFactory.newSponsorSlot(
      slot.sponsorAddress,
      receiptId,
    );
    this.receiptId = receiptId;
    this._state = 'acquired';
    return this.issuedHandle;
  }

  protected async releaseImpl(): Promise<void> {
    if (!this.issuedHandle || !this.receiptId) return;
    // `safeSlotCheckin` never throws; the inner CAS verifies the lease
    // proof so stale cleanup cannot delete a different lease.
    await safeSlotCheckin(this.pool, this.issuedHandle.sponsorAddress, this.receiptId);
  }
}

// ─────────────────────────────────────────────
// NonceReservationImpl
// ─────────────────────────────────────────────

/**
 * Concrete nonce reservation that binds to the sponsored execution store.
 * `acquire()` calls `store.reserveNonce(...)`; release calls
 * `store.releaseNonceReservation(receiptId, senderAddress)`.
 *
 * Release errors are silently swallowed — the pending reservation falls
 * out via sender-metadata TTL compaction
 * if explicit release fails. The base class' `onReleaseError` default
 * (no-op) preserves this behavior.
 */
export class NonceReservationImpl extends NonceReservation {
  private receiptId: string | null = null;
  private senderAddress: string | null = null;

  constructor(private readonly store: SponsoredExecutionStoreAdapter) {
    super();
  }

  async acquire(
    senderAddress: string,
    onchainLastNonce: bigint,
    receiptId: string,
  ): Promise<NonceReservationHandle> {
    const nonce = await this.store.reserveNonce(senderAddress, onchainLastNonce, receiptId);
    this.issuedHandle = internalReservationHandleFactory.newNonce(nonce, senderAddress, receiptId);
    this.receiptId = receiptId;
    this.senderAddress = senderAddress;
    this._state = 'acquired';
    return this.issuedHandle;
  }

  protected async releaseImpl(): Promise<void> {
    if (!this.receiptId || !this.senderAddress) return;
    const receiptId = this.receiptId;
    const sender = this.senderAddress;
    this.receiptId = null;
    this.senderAddress = null;
    await this.store.releaseNonceReservation(receiptId, sender);
  }
}

// ─────────────────────────────────────────────
// LedgerBudgetReservationImpl
// ─────────────────────────────────────────────

const PREPARED_RECEIPT_NOT_COMMITTED_TRIGGER = 'prepared_receipt_not_committed';

/**
 * Concrete Studio ledger reservation that binds to a
 * `PromotionExecutionLedger`.
 *
 * `acquire(params)` calls `ledger.reserve(...)`; on `ok` the reservation
 * issues `LedgerReservationHandle` carrying the receiptId / promotionId
 * / userId / amount, and the receiptId is captured for reverse-cleanup
 * `release()`. On
 * failure the reservation stays pending and returns null — the caller
 * raises the route-specific domain error.
 *
 * Cleanup behavior:
 *   - On `ledger.release(receiptId)` returning `result.ok === false`,
 *     emit `LEDGER_RELEASE_FAILED_IN_HANDLER` (level: error).
 *   - On `ledger.release()` throwing, emit
 *     `LEDGER_RELEASE_THREW_IN_HANDLER` (level: warn).
 *
 * Release failures are attributed to the prepared-receipt boundary because
 * this reservation class is used only by prepare cleanup before durable commit.
 */
export class LedgerBudgetReservationImpl extends LedgerBudgetReservation {
  private receiptId: string | null = null;
  private lastRejectionReason: ReserveFailureReason | null = null;

  constructor(private readonly ledger: PromotionExecutionLedger) {
    super();
  }

  getLastRejectionReason(): ReserveFailureReason | null {
    return this.lastRejectionReason;
  }

  async acquire(
    params: ReserveParams & { promotionId: string; userId: string },
  ): Promise<LedgerReservationHandle | null> {
    const result = await this.ledger.reserve({
      promotionId: params.promotionId,
      userId: params.userId,
      receiptId: params.receiptId,
      amountMist: params.amountMist,
    });
    if (!result.ok) {
      this.lastRejectionReason = result.reason;
      return null;
    }
    this.lastRejectionReason = null;
    this.issuedHandle = internalReservationHandleFactory.newLedgerReservation(
      params.receiptId,
      params.promotionId,
      params.userId,
      params.amountMist,
    );
    this.receiptId = params.receiptId;
    this._state = 'acquired';
    return this.issuedHandle;
  }

  protected async releaseImpl(): Promise<void> {
    // `receiptId` is preserved until after `ledger.release` resolves so
    // both the `result.ok === false` and the throw path see the same
    // identifier. Idempotency is guaranteed at the base-class level —
    // `ReservationBase.release()` only invokes `releaseImpl` when the
    // reservation is in the `acquired` state, so a second `release()`
    // call is a no-op.
    if (!this.receiptId) return;
    const result = await this.ledger.release(this.receiptId);
    if (!result.ok) {
      logStructuredEvent(
        LEDGER_RELEASE_FAILED_IN_HANDLER,
        {
          receiptId: this.receiptId,
          triggerReason: PREPARED_RECEIPT_NOT_COMMITTED_TRIGGER,
          releaseFailureReason: result.reason,
        },
        'error',
      );
    }
  }

  protected override onReleaseError(_err: unknown): void {
    // `releaseImpl` did not clear `receiptId`, so the throw path can
    // still emit the structured log with the identical payload shape
    // the failed release path uses the same receipt/trigger payload.
    if (!this.receiptId) return;
    logStructuredEvent(
      LEDGER_RELEASE_THREW_IN_HANDLER,
      { receiptId: this.receiptId, triggerReason: PREPARED_RECEIPT_NOT_COMMITTED_TRIGGER },
      'warn',
    );
  }
}
