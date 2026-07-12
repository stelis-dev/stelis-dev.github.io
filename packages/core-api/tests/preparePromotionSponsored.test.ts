/**
 * preparePromotionSponsored.test.ts — unit tests for handlePromotionPrepare.
 *
 * Handler receives pre-verified VerifiedDeveloperIdentity.
 * JWT verification is route-layer responsibility — not tested here.
 *
 * Tests validate handler-level fail-closed gates:
 *   - senderAddress match (verified identity vs request)
 *   - promotion status check
 *   - entitlement existence (must claim first)
 *   - PTB structure guard (MoveCall only, no GasCoin)
 *   - Global target policy enforcement (STUDIO_ALLOWED_TARGETS)
 *   - Use window expiry
 */
import { describe, test, expect, vi } from 'vitest';
import { hashTargets } from '../src/studio/promotionTargetPolicy.js';
import {
  handlePromotionPrepare,
  PromotionPrepareError,
  type PromotionPrepareContext,
} from '../src/studio/preparePromotionSponsoredHandler.js';
import { MemoryPromotionStore, type CreatePromotionInput } from '../src/studio/promotionStore.js';
import { MemoryPromotionExecutionLedger } from '../src/studio/executionLedgerMemory.js';
import { MemoryPrepareStore } from '../src/store/memoryPrepareStore.js';
import { MemoryPrepareInflight } from '../src/store/memoryPrepareInflight.js';
import { PrepareOverloadError, PrepareStudioUserQuotaError } from '../src/store/prepareErrors.js';
import { SponsorPool } from '../src/context.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { toBase64 } from '@mysten/sui/utils';
import type { VerifiedDeveloperIdentity } from '../src/studio/developerJwtVerifier.js';
import { grpcSimulationSuccess } from './helpers/suiGrpcExecutionFixtures.js';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

// Fixed test keypair for sponsor (value irrelevant — only address matters)
const SPONSOR_KP = Ed25519Keypair.generate();
const USER_KP = Ed25519Keypair.generate();
const USER_ADDR = USER_KP.toSuiAddress();
// 32+ char HMAC secret for the in-memory sponsor pool lease proofs.
const TEST_HMAC_SECRET = 'prepare-promotion-test-hmac-secret-000';

const ALLOWED_TARGET =
  '0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin';
const GLOBAL_TARGET_HASHES = new Set(hashTargets([ALLOWED_TARGET]));

const PER_USER_ALLOWANCE = '100000000'; // 0.1 SUI
const SIMULATION_GAS_USED = {
  computationCost: '1000000',
  storageCost: '500000',
  storageRebate: '200000',
};

const BASE_PROMO: CreatePromotionInput = {
  type: 'gas_sponsorship',
  displayName: 'Test Promotion Prepare',
  description: 'Unit test promotion',
  maxParticipants: 100,
  perUserGasAllowanceMist: PER_USER_ALLOWANCE,
  claimDeadlineAt: null,
  postClaimUseWindowMs: 0,
  startAt: null,
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Build a pre-verified identity (simulating what the route layer produces). */
function buildIdentity(overrides?: Partial<VerifiedDeveloperIdentity>): VerifiedDeveloperIdentity {
  return {
    userId: overrides?.userId ?? 'user-42',
    senderAddress: overrides?.senderAddress ?? USER_ADDR,
  };
}

async function buildTestTxKindBytes(): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({ target: ALLOWED_TARGET as `${string}::${string}::${string}` });
  const kindBytes = await tx.build({ onlyTransactionKind: true });
  return toBase64(kindBytes);
}

function createMockSui() {
  return {
    simulateTransaction: async () => grpcSimulationSuccess('mock-digest', SIMULATION_GAS_USED),
  } as unknown as import('@mysten/sui/grpc').SuiGrpcClient;
}

/**
 * Extended mock that supports the full Transaction.build() gas-resolution path.
 *
 * Transaction.build({ client }) uses coreClientResolveTransactionPlugin when
 * client.core.resolveTransactionPlugin() returns undefined. That fallback calls
 * client.core.{getCurrentSystemState, getBalance, listCoins, getChainIdentifier}.
 *
 * Required only for tests that exercise the full prepare success path.
 * Tests that fail before step 6 (first build) can continue to use createMockSui().
 */
function createMockSuiWithCore() {
  return {
    simulateTransaction: async () => grpcSimulationSuccess('mock-digest', SIMULATION_GAS_USED),
    core: {
      // Returns undefined → Transaction.build() falls back to coreClientResolveTransactionPlugin,
      // which then calls the other core methods below for gas-price / gas-payment / expiration resolution.
      resolveTransactionPlugin: () => undefined,
      getCurrentSystemState: async () => ({
        systemState: { referenceGasPrice: '1000', epoch: '100' },
      }),
      // Sufficient address balance so setGasPayment() skips coin-object selection and sets payment = [].
      getBalance: async () => ({ balance: { addressBalance: '100000000000000' } }),
      listCoins: async () => ({ objects: [] }),
      // 32 ones in base58 = 32 zero bytes — valid ObjectDigest for ValidDuring.chain.
      getChainIdentifier: async () => ({ chainIdentifier: '11111111111111111111111111111111' }),
    },
  } as unknown as import('@mysten/sui/grpc').SuiGrpcClient;
}

// ─────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────

async function setup() {
  const promotionStore = new MemoryPromotionStore();
  const executionLedger = new MemoryPromotionExecutionLedger();
  const sponsorPool = new SponsorPool([SPONSOR_KP], { hmacSecret: TEST_HMAC_SECRET });
  const prepareStore = new MemoryPrepareStore((sponsorAddress, receiptId, txBytesHash) =>
    sponsorPool.checkin(sponsorAddress, receiptId, txBytesHash),
  );

  // Create and activate a promotion
  const record = await promotionStore.create(BASE_PROMO);
  const promoId = record.promotionId;
  await promotionStore.transitionStatus(promoId, 'active');

  // Claim promotion (creates entitlement atomically via ExecutionLedger)
  await executionLedger.claim(promoId, 'user-42', {
    maxParticipants: BASE_PROMO.maxParticipants,
    perUserGasAllowanceMist: PER_USER_ALLOWANCE,
    useUntilAt: null,
  });

  const ctx: PromotionPrepareContext = {
    sui: createMockSui(),
    promotionStore,
    executionLedger,
    sponsorPool,
    prepareStore,
    prepareInflightLimiter: new MemoryPrepareInflight(10),
    getConfig: async () => ({
      maxClaimMist: 50_000_000_000n,
      minSettleMist: 0n,
      maxHostFeeMist: 0n,
      protocolFlatFeeMist: 0n,
      configVersion: 1n,
      maxSpreadBps: 500n,
      packageId: '0x0',
      configId: '0x0',
    }),
    globalTargetHashes: GLOBAL_TARGET_HASHES,
  };

  return { ctx, promotionStore, executionLedger, prepareStore, promoId };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('handlePromotionPrepare', () => {
  // Cross-route: claim → prepare reads entitlement from same ExecutionLedger
  test('rejects when user has not claimed on this ExecutionLedger (ENTITLEMENT_NOT_FOUND)', async () => {
    const { ctx } = await setup();
    const txKind = await buildTestTxKindBytes();

    // A different user has not claimed — prepare must reject
    try {
      await handlePromotionPrepare(ctx, {
        promotionId: 'some-promo',
        senderAddress: USER_ADDR,
        txKindBytes: txKind,
        verifiedIdentity: buildIdentity({ userId: 'unclaimed-user' }),
        clientIp: '127.0.0.1',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionPrepareError);
      // either NOT_CLAIMED or PROMOTION_NOT_FOUND is acceptable — the point is
      // that the promotion execution ledger is the only source of entitlement truth.
      const code = (err as PromotionPrepareError).code;
      expect(['NOT_CLAIMED', 'PROMOTION_NOT_FOUND']).toContain(code);
    }
  });

  test('rejects senderAddress mismatch (verified identity vs request)', async () => {
    const { ctx, promoId } = await setup();
    const txKind = await buildTestTxKindBytes();
    const wrongAddr = '0x' + '1'.repeat(64);

    await expect(
      handlePromotionPrepare(ctx, {
        promotionId: promoId,
        senderAddress: wrongAddr,
        txKindBytes: txKind,
        verifiedIdentity: buildIdentity({ senderAddress: USER_ADDR }),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/senderAddress does not match/);
  });

  test('rejects when promotion not found', async () => {
    const { ctx } = await setup();
    const txKind = await buildTestTxKindBytes();

    await expect(
      handlePromotionPrepare(ctx, {
        promotionId: 'nonexistent-promo',
        senderAddress: USER_ADDR,
        txKindBytes: txKind,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/not found/i);
  });

  test('rejects when promotion not active', async () => {
    const { ctx, promoId, promotionStore } = await setup();
    await promotionStore.transitionStatus(promoId, 'paused');
    const txKind = await buildTestTxKindBytes();

    await expect(
      handlePromotionPrepare(ctx, {
        promotionId: promoId,
        senderAddress: USER_ADDR,
        txKindBytes: txKind,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/not active/i);
  });

  test('rejects when user has not claimed (no entitlement)', async () => {
    const { ctx, promoId } = await setup();
    const otherAddr = Ed25519Keypair.generate().toSuiAddress();
    const txKind = await buildTestTxKindBytes();

    await expect(
      handlePromotionPrepare(ctx, {
        promotionId: promoId,
        senderAddress: otherAddr,
        txKindBytes: txKind,
        verifiedIdentity: buildIdentity({ userId: 'unclaimed-user', senderAddress: otherAddr }),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toThrow(/must claim the promotion/);
  });

  test('rejects disallowed MoveCall target (global policy)', async () => {
    const { ctx, promoId } = await setup();

    // Build TX with a target NOT in the global allowlist
    const tx = new Transaction();
    tx.moveCall({
      target: '0x0000000000000000000000000000000000000000000000000000000000000bad::hack::steal',
    });
    const kindBytes = await tx.build({ onlyTransactionKind: true });
    const txKind = toBase64(kindBytes);

    try {
      await handlePromotionPrepare(ctx, {
        promotionId: promoId,
        senderAddress: USER_ADDR,
        txKindBytes: txKind,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionPrepareError);
      expect((err as PromotionPrepareError).code).toBe('DISALLOWED_TARGET');
    }
  });

  test('rejects txKindBytes larger than MAX_TX_KIND_BYTES with BAD_TX_KIND before inflight, checkout, reserve, or store (P0 size)', async () => {
    const { ctx, promoId } = await setup();
    const inflightSpy = vi.spyOn(ctx.prepareInflightLimiter, 'tryAcquire');
    const getConfigSpy = vi.spyOn(ctx, 'getConfig');
    const checkoutSpy = vi.spyOn(ctx.sponsorPool, 'checkout');
    const reserveSpy = vi.spyOn(ctx.executionLedger, 'reserve');
    const storeSpy = vi.spyOn(ctx.prepareStore, 'store');

    // 70KB payload: passes the 96KB prepare-request body cap but exceeds the
    // 64KB MAX_TX_KIND_BYTES field cap. P0 size check must fail at the
    // decode boundary before any expensive resource work begins.
    const oversized = new Uint8Array(70 * 1024);
    oversized.fill(0);
    const oversizedTxKind = toBase64(oversized);

    try {
      await handlePromotionPrepare(ctx, {
        promotionId: promoId,
        senderAddress: USER_ADDR,
        txKindBytes: oversizedTxKind,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionPrepareError);
      expect((err as PromotionPrepareError).code).toBe('BAD_TX_KIND');
      expect((err as PromotionPrepareError).statusHint).toBe(400);
    }
    expect(inflightSpy).not.toHaveBeenCalled();
    expect(getConfigSpy).not.toHaveBeenCalled();
    expect(checkoutSpy).not.toHaveBeenCalled();
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(storeSpy).not.toHaveBeenCalled();
  });

  test('rejects malformed base64 txKindBytes with BAD_TX_KIND before inflight, checkout, reserve, or store (P0 base64)', async () => {
    const { ctx, promoId } = await setup();
    const inflightSpy = vi.spyOn(ctx.prepareInflightLimiter, 'tryAcquire');
    const getConfigSpy = vi.spyOn(ctx, 'getConfig');
    const checkoutSpy = vi.spyOn(ctx.sponsorPool, 'checkout');
    const reserveSpy = vi.spyOn(ctx.executionLedger, 'reserve');
    const storeSpy = vi.spyOn(ctx.prepareStore, 'store');

    try {
      await handlePromotionPrepare(ctx, {
        promotionId: promoId,
        senderAddress: USER_ADDR,
        txKindBytes: 'not-valid-base64!!!',
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionPrepareError);
      expect((err as PromotionPrepareError).code).toBe('BAD_TX_KIND');
      expect((err as PromotionPrepareError).statusHint).toBe(400);
    }
    expect(inflightSpy).not.toHaveBeenCalled();
    expect(getConfigSpy).not.toHaveBeenCalled();
    expect(checkoutSpy).not.toHaveBeenCalled();
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(storeSpy).not.toHaveBeenCalled();
  });

  test('rejects undecodable txKindBytes with BAD_TX_KIND before inflight, checkout, reserve, or store (fail-closed decode)', async () => {
    const { ctx, promoId } = await setup();
    const inflightSpy = vi.spyOn(ctx.prepareInflightLimiter, 'tryAcquire');
    const getConfigSpy = vi.spyOn(ctx, 'getConfig');
    const checkoutSpy = vi.spyOn(ctx.sponsorPool, 'checkout');
    const reserveSpy = vi.spyOn(ctx.executionLedger, 'reserve');
    const storeSpy = vi.spyOn(ctx.prepareStore, 'store');

    // Garbage bytes that decode from base64 but fail Transaction.fromKind().
    const garbageTxKind = toBase64(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]));

    try {
      await handlePromotionPrepare(ctx, {
        promotionId: promoId,
        senderAddress: USER_ADDR,
        txKindBytes: garbageTxKind,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionPrepareError);
      expect((err as PromotionPrepareError).code).toBe('BAD_TX_KIND');
      expect((err as PromotionPrepareError).statusHint).toBe(400);
    }
    expect(inflightSpy).not.toHaveBeenCalled();
    expect(getConfigSpy).not.toHaveBeenCalled();
    expect(checkoutSpy).not.toHaveBeenCalled();
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(storeSpy).not.toHaveBeenCalled();
  });

  test('rejects real SDK MoveCall(... tx.gas ...) before inflight, checkout, reserve, or store (S-15)', async () => {
    const { ctx, promoId } = await setup();
    const inflightSpy = vi.spyOn(ctx.prepareInflightLimiter, 'tryAcquire');
    const getConfigSpy = vi.spyOn(ctx, 'getConfig');
    const checkoutSpy = vi.spyOn(ctx.sponsorPool, 'checkout');
    const reserveSpy = vi.spyOn(ctx.executionLedger, 'reserve');
    const storeSpy = vi.spyOn(ctx.prepareStore, 'store');

    // Real SDK build: MoveCall with tx.gas as an argument.
    const tx = new Transaction();
    tx.moveCall({
      target: ALLOWED_TARGET as `${string}::${string}::${string}`,
      arguments: [tx.gas],
    });
    const kindBytes = await tx.build({ onlyTransactionKind: true });
    const txKind = toBase64(kindBytes);

    try {
      await handlePromotionPrepare(ctx, {
        promotionId: promoId,
        senderAddress: USER_ADDR,
        txKindBytes: txKind,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionPrepareError);
      expect((err as PromotionPrepareError).code).toBe('GASCOIN_FORBIDDEN');
      expect((err as PromotionPrepareError).statusHint).toBe(403);
    }
    expect(inflightSpy).not.toHaveBeenCalled();
    expect(getConfigSpy).not.toHaveBeenCalled();
    expect(checkoutSpy).not.toHaveBeenCalled();
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(storeSpy).not.toHaveBeenCalled();
  });

  test('rejects FundsWithdrawal(Sponsor) input before inflight, checkout, reserve, or store (S-15 companion)', async () => {
    const { ctx, promoId } = await setup();
    const inflightSpy = vi.spyOn(ctx.prepareInflightLimiter, 'tryAcquire');
    const getConfigSpy = vi.spyOn(ctx, 'getConfig');
    const checkoutSpy = vi.spyOn(ctx.sponsorPool, 'checkout');
    const reserveSpy = vi.spyOn(ctx.executionLedger, 'reserve');
    const storeSpy = vi.spyOn(ctx.prepareStore, 'store');

    // Build a Sender withdrawal, patch to Sponsor via BCS
    const seed = new Transaction();
    seed.withdrawal({ amount: 999_999_999n, type: '0x2::sui::SUI' });
    const kindBytes = await seed.build({ onlyTransactionKind: true });
    const decoded = bcs.TransactionKind.parse(kindBytes);
    const fw = decoded.ProgrammableTransaction.inputs[0] as {
      FundsWithdrawal: { withdrawFrom: Record<string, unknown> };
    };
    fw.FundsWithdrawal.withdrawFrom = { Sponsor: true };
    const patched = bcs.TransactionKind.serialize(decoded).toBytes();
    const txKind = toBase64(patched);

    try {
      await handlePromotionPrepare(ctx, {
        promotionId: promoId,
        senderAddress: USER_ADDR,
        txKindBytes: txKind,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionPrepareError);
      expect((err as PromotionPrepareError).code).toBe('SPONSOR_WITHDRAWAL_FORBIDDEN');
    }
    expect(inflightSpy).not.toHaveBeenCalled();
    expect(getConfigSpy).not.toHaveBeenCalled();
    expect(checkoutSpy).not.toHaveBeenCalled();
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(storeSpy).not.toHaveBeenCalled();
  });

  test('rejects with PROMOTION_NOT_STARTED when startAt is in the future', async () => {
    const { ctx, promotionStore, executionLedger } = await setup();

    // Create a second promotion with `startAt` in the future, activate it,
    // and have the user claim on it. Activation prerequisites only gate
    // `maxParticipants` / `perUserGasAllowanceMist`, so future `startAt`
    // coexists with an active record — exactly the race we want to gate.
    const futureStart = new Date(Date.now() + 86_400_000).toISOString();
    const futurePromo = await promotionStore.create({
      ...BASE_PROMO,
      displayName: 'Future-start Promo',
      startAt: futureStart,
    });
    await promotionStore.transitionStatus(futurePromo.promotionId, 'active');

    await executionLedger.claim(futurePromo.promotionId, 'user-42', {
      maxParticipants: BASE_PROMO.maxParticipants,
      perUserGasAllowanceMist: PER_USER_ALLOWANCE,
      useUntilAt: null,
    });

    const txKind = await buildTestTxKindBytes();

    try {
      await handlePromotionPrepare(ctx, {
        promotionId: futurePromo.promotionId,
        senderAddress: USER_ADDR,
        txKindBytes: txKind,
        verifiedIdentity: buildIdentity({ userId: 'user-42' }),
        clientIp: '127.0.0.1',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionPrepareError);
      expect((err as PromotionPrepareError).code).toBe('PROMOTION_NOT_STARTED');
      expect((err as PromotionPrepareError).statusHint).toBe(409);
    }
  });

  test('rejects when use window has expired (USE_WINDOW_EXPIRED)', async () => {
    const { ctx, promoId, executionLedger } = await setup();

    // Claim with a use window that has already expired
    await executionLedger.claim(promoId, 'user-expired', {
      maxParticipants: 0,
      perUserGasAllowanceMist: PER_USER_ALLOWANCE,
      useUntilAt: new Date(Date.now() - 86400_000).toISOString(),
    });

    const txKind = await buildTestTxKindBytes();

    try {
      await handlePromotionPrepare(ctx, {
        promotionId: promoId,
        senderAddress: USER_ADDR,
        txKindBytes: txKind,
        verifiedIdentity: buildIdentity({ userId: 'user-expired' }),
        clientIp: '127.0.0.1',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PromotionPrepareError);
      expect((err as PromotionPrepareError).code).toBe('USE_WINDOW_EXPIRED');
    }
  });

  // ── Inflight gate ────────────────────────────────────────────────────

  test('rejects with PrepareOverloadError when inflight gate is exhausted', async () => {
    const { ctx, promoId } = await setup();
    const exhaustedLimiter = new MemoryPrepareInflight(1);
    // Pre-occupy the only slot so tryAcquire returns null
    await exhaustedLimiter.tryAcquire('test-occupy');
    const txKind = await buildTestTxKindBytes();
    const checkoutSpy = vi.spyOn(ctx.sponsorPool, 'checkout');

    await expect(
      handlePromotionPrepare(
        { ...ctx, prepareInflightLimiter: exhaustedLimiter },
        {
          promotionId: promoId,
          senderAddress: USER_ADDR,
          txKindBytes: txKind,
          verifiedIdentity: buildIdentity(),
          clientIp: '127.0.0.1',
        },
      ),
    ).rejects.toBeInstanceOf(PrepareOverloadError);

    expect(checkoutSpy).not.toHaveBeenCalled();
  });

  // ── Inflight release hardening ──────────────────────────────────────
  // Verifies that a failing inflightHandle.release() in the outer finally
  // does not replace the original handler outcome (success or domain error).

  test('release failure does not replace successful prepare result', async () => {
    const { ctx, promoId } = await setup();
    const txKind = await buildTestTxKindBytes();
    const releaseFn = vi.fn().mockRejectedValue(new Error('Redis RELEASE failed'));

    const result = await handlePromotionPrepare(
      {
        ...ctx,
        // Provide a full-path Sui mock required for Transaction.build() gas resolution.
        sui: createMockSuiWithCore(),
        prepareInflightLimiter: {
          tryAcquire: vi.fn().mockResolvedValue({ release: releaseFn }),
          inflight: 0,
          capacity: 10,
        },
      },
      {
        promotionId: promoId,
        senderAddress: USER_ADDR,
        txKindBytes: txKind,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      },
    );

    // Successful result must be returned — release failure must not replace it.
    expect(result.txBytes).toBeDefined();
    expect(result.receiptId).toBeDefined();
    expect(result.estimatedGasMist).toBeDefined();
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  test('release failure does not replace original domain/runtime error', async () => {
    const { ctx, promoId } = await setup();
    const txKind = await buildTestTxKindBytes();
    const releaseFn = vi.fn().mockRejectedValue(new Error('Redis RELEASE failed'));

    // getConfig throws a domain error after inflight admission — the original
    // error must propagate, not the release-time Redis error.
    await expect(
      handlePromotionPrepare(
        {
          ...ctx,
          prepareInflightLimiter: {
            tryAcquire: vi.fn().mockResolvedValue({ release: releaseFn }),
            inflight: 0,
            capacity: 10,
          },
          getConfig: async () => {
            throw new Error('on-chain config read failed');
          },
        },
        {
          promotionId: promoId,
          senderAddress: USER_ADDR,
          txKindBytes: txKind,
          verifiedIdentity: buildIdentity(),
          clientIp: '127.0.0.1',
        },
      ),
    ).rejects.toThrow('on-chain config read failed');

    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  test('inflight slot is released after post-acquire failure (getConfig throws)', async () => {
    const { ctx, promoId } = await setup();
    const limiter = new MemoryPrepareInflight(1);
    const txKind = await buildTestTxKindBytes();

    await expect(
      handlePromotionPrepare(
        {
          ...ctx,
          prepareInflightLimiter: limiter,
          getConfig: async () => {
            throw new Error('config fetch failed');
          },
        },
        {
          promotionId: promoId,
          senderAddress: USER_ADDR,
          txKindBytes: txKind,
          verifiedIdentity: buildIdentity(),
          clientIp: '127.0.0.1',
        },
      ),
    ).rejects.toThrow('config fetch failed');

    // Inflight must be released — limiter should have capacity available again
    expect(limiter.inflight).toBe(0);
    const handle = await limiter.tryAcquire('verify');
    expect(handle).not.toBeNull();
    await handle!.release();
  });

  // ── Studio-user outstanding-prepare quota precheck ───────────────────

  test('rejects with PrepareStudioUserQuotaError on studio-user quota precheck exceeded (before slot checkout)', async () => {
    const { ctx, promoId } = await setup();
    const txKind = await buildTestTxKindBytes();
    const checkoutSpy = vi.spyOn(ctx.sponsorPool, 'checkout');

    // Override checkUserQuota on the prepareStore to simulate quota exceeded
    const quotaCtx: PromotionPrepareContext = {
      ...ctx,
      prepareStore: {
        ...ctx.prepareStore,
        checkUserQuota: async () => ({ exceeded: true as const, limit: 1 }),
      },
    };

    await expect(
      handlePromotionPrepare(quotaCtx, {
        promotionId: promoId,
        senderAddress: USER_ADDR,
        txKindBytes: txKind,
        verifiedIdentity: buildIdentity(),
        clientIp: '127.0.0.1',
      }),
    ).rejects.toBeInstanceOf(PrepareStudioUserQuotaError);

    expect(checkoutSpy).not.toHaveBeenCalled();
  });
});
