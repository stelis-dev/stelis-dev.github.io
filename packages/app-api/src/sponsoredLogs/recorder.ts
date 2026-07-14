/**
 * Sponsored execution recorder — host-side `onSponsorResult` callback.
 *
 * Translates `SponsorResultMetadata` (host-only contract from
 * `@stelis/core-api`) into a `SponsoredExecutionLogEntry`
 * and writes it via the configured `SponsoredLogsStoreAdapter`.
 *
 * Execution-stage filter: only runs that reached an on-chain terminal
 * result, or whose landing became uncertain after the sponsor signature,
 * go into `Sponsored Executions`. The stage is runner-owned metadata;
 * diagnostic `failureReason` text is never parsed as authority.
 * Confirmed congestion and every pre-signature failure stay out of this
 * store because they did not execute on chain.
 *
 * Numeric honesty: every field on an `unknown`-economics row is `null`,
 * including `hostFeeMist`. The recorder MUST NOT coerce an unknown
 * fee to `"0"` — that would manufacture a value the sponsor result path could
 * not prove.
 *
 * Failure semantics:
 *   - never throws — primary sponsor response must not be affected.
 *   - store.append rejection emits `SPONSORED_LOGS_RECORDER_FAILED` with
 *     enough context for triage (receipt, digest, mode, outcome, error message).
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
import type {
  SponsoredExecutionLogEntry,
  SponsoredExecutionLogOutcome,
  SponsoredExecutionMode,
} from './types.js';
import { isSponsoredExecutionLogOutcome } from './types.js';

type RecordableSponsorResultMetadata = SponsorResultMetadata & {
  readonly outcome: SponsoredExecutionLogOutcome;
};

function shouldRecord(
  metadata: SponsorResultMetadata,
): metadata is RecordableSponsorResultMetadata {
  if (!isSponsoredExecutionLogOutcome(metadata.outcome)) {
    return false;
  }
  if (metadata.executionStage === 'on_chain') {
    return true;
  }
  return (
    metadata.executionStage === 'after_sponsor_signature' && metadata.outcome === 'internal_error'
  );
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
 * the `createHostContext` onSponsorResult callback (alongside other sponsor result
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
          receipt_id: metadata.receiptId,
          digest: metadata.digest ?? null,
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
          receipt_id: metadata.receiptId,
          digest: metadata.digest ?? null,
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        },
        'warn',
      );
    }
  };
}

function buildLogEntry(
  metadata: RecordableSponsorResultMetadata,
  clock: ClockFn,
): SponsoredExecutionLogEntry {
  const mode: SponsoredExecutionMode = metadata.route;
  const econ = metadata.economics;
  // A post-signature uncertainty cannot prove what landed. Even if a buggy
  // producer supplies numeric economics, persist the row as unknown rather
  // than manufacturing certainty at the host boundary.
  if (econ.economicsStatus === 'known' && metadata.executionStage !== 'after_sponsor_signature') {
    return {
      createdAt: clock().toISOString(),
      mode,
      outcome: metadata.outcome,
      receiptId: metadata.receiptId,
      digest: metadata.digest ?? null,
      senderAddress: metadata.senderAddress,
      sponsorAddress: metadata.sponsorAddress,
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
    createdAt: clock().toISOString(),
    mode,
    outcome: metadata.outcome,
    receiptId: metadata.receiptId,
    digest: metadata.digest ?? null,
    senderAddress: metadata.senderAddress,
    sponsorAddress: metadata.sponsorAddress,
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
 * `createHostContext` onSponsorResult callback slot.
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
            sponsor_address: metadata.sponsorAddress,
            receipt_id: metadata.receiptId,
            // digest is the cross-reference key documented in
            // `docs/operations.md` (`SPONSOR_RESULT_CALLBACK_FAILED`
            // → recorder/state failure correlation by digest/sponsor address).
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
