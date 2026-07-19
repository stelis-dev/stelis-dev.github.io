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

/**
 * Availability defect: the abuse-blocker adapter (memory or Redis) raised
 * while servicing `checkIp` / `checkSubject`. The request cannot be
 * classified as abusive or clean, so the gate fails closed at the call
 * site and the caller rejects with HTTP 503 `BLOCK_CHECK_UNAVAILABLE`
 * rather than fail-open bypass or a misleading 500.
 */
export class BlockCheckUnavailableError extends Error {
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

declare const admittedClientIpBrand: unique symbol;

/**
 * Opaque proof that the Host completed the authoritative IP block check and
 * the IP was not blocked. The value intentionally exposes no raw-IP field.
 * Runtime consumers must unwrap it through this module, which rejects forged
 * structural values in addition to the compile-time nominal brand.
 */
export interface AdmittedClientIp {
  readonly [admittedClientIpBrand]: true;
}

export type ClientIpAdmissionResult =
  | {
      readonly blocked: true;
      readonly reason?: AbuseBlockStatus['reason'];
      readonly retryAfterMs?: number;
      readonly scope?: AbuseBlockStatus['scope'];
    }
  | {
      readonly blocked: false;
      readonly admittedClientIp: AdmittedClientIp;
    };

interface AdmittedClientIpValue {
  readonly blocker: AbuseBlockerAdapter;
  readonly ip: string;
}

const admittedClientIpValues = new WeakMap<object, AdmittedClientIpValue>();

/**
 * Authoritative, one-time IP admission gate. A token is minted only after the
 * adapter returns an unblocked result. Adapter failures fail closed as
 * `BlockCheckUnavailableError`; blocked results never carry a token.
 */
export async function admitClientIp(
  blocker: AbuseBlockerAdapter,
  ip: string,
): Promise<ClientIpAdmissionResult> {
  try {
    const status = await blocker.checkIp(ip);
    if (status.blocked) {
      return {
        blocked: true,
        ...(status.reason === undefined ? {} : { reason: status.reason }),
        ...(status.retryAfterMs === undefined ? {} : { retryAfterMs: status.retryAfterMs }),
        ...(status.scope === undefined ? {} : { scope: status.scope }),
      };
    }

    const admittedClientIp = Object.freeze(Object.create(null)) as AdmittedClientIp;
    admittedClientIpValues.set(admittedClientIp, { blocker, ip });
    return { blocked: false, admittedClientIp };
  } catch (err) {
    logStructuredEvent(
      ABUSE_BLOCK_CHECK_FAILED,
      {
        ip,
        error: err instanceof Error ? err.message : String(err),
      },
      'warn',
    );
    throw new BlockCheckUnavailableError();
  }
}

export async function checkBlockedSubject(
  blocker: AbuseBlockerAdapter,
  admittedClientIp: AdmittedClientIp,
  subject: AbuseSubject,
): Promise<AbuseBlockStatus> {
  const admitted = readAdmittedClientIpValue(admittedClientIp);
  if (admitted.blocker !== blocker) {
    throw new TypeError(
      'AdmittedClientIp must be a token created by admitClientIp for the same blocker',
    );
  }
  try {
    return await blocker.checkSubject(subject);
  } catch (err) {
    logStructuredEvent(
      ABUSE_BLOCK_CHECK_FAILED,
      {
        ip: admitted.ip,
        ...subjectLogFields(subject),
        error: err instanceof Error ? err.message : String(err),
      },
      'warn',
    );
    throw new BlockCheckUnavailableError();
  }
}

/** Raw projection for Host-owned durable records, limiter keys, and logs. */
export function readAdmittedClientIp(admittedClientIp: AdmittedClientIp): string {
  return readAdmittedClientIpValue(admittedClientIp).ip;
}

function readAdmittedClientIpValue(admittedClientIp: AdmittedClientIp): AdmittedClientIpValue {
  if (
    (typeof admittedClientIp !== 'object' && typeof admittedClientIp !== 'function') ||
    admittedClientIp === null
  ) {
    throw new TypeError('AdmittedClientIp must be a token created by admitClientIp');
  }
  const value = admittedClientIpValues.get(admittedClientIp);
  if (value === undefined) {
    throw new TypeError('AdmittedClientIp must be a token created by admitClientIp');
  }
  return value;
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
