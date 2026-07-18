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
 *   - store.append and entry-build failures emit `SPONSORED_LOGS_RECORDER_FAILED`
 *     with enough context for triage, then reject the callback.
 *   - rejection keeps the durable final receipt's callback state pending;
 *     recovery retries the receipt-safe append until it succeeds.
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

function logRecorderFailure(
  metadata: SponsorResultMetadata,
  stage: 'build_entry' | 'store_append',
  error: unknown,
): void {
  try {
    logStructuredEvent(
      SPONSORED_LOGS_RECORDER_FAILED,
      {
        stage,
        mode: metadata.route,
        outcome: metadata.outcome,
        receipt_id: metadata.receiptId,
        digest: metadata.digest ?? null,
        error: error instanceof Error ? error.message : String(error),
      },
      'warn',
    );
  } catch {
    // Logging is diagnostic; it must not replace the delivery failure that
    // keeps the durable receipt pending.
  }
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

  return async function recordSponsoredExecution(
    metadata: SponsorResultMetadata,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!shouldRecord(metadata)) {
      return;
    }

    let entry: SponsoredExecutionLogEntry;
    try {
      entry = buildLogEntry(metadata, clock);
    } catch (buildErr) {
      logRecorderFailure(metadata, 'build_entry', buildErr);
      throw buildErr;
    }

    try {
      signal?.throwIfAborted();
      await deps.store.append(entry);
      signal?.throwIfAborted();
    } catch (writeErr) {
      signal?.throwIfAborted();
      logRecorderFailure(metadata, 'store_append', writeErr);
      throw writeErr;
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
 * Compose required idempotent `SponsorResultCallback`s into one durable
 * delivery boundary. Every callback runs once per attempt, even when an
 * earlier callback fails. After all callbacks have been attempted, any
 * failures are rethrown together so the final receipt remains pending.
 *
 * Used by the host to combine the sponsor operations state callback with the
 * sponsored-execution recorder under the single
 * `createHostContext` onSponsorResult callback slot.
 */
export function fanOutSponsorResult(
  ...callbacks: readonly SponsorResultCallback[]
): SponsorResultCallback {
  return async function fannedOut(
    metadata: SponsorResultMetadata,
    signal?: AbortSignal,
  ): Promise<void> {
    const failures: unknown[] = [];
    for (let i = 0; i < callbacks.length; i++) {
      signal?.throwIfAborted();
      const cb = callbacks[i];
      try {
        await cb(metadata, signal);
        signal?.throwIfAborted();
      } catch (cbErr) {
        signal?.throwIfAborted();
        failures.push(cbErr);
        try {
          logStructuredEvent(
            SPONSOR_RESULT_CALLBACK_FAILED,
            {
              source: 'sponsored_logs_fanout',
              callback_index: i,
              route: metadata.route,
              sponsor_address: metadata.sponsorAddress,
              receipt_id: metadata.receiptId,
              digest: metadata.digest ?? null,
              outcome: metadata.outcome,
              error: cbErr instanceof Error ? cbErr.message : String(cbErr),
            },
            'warn',
          );
        } catch {
          // All required consumers must still be attempted when the
          // observability sink itself is unavailable.
        }
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Sponsor result delivery failed for receipt ${metadata.receiptId}`,
      );
    }
  };
}
