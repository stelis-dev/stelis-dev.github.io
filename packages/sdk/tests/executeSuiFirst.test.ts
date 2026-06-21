/**
 * executeSuiFirst — unit tests.
 *
 * Verifies:
 *   1.  Gas preset guard: gasPayment preset → Error
 *   2.  Gas preset guard: gasBudget preset → Error
 *   3.  Gas preset guard: gasOwner preset → Error
 *   4.  Gas preset guard: gasPrice preset → Error
 *   5.  SUI sufficient → path:'sui', Host not called
 *   6.  SUI insufficient → path:'sponsored', Host called
 *   7.  SUI = gasBudget (boundary) → path:'sui'
 *   8.  getBalance infra failure → best-effort sponsored fallback
 *       (NOTE: fallback itself may also fail if client node is down)
 *   9.  simulateTransaction infra failure → best-effort sponsored fallback
 *  10.  simulateTransaction FailedTransaction → Error (outside catch)
 *  11.  gasUsed missing → Error (outside catch)
 *  12.  SUI execution FailedTransaction → Error
 *  13.  infra fallback: executeSponsored also fails → error propagates as-is
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { StelisSDK } from '../src/sdk.js';
import type { RelayConfigResponse } from '../src/types.js';
import { STELIS_CONTRACT_IDS } from '@stelis/contracts';

const { mockExtractSettleFields, mockValidateSettleFields } = vi.hoisted(() => ({
  mockExtractSettleFields: vi.fn(),
  mockValidateSettleFields: vi.fn(),
}));

// ── Mock: integrity ───────────────────────────────────────────────────────────
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

// ── Mock: credit ──────────────────────────────────────────────────────────────
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

// ── Mock: StelisClient ─────────────────────────────────────────────────────────
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
    ) {
      super(message);
      this.name = 'StelisApiException';
    }
  },
}));

// ── Mock: fetch ───────────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Constants ──────────────────────────────────────────────────────────────────
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
  integrityPolicyVersion: 1,
};

const MOCK_SPONSOR_RESPONSE = {
  digest: '0xDIGEST_GASLESS',
  effects: { status: { success: true } },
};

// SUI balance: 100 SUI in MIST
const SUFFICIENT_SUI_BALANCE = (100n * 1_000_000_000n).toString();
// SUI balance: 0.001 SUI in MIST
const INSUFFICIENT_SUI_BALANCE = 1_000_000n.toString();

// Simulate: 1M computation + 0 storage = grossGas 1M, with 10% margin → budget 1_100_000
const MOCK_SIM_GAS_USED = {
  computationCost: '1000000',
  storageCost: '0',
  storageRebate: '0',
};
const EXPECTED_GAS_BUDGET = 1_100_000n; // 1_000_000 * 1.1

function makeSimSuccess() {
  return {
    $kind: 'Transaction' as const,
    Transaction: {
      digest: 'simDigest',
      effects: { gasUsed: MOCK_SIM_GAS_USED },
    },
    FailedTransaction: undefined,
    commandResults: undefined,
  };
}

function makeSuiClient(
  overrides: Partial<{
    balanceMist: string;
    simResult: unknown;
    execResult: unknown;
    buildBytes: Uint8Array;
  }> = {},
): SuiGrpcClient {
  const balanceMist = overrides.balanceMist ?? SUFFICIENT_SUI_BALANCE;
  const simResult = overrides.simResult ?? makeSimSuccess();
  const execResult = overrides.execResult ?? {
    $kind: 'Transaction',
    Transaction: { digest: '0xDIGEST_SUI', effects: { status: { success: true } } },
  };
  return {
    getBalance: vi.fn().mockResolvedValue({ balance: { balance: balanceMist } }),
    simulateTransaction: vi.fn().mockResolvedValue(simResult),
    executeTransaction: vi.fn().mockResolvedValue(execResult),
    getReferenceGasPrice: vi.fn().mockResolvedValue(1000n),
    listCoins: vi.fn().mockResolvedValue({ objects: [{ objectId: '0xcoin' }] }),
    resolveTransactionPlugin: vi.fn().mockReturnValue(undefined),
  } as unknown as SuiGrpcClient;
}

async function createSDK(): Promise<StelisSDK> {
  mockFetch.mockResolvedValueOnce(
    new Response(JSON.stringify(RELAY_CONFIG_RESPONSE), { status: 200 }),
  );
  return StelisSDK.connect('http://mock.local/api');
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('StelisSDK.executeSuiFirst', () => {
  let sdk: StelisSDK;
  let buildSpy: MockInstance<typeof Transaction.prototype.build>;

  beforeEach(async () => {
    mockFetch.mockReset();
    mockPrepare.mockReset();
    mockSponsor.mockReset();
    mockExtractSettleFields.mockReset();
    mockExtractSettleFields.mockReturnValue({});
    mockValidateSettleFields.mockReset();
    mockValidateSettleFields.mockReturnValue({ ok: true });
    sdk = await createSDK();
    // Spy on Transaction.prototype.build to avoid real gRPC calls in unit tests
    const validKindBytes = await new Transaction().build({ onlyTransactionKind: true });
    buildSpy = vi.spyOn(Transaction.prototype, 'build').mockResolvedValue(validKindBytes);
  });

  afterEach(() => {
    buildSpy.mockRestore();
  });

  const defaultOpts = (client?: SuiGrpcClient) => ({
    client: client ?? makeSuiClient(),
    prepareAuthorizationSigner: vi.fn().mockResolvedValue('prepare-sig-base64'),
    signer: vi.fn().mockResolvedValue('user-sig-base64'),
    addr: ADDR,
    settlementToken: { type: DEEP_TYPE },
  });

  // ── 1: Gas preset guard — gasPayment ─────────────────────────────────────
  it('throws if tx has gasPayment preset', async () => {
    const tx = new Transaction();
    tx.setGasPayment([{ objectId: '0x' + 'a'.repeat(64), version: '1', digest: 'abc' }]);
    await expect(sdk.executeSuiFirst(tx, defaultOpts())).rejects.toThrow('gasPayment preset');
  });

  // ── 2: Gas preset guard — gasBudget ──────────────────────────────────────
  it('throws if tx has gasBudget preset', async () => {
    const tx = new Transaction();
    tx.setGasBudget(1_000_000n);
    await expect(sdk.executeSuiFirst(tx, defaultOpts())).rejects.toThrow('gasBudget preset');
  });

  // ── 3: Gas preset guard — gasOwner ───────────────────────────────────────
  it('throws if tx has gasOwner preset', async () => {
    const tx = new Transaction();
    tx.setGasOwner(ADDR);
    await expect(sdk.executeSuiFirst(tx, defaultOpts())).rejects.toThrow('gasOwner preset');
  });

  // ── 4: Gas preset guard — gasPrice ───────────────────────────────────────
  it('throws if tx has gasPrice preset', async () => {
    const tx = new Transaction();
    tx.setGasPrice(999n);
    await expect(sdk.executeSuiFirst(tx, defaultOpts())).rejects.toThrow('gasPrice preset');
  });

  // ── 5: SUI sufficient → direct execution, path:'sui' ─────────────────────
  it('executes directly when SUI balance >= gasBudget, returns path:sui', async () => {
    const client = makeSuiClient({ balanceMist: SUFFICIENT_SUI_BALANCE });
    const result = await sdk.executeSuiFirst(new Transaction(), defaultOpts(client));

    expect(result.path).toBe('sui');
    expect(result.digest).toBe('0xDIGEST_SUI');
    expect(mockSponsor).not.toHaveBeenCalled();
  });

  // ── 6: SUI insufficient → sponsored fallback, path:'sponsored' ───────────────
  it('falls back to executeSponsored when SUI < gasBudget, returns path:sponsored', async () => {
    const client = makeSuiClient({ balanceMist: INSUFFICIENT_SUI_BALANCE });
    mockPrepare.mockResolvedValue({
      txBytes: 'base64TxBytes',
      receiptId: '0x' + 'ff'.repeat(32),
      cost: {
        simGas: '1000000',
        gasVarianceFixedMist: '50000',
        slippageBufferMist: '0',
        quotedHostFee: '0',
        protocolFee: '0',
        executionCostClaim: '1050000',
        grossGas: '1000000',
      },
      profile: 'new_user',
      quoteTimestampMs: Date.now(),
      policyHash: '0xab',
    });
    mockSponsor.mockResolvedValue(MOCK_SPONSOR_RESPONSE);

    const result = await sdk.executeSuiFirst(new Transaction(), defaultOpts(client));

    expect(result.path).toBe('sponsored');
    expect(result.digest).toBe(MOCK_SPONSOR_RESPONSE.digest);
    expect(mockSponsor).toHaveBeenCalledTimes(1);
  });

  // ── 7: SUI = gasBudget (boundary) → direct execution ─────────────────────
  it('executes directly when SUI balance exactly equals gasBudget (boundary)', async () => {
    const client = makeSuiClient({ balanceMist: EXPECTED_GAS_BUDGET.toString() });
    const result = await sdk.executeSuiFirst(new Transaction(), defaultOpts(client));

    expect(result.path).toBe('sui');
    expect(mockSponsor).not.toHaveBeenCalled();
  });

  // ── 8: getBalance infra failure → best-effort sponsored fallback ────────────
  it('falls back to executeSponsored when getBalance fails with network error (best-effort)', async () => {
    // NOTE: fallback may also fail if the same client node is down.
    // This test verifies the fallback path is attempted, not that it always succeeds.
    const client = makeSuiClient();
    (client.getBalance as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fetch failed'));
    mockPrepare.mockResolvedValue({
      txBytes: 'base64TxBytes',
      receiptId: '0x' + 'ff'.repeat(32),
      cost: {
        simGas: '1000000',
        gasVarianceFixedMist: '50000',
        slippageBufferMist: '0',
        quotedHostFee: '0',
        protocolFee: '0',
        executionCostClaim: '1050000',
        grossGas: '1000000',
      },
      profile: 'new_user',
      quoteTimestampMs: Date.now(),
      policyHash: '0xab',
    });
    mockSponsor.mockResolvedValue(MOCK_SPONSOR_RESPONSE);

    const result = await sdk.executeSuiFirst(new Transaction(), defaultOpts(client));
    expect(result.path).toBe('sponsored');
  });

  // ── 9: simulateTransaction infra failure → best-effort sponsored fallback ───
  it('falls back to executeSponsored when simulateTransaction fails with timeout (best-effort)', async () => {
    const client = makeSuiClient();
    (client.simulateTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('timeout'),
    );
    mockPrepare.mockResolvedValue({
      txBytes: 'base64TxBytes',
      receiptId: '0x' + 'ff'.repeat(32),
      cost: {
        simGas: '1000000',
        gasVarianceFixedMist: '50000',
        slippageBufferMist: '0',
        quotedHostFee: '0',
        protocolFee: '0',
        executionCostClaim: '1050000',
        grossGas: '1000000',
      },
      profile: 'new_user',
      quoteTimestampMs: Date.now(),
      policyHash: '0xab',
    });
    mockSponsor.mockResolvedValue(MOCK_SPONSOR_RESPONSE);

    const result = await sdk.executeSuiFirst(new Transaction(), defaultOpts(client));
    expect(result.path).toBe('sponsored');
  });

  // ── 10: simulateTransaction FailedTransaction → throw (outside catch) ─────
  it('throws when simulation returns FailedTransaction', async () => {
    const client = makeSuiClient({
      simResult: {
        $kind: 'FailedTransaction',
        FailedTransaction: { status: { error: 'InsufficientGas' } },
        Transaction: undefined,
        commandResults: undefined,
      },
    });
    await expect(sdk.executeSuiFirst(new Transaction(), defaultOpts(client))).rejects.toThrow(
      'Simulation failed',
    );
    expect(mockSponsor).not.toHaveBeenCalled();
  });

  // ── 11: gasUsed missing → throw (outside catch) ───────────────────────────
  it('throws when simulation returns success but gasUsed is missing', async () => {
    const client = makeSuiClient({
      simResult: {
        $kind: 'Transaction',
        Transaction: { digest: 'simDigest', effects: {} }, // no gasUsed
        FailedTransaction: undefined,
        commandResults: undefined,
      },
    });
    await expect(sdk.executeSuiFirst(new Transaction(), defaultOpts(client))).rejects.toThrow(
      'no gasUsed',
    );
  });

  // ── 12: SUI execution FailedTransaction → throw ───────────────────────────
  it('throws when direct SUI executeTransaction returns FailedTransaction', async () => {
    const client = makeSuiClient({
      execResult: {
        $kind: 'FailedTransaction',
        FailedTransaction: { status: { error: 'MoveAbort' } },
        Transaction: undefined,
      },
    });
    await expect(sdk.executeSuiFirst(new Transaction(), defaultOpts(client))).rejects.toThrow(
      'Transaction failed',
    );
  });

  // ── 13: infra fallback → executeSponsored also fails → error propagates ─────
  it('propagates executeSponsored error when infra fallback also fails', async () => {
    const client = makeSuiClient();
    (client.getBalance as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fetch failed'));
    mockPrepare.mockRejectedValue(new Error('HOST_DOWN'));

    await expect(sdk.executeSuiFirst(new Transaction(), defaultOpts(client))).rejects.toThrow(
      'HOST_DOWN',
    );
  });

  // ── orderId echo — sponsored fallback (SUI insufficient) ─────────────────
  it('echoes orderId on sponsored fallback path (SUI insufficient)', async () => {
    const client = makeSuiClient({ balanceMist: INSUFFICIENT_SUI_BALANCE });
    mockPrepare.mockResolvedValue({
      txBytes: 'base64TxBytes',
      receiptId: '0x' + 'ff'.repeat(32),
      cost: {
        simGas: '1000000',
        gasVarianceFixedMist: '50000',
        slippageBufferMist: '0',
        quotedHostFee: '0',
        protocolFee: '0',
        executionCostClaim: '1050000',
        grossGas: '1000000',
      },
      profile: 'new_user',
      quoteTimestampMs: Date.now(),
      policyHash: '0xab',
      orderId: 'fallback-order',
    });
    mockSponsor.mockResolvedValue({
      ...MOCK_SPONSOR_RESPONSE,
      orderId: 'fallback-order',
    });

    const result = await sdk.executeSuiFirst(new Transaction(), {
      ...defaultOpts(client),
      orderId: 'fallback-order',
    });

    expect(result.path).toBe('sponsored');
    expect(result.orderId).toBe('fallback-order');
  });

  // ── orderId echo — infra fallback (getBalance failure) ─────────────────
  it('echoes orderId on infra fallback path (getBalance failure)', async () => {
    const client = makeSuiClient();
    (client.getBalance as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fetch failed'));
    mockPrepare.mockResolvedValue({
      txBytes: 'base64TxBytes',
      receiptId: '0x' + 'ff'.repeat(32),
      cost: {
        simGas: '1000000',
        gasVarianceFixedMist: '50000',
        slippageBufferMist: '0',
        quotedHostFee: '0',
        protocolFee: '0',
        executionCostClaim: '1050000',
        grossGas: '1000000',
      },
      profile: 'new_user',
      quoteTimestampMs: Date.now(),
      policyHash: '0xab',
      orderId: 'infra-order',
    });
    mockSponsor.mockResolvedValue({
      ...MOCK_SPONSOR_RESPONSE,
      orderId: 'infra-order',
    });

    const result = await sdk.executeSuiFirst(new Transaction(), {
      ...defaultOpts(client),
      orderId: 'infra-order',
    });

    expect(result.path).toBe('sponsored');
    expect(result.orderId).toBe('infra-order');
  });

  // ── orderId undefined — direct SUI path ────────────────────────────────
  it('returns undefined orderId on direct SUI path', async () => {
    const client = makeSuiClient({ balanceMist: SUFFICIENT_SUI_BALANCE });
    const result = await sdk.executeSuiFirst(new Transaction(), {
      ...defaultOpts(client),
      orderId: 'should-not-appear',
    });

    expect(result.path).toBe('sui');
    expect(result.orderId).toBeUndefined();
  });
});
