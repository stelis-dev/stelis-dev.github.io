import type {
  AbuseBlockStatus,
  AbuseBlockerAdapter,
  AbuseBlockerConfig,
  AbuseSubject,
  SponsorFailureMeta,
} from './store/abuseBlockTypes.js';
import { logStructuredEvent } from './structuredEventLog.js';
import {
  ABUSE_BLOCK_CHECK_FAILED,
  SPONSOR_FAILURE_RECORDED,
  SPONSOR_FAILURE_RECORDER_FAILED,
} from './observability/events.js';
import { shouldIgnoreSponsorFailureForAbuse, type FailureCode } from './failures.js';

/**
 * Codes accepted by the shared sponsor-failure recorder.
 *
 * Generic Relay API transport projections are deliberately excluded: both
 * sponsor routes record the underlying event using `PREFLIGHT_FAILED` or
 * `ONCHAIN_REVERT` before the generic route maps its typed error to the public
 * `SPONSOR_*` response code.
 */
type SponsorFailureRecordCode = Exclude<
  FailureCode,
  'SPONSOR_PREFLIGHT_FAILED' | 'SPONSOR_ONCHAIN_FAILED'
>;

export const ABUSE_BLOCKED_CODE = 'ABUSE_BLOCKED';

/**
 * Availability defect: the abuse-blocker adapter (memory or Redis) raised
 * while servicing `checkIp` / `checkSubject`. The request cannot be
 * classified as abusive or clean, so the gate fails closed at the call
 * site and the caller rejects with HTTP 503 `BLOCK_CHECK_UNAVAILABLE`
 * rather than fail-open bypass or a misleading 500.
 */
export class BlockCheckUnavailableError extends Error {
  readonly code = 'BLOCK_CHECK_UNAVAILABLE' as const;
  constructor(message = 'Abuse block check is temporarily unavailable') {
    super(message);
    this.name = 'BlockCheckUnavailableError';
  }
}

export const DEFAULT_ABUSE_BLOCKER_CONFIG: AbuseBlockerConfig = {
  ipFailureWindowMs: 5 * 60 * 1000,
  ipFailureThreshold: 10,
  ipBlockDurationMs: 15 * 60 * 1000,
  addressDryRunWindowMs: 60 * 1000,
  addressDryRunThreshold: 3,
  addressBlockDurationMs: 15 * 60 * 1000,
  manipulationBlockDurationMs: 24 * 60 * 60 * 1000,
  // ONCHAIN_REVERT — higher threshold for TOCTOU tolerance
  addressOnchainRevertWindowMs: 5 * 60 * 1000,
  addressOnchainRevertThreshold: 5,
};

/**
 * Authoritative abuse-block gate. On adapter throw (Redis outage, memory
 * blocker internal error) the gate fails closed: a structured
 * `ABUSE_BLOCK_CHECK_FAILED` warn is emitted once at this shared branch and
 * a typed `BlockCheckUnavailableError` is thrown. Callers let the typed
 * error propagate to their route-outer `mapError` bridge, which renders
 * HTTP 503 `BLOCK_CHECK_UNAVAILABLE`. The gate does not fail open, does
 * not silently degrade, and does not record the adapter throw as an
 * abuse signal.
 *
 * `subject` is the typed non-IP subject. Generic `/relay/*` callers pass
 * `{ kind: 'address', address }`; Studio promotion callers pass
 * `{ kind: 'studio_user', userId }`. Pre-proof callers pass `undefined`,
 * which checks only the IP block.
 */
export async function checkBlockedRequest(
  blocker: AbuseBlockerAdapter,
  ip: string,
  subject?: AbuseSubject,
): Promise<AbuseBlockStatus> {
  try {
    const ipStatus = await blocker.checkIp(ip);
    if (ipStatus.blocked) return ipStatus;

    if (!subject) return { blocked: false };

    return await blocker.checkSubject(subject);
  } catch (err) {
    logStructuredEvent(
      ABUSE_BLOCK_CHECK_FAILED,
      {
        ip,
        ...subjectLogFields(subject),
        error: err instanceof Error ? err.message : String(err),
      },
      'warn',
    );
    throw new BlockCheckUnavailableError();
  }
}

/**
 * Record a sponsor failure for abuse tracking.
 *
 * Classification vocabulary lives in `failures.ts`
 * (`shouldIgnoreSponsorFailureForAbuse` / `isManipulationAttemptCode` /
 * `shouldCarveOutNonIpCounter`):
 *   - Ignored codes are silently skipped — they are not abuse signals
 *     (`NO_SPONSOR_SLOT`, `ABUSE_BLOCKED`, `REPREPARE_REQUIRED`,
 *     and any other code whose `FAILURE_TABLE` entry classifies as
 *     `ignored` or `drift`).
 *   - Manipulation codes trigger an immediate long-duration block
 *     inside the blocker adapter (`TAMPERING_DETECTED`,
 *     `P1_GASCOIN_FORBIDDEN`, `L2_UNAUTHORIZED_SETTLEMENT_SWAP_PATH`,
 *     `PROMO_DISALLOWED_TARGET`, …).
 *   - `shouldCarveOutNonIpCounter(code, meta)` applies the same typed-
 *     subject rule to address and studio-user counters: benign retry
 *     subcodes skip both families, while market-volatility subcodes skip
 *     only `PREFLIGHT_FAILED`. IP always increments.
 *
 * All other non-ignored codes are recorded against the normal windowed counters.
 *
 * For all non-ignored codes, a structured SPONSOR_FAILURE_RECORDED log is emitted BEFORE
 * the blocker adapter call, so observability is guaranteed regardless of adapter implementation.
 *
 * Recorder-adapter fault policy:
 *   Blocker adapter failures (e.g. Redis outage, memory blocker throw) are caught
 *   internally and must not mask the primary classified sponsor rejection. Sponsor
 *   handlers treat this function as a best-effort side-effect at every call site;
 *   if the adapter fails, the caller still returns the original 422/5xx classified
 *   rejection rather than an infrastructure 500 from the abuse infrastructure. A
 *   structured `SPONSOR_FAILURE_RECORDER_FAILED` event is emitted instead so operators
 *   can observe recorder degradation without call sites re-implementing the swallow
 *   pattern.
 *
 * @param meta  Optional structured metadata (subcode, executionPathKey) for log enrichment.
 */
export async function recordSponsorFailureForAbuse(
  blocker: AbuseBlockerAdapter,
  ip: string,
  subject: AbuseSubject | undefined,
  code: SponsorFailureRecordCode,
  meta?: SponsorFailureMeta,
): Promise<void> {
  if (shouldIgnoreSponsorFailureForAbuse(code)) return;

  // Structured log — emitted only for non-ignored codes (observability guarantee).
  // The subject kind drives the log field name: address-kind subjects log
  // `address: <addr>`, studio-user subjects log `userId: <uid>`. This
  // prevents structured-log consumers from interpreting a userId as an
  // on-chain address.
  logStructuredEvent(SPONSOR_FAILURE_RECORDED, {
    ip,
    ...subjectLogFields(subject),
    code,
    ...(meta?.subcode ? { subcode: meta.subcode } : {}),
    ...(meta?.executionPathKey ? { executionPathKey: meta.executionPathKey } : {}),
  });

  try {
    await blocker.recordSponsorFailure(ip, subject, code, meta);
  } catch (err) {
    // Swallow adapter failure. Caller is already on a classified-rejection path
    // and needs its primary error preserved. Emit a distinct structured event so
    // the recorder degradation is observable independently of SPONSOR_FAILURE_RECORDED.
    logStructuredEvent(
      SPONSOR_FAILURE_RECORDER_FAILED,
      {
        ip,
        ...subjectLogFields(subject),
        code,
        ...(meta?.subcode ? { subcode: meta.subcode } : {}),
        ...(meta?.executionPathKey ? { executionPathKey: meta.executionPathKey } : {}),
        error: err instanceof Error ? err.message : String(err),
      },
      'warn',
    );
  }
}

/**
 * Render an `AbuseSubject` into structured-log fields. Address-kind
 * subjects emit `address`; studio-user subjects emit `userId`. Returns
 * an empty object when the subject is undefined (pre-proof IP-only path).
 */
function subjectLogFields(subject: AbuseSubject | undefined): Record<string, string> {
  if (!subject) return {};
  return subject.kind === 'address' ? { address: subject.address } : { userId: subject.userId };
}

export function toBlockedError(status: AbuseBlockStatus): {
  error: string;
  code: typeof ABUSE_BLOCKED_CODE;
  retryAfterMs?: number;
} {
  return {
    error: 'Request temporarily blocked',
    code: ABUSE_BLOCKED_CODE,
    ...(status.retryAfterMs === undefined ? {} : { retryAfterMs: status.retryAfterMs }),
  };
}
