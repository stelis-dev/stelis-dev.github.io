/**
 * executePromotionSponsored — unit tests for promotion-specific SDK methods.
 *
 * Verifies:
 *   1. preparePromotionSponsored — builds kind bytes and calls client.promotionPrepare
 *   2. sponsorPromotionSponsored — forwards params to client.promotionSponsor
 *   3. executePromotionSponsored — orchestrates prepare → sign → sponsor
 *   4. Host Studio availability errors are preserved without a client-side mode branch
 *
 * Strategy: mock StelisClient methods and verify SDK orchestration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { withSuiClientIdentity } from './helpers/suiClientIdentity.js';
import { StelisSDK } from '../src/sdk.js';
import type { RelayConfigResponse } from '../src/types.js';
import { STELIS_CONTRACT_IDS } from '@stelis/contracts';

// ── Mock: integrity (skip S-16 and promotion integrity) ─────────────────────
const { mockVerifyPromotionIntegrity } = vi.hoisted(() => ({
  mockVerifyPromotionIntegrity: vi.fn(),
}));
vi.mock('../src/integrity.js', () => ({
  verifyPtbIntegrity: vi.fn(),
  verifyPromotionPtbIntegrity: mockVerifyPromotionIntegrity,
  StelisIntegrityError: class StelisIntegrityError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'StelisIntegrityError';
    }
  },
}));

// ── Mock: StelisClient ────────────────────────────────────────────────────────
const mockPromotionPrepare = vi.fn();
const mockPromotionSponsor = vi.fn();
const mockGetConfig = vi.fn<() => Promise<RelayConfigResponse>>();

vi.mock('../src/client.js', () => ({
  StelisClient: vi.fn().mockImplementation(function ({ endpoint }: { endpoint: string }) {
    return {
      getStatus: vi.fn().mockResolvedValue({ ok: true }),
      getConfig: mockGetConfig,
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

// ── Constants ────────────────────────────────────────────────────────────────
const ADDR = '0x' + 'a'.repeat(64);
const PKG = '0x' + '1'.repeat(64);
const DEEP_TYPE = `${PKG}::deep::DEEP`;
const PROMOTION_ID = '00000000-0000-4000-8000-000000000001';
const RECEIPT_ID = `0x${'ab'.repeat(32)}`;

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

function makeMockSuiClient(): SuiGrpcClient {
  return withSuiClientIdentity({});
}

async function createSDK(): Promise<StelisSDK> {
  mockGetConfig.mockResolvedValueOnce(RELAY_CONFIG_RESPONSE);
  return StelisSDK.connect('http://host.local/relay');
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
    mockGetConfig.mockReset();
    mockPromotionPrepare.mockReset();
    mockPromotionSponsor.mockReset();
    mockVerifyPromotionIntegrity.mockReset();
    sdk = await createSDK();
  });

  it('builds TransactionKind bytes and calls client.promotionPrepare', async () => {
    mockPromotionPrepare.mockResolvedValue({
      txBytes: 'b64tx',
      receiptId: RECEIPT_ID,
      estimatedGasMist: '5000000',
    });

    const tx = buildTestTx();

    const result = await sdk.preparePromotionSponsored(tx, {
      client: makeMockSuiClient(),
      promotionId: PROMOTION_ID,
      addr: ADDR,
      developerJwt: 'jwt-token',
    });

    expect(result.txBytes).toBe('b64tx');
    expect(result.receiptId).toBe(RECEIPT_ID);
    expect(result.estimatedGasMist).toBe('5000000');

    // Verify client.promotionPrepare was called correctly
    expect(mockPromotionPrepare).toHaveBeenCalledTimes(1);
    const [promId, params, jwt] = mockPromotionPrepare.mock.calls[0];
    expect(promId).toBe(PROMOTION_ID);
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

  it('preserves STUDIO_UNAVAILABLE returned by the Host', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockPromotionPrepare.mockRejectedValue(
      new StelisApiException('STUDIO_UNAVAILABLE', 'Service temporarily unavailable', 503),
    );

    await expect(
      sdk.preparePromotionSponsored(buildTestTx(), {
        client: makeMockSuiClient(),
        promotionId: PROMOTION_ID,
        addr: ADDR,
        developerJwt: 'jwt',
      }),
    ).rejects.toMatchObject({ code: 'STUDIO_UNAVAILABLE', status: 503 });
    expect(mockPromotionPrepare).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────
// sponsorPromotionSponsored
// ─────────────────────────────────────────────

describe('StelisSDK.sponsorPromotionSponsored', () => {
  let sdk: StelisSDK;

  beforeEach(async () => {
    mockGetConfig.mockReset();
    mockPromotionPrepare.mockReset();
    mockPromotionSponsor.mockReset();
    sdk = await createSDK();
  });

  it('forwards params to client.promotionSponsor', async () => {
    mockPromotionSponsor.mockResolvedValue({
      digest: '0xdigest',
      effects: { status: { success: true } },
      actualGasMist: '3000000',
    });

    const result = await sdk.sponsorPromotionSponsored({
      promotionId: PROMOTION_ID,
      receiptId: RECEIPT_ID,
      txBytes: 'b64tx',
      userSignature: 'sig',
      developerJwt: 'jwt-token',
    });

    expect(result.digest).toBe('0xdigest');
    expect(result.actualGasMist).toBe('3000000');

    expect(mockPromotionSponsor).toHaveBeenCalledTimes(1);
    const [promId, params, jwt] = mockPromotionSponsor.mock.calls[0];
    expect(promId).toBe(PROMOTION_ID);
    expect(params.receiptId).toBe(RECEIPT_ID);
    expect(params.txBytes).toBe('b64tx');
    expect(params.userSignature).toBe('sig');
    expect(jwt).toBe('jwt-token');
  });

  it('preserves STUDIO_UNAVAILABLE returned by the Host', async () => {
    const { StelisApiException } = await import('../src/client.js');
    mockPromotionSponsor.mockRejectedValue(
      new StelisApiException('STUDIO_UNAVAILABLE', 'Service temporarily unavailable', 503),
    );

    await expect(
      sdk.sponsorPromotionSponsored({
        promotionId: PROMOTION_ID,
        receiptId: RECEIPT_ID,
        txBytes: 'b64tx',
        userSignature: 'sig',
        developerJwt: 'jwt',
      }),
    ).rejects.toMatchObject({ code: 'STUDIO_UNAVAILABLE', status: 503 });
    expect(mockPromotionSponsor).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────
// executePromotionSponsored
// ─────────────────────────────────────────────

describe('StelisSDK.executePromotionSponsored', () => {
  let sdk: StelisSDK;

  beforeEach(async () => {
    mockGetConfig.mockReset();
    mockPromotionPrepare.mockReset();
    mockPromotionSponsor.mockReset();
    sdk = await createSDK();
  });

  it('orchestrates prepare → sign → sponsor and returns combined result', async () => {
    mockPromotionPrepare.mockResolvedValue({
      txBytes: 'b64prepared',
      receiptId: RECEIPT_ID,
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
      promotionId: PROMOTION_ID,
      signer,
      addr: ADDR,
      developerJwt: 'auth-jwt',
    });

    // Result should contain both prepare and sponsor fields
    expect(result.digest).toBe('0xdigest_final');
    expect(result.txBytes).toBe('b64prepared');
    expect(result.receiptId).toBe(RECEIPT_ID);
    expect(result.estimatedGasMist).toBe('5000000');
    expect(result.actualGasMist).toBe('4500000');

    // Verify signer was called with txBytes from prepare
    expect(signer).toHaveBeenCalledWith('b64prepared');

    // Verify sponsor received the user signature
    const sponsorParams = mockPromotionSponsor.mock.calls[0][1];
    expect(sponsorParams.userSignature).toBe('user-sig-base64');
    expect(sponsorParams.txBytes).toBe('b64prepared');
    expect(sponsorParams.receiptId).toBe(RECEIPT_ID);
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
        promotionId: PROMOTION_ID,
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
      receiptId: RECEIPT_ID,
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
        promotionId: PROMOTION_ID,
        signer,
        addr: ADDR,
        developerJwt: 'jwt',
      }),
    ).rejects.toThrow('Transaction reverted');

    // Signer WAS called (signing succeeded before sponsor failed)
    expect(signer).toHaveBeenCalledTimes(1);
  });
});
