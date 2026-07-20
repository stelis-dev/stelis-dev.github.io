import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostContext } from '../src/context.js';
import type { PrepareHandlerConfig } from '../src/handlers/prepare.js';
import { MemoryPrepareInflight } from '../src/store/memoryPrepareInflight.js';
import { PrepareOverloadError } from '../src/store/prepareErrors.js';

const mocks = vi.hoisted(() => ({
  deserializeUserTxKind: vi.fn(),
  validateGenericUserTransactionKind: vi.fn(),
  queryUserCredit: vi.fn(),
  createSettlementFundingRunContext: vi.fn(),
  evaluateCurrentSettlementFunding: vi.fn(),
}));

vi.mock('../src/prepare/replay.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/prepare/replay.js')>();
  return { ...original, deserializeUserTxKind: mocks.deserializeUserTxKind };
});

vi.mock('@stelis/core-relay', async (importOriginal) => {
  const original = await importOriginal<typeof import('@stelis/core-relay')>();
  return {
    ...original,
    validateGenericUserTransactionKind: mocks.validateGenericUserTransactionKind,
    queryUserCredit: mocks.queryUserCredit,
  };
});

vi.mock('../src/prepare/build.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/prepare/build.js')>();
  return {
    ...original,
    createSettlementFundingRunContext: mocks.createSettlementFundingRunContext,
    evaluateCurrentSettlementFunding: mocks.evaluateCurrentSettlementFunding,
  };
});

import { handleSettlementFundingCheck } from '../src/handlers/settlementFundingCheck.js';

const SENDER = `0x${'11'.repeat(32)}`;
const TOKEN = `0x${'22'.repeat(32)}::deep::DEEP`;
const PATH = {
  settlementTokenType: TOKEN,
  settlementTokenSymbol: 'DEEP',
  settlementTokenDecimals: 6,
  settlementSwapDirection: 'baseForQuote' as const,
  effectiveFeeRateBps: 0,
  lotSize: 1n,
  minSize: 1n,
  hops: [
    {
      poolId: `0x${'33'.repeat(32)}`,
      baseType: TOKEN,
      quoteType: '0x2::sui::SUI',
      swapDirection: 'baseForQuote' as const,
      feeBps: 0,
    },
  ],
};
const DESCRIPTOR = { ...PATH };

function makeHost(limiter: MemoryPrepareInflight): HostContext {
  return {
    network: 'testnet',
    sui: Object.freeze({ network: 'testnet', chainIdentifier: 'test' }),
    packageId: `0x${'44'.repeat(32)}`,
    configId: `0x${'55'.repeat(32)}`,
    vaultRegistryId: `0x${'66'.repeat(32)}`,
    deepbookPackageId: `0x${'77'.repeat(32)}`,
    settlementPayoutRecipientAddress: `0x${'88'.repeat(32)}`,
    vaultsTableId: `0x${'99'.repeat(32)}`,
    prepareInflightLimiter: limiter,
    getConfig: vi.fn().mockResolvedValue({
      minSettleMist: 100n,
      maxClaimMist: 1_000n,
      protocolFlatFeeMist: 10n,
    }),
  } as unknown as HostContext;
}

const config: PrepareHandlerConfig = {
  deepbookPackageId: `0x${'77'.repeat(32)}`,
  supportedSettlementSwapPaths: [PATH],
  settlementSwapPathDescriptors: new Map([[TOKEN, DESCRIPTOR]]),
  allowedSettlementSwapPaths: [],
  quotedHostFeeMist: 20n,
};

const params = {
  txKindBytes: 'AAAA',
  senderAddress: SENDER,
  settlementTokenType: TOKEN,
  estimatedExecutionCostClaimMist: 500n,
  signal: new AbortController().signal,
};

describe('handleSettlementFundingCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deserializeUserTxKind.mockResolvedValue({});
    mocks.validateGenericUserTransactionKind.mockReturnValue({ ok: true });
    mocks.queryUserCredit.mockResolvedValue({
      vaultObjectId: null,
      credit: '0',
      needsCreate: true,
      lastNonce: '0',
    });
    mocks.createSettlementFundingRunContext.mockReturnValue({});
    mocks.evaluateCurrentSettlementFunding.mockResolvedValue({
      outcome: 'credit',
      useCreditAmount: 500n,
      rpcStats: {},
    });
  });

  it('shares aggregate prepare capacity and rejects overload before chain reads', async () => {
    const limiter = new MemoryPrepareInflight(1);
    const held = await limiter.tryAcquire('generic');
    expect(held).not.toBeNull();

    await expect(
      handleSettlementFundingCheck(makeHost(limiter), params, config),
    ).rejects.toBeInstanceOf(PrepareOverloadError);
    expect(mocks.queryUserCredit).not.toHaveBeenCalled();
    expect(mocks.evaluateCurrentSettlementFunding).not.toHaveBeenCalled();

    await held!.release();
    await expect(handleSettlementFundingCheck(makeHost(limiter), params, config)).resolves.toEqual({
      status: 'likely_sufficient',
      source: 'vault_credit',
      estimatedExecutionCostClaimMist: '500',
    });
    expect(limiter.inflight).toBe(0);
  });

  it('preserves generic transaction rejection codes without entering chain reads', async () => {
    const limiter = new MemoryPrepareInflight(1);
    mocks.validateGenericUserTransactionKind.mockReturnValueOnce({
      ok: false,
      code: 'UNACCOUNTABLE_WITHDRAWAL',
      message: 'withdrawal is not accountable',
    });

    await expect(
      handleSettlementFundingCheck(makeHost(limiter), params, config),
    ).rejects.toMatchObject({
      code: 'UNACCOUNTABLE_WITHDRAWAL',
    });
    expect(mocks.queryUserCredit).not.toHaveBeenCalled();
    expect(mocks.evaluateCurrentSettlementFunding).not.toHaveBeenCalled();
    expect(limiter.inflight).toBe(0);
  });

  it('rejects an estimate above the current on-chain claim limit before market evaluation', async () => {
    const limiter = new MemoryPrepareInflight(1);
    const host = makeHost(limiter);
    (host.getConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      minSettleMist: 100n,
      maxClaimMist: 499n,
      protocolFlatFeeMist: 10n,
    });

    await expect(handleSettlementFundingCheck(host, params, config)).rejects.toMatchObject({
      code: 'CLAIM_WOULD_EXCEED_MAX',
    });
    expect(mocks.evaluateCurrentSettlementFunding).not.toHaveBeenCalled();
    expect(limiter.inflight).toBe(0);
  });

  it.each([
    {
      evaluation: {
        outcome: 'funded',
        executionQuote: { swapAmountSmallest: 12n },
        funding: { source: 'address_balance', redeemAmount: 12n },
      },
      expected: {
        status: 'likely_sufficient',
        source: 'settlement_token',
        estimatedExecutionCostClaimMist: '500',
        quotedRequiredSettlementTokenAmount: '12',
      },
    },
    {
      evaluation: {
        outcome: 'insufficient',
        executionQuote: { swapAmountSmallest: 12n },
        availableSettlementTokenAmount: 3n,
      },
      expected: {
        status: 'likely_insufficient',
        estimatedExecutionCostClaimMist: '500',
        quotedRequiredSettlementTokenAmount: '12',
        availableSettlementTokenAmount: '3',
      },
    },
    {
      evaluation: {
        outcome: 'indeterminate',
        reason: 'bounded_coin_discovery',
        executionQuote: { swapAmountSmallest: 12n },
      },
      expected: {
        status: 'indeterminate',
        reason: 'bounded_coin_discovery',
        estimatedExecutionCostClaimMist: '500',
        quotedRequiredSettlementTokenAmount: '12',
      },
    },
    {
      evaluation: { outcome: 'indeterminate', reason: 'market_unavailable' },
      expected: {
        status: 'indeterminate',
        reason: 'market_unavailable',
        estimatedExecutionCostClaimMist: '500',
      },
    },
  ])(
    'projects one closed advisory result without reconstructing policy',
    async ({ evaluation, expected }) => {
      const limiter = new MemoryPrepareInflight(1);
      mocks.evaluateCurrentSettlementFunding.mockResolvedValueOnce(evaluation);
      await expect(
        handleSettlementFundingCheck(makeHost(limiter), params, config),
      ).resolves.toEqual(expected);
      expect(mocks.createSettlementFundingRunContext).toHaveBeenCalledWith(
        expect.objectContaining({ deepbookPackageId: config.deepbookPackageId }),
        expect.anything(),
      );
      expect(limiter.inflight).toBe(0);
    },
  );

  it('releases aggregate capacity after evaluation failure', async () => {
    const limiter = new MemoryPrepareInflight(1);
    const error = new Error('market transport');
    mocks.evaluateCurrentSettlementFunding.mockRejectedValueOnce(error);
    await expect(handleSettlementFundingCheck(makeHost(limiter), params, config)).rejects.toBe(
      error,
    );
    expect(limiter.inflight).toBe(0);
  });

  it('propagates request cancellation after an in-flight chain read and releases capacity', async () => {
    const limiter = new MemoryPrepareInflight(1);
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    let resolveCredit!: (value: {
      vaultObjectId: null;
      credit: string;
      needsCreate: true;
      lastNonce: string;
    }) => void;
    mocks.queryUserCredit.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCredit = resolve;
      }),
    );

    const operation = handleSettlementFundingCheck(
      makeHost(limiter),
      { ...params, signal: controller.signal },
      config,
    );
    await vi.waitFor(() => expect(mocks.queryUserCredit).toHaveBeenCalledTimes(1));
    controller.abort(reason);
    resolveCredit({
      vaultObjectId: null,
      credit: '0',
      needsCreate: true,
      lastNonce: '0',
    });

    await expect(operation).rejects.toBe(reason);
    expect(mocks.evaluateCurrentSettlementFunding).not.toHaveBeenCalled();
    expect(limiter.inflight).toBe(0);
  });
});
