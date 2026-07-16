/**
 * AbuseBlockerAdapter — shared conformance test suite.
 *
 * Both MemoryAbuseBlocker and RedisAbuseBlocker must pass this suite.
 * The factory parameter lets each implementation provide its own
 * setup. Tests verify storage, windowed counters, block duration, and the
 * shared subject-family/carve-out decisions that both adapters must enact.
 * Failure-table vocabulary remains covered separately in `failures.test.ts`.
 *
 */

import { afterEach, expect, it } from 'vitest';
import type { AbuseBlockerConfig } from '../src/store/abuseBlockTypes.js';
import { abuseBlockMember, type AbuseBlockStore } from '../src/store/abuseBlockStore.js';

// ─────────────────────────────────────────────
// Factory contract
// ─────────────────────────────────────────────

export interface AbuseBlockerHandle {
  blocker: AbuseBlockStore;
  advanceTime(ms: number): Promise<void> | void;
  seedEqualDeadlineStudioUsers(userIds: readonly string[]): Promise<void> | void;
  dispose(): Promise<void> | void;
}

export type AbuseBlockerFactory = (
  config: Partial<AbuseBlockerConfig>,
) => Promise<AbuseBlockerHandle> | AbuseBlockerHandle;

// ─────────────────────────────────────────────
// Conformance suite
// ─────────────────────────────────────────────

const IP = '203.0.113.10';
const ADDRESS = '0x' + '11'.repeat(32);

export function runAbuseBlockerConformanceTests(factory: AbuseBlockerFactory): void {
  let handle: AbuseBlockerHandle | null = null;

  async function setup(config: Partial<AbuseBlockerConfig>): Promise<AbuseBlockerHandle> {
    handle = await factory(config);
    return handle;
  }

  afterEach(async () => {
    if (handle) {
      await handle.dispose();
      handle = null;
    }
  });

  it('IP threshold — blocks after the windowed counter exceeds the threshold, clears after TTL', async () => {
    const { blocker, advanceTime } = await setup({
      ipFailureThreshold: 1,
      ipFailureWindowMs: 1_000,
      ipBlockDurationMs: 500,
    });

    // First recorded failure keeps us at count=1 (not > threshold=1).
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'L2_UNKNOWN_PAYMENT_ID',
    );
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: false });

    // Second failure crosses the threshold.
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'L2_UNKNOWN_PAYMENT_ID',
    );
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({
      blocked: true,
      scope: 'ip',
    });

    // Advance past the block duration — block clears.
    await advanceTime(501);
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: false });
  });

  it('IP fixed window — expiry starts a new counter window instead of carrying the old count', async () => {
    const { blocker, advanceTime } = await setup({
      ipFailureThreshold: 1,
      ipFailureWindowMs: 50,
      ipBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(IP, undefined, 'PREFLIGHT_FAILED');
    await advanceTime(75);
    await blocker.recordSponsorFailure(IP, undefined, 'PREFLIGHT_FAILED');
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: false });

    await blocker.recordSponsorFailure(IP, undefined, 'PREFLIGHT_FAILED');
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
  });

  it('equal-deadline pages use Redis member byte ordering and exclusive cursors', async () => {
    const { blocker, seedEqualDeadlineStudioUsers } = await setup({
      manipulationBlockDurationMs: 60_000,
    });
    const userIds = ['z', '-', 'A'];
    await seedEqualDeadlineStudioUsers(userIds);

    const actualMembers: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await blocker.listBlocks({ cursor, limit: 1 });
      actualMembers.push(
        ...page.blocks
          .filter((block) => block.identity.scope === 'studio_user')
          .map((block) => abuseBlockMember(block.identity)),
      );
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(actualMembers).toEqual(
      userIds.map((subject) => abuseBlockMember({ scope: 'studio_user', subject })).sort(),
    );
  });

  it('ip, address, and studio_user removals return true once and false after deletion', async () => {
    const { blocker } = await setup({
      manipulationBlockDurationMs: 60_000,
    });
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'TAMPERING_DETECTED',
    );
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'studio_user', userId: 'User-A' },
      'TAMPERING_DETECTED',
    );

    const page = await blocker.listBlocks({ cursor: null, limit: 50 });
    expect(new Set(page.blocks.map((block) => block.identity.scope))).toEqual(
      new Set(['ip', 'address', 'studio_user']),
    );
    for (const block of page.blocks) {
      await expect(blocker.removeBlock(block.identity)).resolves.toBe(true);
      await expect(blocker.removeBlock(block.identity)).resolves.toBe(false);
    }
  });

  it('expired removal returns false instead of reporting a stale block as removed', async () => {
    const { blocker, advanceTime } = await setup({
      manipulationBlockDurationMs: 25,
    });
    await blocker.recordSponsorFailure(IP, undefined, 'TAMPERING_DETECTED');
    await advanceTime(40);

    await expect(blocker.removeBlock({ scope: 'ip', subject: IP })).resolves.toBe(false);
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: false });
  });

  it('address threshold — DRY_RUN_FAILED over threshold blocks the address', async () => {
    const { blocker } = await setup({
      addressDryRunThreshold: 1,
      addressDryRunWindowMs: 1_000,
      addressBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(IP, { kind: 'address', address: ADDRESS }, 'DRY_RUN_FAILED');
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });

    await blocker.recordSponsorFailure(IP, { kind: 'address', address: ADDRESS }, 'DRY_RUN_FAILED');
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({
      blocked: true,
      scope: 'address',
    });
  });

  it('address threshold — PREFLIGHT_FAILED shares the same bucket as DRY_RUN_FAILED', async () => {
    const { blocker } = await setup({
      addressDryRunThreshold: 1,
      addressDryRunWindowMs: 1_000,
      addressBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'PREFLIGHT_FAILED',
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'PREFLIGHT_FAILED',
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({
      blocked: true,
      scope: 'address',
    });
  });

  it('manipulation — TAMPERING_DETECTED applies an immediate long-duration block on IP and address', async () => {
    const { blocker } = await setup({
      ipFailureThreshold: 0,
      manipulationBlockDurationMs: 10_000,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'TAMPERING_DETECTED',
    );
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true });
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: true });
  });

  it('ignored codes — NO_SPONSOR_SLOT, ABUSE_BLOCKED, and REPREPARE_REQUIRED do not increment any counter', async () => {
    const { blocker } = await setup({
      ipFailureThreshold: 0, // would block immediately on any non-ignored code
      manipulationBlockDurationMs: 10_000,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'NO_SPONSOR_SLOT',
    );
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: false });
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });

    await blocker.recordSponsorFailure(IP, { kind: 'address', address: ADDRESS }, 'ABUSE_BLOCKED');
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: false });
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'REPREPARE_REQUIRED',
    );
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: false });
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });
  });

  it('ignored codes short-circuit before IP validation while counted codes reject malformed IPs', async () => {
    const { blocker } = await setup({
      ipFailureThreshold: 0,
      manipulationBlockDurationMs: 10_000,
    });

    await expect(
      blocker.recordSponsorFailure(
        'not-an-ip-address',
        { kind: 'address', address: ADDRESS },
        'NO_SPONSOR_SLOT',
      ),
    ).resolves.toBeUndefined();

    await expect(
      blocker.recordSponsorFailure(
        'not-an-ip-address',
        { kind: 'address', address: ADDRESS },
        'PREFLIGHT_FAILED',
      ),
    ).rejects.toThrow();
  });

  it('non-manipulation sponsor failure — L2_POLICY_HASH_MISMATCH does NOT trigger a manipulation block', async () => {
    const { blocker } = await setup({
      ipFailureThreshold: 100, // high enough that windowed counter cannot trip in one call
      manipulationBlockDurationMs: 10_000,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'L2_POLICY_HASH_MISMATCH',
    );
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: false });
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });
  });

  it('normal row without storage family — PROMO_DEADLINE_PASSED never increments subject counter; IP counter still increments', async () => {
    // Coherence test for the FAILURE_TABLE invariant
    // (`abuseImpact.subject==='count' ⇒ subjectCounterFamily(code) !== null`):
    // PROMO_DEADLINE_PASSED is `normal + family null + subject 'skip'` so
    // the adapter must not bucket it into any non-IP storage tier. We
    // drive the address dry-run / on-chain-revert thresholds to 0 so an
    // off-spec subject increment would block immediately. The IP counter
    // is exercised separately to prove the row's `ip:'count'` half is
    // honored.
    const STUDIO_USER_ID = 'studio-promo-deadline-1';
    const STUDIO_USER = { kind: 'studio_user' as const, userId: STUDIO_USER_ID };
    const { blocker } = await setup({
      addressDryRunThreshold: 0,
      addressOnchainRevertThreshold: 0,
      addressBlockDurationMs: 60_000,
      ipFailureThreshold: 1,
      ipFailureWindowMs: 60_000,
      ipBlockDurationMs: 60_000,
      manipulationBlockDurationMs: 60_000,
    });

    await blocker.recordSponsorFailure(IP, STUDIO_USER, 'PROMO_DEADLINE_PASSED');
    // First record: subject must remain unblocked even with thresholds=0
    // (any subject increment would have crossed the threshold already).
    await expect(blocker.checkSubject(STUDIO_USER)).resolves.toMatchObject({ blocked: false });

    // Second record crosses ip threshold=1, so IP becomes blocked.
    await blocker.recordSponsorFailure(IP, STUDIO_USER, 'PROMO_DEADLINE_PASSED');
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
    // Subject still must not be blocked — proves `subject:'skip'` is
    // honored at runtime, not just in the table.
    await expect(blocker.checkSubject(STUDIO_USER)).resolves.toMatchObject({ blocked: false });
  });

  it('unused subject input is not validated before an IP-only policy records its counter', async () => {
    const { blocker } = await setup({
      ipFailureThreshold: 1,
      ipFailureWindowMs: 60_000,
      ipBlockDurationMs: 60_000,
    });
    const unusedSubject = { kind: 'address' as const, address: 'not-a-current-address' };

    await blocker.recordSponsorFailure(IP, unusedSubject, 'PROMO_DEADLINE_PASSED');
    await blocker.recordSponsorFailure(IP, unusedSubject, 'PROMO_DEADLINE_PASSED');

    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
  });

  it('normal row without storage family — L2_POLICY_HASH_MISMATCH never increments subject counter (address kind)', async () => {
    // Sister case to the studio_user test above, locking the same
    // invariant for the address subject kind. Demonstrates that the
    // honesty of `abuseImpact.subject` propagates uniformly across both
    // typed-subject kinds the adapter supports.
    const { blocker } = await setup({
      addressDryRunThreshold: 0,
      addressOnchainRevertThreshold: 0,
      addressBlockDurationMs: 60_000,
      ipFailureThreshold: 100,
      manipulationBlockDurationMs: 60_000,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'L2_POLICY_HASH_MISMATCH',
    );
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'L2_POLICY_HASH_MISMATCH',
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });
  });

  it('ONCHAIN_REVERT — separate higher-threshold bucket, boundary value (threshold not blocked, threshold+1 blocked)', async () => {
    const { blocker } = await setup({
      addressOnchainRevertThreshold: 5,
      addressOnchainRevertWindowMs: 300_000,
      addressBlockDurationMs: 500,
    });

    for (let i = 0; i < 5; i++) {
      await blocker.recordSponsorFailure(
        IP,
        { kind: 'address', address: ADDRESS },
        'ONCHAIN_REVERT',
      );
    }
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });

    await blocker.recordSponsorFailure(IP, { kind: 'address', address: ADDRESS }, 'ONCHAIN_REVERT');
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({
      blocked: true,
      scope: 'address',
      reason: 'onchain_revert_threshold',
    });
  });

  it('ONCHAIN_REVERT — PAUSED subcode carves out address counter, IP counter still increments', async () => {
    const { blocker } = await setup({
      addressOnchainRevertThreshold: 1,
      addressOnchainRevertWindowMs: 300_000,
      addressBlockDurationMs: 500,
      ipFailureThreshold: 1,
      ipFailureWindowMs: 300_000,
      ipBlockDurationMs: 500,
    });

    // Two PAUSED reverts would cross the address threshold (1) if the carve-out
    // were not in effect. Address must remain unblocked.
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'ONCHAIN_REVERT',
      { subcode: 'PAUSED' },
    );
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'ONCHAIN_REVERT',
      { subcode: 'PAUSED' },
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });

    // IP counter is unaffected — two records exceed the IP threshold=1 and
    // the IP is blocked. This proves the carve-out is address-only.
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
  });

  it('ONCHAIN_REVERT — VAULT_ALREADY_REGISTERED subcode carves out address counter', async () => {
    const { blocker } = await setup({
      addressOnchainRevertThreshold: 1,
      addressOnchainRevertWindowMs: 300_000,
      addressBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'ONCHAIN_REVERT',
      {
        subcode: 'VAULT_ALREADY_REGISTERED',
      },
    );
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'ONCHAIN_REVERT',
      {
        subcode: 'VAULT_ALREADY_REGISTERED',
      },
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });
  });

  it('ONCHAIN_REVERT — REPLAY_NONCE subcode carves out address counter, IP counter still increments', async () => {
    // S-14 monotonic-gap: when a sender prepares two transactions and
    // the higher nonce settles first, the lower nonce reaches
    // `check_and_advance_nonce` with `nonce <= vault.last_nonce` and
    // aborts `EReplayNonce`. This is the documented intended consequence
    // of S-14, not user manipulation, so the address-level revert
    // counter must skip it. IP counting still applies — raw IP churn
    // remains observable so an attacker driving many such failures from
    // one IP is still detected.
    const { blocker } = await setup({
      addressOnchainRevertThreshold: 1,
      addressOnchainRevertWindowMs: 300_000,
      addressBlockDurationMs: 500,
      ipFailureThreshold: 1,
      ipFailureWindowMs: 300_000,
      ipBlockDurationMs: 500,
    });

    // Two REPLAY_NONCE reverts would cross the address threshold (1) if
    // the carve-out were not in effect. Address must remain unblocked.
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'ONCHAIN_REVERT',
      {
        subcode: 'REPLAY_NONCE',
      },
    );
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'ONCHAIN_REVERT',
      {
        subcode: 'REPLAY_NONCE',
      },
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });

    // IP counter is unaffected — two records exceed the IP threshold=1
    // and the IP is blocked. This proves the carve-out is address-only.
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
  });

  it('ONCHAIN_REVERT — SPREAD_EXCEEDED increments the separate address revert counter and IP counter', async () => {
    const { blocker } = await setup({
      addressOnchainRevertThreshold: 1,
      addressOnchainRevertWindowMs: 300_000,
      addressBlockDurationMs: 500,
      ipFailureThreshold: 1,
      ipFailureWindowMs: 300_000,
      ipBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'ONCHAIN_REVERT',
      { subcode: 'SPREAD_EXCEEDED' },
    );
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'ONCHAIN_REVERT',
      { subcode: 'SPREAD_EXCEEDED' },
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: true, scope: 'address' });
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
  });

  it('ONCHAIN_REVERT — SLIPPAGE_EXCEEDED increments the separate address revert counter and IP counter', async () => {
    const { blocker } = await setup({
      addressOnchainRevertThreshold: 1,
      addressOnchainRevertWindowMs: 300_000,
      addressBlockDurationMs: 500,
      ipFailureThreshold: 1,
      ipFailureWindowMs: 300_000,
      ipBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'ONCHAIN_REVERT',
      { subcode: 'SLIPPAGE_EXCEEDED' },
    );
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'ONCHAIN_REVERT',
      { subcode: 'SLIPPAGE_EXCEEDED' },
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: true, scope: 'address' });
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
  });

  it('PREFLIGHT_FAILED — SPREAD_EXCEEDED (market-volatility) carves out address dry-run counter, IP counter still increments', async () => {
    const { blocker } = await setup({
      addressDryRunThreshold: 1,
      addressDryRunWindowMs: 60_000,
      addressBlockDurationMs: 500,
      ipFailureThreshold: 1,
      ipFailureWindowMs: 300_000,
      ipBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'PREFLIGHT_FAILED',
      { subcode: 'SPREAD_EXCEEDED' },
    );
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'PREFLIGHT_FAILED',
      { subcode: 'SPREAD_EXCEEDED' },
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
  });

  it('PREFLIGHT_FAILED — SLIPPAGE_EXCEEDED (market-volatility) carves out address dry-run counter, IP counter still increments', async () => {
    const { blocker } = await setup({
      addressDryRunThreshold: 1,
      addressDryRunWindowMs: 60_000,
      addressBlockDurationMs: 500,
      ipFailureThreshold: 1,
      ipFailureWindowMs: 300_000,
      ipBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'PREFLIGHT_FAILED',
      { subcode: 'SLIPPAGE_EXCEEDED' },
    );
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'PREFLIGHT_FAILED',
      { subcode: 'SLIPPAGE_EXCEEDED' },
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
  });

  it('studio_user — ONCHAIN_REVERT SLIPPAGE_EXCEEDED increments revert and IP counters', async () => {
    const { blocker } = await setup({
      addressOnchainRevertThreshold: 1,
      addressOnchainRevertWindowMs: 300_000,
      addressBlockDurationMs: 500,
      ipFailureThreshold: 1,
      ipFailureWindowMs: 300_000,
      ipBlockDurationMs: 500,
    });

    const userId = 'studio:promo:user-volatility';
    await blocker.recordSponsorFailure(IP, { kind: 'studio_user', userId }, 'ONCHAIN_REVERT', {
      subcode: 'SLIPPAGE_EXCEEDED',
    });
    await blocker.recordSponsorFailure(IP, { kind: 'studio_user', userId }, 'ONCHAIN_REVERT', {
      subcode: 'SLIPPAGE_EXCEEDED',
    });
    await expect(blocker.checkSubject({ kind: 'studio_user', userId })).resolves.toMatchObject({
      blocked: true,
      scope: 'studio_user',
    });
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
  });

  it('studio_user — PREFLIGHT_FAILED SLIPPAGE_EXCEEDED carves out sim-tier but not IP', async () => {
    const { blocker } = await setup({
      addressDryRunThreshold: 1,
      addressDryRunWindowMs: 60_000,
      addressBlockDurationMs: 500,
      ipFailureThreshold: 1,
      ipFailureWindowMs: 300_000,
      ipBlockDurationMs: 500,
    });

    const userId = 'studio:promo:user-preflight-volatility';
    await blocker.recordSponsorFailure(IP, { kind: 'studio_user', userId }, 'PREFLIGHT_FAILED', {
      subcode: 'SLIPPAGE_EXCEEDED',
    });
    await blocker.recordSponsorFailure(IP, { kind: 'studio_user', userId }, 'PREFLIGHT_FAILED', {
      subcode: 'SLIPPAGE_EXCEEDED',
    });
    await expect(blocker.checkSubject({ kind: 'studio_user', userId })).resolves.toMatchObject({
      blocked: false,
    });
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
  });

  it('ONCHAIN_REVERT — non-carved subcode (e.g. CLAIM_WOULD_EXCEED_MAX) still drives the address counter', async () => {
    const { blocker } = await setup({
      addressOnchainRevertThreshold: 1,
      addressOnchainRevertWindowMs: 300_000,
      addressBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'ONCHAIN_REVERT',
      {
        subcode: 'CLAIM_WOULD_EXCEED_MAX',
      },
    );
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'ONCHAIN_REVERT',
      {
        subcode: 'CLAIM_WOULD_EXCEED_MAX',
      },
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({
      blocked: true,
      scope: 'address',
      reason: 'onchain_revert_threshold',
    });
  });

  it('PREFLIGHT_FAILED — REPLAY_NONCE subcode carves out address dry-run counter, IP counter still increments', async () => {
    // Same S-14 monotonic-gap rationale as the ONCHAIN_REVERT case above:
    // a stale prepared nonce returns at preflight as
    // `vault::EReplayNonce`. The shared address-level carve-out predicate
    // (`shouldCarveOutNonIpCounter`) gates both counter families,
    // so the simulation-tier address dry-run counter must skip it.
    const { blocker } = await setup({
      addressDryRunThreshold: 1,
      addressDryRunWindowMs: 60_000,
      addressBlockDurationMs: 500,
      ipFailureThreshold: 1,
      ipFailureWindowMs: 300_000,
      ipBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'PREFLIGHT_FAILED',
      {
        subcode: 'REPLAY_NONCE',
        executionPathKey: 'credit',
      },
    );
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'PREFLIGHT_FAILED',
      {
        subcode: 'REPLAY_NONCE',
        executionPathKey: 'credit',
      },
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });

    // IP counter is unaffected — two records exceed the IP threshold=1
    // and the IP is blocked. Proves the carve-out is address-only.
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
  });

  it('PREFLIGHT_FAILED — non-carved subcode (e.g. CLAIM_WOULD_EXCEED_MAX) still drives the address dry-run counter', async () => {
    // SLIPPAGE_EXCEEDED is now part of
    // `MARKET_VOLATILITY_CARVE_OUT_SUBCODES`, so it no longer works as
    // a "non-carved" example here. Use a genuinely non-carved subcode
    // so the negative-side counter assertion remains meaningful.
    const { blocker } = await setup({
      addressDryRunThreshold: 1,
      addressDryRunWindowMs: 60_000,
      addressBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'PREFLIGHT_FAILED',
      {
        subcode: 'CLAIM_WOULD_EXCEED_MAX',
        executionPathKey: 'credit',
      },
    );
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'PREFLIGHT_FAILED',
      {
        subcode: 'CLAIM_WOULD_EXCEED_MAX',
        executionPathKey: 'credit',
      },
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({
      blocked: true,
      scope: 'address',
      reason: 'dry_run_failure_threshold',
    });
  });

  it('DRY_RUN_FAILED — REPLAY_NONCE subcode carves out address dry-run counter (defensive coverage)', async () => {
    // Defensive coverage: production code does not currently route
    // `DRY_RUN_FAILED` through `recordSponsorFailureForAbuse`. This case
    // locks the same address-level carve-out predicate
    // (`shouldCarveOutNonIpCounter`) for that code — the
    // simulation-tier branch in both blocker adapters covers
    // `DRY_RUN_FAILED || PREFLIGHT_FAILED` together.
    const { blocker } = await setup({
      addressDryRunThreshold: 1,
      addressDryRunWindowMs: 60_000,
      addressBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'DRY_RUN_FAILED',
      {
        subcode: 'REPLAY_NONCE',
        executionPathKey: 'credit',
      },
    );
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'DRY_RUN_FAILED',
      {
        subcode: 'REPLAY_NONCE',
        executionPathKey: 'credit',
      },
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: false });
  });

  it('DRY_RUN_FAILED — market subcodes do not inherit the sponsor-preflight carve-out', async () => {
    const { blocker } = await setup({
      addressDryRunThreshold: 1,
      addressDryRunWindowMs: 60_000,
      addressBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'DRY_RUN_FAILED',
      { subcode: 'SLIPPAGE_EXCEEDED', executionPathKey: 'credit' },
    );
    await blocker.recordSponsorFailure(
      IP,
      { kind: 'address', address: ADDRESS },
      'DRY_RUN_FAILED',
      { subcode: 'SLIPPAGE_EXCEEDED', executionPathKey: 'credit' },
    );
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({ blocked: true, scope: 'address' });
  });

  // ────────────────────────────────────────────────────────────────
  // `studio_user` carve-out parity
  //
  // The `shouldCarveOutNonIpCounter` predicate gates both kinds
  // uniformly and defines which classified subcodes skip the
  // non-IP counter. The subject-boundary contract is that the same carve-out
  // applies when the typed subject is `{ kind: 'studio_user', userId }`,
  // not just `{ kind: 'address' }`. These conformance tests lock that
  // promise at both backend boundaries (Memory + Redis). IP counter
  // behavior must remain unaffected — raw IP churn is still observable
  // across studio-user calls so an attacker driving many such failures
  // from one IP is still detected.
  // ────────────────────────────────────────────────────────────────

  const STUDIO_USER_ID = 'studio-user-carveout-1';
  const STUDIO_USER_SUBJECT = { kind: 'studio_user' as const, userId: STUDIO_USER_ID };

  it('studio_user — ONCHAIN_REVERT PAUSED subcode carves out non-IP counter, IP counter still increments', async () => {
    const { blocker } = await setup({
      addressOnchainRevertThreshold: 1,
      addressOnchainRevertWindowMs: 300_000,
      addressBlockDurationMs: 500,
      ipFailureThreshold: 1,
      ipFailureWindowMs: 300_000,
      ipBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'ONCHAIN_REVERT', {
      subcode: 'PAUSED',
    });
    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'ONCHAIN_REVERT', {
      subcode: 'PAUSED',
    });

    // studio_user counter: PAUSED carved out — must remain unblocked.
    await expect(blocker.checkSubject(STUDIO_USER_SUBJECT)).resolves.toMatchObject({
      blocked: false,
    });
    // IP counter: still increments on each non-ignored record — blocked.
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
  });

  it('studio_user — ONCHAIN_REVERT VAULT_ALREADY_REGISTERED subcode carves out non-IP counter', async () => {
    const { blocker } = await setup({
      addressOnchainRevertThreshold: 1,
      addressOnchainRevertWindowMs: 300_000,
      addressBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'ONCHAIN_REVERT', {
      subcode: 'VAULT_ALREADY_REGISTERED',
    });
    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'ONCHAIN_REVERT', {
      subcode: 'VAULT_ALREADY_REGISTERED',
    });
    await expect(blocker.checkSubject(STUDIO_USER_SUBJECT)).resolves.toMatchObject({
      blocked: false,
    });
  });

  it('studio_user — ONCHAIN_REVERT REPLAY_NONCE subcode carves out non-IP counter, IP counter still increments', async () => {
    // S-14 monotonic-gap rationale (Studio path): a Studio user that
    // prepares two transactions and lands them out of order produces an
    // `EReplayNonce` abort even though the request is benign. The
    // carve-out must apply to the studio_user counter so a legitimate
    // Studio user is not self-blocked. IP counter still applies.
    const { blocker } = await setup({
      addressOnchainRevertThreshold: 1,
      addressOnchainRevertWindowMs: 300_000,
      addressBlockDurationMs: 500,
      ipFailureThreshold: 1,
      ipFailureWindowMs: 300_000,
      ipBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'ONCHAIN_REVERT', {
      subcode: 'REPLAY_NONCE',
    });
    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'ONCHAIN_REVERT', {
      subcode: 'REPLAY_NONCE',
    });

    await expect(blocker.checkSubject(STUDIO_USER_SUBJECT)).resolves.toMatchObject({
      blocked: false,
    });
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
  });

  it('studio_user — ONCHAIN_REVERT non-carved subcode (e.g. CLAIM_WOULD_EXCEED_MAX) still drives the non-IP counter', async () => {
    const { blocker } = await setup({
      addressOnchainRevertThreshold: 1,
      addressOnchainRevertWindowMs: 300_000,
      addressBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'ONCHAIN_REVERT', {
      subcode: 'CLAIM_WOULD_EXCEED_MAX',
    });
    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'ONCHAIN_REVERT', {
      subcode: 'CLAIM_WOULD_EXCEED_MAX',
    });
    await expect(blocker.checkSubject(STUDIO_USER_SUBJECT)).resolves.toMatchObject({
      blocked: true,
      scope: 'studio_user',
      reason: 'onchain_revert_threshold',
    });
  });

  it('studio_user — PREFLIGHT_FAILED REPLAY_NONCE subcode carves out non-IP dry-run counter, IP counter still increments', async () => {
    const { blocker } = await setup({
      addressDryRunThreshold: 1,
      addressDryRunWindowMs: 60_000,
      addressBlockDurationMs: 500,
      ipFailureThreshold: 1,
      ipFailureWindowMs: 300_000,
      ipBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'PREFLIGHT_FAILED', {
      subcode: 'REPLAY_NONCE',
      executionPathKey: 'promotion:studio-promo-1',
    });
    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'PREFLIGHT_FAILED', {
      subcode: 'REPLAY_NONCE',
      executionPathKey: 'promotion:studio-promo-1',
    });

    await expect(blocker.checkSubject(STUDIO_USER_SUBJECT)).resolves.toMatchObject({
      blocked: false,
    });
    await expect(blocker.checkIp(IP)).resolves.toMatchObject({ blocked: true, scope: 'ip' });
  });

  it('studio_user — PREFLIGHT_FAILED non-carved subcode (e.g. CLAIM_WOULD_EXCEED_MAX) still drives the non-IP dry-run counter', async () => {
    // SLIPPAGE_EXCEEDED is now part of
    // `MARKET_VOLATILITY_CARVE_OUT_SUBCODES`, so it no longer works as
    // a "non-carved" example here.
    const { blocker } = await setup({
      addressDryRunThreshold: 1,
      addressDryRunWindowMs: 60_000,
      addressBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'PREFLIGHT_FAILED', {
      subcode: 'CLAIM_WOULD_EXCEED_MAX',
      executionPathKey: 'promotion:studio-promo-1',
    });
    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'PREFLIGHT_FAILED', {
      subcode: 'CLAIM_WOULD_EXCEED_MAX',
      executionPathKey: 'promotion:studio-promo-1',
    });
    await expect(blocker.checkSubject(STUDIO_USER_SUBJECT)).resolves.toMatchObject({
      blocked: true,
      scope: 'studio_user',
      reason: 'dry_run_failure_threshold',
    });
  });

  it('studio_user — DRY_RUN_FAILED REPLAY_NONCE subcode carves out non-IP dry-run counter (defensive coverage)', async () => {
    // Defensive coverage parallel to the address-kind case above: the
    // simulation-tier branch must honour the same predicate uniformly
    // across both subject kinds for `DRY_RUN_FAILED`.
    const { blocker } = await setup({
      addressDryRunThreshold: 1,
      addressDryRunWindowMs: 60_000,
      addressBlockDurationMs: 500,
    });

    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'DRY_RUN_FAILED', {
      subcode: 'REPLAY_NONCE',
      executionPathKey: 'promotion:studio-promo-1',
    });
    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'DRY_RUN_FAILED', {
      subcode: 'REPLAY_NONCE',
      executionPathKey: 'promotion:studio-promo-1',
    });
    await expect(blocker.checkSubject(STUDIO_USER_SUBJECT)).resolves.toMatchObject({
      blocked: false,
    });
  });

  // Per-kind isolation: a studio_user counter increment must NOT spill
  // into the address counter, and vice versa. Without this isolation, an
  // address-keyed attacker could trigger blocks on a Studio user (or
  // vice-versa) by sharing the IP and crossing the threshold of the
  // other kind.
  it('studio_user counters are isolated from address counters of any address', async () => {
    const { blocker } = await setup({
      addressOnchainRevertThreshold: 1,
      addressOnchainRevertWindowMs: 300_000,
      addressBlockDurationMs: 500,
    });

    // Cross the studio_user threshold via two non-carved reverts.
    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'ONCHAIN_REVERT', {
      subcode: 'CLAIM_WOULD_EXCEED_MAX',
    });
    await blocker.recordSponsorFailure(IP, STUDIO_USER_SUBJECT, 'ONCHAIN_REVERT', {
      subcode: 'CLAIM_WOULD_EXCEED_MAX',
    });
    await expect(blocker.checkSubject(STUDIO_USER_SUBJECT)).resolves.toMatchObject({
      blocked: true,
      scope: 'studio_user',
    });
    // An arbitrary address must NOT inherit the block.
    await expect(
      blocker.checkSubject({ kind: 'address', address: ADDRESS }),
    ).resolves.toMatchObject({
      blocked: false,
    });
  });
}
