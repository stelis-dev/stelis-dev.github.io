/**
 * Sponsored execution recorder — host-side `onSponsorResult` callback.
 *
 * Translates `SponsorResultMetadata` (host-only contract from
 * `@stelis/core-api`) into a `SponsoredExecutionLogEntry`
 * and writes it via the configured `SponsoredLogsStoreAdapter`.
 *
 * Outcome filter: only outcomes that the relayer paid (or could have
 * paid) gas for go into `Sponsored Executions`. The recorded set is
 * `success`, `onchain_revert`, plus the narrow `internal_error` subset
 * whose `economics.failureReason` starts with `submit_infra_unknown`.
 * That marker is stamped on both routes (generic and promotion) by
 * the post-signature submit-infra exception branch — `pool.sign()`
 * issues the sponsor signature inside `signAndSubmit` before
 * `executeTransaction()` is called, so any non-congestion throw on
 * the latter is post-signature and the TX may have reached the
 * network and burned gas. All other `internal_error` paths (raw
 * catch-all crashes that throw before sponsor signature) did not pay
 * gas; they stay out of this store. `validation_failure`,
 * `preflight_failure`, and `congestion` also did not pay gas and
 * belong to other audit views.
 *
 * Numeric honesty: every field on an `unknown`-economics row is `null`,
 * including `hostFeeMist`. The recorder MUST NOT coerce an unknown
 * fee to `"0"` — that would manufacture a value the sponsor result path could
 * not prove.
 *
 * Failure semantics:
 *   - never throws — primary sponsor response must not be affected.
 *   - store.append rejection emits `SPONSORED_LOGS_RECORDER_FAILED` with
 *     enough context for triage (digest, mode, outcome, error message).
 *   - aggregate-vs-recent atomicity is the store adapter's responsibility
 *     (Lua-atomic in Redis). The recorder does NOT split the write.
 */

import {
  logStructuredEvent,
  SPONSORED_LOGS_RECORDER_FAILED,
  SPONSOR_RESULT_CALLBACK_FAILED,
} from '@stelis/core-api/observability';
import type { SponsorResultCallback, SponsorResultMetadata } from '@stelis/core-api';
import type { SponsoredLogsStoreAdapter } from './store.js';
import type { SponsoredExecutionLogEntry, SponsoredExecutionMode } from './types.js';

/**
 * Outcomes that always produce a sponsored-execution row. `success`
 * reached onchain submit; `onchain_revert` reached onchain submit and
 * burned gas.
 */
const ALWAYS_RECORDED_OUTCOMES = new Set<string>(['success', 'onchain_revert']);

/**
 * Marker prefix on `economics.failureReason` for the submit-infra
 * branch (post-signature uncertainty: sponsor signature issued, TX may
 * have reached the network). Both routes stamp it on the
 * `internal_error` outcome before re-throwing the raw RPC error and
 * lock the economics via `sponsorResultEconomicsLocked` so the outer-catch
 * fall-through cannot overwrite the marker:
 *   - Generic: `packages/core-api/src/session/sponsoredExecution/genericExecutionPolicy.ts` — single
 *     `submit_infra_unknown: <rpcMsg>` shape (no per-receipt ledger
 *     reservation on this route).
 *   - Promotion:
 *     `packages/core-api/src/session/sponsoredExecution/studioExecutionPolicy.ts`
 *     — two shapes:
 *       - `submit_infra_unknown: <rpcMsg>` (consume() succeeded)
 *       - `submit_infra_unknown (ledger consume <kind>): <rpcMsg>`
 *         (consume() returned `{ ok: false }` or threw)
 * All three shapes start with `submit_infra_unknown`, so a prefix
 * check is the narrow signal we use to opt this single
 * `internal_error` subset into sponsoredLogs without admitting raw
 * catch-all crashes.
 */
const SUBMIT_INFRA_FAILURE_REASON_PREFIX = 'submit_infra_unknown';

function shouldRecord(metadata: SponsorResultMetadata): boolean {
  if (ALWAYS_RECORDED_OUTCOMES.has(metadata.outcome)) {
    return true;
  }
  if (metadata.outcome === 'internal_error') {
    const reason = metadata.economics.failureReason;
    if (typeof reason === 'string' && reason.startsWith(SUBMIT_INFRA_FAILURE_REASON_PREFIX)) {
      return true;
    }
  }
  return false;
}

/** ISO timestamp source — pluggable for test determinism. */
type ClockFn = () => Date;

export interface SponsoredLogsRecorderDeps {
  readonly store: SponsoredLogsStoreAdapter;
  /** Inject a clock for deterministic test timestamps. */
  readonly clock?: ClockFn;
}

/**
 * Build the host-side recorder callback. Pass the returned function to
 * `RelayerApiConfig.onSponsorResult` (alongside other sponsor result
 * callbacks via a fan-out wrapper if multiple are needed).
 */
export function createSponsoredLogsRecorder(
  deps: SponsoredLogsRecorderDeps,
): SponsorResultCallback {
  const clock = deps.clock ?? (() => new Date());

  return async function recordSponsoredExecution(metadata: SponsorResultMetadata): Promise<void> {
    if (!shouldRecord(metadata)) {
      return;
    }

    let entry: SponsoredExecutionLogEntry;
    try {
      entry = buildLogEntry(metadata, clock);
    } catch (buildErr) {
      logStructuredEvent(
        SPONSORED_LOGS_RECORDER_FAILED,
        {
          stage: 'build_entry',
          mode: metadata.route,
          outcome: metadata.outcome,
          digest: metadata.digest,
          error: buildErr instanceof Error ? buildErr.message : String(buildErr),
        },
        'warn',
      );
      return;
    }

    try {
      await deps.store.append(entry);
    } catch (writeErr) {
      logStructuredEvent(
        SPONSORED_LOGS_RECORDER_FAILED,
        {
          stage: 'store_append',
          mode: metadata.route,
          outcome: metadata.outcome,
          digest: metadata.digest,
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        },
        'warn',
      );
    }
  };
}

function buildLogEntry(
  metadata: SponsorResultMetadata,
  clock: ClockFn,
): SponsoredExecutionLogEntry {
  const mode: SponsoredExecutionMode = metadata.route;
  const econ = metadata.economics;
  if (econ.economicsStatus === 'known') {
    return {
      schemaVersion: 1,
      createdAt: clock().toISOString(),
      mode,
      outcome: metadata.outcome,
      receiptId: metadata.receiptId,
      digest: metadata.digest ?? null,
      senderAddress: metadata.senderAddress,
      sponsorAddress: metadata.sponsorAddress,
      slotId: metadata.slotId,
      executionPathKey: metadata.executionPathKey,
      orderIdHash: metadata.orderIdHash,
      promotionId: metadata.promotionId,
      userId: metadata.userId,
      recoveredGasMist: econ.recoveredGasMist,
      hostPaidGasMist: econ.hostPaidGasMist,
      hostFeeMist: econ.hostFeeMist,
      protocolFeeMist: econ.protocolFeeMist,
      hostNetMist: econ.hostNetMist,
      grossGasMist: econ.grossGasMist,
      storageRebateMist: econ.storageRebateMist,
      economicsStatus: 'known',
      failureReason: econ.failureReason,
    };
  }
  return {
    schemaVersion: 1,
    createdAt: clock().toISOString(),
    mode,
    outcome: metadata.outcome,
    receiptId: metadata.receiptId,
    digest: metadata.digest ?? null,
    senderAddress: metadata.senderAddress,
    sponsorAddress: metadata.sponsorAddress,
    slotId: metadata.slotId,
    executionPathKey: metadata.executionPathKey,
    orderIdHash: metadata.orderIdHash,
    promotionId: metadata.promotionId,
    userId: metadata.userId,
    recoveredGasMist: null,
    hostPaidGasMist: null,
    hostFeeMist: null,
    protocolFeeMist: null,
    hostNetMist: null,
    grossGasMist: null,
    storageRebateMist: null,
    economicsStatus: 'unknown',
    failureReason: econ.failureReason,
  };
}

/**
 * Compose multiple `SponsorResultCallback`s into a single fan-out
 * callback. Each callback runs in sequence; rejections / throws are
 * caught per-callback so one failure cannot suppress the others.
 *
 * Each child callback owns a never-throws contract internally. A throw
 * escaping from a child is a contract violation and is surfaced as a
 * `SPONSOR_RESULT_CALLBACK_FAILED` warn so the operator sees the
 * failure even though the parent Release hook's try/catch never sees it
 * (the fan-out itself returns successfully to keep the never-throws
 * boundary intact for the remaining children and sponsor processing).
 *
 * Used by the host to combine the sponsor operations state callback with the
 * sponsored-execution recorder under the single
 * `RelayerApiConfig.onSponsorResult` slot.
 */
export function fanOutSponsorResult(
  ...callbacks: readonly SponsorResultCallback[]
): SponsorResultCallback {
  return async function fannedOut(metadata: SponsorResultMetadata): Promise<void> {
    for (let i = 0; i < callbacks.length; i++) {
      const cb = callbacks[i];
      try {
        await cb(metadata);
      } catch (cbErr) {
        logStructuredEvent(
          SPONSOR_RESULT_CALLBACK_FAILED,
          {
            source: 'sponsored_logs_fanout',
            callback_index: i,
            route: metadata.route,
            slot_id: metadata.slotId,
            // digest is the cross-reference key documented in
            // `docs/operations.md` (`SPONSOR_RESULT_CALLBACK_FAILED`
            // → recorder/state failure correlation by digest/slot).
            // null when the sponsor result path never reached submit.
            digest: metadata.digest ?? null,
            outcome: metadata.outcome,
            error: cbErr instanceof Error ? cbErr.message : String(cbErr),
          },
          'warn',
        );
      }
    }
  };
}
