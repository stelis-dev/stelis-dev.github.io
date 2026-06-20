/**
 * S-16: _verifyIntegrity runtime branch tests.
 *
 * These tests exercise the actual _verifyIntegrity logic through prepareSponsored,
 * WITHOUT mocking integrity.ts. This verifies the real runtime behavior of:
 *   1. connect-time rejection when integrityPolicyVersion is missing
 *   2. fail-closed when policyVersion is unsupported
 *   3. pinnedPackageId does not weaken fail-closed behavior
 *
 * Source: sdk.ts L542-575 (_verifyIntegrity)
 *
 * Approach: unsupported-version cases throw BEFORE verifyPtbIntegrity is called,
 * so mock txBytes from prepare is sufficient.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { StelisSDK } from '../src/sdk.js';
import { StelisIntegrityError } from '../src/integrity.js';
import type { RelayConfigResponse, PrepareResponse } from '../src/types.js';
import { STELIS_CONTRACT_IDS } from '@stelis/contracts';

// ── Module-level mock: StelisClient ─────────────────────────────────────────────
const mockPrepare = vi.fn<(params: Record<string, unknown>) => Promise<PrepareResponse>>();

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

// ── Module-level mock: queryUserCredit (not testing credit here) ────────────────
vi.mock('../src/credit.js', () => ({
  queryUserCredit: vi.fn(async () => ({ vaultObjectId: null, credit: '0', needsCreate: false })),
}));

// NOTE: integrity.ts is NOT mocked — runtime branches are exercised for real.

// ── Mock fetch ─────────────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Constants ──────────────────────────────────────────────────────────────────
const CANONICAL_PKG = STELIS_CONTRACT_IDS.testnet!.packageId;

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
    integrityPolicyVersion: 1,
    ...overrides,
  };
}

function stubCandidate(config: unknown): void {
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }));
}

const MOCK_PREPARE_RESPONSE: PrepareResponse = {
  txBytes: 'mockTxBytes',
  receiptId: '0x' + 'ff'.repeat(32),
  nonce: '1',
  cost: {
    simGas: '5000000',
    gasVarianceFixedMist: '200000',
    slippageBufferMist: '50000',
    quotedHostFee: '100000',
    protocolFee: '20000',
    executionCostClaim: '5250000',
    grossGas: '7000000',
  },
  profile: 'new_user',
  quoteTimestampMs: Date.now(),
  policyHash: '0x' + 'ab'.repeat(32),
};

beforeEach(() => {
  mockFetch.mockReset();
  mockPrepare.mockReset();
  mockPrepare.mockResolvedValue({ ...MOCK_PREPARE_RESPONSE });
});

// ── Helper ─────────────────────────────────────────────────────────────────────

function callPrepareSponsored(sdk: StelisSDK) {
  const tx = new Transaction();
  return sdk.prepareSponsored(tx, {
    client: {
      getReferenceGasPrice: vi.fn().mockResolvedValue(1000n),
      listCoins: vi.fn().mockResolvedValue({ objects: [{ objectId: '0xcoin' }] }),
    } as unknown as import('@mysten/sui/grpc').SuiGrpcClient,
    addr: '0x' + 'a'.repeat(64),
    settlementToken: { type: `${CANONICAL_PKG}::deep::DEEP` },
    prepareAuthorizationSigner: vi.fn().mockResolvedValue('prepare-signature'),
  });
}

// ─────────────────────────────────────────────
// Runtime branch tests (integrity.ts is REAL, not mocked)
// ─────────────────────────────────────────────

describe('S-16: _verifyIntegrity runtime branches (no integrity mock)', () => {
  it('connect rejects when integrityPolicyVersion is missing', async () => {
    const invalid = { ...makeConfig() };
    delete (invalid as Record<string, unknown>).integrityPolicyVersion;
    stubCandidate(invalid);

    await expect(StelisSDK.connect('http://primary/api')).rejects.toThrow(
      'integrityPolicyVersion must be an integer >= 1',
    );
  });

  it('fail-closed: policyVersion=99 (unsupported) → StelisIntegrityError', async () => {
    stubCandidate(makeConfig({ integrityPolicyVersion: 99 }));
    const sdk = await StelisSDK.connect('http://primary/api');

    await expect(callPrepareSponsored(sdk)).rejects.toThrow(StelisIntegrityError);
    await expect(callPrepareSponsored(sdk)).rejects.toThrow('server version 99');
  });

  it('pinnedPackageId does not weaken fail-closed behavior', async () => {
    stubCandidate(makeConfig({ integrityPolicyVersion: 99 }));
    const sdk = await StelisSDK.connect('http://primary/api', {
      pinnedPackageId: CANONICAL_PKG,
    });

    await expect(callPrepareSponsored(sdk)).rejects.toThrow(StelisIntegrityError);
    await expect(callPrepareSponsored(sdk)).rejects.toThrow('server version 99');
  });
});
