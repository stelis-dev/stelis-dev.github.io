/**
 * costValidation — COST_MISMATCH cross-validation tests.
 *
 * Verifies that executeSponsored throws COST_MISMATCH (wrapped as StelisSponsoredError)
 * when prepareRes.cost fields do not match settle args in txBytes,
 * and fails closed when txBytes cannot be parsed.
 *
 * Covers:
 *   T-1: quotedHostFee mismatch → StelisSponsoredError (COST_MISMATCH)
 *   T-2: protocolFee mismatch → StelisSponsoredError (COST_MISMATCH)
 *   T-3: txBytes parse failure → StelisSponsoredError (SETTLE_TX_PARSE_FAILED)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { StelisSDK } from '../src/sdk.js';
import { StelisSponsoredError } from '../src/errors.js';
import type { RelayConfigResponse, RelayPrepareResponse } from '../src/types.js';
import { STELIS_CONTRACT_IDS } from '@stelis/contracts';
import { makeCreditResult } from './helpers/currentFixtures.js';

// ── vi.hoisted: must precede vi.mock calls (Vitest hoisting rule) ──────────────
const { mockExtractSettleFields, mockValidateSettleFields } = vi.hoisted(() => ({
  mockExtractSettleFields: vi.fn(),
  mockValidateSettleFields: vi.fn(),
}));

// ── Module mocks ───────────────────────────────────────────────────────────────
vi.mock('../src/integrity.js', () => ({
  verifyPtbIntegrity: vi.fn(),
  StelisIntegrityError: class StelisIntegrityError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'StelisIntegrityError';
    }
  },
}));

vi.mock('@stelis/core-relay/browser', async (importOriginal) => {
  const original = await importOriginal<typeof import('@stelis/core-relay/browser')>();
  return {
    ...original,
    queryUserCredit: vi.fn(async () => makeCreditResult()),
    extractSettleTransactionFieldsFromTxBytes: mockExtractSettleFields,
    validateSettleTransactionFields: mockValidateSettleFields,
  };
});

const mockPrepare = vi.fn();
const mockSponsor = vi.fn();
const mockGetConfig = vi.fn<() => Promise<RelayConfigResponse>>();

vi.mock('../src/client.js', () => ({
  StelisClient: vi.fn().mockImplementation(function ({ endpoint }: { endpoint: string }) {
    return {
      getStatus: vi.fn().mockResolvedValue({ ok: true }),
      getConfig: mockGetConfig,
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

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const ADDR = '0x' + 'a'.repeat(64);
const PKG = '0x' + '1'.repeat(64);
const DEEP_TYPE = `${PKG}::deep::DEEP`;

const RELAY_CONFIG_RESPONSE: RelayConfigResponse = {
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

const MOCK_PREPARE_RESPONSE: RelayPrepareResponse = {
  txBytes: 'base64MockTxBytes',
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

function makeMockSuiClient(): SuiGrpcClient {
  return {
    getReferenceGasPrice: vi.fn().mockResolvedValue(1000n),
    listCoins: vi.fn().mockResolvedValue({ objects: [{ objectId: '0xcoin' }] }),
  } as unknown as SuiGrpcClient;
}

async function createSDK(): Promise<StelisSDK> {
  mockGetConfig.mockResolvedValueOnce(RELAY_CONFIG_RESPONSE);
  return StelisSDK.connect('http://mock.local/api');
}

const defaultOpts = () => ({
  client: makeMockSuiClient(),
  prepareAuthorizationSigner: vi.fn().mockResolvedValue('prepare-sig-base64'),
  signer: vi.fn().mockResolvedValue('user-sig-base64'),
  addr: ADDR,
  settlementToken: { type: DEEP_TYPE },
});

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────
describe('StelisSDK — COST_MISMATCH cross-validation', () => {
  let sdk: StelisSDK;

  beforeEach(async () => {
    mockGetConfig.mockReset();
    mockPrepare.mockReset();
    mockSponsor.mockReset();
    mockExtractSettleFields.mockReset();
    mockExtractSettleFields.mockReturnValue({});
    mockValidateSettleFields.mockReset();
    mockValidateSettleFields.mockReturnValue({ ok: true });
    sdk = await createSDK();
    mockPrepare.mockResolvedValue(MOCK_PREPARE_RESPONSE);
    mockSponsor.mockResolvedValue({ digest: '0xDIGEST', effects: { status: { success: true } } });
  });

  // T-1: quotedHostFee mismatch → COST_MISMATCH wrapped as StelisSponsoredError
  it('throws when cost.quotedHostFee differs from txBytes settle args', async () => {
    mockValidateSettleFields.mockReturnValue({
      ok: false,
      code: 'SETTLE_HOST_FEE_MISMATCH',
      message: 'quotedHostFee mismatch',
    });

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).message).toContain('quotedHostFee');
    }
  });

  // T-2: protocolFee mismatch → COST_MISMATCH wrapped as StelisSponsoredError
  it('throws when cost.protocolFee differs from txBytes settle args', async () => {
    mockValidateSettleFields.mockReturnValue({
      ok: false,
      code: 'SETTLE_PROTOCOL_FEE_MISMATCH',
      message: 'protocolFee mismatch',
    });

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).message).toContain('protocolFee');
    }
  });

  // T-3: parse failure → fail closed before sponsor.
  it('throws when txBytes settle args cannot be parsed', async () => {
    mockExtractSettleFields.mockImplementation(() => {
      throw new Error('settle call missing');
    });

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).code).toBe('SETTLE_TX_PARSE_FAILED');
      expect((err as StelisSponsoredError).message).toContain('settle call missing');
    }
  });

  // T-4: executionCostClaim mismatch → COST_MISMATCH wrapped as StelisSponsoredError
  it('throws when cost.executionCostClaim differs from txBytes settle args', async () => {
    mockValidateSettleFields.mockReturnValue({
      ok: false,
      code: 'SETTLE_EXECUTION_COST_CLAIM_MISMATCH',
      message: 'executionCostClaim mismatch',
    });

    try {
      await sdk.executeSponsored(new Transaction(), defaultOpts());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisSponsoredError);
      expect((err as StelisSponsoredError).message).toContain('executionCostClaim');
    }
  });
});
