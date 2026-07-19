/**
 * [app-api] settlementSwapPathRegistry unit tests.
 *
 * Covers:
 *   - parseSettlementSwapPathRegistryJson: network-keyed JSON -> registry entries
 *   - validateSettlementSwapPathRegistry: duplicate-token rejection, empty-registry rejection
 *   - determineSettlementToken: settle.move baseForQuote direction enforcement
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createSuiEndpointSnapshot, type SuiEndpointSnapshot } from '@stelis/core-relay';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

const {
  forbiddenReadFile,
  forbiddenReadFileSync,
  getSuiCoinMetadata,
  getSuiObject,
  simulateSuiMoveView,
} = vi.hoisted(() => ({
  forbiddenReadFile: vi.fn(() => {
    throw new Error('registry resolver must not read a file');
  }),
  forbiddenReadFileSync: vi.fn(() => {
    throw new Error('registry resolver must not read a file');
  }),
  getSuiCoinMetadata: vi.fn(),
  getSuiObject: vi.fn(),
  simulateSuiMoveView: vi.fn(),
}));

vi.mock('@stelis/core-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stelis/core-relay')>()),
  getSuiCoinMetadata,
  getSuiObject,
  simulateSuiMoveView,
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
import { DEEPBOOK_RUNTIME_PACKAGE_ID, type SingleHopSettlementSwapPath } from '@stelis/contracts';

const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const DEEP_TYPE = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
const USDC_TYPE = '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN';
const POOL_ID = `0x${'44'.repeat(32)}`;
const DEEPBOOK_PACKAGE_ID = `0x${'55'.repeat(32)}`;
const SECOND_POOL_ID = `0x${'66'.repeat(32)}`;

function settlementSwapPathRegistryJson(testnet: unknown, mainnet: unknown = []) {
  return { testnet, mainnet };
}

// ─────────────────────────────────────────────
// parseSettlementSwapPathRegistryJson
// ─────────────────────────────────────────────

describe('parseSettlementSwapPathRegistryJson', () => {
  it('parses a single 1-hop settlement swap path', () => {
    const result = parseSettlementSwapPathRegistryJson(
      settlementSwapPathRegistryJson([POOL_ID]),
      'testnet',
    );
    expect(result).toEqual([{ poolId: normalizeSuiAddress(POOL_ID) }]);
  });

  it('parses multiple 1-hop settlement swap paths', () => {
    const result = parseSettlementSwapPathRegistryJson(
      settlementSwapPathRegistryJson([POOL_ID, SECOND_POOL_ID]),
      'testnet',
    );
    expect(result).toEqual([
      { poolId: normalizeSuiAddress(POOL_ID) },
      { poolId: normalizeSuiAddress(SECOND_POOL_ID) },
    ]);
  });

  it('parses only the selected network section', () => {
    const result = parseSettlementSwapPathRegistryJson(
      settlementSwapPathRegistryJson([POOL_ID], [SECOND_POOL_ID]),
      'mainnet',
    );
    expect(result).toEqual([{ poolId: normalizeSuiAddress(SECOND_POOL_ID) }]);
  });

  it('throws on old flat-array input', () => {
    expect(() => parseSettlementSwapPathRegistryJson([POOL_ID], 'testnet')).toThrow('object');
  });

  it('throws on missing network section', () => {
    expect(() => parseSettlementSwapPathRegistryJson({ mainnet: [POOL_ID] }, 'testnet')).toThrow(
      'testnet',
    );
  });

  it('throws on unsupported network section', () => {
    expect(() =>
      parseSettlementSwapPathRegistryJson(
        { testnet: [POOL_ID], mainnet: [], devnet: [SECOND_POOL_ID] },
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
    lotSize: 1000n,
    minSize: 10000n,
    effectiveFeeRateBps: 0,
    settlementSwapDirection: 'baseForQuote',
    hops: [
      {
        poolId: normalizeSuiAddress(POOL_ID),
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
    outcome: 'success' as const,
    commandResults: [
      {
        returnValues: values.map((bcs) => ({ bcs })),
        mutatedReferences: [],
      },
    ],
  };
}

const ENDPOINT_SNAPSHOT = createSuiEndpointSnapshot([{ network: 'testnet' } as SuiGrpcClient]);

function configureResolverGateways(feePenaltyMultiplier: bigint): void {
  getSuiObject.mockResolvedValue({
    type: `${DEEPBOOK_RUNTIME_PACKAGE_ID}::pool::Pool<${USDC_TYPE}, ${SUI_TYPE}>`,
  });
  getSuiCoinMetadata.mockResolvedValue({ symbol: 'USDC', decimals: 6 });
  simulateSuiMoveView.mockImplementation(
    async (
      _snapshot: SuiEndpointSnapshot,
      { transaction }: { readonly transaction: Transaction },
    ) => {
      const data = transaction.getData();
      if (data.sender !== null) {
        throw new Error('registry caller must leave Move-view sender ownership to the gateway');
      }
      if (
        data.gasData.budget !== null ||
        data.gasData.owner !== null ||
        data.gasData.payment !== null ||
        data.gasData.price !== null
      ) {
        throw new Error('registry caller must leave Move-view gas ownership to the gateway');
      }
      const command = data.commands[0];
      if (data.commands.length !== 1 || command?.$kind !== 'MoveCall') {
        throw new Error('registry fixture expected exactly one current MoveCall');
      }
      const moveCall = command.MoveCall;
      const target = `${moveCall.package}::${moveCall.module}::${moveCall.function}`;
      if (target.endsWith('::constants::float_scaling')) {
        return viewResult([bcsU64(1_000_000_000n)]);
      }
      if (target.endsWith('::constants::fee_penalty_multiplier')) {
        return viewResult([bcsU64(feePenaltyMultiplier)]);
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
    },
  );
}

describe('resolveSettlementSwapPathRegistry', () => {
  beforeEach(() => {
    forbiddenReadFile.mockClear();
    forbiddenReadFileSync.mockClear();
    getSuiCoinMetadata.mockReset();
    getSuiObject.mockReset();
    simulateSuiMoveView.mockReset();
  });

  it('publishes fee-bearing settlement swap paths on Stelis input-fee basis', async () => {
    configureResolverGateways(1_250_000_000n);

    const entries = parseSettlementSwapPathRegistryJson(
      settlementSwapPathRegistryJson([POOL_ID]),
      'testnet',
    );
    const settlementSwapPaths = await resolveSettlementSwapPathRegistry(
      ENDPOINT_SNAPSHOT,
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
    configureResolverGateways(2_000_000_000n);

    const entries = parseSettlementSwapPathRegistryJson(
      settlementSwapPathRegistryJson([POOL_ID]),
      'testnet',
    );
    const settlementSwapPaths = await resolveSettlementSwapPathRegistry(
      ENDPOINT_SNAPSHOT,
      DEEPBOOK_PACKAGE_ID,
      entries,
    );
    expect(settlementSwapPaths[0].effectiveFeeRateBps).toBe(40);
    expect(settlementSwapPaths[0].hops[0].feeBps).toBe(40);
  });

  it('rejects published and unrelated package IDs as Pool runtime identity', async () => {
    configureResolverGateways(1_250_000_000n);
    getSuiObject.mockResolvedValue({
      type: `${DEEPBOOK_PACKAGE_ID}::pool::Pool<${USDC_TYPE}, ${SUI_TYPE}>`,
    });

    const entries = parseSettlementSwapPathRegistryJson(
      settlementSwapPathRegistryJson([POOL_ID]),
      'testnet',
    );
    await expect(
      resolveSettlementSwapPathRegistry(ENDPOINT_SNAPSHOT, DEEPBOOK_PACKAGE_ID, entries),
    ).rejects.toThrow('object is not the current DeepBook Pool type');

    configureResolverGateways(1_250_000_000n);
    getSuiObject.mockResolvedValue({
      type: `${normalizeSuiAddress(`0x${'77'.repeat(32)}`)}::pool::Pool<${USDC_TYPE}, ${SUI_TYPE}>`,
    });
    await expect(
      resolveSettlementSwapPathRegistry(ENDPOINT_SNAPSHOT, DEEPBOOK_PACKAGE_ID, entries),
    ).rejects.toThrow('object is not the current DeepBook Pool type');
  });

  it('rejects command results carried by a failed DeepBook view transaction', async () => {
    getSuiObject.mockResolvedValue({
      type: `${DEEPBOOK_PACKAGE_ID}::pool::Pool<${USDC_TYPE}, ${SUI_TYPE}>`,
    });
    getSuiCoinMetadata.mockResolvedValue({ symbol: 'USDC', decimals: 6 });
    simulateSuiMoveView.mockResolvedValue({
      outcome: 'failure',
      error: { kind: 'InvariantViolation' },
      // A failed RPC result may still carry decodable-looking values. They
      // are not authoritative view output and must never enter the registry.
      commandResults: [{ returnValues: [{ bcs: bcsU64(1_000_000_000n) }] }],
    });

    const entries = parseSettlementSwapPathRegistryJson(
      settlementSwapPathRegistryJson([POOL_ID]),
      'testnet',
    );
    await expect(
      resolveSettlementSwapPathRegistry(ENDPOINT_SNAPSHOT, DEEPBOOK_PACKAGE_ID, entries),
    ).rejects.toThrow('DeepBook float_scaling failed: Sui execution failed (InvariantViolation)');
  });

  it('rejects extra command results instead of selecting the first result', async () => {
    configureResolverGateways(1_250_000_000n);
    const command = {
      returnValues: [{ bcs: bcsU64(1_000_000_000n) }],
      mutatedReferences: [],
    };
    simulateSuiMoveView.mockResolvedValue({
      outcome: 'success',
      commandResults: [command, command],
    });

    const entries = parseSettlementSwapPathRegistryJson(
      settlementSwapPathRegistryJson([POOL_ID]),
      'testnet',
    );
    await expect(
      resolveSettlementSwapPathRegistry(ENDPOINT_SNAPSHOT, DEEPBOOK_PACKAGE_ID, entries),
    ).rejects.toThrow('returned 2 command results (expected 1)');
  });

  it('rejects extra return values and mutated references from fixed-ABI views', async () => {
    configureResolverGateways(1_250_000_000n);
    simulateSuiMoveView.mockResolvedValue(viewResult([bcsU64(1n), bcsU64(2n)]));

    const entries = parseSettlementSwapPathRegistryJson(
      settlementSwapPathRegistryJson([POOL_ID]),
      'testnet',
    );
    const first = resolveSettlementSwapPathRegistry(
      ENDPOINT_SNAPSHOT,
      DEEPBOOK_PACKAGE_ID,
      entries,
    );
    await expect(first).rejects.toThrow('returned 2 values (expected 1)');

    configureResolverGateways(1_250_000_000n);
    simulateSuiMoveView.mockResolvedValue({
      outcome: 'success',
      commandResults: [
        {
          returnValues: [{ bcs: bcsU64(1n) }],
          mutatedReferences: [{ bcs: bcsU64(2n) }],
        },
      ],
    });
    await expect(
      resolveSettlementSwapPathRegistry(ENDPOINT_SNAPSHOT, DEEPBOOK_PACKAGE_ID, entries),
    ).rejects.toThrow('unexpectedly returned mutated references');
  });
});
