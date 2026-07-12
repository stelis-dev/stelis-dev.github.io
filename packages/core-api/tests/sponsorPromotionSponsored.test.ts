/**
 * sponsorPromotionSponsored.test.ts — unit tests for handlePromotionSponsor.
 *
 * Handler receives pre-verified VerifiedDeveloperIdentity.
 * JWT verification is route-layer responsibility — not tested here.
 *
 * Tests validate handler-level fail-closed gates:
 *   - mode='promotion' gate (rejects generic-mode receipts)
 *   - promotionId mismatch (receipt vs path)
 *   - senderAddress re-verification (verified identity vs prepared sender)
 *   - PTB structure + global target policy enforcement
 *   - sender signature cryptographic verification
 *   - hash mismatch (tamper detection)
 *   - gas overrun
 *   - gasUsed missing → fail-closed
 *   - use window expiry
 *   - successful flow (simulate → sign → execute → consume)
 */
import { describe, test, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { hashTargets } from '../src/studio/promotionTargetPolicy.js';
import {
  handlePromotionSponsor,
  PromotionSponsorError,
  type PromotionSponsorContext,
} from '../src/studio/sponsorPromotionSponsoredHandler.js';
import { SponsorCongestionError, SponsorLeaseExpiredError } from '../src/handlers/sponsor.js';
import { MemoryPromotionExecutionLedger } from '../src/studio/executionLedgerMemory.js';
import { MemoryPrepareStore } from '../src/store/memoryPrepareStore.js';
import { MemoryAbuseBlocker } from '../src/store/memoryAbuseBlocker.js';
import { SponsorPool } from '../src/context.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64, toHex, toBase58 } from '@mysten/sui/utils';
import type { PromotionPreparedTxEntry } from '../src/store/prepareTypes.js';
import type { VerifiedDeveloperIdentity } from '../src/studio/developerJwtVerifier.js';
import type {
  SponsorResultCallback,
  SponsorResultMetadata,
} from '../src/handlers/sponsorResult.js';
import {
  congestedObjectsExecutionError,
  grpcExecutionFailure,
  grpcExecutionSuccess,
  grpcSimulationFailure,
  grpcSimulationSuccess,
  moveAbortExecutionError,
} from './helpers/suiGrpcExecutionFixtures.js';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const TEST_PROMO_ID = 'sponsor-promo-1';
const TEST_USER_ID = 'sponsor-user-1';
const PER_USER_ALLOWANCE = '100000000'; // 0.1 SUI
const ALLOWED_TARGET =
  '0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin';
const GLOBAL_TARGET_HASHES = new Set(hashTargets([ALLOWED_TARGET]));
const TEST_DEEPBOOK_PACKAGE_ID = '0xdef';

// Fixed test keypairs
const SPONSOR_KP = Ed25519Keypair.generate();
const USER_KP = Ed25519Keypair.generate();
const USER_ADDR = USER_KP.toSuiAddress();
// 32+ char HMAC secret for the in-memory sponsor pool lease proofs.
const TEST_HMAC_SECRET = 'sponsor-promotion-test-hmac-secret-000';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Build a pre-verified identity (simulating what the route layer produces). */
function buildIdentity(overrides?: Partial<VerifiedDeveloperIdentity>): VerifiedDeveloperIdentity {
  return {
    userId: overrides?.userId ?? TEST_USER_ID,
    senderAddress: overrides?.senderAddress ?? USER_ADDR,
  };
}

/** Build a user TX (full bytes, with sender+gas owner set), return txBytes + hash + userSig. */
async function buildSignedTx() {
  const kindTx = new Transaction();
  kindTx.moveCall({ target: ALLOWED_TARGET as `${string}::${string}::${string}` });
  const kindBytes = await kindTx.build({ onlyTransactionKind: true });

  const tx = Transaction.fromKind(kindBytes);
  tx.setSender(USER_ADDR);
  tx.setGasOwner(SPONSOR_KP.toSuiAddress());
  tx.setGasBudget(2_000_000n);
  tx.setGasPrice(1000);
  const digestBytes = new Uint8Array(32);
  digestBytes.fill(1);
  tx.setGasPayment([
    {
      objectId: '0x' + '0'.repeat(64),
      version: '1',
      digest: toBase58(digestBytes),
    },
  ]);

  const txBytes = await tx.build();
  const txHash = createHash('sha256').update(txBytes).digest('hex');
  const userSig = await USER_KP.signTransaction(txBytes);

  return {
    txBytes,
    txBytesBase64: toBase64(txBytes),
    txHash,
    userSignature: userSig.signature,
  };
}

function createMockSui(opts?: {
  simFail?: boolean;
  simFailReason?: string;
  execFail?: boolean;
  execFailReason?: string;
  execCongestion?: boolean;
  highGas?: boolean;
  noGasUsed?: boolean;
  /**
   * Simulate a non-congestion `executeTransaction` throw —
   * `signAndSubmit` rethrows after the sponsor signature was already
   * issued by `pool.sign()`. The Studio sponsor sign/submit port must
   * consume the full reserved amount and emit the reconciliation event.
   */
  submitThrows?: boolean;
  submitThrowMessage?: string;
  /**
   * Simulate an on-chain revert that DOES carry `gasUsed` in
   * the failure-path effects. The default `execFail: true` returns a
   * FailedTransaction with a non-canonical gas summary, exercising the
   * `onchain_revert_gas_unknown` branch.
   */
  revertWithGasUsed?: boolean;
  /**
   * Regression input: simulate a revert whose `gasUsed` produces a
   * non-positive `simGas` (rebate >= computation + storage — e.g. a
   * delete-objects-only TX that reverts post-effects). The handler
   * must still classify this as `onchain_revert` (gasUsed present;
   * 0-clamp via `computeExecutionCostClaim.simGas`), NOT
   * `onchain_revert_gas_unknown`.
   */
  zeroNetRevert?: boolean;
}) {
  const gasCost = opts?.highGas
    ? { computationCost: '999999999999', storageCost: '500000000', storageRebate: '200000' }
    : opts?.zeroNetRevert
      ? // computation + storage − rebate = 700_000 + 300_000 - 1_500_000 < 0
        // → simGas clamps to 0n.
        { computationCost: '700000', storageCost: '300000', storageRebate: '1500000' }
      : { computationCost: '1000000', storageCost: '500000', storageRebate: '200000' };

  return {
    simulateTransaction: async () => {
      if (opts?.simFail) {
        const reason = opts.simFailReason ?? 'sim-error';
        return grpcSimulationFailure(
          'mock-simulation-failure',
          moveAbortExecutionError(reason),
          gasCost,
        );
      }
      return grpcSimulationSuccess('mock-digest', gasCost);
    },
    executeTransaction: async () => {
      if (opts?.submitThrows) {
        throw new Error(opts.submitThrowMessage ?? 'rpc transport error');
      }
      if (opts?.execFail) {
        const reason = opts.execFailReason ?? 'exec-error';
        const error = opts.execCongestion
          ? congestedObjectsExecutionError(reason)
          : moveAbortExecutionError(reason);
        const failed = grpcExecutionFailure('tx-digest-revert', error, gasCost);
        if (opts.revertWithGasUsed || opts.execCongestion) return failed;
        return {
          ...failed,
          FailedTransaction: {
            ...failed.FailedTransaction,
            effects: {
              ...failed.FailedTransaction.effects,
              gasUsed: {},
            },
          },
        };
      }
      const success = grpcExecutionSuccess('tx-digest-abc', gasCost);
      if (!opts?.noGasUsed) return success;
      return {
        ...success,
        Transaction: {
          ...success.Transaction,
          effects: {
            ...success.Transaction.effects,
            gasUsed: {},
          },
        },
      };
    },
  } as unknown as import('@mysten/sui/grpc').SuiGrpcClient;
}

// ─────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────

async function setup(opts?: {
  simFail?: boolean;
  simFailReason?: string;
  execFail?: boolean;
  execFailReason?: string;
  execCongestion?: boolean;
  highGas?: boolean;
  noGasUsed?: boolean;
  submitThrows?: boolean;
  submitThrowMessage?: string;
  revertWithGasUsed?: boolean;
  zeroNetRevert?: boolean;
  /**
   * When set, an in-memory usageStore captures every
   * `usageStore.append()` call so tests can verify failure-path
   * `result: 'failed'` rows are emitted with the right `failureReason`.
   */
  withUsageCapture?: boolean;
}) {
  const executionLedger = new MemoryPromotionExecutionLedger();
  const sponsorPool = new SponsorPool([SPONSOR_KP], { hmacSecret: TEST_HMAC_SECRET });
  const prepareStore = new MemoryPrepareStore((sponsorAddress, receiptId, txBytesHash) =>
    sponsorPool.checkin(sponsorAddress, receiptId, txBytesHash),
  );
  const abuseBlocker = new MemoryAbuseBlocker();

  // Claim promotion (creates entitlement via ExecutionLedger)
  await executionLedger.claim(TEST_PROMO_ID, TEST_USER_ID, {
    maxParticipants: 100,
    perUserGasAllowanceMist: PER_USER_ALLOWANCE,
    useUntilAt: null,
  });

  // Build and sign TX
  const signed = await buildSignedTx();

  // receiptId must exist before pool.checkout() so the lease proof can
  // bind receiptId and sponsorAddress deterministically.
  const receiptId = `0x${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;

  // Checkout a slot
  const slot = await sponsorPool.checkout(receiptId);
  if (!slot) throw new Error('No sponsor slot available');

  // Commit the slot lease to the final txBytesHash so
  // handlePromotionSponsor → pool.sign() can pass.
  await sponsorPool.commit(slot.sponsorAddress, receiptId, signed.txHash);

  // Reserve via executionLedger
  const reserveResult = await executionLedger.reserve({
    promotionId: TEST_PROMO_ID,
    userId: TEST_USER_ID,
    receiptId,
    amountMist: 2_000_000n,
  });
  if (!reserveResult.ok) throw new Error(`Reserve failed: ${reserveResult.reason}`);

  // Store in prepareStore with mode='promotion'
  const entry: PromotionPreparedTxEntry = {
    issuedAt: Date.now(),
    receiptId,
    reservedGasMist: 2_000_000n, // simGas + GAS_VARIANCE_FIXED_MIST
    txBytesHash: signed.txHash,
    senderAddress: USER_ADDR,
    sponsorAddress: slot.sponsorAddress,
    clientIp: '127.0.0.1',
    executionPathKey: `promotion:${TEST_PROMO_ID}`,
    orderId: null,
    nonce: 0n,
    mode: 'promotion',
    promotionId: TEST_PROMO_ID,
    userId: TEST_USER_ID,
  };
  await prepareStore.store(receiptId, entry);

  // Mock promotion store
  const promotionStore = {
    get: async (id: string) =>
      id === TEST_PROMO_ID
        ? {
            promotionId: TEST_PROMO_ID,
            type: 'gas_sponsorship' as const,
            displayName: 'Test Promo',
            description: '',
            status: 'active' as const,
            maxParticipants: 100,
            perUserGasAllowanceMist: PER_USER_ALLOWANCE,
            claimDeadlineAt: null,
            postClaimUseWindowMs: 0,
            startAt: null,
            pauseReason: null,
            archiveReason: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        : null,
    create: async () => {
      throw new Error('not needed');
    },
    list: async () => [],
    update: async () => null,
    delete: async () => true,
    transitionStatus: async () => null,
  } satisfies import('../src/studio/promotionStore.js').PromotionStoreAdapter;

  const usageRows: import('../src/studio/domain.js').CreateUsageEventInput[] = [];
  const usageStore = opts?.withUsageCapture
    ? ({
        append: async (row: import('../src/studio/domain.js').CreateUsageEventInput) => {
          usageRows.push(row);
        },
      } as import('../src/studio/promotionUsageStore.js').PromotionUsageStoreAdapter)
    : undefined;

  const ctx: PromotionSponsorContext = {
    sui: createMockSui(opts),
    // Trusted Stelis package ID for sponsor-time abort classification. The
    // fixtures below use `0xabc::vault` / `0xabc::settle` for trusted
    // Stelis aborts, so the test ctx must carry the matching package ID.
    packageId: '0xabc',
    deepbookPackageId: TEST_DEEPBOOK_PACKAGE_ID,
    promotionStore,
    executionLedger,
    sponsorPool,
    prepareStore,
    abuseBlocker,
    globalTargetHashes: GLOBAL_TARGET_HASHES,
    usageStore,
  };

  return {
    ctx,
    signed,
    receiptId,
    executionLedger,
    sponsorPool,
    prepareStore,
    promotionStore,
    usageRows,
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('handlePromotionSponsor', () => {
  test('rejects when receipt is mode=generic (not promotion)', async () => {
    const { ctx, signed, executionLedger } = await setup();

    const genericReceiptId = `0x${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;
    await ctx.prepareStore.store(genericReceiptId, {
      issuedAt: Date.now(),
      receiptId: genericReceiptId,
      txBytesHash: signed.txHash,
      senderAddress: USER_ADDR,
      sponsorAddress: SPONSOR_KP.toSuiAddress(),
      clientIp: '127.0.0.1',
      executionPathKey: 'generic-execution-path',
      orderId: null,
      nonce: 0n,
      mode: 'generic',
    });

    // Generic receipts have no promotion ledger reservation; the cleanup
    // contract for MODE_MISMATCH must NOT call executionLedger.release,
    // otherwise it emits a false-positive `reservation_not_found` warn.
    const releaseSpy = vi.spyOn(executionLedger, 'release');

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId: genericReceiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/not created via promotion prepare/);

    // Promotion ledger release must not fire for a generic-mode receipt.
    expect(releaseSpy).not.toHaveBeenCalled();

    // Destructive cleanup authority is reserved for stored-hash-verified and
    // corrupt-entry phases. The misrouted generic entry stays intact so
    // the legitimate `/relay/sponsor` caller can still consume it.
    const stillPeeked = await ctx.prepareStore.peek(genericReceiptId);
    expect(stillPeeked).not.toBeNull();
    expect(stillPeeked!.mode).toBe('generic');
    expect(stillPeeked!.receiptId).toBe(genericReceiptId);

    releaseSpy.mockRestore();
  });

  test('preserves entry + reservation on promotionId mismatch', async () => {
    const { ctx, signed, receiptId, executionLedger } = await setup();

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: 'wrong-promo',
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/does not match path/);

    // Pre-consume reject must not destroy the legitimate owner's session.
    const stillPeeked = await ctx.prepareStore.peek(receiptId);
    expect(stillPeeked).not.toBeNull();
    expect(stillPeeked!.receiptId).toBe(receiptId);
    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent!.activeReservationReceiptId).toBe(receiptId);
  });

  test('preserves entry + reservation when verified identity senderAddress mismatches', async () => {
    const { ctx, signed, receiptId, executionLedger } = await setup();
    const otherAddr = Ed25519Keypair.generate().toSuiAddress();

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity({ senderAddress: otherAddr }),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/senderAddress does not match/);

    const stillPeeked = await ctx.prepareStore.peek(receiptId);
    expect(stillPeeked).not.toBeNull();
    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent!.activeReservationReceiptId).toBe(receiptId);
  });

  test('preserves entry + reservation on disallowed MoveCall target', async () => {
    const { ctx, signed, receiptId, executionLedger } = await setup();

    // Use ctx with empty global target hashes → all targets disallowed
    ctx.globalTargetHashes = new Set<string>();

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/Disallowed MoveCall targets/);

    const stillPeeked = await ctx.prepareStore.peek(receiptId);
    expect(stillPeeked).not.toBeNull();
    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent!.activeReservationReceiptId).toBe(receiptId);
  });

  test('preserves entry + reservation on invalid sender signature', async () => {
    const { ctx, signed, receiptId, executionLedger } = await setup();
    const wrongKp = Ed25519Keypair.generate();
    const wrongSig = await wrongKp.signTransaction(signed.txBytes);

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: wrongSig.signature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/invalid or does not match/);

    const stillPeeked = await ctx.prepareStore.peek(receiptId);
    expect(stillPeeked).not.toBeNull();
    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent!.activeReservationReceiptId).toBe(receiptId);
  });

  test('legitimate caller succeeds on retry after a preserved preconsume reject', async () => {
    // This is the preserve-on-preconsume-reject contract: after an unauthenticated caller hits
    // SENDER_ADDRESS_MISMATCH with a leaked receiptId, the legitimate
    // owner must still be able to consume the prepared session in the
    // same /sponsor call without re-prepare.
    const { ctx, signed, receiptId, executionLedger } = await setup();
    const otherAddr = Ed25519Keypair.generate().toSuiAddress();

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity({ senderAddress: otherAddr }),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/senderAddress does not match/);

    // Legitimate caller now drives the same receiptId through /sponsor.
    const result = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    });

    expect(result.digest).toBe('tx-digest-abc');
    // After success the reservation is consumed, not released
    // by the rejected attacker. `activeReservationReceiptId` is cleared
    // by the success path, not by the preconsume reject above.
    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent!.activeReservationReceiptId).toBeNull();
    expect(BigInt(ent!.consumedGasAllowanceMist)).toBeGreaterThan(0n);
  });

  test('rejects txBytes hash mismatch (tamper detection) and releases ledger reservation', async () => {
    const { ctx, receiptId, executionLedger } = await setup();

    const emptyKind = new Transaction();
    const emptyKindBytes = await emptyKind.build({ onlyTransactionKind: true });
    const tx2 = Transaction.fromKind(emptyKindBytes);
    tx2.setSender(USER_ADDR);
    tx2.setGasOwner(SPONSOR_KP.toSuiAddress());
    tx2.setGasBudget(2_000_000n);
    tx2.setGasPrice(1000);
    const digestBytes = new Uint8Array(32);
    digestBytes.fill(2);
    tx2.setGasPayment([
      {
        objectId: '0x' + '0'.repeat(64),
        version: '1',
        digest: toBase58(digestBytes),
      },
    ]);
    const tamperedBytes = await tx2.build();
    const tamperedSig = await USER_KP.signTransaction(tamperedBytes);

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: toBase64(tamperedBytes),
        userSignature: tamperedSig.signature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/hash mismatch|Disallowed/);

    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent).not.toBeNull();
    expect(ent!.activeReservationReceiptId).toBeNull();
    expect(ent!.activeReservationAmountMist).toBeNull();
  });

  // ── gasOwner mismatch — post-consume drift classification ──────────────
  //
  // Mirrors the generic handleSponsor behaviour: post-consume
  // `GasOwnerMismatchError` is server-side coordination drift, not user
  // abuse. The stored-hash-verified consume() has already proved the submitted bytes
  // are byte-identical to the /prepare commit, so the gas owner embedded in
  // the PTB is exactly what /prepare built. A mismatch against
  // `prepared.sponsorAddress` therefore points at store coordination drift
  // (rolling deploy, slot recycled server-side) — not tampering.
  //
  // Expected behavior:
  //   - Error code: `REPREPARE_REQUIRED` (not `GAS_OWNER_MISMATCH`)
  //   - No IP or studio-user abuse recorded
  //   - `SPONSOR_DRIFT_OBSERVED` structured log emitted with
  //     `route: 'promotion'` and `subcode: 'GAS_OWNER_MISMATCH'`
  test('gasOwner mismatch → REPREPARE_REQUIRED drift, no abuse, SPONSOR_DRIFT_OBSERVED, ledger released', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { ctx, signed, receiptId, executionLedger } = await setup();

    // Pre-condition: the reservation created by setup() is active and
    // bound to this receiptId.
    const entBefore = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(entBefore).not.toBeNull();
    expect(entBefore!.activeReservationReceiptId).toBe(receiptId);

    // Tamper the stored entry's sponsorAddress to simulate server-side slot
    // coordination drift. The submitted txBytes are unchanged (still pass
    // the consume() hash binding) but verifyGasOwner will see the drifted
    // value and fail. This is the scenario this test covers.
    //
    // White-box access to the in-memory store map is justified: no public
    // API lets an external actor mutate a stored entry, and drift is
    // precisely a server-side internal-state condition. This matches the
    // generic sponsor test pattern in handleSponsor.test.ts.
    const wrongSponsor = '0x' + 'bb'.repeat(32);
    const entriesMap = (
      ctx.prepareStore as unknown as { _entries: Map<string, PromotionPreparedTxEntry> }
    )._entries;
    const existing = entriesMap.get(receiptId);
    expect(existing).toBeDefined();
    entriesMap.set(receiptId, { ...existing!, sponsorAddress: wrongSponsor });

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('REPREPARE_REQUIRED');

    // No abuse recorded — post-consume drift, stored-hash-verified internal state.
    await expect(ctx.abuseBlocker.checkIp('127.0.0.1')).resolves.toMatchObject({
      blocked: false,
    });
    await expect(
      ctx.abuseBlocker.checkSubject({ kind: 'studio_user', userId: TEST_USER_ID }),
    ).resolves.toMatchObject({
      blocked: false,
    });

    // Operator observability: SPONSOR_DRIFT_OBSERVED emitted with
    // promotion-specific route tag.
    const driftLog = infoSpy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(call[0] as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((entry) => entry && entry['event'] === 'SPONSOR_DRIFT_OBSERVED');
    expect(driftLog).toBeDefined();
    expect(driftLog!['stage']).toBe('gas_owner_mismatch');
    expect(driftLog!['subcode']).toBe('GAS_OWNER_MISMATCH');
    expect(driftLog!['route']).toBe('promotion');
    expect(driftLog!['promotion_id']).toBe(TEST_PROMO_ID);
    expect(driftLog!['receipt_id']).toBe(receiptId);

    // Fail-closed cleanup contract: the ledger reservation tied to this
    // receiptId must have been released before the drift response was
    // returned. `activeReservationReceiptId` should be cleared so that a
    // subsequent /prepare call can reserve afresh without TTL aging.
    const entAfter = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(entAfter).not.toBeNull();
    expect(entAfter!.activeReservationReceiptId).toBeNull();
    expect(entAfter!.activeReservationAmountMist).toBeNull();

    infoSpy.mockRestore();
  });

  test('releases reservation on preflight failure', async () => {
    const { ctx, signed, receiptId, executionLedger } = await setup({ simFail: true });

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/Preflight simulation failed/);

    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent).not.toBeNull();
    expect(ent!.activeReservationReceiptId).toBeNull();
    expect(ent!.activeReservationAmountMist).toBeNull();
  });

  // Post-consume PREFLIGHT_FAILED records studio-user abuse keyed by
  // `peekedPromotion.userId` (the verified developer JWT principal). The
  // generic path records address-level abuse instead; promotion routes the
  // counter to the studio_user kind so a Sui key rotation cannot evade the
  // accumulated failure history.
  test('records studio-user abuse on preflight failure', async () => {
    const { ctx, signed, receiptId } = await setup({ simFail: true });
    const recordSpy = vi.spyOn(ctx.abuseBlocker, 'recordSponsorFailure');

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/Preflight simulation failed/);

    const preflightCalls = recordSpy.mock.calls.filter((args) => args[2] === 'PREFLIGHT_FAILED');
    expect(preflightCalls.length).toBe(1);
    const [ip, subject, code, meta] = preflightCalls[0]!;
    expect(ip).toBe('127.0.0.1');
    expect(subject).toEqual({ kind: 'studio_user', userId: TEST_USER_ID });
    expect(code).toBe('PREFLIGHT_FAILED');
    expect(meta).toEqual({
      subcode: 'simulation_failed',
      executionPathKey: `promotion:${TEST_PROMO_ID}`,
    });

    recordSpy.mockRestore();
  });

  // Blocker adapter failures must not mask the primary classified sponsor
  // rejection. The swallow is owned by `recordSponsorFailureForAbuse`
  // (helper in `abuseBlocking.ts`). The Studio SponsoredExecutionPolicy carries no inline
  // try/catch, and this test verifies the route-level behavior that mirrors
  // the generic path in `handleSponsor.test.ts`.
  test('preserves PromotionSponsorError when abuse blocker recordSponsorFailure throws', async () => {
    const { ctx, signed, receiptId } = await setup({ simFail: true });
    const recordSpy = vi
      .spyOn(ctx.abuseBlocker, 'recordSponsorFailure')
      .mockRejectedValue(new Error('redis unreachable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // Primary classified rejection must survive the recorder fault.
      await expect(
        handlePromotionSponsor(ctx, {
          promotionId: TEST_PROMO_ID,
          receiptId,
          txBytes: signed.txBytesBase64,
          userSignature: signed.userSignature,
          verifiedIdentity: buildIdentity(),
          clientIp: '127.0.0.1',
        }),
      ).rejects.toThrow(/Preflight simulation failed/);

      // Recorder still invoked at the postconsume PREFLIGHT_FAILED site.
      const preflightCalls = recordSpy.mock.calls.filter((args) => args[2] === 'PREFLIGHT_FAILED');
      expect(preflightCalls.length).toBe(1);
      const [ip, subject, code] = preflightCalls[0]!;
      expect(ip).toBe('127.0.0.1');
      expect(subject).toEqual({ kind: 'studio_user', userId: TEST_USER_ID });
      expect(code).toBe('PREFLIGHT_FAILED');

      // Recorder degradation observable via SPONSOR_FAILURE_RECORDER_FAILED.
      const recorderFailed = warnSpy.mock.calls
        .map((call) => {
          try {
            return JSON.parse(String(call[0])) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find(
          (entry): entry is Record<string, unknown> =>
            entry?.['event'] === 'SPONSOR_FAILURE_RECORDER_FAILED',
        );
      expect(recorderFailed).toBeDefined();
      expect(recorderFailed!['code']).toBe('PREFLIGHT_FAILED');
      expect(recorderFailed!['error']).toBe('redis unreachable');
      expect(recorderFailed!['executionPathKey']).toBe(`promotion:${TEST_PROMO_ID}`);
    } finally {
      recordSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('logs LEDGER_RELEASE_FAILED_IN_HANDLER when ledger.release returns failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, signed, receiptId } = await setup({ simFail: true });

    ctx.executionLedger.release = async () => ({ ok: false, reason: 'reservation_not_found' });

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/Preflight simulation failed/);

    const calls = errorSpy.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('LEDGER_RELEASE_FAILED_IN_HANDLER'),
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);

    errorSpy.mockRestore();
  });

  test('logs LEDGER_RELEASE_THREW_IN_HANDLER when ledger.release throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, signed, receiptId } = await setup({ simFail: true });

    ctx.executionLedger.release = async () => {
      throw new Error('release exploded');
    };

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/Preflight simulation failed/);

    const calls = errorSpy.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('LEDGER_RELEASE_THREW_IN_HANDLER'),
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);

    errorSpy.mockRestore();
  });

  test('on-chain revert terminalizes the active reservation (consume, not release)', async () => {
    // Post-signature/post-submit revert without `gasUsed` consumes
    // `prepared.reservedGasMist` (the gas-unknown branch consumes the
    // full reserved amount). The active-reservation lock asserts the
    // reservation is no longer in flight; `consumedGasAllowanceMist`
    // would be `'0'` under a release policy, so this assertion also
    // locks the consume-not-release contract for this branch.
    const { ctx, signed, receiptId, executionLedger } = await setup({ execFail: true });

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/reverted on-chain/);

    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent).not.toBeNull();
    expect(ent!.activeReservationReceiptId).toBeNull();
    expect(ent!.activeReservationAmountMist).toBeNull();
    // Full reserved consume (no gasUsed branch).
    expect(ent!.consumedGasAllowanceMist).toBe('2000000');
  });

  // The actual promotion command is 0x2::coin::Coin. A Stelis abort string at
  // that outer command is impossible provenance and must stay unclassified.
  test('does not classify an unrelated Stelis abort string for a promotion coin command', async () => {
    const { ctx, signed, receiptId } = await setup({
      simFail: true,
      simFailReason: 'MoveAbort(0xabc::vault::check_and_advance_nonce, 1) in command 0',
    });
    const recordSpy = vi.spyOn(ctx.abuseBlocker, 'recordSponsorFailure');

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('PREFLIGHT_FAILED');
    expect((err as PromotionSponsorError).subcode).toBeUndefined();

    const preflightCalls = recordSpy.mock.calls.filter((args) => args[2] === 'PREFLIGHT_FAILED');
    expect(preflightCalls.length).toBe(1);
    const [, , , meta] = preflightCalls[0]!;
    expect(meta).toEqual({
      subcode: 'simulation_failed',
      executionPathKey: `promotion:${TEST_PROMO_ID}`,
    });

    recordSpy.mockRestore();
  });

  // Unclassified promotion preflight failure keeps `simulation_failed` in
  // abuse meta but does NOT expose it as `PromotionSponsorError.subcode`.
  // Public subcode is reserved for recognized `SponsorFailureSubcode` values.
  test('keeps unclassified preflight failure subcode internal (PromotionSponsorError.subcode undefined)', async () => {
    const { ctx, signed, receiptId } = await setup({
      simFail: true,
      simFailReason: 'unrecognized RPC error string',
    });
    const recordSpy = vi.spyOn(ctx.abuseBlocker, 'recordSponsorFailure');

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('PREFLIGHT_FAILED');
    expect((err as PromotionSponsorError).subcode).toBeUndefined();

    const preflightCalls = recordSpy.mock.calls.filter((args) => args[2] === 'PREFLIGHT_FAILED');
    expect(preflightCalls.length).toBe(1);
    const [, , , meta] = preflightCalls[0]!;
    expect(meta).toEqual({
      subcode: 'simulation_failed',
      executionPathKey: `promotion:${TEST_PROMO_ID}`,
    });

    recordSpy.mockRestore();
  });

  // The same provenance rule applies to the terminal execution result.
  test('does not classify an unrelated Stelis on-chain abort for a promotion coin command', async () => {
    const { ctx, signed, receiptId } = await setup({
      execFail: true,
      execFailReason: 'MoveAbort(0xabc::vault::check_and_advance_nonce, 1) in command 0',
    });
    const recordSpy = vi.spyOn(ctx.abuseBlocker, 'recordSponsorFailure');

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('ONCHAIN_REVERT');
    expect((err as PromotionSponsorError).subcode).toBeUndefined();

    const onchainCalls = recordSpy.mock.calls.filter((args) => args[2] === 'ONCHAIN_REVERT');
    expect(onchainCalls.length).toBe(1);
    const [, , , meta] = onchainCalls[0]!;
    expect(meta).toEqual({
      subcode: 'onchain_revert',
      executionPathKey: `promotion:${TEST_PROMO_ID}`,
    });

    recordSpy.mockRestore();
  });

  // Unclassified on-chain revert keeps the `'onchain_revert'` fallback
  // literal in abuse meta only — the fallback literal is never exposed
  // as a public `subcode` on `PromotionSponsorError`.
  test('falls back to onchain_revert subcode in abuse meta and keeps PromotionSponsorError.subcode undefined', async () => {
    const { ctx, signed, receiptId } = await setup({ execFail: true });
    const recordSpy = vi.spyOn(ctx.abuseBlocker, 'recordSponsorFailure');

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('ONCHAIN_REVERT');
    expect((err as PromotionSponsorError).subcode).toBeUndefined();

    const onchainCalls = recordSpy.mock.calls.filter((args) => args[2] === 'ONCHAIN_REVERT');
    expect(onchainCalls.length).toBe(1);
    const [, , , meta] = onchainCalls[0]!;
    expect(meta).toEqual({
      subcode: 'onchain_revert',
      executionPathKey: `promotion:${TEST_PROMO_ID}`,
    });

    recordSpy.mockRestore();
  });

  test('congestion throws SponsorCongestionError, releases reservation, and does NOT record abuse', async () => {
    const { ctx, signed, receiptId, executionLedger } = await setup();
    const abuseBlocker = ctx.abuseBlocker;

    // Only the current SDK CongestedObjects terminal kind proves that the
    // sponsor-signed transaction was cancelled before on-chain execution.
    (ctx.sui as unknown as { executeTransaction: unknown }).executeTransaction = async () =>
      grpcExecutionFailure('congestion-digest', congestedObjectsExecutionError());

    const recordSpy = vi.spyOn(abuseBlocker, 'recordSponsorFailure');

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect((err as Error).name).toBe('SponsorCongestionError');

    // Reservation was released.
    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent!.activeReservationReceiptId).toBeNull();

    // No abuse recording — congestion is infra contention, not user abuse.
    const onchainRevertCalls = recordSpy.mock.calls.filter((call) => call[2] === 'ONCHAIN_REVERT');
    expect(onchainRevertCalls).toHaveLength(0);

    recordSpy.mockRestore();
  });

  test('gas-budget parity mismatch throws REPREPARE_REQUIRED and releases reservation (server-side drift)', async () => {
    const { ctx, signed, receiptId, executionLedger, prepareStore } = await setup();

    // Simulate post-consume server-side drift: the prepared entry's
    // `reservedGasMist` differs from the built tx's gas budget.
    // Overwrite the stored entry so consume() succeeds (stored-hash-verified) but
    // the reservedGasMist field disagrees with the PTB's gasData.budget.
    const peeked = await prepareStore.peek(receiptId);
    if (!peeked || peeked.mode !== 'promotion') throw new Error('expected promotion entry');
    await prepareStore.store(receiptId, {
      ...peeked,
      reservedGasMist: peeked.reservedGasMist + 1n,
    });

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('REPREPARE_REQUIRED');
    expect((err as PromotionSponsorError).statusHint).toBe(422);

    // Reservation was released (defense-in-depth drift cleanup).
    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent!.activeReservationReceiptId).toBeNull();
  });

  test('succeeds and returns digest + actualGasMist', async () => {
    const { ctx, signed, receiptId } = await setup();

    const result = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    });

    expect(result.digest).toBe('tx-digest-abc');
    expect(BigInt(result.actualGasMist)).toBeGreaterThan(0n);
  });

  test('usage recorder append rejection preserves success response and emits PROMOTION_USAGE_RECORDER_FAILED warn', async () => {
    const { ctx, signed, receiptId } = await setup();
    ctx.usageStore = {
      append: async () => {
        throw new Error('usage-store-unreachable');
      },
      getByReceipt: async () => [],
      getByUser: async () => [],
      getByPromotion: async () => [],
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      });

      expect(result.digest).toBe('tx-digest-abc');
      expect(BigInt(result.actualGasMist)).toBeGreaterThan(0n);

      const recorderFailed = warnSpy.mock.calls
        .map((call) => {
          try {
            return JSON.parse(String(call[0])) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find(
          (entry): entry is Record<string, unknown> =>
            entry?.['event'] === 'PROMOTION_USAGE_RECORDER_FAILED',
        );
      expect(recorderFailed).toBeDefined();
      expect(recorderFailed!['promotionId']).toBe(TEST_PROMO_ID);
      expect(recorderFailed!['receiptId']).toBe(receiptId);
      expect(recorderFailed!['userId']).toBe(TEST_USER_ID);
      expect(recorderFailed!['digest']).toBe('tx-digest-abc');
      expect(recorderFailed!['error']).toBe('usage-store-unreachable');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('gas overrun: consumes actual gas, deducts overrun from budget + allowance', async () => {
    const { ctx, signed, receiptId } = await setup({ highGas: true });

    const result = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    });

    expect(result.digest).toBe('tx-digest-abc');
    expect(BigInt(result.actualGasMist)).toBeGreaterThan(0n);
  });

  test('fail-closed when gasUsed missing from execution effects', async () => {
    const { ctx, signed, receiptId, executionLedger } = await setup({ noGasUsed: true });

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/cannot determine actual gas/);

    // Verify reservation terminalization. The post-success
    // `GAS_EFFECTS_MISSING` branch CONSUMES the full reserved amount
    // (release would leak the user's allowance because the TX executed
    // on-chain), so the active reservation must be cleared by consume —
    // not release. The detailed consumed-amount + usage row assertions
    // are locked in the `post-signature/post-submit ledger consume
    // policy` describe block; this test only asserts that the active
    // reservation pointer is dropped.
    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent).not.toBeNull();
    expect(ent!.activeReservationReceiptId).toBeNull();
    expect(ent!.activeReservationAmountMist).toBeNull();
    expect(ent!.consumedGasAllowanceMist).toBe('2000000');
  });

  test('releases reservation when consume returns expired (PREPARED_TX_EXPIRED)', async () => {
    const { ctx, signed, receiptId, executionLedger, prepareStore } = await setup();

    // Simulate the timing window: peek succeeds (entry alive), but
    // consume returns 'expired' (entry expired between peek and consume).
    // Override consume only -- peek uses the real store.
    ctx.prepareStore = {
      ...ctx.prepareStore,
      peek: prepareStore.peek.bind(prepareStore),
      consume: vi.fn().mockResolvedValue('expired'),
    };

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(PromotionSponsorError);

    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent).not.toBeNull();
    expect(ent!.activeReservationReceiptId).toBeNull();
    expect(ent!.activeReservationAmountMist).toBeNull();
  });

  test('post-signature uncertainty terminalizes the active reservation (consume, not release)', async () => {
    // Post-signature uncertainty consumes the full reserved
    // amount (release leaks; reaper hold also leaks at TTL). Active
    // reservation must be terminalized; `consumedGasAllowanceMist`
    // advanced by the full reserved amount.
    const { ctx, signed, receiptId, executionLedger } = await setup();

    // Replace executeTransaction with a rejected promise to simulate
    // infrastructure failure (connection refused, timeout, etc.).
    ctx.sui = {
      ...ctx.sui,
      simulateTransaction: ctx.sui.simulateTransaction.bind(ctx.sui),
      executeTransaction: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as typeof ctx.sui;

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/connection refused/);

    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent).not.toBeNull();
    expect(ent!.activeReservationReceiptId).toBeNull();
    expect(ent!.activeReservationAmountMist).toBeNull();
    // Full reserved consume.
    expect(ent!.consumedGasAllowanceMist).toBe('2000000');
  });

  test('rejects when verifiedIdentity userId does not match prepared receipt (USER_ID_MISMATCH)', async () => {
    const { ctx, signed, receiptId } = await setup();

    const ATTACKER_USER_ID = 'attacker-user-id';

    try {
      await handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity({ userId: ATTACKER_USER_ID }),
        clientIp: '127.0.0.1',
      });
      expect.unreachable('should have thrown on userId mismatch');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionSponsorError);
      expect((err as PromotionSponsorError).code).toBe('USER_ID_MISMATCH');
      expect((err as PromotionSponsorError).statusHint).toBe(403);
    }
  });

  test('rejects when verifiedIdentity senderAddress does not match prepared receipt (SENDER_ADDRESS_MISMATCH)', async () => {
    const { ctx, signed, receiptId, executionLedger } = await setup();
    const ATTACKER_ADDR = Ed25519Keypair.generate().toSuiAddress();

    try {
      await handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity({ senderAddress: ATTACKER_ADDR }),
        clientIp: '127.0.0.1',
      });
      expect.unreachable('should have thrown on senderAddress mismatch');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionSponsorError);
      expect((err as PromotionSponsorError).code).toBe('SENDER_ADDRESS_MISMATCH');
      expect((err as PromotionSponsorError).statusHint).toBe(403);
    }

    // Preserve-on-preconsume-reject: a leaked receiptId cannot destroy the
    // legitimate caller's prepared entry or their ledger reservation.
    // Retry at /sponsor stays valid for the owner.
    const stillPeeked = await ctx.prepareStore.peek(receiptId);
    expect(stillPeeked).not.toBeNull();
    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent).not.toBeNull();
    expect(ent!.activeReservationReceiptId).toBe(receiptId);
  });

  test('rejects with PROMOTION_NOT_STARTED when startAt is in the future', async () => {
    const executionLedger = new MemoryPromotionExecutionLedger();
    const sponsorPool = new SponsorPool([SPONSOR_KP], { hmacSecret: TEST_HMAC_SECRET });
    const prepareStore = new MemoryPrepareStore((sponsorAddress, receiptId, txBytesHash) =>
      sponsorPool.checkin(sponsorAddress, receiptId, txBytesHash),
    );
    const abuseBlocker = new MemoryAbuseBlocker();

    // Claim with an open use-window so the startAt gate is the only failing check.
    await executionLedger.claim(TEST_PROMO_ID, TEST_USER_ID, {
      maxParticipants: 0,
      perUserGasAllowanceMist: PER_USER_ALLOWANCE,
      useUntilAt: null,
    });

    const signed = await buildSignedTx();
    const receiptId = `0x${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;
    const slot = await sponsorPool.checkout(receiptId);
    if (!slot) throw new Error('No sponsor slot');
    await sponsorPool.commit(slot.sponsorAddress, receiptId, signed.txHash);
    const reserveResult = await executionLedger.reserve({
      promotionId: TEST_PROMO_ID,
      userId: TEST_USER_ID,
      receiptId,
      amountMist: 2_000_000n,
    });
    if (!reserveResult.ok) throw new Error(`Reserve failed: ${reserveResult.reason}`);

    const txBytesHash = signed.txHash;
    await prepareStore.store(receiptId, {
      issuedAt: Date.now(),
      receiptId,
      senderAddress: USER_ADDR,
      reservedGasMist: 2_000_000n,
      txBytesHash,
      sponsorAddress: slot.sponsorAddress,
      clientIp: '127.0.0.1',
      executionPathKey: `promotion:${TEST_PROMO_ID}`,
      orderId: null,
      nonce: 0n,
      mode: 'promotion',
      promotionId: TEST_PROMO_ID,
      userId: TEST_USER_ID,
    } satisfies PromotionPreparedTxEntry);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    const promotionStore = {
      get: async () => ({
        promotionId: TEST_PROMO_ID,
        type: 'gas_sponsorship' as const,
        displayName: 'Test',
        description: '',
        status: 'active' as const,
        maxParticipants: 100,
        perUserGasAllowanceMist: PER_USER_ALLOWANCE,
        claimDeadlineAt: null,
        postClaimUseWindowMs: 86400_000,
        startAt: future,
        pauseReason: null,
        archiveReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      create: async () => {
        throw new Error('not needed');
      },
      list: async () => [],
      update: async () => null,
      delete: async () => true,
      transitionStatus: async () => null,
    } satisfies import('../src/studio/promotionStore.js').PromotionStoreAdapter;

    const ctx: PromotionSponsorContext = {
      sui: createMockSui(),
      packageId: '0xabc',
      deepbookPackageId: TEST_DEEPBOOK_PACKAGE_ID,
      promotionStore,
      executionLedger,
      sponsorPool,
      prepareStore,
      abuseBlocker,
      globalTargetHashes: GLOBAL_TARGET_HASHES,
    };

    try {
      await handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity({ userId: TEST_USER_ID }),
        clientIp: '127.0.0.1',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionSponsorError);
      expect((err as PromotionSponsorError).code).toBe('PROMOTION_NOT_STARTED');
      expect((err as PromotionSponsorError).statusHint).toBe(409);
    }
  });

  test('rejects when use window has expired (USE_WINDOW_EXPIRED)', async () => {
    const executionLedger = new MemoryPromotionExecutionLedger();
    const sponsorPool = new SponsorPool([SPONSOR_KP], { hmacSecret: TEST_HMAC_SECRET });
    const prepareStore = new MemoryPrepareStore((sponsorAddress, receiptId, txBytesHash) =>
      sponsorPool.checkin(sponsorAddress, receiptId, txBytesHash),
    );
    const abuseBlocker = new MemoryAbuseBlocker();

    // Claim with expired use window
    await executionLedger.claim(TEST_PROMO_ID, TEST_USER_ID, {
      maxParticipants: 0,
      perUserGasAllowanceMist: PER_USER_ALLOWANCE,
      useUntilAt: new Date(Date.now() - 86400_000).toISOString(),
    });

    const signed = await buildSignedTx();
    const receiptId = `0x${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;
    const slot = await sponsorPool.checkout(receiptId);
    if (!slot) throw new Error('No sponsor slot');
    await sponsorPool.commit(slot.sponsorAddress, receiptId, signed.txHash);
    const reserveResult = await executionLedger.reserve({
      promotionId: TEST_PROMO_ID,
      userId: TEST_USER_ID,
      receiptId,
      amountMist: 2_000_000n,
    });
    if (!reserveResult.ok) throw new Error(`Reserve failed: ${reserveResult.reason}`);

    const txBytesHash = signed.txHash;
    await prepareStore.store(receiptId, {
      issuedAt: Date.now(),
      receiptId,
      senderAddress: USER_ADDR,
      reservedGasMist: 2_000_000n, // simGas + GAS_VARIANCE_FIXED_MIST
      txBytesHash,
      sponsorAddress: slot.sponsorAddress,
      clientIp: '127.0.0.1',
      executionPathKey: `promotion:${TEST_PROMO_ID}`,
      orderId: null,
      nonce: 0n,
      mode: 'promotion',
      promotionId: TEST_PROMO_ID,
      userId: TEST_USER_ID,
    } satisfies PromotionPreparedTxEntry);

    const promotionStore = {
      get: async () => ({
        promotionId: TEST_PROMO_ID,
        type: 'gas_sponsorship' as const,
        displayName: 'Test',
        description: '',
        status: 'active' as const,
        maxParticipants: 100,
        perUserGasAllowanceMist: PER_USER_ALLOWANCE,
        claimDeadlineAt: null,
        postClaimUseWindowMs: 86400_000,
        startAt: null,
        pauseReason: null,
        archiveReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      create: async () => {
        throw new Error('not needed');
      },
      list: async () => [],
      update: async () => null,
      delete: async () => true,
      transitionStatus: async () => null,
    } satisfies import('../src/studio/promotionStore.js').PromotionStoreAdapter;

    const ctx: PromotionSponsorContext = {
      sui: createMockSui(),
      packageId: '0xabc',
      deepbookPackageId: TEST_DEEPBOOK_PACKAGE_ID,
      promotionStore,
      executionLedger,
      sponsorPool,
      prepareStore,
      abuseBlocker,
      globalTargetHashes: GLOBAL_TARGET_HASHES,
    };

    try {
      await handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity({ userId: TEST_USER_ID }),
        clientIp: '127.0.0.1',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionSponsorError);
      expect((err as PromotionSponsorError).code).toBe('USE_WINDOW_EXPIRED');
    }
  });

  // ── Corrupt entry handling: peek/consume throw must trigger evictPreparedEntry ──

  test('rejects corrupt entry on peek throw and calls evictPreparedEntry + releases executionLedger reservation', async () => {
    const { ctx, signed, receiptId, executionLedger } = await setup();

    // Replace prepareStore.peek with a stub that throws (simulates a
    // RedisPrepareStore deserialization failure on an unsupported version).
    const evictSpy = vi.fn().mockResolvedValue(undefined);
    const peekSpy = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'RedisPrepareStore: refusing to deserialize entry with unsupported schema version 99',
        ),
      );
    // Spy on executionLedger.release to verify reservation cleanup.
    const releaseSpy = vi.spyOn(executionLedger, 'release');
    ctx.prepareStore = {
      ...ctx.prepareStore,
      peek: peekSpy,
      evictPreparedEntry: evictSpy,
    };

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(PromotionSponsorError);

    expect(peekSpy).toHaveBeenCalledWith(receiptId);
    expect(evictSpy).toHaveBeenCalledWith(receiptId);
    expect(releaseSpy).toHaveBeenCalled();
  });

  test('rejects corrupt entry on consume throw and calls evictPreparedEntry + releases executionLedger reservation', async () => {
    const { ctx, signed, receiptId, executionLedger, prepareStore } = await setup();

    const evictSpy = vi.fn().mockResolvedValue(undefined);
    const consumeSpy = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'RedisPrepareStore: refusing to deserialize entry with unsupported schema version 7',
        ),
      );
    const releaseSpy = vi.spyOn(executionLedger, 'release');
    // peek must succeed (real entry) so the handler reaches consume.
    ctx.prepareStore = {
      ...ctx.prepareStore,
      peek: prepareStore.peek.bind(prepareStore),
      consume: consumeSpy,
      evictPreparedEntry: evictSpy,
    };

    await expect(
      handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(PromotionSponsorError);

    expect(consumeSpy).toHaveBeenCalled();
    expect(evictSpy).toHaveBeenCalledWith(receiptId);
    expect(releaseSpy).toHaveBeenCalled();
  });

  // ── Sender binding: canonical tx.sender must equal prepared senderAddress ──
  //
  // Attack scenario: attacker crafts txBytes with tx.sender = ATTACKER_ADDR
  // but signs with USER_KP (valid for USER_ADDR = peeked.senderAddress).
  //
  // Defence: extractTxSender(builtTx) yields ATTACKER_ADDR which does not
  // equal peeked.senderAddress, so the handler rejects with
  // SENDER_SIGNATURE_INVALID before consume() is attempted.
  // (Without the canonical-sender check, `verifySenderSignature(txBytes,
  // userSig, peeked.senderAddress)` would pass because userSig is valid
  // for USER_ADDR over any bytes, and only the hash check at consume()
  // catches it at a later stage — too late for studio-user attribution.
  // Promotion abuse attribution is keyed by `peekedPromotion.userId`,
  // the verified developer JWT principal; `senderAddress` is the
  // canonical-tx execution binding only and cannot be used as the
  // long-lived enforcement subject.)

  test('rejects when canonical tx.sender differs from prepared senderAddress (sender substitution)', async () => {
    const { ctx, receiptId } = await setup();

    const ATTACKER_ADDR = Ed25519Keypair.generate().toSuiAddress();

    // Build txBytes with the attacker's address as tx.sender. Allowed
    // commands let validatePromotionPreconsumePolicy structure checks pass,
    // isolating canonical sender validation.
    const kindTx = new Transaction();
    kindTx.moveCall({ target: ALLOWED_TARGET as `${string}::${string}::${string}` });
    const kindBytes = await kindTx.build({ onlyTransactionKind: true });
    const attackTx = Transaction.fromKind(kindBytes);
    attackTx.setSender(ATTACKER_ADDR); // ← substituted: tx.sender != USER_ADDR
    attackTx.setGasOwner(SPONSOR_KP.toSuiAddress());
    attackTx.setGasBudget(2_000_000n);
    attackTx.setGasPrice(1000);
    const digestBytes = new Uint8Array(32);
    digestBytes.fill(3);
    attackTx.setGasPayment([
      {
        objectId: '0x' + '0'.repeat(64),
        version: '1',
        digest: toBase58(digestBytes),
      },
    ]);
    const attackerTxBytes = await attackTx.build();

    // Sign with USER_KP — valid for USER_ADDR (peeked.senderAddress), NOT
    // for ATTACKER_ADDR (tx.sender). Canonical sender validation catches
    // the mismatch before signature verification.
    const sigOnAttackerTx = await USER_KP.signTransaction(attackerTxBytes);

    try {
      await handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: toBase64(attackerTxBytes),
        userSignature: sigOnAttackerTx.signature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      });
      expect.unreachable('should have rejected canonical sender mismatch');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionSponsorError);
      expect((err as PromotionSponsorError).code).toBe('SENDER_SIGNATURE_INVALID');
    }

    // Preserve-on-preconsume contract: canonical-sender mismatch rejects
    // before the stored hash match, so the prepared entry stays alive for the
    // legitimate owner to retry /sponsor without re-preparing.
    const stillPeeked = await ctx.prepareStore.peek(receiptId);
    expect(stillPeeked).not.toBeNull();
  });

  // ── Preconsume recorder-degradation coverage ──
  //
  // Promotion preconsume records studio-user abuse (keyed by `userId`) via
  // `recordPromotionAbuseEvent()` for DISALLOWED_TARGET, FORBIDDEN_COMMAND,
  // GASCOIN_FORBIDDEN, and the two SENDER_SIGNATURE_INVALID variants
  // (canonical sender mismatch and invalid signature) BEFORE constructing
  // the classified `PromotionSponsorError`. The recorder helper swallows
  // adapter failures internally and reports degradation via
  // `PROMOTION_ABUSE_RECORDER_FAILED` warn so it never masks the primary
  // rejection. Each case below locks that contract at the handler level
  // and verifies the prepare entry remains unconsumed.
  //
  // Helper: build a tx with a single SplitCoins command — non-MoveCall,
  // so S1 returns FORBIDDEN_COMMAND before touching target policy.
  async function buildForbiddenCommandTx() {
    const kindTx = new Transaction();
    kindTx.splitCoins(kindTx.gas, [kindTx.pure.u64(100n)]);
    const kindBytes = await kindTx.build({ onlyTransactionKind: true });
    const tx = Transaction.fromKind(kindBytes);
    tx.setSender(USER_ADDR);
    tx.setGasOwner(SPONSOR_KP.toSuiAddress());
    tx.setGasBudget(2_000_000n);
    tx.setGasPrice(1000);
    const digestBytes = new Uint8Array(32);
    digestBytes.fill(4);
    tx.setGasPayment([
      {
        objectId: '0x' + '0'.repeat(64),
        version: '1',
        digest: toBase58(digestBytes),
      },
    ]);
    const txBytes = await tx.build();
    const sig = await USER_KP.signTransaction(txBytes);
    return { txBytes, txBytesBase64: toBase64(txBytes), userSignature: sig.signature };
  }

  // Helper: build a tx with a MoveCall referencing tx.gas as an argument —
  // passes FORBIDDEN_COMMAND check (kind === 'MoveCall') and trips
  // GASCOIN_FORBIDDEN after convertSdkCommands normalization.
  async function buildGasCoinForbiddenTx() {
    const kindTx = new Transaction();
    kindTx.moveCall({
      target: ALLOWED_TARGET as `${string}::${string}::${string}`,
      arguments: [kindTx.gas],
    });
    const kindBytes = await kindTx.build({ onlyTransactionKind: true });
    const tx = Transaction.fromKind(kindBytes);
    tx.setSender(USER_ADDR);
    tx.setGasOwner(SPONSOR_KP.toSuiAddress());
    tx.setGasBudget(2_000_000n);
    tx.setGasPrice(1000);
    const digestBytes = new Uint8Array(32);
    digestBytes.fill(5);
    tx.setGasPayment([
      {
        objectId: '0x' + '0'.repeat(64),
        version: '1',
        digest: toBase58(digestBytes),
      },
    ]);
    const txBytes = await tx.build();
    const sig = await USER_KP.signTransaction(txBytes);
    return { txBytes, txBytesBase64: toBase64(txBytes), userSignature: sig.signature };
  }

  // Helper: tamper tx.sender while signing with USER_KP. Canonical sender
  // mismatch path (same shape as the canonical mismatch test but with a
  // separate digest seed so fixtures don't collide if tests are reordered).
  async function buildCanonicalSenderMismatchTx() {
    const attackerAddr = Ed25519Keypair.generate().toSuiAddress();
    const kindTx = new Transaction();
    kindTx.moveCall({ target: ALLOWED_TARGET as `${string}::${string}::${string}` });
    const kindBytes = await kindTx.build({ onlyTransactionKind: true });
    const tx = Transaction.fromKind(kindBytes);
    tx.setSender(attackerAddr);
    tx.setGasOwner(SPONSOR_KP.toSuiAddress());
    tx.setGasBudget(2_000_000n);
    tx.setGasPrice(1000);
    const digestBytes = new Uint8Array(32);
    digestBytes.fill(6);
    tx.setGasPayment([
      {
        objectId: '0x' + '0'.repeat(64),
        version: '1',
        digest: toBase58(digestBytes),
      },
    ]);
    const txBytes = await tx.build();
    const sig = await USER_KP.signTransaction(txBytes);
    return { txBytes, txBytesBase64: toBase64(txBytes), userSignature: sig.signature };
  }

  test('recorder degradation: DISALLOWED_TARGET preserves 403 and emits recorder-failed warn', async () => {
    const { ctx, receiptId, signed } = await setup();
    ctx.globalTargetHashes = new Set<string>();

    const recordSpy = vi
      .spyOn(ctx.abuseBlocker, 'recordSponsorFailure')
      .mockRejectedValue(new Error('redis unreachable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const err = await handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PromotionSponsorError);
      expect((err as PromotionSponsorError).code).toBe('DISALLOWED_TARGET');
      expect((err as PromotionSponsorError).statusHint).toBe(403);

      const abuseCalls = recordSpy.mock.calls.filter((a) => a[2] === 'PROMO_DISALLOWED_TARGET');
      expect(abuseCalls.length).toBe(1);

      const recorderFailed = warnSpy.mock.calls
        .map((call) => {
          try {
            return JSON.parse(String(call[0])) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find(
          (entry): entry is Record<string, unknown> =>
            entry?.['event'] === 'PROMOTION_ABUSE_RECORDER_FAILED',
        );
      expect(recorderFailed).toBeDefined();
      expect(recorderFailed!['code']).toBe('PROMO_DISALLOWED_TARGET');
      expect(recorderFailed!['error']).toBe('redis unreachable');
      expect(recorderFailed!['promotionId']).toBe(TEST_PROMO_ID);

      // Preserve-on-preconsume contract: entry stays alive so the
      // legitimate owner can retry /sponsor without re-preparing.
      const stillPeeked = await ctx.prepareStore.peek(receiptId);
      expect(stillPeeked).not.toBeNull();
    } finally {
      recordSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // Preconsume rejections reach neither consume() nor the stored hash check,
  // so we can reuse the slot/entry from setup() and just submit crafted
  // txBytes. No extra pool slot is required.
  async function runPreconsumeRecorderCase(opts: {
    buildSubmission: () => Promise<{ txBytesBase64: string; userSignature: string }>;
    expectedCode: string;
    expectedStatusHint: number;
    expectedAbuseCode: string;
    expectedWarnDetail?: string;
  }) {
    const { ctx, receiptId } = await setup();
    const submission = await opts.buildSubmission();
    const recordSpy = vi
      .spyOn(ctx.abuseBlocker, 'recordSponsorFailure')
      .mockRejectedValue(new Error('redis unreachable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const err = await handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: submission.txBytesBase64,
        userSignature: submission.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PromotionSponsorError);
      expect((err as PromotionSponsorError).code).toBe(opts.expectedCode);
      expect((err as PromotionSponsorError).statusHint).toBe(opts.expectedStatusHint);

      const abuseCalls = recordSpy.mock.calls.filter((a) => a[2] === opts.expectedAbuseCode);
      expect(abuseCalls.length).toBe(1);

      const recorderFailed = warnSpy.mock.calls
        .map((call) => {
          try {
            return JSON.parse(String(call[0])) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find(
          (entry): entry is Record<string, unknown> =>
            entry?.['event'] === 'PROMOTION_ABUSE_RECORDER_FAILED',
        );
      expect(recorderFailed).toBeDefined();
      expect(recorderFailed!['code']).toBe(opts.expectedAbuseCode);
      expect(recorderFailed!['error']).toBe('redis unreachable');
      expect(recorderFailed!['promotionId']).toBe(TEST_PROMO_ID);
      if (opts.expectedWarnDetail !== undefined) {
        expect(recorderFailed!['detail']).toBe(opts.expectedWarnDetail);
      }

      // Preserve-on-preconsume contract: entry stays alive so the
      // legitimate owner can retry /sponsor without re-preparing.
      const stillPeeked = await ctx.prepareStore.peek(receiptId);
      expect(stillPeeked).not.toBeNull();
    } finally {
      recordSpy.mockRestore();
      warnSpy.mockRestore();
    }
  }

  test('recorder degradation: FORBIDDEN_COMMAND preserves 403 and emits recorder-failed warn', async () => {
    await runPreconsumeRecorderCase({
      buildSubmission: buildForbiddenCommandTx,
      expectedCode: 'FORBIDDEN_COMMAND',
      expectedStatusHint: 403,
      expectedAbuseCode: 'PROMO_FORBIDDEN_COMMAND',
    });
  });

  test('malformed txBytes (valid base64, invalid BCS) returns BAD_REQUEST/400 and preserves prepared entry', async () => {
    const { ctx, receiptId } = await setup();

    // Garbage bytes: base64 decode succeeds (so `decodeTxBytes` passes),
    // but `Transaction.from()` BCS deserialization fails. Must be
    // classified as 400 BAD_REQUEST rather than falling through to the
    // route-level 500 SPONSOR_FAILED catch.
    const garbageTxBytes = toBase64(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]));
    const userSig = await USER_KP.signTransaction(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]));

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: garbageTxBytes,
      userSignature: userSig.signature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('BAD_REQUEST');
    expect((err as PromotionSponsorError).statusHint).toBe(400);

    // Preserve-on-preconsume contract: a malformed submission is not
    // a tampering signal for the prepared entry, and the stored hash match
    // has not yet happened, so the entry and reservation stay alive for
    // the legitimate owner's retry (docs/operations.md Studio Mode Operations).
    const stillPeeked = await ctx.prepareStore.peek(receiptId);
    expect(stillPeeked).not.toBeNull();
  });

  test('GASCOIN_FORBIDDEN: real SDK MoveCall(... tx.gas ...) rejects preconsume with 403 and preserves prepared entry', async () => {
    const { ctx, receiptId } = await setup();
    const gasCoin = await buildGasCoinForbiddenTx();

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: gasCoin.txBytesBase64,
      userSignature: gasCoin.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('GASCOIN_FORBIDDEN');
    expect((err as PromotionSponsorError).statusHint).toBe(403);

    // Preserve-on-preconsume contract: S1 policy failures reject before
    // the stored hash match, so the prepared entry and its reservation are
    // preserved for the legitimate owner's retry
    // (docs/operations.md Studio Mode Operations).
    const stillPeeked = await ctx.prepareStore.peek(receiptId);
    expect(stillPeeked).not.toBeNull();
  });

  test('recorder degradation: GASCOIN_FORBIDDEN preserves 403 and emits recorder-failed warn', async () => {
    await runPreconsumeRecorderCase({
      buildSubmission: buildGasCoinForbiddenTx,
      expectedCode: 'GASCOIN_FORBIDDEN',
      expectedStatusHint: 403,
      expectedAbuseCode: 'PROMO_GASCOIN_FORBIDDEN',
    });
  });

  test('recorder degradation: canonical sender mismatch preserves SENDER_SIGNATURE_INVALID/422', async () => {
    await runPreconsumeRecorderCase({
      buildSubmission: buildCanonicalSenderMismatchTx,
      expectedCode: 'SENDER_SIGNATURE_INVALID',
      expectedStatusHint: 422,
      expectedAbuseCode: 'PROMO_SENDER_SIGNATURE_INVALID',
      expectedWarnDetail: 'canonical_sender_mismatch',
    });
  });

  test('recorder degradation: invalid user signature preserves SENDER_SIGNATURE_INVALID/422', async () => {
    const { ctx, signed, receiptId } = await setup();
    const wrongKp = Ed25519Keypair.generate();
    const wrongSig = await wrongKp.signTransaction(signed.txBytes);

    const recordSpy = vi
      .spyOn(ctx.abuseBlocker, 'recordSponsorFailure')
      .mockRejectedValue(new Error('redis unreachable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const err = await handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: wrongSig.signature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PromotionSponsorError);
      expect((err as PromotionSponsorError).code).toBe('SENDER_SIGNATURE_INVALID');
      expect((err as PromotionSponsorError).statusHint).toBe(422);

      const abuseCalls = recordSpy.mock.calls.filter(
        (a) => a[2] === 'PROMO_SENDER_SIGNATURE_INVALID',
      );
      expect(abuseCalls.length).toBe(1);

      const recorderFailed = warnSpy.mock.calls
        .map((call) => {
          try {
            return JSON.parse(String(call[0])) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find(
          (entry): entry is Record<string, unknown> =>
            entry?.['event'] === 'PROMOTION_ABUSE_RECORDER_FAILED',
        );
      expect(recorderFailed).toBeDefined();
      expect(recorderFailed!['code']).toBe('PROMO_SENDER_SIGNATURE_INVALID');
      expect(recorderFailed!['detail']).toBe('sender_signature_invalid');

      // Preserve-on-preconsume contract: entry stays alive so the
      // legitimate owner can retry /sponsor without re-preparing.
      const stillPeeked = await ctx.prepareStore.peek(receiptId);
      expect(stillPeeked).not.toBeNull();
    } finally {
      recordSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  // ── Sponsor result host callback contract ──────────────────────────
  //
  // Locks the `ctx.onSponsorResult` contract for the promotion path:
  //   (a) invoked with `route='promotion'` on every sponsor result path that
  //       reaches post-consume,
  //   (b) post-success throws (missing gasUsed, ledger consume failure)
  //       keep `outcome='success'` because the slot balance change is
  //       authoritative from submit onwards,
  //   (c) invocation strictly follows `sponsorPool.checkin`,
  //   (d) callback errors are swallowed; primary result/error unchanged.

  function collectingPromotionCallback(): {
    callback: SponsorResultCallback;
    calls: SponsorResultMetadata[];
    order: string[];
  } {
    const calls: SponsorResultMetadata[] = [];
    const order: string[] = [];
    return {
      calls,
      order,
      callback: (metadata) => {
        order.push('callback');
        calls.push(metadata);
      },
    };
  }

  test('host callback: happy path → outcome=success with digest and actualGasMist (route=promotion)', async () => {
    const { ctx, signed, receiptId, sponsorPool } = await setup();
    const probe = collectingPromotionCallback();
    const originalCheckin = sponsorPool.checkin.bind(sponsorPool);
    vi.spyOn(sponsorPool, 'checkin').mockImplementation(
      async (...args: Parameters<typeof originalCheckin>) => {
        probe.order.push('checkin');
        return originalCheckin(...args);
      },
    );
    ctx.onSponsorResult = probe.callback;

    await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    });

    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]).toMatchObject({
      outcome: 'success',
      executionStage: 'on_chain',
      route: 'promotion',
      digest: 'tx-digest-abc',
    });
    // Promotion allowance consumption is entitlement accounting, not a
    // transfer that recovers the Host's gas payment.
    expect(probe.calls[0].economics.economicsStatus).toBe('known');
    if (probe.calls[0].economics.economicsStatus === 'known') {
      expect(probe.calls[0].economics.recoveredGasMist).toBe('0');
      expect(probe.calls[0].economics.hostFeeMist).toBe('0');
      expect(BigInt(probe.calls[0].economics.hostPaidGasMist)).toBeGreaterThan(0n);
      expect(probe.calls[0].economics.hostNetMist).toBe(
        (-BigInt(probe.calls[0].economics.hostPaidGasMist)).toString(),
      );
    }
    // Ordering: safeSlotCheckin runs before callback.
    expect(probe.order).toEqual(['checkin', 'callback']);
  });

  test('host callback: post-success gasUsed-missing → outcome=success', async () => {
    // Submit succeeded on-chain, but effects normalisation dropped
    // `gasUsed`. Slot balance was drained; the primary error transport
    // remains `PromotionSponsorError('GAS_EFFECTS_MISSING')`, but the
    // sponsor result callback must see `success` for slot-state purposes.
    const { ctx, signed, receiptId } = await setup({ noGasUsed: true });
    const probe = collectingPromotionCallback();
    ctx.onSponsorResult = probe.callback;

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('GAS_EFFECTS_MISSING');
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]).toMatchObject({
      outcome: 'success',
      executionStage: 'on_chain',
      route: 'promotion',
    });
    // Economics: gasUsed-missing edge path → unknown economics with
    // GAS_EFFECTS_MISSING failureReason.
    expect(probe.calls[0].economics.economicsStatus).toBe('unknown');
    if (probe.calls[0].economics.economicsStatus === 'unknown') {
      expect(probe.calls[0].economics.failureReason).toBe('GAS_EFFECTS_MISSING');
    }
  });

  test('host callback: post-success ledger throw keeps known unrecovered gas loss', async () => {
    const { ctx, signed, receiptId, executionLedger } = await setup();
    const probe = collectingPromotionCallback();
    ctx.onSponsorResult = probe.callback;
    vi.spyOn(executionLedger, 'consume').mockRejectedValue(new Error('redis transport down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((cause: unknown) => cause);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('CONSUME_FAILED');
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]).toMatchObject({
      outcome: 'success',
      executionStage: 'on_chain',
    });
    expect(probe.calls[0].economics.economicsStatus).toBe('known');
    if (probe.calls[0].economics.economicsStatus === 'known') {
      expect(probe.calls[0].economics.recoveredGasMist).toBe('0');
      expect(probe.calls[0].economics.hostNetMist).toBe(
        (-BigInt(probe.calls[0].economics.hostPaidGasMist)).toString(),
      );
      expect(probe.calls[0].economics.failureReason).toContain('PROMOTION_LEDGER_CONSUME_THREW');
    }

    consoleErrorSpy.mockRestore();
  });

  test('host callback: errors are swallowed — primary result preserved', async () => {
    const { ctx, signed, receiptId } = await setup();
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ctx.onSponsorResult = () => {
      throw new Error('host callback bug');
    };

    const result = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    });

    // Primary response preserved despite the throwing callback.
    expect(result.digest).toBe('tx-digest-abc');

    const callbackFailedLog = consoleWarnSpy.mock.calls
      .map((args: unknown[]) => {
        try {
          return JSON.parse(args[0] as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.['event'] === 'SPONSOR_RESULT_CALLBACK_FAILED');
    expect(callbackFailedLog).toBeDefined();
    expect(callbackFailedLog!['route']).toBe('promotion');
    expect(callbackFailedLog!['outcome']).toBe('success');
    // Cross-reference shape: `source` and `digest` are required so
    // operators can correlate this emit with host-side projection
    // failures (`SPONSORED_LOGS_RECORDER_FAILED` / `SPONSOR_OPERATIONS_STATE_WRITE_FAILED`).
    expect(callbackFailedLog!['source']).toBe('sponsor_handler');
    expect(callbackFailedLog!['digest']).toBe('tx-digest-abc');

    consoleWarnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────
// Post-signature/post-submit ledger consume policy
// ─────────────────────────────────────────────
//
// Acceptance:
//   - post-signature uncertainty → consume(reservedGasMist), UsageEvent
//     `post_signature_uncertainty`, reconciliation event,
//     no `release()`.
//   - on-chain revert with `gasUsed` → consume(actualGasMist), UsageEvent
//     `onchain_revert`, no `release()`.
//   - on-chain revert without `gasUsed` → consume(reservedGasMist),
//     UsageEvent `onchain_revert_gas_unknown`, no `release()`.
//   - GAS_EFFECTS_MISSING → consume(reservedGasMist), UsageEvent
//     `gas_used_missing`, response code stays `GAS_EFFECTS_MISSING`,
//     no `release()`.
//   - Pre-submit + congestion remain `release()`.

describe('post-signature/post-submit ledger consume policy', () => {
  test('post-signature uncertainty consumes reserved, appends usage row, emits reconciliation event, and does not release', async () => {
    const { ctx, signed, receiptId, executionLedger, usageRows } = await setup({
      submitThrows: true,
      submitThrowMessage: 'rpc transport error',
      withUsageCapture: true,
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('rpc transport error');

    // Ledger consume path: entitlement.consumedGasAllowanceMist advanced
    // by the full reserved amount. Release would have left consumed=0.
    const entitlement = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(entitlement).not.toBeNull();
    expect(entitlement!.consumedGasAllowanceMist).toBe('2000000');
    expect(entitlement!.activeReservationReceiptId).toBeNull();

    // UsageEvent append.
    const failedRow = usageRows.find((r) => r.failureReason === 'post_signature_uncertainty');
    expect(failedRow).toBeDefined();
    expect(failedRow!.result).toBe('failed');
    expect(failedRow!.txDigest).toBeNull();
    expect(failedRow!.consumedGasMist).toBe('2000000');
    expect(failedRow!.releasedGasMist).toBe('0');

    // Reconciliation event emitted with operator-side context.
    const reconLog = consoleErrorSpy.mock.calls
      .map((args: unknown[]) => {
        try {
          return JSON.parse(args[0] as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.['event'] === 'PROMOTION_SPONSOR_POST_SIGNATURE_UNCERTAINTY');
    expect(reconLog).toBeDefined();
    expect(reconLog!['promotionId']).toBe(TEST_PROMO_ID);
    expect(reconLog!['userId']).toBe(TEST_USER_ID);
    expect(reconLog!['receiptId']).toBe(receiptId);
    expect(reconLog!['reservedMist']).toBe('2000000');
    expect(reconLog!['consumeOutcome']).toBe('ok');

    consoleErrorSpy.mockRestore();
  });

  test('on-chain revert with gasUsed consumes actualGasMist (not reservedGasMist), appends onchain_revert usage row', async () => {
    const { ctx, signed, receiptId, executionLedger, usageRows } = await setup({
      execFail: true,
      execFailReason: 'arbitrary on-chain abort',
      revertWithGasUsed: true,
      withUsageCapture: true,
    });
    const sponsorResults: SponsorResultMetadata[] = [];
    ctx.onSponsorResult = (metadata) => {
      sponsorResults.push(metadata);
    };

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('ONCHAIN_REVERT');

    // The default mock gasCost yields netGas = computation + storage -
    // rebate = 1_000_000 + 500_000 - 200_000 = 1_300_000. consume() with
    // that amount; surplus 700_000 delta-released back to budget +
    // entitlement.
    const entitlement = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(entitlement!.consumedGasAllowanceMist).toBe('1300000');

    const failedRow = usageRows.find((r) => r.failureReason === 'onchain_revert');
    expect(failedRow).toBeDefined();
    expect(failedRow!.result).toBe('failed');
    expect(failedRow!.consumedGasMist).toBe('1300000');
    expect(failedRow!.releasedGasMist).toBe('700000');
    expect(failedRow!.txDigest).toBe('tx-digest-revert');

    expect(sponsorResults).toHaveLength(1);
    expect(sponsorResults[0]).toMatchObject({
      outcome: 'onchain_revert',
      executionStage: 'on_chain',
      digest: 'tx-digest-revert',
      economics: {
        economicsStatus: 'known',
        recoveredGasMist: '0',
        hostPaidGasMist: '1300000',
        hostFeeMist: '0',
        hostNetMist: '-1300000',
      },
    });
  });

  test('on-chain revert with gasUsed but zero net (rebate ≥ computation+storage) stays onchain_revert with 0 consume + full surplus released', async () => {
    // Regression for the `> 0n` vs `>= 0n` discriminator. Previously the
    // handler routed a delete-objects-only revert (rebate exceeds
    // computation + storage) into the `onchain_revert_gas_unknown`
    // branch and consumed the full reserved amount, even though
    // `gasUsed` was present and the canonical clamp says simGas === 0.
    // Acceptance: `gasUsed` present → `onchain_revert`; consumed=0;
    // released=full reserved (delta-release surplus).
    const { ctx, signed, receiptId, executionLedger, usageRows } = await setup({
      execFail: true,
      execFailReason: 'rebate-positive revert',
      revertWithGasUsed: true,
      zeroNetRevert: true,
      withUsageCapture: true,
    });

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('ONCHAIN_REVERT');

    const entitlement = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    // simGas clamps to 0n → consumed bucket gains 0; remaining is fully restored.
    expect(entitlement!.consumedGasAllowanceMist).toBe('0');
    expect(BigInt(entitlement!.remainingGasAllowanceMist)).toBe(BigInt(PER_USER_ALLOWANCE));

    // Audit row: failureReason stays `onchain_revert`, NOT `_gas_unknown`.
    const failedRow = usageRows.find((r) => r.failureReason === 'onchain_revert');
    expect(failedRow).toBeDefined();
    expect(failedRow!.consumedGasMist).toBe('0');
    expect(failedRow!.releasedGasMist).toBe('2000000');
    expect(failedRow!.txDigest).toBe('tx-digest-revert');
    // Negative regression: must not have written the gas-unknown variant.
    expect(usageRows.find((r) => r.failureReason === 'onchain_revert_gas_unknown')).toBeUndefined();
  });

  test('on-chain revert without gasUsed consumes full reserved, appends onchain_revert_gas_unknown usage row', async () => {
    const { ctx, signed, receiptId, executionLedger, usageRows } = await setup({
      execFail: true,
      execFailReason: 'no effects revert',
      withUsageCapture: true,
    });

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('ONCHAIN_REVERT');

    const entitlement = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(entitlement!.consumedGasAllowanceMist).toBe('2000000');

    const failedRow = usageRows.find((r) => r.failureReason === 'onchain_revert_gas_unknown');
    expect(failedRow).toBeDefined();
    expect(failedRow!.consumedGasMist).toBe('2000000');
    expect(failedRow!.releasedGasMist).toBe('0');
  });

  test('post-success GAS_EFFECTS_MISSING consumes full reserved, appends gas_used_missing usage row, response code unchanged', async () => {
    const { ctx, signed, receiptId, executionLedger, usageRows } = await setup({
      noGasUsed: true,
      withUsageCapture: true,
    });

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('GAS_EFFECTS_MISSING');

    const entitlement = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(entitlement!.consumedGasAllowanceMist).toBe('2000000');

    const failedRow = usageRows.find((r) => r.failureReason === 'gas_used_missing');
    expect(failedRow).toBeDefined();
    expect(failedRow!.consumedGasMist).toBe('2000000');
    expect(failedRow!.txDigest).toBe('tx-digest-abc');
  });

  test('post-signature uncertainty and post-submit loss paths never invoke ledger.release()', async () => {
    // Lock that the remaining `releaseLedgerReservationWithLog()` call
    // sites are limited to pre-submit / no-gas-burn / congestion
    // branches. This test wraps `executionLedger.release` with a spy
    // and exercises all four post-signature/post-submit branches in
    // turn; each must reach its primary error WITHOUT touching
    // `release()`.
    const branches: Array<{
      label: string;
      opts: Parameters<typeof setup>[0];
      expectedCode: string;
    }> = [
      {
        label: 'post-signature uncertainty',
        opts: { submitThrows: true, withUsageCapture: true },
        expectedCode: '__throw__', // not a PromotionSponsorError; raw rethrow
      },
      {
        label: 'on-chain revert with gasUsed',
        opts: { execFail: true, revertWithGasUsed: true, withUsageCapture: true },
        expectedCode: 'ONCHAIN_REVERT',
      },
      {
        label: 'on-chain revert without gasUsed',
        opts: { execFail: true, withUsageCapture: true },
        expectedCode: 'ONCHAIN_REVERT',
      },
      {
        label: 'GAS_EFFECTS_MISSING',
        opts: { noGasUsed: true, withUsageCapture: true },
        expectedCode: 'GAS_EFFECTS_MISSING',
      },
    ];
    for (const branch of branches) {
      const { ctx, signed, receiptId, executionLedger } = await setup(branch.opts);
      const releaseSpy = vi.spyOn(executionLedger, 'release');
      await handlePromotionSponsor(ctx, {
        promotionId: TEST_PROMO_ID,
        receiptId,
        txBytes: signed.txBytesBase64,
        userSignature: signed.userSignature,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }).catch(() => undefined);
      expect(releaseSpy, `${branch.label}: release() must not be called`).not.toHaveBeenCalled();
      releaseSpy.mockRestore();
    }
  });

  test('failure-path consume() throw preserves primary sponsor error and emits LEDGER_CONSUME_THREW_IN_HANDLER', async () => {
    // A failed-path `consume()` throw must not mask the primary sponsor
    // error — the handler still reports the `ONCHAIN_REVERT` (or
    // whichever branch threw) and the helper emits
    // `LEDGER_CONSUME_THREW_IN_HANDLER` with the attempted amount +
    // branch context for operator reconciliation.
    const { ctx, signed, receiptId, executionLedger } = await setup({
      execFail: true,
      revertWithGasUsed: true,
      withUsageCapture: true,
    });
    vi.spyOn(executionLedger, 'consume').mockRejectedValue(new Error('redis transport down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    // Primary error preserved.
    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('ONCHAIN_REVERT');

    // Operator event emitted.
    const threwLog = consoleErrorSpy.mock.calls
      .map((args: unknown[]) => {
        try {
          return JSON.parse(args[0] as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.['event'] === 'LEDGER_CONSUME_THREW_IN_HANDLER');
    expect(threwLog).toBeDefined();
    expect(threwLog!['triggerReason']).toBe('onchain_revert');
    expect(threwLog!['attemptedAmountMist']).toBe('1300000');
    expect(threwLog!['error']).toContain('redis transport down');
    expect(threwLog!['promotionId']).toBe(TEST_PROMO_ID);
    expect(threwLog!['userId']).toBe(TEST_USER_ID);

    consoleErrorSpy.mockRestore();
  });

  test('failure-path consume() returns ConsumeResult.ok=false preserves primary sponsor error and emits LEDGER_CONSUME_FAILED_IN_HANDLER', async () => {
    // Companion to the consume-throws test: a structured `{ ok: false,
    // reason }` from the underlying ledger must take the SAME path
    // (primary sponsor error preserved, no `release()` fallback,
    // operator event emitted with attempted amount + branch
    // context). This is the path the helper hits when a reservation has
    // already been swept by the reaper or terminal-guard between submit
    // and the post-submit consume, NOT an adapter throw.
    const { ctx, signed, receiptId, executionLedger } = await setup({
      execFail: true,
      revertWithGasUsed: true,
      withUsageCapture: true,
    });
    const releaseSpy = vi.spyOn(executionLedger, 'release');
    vi.spyOn(executionLedger, 'consume').mockResolvedValue({
      ok: false,
      reason: 'reservation_not_found',
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    // Primary error preserved.
    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('ONCHAIN_REVERT');

    // No release() fallback — failed consume is observed and reaper owns
    // the 60s release fallback per the helper contract.
    expect(releaseSpy).not.toHaveBeenCalled();

    // Operator event emitted with full reconciliation context.
    const failedLog = consoleErrorSpy.mock.calls
      .map((args: unknown[]) => {
        try {
          return JSON.parse(args[0] as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.['event'] === 'LEDGER_CONSUME_FAILED_IN_HANDLER');
    expect(failedLog).toBeDefined();
    expect(failedLog!['triggerReason']).toBe('onchain_revert');
    expect(failedLog!['attemptedAmountMist']).toBe('1300000');
    expect(failedLog!['consumeFailureReason']).toBe('reservation_not_found');
    expect(failedLog!['promotionId']).toBe(TEST_PROMO_ID);
    expect(failedLog!['userId']).toBe(TEST_USER_ID);
    expect(failedLog!['receiptId']).toBe(receiptId);

    consoleErrorSpy.mockRestore();
  });

  test('post-signature uncertainty callback retains ledger reconciliation context', async () => {
    // The typed execution stage is the recorder authority. This separately
    // checks that the diagnostic reason preserves ledger reconciliation
    // context instead of being replaced by the outer raw error.
    const { ctx, signed, receiptId, executionLedger } = await setup({
      submitThrows: true,
      submitThrowMessage: 'rpc transport error',
      withUsageCapture: true,
    });
    const calls: SponsorResultMetadata[] = [];
    ctx.onSponsorResult = (metadata) => {
      calls.push(metadata);
    };
    // Force consume() to fail so the economics string also carries the
    // ledger consume kind (`(ledger consume failed): rpc transport error`).
    vi.spyOn(executionLedger, 'consume').mockResolvedValue({
      ok: false,
      reason: 'reservation_not_found',
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('rpc transport error');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.outcome).toBe('internal_error');
    expect(calls[0]!.executionStage).toBe('after_sponsor_signature');
    expect(calls[0]!.route).toBe('promotion');
    // Critical: economics carry the post-signature uncertainty reason and
    // ledger consume kind, NOT the raw RPC error message.
    expect(calls[0]!.economics.economicsStatus).toBe('unknown');
    if (calls[0]!.economics.economicsStatus === 'unknown') {
      expect(calls[0]!.economics.failureReason).toContain('post_signature_uncertainty');
      expect(calls[0]!.economics.failureReason).toContain('ledger consume failed');
      expect(calls[0]!.economics.failureReason).toContain('rpc transport error');
    }

    consoleErrorSpy.mockRestore();
  });

  test('malformed terminal result after sponsor signature uses the uncertain consume path, not pre-sign release', async () => {
    const { ctx, signed, receiptId, executionLedger, usageRows } = await setup({
      withUsageCapture: true,
    });
    (ctx.sui as unknown as { executeTransaction: () => Promise<unknown> }).executeTransaction =
      async () => ({
        $kind: 'Transaction',
        Transaction: {
          digest: 'malformed-effects-digest',
          status: { success: true, error: null },
          effects: {},
        },
      });
    const calls: SponsorResultMetadata[] = [];
    ctx.onSponsorResult = (metadata) => {
      calls.push(metadata);
    };

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((cause: unknown) => cause);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('malformed terminal result');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      outcome: 'internal_error',
      executionStage: 'after_sponsor_signature',
      route: 'promotion',
    });
    expect(usageRows.some((row) => row.failureReason === 'post_signature_uncertainty')).toBe(true);
    const entitlement = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(entitlement?.activeReservationReceiptId).toBeNull();
    expect(BigInt(entitlement?.consumedGasAllowanceMist ?? '0')).toBeGreaterThan(0n);
  });

  test('on-chain revert + consume() returns ok=false keeps known on-chain gas loss and the ledger failure reason', async () => {
    // A failed-path consume() on the on-chain-revert branch must still
    // send `outcome='onchain_revert'` to the host callback with the
    // unknown-economics fall-through carrying the revert reason. The
    // outer catch must not overwrite this with the
    // `PromotionSponsorError` message; the inner branch already set
    // `sponsorResultOutcome='onchain_revert'` so the gate skips it.
    const { ctx, signed, receiptId, executionLedger } = await setup({
      execFail: true,
      revertWithGasUsed: true,
      execFailReason: 'arbitrary on-chain abort',
      withUsageCapture: true,
    });
    const calls: SponsorResultMetadata[] = [];
    ctx.onSponsorResult = (metadata) => {
      calls.push(metadata);
    };
    vi.spyOn(executionLedger, 'consume').mockResolvedValue({
      ok: false,
      reason: 'reservation_not_found',
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('ONCHAIN_REVERT');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.outcome).toBe('onchain_revert');
    expect(calls[0]!.executionStage).toBe('on_chain');
    expect(calls[0]!.route).toBe('promotion');
    // The on-chain revert branch sets `sponsorResultEconomics` directly
    // before throwing the PromotionSponsorError, so the outer catch
    // gate at `sponsorResultOutcome === 'internal_error'` does not run and
    // the rich economics is preserved. Ledger consume failure does not
    // make on-chain gas unknown; it is entitlement-accounting context
    // appended to the failureReason. Must NOT be the raw
    // PromotionSponsorError message ("Transaction reverted on-chain:
    // ..."), which is what would have been written by the outer catch
    // fall-through in the absence of the inner branch's economics
    // stamp.
    expect(calls[0]!.economics.economicsStatus).toBe('known');
    if (calls[0]!.economics.economicsStatus === 'known') {
      expect(calls[0]!.economics.recoveredGasMist).toBe('0');
      expect(calls[0]!.economics.hostNetMist).toBe(
        (-BigInt(calls[0]!.economics.hostPaidGasMist)).toString(),
      );
      expect(calls[0]!.economics.failureReason).toContain('onchain_revert');
      expect(calls[0]!.economics.failureReason).toContain('ledger consume failed');
      expect(calls[0]!.economics.failureReason).toContain('arbitrary on-chain abort');
    }
    expect(calls[0]!.economics.failureReason).not.toMatch(/Transaction reverted on-chain:/);

    consoleErrorSpy.mockRestore();
  });

  test('on-chain revert + consume() throws: sponsor result callback economics preserves on-chain revert classification', async () => {
    // Symmetric to the consume()-ok-false test above, but exercising
    // the adapter-throw branch of the failure-path consume helper.
    const { ctx, signed, receiptId, executionLedger } = await setup({
      execFail: true,
      revertWithGasUsed: true,
      execFailReason: 'arbitrary on-chain abort',
      withUsageCapture: true,
    });
    const calls: SponsorResultMetadata[] = [];
    ctx.onSponsorResult = (metadata) => {
      calls.push(metadata);
    };
    vi.spyOn(executionLedger, 'consume').mockRejectedValue(new Error('redis transport down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('ONCHAIN_REVERT');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.outcome).toBe('onchain_revert');
    expect(calls[0]!.executionStage).toBe('on_chain');
    expect(calls[0]!.economics.economicsStatus).toBe('known');
    if (calls[0]!.economics.economicsStatus === 'known') {
      expect(calls[0]!.economics.recoveredGasMist).toBe('0');
      expect(calls[0]!.economics.hostNetMist).toBe(
        (-BigInt(calls[0]!.economics.hostPaidGasMist)).toString(),
      );
      expect(calls[0]!.economics.failureReason).toContain('onchain_revert');
      expect(calls[0]!.economics.failureReason).toContain('ledger consume threw');
      expect(calls[0]!.economics.failureReason).toContain('arbitrary on-chain abort');
    }
    // The redis error stays in the LEDGER_CONSUME_THREW_IN_HANDLER
    // structured event, not in the sponsor result economics stamp — the
    // failureReason carries the on-chain revert reason (the primary
    // operational signal), not the secondary infra error.
    expect(calls[0]!.economics.failureReason).not.toMatch(/redis transport down/);

    consoleErrorSpy.mockRestore();
  });

  test('GAS_EFFECTS_MISSING + consume() returns ok=false: sponsor result callback economics stays unknown with GAS_EFFECTS_MISSING reason and outcome=success', async () => {
    // Post-success gas-effects-missing keeps `sponsorResultOutcome='success'`
    // because the slot balance change is authoritative from submit
    // onwards; the post-success accounting throws afterwards. A failing
    // consume() must not regress that to internal_error nor synthesize a
    // new economics string from the thrown PromotionSponsorError.
    const { ctx, signed, receiptId, executionLedger } = await setup({
      noGasUsed: true,
      withUsageCapture: true,
    });
    const calls: SponsorResultMetadata[] = [];
    ctx.onSponsorResult = (metadata) => {
      calls.push(metadata);
    };
    vi.spyOn(executionLedger, 'consume').mockResolvedValue({
      ok: false,
      reason: 'reservation_not_found',
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('GAS_EFFECTS_MISSING');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.outcome).toBe('success');
    expect(calls[0]!.economics.economicsStatus).toBe('unknown');
    if (calls[0]!.economics.economicsStatus === 'unknown') {
      // Handler appends the ledger-consume kind to the GAS_EFFECTS_MISSING
      // reason so operators see both signals on the row.
      expect(calls[0]!.economics.failureReason).toContain('GAS_EFFECTS_MISSING');
      expect(calls[0]!.economics.failureReason).toContain('ledger consume failed');
    }

    consoleErrorSpy.mockRestore();
  });

  test('GAS_EFFECTS_MISSING + consume() throws: sponsor result callback economics preserves GAS_EFFECTS_MISSING reason and outcome=success', async () => {
    const { ctx, signed, receiptId, executionLedger } = await setup({
      noGasUsed: true,
      withUsageCapture: true,
    });
    const calls: SponsorResultMetadata[] = [];
    ctx.onSponsorResult = (metadata) => {
      calls.push(metadata);
    };
    vi.spyOn(executionLedger, 'consume').mockRejectedValue(new Error('redis transport down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('GAS_EFFECTS_MISSING');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.outcome).toBe('success');
    expect(calls[0]!.economics.economicsStatus).toBe('unknown');
    if (calls[0]!.economics.economicsStatus === 'unknown') {
      expect(calls[0]!.economics.failureReason).toContain('GAS_EFFECTS_MISSING');
      expect(calls[0]!.economics.failureReason).toContain('ledger consume threw');
    }

    consoleErrorSpy.mockRestore();
  });

  test('pre-sign pool.sign() rejection releases reservation without post-signature uncertainty records', async () => {
    // Boundary regression: `pool.sign()` runs BEFORE
    // `executeTransaction()` inside `signAndSubmit`. A pre-sign lease
    // failure means the sponsor signature was NEVER issued, so the
    // promotion post-signature cleanup (consume + UsageEvent +
    // reconciliation event) MUST NOT fire. The active reservation
    // must be released via the pre-submit cleanup path so the user's
    // allowance is not held until the ExecutionLedger reservation reaper
    // sweeps.
    const { ctx, signed, receiptId, executionLedger, sponsorPool, usageRows } = await setup({
      withUsageCapture: true,
    });
    vi.spyOn(sponsorPool, 'sign').mockRejectedValue(new SponsorLeaseExpiredError(signed.txHash));
    const calls: SponsorResultMetadata[] = [];
    ctx.onSponsorResult = (metadata) => {
      calls.push(metadata);
    };
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorLeaseExpiredError);

    // Active reservation released → consumed stays at 0; allowance
    // restored via the pre-submit release path, not via reaper.
    const ent = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(ent!.activeReservationReceiptId).toBeNull();
    expect(ent!.consumedGasAllowanceMist).toBe('0');

    // No post-signature uncertainty UsageEvent. That failed usage row is reserved
    // for post-signature executeTransaction throws; pre-sign lease failures must
    // not reuse that row shape.
    expect(usageRows.find((r) => r.failureReason === 'post_signature_uncertainty')).toBeUndefined();

    // No post-signature uncertainty reconciliation
    // event. That event signals operator-side reconciliation for an
    // on-chain TX whose landing is uncertain; a pre-sign lease
    // failure has no on-chain TX to reconcile.
    const reconLog = consoleErrorSpy.mock.calls
      .map((args: unknown[]) => {
        try {
          return JSON.parse(args[0] as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.['event'] === 'PROMOTION_SPONSOR_POST_SIGNATURE_UNCERTAINTY');
    expect(reconLog).toBeUndefined();

    // Sponsor result callback receives `validation_failure` (existing
    // classification rule for `SponsorLeaseExpiredError`); economics must NOT
    // carry the post-signature uncertainty marker.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.outcome).toBe('validation_failure');
    expect(calls[0]!.executionStage).toBe('before_sponsor_signature');
    expect(calls[0]!.economics.economicsStatus).toBe('unknown');
    if (calls[0]!.economics.economicsStatus === 'unknown') {
      expect(calls[0]!.economics.failureReason ?? '').not.toContain('post_signature_uncertainty');
    }

    consoleErrorSpy.mockRestore();
  });

  test('congestion still releases (entitlement consumed=0)', async () => {
    const { ctx, signed, receiptId, executionLedger, usageRows } = await setup({
      execFail: true,
      execFailReason: 'confirmed shared-object congestion',
      execCongestion: true,
      withUsageCapture: true,
    });

    const err = await handlePromotionSponsor(ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId,
      txBytes: signed.txBytesBase64,
      userSignature: signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorCongestionError);
    const entitlement = await executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    // Release path → consumed stays at 0 (allowance restored).
    expect(entitlement!.consumedGasAllowanceMist).toBe('0');
    // No failed usage row written for congestion (release path).
    expect(usageRows.find((r) => r.result === 'failed')).toBeUndefined();
  });
});
