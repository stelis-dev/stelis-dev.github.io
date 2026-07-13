import { DEFAULT_ABUSE_BLOCKER_CONFIG } from '../abuseBlocking.js';
import {
  getFailurePolicy,
  isManipulationAttemptCode,
  shouldCarveOutNonIpCounter,
  shouldIgnoreSponsorFailureForAbuse,
  subjectCounterFamily,
} from '../failures.js';
import type {
  AbuseBlockStatus,
  AbuseBlockerAdapter,
  AbuseBlockerConfig,
  AbuseSubject,
} from './abuseBlockTypes.js';
import { ensureBoundedCapacity } from './boundedMapEvict.js';
import { type Clock, systemClock } from '../clock.js';
import { validateAbuseBlockerConfig } from './abuseBlockConfig.js';

interface CounterEntry {
  count: number;
  expiresAt: number;
}

interface BlockEntry {
  reason: string;
  expiresAt: number;
}

/** Maximum tracked keys per counter Map (memory DoS prevention). */
const MAX_COUNTER_KEYS = 50_000;

/** Maximum tracked keys per block Map (memory DoS prevention). */
const MAX_BLOCK_KEYS = 100_000;

export class MemoryAbuseBlocker implements AbuseBlockerAdapter {
  private readonly _config: AbuseBlockerConfig;
  private readonly _ipFailures = new Map<string, CounterEntry>();
  private readonly _addressDryRunFailures = new Map<string, CounterEntry>();
  private readonly _addressOnchainRevertFailures = new Map<string, CounterEntry>();
  private readonly _studioUserDryRunFailures = new Map<string, CounterEntry>();
  private readonly _studioUserOnchainRevertFailures = new Map<string, CounterEntry>();
  private readonly _ipBlocks = new Map<string, BlockEntry>();
  private readonly _addressBlocks = new Map<string, BlockEntry>();
  private readonly _studioUserBlocks = new Map<string, BlockEntry>();
  private readonly _clock: Clock;

  constructor(config: Partial<AbuseBlockerConfig> = {}, clock: Clock = systemClock) {
    this._config = validateAbuseBlockerConfig({ ...DEFAULT_ABUSE_BLOCKER_CONFIG, ...config });
    this._clock = clock;
  }

  async checkIp(ip: string): Promise<AbuseBlockStatus> {
    return this.checkBlockMap(this._ipBlocks, ip, 'ip');
  }

  async checkSubject(subject: AbuseSubject): Promise<AbuseBlockStatus> {
    if (subject.kind === 'address') {
      return this.checkBlockMap(this._addressBlocks, subject.address, 'address');
    }
    return this.checkBlockMap(this._studioUserBlocks, subject.userId, 'studio_user');
  }

  async recordSponsorFailure(
    ip: string,
    subject: AbuseSubject | undefined,
    code: string,
    meta?: import('./abuseBlockTypes.js').SponsorFailureMeta,
  ): Promise<void> {
    const now = this._clock.nowMs();

    if (shouldIgnoreSponsorFailureForAbuse(code)) {
      return;
    }

    if (isManipulationAttemptCode(code)) {
      this.setBlock(
        this._ipBlocks,
        ip,
        `manipulation:${code}`,
        now + this._config.manipulationBlockDurationMs,
      );
      if (subject) {
        const { blocks } = this.subjectStore(subject);
        const subjectKey = subjectKeyOf(subject);
        this.setBlock(
          blocks,
          subjectKey,
          `manipulation:${code}`,
          now + this._config.manipulationBlockDurationMs,
        );
      }
      return;
    }

    // Failure policy lookup. Codes outside the public HTTP + promotion-abuse
    // table fall through with `policy === undefined`; treat that as
    // `abuseImpact = COUNT_BOTH`. The IP counter still applies; the
    // subject counter only fires when a family is mapped.
    const policy = getFailurePolicy(code);
    const ipImpact = policy?.abuseImpact.ip ?? 'count';
    const subjectImpact = policy?.abuseImpact.subject ?? 'count';

    if (ipImpact === 'count') {
      this.recordCounter(this._ipFailures, ip, this._config.ipFailureWindowMs, now);
      const ipFailureCount = this._ipFailures.get(ip)?.count ?? 0;
      if (ipFailureCount > this._config.ipFailureThreshold) {
        this.setBlock(
          this._ipBlocks,
          ip,
          'sponsor_failure_threshold',
          now + this._config.ipBlockDurationMs,
        );
      }
    }

    // Non-IP counter family routing. `abuseImpact.subject === 'count'`
    // says the policy permits a subject-level increment;
    // `subjectCounterFamily(code)` resolves which storage tier
    // (sim_tier / revert) the increment lands in. Codes whose family is
    // `null` (most `normal` and promotion-abuse codes) get IP-only
    // tracking. `shouldCarveOutNonIpCounter(code, meta)` preserves the
    // separate benign-retry and preflight-only market policies.
    const family = subjectCounterFamily(code);
    if (
      subject &&
      subjectImpact === 'count' &&
      family !== null &&
      !shouldCarveOutNonIpCounter(code, meta)
    ) {
      if (family === 'sim_tier') {
        const { dryRunFailures, blocks } = this.subjectStore(subject);
        const subjectKey = subjectKeyOf(subject);
        this.recordCounter(dryRunFailures, subjectKey, this._config.addressDryRunWindowMs, now);
        const dryRunCount = dryRunFailures.get(subjectKey)?.count ?? 0;
        if (dryRunCount > this._config.addressDryRunThreshold) {
          this.setBlock(
            blocks,
            subjectKey,
            'dry_run_failure_threshold',
            now + this._config.addressBlockDurationMs,
          );
        }
      } else if (family === 'revert') {
        const { onchainRevertFailures, blocks } = this.subjectStore(subject);
        const subjectKey = subjectKeyOf(subject);
        this.recordCounter(
          onchainRevertFailures,
          subjectKey,
          this._config.addressOnchainRevertWindowMs,
          now,
        );
        const revertCount = onchainRevertFailures.get(subjectKey)?.count ?? 0;
        if (revertCount > this._config.addressOnchainRevertThreshold) {
          this.setBlock(
            blocks,
            subjectKey,
            'onchain_revert_threshold',
            now + this._config.addressBlockDurationMs,
          );
        }
      }
    }
  }

  /**
   * Resolve the per-kind counter and block maps for the typed subject. The
   * address kind owns address-keyed maps; the studio_user kind owns
   * studio-user-keyed maps. Counters and blocks are isolated by kind so a
   * studio-user subject's counter cannot increment an address bucket and
   * vice versa.
   */
  private subjectStore(subject: AbuseSubject): {
    dryRunFailures: Map<string, CounterEntry>;
    onchainRevertFailures: Map<string, CounterEntry>;
    blocks: Map<string, BlockEntry>;
  } {
    if (subject.kind === 'address') {
      return {
        dryRunFailures: this._addressDryRunFailures,
        onchainRevertFailures: this._addressOnchainRevertFailures,
        blocks: this._addressBlocks,
      };
    }
    return {
      dryRunFailures: this._studioUserDryRunFailures,
      onchainRevertFailures: this._studioUserOnchainRevertFailures,
      blocks: this._studioUserBlocks,
    };
  }

  private checkBlockMap(
    blocks: Map<string, BlockEntry>,
    key: string,
    scope: 'ip' | 'address' | 'studio_user',
  ): AbuseBlockStatus {
    const now = this._clock.nowMs();
    const entry = blocks.get(key);
    if (!entry) return { blocked: false };
    if (entry.expiresAt <= now) {
      blocks.delete(key);
      return { blocked: false };
    }
    return {
      blocked: true,
      scope,
      reason: entry.reason,
      retryAfterMs: Math.max(entry.expiresAt - now, 0),
    };
  }

  private recordCounter(
    counters: Map<string, CounterEntry>,
    key: string,
    windowMs: number,
    now: number,
  ): void {
    const existing = counters.get(key);
    if (!existing || existing.expiresAt <= now) {
      // Bounded eviction: expired first → oldest live evict.
      // Never skips tracking — prevents fail-open under saturation.
      if (!existing) {
        ensureBoundedCapacity(
          counters,
          MAX_COUNTER_KEYS,
          (v) => v.expiresAt <= now,
          (v) => v.expiresAt,
        );
      }
      counters.set(key, { count: 1, expiresAt: now + windowMs });
      return;
    }
    existing.count += 1;
  }

  /**
   * Set or update a block entry with bounded memory protection.
   *
   * When at capacity:
   *   1. Evict expired entries
   *   2. If still full, replace the entry closest to expiry (evict-oldest)
   *
   * Never skips a new block — prevents security inversion (fail-open).
   */
  private setBlock(
    blocks: Map<string, BlockEntry>,
    key: string,
    reason: string,
    expiresAt: number,
  ): void {
    // Existing key update — no growth, always allowed
    if (blocks.has(key)) {
      blocks.set(key, { reason, expiresAt });
      return;
    }

    // New key — check capacity
    if (blocks.size >= MAX_BLOCK_KEYS) {
      const now = this._clock.nowMs();
      this.evictExpiredBlocks(blocks, now);

      // Still full — evict the entry closest to expiry to make room
      if (blocks.size >= MAX_BLOCK_KEYS) {
        this.evictOldestBlock(blocks);
      }
    }

    blocks.set(key, { reason, expiresAt });
  }

  private evictExpiredBlocks(blocks: Map<string, BlockEntry>, now: number): void {
    for (const [key, entry] of blocks) {
      if (entry.expiresAt <= now) {
        blocks.delete(key);
      }
    }
  }

  /** Remove the block entry with the earliest expiresAt (closest to expiry). */
  private evictOldestBlock(blocks: Map<string, BlockEntry>): void {
    let oldestKey: string | null = null;
    let oldestExpiresAt = Infinity;
    for (const [key, entry] of blocks) {
      if (entry.expiresAt < oldestExpiresAt) {
        oldestKey = key;
        oldestExpiresAt = entry.expiresAt;
      }
    }
    if (oldestKey) blocks.delete(oldestKey);
  }
}

function subjectKeyOf(subject: AbuseSubject): string {
  return subject.kind === 'address' ? subject.address : subject.userId;
}
