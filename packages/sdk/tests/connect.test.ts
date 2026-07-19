/**
 * connect() policy branch tests.
 *
 * Tests verify:
 * - pinnedPackageId validation (S-16 step 2)
 * - rogue Host packageId rejection (S-16 step 1)
 * - consumption and bigint conversion of StelisClient's validated config
 *
 * connect() now takes a required endpoint string. There is no canonical fallback,
 * no reconnect(), no allowCanonicalFallback, and no endpoint-switch callbacks.
 * Errors from config parsing, package ID checks, and status checks are thrown directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StelisSDK } from '../src/sdk.js';
import type { RelayConfigResponse } from '../src/types.js';
import { STELIS_CONTRACT_IDS } from '@stelis/contracts';

// ── Module-level mock: StelisClient ─────────────────────────────────────────────
const mockGetConfig = vi.fn<() => Promise<RelayConfigResponse>>();

vi.mock('../src/client.js', () => ({
  StelisClient: vi.fn().mockImplementation(function ({ endpoint }: { endpoint: string }) {
    return {
      getStatus: vi.fn().mockResolvedValue({ ok: true }),
      getConfig: mockGetConfig,
      prepare: vi.fn(),
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

function stubConfig(config: RelayConfigResponse): void {
  mockGetConfig.mockResolvedValueOnce(config);
}

beforeEach(() => {
  mockGetConfig.mockReset();
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
    expect(sdk.supportedSettlementSwapPaths[0].lotSize).toBe(100n);
    expect(mockGetConfig).toHaveBeenCalledOnce();
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
