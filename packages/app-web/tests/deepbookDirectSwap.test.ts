import { describe, expect, test, vi } from 'vitest';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { TestSwapPair } from '../src/pages/sandbox/testSwapPairs';

const { getQuantityOutMock } = vi.hoisted(() => ({ getQuantityOutMock: vi.fn() }));

vi.mock('@stelis/core-relay/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stelis/core-relay/browser')>();
  return { ...actual, getQuantityOut: getQuantityOutMock };
});

import {
  calculateMinOutputSmallest,
  quoteDirectSwapOutput,
} from '../src/pages/sandbox/deepbookDirectSwap';

const PAIR: TestSwapPair = {
  settlementTokenType: '0x1::coin::COIN',
  label: 'COIN',
  poolId: '0x2',
  baseType: '0x2::sui::SUI',
  quoteType: '0x1::coin::COIN',
  swapDirection: 'swap_exact_base_for_quote',
};

function client(): SuiGrpcClient {
  return { network: 'testnet' } as unknown as SuiGrpcClient;
}

describe('direct DeepBook quote', () => {
  test('uses the shared exact quantity-out authority and applies the local slippage floor', async () => {
    getQuantityOutMock.mockResolvedValueOnce(1_000_000n);

    await expect(
      quoteDirectSwapOutput({
        client: client(),
        deepbookPackageId: '0x3',
        testPair: PAIR,
        inputAmountSmallest: 1_000n,
      }),
    ).resolves.toEqual({
      expectedOutputSmallest: 1_000_000n,
      minOutputSmallest: 980_000n,
    });

    expect(getQuantityOutMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpointCount: 1, network: 'testnet' }),
      '0x3',
      {
        poolId: PAIR.poolId,
        baseType: PAIR.baseType,
        quoteType: PAIR.quoteType,
        swapDirection: 'baseForQuote',
      },
      1_000n,
    );
  });

  test('maps quote-for-base direction without inventing a fee field', async () => {
    getQuantityOutMock.mockResolvedValueOnce(10_000n);
    const quoteForBase = { ...PAIR, swapDirection: 'swap_exact_quote_for_base' as const };

    await quoteDirectSwapOutput({
      client: client(),
      deepbookPackageId: '0x3',
      testPair: quoteForBase,
      inputAmountSmallest: 100n,
    });

    expect(getQuantityOutMock).toHaveBeenCalledWith(
      expect.anything(),
      '0x3',
      expect.objectContaining({ swapDirection: 'quoteForBase' }),
      100n,
    );
  });

  test('propagates exact gateway failures instead of manufacturing a quote', async () => {
    getQuantityOutMock.mockRejectedValueOnce(new Error('malformed quantity-out result'));

    await expect(
      quoteDirectSwapOutput({
        client: client(),
        deepbookPackageId: '0x3',
        testPair: PAIR,
        inputAmountSmallest: 1_000n,
      }),
    ).rejects.toThrow('malformed quantity-out result');
  });

  test('requires a positive input and a positive slippage-adjusted output', async () => {
    await expect(
      quoteDirectSwapOutput({
        client: client(),
        deepbookPackageId: '0x3',
        testPair: PAIR,
        inputAmountSmallest: 0n,
      }),
    ).rejects.toThrow('greater than 0');
    expect(() => calculateMinOutputSmallest(0n, 200)).toThrow('no settlement token output');
    expect(() => calculateMinOutputSmallest(1n, 9_999)).toThrow('too small');
  });
});
