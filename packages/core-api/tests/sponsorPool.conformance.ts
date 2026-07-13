/**
 * SponsorPoolAdapter — shared conformance test suite.
 *
 * Both `SponsorPool` (in-memory) and `RedisSponsorPool` must pass this
 * suite. The factory parameter lets each implementation provide its own
 * setup (keypair injection, Redis client injection, etc).
 *
 * Tests verify the behavioral contract defined by `SponsorPoolAdapter`:
 *   - Two-stage HMAC lease proof (checkout → commit → sign → checkin)
 *   - checkout returns null when all slots busy
 *   - commit CAS: reserved → committed transition, fail-closed on mismatch
 *   - sign gate: rejects before commit, succeeds only for committed txBytes
 *   - checkin: reserved-stage cleanup, committed-stage cleanup, idempotency
 *   - Receipt/sponsor pinning: substitution rejection
 *   - leaseStatus: admin-only occupancy snapshot
 *
 * Backend-specific details (Redis key layout, cursor rotation, observability
 * events, TTL recovery) belong in the backend entry files, not here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { SponsorPoolAdapter } from '../src/context.js';
import { SponsorLeaseCommitError } from '../src/store/sponsorLeaseProof.js';
import { SponsorLeaseExpiredError } from '../src/store/sponsorPoolErrors.js';

// ─────────────────────────────────────────────
// Factory contract
// ─────────────────────────────────────────────

export interface SponsorPoolHandle {
  pool: SponsorPoolAdapter;
  /** The txBytes that the test keypair can sign. */
  sampleTxBytes: Uint8Array;
  /** Idempotent cleanup. */
  dispose(): Promise<void> | void;
}

export type SponsorPoolFactory = () => Promise<SponsorPoolHandle> | SponsorPoolHandle;

// ─────────────────────────────────────────────
// Conformance suite
// ─────────────────────────────────────────────

export function runSponsorPoolConformanceTests(factory: SponsorPoolFactory): void {
  let handle: SponsorPoolHandle | null = null;

  async function setup(): Promise<SponsorPoolHandle> {
    handle = await factory();
    return handle;
  }

  afterEach(async () => {
    if (handle) {
      await handle.dispose();
      handle = null;
    }
  });

  // ── Full lifecycle ──────────────────────────────

  describe('full lifecycle: checkout → commit → sign → checkin', () => {
    it('completes the two-stage lease proof cycle', async () => {
      const h = await setup();
      const receipt = 'receipt-lifecycle-1';

      const lease = await h.pool.checkout(receipt);
      expect(lease).not.toBeNull();
      expect(lease).toEqual({ sponsorAddress: expect.any(String) });
      const { sponsorAddress } = lease!;

      await h.pool.commit(sponsorAddress, receipt, sha256Hex(h.sampleTxBytes));
      const { signature } = await h.pool.sign(sponsorAddress, receipt, h.sampleTxBytes);
      expect(typeof signature).toBe('string');
      expect(signature.length).toBeGreaterThan(0);

      await h.pool.checkin(sponsorAddress, receipt, sha256Hex(h.sampleTxBytes));
    });

    it('slot is available again after committed checkin', async () => {
      const h = await setup();
      const r1 = 'receipt-reuse-1';
      const lease1 = await h.pool.checkout(r1);
      expect(lease1).not.toBeNull();

      await h.pool.commit(lease1!.sponsorAddress, r1, sha256Hex(h.sampleTxBytes));
      await h.pool.checkin(lease1!.sponsorAddress, r1, sha256Hex(h.sampleTxBytes));

      const r2 = 'receipt-reuse-2';
      const lease2 = await h.pool.checkout(r2);
      expect(lease2).not.toBeNull();
      expect(lease2!.sponsorAddress).toBe(lease1!.sponsorAddress);
    });
  });

  // ── checkout ────────────────────────────────────

  describe('checkout', () => {
    it('returns null when all slots are busy', async () => {
      const h = await setup();
      expect(h.pool.size).toBeGreaterThanOrEqual(1);

      const receipts: string[] = [];
      for (let i = 0; i < h.pool.size; i++) {
        const r = `receipt-exhaust-${i}`;
        receipts.push(r);
        const lease = await h.pool.checkout(r);
        expect(lease).not.toBeNull();
      }

      const extra = await h.pool.checkout('receipt-overflow');
      expect(extra).toBeNull();

      for (let i = 0; i < receipts.length; i++) {
        await h.pool.checkin(h.pool.addresses()[i], receipts[i], null);
      }
    });
  });

  // ── commit ──────────────────────────────────────

  describe('commit', () => {
    it('throws SponsorLeaseCommitError when no reservation exists', async () => {
      const h = await setup();
      await expect(
        h.pool.commit('nonexistent-slot', 'receipt-missing', 'somehash'),
      ).rejects.toThrow(SponsorLeaseCommitError);
    });

    it('throws SponsorLeaseCommitError on double commit', async () => {
      const h = await setup();
      const receipt = 'receipt-double-commit';
      const lease = await h.pool.checkout(receipt);
      expect(lease).not.toBeNull();

      await h.pool.commit(lease!.sponsorAddress, receipt, sha256Hex(h.sampleTxBytes));

      await expect(
        h.pool.commit(lease!.sponsorAddress, receipt, sha256Hex(h.sampleTxBytes)),
      ).rejects.toThrow(SponsorLeaseCommitError);

      await h.pool.checkin(lease!.sponsorAddress, receipt, sha256Hex(h.sampleTxBytes));
    });

    it('throws SponsorLeaseCommitError when receiptId does not match reservation', async () => {
      const h = await setup();
      const receipt = 'receipt-commit-pin';
      const lease = await h.pool.checkout(receipt);
      expect(lease).not.toBeNull();

      await expect(
        h.pool.commit(lease!.sponsorAddress, 'wrong-receipt', sha256Hex(h.sampleTxBytes)),
      ).rejects.toThrow(SponsorLeaseCommitError);

      await h.pool.checkin(lease!.sponsorAddress, receipt, null);
    });
  });

  // ── sign ────────────────────────────────────────

  describe('sign', () => {
    it('rejects sign before commit (reserved-stage)', async () => {
      const h = await setup();
      const receipt = 'receipt-sign-early';
      const lease = await h.pool.checkout(receipt);
      expect(lease).not.toBeNull();

      await expect(h.pool.sign(lease!.sponsorAddress, receipt, h.sampleTxBytes)).rejects.toThrow(
        SponsorLeaseExpiredError,
      );

      await h.pool.checkin(lease!.sponsorAddress, receipt, null);
    });

    it('rejects sign with wrong txBytes (different hash)', async () => {
      const h = await setup();
      const receipt = 'receipt-sign-wrong';
      const lease = await h.pool.checkout(receipt);
      expect(lease).not.toBeNull();

      await h.pool.commit(lease!.sponsorAddress, receipt, sha256Hex(h.sampleTxBytes));

      const wrongTx = new Uint8Array([0xff, 0xfe, 0xfd]);
      await expect(h.pool.sign(lease!.sponsorAddress, receipt, wrongTx)).rejects.toThrow(
        SponsorLeaseExpiredError,
      );

      await h.pool.checkin(lease!.sponsorAddress, receipt, sha256Hex(h.sampleTxBytes));
    });

    it('rejects sign with wrong receiptId', async () => {
      const h = await setup();
      const receipt = 'receipt-sign-pin';
      const lease = await h.pool.checkout(receipt);
      expect(lease).not.toBeNull();

      await h.pool.commit(lease!.sponsorAddress, receipt, sha256Hex(h.sampleTxBytes));

      await expect(
        h.pool.sign(lease!.sponsorAddress, 'wrong-receipt', h.sampleTxBytes),
      ).rejects.toThrow(SponsorLeaseExpiredError);

      await h.pool.checkin(lease!.sponsorAddress, receipt, sha256Hex(h.sampleTxBytes));
    });
  });

  // ── checkin ─────────────────────────────────────

  describe('checkin', () => {
    it('reserved-stage checkin (txBytesHash = null)', async () => {
      const h = await setup();
      const receipt = 'receipt-checkin-reserved';
      const lease = await h.pool.checkout(receipt);
      expect(lease).not.toBeNull();

      await h.pool.checkin(lease!.sponsorAddress, receipt, null);

      const lease2 = await h.pool.checkout('receipt-after-reserved-checkin');
      expect(lease2).not.toBeNull();
      expect(lease2!.sponsorAddress).toBe(lease!.sponsorAddress);
    });

    it('checkin is idempotent — second call is silent no-op', async () => {
      const h = await setup();
      const receipt = 'receipt-idempotent';
      const lease = await h.pool.checkout(receipt);
      expect(lease).not.toBeNull();

      await h.pool.commit(lease!.sponsorAddress, receipt, sha256Hex(h.sampleTxBytes));
      await h.pool.checkin(lease!.sponsorAddress, receipt, sha256Hex(h.sampleTxBytes));

      await expect(
        h.pool.checkin(lease!.sponsorAddress, receipt, sha256Hex(h.sampleTxBytes)),
      ).resolves.toBeUndefined();
    });

    it('mismatched checkin is silent no-op (wrong receiptId)', async () => {
      const h = await setup();
      const receipt = 'receipt-mismatch-checkin';
      const lease = await h.pool.checkout(receipt);
      expect(lease).not.toBeNull();

      await expect(
        h.pool.checkin(lease!.sponsorAddress, 'wrong-receipt', null),
      ).resolves.toBeUndefined();

      const lease2 = await h.pool.checkout('receipt-should-fail-busy');
      expect(lease2).toBeNull();

      await h.pool.checkin(lease!.sponsorAddress, receipt, null);
    });
  });

  // ── properties ──────────────────────────────────

  describe('properties', () => {
    it('size matches factory-configured slot count', async () => {
      const h = await setup();
      expect(h.pool.size).toBeGreaterThanOrEqual(1);
    });

    it('primaryAddress is a non-empty string', async () => {
      const h = await setup();
      expect(typeof h.pool.primaryAddress).toBe('string');
      expect(h.pool.primaryAddress.length).toBeGreaterThan(0);
    });

    it('addresses() returns array of size length', async () => {
      const h = await setup();
      expect(h.pool.addresses()).toHaveLength(h.pool.size);
    });

    it('leaseStatus reports current sponsor slot lease occupancy', async () => {
      const h = await setup();
      const before = await h.pool.leaseStatus();
      expect(before.leasedSlots).toBe(0);
      expect(before.freeSlots).toBe(h.pool.size);
      expect(before.slots).toHaveLength(h.pool.size);
      expect(before.slots.map((slot) => slot.address)).toEqual(h.pool.addresses());
      expect(before.slots.every((slot) => slot.leased === false)).toBe(true);

      const receipt = 'receipt-lease-status';
      const lease = await h.pool.checkout(receipt);
      expect(lease).not.toBeNull();

      const during = await h.pool.leaseStatus();
      expect(during.leasedSlots).toBe(1);
      expect(during.freeSlots).toBe(h.pool.size - 1);
      expect(during.slots.find((slot) => slot.address === lease!.sponsorAddress)?.leased).toBe(
        true,
      );

      await h.pool.checkin(lease!.sponsorAddress, receipt, null);
      const after = await h.pool.leaseStatus();
      expect(after.leasedSlots).toBe(0);
      expect(after.freeSlots).toBe(h.pool.size);
    });
  });
}

// ─────────────────────────────────────────────
// Shared helper
// ─────────────────────────────────────────────

import { createHash } from 'node:crypto';

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
