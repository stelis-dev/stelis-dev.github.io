/**
 * preparedCommitAdapter.test.ts — shared `composePreparedCommit` boundary.
 *
 * This file pins:
 *   - both routes (generic + Studio) project through one function;
 *   - the durable stored JSON shape is preserved (`mode` discriminator,
 *     coordination fields);
 *   - `composePreparedCommit()` returns the durable `PreparedTxEntry`
 *     union while mode-specific narrowing uses the store-layer entry types.
 *
 * The public prepare adapters now route through `composePreparedCommit`;
 * these tests keep that shared durable-entry projection locked directly.
 */
import { describe, test, expect } from 'vitest';
import {
  composePreparedCommit,
  isGenericPreparedCommit,
  isPromotionPreparedCommit,
  type GenericCommitInputs,
  type PromotionCommitInputs,
} from '../src/session/sponsoredExecution/preparedCommit.js';
import type {
  GenericPreparedTxEntry,
  PreparedTxEntry,
  PromotionPreparedTxEntry,
} from '../src/store/prepareTypes.js';

// ─────────────────────────────────────────────
// Section 1 — coordination-field parity (both routes)
// ─────────────────────────────────────────────

describe('composePreparedCommit — coordination-field parity', () => {
  const COMMON = {
    receiptId: '0xRECEIPT',
    senderAddress: '0xSENDER',
    clientIp: '127.0.0.1',
    txBytesHash: 'a'.repeat(64),
    sponsorAddress: '0xSPONSOR',
    executionPathKey: 'credit',
    orderId: 'order-1',
    nonce: 7n,
    issuedAt: 1_700_000_000_000,
  };

  test('generic mode produces a durable generic entry with mode="generic" and no promotion fields', () => {
    const input: GenericCommitInputs = { mode: 'generic', ...COMMON };
    const commit = composePreparedCommit(input);
    expect(commit.mode).toBe('generic');
    expect(commit.receiptId).toBe(COMMON.receiptId);
    expect(commit.senderAddress).toBe(COMMON.senderAddress);
    expect(commit.clientIp).toBe(COMMON.clientIp);
    expect(commit.txBytesHash).toBe(COMMON.txBytesHash);
    expect(commit.sponsorAddress).toBe(COMMON.sponsorAddress);
    expect(commit.executionPathKey).toBe(COMMON.executionPathKey);
    expect(commit.orderId).toBe(COMMON.orderId);
    expect(commit.nonce).toBe(COMMON.nonce);
    expect(commit.issuedAt).toBe(COMMON.issuedAt);
    expect((commit as Record<string, unknown>).promotionId).toBeUndefined();
    expect((commit as Record<string, unknown>).userId).toBeUndefined();
    expect((commit as Record<string, unknown>).reservedGasMist).toBeUndefined();
  });

  test('promotion mode produces a durable promotion entry with promotion-specific fields', () => {
    const input: PromotionCommitInputs = {
      mode: 'promotion',
      ...COMMON,
      nonce: 0n, // promotion entries always persist nonce=0
      promotionId: 'promo-X',
      userId: 'user-Y',
      reservedGasMist: 1_400_000n,
    };
    const commit = composePreparedCommit(input);
    expect(commit.mode).toBe('promotion');
    if (commit.mode !== 'promotion') {
      throw new Error('expected promotion-mode commit');
    }
    expect(commit.promotionId).toBe('promo-X');
    expect(commit.userId).toBe('user-Y');
    expect(commit.reservedGasMist).toBe(1_400_000n);
    expect(commit.nonce).toBe(0n);
  });

  test('the orderId=null path round-trips correctly for generic', () => {
    const input: GenericCommitInputs = { mode: 'generic', ...COMMON, orderId: null };
    const commit = composePreparedCommit(input);
    expect(commit.orderId).toBeNull();
  });

  test('issuedAt defaults to clock.nowMs() when omitted', () => {
    const fakeClock = { nowMs: () => 1_700_999_999_999 };
    const input: GenericCommitInputs = {
      mode: 'generic',
      ...COMMON,
      issuedAt: undefined,
    };
    const commit = composePreparedCommit(input, fakeClock);
    expect(commit.issuedAt).toBe(1_700_999_999_999);
  });
});

// ─────────────────────────────────────────────
// Section 2 — durable store entry shape contract
// ─────────────────────────────────────────────

describe('composePreparedCommit — durable store entry shape contract', () => {
  test('durable prepared entry union accepts both modes without widening', () => {
    const generic: PreparedTxEntry = composePreparedCommit({
      mode: 'generic',
      receiptId: '0xR',
      senderAddress: '0xS',
      clientIp: '127.0.0.1',
      txBytesHash: 'h',
      sponsorAddress: '0xSP',
      executionPathKey: 'credit',
      orderId: null,
      nonce: 1n,
    });
    const promotion: PreparedTxEntry = composePreparedCommit({
      mode: 'promotion',
      receiptId: '0xR',
      senderAddress: '0xS',
      clientIp: '127.0.0.1',
      txBytesHash: 'h',
      sponsorAddress: '0xSP',
      executionPathKey: 'promotion:p1',
      orderId: null,
      nonce: 0n,
      promotionId: 'p1',
      userId: 'u1',
      reservedGasMist: 1n,
    });
    const asStoreEntry1: PreparedTxEntry = generic;
    const asStoreEntry2: PreparedTxEntry = promotion;
    expect(asStoreEntry1.mode).toBe('generic');
    expect(asStoreEntry2.mode).toBe('promotion');
  });
});

// ─────────────────────────────────────────────
// Section 3 — discrimination guards
// ─────────────────────────────────────────────

describe('composePreparedCommit — type guards', () => {
  const generic = composePreparedCommit({
    mode: 'generic',
    receiptId: '0xR',
    senderAddress: '0xS',
    clientIp: '127.0.0.1',
    txBytesHash: 'h',
    sponsorAddress: '0xSP',
    executionPathKey: 'credit',
    orderId: null,
    nonce: 1n,
  });
  const promotion = composePreparedCommit({
    mode: 'promotion',
    receiptId: '0xR',
    senderAddress: '0xS',
    clientIp: '127.0.0.1',
    txBytesHash: 'h',
    sponsorAddress: '0xSP',
    executionPathKey: 'promotion:p1',
    orderId: null,
    nonce: 0n,
    promotionId: 'p1',
    userId: 'u1',
    reservedGasMist: 1n,
  });

  test('isGenericPreparedCommit narrows correctly', () => {
    expect(isGenericPreparedCommit(generic)).toBe(true);
    expect(isGenericPreparedCommit(promotion)).toBe(false);
    if (isGenericPreparedCommit(generic)) {
      // Type-narrowed: promotion fields are absent.
      const narrowed: GenericPreparedTxEntry = generic;
      expect(narrowed.mode).toBe('generic');
      expect((generic as Record<string, unknown>).promotionId).toBeUndefined();
    }
  });

  test('isPromotionPreparedCommit narrows correctly', () => {
    expect(isPromotionPreparedCommit(promotion)).toBe(true);
    expect(isPromotionPreparedCommit(generic)).toBe(false);
    if (isPromotionPreparedCommit(promotion)) {
      const narrowed: PromotionPreparedTxEntry = promotion;
      expect(narrowed.promotionId).toBe('p1');
    }
  });
});

// ─────────────────────────────────────────────
// Section 4 — directory barrel hygiene (the new types are reachable
// only via the `sponsoredExecution` directory, not the package main
// barrel)
// ─────────────────────────────────────────────

describe('composePreparedCommit — module API', () => {
  test('the package main barrel does NOT re-export prepared-entry composer helpers', async () => {
    const mainBarrel = await import('@stelis/core-api');
    expect(Object.prototype.hasOwnProperty.call(mainBarrel, 'composePreparedCommit')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(mainBarrel, 'isGenericPreparedCommit')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(mainBarrel, 'isPromotionPreparedCommit')).toBe(
      false,
    );
  });

  test('the directory internal barrel exposes the public API', async () => {
    const barrel = (await import('../src/session/sponsoredExecution/index.js')) as Record<
      string,
      unknown
    >;
    expect(barrel.composePreparedCommit).toBeDefined();
    expect(barrel.isGenericPreparedCommit).toBeDefined();
    expect(barrel.isPromotionPreparedCommit).toBeDefined();
  });
});
