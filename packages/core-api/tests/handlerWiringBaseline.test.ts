/**
 * handlerWiringBaseline.test.ts — wiring snapshot tests for handlePrepare.
 *
 * Scope: this file verifies the observable wiring of the prepare handler.
 * It stubs `runGenericPrepareBuildPipeline()`, `extractSettleArgsFromBuiltTx()`, and
 * `Transaction.from()` so the boundary under test is the handler →
 * compose → store path, NOT the build math or real PTB extraction.
 *
 * What this file CAN catch:
 *   - effective profile propagation (GenericPrepareBuildOutput.profile → store → response)
 *   - executionCostClaim propagation (GenericPrepareBuildOutput → store → response)
 *   - nonce propagation (reserveNonce → store → response)
 *   - cost response shape (exact 7-field key set)
 *   - prepared-commit projection wiring (no extra/missing fields)
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
import { PREPARE_TTL_MS } from '../src/handlers/prepare.js';
import { computePolicyHash } from '../src/policyHash.js';

// ─── Module mocks ──────────────────────────────────────────────────────────

const { mockQueryUserCredit, mockPrepareBuildPipeline } = vi.hoisted(() => ({
  mockQueryUserCredit: vi.fn(),
  mockPrepareBuildPipeline: vi.fn(),
}));

vi.mock('@stelis/core-relay', async (importOriginal) => {
  const original = await importOriginal<typeof import('@stelis/core-relay')>();
  return { ...original, queryUserCredit: mockQueryUserCredit };
});

vi.mock('../src/prepare/build.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/prepare/build.js')>();
  return { ...original, runGenericPrepareBuildPipeline: mockPrepareBuildPipeline };
});

vi.mock('../src/prepare/extractSettleArgs.js');

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
  return { ...original, Transaction: MockTransaction };
});

import type { PrepareParams, PrepareHandlerConfig } from '../src/handlers/prepare.js';
import { handlePrepare } from '../src/handlers/prepare.js';
import { extractSettleArgsFromBuiltTx } from '../src/prepare/extractSettleArgs.js';
import type { SingleHopSettlementSwapPath } from '@stelis/contracts';
import type { StaticSettlementSwapPathDescriptorMap } from '@stelis/core-relay/server';
import { TEST_PREPARE_AUTH_SENDER, withPrepareAuthorization } from './prepareAuthTestHelpers.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const FAKE_TX_BYTES = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
const FAKE_TX_BYTES_HASH = '3cf654795a1c99c8e41f69aaeb3ad9e03f1b64cb14efb3b9b3b46be771e3a5b4';

const ONCHAIN_CONFIG = {
  packageId: '0xPACKAGE',
  configId: '0xCONFIG',
  maxClaimMist: 50_000_000n,
  minSettleMist: 0n,
  maxHostFeeMist: 500_000n,
  protocolFlatFeeMist: 10_000n,
  configVersion: 1n,
  maxSpreadBps: 500n,
};

const NEW_USER_BUILD_RESULT = {
  txBytes: FAKE_TX_BYTES,
  txBytesHash: FAKE_TX_BYTES_HASH,
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
};

const ADDRESS_BALANCE_PAYMENT_EVIDENCE = {
  settleVariantClass: 'with_vault' as const,
  source: 'address_balance' as const,
  paymentCoinRefKind: 'nested_result' as const,
  producerCommandKind: 'MoveCall' as const,
  settleSwapAmount: 500_000n,
  withdrawalAmount: 500_000n,
};

const CREDIT_ONLY_PAYMENT_EVIDENCE = {
  settleVariantClass: 'credit' as const,
  source: 'none_credit_only' as const,
  paymentCoinRefKind: 'none' as const,
};

const SUPPORTED_POOL = {
  hops: [
    {
      poolId: '0xPOOL',
      baseType: '0xDEEP::deep::DEEP',
      quoteType: '0x2::sui::SUI',
      swapDirection: 'baseForQuote' as const,
      feeBps: 0,
    },
  ],
  paymentTokenType: '0xDEEP::deep::DEEP',
  paymentTokenSymbol: 'DEEP',
  paymentTokenDecimals: 6,
  lotSize: 1n,
  minSize: 1n,
  effectiveFeeRateBps: 0,
  settlementSwapDirection: 'baseForQuote' as const,
} satisfies SingleHopSettlementSwapPath;

const SETTLEMENT_SWAP_PATH_DESCRIPTORS: StaticSettlementSwapPathDescriptorMap = new Map([
  [
    SUPPORTED_POOL.paymentTokenType,
    {
      paymentTokenType: SUPPORTED_POOL.paymentTokenType,
      paymentTokenSymbol: SUPPORTED_POOL.paymentTokenSymbol,
      paymentTokenDecimals: SUPPORTED_POOL.paymentTokenDecimals,
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
      reserveNonce: vi.fn().mockResolvedValue(7n),
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
  return {
    deepbookPackageId: '0xDEEPBOOK',
    supportedSettlementSwapPaths: [SUPPORTED_POOL],
    settlementSwapPathDescriptors: SETTLEMENT_SWAP_PATH_DESCRIPTORS,
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

function mockSettleArgs(paymentInputTrace: unknown) {
  const variantClass = (paymentInputTrace as { settleVariantClass?: unknown }).settleVariantClass;
  const isCreditOnly = variantClass === 'credit';
  vi.mocked(extractSettleArgsFromBuiltTx).mockReturnValue({
    configObjectId: '0xCONFIG',
    registryObjectId: '0xREGISTRY',
    settlementPayoutRecipient: '0xRELAYER',
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
          tokenType: SUPPORTED_POOL.paymentTokenType,
          hops: [SUPPORTED_POOL.hops[0].poolId],
          settlementSwapDirection: SUPPORTED_POOL.settlementSwapDirection,
        },
    paymentInputTrace,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

const NEW_USER_PARAMS = (txKindBytes: string): Promise<PrepareParams> =>
  withPrepareAuthorization({
    txKindBytes,
    senderAddress: TEST_PREPARE_AUTH_SENDER,
    paymentTokenType: '0xDEEP::deep::DEEP',
    clientIp: '10.0.0.1',
  });

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
    const params = await NEW_USER_PARAMS(await makeValidTxKindBytes());
    const result = await handlePrepare(ctx, params, makeExtraCfg());

    // Effective profile in response
    expect(result.profile).toBe('new_user');
    // executionCostClaim in response
    expect(result.cost.executionCostClaim).toBe('1800000');
    // nonce assigned by reserveNonce mock
    expect(result.nonce).toBe('7');

    // Settle args: paymentInputTrace consumed by L2 must be coin_object
    const settleArgsCall = vi.mocked(extractSettleArgsFromBuiltTx).mock.results[0].value;
    expect(settleArgsCall.paymentInputTrace.source).toBe('coin_object');

    // GenericPrepareBuildOutput.paymentInputSource passed to L2 expected check
    const [, buildInput] = mockPrepareBuildPipeline.mock.calls[0];
    expect(buildInput.profile).toBe('new_user');
    expect(buildInput.vaultObjectId).toBeNull();

    // Store entry persists coordination fields only. Settle copies
    // (`profile` / `executionCostClaim` etc.) are read from
    // `parseSettleArgs(txBytes)` at sponsor time, so this test locks
    // `nonce` (a true coordination field) plus the negative shape of
    // the settle copies that must not be persisted.
    const [, storedEntry] = (ctx.prepareStore.store as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(storedEntry.nonce).toBe(7n);
    expect(storedEntry).not.toHaveProperty('profile');
    expect(storedEntry).not.toHaveProperty('executionCostClaim');
    expect(storedEntry).not.toHaveProperty('paymentInputSource');
  });

  // ── Case 2: with_vault, address_balance ──

  it('with_vault / address_balance — locks profile, claim, nonce, source', async () => {
    mockQueryUserCredit.mockResolvedValue({
      vaultObjectId: '0xVAULT_1',
      credit: '0',
      needsCreate: false,
      lastNonce: '0',
    });
    mockPrepareBuildPipeline.mockResolvedValue(WITH_VAULT_BUILD_RESULT);
    mockSettleArgs(ADDRESS_BALANCE_PAYMENT_EVIDENCE);

    const ctx = makeMockContext();
    const params = await NEW_USER_PARAMS(await makeValidTxKindBytes());
    const result = await handlePrepare(ctx, params, makeExtraCfg());

    expect(result.profile).toBe('with_vault');
    expect(result.cost.executionCostClaim).toBe('1800000');
    expect(result.nonce).toBe('7');

    const [, buildInput] = mockPrepareBuildPipeline.mock.calls[0];
    // Requested profile is credit_general (vault present); planner may downgrade to with_vault
    expect(buildInput.profile).toBe('credit_general');
    expect(buildInput.vaultObjectId).toBe('0xVAULT_1');

    const settleArgsCall = vi.mocked(extractSettleArgsFromBuiltTx).mock.results[0].value;
    expect(settleArgsCall.paymentInputTrace.source).toBe('address_balance');

    // Store entry: nonce coordination retained, settle copies not
    // persisted. Result.profile / result.cost.executionCostClaim above already
    // verify the values flow from GenericPrepareBuildOutput through the response; the
    // store entry is not the assertion site for them.
    const [, storedEntry] = (ctx.prepareStore.store as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(storedEntry.nonce).toBe(7n);
    expect(storedEntry).not.toHaveProperty('profile');
    expect(storedEntry).not.toHaveProperty('executionCostClaim');
  });

  // ── Case 3: credit_general, none_credit_only ──

  it('credit_general / none_credit_only — locks credit-only path shape', async () => {
    mockQueryUserCredit.mockResolvedValue({
      vaultObjectId: '0xVAULT_2',
      credit: '999999999',
      needsCreate: false,
      lastNonce: '0',
    });
    mockPrepareBuildPipeline.mockResolvedValue(CREDIT_GENERAL_BUILD_RESULT);
    mockSettleArgs(CREDIT_ONLY_PAYMENT_EVIDENCE);

    const ctx = makeMockContext();
    const params = await NEW_USER_PARAMS(await makeValidTxKindBytes());
    const result = await handlePrepare(ctx, params, makeExtraCfg());

    expect(result.profile).toBe('credit_general');
    expect(result.cost.executionCostClaim).toBe('1800000');
    expect(result.cost.slippageBufferMist).toBe('0');
    expect(result.nonce).toBe('7');

    const [, buildInput] = mockPrepareBuildPipeline.mock.calls[0];
    expect(buildInput.profile).toBe('credit_general');
    expect(buildInput.vaultObjectId).toBe('0xVAULT_2');

    const settleArgsCall = vi.mocked(extractSettleArgsFromBuiltTx).mock.results[0].value;
    expect(settleArgsCall.paymentInputTrace.source).toBe('none_credit_only');
    expect(settleArgsCall.paymentInputTrace.settleVariantClass).toBe('credit');

    // Store entry does not persist settle copies (profile,
    // slippageBufferMist). Result.profile and result.cost.slippageBufferMist
    // above verify the values flow from GenericPrepareBuildOutput through the response.
    const [, storedEntry] = (ctx.prepareStore.store as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(storedEntry).not.toHaveProperty('profile');
    expect(storedEntry).not.toHaveProperty('slippageBufferMist');
  });

  // ── Case 4: store entry preserves only `txBytesHash` from GenericPrepareBuildOutput ──

  it('persisted store entry projects txBytesHash from GenericPrepareBuildOutput and drops the 9 settle observability copies', async () => {
    mockQueryUserCredit.mockResolvedValue({
      vaultObjectId: null,
      credit: '0',
      needsCreate: true,
      lastNonce: '0',
    });
    mockPrepareBuildPipeline.mockResolvedValue(NEW_USER_BUILD_RESULT);
    mockSettleArgs(COIN_OBJECT_PAYMENT_EVIDENCE);

    const ctx = makeMockContext();
    const params = await NEW_USER_PARAMS(await makeValidTxKindBytes());
    await handlePrepare(ctx, params, makeExtraCfg());

    const [, storedEntry] = (ctx.prepareStore.store as ReturnType<typeof vi.fn>).mock.calls[0];

    // Coordination-only projection from GenericPrepareBuildOutput.
    expect(storedEntry.txBytesHash).toBe(NEW_USER_BUILD_RESULT.txBytesHash);

    // The 9 settle observability copies are not persisted. Sponsor reads
    // each value from `parseSettleArgs(txBytes)`; the store entry is not
    // their carrier. GenericPrepareBuildOutput-only fields are also never persisted.
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
    expect(storedEntry).not.toHaveProperty('swapAmountSmallest');
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
    const params = await NEW_USER_PARAMS(await makeValidTxKindBytes());
    const result = await handlePrepare(ctx, params, makeExtraCfg());

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
