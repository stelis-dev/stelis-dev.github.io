/**
 * handlerWiringBaseline.test.ts — wiring snapshot tests for handlePrepare.
 *
 * Scope: this file verifies the observable wiring of the prepare handler.
 * It stubs `runGenericPrepareBuildPipeline()` and `Transaction.from()` so the boundary under test is the handler →
 * compose → store path, NOT the build math or real PTB extraction.
 *
 * What this file CAN catch:
 *   - effective profile propagation to the response while excluding it from the store draft
 *   - executionCostClaim propagation to the response while excluding it from the store draft
 *   - runner-owned receipt propagation (build input → store draft → response)
 *   - nonce propagation (reserveNonce → store draft → response)
 *   - cost response shape (exact 7-field key set)
 *   - runner-composed draft wiring (policy supplies only route-owned fields)
 *
 * What this file CANNOT catch (inner steps are mocked):
 *   - real PTB serialization correctness — see `roundTripPtb.test.ts`
 *   - real settle-args extraction from a built PTB — see `roundTripPtb.test.ts`
 *   - real build orchestration (credit probe / pass 1 / 1.5 / 2) — covered
 *     by the generic prepare build-pipeline suite
 *
 * For pure planner math we keep `settlementPlanner.test.ts`. For real
 * builder→parser round-trip we keep `roundTripPtb.test.ts` and
 * `@stelis/core-relay/tests/builders.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { GAS_VARIANCE_FIXED_MIST } from '@stelis/core-relay';
import {
  SETTLE_MODULE,
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
  SLIPPAGE_CAP_BPS,
} from '@stelis/contracts';
import { PREPARE_TTL_MS } from '../src/preparePolicy.js';
import { computePolicyHash } from '../src/policyHash.js';

// ─── Module mocks ──────────────────────────────────────────────────────────

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
  VAULT_ONE_ID,
  VAULT_TWO_ID,
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
  VAULT_ONE_ID: `0x${'91'.repeat(32)}`,
  VAULT_TWO_ID: `0x${'92'.repeat(32)}`,
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
  return { ...original, queryUserCredit: mockQueryUserCredit };
});

vi.mock('../src/prepare/build.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/prepare/build.js')>();
  return { ...original, runGenericPrepareBuildPipeline: mockPrepareBuildPipeline };
});

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
  return { ...original, Transaction: MockTransaction };
});

import type { PrepareParams, PrepareHandlerConfig } from '../src/handlers/prepare.js';
import { handlePrepare } from '../src/handlers/prepare.js';
import { ALLOW_PREPARE_REQUEST } from './prepareRequestAdmissionTestHelpers.js';
import type { ExtractedSettleArgs } from '../src/prepare/extractSettleArgs.js';
import type { PreparedTxDraft } from '../src/store/prepareTypes.js';
import type { SingleHopSettlementSwapPath } from '@stelis/contracts';
import type {
  AddressBalanceGasTransaction,
  PaymentInputTrace,
  StaticSettlementSwapPathDescriptorMap,
} from '@stelis/core-relay/server';
import { TEST_PREPARE_AUTH_SENDER, withPrepareAuthorization } from './prepareAuthTestHelpers.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const FAKE_TX_BYTES = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
const FAKE_TX_BYTES_HASH = '3cf654795a1c99c8e41f69aaeb3ad9e03f1b64cb14efb3b9b3b46be771e3a5b4';

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

const ONCHAIN_CONFIG = {
  packageId: PACKAGE_ID,
  configId: CONFIG_ID,
  maxClaimMist: 50_000_000n,
  minSettleMist: 0n,
  maxHostFeeMist: 500_000n,
  protocolFlatFeeMist: 10_000n,
  configVersion: 1n,
  maxSpreadBps: 500n,
};

const NEW_USER_BUILD_RESULT = {
  addressBalanceGasTransaction: FAKE_ADDRESS_BALANCE_GAS_TRANSACTION,
  l1Validation: { ok: true } as const,
  settleArgs: null as ExtractedSettleArgs | null,
  executionCostClaim: 1_800_000n,
  simGas: 1_300_000n,
  gasVarianceFixedMist: 350_000n,
  slippageBufferMist: 150_000n,
  grossGas: 1_500_000n,
  profile: 'new_user' as const,
  paymentInputSource: 'coin_object' as const,
  swapAmountSmallest: 500_000n,
};

const WITH_VAULT_BUILD_RESULT = {
  ...NEW_USER_BUILD_RESULT,
  profile: 'with_vault' as const,
  paymentInputSource: 'address_balance' as const,
};

const CREDIT_GENERAL_BUILD_RESULT = {
  ...NEW_USER_BUILD_RESULT,
  profile: 'credit_general' as const,
  paymentInputSource: 'none_credit_only' as const,
  slippageBufferMist: 0n,
  swapAmountSmallest: 0n,
};

const COIN_OBJECT_PAYMENT_EVIDENCE = {
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
} satisfies PaymentInputTrace;

const ADDRESS_BALANCE_PAYMENT_EVIDENCE = {
  settleVariantClass: 'with_vault' as const,
  source: 'address_balance' as const,
  paymentCoinRefKind: 'nested_result' as const,
  producerCommandKind: 'MoveCall' as const,
  settleSwapAmount: 500_000n,
  withdrawalAmount: 500_000n,
  redeemCommandIndex: 0,
  withdrawalInputIndex: 0,
  senderWithdrawals: [{ inputIndex: 0, amount: 500_000n }],
  senderRedeems: [{ commandIndex: 0, inputIndex: 0, amount: 500_000n }],
} satisfies PaymentInputTrace;

const CREDIT_ONLY_PAYMENT_EVIDENCE = {
  settleVariantClass: 'credit' as const,
  source: 'none_credit_only' as const,
  paymentCoinRefKind: 'none' as const,
} satisfies PaymentInputTrace;

const SUPPORTED_POOL = {
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
} satisfies SingleHopSettlementSwapPath;

const SETTLEMENT_SWAP_PATH_DESCRIPTORS: StaticSettlementSwapPathDescriptorMap = new Map([
  [
    SUPPORTED_POOL.settlementTokenType,
    {
      settlementTokenType: SUPPORTED_POOL.settlementTokenType,
      settlementTokenSymbol: SUPPORTED_POOL.settlementTokenSymbol,
      settlementTokenDecimals: SUPPORTED_POOL.settlementTokenDecimals,
      effectiveFeeRateBps: SUPPORTED_POOL.effectiveFeeRateBps,
      settlementSwapDirection: SUPPORTED_POOL.settlementSwapDirection,
      hops: SUPPORTED_POOL.hops,
      lotSize: SUPPORTED_POOL.lotSize,
      minSize: SUPPORTED_POOL.minSize,
    },
  ],
]);

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
      reserveNonce: vi.fn().mockResolvedValue(7n),
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
  return {
    deepbookPackageId: DEEPBOOK_PACKAGE_ID,
    supportedSettlementSwapPaths: [SUPPORTED_POOL],
    settlementSwapPathDescriptors: SETTLEMENT_SWAP_PATH_DESCRIPTORS,
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
  tx.makeMoveVec({ elements: [tx.pure.u64(42)] });
  const kindBytes = await tx.build({ onlyTransactionKind: true });
  return toBase64(kindBytes);
}

function policyHashBytes(): Uint8Array {
  const hex = computePolicyHash({
    maxClaimMist: ONCHAIN_CONFIG.maxClaimMist,
    maxHostFeeMist: ONCHAIN_CONFIG.maxHostFeeMist,
    protocolFeeMist: ONCHAIN_CONFIG.protocolFlatFeeMist,
    quoteTtlMs: PREPARE_TTL_MS,
    gasVarianceFixedMist: GAS_VARIANCE_FIXED_MIST,
    slippageCapBps: SLIPPAGE_CAP_BPS,
  });
  return Uint8Array.from(Buffer.from(hex.replace('0x', ''), 'hex'));
}

function mockSettleArgs(paymentInputTrace: PaymentInputTrace): void {
  const isCreditOnly = paymentInputTrace.settleVariantClass === 'credit';
  const settleArgs: ExtractedSettleArgs = {
    configObjectId: CONFIG_ID,
    registryObjectId: REGISTRY_ID,
    settlementPayoutRecipient: PAYOUT_ADDRESS,
    executionCostClaim: 1_800_000n,
    policyHash: policyHashBytes(),
    orderIdHash: new Uint8Array(0),
    quotedHostFeeMist: 50_000n,
    expectedProtocolFeeMist: ONCHAIN_CONFIG.protocolFlatFeeMist,
    expectedConfigVersion: ONCHAIN_CONFIG.configVersion,
    nonce: 7n,
    receiptId: new Uint8Array(32),
    simGasReported: 1_300_000n,
    gasVarianceFixedMist: 350_000n,
    slippageBufferMist: isCreditOnly ? 0n : 150_000n,
    quoteTimestampMs: 1_741_680_000_000n,
    extractedSettlementSwapPath: isCreditOnly
      ? undefined
      : {
          tokenType: SUPPORTED_POOL.settlementTokenType,
          hops: [SUPPORTED_POOL.hops[0].poolId],
          settlementSwapDirection: SUPPORTED_POOL.settlementSwapDirection,
        },
    paymentInputTrace,
  };
  NEW_USER_BUILD_RESULT.settleArgs = settleArgs;
  WITH_VAULT_BUILD_RESULT.settleArgs = settleArgs;
  CREDIT_GENERAL_BUILD_RESULT.settleArgs = settleArgs;
}

function requirePaymentInputTrace(settleArgs: ExtractedSettleArgs): PaymentInputTrace {
  if (!settleArgs.paymentInputTrace) {
    throw new Error('test fixture must include the payment-input trace consumed by self-check');
  }
  return settleArgs.paymentInputTrace;
}

const NEW_USER_PARAMS = (
  txKindBytes: string,
  abuseBlocker: Parameters<typeof handlePrepare>[0]['abuseBlocker'],
): Promise<PrepareParams> =>
  withPrepareAuthorization(
    {
      txKindBytes,
      senderAddress: TEST_PREPARE_AUTH_SENDER,
      settlementTokenType: SETTLEMENT_TOKEN_TYPE,
      clientIp: '10.0.0.1',
      abuseBlocker,
    },
    { packageId: PACKAGE_ID },
  );

// ─── Tests ────────────────────────────────────────────────────────────────

describe('Handler wiring: handlePrepare boundary-crossing snapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Case 1: new_user, coin_object ──

  it('new_user / coin_object — locks profile, claim, nonce, source, settle args', async () => {
    mockQueryUserCredit.mockResolvedValue({
      vaultObjectId: null,
      credit: '0',
      needsCreate: true,
      lastNonce: '0',
    });
    mockPrepareBuildPipeline.mockResolvedValue(NEW_USER_BUILD_RESULT);
    mockSettleArgs(COIN_OBJECT_PAYMENT_EVIDENCE);

    const ctx = makeMockContext();
    const params = await NEW_USER_PARAMS(await makeValidTxKindBytes(), ctx.abuseBlocker);
    const result = await handlePrepare(ctx, params, makeExtraCfg(), ALLOW_PREPARE_REQUEST);

    // Effective profile in response
    expect(result.profile).toBe('new_user');
    // executionCostClaim in response
    expect(result.cost.executionCostClaim).toBe('1800000');
    // nonce assigned by reserveNonce mock
    expect(result.nonce).toBe('7');

    // Settle args: paymentInputTrace consumed by L2 must be coin_object
    const settleArgsCall = NEW_USER_BUILD_RESULT.settleArgs!;
    expect(requirePaymentInputTrace(settleArgsCall).source).toBe('coin_object');

    // GenericPrepareBuildOutput.paymentInputSource passed to L2 expected check
    const [, buildInput] = mockPrepareBuildPipeline.mock.calls[0];
    expect(buildInput.profile).toBe('new_user');
    expect(buildInput.vaultObjectId).toBeNull();
    expect(`0x${Buffer.from(buildInput.receiptId).toString('hex')}`).toBe(result.receiptId);

    // Store draft carries coordination fields only. Settle copies
    // (`profile` / `executionCostClaim` etc.) are read from
    // `parseSettleArgs(txBytes)` at sponsor time, so this test locks
    // `nonce` (a true coordination field) plus the negative shape of
    // the settle copies that must not be persisted.
    const [storedDraft] = (
      ctx.sponsoredExecutionStore.commitPreparedReceipt as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(storedDraft.receiptId).toBe(result.receiptId);
    expect(storedDraft.nonce).toBe(7n);
    expect(storedDraft).not.toHaveProperty('issuedAt');
    expect(storedDraft).not.toHaveProperty('profile');
    expect(storedDraft).not.toHaveProperty('executionCostClaim');
    expect(storedDraft).not.toHaveProperty('paymentInputSource');
  });

  // ── Case 2: with_vault, address_balance ──

  it('with_vault / address_balance — locks profile, claim, nonce, source', async () => {
    mockQueryUserCredit.mockResolvedValue({
      vaultObjectId: VAULT_ONE_ID,
      credit: '0',
      needsCreate: false,
      lastNonce: '0',
    });
    mockPrepareBuildPipeline.mockResolvedValue(WITH_VAULT_BUILD_RESULT);
    mockSettleArgs(ADDRESS_BALANCE_PAYMENT_EVIDENCE);

    const ctx = makeMockContext();
    const params = await NEW_USER_PARAMS(await makeValidTxKindBytes(), ctx.abuseBlocker);
    const result = await handlePrepare(ctx, params, makeExtraCfg(), ALLOW_PREPARE_REQUEST);

    expect(result.profile).toBe('with_vault');
    expect(result.cost.executionCostClaim).toBe('1800000');
    expect(result.nonce).toBe('7');

    const [, buildInput] = mockPrepareBuildPipeline.mock.calls[0];
    // Requested profile is credit_general (vault present); planner may downgrade to with_vault
    expect(buildInput.profile).toBe('credit_general');
    expect(buildInput.vaultObjectId).toBe(VAULT_ONE_ID);

    const settleArgsCall = WITH_VAULT_BUILD_RESULT.settleArgs!;
    expect(requirePaymentInputTrace(settleArgsCall).source).toBe('address_balance');

    // Store draft: nonce coordination retained, settle copies not
    // persisted. Result.profile / result.cost.executionCostClaim above already
    // verify the values flow from GenericPrepareBuildOutput through the response; the
    // store draft is not the assertion site for them.
    const [storedDraft] = (
      ctx.sponsoredExecutionStore.commitPreparedReceipt as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(storedDraft.nonce).toBe(7n);
    expect(storedDraft).not.toHaveProperty('issuedAt');
    expect(storedDraft).not.toHaveProperty('profile');
    expect(storedDraft).not.toHaveProperty('executionCostClaim');
  });

  // ── Case 3: credit_general, none_credit_only ──

  it('credit_general / none_credit_only — locks credit-only path shape', async () => {
    mockQueryUserCredit.mockResolvedValue({
      vaultObjectId: VAULT_TWO_ID,
      credit: '999999999',
      needsCreate: false,
      lastNonce: '0',
    });
    mockPrepareBuildPipeline.mockResolvedValue(CREDIT_GENERAL_BUILD_RESULT);
    mockSettleArgs(CREDIT_ONLY_PAYMENT_EVIDENCE);

    const ctx = makeMockContext();
    const params = await NEW_USER_PARAMS(await makeValidTxKindBytes(), ctx.abuseBlocker);
    const result = await handlePrepare(ctx, params, makeExtraCfg(), ALLOW_PREPARE_REQUEST);

    expect(result.profile).toBe('credit_general');
    expect(result.cost.executionCostClaim).toBe('1800000');
    expect(result.cost.slippageBufferMist).toBe('0');
    expect(result.nonce).toBe('7');

    const [, buildInput] = mockPrepareBuildPipeline.mock.calls[0];
    expect(buildInput.profile).toBe('credit_general');
    expect(buildInput.vaultObjectId).toBe(VAULT_TWO_ID);

    const settleArgsCall = CREDIT_GENERAL_BUILD_RESULT.settleArgs!;
    const paymentInputTrace = requirePaymentInputTrace(settleArgsCall);
    expect(paymentInputTrace.source).toBe('none_credit_only');
    expect(paymentInputTrace.settleVariantClass).toBe('credit');

    // Store draft does not persist settle copies (profile,
    // slippageBufferMist). Result.profile and result.cost.slippageBufferMist
    // above verify the values flow from GenericPrepareBuildOutput through the response.
    const [storedDraft] = (
      ctx.sponsoredExecutionStore.commitPreparedReceipt as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(storedDraft).not.toHaveProperty('profile');
    expect(storedDraft).not.toHaveProperty('slippageBufferMist');
  });

  // ── Case 4: store draft preserves the validated transaction digest ──

  it('store draft projects the opaque transaction hash and drops the 9 settle observability copies', async () => {
    mockQueryUserCredit.mockResolvedValue({
      vaultObjectId: null,
      credit: '0',
      needsCreate: true,
      lastNonce: '0',
    });
    mockPrepareBuildPipeline.mockResolvedValue(NEW_USER_BUILD_RESULT);
    mockSettleArgs(COIN_OBJECT_PAYMENT_EVIDENCE);

    const ctx = makeMockContext();
    const params = await NEW_USER_PARAMS(await makeValidTxKindBytes(), ctx.abuseBlocker);
    await handlePrepare(ctx, params, makeExtraCfg(), ALLOW_PREPARE_REQUEST);

    const [storedDraft] = (
      ctx.sponsoredExecutionStore.commitPreparedReceipt as ReturnType<typeof vi.fn>
    ).mock.calls[0];

    // Coordination-only projection from the validated opaque transaction.
    expect(storedDraft.txBytesHash).toBe(FAKE_TX_BYTES_HASH);
    expect(storedDraft).not.toHaveProperty('issuedAt');

    // The 9 settle observability copies are not persisted. Sponsor reads
    // each value from `parseSettleArgs(txBytes)`; the store draft is not
    // their carrier. GenericPrepareBuildOutput-only fields are also never persisted.
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
    expect(storedDraft).not.toHaveProperty('swapAmountSmallest');
  });

  // ── Case 5: cost response shape locked ──

  it('response cost breakdown shape is exactly the 7-field format', async () => {
    mockQueryUserCredit.mockResolvedValue({
      vaultObjectId: null,
      credit: '0',
      needsCreate: true,
      lastNonce: '0',
    });
    mockPrepareBuildPipeline.mockResolvedValue(NEW_USER_BUILD_RESULT);
    mockSettleArgs(COIN_OBJECT_PAYMENT_EVIDENCE);

    const ctx = makeMockContext();
    const params = await NEW_USER_PARAMS(await makeValidTxKindBytes(), ctx.abuseBlocker);
    const result = await handlePrepare(ctx, params, makeExtraCfg(), ALLOW_PREPARE_REQUEST);

    expect(Object.keys(result.cost).sort()).toEqual([
      'executionCostClaim',
      'gasVarianceFixedMist',
      'grossGas',
      'protocolFee',
      'quotedHostFee',
      'simGas',
      'slippageBufferMist',
    ]);
  });
});
