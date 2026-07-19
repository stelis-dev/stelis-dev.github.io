import { DEFAULT_ABUSE_BLOCKER_CONFIG } from '../abuseBlocking.js';
import type { AbuseBlockReason } from '@stelis/contracts';
import {
  getFailurePolicy,
  isManipulationAttemptCode,
  shouldCarveOutNonIpCounter,
  shouldIgnoreSponsorFailureForAbuse,
  subjectCounterFamily,
} from '../failures.js';
import type { AbuseBlockStatus, AbuseBlockerConfig, AbuseSubject } from './abuseBlockTypes.js';
import {
  AbuseBlockStorageCorruptionError,
  abuseBlockIdentityFromSubject,
  cloneAbuseBlockRecord,
  compareAbuseBlockPosition,
  decodeAbuseBlockCursor,
  decideAbuseBlockRemoval,
  decideAbuseBlockWrite,
  encodeAbuseBlockCursor,
  isLiveAbuseBlock,
  normalizeAbuseBlockIdentity,
  validateAbuseBlockPageParams,
  type AbuseBlockIdentity,
  type AbuseBlockPage,
  type AbuseBlockPageParams,
  type AbuseBlockRecord,
  type AbuseBlockStore,
} from './abuseBlockStore.js';
import { type Clock, systemClock } from '../clock.js';
import { validateAbuseBlockerConfig } from './abuseBlockConfig.js';

interface CounterEntry {
  count: number;
  expiresAt: number;
}

export class MemoryAbuseBlocker implements AbuseBlockStore {
  private readonly _config: AbuseBlockerConfig;
  private readonly _ipFailures = new Map<string, CounterEntry>();
  private readonly _addressDryRunFailures = new Map<string, CounterEntry>();
  private readonly _addressOnchainRevertFailures = new Map<string, CounterEntry>();
  private readonly _studioUserDryRunFailures = new Map<string, CounterEntry>();
  private readonly _studioUserOnchainRevertFailures = new Map<string, CounterEntry>();
  private readonly _ipBlocks = new Map<string, AbuseBlockRecord>();
  private readonly _addressBlocks = new Map<string, AbuseBlockRecord>();
  private readonly _studioUserBlocks = new Map<string, AbuseBlockRecord>();
  private readonly _clock: Clock;

  constructor(config: Partial<AbuseBlockerConfig> = {}, clock: Clock = systemClock) {
    this._config = validateAbuseBlockerConfig({ ...DEFAULT_ABUSE_BLOCKER_CONFIG, ...config });
    this._clock = clock;
  }

  async checkIp(ip: string): Promise<AbuseBlockStatus> {
    const identity = normalizeAbuseBlockIdentity({ scope: 'ip', subject: ip });
    return this.checkBlockMap(this._ipBlocks, identity.subject, 'ip');
  }

  async checkSubject(subject: AbuseSubject): Promise<AbuseBlockStatus> {
    const identity = abuseBlockIdentityFromSubject(subject);
    return this.checkBlockMap(this.blockMap(identity.scope), identity.subject, identity.scope);
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

    const now = this._clock.nowMs();
    const ipKey = normalizeAbuseBlockIdentity({ scope: 'ip', subject: ip }).subject;

    if (isManipulationAttemptCode(code)) {
      this.setBlock(
        { scope: 'ip', subject: ipKey },
        'manipulation',
        now + this._config.manipulationBlockDurationMs,
      );
      if (subject) {
        this.setBlock(
          abuseBlockIdentityFromSubject(subject),
          'manipulation',
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
      this.recordCounter(this._ipFailures, ipKey, this._config.ipFailureWindowMs, now);
      const ipFailureCount = this._ipFailures.get(ipKey)?.count ?? 0;
      if (ipFailureCount > this._config.ipFailureThreshold) {
        this.setBlock(
          { scope: 'ip', subject: ipKey },
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
      const currentSubject = abuseBlockIdentityFromSubject(subject);
      if (family === 'sim_tier') {
        const { dryRunFailures } = this.subjectStore(subject);
        const subjectKey = currentSubject.subject;
        this.recordCounter(dryRunFailures, subjectKey, this._config.addressDryRunWindowMs, now);
        const dryRunCount = dryRunFailures.get(subjectKey)?.count ?? 0;
        if (dryRunCount > this._config.addressDryRunThreshold) {
          this.setBlock(
            currentSubject,
            'dry_run_failure_threshold',
            now + this._config.addressBlockDurationMs,
          );
        }
      } else if (family === 'revert') {
        const { onchainRevertFailures } = this.subjectStore(subject);
        const subjectKey = currentSubject.subject;
        this.recordCounter(
          onchainRevertFailures,
          subjectKey,
          this._config.addressOnchainRevertWindowMs,
          now,
        );
        const revertCount = onchainRevertFailures.get(subjectKey)?.count ?? 0;
        if (revertCount > this._config.addressOnchainRevertThreshold) {
          this.setBlock(
            currentSubject,
            'onchain_revert_threshold',
            now + this._config.addressBlockDurationMs,
          );
        }
      }
    }
  }

  /**
   * Resolve the per-kind counter maps for the typed subject. The address kind
   * owns address-keyed maps; the studio_user kind owns studio-user-keyed maps.
   * Counters are isolated by kind so a
   * studio-user subject's counter cannot increment an address bucket and
   * vice versa.
   */
  private subjectStore(subject: AbuseSubject): {
    dryRunFailures: Map<string, CounterEntry>;
    onchainRevertFailures: Map<string, CounterEntry>;
  } {
    if (subject.kind === 'address') {
      return {
        dryRunFailures: this._addressDryRunFailures,
        onchainRevertFailures: this._addressOnchainRevertFailures,
      };
    }
    return {
      dryRunFailures: this._studioUserDryRunFailures,
      onchainRevertFailures: this._studioUserOnchainRevertFailures,
    };
  }

  private checkBlockMap(
    blocks: Map<string, AbuseBlockRecord>,
    key: string,
    scope: AbuseBlockIdentity['scope'],
  ): AbuseBlockStatus {
    const now = this._clock.nowMs();
    const entry = this.currentBlock(blocks, key, scope);
    if (!entry) return { blocked: false };
    if (!isLiveAbuseBlock(entry, now)) {
      blocks.delete(key);
      return { blocked: false };
    }
    return {
      blocked: true,
      scope,
      reason: entry.reason,
      retryAfterMs: entry.blockedUntilMs - now,
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
      counters.set(key, { count: 1, expiresAt: now + windowMs });
      return;
    }
    existing.count += 1;
  }

  private setBlock(
    identity: AbuseBlockIdentity,
    reason: AbuseBlockReason,
    blockedUntilMs: number,
  ): void {
    const currentIdentity = normalizeAbuseBlockIdentity(identity);
    const blocks = this.blockMap(currentIdentity.scope);
    const current = this.currentBlock(blocks, currentIdentity.subject, currentIdentity.scope);
    const decision = decideAbuseBlockWrite(current, {
      identity: currentIdentity,
      reason,
      blockedUntilMs,
    });
    if (decision.kind === 'preserved') return;

    blocks.set(currentIdentity.subject, decision.record);
  }

  async listBlocks(params: AbuseBlockPageParams): Promise<AbuseBlockPage> {
    validateAbuseBlockPageParams(params);
    const now = this._clock.nowMs();
    const rows: Array<{
      identity: AbuseBlockIdentity;
      reason: AbuseBlockReason;
      blockedUntilMs: number;
    }> = [];
    this.collectBlocks(rows, this._ipBlocks, 'ip', now);
    this.collectBlocks(rows, this._addressBlocks, 'address', now);
    this.collectBlocks(rows, this._studioUserBlocks, 'studio_user', now);
    rows.sort(compareAbuseBlockPosition);
    const cursor =
      params.cursor === null
        ? null
        : (() => {
            const decoded = decodeAbuseBlockCursor(params.cursor);
            return {
              identity: { scope: decoded.scope, subject: decoded.subject } as AbuseBlockIdentity,
              blockedUntilMs: decoded.blockedUntilMs,
            };
          })();
    const afterCursor = rows.filter(
      (row) => cursor === null || compareAbuseBlockPosition(row, cursor) > 0,
    );
    const examined = afterCursor.slice(0, params.limit);
    const hasMore = afterCursor.length > params.limit;
    return {
      blocks: examined,
      nextCursor:
        hasMore && examined.length > 0
          ? encodeAbuseBlockCursor(examined[examined.length - 1]!)
          : null,
    };
  }

  async removeBlock(identity: AbuseBlockIdentity): Promise<boolean> {
    const current = normalizeAbuseBlockIdentity(identity);
    const blocks = this.blockMap(current.scope);
    const record = this.currentBlock(blocks, current.subject, current.scope);
    const decision = decideAbuseBlockRemoval(record, this._clock.nowMs());
    if (record !== null) blocks.delete(current.subject);
    return decision === 'removed';
  }

  async stop(): Promise<void> {}

  private collectBlocks(
    output: Array<{
      identity: AbuseBlockIdentity;
      reason: AbuseBlockReason;
      blockedUntilMs: number;
    }>,
    blocks: Map<string, AbuseBlockRecord>,
    scope: AbuseBlockIdentity['scope'],
    now: number,
  ): void {
    for (const subject of [...blocks.keys()]) {
      const record = this.currentBlock(blocks, subject, scope);
      if (record === null) continue;
      if (!isLiveAbuseBlock(record, now)) {
        blocks.delete(subject);
        continue;
      }
      output.push(record);
    }
  }

  private blockMap(scope: AbuseBlockIdentity['scope']): Map<string, AbuseBlockRecord> {
    if (scope === 'ip') return this._ipBlocks;
    if (scope === 'address') return this._addressBlocks;
    return this._studioUserBlocks;
  }

  private currentBlock(
    blocks: Map<string, AbuseBlockRecord>,
    subject: string,
    scope: AbuseBlockIdentity['scope'],
  ): AbuseBlockRecord | null {
    const stored = blocks.get(subject);
    if (stored === undefined) return null;
    const record = cloneAbuseBlockRecord(stored);
    if (record.identity.scope !== scope || record.identity.subject !== subject) {
      throw new AbuseBlockStorageCorruptionError(
        'Memory abuse block record does not match its storage key',
      );
    }
    return record;
  }
}
