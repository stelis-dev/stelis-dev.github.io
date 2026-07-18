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
 *   - use window expiry
 *   - successful flow (simulate → sign → execute → consume)
 */
import { beforeEach, describe, test, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalizePromotionTarget } from '../src/studio/promotionTargetPolicy.js';
import {
  handlePromotionSponsor,
  PromotionSponsorError,
  type PromotionSponsorContext,
} from '../src/studio/sponsorPromotionSponsoredHandler.js';
import { SponsorLeaseExpiredError } from '../src/handlers/sponsor.js';
import { MemoryPromotionExecutionLedger } from '../src/studio/executionLedgerMemory.js';
import { MemoryPromotionStore } from '../src/studio/promotionStore.js';
import { MemorySponsoredExecutionStore } from '../src/store/memorySponsoredExecutionStore.js';
import { MemoryAbuseBlocker } from '../src/store/memoryAbuseBlocker.js';
import { SponsorPool } from '../src/context.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { toBase64, toHex } from '@mysten/sui/utils';
import { SUI_CHAIN_IDENTIFIERS } from '@stelis/contracts';
import type { SuiEndpointSnapshot, SuiExecutionError } from '@stelis/core-relay';
import type { ChainBoundSuiEndpointSnapshot } from '@stelis/core-relay';
import type { PromotionPreparedTxDraft } from '../src/store/prepareTypes.js';
import type { VerifiedDeveloperIdentity } from '../src/studio/developerJwtVerifier.js';
import type { SponsorResultMetadata } from '../src/handlers/sponsorResult.js';
import {
  bindSuiResultToTransactionBytes,
  congestedSuiExecutionError,
  moveAbortSuiExecutionError,
  suiExecutionFailure,
  suiExecutionSuccess,
  suiSimulationFailure,
  suiSimulationSuccess,
  TEST_SUI_TRANSACTION_DIGEST,
  suiEndpointSnapshotFixture,
  unclassifiedSuiExecutionError,
} from './helpers/suiGatewayResultFixtures.js';

const { executeSuiTransactionMock, simulateSuiTransactionMock } = vi.hoisted(() => ({
  executeSuiTransactionMock: vi.fn(),
  simulateSuiTransactionMock: vi.fn(),
}));

vi.mock('@stelis/core-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stelis/core-relay')>()),
  executeSuiTransaction: executeSuiTransactionMock,
  simulateSuiTransaction: simulateSuiTransactionMock,
}));

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const TEST_PROMO_ID = '00000000-0000-4000-8000-000000000301';
const TEST_USER_ID = 'sponsor-user-1';
const PER_USER_ALLOWANCE = '100000000'; // 0.1 SUI
const ALLOWED_TARGET =
  '0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin';
const GLOBAL_ALLOWED_TARGETS = new Set([canonicalizePromotionTarget(ALLOWED_TARGET)]);
const TEST_DEEPBOOK_PACKAGE_ID = '0xdef';

// Fixed test keypairs
const SPONSOR_KP = Ed25519Keypair.generate();
const USER_KP = Ed25519Keypair.generate();
const USER_ADDR = USER_KP.toSuiAddress();
const suiDigest = (txBytes: Uint8Array): string =>
  TransactionDataBuilder.getDigestFromBytes(txBytes);
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
  tx.setGasPayment([]);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: '1',
      maxEpoch: '2',
      minTimestamp: null,
      maxTimestamp: null,
      chain: SUI_CHAIN_IDENTIFIERS.testnet,
      nonce: 0,
    },
  });

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

interface MockSuiOptions {
  simulationError?: SuiExecutionError;
  executionError?: SuiExecutionError;
  submitThrows?: boolean;
  submitThrowMessage?: string;
}

type SetupOptions = MockSuiOptions;

const mockSuiOptions = new WeakMap<object, MockSuiOptions>();

function gasUsedFor() {
  return { computationCost: '1000000', storageCost: '500000', storageRebate: '200000' };
}

simulateSuiTransactionMock.mockImplementation(
  async (snapshot: SuiEndpointSnapshot, _input: { transaction: Uint8Array }) => {
    const opts = mockSuiOptions.get(snapshot) ?? {};
    const result = opts.simulationError
      ? suiSimulationFailure(opts.simulationError, gasUsedFor())
      : suiSimulationSuccess(gasUsedFor());
    return result;
  },
);

executeSuiTransactionMock.mockImplementation(
  async (snapshot: SuiEndpointSnapshot, input: { transaction: Uint8Array }) => {
    const opts = mockSuiOptions.get(snapshot) ?? {};
    if (opts.submitThrows) {
      throw new Error(opts.submitThrowMessage ?? 'rpc transport error');
    }
    const result = opts.executionError
      ? suiExecutionFailure(TEST_SUI_TRANSACTION_DIGEST, opts.executionError, gasUsedFor())
      : suiExecutionSuccess(TEST_SUI_TRANSACTION_DIGEST, gasUsedFor());
    return bindSuiResultToTransactionBytes(result, input.transaction);
  },
);

function createMockSui(opts: MockSuiOptions = {}): ChainBoundSuiEndpointSnapshot {
  const snapshot = suiEndpointSnapshotFixture();
  mockSuiOptions.set(snapshot, opts);
  return snapshot;
}

// ─────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────

async function setup(opts: SetupOptions = {}) {
  class FixedPromotionStore extends MemoryPromotionStore {
    protected override generateId(): string {
      return TEST_PROMO_ID;
    }
  }
  const promotionStore = new FixedPromotionStore();
  const promotion = await promotionStore.create({
    type: 'gas_sponsorship',
    displayName: 'Test Promo',
    maxParticipants: 100,
    perUserGasAllowanceMist: PER_USER_ALLOWANCE,
  });
  await promotionStore.transitionStatus(promotion.promotionId, 'active');
  const executionLedger = new MemoryPromotionExecutionLedger(promotionStore);
  const sponsorPool = new SponsorPool([SPONSOR_KP], { hmacSecret: TEST_HMAC_SECRET });
  const sponsoredExecutionStore = new MemorySponsoredExecutionStore(sponsorPool, executionLedger);
  const abuseBlocker = new MemoryAbuseBlocker();

  // Claim promotion (creates entitlement via ExecutionLedger)
  await executionLedger.claim(TEST_PROMO_ID, TEST_USER_ID, {
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

  // Reserve via executionLedger
  const reserveResult = await executionLedger.reserve({
    promotionId: TEST_PROMO_ID,
    userId: TEST_USER_ID,
    receiptId,
    amountMist: 2_000_000n,
  });
  if (!reserveResult.ok) throw new Error(`Reserve failed: ${reserveResult.reason}`);

  // Commit the prepared receipt and sponsor lease as one store mutation.
  const entry: PromotionPreparedTxDraft = {
    receiptId,
    reservedGasMist: 2_000_000n, // simGas + GAS_VARIANCE_FIXED_MIST
    txBytesHash: signed.txHash,
    senderAddress: USER_ADDR,
    sponsorAddress: slot.sponsorAddress,
    clientIp: '127.0.0.1',
    executionPathKey: `promotion:${TEST_PROMO_ID}`,
    orderId: null,
    mode: 'promotion',
    promotionId: TEST_PROMO_ID,
    userId: TEST_USER_ID,
  };
  await sponsoredExecutionStore.commitPreparedReceipt(entry);

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
    sponsoredExecutionStore,
    abuseBlocker,
    globalAllowedTargets: GLOBAL_ALLOWED_TARGETS,
    onSponsorResult: async () => {},
    isSponsorAddressAvailable: async () => true,
  };

  return {
    ctx,
    signed,
    receiptId,
    executionLedger,
    sponsorPool,
    sponsoredExecutionStore,
    promotionStore,
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('handlePromotionSponsor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sponsor = async (
    fixture: Awaited<ReturnType<typeof setup>>,
    overrides: Partial<Parameters<typeof handlePromotionSponsor>[1]> = {},
  ) =>
    handlePromotionSponsor(fixture.ctx, {
      promotionId: TEST_PROMO_ID,
      receiptId: fixture.receiptId,
      txBytes: fixture.signed.txBytesBase64,
      userSignature: fixture.signed.userSignature,
      verifiedIdentity: buildIdentity(),
      clientIp: '127.0.0.1',
      ...overrides,
    });

  test('preserves the prepared receipt and reservation when the path promotion does not match', async () => {
    const fixture = await setup();

    const error = await sponsor(fixture, { promotionId: 'wrong-promotion' }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(PromotionSponsorError);
    expect((error as PromotionSponsorError).code).toBe('PROMOTION_ID_MISMATCH');
    expect(
      await fixture.sponsoredExecutionStore.readPreparedReceipt(fixture.receiptId),
    ).not.toBeNull();
    expect(
      (await fixture.executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID))
        ?.activeReservationReceiptId,
    ).toBe(fixture.receiptId);
    expect((await fixture.sponsorPool.leaseStatus()).leasedSlots).toBe(1);
  });

  test('preserves the legitimate session when verified sender identity is wrong', async () => {
    const fixture = await setup();
    const otherAddress = Ed25519Keypair.generate().toSuiAddress();

    const error = await sponsor(fixture, {
      verifiedIdentity: buildIdentity({ senderAddress: otherAddress }),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PromotionSponsorError);
    expect((error as PromotionSponsorError).code).toBe('SENDER_ADDRESS_MISMATCH');
    expect(
      await fixture.sponsoredExecutionStore.readPreparedReceipt(fixture.receiptId),
    ).not.toBeNull();
    expect(
      (await fixture.executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID))
        ?.activeReservationReceiptId,
    ).toBe(fixture.receiptId);
  });

  test('preserves the legitimate session when the MoveCall target is not allowed', async () => {
    const fixture = await setup();
    fixture.ctx.globalAllowedTargets = new Set();

    const error = await sponsor(fixture).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PromotionSponsorError);
    expect((error as PromotionSponsorError).code).toBe('DISALLOWED_TARGET');
    expect(
      await fixture.sponsoredExecutionStore.readPreparedReceipt(fixture.receiptId),
    ).not.toBeNull();
    expect(
      (await fixture.executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID))
        ?.activeReservationReceiptId,
    ).toBe(fixture.receiptId);
  });

  test('preserves the legitimate session when the sender signature is invalid', async () => {
    const fixture = await setup();
    const attackerSignature = await Ed25519Keypair.generate().signTransaction(
      fixture.signed.txBytes,
    );

    const error = await sponsor(fixture, {
      userSignature: attackerSignature.signature,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PromotionSponsorError);
    expect((error as PromotionSponsorError).code).toBe('SENDER_SIGNATURE_INVALID');
    expect(
      await fixture.sponsoredExecutionStore.readPreparedReceipt(fixture.receiptId),
    ).not.toBeNull();
    expect(
      (await fixture.executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID))
        ?.activeReservationReceiptId,
    ).toBe(fixture.receiptId);
  });

  test('atomically releases the reservation when preflight rejects before sponsor signing', async () => {
    const fixture = await setup({ simulationError: unclassifiedSuiExecutionError() });
    const signSpy = vi.spyOn(fixture.sponsorPool, 'sign');

    const error = await sponsor(fixture).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PromotionSponsorError);
    expect((error as PromotionSponsorError).code).toBe('PREFLIGHT_FAILED');
    expect(signSpy).not.toHaveBeenCalled();
    expect(await fixture.sponsoredExecutionStore.readPreparedReceipt(fixture.receiptId)).toBeNull();
    const entitlement = await fixture.executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(entitlement?.activeReservationReceiptId).toBeNull();
    expect(entitlement?.consumedGasAllowanceMist).toBe('0');
    expect((await fixture.sponsorPool.leaseStatus()).leasedSlots).toBe(0);
  });

  test('uses one decoded transaction object through simulation, sponsor signing, and submission', async () => {
    const fixture = await setup();
    const callbacks: SponsorResultMetadata[] = [];
    fixture.ctx.onSponsorResult = async (result) => {
      callbacks.push(result);
    };
    const signSpy = vi.spyOn(fixture.sponsorPool, 'sign');

    const result = await sponsor(fixture);

    const signedBytes = signSpy.mock.calls[0]?.[2];
    expect(signedBytes).toBeInstanceOf(Uint8Array);
    expect(simulateSuiTransactionMock.mock.calls[0]?.[1]?.transaction).toBe(signedBytes);
    expect(executeSuiTransactionMock.mock.calls[0]?.[1]?.transaction).toBe(signedBytes);
    expect(result).toEqual({
      digest: suiDigest(fixture.signed.txBytes),
      effects: expect.anything(),
      actualGasMist: '1300000',
    });
    const entitlement = await fixture.executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(entitlement?.activeReservationReceiptId).toBeNull();
    expect(entitlement?.consumedGasAllowanceMist).toBe('1300000');
    expect(callbacks[0]).toMatchObject({
      route: 'promotion',
      outcome: 'success',
      receiptId: fixture.receiptId,
      digest: suiDigest(fixture.signed.txBytes),
    });
    expect((await fixture.sponsorPool.leaseStatus()).leasedSlots).toBe(0);
  });

  test('consumes actual gas and preserves the on-chain revert classification', async () => {
    const fixture = await setup({
      executionError: moveAbortSuiExecutionError({ abortCode: '7' }),
    });
    const callbacks: SponsorResultMetadata[] = [];
    fixture.ctx.onSponsorResult = async (result) => {
      callbacks.push(result);
    };

    const error = await sponsor(fixture).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PromotionSponsorError);
    expect((error as PromotionSponsorError).code).toBe('ONCHAIN_REVERT');
    expect((error as PromotionSponsorError).meta).toMatchObject({
      digest: suiDigest(fixture.signed.txBytes),
      gasUsed: {
        computationCost: '1000000',
        storageCost: '500000',
        storageRebate: '200000',
        nonRefundableStorageFee: '0',
      },
    });
    const entitlement = await fixture.executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(entitlement?.activeReservationReceiptId).toBeNull();
    expect(entitlement?.consumedGasAllowanceMist).toBe('1300000');
    expect(callbacks[0]).toMatchObject({
      route: 'promotion',
      outcome: 'onchain_revert',
      executionStage: 'on_chain',
    });
  });

  test('releases the Promotion reservation on validated congestion without recording abuse', async () => {
    const fixture = await setup({ executionError: congestedSuiExecutionError() });
    const recordFailureSpy = vi.spyOn(fixture.ctx.abuseBlocker, 'recordSponsorFailure');

    const error = await sponsor(fixture).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PromotionSponsorError);
    expect((error as PromotionSponsorError).code).toBe('SPONSOR_CONGESTION');
    expect(recordFailureSpy).not.toHaveBeenCalled();
    const entitlement = await fixture.executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(entitlement?.activeReservationReceiptId).toBeNull();
    expect(entitlement?.consumedGasAllowanceMist).toBe('0');
    expect((await fixture.sponsorPool.leaseStatus()).leasedSlots).toBe(0);
  });

  test('keeps the receipt executing and reserved when submission is uncertain', async () => {
    const fixture = await setup({
      submitThrows: true,
      submitThrowMessage: 'rpc transport disconnected after submit',
    });
    const callbacks: SponsorResultMetadata[] = [];
    fixture.ctx.onSponsorResult = async (result) => {
      callbacks.push(result);
    };

    const error = await sponsor(fixture).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PromotionSponsorError);
    expect((error as PromotionSponsorError).code).toBe('SPONSOR_SUBMISSION_UNCERTAIN');
    expect((error as PromotionSponsorError).meta.digest).toBe(suiDigest(fixture.signed.txBytes));
    expect(await fixture.sponsoredExecutionStore.readPreparedReceipt(fixture.receiptId)).toBeNull();
    const entitlement = await fixture.executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(entitlement?.activeReservationReceiptId).toBe(fixture.receiptId);
    expect(entitlement?.consumedGasAllowanceMist).toBe('0');
    expect((await fixture.sponsorPool.leaseStatus()).leasedSlots).toBe(1);
    expect(callbacks).toEqual([]);
  });

  test('a pre-sign lease failure releases the execution without becoming submission uncertainty', async () => {
    const fixture = await setup();
    vi.spyOn(fixture.sponsorPool, 'sign').mockRejectedValue(
      new SponsorLeaseExpiredError(SPONSOR_KP.toSuiAddress()),
    );

    const error = await sponsor(fixture).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PromotionSponsorError);
    expect((error as PromotionSponsorError).code).toBe('LEASE_EXPIRED');
    expect((error as PromotionSponsorError).code).not.toBe('SPONSOR_SUBMISSION_UNCERTAIN');
    expect(executeSuiTransactionMock).not.toHaveBeenCalled();
    const entitlement = await fixture.executionLedger.getEntitlement(TEST_PROMO_ID, TEST_USER_ID);
    expect(entitlement?.activeReservationReceiptId).toBeNull();
    expect(entitlement?.consumedGasAllowanceMist).toBe('0');
    expect((await fixture.sponsorPool.leaseStatus()).leasedSlots).toBe(0);
  });
});
