/**
 * deriveAllowedSettlementSwapPaths — fail-closed integrity check tests.
 *
 * Validates that server-side settlement swap path derivation rejects configs
 * whose settlementSwapDirection is inconsistent with either hop count or ordered
 * swapDirection vector. This is the boot-time barrier that locks runtime config
 * against the on-chain Move entry signatures.
 */
import { describe, it, expect } from 'vitest';
import { createStaticSettlementSwapPathDescriptorMap } from '@stelis/core-relay/server';
import { deriveAllowedSettlementSwapPaths, resolvePrepareConfig } from '../src/prepareConfig.js';
import type { SingleHopSettlementSwapPath } from '@stelis/contracts';

const USDC = '0x' + 'cc'.repeat(32) + '::usdc::USDC';
const DEEP = '0x' + 'de'.repeat(32) + '::deep::DEEP';
const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const POOL_A = '0x' + 'a1'.repeat(32);
const POOL_B = '0x' + 'b2'.repeat(32);

function settlementSwapPath(
  overrides: Partial<SingleHopSettlementSwapPath>,
): SingleHopSettlementSwapPath {
  return {
    settlementTokenType: DEEP,
    settlementTokenSymbol: 'DEEP',
    settlementTokenDecimals: 6,
    lotSize: 1n,
    minSize: 1n,
    effectiveFeeRateBps: 0,
    settlementSwapDirection: 'baseForQuote',
    hops: [
      { poolId: POOL_A, baseType: DEEP, quoteType: SUI, swapDirection: 'baseForQuote', feeBps: 0 },
    ],
    ...overrides,
  } as SingleHopSettlementSwapPath;
}

describe('deriveAllowedSettlementSwapPaths — settlementSwapDirection ↔ swapDirection vector integrity', () => {
  it('accepts baseForQuote direction with swapDirection=baseForQuote', () => {
    const result = deriveAllowedSettlementSwapPaths([settlementSwapPath({})]);
    expect(result).toHaveLength(1);
    expect(result[0].settlementSwapDirection).toBe('baseForQuote');
  });

  it('accepts quoteForBase direction with swapDirection=quoteForBase', () => {
    const result = deriveAllowedSettlementSwapPaths([
      settlementSwapPath({
        settlementTokenType: USDC,
        settlementTokenSymbol: 'USDC',
        settlementSwapDirection: 'quoteForBase',
        hops: [
          {
            poolId: POOL_A,
            baseType: SUI,
            quoteType: USDC,
            swapDirection: 'quoteForBase',
            feeBps: 0,
          },
        ],
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].settlementSwapDirection).toBe('quoteForBase');
  });

  it('rejects duplicate settlementTokenType because each token selects one active settlement swap path', () => {
    expect(() =>
      deriveAllowedSettlementSwapPaths([
        settlementSwapPath({}),
        settlementSwapPath({
          hops: [
            {
              poolId: POOL_B,
              baseType: DEEP,
              quoteType: SUI,
              swapDirection: 'baseForQuote',
              feeBps: 0,
            },
          ],
        }),
      ]),
    ).toThrow(/Duplicate settlementTokenType/);
  });

  it('rejects baseForQuote direction with swapDirection=quoteForBase (swapDirection vector mismatch)', () => {
    expect(() =>
      deriveAllowedSettlementSwapPaths([
        settlementSwapPath({
          hops: [
            {
              poolId: POOL_A,
              baseType: DEEP,
              quoteType: SUI,
              swapDirection: 'quoteForBase',
              feeBps: 0,
            },
          ],
        }),
      ]),
    ).toThrow(
      /settlementSwapDirection 'baseForQuote' requires hops\[0\]\.swapDirection='baseForQuote'/,
    );
  });

  it('rejects quoteForBase direction with swapDirection=baseForQuote (swapDirection vector mismatch)', () => {
    expect(() =>
      deriveAllowedSettlementSwapPaths([
        settlementSwapPath({
          settlementSwapDirection: 'quoteForBase',
          hops: [
            {
              poolId: POOL_A,
              baseType: SUI,
              quoteType: DEEP,
              swapDirection: 'baseForQuote',
              feeBps: 0,
            },
          ],
        }),
      ]),
    ).toThrow(
      /settlementSwapDirection 'quoteForBase' requires hops\[0\]\.swapDirection='quoteForBase'/,
    );
  });

  it('rejects baseForQuote direction with 2 hops (hop count mismatch)', () => {
    expect(() =>
      deriveAllowedSettlementSwapPaths([
        settlementSwapPath({
          settlementSwapDirection: 'baseForQuote',
          hops: [
            {
              poolId: POOL_A,
              baseType: DEEP,
              quoteType: SUI,
              swapDirection: 'baseForQuote',
              feeBps: 0,
            },
            {
              poolId: POOL_B,
              baseType: DEEP,
              quoteType: SUI,
              swapDirection: 'baseForQuote',
              feeBps: 0,
            },
          ],
        }),
      ]),
    ).toThrow(/settlementSwapDirection 'baseForQuote' requires 1 hop\(s\), got 2/);
  });
});

describe('resolvePrepareConfig — settlement swap path descriptor coverage', () => {
  it('accepts descriptors derived from the same supported settlement swap path set', () => {
    const settlementSwapPaths = [settlementSwapPath({})];
    const result = resolvePrepareConfig({
      settlementSwapPaths,
      descriptors: createStaticSettlementSwapPathDescriptorMap(settlementSwapPaths),
      deepbookPackageId: '0xDEEPBOOK',
    });

    expect(result.supportedSettlementSwapPaths).toEqual(settlementSwapPaths);
    expect(result.settlementSwapPathDescriptors.size).toBe(1);
  });

  it('rejects a supported settlement swap path without a matching descriptor', () => {
    expect(() =>
      resolvePrepareConfig({
        settlementSwapPaths: [settlementSwapPath({})],
        descriptors: new Map(),
        deepbookPackageId: '0xDEEPBOOK',
      }),
    ).toThrow(/Missing StaticSettlementSwapPathDescriptor/);
  });

  it('rejects descriptors that are not backed by supportedSettlementSwapPaths', () => {
    const settlementSwapPaths = [settlementSwapPath({})];
    const extraSettlementSwapPath = settlementSwapPath({
      settlementTokenType: USDC,
      settlementTokenSymbol: 'USDC',
      settlementSwapDirection: 'quoteForBase',
      hops: [
        {
          poolId: POOL_B,
          baseType: SUI,
          quoteType: USDC,
          swapDirection: 'quoteForBase',
          feeBps: 0,
        },
      ],
    });
    const descriptors = createStaticSettlementSwapPathDescriptorMap([
      ...settlementSwapPaths,
      extraSettlementSwapPath,
    ]);

    expect(() =>
      resolvePrepareConfig({
        settlementSwapPaths,
        descriptors,
        deepbookPackageId: '0xDEEPBOOK',
      }),
    ).toThrow(/Unexpected StaticSettlementSwapPathDescriptor/);
  });

  it('rejects a descriptor whose execution fields drift from the supported settlement swap path', () => {
    const settlementSwapPaths = [settlementSwapPath({})];
    const descriptors = createStaticSettlementSwapPathDescriptorMap([
      settlementSwapPath({
        lotSize: 2n,
      }),
    ]);

    expect(() =>
      resolvePrepareConfig({
        settlementSwapPaths,
        descriptors,
        deepbookPackageId: '0xDEEPBOOK',
      }),
    ).toThrow(/lotSize expected 1, got 2/);
  });
});
