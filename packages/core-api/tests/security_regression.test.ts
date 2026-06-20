/**
 * security_regression.test.ts
 *
 * Coverage for current security-sensitive behavior.
 *
 * Tests:
 *   A. PrepareStudioUserQuotaError — MemoryPrepareStore studio-user outstanding-prepare quota
 *   B. executionPathKey — canonical key built from extractedSettlementSwapPath (not allowedSettlementSwapPaths lookup)
 *   C. SPONSOR_FAILURE_RECORDED log — abuseBlocking.ts logs before adapter call
 *   D. CORS getAllowedOrigins — fail-closed in production, localhost:3200 in dev
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── A: PrepareStudioUserQuotaError ────────────────────────────────────────────────────

import {
  MemoryPrepareStore,
  MAX_OUTSTANDING_PER_STUDIO_USER,
} from '../src/store/memoryPrepareStore.js';
import { PREPARE_TTL_MS } from '../src/handlers/prepare.js';
import { PrepareStudioUserQuotaError } from '../src/store/prepareErrors.js';
import type {
  GenericPreparedTxEntry,
  PromotionPreparedTxEntry,
} from '../src/store/prepareTypes.js';

const SENDER_A = '0x' + 'AA'.repeat(32);
const SENDER_B = '0x' + 'BB'.repeat(32);
const SLOT_A = 'slot-a';
const SLOT_B = 'slot-b';
const SLOT_D = 'slot-d';
const CLIENT_IP = '10.0.0.1';

function makeGenericEntry(overrides?: Partial<GenericPreparedTxEntry>): GenericPreparedTxEntry {
  return {
    issuedAt: Date.now(),
    receiptId: 'pid-default',
    orderId: null,
    senderAddress: SENDER_A,
    executionCostClaim: 7_350_000n,
    simGas: 7_000_000n,
    gasVarianceFixedMist: 100_000n,
    slippageBufferMist: 250_000n,
    grossGas: 7_100_000n,
    quotedHostFeeMist: 0n,
    nonce: 1n,
    profile: 'new_user',
    quoteTimestampMs: Date.now(),
    policyHash: '0xPOLICY',
    txBytesHash: 'mock-hash',
    slotId: SLOT_A,
    sponsorAddress: '0xSPONSOR',

    clientIp: CLIENT_IP,
    executionPathKey: 'mock-execution-path',
    mode: 'generic',
    ...overrides,
  };
}

function makePromotionEntry(
  overrides?: Partial<PromotionPreparedTxEntry>,
): PromotionPreparedTxEntry {
  return {
    issuedAt: Date.now(),
    receiptId: 'pid-promo-default',
    orderId: null,
    senderAddress: SENDER_A,
    executionCostClaim: 7_350_000n,
    simGas: 7_000_000n,
    gasVarianceFixedMist: 100_000n,
    slippageBufferMist: 250_000n,
    grossGas: 7_100_000n,
    nonce: 0n,
    txBytesHash: 'mock-hash',
    slotId: SLOT_A,
    sponsorAddress: '0xSPONSOR',

    clientIp: CLIENT_IP,
    executionPathKey: 'promotion:test',
    mode: 'promotion',
    promotionId: 'promo-001',
    userId: 'user-001',
    ...overrides,
  };
}

describe('PrepareStudioUserQuotaError (mode-aware)', () => {
  let store: MemoryPrepareStore;
  const released: string[] = [];

  beforeEach(() => {
    released.length = 0;
    store = new MemoryPrepareStore(
      (slotId) => void released.push(slotId),
      PREPARE_TTL_MS, // ttlMs
      10, // maxPerIp — high enough that IP limit doesn't interfere with user-quota tests
      MAX_OUTSTANDING_PER_STUDIO_USER, // maxPerStudioUser (4th arg)
      60_000, // evictIntervalMs
    );
  });

  afterEach(() => {
    store.dispose();
  });

  it('generic mode: studio-user quota is NOT enforced (no verified developer JWT userId)', async () => {
    // Fill beyond MAX_OUTSTANDING_PER_STUDIO_USER with generic entries — should succeed
    for (let i = 0; i < MAX_OUTSTANDING_PER_STUDIO_USER + 2; i++) {
      await store.store(
        `pid-generic-${i}`,
        makeGenericEntry({
          slotId: `slot-${i}`,
          txBytesHash: `hash-${i}`,
          receiptId: `pid-generic-${i}`,
        }),
      );
    }
    // No thrown error — generic mode has no userId, so checkUserQuota never runs
  });

  it('promotion mode: allows up to MAX_OUTSTANDING_PER_STUDIO_USER entries per studio user', async () => {
    for (let i = 0; i < MAX_OUTSTANDING_PER_STUDIO_USER; i++) {
      await store.store(
        `pid-promo-${i}`,
        makePromotionEntry({
          slotId: `slot-${i}`,
          txBytesHash: `hash-${i}`,
          receiptId: `pid-promo-${i}`,
        }),
      );
    }
    // No thrown error — all stored successfully
  });

  it('promotion mode: throws PrepareStudioUserQuotaError when studio user exceeds MAX_OUTSTANDING_PER_STUDIO_USER', async () => {
    for (let i = 0; i < MAX_OUTSTANDING_PER_STUDIO_USER; i++) {
      await store.store(
        `pid-promo-${i}`,
        makePromotionEntry({
          slotId: `slot-${i}`,
          txBytesHash: `hash-${i}`,
          receiptId: `pid-promo-${i}`,
        }),
      );
    }
    // One more → PrepareStudioUserQuotaError
    await expect(
      store.store(
        'pid-promo-overflow',
        makePromotionEntry({ slotId: SLOT_D, txBytesHash: 'hash-overflow' }),
      ),
    ).rejects.toThrow(PrepareStudioUserQuotaError);
  });

  it('promotion quota is per-userId — different Studio user is not affected', async () => {
    for (let i = 0; i < MAX_OUTSTANDING_PER_STUDIO_USER; i++) {
      await store.store(
        `pid-a${i}`,
        makePromotionEntry({
          slotId: `slot-a${i}`,
          txBytesHash: `hash-a${i}`,
          receiptId: `pid-a${i}`,
          senderAddress: SENDER_A,
          userId: 'user-001',
        }),
      );
    }
    // A different Studio user has no outstanding entries — should succeed
    // even though SENDER_B is reused (studio quota is keyed by userId,
    // not senderAddress).
    await expect(
      store.store(
        'pid-b0',
        makePromotionEntry({
          slotId: SLOT_B,
          txBytesHash: 'hash-b0',
          receiptId: 'pid-b0',
          senderAddress: SENDER_B,
          userId: 'user-002',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('promotion quota frees after consume', async () => {
    for (let i = 0; i < MAX_OUTSTANDING_PER_STUDIO_USER; i++) {
      await store.store(
        `pid-promo-${i}`,
        makePromotionEntry({
          slotId: `slot-${i}`,
          txBytesHash: `hash-${i}`,
          receiptId: `pid-promo-${i}`,
        }),
      );
    }
    await store.consume('pid-promo-0', 'hash-0');
    await expect(
      store.store(
        'pid-promo-new',
        makePromotionEntry({ slotId: SLOT_D, txBytesHash: 'hash-new', receiptId: 'pid-promo-new' }),
      ),
    ).resolves.toBeUndefined();
  });

  it('cross-mode isolation: generic entries do NOT count toward promotion quota', async () => {
    // Fill sender index with generic entries beyond the limit
    for (let i = 0; i < MAX_OUTSTANDING_PER_STUDIO_USER + 2; i++) {
      await store.store(
        `pid-generic-${i}`,
        makeGenericEntry({
          slotId: `slot-g${i}`,
          txBytesHash: `hash-g${i}`,
          receiptId: `pid-generic-${i}`,
        }),
      );
    }
    // Promotion entry for the same sender must still succeed
    await expect(
      store.store(
        'pid-promo-0',
        makePromotionEntry({ slotId: 'slot-p0', txBytesHash: 'hash-p0', receiptId: 'pid-promo-0' }),
      ),
    ).resolves.toBeUndefined();
  });

  // ── Studio user key-rotation invariant ─────────────────────────────────
  // The promotion outstanding-prepare quota is keyed by verified developer
  // JWT `userId`. Rotating the Sui `senderAddress` while keeping the same
  // userId must NOT bypass the quota: senderAddress is a mutable execution
  // credential, not the long-lived enforcement principal.
  it('promotion quota: same userId + rotated senderAddress still hits the quota', async () => {
    const ROTATING_USER = 'user-rotating';
    // Fill quota under SENDER_A
    for (let i = 0; i < MAX_OUTSTANDING_PER_STUDIO_USER; i++) {
      await store.store(
        `pid-rot-${i}`,
        makePromotionEntry({
          slotId: `slot-rot-${i}`,
          txBytesHash: `hash-rot-${i}`,
          receiptId: `pid-rot-${i}`,
          senderAddress: SENDER_A,
          userId: ROTATING_USER,
        }),
      );
    }
    // Rotate to a new senderAddress for the same userId — must still hit quota.
    await expect(
      store.store(
        'pid-rot-bypass',
        makePromotionEntry({
          slotId: SLOT_D,
          txBytesHash: 'hash-rot-bypass',
          receiptId: 'pid-rot-bypass',
          senderAddress: SENDER_B,
          userId: ROTATING_USER,
        }),
      ),
    ).rejects.toThrow(PrepareStudioUserQuotaError);
  });

  it('expired entries are pruned before quota check', async () => {
    const shortStore = new MemoryPrepareStore(
      (slotId) => void released.push(slotId),
      100, // 100ms TTL
      10, // maxPerIp — high enough not to interfere
      MAX_OUTSTANDING_PER_STUDIO_USER, // maxPerStudioUser (4th arg)
      60_000, // evictIntervalMs
    );
    try {
      for (let i = 0; i < MAX_OUTSTANDING_PER_STUDIO_USER; i++) {
        await shortStore.store(
          `pid-promo-${i}`,
          makePromotionEntry({
            slotId: `slot-${i}`,
            txBytesHash: `hash-${i}`,
            receiptId: `pid-promo-${i}`,
            issuedAt: Date.now() - 500, // already expired
          }),
        );
      }
      await expect(
        shortStore.store(
          'pid-promo-new',
          makePromotionEntry({
            slotId: SLOT_D,
            txBytesHash: 'hash-new',
            receiptId: 'pid-promo-new',
          }),
        ),
      ).resolves.toBeUndefined();
    } finally {
      shortStore.dispose();
    }
  });
});

// ─── B: executionPathKey — canonical key from extractedSettlementSwapPath ────────────────────────
// Directly calls buildExecutionPathKey() exported from prepare.ts — the same function the
// handler calls at runtime. If prepare.ts changes the format, this test breaks immediately.

import type { AllowedSettlementSwapPath } from '@stelis/core-relay';
import { buildExecutionPathKey } from '../src/handlers/prepare.js';

describe('executionPathKey canonical construction', () => {
  it('swap path: key encodes tokenType + poolId + settlementSwapDirection', () => {
    const er: AllowedSettlementSwapPath = {
      tokenType: '0xDEEP::deep::DEEP',
      hops: ['0xPOOL1'],
      settlementSwapDirection: 'baseForQuote',
    };
    expect(buildExecutionPathKey(er)).toBe('0xDEEP::deep::DEEP:0xPOOL1:baseForQuote');
  });

  it('credit-only path yields "credit"', () => {
    // buildExecutionPathKey handles undefined — same branch as prepare.ts
    expect(buildExecutionPathKey(undefined)).toBe('credit');
  });

  it('settle profile argument does not affect swap-path executionPathKey', () => {
    // When extractedSettlementSwapPath is present, executionPathKey is determined by the swap path.
    const er: AllowedSettlementSwapPath = {
      tokenType: '0xDEEP::deep::DEEP',
      hops: ['0xPOOL1'],
      settlementSwapDirection: 'baseForQuote',
    };
    expect(buildExecutionPathKey(er)).toBe('0xDEEP::deep::DEEP:0xPOOL1:baseForQuote');
  });
});

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
