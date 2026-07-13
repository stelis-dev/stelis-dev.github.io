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
import type { RedisClientLike } from './redisClient.js';
import { type Clock, systemClock } from '../clock.js';
import { validateAbuseBlockerConfig } from './abuseBlockConfig.js';
import { FIXED_WINDOW_INCR_SCRIPT, parseFixedWindowResult } from './redisFixedWindowCounter.js';

interface RedisBlockEntry {
  reason: string;
  blockedUntil: number;
}

export interface RedisAbuseBlockerOptions {
  ipFailurePrefix?: string;
  addressDryRunPrefix?: string;
  ipBlockPrefix?: string;
  addressBlockPrefix?: string;
  /** Optional `Clock` for JS-side blockedUntil computation. Defaults to `systemClock`. */
  clock?: Clock;
}

export class RedisAbuseBlocker implements AbuseBlockerAdapter {
  private readonly _client: RedisClientLike;
  private readonly _config: AbuseBlockerConfig;
  private readonly _ipFailurePrefix: string;
  private readonly _addressDryRunPrefix: string;
  private readonly _addressOnchainRevertPrefix: string;
  private readonly _studioUserDryRunPrefix: string;
  private readonly _studioUserOnchainRevertPrefix: string;
  private readonly _ipBlockPrefix: string;
  private readonly _addressBlockPrefix: string;
  private readonly _studioUserBlockPrefix: string;
  private readonly _clock: Clock;

  constructor(
    client: RedisClientLike,
    config: Partial<AbuseBlockerConfig> = {},
    options: RedisAbuseBlockerOptions = {},
  ) {
    this._client = client;
    this._config = validateAbuseBlockerConfig({ ...DEFAULT_ABUSE_BLOCKER_CONFIG, ...config });
    this._ipFailurePrefix = options.ipFailurePrefix ?? 'stelis:abuse:ip_fail:';
    this._addressDryRunPrefix = options.addressDryRunPrefix ?? 'stelis:abuse:address_dry_run:';
    this._addressOnchainRevertPrefix = 'stelis:abuse:address_onchain_revert:';
    this._studioUserDryRunPrefix = 'stelis:abuse:studio_user_dry_run:';
    this._studioUserOnchainRevertPrefix = 'stelis:abuse:studio_user_onchain_revert:';
    this._ipBlockPrefix = options.ipBlockPrefix ?? 'stelis:abuse:block:ip:';
    this._addressBlockPrefix = options.addressBlockPrefix ?? 'stelis:abuse:block:address:';
    this._studioUserBlockPrefix = 'stelis:abuse:block:studio_user:';
    this._clock = options.clock ?? systemClock;
  }

  async checkIp(ip: string): Promise<AbuseBlockStatus> {
    return this.checkBlock(this.ipBlockKey(ip), 'ip');
  }

  async checkSubject(subject: AbuseSubject): Promise<AbuseBlockStatus> {
    if (subject.kind === 'address') {
      return this.checkBlock(this.addressBlockKey(subject.address), 'address');
    }
    return this.checkBlock(this.studioUserBlockKey(subject.userId), 'studio_user');
  }

  async recordSponsorFailure(
    ip: string,
    subject: AbuseSubject | undefined,
    code: string,
    meta?: import('./abuseBlockTypes.js').SponsorFailureMeta,
  ): Promise<void> {
    if (shouldIgnoreSponsorFailureForAbuse(code)) {
      return;
    }

    if (isManipulationAttemptCode(code)) {
      await this.setBlock(
        this.ipBlockKey(ip),
        `manipulation:${code}`,
        this._config.manipulationBlockDurationMs,
      );
      if (subject) {
        await this.setBlock(
          this.subjectBlockKey(subject),
          `manipulation:${code}`,
          this._config.manipulationBlockDurationMs,
        );
      }
      return;
    }

    // Failure-policy lookup. Codes outside the public HTTP + promotion-abuse
    // table fall through with `policy === undefined`; the fail-safe is
    // `abuseImpact = COUNT_BOTH`. The IP counter still applies; the subject
    // counter only fires when a family is mapped.
    const policy = getFailurePolicy(code);
    const ipImpact = policy?.abuseImpact.ip ?? 'count';
    const subjectImpact = policy?.abuseImpact.subject ?? 'count';

    if (ipImpact === 'count') {
      const ipFailureCount = await this.incrementWindowCounter(
        this.ipFailureKey(ip),
        this._config.ipFailureWindowMs,
      );
      if (ipFailureCount > this._config.ipFailureThreshold) {
        await this.setBlock(
          this.ipBlockKey(ip),
          'sponsor_failure_threshold',
          this._config.ipBlockDurationMs,
        );
      }
    }

    // Non-IP counter family routing: `abuseImpact.subject === 'count'`
    // permits a subject-level increment, and `subjectCounterFamily`
    // resolves which storage tier (sim_tier / revert) the increment
    // lands in. `shouldCarveOutNonIpCounter(code, meta)` preserves the
    // separate benign-retry and preflight-only market policies.
    const family = subjectCounterFamily(code);
    if (
      subject &&
      subjectImpact === 'count' &&
      family !== null &&
      !shouldCarveOutNonIpCounter(code, meta)
    ) {
      if (family === 'sim_tier') {
        const subjectFailureCount = await this.incrementWindowCounter(
          this.subjectDryRunKey(subject),
          this._config.addressDryRunWindowMs,
        );
        if (subjectFailureCount > this._config.addressDryRunThreshold) {
          await this.setBlock(
            this.subjectBlockKey(subject),
            'dry_run_failure_threshold',
            this._config.addressBlockDurationMs,
          );
        }
      } else if (family === 'revert') {
        const revertCount = await this.incrementWindowCounter(
          this.subjectOnchainRevertKey(subject),
          this._config.addressOnchainRevertWindowMs,
        );
        if (revertCount > this._config.addressOnchainRevertThreshold) {
          await this.setBlock(
            this.subjectBlockKey(subject),
            'onchain_revert_threshold',
            this._config.addressBlockDurationMs,
          );
        }
      }
    }
  }

  private async checkBlock(
    key: string,
    scope: 'ip' | 'address' | 'studio_user',
  ): Promise<AbuseBlockStatus> {
    const raw = await this._client.get(key);
    if (!raw) return { blocked: false };

    const parsed = JSON.parse(raw) as RedisBlockEntry;
    const retryAfterMs = Math.max(parsed.blockedUntil - this._clock.nowMs(), 0);
    if (retryAfterMs === 0) {
      await this._client.del(key);
      return { blocked: false };
    }

    return {
      blocked: true,
      scope,
      reason: parsed.reason,
      retryAfterMs,
    };
  }

  private async incrementWindowCounter(key: string, windowMs: number): Promise<number> {
    const { current } = parseFixedWindowResult(
      await this._client.eval(FIXED_WINDOW_INCR_SCRIPT, [key], [String(windowMs)]),
    );
    return current;
  }

  private async setBlock(key: string, reason: string, durationMs: number): Promise<void> {
    const blockedUntil = this._clock.nowMs() + durationMs;
    await this._client.set(
      key,
      JSON.stringify({ reason, blockedUntil } satisfies RedisBlockEntry),
      { px: durationMs },
    );
  }

  private ipFailureKey(ip: string): string {
    return `${this._ipFailurePrefix}${ip}`;
  }

  private ipBlockKey(ip: string): string {
    return `${this._ipBlockPrefix}${ip}`;
  }

  private addressBlockKey(address: string): string {
    return `${this._addressBlockPrefix}${address}`;
  }

  private studioUserBlockKey(userId: string): string {
    return `${this._studioUserBlockPrefix}${userId}`;
  }

  private subjectDryRunKey(subject: AbuseSubject): string {
    return subject.kind === 'address'
      ? `${this._addressDryRunPrefix}${subject.address}`
      : `${this._studioUserDryRunPrefix}${subject.userId}`;
  }

  private subjectOnchainRevertKey(subject: AbuseSubject): string {
    return subject.kind === 'address'
      ? `${this._addressOnchainRevertPrefix}${subject.address}`
      : `${this._studioUserOnchainRevertPrefix}${subject.userId}`;
  }

  private subjectBlockKey(subject: AbuseSubject): string {
    return subject.kind === 'address'
      ? this.addressBlockKey(subject.address)
      : this.studioUserBlockKey(subject.userId);
  }
}
