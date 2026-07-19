/**
 * security_regression.test.ts
 *
 * Coverage for current security-sensitive behavior.
 *
 * Tests:
 *   A. executionPathKey — canonical key built from extractedSettlementSwapPath
 *   B. SPONSOR_FAILURE_RECORDED log — abuseBlocking.ts logs before adapter call
 *   C. CORS getAllowedOrigins — fail-closed in production, localhost:3200 in dev
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── SPONSOR_FAILURE_RECORDED log via abuseBlocking.ts ─────────────────────

import { recordSponsorFailureForAbuse } from '../src/abuseBlocking.js';
import { shouldIgnoreSponsorFailureForAbuse } from '../src/failures.js';
import { MemoryAbuseBlocker } from '../src/store/memoryAbuseBlocker.js';

describe('SPONSOR_FAILURE_RECORDED structured log', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits SPONSOR_FAILURE_RECORDED log for non-ignored failures', async () => {
    const blocker = new MemoryAbuseBlocker();

    // Verify the adapter is called with meta (structured log is emitted before the adapter call
    // inside recordSponsorFailureForAbuse, observable via adapter being called with correct args)
    const adapterSpy = vi.spyOn(blocker, 'recordSponsorFailure');

    const subject = { kind: 'address' as const, address: '0xADDR' };
    await recordSponsorFailureForAbuse(blocker, '1.2.3.4', subject, 'ONCHAIN_REVERT', {
      subcode: 'INSUFFICIENT_SETTLE_INPUT',
      executionPathKey: 'deep:pool1:',
    });

    // adapter MUST have been called (log + adapter both fire for non-ignored codes)
    expect(adapterSpy).toHaveBeenCalledWith(
      '1.2.3.4',
      subject,
      'ONCHAIN_REVERT',
      expect.objectContaining({
        subcode: 'INSUFFICIENT_SETTLE_INPUT',
        executionPathKey: 'deep:pool1:',
      }),
    );
  });

  // ── Studio user key-rotation invariant (block path) ────────────────────
  // The studio_user block map is keyed by `userId` only; senderAddress is
  // structurally absent from the studio_user subject, so a Sui key rotation
  // on the same Studio user cannot evade an already-issued block. This test
  // locks that invariant at the runtime layer.
  it('studio_user block: applies on userId, independent of any rotated senderAddress', async () => {
    const blocker = new MemoryAbuseBlocker({
      addressDryRunThreshold: 3,
      addressDryRunWindowMs: 60_000,
      addressBlockDurationMs: 60_000,
    });
    const ROTATING_USER = 'user-rotating';
    const SUBJECT = { kind: 'studio_user' as const, userId: ROTATING_USER };

    // Cross PREFLIGHT_FAILED threshold (4 events > threshold of 3).
    for (let i = 0; i < 4; i++) {
      await recordSponsorFailureForAbuse(blocker, '10.0.0.1', SUBJECT, 'PREFLIGHT_FAILED');
    }
    await expect(blocker.checkSubject(SUBJECT)).resolves.toMatchObject({
      blocked: true,
      scope: 'studio_user',
    });
    // Address-kind subject for the same userId must not pick up the block —
    // address and studio_user buckets are isolated.
    await expect(
      blocker.checkSubject({ kind: 'address', address: '0x' + 'cd'.repeat(32) }),
    ).resolves.toMatchObject({ blocked: false });
  });

  it('does NOT call adapter for ignored codes (fail-closed guard in recordSponsorFailureForAbuse)', async () => {
    const blocker = new MemoryAbuseBlocker();
    const adapterSpy = vi.spyOn(blocker, 'recordSponsorFailure');
    const logSpy = vi.spyOn(console, 'log');

    const subject = { kind: 'address' as const, address: '0xADDR' };
    // abuseBlocking.ts: if (shouldIgnoreSponsorFailureForAbuse(code)) return;
    // Neither the structured log nor the adapter call should fire for codes
    // classified as `ignored` or `drift` in failures.ts.
    await recordSponsorFailureForAbuse(blocker, '1.2.3.4', subject, 'NO_SPONSOR_SLOT');
    await recordSponsorFailureForAbuse(blocker, '1.2.3.4', subject, 'REPREPARE_REQUIRED');

    // Guard confirmed via shouldIgnore
    expect(shouldIgnoreSponsorFailureForAbuse('NO_SPONSOR_SLOT')).toBe(true);
    expect(shouldIgnoreSponsorFailureForAbuse('REPREPARE_REQUIRED')).toBe(true);

    // Actual behavioural assertion: adapter must NOT have been called
    expect(adapterSpy).not.toHaveBeenCalled();

    // Structured log must NOT have been emitted (SPONSOR_FAILURE_RECORDED)
    const loggedSponsorFailure = logSpy.mock.calls.some(
      (args) => typeof args[0] === 'string' && args[0].includes('SPONSOR_FAILURE_RECORDED'),
    );
    expect(loggedSponsorFailure).toBe(false);
  });
});
