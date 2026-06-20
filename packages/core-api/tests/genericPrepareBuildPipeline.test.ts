/**
 * runGenericPrepareBuildPipeline — boundary condition tests.
 *
 * Tests the internal branching logic of runGenericPrepareBuildPipeline:
 *   1. Eligible credit_general requests may measure credit before swap funding
 *   2. Swap fallback remains canonical through pass 2 once selected
 *   3. Credit-insufficient falls through to a with_vault swap entry
 *   4. gasBudget is capped at maxClaimMist
 *
 * Uses vi.mock to replace PTB builders, simulation, and gas math so the build
 * orchestration logic can be tested without on-chain calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BuildContext, GenericPrepareBuildRequest } from '../src/prepare/build.js';

// ── Mock Transaction ────────────────────────────────────────────────────────

const mockBuild = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
const mockSetSender = vi.fn();
const mockSetGasOwner = vi.fn();
const mockSetGasBudget = vi.fn();

vi.mock('@mysten/sui/transactions', () => {
  class MockTransaction {
    build = mockBuild;
    setSender = mockSetSender;
    setGasOwner = mockSetGasOwner;
    setGasBudget = mockSetGasBudget;
    object = vi.fn().mockImplementation((id: string) => ({ $kind: 'Input', objectId: id }));
    moveCall = vi.fn().mockReturnValue([{ $kind: 'Result', Result: 0 }]);
    withdrawal = vi.fn().mockReturnValue({ $kind: 'Result', Result: 0 });
    mergeCoins = vi.fn();
    splitCoins = vi.fn().mockReturnValue([{ $kind: 'Result', Result: 1 }]);

    // R-9: classifyUserTxCoins reads TX data to detect coin overlap
    getData() {
      return { inputs: [], commands: [] };
    }

    static fromKind(_kindBytes: Uint8Array) {
      return new MockTransaction();
    }
  }
  return { Transaction: MockTransaction };
});

// ── Mock core-relay ────────────────────────────────────────────────────────

const mockBuildSwapAndSettlePtb = vi.fn();
const mockBuildSettleWithCreditPtb = vi.fn();
const mockComputeExecutionCostClaim = vi.fn();
const mockBatchGetHopMidPrices = vi.fn().mockResolvedValue([27_000_000_000n]);
const mockResolvePaymentSource = vi.fn().mockResolvedValue({
  source: 'coin_object',
  usableCoinTotal: 100_000_000n,
  addressBalance: 0n,
  usableCoins: [{ objectId: '0xCOIN', balance: '100000000' }],
  redeemDelta: 0n,
});
const mockSelectPaymentCoin = vi.fn().mockResolvedValue({
  paymentCoin: '0xCOIN',
  leftoverCoin: null,
});
const mockSolveExecutableSwap = vi.fn().mockResolvedValue({
  swapAmountSmallest: 1_000_000n,
  targetOutputMist: 27_000_000n,
  effectiveTargetOutputMist: 27_000_000n,
  quotedHopOutputs: [27_000_000n],
  rawMidPrices: [27_000_000_000n],
  idealOutputMist: 27_000_000n,
  actualOutputMist: 27_000_000n,
  executionGapMist: 0n,
  executionGapBps: 0n,
});
const mockExtractPrefixWithdrawals = vi.fn().mockReturnValue({ total: 0n, unaccountable: false });

vi.mock('@stelis/core-relay', () => {
  // Must be defined inside factory to avoid hoisting issues
  class SlippageQueryError extends Error {
    override readonly name = 'SlippageQueryError';
  }
  return {
    buildSwapAndSettlePtb: (...args: unknown[]) => mockBuildSwapAndSettlePtb(...args),
    buildSettleWithCreditPtb: (...args: unknown[]) => mockBuildSettleWithCreditPtb(...args),
    computeExecutionCostClaim: (...args: unknown[]) => mockComputeExecutionCostClaim(...args),
    batchGetHopMidPrices: (...args: unknown[]) => mockBatchGetHopMidPrices(...args),
    SlippageQueryError,
    CONVERGENCE_TOLERANCE_BPS: 500,
    DEFAULT_GAS_MARGIN_BPS: 1000,
    classifyUserTxCoins: () => ({
      survivors: new Set(),
      consumed: new Set(),
      opaqueInUse: new Set(),
      mutated: new Set(),
      reusableSplitSources: new Set(),
      mergeDestToSources: new Map(),
    }),
    extractPrefixWithdrawals: (...args: unknown[]) => mockExtractPrefixWithdrawals(...args),
    extractObjectIdFromInput: () => null,
    // Move abort code constants consumed at module load by prepareErrors.ts's
    // regex builders. Values mirror packages/core-relay/src/moveAbortCode.ts
    // and are locked to Move source by core-relay/tests/errorCodeLock.test.ts.
    SETTLE_ABORT: {
      EPaused: 100,
      EClaimTooHigh: 101,
      ETotalInTooLow: 102,
      EInsufficientFunds: 103,
      EInvalidReceiptId: 104,
      EInvalidPolicyHash: 105,
      EConfigVersionMismatch: 106,
      EProtocolFeeMismatch: 107,
      EHostFeeCapExceeded: 108,
      EInvalidOrderIdHash: 109,
      ESpreadTooWide: 110,
    },
    VAULT_ABORT: {
      EInsufficientBalance: 0,
      EReplayNonce: 1,
      EVaultAlreadyRegistered: 2,
      EVaultNotRegistered: 3,
      EVaultMismatch: 4,
    },
    DEEPBOOK_ABORT: { EMinimumQuantityOutNotMet: 12 },
  };
});

vi.mock('@stelis/core-relay/server', () => {
  class MarketQuoteUnavailableError extends Error {
    override readonly name = 'MarketQuoteUnavailableError';
  }
  class ExecutionGapExceededError extends Error {
    override readonly name = 'ExecutionGapExceededError';
  }
  class SwapUnviableUnderPolicyError extends Error {
    override readonly name = 'SwapUnviableUnderPolicyError';
  }
  function nextQueuedStats(): QuotedRpcStatsEntry {
    const entry = mockQueuedRpcStats.shift();
    if (entry) {
      return {
        quantityInCalls: entry.quantityInCalls,
        quantityOutVerifyCalls: entry.quantityOutVerifyCalls,
        totalDurationMs: entry.totalDurationMs,
        maxDurationMs: entry.maxDurationMs,
        // When a test does not specify logical / cacheHits explicitly,
        // mirror the RPC dispatch numbers (no cache effect).
        quantityInLogicalCalls: entry.quantityInLogicalCalls ?? entry.quantityInCalls,
        quantityOutVerifyLogicalCalls:
          entry.quantityOutVerifyLogicalCalls ?? entry.quantityOutVerifyCalls,
        cacheHits: entry.cacheHits ?? 0,
      };
    }
    return {
      quantityInCalls: 0,
      quantityOutVerifyCalls: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      quantityInLogicalCalls: 0,
      quantityOutVerifyLogicalCalls: 0,
      cacheHits: 0,
    };
  }

  return {
    createDeepbookQuotePort: vi.fn().mockReturnValue({}),
    wrapQuotePortWithStats: (port: unknown) => {
      mockNoCacheWrapperCalls.count += 1;
      return {
        port,
        stats: nextQueuedStats(),
      };
    },
    wrapQuotePortWithCacheAndStats: (port: unknown, cache: unknown) => {
      mockCachedWrapperCacheArgs.push(cache as object);
      return {
        port,
        stats: nextQueuedStats(),
      };
    },
    createRequestQuoteCache: () => {
      mockCreateCacheCalls.count += 1;
      // Return a fresh tagged object so cache-identity assertions can prove
      // the same instance is shared across pass1 / pass1.5 / pass2.
      return { outputs: new Map(), inputs: new Map() };
    },
    solveExecutableSwap: (...args: unknown[]) => mockSolveExecutableSwap(...args),
    MarketQuoteUnavailableError,
    ExecutionGapExceededError,
    SwapUnviableUnderPolicyError,
  };
});

// Module-level captures used by cache-orchestration assertions.
// `mockCreateCacheCalls.count` increments once per `createRequestQuoteCache`
// invocation. `mockCachedWrapperCacheArgs` records the cache argument passed
// to every `wrapQuotePortWithCacheAndStats` call (in order). `mockNoCacheWrapperCalls`
// counts the no-cache wrapper invocations so a swap-path test can lock
// "all solver calls go through the cached wrapper".
const mockCreateCacheCalls = { count: 0 };
const mockCachedWrapperCacheArgs: object[] = [];
const mockNoCacheWrapperCalls = { count: 0 };

// Per-invocation queue of stats objects. Each `wrapQuotePortWithStats` /
// `wrapQuotePortWithCacheAndStats` call dequeues the next entry; an empty
// queue falls back to all-zero stats. Tests opt in by pushing entries before
// invoking `runGenericPrepareBuildPipeline`. Logical / cacheHits fields are optional — when
// omitted they mirror the RPC counts (i.e., no cache effect).
interface QuotedRpcStatsEntry {
  quantityInCalls: number;
  quantityOutVerifyCalls: number;
  totalDurationMs: number;
  maxDurationMs: number;
  quantityInLogicalCalls?: number;
  quantityOutVerifyLogicalCalls?: number;
  cacheHits?: number;
}
const mockQueuedRpcStats: QuotedRpcStatsEntry[] = [];

// ── Mock internal modules ───────────────────────────────────────────────────

vi.mock('../src/prepare/coinSelection.js', () => ({
  selectPaymentCoin: (...args: unknown[]) => mockSelectPaymentCoin(...args),
  resolvePaymentSource: (...args: unknown[]) => mockResolvePaymentSource(...args),
}));

// ── Import after mocks ─────────────────────────────────────────────────────

import {
  __testingGenericPrepareBuildStages,
  runGenericPrepareBuildPipeline,
} from '../src/prepare/build.js';
import { PrepareValidationError } from '../src/prepare/replay.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    sui: {
      simulateTransaction: vi.fn().mockResolvedValue({
        Transaction: {
          status: { success: true },
          effects: {
            gasUsed: {
              computationCost: '2000000',
              storageCost: '500000',
              storageRebate: '400000',
            },
          },
        },
      }),
    } as unknown as BuildContext['sui'],
    // The package-bound classifier requires the trusted package IDs to
    // match the abort-message fixtures used by the suite below. All
    // fixtures use `0xabc::...` for both Stelis and DeepBook aborts.
    packageId: '0xabc',
    configId: '0xCFG',
    vaultRegistryId: '0xREG',
    deepbookPackageId: '0xabc',
    settlementPayoutRecipientAddress: '0xRELAYER',
    maxClaimMist: 50_000_000n,
    minSettleMist: 100_000n,
    quotedHostFeeMist: 0n,
    protocolFlatFeeMist: 0n,
    configVersion: 1n,
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<GenericPrepareBuildRequest> = {},
): GenericPrepareBuildRequest {
  return {
    userTxKindBytes: 'AAAA', // base64 placeholder
    senderAddress: '0xSENDER',
    settlementSwapPath: {
      hops: [
        {
          poolId: '0xPOOL',
          baseType: '0xBASE',
          quoteType: '0xQUOTE',
          swapDirection: 'baseForQuote',
          feeBps: 0,
        },
      ],
      settlementTokenType: '0xDEEP::deep::DEEP',
      settlementTokenSymbol: 'DEEP',
      settlementTokenDecimals: 6,
      lotSize: 1n,
      minSize: 1n,
      effectiveFeeRateBps: 0,
      settlementSwapDirection: 'baseForQuote',
    } as unknown as GenericPrepareBuildRequest['settlementSwapPath'],
    descriptor: {
      settlementTokenType: '0xDEEP::deep::DEEP',
      settlementTokenSymbol: 'DEEP',
      settlementTokenDecimals: 6,
      effectiveFeeRateBps: 0,
      settlementSwapDirection: 'baseForQuote',
      hops: [
        {
          poolId: '0xPOOL',
          baseType: '0xBASE',
          quoteType: '0xQUOTE',
          swapDirection: 'baseForQuote',
          feeBps: 0,
        },
      ],
      lotSize: 1n,
      minSize: 1n,
    } as unknown as GenericPrepareBuildRequest['descriptor'],
    sponsorAddress: '0xSPONSOR',
    slippageBps: 100,
    gasMarginBps: 1000,
    profile: 'credit_general',
    vaultObjectId: '0xVAULT',
    credit: '10000000', // 10M MIST
    receiptId: new Uint8Array(32),
    policyHash: new Uint8Array(32),
    quoteTimestampMs: Date.now(),
    ...overrides,
  };
}

function makeExecutableQuote(
  overrides: Partial<{
    swapAmountSmallest: bigint;
    targetOutputMist: bigint;
    effectiveTargetOutputMist: bigint;
    quotedHopOutputs: bigint[];
    rawMidPrices: bigint[];
    idealOutputMist: bigint;
    actualOutputMist: bigint;
    executionGapMist: bigint;
    executionGapBps: bigint;
  }> = {},
) {
  return {
    swapAmountSmallest: 1_000_000n,
    targetOutputMist: 27_000_000n,
    effectiveTargetOutputMist: 27_000_000n,
    quotedHopOutputs: [27_000_000n],
    rawMidPrices: [27_000_000_000n],
    idealOutputMist: 27_000_000n,
    actualOutputMist: 27_000_000n,
    executionGapMist: 0n,
    executionGapBps: 0n,
    ...overrides,
  };
}

function resetBuildMocks(): void {
  vi.clearAllMocks();
  mockBuild.mockReset();
  mockBuild.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mockComputeExecutionCostClaim.mockReset();
  mockBatchGetHopMidPrices.mockReset();
  mockBatchGetHopMidPrices.mockResolvedValue([27_000_000_000n]);
  mockResolvePaymentSource.mockReset();
  mockResolvePaymentSource.mockResolvedValue({
    source: 'coin_object',
    usableCoinTotal: 100_000_000n,
    addressBalance: 0n,
    usableCoins: [{ objectId: '0xCOIN', balance: '100000000' }],
    redeemDelta: 0n,
  });
  mockSelectPaymentCoin.mockReset();
  mockSelectPaymentCoin.mockResolvedValue({ paymentCoin: '0xCOIN', leftoverCoin: null });
  mockSolveExecutableSwap.mockReset();
  mockSolveExecutableSwap.mockResolvedValue(makeExecutableQuote());
  mockExtractPrefixWithdrawals.mockReset();
  mockExtractPrefixWithdrawals.mockReturnValue({ total: 0n, unaccountable: false });
  mockComputeExecutionCostClaim.mockReturnValue({
    simGas: 2_000_000n,
    grossGas: 2_500_000n,
    gasVarianceFixedMist: 100_000n,
    slippageBufferMist: 0n,
    executionCostClaim: 3_000_000n,
  });
  mockQueuedRpcStats.length = 0;
  mockCreateCacheCalls.count = 0;
  mockCachedWrapperCacheArgs.length = 0;
  mockNoCacheWrapperCalls.count = 0;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('runGenericPrepareBuildPipeline — boundary conditions', () => {
  beforeEach(() => {
    resetBuildMocks();
  });

  // ── Pass 1 max-claim probe behavior ─────────────────────────────────────

  it('measures and selects credit before payment-source resolution when credit covers the measured credit-only cost', async () => {
    const ctx = makeCtx();
    const input = makeInput({ credit: '5000000' }); // Below max claim, above measured credit-only total.

    mockResolvePaymentSource.mockRejectedValue(
      new PrepareValidationError(
        'INSUFFICIENT_BALANCE',
        'Payment-token funding should not be required for a measured credit-only path',
      ),
    );
    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 2_000_000n,
      grossGas: 2_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 3_000_000n,
    });

    const result = await runGenericPrepareBuildPipeline(ctx, input);

    expect(mockResolvePaymentSource).not.toHaveBeenCalled();
    expect(mockSolveExecutableSwap).not.toHaveBeenCalled();
    expect(mockBuildSwapAndSettlePtb).not.toHaveBeenCalled();
    expect(mockBuildSettleWithCreditPtb).toHaveBeenCalledTimes(2);
    expect(result.profile).toBe('credit_general');
    expect(result.paymentInputSource).toBe('none_credit_only');
    expect(result.executionCostClaim).toBe(3_000_000n);
    expect(result.slippageBufferMist).toBe(0n);
    expect(result.swapAmountSmallest).toBe(0n);
  });

  it('rejects unaccountable withdrawals before selecting a measured credit-only path', async () => {
    const ctx = makeCtx();
    const input = makeInput({ credit: '5000000' });

    mockExtractPrefixWithdrawals.mockReturnValueOnce({ total: 0n, unaccountable: true });

    await expect(runGenericPrepareBuildPipeline(ctx, input)).rejects.toMatchObject({
      code: 'UNACCOUNTABLE_WITHDRAWAL',
    });
    expect(mockBuildSettleWithCreditPtb).not.toHaveBeenCalled();
    expect(mockResolvePaymentSource).not.toHaveBeenCalled();
  });

  it('preserves swap fallback in pass2 when the swap-buffered final claim is credit-coverable', async () => {
    const ctx = makeCtx();
    const input = makeInput({ credit: '3500000' });

    mockSolveExecutableSwap
      .mockResolvedValueOnce(
        makeExecutableQuote({
          executionGapMist: 0n,
          actualOutputMist: 27_000_000n,
        }),
      )
      .mockResolvedValueOnce(
        makeExecutableQuote({
          executionGapMist: 200_000n,
          actualOutputMist: 26_800_000n,
        }),
      )
      .mockResolvedValueOnce(
        makeExecutableQuote({
          executionGapMist: 200_000n,
          actualOutputMist: 26_800_000n,
        }),
      );
    mockComputeExecutionCostClaim
      .mockReturnValueOnce({
        simGas: 3_000_000n,
        grossGas: 3_500_000n,
        gasVarianceFixedMist: 100_000n,
        slippageBufferMist: 0n,
        executionCostClaim: 4_000_000n,
      })
      .mockReturnValueOnce({
        simGas: 2_000_000n,
        grossGas: 2_500_000n,
        gasVarianceFixedMist: 100_000n,
        slippageBufferMist: 0n,
        executionCostClaim: 3_000_000n,
      })
      .mockImplementation((_gasUsed: unknown, opts?: { slippageBufferMist?: bigint }) => {
        const slippageBufferMist = opts?.slippageBufferMist ?? 0n;
        return {
          simGas: 2_000_000n,
          grossGas: 2_500_000n,
          gasVarianceFixedMist: 100_000n,
          slippageBufferMist,
          executionCostClaim: 3_000_000n + slippageBufferMist,
        };
      });

    const result = await runGenericPrepareBuildPipeline(ctx, input);

    expect(mockBuildSettleWithCreditPtb).toHaveBeenCalledTimes(1);
    expect(mockBuildSwapAndSettlePtb).toHaveBeenCalledTimes(2);
    expect(result.profile).toBe('with_vault');
    expect(result.paymentInputSource).toBe('coin_object');
    expect(result.executionCostClaim).toBe(3_200_000n);
    expect(result.slippageBufferMist).toBe(200_000n);
    expect(result.swapAmountSmallest).toBe(1_000_000n);
  });

  it('pre-swap credit measurement replaces the max-claim swap probe when measured credit is covered', async () => {
    const ctx = makeCtx();
    const input = makeInput({ credit: '5000000' }); // 5M < 50M maxClaimMist
    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 2_000_000n,
      grossGas: 2_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 3_000_000n, // 3M < 5M credit → success
    });

    const result = await runGenericPrepareBuildPipeline(ctx, input);
    expect(mockBuildSwapAndSettlePtb).not.toHaveBeenCalled();
    expect(mockBuildSettleWithCreditPtb).toHaveBeenCalledTimes(2);
    const preSwapCreditCall = mockBuildSettleWithCreditPtb.mock.calls[0] as [
      unknown,
      { executionCostClaim: bigint },
    ];
    const pass2CreditCall = mockBuildSettleWithCreditPtb.mock.calls[1] as [
      unknown,
      { executionCostClaim: bigint },
    ];
    expect(preSwapCreditCall[1].executionCostClaim).toBe(5_000_000n);
    expect(pass2CreditCall[1].executionCostClaim).toBe(3_000_000n);
    expect(result.executionCostClaim).toBe(3_000_000n);
    expect(result.profile).toBe('credit_general');
  });

  it('pre-swap credit probe dry-runs credit PTB and uses its zero-buffer cost envelope', async () => {
    const ctx = makeCtx();
    const input = makeInput({ credit: '5000000' }); // 5M < maxClaim, but covers base claim

    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 4_000_000n,
      grossGas: 4_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 5_000_000n,
    });

    const result = await runGenericPrepareBuildPipeline(ctx, input);

    expect(mockSolveExecutableSwap).not.toHaveBeenCalled();
    expect(ctx.sui.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(mockComputeExecutionCostClaim).toHaveBeenCalledTimes(1);
    expect(mockBuildSwapAndSettlePtb).not.toHaveBeenCalled();
    expect(mockBuildSettleWithCreditPtb).toHaveBeenCalledTimes(2);
    const provisionalCreditCall = mockBuildSettleWithCreditPtb.mock.calls[0] as [
      unknown,
      { executionCostClaim: bigint; slippageBufferMist: bigint; useCreditAmount: bigint },
    ];
    const pass2CreditCall = mockBuildSettleWithCreditPtb.mock.calls[1] as [
      unknown,
      { executionCostClaim: bigint; slippageBufferMist: bigint; useCreditAmount: bigint },
    ];
    expect(provisionalCreditCall[1].executionCostClaim).toBe(5_000_000n);
    expect(pass2CreditCall[1].executionCostClaim).toBe(5_000_000n);
    expect(pass2CreditCall[1].slippageBufferMist).toBe(0n);
    expect(pass2CreditCall[1].useCreditAmount).toBe(5_000_000n);
    expect(result.profile).toBe('credit_general');
    expect(result.paymentInputSource).toBe('none_credit_only');
    expect(result.simGas).toBe(4_000_000n);
    expect(result.executionCostClaim).toBe(5_000_000n);
    expect(result.slippageBufferMist).toBe(0n);
    expect(result.swapAmountSmallest).toBe(0n);
  });

  it('selects credit when credit covers the zero-buffer claim but not a swap-buffered claim', async () => {
    const ctx = makeCtx();
    const input = makeInput({ credit: '3500000' }); // Covers 3M base, not 3.6M inflated

    mockComputeExecutionCostClaim.mockImplementation(
      (_gasUsed: unknown, opts?: { slippageBufferMist?: bigint }) => {
        const slippageBufferMist = opts?.slippageBufferMist ?? 0n;
        return {
          simGas: 2_000_000n,
          grossGas: 2_500_000n,
          gasVarianceFixedMist: 100_000n,
          slippageBufferMist,
          executionCostClaim: 3_000_000n + slippageBufferMist,
        };
      },
    );

    const result = await runGenericPrepareBuildPipeline(ctx, input);

    expect(mockComputeExecutionCostClaim).toHaveBeenCalledTimes(1);
    expect(mockSolveExecutableSwap).not.toHaveBeenCalled();
    expect(mockBuildSwapAndSettlePtb).not.toHaveBeenCalled();
    expect(mockBuildSettleWithCreditPtb).toHaveBeenCalledTimes(2);
    expect(result.profile).toBe('credit_general');
    expect(result.executionCostClaim).toBe(3_000_000n);
    expect(result.slippageBufferMist).toBe(0n);
  });

  it('falls back to swap when pre-swap credit measurement raises the final claim above credit', async () => {
    const ctx = makeCtx();
    const input = makeInput({ credit: '3500000' });

    mockSolveExecutableSwap
      .mockResolvedValueOnce(
        makeExecutableQuote({
          executionGapMist: 0n,
          actualOutputMist: 27_000_000n,
        }),
      )
      .mockResolvedValueOnce(
        makeExecutableQuote({
          executionGapMist: 700_000n,
          actualOutputMist: 26_300_000n,
        }),
      )
      .mockResolvedValueOnce(
        makeExecutableQuote({
          executionGapMist: 700_000n,
          actualOutputMist: 26_300_000n,
        }),
      );
    mockComputeExecutionCostClaim
      .mockReturnValueOnce({
        simGas: 3_000_000n,
        grossGas: 3_500_000n,
        gasVarianceFixedMist: 100_000n,
        slippageBufferMist: 0n,
        executionCostClaim: 4_000_000n,
      })
      .mockReturnValueOnce({
        simGas: 2_000_000n,
        grossGas: 2_500_000n,
        gasVarianceFixedMist: 100_000n,
        slippageBufferMist: 0n,
        executionCostClaim: 3_000_000n,
      })
      .mockImplementation((_gasUsed: unknown, opts?: { slippageBufferMist?: bigint }) => {
        const slippageBufferMist = opts?.slippageBufferMist ?? 0n;
        return {
          simGas: 2_000_000n,
          grossGas: 2_500_000n,
          gasVarianceFixedMist: 100_000n,
          slippageBufferMist,
          executionCostClaim: 3_000_000n + slippageBufferMist,
        };
      });

    const result = await runGenericPrepareBuildPipeline(ctx, input);

    expect(ctx.sui.simulateTransaction).toHaveBeenCalledTimes(2);
    expect(mockComputeExecutionCostClaim).toHaveBeenCalledTimes(3);
    expect(mockSolveExecutableSwap).toHaveBeenCalledTimes(3);
    expect(mockBuildSettleWithCreditPtb).toHaveBeenCalledTimes(1);
    expect(mockBuildSwapAndSettlePtb).toHaveBeenCalledTimes(2);
    expect(result.profile).toBe('with_vault');
    expect(result.paymentInputSource).toBe('coin_object');
    expect(result.executionCostClaim).toBe(3_700_000n);
    expect(result.slippageBufferMist).toBe(700_000n);
  });

  it('does not mask max-claim overflow as insufficient balance when no swap quote was collected', async () => {
    const ctx = makeCtx({ maxClaimMist: 50_000_000n });
    const input = makeInput({ credit: '55000000' }); // Covers pass1 max claim, not the measured 60M claim.

    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 59_000_000n,
      grossGas: 59_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 60_000_000n,
    });

    await expect(runGenericPrepareBuildPipeline(ctx, input)).rejects.toMatchObject({
      code: 'CLAIM_WOULD_EXCEED_MAX',
    });
    expect(mockSolveExecutableSwap).not.toHaveBeenCalled();
    expect(mockBuildSettleWithCreditPtb).toHaveBeenCalledTimes(1);
    expect(mockBuildSwapAndSettlePtb).not.toHaveBeenCalled();
  });

  it('uses the zero-buffer credit total even when credit also covers an inflated swap-buffer total', async () => {
    const ctx = makeCtx({
      quotedHostFeeMist: 1_000_000n,
      protocolFlatFeeMist: 500_000n,
    });
    const input = makeInput({ credit: '10000000' });

    mockSolveExecutableSwap.mockResolvedValueOnce(
      makeExecutableQuote({
        executionGapMist: 600_000n,
        actualOutputMist: 26_400_000n,
      }),
    );
    mockComputeExecutionCostClaim.mockImplementation(
      (_gasUsed: unknown, opts?: { slippageBufferMist?: bigint }) => {
        const slippageBufferMist = opts?.slippageBufferMist ?? 0n;
        return {
          simGas: 2_000_000n,
          grossGas: 2_500_000n,
          gasVarianceFixedMist: 100_000n,
          slippageBufferMist,
          executionCostClaim: 3_000_000n + slippageBufferMist,
        };
      },
    );

    const result = await runGenericPrepareBuildPipeline(ctx, input);

    const pass2CreditCall = mockBuildSettleWithCreditPtb.mock.calls[
      mockBuildSettleWithCreditPtb.mock.calls.length - 1
    ] as [unknown, { executionCostClaim: bigint; slippageBufferMist: bigint; useCreditAmount: bigint }];
    expect(pass2CreditCall[1].executionCostClaim).toBe(3_000_000n);
    expect(pass2CreditCall[1].slippageBufferMist).toBe(0n);
    expect(pass2CreditCall[1].useCreditAmount).toBe(4_500_000n);
    expect(result.executionCostClaim).toBe(3_000_000n);
    expect(result.slippageBufferMist).toBe(0n);
  });

  it('uses pre-swap credit measurement and final credit assembly when credit covers maxClaimMist', async () => {
    const ctx = makeCtx({ maxClaimMist: 50_000_000n });
    const input = makeInput({ credit: '100000000' }); // 100M >= 50M maxClaimMist

    const result = await runGenericPrepareBuildPipeline(ctx, input);
    expect(mockBuildSwapAndSettlePtb).not.toHaveBeenCalled();
    expect(mockBuildSettleWithCreditPtb).toHaveBeenCalledTimes(2);
    const preSwapCreditCall = mockBuildSettleWithCreditPtb.mock.calls[0] as [
      unknown,
      { executionCostClaim: bigint },
    ];
    const pass2CreditCall = mockBuildSettleWithCreditPtb.mock.calls[1] as [
      unknown,
      { executionCostClaim: bigint },
    ];
    expect(preSwapCreditCall[1].executionCostClaim).toBe(50_000_000n);
    expect(pass2CreditCall[1].executionCostClaim).toBe(3_000_000n);
    expect(result.executionCostClaim).toBe(3_000_000n);
  });

  it('new_user probes with maxClaimMist and remains on swap path', async () => {
    const ctx = makeCtx();
    const input = makeInput({
      profile: 'new_user',
      vaultObjectId: null,
      credit: '0',
    });

    const result = await runGenericPrepareBuildPipeline(ctx, input);
    expect(mockBuildSwapAndSettlePtb).toHaveBeenCalledTimes(2);
    expect(mockBuildSettleWithCreditPtb).not.toHaveBeenCalled();
    const pass1SwapCall = mockBuildSwapAndSettlePtb.mock.calls[0] as [
      unknown,
      { executionCostClaim: bigint },
    ];
    const pass2SwapCall = mockBuildSwapAndSettlePtb.mock.calls[1] as [
      unknown,
      { executionCostClaim: bigint },
    ];
    expect(pass1SwapCall[1].executionCostClaim).toBe(50_000_000n);
    expect(pass2SwapCall[1].executionCostClaim).toBe(3_000_000n);
    expect(result.executionCostClaim).toBe(3_000_000n);
  });

  // ── Credit-insufficient → swap fallback ─────────────────────────────────

  it('falls through to swap path when executionCostClaim > credit for credit_general', async () => {
    const ctx = makeCtx();
    const input = makeInput({ credit: '2000000' }); // 2M credit
    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 2_000_000n,
      grossGas: 2_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 3_000_000n, // 3M > 2M credit → swap fallback
    });

    // Should NOT throw — falls through to a with_vault swap entry
    const result = await runGenericPrepareBuildPipeline(ctx, input);
    expect(result.executionCostClaim).toBe(3_000_000n);
    // credit insufficient → falls through to a with_vault swap entry
    expect(result.profile).toBe('with_vault');
  });

  it('uses credit-only settle when credit covers the effective zero-fee requirement', async () => {
    const ctx = makeCtx();
    const input = makeInput({ credit: '5000000' }); // 5M credit
    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 2_000_000n,
      grossGas: 2_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 3_000_000n, // zero fees and minSettle below claim: 3M <= 5M → credit-only
    });

    const result = await runGenericPrepareBuildPipeline(ctx, input);
    expect(result.executionCostClaim).toBe(3_000_000n);
  });

  it('new_user with zero credit uses swap path without error', async () => {
    const ctx = makeCtx();
    const input = makeInput({
      profile: 'new_user',
      vaultObjectId: null,
      credit: '0',
    });
    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 10_000_000n,
      grossGas: 12_000_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 15_000_000n,
    });

    const result = await runGenericPrepareBuildPipeline(ctx, input);
    expect(result.executionCostClaim).toBe(15_000_000n);
  });

  // ── gasBudget cap ─────────────────────────────────────────────────────

  it('gasBudget is capped at maxClaimMist when rawGasBudget exceeds it', async () => {
    const ctx = makeCtx({ maxClaimMist: 5_000_000n }); // low cap
    const input = makeInput({
      profile: 'new_user',
      vaultObjectId: null,
      credit: '0',
      gasMarginBps: 1000,
    });
    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 4_000_000n,
      grossGas: 4_500_000n, // × 1.1 = 4_950_000 < 5M → under cap
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 4_500_000n,
    });

    await runGenericPrepareBuildPipeline(ctx, input);
    // gasBudget = grossGas(4.5M) × 1.1 = 4,950,000 < 5M → gasBudget = 4,950,000
    expect(mockSetGasBudget).toHaveBeenCalledWith(4_950_000n);
  });

  it('gasBudget capped to maxClaimMist when grossGas × margin exceeds it', async () => {
    const ctx = makeCtx({ maxClaimMist: 3_000_000n }); // very low cap
    const input = makeInput({
      profile: 'new_user',
      vaultObjectId: null,
      credit: '0',
      gasMarginBps: 1000,
    });
    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 4_000_000n,
      grossGas: 4_500_000n, // × 1.1 = 4,950,000 > 3M → capped
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 3_000_000n,
    });

    await runGenericPrepareBuildPipeline(ctx, input);
    expect(mockSetGasBudget).toHaveBeenCalledWith(3_000_000n);
  });
});

describe('generic prepare build stages — slot-free / gas-bound boundary locks', () => {
  beforeEach(() => {
    resetBuildMocks();
  });

  function makeMaxClaimProbe() {
    return {
      baseCosts: {
        simGas: 2_000_000n,
        grossGas: 2_500_000n,
        gasVarianceFixedMist: 100_000n,
        slippageBufferMist: 0n,
        executionCostClaim: 3_000_000n,
      },
      gasUsed: {
        computationCost: '2000000',
        storageCost: '500000',
        storageRebate: '400000',
      },
      pass1MidPrices: [27_000_000_000n],
      pass1ExecutionQuote: makeExecutableQuote(),
    };
  }

  it('measureSwapExecutionGap stays slot-free: quote solve only, no gas-owner, dry-run, or final build', async () => {
    const ctx = makeCtx();
    const input = makeInput();
    const runContext = __testingGenericPrepareBuildStages.createGenericPrepareBuildRunContext();
    const measuredCosts = {
      simGas: 2_000_000n,
      grossGas: 2_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 123_000n,
      executionCostClaim: 3_123_000n,
    };
    mockComputeExecutionCostClaim.mockReturnValueOnce(measuredCosts);

    const result = await __testingGenericPrepareBuildStages.measureSwapExecutionGap(
      ctx,
      input,
      makeMaxClaimProbe(),
      runContext,
    );

    expect(result.finalCosts).toBe(measuredCosts);
    expect(result.probeQuote.executionGapMist).toBe(0n);
    expect(mockSolveExecutableSwap).toHaveBeenCalledTimes(1);
    expect(mockSetGasOwner).not.toHaveBeenCalled();
    expect(mockSetGasBudget).not.toHaveBeenCalled();
    expect(mockBuild).not.toHaveBeenCalled();
    expect(ctx.sui.simulateTransaction).not.toHaveBeenCalled();
    expect(mockBuildSwapAndSettlePtb).not.toHaveBeenCalled();
    expect(mockBuildSettleWithCreditPtb).not.toHaveBeenCalled();
  });

  it('runMaxClaimGasProbe is gas-bound: applies lowered sponsor identity, gas budget, and dry-run', async () => {
    const ctx = makeCtx();
    const input = makeInput({ sponsorAddress: '0xBOUND_SPONSOR' });
    const runContext = __testingGenericPrepareBuildStages.createGenericPrepareBuildRunContext();

    const result = await __testingGenericPrepareBuildStages.runMaxClaimGasProbe(
      ctx,
      input,
      runContext,
    );

    expect(mockSetSender).toHaveBeenCalledWith(input.senderAddress);
    expect(mockSetGasOwner).toHaveBeenCalledWith('0xBOUND_SPONSOR');
    expect(mockSetGasBudget).toHaveBeenCalledWith(ctx.maxClaimMist);
    expect(mockBuild).toHaveBeenCalledTimes(1);
    expect(ctx.sui.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(result.baseCosts.executionCostClaim).toBe(3_000_000n);
    expect(result.pass1MidPrices).toEqual([27_000_000_000n]);
  });

  it('buildFinalGenericPrepareResult is gas-bound: final assembly sets sponsor gas owner and safe-builds txBytes', async () => {
    const ctx = makeCtx();
    const input = makeInput({ sponsorAddress: '0xFINAL_SPONSOR' });
    const runContext = __testingGenericPrepareBuildStages.createGenericPrepareBuildRunContext();
    const finalCosts = {
      simGas: 2_000_000n,
      grossGas: 2_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 3_000_000n,
    };

    const result = await __testingGenericPrepareBuildStages.buildFinalGenericPrepareResult(
      ctx,
      input,
      finalCosts,
      'swap',
      [27_000_000_000n],
      makeExecutableQuote({ executionGapMist: 0n }),
      runContext.rpcAcc,
      runContext.quoteCache,
    );

    expect(mockSetSender).toHaveBeenCalledWith(input.senderAddress);
    expect(mockSetGasOwner).toHaveBeenCalledWith('0xFINAL_SPONSOR');
    expect(mockSetGasBudget).toHaveBeenCalledWith(2_750_000n);
    expect(mockBuild).toHaveBeenCalledTimes(1);
    expect(ctx.sui.simulateTransaction).not.toHaveBeenCalled();
    expect(result.txBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.executionCostClaim).toBe(3_000_000n);
    expect(result.simGas).toBe(2_000_000n);
  });
});

// ─────────────────────────────────────────────
// Error classification coverage
// ─────────────────────────────────────────────

describe('runGenericPrepareBuildPipeline — error classification', () => {
  beforeEach(() => {
    resetBuildMocks();
  });

  // ── UNACCOUNTABLE_WITHDRAWAL: extractPrefixWithdrawals returns unaccountable ──
  it('throws UNACCOUNTABLE_WITHDRAWAL when extractPrefixWithdrawals returns unaccountable: true', async () => {
    mockExtractPrefixWithdrawals.mockReturnValueOnce({ total: 0n, unaccountable: true });
    const ctx = makeCtx();
    const input = makeInput({ credit: '0' });

    await expect(runGenericPrepareBuildPipeline(ctx, input)).rejects.toMatchObject({
      code: 'UNACCOUNTABLE_WITHDRAWAL',
    });
  });

  // ── safeBuild: InsufficientCoinBalance → INSUFFICIENT_BALANCE ─────────
  it('classifies InsufficientCoinBalance from tx.build() as INSUFFICIENT_BALANCE', async () => {
    mockBuild.mockRejectedValueOnce(
      new Error('Transaction resolution failed: InsufficientCoinBalance in command 1'),
    );
    const ctx = makeCtx();
    const input = makeInput({ profile: 'new_user', vaultObjectId: null, credit: '0' });

    await expect(runGenericPrepareBuildPipeline(ctx, input)).rejects.toThrow(
      PrepareValidationError,
    );
    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err) {
      // Reset mock before second call in case of test structure
    }
    // Verify the first call threw INSUFFICIENT_BALANCE
    mockBuild.mockRejectedValueOnce(
      new Error('Transaction resolution failed: InsufficientCoinBalance in command 1'),
    );
    try {
      await runGenericPrepareBuildPipeline(ctx, input);
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('INSUFFICIENT_BALANCE');
    }
  });

  // ── classifyDryRunFailure: InsufficientCoinBalance in dry-run ─────────
  it('classifies InsufficientCoinBalance in dry-run as INSUFFICIENT_BALANCE', async () => {
    const ctx = makeCtx({
      sui: {
        simulateTransaction: vi.fn().mockResolvedValue({
          FailedTransaction: {
            $kind: 'FailedTransaction',
            status: {
              error: { message: 'InsufficientCoinBalance in command 0' },
            },
          },
        }),
      } as unknown as BuildContext['sui'],
    });
    // Override to return FailedTransaction format
    (ctx.sui.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      $kind: 'FailedTransaction',
      FailedTransaction: {
        status: {
          error: { message: 'InsufficientCoinBalance in command 0' },
        },
      },
    });

    const input = makeInput({ profile: 'new_user', vaultObjectId: null, credit: '0' });

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('INSUFFICIENT_BALANCE');
    }
  });

  // ── classifyDryRunFailure: non-balance error stays DRY_RUN_FAILED ─────
  it('classifies non-balance dry-run error as DRY_RUN_FAILED', async () => {
    const ctx = makeCtx({
      sui: {
        simulateTransaction: vi.fn().mockResolvedValue({
          $kind: 'FailedTransaction',
          FailedTransaction: {
            status: {
              error: { message: 'MoveAbort in module foo' },
            },
          },
        }),
      } as unknown as BuildContext['sui'],
    });

    const input = makeInput();

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('DRY_RUN_FAILED');
    }
  });

  // ── safeBuild: address balance overflow → INSUFFICIENT_BALANCE ────────
  // This captures the underlying runtime failure when user prefix and
  // relayer suffix both request address-balance withdrawal and the combined amount exceeds the
  // available balance, Sui runtime rejects with "Available amount in
  // account for object id ... is less than requested: X < Y".
  // safeBuild must catch this and classify as INSUFFICIENT_BALANCE.
  it('classifies address-balance overflow from tx.build() as INSUFFICIENT_BALANCE', async () => {
    mockBuild.mockRejectedValueOnce(
      new Error(
        'Available amount in account for object id 0xabc is less than requested: 3000 < 8000',
      ),
    );
    const ctx = makeCtx();
    const input = makeInput();

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('INSUFFICIENT_BALANCE');
      expect((err as PrepareValidationError).message).toContain('Insufficient address balance');
    }
  });

  // ── safeBuild: non-balance error re-thrown as-is ──────────────────────
  it('re-throws non-balance tx.build() error as-is', async () => {
    mockBuild.mockRejectedValueOnce(new TypeError('Cannot read property of undefined'));
    const ctx = makeCtx();
    const input = makeInput();

    await expect(runGenericPrepareBuildPipeline(ctx, input)).rejects.toThrow(TypeError);
  });

  // ── safeBuild: DeepBook minOut abort 12 → SLIPPAGE_EXCEEDED ──────────
  it('classifies DeepBook abort 12 in tx.build() as SLIPPAGE_EXCEEDED', async () => {
    mockBuild.mockRejectedValueOnce(
      new Error(
        'Transaction resolution failed: MoveAbort in 5th command, abort code: 12, ' +
          "in '0xabc::pool::swap_exact_quantity' (instruction 165)",
      ),
    );
    const ctx = makeCtx();
    const input = makeInput();

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('SLIPPAGE_EXCEEDED');
    }
  });

  // ── safeBuild: Transaction resolution failed classified as DRY_RUN_FAILED ─
  it('classifies "Transaction resolution failed" in tx.build() as DRY_RUN_FAILED', async () => {
    mockBuild.mockRejectedValueOnce(
      new Error('Transaction resolution failed: some other abort reason'),
    );
    const ctx = makeCtx();
    const input = makeInput();

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('DRY_RUN_FAILED');
    }
  });

  // ── simulateTransaction returns no Transaction or FailedTransaction ────
  it('DRY_RUN_FAILED when simulateTransaction returns unexpected empty result', async () => {
    const ctx = makeCtx({
      sui: {
        simulateTransaction: vi.fn().mockResolvedValue({}), // no Transaction / FailedTransaction
      } as unknown as BuildContext['sui'],
    });
    const input = makeInput();

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('DRY_RUN_FAILED');
    }
  });

  // ── Transaction result with status.success === false ──────────────────
  it('DRY_RUN_FAILED when Transaction status.success is false (MoveAbort)', async () => {
    const ctx = makeCtx({
      sui: {
        simulateTransaction: vi.fn().mockResolvedValue({
          Transaction: {
            status: { success: false, error: { message: 'MoveAbort in settle' } },
            effects: {
              gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
            },
          },
        }),
      } as unknown as BuildContext['sui'],
    });
    const input = makeInput();

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('DRY_RUN_FAILED');
    }
  });

  it('SLIPPAGE_EXCEEDED when Transaction status.success is false (DeepBook abort 12)', async () => {
    const ctx = makeCtx({
      sui: {
        simulateTransaction: vi.fn().mockResolvedValue({
          Transaction: {
            status: {
              success: false,
              error: {
                message:
                  "Transaction resolution failed: MoveAbort in 5th command, abort code: 12, in '0xabc::pool::swap_exact_quantity' (instruction 165)",
              },
            },
            effects: {
              gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
            },
          },
        }),
      } as unknown as BuildContext['sui'],
    });
    const input = makeInput();

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('SLIPPAGE_EXCEEDED');
    }
  });

  // ── DRY_RUN_NO_GAS: gasUsed absent ───────────────────────────────────
  it('DRY_RUN_NO_GAS when gasUsed is missing from successful dry-run', async () => {
    const ctx = makeCtx({
      sui: {
        simulateTransaction: vi.fn().mockResolvedValue({
          Transaction: {
            status: { success: true },
            effects: {}, // no gasUsed
          },
        }),
      } as unknown as BuildContext['sui'],
    });
    const input = makeInput();

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('DRY_RUN_NO_GAS');
    }
  });

  // ── pass2 safeBuild: InsufficientCoinBalance ──────────────────────────
  it('INSUFFICIENT_BALANCE from pass2 safeBuild (pass1 succeeds, pass2 fails)', async () => {
    // pass1 build succeeds, then pass2 build fails with InsufficientCoinBalance
    mockBuild
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3])) // pass1 ok
      .mockRejectedValueOnce(
        new Error('Transaction resolution failed: InsufficientCoinBalance in command 2'),
      ); // pass2 fails

    const ctx = makeCtx();
    const input = makeInput();

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      expect((err as PrepareValidationError).code).toBe('INSUFFICIENT_BALANCE');
    }
  });

  // ── effective profile determination ─────────────────────────────────────

  it('profile: credit_general when vault credit covers the effective requirement', async () => {
    const ctx = makeCtx();
    const input = makeInput({ credit: '5000000' }); // 5M credit, settleProfile='credit_general'
    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 2_000_000n,
      grossGas: 2_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 3_000_000n, // zero fees and minSettle below claim: 3M <= 5M → credit path
    });

    const result = await runGenericPrepareBuildPipeline(ctx, input);
    expect(result.profile).toBe('credit_general');
  });

  it('profile: with_vault when vault credit cannot cover the effective requirement', async () => {
    const ctx = makeCtx();
    const input = makeInput({ credit: '1000000' }); // 1M credit, settleProfile='credit_general'
    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 2_000_000n,
      grossGas: 2_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 3_000_000n, // 3M > 1M → swap fallback, vault exists
    });

    const result = await runGenericPrepareBuildPipeline(ctx, input);
    expect(result.profile).toBe('with_vault');
  });

  it('profile: new_user when vaultObjectId is null', async () => {
    const ctx = makeCtx();
    const input = makeInput({ profile: 'new_user', vaultObjectId: null, credit: '0' });
    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 2_000_000n,
      grossGas: 2_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 3_000_000n,
    });

    const result = await runGenericPrepareBuildPipeline(ctx, input);
    expect(result.profile).toBe('new_user');
  });

  // Defensive: runGenericPrepareBuildPipeline must respect settleProfile='new_user' even if vaultObjectId is present.
  // Since fail-closed hardening, queryUserCredit throws on this state, but build must remain
  // safe if called with an unexpected input combination.
  it('profile: new_user when profile=new_user even if vaultObjectId is present', async () => {
    const ctx = makeCtx();
    // Defensive: build.ts treats profile as authoritative regardless of vaultObjectId presence
    const input = makeInput({ profile: 'new_user', vaultObjectId: 'vault-id-123', credit: '0' });
    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 2_000_000n,
      grossGas: 2_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 3_000_000n,
    });

    const result = await runGenericPrepareBuildPipeline(ctx, input);
    // build.ts:329: (input.profile === 'new_user' || !input.vaultObjectId) → 'new_user'
    expect(result.profile).toBe('new_user');
  });

  // ── credit >= executionCostClaim but < minSettleMist → swap path ────────────

  it('credit >= executionCostClaim but < minSettleMist → falls through to swap (with_vault)', async () => {
    // executionCostClaim=3M (from default mock), credit=5M >= executionCostClaim but < minSettle=20M
    const ctx = makeCtx({ minSettleMist: 20_000_000n });
    const input = makeInput({
      profile: 'credit_general',
      vaultObjectId: '0xVAULT',
      credit: '5000000', // 5M MIST — above executionCostClaim(3M), below minSettle(20M)
    });

    const result = await runGenericPrepareBuildPipeline(ctx, input);

    // Must NOT use credit-only path (would abort 102).
    // Must use swap+vault path instead.
    expect(mockBuildSettleWithCreditPtb).not.toHaveBeenCalled();
    expect(mockBuildSwapAndSettlePtb).toHaveBeenCalled();
    const call = mockBuildSwapAndSettlePtb.mock.calls[0];
    expect(call[1].variant).toBe('with_vault');
    // Existing credit still applied on-chain via useCreditAmount
    expect(call[1].useCreditAmount).toBe(5_000_000n);
    expect(result.profile).toBe('with_vault');
  });

  // ── non-zero fees affect credit viability ─────────────────────────────
  // total credit needed is max(executionCostClaim + quoted + protocol, minSettle)
  // because settle.move deducts
  // execution_cost_claim_mist + quoted_host_fee_mist + protocol_fee.

  it('credit >= executionCostClaim but < executionCostClaim+fees → falls through to swap', async () => {
    // executionCostClaim=3M, quoted=1M, protocol=500K → totalNeeded=4.5M
    // credit=4M > executionCostClaim(3M) but < totalNeeded(4.5M) → swap
    const ctx = makeCtx({
      quotedHostFeeMist: 1_000_000n,
      protocolFlatFeeMist: 500_000n,
    });
    const input = makeInput({
      profile: 'credit_general',
      vaultObjectId: '0xVAULT',
      credit: '4000000', // 4M MIST
    });

    const result = await runGenericPrepareBuildPipeline(ctx, input);

    expect(mockBuildSettleWithCreditPtb).toHaveBeenCalledTimes(1);
    expect(mockBuildSwapAndSettlePtb).toHaveBeenCalled();
    expect(result.profile).toBe('with_vault');
  });

  it('credit >= executionCostClaim+fees → credit path with correct useCreditAmount', async () => {
    // executionCostClaim=3M, quoted=1M, protocol=500K → totalNeeded=4.5M
    // credit=5M >= totalNeeded(4.5M) → measured credit path
    // effectiveCredit = max(4.5M, 100K minSettle) = 4.5M
    //
    // Note: the pre-swap credit probe uses a credit-safe seed, then pass2
    // rebuilds with the measured executionCostClaim=3M. Both credit builders are
    // called because measurement and final assembly are separate PTBs.
    const ctx = makeCtx({
      quotedHostFeeMist: 1_000_000n,
      protocolFlatFeeMist: 500_000n,
    });
    const input = makeInput({
      profile: 'credit_general',
      vaultObjectId: '0xVAULT',
      credit: '5000000', // 5M MIST
    });

    const result = await runGenericPrepareBuildPipeline(ctx, input);

    // Pass2 result: credit path wins because actual executionCostClaim+fees=4.5M <= 5M credit
    expect(mockBuildSettleWithCreditPtb).toHaveBeenCalled();
    expect(result.profile).toBe('credit_general');
    // useCreditAmount = effectiveCredit = max(3M+1M+0.5M, 100K) = 4.5M
    const call =
      mockBuildSettleWithCreditPtb.mock.calls[mockBuildSettleWithCreditPtb.mock.calls.length - 1];
    expect(call[1].useCreditAmount).toBe(4_500_000n);
  });

  // ── safeBuild: MoveAbort 102 from settle → INSUFFICIENT_SETTLE_INPUT ──

  it('CLAIM_WOULD_EXCEED_MAX from pass1 safeBuild (MoveAbort settle 101)', async () => {
    mockBuild.mockRejectedValueOnce(new Error('MoveAbort(0xabc::settle, 101) in command 5'));

    const ctx = makeCtx({ maxClaimMist: 50_000_000n });
    const input = makeInput({ profile: 'new_user', vaultObjectId: null, credit: '0' });

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      const e = err as PrepareValidationError;
      expect(e.code).toBe('CLAIM_WOULD_EXCEED_MAX');
    }
  });

  it('CLAIM_WOULD_EXCEED_MAX from pass1 dry-run (settle 101 in simulation)', async () => {
    const ctx = makeCtx({
      sui: {
        simulateTransaction: vi.fn().mockResolvedValue({
          Transaction: {
            status: {
              success: false,
              error: {
                message: 'MoveAbort(0xabc::settle::settle_core, 101) in command 4',
              },
            },
            effects: {
              gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
            },
          },
        }),
      } as unknown as BuildContext['sui'],
      maxClaimMist: 50_000_000n,
    });
    const input = makeInput({ profile: 'new_user', vaultObjectId: null, credit: '0' });

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      const e = err as PrepareValidationError;
      expect(e.code).toBe('CLAIM_WOULD_EXCEED_MAX');
    }
  });

  it('INSUFFICIENT_SETTLE_INPUT from pass1 safeBuild (MoveAbort settle 102)', async () => {
    mockBuild.mockRejectedValueOnce(new Error('MoveAbort(0xabc::settle, 102) in command 5'));

    const ctx = makeCtx({
      minSettleMist: 100_000n,
      protocolFlatFeeMist: 10_000n,
    });
    const input = makeInput({ profile: 'new_user', vaultObjectId: null, credit: '0' });

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      const e = err as PrepareValidationError;
      expect(e.code).toBe('INSUFFICIENT_SETTLE_INPUT');
      expect(e.meta).toBeDefined();
      expect(e.meta!.isEstimate).toBe('true'); // pass1 = estimate
      expect(e.meta!.minSettleMist).toBeDefined();
    }
  });

  it('INSUFFICIENT_SETTLE_INPUT from pass2 safeBuild (MoveAbort settle 102)', async () => {
    // pass1 build succeeds, then pass2 build fails with settle 102
    mockBuild
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3])) // pass1 ok
      .mockRejectedValueOnce(new Error('MoveAbort(0xabc::settle, 102) in command 7')); // pass2 fails

    const ctx = makeCtx({
      minSettleMist: 100_000n,
      protocolFlatFeeMist: 10_000n,
    });
    const input = makeInput();

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      const e = err as PrepareValidationError;
      expect(e.code).toBe('INSUFFICIENT_SETTLE_INPUT');
      expect(e.meta).toBeDefined();
      expect(e.meta!.isEstimate).toBe('false'); // pass2 = confirmed
    }
  });

  it('INSUFFICIENT_SETTLE_INPUT from pass1 dry-run (settle 102 in simulation)', async () => {
    const ctx = makeCtx({
      sui: {
        simulateTransaction: vi.fn().mockResolvedValue({
          Transaction: {
            status: {
              success: false,
              error: {
                message: 'MoveAbort(0xabc::settle::execute_settle, 102) in command 4',
              },
            },
            effects: {
              gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
            },
          },
        }),
      } as unknown as BuildContext['sui'],
      minSettleMist: 100_000n,
      protocolFlatFeeMist: 10_000n,
    });
    const input = makeInput({ profile: 'new_user', vaultObjectId: null, credit: '0' });

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      const e = err as PrepareValidationError;
      expect(e.code).toBe('INSUFFICIENT_SETTLE_INPUT');
      expect(e.meta).toBeDefined();
      expect(e.meta!.isEstimate).toBe('true');
    }
  });

  // ── safeBuild: MoveAbort 110 from settle → SPREAD_EXCEEDED ────────────

  it('SPREAD_EXCEEDED from pass1 safeBuild (MoveAbort settle 110)', async () => {
    mockBuild.mockRejectedValueOnce(new Error('MoveAbort(0xabc::settle, 110) in command 5'));

    const ctx = makeCtx();
    const input = makeInput();

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      const e = err as PrepareValidationError;
      expect(e.code).toBe('SPREAD_EXCEEDED');
    }
  });

  it('SPREAD_EXCEEDED from pass2 safeBuild (MoveAbort settle 110)', async () => {
    mockBuild
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3])) // pass1 ok
      .mockRejectedValueOnce(new Error('MoveAbort(0xabc::settle, 110) in command 7')); // pass2 fails

    const ctx = makeCtx();
    const input = makeInput();

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      const e = err as PrepareValidationError;
      expect(e.code).toBe('SPREAD_EXCEEDED');
    }
  });

  it('SPREAD_EXCEEDED from pass1 dry-run (settle 110 in simulation)', async () => {
    const ctx = makeCtx({
      sui: {
        simulateTransaction: vi.fn().mockResolvedValue({
          Transaction: {
            status: {
              success: false,
              error: {
                message: 'MoveAbort(0xabc::settle::assert_spread_ok, 110) in command 4',
              },
            },
            effects: {
              gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
            },
          },
        }),
      } as unknown as BuildContext['sui'],
    });
    const input = makeInput();

    try {
      await runGenericPrepareBuildPipeline(ctx, input);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      const e = err as PrepareValidationError;
      expect(e.code).toBe('SPREAD_EXCEEDED');
    }
  });

  it('throws CLAIM_WOULD_EXCEED_MAX before pass2 build when computed claim exceeds max', async () => {
    const ctx = makeCtx({ maxClaimMist: 50_000_000n });
    const input = makeInput({
      profile: 'credit_general',
      vaultObjectId: '0xVAULT',
      credit: '1000000000',
    });

    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 50_000_000n,
      grossGas: 50_100_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 50_100_000n,
    });

    const err = await runGenericPrepareBuildPipeline(ctx, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrepareValidationError);
    expect((err as PrepareValidationError).code).toBe('CLAIM_WOULD_EXCEED_MAX');
    expect((err as PrepareValidationError).meta?.maxClaimMist).toBe('50000000');
    // pass1 build attempted, pass2 build blocked by explicit boundary check.
    expect(mockBuild).toHaveBeenCalledTimes(1);
  });
});

// ── isTotalInTooLow regex unit tests ────────────────────────────────────────

import { isTotalInTooLow } from '../src/prepare/prepareErrors.js';
import { isClaimTooHigh } from '../src/prepare/prepareErrors.js';

// Package-bound classifier fixtures: every classifier and `isXxx` helper
// takes an explicit trusted Stelis / DeepBook package ID. Positive tests
// match the trusted ID against the regex fixture under test. Negative
// tests use a different "external" package ID (`0xdef`) inline in the
// fixture string to prove non-Stelis / non-DeepBook aborts do not
// classify.
const TRUSTED_STELIS_PKG = '0xabc';
const TRUSTED_STELIS_PKG_LONG = '0xabc123';
const TRUSTED_DEEPBOOK_PKG = '0xabc';

describe('isClaimTooHigh — regex coverage', () => {
  it('matches MoveAbort(0x…::settle, 101)', () => {
    expect(
      isClaimTooHigh('MoveAbort(0xabc123::settle, 101) in command 5', TRUSTED_STELIS_PKG_LONG),
    ).toBe(true);
  });

  it('matches "abort code" phrasing', () => {
    expect(isClaimTooHigh('abort code 101 in module 0xabc::settle::fn', TRUSTED_STELIS_PKG)).toBe(
      true,
    );
  });

  it('does NOT match settle with non-101 abort code', () => {
    expect(isClaimTooHigh('MoveAbort(0xabc::settle, 102) in command 5', TRUSTED_STELIS_PKG)).toBe(
      false,
    );
  });

  it('does NOT match 101 without settle', () => {
    expect(isClaimTooHigh('MoveAbort(0xabc::vault, 101) in command 5', TRUSTED_STELIS_PKG)).toBe(
      false,
    );
  });

  // Negative: external package with the same module + abort code does
  // not classify — package ID is not the trusted Stelis ID.
  it('does NOT match non-Stelis package', () => {
    expect(isClaimTooHigh('MoveAbort(0xdef::settle, 101) in command 5', TRUSTED_STELIS_PKG)).toBe(
      false,
    );
  });
});

describe('isTotalInTooLow — regex coverage', () => {
  it('matches MoveAbort(0x…::settle, 102)', () => {
    expect(
      isTotalInTooLow('MoveAbort(0xabc123::settle, 102) in command 5', TRUSTED_STELIS_PKG_LONG),
    ).toBe(true);
  });

  it('matches MoveAbort with ::settle:: (function path)', () => {
    expect(
      isTotalInTooLow(
        'MoveAbort(0xabc::settle::execute_settle, 102) in command 4',
        TRUSTED_STELIS_PKG,
      ),
    ).toBe(true);
  });

  it('matches "abort code" phrasing', () => {
    expect(isTotalInTooLow('abort code 102 in module 0xabc::settle::fn', TRUSTED_STELIS_PKG)).toBe(
      true,
    );
  });

  it('does NOT match MoveAbort in non-settle module', () => {
    expect(isTotalInTooLow('MoveAbort(0xabc::swap, 102) in command 3', TRUSTED_STELIS_PKG)).toBe(
      false,
    );
  });

  it('does NOT match settle with non-102 abort code', () => {
    expect(isTotalInTooLow('MoveAbort(0xabc::settle, 103) in command 5', TRUSTED_STELIS_PKG)).toBe(
      false,
    );
  });

  it('does NOT match 102 without settle', () => {
    expect(isTotalInTooLow('MoveAbort(0xabc::vault, 102) in command 5', TRUSTED_STELIS_PKG)).toBe(
      false,
    );
  });

  it('does NOT match settle without 102 or MoveAbort', () => {
    expect(isTotalInTooLow('Some error in ::settle:: module', TRUSTED_STELIS_PKG)).toBe(false);
  });

  // Negative: external package settle 102 does not classify.
  it('does NOT match non-Stelis package', () => {
    expect(isTotalInTooLow('MoveAbort(0xdef::settle, 102) in command 5', TRUSTED_STELIS_PKG)).toBe(
      false,
    );
  });
});

// ── isSpreadTooWide regex unit tests ────────────────────────────────────────

import { isSpreadTooWide } from '../src/prepare/prepareErrors.js';

describe('isSpreadTooWide — regex coverage', () => {
  it('matches MoveAbort(0x…::settle, 110)', () => {
    expect(
      isSpreadTooWide('MoveAbort(0xabc123::settle, 110) in command 5', TRUSTED_STELIS_PKG_LONG),
    ).toBe(true);
  });

  it('matches MoveAbort with ::settle:: (function path)', () => {
    expect(
      isSpreadTooWide(
        'MoveAbort(0xabc::settle::assert_spread_ok, 110) in command 4',
        TRUSTED_STELIS_PKG,
      ),
    ).toBe(true);
  });

  it('matches "abort code" phrasing', () => {
    expect(isSpreadTooWide('abort code 110 in module 0xabc::settle::fn', TRUSTED_STELIS_PKG)).toBe(
      true,
    );
  });

  it('does NOT match MoveAbort in non-settle module', () => {
    expect(isSpreadTooWide('MoveAbort(0xabc::swap, 110) in command 3', TRUSTED_STELIS_PKG)).toBe(
      false,
    );
  });

  it('does NOT match settle with non-110 abort code', () => {
    expect(isSpreadTooWide('MoveAbort(0xabc::settle, 102) in command 5', TRUSTED_STELIS_PKG)).toBe(
      false,
    );
  });

  it('does NOT match 110 without settle', () => {
    expect(isSpreadTooWide('MoveAbort(0xabc::vault, 110) in command 5', TRUSTED_STELIS_PKG)).toBe(
      false,
    );
  });

  it('does NOT match settle without 110 or MoveAbort', () => {
    expect(isSpreadTooWide('Some error in ::settle:: module', TRUSTED_STELIS_PKG)).toBe(false);
  });

  // Negative: external package settle 110 does not classify.
  it('does NOT match non-Stelis package', () => {
    expect(isSpreadTooWide('MoveAbort(0xdef::settle, 110) in command 5', TRUSTED_STELIS_PKG)).toBe(
      false,
    );
  });
});

// ── isDeepbookMinOutNotMet regex unit tests ────────────────────────────────

import { isDeepbookMinOutNotMet } from '../src/prepare/prepareErrors.js';

describe('isDeepbookMinOutNotMet — regex coverage', () => {
  it('matches swap_exact_quantity abort code 12', () => {
    expect(
      isDeepbookMinOutNotMet(
        "Transaction resolution failed: MoveAbort in 5th command, abort code: 12, in '0xabc::pool::swap_exact_quantity' (instruction 165)",
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBe(true);
  });

  it('does NOT match swap_exact_quantity with non-12 code', () => {
    expect(
      isDeepbookMinOutNotMet(
        "Transaction resolution failed: MoveAbort in 5th command, abort code: 11, in '0xabc::pool::swap_exact_quantity' (instruction 165)",
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBe(false);
  });

  it('does NOT match abort 12 from non-swap_exact_quantity path', () => {
    expect(
      isDeepbookMinOutNotMet(
        'MoveAbort(0xabc::pool::some_other_fn, 12) in command 3',
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBe(false);
  });

  // Negative: external package's `pool::swap_exact_quantity` abort 12
  // does not classify into `SLIPPAGE_EXCEEDED`.
  it('does NOT match non-DeepBook package', () => {
    expect(
      isDeepbookMinOutNotMet(
        "Transaction resolution failed: MoveAbort in 5th command, abort code: 12, in '0xdef::pool::swap_exact_quantity' (instruction 165)",
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBe(false);
  });
});

// ── isPaused regex unit tests ─────────────────────────────────────────────

import { isPaused } from '../src/prepare/prepareErrors.js';

describe('isPaused — regex coverage', () => {
  it('matches MoveAbort(0x…::settle, 100)', () => {
    expect(isPaused('MoveAbort(0xabc123::settle, 100) in command 5', TRUSTED_STELIS_PKG_LONG)).toBe(
      true,
    );
  });

  it('matches "abort code" phrasing', () => {
    expect(isPaused('abort code 100 in module 0xabc::settle::fn', TRUSTED_STELIS_PKG)).toBe(true);
  });

  it('does NOT match settle with non-100 abort code', () => {
    expect(isPaused('MoveAbort(0xabc::settle, 101) in command 5', TRUSTED_STELIS_PKG)).toBe(false);
  });

  it('does NOT match 100 without settle', () => {
    expect(isPaused('MoveAbort(0xabc::vault, 100) in command 5', TRUSTED_STELIS_PKG)).toBe(false);
  });

  // Negative: external package settle 100 does not classify.
  it('does NOT match non-Stelis package', () => {
    expect(isPaused('MoveAbort(0xdef::settle, 100) in command 5', TRUSTED_STELIS_PKG)).toBe(false);
  });
});

// ── isVaultAlreadyRegistered regex unit tests ─────────────────────────────

import { isVaultAlreadyRegistered } from '../src/prepare/prepareErrors.js';

describe('isVaultAlreadyRegistered — regex coverage', () => {
  it('matches MoveAbort(0x…::vault, 2)', () => {
    expect(
      isVaultAlreadyRegistered(
        'MoveAbort(0xabc123::vault, 2) in command 5',
        TRUSTED_STELIS_PKG_LONG,
      ),
    ).toBe(true);
  });

  it('matches MoveAbort with ::vault:: (function path)', () => {
    expect(
      isVaultAlreadyRegistered(
        'MoveAbort(0xabc::vault::register, 2) in command 4',
        TRUSTED_STELIS_PKG,
      ),
    ).toBe(true);
  });

  it('matches "abort code" phrasing', () => {
    expect(
      isVaultAlreadyRegistered('abort code 2 in module 0xabc::vault::fn', TRUSTED_STELIS_PKG),
    ).toBe(true);
  });

  it('does NOT match vault with non-2 abort code', () => {
    expect(
      isVaultAlreadyRegistered('MoveAbort(0xabc::vault, 3) in command 5', TRUSTED_STELIS_PKG),
    ).toBe(false);
  });

  it('does NOT match 2 without vault', () => {
    expect(
      isVaultAlreadyRegistered('MoveAbort(0xabc::settle, 2) in command 5', TRUSTED_STELIS_PKG),
    ).toBe(false);
  });

  // Negative: external package vault 2 does not classify.
  it('does NOT match non-Stelis package', () => {
    expect(
      isVaultAlreadyRegistered('MoveAbort(0xdef::vault, 2) in command 5', TRUSTED_STELIS_PKG),
    ).toBe(false);
  });
});

// ── isReplayNonce regex unit tests ────────────────────────────────────────

import { isReplayNonce } from '../src/prepare/prepareErrors.js';

describe('isReplayNonce — regex coverage', () => {
  it('matches MoveAbort(0x…::vault, 1)', () => {
    expect(
      isReplayNonce('MoveAbort(0xabc123::vault, 1) in command 5', TRUSTED_STELIS_PKG_LONG),
    ).toBe(true);
  });

  it('matches MoveAbort with ::vault:: (function path)', () => {
    expect(
      isReplayNonce(
        'MoveAbort(0xabc::vault::check_and_advance_nonce, 1) in command 4',
        TRUSTED_STELIS_PKG,
      ),
    ).toBe(true);
  });

  it('matches "abort code" phrasing', () => {
    expect(isReplayNonce('abort code 1 in module 0xabc::vault::fn', TRUSTED_STELIS_PKG)).toBe(true);
  });

  it('does NOT match vault with non-1 abort code', () => {
    expect(isReplayNonce('MoveAbort(0xabc::vault, 2) in command 5', TRUSTED_STELIS_PKG)).toBe(
      false,
    );
  });

  it('does NOT match 1 without vault', () => {
    expect(isReplayNonce('MoveAbort(0xabc::settle, 1) in command 5', TRUSTED_STELIS_PKG)).toBe(
      false,
    );
  });

  // Negative: external package vault 1 does not classify.
  it('does NOT match non-Stelis package', () => {
    expect(
      isReplayNonce(
        'MoveAbort(0xdef::vault::check_and_advance_nonce, 1) in command 5',
        TRUSTED_STELIS_PKG,
      ),
    ).toBe(false);
  });
});

// ── classifySponsorFailureSubcode — subcode routing ──────────────────────

import { classifySponsorFailureSubcode } from '../src/prepare/prepareErrors.js';

describe('classifySponsorFailureSubcode — subcode routing', () => {
  it('classifies settle EPaused into PAUSED', () => {
    expect(
      classifySponsorFailureSubcode(
        'MoveAbort(0xabc::settle, 100) in command 2',
        TRUSTED_STELIS_PKG,
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBe('PAUSED');
  });

  it('classifies vault EVaultAlreadyRegistered into VAULT_ALREADY_REGISTERED', () => {
    expect(
      classifySponsorFailureSubcode(
        'MoveAbort(0xabc::vault, 2) in command 3',
        TRUSTED_STELIS_PKG,
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBe('VAULT_ALREADY_REGISTERED');
  });

  // S-14 monotonic-nonce out-of-order execution (EReplayNonce) classification.
  // Required for the address-revert carve-out so a sender that races two
  // concurrent prepares does not self-block when the loser's prepared nonce
  // settles after the winner's.
  it('classifies vault EReplayNonce into REPLAY_NONCE', () => {
    expect(
      classifySponsorFailureSubcode(
        'MoveAbort(0xabc::vault, 1) in command 3',
        TRUSTED_STELIS_PKG,
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBe('REPLAY_NONCE');
  });

  // Locks the server-side link of the server-to-SDK exhaustion normalization
  // chain:
  //   MoveAbort settle 103 (EInsufficientFunds, S-4 non-loss assert)
  //   → classifySponsorFailureSubcode === 'INSUFFICIENT_FUNDS'
  //   → SponsorPreflightError/SponsorOnchainError carries this subcode
  //   → SDK normalizeApiError maps to code 'INSUFFICIENT_FUNDS' (locked in the
  //     SDK preflight + onchain subcode tests in executeSponsored.test.ts).
  // Without this lock, a regex/rename break in isInsufficientFunds would route
  // EInsufficientFunds back into the generic SPONSOR_*_FAILED → EXECUTION_FAILED
  // path silently.
  it('classifies settle EInsufficientFunds into INSUFFICIENT_FUNDS', () => {
    expect(
      classifySponsorFailureSubcode(
        'MoveAbort(0xabc::settle, 103) in command 4',
        TRUSTED_STELIS_PKG,
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBe('INSUFFICIENT_FUNDS');
  });

  // Package binding for Stelis classifications.
  it('does NOT classify non-Stelis vault aborts into Stelis subcodes', () => {
    expect(
      classifySponsorFailureSubcode(
        'MoveAbort(0xdef::vault::check_and_advance_nonce, 1) in command 0',
        TRUSTED_STELIS_PKG,
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBeUndefined();
    expect(
      classifySponsorFailureSubcode(
        'MoveAbort(0xdef::settle, 100) in command 2',
        TRUSTED_STELIS_PKG,
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBeUndefined();
  });

  // Package binding for DeepBook classification — external package
  // matching `pool::swap_exact_quantity` does not become `SLIPPAGE_EXCEEDED`.
  it('does NOT classify non-DeepBook pool aborts into SLIPPAGE_EXCEEDED', () => {
    expect(
      classifySponsorFailureSubcode(
        "Transaction resolution failed: MoveAbort in 5th command, abort code: 12, in '0xdef::pool::swap_exact_quantity' (instruction 165)",
        TRUSTED_STELIS_PKG,
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBeUndefined();
  });

  // Trusted DeepBook abort still classifies.
  it('classifies trusted DeepBook pool::swap_exact_quantity 12 into SLIPPAGE_EXCEEDED', () => {
    expect(
      classifySponsorFailureSubcode(
        "Transaction resolution failed: MoveAbort in 5th command, abort code: 12, in '0xabc::pool::swap_exact_quantity' (instruction 165)",
        TRUSTED_STELIS_PKG,
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBe('SLIPPAGE_EXCEEDED');
  });
});

// ── Abort-code position binding ──────────────────────────────────────────
//
// The classifier reads the numeric code from its actual abort-code
// position. Free-floating numeric tokens like `command N`, `Nth command`,
// or `(instruction N)` cannot satisfy a low-numbered abort code, even
// when the trusted package + module substring are present.

describe('classifySponsorFailureSubcode — abort-code position binding', () => {
  // EVaultAlreadyRegistered (code 2) abort with `command 1` elsewhere in
  // the string must classify by the abort-tuple code (2), not the command
  // index (1).
  it('classifies vault 2 as VAULT_ALREADY_REGISTERED even when string contains "command 1"', () => {
    expect(
      classifySponsorFailureSubcode(
        'MoveAbort(0xabc::vault, 2) in command 1',
        TRUSTED_STELIS_PKG,
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBe('VAULT_ALREADY_REGISTERED');
  });

  // EReplayNonce (code 1) abort with `command 2` elsewhere in the string
  // must classify by the abort-tuple code (1), not the command index (2).
  it('classifies vault 1 as REPLAY_NONCE even when string contains "command 2"', () => {
    expect(
      classifySponsorFailureSubcode(
        'MoveAbort(0xabc::vault, 1) in command 2',
        TRUSTED_STELIS_PKG,
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBe('REPLAY_NONCE');
  });

  // settle EClaimTooHigh (code 101) abort with `command 100` elsewhere in
  // the string must classify by the abort-tuple code (101), not the
  // command index (100).
  it('classifies settle 101 as CLAIM_WOULD_EXCEED_MAX even when string contains "command 100"', () => {
    expect(
      classifySponsorFailureSubcode(
        'MoveAbort(0xabc::settle, 101) in command 100',
        TRUSTED_STELIS_PKG,
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBe('CLAIM_WOULD_EXCEED_MAX');
  });

  // DeepBook real abort code 11 with `(instruction 12)` elsewhere in the
  // string must not classify as SLIPPAGE_EXCEEDED (which expects code 12
  // at the abort-code position).
  it('does NOT classify trusted DeepBook code 11 as SLIPPAGE_EXCEEDED via "(instruction 12)"', () => {
    expect(
      classifySponsorFailureSubcode(
        "Transaction resolution failed: MoveAbort in 5th command, abort code: 11, in '0xabc::pool::swap_exact_quantity' (instruction 12)",
        TRUSTED_STELIS_PKG,
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBeUndefined();
  });

  // Trusted package + vault module substring with the only `1`
  // appearing as `command 1` index — no abort-tuple form and no
  // `abort code` keyword. Must not classify.
  it('does NOT classify "command 1" + vault substring as REPLAY_NONCE without abort-code position', () => {
    expect(
      classifySponsorFailureSubcode(
        'Transaction resolution failed in command 1 referencing 0xabc::vault::check_and_advance_nonce — internal error',
        TRUSTED_STELIS_PKG,
        TRUSTED_DEEPBOOK_PKG,
      ),
    ).toBeUndefined();
  });
});

// ── Slippage error paths ────────────────────────────────────────────────────

describe('runGenericPrepareBuildPipeline — slippage error paths', () => {
  beforeEach(() => {
    resetBuildMocks();
  });

  // Force swap path: new_user with no credit/vault
  const swapInput = () =>
    makeInput({
      profile: 'new_user',
      vaultObjectId: undefined,
      credit: '0',
    });

  it('throws SLIPPAGE_QUERY_FAILED when midPrice is null (0n)', async () => {
    const ctx = makeCtx();
    const input = swapInput();

    // midPrice null → batchGetHopMidPrices returns [0n]
    mockBatchGetHopMidPrices.mockResolvedValue([0n]);
    const { MarketQuoteUnavailableError: MQE } = await import('@stelis/core-relay/server');
    mockSolveExecutableSwap.mockRejectedValue(new MQE('Mid-price unavailable (empty orderbook)'));

    await expect(runGenericPrepareBuildPipeline(ctx, input)).rejects.toThrow(
      expect.objectContaining({ code: 'SLIPPAGE_QUERY_FAILED' }),
    );
  });

  it('throws SLIPPAGE_QUERY_FAILED with RPC message when batchGetHopMidPrices throws SlippageQueryError', async () => {
    const ctx = makeCtx();
    const input = swapInput();

    const { SlippageQueryError: SQE } = await import('@stelis/core-relay');
    mockBatchGetHopMidPrices.mockRejectedValue(new SQE('simulateTransaction failed: RPC timeout'));

    const err = await runGenericPrepareBuildPipeline(ctx, input).catch((e: unknown) => e);
    expect(err).toEqual(expect.objectContaining({ code: 'SLIPPAGE_QUERY_FAILED' }));
    expect((err as PrepareValidationError).meta?.stage).toBe('mid_price_collection');
    // Message must include query-failure context (not "empty orderbook")
    expect((err as Error).message).toContain('Mid-price query failed');
    expect((err as Error).message).toContain('RPC timeout');
  });

  it('throws SLIPPAGE_QUERY_FAILED when solveExecutableSwap throws MarketQuoteUnavailableError', async () => {
    const ctx = makeCtx();
    const input = swapInput();

    mockBatchGetHopMidPrices.mockResolvedValue([27_000_000_000n]);
    const { MarketQuoteUnavailableError: MQE } = await import('@stelis/core-relay/server');
    mockSolveExecutableSwap.mockRejectedValue(new MQE('RPC timeout'));

    await expect(runGenericPrepareBuildPipeline(ctx, input)).rejects.toThrow(
      expect.objectContaining({ code: 'SLIPPAGE_QUERY_FAILED' }),
    );
  });

  it('throws SLIPPAGE_EXCEEDED when solveExecutableSwap throws ExecutionGapExceededError', async () => {
    const ctx = makeCtx();
    const input = swapInput();

    mockBatchGetHopMidPrices.mockResolvedValue([27_000_000_000n]);
    const { ExecutionGapExceededError: EGE } = await import('@stelis/core-relay/server');
    mockSolveExecutableSwap.mockRejectedValue(new EGE('Exceeds cap'));

    await expect(runGenericPrepareBuildPipeline(ctx, input)).rejects.toThrow(
      expect.objectContaining({ code: 'SLIPPAGE_EXCEEDED' }),
    );
  });

  it('throws SLIPPAGE_CONVERGENCE_FAILED when buffer0=0n and increased final input has residual>0n', async () => {
    const ctx = makeCtx();
    const input = swapInput();

    mockBatchGetHopMidPrices.mockResolvedValue([27_000_000_000n]);
    // Call order: pass1 solve (cap disabled) -> pass1.5 solve -> pass2 solve.
    mockSolveExecutableSwap
      .mockResolvedValueOnce({
        swapAmountSmallest: 1_000_000n,
        targetOutputMist: 27_000_000n,
        effectiveTargetOutputMist: 27_000_000n,
        quotedHopOutputs: [27_000_000n],
        rawMidPrices: [27_000_000_000n],
        idealOutputMist: 27_000_000n,
        actualOutputMist: 27_000_000n,
        executionGapMist: 0n,
        executionGapBps: 0n,
      })
      .mockResolvedValueOnce({
        swapAmountSmallest: 1_000_000n,
        targetOutputMist: 27_000_000n,
        effectiveTargetOutputMist: 27_000_000n,
        quotedHopOutputs: [27_000_000n],
        rawMidPrices: [27_000_000_000n],
        idealOutputMist: 27_000_000n,
        actualOutputMist: 27_000_000n,
        executionGapMist: 0n,
        executionGapBps: 0n,
      })
      .mockResolvedValueOnce({
        swapAmountSmallest: 2_000_000n,
        targetOutputMist: 54_000_000n,
        effectiveTargetOutputMist: 54_000_000n,
        quotedHopOutputs: [53_999_000n],
        rawMidPrices: [27_000_000_000n],
        idealOutputMist: 54_000_000n,
        actualOutputMist: 53_999_000n,
        executionGapMist: 1_000n,
        executionGapBps: 0n,
      });

    // Force swapFinal > swap0 via computeExecutionCostClaim returning higher claim on second call
    mockComputeExecutionCostClaim
      .mockReturnValueOnce({
        simGas: 2_000_000n,
        grossGas: 2_500_000n,
        gasVarianceFixedMist: 100_000n,
        slippageBufferMist: 0n,
        executionCostClaim: 3_000_000n,
      })
      .mockReturnValueOnce({
        simGas: 2_000_000n,
        grossGas: 2_500_000n,
        gasVarianceFixedMist: 100_000n,
        slippageBufferMist: 0n,
        executionCostClaim: 4_000_000n, // higher → swapFinal > swap0
      });

    await expect(runGenericPrepareBuildPipeline(ctx, input)).rejects.toThrow(
      expect.objectContaining({ code: 'SLIPPAGE_CONVERGENCE_FAILED' }),
    );
  });

  it('throws SLIPPAGE_CONVERGENCE_FAILED when equal final input has higher residual gap', async () => {
    const ctx = makeCtx();
    const input = swapInput();

    mockBatchGetHopMidPrices.mockResolvedValue([27_000_000_000n]);
    // Call order: pass1 solve (cap disabled) -> pass1.5 solve -> pass2 solve.
    mockSolveExecutableSwap
      .mockResolvedValueOnce({
        swapAmountSmallest: 1_000_000n,
        targetOutputMist: 27_000_000n,
        effectiveTargetOutputMist: 27_000_000n,
        quotedHopOutputs: [27_000_000n],
        rawMidPrices: [27_000_000_000n],
        idealOutputMist: 27_000_000n,
        actualOutputMist: 27_000_000n,
        executionGapMist: 0n,
        executionGapBps: 0n,
      })
      .mockResolvedValueOnce({
        swapAmountSmallest: 1_000_000n,
        targetOutputMist: 27_000_000n,
        effectiveTargetOutputMist: 27_000_000n,
        quotedHopOutputs: [27_000_000n],
        rawMidPrices: [27_000_000_000n],
        idealOutputMist: 27_000_000n,
        actualOutputMist: 27_000_000n,
        executionGapMist: 0n,
        executionGapBps: 0n,
      })
      .mockResolvedValueOnce({
        swapAmountSmallest: 1_000_000n,
        targetOutputMist: 27_000_000n,
        effectiveTargetOutputMist: 27_000_000n,
        quotedHopOutputs: [26_999_000n],
        rawMidPrices: [27_000_000_000n],
        idealOutputMist: 27_000_000n,
        actualOutputMist: 26_999_000n,
        executionGapMist: 1_000n,
        executionGapBps: 0n,
      });

    mockComputeExecutionCostClaim
      .mockReturnValueOnce({
        simGas: 2_000_000n,
        grossGas: 2_500_000n,
        gasVarianceFixedMist: 100_000n,
        slippageBufferMist: 0n,
        executionCostClaim: 3_000_000n,
      })
      .mockReturnValueOnce({
        simGas: 2_000_000n,
        grossGas: 2_500_000n,
        gasVarianceFixedMist: 100_000n,
        slippageBufferMist: 0n,
        executionCostClaim: 3_000_000n,
      });

    await expect(runGenericPrepareBuildPipeline(ctx, input)).rejects.toThrow(
      expect.objectContaining({ code: 'SLIPPAGE_CONVERGENCE_FAILED' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Quote-RPC observability fields.
//
// Two lock layers in this describe block:
//   1. Presence/type locks (credit-only and swap paths): assert the field set
//      ships at the expected stage events. Counts are 0 in the credit-only
//      path and reflect only the mid_price RPC in the swap path because
//      `solveExecutableSwap` is mocked away from the wrapper.
//   2. Non-zero aggregation lock: stages distinct per-invocation stats via
//      `mockQueuedRpcStats` and asserts the production summation
//      (mid_price + per-pass quantity_in + per-pass quantity_out_verify)
//      flows into both the per-pass payload fields and the aggregate fields
//      at `two_pass_complete`.
//
// Wrapper-level count math (per-call increment, finally-duration, max
// retention) is independently locked in
// `packages/core-relay/tests/quotePort.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

describe('runGenericPrepareBuildPipeline — quote RPC observability fields', () => {
  beforeEach(() => {
    resetBuildMocks();
  });

  function captureStageEvents(): Array<{ stage: string; payload: Record<string, unknown> }> {
    const events: Array<{ stage: string; payload: Record<string, unknown> }> = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      const line = typeof args[0] === 'string' ? args[0] : '';
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.event === 'PREPARE_BUILD_STAGE' && typeof parsed.stage === 'string') {
          const { stage, ...payload } = parsed;
          events.push({ stage, payload });
        }
      } catch {
        // non-JSON line — ignore
      }
    });
    return events;
  }

  it('credit-only path emits per-pass + aggregate quote-RPC fields with zero values', async () => {
    const ctx = makeCtx();
    const input = makeInput({ credit: '5000000' });
    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 2_000_000n,
      grossGas: 2_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 3_000_000n,
    });

    const events = captureStageEvents();
    await runGenericPrepareBuildPipeline(ctx, input);

    const completion = events.find((e) => e.stage === 'two_pass_complete');
    expect(completion).toBeDefined();
    // All five aggregate fields present and numeric.
    expect(typeof completion!.payload.quote_quantity_in_rpc_calls).toBe('number');
    expect(typeof completion!.payload.quote_quantity_out_verify_rpc_calls).toBe('number');
    expect(typeof completion!.payload.quote_total_rpc_calls).toBe('number');
    expect(typeof completion!.payload.quote_rpc_total_ms).toBe('number');
    expect(typeof completion!.payload.quote_rpc_max_ms).toBe('number');
    // Credit-only path → no swap RPC at all.
    expect(completion!.payload.quote_quantity_in_rpc_calls).toBe(0);
    expect(completion!.payload.quote_quantity_out_verify_rpc_calls).toBe(0);
    expect(completion!.payload.quote_total_rpc_calls).toBe(0);
  });

  it('swap path emits pass1 / pass1_5 / pass2 quantity-in fields and aggregate fields with consistent total', async () => {
    const ctx = makeCtx();
    const input = makeInput({ profile: 'new_user', vaultObjectId: undefined, credit: '0' });
    mockSolveExecutableSwap
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 0n }))
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 1_000n }))
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 1_000n }));
    mockComputeExecutionCostClaim.mockImplementation(
      (_gasUsed: unknown, opts?: { slippageBufferMist?: bigint }) => {
        const slippageBufferMist = opts?.slippageBufferMist ?? 0n;
        return {
          simGas: 2_000_000n,
          grossGas: 2_500_000n,
          gasVarianceFixedMist: 100_000n,
          slippageBufferMist,
          executionCostClaim: 3_000_000n + slippageBufferMist,
        };
      },
    );

    const events = captureStageEvents();
    await runGenericPrepareBuildPipeline(ctx, input);

    const pass1 = events.find((e) => e.stage === 'pass1_compiled');
    const pass1_5 = events.find((e) => e.stage === 'pass1_5_slippage_measured');
    const pass2 = events.find((e) => e.stage === 'pass2_compiled');
    const completion = events.find((e) => e.stage === 'two_pass_complete');

    expect(pass1?.payload.pass1_quantity_in_rpc_calls).toBeTypeOf('number');
    expect(pass1_5?.payload.pass1_5_quantity_in_rpc_calls).toBeTypeOf('number');
    expect(pass2?.payload.pass2_quantity_in_rpc_calls).toBeTypeOf('number');

    // Aggregate total = mid_price + quantity_in + verify. With
    // solveExecutableSwap mocked and no staged stats, quantity_in/verify are 0
    // and the only counted RPC is the single mid_price call from
    // batchGetHopMidPrices, so the aggregate total equals exactly 1.
    expect(completion!.payload.quote_total_rpc_calls).toBe(1);
    expect(completion!.payload.quote_quantity_in_rpc_calls).toBe(0);
    expect(completion!.payload.quote_quantity_out_verify_rpc_calls).toBe(0);
  });

  it('aggregates non-zero pass-level quote stats into per-pass and two_pass_complete fields', async () => {
    const ctx = makeCtx();
    const input = makeInput({ profile: 'new_user', vaultObjectId: undefined, credit: '0' });

    // Stage one stats entry per solveSwapForClaim invocation, in call order:
    //   pass1 → pass1_5 → pass2.
    mockQueuedRpcStats.push(
      { quantityInCalls: 1, quantityOutVerifyCalls: 1, totalDurationMs: 50, maxDurationMs: 50 },
      { quantityInCalls: 1, quantityOutVerifyCalls: 2, totalDurationMs: 30, maxDurationMs: 20 },
      { quantityInCalls: 1, quantityOutVerifyCalls: 1, totalDurationMs: 100, maxDurationMs: 100 },
    );

    mockSolveExecutableSwap
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 0n }))
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 1_000n }))
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 1_000n }));

    mockComputeExecutionCostClaim.mockImplementation(
      (_gasUsed: unknown, opts?: { slippageBufferMist?: bigint }) => {
        const slippageBufferMist = opts?.slippageBufferMist ?? 0n;
        return {
          simGas: 2_000_000n,
          grossGas: 2_500_000n,
          gasVarianceFixedMist: 100_000n,
          slippageBufferMist,
          executionCostClaim: 3_000_000n + slippageBufferMist,
        };
      },
    );

    const events = captureStageEvents();
    await runGenericPrepareBuildPipeline(ctx, input);

    // Per-pass quantity-in counts route to the matching stage events.
    expect(
      events.find((e) => e.stage === 'pass1_compiled')?.payload.pass1_quantity_in_rpc_calls,
    ).toBe(1);
    expect(
      events.find((e) => e.stage === 'pass1_5_slippage_measured')?.payload
        .pass1_5_quantity_in_rpc_calls,
    ).toBe(1);
    expect(
      events.find((e) => e.stage === 'pass2_compiled')?.payload.pass2_quantity_in_rpc_calls,
    ).toBe(1);

    const completion = events.find((e) => e.stage === 'two_pass_complete');
    expect(completion).toBeDefined();
    // Aggregates summed across all three passes.
    expect(completion!.payload.quote_quantity_in_rpc_calls).toBe(3);
    expect(completion!.payload.quote_quantity_out_verify_rpc_calls).toBe(4);
    // total = mid_price (1, from pass1's batchGetHopMidPrices) + qIn (3) + qOut (4) = 8
    expect(completion!.payload.quote_total_rpc_calls).toBe(8);
    // total_ms aggregates per-pass durations + mid_price duration. Mid-price
    // duration in mock is environment-dependent (typically <5ms), so assert
    // a lower bound that requires the per-pass values to have flowed in.
    expect(completion!.payload.quote_rpc_total_ms).toBeGreaterThanOrEqual(50 + 30 + 100);
    // max_ms = max(midPriceTotalMs, pass1.max=50, pass1_5.max=20, pass2.max=100).
    // Mid-price ms is <5ms in the mocked path, so pass2's 100 wins.
    expect(completion!.payload.quote_rpc_max_ms).toBeGreaterThanOrEqual(100);
    expect(completion!.payload.quote_rpc_max_ms).toBeLessThan(200);
    // Symmetry marker for partial failure-path emits — see `quote_rpc_failed`
    // tests below.
    expect(completion!.payload.quote_rpc_stats_complete).toBe(true);
  });

  // ── Aggregate logical / cache_hits emit ───────────────────────────────
  //
  // When no cache fires (logical = rpc per primitive, cacheHits = 0), the
  // aggregate `quote_quantity_in_logical_calls` /
  // `quote_quantity_out_verify_logical_calls` mirror the RPC counts and
  // `quote_cache_hits` stays at 0. `quote_quantity_in_rpc_calls` means
  // "RPC dispatch count"; logical fields include cache hits.

  it('emits aggregate logical/cache_hits fields equal to rpc counts when no cache fires', async () => {
    const ctx = makeCtx();
    const input = makeInput({ profile: 'new_user', vaultObjectId: undefined, credit: '0' });

    mockQueuedRpcStats.push(
      { quantityInCalls: 1, quantityOutVerifyCalls: 1, totalDurationMs: 50, maxDurationMs: 50 },
      { quantityInCalls: 1, quantityOutVerifyCalls: 2, totalDurationMs: 30, maxDurationMs: 20 },
      { quantityInCalls: 1, quantityOutVerifyCalls: 1, totalDurationMs: 100, maxDurationMs: 100 },
    );

    mockSolveExecutableSwap
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 0n }))
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 1_000n }))
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 1_000n }));

    mockComputeExecutionCostClaim.mockImplementation(
      (_gasUsed: unknown, opts?: { slippageBufferMist?: bigint }) => {
        const slippageBufferMist = opts?.slippageBufferMist ?? 0n;
        return {
          simGas: 2_000_000n,
          grossGas: 2_500_000n,
          gasVarianceFixedMist: 100_000n,
          slippageBufferMist,
          executionCostClaim: 3_000_000n + slippageBufferMist,
        };
      },
    );

    const events = captureStageEvents();
    await runGenericPrepareBuildPipeline(ctx, input);

    const completion = events.find((e) => e.stage === 'two_pass_complete');
    expect(completion).toBeDefined();
    expect(completion!.payload.quote_quantity_in_logical_calls).toBe(3);
    expect(completion!.payload.quote_quantity_out_verify_logical_calls).toBe(4);
    // logical == rpc when no cache fires; cacheHits == 0.
    expect(completion!.payload.quote_quantity_in_logical_calls).toBe(
      completion!.payload.quote_quantity_in_rpc_calls,
    );
    expect(completion!.payload.quote_quantity_out_verify_logical_calls).toBe(
      completion!.payload.quote_quantity_out_verify_rpc_calls,
    );
    expect(completion!.payload.quote_cache_hits).toBe(0);
  });

  it('emits aggregate cache_hits > 0 when injected cache effect makes logical exceed rpc', async () => {
    const ctx = makeCtx();
    const input = makeInput({ profile: 'new_user', vaultObjectId: undefined, credit: '0' });

    // Floor-bound case simulation: pass1 misses (1 logical, 1 rpc),
    // pass1.5 and pass2 hit cache (1 logical, 0 rpc each).
    // Aggregate: logical_in = 3, rpc_in = 1, cache_hits_in = 2.
    // Same shape on the verify primitive: logical = 3, rpc = 1, hits = 2.
    // Total cache_hits = 4 (= 2 in + 2 out).
    mockQueuedRpcStats.push(
      {
        quantityInCalls: 1,
        quantityOutVerifyCalls: 1,
        totalDurationMs: 50,
        maxDurationMs: 50,
        quantityInLogicalCalls: 1,
        quantityOutVerifyLogicalCalls: 1,
        cacheHits: 0,
      },
      {
        quantityInCalls: 0,
        quantityOutVerifyCalls: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        quantityInLogicalCalls: 1,
        quantityOutVerifyLogicalCalls: 1,
        cacheHits: 2,
      },
      {
        quantityInCalls: 0,
        quantityOutVerifyCalls: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        quantityInLogicalCalls: 1,
        quantityOutVerifyLogicalCalls: 1,
        cacheHits: 2,
      },
    );

    mockSolveExecutableSwap
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 0n }))
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 1_000n }))
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 1_000n }));

    mockComputeExecutionCostClaim.mockImplementation(
      (_gasUsed: unknown, opts?: { slippageBufferMist?: bigint }) => {
        const slippageBufferMist = opts?.slippageBufferMist ?? 0n;
        return {
          simGas: 2_000_000n,
          grossGas: 2_500_000n,
          gasVarianceFixedMist: 100_000n,
          slippageBufferMist,
          executionCostClaim: 3_000_000n + slippageBufferMist,
        };
      },
    );

    const events = captureStageEvents();
    await runGenericPrepareBuildPipeline(ctx, input);

    const completion = events.find((e) => e.stage === 'two_pass_complete');
    expect(completion).toBeDefined();
    // RPC dispatch counts stay at 1 each — only pass1 dispatched.
    expect(completion!.payload.quote_quantity_in_rpc_calls).toBe(1);
    expect(completion!.payload.quote_quantity_out_verify_rpc_calls).toBe(1);
    // Logical counts cover all three passes.
    expect(completion!.payload.quote_quantity_in_logical_calls).toBe(3);
    expect(completion!.payload.quote_quantity_out_verify_logical_calls).toBe(3);
    // Cache hits summed across passes and primitives = 4.
    expect(completion!.payload.quote_cache_hits).toBe(4);
  });

  // ── Cache orchestration lock ──────────────────────────────────────────
  //
  // The cache primitive must be allocated exactly once per /relay/prepare
  // and threaded — by identity — through pass1, pass1.5, and pass2. If a
  // refactor splits the cache instance across passes, the floor-bound
  // collapse (where all three passes resolve to identical args) silently
  // regresses to three separate RPCs and the cache becomes useless. The
  // lock asserts: (a) `createRequestQuoteCache` fires once, (b) every
  // `wrapQuotePortWithCacheAndStats` call receives the SAME cache object
  // by reference, and (c) the no-cache wrapper is never used on the swap
  // path.

  it('shares a single cache instance across pass1 / pass1_5 / pass2 (orchestration lock)', async () => {
    const ctx = makeCtx();
    const input = makeInput({ profile: 'new_user', vaultObjectId: undefined, credit: '0' });

    mockSolveExecutableSwap
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 0n }))
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 1_000n }))
      .mockResolvedValueOnce(makeExecutableQuote({ executionGapMist: 1_000n }));

    mockComputeExecutionCostClaim.mockImplementation(
      (_gasUsed: unknown, opts?: { slippageBufferMist?: bigint }) => {
        const slippageBufferMist = opts?.slippageBufferMist ?? 0n;
        return {
          simGas: 2_000_000n,
          grossGas: 2_500_000n,
          gasVarianceFixedMist: 100_000n,
          slippageBufferMist,
          executionCostClaim: 3_000_000n + slippageBufferMist,
        };
      },
    );

    await runGenericPrepareBuildPipeline(ctx, input);

    // (a) Cache allocated exactly once per request.
    expect(mockCreateCacheCalls.count).toBe(1);
    // (b) Cached wrapper invoked three times (pass1, pass1.5, pass2) and
    //     each invocation received the SAME cache instance by reference.
    expect(mockCachedWrapperCacheArgs).toHaveLength(3);
    const [c1, c2, c3] = mockCachedWrapperCacheArgs;
    expect(c1).toBe(c2);
    expect(c2).toBe(c3);
    // (c) No-cache wrapper not used on the swap path.
    expect(mockNoCacheWrapperCalls.count).toBe(0);
  });

  it('credit-only path bypasses the cached wrapper entirely', async () => {
    const ctx = makeCtx();
    // credit-eligible request — pre-swap credit probe selects credit and
    // returns before any solver invocation.
    const input = makeInput({
      profile: 'credit_general',
      vaultObjectId: '0xVAULT',
      credit: '100000000',
    });
    mockComputeExecutionCostClaim.mockReturnValue({
      simGas: 2_000_000n,
      grossGas: 2_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 3_000_000n,
    });

    await runGenericPrepareBuildPipeline(ctx, input);

    // Cache is still allocated (runGenericPrepareBuildPipeline allocates before the credit
    // branch decision), but neither wrapper is ever invoked because the
    // credit branch returns early inside runPreparePass. The mid_price
    // RPC also never fires on the credit path.
    expect(mockCachedWrapperCacheArgs).toHaveLength(0);
    expect(mockNoCacheWrapperCalls.count).toBe(0);
  });

  // ── Failure-path emit lock: solveSwapForClaim catches the underlying
  // MarketQuoteUnavailableError / ExecutionGapExceededError /
  // SwapUnviableUnderPolicyError, emits a `quote_rpc_failed` stage with the
  // partial quote-port stats, then rethrows via normalizeMarketPolicyError.
  // Without this emit, request-level observability would lose the count and
  // timing for any quote-RPC work performed before the failure.
  // ──────────────────────────────────────────────────────────────────────

  it('emits quote_rpc_failed (SLIPPAGE_QUERY_FAILED) on pass1 when solve throws MarketQuoteUnavailableError', async () => {
    const ctx = makeCtx();
    const input = makeInput({
      profile: 'new_user',
      vaultObjectId: undefined,
      credit: '0',
    });

    // Inject pass1 stats so the failure emit carries non-zero counts/timings.
    mockQueuedRpcStats.push({
      quantityInCalls: 2,
      quantityOutVerifyCalls: 3,
      totalDurationMs: 80,
      maxDurationMs: 50,
    });

    mockBatchGetHopMidPrices.mockResolvedValue([27_000_000_000n]);
    const { MarketQuoteUnavailableError: MQE } = await import('@stelis/core-relay/server');
    mockSolveExecutableSwap.mockRejectedValueOnce(new MQE('Mid-price unavailable'));

    const events = captureStageEvents();
    const err = await runGenericPrepareBuildPipeline(ctx, input).catch((e: unknown) => e);
    expect(err).toEqual(expect.objectContaining({ code: 'SLIPPAGE_QUERY_FAILED' }));

    const failed = events.find((e) => e.stage === 'quote_rpc_failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.pass).toBe('pass1');
    expect(failed!.payload.error_code).toBe('SLIPPAGE_QUERY_FAILED');
    expect(failed!.payload.quote_quantity_in_rpc_calls).toBe(2);
    expect(failed!.payload.quote_quantity_out_verify_rpc_calls).toBe(3);
    expect(failed!.payload.quote_total_rpc_calls).toBe(5);
    expect(failed!.payload.quote_rpc_total_ms).toBe(80);
    expect(failed!.payload.quote_rpc_max_ms).toBe(50);
    expect(failed!.payload.quote_rpc_stats_complete).toBe(false);
    // Failure-path partial payload still carries logical / cache_hits fields.
    // With no explicit cache effect injected, the mock mirrors logical = rpc
    // and cache_hits = 0.
    expect(failed!.payload.quote_quantity_in_logical_calls).toBe(2);
    expect(failed!.payload.quote_quantity_out_verify_logical_calls).toBe(3);
    expect(failed!.payload.quote_cache_hits).toBe(0);
    expect(failed!.payload.pool_id).toBe('0xPOOL');
    expect(failed!.payload.settlement_token_symbol).toBe('DEEP');
    // The planner's economic target is captured even though the solver
    // threw before any quote object existed. Without this field, an
    // operator triaging a failed quote cannot recover the target the
    // request was solving for. `effective_target_output_mist` is
    // intentionally absent here — it is only meaningful once the solver
    // completes its bump.
    expect(failed!.payload.target_output_mist).toBeTypeOf('string');
    expect(failed!.payload.effective_target_output_mist).toBeUndefined();
    // No two_pass_complete on the failure path.
    expect(events.find((e) => e.stage === 'two_pass_complete')).toBeUndefined();
  });

  it('emits quote_rpc_failed (SLIPPAGE_EXCEEDED) on pass1_5 when probe solve throws ExecutionGapExceededError', async () => {
    const ctx = makeCtx();
    const input = makeInput({
      profile: 'new_user',
      vaultObjectId: undefined,
      credit: '0',
    });

    // pass1 succeeds with one stats entry, pass1_5 fails with the second entry.
    mockQueuedRpcStats.push({
      quantityInCalls: 1,
      quantityOutVerifyCalls: 1,
      totalDurationMs: 30,
      maxDurationMs: 30,
    });
    mockQueuedRpcStats.push({
      quantityInCalls: 1,
      quantityOutVerifyCalls: 2,
      totalDurationMs: 70,
      maxDurationMs: 60,
    });

    mockBatchGetHopMidPrices.mockResolvedValue([27_000_000_000n]);
    // pass1 resolves with default mock; pass1_5 rejects with execution-gap error.
    const { ExecutionGapExceededError: EGE } = await import('@stelis/core-relay/server');
    mockSolveExecutableSwap.mockResolvedValueOnce(makeExecutableQuote());
    mockSolveExecutableSwap.mockRejectedValueOnce(new EGE('Execution gap exceeds cap'));

    const events = captureStageEvents();
    const err = await runGenericPrepareBuildPipeline(ctx, input).catch((e: unknown) => e);
    expect(err).toEqual(expect.objectContaining({ code: 'SLIPPAGE_EXCEEDED' }));

    const failed = events.find((e) => e.stage === 'quote_rpc_failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.pass).toBe('pass1_5');
    expect(failed!.payload.error_code).toBe('SLIPPAGE_EXCEEDED');
    // Stats reflect only the pass1_5 wrapper (per-call scope, not aggregated).
    expect(failed!.payload.quote_quantity_in_rpc_calls).toBe(1);
    expect(failed!.payload.quote_quantity_out_verify_rpc_calls).toBe(2);
    expect(failed!.payload.quote_total_rpc_calls).toBe(3);
    expect(failed!.payload.quote_rpc_total_ms).toBe(70);
    expect(failed!.payload.quote_rpc_max_ms).toBe(60);
    expect(failed!.payload.quote_rpc_stats_complete).toBe(false);
    expect(failed!.payload.pool_id).toBe('0xPOOL');
    expect(failed!.payload.settlement_token_symbol).toBe('DEEP');
    // pass1 emit succeeded before the failure; aggregate did not.
    expect(events.find((e) => e.stage === 'pass1_compiled')).toBeDefined();
    expect(events.find((e) => e.stage === 'two_pass_complete')).toBeUndefined();
  });

  // ── Post-solve abort emit lock: solveSwapForClaim succeeds (so its catch
  // does not fire), but the runPreparePass body throws between
  // `rpcStats.quote = solveRpcStats` and caller absorption. Without the
  // post-solve try/catch, the local quote stats would be dropped on the
  // floor (no `quote_rpc_failed`, no `passX_compiled`, no
  // `two_pass_complete`). `pass_aborted_post_solve` carries the partial
  // stats so the request keeps observability.
  // ──────────────────────────────────────────────────────────────────────

  it('emits pass_aborted_post_solve when resolvePaymentSource throws after a successful solve', async () => {
    const ctx = makeCtx();
    const input = makeInput({
      profile: 'new_user',
      vaultObjectId: undefined,
      credit: '0',
    });

    // pass1 wrapper stats: solve succeeds with these counts.
    mockQueuedRpcStats.push({
      quantityInCalls: 1,
      quantityOutVerifyCalls: 2,
      totalDurationMs: 40,
      maxDurationMs: 25,
    });

    mockBatchGetHopMidPrices.mockResolvedValue([27_000_000_000n]);
    // solveSwapForClaim resolves with the default mock; resolvePaymentSource
    // then throws. Caller absorption of pass1 stats never runs.
    mockResolvePaymentSource.mockRejectedValueOnce(
      new PrepareValidationError(
        'INSUFFICIENT_BALANCE',
        'Address balance below required swap amount',
      ),
    );

    const events = captureStageEvents();
    const err = await runGenericPrepareBuildPipeline(ctx, input).catch((e: unknown) => e);
    expect(err).toEqual(expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }));

    const aborted = events.find((e) => e.stage === 'pass_aborted_post_solve');
    expect(aborted).toBeDefined();
    expect(aborted!.payload.pass).toBe('pass1');
    expect(aborted!.payload.error_code).toBe('INSUFFICIENT_BALANCE');
    expect(aborted!.payload.quote_quantity_in_rpc_calls).toBe(1);
    expect(aborted!.payload.quote_quantity_out_verify_rpc_calls).toBe(2);
    expect(aborted!.payload.quote_total_rpc_calls).toBe(3);
    expect(aborted!.payload.quote_rpc_total_ms).toBe(40);
    expect(aborted!.payload.quote_rpc_max_ms).toBe(25);
    expect(aborted!.payload.quote_rpc_stats_complete).toBe(false);
    // Post-solve failure carries the same logical / cache_hits fields as
    // quote_rpc_failed and two_pass_complete. With no explicit cache effect
    // injected, the mock mirrors logical = rpc and cache_hits = 0.
    expect(aborted!.payload.quote_quantity_in_logical_calls).toBe(1);
    expect(aborted!.payload.quote_quantity_out_verify_logical_calls).toBe(2);
    expect(aborted!.payload.quote_cache_hits).toBe(0);
    expect(aborted!.payload.pool_id).toBe('0xPOOL');
    expect(aborted!.payload.settlement_token_symbol).toBe('DEEP');
    // Caller never absorbed pass1 stats → no per-pass emit, no aggregate.
    expect(events.find((e) => e.stage === 'pass1_compiled')).toBeUndefined();
    expect(events.find((e) => e.stage === 'two_pass_complete')).toBeUndefined();
    // No `quote_rpc_failed` (solve itself did not fail).
    expect(events.find((e) => e.stage === 'quote_rpc_failed')).toBeUndefined();
  });

  it('emits pass_aborted_post_solve when compileSwapSettlement throws PAYMENT_COIN_CONFLICT', async () => {
    const ctx = makeCtx();
    const input = makeInput({
      profile: 'new_user',
      vaultObjectId: undefined,
      credit: '0',
    });

    // pass1 wrapper stats: solve succeeds with these counts.
    mockQueuedRpcStats.push({
      quantityInCalls: 2,
      quantityOutVerifyCalls: 1,
      totalDurationMs: 55,
      maxDurationMs: 35,
    });

    mockBatchGetHopMidPrices.mockResolvedValue([27_000_000_000n]);
    // resolvePaymentSource succeeds with mixed_topup but no usableCoins,
    // which makes the real compileSwapSettlement throw PAYMENT_COIN_CONFLICT
    // (ptbCompiler.ts mixed_topup branch invariant).
    mockResolvePaymentSource.mockResolvedValueOnce({
      source: 'mixed_topup',
      usableCoins: [],
      usableCoinTotal: 0n,
      addressBalance: 5_000_000n,
      redeemDelta: 1_000_000n,
    });

    const events = captureStageEvents();
    const err = await runGenericPrepareBuildPipeline(ctx, input).catch((e: unknown) => e);
    expect(err).toEqual(expect.objectContaining({ code: 'PAYMENT_COIN_CONFLICT' }));

    const aborted = events.find((e) => e.stage === 'pass_aborted_post_solve');
    expect(aborted).toBeDefined();
    expect(aborted!.payload.pass).toBe('pass1');
    expect(aborted!.payload.error_code).toBe('PAYMENT_COIN_CONFLICT');
    expect(aborted!.payload.quote_quantity_in_rpc_calls).toBe(2);
    expect(aborted!.payload.quote_quantity_out_verify_rpc_calls).toBe(1);
    expect(aborted!.payload.quote_total_rpc_calls).toBe(3);
    expect(aborted!.payload.quote_rpc_total_ms).toBe(55);
    expect(aborted!.payload.quote_rpc_max_ms).toBe(35);
    expect(aborted!.payload.quote_rpc_stats_complete).toBe(false);
    // Same logical / cache_hits coverage as the INSUFFICIENT_BALANCE
    // post-solve failure above.
    expect(aborted!.payload.quote_quantity_in_logical_calls).toBe(2);
    expect(aborted!.payload.quote_quantity_out_verify_logical_calls).toBe(1);
    expect(aborted!.payload.quote_cache_hits).toBe(0);
    expect(aborted!.payload.pool_id).toBe('0xPOOL');
    expect(aborted!.payload.settlement_token_symbol).toBe('DEEP');
    // Funding emit happened (resolvePaymentSource succeeded), but pass1 emit
    // never did because compile threw before caller absorption.
    expect(events.find((e) => e.stage === 'run_prepare_pass_funding_resolved')).toBeDefined();
    expect(events.find((e) => e.stage === 'pass1_compiled')).toBeUndefined();
    expect(events.find((e) => e.stage === 'two_pass_complete')).toBeUndefined();
  });

  // ── Mid-price-failure emit lock: batchGetHopMidPrices throws before any
  // quote-solve work, so neither `quote_rpc_failed` (solve) nor
  // `pass_aborted_post_solve` (post-solve) fires. Without
  // `mid_price_rpc_failed`, the request would have zero failure-stage
  // observability on the mid-price RPC axis.
  // ──────────────────────────────────────────────────────────────────────

  // ── baseForQuote floor diagnostic payload + orchestration coverage ────
  //
  // Three orchestration scenarios that pin the baseForQuote market-executable
  // floor diagnostic fields (`bfq_floor_raised`, `target_output_mist`,
  // `effective_target_output_mist`) and the funding-failure / convergence
  // behavior triggered by a raised target. The solver-side floor math is
  // locked separately in `packages/core-relay/tests/marketPolicySolver.test.ts`
  // — these tests assume a successful raised-target solve and exercise the
  // pieces that matter once the solver returns:
  //
  //   1. raised solver output → request progresses past quote_rpc_failed.
  //   2. raised swap amount > user funding → expected fail-closed branch
  //      and the diagnostic payload is emitted at the correct stage.
  //   3. pass1.5 and pass2 receive the same effective floor → convergence
  //      lock holds.
  //
  // ──────────────────────────────────────────────────────────────────────

  it('progresses past pass1 without quote_rpc_failed when solver returns a raised bfq floor target', async () => {
    const ctx = makeCtx();
    const input = makeInput({ profile: 'new_user', vaultObjectId: undefined, credit: '0' });

    // Below-floor economic target → solver lifts to ceil(minSize * mid / 1e9).
    // Mock the raised quote to mimic a successful executable quote at the floor.
    mockSolveExecutableSwap.mockResolvedValue(
      makeExecutableQuote({
        swapAmountSmallest: 1_000_000n,
        targetOutputMist: 5_000_000n,
        effectiveTargetOutputMist: 32_745_000n,
        actualOutputMist: 32_745_000n,
        idealOutputMist: 32_745_000n,
        executionGapMist: 0n,
        rawMidPrices: [32_745_000_000n],
        quotedHopOutputs: [32_745_000n],
      }),
    );
    mockBatchGetHopMidPrices.mockResolvedValue([32_745_000_000n]);

    const events = captureStageEvents();
    const result = await runGenericPrepareBuildPipeline(ctx, input);

    // No solver failure event was emitted — the raised target is live.
    expect(events.find((e) => e.stage === 'quote_rpc_failed')).toBeUndefined();

    // Diagnostic payload is present at every required stage with the raise
    // visible. Pass1 emits with the raised target.
    const swapAmount = events.filter((e) => e.stage === 'run_prepare_pass_swap_amount_computed');
    expect(swapAmount.length).toBeGreaterThan(0);
    for (const evt of swapAmount) {
      expect(evt.payload.bfq_floor_raised).toBe(true);
      expect(evt.payload.target_output_mist).toBe('5000000');
      expect(evt.payload.effective_target_output_mist).toBe('32745000');
    }

    const slippage = events.find((e) => e.stage === 'pass1_5_slippage_measured');
    expect(slippage).toBeDefined();
    expect(slippage!.payload.bfq_floor_raised).toBe(true);
    expect(slippage!.payload.target_output_mist).toBe('5000000');
    expect(slippage!.payload.effective_target_output_mist).toBe('32745000');

    const completion = events.find((e) => e.stage === 'two_pass_complete');
    expect(completion).toBeDefined();
    expect(completion!.payload.bfq_floor_raised).toBe(true);
    expect(completion!.payload.effective_target_output_mist).toBe('32745000');

    // Build still succeeds and reports the raised swap amount.
    expect(result.swapAmountSmallest).toBe(1_000_000n);
  });

  it('emits raised-floor diagnostic on pass_aborted_post_solve when raised swap amount exceeds user funding', async () => {
    const ctx = makeCtx();
    const input = makeInput({ profile: 'new_user', vaultObjectId: undefined, credit: '0' });

    mockBatchGetHopMidPrices.mockResolvedValue([32_745_000_000n]);
    mockSolveExecutableSwap.mockResolvedValue(
      makeExecutableQuote({
        swapAmountSmallest: 1_000_000n,
        targetOutputMist: 5_000_000n,
        effectiveTargetOutputMist: 32_745_000n,
        actualOutputMist: 32_745_000n,
        idealOutputMist: 32_745_000n,
        executionGapMist: 0n,
        rawMidPrices: [32_745_000_000n],
        quotedHopOutputs: [32_745_000n],
      }),
    );

    // Funding resolution rejects the raised swap input. This is the
    // expected fail-closed branch when the user holds enough payment-token
    // for the economic target but not for the floor-raised amount.
    mockResolvePaymentSource.mockRejectedValueOnce(
      new PrepareValidationError(
        'INSUFFICIENT_BALANCE',
        'Address balance below required swap amount',
      ),
    );

    const events = captureStageEvents();
    const err = await runGenericPrepareBuildPipeline(ctx, input).catch((e: unknown) => e);
    expect(err).toEqual(expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }));

    const aborted = events.find((e) => e.stage === 'pass_aborted_post_solve');
    expect(aborted).toBeDefined();
    expect(aborted!.payload.error_code).toBe('INSUFFICIENT_BALANCE');
    // The diagnostic correlates the funding failure with the floor that
    // raised the swap input. Without these fields the operator cannot tell
    // whether the failure is due to a floor raise or a different cause.
    expect(aborted!.payload.bfq_floor_raised).toBe(true);
    expect(aborted!.payload.target_output_mist).toBe('5000000');
    expect(aborted!.payload.effective_target_output_mist).toBe('32745000');
  });

  it('pass1.5 and pass2 land on the same effective floor when mid-price is held constant', async () => {
    const ctx = makeCtx();
    const input = makeInput({ profile: 'new_user', vaultObjectId: undefined, credit: '0' });

    mockBatchGetHopMidPrices.mockResolvedValue([32_745_000_000n]);

    // pass1 (cap-disabled), pass1.5, pass2 each receive a quote at the
    // same raised effective target. Convergence math compares pass1.5's
    // executionGapMist to pass2's residual — equal targets and equal mocks
    // produce equal gaps, so SLIPPAGE_CONVERGENCE_FAILED must not fire.
    const raisedQuote = makeExecutableQuote({
      swapAmountSmallest: 1_000_000n,
      targetOutputMist: 5_000_000n,
      effectiveTargetOutputMist: 32_745_000n,
      actualOutputMist: 32_745_000n,
      idealOutputMist: 32_745_000n,
      executionGapMist: 1_000n,
      rawMidPrices: [32_745_000_000n],
      quotedHopOutputs: [32_745_000n],
    });
    mockSolveExecutableSwap
      .mockResolvedValueOnce(raisedQuote)
      .mockResolvedValueOnce(raisedQuote)
      .mockResolvedValueOnce(raisedQuote);

    mockComputeExecutionCostClaim.mockImplementation(
      (_gasUsed: unknown, opts?: { slippageBufferMist?: bigint }) => {
        const slippageBufferMist = opts?.slippageBufferMist ?? 0n;
        return {
          simGas: 2_000_000n,
          grossGas: 2_500_000n,
          gasVarianceFixedMist: 100_000n,
          slippageBufferMist,
          executionCostClaim: 3_000_000n + slippageBufferMist,
        };
      },
    );

    const events = captureStageEvents();
    const result = await runGenericPrepareBuildPipeline(ctx, input);

    // No convergence failure.
    expect(events.find((e) => e.stage === 'quote_rpc_failed')).toBeUndefined();

    // Build completes with the raised-floor diagnostic stamped on
    // two_pass_complete.
    const completion = events.find((e) => e.stage === 'two_pass_complete');
    expect(completion).toBeDefined();
    expect(completion!.payload.bfq_floor_raised).toBe(true);
    expect(completion!.payload.target_output_mist).toBe('5000000');
    expect(completion!.payload.effective_target_output_mist).toBe('32745000');

    // pass1.5 and pass2 both used the same raised target — diagnostic
    // payloads agree.
    const slippage = events.find((e) => e.stage === 'pass1_5_slippage_measured');
    expect(slippage!.payload.target_output_mist).toBe('5000000');
    expect(slippage!.payload.effective_target_output_mist).toBe('32745000');

    expect(result.slippageBufferMist).toBe(1_000n);
  });

  it('does not flag bfq_floor_raised on the quoteForBase branch even when its existing minSize bump fires', async () => {
    // quoteForBase's existing minSize bump path causes effectiveTargetOutputMist >
    // targetOutputMist, but the diagnostic flag is scoped to baseForQuote.
    // This lock keeps the baseForQuote diagnostic from leaking onto quoteForBase.
    const ctx = makeCtx();
    const input = makeInput({
      profile: 'new_user',
      vaultObjectId: undefined,
      credit: '0',
      settlementSwapPath: {
        hops: [
          {
            poolId: '0xPOOL',
            baseType: '0xBASE',
            quoteType: '0xQUOTE',
            swapDirection: 'quoteForBase',
            feeBps: 0,
          },
        ],
        settlementTokenType: '0xUSDC::usdc::USDC',
        settlementTokenSymbol: 'USDC',
        settlementTokenDecimals: 6,
        lotSize: 1_000n,
        minSize: 1_000_000_000n,
        effectiveFeeRateBps: 0,
        settlementSwapDirection: 'quoteForBase',
      } as unknown as GenericPrepareBuildRequest['settlementSwapPath'],
      descriptor: {
        settlementTokenType: '0xUSDC::usdc::USDC',
        settlementTokenSymbol: 'USDC',
        settlementTokenDecimals: 6,
        effectiveFeeRateBps: 0,
        settlementSwapDirection: 'quoteForBase',
        hops: [
          {
            poolId: '0xPOOL',
            baseType: '0xBASE',
            quoteType: '0xQUOTE',
            swapDirection: 'quoteForBase',
            feeBps: 0,
          },
        ],
        lotSize: 1_000n,
        minSize: 1_000_000_000n,
      } as unknown as GenericPrepareBuildRequest['descriptor'],
    });

    mockBatchGetHopMidPrices.mockResolvedValue([946_000n]);
    mockSolveExecutableSwap.mockResolvedValue(
      makeExecutableQuote({
        swapAmountSmallest: 952_189n,
        targetOutputMist: 5_000_000n,
        effectiveTargetOutputMist: 1_000_000_000n,
        actualOutputMist: 1_000_000_000n,
        idealOutputMist: 1_006_542_283n,
        executionGapMist: 6_542_283n,
        rawMidPrices: [946_000n],
        quotedHopOutputs: [1_000_000_000n],
      }),
    );
    // Honor `opts.slippageBufferMist` so pass1.5 → pass2 convergence sees a
    // non-zero buffer that matches pass2's residual gap. Without this, the
    // default reset returns slippageBufferMist=0n unconditionally and the
    // raised-target fixture trips SLIPPAGE_CONVERGENCE_FAILED on the
    // buffer0==0 && residual>0 branch.
    mockComputeExecutionCostClaim.mockImplementation(
      (_gasUsed: unknown, opts?: { slippageBufferMist?: bigint }) => {
        const slippageBufferMist = opts?.slippageBufferMist ?? 0n;
        return {
          simGas: 2_000_000n,
          grossGas: 2_500_000n,
          gasVarianceFixedMist: 100_000n,
          slippageBufferMist,
          executionCostClaim: 3_000_000n + slippageBufferMist,
        };
      },
    );

    const events = captureStageEvents();
    await runGenericPrepareBuildPipeline(ctx, input);

    const completion = events.find((e) => e.stage === 'two_pass_complete');
    expect(completion).toBeDefined();
    // qfb raised the target (existing minSize bump), but the new bfq
    // diagnostic flag stays false.
    expect(completion!.payload.bfq_floor_raised).toBe(false);
    expect(completion!.payload.target_output_mist).toBe('5000000');
    expect(completion!.payload.effective_target_output_mist).toBe('1000000000');
  });

  it('emits mid_price_rpc_failed when batchGetHopMidPrices throws SlippageQueryError', async () => {
    const ctx = makeCtx();
    const input = makeInput({
      profile: 'new_user',
      vaultObjectId: undefined,
      credit: '0',
    });

    const { SlippageQueryError: SQE } = await import('@stelis/core-relay');
    mockBatchGetHopMidPrices.mockRejectedValue(new SQE('simulateTransaction failed: RPC timeout'));

    const events = captureStageEvents();
    const err = await runGenericPrepareBuildPipeline(ctx, input).catch((e: unknown) => e);
    // loadRawMidPrices wraps SlippageQueryError into PrepareValidationError.
    expect(err).toEqual(expect.objectContaining({ code: 'SLIPPAGE_QUERY_FAILED' }));

    const failed = events.find((e) => e.stage === 'mid_price_rpc_failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.pass).toBe('pass1');
    expect(failed!.payload.error_code).toBe('SLIPPAGE_QUERY_FAILED');
    expect(typeof failed!.payload.mid_price_total_ms).toBe('number');
    expect(failed!.payload.mid_price_stats_complete).toBe(false);
    expect(failed!.payload.pool_id).toBe('0xPOOL');
    expect(failed!.payload.settlement_token_symbol).toBe('DEEP');
    // Mid-price failure is upstream of any solve work — neither solve-time
    // nor post-solve emits should fire.
    expect(events.find((e) => e.stage === 'quote_rpc_failed')).toBeUndefined();
    expect(events.find((e) => e.stage === 'pass_aborted_post_solve')).toBeUndefined();
    expect(events.find((e) => e.stage === 'pass1_compiled')).toBeUndefined();
    expect(events.find((e) => e.stage === 'two_pass_complete')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle failure observability — dry-run safeBuild/simulate/extract +
// final pass2 safeBuild emit phase-specific PREPARE_BUILD_STAGE failure stages.
// These cover lifecycle gaps outside the quote-RPC axis (mid_price /
// quote_solve / post_solve already covered by other failure stages).
// ─────────────────────────────────────────────────────────────────────────────

describe('runGenericPrepareBuildPipeline — lifecycle failure observability', () => {
  beforeEach(() => {
    resetBuildMocks();
  });

  function captureStageEvents(): Array<{ stage: string; payload: Record<string, unknown> }> {
    const events: Array<{ stage: string; payload: Record<string, unknown> }> = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      const line = typeof args[0] === 'string' ? args[0] : '';
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.event === 'PREPARE_BUILD_STAGE' && typeof parsed.stage === 'string') {
          const { stage, ...payload } = parsed;
          events.push({ stage, payload });
        }
      } catch {
        // non-JSON line — ignore
      }
    });
    return events;
  }

  it('emits dryrun_safebuild_failed (pass=credit_preswap) when credit_preswap dry-run safeBuild throws', async () => {
    const ctx = makeCtx();
    const input = makeInput({
      profile: 'credit_general',
      vaultObjectId: '0xVAULT',
      credit: '5000000',
    });

    // First tx.build is the credit_preswap probe. Reject with InsufficientCoinBalance
    // so safeBuild classifies it as INSUFFICIENT_BALANCE before simulateTransaction
    // is reached.
    mockBuild.mockRejectedValueOnce(new Error('InsufficientCoinBalance: cannot fund swap'));

    const events = captureStageEvents();
    const err = await runGenericPrepareBuildPipeline(ctx, input).catch((e: unknown) => e);
    expect(err).toEqual(expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }));

    const failed = events.find((e) => e.stage === 'dryrun_safebuild_failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.pass).toBe('credit_preswap');
    expect(failed!.payload.error_code).toBe('INSUFFICIENT_BALANCE');
    expect(failed!.payload.pool_id).toBe('0xPOOL');
    expect(failed!.payload.settlement_token_symbol).toBe('DEEP');
    expect(failed!.payload.phase_complete).toBe(false);
    // Quote-stats schema: credit_preswap path is upstream of any quote solve,
    // so all 8 quote-stat fields are zero and the marker is `false` because
    // request-level quote work is not complete (no quote work for this path).
    expect(failed!.payload.quote_rpc_stats_complete).toBe(false);
    expect(failed!.payload.quote_quantity_in_rpc_calls).toBe(0);
    expect(failed!.payload.quote_quantity_out_verify_rpc_calls).toBe(0);
    expect(failed!.payload.quote_total_rpc_calls).toBe(0);
    expect(failed!.payload.quote_rpc_total_ms).toBe(0);
    expect(failed!.payload.quote_rpc_max_ms).toBe(0);
    expect(failed!.payload.quote_quantity_in_logical_calls).toBe(0);
    expect(failed!.payload.quote_quantity_out_verify_logical_calls).toBe(0);
    expect(failed!.payload.quote_cache_hits).toBe(0);
    // safeBuild threw before simulateTransaction → no simulated-stage emit.
    expect(events.find((e) => e.stage === 'credit_preswap_dryrun_simulated')).toBeUndefined();
    expect(events.find((e) => e.stage === 'two_pass_complete')).toBeUndefined();
  });

  it('emits dryrun_simulate_failed (pass=pass1) when pass1 simulateTransaction rejects', async () => {
    const ctx = makeCtx();
    const input = makeInput({
      profile: 'new_user',
      vaultObjectId: undefined,
      credit: '0',
    });

    // Inject pass1 stats so the dry-run failure emit carries non-zero counts.
    // Locks the forward-carry contract — `dryRunForGas` must propagate the
    // already-accumulated `rpcAcc.pass1Quote` into the dryrun_simulate_failed
    // payload.
    mockQueuedRpcStats.push({
      quantityInCalls: 2,
      quantityOutVerifyCalls: 1,
      totalDurationMs: 40,
      maxDurationMs: 25,
    });

    // pass1 tx.build succeeds (default mock). simulateTransaction rejects on the
    // first call (the pass1 dry-run).
    (ctx.sui.simulateTransaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('RPC unavailable: simulate timed out'),
    );

    const events = captureStageEvents();
    const err = await runGenericPrepareBuildPipeline(ctx, input).catch((e: unknown) => e);
    // simulate rejection is unclassified raw infra error; propagates as-is.
    expect((err as Error).message).toContain('RPC unavailable');

    const failed = events.find((e) => e.stage === 'dryrun_simulate_failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.pass).toBe('pass1');
    expect(failed!.payload.error_code).toBe('UNKNOWN');
    expect(failed!.payload.phase_complete).toBe(false);
    expect(failed!.payload.pool_id).toBe('0xPOOL');
    expect(failed!.payload.settlement_token_symbol).toBe('DEEP');
    // Quote-stats schema: pass1 dry-run runs AFTER pass1 quote-solve has
    // already accumulated, so the failure emit MUST carry forward the injected
    // non-zero pass1 stats. Marker is `false` because pass1.5 / pass2 quote
    // work has not started yet (request-level quote work incomplete). Without
    // this lock a regression that drops the optional `quoteStats` argument
    // from the pass1 caller would silently land empty zeros.
    expect(failed!.payload.quote_rpc_stats_complete).toBe(false);
    expect(failed!.payload.quote_quantity_in_rpc_calls).toBe(2);
    expect(failed!.payload.quote_quantity_out_verify_rpc_calls).toBe(1);
    expect(failed!.payload.quote_total_rpc_calls).toBe(3);
    expect(failed!.payload.quote_rpc_total_ms).toBe(40);
    expect(failed!.payload.quote_rpc_max_ms).toBe(25);
    // Logical fields default to mirror RPC counts when no explicit cache
    // effect is injected (consistent with existing quote_rpc_failed tests).
    expect(failed!.payload.quote_quantity_in_logical_calls).toBe(2);
    expect(failed!.payload.quote_quantity_out_verify_logical_calls).toBe(1);
    expect(failed!.payload.quote_cache_hits).toBe(0);
    // simulateTransaction threw → simulated-stage did not emit.
    expect(events.find((e) => e.stage === 'pass1_dryrun_simulated')).toBeUndefined();
    expect(events.find((e) => e.stage === 'pass1_compiled')).toBeDefined();
    expect(events.find((e) => e.stage === 'two_pass_complete')).toBeUndefined();
  });

  it('emits dryrun_extract_failed with dual emit when pass1 dry-run returns failed status', async () => {
    const ctx = makeCtx();
    const input = makeInput({
      profile: 'new_user',
      vaultObjectId: undefined,
      credit: '0',
    });

    // Inject pass1 stats so the dry-run failure emit carries non-zero counts.
    // Same forward-carry contract as `dryrun_simulate_failed` above.
    mockQueuedRpcStats.push({
      quantityInCalls: 1,
      quantityOutVerifyCalls: 2,
      totalDurationMs: 30,
      maxDurationMs: 20,
    });

    // simulateTransaction returns successfully but with status.success=false.
    // The completed-stage emits (because simulate returned), then
    // extractSuccessfulDryRunGas throws DRY_RUN_FAILED.
    (ctx.sui.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      Transaction: {
        status: { success: false, error: { message: 'execution_failure: gas exhausted' } },
      },
    });

    const events = captureStageEvents();
    const err = await runGenericPrepareBuildPipeline(ctx, input).catch((e: unknown) => e);
    expect(err).toEqual(expect.objectContaining({ code: 'DRY_RUN_FAILED' }));

    // Dual emit: simulated-stage AND extract-failed.
    expect(events.find((e) => e.stage === 'pass1_dryrun_simulated')).toBeDefined();
    const failed = events.find((e) => e.stage === 'dryrun_extract_failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.pass).toBe('pass1');
    expect(failed!.payload.error_code).toBe('DRY_RUN_FAILED');
    expect(failed!.payload.has_transaction).toBe(true);
    expect(failed!.payload.completed_stage_emitted).toBe(true);
    expect(failed!.payload.phase_complete).toBe(false);
    expect(failed!.payload.pool_id).toBe('0xPOOL');
    expect(failed!.payload.settlement_token_symbol).toBe('DEEP');
    // Quote-stats schema with non-zero forward-carry — same lock as
    // `dryrun_simulate_failed`. Pass1 stats already accumulated by the time
    // dry-run runs; the dual-emit (simulated + extract_failed) does not
    // change quote-stats source. Marker is `false`.
    expect(failed!.payload.quote_rpc_stats_complete).toBe(false);
    expect(failed!.payload.quote_quantity_in_rpc_calls).toBe(1);
    expect(failed!.payload.quote_quantity_out_verify_rpc_calls).toBe(2);
    expect(failed!.payload.quote_total_rpc_calls).toBe(3);
    expect(failed!.payload.quote_rpc_total_ms).toBe(30);
    expect(failed!.payload.quote_rpc_max_ms).toBe(20);
    expect(failed!.payload.quote_quantity_in_logical_calls).toBe(1);
    expect(failed!.payload.quote_quantity_out_verify_logical_calls).toBe(2);
    expect(failed!.payload.quote_cache_hits).toBe(0);
    expect(events.find((e) => e.stage === 'two_pass_complete')).toBeUndefined();
  });

  it('emits pass2_safebuild_failed when final pass2 safeBuild throws and skips two_pass_complete', async () => {
    const ctx = makeCtx();
    const input = makeInput({
      profile: 'new_user',
      vaultObjectId: undefined,
      credit: '0',
    });

    // pass1 dry-run succeeds (default). pass2 final tx.build is the second
    // mockBuild call — reject it with a classifiable error.
    mockBuild
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
      .mockRejectedValueOnce(new Error('InsufficientCoinBalance: pass2 swap'));

    const events = captureStageEvents();
    const err = await runGenericPrepareBuildPipeline(ctx, input).catch((e: unknown) => e);
    expect(err).toEqual(expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }));

    const failed = events.find((e) => e.stage === 'pass2_safebuild_failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.pass).toBe('pass2');
    expect(failed!.payload.error_code).toBe('INSUFFICIENT_BALANCE');
    expect(failed!.payload.phase_complete).toBe(false);
    expect(failed!.payload.pool_id).toBe('0xPOOL');
    expect(failed!.payload.settlement_token_symbol).toBe('DEEP');
    // Final safeBuild fails after all quote work has completed, so this
    // lifecycle failure still carries a complete request-level quote-stats
    // payload. The default mock path has one mid-price RPC and no quote-port
    // dispatches.
    expect(failed!.payload.quote_rpc_stats_complete).toBe(true);
    expect(failed!.payload.quote_quantity_in_rpc_calls).toBe(0);
    expect(failed!.payload.quote_quantity_out_verify_rpc_calls).toBe(0);
    expect(failed!.payload.quote_total_rpc_calls).toBe(1);
    expect(failed!.payload.quote_quantity_in_logical_calls).toBe(0);
    expect(failed!.payload.quote_quantity_out_verify_logical_calls).toBe(0);
    expect(failed!.payload.quote_cache_hits).toBe(0);
    // Final-build failure is the last gap before two_pass_complete; aggregate
    // must not emit on this path.
    expect(events.find((e) => e.stage === 'two_pass_complete')).toBeUndefined();
    // pass1/pass2 compiled emits happened before final safeBuild.
    expect(events.find((e) => e.stage === 'pass1_compiled')).toBeDefined();
    expect(events.find((e) => e.stage === 'pass2_compiled')).toBeDefined();
  });
});
