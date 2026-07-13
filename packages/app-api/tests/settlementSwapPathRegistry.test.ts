/**
 * [app-api] settlementSwapPathRegistry unit tests.
 *
 * Covers:
 *   - parseSettlementSwapPathRegistryJson: network-keyed JSON -> registry entries
 *   - validateSettlementSwapPathRegistry: duplicate-token rejection, empty-registry rejection
 *   - determineSettlementToken: settle.move baseForQuote direction enforcement
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const { forbiddenReadFile, forbiddenReadFileSync } = vi.hoisted(() => ({
  forbiddenReadFile: vi.fn(() => {
    throw new Error('registry resolver must not read a file');
  }),
  forbiddenReadFileSync: vi.fn(() => {
    throw new Error('registry resolver must not read a file');
  }),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: forbiddenReadFile };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: forbiddenReadFileSync };
});
import {
  parseSettlementSwapPathRegistryJson,
  validateSettlementSwapPathRegistry,
  determineSettlementToken,
  resolveSettlementSwapPathRegistry,
} from '../src/settlementSwapPathRegistry.js';
import type { SingleHopSettlementSwapPath } from '@stelis/contracts';

vi.mock('@mysten/sui/transactions', () => {
  class Transaction {
    private target = '';

    moveCall(input: { target: string }) {
      this.target = input.target;
      return [];
    }

    object(id: string) {
      return id;
    }

    setSender() {
      return undefined;
    }

    async build() {
      return new TextEncoder().encode(this.target);
    }
  }

  return { Transaction };
});

const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
const USDC_TYPE = '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN';
const POOL_ID = '0xpool';
const DEEPBOOK_PACKAGE_ID = '0xdeepbook';

function settlementSwapPathRegistryJson(testnet: unknown, mainnet: unknown = []) {
  return { testnet, mainnet };
}

// ─────────────────────────────────────────────
// parseSettlementSwapPathRegistryJson
// ─────────────────────────────────────────────

describe('parseSettlementSwapPathRegistryJson', () => {
  it('parses a single 1-hop settlement swap path', () => {
    const result = parseSettlementSwapPathRegistryJson(
      settlementSwapPathRegistryJson(['0xabc123']),
      'testnet',
    );
    expect(result).toEqual([{ poolId: '0xabc123' }]);
  });

  it('parses multiple 1-hop settlement swap paths', () => {
    const result = parseSettlementSwapPathRegistryJson(
      settlementSwapPathRegistryJson(['0xabc', '0xdef']),
      'testnet',
    );
    expect(result).toEqual([{ poolId: '0xabc' }, { poolId: '0xdef' }]);
  });

  it('parses only the selected network section', () => {
    const result = parseSettlementSwapPathRegistryJson(
      settlementSwapPathRegistryJson(['0xtestnet'], ['0xmainnet']),
      'mainnet',
    );
    expect(result).toEqual([{ poolId: '0xmainnet' }]);
  });

  it('throws on old flat-array input', () => {
    expect(() => parseSettlementSwapPathRegistryJson(['0xabc123'], 'testnet')).toThrow('object');
  });

  it('throws on missing network section', () => {
    expect(() => parseSettlementSwapPathRegistryJson({ mainnet: ['0xabc123'] }, 'testnet')).toThrow(
      'testnet',
    );
  });

  it('throws on unsupported network section', () => {
    expect(() =>
      parseSettlementSwapPathRegistryJson(
        { testnet: ['0xabc123'], mainnet: [], devnet: ['0xdef456'] },
        'testnet',
      ),
    ).toThrow('Unsupported network section');
  });

  it('throws on empty selected network section', () => {
    expect(() =>
      parseSettlementSwapPathRegistryJson(settlementSwapPathRegistryJson([]), 'testnet'),
    ).toThrow('At least one pool ID');
  });

  it('throws on invalid pool ID format (no 0x prefix)', () => {
    expect(() =>
      parseSettlementSwapPathRegistryJson(settlementSwapPathRegistryJson(['abc123']), 'testnet'),
    ).toThrow('invalid pool ID');
  });

  it('throws on pool ID too short (just 0x)', () => {
    expect(() =>
      parseSettlementSwapPathRegistryJson(settlementSwapPathRegistryJson(['0x']), 'testnet'),
    ).toThrow('invalid pool ID');
  });

  it('rejects nested path-array format', () => {
    expect(() =>
      parseSettlementSwapPathRegistryJson(settlementSwapPathRegistryJson([['0xa']]), 'testnet'),
    ).toThrow('flat array of DeepBook pool IDs');
  });

  it('throws on non-string pool ID', () => {
    expect(() =>
      parseSettlementSwapPathRegistryJson(settlementSwapPathRegistryJson([123]), 'testnet'),
    ).toThrow('invalid pool ID');
  });
});

// ─────────────────────────────────────────────
// validateSettlementSwapPathRegistry
// ─────────────────────────────────────────────

/** Test helper to build a minimal SingleHopSettlementSwapPath. */
function makeSettlementSwapPath(
  settlementTokenType: string,
  symbol: string,
): SingleHopSettlementSwapPath {
  return {
    settlementTokenType,
    settlementTokenSymbol: symbol,
    settlementTokenDecimals: 9,
    lotSize: 1000,
    minSize: 10000,
    effectiveFeeRateBps: 0,
    settlementSwapDirection: 'baseForQuote',
    hops: [
      {
        poolId: '0xfake',
        baseType: settlementTokenType,
        quoteType: SUI_TYPE,
        swapDirection: 'baseForQuote',
        feeBps: 0,
      },
    ],
  };
}

describe('validateSettlementSwapPathRegistry', () => {
  it('accepts a valid single-path registry', () => {
    const settlementSwapPaths = [makeSettlementSwapPath(DEEP_TYPE, 'DEEP')];
    expect(() => validateSettlementSwapPathRegistry(settlementSwapPaths)).not.toThrow();
  });

  it('accepts multiple paths with distinct settlement tokens', () => {
    const settlementSwapPaths = [
      makeSettlementSwapPath(DEEP_TYPE, 'DEEP'),
      makeSettlementSwapPath(USDC_TYPE, 'USDC'),
    ];
    expect(() => validateSettlementSwapPathRegistry(settlementSwapPaths)).not.toThrow();
  });

  it('rejects empty registry', () => {
    expect(() => validateSettlementSwapPathRegistry([])).toThrow('Resolved registry is empty');
  });

  it('rejects duplicate settlementTokenType', () => {
    const settlementSwapPaths = [
      makeSettlementSwapPath(DEEP_TYPE, 'DEEP'),
      makeSettlementSwapPath(DEEP_TYPE, 'DEEP'),
    ];
    expect(() => validateSettlementSwapPathRegistry(settlementSwapPaths)).toThrow(
      'Duplicate settlementTokenType',
    );
  });

  it('rejects fee drift between path and hop metadata', () => {
    const settlementSwapPath = makeSettlementSwapPath(DEEP_TYPE, 'DEEP');
    settlementSwapPath.effectiveFeeRateBps = 25;
    settlementSwapPath.hops[0].feeBps = 20;
    expect(() => validateSettlementSwapPathRegistry([settlementSwapPath])).toThrow(
      'feeBps must equal effectiveFeeRateBps',
    );
  });

  it('rejects fee metadata over 100%', () => {
    const settlementSwapPath = makeSettlementSwapPath(DEEP_TYPE, 'DEEP');
    settlementSwapPath.effectiveFeeRateBps = 10_001;
    settlementSwapPath.hops[0].feeBps = 10_001;
    expect(() => validateSettlementSwapPathRegistry([settlementSwapPath])).toThrow(
      'effectiveFeeRateBps must be a safe integer in [0, 10000]',
    );
  });
});

// ─────────────────────────────────────────────
// determineSettlementToken (settlement swap direction enforcement)
// ─────────────────────────────────────────────

describe('determineSettlementToken', () => {
  it('accepts Pool<Token, SUI> → baseForQuote', () => {
    const result = determineSettlementToken({ baseType: DEEP_TYPE, quoteType: SUI_TYPE });
    expect(result.settlementTokenType).toBe(DEEP_TYPE);
    expect(result.swapDirection).toBe('baseForQuote');
  });

  it('accepts Pool<SUI, Token> → quoteForBase', () => {
    const result = determineSettlementToken({ baseType: SUI_TYPE, quoteType: DEEP_TYPE });
    expect(result.settlementTokenType).toBe(DEEP_TYPE);
    expect(result.swapDirection).toBe('quoteForBase');
  });

  it('rejects Pool<Token1, Token2> (no SUI on either side)', () => {
    expect(() => determineSettlementToken({ baseType: DEEP_TYPE, quoteType: USDC_TYPE })).toThrow(
      'Neither base nor quote is SUI',
    );
  });
});

// ─────────────────────────────────────────────
// resolveSettlementSwapPathRegistry fee derivation
// ─────────────────────────────────────────────

function bcsU64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

function bcsBool(value: boolean): Uint8Array {
  return new Uint8Array([value ? 1 : 0]);
}

function viewResult(values: Uint8Array[]) {
  return {
    Transaction: {},
    commandResults: [
      {
        returnValues: values.map((bcs) => ({ bcs })),
      },
    ],
  };
}

describe('resolveSettlementSwapPathRegistry', () => {
  beforeEach(() => {
    forbiddenReadFile.mockClear();
    forbiddenReadFileSync.mockClear();
  });

  it('publishes fee-bearing settlement swap paths on Stelis input-fee basis', async () => {
    const client = {
      getObject: vi.fn(async () => ({
        object: {
          type: `${DEEPBOOK_PACKAGE_ID}::pool::Pool<${USDC_TYPE}, ${SUI_TYPE}>`,
        },
      })),
      getCoinMetadata: vi.fn(async () => ({
        coinMetadata: { symbol: 'USDC', decimals: 6 },
      })),
      simulateTransaction: vi.fn(async ({ transaction }: { transaction: Uint8Array }) => {
        const target = new TextDecoder().decode(transaction);
        if (target.endsWith('::constants::float_scaling')) {
          return viewResult([bcsU64(1_000_000_000n)]);
        }
        if (target.endsWith('::constants::fee_penalty_multiplier')) {
          return viewResult([bcsU64(1_250_000_000n)]);
        }
        if (target.endsWith('::pool::pool_book_params')) {
          return viewResult([bcsU64(1n), bcsU64(1_000n), bcsU64(10_000n)]);
        }
        if (target.endsWith('::pool::whitelisted')) {
          return viewResult([bcsBool(false)]);
        }
        if (target.endsWith('::pool::pool_trade_params')) {
          // DeepBook taker_fee 2_000_000 / 1e9 = 20 bps in DEEP-fee mode.
          // Stelis executes input-fee mode, which applies the 1.25x penalty: 25 bps.
          return viewResult([bcsU64(2_000_000n), bcsU64(0n), bcsU64(0n)]);
        }
        throw new Error(`unexpected view call target: ${target}`);
      }),
    };

    const entries = parseSettlementSwapPathRegistryJson(
      settlementSwapPathRegistryJson([POOL_ID]),
      'testnet',
    );
    const settlementSwapPaths = await resolveSettlementSwapPathRegistry(
      client as never,
      DEEPBOOK_PACKAGE_ID,
      entries,
    );
    expect(settlementSwapPaths).toHaveLength(1);
    expect(settlementSwapPaths[0].effectiveFeeRateBps).toBe(25);
    expect(settlementSwapPaths[0].hops[0].feeBps).toBe(25);
    expect(forbiddenReadFile).not.toHaveBeenCalled();
    expect(forbiddenReadFileSync).not.toHaveBeenCalled();
  });

  it('uses deployed DeepBook fee constants instead of local literals', async () => {
    const client = {
      getObject: vi.fn(async () => ({
        object: {
          type: `${DEEPBOOK_PACKAGE_ID}::pool::Pool<${USDC_TYPE}, ${SUI_TYPE}>`,
        },
      })),
      getCoinMetadata: vi.fn(async () => ({
        coinMetadata: { symbol: 'USDC', decimals: 6 },
      })),
      simulateTransaction: vi.fn(async ({ transaction }: { transaction: Uint8Array }) => {
        const target = new TextDecoder().decode(transaction);
        if (target.endsWith('::constants::float_scaling')) {
          return viewResult([bcsU64(1_000_000_000n)]);
        }
        if (target.endsWith('::constants::fee_penalty_multiplier')) {
          return viewResult([bcsU64(2_000_000_000n)]);
        }
        if (target.endsWith('::pool::pool_book_params')) {
          return viewResult([bcsU64(1n), bcsU64(1_000n), bcsU64(10_000n)]);
        }
        if (target.endsWith('::pool::whitelisted')) {
          return viewResult([bcsBool(false)]);
        }
        if (target.endsWith('::pool::pool_trade_params')) {
          return viewResult([bcsU64(2_000_000n), bcsU64(0n), bcsU64(0n)]);
        }
        throw new Error(`unexpected view call target: ${target}`);
      }),
    };

    const entries = parseSettlementSwapPathRegistryJson(
      settlementSwapPathRegistryJson([POOL_ID]),
      'testnet',
    );
    const settlementSwapPaths = await resolveSettlementSwapPathRegistry(
      client as never,
      DEEPBOOK_PACKAGE_ID,
      entries,
    );
    expect(settlementSwapPaths[0].effectiveFeeRateBps).toBe(40);
    expect(settlementSwapPaths[0].hops[0].feeBps).toBe(40);
  });
});
