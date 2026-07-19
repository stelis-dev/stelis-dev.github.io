/**
 * prepareSponsored — verifies the thin wrapper that delegates to client.prepare().
 *
 * Tests verify:
 *   1. client.prepare() is called with correct params
 *   2. RelayPrepareResponse fields are passed through correctly
 *   3. onGasEstimate callback receives totalCost (MIST) with 'SUI' symbol
 *   4. Optional params (slippageBps, gasMarginBps) are forwarded
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { withSuiClientIdentity } from './helpers/suiClientIdentity.js';
import { StelisSDK } from '../src/sdk.js';
import type { RelayConfigResponse, RelayPrepareResponse } from '../src/types.js';
import { parseRelayPrepareRequest, STELIS_CONTRACT_IDS } from '@stelis/contracts';

const {
  mockExtractSettleFields,
  mockValidateSettleFields,
  mockValidateGenericUserTx,
  mockQueryUserCredit,
} = vi.hoisted(() => ({
  mockExtractSettleFields: vi.fn(),
  mockValidateSettleFields: vi.fn(),
  mockValidateGenericUserTx: vi.fn(),
  mockQueryUserCredit: vi.fn(),
}));

// ── Module-level mock: integrity (S-16) ────────────────────────────────────────
// prepareSponsored tests verify prepare delegation, not PTB integrity.
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
  const actual = await importOriginal<typeof import('@stelis/core-relay/browser')>();
  return {
    ...actual,
    queryUserCredit: mockQueryUserCredit,
    extractSettleTransactionFieldsFromTxBytes: mockExtractSettleFields,
    validateSettleTransactionFields: mockValidateSettleFields,
    validateGenericUserTransactionKind: mockValidateGenericUserTx,
  };
});

// ── Module-level mock: StelisClient ─────────────────────────────────────────────
// Mock StelisClient so StelisSDK.connect() succeeds without network.
const mockPrepare =
  vi.fn<
    (
      params: Record<string, unknown>,
      headers?: Record<string, string>,
    ) => Promise<RelayPrepareResponse>
  >();
const mockSponsor = vi.fn();
const mockGetConfig = vi.fn<() => Promise<RelayConfigResponse>>();

vi.mock('../src/client.js', () => ({
  StelisClient: vi.fn().mockImplementation(function () {
    return {
      getStatus: vi.fn().mockResolvedValue({ ok: true }),
      getConfig: mockGetConfig,
      prepare: mockPrepare,
      sponsor: mockSponsor,
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

// ── Constants ──────────────────────────────────────────────────────────────────
const ADDR = '0x' + 'a'.repeat(64);
const SETTLEMENT_PAYOUT_RECIPIENT = '0x' + 'b'.repeat(64);
const PKG = '0x' + '1'.repeat(64);
const POOL = '0x' + '4'.repeat(64);
const DEEP_TYPE = `${PKG}::deep::DEEP`;
const SUI_TYPE = '0x2::sui::SUI';

const RELAY_CONFIG_RESPONSE: RelayConfigResponse = {
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

const prepareAuthorizationSigner = vi.fn().mockResolvedValue('prepare-signature');

// ── Mock SuiClient ─────────────────────────────────────────────────────────────
function makeMockSuiClient(): SuiGrpcClient {
  return withSuiClientIdentity({});
}

// ── SDK factory — uses the mocked StelisClient public boundary ─────────────────
async function createSDK(): Promise<StelisSDK> {
  mockGetConfig.mockResolvedValueOnce(RELAY_CONFIG_RESPONSE);
  return StelisSDK.connect('http://mock.local/api');
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('StelisSDK.prepareSponsored — prepare delegation', () => {
  beforeEach(() => {
    mockPrepare.mockReset();
    mockPrepare.mockResolvedValue(MOCK_PREPARE_RESPONSE);
    mockExtractSettleFields.mockReset();
    mockExtractSettleFields.mockReturnValue({});
    mockValidateSettleFields.mockReset();
    mockValidateSettleFields.mockReturnValue({ ok: true });
    mockValidateGenericUserTx.mockReset();
    mockValidateGenericUserTx.mockReturnValue({ ok: true });
    mockQueryUserCredit.mockReset();
    prepareAuthorizationSigner.mockClear();
    mockGetConfig.mockReset();
  });

  // ── 1: Calls client.prepare with correct params ──────────────────────

  it('calls client.prepare() with txKindBytes, senderAddress, settlementTokenType', async () => {
    const sdk = await createSDK();
    const tx = new Transaction();
    const client = makeMockSuiClient();

    await sdk.prepareSponsored(tx, {
      client,
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
    });

    expect(mockPrepare).toHaveBeenCalledTimes(1);
    const prepareArgs = mockPrepare.mock.calls[0][0] as Record<string, unknown>;
    expect(prepareArgs['senderAddress']).toBe(ADDR);
    expect(prepareArgs['settlementTokenType']).toBe(DEEP_TYPE);
    expect(typeof prepareArgs['txKindBytes']).toBe('string');
    // txKindBytes should be a base64-encoded string
    expect((prepareArgs['txKindBytes'] as string).length).toBeGreaterThan(0);
    expect(prepareArgs['txKindBytesHash']).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof prepareArgs['prepareAuthorizationTimestampMs']).toBe('number');
    expect(prepareArgs['prepareAuthorizationRequestNonce']).toMatch(/^[0-9a-f]+$/);
    expect(prepareArgs['prepareAuthorizationSignature']).toBe('prepare-signature');
    expect(prepareArgs).not.toHaveProperty('slippageBps');
    expect(prepareArgs).not.toHaveProperty('gasMarginBps');
    expect(prepareArgs).not.toHaveProperty('orderId');
    expect(() => parseRelayPrepareRequest(prepareArgs)).not.toThrow();
    expect(prepareAuthorizationSigner).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(mockValidateGenericUserTx).toHaveBeenCalledTimes(1);
    expect(mockValidateGenericUserTx.mock.calls[0][1]).toEqual({
      network: RELAY_CONFIG_RESPONSE.network,
      settlementPayoutRecipientAddress: RELAY_CONFIG_RESPONSE.settlementPayoutRecipient,
      configId: STELIS_CONTRACT_IDS.testnet!.configId,
      vaultRegistryId: STELIS_CONTRACT_IDS.testnet!.vaultRegistryId,
      packageId: STELIS_CONTRACT_IDS.testnet!.packageId,
    });
    expect(mockValidateGenericUserTx.mock.calls[0][2]).toBe(DEEP_TYPE);
  });

  it('rejects locally when the shared user TransactionKind validator fails', async () => {
    mockValidateGenericUserTx.mockReturnValueOnce({
      ok: false,
      code: 'P1_SPONSOR_WITHDRAWAL_FORBIDDEN',
      message: 'sponsor withdrawal forbidden',
    });
    const sdk = await createSDK();

    await expect(
      sdk.prepareSponsored(new Transaction(), {
        client: makeMockSuiClient(),
        addr: ADDR,
        settlementToken: { type: DEEP_TYPE },
        prepareAuthorizationSigner,
      }),
    ).rejects.toMatchObject({
      name: 'StelisSponsoredError',
      code: 'P1_SPONSOR_WITHDRAWAL_FORBIDDEN',
      message: 'sponsor withdrawal forbidden',
    });

    expect(mockPrepare).not.toHaveBeenCalled();
    expect(prepareAuthorizationSigner).not.toHaveBeenCalled();
  });

  // ── 2: Returns txBytes from prepare response ────────────────────────

  it('returns the Host-bound transaction bytes and policy hash', async () => {
    const sdk = await createSDK();
    const result = await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient(),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
    });

    expect(result.txBytes).toBe('base64MockTxBytes');
    expect(result.policyHash).toBe(MOCK_PREPARE_RESPONSE.policyHash);
    expect(mockQueryUserCredit).not.toHaveBeenCalled();
  });

  // ── 3: Returns receiptId from prepare response ──────────────────────

  it('returns receiptId from prepare response', async () => {
    const sdk = await createSDK();
    const result = await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient(),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
    });

    expect(result.receiptId).toBe(MOCK_PREPARE_RESPONSE.receiptId);
  });

  // ── 4: Returns cost breakdown from prepare response ─────────────────

  it('returns cost breakdown from prepare response', async () => {
    const sdk = await createSDK();
    const result = await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient(),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
    });

    expect(result.cost).toEqual(MOCK_PREPARE_RESPONSE.cost);
  });

  // ── 5: Calls onGasEstimate with totalCost from prepare ───────────────

  it('calls onGasEstimate callback with totalCost (executionCostClaim + quotedHostFee + protocolFee) in SUI', async () => {
    const sdk = await createSDK();
    const onGasEstimate = vi.fn();

    await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient(),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
      onGasEstimate,
    });

    expect(onGasEstimate).toHaveBeenCalledTimes(1);
    // totalCost = executionCostClaim(5250000) + quotedHostFee(100000) + protocolFee(20000) = 5370000
    expect(onGasEstimate).toHaveBeenCalledWith(5_370_000n, '0.005370000', 'SUI');
  });

  // ── 6: Returns totalCostSui computed from totalCost ─────────────────

  it('returns totalCostSui and totalCostMist computed from cost breakdown', async () => {
    const sdk = await createSDK();
    const result = await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient(),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
    });

    // totalCost = executionCostClaim(5250000) + quotedHostFee(100000) + protocolFee(20000) = 5370000
    expect(result.totalCostSui).toBe('0.005370000');
    expect(result.totalCostMist).toBe(5_370_000n);
  });

  // ── 8: Passes slippageBps and gasMarginBps to client.prepare ────────

  it('forwards slippageBps and gasMarginBps to client.prepare()', async () => {
    const sdk = await createSDK();

    await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient(),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
      slippageBps: 300,
      gasMarginBps: 500,
    });

    expect(mockPrepare).toHaveBeenCalledTimes(1);
    const args = mockPrepare.mock.calls[0][0] as Record<string, unknown>;
    expect(args['slippageBps']).toBe(300);
    expect(args['gasMarginBps']).toBe(500);
  });

  // ── 9: Throws on unknown settlementToken type ──────────────────────────────

  it('throws when settlementToken type is not in supported settlement swap paths', async () => {
    const sdk = await createSDK();

    await expect(
      sdk.prepareSponsored(new Transaction(), {
        client: makeMockSuiClient(),
        addr: ADDR,
        settlementToken: { type: '0xunknown::token::TOKEN' },
        prepareAuthorizationSigner,
      }),
    ).rejects.toThrow();
  });

  // ── 10: Forwards orderId to client.prepare ─────────────────────────

  it('forwards orderId to client.prepare()', async () => {
    const sdk = await createSDK();

    await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient(),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
      orderId: 'sponsored-order-42',
    });

    expect(mockPrepare).toHaveBeenCalledTimes(1);
    const args = mockPrepare.mock.calls[0][0] as Record<string, unknown>;
    expect(args['orderId']).toBe('sponsored-order-42');
  });

  // ── 11: Echoes orderId from prepare response ───────────────────────

  it('echoes orderId from prepare response', async () => {
    mockPrepare.mockResolvedValueOnce({
      ...MOCK_PREPARE_RESPONSE,
      orderId: 'echoed-order-42',
    });
    const sdk = await createSDK();

    const result = await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient(),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
      orderId: 'echoed-order-42',
    });

    expect(result.orderId).toBe('echoed-order-42');
  });
});
