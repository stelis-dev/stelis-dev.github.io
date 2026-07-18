/**
 * Static structured-event names owned by `@stelis/core-api`.
 *
 * Scope: events emitted via the server-interior sink at
 * `../structuredEventLog.ts`. Redis-backed admin audit logs written
 * by `packages/app-api/src/adminAuditLog.ts` are a separate observability
 * path and are out of scope for this file.
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
export const PREPARE_SLOT_EXHAUSTED = 'PREPARE_SLOT_EXHAUSTED';

// ─────────────────────────────────────────────
// Sponsor runtime
// ─────────────────────────────────────────────

export const SPONSOR_FAILURE_RECORDED = 'SPONSOR_FAILURE_RECORDED';
export const SPONSOR_FAILURE_RECORDER_FAILED = 'SPONSOR_FAILURE_RECORDER_FAILED';
export const ABUSE_BLOCK_CHECK_FAILED = 'ABUSE_BLOCK_CHECK_FAILED';
export const SPONSOR_SENDER_STORE_DIVERGENCE = 'SPONSOR_SENDER_STORE_DIVERGENCE';
export const SPONSOR_DRIFT_OBSERVED = 'SPONSOR_DRIFT_OBSERVED';
export const SETTLEMENT_ECONOMICS_EXECUTION = 'SETTLEMENT_ECONOMICS_EXECUTION';
export const SETTLEMENT_ECONOMICS_LOG_FAILED = 'SETTLEMENT_ECONOMICS_LOG_FAILED';

// ─────────────────────────────────────────────
// Sponsor pool / lease
// ─────────────────────────────────────────────

export const SPONSOR_POOL_LEASE_CHECKOUT = 'SPONSOR_POOL_LEASE_CHECKOUT';
export const SPONSOR_POOL_LEASE_CHECKIN = 'SPONSOR_POOL_LEASE_CHECKIN';
export const SPONSOR_POOL_LEASE_EXHAUSTED = 'SPONSOR_POOL_LEASE_EXHAUSTED';
export const SPONSOR_POOL_SIGN = 'SPONSOR_POOL_SIGN';
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

// A retained SponsorOperations task failed before it could complete its own
// durable transition. Raw balance observations are never rewritten from this
// event path; the scheduler only reports the failure and keeps one retained retry timer.
export const SPONSOR_OPERATIONS_TASK_FAILED = 'SPONSOR_OPERATIONS_TASK_FAILED';

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
export const PROMOTION_SPONSOR_EXECUTION = 'PROMOTION_SPONSOR_EXECUTION';

// ─────────────────────────────────────────────
// Execution-ledger lifecycle
// ─────────────────────────────────────────────

export const LEDGER_RELEASE_FAILED_IN_HANDLER = 'LEDGER_RELEASE_FAILED_IN_HANDLER';
export const LEDGER_RELEASE_THREW_IN_HANDLER = 'LEDGER_RELEASE_THREW_IN_HANDLER';
export const PROMOTION_EXECUTION_LEDGER_REAPER_ERROR = 'PROMOTION_EXECUTION_LEDGER_REAPER_ERROR';
export const ABUSE_BLOCK_EXPIRY_TASK_FAILED = 'ABUSE_BLOCK_EXPIRY_TASK_FAILED';
