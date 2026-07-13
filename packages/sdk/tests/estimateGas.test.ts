/**
 * estimateGas — unit tests for StelisSDK.estimateGas()
 *
 * Tests verify:
 *   1. Budget-based gas estimation using computeExecutionCostClaim + fees
 *   2. Three profile branches (no vault / credit sufficient / credit insufficient)
 *   3. canSkipLiquidity logic (credit_general only)
 *   4. settlementToken is required for estimateGas()
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StelisSDK } from '../src/sdk.js';
import type { RelayConfigResponse, RelayPrepareResponse } from '../src/types.js';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { STELIS_CONTRACT_IDS } from '@stelis/contracts';

// ── Module-level mock: queryUserCredit ──────────────────────────────────────────
let _creditResult = { vaultObjectId: null as string | null, credit: '0', needsCreate: false };
vi.mock('../src/credit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/credit.js')>();
  return {
    ...actual,
    queryUserCredit: vi.fn(async () => _creditResult),
  };
});

// ── Module-level mock: StelisClient ─────────────────────────────────────────────
const mockPrepare = vi.fn<(params: Record<string, unknown>) => Promise<RelayPrepareResponse>>();
vi.mock('../src/client.js', () => ({
  StelisClient: vi.fn().mockImplementation(function () {
    return {
      getStatus: vi.fn().mockResolvedValue({ ok: true }),
      prepare: mockPrepare,
      sponsor: vi.fn(),
    };
  }),
  StelisApiException: class extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
}));

// ── Module-level mock: batchGetHopMidPrices (exchange rate) ─────────────────────
let _midPrice: bigint | null = 27_000_000_000n; // 1 DEEP ≈ 0.027 SUI
vi.mock('@stelis/core-relay/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stelis/core-relay/browser')>();
  return {
    ...actual,
    batchGetHopMidPrices: vi.fn(async () => (_midPrice !== null ? [_midPrice] : [0n])),
  };
});

// ── Mock fetch ─────────────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Constants ──────────────────────────────────────────────────────────────────
const ADDR = '0x' + 'a'.repeat(64);
const SETTLEMENT_PAYOUT_RECIPIENT = '0x' + 'b'.repeat(64);
const PKG = '0x' + '1'.repeat(64);
const POOL = '0x' + '4'.repeat(64);
const DEEP_TYPE = `${PKG}::deep::DEEP`;
const SUI_TYPE = '0x2::sui::SUI';

const BASE_CONFIG: RelayConfigResponse = {
  network: 'testnet',
  packageId: STELIS_CONTRACT_IDS.testnet!.packageId,
  settlementPayoutRecipient: SETTLEMENT_PAYOUT_RECIPIENT,
  supportedSettlementSwapPaths: [
    {
      hops: [
        {
          poolId: POOL,
          baseType: DEEP_TYPE,
          quoteType: SUI_TYPE,
          swapDirection: 'baseForQuote' as const,
          feeBps: 0,
        },
      ],
      settlementTokenType: DEEP_TYPE,
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
};

function makeSuiClient(): SuiGrpcClient {
  return { getReferenceGasPrice: vi.fn().mockResolvedValue(1000n) } as unknown as SuiGrpcClient;
}

async function createSDK(configOverrides?: Partial<RelayConfigResponse>): Promise<StelisSDK> {
  const config = { ...BASE_CONFIG, ...configOverrides };
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }));
  return StelisSDK.connect('http://mock.local/api');
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('StelisSDK.estimateGas — gas estimate with profile branches', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    _creditResult = { vaultObjectId: null, credit: '0', needsCreate: false };
    _midPrice = 27_000_000_000n;
  });

  // ── 1: Budget-based estimation uses computeExecutionCostClaim + fees ──────

  it('computes totalCost using computeExecutionCostClaim + quotedHostFee + protocolFee', async () => {
    const sdk = await createSDK();
    const result = await sdk.estimateGas(makeSuiClient(), {
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
    });

    // Default budget = 5_000_000
    // computeExecutionCostClaim({ computationCost: '5000000', storageCost: '0', storageRebate: '0' })
    // → executionCostClaim depends on the formula, but suiAmountHuman should be non-zero
    expect(result.suiAmountHuman).not.toBe('0');
    expect(result.displayUnit).toBe('DEEP'); // no vault → new_user → settlement token
    expect(result.profile).toBe('new_user');
    expect(result.canSkipLiquidity).toBe(false);
  });

  // ── 2: No vault → new_user profile, display in settlement token ────────

  it('returns new_user profile when user has no vault', async () => {
    _creditResult = { vaultObjectId: null, credit: '0', needsCreate: false };
    const sdk = await createSDK();
    const result = await sdk.estimateGas(makeSuiClient(), {
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
    });

    expect(result.profile).toBe('new_user');
    expect(result.displayUnit).toBe('DEEP');
    expect(result.canSkipLiquidity).toBe(false);
    expect(result.hasLiquidity).toBe(true);
  });

  // ── 3: Vault + sufficient credit → credit_general ───────────────────

  it('returns credit_general profile when vault credit covers totalCost', async () => {
    _creditResult = { vaultObjectId: '0xvault', credit: '999999999', needsCreate: false };
    const sdk = await createSDK();
    const result = await sdk.estimateGas(makeSuiClient(), {
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
    });

    expect(result.profile).toBe('credit_general');
    expect(result.displayUnit).toBe('SUI');
    expect(result.canSkipLiquidity).toBe(true);
  });

  // ── 4: Vault + insufficient credit → with_vault ─────────────────────

  it('returns with_vault profile when vault credit is insufficient', async () => {
    _creditResult = { vaultObjectId: '0xvault', credit: '1', needsCreate: false };
    const sdk = await createSDK();
    const result = await sdk.estimateGas(makeSuiClient(), {
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
    });

    expect(result.profile).toBe('with_vault');
    expect(result.displayUnit).toBe('DEEP');
    expect(result.canSkipLiquidity).toBe(false);
  });

  // ── 5: No liquidity returns hasLiquidity=false ──────────────────────

  it('returns hasLiquidity=false when the settlement swap path has no liquidity', async () => {
    _midPrice = null;
    const sdk = await createSDK();
    const result = await sdk.estimateGas(makeSuiClient(), {
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
    });

    expect(result.hasLiquidity).toBe(false);
    expect(result.amountHuman).toBe('0');
  });
  // ── 6: settlementToken is required ────────────────────────────────────────

  it('throws when settlementToken is omitted', async () => {
    const sdk = await createSDK();
    await expect(
      sdk.estimateGas(makeSuiClient(), {
        addr: ADDR,
        // settlementToken intentionally omitted
      } as Parameters<typeof sdk.estimateGas>[1]),
    ).rejects.toThrow('settlementToken is required');
  });

  // ── 7: CreditQueryInconsistentStateError propagates to caller ─────

  it('throws CreditQueryInconsistentStateError when vault state is inconsistent', async () => {
    const { CreditQueryInconsistentStateError } = await import('../src/credit.js');
    const { queryUserCredit } = await import('../src/credit.js');
    (queryUserCredit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new CreditQueryInconsistentStateError('vault missing', '0xVAULT', '0xUSER'),
    );
    const sdk = await createSDK();
    await expect(
      sdk.estimateGas(makeSuiClient(), { addr: ADDR, settlementToken: { type: DEEP_TYPE } }),
    ).rejects.toThrow(CreditQueryInconsistentStateError);
  });

  // ── 8: 1-hop qfb settlement swap path uses inverted rate composition ─────

  it('returns settlement token estimate for a 1-hop qfb settlement swap path', async () => {
    const ALPHA_TYPE = `${PKG}::alpha::ALPHA`;
    const qfbConfig: RelayConfigResponse = {
      ...BASE_CONFIG,
      supportedSettlementSwapPaths: [
        {
          hops: [
            {
              poolId: POOL,
              baseType: SUI_TYPE,
              quoteType: ALPHA_TYPE,
              swapDirection: 'quoteForBase' as const,
              feeBps: 0,
            },
          ],
          settlementTokenType: ALPHA_TYPE,
          settlementTokenSymbol: 'ALPHA',
          settlementTokenDecimals: 6,
          lotSize: 100,
          minSize: 1_000_000,
          effectiveFeeRateBps: 0,
          settlementSwapDirection: 'quoteForBase' as const,
        },
      ],
    };

    // Mock batchGetHopMidPrices for the qfb settlement swap path.
    const { batchGetHopMidPrices } = await import('@stelis/core-relay/browser');
    (batchGetHopMidPrices as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      [1_000_000_000n], // midPrice = 1e9 for qfb pool
    );

    const sdk = await createSDK(qfbConfig);
    const result = await sdk.estimateGas(makeSuiClient(), {
      addr: ADDR,
      settlementToken: { type: ALPHA_TYPE },
    });

    expect(result.profile).toBe('new_user');
    expect(result.displayUnit).toBe('ALPHA');
    expect(result.hasLiquidity).toBe(true);
    // amountHuman should be non-zero (ALPHA amount for gas via qfb rate)
    expect(Number(result.amountHuman)).toBeGreaterThan(0);
  });

  it('qfb: keeps estimate as a non-authoritative UX preview without executable min-size policy', async () => {
    const ALPHA_TYPE = `${PKG}::alpha::ALPHA`;
    const qfbConfig: RelayConfigResponse = {
      ...BASE_CONFIG,
      supportedSettlementSwapPaths: [
        {
          hops: [
            {
              poolId: POOL,
              baseType: SUI_TYPE,
              quoteType: ALPHA_TYPE,
              swapDirection: 'quoteForBase' as const,
              feeBps: 0,
            },
          ],
          settlementTokenType: ALPHA_TYPE,
          settlementTokenSymbol: 'ALPHA',
          settlementTokenDecimals: 6,
          lotSize: 100,
          minSize: 1_000_000_000, // 1 SUI (base)
          effectiveFeeRateBps: 0,
          settlementSwapDirection: 'quoteForBase' as const,
        },
      ],
    };

    const { batchGetHopMidPrices } = await import('@stelis/core-relay/browser');
    (batchGetHopMidPrices as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      [964_321n], // qfb: quote_per_base = 0.000964321 (smallest-unit scaled)
    );

    const sdk = await createSDK(qfbConfig);
    const result = await sdk.estimateGas(makeSuiClient(), {
      addr: ADDR,
      settlementToken: { type: ALPHA_TYPE },
    });

    expect(result.profile).toBe('new_user');
    expect(result.displayUnit).toBe('ALPHA');
    expect(result.hasLiquidity).toBe(true);
    expect(result.canSkipLiquidity).toBe(false);
    expect(Number(result.amountHuman)).toBeGreaterThan(0);
  });
});
