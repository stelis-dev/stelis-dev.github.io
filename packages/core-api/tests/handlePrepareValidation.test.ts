/**
 * handlePrepare — built-transaction validation rejection tests.
 *
 * Tests that the prepare handler correctly rejects transactions
 * when PTB structure or settlement-argument validation fails.
 *
 * These tests mock runGenericPrepareBuildPipeline to return a REAL Transaction
 * containing forbidden or invalid commands, then verify the handler
 * reports PrepareValidationError with the correct error code.
 *
 * References:
 *   prepare.ts:211-241 (built-transaction validation try-catch block)
 *   validate/static.ts:validatePtbStructure
 *   extractSettleArgs.ts:extractSettleArgsFromBuiltTx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import type { PrepareHandlerConfig, PrepareParams } from '../src/handlers/prepare.js';
import { handlePrepare } from '../src/handlers/prepare.js';
import { PrepareValidationError } from '../src/prepare/replay.js';
import { createStaticSettlementSwapPathDescriptorMap } from '@stelis/core-relay/server';
import {
  TEST_PREPARE_AUTH_PACKAGE_ID,
  TEST_PREPARE_AUTH_SENDER,
  withPrepareAuthorization,
} from './prepareAuthTestHelpers.js';
import { suiEndpointSnapshotFixture } from './helpers/suiGatewayResultFixtures.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockPrepareBuildPipeline, mockQueryUserCredit } = vi.hoisted(() => ({
  mockPrepareBuildPipeline: vi.fn(),
  mockQueryUserCredit: vi.fn(),
}));

vi.mock('../src/prepare/build.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/prepare/build.js')>();
  return { ...original, runGenericPrepareBuildPipeline: mockPrepareBuildPipeline };
});

vi.mock('@stelis/core-relay', async (importOriginal) => {
  const original = await importOriginal<typeof import('@stelis/core-relay')>();
  return { ...original, queryUserCredit: mockQueryUserCredit };
});

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const MOCK_CREDIT = { vaultObjectId: null, credit: '0', needsCreate: true, lastNonce: '0' };
const CONFIG_ID = `0x${'22'.repeat(32)}`;
const REGISTRY_ID = `0x${'33'.repeat(32)}`;
const PAYOUT_ADDRESS = `0x${'44'.repeat(32)}`;
const SPONSOR_ADDRESS = `0x${'55'.repeat(32)}`;
const DEEPBOOK_PACKAGE_ID = `0x${'66'.repeat(32)}`;
const POOL_ID = `0x${'77'.repeat(32)}`;
const SETTLEMENT_TOKEN_TYPE = `0x${'88'.repeat(32)}::deep::DEEP`;

function makeCtx() {
  const onchainConfig = {
    packageId: TEST_PREPARE_AUTH_PACKAGE_ID,
    configId: CONFIG_ID,
    maxClaimMist: 50_000_000n,
    minSettleMist: 0n,
    maxHostFeeMist: 500_000n,
    protocolFlatFeeMist: 0n,
    configVersion: 1n,
  };
  return {
    network: 'testnet' as const,
    // The build pipeline and credit query are mocked at their current
    // boundaries in this validation-only suite. Do not invent raw Sui client
    // methods that the exercised path never calls.
    sui: suiEndpointSnapshotFixture(),
    sponsorPool: {
      checkout: vi.fn().mockResolvedValue({
        sponsorAddress: SPONSOR_ADDRESS,
      }),
      commit: vi.fn().mockResolvedValue(undefined),
      checkin: vi.fn().mockResolvedValue(undefined),
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
      claim: vi.fn().mockResolvedValue('ok'),
    },
    prepareStore: {
      store: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn(),
      peek: vi.fn(),
      evictPreparedEntry: vi.fn().mockResolvedValue(undefined),
      reserveNonce: vi.fn().mockResolvedValue(1n),
      releaseReservation: vi.fn().mockResolvedValue(undefined),
    },
    settlementPayoutRecipientAddress: PAYOUT_ADDRESS,
    allowedSettlementSwapPaths: [
      {
        tokenType: SETTLEMENT_TOKEN_TYPE,
        hops: [POOL_ID],
        settlementSwapDirection: 'baseForQuote' as const,
      },
    ],
    getConfig: vi.fn().mockResolvedValue(onchainConfig),
    prepareInflightLimiter: {
      tryAcquire: vi.fn().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) }),
      inflight: 0,
      capacity: 10,
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
    supportedSettlementSwapPaths,
    settlementSwapPathDescriptors: createStaticSettlementSwapPathDescriptorMap(
      supportedSettlementSwapPaths,
    ),
    allowedSettlementSwapPaths: [
      {
        tokenType: SETTLEMENT_TOKEN_TYPE,
        hops: [POOL_ID],
        settlementSwapDirection: 'baseForQuote' as const,
      },
    ],
    quotedHostFeeMist: 50_000n,
  };
}

async function makeValidTxKindBytes(): Promise<string> {
  const tx = new Transaction();
  tx.makeMoveVec({ elements: [tx.pure.u64(42)] });
  const kindBytes = await tx.build({ onlyTransactionKind: true });
  return toBase64(kindBytes);
}

async function makeParams(txKindBytes: string): Promise<PrepareParams> {
  return withPrepareAuthorization(
    {
      txKindBytes,
      senderAddress: TEST_PREPARE_AUTH_SENDER,
      settlementTokenType: SETTLEMENT_TOKEN_TYPE,
      clientIp: '127.0.0.1',
    },
    { packageId: TEST_PREPARE_AUTH_PACKAGE_ID },
  );
}

/**
 * Build real TX bytes containing a Publish command.
 * Uses onlyTransactionKind:false with no object refs.
 */
async function buildPublishTxBytes(): Promise<Uint8Array> {
  const tx = new Transaction();
  // Publish command — forbidden in sponsored PTBs
  tx.publish({ modules: [[0]], dependencies: ['0x1'] });
  tx.setSender('0x' + '00'.repeat(32));
  tx.setGasPrice(1000);
  tx.setGasBudget(50_000_000);
  tx.setGasOwner('0x' + '00'.repeat(32));
  // Use pure gas payment to avoid resolve
  tx.setGasPayment([
    {
      objectId: '0x' + 'aa'.repeat(32),
      version: '1',
      digest: '11111111111111111111111111111111',
    },
  ]);
  return await tx.build();
}

/**
 * Build real TX bytes with NO settle function.
 * L1 requires exactly one settle call — this should fail.
 */
async function buildNoSettleTxBytes(): Promise<Uint8Array> {
  const tx = new Transaction();
  // MakeMoveVec — valid but not a settle call
  tx.makeMoveVec({ elements: [tx.pure.u64(42)] });
  tx.setSender('0x' + '00'.repeat(32));
  tx.setGasPrice(1000);
  tx.setGasBudget(50_000_000);
  tx.setGasOwner('0x' + '00'.repeat(32));
  tx.setGasPayment([
    {
      objectId: '0x' + 'bb'.repeat(32),
      version: '1',
      digest: '11111111111111111111111111111111',
    },
  ]);
  return await tx.build();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('handlePrepare — built-transaction validation rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryUserCredit.mockResolvedValue(MOCK_CREDIT);
  });

  it('L1_PARSE_FAILED: rejects when built TX contains Publish command', async () => {
    const publishBytes = await buildPublishTxBytes();
    mockPrepareBuildPipeline.mockResolvedValue({
      txBytes: publishBytes,
      simGas: 1_300_000n,
      grossGas: 1_500_000n,
      gasVarianceFixedMist: 350_000n,
      slippageBufferMist: 150_000n,
      executionCostClaim: 1_800_000n,
      profile: 'new_user',
      paymentInputSource: 'coin_object',
      swapAmountSmallest: 500_000n,
      sponsorAddress: SPONSOR_ADDRESS,
    });

    const txKindBytes = await makeValidTxKindBytes();
    const ctx = makeCtx();

    try {
      await handlePrepare(ctx, await makeParams(txKindBytes), makeExtraCfg());
      expect.unreachable('Expected PrepareValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      // Should be an L1 error code (structure validation)
      const code = (err as PrepareValidationError).code;
      // L1 rejects: FORBIDDEN_COMMAND, NO_SETTLE, EXCESS_SETTLE, or L1_PARSE_FAILED
      expect(['L1_FORBIDDEN_COMMAND', 'L1_NO_SETTLE', 'L1_PARSE_FAILED']).toContain(code);
    }
  });

  it('L1: rejects when built TX has no settle function', async () => {
    const noSettleBytes = await buildNoSettleTxBytes();
    mockPrepareBuildPipeline.mockResolvedValue({
      txBytes: noSettleBytes,
      simGas: 1_300_000n,
      grossGas: 1_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 1_800_000n,
      quotedHostFee: 50_000n,
      protocolFee: 10_000n,
      profile: 'new_user',
      paymentInputSource: 'coin_object',
      swapAmountSmallest: 500_000n,
      sponsorAddress: SPONSOR_ADDRESS,
    });

    const txKindBytes = await makeValidTxKindBytes();
    const ctx = makeCtx();

    try {
      await handlePrepare(ctx, await makeParams(txKindBytes), makeExtraCfg());
      expect.unreachable('Expected PrepareValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(PrepareValidationError);
      const code = (err as PrepareValidationError).code;
      expect(['L1_NO_SETTLE', 'L1_PARSE_FAILED']).toContain(code);
    }
  });

  it('slot is released when built-transaction validation fails', async () => {
    const noSettleBytes = await buildNoSettleTxBytes();
    mockPrepareBuildPipeline.mockResolvedValue({
      txBytes: noSettleBytes,
      simGas: 1_300_000n,
      grossGas: 1_500_000n,
      gasVarianceFixedMist: 100_000n,
      slippageBufferMist: 0n,
      executionCostClaim: 1_800_000n,
      quotedHostFee: 50_000n,
      protocolFee: 10_000n,
      profile: 'new_user',
      paymentInputSource: 'coin_object',
      swapAmountSmallest: 500_000n,
      sponsorAddress: SPONSOR_ADDRESS,
    });

    const txKindBytes = await makeValidTxKindBytes();
    const ctx = makeCtx();

    await handlePrepare(ctx, await makeParams(txKindBytes), makeExtraCfg()).catch(() => {});

    // Slot must be released even on built-transaction validation failure. checkin is called with
    // `(sponsorAddress, receiptId)` where receiptId is the generated lease
    // authenticator; assert on its shape.
    expect(ctx.sponsorPool.checkin).toHaveBeenCalledTimes(1);
    const checkinArgs = (ctx.sponsorPool.checkin as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(checkinArgs[0]).toBe(SPONSOR_ADDRESS);
    expect(checkinArgs[1]).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
