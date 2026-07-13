/**
 * connect() policy branch tests.
 *
 * Tests verify:
 * - pinnedPackageId validation (S-16 step 2)
 * - rogue Host packageId rejection (S-16 step 1)
 * - strict current config field parsing
 * - settlement swap path integrity fail-closed (settlementSwapDirection ↔ hops ↔ swapDirection)
 * - studioEndpoint mode guard
 *
 * connect() now takes a required endpoint string. There is no canonical fallback,
 * no reconnect(), no allowCanonicalFallback, and no endpoint-switch callbacks.
 * Errors from config parsing, package ID checks, and status checks are thrown directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StelisSDK } from '../src/sdk.js';
import type { RelayConfigResponse, RelayPrepareResponse } from '../src/types.js';
import { STELIS_CONTRACT_IDS } from '@stelis/contracts';

// ── Module-level mock: StelisClient ─────────────────────────────────────────────
const mockPrepare = vi.fn<(params: Record<string, unknown>) => Promise<RelayPrepareResponse>>();

vi.mock('../src/client.js', () => ({
  StelisClient: vi.fn().mockImplementation(function ({ endpoint }: { endpoint: string }) {
    return {
      getStatus: vi.fn().mockResolvedValue({ ok: true }),
      prepare: mockPrepare,
      sponsor: vi.fn(),
      endpoint,
    };
  }),
  StelisApiException: class StelisApiException extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
}));

// ── Module-level mock: integrity ────────────────────────────────────────────────
vi.mock('../src/integrity.js', () => ({
  verifyPtbIntegrity: vi.fn(),
  StelisIntegrityError: class StelisIntegrityError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'StelisIntegrityError';
    }
  },
}));

// ── Module-level mock: queryUserCredit ──────────────────────────────────────────
vi.mock('../src/credit.js', () => ({
  queryUserCredit: vi.fn(async () => ({ vaultObjectId: null, credit: '0', needsCreate: false })),
}));

// ── Mock fetch ─────────────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Constants ──────────────────────────────────────────────────────────────────
const CANONICAL_PKG = STELIS_CONTRACT_IDS.testnet!.packageId;
const PKG_B = '0x' + 'b'.repeat(64);

function makeConfig(overrides: Partial<RelayConfigResponse> = {}): RelayConfigResponse {
  return {
    network: 'testnet',
    packageId: CANONICAL_PKG,
    settlementPayoutRecipient: '0x' + 'e'.repeat(64),
    supportedSettlementSwapPaths: [
      {
        hops: [
          {
            poolId: '0x' + '4'.repeat(64),
            baseType: `${CANONICAL_PKG}::deep::DEEP`,
            quoteType: '0x2::sui::SUI',
            swapDirection: 'baseForQuote' as const,
            feeBps: 0,
          },
        ],
        settlementTokenType: `${CANONICAL_PKG}::deep::DEEP`,
        settlementTokenSymbol: 'DEEP',
        settlementTokenDecimals: 6,
        lotSize: 100,
        minSize: 1_000_000,
        effectiveFeeRateBps: 0,
        settlementSwapDirection: 'baseForQuote' as const,
      },
    ],
    quotedHostFeeMist: '100000',
    protocolFlatFeeMist: '20000',
    ...overrides,
  };
}

function stubConfig(config: unknown): void {
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }));
}

beforeEach(() => {
  mockFetch.mockReset();
  mockPrepare.mockReset();
});

// ─────────────────────────────────────────────
// connect — pinnedPackageId tests
// ─────────────────────────────────────────────

describe('StelisSDK.connect — pinnedPackageId policy', () => {
  it('connects when pinnedPackageId matches canonical constant', async () => {
    stubConfig(makeConfig());
    const sdk = await StelisSDK.connect('http://primary/api', { pinnedPackageId: CANONICAL_PKG });
    expect(sdk).toBeDefined();
    expect(sdk.config.packageId).toBe(CANONICAL_PKG);
  });

  it('rejects when pinnedPackageId does not match canonical constant', async () => {
    stubConfig(makeConfig());
    await expect(
      StelisSDK.connect('http://primary/api', { pinnedPackageId: PKG_B }),
    ).rejects.toThrow('pinnedPackageId mismatch');
  });

  it('connects without pin — any network is accepted', async () => {
    stubConfig(makeConfig());
    const sdk = await StelisSDK.connect('http://primary/api');
    expect(sdk.config.packageId).toBe(CANONICAL_PKG);
  });

  it('rejects rogue Host advertising wrong packageId', async () => {
    stubConfig(makeConfig({ packageId: PKG_B }));
    await expect(
      StelisSDK.connect('http://primary/api', { pinnedPackageId: CANONICAL_PKG }),
    ).rejects.toThrow('Relay config packageId mismatch');
  });
});

// ─────────────────────────────────────────────
// Config field tests
// ─────────────────────────────────────────────

describe('StelisSDK — current config fields', () => {
  it('rejects fields outside the current Relay config contract', async () => {
    stubConfig({ ...makeConfig(), obsoleteField: 1 });
    await expect(StelisSDK.connect('http://primary/api')).rejects.toThrow(
      'obsoleteField is not a current field',
    );
  });
  it('config with unsafe-integer lotSize is rejected at connect', async () => {
    const config = makeConfig();
    (config.supportedSettlementSwapPaths[0] as Record<string, unknown>).lotSize =
      Number.MAX_SAFE_INTEGER + 1;
    stubConfig(config);
    await expect(StelisSDK.connect('http://primary/api')).rejects.toThrow(
      'lotSize must be a safe integer',
    );
  });

  it('config with missing lotSize is rejected at connect', async () => {
    const config = makeConfig();
    delete (config.supportedSettlementSwapPaths[0] as Record<string, unknown>).lotSize;
    stubConfig(config);
    await expect(StelisSDK.connect('http://primary/api')).rejects.toThrow(
      'lotSize must be a safe integer',
    );
  });

  it('config without quotedHostFeeMist is rejected at connect', async () => {
    const invalid = { ...makeConfig() };
    delete (invalid as Record<string, unknown>).quotedHostFeeMist;
    stubConfig(invalid);
    await expect(StelisSDK.connect('http://primary/api')).rejects.toThrow(
      'quotedHostFeeMist must be a string',
    );
  });

  it('config with non-decimal fee strings is rejected at connect', async () => {
    stubConfig({ ...makeConfig(), protocolFlatFeeMist: '1.5' });
    await expect(StelisSDK.connect('http://primary/api')).rejects.toThrow(
      'protocolFlatFeeMist must be a canonical non-negative decimal string',
    );
  });
});

// ─────────────────────────────────────────────
// connect — studioEndpoint mode guard
// ─────────────────────────────────────────────

describe('StelisSDK.connect — studioEndpoint mode guard', () => {
  it('connects to explicit endpoint in studio mode', async () => {
    stubConfig(makeConfig());
    const sdk = await StelisSDK.connect('http://studio.local/api', { studioEndpoint: true });
    expect(sdk).toBeDefined();
  });

  it('promotion methods throw when not in studio mode', async () => {
    stubConfig(makeConfig());
    const sdk = await StelisSDK.connect('http://primary/api');
    // preparePromotionSponsored requires studioEndpoint: true
    await expect(
      sdk.preparePromotionSponsored({} as import('@mysten/sui/transactions').Transaction, {
        client: {} as import('@mysten/sui/grpc').SuiGrpcClient,
        promotionId: 'p1',
        addr: '0x1',
        developerJwt: 'jwt',
      }),
    ).rejects.toThrow('studioEndpoint: true');
  });
});

// ─────────────────────────────────────────────
// Settlement swap path integrity validation in parseRelayConfigResponse
// ─────────────────────────────────────────────

describe('parseRelayConfigResponse — settlement swap path integrity fail-closed', () => {
  // connect() reports parse errors directly; no fallback wrapping applied.

  it('rejects missing settlementSwapDirection', async () => {
    const bad = makeConfig();
    delete (bad.supportedSettlementSwapPaths[0] as Record<string, unknown>).settlementSwapDirection;
    stubConfig(bad);
    await expect(
      StelisSDK.connect('http://primary/api', { pinnedPackageId: CANONICAL_PKG }),
    ).rejects.toThrow('settlementSwapDirection is invalid');
  });

  it('rejects invalid settlementSwapDirection value', async () => {
    const bad = makeConfig();
    (bad.supportedSettlementSwapPaths[0] as Record<string, unknown>).settlementSwapDirection =
      '_2hop';
    stubConfig(bad);
    await expect(
      StelisSDK.connect('http://primary/api', { pinnedPackageId: CANONICAL_PKG }),
    ).rejects.toThrow('settlementSwapDirection is invalid');
  });

  it('rejects swapDirection ↔ settlementSwapDirection mismatch (baseForQuote direction with quoteForBase hop)', async () => {
    const bad = makeConfig();
    (bad.supportedSettlementSwapPaths[0].hops[0] as Record<string, unknown>).swapDirection =
      'quoteForBase';
    stubConfig(bad);
    await expect(
      StelisSDK.connect('http://primary/api', { pinnedPackageId: CANONICAL_PKG }),
    ).rejects.toThrow('hops do not match settlementSwapDirection');
  });

  it('rejects missing hops array', async () => {
    const bad = makeConfig();
    delete (bad.supportedSettlementSwapPaths[0] as Record<string, unknown>).hops;
    stubConfig(bad);
    await expect(
      StelisSDK.connect('http://primary/api', { pinnedPackageId: CANONICAL_PKG }),
    ).rejects.toThrow('hops must be a non-empty array');
  });

  it('rejects duplicate settlementTokenType because each token selects one active settlement swap path', async () => {
    const bad = makeConfig();
    bad.supportedSettlementSwapPaths.push({
      ...bad.supportedSettlementSwapPaths[0],
      hops: [
        {
          ...bad.supportedSettlementSwapPaths[0].hops[0],
          poolId: '0x' + '5'.repeat(64),
        },
      ],
    });
    stubConfig(bad);
    await expect(
      StelisSDK.connect('http://primary/api', { pinnedPackageId: CANONICAL_PKG }),
    ).rejects.toThrow('duplicate settlementTokenType');
  });

  it('rejects invalid swapDirection value', async () => {
    const bad = makeConfig();
    (bad.supportedSettlementSwapPaths[0].hops[0] as Record<string, unknown>).swapDirection =
      'invalidFn';
    stubConfig(bad);
    await expect(
      StelisSDK.connect('http://primary/api', { pinnedPackageId: CANONICAL_PKG }),
    ).rejects.toThrow('swapDirection is invalid');
  });

  it('rejects fee metadata drift between effectiveFeeRateBps and hop feeBps', async () => {
    const bad = makeConfig();
    bad.supportedSettlementSwapPaths[0].effectiveFeeRateBps = 25;
    bad.supportedSettlementSwapPaths[0].hops[0].feeBps = 20;
    stubConfig(bad);
    await expect(
      StelisSDK.connect('http://primary/api', { pinnedPackageId: CANONICAL_PKG }),
    ).rejects.toThrow('feeBps must equal effectiveFeeRateBps');
  });

  it('rejects fee metadata over 100%', async () => {
    const bad = makeConfig();
    bad.supportedSettlementSwapPaths[0].effectiveFeeRateBps = 10_001;
    bad.supportedSettlementSwapPaths[0].hops[0].feeBps = 10_001;
    stubConfig(bad);
    await expect(
      StelisSDK.connect('http://primary/api', { pinnedPackageId: CANONICAL_PKG }),
    ).rejects.toThrow('feeBps must be in [0, 10000]');
  });
});
