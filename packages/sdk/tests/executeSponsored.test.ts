/**
 * executeSponsored — unit tests for error-normalizing sponsored execution.
 *
 * Verifies:
 *   1. Success path: pass-through from executeSponsored
 *   2. INSUFFICIENT_SETTLE_INPUT → INSUFFICIENT_FUNDS
 *   3. INSUFFICIENT_BALANCE → INSUFFICIENT_FUNDS
 *   3b. PAYMENT_COIN_CONFLICT → INSUFFICIENT_FUNDS (R-9)
 *   4. SPONSOR_PREFLIGHT_FAILED + subcode INSUFFICIENT_SETTLE_INPUT → INSUFFICIENT_FUNDS
 *   5. SPONSOR_ONCHAIN_FAILED + subcode INSUFFICIENT_SETTLE_INPUT → INSUFFICIENT_FUNDS
 *   5b. SPONSOR_PREFLIGHT_FAILED + subcode INSUFFICIENT_FUNDS → INSUFFICIENT_FUNDS
 *   5c. SPONSOR_ONCHAIN_FAILED + subcode INSUFFICIENT_FUNDS → INSUFFICIENT_FUNDS
 *   6. DRY_RUN_FAILED → TRANSACTION_FAILED
 *   7. SPONSOR_PREFLIGHT_FAILED (no subcode) → EXECUTION_FAILED
 *   8. Unknown code → passthrough
 *   14. SPREAD_EXCEEDED (prepare top-level) → TRANSACTION_FAILED
 *   15. SPONSOR_PREFLIGHT_FAILED + subcode SPREAD_EXCEEDED → TRANSACTION_FAILED
 *   16. SPONSOR_ONCHAIN_FAILED + subcode SPREAD_EXCEEDED → TRANSACTION_FAILED
 *   17. SPONSOR_PREFLIGHT_FAILED + subcode SLIPPAGE_EXCEEDED → TRANSACTION_FAILED
 *   18. SPONSOR_ONCHAIN_FAILED + subcode SLIPPAGE_EXCEEDED → TRANSACTION_FAILED
 *   19. SPONSOR_PREFLIGHT_FAILED + subcode CLAIM_WOULD_EXCEED_MAX → TRANSACTION_FAILED
 *   20. SPONSOR_ONCHAIN_FAILED + subcode CLAIM_WOULD_EXCEED_MAX → TRANSACTION_FAILED
 *
 * Strategy: spy on executeSponsored (via vi.spyOn) to isolate the
 * executeSponsored normalization layer from the full prepare/sign/sponsor flow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { StelisSDK, StelisSponsoredError } from '../src/sdk.js';
import type { RelayerConfig } from '../src/types.js';
import { STELIS_CONTRACT_IDS } from '@stelis/contracts';

const { mockExtractSettleFields, mockValidateSettleFields } = vi.hoisted(() => ({
  mockExtractSettleFields: vi.fn(),
  mockValidateSettleFields: vi.fn(),
}));

// ── Mock: integrity (skip S-16) ─────────────────────────────────────────────
vi.mock('../src/integrity.js', () => ({
  verifyPtbIntegrity: vi.fn(),
  SUPPORTED_INTEGRITY_POLICY_VERSION: 1,
  StelisIntegrityError: class StelisIntegrityError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'StelisIntegrityError';
    }
  },
}));

// ── Mock: credit ─────────────────────────────────────────────────────────────
vi.mock('../src/credit.js', () => ({
  queryUserCredit: vi.fn(async () => ({ vaultObjectId: null, credit: '0', needsCreate: false })),
}));

vi.mock('@stelis/core-relay/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stelis/core-relay/browser')>();
  return {
    ...actual,
    extractSettleTransactionFieldsFromTxBytes: mockExtractSettleFields,
    validateSettleTransactionFields: mockValidateSettleFields,
  };
});

// ── Mock: StelisClient ────────────────────────────────────────────────────────
const mockPrepare = vi.fn();
const mockSponsor = vi.fn();

vi.mock('../src/client.js', () => ({
  StelisClient: vi.fn().mockImplementation(function ({ endpoint }: { endpoint: string }) {
    return {
      getStatus: vi.fn().mockResolvedValue({ ok: true }),
      prepare: mockPrepare,
      sponsor: mockSponsor,
      endpoint,
    };
  }),
  StelisApiException: class StelisApiException extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
      public readonly meta?: Record<string, unknown>,
    ) {
      super(message);
      this.name = 'StelisApiException';
    }
  },
}));

// ── Mock: fetch ──────────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Constants ────────────────────────────────────────────────────────────────
const ADDR = '0x' + 'a'.repeat(64);
const PKG = '0x' + '1'.repeat(64);
const DEEP_TYPE = `${PKG}::deep::DEEP`;

const RELAYER_CONFIG: RelayerConfig = {
  network: 'testnet',
  packageId: STELIS_CONTRACT_IDS.testnet!.packageId,
  settlementPayoutRecipient: '0x' + 'b'.repeat(64),
  supportedSettlementSwapPaths: [
    {
      hops: [
        {
          poolId: '0x' + '4'.repeat(64),
          baseType: DEEP_TYPE,
          quoteType: '0x2::sui::SUI',
          swapDirection: 'baseForQuote' as const,
          feeBps: 0,
        },
      ],
      paymentTokenType: DEEP_TYPE,
      paymentTokenSymbol: 'DEEP',
      paymentTokenDecimals: 6,
      lotSize: 100,
      minSize: 1_000_000,
      effectiveFeeRateBps: 0,
      settlementSwapDirection: 'baseForQuote' as const,
    },
  ],
  quotedHostFeeMist: '100000',
  protocolFlatFeeMist: '20000',
  integrityPolicyVersion: 1,
};

function makeMockSuiClient(): SuiGrpcClient {
  return {
    getReferenceGasPrice: vi.fn().mockResolvedValue(1000n),
    listCoins: vi.fn().mockResolvedValue({ objects: [{ objectId: '0xcoin' }] }),
  } as unknown as SuiGrpcClient;
}

async function createSDK(): Promise<StelisSDK> {
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(RELAYER_CONFIG), { status: 200 }));
  return StelisSDK.connect('http://mock.local/api');
}

const defaultOpts = () => ({
  client: makeMockSuiClient(),
  prepareAuthorizationSigner: vi.fn().mockResolvedValue('prepare-sig-base64'),
  signer: vi.fn().mockResolvedValue('user-sig-base64'),
  addr: ADDR,
  paymentToken: { type: DEEP_TYPE },
});

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('StelisSDK.executeSponsored', () => {
  let sdk: StelisSDK;

  beforeEach(async () => {
    mockFetch.mockReset();
    mockPrepare.mockReset();
    mockSponsor.mockReset();
    mockExtractSettleFields.mockReset();
    mockExtractSettleFields.mockReturnValue({});
    mockValidateSettleFields.mockReset();
    mockValidateSettleFields.mockReturnValue({ ok: true });
    sdk = await createSDK();
    // Default success mocks
    mockPrepare.mockResolvedValue({
      txBytes: 'base64TxBytes',
      receiptId: '0x' + 'ff'.repeat(32),
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
    });
    mockSponsor.mockResolvedValue({
      digest: '0xDIGEST123',
      effects: { status: { success: true } },
    });
  });

  // ── 1: Success — pass-through from executeSponsored ─────────────────────
  it('returns digest and effects on success', async () => {
    const result = await sdk.executeSponsored(new Transaction(), defaultOpts());
    expect(result.digest).toBe('0xDIGEST123');
    expect(result.effects).toEqual({ status: { success: true } });
  });

  // ── 2: INSUFFICIENT_SETTLE_INPUT → INSUFFICIENT_FUNDS ─────────────────
  it('normalizes INSUFFICIENT_SETTLE_INPUT to INSUFFICIENT_FUNDS', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockPrepare.mockRejectedValueOnce(
      new StelisApiException('INSUFFICIENT_SETTLE_INPUT', 'Settle input too low', 422, {
        minSettleMist: '100000',
        requiredTotalIn: '250000',
        isEstimate: 'false',
      }),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      const e = err as StelisSponsoredError;
      expect(e.code).toBe('INSUFFICIENT_FUNDS');
      expect(e.meta?.minSettleMist).toBe('100000');
    }
  });

  // ── 3: INSUFFICIENT_BALANCE → INSUFFICIENT_FUNDS ──────────────────────
  it('normalizes INSUFFICIENT_BALANCE to INSUFFICIENT_FUNDS', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockPrepare.mockRejectedValueOnce(
      new StelisApiException('INSUFFICIENT_BALANCE', 'Insufficient coin balance', 422),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).code).toBe('INSUFFICIENT_FUNDS');
    }
  });

  // ── 3b: PAYMENT_COIN_CONFLICT → INSUFFICIENT_FUNDS (R-9) ──────────────
  it('normalizes PAYMENT_COIN_CONFLICT to INSUFFICIENT_FUNDS', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockPrepare.mockRejectedValueOnce(
      new StelisApiException('PAYMENT_COIN_CONFLICT', 'All coins consumed by user TX', 422),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).code).toBe('INSUFFICIENT_FUNDS');
    }
  });

  // ── 4: SPONSOR_PREFLIGHT_FAILED + subcode → INSUFFICIENT_FUNDS ────────
  it('normalizes SPONSOR_PREFLIGHT_FAILED with subcode INSUFFICIENT_SETTLE_INPUT', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockSponsor.mockRejectedValueOnce(
      new StelisApiException('SPONSOR_PREFLIGHT_FAILED', 'preflight failed', 422, {
        subcode: 'INSUFFICIENT_SETTLE_INPUT',
      }),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      const e = err as StelisSponsoredError;
      expect(e.code).toBe('INSUFFICIENT_FUNDS');
      expect(e.meta?.subcode).toBe('INSUFFICIENT_SETTLE_INPUT');
    }
  });

  // ── 5: SPONSOR_ONCHAIN_FAILED + subcode → INSUFFICIENT_FUNDS ──────────
  it('normalizes SPONSOR_ONCHAIN_FAILED with subcode INSUFFICIENT_SETTLE_INPUT', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockSponsor.mockRejectedValueOnce(
      new StelisApiException('SPONSOR_ONCHAIN_FAILED', 'on-chain revert', 422, {
        subcode: 'INSUFFICIENT_SETTLE_INPUT',
        digest: '0xABC',
      }),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).code).toBe('INSUFFICIENT_FUNDS');
    }
  });

  // ── 5b: SPONSOR_PREFLIGHT_FAILED + subcode INSUFFICIENT_FUNDS → INSUFFICIENT_FUNDS ──
  // settle.move EInsufficientFunds (S-4 non-loss assert): total_in covers
  // min_settle but not execution_cost_claim_mist + fees. User-visible exhaustion class —
  // collapse with INSUFFICIENT_SETTLE_INPUT under the same SDK code.
  it('normalizes SPONSOR_PREFLIGHT_FAILED with subcode INSUFFICIENT_FUNDS', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockSponsor.mockRejectedValueOnce(
      new StelisApiException('SPONSOR_PREFLIGHT_FAILED', 'preflight failed', 422, {
        subcode: 'INSUFFICIENT_FUNDS',
      }),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      const e = err as StelisSponsoredError;
      expect(e.code).toBe('INSUFFICIENT_FUNDS');
      expect(e.meta?.subcode).toBe('INSUFFICIENT_FUNDS');
    }
  });

  // ── 5c: SPONSOR_ONCHAIN_FAILED + subcode INSUFFICIENT_FUNDS → INSUFFICIENT_FUNDS ────
  it('normalizes SPONSOR_ONCHAIN_FAILED with subcode INSUFFICIENT_FUNDS', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockSponsor.mockRejectedValueOnce(
      new StelisApiException('SPONSOR_ONCHAIN_FAILED', 'on-chain revert', 422, {
        subcode: 'INSUFFICIENT_FUNDS',
        digest: '0xDEF',
      }),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).code).toBe('INSUFFICIENT_FUNDS');
    }
  });

  // ── 6: DRY_RUN_FAILED → TRANSACTION_FAILED ────────────────────────────
  it('normalizes DRY_RUN_FAILED to TRANSACTION_FAILED', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockPrepare.mockRejectedValueOnce(
      new StelisApiException('DRY_RUN_FAILED', 'Dry-run failed: something', 422),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).code).toBe('TRANSACTION_FAILED');
    }
  });

  // ── 7: SPONSOR_PREFLIGHT_FAILED (no subcode) → EXECUTION_FAILED ───────
  it('normalizes SPONSOR_PREFLIGHT_FAILED without subcode to EXECUTION_FAILED', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockSponsor.mockRejectedValueOnce(
      new StelisApiException('SPONSOR_PREFLIGHT_FAILED', 'preflight generic fail', 422),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).code).toBe('EXECUTION_FAILED');
    }
  });

  // ── 8: Unknown code → passthrough ──────────────────────────────────────
  it('passes through unknown API error codes verbatim', async () => {
    const { StelisApiException } = await import('../src/client.js');
    // Sample a code that the SDK has no normalizer for. Use a synthetic
    // literal that is intentionally outside every public error-code union so the
    // passthrough path is exercised without depending on a stale code.
    mockPrepare.mockRejectedValueOnce(
      new StelisApiException('UNKNOWN_FUTURE_CODE', 'Some unmapped server reason', 422),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).code).toBe('UNKNOWN_FUTURE_CODE');
    }
  });

  // ── 9: SLIPPAGE_EXCEEDED → TRANSACTION_FAILED (pre-wired) ──────────────
  it('normalizes SLIPPAGE_EXCEEDED to TRANSACTION_FAILED', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockPrepare.mockRejectedValueOnce(
      new StelisApiException('SLIPPAGE_EXCEEDED', 'Slippage exceeds cap', 422),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).code).toBe('TRANSACTION_FAILED');
    }
  });

  // ── 10: CLAIM_WOULD_EXCEED_MAX → TRANSACTION_FAILED (pre-wired) ───────
  it('normalizes CLAIM_WOULD_EXCEED_MAX to TRANSACTION_FAILED', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockPrepare.mockRejectedValueOnce(
      new StelisApiException('CLAIM_WOULD_EXCEED_MAX', 'Claim would exceed max', 422),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).code).toBe('TRANSACTION_FAILED');
    }
  });

  // ── 11: SLIPPAGE_QUERY_FAILED → TRANSACTION_FAILED (pre-wired) ────────
  it('normalizes SLIPPAGE_QUERY_FAILED to TRANSACTION_FAILED', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockPrepare.mockRejectedValueOnce(
      new StelisApiException('SLIPPAGE_QUERY_FAILED', 'RPC query failed', 422),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      const e = err as StelisSponsoredError;
      expect(e.code).toBe('TRANSACTION_FAILED');
      expect(e.message).toContain('verify swap conditions');
    }
  });

  // ── 12: SLIPPAGE_CONVERGENCE_FAILED → TRANSACTION_FAILED ──────────────
  it('normalizes SLIPPAGE_CONVERGENCE_FAILED to TRANSACTION_FAILED', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockPrepare.mockRejectedValueOnce(
      new StelisApiException('SLIPPAGE_CONVERGENCE_FAILED', 'Convergence failed', 422),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).code).toBe('TRANSACTION_FAILED');
    }
  });

  // ── 13: SWAP_AMOUNT_OVERFLOW → TRANSACTION_FAILED ─────────────────────
  it('normalizes SWAP_AMOUNT_OVERFLOW to TRANSACTION_FAILED', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockPrepare.mockRejectedValueOnce(
      new StelisApiException('SWAP_AMOUNT_OVERFLOW', 'Amount exceeds safe integer', 422),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).code).toBe('TRANSACTION_FAILED');
    }
  });

  // ── 9: Non-API error → re-thrown without wrapping ──────────────────────
  it('does not wrap non-StelisApiException errors', async () => {
    const genericError = new Error('Network timeout');
    mockPrepare.mockRejectedValueOnce(genericError);

    await expect(sdk.executeSponsored(new Transaction(), defaultOpts())).rejects.toThrow(
      'Network timeout',
    );
  });

  // ── orderId echo from sponsor response ────────────────────────────────
  it('echoes orderId from sponsor response', async () => {
    mockPrepare.mockResolvedValueOnce({
      txBytes: 'base64TxBytes',
      receiptId: '0x' + 'ff'.repeat(32),
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
      orderId: 'prepare-order',
    });
    mockSponsor.mockResolvedValueOnce({
      digest: '0xDIGEST',
      effects: { status: { success: true } },
      orderId: 'sponsored-order',
    });

    const result = await sdk.executeSponsored(new Transaction(), defaultOpts());
    // sponsorRes.orderId takes precedence
    expect(result.orderId).toBe('sponsored-order');
  });

  // ── 14: SPREAD_EXCEEDED (prepare top-level) → TRANSACTION_FAILED ──────
  it('normalizes SPREAD_EXCEEDED to TRANSACTION_FAILED', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockPrepare.mockRejectedValueOnce(
      new StelisApiException('SPREAD_EXCEEDED', 'Spread too wide', 422),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).code).toBe('TRANSACTION_FAILED');
    }
  });

  // ── 15: SPONSOR_PREFLIGHT_FAILED + subcode SPREAD_EXCEEDED → TRANSACTION_FAILED
  it('normalizes SPONSOR_PREFLIGHT_FAILED with subcode SPREAD_EXCEEDED', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockSponsor.mockRejectedValueOnce(
      new StelisApiException('SPONSOR_PREFLIGHT_FAILED', 'preflight failed', 422, {
        subcode: 'SPREAD_EXCEEDED',
      }),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      const e = err as StelisSponsoredError;
      expect(e.code).toBe('TRANSACTION_FAILED');
      expect(e.meta?.subcode).toBe('SPREAD_EXCEEDED');
    }
  });

  // ── 16: SPONSOR_ONCHAIN_FAILED + subcode SPREAD_EXCEEDED → TRANSACTION_FAILED
  it('normalizes SPONSOR_ONCHAIN_FAILED with subcode SPREAD_EXCEEDED', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockSponsor.mockRejectedValueOnce(
      new StelisApiException('SPONSOR_ONCHAIN_FAILED', 'on-chain revert', 422, {
        subcode: 'SPREAD_EXCEEDED',
        digest: '0xABC',
      }),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      const e = err as StelisSponsoredError;
      expect(e.code).toBe('TRANSACTION_FAILED');
      expect(e.meta?.subcode).toBe('SPREAD_EXCEEDED');
    }
  });

  // ── 17: SPONSOR_PREFLIGHT_FAILED + subcode SLIPPAGE_EXCEEDED → TRANSACTION_FAILED
  it('normalizes SPONSOR_PREFLIGHT_FAILED with subcode SLIPPAGE_EXCEEDED', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockSponsor.mockRejectedValueOnce(
      new StelisApiException('SPONSOR_PREFLIGHT_FAILED', 'preflight failed', 422, {
        subcode: 'SLIPPAGE_EXCEEDED',
      }),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      const e = err as StelisSponsoredError;
      expect(e.code).toBe('TRANSACTION_FAILED');
      expect(e.meta?.subcode).toBe('SLIPPAGE_EXCEEDED');
    }
  });

  // ── 18: SPONSOR_ONCHAIN_FAILED + subcode SLIPPAGE_EXCEEDED → TRANSACTION_FAILED
  it('normalizes SPONSOR_ONCHAIN_FAILED with subcode SLIPPAGE_EXCEEDED', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockSponsor.mockRejectedValueOnce(
      new StelisApiException('SPONSOR_ONCHAIN_FAILED', 'on-chain revert', 422, {
        subcode: 'SLIPPAGE_EXCEEDED',
        digest: '0xABC',
      }),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      const e = err as StelisSponsoredError;
      expect(e.code).toBe('TRANSACTION_FAILED');
      expect(e.meta?.subcode).toBe('SLIPPAGE_EXCEEDED');
    }
  });

  // ── 19: SPONSOR_PREFLIGHT_FAILED + subcode CLAIM_WOULD_EXCEED_MAX → TRANSACTION_FAILED
  it('normalizes SPONSOR_PREFLIGHT_FAILED with subcode CLAIM_WOULD_EXCEED_MAX', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockSponsor.mockRejectedValueOnce(
      new StelisApiException('SPONSOR_PREFLIGHT_FAILED', 'preflight failed', 422, {
        subcode: 'CLAIM_WOULD_EXCEED_MAX',
      }),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      const e = err as StelisSponsoredError;
      expect(e.code).toBe('TRANSACTION_FAILED');
      expect(e.meta?.subcode).toBe('CLAIM_WOULD_EXCEED_MAX');
    }
  });

  // ── 20: SPONSOR_ONCHAIN_FAILED + subcode CLAIM_WOULD_EXCEED_MAX → TRANSACTION_FAILED
  it('normalizes SPONSOR_ONCHAIN_FAILED with subcode CLAIM_WOULD_EXCEED_MAX', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockSponsor.mockRejectedValueOnce(
      new StelisApiException('SPONSOR_ONCHAIN_FAILED', 'on-chain revert', 422, {
        subcode: 'CLAIM_WOULD_EXCEED_MAX',
        digest: '0xABC',
      }),
    );

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      const e = err as StelisSponsoredError;
      expect(e.code).toBe('TRANSACTION_FAILED');
      expect(e.meta?.subcode).toBe('CLAIM_WOULD_EXCEED_MAX');
    }
  });
});
