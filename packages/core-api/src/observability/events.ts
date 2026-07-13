/**
 * Structured-event names for all stdout-path observability events
 * emitted by this repository.
 *
 * Scope: events emitted via `logStructuredEvent` / `logSponsorPoolEvent`
 * (server-interior sinks at `../structuredEventLog.ts` /
 * `../sponsorPoolEventLog.ts`). Redis-backed admin audit logs written
 * by `packages/app-api/src/adminAuditLog.ts` are a separate observability
 * path and are out of scope for this file.
 *
 * The public operations summary is in `docs/operations.md#observability`.
 * This file remains the runtime event-name list. Do not mention a separate
 * event registry document or registry-check script unless those files exist
 * in this repository.
 */

// ─────────────────────────────────────────────
// Prepare pipeline
// ─────────────────────────────────────────────

export const PREPARE_STAGE = 'PREPARE_STAGE';
export const PREPARE_BUILD_STAGE = 'PREPARE_BUILD_STAGE';
export const PREPARE_INFLIGHT_ACQUIRED = 'PREPARE_INFLIGHT_ACQUIRED';
export const PREPARE_INFLIGHT_RELEASED = 'PREPARE_INFLIGHT_RELEASED';
export const PREPARE_INFLIGHT_REJECTED = 'PREPARE_INFLIGHT_REJECTED';
export const PREPARE_INFLIGHT_RELEASE_FAILED = 'PREPARE_INFLIGHT_RELEASE_FAILED';
export const PREPARE_ENTRY_CORRUPT = 'PREPARE_ENTRY_CORRUPT';
export const PREPARE_STORE_EVICT_CALLBACK_FAILED = 'PREPARE_STORE_EVICT_CALLBACK_FAILED';
export const PREPARE_STORE_EVICT_CLEANUP_FAILED = 'PREPARE_STORE_EVICT_CLEANUP_FAILED';
export const PREPARE_STORE_EVICT_CLEANUP_THREW = 'PREPARE_STORE_EVICT_CLEANUP_THREW';
export const PREPARE_SLOT_EXHAUSTED = 'PREPARE_SLOT_EXHAUSTED';

// ─────────────────────────────────────────────
// Sponsor runtime
// ─────────────────────────────────────────────

export const SPONSOR_FAILURE_RECORDED = 'SPONSOR_FAILURE_RECORDED';
export const SPONSOR_FAILURE_RECORDER_FAILED = 'SPONSOR_FAILURE_RECORDER_FAILED';
export const ABUSE_BLOCK_CHECK_FAILED = 'ABUSE_BLOCK_CHECK_FAILED';
export const SPONSOR_SENDER_STORE_DIVERGENCE = 'SPONSOR_SENDER_STORE_DIVERGENCE';
export const SPONSOR_EXEC_GAS_USED_MISSING = 'SPONSOR_EXEC_GAS_USED_MISSING';
export const SPONSOR_DRIFT_OBSERVED = 'SPONSOR_DRIFT_OBSERVED';
export const SETTLEMENT_ECONOMICS_EXECUTION = 'SETTLEMENT_ECONOMICS_EXECUTION';
export const SETTLEMENT_ECONOMICS_LOG_FAILED = 'SETTLEMENT_ECONOMICS_LOG_FAILED';

// ─────────────────────────────────────────────
// Sponsor pool / lease
// ─────────────────────────────────────────────

export const SPONSOR_POOL_LEASE_CHECKOUT = 'SPONSOR_POOL_LEASE_CHECKOUT';
export const SPONSOR_POOL_LEASE_COMMITTED = 'SPONSOR_POOL_LEASE_COMMITTED';
export const SPONSOR_POOL_LEASE_CHECKIN = 'SPONSOR_POOL_LEASE_CHECKIN';
export const SPONSOR_POOL_LEASE_EXHAUSTED = 'SPONSOR_POOL_LEASE_EXHAUSTED';
export const SPONSOR_POOL_LEASE_RELEASE = 'SPONSOR_POOL_LEASE_RELEASE';
export const SPONSOR_POOL_LEASE_RELEASE_FAILED = 'SPONSOR_POOL_LEASE_RELEASE_FAILED';
export const SPONSOR_POOL_SIGN = 'SPONSOR_POOL_SIGN';
export const SPONSOR_POOL_SLOT_INFO_UNRECOVERABLE = 'SPONSOR_POOL_SLOT_INFO_UNRECOVERABLE';
export const SPONSOR_POOL_CHECKIN_FAILED = 'SPONSOR_POOL_CHECKIN_FAILED';
export const SPONSOR_RESULT_CALLBACK_FAILED = 'SPONSOR_RESULT_CALLBACK_FAILED';

// ─────────────────────────────────────────────
// Sponsor operations state store
// ─────────────────────────────────────────────

// Shared sponsor operations state-store write failure. Emitted when a host-side
// writer cannot commit a slot or sponsor refill account state update to Redis —
// including the fallback-after-probe-failure path — or when a defensive
// outer catch in the sponsor result callback traps an unexpected escape. The
// `source` payload field discriminates the concrete emit site.
export const SPONSOR_OPERATIONS_STATE_WRITE_FAILED = 'SPONSOR_OPERATIONS_STATE_WRITE_FAILED';

// ─────────────────────────────────────────────
// Sponsored execution recorder
// ─────────────────────────────────────────────

// Recorder write failed end-to-end (idempotency / aggregate / recent
// list). Emitted by the host-side sponsored-execution recorder when the
// store.append call rejected. Sponsor stateMachineResult primary response is
// preserved; this event is the only operator signal of the lost write.
export const SPONSORED_LOGS_RECORDER_FAILED = 'SPONSORED_LOGS_RECORDER_FAILED';

// ─────────────────────────────────────────────
// Promotion / studio
// ─────────────────────────────────────────────

export const PROMOTION_ABUSE_RECORDED = 'PROMOTION_ABUSE_RECORDED';
export const PROMOTION_ABUSE_RECORDER_FAILED = 'PROMOTION_ABUSE_RECORDER_FAILED';
export const PROMOTION_GAS_OVERRUN_WARNING = 'PROMOTION_GAS_OVERRUN_WARNING';
export const PROMOTION_USAGE_RECORDER_FAILED = 'PROMOTION_USAGE_RECORDER_FAILED';
export const PROMOTION_SPONSOR_EXECUTION = 'PROMOTION_SPONSOR_EXECUTION';

// Uncertain landing after `pool.sign()` issued the sponsor signature. The
// transaction may have reached the network, but the Host could not prove a
// terminal result. Operators reconcile by senderAddress + receiptId +
// submitted-time window (digest is unavailable at the uncertainty boundary).
export const PROMOTION_SPONSOR_POST_SIGNATURE_UNCERTAINTY =
  'PROMOTION_SPONSOR_POST_SIGNATURE_UNCERTAINTY';

// ─────────────────────────────────────────────
// Execution-ledger lifecycle
// ─────────────────────────────────────────────

export const LEDGER_RELEASE_FAILED_IN_HANDLER = 'LEDGER_RELEASE_FAILED_IN_HANDLER';
export const LEDGER_RELEASE_THREW_IN_HANDLER = 'LEDGER_RELEASE_THREW_IN_HANDLER';
// Failure-path consume helper events. Mirror the release pair for the
// post-signature/post-submit consume branches.
// `_FAILED_IN_HANDLER`: `ConsumeResult.ok === false` (e.g.
// `reservation_not_found`). `_THREW_IN_HANDLER`: adapter call threw.
// Both preserve the primary sponsor error and signal that the reservation
// may still be eligible for the ExecutionLedger reservation reaper release
// path.
export const LEDGER_CONSUME_FAILED_IN_HANDLER = 'LEDGER_CONSUME_FAILED_IN_HANDLER';
export const LEDGER_CONSUME_THREW_IN_HANDLER = 'LEDGER_CONSUME_THREW_IN_HANDLER';
export const PROMOTION_EXECUTION_LEDGER_REAPER_ERROR = 'PROMOTION_EXECUTION_LEDGER_REAPER_ERROR';

// ─────────────────────────────────────────────
// Redis / infrastructure
// ─────────────────────────────────────────────

export const REDIS_SCAN_UNAVAILABLE = 'REDIS_SCAN_UNAVAILABLE';

// ─────────────────────────────────────────────
// Sui RPC transport (bounded dynamic family)
// ─────────────────────────────────────────────

/**
 * Emitter: `packages/app-api/src/sui/failoverTransport.ts:358`.
 * Name set is bounded at compile time by the `FailoverEvent.type`
 * literal union at `failoverTransport.ts:94`. The emitter builds the
 * name via `` `SUI_RPC_${event.type}` `` from the typed union, so the
 * name set is exactly the three constants below.
 */
export const SUI_RPC_FAILOVER = 'SUI_RPC_FAILOVER';
export const SUI_RPC_ENDPOINT_COOLDOWN = 'SUI_RPC_ENDPOINT_COOLDOWN';
export const SUI_RPC_ALL_EXHAUSTED = 'SUI_RPC_ALL_EXHAUSTED';
