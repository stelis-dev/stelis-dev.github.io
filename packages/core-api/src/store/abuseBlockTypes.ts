import type { AbuseBlockReason, AdminBlockScope } from '@stelis/contracts';

/**
 * Typed abuse subject. The non-IP enforcement principal differs by route
 * family:
 *   - Generic `/relay/*` keys non-IP counters by Sui `senderAddress` (the
 *     mutable execution credential is also the principal because no
 *     pre-proof developer identity exists).
 *   - Studio promotion routes key non-IP counters by verified developer
 *     JWT `userId`. `senderAddress` remains a mutable execution credential
 *     bound by the JWT for the current action only; it is not the
 *     long-lived enforcement principal.
 *
 * The typed union prevents accidental cross-subject leakage at call sites:
 * a string parameter named `address` cannot accept a `userId`, and
 * adapter implementations switch on `subject.kind` to choose the correct
 * map / Redis prefix / structured-log field.
 */
export type AbuseSubject =
  | { kind: 'address'; address: string }
  | { kind: 'studio_user'; userId: string };

export interface AbuseBlockStatus {
  blocked: boolean;
  reason?: AbuseBlockReason;
  retryAfterMs?: number;
  scope?: AdminBlockScope;
}

/** Optional structured metadata attached to sponsor failure records for observability. */
export interface SponsorFailureMeta {
  /** Subcode from the underlying error (e.g. 'INSUFFICIENT_SETTLE_INPUT'). */
  subcode?: string;
  /** Canonical execution path key from the PreparedTxEntry. */
  executionPathKey?: string;
}

export interface AbuseBlockerConfig {
  ipFailureWindowMs: number;
  ipFailureThreshold: number;
  ipBlockDurationMs: number;
  /**
   * Non-IP simulation-tier (DRY_RUN_FAILED + PREFLIGHT_FAILED) failure
   * window and threshold. The same numeric thresholds gate both the
   * Sui-address counter (generic route) and the Studio-user counter
   * (promotion route). Counters are isolated per subject kind; only the
   * threshold values are shared.
   */
  addressDryRunWindowMs: number;
  addressDryRunThreshold: number;
  /** Non-IP block duration applied uniformly across address and studio-user kinds. */
  addressBlockDurationMs: number;
  manipulationBlockDurationMs: number;
  /** Non-IP on-chain-revert window and threshold (TOCTOU tolerance, separate from simulation-tier). */
  addressOnchainRevertWindowMs: number;
  addressOnchainRevertThreshold: number;
}

export interface AbuseBlockerAdapter {
  checkIp(ip: string): Promise<AbuseBlockStatus>;
  /**
   * Non-IP block check for the typed subject (address or studio_user).
   * Adapter implementations route the lookup to the correct internal
   * structure (per-kind map for memory; per-kind Redis prefix for redis).
   */
  checkSubject(subject: AbuseSubject): Promise<AbuseBlockStatus>;
  /**
   * Record a sponsor failure event. The IP counter is always considered.
   * The non-IP counter is keyed by the typed subject kind when present;
   * pre-proof failures (subject undefined) record only the IP counter.
   */
  recordSponsorFailure(
    ip: string,
    subject: AbuseSubject | undefined,
    code: string,
    meta?: SponsorFailureMeta,
  ): Promise<void>;
}
