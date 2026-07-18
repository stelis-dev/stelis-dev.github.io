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
import { PREPARE_TTL_MS } from '../src/preparePolicy.js';
import { computePolicyHash } from '../src/policyHash.js';

// ─── Module mocks (vi.hoisted ensures availability inside vi.mock factory) ──

const {
  mockQueryUserCredit,
  mockPrepareBuildPipeline,
  PACKAGE_ID,
  CONFIG_ID,
  REGISTRY_ID,
  PAYOUT_ADDRESS,
  SPONSOR_ADDRESS,
  DEEPBOOK_PACKAGE_ID,
  SETTLEMENT_TOKEN_TYPE,
  POOL_ID,
  VAULT_ID,
  addressBalanceGasTransactionContents,
  getAddressBalanceGasTransactionBytesMock,
  getAddressBalanceGasTransactionTxBytesHashMock,
} = vi.hoisted(() => ({
  mockQueryUserCredit: vi.fn(),
  mockPrepareBuildPipeline: vi.fn(),
  PACKAGE_ID: `0x${'11'.repeat(32)}`,
  CONFIG_ID: `0x${'22'.repeat(32)}`,
  REGISTRY_ID: `0x${'33'.repeat(32)}`,
  PAYOUT_ADDRESS: `0x${'44'.repeat(32)}`,
  SPONSOR_ADDRESS: `0x${'55'.repeat(32)}`,
  DEEPBOOK_PACKAGE_ID: `0x${'66'.repeat(32)}`,
  SETTLEMENT_TOKEN_TYPE: `0x${'77'.repeat(32)}::deep::DEEP`,
  POOL_ID: `0x${'88'.repeat(32)}`,
  VAULT_ID: `0x${'99'.repeat(32)}`,
  addressBalanceGasTransactionContents: new WeakMap<
    object,
    { readonly bytes: Uint8Array; readonly txBytesHash: string }
  >(),
  getAddressBalanceGasTransactionBytesMock: vi.fn(),
  getAddressBalanceGasTransactionTxBytesHashMock: vi.fn(),
}));

vi.mock('@stelis/core-relay/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stelis/core-relay/server')>()),
  getAddressBalanceGasTransactionBytes: getAddressBalanceGasTransactionBytesMock,
  getAddressBalanceGasTransactionTxBytesHash: getAddressBalanceGasTransactionTxBytesHashMock,
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
                package: PACKAGE_ID,
                module: SETTLE_MODULE,
                function: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser,
                typeArguments: [SETTLEMENT_TOKEN_TYPE],
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
import type { ExtractedSettleArgs } from '../src/prepare/extractSettleArgs.js';
import {
  createStaticSettlementSwapPathDescriptorMap,
  type AddressBalanceGasTransaction,
} from '@stelis/core-relay/server';
import type { PreparedTxDraft } from '../src/store/prepareTypes.js';
import { TEST_PREPARE_AUTH_SENDER, withPrepareAuthorization } from './prepareAuthTestHelpers.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Deterministic fake txBytes for assertions. */
const FAKE_TX_BYTES = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
const FAKE_TX_BYTES_HASH = '3cf654795a1c99c8e41f69aaeb3ad9e03f1b64cb14efb3b9b3b46be771e3a5b4'; // sha256 of FAKE_TX_BYTES — will be verified

function addressBalanceGasTransactionFixture(
  bytes: Uint8Array,
  txBytesHash: string,
): AddressBalanceGasTransaction {
  const transaction = Object.freeze({}) as AddressBalanceGasTransaction;
  addressBalanceGasTransactionContents.set(transaction, { bytes: bytes.slice(), txBytesHash });
  return transaction;
}

getAddressBalanceGasTransactionBytesMock.mockImplementation(
  (transaction: AddressBalanceGasTransaction) => {
    const contents = addressBalanceGasTransactionContents.get(transaction);
    if (!contents) throw new TypeError('test transaction was not created by its fixture');
    return contents.bytes.slice();
  },
);
getAddressBalanceGasTransactionTxBytesHashMock.mockImplementation(
  (transaction: AddressBalanceGasTransaction) => {
    const contents = addressBalanceGasTransactionContents.get(transaction);
    if (!contents) throw new TypeError('test transaction was not created by its fixture');
    return contents.txBytesHash;
  },
);

const FAKE_ADDRESS_BALANCE_GAS_TRANSACTION = addressBalanceGasTransactionFixture(
  FAKE_TX_BYTES,
  FAKE_TX_BYTES_HASH,
);

const MOCK_BUILD_RESULT = {
  addressBalanceGasTransaction: FAKE_ADDRESS_BALANCE_GAS_TRANSACTION,
  l1Validation: { ok: true } as const,
  settleArgs: null as ExtractedSettleArgs | null,
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
  splitCommandIndex: 0,
  baseInputIndex: 0,
  baseCoinObjectId: `0x${'11'.repeat(32)}`,
  directMergeSources: [],
  unsupportedMergeSources: [],
  fundingInputUses: [{ commandIndex: 0, inputIndex: 0, occurrences: 1 }],
  senderWithdrawals: [],
  senderRedeems: [],
};

const MOCK_CREDIT_RESULT = {
  vaultObjectId: null,
  credit: '0',
  needsCreate: true,
  lastNonce: '0',
};

const ONCHAIN_CONFIG = {
  packageId: PACKAGE_ID,
  configId: CONFIG_ID,
  maxClaimMist: 50_000_000n,
  minSettleMist: 0n,
  maxHostFeeMist: 500_000n,
  protocolFlatFeeMist: 10_000n,
  configVersion: 1n,
};

function makeExtractedSettleArgs(
  overrides: Partial<ExtractedSettleArgs> = {},
): ExtractedSettleArgs {
  return {
    configObjectId: CONFIG_ID,
    registryObjectId: REGISTRY_ID,
    settlementPayoutRecipient: PAYOUT_ADDRESS,
    executionCostClaim: 1_800_000n,
    policyHash: new Uint8Array(32),
    orderIdHash: new Uint8Array(0),
    nonce: 1n,
    receiptId: new Uint8Array(32),
    simGasReported: MOCK_BUILD_RESULT.simGas,
    gasVarianceFixedMist: MOCK_BUILD_RESULT.gasVarianceFixedMist,
    slippageBufferMist: MOCK_BUILD_RESULT.slippageBufferMist,
    quotedHostFeeMist: 50_000n,
    expectedProtocolFeeMist: ONCHAIN_CONFIG.protocolFlatFeeMist,
    expectedConfigVersion: ONCHAIN_CONFIG.configVersion,
    quoteTimestampMs: 1n,
    ...overrides,
  };
}

function setSettleArgs(args: ExtractedSettleArgs): void {
  MOCK_BUILD_RESULT.settleArgs = args;
}

function makeMockContext() {
  return {
    network: 'testnet' as const,
    sui: {},
    sponsorPool: {
      checkout: vi.fn().mockResolvedValue({
        sponsorAddress: SPONSOR_ADDRESS,
      }),
      checkin: vi.fn().mockResolvedValue(undefined),
      sign: vi.fn(),
    },
    packageId: PACKAGE_ID,
    configId: CONFIG_ID,
    vaultRegistryId: REGISTRY_ID,
    rateLimiter: {},
    abuseBlocker: {
      checkIp: vi.fn().mockResolvedValue({ blocked: false }),
      checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
      recordSponsorFailure: vi.fn().mockResolvedValue(undefined),
    },
    prepareRequestNonceStore: {
      claim: vi.fn().mockResolvedValue('ok'),
    },
    sponsoredExecutionStore: {
      commitPreparedReceipt: vi.fn(async (draft: PreparedTxDraft) => ({
        ...draft,
        issuedAt: 1_741_680_000_000,
      })),
      reserveNonce: vi.fn().mockResolvedValue(1n),
      releaseNonceReservation: vi.fn().mockResolvedValue(undefined),
    },
    settlementPayoutRecipientAddress: PAYOUT_ADDRESS,
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
          poolId: POOL_ID,
          baseType: SETTLEMENT_TOKEN_TYPE,
          quoteType: '0x2::sui::SUI',
          swapDirection: 'baseForQuote' as const,
          feeBps: 0,
        },
      ],
      settlementTokenType: SETTLEMENT_TOKEN_TYPE,
      settlementTokenSymbol: 'DEEP',
      settlementTokenDecimals: 6,
      lotSize: 1n,
      minSize: 1n,
      effectiveFeeRateBps: 0,
      settlementSwapDirection: 'baseForQuote' as const,
    },
  ];
  return {
    deepbookPackageId: DEEPBOOK_PACKAGE_ID,
    supportedSettlementSwapPaths,
    settlementSwapPathDescriptors: createStaticSettlementSwapPathDescriptorMap(
      supportedSettlementSwapPaths,
    ),
    allowedSettlementSwapPaths: [
      {
        tokenType: SETTLEMENT_TOKEN_TYPE,
        hops: [POOL_ID],
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
  return withPrepareAuthorization(
    {
      txKindBytes,
      senderAddress: TEST_PREPARE_AUTH_SENDER,
      settlementTokenType: SETTLEMENT_TOKEN_TYPE,
      clientIp: '127.0.0.1',
      ...overrides,
    },
    { packageId: PACKAGE_ID },
  );
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

    setSettleArgs(
      makeExtractedSettleArgs({
        configObjectId: CONFIG_ID,
        registryObjectId: REGISTRY_ID,
        settlementPayoutRecipient: PAYOUT_ADDRESS,
        executionCostClaim: 1_800_000n,
        policyHash: policyHashBytes,
        orderIdHash: new Uint8Array(0),
        quotedHostFeeMist: 50_000n,
        expectedProtocolFeeMist: ONCHAIN_CONFIG.protocolFlatFeeMist,
        expectedConfigVersion: ONCHAIN_CONFIG.configVersion,
        paymentInputTrace: MOCK_PAYMENT_INPUT_TRACE,
        slippageBufferMist: MOCK_BUILD_RESULT.slippageBufferMist,
        extractedSettlementSwapPath: {
          tokenType: SETTLEMENT_TOKEN_TYPE,
          hops: [POOL_ID],
          settlementSwapDirection: 'baseForQuote',
        },
      }),
    );
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

  it('commits the exact runner-owned draft to the receipt lifecycle store', async () => {
    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams(txKindBytes, { clientIp: '192.168.1.1' });

    const result = await handlePrepare(ctx, params, makeExtraCfg());

    expect(ctx.sponsoredExecutionStore.commitPreparedReceipt).toHaveBeenCalledTimes(1);

    const [storedDraft] = (
      ctx.sponsoredExecutionStore.commitPreparedReceipt as ReturnType<typeof vi.fn>
    ).mock.calls[0];

    // The runner owns the receipt and passes one exact draft to the store;
    // the store alone adds issuedAt to the committed entry it returns.
    expect(storedDraft.receiptId).toBe(result.receiptId);
    expect(storedDraft.senderAddress).toBe(TEST_PREPARE_AUTH_SENDER);
    expect(storedDraft.txBytesHash).toBe(FAKE_TX_BYTES_HASH);
    expect(storedDraft.sponsorAddress).toBe(SPONSOR_ADDRESS);
    expect(storedDraft.clientIp).toBe('192.168.1.1');
    expect(storedDraft.mode).toBe('generic');
    expect(storedDraft).not.toHaveProperty('issuedAt');

    // Settle / observability copies are not persisted. Sponsor reads
    // every settle value from `parseSettleArgs(txBytes)` — store copies
    // would invite drift bugs without adding authority. GenericPrepareBuildOutput-only
    // fields are also never persisted.
    expect(storedDraft).not.toHaveProperty('executionCostClaim');
    expect(storedDraft).not.toHaveProperty('simGas');
    expect(storedDraft).not.toHaveProperty('gasVarianceFixedMist');
    expect(storedDraft).not.toHaveProperty('slippageBufferMist');
    expect(storedDraft).not.toHaveProperty('grossGas');
    expect(storedDraft).not.toHaveProperty('profile');
    expect(storedDraft).not.toHaveProperty('quoteTimestampMs');
    expect(storedDraft).not.toHaveProperty('policyHash');
    expect(storedDraft).not.toHaveProperty('quotedHostFeeMist');
    expect(storedDraft).not.toHaveProperty('paymentInputSource');
  });

  it('txBytesHash in store matches response txBytes hash', async () => {
    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams(txKindBytes);

    const result = await handlePrepare(ctx, params, makeExtraCfg());

    // The committed draft must carry the hash paired with the opaque validated transaction.
    const [storedDraft] = (
      ctx.sponsoredExecutionStore.commitPreparedReceipt as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(storedDraft.txBytesHash).toBe(FAKE_TX_BYTES_HASH);

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
      vaultObjectId: VAULT_ID,
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
    expect(buildInput.vaultObjectId).toBe(VAULT_ID);
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
    setSettleArgs(
      makeExtractedSettleArgs({
        configObjectId: CONFIG_ID,
        registryObjectId: REGISTRY_ID,
        settlementPayoutRecipient: PAYOUT_ADDRESS,
        executionCostClaim: 1_800_000n,
        policyHash: policyHashBytes,
        orderIdHash,
        quotedHostFeeMist: 50_000n,
        expectedProtocolFeeMist: ONCHAIN_CONFIG.protocolFlatFeeMist,
        expectedConfigVersion: ONCHAIN_CONFIG.configVersion,
        paymentInputTrace: MOCK_PAYMENT_INPUT_TRACE,
        slippageBufferMist: MOCK_BUILD_RESULT.slippageBufferMist,
        extractedSettlementSwapPath: {
          tokenType: SETTLEMENT_TOKEN_TYPE,
          hops: [POOL_ID],
          settlementSwapDirection: 'baseForQuote',
        },
      }),
    );

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

  it('stores orderId in the PreparedTxDraft', async () => {
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
    setSettleArgs(
      makeExtractedSettleArgs({
        configObjectId: CONFIG_ID,
        registryObjectId: REGISTRY_ID,
        settlementPayoutRecipient: PAYOUT_ADDRESS,
        executionCostClaim: 1_800_000n,
        policyHash: policyHashBytes,
        orderIdHash,
        quotedHostFeeMist: 50_000n,
        expectedProtocolFeeMist: ONCHAIN_CONFIG.protocolFlatFeeMist,
        expectedConfigVersion: ONCHAIN_CONFIG.configVersion,
        paymentInputTrace: MOCK_PAYMENT_INPUT_TRACE,
        slippageBufferMist: MOCK_BUILD_RESULT.slippageBufferMist,
        extractedSettlementSwapPath: {
          tokenType: SETTLEMENT_TOKEN_TYPE,
          hops: [POOL_ID],
          settlementSwapDirection: 'baseForQuote',
        },
      }),
    );

    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams(txKindBytes, { orderId: 'store-test-order' });

    await handlePrepare(ctx, params, makeExtraCfg());

    const [storedDraft] = (
      ctx.sponsoredExecutionStore.commitPreparedReceipt as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(storedDraft.orderId).toBe('store-test-order');
  });

  it('stores orderId as null when not provided', async () => {
    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();
    const params = await makeParams(txKindBytes);

    await handlePrepare(ctx, params, makeExtraCfg());

    const [storedDraft] = (
      ctx.sponsoredExecutionStore.commitPreparedReceipt as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(storedDraft.orderId).toBeNull();
  });

  it('rejects before store when payment-input trace mismatches the selected source', async () => {
    setSettleArgs(
      makeExtractedSettleArgs({
        configObjectId: CONFIG_ID,
        registryObjectId: REGISTRY_ID,
        settlementPayoutRecipient: PAYOUT_ADDRESS,
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
          redeemCommandIndex: 0,
          withdrawalInputIndex: 0,
          senderWithdrawals: [{ inputIndex: 0, amount: MOCK_BUILD_RESULT.swapAmountSmallest }],
          senderRedeems: [
            { commandIndex: 0, inputIndex: 0, amount: MOCK_BUILD_RESULT.swapAmountSmallest },
          ],
        },
      }),
    );

    const ctx = makeMockContext();
    const txKindBytes = await makeValidTxKindBytes();

    await expect(
      handlePrepare(ctx, await makeParams(txKindBytes), makeExtraCfg()),
    ).rejects.toMatchObject({
      code: 'L2_EXTRACT_FAILED',
      meta: { subcode: 'payment_input_source_mismatch' },
    });

    expect(ctx.sponsoredExecutionStore.commitPreparedReceipt).not.toHaveBeenCalled();
  });

  // ── Lease commit error mapping (handler adapter invariant) ──────────────
  // `SponsorLeaseCommitError` thrown by the atomic receipt commit MUST be re-mapped by the handler to
  // `PrepareValidationError('SPONSOR_LEASE_COMMIT_FAILED')`.
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
    // Force the atomic prepared-receipt commit to report a lease CAS failure.
    // re-map. Any non-SponsorLeaseCommitError throw should propagate as-is —
    // covered indirectly by the existing scope ordering tests.
    (
      ctx.sponsoredExecutionStore.commitPreparedReceipt as ReturnType<typeof vi.fn>
    ).mockRejectedValue(
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

    // Mapping invariant: typed lease error → current prepare-domain code.
    expect(caught).toBeInstanceOf(PrepareValidationError);
    if (!(caught instanceof PrepareValidationError)) {
      throw new Error('expected PrepareValidationError');
    }
    expect(caught.code).toBe('SPONSOR_LEASE_COMMIT_FAILED');
    expect(caught.message).toContain('lease was not in reserved stage');

    // Scope cleanup invariant: nonce reservation must be released, slot
    // checked back in by receipt ID, and inflight handle dropped. Order:
    // reservation → slot checkin → inflight release.
    expect(ctx.sponsoredExecutionStore.releaseNonceReservation).toHaveBeenCalledWith(
      expect.stringMatching(/^0x[0-9a-f]{64}$/),
      TEST_PREPARE_AUTH_SENDER,
    );
    expect(ctx.sponsorPool.checkin).toHaveBeenCalledWith(
      SPONSOR_ADDRESS,
      expect.stringMatching(/^0x[0-9a-f]{64}$/),
    );
    expect(inflightRelease).toHaveBeenCalledTimes(1);

    // The single atomic commit attempt failed before it could produce a
    // prepared entry; the runner must not retry that mutation.
    expect(ctx.sponsoredExecutionStore.commitPreparedReceipt).toHaveBeenCalledTimes(1);
  });
});
