/**
 * SponsoredExecution — prepare runner.
 *
 * Executes the prepare procedure against an injected
 * `SponsoredExecutionPolicy`. The runner owns receipt generation,
 * reservation acquisition, response projection timing, durable store commit,
 * ownership transfer, and reverse-order cleanup. Policy hooks own
 * route-specific verification and build orchestration; request callbacks own
 * path/order fields and public response projection.
 *
 * Design: typed transition functions per state, dispatched sequentially by a
 * procedural runner that holds the typed execution context. The runner never
 * delegates the next state to a hook.
 *
 * Cleanup ordering:
 *   route-specific reservations (reverse acquire order)
 *     → sponsor slot checkin
 *       → inflight release
 * Inflight is intentionally non-transferable — it always releases on
 * every path so concurrency caps stay accurate after a durable commit.
 * See `reservations.ts` for the type-level enforcement.
 *
 * Internal module. The public prepare handlers now delegate to
 * `runPrepareStateMachine` while preserving their stable entrypoint
 * signatures.
 */

import { toBase64, toHex } from '@mysten/sui/utils';
import type {
  GasBoundBuildResult,
  LedgerReservationHandle,
  NonceReservationHandle,
  SponsorSlotReservationHandle,
} from './index.js';
import { createGasBoundBuildInput } from './index.js';
import type {
  SponsoredExecutionPolicy,
  PrepareChainSnapshot,
  PreparePolicyHookContext,
} from './index.js';
import {
  InflightReservationImpl,
  LedgerBudgetReservationImpl,
  NonceReservationImpl,
  SponsorSlotReservationImpl,
  type OwnershipTransfer,
  type ReservationLifecycle,
} from './reservations.js';
import type { SponsorPoolAdapter } from '../../context.js';
import type { PreparedTxDraft, PrepareStoreAdapter } from '../../store/prepareTypes.js';
import type { PrepareInflightLimiter } from '../../store/prepareInflightTypes.js';
import type { PromotionExecutionLedger } from '../../studio/executionLedger.js';
import type { ReserveFailureReason } from '../../studio/domain.js';

// ─────────────────────────────────────────────
// Host adapters + request shape
// ─────────────────────────────────────────────

/**
 * Production-side adapters the runner consumes. The runner constructs
 * fresh reservation instances per request from these adapters; the
 * adapters themselves are long-lived (single instance per process).
 *
 * `executionLedger` is required for promotion policies and ignored for
 * generic. The runner consults
 * `policy.handleRequirements.preparedCommit.ledgerReservation`
 * to decide whether to require it; missing-when-required throws
 * `RunnerHostMisconfiguredError` at runtime.
 */
export interface PrepareStateMachineHost {
  readonly inflightLimiter: PrepareInflightLimiter;
  readonly sponsorPool: SponsorPoolAdapter;
  readonly prepareStore: PrepareStoreAdapter;
  readonly executionLedger?: PromotionExecutionLedger;
}

/**
 * Per-request inputs the runner does not derive from the execution policy.
 *
 *   - `senderAddress` / `clientIp` — request identity fields used to build
 *     the hook context after the runner generates one receipt ID.
 *   - `ChainSnapshot` output — the policy-owned typed snapshot fields
 *     the runner needs to acquire route reservations. Generic returns
 *     `nonceAcquire.onchainLastNonce`; Studio omits it.
 *   - `ledgerAcquireParams` — the promotion identity fields the runner combines
 *     with its receipt ID to acquire the ledger reservation. Required
 *     when `handleRequirements.preparedCommit.ledgerReservation === true`.
 *   - `preparedDraftFields` — policy projection of path/order fields only.
 *   - `projectResponse` — route-specific public response projection. It runs
 *     before the lease commit and durable store commit.
 */
export interface PrepareResponseProjectionInput {
  readonly txBytesBase64: string;
  readonly draft: Readonly<PreparedTxDraft>;
}

/** Policy-owned fields that the runner cannot derive from acquired resources. */
export interface PrepareDraftPolicyFields {
  readonly executionPathKey: string;
  readonly orderId: string | null;
}

export interface PrepareStateMachineRequest<TResult = unknown> {
  readonly senderAddress: string;
  readonly clientIp: string;
  readonly ledgerAcquireParams?: {
    readonly promotionId: string;
    readonly userId: string;
  };
  /**
   * Project only route-owned coordination fields. The runner constructs every
   * identity and resource-derived draft field itself so a policy cannot split
   * the response/lease receipt from the durable store key.
   */
  readonly preparedDraftFields: () => PrepareDraftPolicyFields;
  readonly projectResponse: (input: PrepareResponseProjectionInput) => Promise<TResult> | TResult;
}

// ─────────────────────────────────────────────
// Errors raised by the runner itself
// ─────────────────────────────────────────────

/**
 * Runner-side errors are preserved as named classes so the
 * handler adapters can map them to public failure codes without
 * string-matching. Policy-side errors propagate unchanged.
 */
export class RunnerHostMisconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerHostMisconfiguredError';
  }
}

export class RunnerSponsorSlotExhaustedError extends Error {
  constructor() {
    super('Sponsor pool returned no slot for the request');
    this.name = 'RunnerSponsorSlotExhaustedError';
  }
}

export class RunnerLedgerReservationRejectedError extends Error {
  constructor(public readonly reason: ReserveFailureReason | 'unknown' = 'unknown') {
    super(`Promotion ledger rejected the reservation request: ${reason}`);
    this.name = 'RunnerLedgerReservationRejectedError';
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function isTransferable(
  reservation: ReservationLifecycle,
): reservation is ReservationLifecycle & OwnershipTransfer {
  return typeof (reservation as Partial<OwnershipTransfer>).transferOwnership === 'function';
}

function generateReceiptIdHex(): string {
  return `0x${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/**
 * Hook-call helper that:
 *   1. preserves the runner's awaiting contract regardless of whether
 *      the hook returns `void` or `Promise<void>`,
 *   2. accepts an optional hook (for the two route-reservation states
 *      that may be omitted by policies that do not need them).
 */
async function callHook<Args extends unknown[]>(
  hook: ((...args: Args) => Promise<unknown> | unknown) | undefined,
  ...args: Args
): Promise<void> {
  if (!hook) return;
  await hook(...args);
}

// ─────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────

/**
 * Run the prepare procedure. The runner owns the concrete order; no parallel
 * runtime state-order declaration is consulted.
 *
 * Cleanup contract: on every failure before store success, acquired
 * reservations release in reverse order. After store success the runner only
 * marks transferable reservations as owned by the durable entry and returns
 * the response that was already projected.
 */
export async function runPrepareStateMachine<TResult>(
  host: PrepareStateMachineHost,
  request: PrepareStateMachineRequest<TResult>,
  policy: SponsoredExecutionPolicy,
): Promise<TResult> {
  const acquired: ReservationLifecycle[] = [];
  const receiptId = generateReceiptIdHex();
  const hookContext: PreparePolicyHookContext = {
    receiptId,
    senderAddress: request.senderAddress,
    clientIp: request.clientIp,
  };
  let chainSnapshot: PrepareChainSnapshot = {};
  let sponsorSlotHandle: SponsorSlotReservationHandle | null = null;
  let nonceHandle: NonceReservationHandle | undefined;
  let ledgerReservationHandle: LedgerReservationHandle | undefined;
  let buildResult: GasBoundBuildResult | null = null;

  try {
    await callHook(policy.hooks.Intent, hookContext);
    await callHook(policy.hooks.RequestValidation, hookContext);

    const inflight = new InflightReservationImpl(host.inflightLimiter);
    await inflight.acquire(policy.discriminator);
    acquired.push(inflight);
    await callHook(policy.hooks.InflightAdmission, hookContext);

    chainSnapshot = await policy.hooks.ChainSnapshot(hookContext);
    await callHook(policy.hooks.ExecutionPolicySelected, hookContext);
    await callHook(policy.hooks.SlotFreePlan, hookContext);

    const slotReservation = new SponsorSlotReservationImpl(host.sponsorPool);
    sponsorSlotHandle = await slotReservation.acquire(receiptId);
    if (!sponsorSlotHandle) throw new RunnerSponsorSlotExhaustedError();
    acquired.push(slotReservation);
    await callHook(policy.hooks.SponsorSlotReservationAcquired, hookContext, sponsorSlotHandle);

    if (policy.handleRequirements.gasBoundBuild.nonce) {
      if (!chainSnapshot.nonceAcquire) {
        throw new RunnerHostMisconfiguredError(
          'policy requires nonce reservation handle but ChainSnapshot did not return nonceAcquire',
        );
      }
      const nonceReservation = new NonceReservationImpl(host.prepareStore);
      nonceHandle = await nonceReservation.acquire(
        hookContext.senderAddress,
        chainSnapshot.nonceAcquire.onchainLastNonce,
        receiptId,
      );
      acquired.push(nonceReservation);
      await callHook(
        policy.hooks.RouteReservationBeforeBuild,
        hookContext,
        sponsorSlotHandle,
        nonceHandle,
      );
    }

    const gasBoundInput = createGasBoundBuildInput({
      sponsorSlot: sponsorSlotHandle,
      nonce: nonceHandle,
    });
    buildResult = await policy.hooks.GasBoundBuild(hookContext, gasBoundInput);

    if (policy.handleRequirements.preparedCommit.ledgerReservation) {
      if (!host.executionLedger) {
        throw new RunnerHostMisconfiguredError(
          'policy requires ledger reservation handle but host.executionLedger is missing',
        );
      }
      if (!request.ledgerAcquireParams) {
        throw new RunnerHostMisconfiguredError(
          'policy requires ledger reservation handle but request.ledgerAcquireParams is missing',
        );
      }
      const ledgerReservation = new LedgerBudgetReservationImpl(host.executionLedger);
      const ledgerAcquireResult = await ledgerReservation.acquire({
        receiptId,
        promotionId: request.ledgerAcquireParams.promotionId,
        userId: request.ledgerAcquireParams.userId,
        amountMist: buildResult.measuredGasMist,
      });
      if (!ledgerAcquireResult) {
        throw new RunnerLedgerReservationRejectedError(
          ledgerReservation.getLastRejectionReason() ?? 'unknown',
        );
      }
      ledgerReservationHandle = ledgerAcquireResult;
      acquired.push(ledgerReservation);
      await callHook(
        policy.hooks.RouteReservationAfterBuild,
        hookContext,
        sponsorSlotHandle,
        ledgerReservationHandle,
      );
    }

    await callHook(policy.hooks.SelfCheck, hookContext);

    const policyDraftFields = request.preparedDraftFields();
    const commonDraftInputs = {
      receiptId,
      senderAddress: hookContext.senderAddress,
      clientIp: hookContext.clientIp,
      txBytesHash: buildResult.txBytesHash,
      sponsorAddress: sponsorSlotHandle.sponsorAddress,
      executionPathKey: policyDraftFields.executionPathKey,
      orderId: policyDraftFields.orderId,
    } as const;
    let draft: PreparedTxDraft;
    if (policy.discriminator === 'generic') {
      if (!nonceHandle) {
        throw new RunnerHostMisconfiguredError(
          'generic policy did not acquire the nonce required by its prepared draft',
        );
      }
      draft = {
        ...commonDraftInputs,
        mode: 'generic',
        nonce: nonceHandle.nonce,
      };
    } else {
      if (!ledgerReservationHandle) {
        throw new RunnerHostMisconfiguredError(
          'promotion policy did not acquire the ledger reservation required by its prepared draft',
        );
      }
      draft = {
        ...commonDraftInputs,
        mode: 'promotion',
        nonce: 0n,
        promotionId: ledgerReservationHandle.promotionId,
        userId: ledgerReservationHandle.userId,
        reservedGasMist: ledgerReservationHandle.reservedGasMist,
      };
    }
    const response = await request.projectResponse({
      txBytesBase64: toBase64(buildResult.txBytes),
      // Keep the runner's store input private. A response projector cannot
      // mutate receipt/hash/resource identity after this boundary.
      draft: Object.freeze({ ...draft }) as Readonly<PreparedTxDraft>,
    });

    await slotReservation.commitToTxBytesHash(buildResult.txBytesHash);
    await callHook(policy.hooks.SponsorLeaseCommitted, hookContext);

    await host.prepareStore.store(draft);
    for (const reservation of acquired) {
      if (isTransferable(reservation)) reservation.transferOwnership();
    }

    return response;
  } finally {
    for (let i = acquired.length - 1; i >= 0; i--) {
      await acquired[i]!.release();
    }
  }
}
