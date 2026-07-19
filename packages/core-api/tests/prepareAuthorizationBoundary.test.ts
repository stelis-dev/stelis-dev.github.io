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
import type { AbuseBlockerAdapter } from '../src/store/abuseBlockTypes.js';
import {
  TEST_PREPARE_AUTH_PACKAGE_ID,
  TEST_PREPARE_AUTH_SENDER,
  withPrepareAuthorization,
} from './prepareAuthTestHelpers.js';

const CONFIG_ID = `0x${'22'.repeat(32)}`;
const REGISTRY_ID = `0x${'33'.repeat(32)}`;
const PAYOUT_ADDRESS = `0x${'44'.repeat(32)}`;
const DEEPBOOK_PACKAGE_ID = `0x${'55'.repeat(32)}`;
const POOL_ID = `0x${'66'.repeat(32)}`;
const SETTLEMENT_TOKEN_TYPE = `0x${'77'.repeat(32)}::deep::DEEP`;
const SIGNATURE_ONLY_ABUSE_BLOCKER = {
  checkIp: async () => ({ blocked: false as const }),
  checkSubject: async () => ({ blocked: false as const }),
  recordSponsorFailure: async () => undefined,
};

async function makeValidTxKindBytes(): Promise<string> {
  const tx = new Transaction();
  tx.makeMoveVec({ elements: [tx.pure.u64(42)] });
  return toBase64(await tx.build({ onlyTransactionKind: true }));
}

async function makeSignedParams(
  overrides: Partial<PrepareParams> = {},
  abuseBlocker: AbuseBlockerAdapter = SIGNATURE_ONLY_ABUSE_BLOCKER,
): Promise<PrepareParams> {
  const {
    clientIp: clientIpOverride,
    txKindBytesHash,
    prepareAuthorizationTimestampMs,
    prepareAuthorizationRequestNonce,
    prepareAuthorizationSignature,
    ...inputOverrides
  } = overrides;
  const input = {
    txKindBytes: await makeValidTxKindBytes(),
    senderAddress: TEST_PREPARE_AUTH_SENDER,
    settlementTokenType: SETTLEMENT_TOKEN_TYPE,
    ...inputOverrides,
  };
  const clientIp = clientIpOverride ?? '127.0.0.1';
  const authorization = {
    txKindBytesHash,
    prepareAuthorizationTimestampMs,
    prepareAuthorizationRequestNonce,
    prepareAuthorizationSignature,
    packageId: TEST_PREPARE_AUTH_PACKAGE_ID,
  };
  return typeof clientIp === 'string'
    ? withPrepareAuthorization({ ...input, clientIp, abuseBlocker }, authorization)
    : withPrepareAuthorization({ ...input, clientIp }, authorization);
}

function makeContext(options: { nonceClaim?: 'ok' | 'duplicate' } = {}) {
  return {
    network: 'testnet' as const,
    sui: {},
    sponsorPool: {
      checkout: vi.fn(),
      checkin: vi.fn(),
      sign: vi.fn(),
    },
    packageId: TEST_PREPARE_AUTH_PACKAGE_ID,
    configId: CONFIG_ID,
    vaultRegistryId: REGISTRY_ID,
    rateLimiter: {},
    abuseBlocker: {
      checkIp: vi.fn().mockResolvedValue({ blocked: false }),
      checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
      recordSponsorFailure: vi.fn().mockResolvedValue(undefined),
    },
    prepareRequestNonceStore: {
      claim: vi.fn().mockResolvedValue(options.nonceClaim ?? 'ok'),
    },
    settlementPayoutRecipientAddress: PAYOUT_ADDRESS,
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
          poolId: POOL_ID,
          baseType: SETTLEMENT_TOKEN_TYPE,
          quoteType: '0x2::sui::SUI',
          swapDirection: 'baseForQuote' as const,
          feeBps: 0,
        },
      ],
      settlementTokenType: SETTLEMENT_TOKEN_TYPE,
      settlementTokenSymbol: 'DEEP',
      settlementTokenDecimals: 6,
      lotSize: 1n,
      minSize: 1n,
      effectiveFeeRateBps: 0,
      settlementSwapDirection: 'baseForQuote' as const,
    },
  ];
  return {
    deepbookPackageId: DEEPBOOK_PACKAGE_ID,
    quotedHostFeeMist: 0n,
    allowedSettlementSwapPaths: [
      {
        tokenType: SETTLEMENT_TOKEN_TYPE,
        hops: [POOL_ID],
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
  const assertSponsorAvailable = vi.fn().mockResolvedValue(undefined);
  await expect(
    handlePrepare(ctx, params, makeExtraCfg(), { assertSponsorAvailable }),
  ).rejects.toMatchObject({
    code: expectedCode,
  });
  expect(assertSponsorAvailable).not.toHaveBeenCalled();
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
        settlementTokenType: SETTLEMENT_TOKEN_TYPE,
        clientIp: '127.0.0.1',
        abuseBlocker: SIGNATURE_ONLY_ABUSE_BLOCKER,
      },
      { keypair: wrongKeypair, packageId: TEST_PREPARE_AUTH_PACKAGE_ID },
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
    const params = await makeSignedParams({}, ctx.abuseBlocker);
    const assertSponsorAvailable = vi.fn().mockResolvedValue(undefined);

    await expect(
      handlePrepare(ctx, params, makeExtraCfg(), { assertSponsorAvailable }),
    ).rejects.toMatchObject({ code: 'PREPARE_AUTH_NONCE_REUSED' });
    expect(assertSponsorAvailable).not.toHaveBeenCalled();
    expect(ctx.prepareInflightLimiter.tryAcquire).not.toHaveBeenCalled();
  });

  it('admits a valid authorization into the prepare state machine', async () => {
    const ctx = makeContext();
    const params = await makeSignedParams({}, ctx.abuseBlocker);
    const assertSponsorAvailable = vi.fn().mockResolvedValue(undefined);

    await expect(
      handlePrepare(ctx, params, makeExtraCfg(), { assertSponsorAvailable }),
    ).rejects.toBeInstanceOf(PrepareOverloadError);
    expect(assertSponsorAvailable).toHaveBeenCalledTimes(1);
    expect(ctx.prepareInflightLimiter.tryAcquire).toHaveBeenCalledTimes(1);
    expect(ctx.abuseBlocker.checkIp).toHaveBeenCalledTimes(1);
    expect(ctx.abuseBlocker.checkIp).toHaveBeenCalledWith('127.0.0.1');
    expect(vi.mocked(ctx.prepareRequestNonceStore.claim).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ctx.abuseBlocker.checkSubject).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(ctx.abuseBlocker.checkSubject).mock.invocationCallOrder[0]).toBeLessThan(
      assertSponsorAvailable.mock.invocationCallOrder[0],
    );
    expect(assertSponsorAvailable.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ctx.prepareInflightLimiter.tryAcquire).mock.invocationCallOrder[0],
    );
  });

  it('returns ABUSE_BLOCKED only after sender authorization succeeds', async () => {
    const ctx = makeContext();
    (ctx.abuseBlocker.checkSubject as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocked: true,
      retryAfterMs: 10_000,
    });
    const params = await makeSignedParams({}, ctx.abuseBlocker);
    const assertSponsorAvailable = vi.fn().mockResolvedValue(undefined);

    await expect(
      handlePrepare(ctx, params, makeExtraCfg(), { assertSponsorAvailable }),
    ).rejects.toMatchObject({ code: 'ABUSE_BLOCKED' });
    expect(assertSponsorAvailable).not.toHaveBeenCalled();
    expect(ctx.prepareInflightLimiter.tryAcquire).not.toHaveBeenCalled();
  });

  it('stops before prepare domain work when sponsor-capacity admission rejects', async () => {
    const ctx = makeContext();
    const params = await makeSignedParams({}, ctx.abuseBlocker);
    const admissionError = new Error('sponsor capacity unavailable');
    const assertSponsorAvailable = vi.fn().mockRejectedValue(admissionError);

    await expect(
      handlePrepare(ctx, params, makeExtraCfg(), { assertSponsorAvailable }),
    ).rejects.toBe(admissionError);

    expect(ctx.prepareRequestNonceStore.claim).toHaveBeenCalledTimes(1);
    expect(ctx.abuseBlocker.checkIp).toHaveBeenCalledTimes(1);
    expect(ctx.abuseBlocker.checkIp).toHaveBeenCalledWith('127.0.0.1');
    expect(ctx.abuseBlocker.checkSubject).toHaveBeenCalledTimes(1);
    expect(assertSponsorAvailable).toHaveBeenCalledTimes(1);
    expect(ctx.prepareInflightLimiter.tryAcquire).not.toHaveBeenCalled();
    expect(ctx.sponsorPool.checkout).not.toHaveBeenCalled();
    expect(ctx.getConfig).not.toHaveBeenCalled();
  });
});
