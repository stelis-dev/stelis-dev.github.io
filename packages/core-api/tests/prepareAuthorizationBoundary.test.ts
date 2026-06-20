import { describe, expect, it, vi } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase64 } from '@mysten/sui/utils';
import { createStaticSettlementSwapPathDescriptorMap } from '@stelis/core-relay/server';
import type { PrepareHandlerConfig, PrepareParams } from '../src/handlers/prepare.js';
import { handlePrepare } from '../src/handlers/prepare.js';
import {
  PREPARE_AUTHORIZATION_CLOCK_SKEW_MS,
  PREPARE_AUTHORIZATION_TTL_MS,
} from '../src/prepare/prepareAuthorization.js';
import { PrepareOverloadError } from '../src/store/prepareErrors.js';
import { TEST_PREPARE_AUTH_SENDER, withPrepareAuthorization } from './prepareAuthTestHelpers.js';

async function makeValidTxKindBytes(): Promise<string> {
  const tx = new Transaction();
  tx.makeMoveVec({ elements: [tx.pure.u64(42)] });
  return toBase64(await tx.build({ onlyTransactionKind: true }));
}

async function makeSignedParams(overrides: Partial<PrepareParams> = {}): Promise<PrepareParams> {
  const {
    txKindBytesHash,
    prepareAuthorizationTimestampMs,
    prepareAuthorizationRequestNonce,
    prepareAuthorizationSignature,
    ...inputOverrides
  } = overrides;
  return withPrepareAuthorization(
    {
      txKindBytes: await makeValidTxKindBytes(),
      senderAddress: TEST_PREPARE_AUTH_SENDER,
      paymentTokenType: '0xDEEP::deep::DEEP',
      clientIp: '127.0.0.1',
      ...inputOverrides,
    },
    {
      txKindBytesHash,
      prepareAuthorizationTimestampMs,
      prepareAuthorizationRequestNonce,
      prepareAuthorizationSignature,
    },
  );
}

function makeContext(options: { nonceClaim?: 'ok' | 'duplicate' } = {}) {
  return {
    network: 'testnet' as const,
    sui: {},
    sponsorPool: {
      checkout: vi.fn(),
      commit: vi.fn(),
      checkin: vi.fn(),
      sign: vi.fn(),
    },
    packageId: '0xPACKAGE',
    configId: '0xCONFIG',
    vaultRegistryId: '0xREGISTRY',
    rateLimiter: {},
    abuseBlocker: {
      checkIp: vi.fn().mockResolvedValue({ blocked: false }),
      checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
      recordSponsorFailure: vi.fn().mockResolvedValue(undefined),
    },
    prepareRequestNonceStore: {
      claim: vi.fn().mockResolvedValue(options.nonceClaim ?? 'ok'),
    },
    prepareStore: {
      store: vi.fn(),
      consume: vi.fn(),
      peek: vi.fn(),
      evictPreparedEntry: vi.fn(),
      reserveNonce: vi.fn(),
      releaseReservation: vi.fn(),
    },
    settlementPayoutRecipientAddress: '0xRELAYER',
    getConfig: vi.fn(),
    prepareInflightLimiter: {
      tryAcquire: vi.fn().mockResolvedValue(null),
      inflight: 1,
      capacity: 1,
    },
  } as unknown as Parameters<typeof handlePrepare>[0];
}

function makeExtraCfg(): PrepareHandlerConfig {
  const supportedSettlementSwapPaths = [
    {
      hops: [
        {
          poolId: '0xPOOL',
          baseType: '0xDEEP::deep::DEEP',
          quoteType: '0x2::sui::SUI',
          swapDirection: 'baseForQuote' as const,
          feeBps: 0,
        },
      ],
      paymentTokenType: '0xDEEP::deep::DEEP',
      paymentTokenSymbol: 'DEEP',
      paymentTokenDecimals: 6,
      lotSize: 1,
      minSize: 1,
      effectiveFeeRateBps: 0,
      settlementSwapDirection: 'baseForQuote' as const,
    },
  ];
  return {
    deepbookPackageId: '0xDEEPBOOK',
    quotedHostFeeMist: 0n,
    allowedSettlementSwapPaths: [
      {
        tokenType: '0xDEEP::deep::DEEP',
        hops: ['0xPOOL'],
        settlementSwapDirection: 'baseForQuote',
      },
    ],
    supportedSettlementSwapPaths,
    settlementSwapPathDescriptors: createStaticSettlementSwapPathDescriptorMap(
      supportedSettlementSwapPaths,
    ),
  };
}

async function expectAuthError(params: PrepareParams, expectedCode: string): Promise<void> {
  const ctx = makeContext();
  await expect(handlePrepare(ctx, params, makeExtraCfg())).rejects.toMatchObject({
    code: expectedCode,
  });
  expect(ctx.prepareInflightLimiter.tryAcquire).not.toHaveBeenCalled();
}

describe('prepare authorization boundary', () => {
  it('rejects unsigned prepare before in-flight admission', async () => {
    const params = await makeSignedParams();
    params.prepareAuthorizationSignature = '';

    await expectAuthError(params, 'PREPARE_AUTH_SIGNATURE_INVALID');
  });

  it('rejects a signature from a different sender before in-flight admission', async () => {
    const wrongKeypair = Ed25519Keypair.generate();
    const params = await withPrepareAuthorization(
      {
        txKindBytes: await makeValidTxKindBytes(),
        senderAddress: TEST_PREPARE_AUTH_SENDER,
        paymentTokenType: '0xDEEP::deep::DEEP',
        clientIp: '127.0.0.1',
      },
      { keypair: wrongKeypair },
    );

    await expectAuthError(params, 'PREPARE_AUTH_SIGNATURE_INVALID');
  });

  it('rejects a txKindBytes hash mismatch before in-flight admission', async () => {
    const params = await makeSignedParams({
      txKindBytesHash: '0x' + 'ff'.repeat(32),
    });

    await expectAuthError(params, 'PREPARE_AUTH_TX_KIND_HASH_MISMATCH');
  });

  it('rejects an expired authorization timestamp before in-flight admission', async () => {
    const expiredTimestampMs =
      Date.now() - PREPARE_AUTHORIZATION_TTL_MS - PREPARE_AUTHORIZATION_CLOCK_SKEW_MS - 1;
    const params = await makeSignedParams({
      prepareAuthorizationTimestampMs: expiredTimestampMs,
    });

    await expectAuthError(params, 'PREPARE_AUTH_EXPIRED');
  });

  it('rejects a reused prepare request nonce before in-flight admission', async () => {
    const ctx = makeContext({ nonceClaim: 'duplicate' });
    const params = await makeSignedParams();

    await expect(handlePrepare(ctx, params, makeExtraCfg())).rejects.toMatchObject({
      code: 'PREPARE_AUTH_NONCE_REUSED',
    });
    expect(ctx.prepareInflightLimiter.tryAcquire).not.toHaveBeenCalled();
  });

  it('admits a valid authorization into the prepare state machine', async () => {
    const ctx = makeContext();
    const params = await makeSignedParams();

    await expect(handlePrepare(ctx, params, makeExtraCfg())).rejects.toBeInstanceOf(
      PrepareOverloadError,
    );
    expect(ctx.prepareInflightLimiter.tryAcquire).toHaveBeenCalledTimes(1);
  });

  it('returns ABUSE_BLOCKED only after sender authorization succeeds', async () => {
    const ctx = makeContext();
    (ctx.abuseBlocker.checkSubject as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocked: true,
      retryAfterMs: 10_000,
    });
    const params = await makeSignedParams();

    await expect(handlePrepare(ctx, params, makeExtraCfg())).rejects.toMatchObject({
      code: 'ABUSE_BLOCKED',
    });
    expect(ctx.prepareInflightLimiter.tryAcquire).not.toHaveBeenCalled();
  });
});
