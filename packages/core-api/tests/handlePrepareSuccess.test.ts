/**
 * handlePrepare — success path tests.
 *
 * Uses vi.mock to replace runGenericPrepareBuildPipeline and queryUserCredit
 * so the handler orchestration logic (store binding, cost shape,
 * txBytesHash consistency) can be tested without on-chain calls.
 *
 * Separated from handlePrepare.test.ts (error-path tests) to keep
 * vi.mock isolation clean and module-level mock concerns contained.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { GAS_VARIANCE_FIXED_MIST, sha256Bytes } from '@stelis/core-relay';
import {
  SETTLE_MODULE,
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
  SLIPPAGE_CAP_BPS,
} from '@stelis/contracts';
import { PREPARE_TTL_MS } from '../src/handlers/prepare.js';
import { computePolicyHash } from '../src/policyHash.js';

// ─── Module mocks (vi.hoisted ensures availability inside vi.mock factory) ──

const { mockQueryUserCredit, mockPrepareBuildPipeline } = vi.hoisted(() => ({
  mockQueryUserCredit: vi.fn(),
  mockPrepareBuildPipeline: vi.fn(),
}));

vi.mock('@stelis/core-relay', async (importOriginal) => {
  const original = await importOriginal<typeof import('@stelis/core-relay')>();
  return {
    ...original,
    queryUserCredit: mockQueryUserCredit,
  };
});

vi.mock('../src/prepare/build.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/prepare/build.js')>();
  return {
    ...original,
    runGenericPrepareBuildPipeline: mockPrepareBuildPipeline,
  };
});

// Auto-mock extractSettleArgs to allow dynamic policyHash injection in beforeEach.
// This avoids hardcoded byte arrays that would silently break when constants change.
vi.mock('../src/prepare/extractSettleArgs.js');

// Mock Transaction.from to avoid BCS parse of fake txBytes
// Keep constructor functional (used by makeValidTxKindBytes)
vi.mock('@mysten/sui/transactions', async (importOriginal) => {
  const original = await importOriginal<typeof import('@mysten/sui/transactions')>();
  const OriginalTransaction = original.Transaction;

  class MockTransaction extends OriginalTransaction {
    static override from(_input: unknown): InstanceType<typeof OriginalTransaction> {
      return {
        getData: () => ({
          commands: [
            {
              $kind: 'MoveCall',
              MoveCall: {
                package: '0xPACKAGE',
                module: SETTLE_MODULE,
                function: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser,
                typeArguments: ['0xDEEP::deep::DEEP'],
                arguments: [],
              },
            },
          ],
          inputs: [],
        }),
      } as unknown as InstanceType<typeof OriginalTransaction>;
    }
  }

  return {
    ...original,
    Transaction: MockTransaction,
  };
});

// ─── Now import the handler and mocked modules ───────────────────────────────

import type { PrepareParams, PrepareHandlerConfig } from '../src/handlers/prepare.js';
import { handlePrepare } from '../src/handlers/prepare.js';
import { extractSettleArgsFromBuiltTx } from '../src/prepare/extractSettleArgs.js';
import { createStaticSettlementSwapPathDescriptorMap } from '@stelis/core-relay/server';
import { TEST_PREPARE_AUTH_SENDER, withPrepareAuthorization } from './prepareAuthTestHelpers.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Deterministic fake txBytes for assertions. */
const FAKE_TX_BYTES = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
const FAKE_TX_BYTES_HASH = '3cf654795a1c99c8e41f69aaeb3ad9e03f1b64cb14efb3b9b3b46be771e3a5b4'; // sha256 of FAKE_TX_BYTES — will be verified

const MOCK_BUILD_RESULT = {
  txBytes: FAKE_TX_BYTES,
  txBytesHash: FAKE_TX_BYTES_HASH,
  executionCostClaim: 1_800_000n, // simGas(1_300_000) + gasVariance(350K) + slippage(150K)
  simGas: 1_300_000n,
  gasVarianceFixedMist: 350_000n, // fixed gas variance buffer
  slippageBufferMist: 150_000n, // slippage buffer (for swap)
  grossGas: 1_500_000n,
  profile: 'new_user' as const,
  paymentInputSource: 'coin_object' as const,
  swapAmountSmallest: 500_000n,
};

const MOCK_PAYMENT_INPUT_TRACE = {
  settleVariantClass: 'new_user' as const,
  source: 'coin_object' as const,
  paymentCoinRefKind: 'nested_result' as const,
  producerCommandKind: 'SplitCoins' as const,
  settleSwapAmount: 500_000n,
  splitAmount: 500_000n,
};

const MOCK_CREDIT_RESULT = {
  vaultObjectId: null,
  credit: '0',
  needsCreate: true,
  lastNonce: '0',
};

const ONCHAIN_CONFIG = {
  packageId: '0xPACKAGE',
  configId: '0xCONFIG',
  maxClaimMist: 50_000_000n,
  minSettleMist: 0n,
  maxHostFeeMist: 500_000n,
  protocolFlatFeeMist: 10_000n,
  configVersion: 1n,
};

function makeMockContext() {
  return {
    network: 'testnet' as const,
    sui: {},
    sponsorPool: {
      checkout: vi.fn().mockResolvedValue({
        slotId: 'slot-42',
        sponsorAddress: '0xSPONSOR42',
      }),
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
    settlementPayoutRecipientAddress: '0xRELAYER',
    getConfig: vi.fn().mockResolvedValue(ONCHAIN_CONFIG),
    prepareInflightLimiter: {
      tryAcquire: vi.fn().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) }),
      inflight: 0,
      capacity: 10,
    },
  } as unknown as Parameters<typeof handlePrepare>[0];
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
    supportedSettlementSwapPaths,
    settlementSwapPathDescriptors: createStaticSettlementSwapPathDescriptorMap(
      supportedSettlementSwapPaths,
    ),
    allowedSettlementSwapPaths: [
      {
        tokenType: '0xDEEP::deep::DEEP',
        hops: ['0xPOOL'],
        settlementSwapDirection: 'baseForQuote' as const,
      },
    ],
    quotedHostFeeMist: 50_000n,
  };
}

async function makeValidTxKindBytes(): Promise<string> {
  const tx = new Transaction();
  // MakeMoveVec with pure value — no GasCoin reference, fully offline-buildable.
  tx.makeMoveVec({ elements: [tx.pure.u64(42)] });
  const kindBytes = await tx.build({ onlyTransactionKind: true });
  return toBase64(kindBytes);
}

async function makeParams(
  txKindBytes: string,
  overrides: Partial<Omit<PrepareParams, 'txKindBytes'>> = {},
): Promise<PrepareParams> {
  return withPrepareAuthorization({
    txKindBytes,
    senderAddress: TEST_PREPARE_AUTH_SENDER,
    settlementTokenType: '0xDEEP::deep::DEEP',
    clientIp: '127.0.0.1',
    ...overrides,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handlePrepare — success path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryUserCredit.mockResolvedValue(MOCK_CREDIT_RESULT);
    mockPrepareBuildPipeline.mockResolvedValue(MOCK_BUILD_RESULT);

    // Compute policyHash dynamically from ONCHAIN_CONFIG so that any change
    // to GAS_VARIANCE_FIXED_MIST / SLIPPAGE_CAP_BPS / PREPARE_TTL_MS / fees
    // is automatically reflected here — no hardcoded byte arrays.
    const policyHashHex = computePolicyHash({
      maxClaimMist: ONCHAIN_CONFIG.maxClaimMist,
      maxHostFeeMist: ONCHAIN_CONFIG.maxHostFeeMist,
      protocolFeeMist: ONCHAIN_CONFIG.protocolFlatFeeMist,
      quoteTtlMs: PREPARE_TTL_MS,
      gasVarianceFixedMist: GAS_VARIANCE_FIXED_MIST,
      slippageCapBps: SLIPPAGE_CAP_BPS,
    });
    const policyHashBytes = Uint8Array.from(Buffer.from(policyHashHex.replace('0x', ''), 'hex'));

    vi.mocked(extractSettleArgsFromBuiltTx).mockReturnValue({
      configObjectId: '0xCONFIG',
      registryObjectId: '0xREGISTRY',
      settlementPayoutRecipient: '0xRELAYER',
      executionCostClaim: 1_800_000n,
      policyHash: policyHashBytes,
      orderIdHash: new Uint8Array(0),
      quotedHostFeeMist: 50_000n,
      expectedProtocolFeeMist: ONCHAIN_CONFIG.protocolFlatFeeMist,
      expectedConfigVersion: ONCHAIN_CONFIG.configVersion,
      paymentInputTrace: MOCK_PAYMENT_INPUT_TRACE,
      slippageBufferMist: MOCK_BUILD_RESULT.slippageBufferMist,
      extractedSettlementSwapPath: {
        tokenType: '0xDEEP::deep::DEEP',
        hops: ['0xPOOL'],
        settlementSwapDirection: 'baseForQuote',
      },
    });
  });

  it('returns correct cost breakdown with all fee components', async () => {
    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams(txKindBytes, { clientIp: '10.0.0.1' });

    const result = await handlePrepare(ctx, params, makeExtraCfg());

    // Cost breakdown must include all fee components
    expect(result.cost).toEqual({
      simGas: '1300000',
      gasVarianceFixedMist: '350000',
      slippageBufferMist: '150000',
      quotedHostFee: '50000',
      protocolFee: '10000',
      executionCostClaim: '1800000',
      grossGas: '1500000',
    });
  });

  it('stores correct values in prepareStore', async () => {
    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams(txKindBytes, { clientIp: '192.168.1.1' });

    const result = await handlePrepare(ctx, params, makeExtraCfg());

    // prepareStore.store should have been called exactly once
    expect(ctx.prepareStore.store).toHaveBeenCalledTimes(1);

    const [storedKey, storedEntry] = (ctx.prepareStore.store as ReturnType<typeof vi.fn>).mock
      .calls[0];

    // Key = receiptId (hex)
    expect(storedKey).toBe(result.receiptId);

    // Coordination fields persisted.
    expect(storedEntry.receiptId).toBe(result.receiptId);
    expect(storedEntry.senderAddress).toBe(TEST_PREPARE_AUTH_SENDER);
    expect(storedEntry.txBytesHash).toBe(FAKE_TX_BYTES_HASH);
    expect(storedEntry.slotId).toBe('slot-42');
    expect(storedEntry.sponsorAddress).toBe('0xSPONSOR42');
    expect(storedEntry.clientIp).toBe('192.168.1.1');
    expect(storedEntry.mode).toBe('generic');

    // Settle / observability copies are not persisted. Sponsor reads
    // every settle value from `parseSettleArgs(txBytes)` — store copies
    // would invite drift bugs without adding authority. GenericPrepareBuildOutput-only
    // fields are also never persisted.
    expect(storedEntry).not.toHaveProperty('executionCostClaim');
    expect(storedEntry).not.toHaveProperty('simGas');
    expect(storedEntry).not.toHaveProperty('gasVarianceFixedMist');
    expect(storedEntry).not.toHaveProperty('slippageBufferMist');
    expect(storedEntry).not.toHaveProperty('grossGas');
    expect(storedEntry).not.toHaveProperty('profile');
    expect(storedEntry).not.toHaveProperty('quoteTimestampMs');
    expect(storedEntry).not.toHaveProperty('policyHash');
    expect(storedEntry).not.toHaveProperty('quotedHostFeeMist');
    expect(storedEntry).not.toHaveProperty('paymentInputSource');
  });

  it('txBytesHash in store matches response txBytes hash', async () => {
    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams(txKindBytes);

    const result = await handlePrepare(ctx, params, makeExtraCfg());

    // Store entry must have same txBytesHash as what runGenericPrepareBuildPipeline returned
    const [, storedEntry] = (ctx.prepareStore.store as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(storedEntry.txBytesHash).toBe(FAKE_TX_BYTES_HASH);

    // Response txBytes must be base64 of the same bytes fed to hash
    expect(result.txBytes).toBe(toBase64(FAKE_TX_BYTES));
  });

  it('response includes profile, quoteTimestampMs, policyHash', async () => {
    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams(txKindBytes);

    const result = await handlePrepare(ctx, params, makeExtraCfg());

    expect(result.profile).toBe('new_user');
    expect(typeof result.quoteTimestampMs).toBe('number');
    expect(result.quoteTimestampMs).toBeGreaterThan(0);
    // policyHash is 0x-prefixed hex (64 hex chars = 32 bytes SHA-256)
    expect(result.policyHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('passes correct profile to runGenericPrepareBuildPipeline for new_user', async () => {
    mockQueryUserCredit.mockResolvedValue({
      vaultObjectId: null,
      credit: '0',
      needsCreate: true,
      lastNonce: '0',
    });

    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams(txKindBytes);

    await handlePrepare(ctx, params, makeExtraCfg());

    // runGenericPrepareBuildPipeline should receive settleProfile='new_user'
    const [, buildInput] = mockPrepareBuildPipeline.mock.calls[0];
    expect(buildInput.profile).toBe('new_user');
    expect(buildInput.vaultObjectId).toBeNull();
  });

  it('passes correct profile to runGenericPrepareBuildPipeline for credit_general', async () => {
    mockQueryUserCredit.mockResolvedValue({
      vaultObjectId: '0xVAULT_123',
      credit: '5000000',
      needsCreate: false,
      lastNonce: '0',
    });
    mockPrepareBuildPipeline.mockResolvedValue({
      ...MOCK_BUILD_RESULT,
      profile: 'credit_general',
    });

    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams(txKindBytes);

    const result = await handlePrepare(ctx, params, makeExtraCfg());

    // runGenericPrepareBuildPipeline should receive settleProfile='credit_general'
    const [, buildInput] = mockPrepareBuildPipeline.mock.calls[0];
    expect(buildInput.profile).toBe('credit_general');
    expect(buildInput.vaultObjectId).toBe('0xVAULT_123');
    expect(buildInput.credit).toBe('5000000');

    expect(result.profile).toBe('credit_general');
  });

  // ── orderId echo ─────────────────────────────────────────────────────

  it('echoes orderId in response when provided', async () => {
    // Re-setup extractSettleArgs mock with orderIdHash matching the orderId
    const policyHashHex = computePolicyHash({
      maxClaimMist: ONCHAIN_CONFIG.maxClaimMist,
      maxHostFeeMist: ONCHAIN_CONFIG.maxHostFeeMist,
      protocolFeeMist: ONCHAIN_CONFIG.protocolFlatFeeMist,
      quoteTtlMs: PREPARE_TTL_MS,
      gasVarianceFixedMist: GAS_VARIANCE_FIXED_MIST,
      slippageCapBps: SLIPPAGE_CAP_BPS,
    });
    const policyHashBytes = Uint8Array.from(Buffer.from(policyHashHex.replace('0x', ''), 'hex'));
    const orderIdHash = await sha256Bytes(new TextEncoder().encode('test-order-123'));
    vi.mocked(extractSettleArgsFromBuiltTx).mockReturnValue({
      configObjectId: '0xCONFIG',
      registryObjectId: '0xREGISTRY',
      settlementPayoutRecipient: '0xRELAYER',
      executionCostClaim: 1_800_000n,
      policyHash: policyHashBytes,
      orderIdHash,
      quotedHostFeeMist: 50_000n,
      expectedProtocolFeeMist: ONCHAIN_CONFIG.protocolFlatFeeMist,
      expectedConfigVersion: ONCHAIN_CONFIG.configVersion,
      paymentInputTrace: MOCK_PAYMENT_INPUT_TRACE,
      slippageBufferMist: MOCK_BUILD_RESULT.slippageBufferMist,
      extractedSettlementSwapPath: {
        tokenType: '0xDEEP::deep::DEEP',
        hops: ['0xPOOL'],
        settlementSwapDirection: 'baseForQuote',
      },
    });

    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams(txKindBytes, { orderId: 'test-order-123' });

    const result = await handlePrepare(ctx, params, makeExtraCfg());
    expect(result.orderId).toBe('test-order-123');
  });

  it('response does not include orderId when not provided', async () => {
    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams(txKindBytes);

    const result = await handlePrepare(ctx, params, makeExtraCfg());
    expect(result.orderId).toBeUndefined();
  });

  it('stores orderId in PreparedTxEntry', async () => {
    // Re-setup extractSettleArgs mock with orderIdHash matching the orderId
    const policyHashHex = computePolicyHash({
      maxClaimMist: ONCHAIN_CONFIG.maxClaimMist,
      maxHostFeeMist: ONCHAIN_CONFIG.maxHostFeeMist,
      protocolFeeMist: ONCHAIN_CONFIG.protocolFlatFeeMist,
      quoteTtlMs: PREPARE_TTL_MS,
      gasVarianceFixedMist: GAS_VARIANCE_FIXED_MIST,
      slippageCapBps: SLIPPAGE_CAP_BPS,
    });
    const policyHashBytes = Uint8Array.from(Buffer.from(policyHashHex.replace('0x', ''), 'hex'));
    const orderIdHash = await sha256Bytes(new TextEncoder().encode('store-test-order'));
    vi.mocked(extractSettleArgsFromBuiltTx).mockReturnValue({
      configObjectId: '0xCONFIG',
      registryObjectId: '0xREGISTRY',
      settlementPayoutRecipient: '0xRELAYER',
      executionCostClaim: 1_800_000n,
      policyHash: policyHashBytes,
      orderIdHash,
      quotedHostFeeMist: 50_000n,
      expectedProtocolFeeMist: ONCHAIN_CONFIG.protocolFlatFeeMist,
      expectedConfigVersion: ONCHAIN_CONFIG.configVersion,
      paymentInputTrace: MOCK_PAYMENT_INPUT_TRACE,
      slippageBufferMist: MOCK_BUILD_RESULT.slippageBufferMist,
      extractedSettlementSwapPath: {
        tokenType: '0xDEEP::deep::DEEP',
        hops: ['0xPOOL'],
        settlementSwapDirection: 'baseForQuote',
      },
    });

    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams(txKindBytes, { orderId: 'store-test-order' });

    await handlePrepare(ctx, params, makeExtraCfg());

    const [, storedEntry] = (ctx.prepareStore.store as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(storedEntry.orderId).toBe('store-test-order');
  });

  it('stores orderId as null when not provided', async () => {
    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams(txKindBytes);

    await handlePrepare(ctx, params, makeExtraCfg());

    const [, storedEntry] = (ctx.prepareStore.store as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(storedEntry.orderId).toBeNull();
  });

  it('rejects before store when payment-input trace mismatches the selected source', async () => {
    vi.mocked(extractSettleArgsFromBuiltTx).mockReturnValue({
      configObjectId: '0xCONFIG',
      registryObjectId: '0xREGISTRY',
      settlementPayoutRecipient: '0xRELAYER',
      executionCostClaim: 1_800_000n,
      policyHash: new Uint8Array(32).fill(0x11),
      orderIdHash: new Uint8Array(0),
      quotedHostFeeMist: 50_000n,
      expectedProtocolFeeMist: ONCHAIN_CONFIG.protocolFlatFeeMist,
      expectedConfigVersion: ONCHAIN_CONFIG.configVersion,
      paymentInputTrace: {
        settleVariantClass: 'new_user',
        source: 'address_balance',
        paymentCoinRefKind: 'nested_result',
        producerCommandKind: 'MoveCall',
        settleSwapAmount: MOCK_BUILD_RESULT.swapAmountSmallest,
        withdrawalAmount: MOCK_BUILD_RESULT.swapAmountSmallest,
      },
    });

    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();

    await expect(
      handlePrepare(ctx, await makeParams(txKindBytes), makeExtraCfg()),
    ).rejects.toMatchObject({
      code: 'L2_EXTRACT_FAILED',
      meta: { subcode: 'payment_input_source_mismatch' },
    });

    expect(ctx.prepareStore.store).not.toHaveBeenCalled();
  });

  // ── Lease commit error mapping (handler adapter invariant) ──────────────
  // `SponsorLeaseCommitError` thrown by `sponsorPool.commit()` (called via
  // the prepare runner) MUST be re-mapped by the handler to
  // `PrepareValidationError('SPONSOR_LEASE_COMMIT_FAILED')` with statusHint=500.
  // The runner owns cleanup, and the handler adapter owns the route-specific
  // domain error classification.
  it('maps SponsorLeaseCommitError → SPONSOR_LEASE_COMMIT_FAILED at handler boundary, releases all runner resources', async () => {
    const { SponsorLeaseCommitError } = await import('../src/store/sponsorLeaseProof.js');
    const { PrepareValidationError } = await import('../src/prepare/replay.js');

    const ctx = makeMockContext();
    const inflightRelease = vi.fn().mockResolvedValue(undefined);
    (ctx.prepareInflightLimiter.tryAcquire as ReturnType<typeof vi.fn>).mockResolvedValue({
      release: inflightRelease,
    });
    // Force the lease-commit step to throw the typed error the handler must
    // re-map. Any non-SponsorLeaseCommitError throw should propagate as-is —
    // covered indirectly by the existing scope ordering tests.
    (ctx.sponsorPool.commit as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SponsorLeaseCommitError('CAS_MISMATCH', 'lease was not in reserved stage'),
    );

    const txKindBytes = await makeValidTxKindBytes();

    let caught: unknown;
    try {
      await handlePrepare(ctx, await makeParams(txKindBytes), makeExtraCfg());
      expect.unreachable('Expected SPONSOR_LEASE_COMMIT_FAILED');
    } catch (err) {
      caught = err;
    }

    // Mapping invariant: typed lease error → PrepareValidationError(500).
    expect(caught).toBeInstanceOf(PrepareValidationError);
    expect((caught as PrepareValidationError).code).toBe('SPONSOR_LEASE_COMMIT_FAILED');
    expect((caught as PrepareValidationError).statusHint).toBe(500);
    expect((caught as PrepareValidationError).message).toContain('lease was not in reserved stage');

    // Scope cleanup invariant: nonce reservation must be released, slot
    // checked back in (reserved stage — commit failed before promotion to
    // committed), and inflight handle dropped. Order:
    // reservation → slot checkin → inflight release.
    expect(ctx.prepareStore.releaseReservation).toHaveBeenCalledWith(
      expect.stringMatching(/^0x[0-9a-f]{64}$/),
      TEST_PREPARE_AUTH_SENDER,
    );
    expect(ctx.sponsorPool.checkin).toHaveBeenCalledWith(
      'slot-42',
      expect.stringMatching(/^0x[0-9a-f]{64}$/),
      null, // commit failed → lease still in reserved stage
    );
    expect(inflightRelease).toHaveBeenCalledTimes(1);

    // Store must NOT receive the entry — commit failure must abort before
    // the prepared entry is persisted.
    expect(ctx.prepareStore.store).not.toHaveBeenCalled();
  });
});
