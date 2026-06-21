/**
 * prepareSponsored — verifies the thin wrapper that delegates to client.prepare().
 *
 * Tests verify:
 *   1. client.prepare() is called with correct params
 *   2. PrepareResponse fields are passed through correctly
 *   3. onGasEstimate callback receives totalCost (MIST) with 'SUI' symbol
 *   4. queryUserCredit is called and vaultId is returned
 *   5. Optional params (slippageBps, gasMarginBps) are forwarded
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { StelisSDK } from '../src/sdk.js';
import type { RelayConfigResponse, PrepareResponse } from '../src/types.js';
import { STELIS_CONTRACT_IDS } from '@stelis/contracts';

const { mockExtractSettleFields, mockValidateSettleFields, mockValidateGenericUserTx } = vi.hoisted(
  () => ({
    mockExtractSettleFields: vi.fn(),
    mockValidateSettleFields: vi.fn(),
    mockValidateGenericUserTx: vi.fn(),
  }),
);

// ── Module-level mock: queryUserCredit ─────────────────────────────────────────
let _creditResult = { vaultObjectId: null as string | null, credit: '0', needsCreate: false };

vi.mock('../src/credit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/credit.js')>();
  return {
    ...actual,
    queryUserCredit: vi.fn(async () => ({ ..._creditResult })),
  };
});

// ── Module-level mock: integrity (S-16) ────────────────────────────────────────
// prepareSponsored tests verify prepare delegation, not PTB integrity.
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

vi.mock('@stelis/core-relay/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stelis/core-relay/browser')>();
  return {
    ...actual,
    extractSettleTransactionFieldsFromTxBytes: mockExtractSettleFields,
    validateSettleTransactionFields: mockValidateSettleFields,
    validateGenericUserTransactionKind: mockValidateGenericUserTx,
  };
});

// ── Module-level mock: StelisClient ─────────────────────────────────────────────
// Mock StelisClient so StelisSDK.connect() succeeds without network.
const mockPrepare =
  vi.fn<
    (params: Record<string, unknown>, headers?: Record<string, string>) => Promise<PrepareResponse>
  >();
const mockSponsor = vi.fn();

vi.mock('../src/client.js', () => ({
  StelisClient: vi.fn().mockImplementation(function () {
    return {
      getStatus: vi.fn().mockResolvedValue({ ok: true }),
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

// ── Mock: fetch for StelisSDK.connect() config endpoint ─────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

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
  integrityPolicyVersion: 1,
};

const MOCK_PREPARE_RESPONSE: PrepareResponse = {
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
function makeMockSuiClient(overrides?: { listCoins?: ReturnType<typeof vi.fn> }): SuiGrpcClient {
  return {
    getReferenceGasPrice: vi.fn().mockResolvedValue(1000n),
    listCoins:
      overrides?.listCoins ?? vi.fn().mockResolvedValue({ objects: [{ objectId: '0xcoin' }] }),
    // Minimal mocks for tx.build
  } as unknown as SuiGrpcClient;
}

// ── SDK factory — uses mocked StelisClient.connect ──────────────────────────────
async function createSDK(): Promise<StelisSDK> {
  // Mock the internal /relay/config fetch that StelisSDK.connect() uses.
  // The StelisClient constructor is mocked — getStatus() resolves immediately.
  mockFetch.mockResolvedValueOnce(
    new Response(JSON.stringify(RELAY_CONFIG_RESPONSE), { status: 200 }),
  );
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
    prepareAuthorizationSigner.mockClear();
    _creditResult = { vaultObjectId: null, credit: '0', needsCreate: false };
    mockFetch.mockReset();
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
      code: 'P1_SPONSOR_WITHDRAWAL_FORBIDDEN',
      message: 'sponsor withdrawal forbidden',
      status: 422,
    });

    expect(mockPrepare).not.toHaveBeenCalled();
    expect(prepareAuthorizationSigner).not.toHaveBeenCalled();
  });

  // ── 2: Returns txBytes from prepare response ────────────────────────

  it('returns txBytes from prepare response', async () => {
    const sdk = await createSDK();
    const result = await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient(),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
    });

    expect(result.txBytes).toBe('base64MockTxBytes');
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

  // ── 9: Returns vaultId from queryUserCredit ─────────────────────────

  it('returns vaultId from queryUserCredit', async () => {
    _creditResult = { vaultObjectId: '0xVaultObj', credit: '1000', needsCreate: false };
    const sdk = await createSDK();

    const result = await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient(),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
    });

    expect(result.vaultId).toBe('0xVaultObj');
  });

  // ── 10: Returns null vaultId when no vault ──────────────────────────

  it('returns null vaultId for new user', async () => {
    _creditResult = { vaultObjectId: null, credit: '0', needsCreate: true };
    const sdk = await createSDK();

    const result = await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient(),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
    });

    expect(result.vaultId).toBeNull();
  });

  // ── 11: Throws on unknown settlementToken type ─────────────────────────────

  it('throws when settlementToken type is not in supported settlement swap paths', async () => {
    const sdk = await createSDK();

    await expect(
      sdk.prepareSponsored(new Transaction(), {
        client: makeMockSuiClient(),
        addr: ADDR,
        settlementToken: { type: '0xunknown::token::TOKEN' },
      }),
    ).rejects.toThrow();
  });

  // ── 12: Forwards orderId to client.prepare ──────────────────────────

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

  // ── 13: Echoes orderId from prepare response ────────────────────────

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

// ─────────────────────────────────────────────
// Preflight coverage
// ─────────────────────────────────────────────

describe('StelisSDK.prepareSponsored — preflight checks', () => {
  beforeEach(() => {
    mockPrepare.mockReset();
    mockPrepare.mockResolvedValue(MOCK_PREPARE_RESPONSE);
    mockExtractSettleFields.mockReset();
    mockExtractSettleFields.mockReturnValue({});
    mockValidateSettleFields.mockReset();
    mockValidateSettleFields.mockReturnValue({ ok: true });
    mockValidateGenericUserTx.mockReset();
    mockValidateGenericUserTx.mockReturnValue({ ok: true });
    _creditResult = { vaultObjectId: null, credit: '0', needsCreate: false };
    mockFetch.mockReset();
  });

  // ── Preflight: no coin check — server handles source resolution ─────
  it('proceeds to /prepare even when no vault and no coins (server resolves from address balance)', async () => {
    _creditResult = { vaultObjectId: null, credit: '0', needsCreate: true };
    const sdk = await createSDK();
    const listCoins = vi.fn().mockResolvedValue({ objects: [] });

    const result = await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient({ listCoins }),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
    });

    // Should proceed to /prepare — server resolves coin vs address balance
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(result.txBytes).toBe('base64MockTxBytes');
  });

  // ── Preflight: proceeds when coins exist ────────────────────────────
  it('proceeds to /prepare when no vault but coins exist', async () => {
    _creditResult = { vaultObjectId: null, credit: '0', needsCreate: true };
    const sdk = await createSDK();
    const listCoins = vi.fn().mockResolvedValue({ objects: [{ objectId: '0xcoin' }] });

    const result = await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient({ listCoins }),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
    });

    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(result.txBytes).toBe('base64MockTxBytes');
  });

  // ── Preflight: skips coin check for credit_general ──────────────────
  it('skips preflight coin check when vault has credit', async () => {
    _creditResult = { vaultObjectId: '0xVault', credit: '999999999', needsCreate: false };
    const sdk = await createSDK();
    const listCoins = vi.fn();

    await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient({ listCoins }),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
    });

    // listCoins should NOT have been called — credit covers everything
    expect(listCoins).not.toHaveBeenCalled();
    expect(mockPrepare).toHaveBeenCalledTimes(1);
  });

  // ── Preflight: fail-open on RPC error ───────────────────────────────
  it('proceeds to /prepare when preflight RPC fails (fail-open)', async () => {
    // queryUserCredit will throw a network error (simulated via mock)
    const { queryUserCredit: mockQueryCredit } = await import('../src/credit.js');
    const originalImpl = (mockQueryCredit as ReturnType<typeof vi.fn>).getMockImplementation();
    (mockQueryCredit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('fetch failed: network timeout'),
    );

    const sdk = await createSDK();

    const result = await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient(),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
    });

    // Should have proceeded to /prepare despite preflight RPC failure
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(result.txBytes).toBe('base64MockTxBytes');

    // Restore original mock
    if (originalImpl) {
      (mockQueryCredit as ReturnType<typeof vi.fn>).mockImplementation(originalImpl);
    }
  });

  // ── Post-prepare vault query failure does not abort flow ──────────
  it('returns vaultId=null when post-prepare queryUserCredit fails', async () => {
    const { queryUserCredit: mockQueryCredit } = await import('../src/credit.js');
    const sdk = await createSDK();

    // First call (preflight) succeeds, second call (post-prepare) fails
    let callCount = 0;
    (mockQueryCredit as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        return { ..._creditResult };
      }
      throw new Error('transient RPC failure');
    });

    const result = await sdk.prepareSponsored(new Transaction(), {
      client: makeMockSuiClient(),
      addr: ADDR,
      settlementToken: { type: DEEP_TYPE },
      prepareAuthorizationSigner,
    });

    // /prepare succeeded — result should be returned with vaultId=null
    expect(result.txBytes).toBe('base64MockTxBytes');
    expect(result.vaultId).toBeNull();
  });

  // ── CreditQueryInconsistentStateError in preflight propagates ─────
  it('propagates CreditQueryInconsistentStateError from preflight (not swallowed as infra error)', async () => {
    const { queryUserCredit: mockQueryCredit, CreditQueryInconsistentStateError } =
      await import('../src/credit.js');
    (mockQueryCredit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new CreditQueryInconsistentStateError('vault missing', '0xVAULT', '0xUSER'),
    );

    const sdk = await createSDK();

    await expect(
      sdk.prepareSponsored(new Transaction(), {
        client: makeMockSuiClient(),
        addr: ADDR,
        settlementToken: { type: DEEP_TYPE },
        prepareAuthorizationSigner,
      }),
    ).rejects.toThrow(CreditQueryInconsistentStateError);
  });
});
