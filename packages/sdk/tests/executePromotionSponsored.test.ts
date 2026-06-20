/**
 * executePromotionSponsored — unit tests for promotion-specific SDK methods.
 *
 * Verifies:
 *   1. preparePromotionSponsored — builds kind bytes and calls client.promotionPrepare
 *   2. sponsorPromotionSponsored — forwards params to client.promotionSponsor
 *   3. executePromotionSponsored — orchestrates prepare → sign → sponsor
 *   4. Non-studioMode rejection — all methods throw when studioEndpoint is not set
 *
 * Strategy: mock StelisClient methods and verify SDK orchestration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { StelisSDK } from '../src/sdk.js';
import type { RelayerConfig } from '../src/types.js';
import { STELIS_CONTRACT_IDS } from '@stelis/contracts';

// ── Mock: integrity (skip S-16 and promotion integrity) ─────────────────────
const { mockVerifyPromotionIntegrity } = vi.hoisted(() => ({
  mockVerifyPromotionIntegrity: vi.fn(),
}));
vi.mock('../src/integrity.js', () => ({
  verifyPtbIntegrity: vi.fn(),
  verifyPromotionPtbIntegrity: mockVerifyPromotionIntegrity,
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

// ── Mock: StelisClient ────────────────────────────────────────────────────────
const mockPromotionPrepare = vi.fn();
const mockPromotionSponsor = vi.fn();

vi.mock('../src/client.js', () => ({
  StelisClient: vi.fn().mockImplementation(function ({ endpoint }: { endpoint: string }) {
    return {
      getStatus: vi.fn().mockResolvedValue({ ok: true }),
      prepare: vi.fn(),
      sponsor: vi.fn(),
      promotionPrepare: mockPromotionPrepare,
      promotionSponsor: mockPromotionSponsor,
      listPromotions: vi.fn(),
      getPromotionDetail: vi.fn(),
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

function makeMockSuiClient(): SuiGrpcClient {
  return {
    getReferenceGasPrice: vi.fn().mockResolvedValue(1000n),
    listCoins: vi.fn().mockResolvedValue({ objects: [{ objectId: '0xcoin' }] }),
  } as unknown as SuiGrpcClient;
}

async function createStudioSDK(): Promise<StelisSDK> {
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(RELAYER_CONFIG), { status: 200 }));
  return StelisSDK.connect('http://studio.local/relay', { studioEndpoint: true });
}

async function createNonStudioSDK(): Promise<StelisSDK> {
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(RELAYER_CONFIG), { status: 200 }));
  return StelisSDK.connect('http://relay.local/relay');
}

/**
 * Build a valid 2-step promotion test TX:
 *   1. coin::zero<SUI> → creates zero-balance Coin<SUI>
 *   2. coin::destroy_zero<SUI> → consumes it (Coin has no `drop`)
 *
 * Mirrors StudioExecutionPanel.buildTestTx().
 */
function buildTestTx(): Transaction {
  const tx = new Transaction();
  const [zeroCoin] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: ['0x2::sui::SUI'] });
  tx.moveCall({
    target: '0x2::coin::destroy_zero',
    typeArguments: ['0x2::sui::SUI'],
    arguments: [zeroCoin],
  });
  return tx;
}

// ─────────────────────────────────────────────
// preparePromotionSponsored
// ─────────────────────────────────────────────

describe('StelisSDK.preparePromotionSponsored', () => {
  let sdk: StelisSDK;

  beforeEach(async () => {
    mockFetch.mockReset();
    mockPromotionPrepare.mockReset();
    mockPromotionSponsor.mockReset();
    mockVerifyPromotionIntegrity.mockReset();
    sdk = await createStudioSDK();
  });

  it('builds TransactionKind bytes and calls client.promotionPrepare', async () => {
    mockPromotionPrepare.mockResolvedValue({
      txBytes: 'b64tx',
      receiptId: 'r1',
      estimatedGasMist: '5000000',
    });

    const tx = buildTestTx();

    const result = await sdk.preparePromotionSponsored(tx, {
      client: makeMockSuiClient(),
      promotionId: 'promo_abc',
      addr: ADDR,
      developerJwt: 'jwt-token',
    });

    expect(result.txBytes).toBe('b64tx');
    expect(result.receiptId).toBe('r1');
    expect(result.estimatedGasMist).toBe('5000000');

    // Verify client.promotionPrepare was called correctly
    expect(mockPromotionPrepare).toHaveBeenCalledTimes(1);
    const [promId, params, jwt] = mockPromotionPrepare.mock.calls[0];
    expect(promId).toBe('promo_abc');
    expect(params.senderAddress).toBe(ADDR);
    expect(typeof params.txKindBytes).toBe('string'); // base64 TX kind bytes
    expect(jwt).toBe('jwt-token');

    // Verify promotion integrity check was invoked with original kindBytes and server txBytes
    expect(mockVerifyPromotionIntegrity).toHaveBeenCalledOnce();
    const [kindArg, txBytesArg] = mockVerifyPromotionIntegrity.mock.calls[0];
    expect(kindArg).toBeInstanceOf(Uint8Array);
    expect(kindArg.length).toBeGreaterThan(0);
    // Verify kindArg encodes the exact user commands from buildTestTx()
    const roundTripped = Transaction.fromKind(kindArg);
    const cmds = roundTripped.getData().commands as Array<{
      MoveCall?: { package: string; module: string; function: string };
    }>;
    expect(cmds).toHaveLength(2);
    expect(cmds[0].MoveCall?.function).toBe('zero');
    expect(cmds[1].MoveCall?.function).toBe('destroy_zero');
    expect(txBytesArg).toBe('b64tx');
  });

  it('throws when not in studioMode', async () => {
    const nonStudioSdk = await createNonStudioSDK();
    const tx = new Transaction();

    await expect(
      nonStudioSdk.preparePromotionSponsored(tx, {
        client: makeMockSuiClient(),
        promotionId: 'promo_1',
        addr: ADDR,
        developerJwt: 'jwt',
      }),
    ).rejects.toThrow('studioEndpoint: true');
  });
});

// ─────────────────────────────────────────────
// sponsorPromotionSponsored
// ─────────────────────────────────────────────

describe('StelisSDK.sponsorPromotionSponsored', () => {
  let sdk: StelisSDK;

  beforeEach(async () => {
    mockFetch.mockReset();
    mockPromotionPrepare.mockReset();
    mockPromotionSponsor.mockReset();
    sdk = await createStudioSDK();
  });

  it('forwards params to client.promotionSponsor', async () => {
    mockPromotionSponsor.mockResolvedValue({
      digest: '0xdigest',
      effects: { status: { success: true } },
      actualGasMist: '3000000',
    });

    const result = await sdk.sponsorPromotionSponsored({
      promotionId: 'promo_abc',
      receiptId: 'r1',
      txBytes: 'b64tx',
      userSignature: 'sig',
      developerJwt: 'jwt-token',
    });

    expect(result.digest).toBe('0xdigest');
    expect(result.actualGasMist).toBe('3000000');

    expect(mockPromotionSponsor).toHaveBeenCalledTimes(1);
    const [promId, params, jwt] = mockPromotionSponsor.mock.calls[0];
    expect(promId).toBe('promo_abc');
    expect(params.receiptId).toBe('r1');
    expect(params.txBytes).toBe('b64tx');
    expect(params.userSignature).toBe('sig');
    expect(jwt).toBe('jwt-token');
  });

  it('throws when not in studioMode', async () => {
    const nonStudioSdk = await createNonStudioSDK();

    await expect(
      nonStudioSdk.sponsorPromotionSponsored({
        promotionId: 'promo_1',
        receiptId: 'r1',
        txBytes: 'b64tx',
        userSignature: 'sig',
        developerJwt: 'jwt',
      }),
    ).rejects.toThrow('studioEndpoint: true');
  });
});

// ─────────────────────────────────────────────
// executePromotionSponsored
// ─────────────────────────────────────────────

describe('StelisSDK.executePromotionSponsored', () => {
  let sdk: StelisSDK;

  beforeEach(async () => {
    mockFetch.mockReset();
    mockPromotionPrepare.mockReset();
    mockPromotionSponsor.mockReset();
    sdk = await createStudioSDK();
  });

  it('orchestrates prepare → sign → sponsor and returns combined result', async () => {
    mockPromotionPrepare.mockResolvedValue({
      txBytes: 'b64prepared',
      receiptId: 'receipt-1',
      estimatedGasMist: '5000000',
    });
    mockPromotionSponsor.mockResolvedValue({
      digest: '0xdigest_final',
      effects: { status: { success: true } },
      actualGasMist: '4500000',
    });

    const signer = vi.fn().mockResolvedValue('user-sig-base64');

    const tx = buildTestTx();

    const result = await sdk.executePromotionSponsored(tx, {
      client: makeMockSuiClient(),
      promotionId: 'promo_xyz',
      signer,
      addr: ADDR,
      developerJwt: 'auth-jwt',
    });

    // Result should contain both prepare and sponsor fields
    expect(result.digest).toBe('0xdigest_final');
    expect(result.txBytes).toBe('b64prepared');
    expect(result.receiptId).toBe('receipt-1');
    expect(result.estimatedGasMist).toBe('5000000');
    expect(result.actualGasMist).toBe('4500000');

    // Verify signer was called with txBytes from prepare
    expect(signer).toHaveBeenCalledWith('b64prepared');

    // Verify sponsor received the user signature
    const sponsorParams = mockPromotionSponsor.mock.calls[0][1];
    expect(sponsorParams.userSignature).toBe('user-sig-base64');
    expect(sponsorParams.txBytes).toBe('b64prepared');
    expect(sponsorParams.receiptId).toBe('receipt-1');
  });

  it('propagates prepare error without signing', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockPromotionPrepare.mockRejectedValue(
      new StelisApiException('NOT_CLAIMED', 'User has not claimed', 403),
    );

    const signer = vi.fn();
    const tx = new Transaction();

    await expect(
      sdk.executePromotionSponsored(tx, {
        client: makeMockSuiClient(),
        promotionId: 'promo_1',
        signer,
        addr: ADDR,
        developerJwt: 'jwt',
      }),
    ).rejects.toThrow('User has not claimed');

    // Signer should NOT have been called
    expect(signer).not.toHaveBeenCalled();
    // Sponsor should NOT have been called
    expect(mockPromotionSponsor).not.toHaveBeenCalled();
  });

  it('propagates sponsor error after signing', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockPromotionPrepare.mockResolvedValue({
      txBytes: 'b64tx',
      receiptId: 'r1',
      estimatedGasMist: '5000000',
    });
    mockPromotionSponsor.mockRejectedValue(
      new StelisApiException('ONCHAIN_REVERT', 'Transaction reverted', 422),
    );

    const signer = vi.fn().mockResolvedValue('sig');
    const tx = new Transaction();

    await expect(
      sdk.executePromotionSponsored(tx, {
        client: makeMockSuiClient(),
        promotionId: 'promo_1',
        signer,
        addr: ADDR,
        developerJwt: 'jwt',
      }),
    ).rejects.toThrow('Transaction reverted');

    // Signer WAS called (signing succeeded before sponsor failed)
    expect(signer).toHaveBeenCalledTimes(1);
  });
});
