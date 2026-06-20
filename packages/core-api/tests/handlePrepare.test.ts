/**
 * Direct tests for handlePrepare — handler-level boundary testing.
 *
 * Tests validate:
 *   - P0: txKindBytes size check
 *   - P1: pre-settle validation (settle command rejection)
 *   - Unsupported settlement token rejection
 *   - Slot checkout failure → NO_SPONSOR_SLOT
 *   - Slot release on post-checkout failure (await checkin)
 *   - No slot release for pre-checkout errors (P0, orderId, queryUserCredit)
 *
 * On-chain queries and dry-run are mocked — integration testing
 * requires a live network or more elaborate test infrastructure.
 */
import { describe, it, expect, vi } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { toBase64 } from '@mysten/sui/utils';
import type { PrepareParams, PrepareHandlerConfig } from '../src/handlers/prepare.js';
import { handlePrepare } from '../src/handlers/prepare.js';
import { PrepareValidationError, MAX_TX_KIND_BYTES } from '../src/prepare/replay.js';
import { PrepareOverloadError } from '../src/store/prepareErrors.js';
import { createStaticSettlementSwapPathDescriptorMap } from '@stelis/core-relay/server';
import { TEST_PREPARE_AUTH_SENDER, withPrepareAuthorization } from './prepareAuthTestHelpers.js';

/** Valid-format test address (64-hex) for use in tests that reach BCS serialize. */
const TEST_SENDER_ADDR = TEST_PREPARE_AUTH_SENDER;

// ─── Mock HostContext factory ────────────────────────────────────────────

function makeMockContext(overrides?: {
  checkoutResult?: { slotId: string; sponsorAddress: string } | null;
}) {
  const onchainConfig = {
    packageId: '0xPACKAGE',
    configId: '0xCONFIG',
    maxClaimMist: 50_000_000n,
    minSettleMist: 0n,
    maxHostFeeMist: 50_000n,
    protocolFlatFeeMist: 0n,
    configVersion: 1n,
  };

  return {
    ctx: {
      network: 'testnet' as const,
      sui: {
        core: {
          getMoveFunction: vi.fn().mockRejectedValue(new Error('mock: no move function')),
        },
        getObject: vi.fn().mockRejectedValue(new Error('mock: no on-chain')),
        getDynamicField: vi.fn(),
        listOwnedObjects: vi.fn().mockResolvedValue({ objects: [] }),
        listCoins: vi.fn().mockResolvedValue({ objects: [] }),
        simulateTransaction: vi.fn().mockResolvedValue({
          Transaction: {
            status: { success: true },
            effects: {
              gasUsed: {
                computationCost: '1000000',
                storageCost: '500000',
                storageRebate: '200000',
              },
            },
          },
        }),
      },
      sponsorPool: {
        checkout: vi
          .fn()
          .mockResolvedValue(
            overrides?.checkoutResult !== undefined
              ? overrides.checkoutResult
              : { slotId: 'slot-1', sponsorAddress: '0xSPONSOR' },
          ),
        commit: vi.fn().mockResolvedValue(undefined),
        checkin: vi.fn().mockResolvedValue(undefined),
        sign: vi.fn(),
      },
      packageId: '0xPACKAGE',
      configId: '0xCONFIG',
      vaultRegistryId: '0xREGISTRY',
      rateLimiter: {},
      abuseBlocker: {
        checkIp: vi.fn().mockResolvedValue({ blocked: false }),
        checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
        recordSponsorFailure: vi.fn().mockResolvedValue(undefined),
      },
      prepareRequestNonceStore: {
        claim: vi.fn().mockResolvedValue('ok'),
      },
      prepareStore: {
        store: vi.fn().mockResolvedValue(undefined),
        consume: vi.fn(),
        peek: vi.fn(),
        evictPreparedEntry: vi.fn().mockResolvedValue(undefined),
        reserveNonce: vi.fn().mockResolvedValue(1n),
        releaseReservation: vi.fn().mockResolvedValue(undefined),
      },
      prepareInflightLimiter: {
        tryAcquire: vi.fn().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) }),
        inflight: 0,
        capacity: 10,
      },
      settlementPayoutRecipientAddress: '0xPAYOUT',
      getConfig: vi.fn().mockResolvedValue(onchainConfig),
    } as unknown as Parameters<typeof handlePrepare>[0],
    onchainConfig,
  };
}

function makeExtraCfg(): PrepareHandlerConfig {
  const supportedSettlementSwapPaths = [
    {
      hops: [
        {
          poolId: '0xPOOL',
          baseType: '0xDEEP::deep::DEEP',
          quoteType: '0x2::sui::SUI',
          swapDirection: 'baseForQuote' as const,
          feeBps: 0,
        },
      ],
      settlementTokenType: '0xDEEP::deep::DEEP',
      settlementTokenSymbol: 'DEEP',
      settlementTokenDecimals: 6,
      lotSize: 1,
      minSize: 1,
      effectiveFeeRateBps: 0,
      settlementSwapDirection: 'baseForQuote' as const,
    },
  ];
  return {
    deepbookPackageId: '0xDEEPBOOK',
    quotedHostFeeMist: 0n,
    allowedSettlementSwapPaths: [
      {
        tokenType: '0xDEEP::deep::DEEP',
        hops: ['0xPOOL'],
        settlementSwapDirection: 'baseForQuote',
      },
    ],
    supportedSettlementSwapPaths,
    settlementSwapPathDescriptors: createStaticSettlementSwapPathDescriptorMap(
      supportedSettlementSwapPaths,
    ),
  };
}

/** Build minimal valid txKindBytes (MakeMoveVec — no GasCoin, offline-safe). */
async function makeValidTxKindBytes(): Promise<string> {
  const tx = new Transaction();
  tx.makeMoveVec({ elements: [tx.pure.u64(42)] });
  const kindBytes = await tx.build({ onlyTransactionKind: true });
  return toBase64(kindBytes);
}

async function makeParams(overrides?: Partial<PrepareParams>): Promise<PrepareParams> {
  return withPrepareAuthorization({
    txKindBytes: '',
    senderAddress: TEST_SENDER_ADDR,
    settlementTokenType: '0xDEEP::deep::DEEP',
    clientIp: '127.0.0.1',
    ...overrides,
  });
}

async function makeParamsWithRequestShapeOverride(
  signedOverrides: Partial<PrepareParams>,
  shapeOverrides: Partial<PrepareParams>,
): Promise<PrepareParams> {
  return {
    ...(await makeParams(signedOverrides)),
    ...shapeOverrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function expectPrepareError(
  ctx: Parameters<typeof handlePrepare>[0],
  params: PrepareParams,
  extraCfg: PrepareHandlerConfig,
  expectedCode: string,
) {
  try {
    await handlePrepare(ctx, params, extraCfg);
    expect.unreachable('Expected PrepareValidationError');
  } catch (err) {
    expect(err).toBeInstanceOf(PrepareValidationError);
    expect((err as PrepareValidationError).code).toBe(expectedCode);
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handlePrepare', () => {
  // ── P0: Size check ──────────────────────────────────────────────────────

  it('P0 — rejects txKindBytes exceeding MAX_TX_KIND_BYTES', async () => {
    const { ctx } = makeMockContext();
    const oversizedBytes = toBase64(new Uint8Array(MAX_TX_KIND_BYTES + 1));
    const params = await makeParams({ txKindBytes: oversizedBytes });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'P0_TX_KIND_TOO_LARGE');
  });

  it('P0 — rejects invalid txKindBytes', async () => {
    const { ctx } = makeMockContext();
    const params = await makeParams({ txKindBytes: toBase64(new Uint8Array([1, 2, 3, 4])) });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'P0_INVALID_TX_KIND');
  });

  // ── P1: GasCoin rejection coverage ──────────────────────────────────────

  it('P1 — rejects txKindBytes containing GasCoin reference', async () => {
    const { ctx } = makeMockContext();
    const tx = new Transaction();
    // TransferObjects([GasCoin], attacker) must be rejected
    const TEST_ATTACKER_ADDR = '0x' + '0'.repeat(62) + '01';
    tx.transferObjects([tx.gas], TEST_ATTACKER_ADDR);
    const kindBytes = await tx.build({ onlyTransactionKind: true });
    const params = await makeParams({ txKindBytes: toBase64(kindBytes) });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'P1_GASCOIN_FORBIDDEN');
  });

  // ── P1: FundsWithdrawal(Sponsor) rejection (S-15 companion) ──────────────

  it('P1 — rejects txKindBytes containing FundsWithdrawal(Sponsor) before expensive or stateful stages', async () => {
    const { ctx } = makeMockContext();
    // Build a Sender withdrawal, then patch to Sponsor via BCS
    const seed = new Transaction();
    seed.withdrawal({ amount: 999_999_999n, type: '0x2::sui::SUI' });
    const kindBytes = await seed.build({ onlyTransactionKind: true });
    const decoded = bcs.TransactionKind.parse(kindBytes);
    const fw = decoded.ProgrammableTransaction.inputs[0] as {
      FundsWithdrawal: { withdrawFrom: Record<string, unknown> };
    };
    fw.FundsWithdrawal.withdrawFrom = { Sponsor: true };
    const patched = bcs.TransactionKind.serialize(decoded).toBytes();
    const params = await makeParams({ txKindBytes: toBase64(patched) });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'P1_SPONSOR_WITHDRAWAL_FORBIDDEN');
    expect(ctx.prepareInflightLimiter.tryAcquire).not.toHaveBeenCalled();
    expect(ctx.sui.getDynamicField).not.toHaveBeenCalled();
    expect(ctx.sui.getObject).not.toHaveBeenCalled();
    expect(ctx.getConfig).not.toHaveBeenCalled();
    expect(ctx.sponsorPool.checkout).not.toHaveBeenCalled();
    expect(ctx.sponsorPool.checkin).not.toHaveBeenCalled();
    expect(ctx.prepareStore.reserveNonce).not.toHaveBeenCalled();
    expect(ctx.prepareStore.releaseReservation).not.toHaveBeenCalled();
    expect(ctx.prepareStore.store).not.toHaveBeenCalled();
  });

  // ── Unsupported settlement token ────────────────────────────────────────────────

  it('rejects unsupported settlement token', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({
      txKindBytes,
      settlementTokenType: '0xUNSUPPORTED::token::TOKEN',
    });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'UNSUPPORTED_SETTLEMENT_TOKEN');
  });

  // ── Slot checkout failure ────────────────────────────────────────────────

  it('rejects when no sponsor slots available', async () => {
    const { ctx } = makeMockContext({ checkoutResult: null });
    // queryUserCredit + getConfig now run before checkout.
    // Provide vaultsTableId so queryUserCredit skips getObject; getDynamicField
    // rejects with a "not found"-shaped error so it returns needsCreate: true.
    ctx.vaultsTableId = '0xTABLE';
    (ctx.sui.getDynamicField as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('dynamic field not found'), { code: 'dynamicFieldNotFound' }),
    );
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({ txKindBytes, senderAddress: TEST_SENDER_ADDR });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'NO_SPONSOR_SLOT');
  });

  // ── Slot release on failure (await checkin) ──────────────────────────────

  it('releases slot on post-checkout failure (await checkin)', async () => {
    const { ctx } = makeMockContext();
    // queryUserCredit now runs before checkout — must succeed.
    ctx.vaultsTableId = '0xTABLE';
    (ctx.sui.getDynamicField as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('dynamic field not found'), { code: 'dynamicFieldNotFound' }),
    );
    // prepareStore.reserveNonce runs after checkout — make it throw to
    // simulate a post-checkout failure.
    ctx.prepareStore.reserveNonce = vi.fn().mockRejectedValue(new Error('nonce store error'));
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({ txKindBytes, senderAddress: TEST_SENDER_ADDR });

    await expect(handlePrepare(ctx, params, makeExtraCfg())).rejects.toThrow('nonce store error');

    // Verify checkin was called to release the slot. The second
    // arg is the receiptId the prepare flow generated before checkout, so
    // we assert on the receiptIdHex shape rather than a fixed value.
    expect(ctx.sponsorPool.checkin).toHaveBeenCalledTimes(1);
    const checkinCall = (ctx.sponsorPool.checkin as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(checkinCall[0]).toBe('slot-1');
    expect(checkinCall[1]).toMatch(/^0x[0-9a-f]{64}$/);
  });

  // ── No slot release for pre-checkout errors ──────────────────────────────

  it('releases pending nonce reservation on post-checkout failure', async () => {
    const { ctx } = makeMockContext();
    // queryUserCredit must succeed (pre-checkout)
    ctx.vaultsTableId = '0xTABLE';
    (ctx.sui.getDynamicField as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('dynamic field not found'), { code: 'dynamicFieldNotFound' }),
    );
    // reserveNonce succeeds — a pending reservation is created
    ctx.prepareStore.reserveNonce = vi.fn().mockResolvedValue(5n);
    // runGenericPrepareBuildPipeline fails (mid-price query) — triggers catch block after reserveNonce
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({ txKindBytes, senderAddress: TEST_SENDER_ADDR });

    await expect(handlePrepare(ctx, params, makeExtraCfg())).rejects.toThrow();

    // Verify releaseReservation was called with the receiptId and sender
    expect(ctx.prepareStore.releaseReservation).toHaveBeenCalledTimes(1);
    const [reservationId, sender] = (
      ctx.prepareStore.releaseReservation as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(reservationId).toMatch(/^0x[0-9a-f]{64}$/); // receiptIdHex format
    expect(sender).toBe(TEST_SENDER_ADDR);
    // checkin also called
    expect(ctx.sponsorPool.checkin).toHaveBeenCalledTimes(1);
  });

  it('does NOT release slot for P0 validation errors', async () => {
    const { ctx } = makeMockContext();
    const params = await makeParams({ txKindBytes: toBase64(new Uint8Array([1, 2, 3])) });

    await expect(handlePrepare(ctx, params, makeExtraCfg())).rejects.toThrow(
      PrepareValidationError,
    );

    // Checkout and checkin should never have been called
    expect(ctx.sponsorPool.checkout).not.toHaveBeenCalled();
    expect(ctx.sponsorPool.checkin).not.toHaveBeenCalled();
  });

  // ── B-3: Slot checkin called exactly once on error paths ─────────────────

  it('checkin called exactly once — no double-release on post-checkout failure', async () => {
    const { ctx } = makeMockContext();
    // queryUserCredit runs before checkout — must succeed.
    ctx.vaultsTableId = '0xTABLE';
    (ctx.sui.getDynamicField as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('dynamic field not found'), { code: 'dynamicFieldNotFound' }),
    );
    ctx.prepareStore.reserveNonce = vi.fn().mockRejectedValue(new Error('nonce store error'));
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({ txKindBytes, senderAddress: TEST_SENDER_ADDR });

    await expect(handlePrepare(ctx, params, makeExtraCfg())).rejects.toThrow('nonce store error');

    expect(ctx.sponsorPool.checkin).toHaveBeenCalledTimes(1);
    // receiptId is the lease authenticator. Assert on its
    // shape rather than a fixed value.
    const checkinArgs = (ctx.sponsorPool.checkin as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(checkinArgs[0]).toBe('slot-1');
    expect(checkinArgs[1]).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('does NOT release slot when queryUserCredit throws before checkout', async () => {
    // queryUserCredit now runs before checkout. If it throws,
    // no slot has been checked out → no checkin should happen.
    const { ctx } = makeMockContext();
    // Force queryUserCredit to throw by not providing vaultsTableId
    // and having getObject reject.
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({ txKindBytes });

    await expect(handlePrepare(ctx, params, makeExtraCfg())).rejects.toThrow('mock: no on-chain');

    // No slot was checked out → checkout never called, checkin never called.
    expect(ctx.sponsorPool.checkout).not.toHaveBeenCalled();
    expect(ctx.sponsorPool.checkin).not.toHaveBeenCalled();
  });

  // ── VAULT_STATE_INCONSISTENT — fail-closed on inconsistent vault state ──

  it('returns VAULT_STATE_INCONSISTENT with vaultId and userAddress meta when registry has vault but object is missing', async () => {
    const { ctx } = makeMockContext();
    ctx.vaultsTableId = '0xTABLE';
    const { bcs } = await import('@mysten/sui/bcs');
    const vaultId = '0x' + 'bb'.repeat(32);
    // getDynamicField returns a vault ID (registry entry exists)
    (ctx.sui.getDynamicField as ReturnType<typeof vi.fn>).mockResolvedValue({
      dynamicField: {
        value: { bcs: bcs.Address.serialize(vaultId).toBytes() },
      },
    });
    // getObject rejects with objectNotFound (vault object missing)
    (ctx.sui.getObject as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('Object not found'), { code: 'objectNotFound' }),
    );
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({ txKindBytes, senderAddress: TEST_SENDER_ADDR });

    try {
      await handlePrepare(ctx, params, makeExtraCfg());
      expect.unreachable('Expected PrepareValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      const pve = err as PrepareValidationError;
      expect(pve.code).toBe('VAULT_STATE_INCONSISTENT');
      // Verify meta fields are included (these are spread into HTTP response body)
      expect(pve.meta).toBeDefined();
      expect(pve.meta!.vaultId).toBe(vaultId);
      expect(pve.meta!.userAddress).toBe(TEST_SENDER_ADDR);
    }
    // Error occurs before slot checkout
    expect(ctx.sponsorPool.checkout).not.toHaveBeenCalled();
    expect(ctx.sponsorPool.checkin).not.toHaveBeenCalled();
  });

  // ── orderId validation (INVALID_ORDER_ID) ──────────────────────────────

  it('rejects orderId exceeding 128 UTF-8 bytes without slot checkout', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    // 129 ASCII chars = 129 UTF-8 bytes → exceeds 128-byte cap
    const longOrderId = 'x'.repeat(129);
    const params = await makeParams({ txKindBytes, orderId: longOrderId });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'INVALID_ORDER_ID');
    // orderId validation now happens before checkout — no slot to release
    expect(ctx.sponsorPool.checkout).not.toHaveBeenCalled();
    expect(ctx.sponsorPool.checkin).not.toHaveBeenCalled();
  });

  it('rejects empty string orderId', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParamsWithRequestShapeOverride({ txKindBytes }, { orderId: '' });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'INVALID_ORDER_ID');
  });

  // ── Generic path does NOT gate on the studio-user outstanding-prepare quota ──
  // The outstanding-prepare quota is keyed by verified developer JWT `userId`
  // (Studio promotion principal). The generic `/relay/prepare` route has no
  // verified userId, so `checkUserQuota` must not run on this path.

  it('generic path does not call checkUserQuota (studio-user quota is promotion-only)', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({ txKindBytes });

    ctx.prepareStore.checkUserQuota = vi.fn();

    // The call will fail at queryUserCredit (mock: no on-chain) but that
    // is downstream of where a user-quota gate would run on the promotion
    // path. The key assertion is that the generic handler never invokes it.
    await expect(handlePrepare(ctx, params, makeExtraCfg())).rejects.toThrow();
    expect(ctx.prepareStore.checkUserQuota).not.toHaveBeenCalled();
  });

  // ── In-flight limiter rejection ───────────────────────────────────────

  it('rejects with PREPARE_OVERLOADED when in-flight limiter is at capacity', async () => {
    const { ctx } = makeMockContext();
    // Limiter at capacity — tryAcquire returns null
    ctx.prepareInflightLimiter = {
      tryAcquire: vi.fn().mockResolvedValue(null),
      inflight: 5,
      capacity: 5,
    };
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({ txKindBytes });

    try {
      await handlePrepare(ctx, params, makeExtraCfg());
      expect.unreachable('Expected PrepareOverloadError');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareOverloadError);
      expect((err as PrepareOverloadError).code).toBe('PREPARE_OVERLOADED');
    }
    // No slot should have been checked out
    expect(ctx.sponsorPool.checkout).not.toHaveBeenCalled();
  });

  // ── BPS input boundary enforcement ──────────────────────────────────────

  it('rejects decimal slippageBps with INVALID_SLIPPAGE_BPS', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParamsWithRequestShapeOverride({ txKindBytes }, { slippageBps: 1.5 });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'INVALID_SLIPPAGE_BPS');
    expect(ctx.sponsorPool.checkout).not.toHaveBeenCalled();
  });

  it('rejects negative slippageBps with INVALID_SLIPPAGE_BPS', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParamsWithRequestShapeOverride({ txKindBytes }, { slippageBps: -1 });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'INVALID_SLIPPAGE_BPS');
  });

  it('rejects slippageBps exceeding SLIPPAGE_CAP_BPS with INVALID_SLIPPAGE_BPS', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({ txKindBytes, slippageBps: 501 });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'INVALID_SLIPPAGE_BPS');
  });

  it('rejects NaN slippageBps with INVALID_SLIPPAGE_BPS', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParamsWithRequestShapeOverride({ txKindBytes }, { slippageBps: NaN });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'INVALID_SLIPPAGE_BPS');
  });

  it('rejects Infinity slippageBps with INVALID_SLIPPAGE_BPS', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParamsWithRequestShapeOverride(
      { txKindBytes },
      { slippageBps: Infinity },
    );

    await expectPrepareError(ctx, params, makeExtraCfg(), 'INVALID_SLIPPAGE_BPS');
  });

  it('rejects decimal gasMarginBps with INVALID_GAS_MARGIN_BPS', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParamsWithRequestShapeOverride({ txKindBytes }, { gasMarginBps: 1.5 });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'INVALID_GAS_MARGIN_BPS');
    expect(ctx.sponsorPool.checkout).not.toHaveBeenCalled();
  });

  it('rejects negative gasMarginBps with INVALID_GAS_MARGIN_BPS', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParamsWithRequestShapeOverride({ txKindBytes }, { gasMarginBps: -1 });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'INVALID_GAS_MARGIN_BPS');
  });

  it('rejects NaN gasMarginBps with INVALID_GAS_MARGIN_BPS', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParamsWithRequestShapeOverride({ txKindBytes }, { gasMarginBps: NaN });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'INVALID_GAS_MARGIN_BPS');
  });

  it('rejects Infinity gasMarginBps with INVALID_GAS_MARGIN_BPS', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParamsWithRequestShapeOverride(
      { txKindBytes },
      { gasMarginBps: Infinity },
    );

    await expectPrepareError(ctx, params, makeExtraCfg(), 'INVALID_GAS_MARGIN_BPS');
  });

  it('rejects gasMarginBps exceeding cap with INVALID_GAS_MARGIN_BPS', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({ txKindBytes, gasMarginBps: 10001 });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'INVALID_GAS_MARGIN_BPS');
  });

  it('accepts slippageBps=0 and gasMarginBps=0 (valid edge)', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({
      txKindBytes,
      slippageBps: 0,
      gasMarginBps: 0,
    });

    // Will fail later at queryUserCredit, but should NOT fail at BPS validation.
    try {
      await handlePrepare(ctx, params, makeExtraCfg());
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      // Must NOT be INVALID_SLIPPAGE_BPS or INVALID_GAS_MARGIN_BPS
      if (err instanceof PrepareValidationError) {
        expect(err.code).not.toBe('INVALID_SLIPPAGE_BPS');
        expect(err.code).not.toBe('INVALID_GAS_MARGIN_BPS');
      }
    }
  });

  it('accepts slippageBps at cap boundary (SLIPPAGE_CAP_BPS=500)', async () => {
    const { ctx } = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({ txKindBytes, slippageBps: 500 });

    // Should NOT fail at BPS validation
    try {
      await handlePrepare(ctx, params, makeExtraCfg());
    } catch (err) {
      if (err instanceof PrepareValidationError) {
        expect(err.code).not.toBe('INVALID_SLIPPAGE_BPS');
      }
    }
  });

  it('releases in-flight handle even when slot checkout fails', async () => {
    const releaseFn = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeMockContext({ checkoutResult: null });
    ctx.prepareInflightLimiter = {
      tryAcquire: vi.fn().mockResolvedValue({ release: releaseFn }),
      inflight: 1,
      capacity: 10,
    };
    // queryUserCredit must succeed for checkout to be reached
    ctx.vaultsTableId = '0xTABLE';
    (ctx.sui.getDynamicField as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('dynamic field not found'), { code: 'dynamicFieldNotFound' }),
    );
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({ txKindBytes, senderAddress: TEST_SENDER_ADDR });

    await expectPrepareError(ctx, params, makeExtraCfg(), 'NO_SPONSOR_SLOT');
    // In-flight handle must be released even on NO_SPONSOR_SLOT
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  // ── Release failure does not replace handler outcome ──────────────────

  it('release failure does not replace original domain error', async () => {
    const releaseFn = vi.fn().mockRejectedValue(new Error('Redis RELEASE failed'));
    const { ctx } = makeMockContext({ checkoutResult: null });
    ctx.prepareInflightLimiter = {
      tryAcquire: vi.fn().mockResolvedValue({ release: releaseFn }),
      inflight: 1,
      capacity: 10,
    };
    ctx.vaultsTableId = '0xTABLE';
    (ctx.sui.getDynamicField as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('dynamic field not found'), { code: 'dynamicFieldNotFound' }),
    );
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams({ txKindBytes, senderAddress: TEST_SENDER_ADDR });

    // Original error (NO_SPONSOR_SLOT) must be preserved, not replaced by release error
    await expectPrepareError(ctx, params, makeExtraCfg(), 'NO_SPONSOR_SLOT');
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });
});
