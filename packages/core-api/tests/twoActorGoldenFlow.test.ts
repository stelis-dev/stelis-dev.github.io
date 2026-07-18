/**
 * twoActorGoldenFlow.test.ts — cross-request golden-flow harness.
 *
 * Locks the prepare → user-signature → sponsor protocol over the generic
 * and Studio handlers.
 *
 * Cross-request binding under test:
 *   1. handlePrepare / handlePromotionPrepare persists `txBytesHash` =
 *      the prepare runner's validated bytes and hash into a real receipt lifecycle store.
 *   2. The user (Actor 2) signs the `txBytes` returned by /prepare.
 *   3. handleSponsor / handlePromotionSponsor reads the same receiptId from
 *      the SAME store, validates sha256(submittedTxBytes), then atomically
 *      changes the exact prepared record to executing before signing.
 *
 * Failure rows held by this harness:
 *   - Tampered txBytes — Actor 2 swaps in a second valid signed tx with
 *     the same sender / gas-owner identity but different bytes. The
 *     pre-execution hash validation fires and both routes classify the result
 *     as `TAMPERING_DETECTED` without destroying the legitimate receipt.
 *   - Replayed receiptId — second sponsor call after a successful execution
 *     sees the prepared entry gone and rejects with
 *     `PREPARED_TX_NOT_FOUND`.
 *   - Malformed user signature — `verifySenderSignature` throws and the
 *     handler classifies as `SENDER_SIGNATURE_INVALID`.
 *
 * NB: PROMO_DUPLICATE_CLAIM is NOT a sponsor state-machine failure. It
 * lives in the claim path, not /prepare or /sponsor, and is therefore
 * intentionally excluded from this harness.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { bcs } from '@mysten/sui/bcs';
import { toBase64, toBase58 } from '@mysten/sui/utils';
import type { ChainBoundSuiEndpointSnapshot } from '@stelis/core-relay';
import { GAS_VARIANCE_FIXED_MIST } from '@stelis/core-relay';
import {
  SETTLE_WITH_CREDIT_FUNCTION,
  SLIPPAGE_CAP_BPS,
  SUI_CHAIN_IDENTIFIERS,
} from '@stelis/contracts';
import type {
  AddressBalanceGasTransaction,
  buildAddressBalanceGasTransaction,
} from '@stelis/core-relay/server';
import { canonicalizePromotionTarget } from '../src/studio/promotionTargetPolicy.js';

type BuildAddressBalanceGasTransactionOptions = Parameters<
  typeof buildAddressBalanceGasTransaction
>[1];

// ─────────────────────────────────────────────
// Module mocks (vi.hoisted ensures availability in factories)
// ─────────────────────────────────────────────

const {
  mockQueryUserCredit,
  mockPrepareBuildPipeline,
  mockSponsorPreflightSimulation,
  mockExecuteSuiTransaction,
  addressBalanceGasTransactionContents,
  mockBuildAddressBalanceGasTransaction,
  mockGetAddressBalanceGasTransactionBytes,
  mockGetAddressBalanceGasTransactionTxBytesHash,
  mockSimulateAddressBalanceGasTransaction,
} = vi.hoisted(() => ({
  mockQueryUserCredit: vi.fn(),
  mockPrepareBuildPipeline: vi.fn(),
  mockSponsorPreflightSimulation: vi.fn(),
  mockExecuteSuiTransaction: vi.fn(),
  addressBalanceGasTransactionContents: new WeakMap<
    object,
    {
      readonly bytes: Uint8Array;
      readonly txBytesHash: string;
      readonly snapshot: ChainBoundSuiEndpointSnapshot;
    }
  >(),
  mockBuildAddressBalanceGasTransaction: vi.fn(),
  mockGetAddressBalanceGasTransactionBytes: vi.fn(),
  mockGetAddressBalanceGasTransactionTxBytesHash: vi.fn(),
  mockSimulateAddressBalanceGasTransaction: vi.fn(),
}));

vi.mock('@stelis/core-relay', async (importOriginal) => {
  const original = await importOriginal<typeof import('@stelis/core-relay')>();
  return {
    ...original,
    queryUserCredit: mockQueryUserCredit,
    simulateSuiTransaction: mockSponsorPreflightSimulation,
    executeSuiTransaction: mockExecuteSuiTransaction,
  };
});

vi.mock('@stelis/core-relay/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@stelis/core-relay/server')>();
  return {
    ...original,
    buildAddressBalanceGasTransaction: mockBuildAddressBalanceGasTransaction,
    getAddressBalanceGasTransactionBytes: mockGetAddressBalanceGasTransactionBytes,
    getAddressBalanceGasTransactionTxBytesHash: mockGetAddressBalanceGasTransactionTxBytesHash,
    simulateAddressBalanceGasTransaction: mockSimulateAddressBalanceGasTransaction,
  };
});

vi.mock('../src/prepare/build.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/prepare/build.js')>();
  return { ...original, runGenericPrepareBuildPipeline: mockPrepareBuildPipeline };
});

// extractSettleArgsFromBuiltTx is replaced per test (see beforeEach below).
// The underlying real bytes are still consumed by /sponsor's parseSettleArgs
// path, so the mocked extraction here only governs /prepare-side L2 +
// payment-input integrity.
vi.mock('../src/prepare/extractSettleArgs.js');

// ─────────────────────────────────────────────
// Imports under test (loaded after vi.mock so factories register)
// ─────────────────────────────────────────────

import { handlePrepare, type PrepareHandlerConfig } from '../src/handlers/prepare.js';
import { PREPARE_TTL_MS } from '../src/preparePolicy.js';
import { handleSponsor, SponsorValidationError } from '../src/handlers/sponsor.js';
import { computePolicyHash } from '../src/policyHash.js';
import { extractSettleArgsFromBuiltTx } from '../src/prepare/extractSettleArgs.js';
import { MemorySponsoredExecutionStore } from '../src/store/memorySponsoredExecutionStore.js';
import { MemoryPrepareInflight } from '../src/store/memoryPrepareInflight.js';
import { MemoryAbuseBlocker } from '../src/store/memoryAbuseBlocker.js';
import { SponsorPool } from '../src/context.js';
import type { HostContext } from '../src/context.js';
import { createStaticSettlementSwapPathDescriptorMap } from '@stelis/core-relay/server';
import {
  handlePromotionPrepare,
  type PromotionPrepareContext,
} from '../src/studio/preparePromotionSponsoredHandler.js';
import {
  handlePromotionSponsor,
  PromotionSponsorError,
  type PromotionSponsorContext,
} from '../src/studio/sponsorPromotionSponsoredHandler.js';
import { MemoryPromotionStore } from '../src/studio/promotionStore.js';
import { MemoryPromotionExecutionLedger } from '../src/studio/executionLedgerMemory.js';
import type { VerifiedDeveloperIdentity } from '../src/studio/developerJwtVerifier.js';
import { withPrepareAuthorization } from './prepareAuthTestHelpers.js';
import {
  addressBalanceGasTransactionBytesFixture,
  bindSuiResultToTransactionBytes,
  suiEndpointSnapshotFixture,
  suiExecutionSuccess,
  suiSimulationSuccess,
  TEST_SUI_TRANSACTION_DIGEST,
  type TestGasUsed,
} from './helpers/suiGatewayResultFixtures.js';

const gatewayGasUsed = new WeakMap<object, TestGasUsed>();

function gasUsedFor(snapshot: ChainBoundSuiEndpointSnapshot): TestGasUsed {
  const gasUsed = gatewayGasUsed.get(snapshot);
  if (!gasUsed) throw new Error('Missing gateway gas fixture');
  return gasUsed;
}

mockExecuteSuiTransaction.mockImplementation(
  async (snapshot: ChainBoundSuiEndpointSnapshot, input: { transaction: Uint8Array }) =>
    bindSuiResultToTransactionBytes(
      suiExecutionSuccess(TEST_SUI_TRANSACTION_DIGEST, gasUsedFor(snapshot)),
      input.transaction,
    ),
);

mockSponsorPreflightSimulation.mockImplementation(
  async (snapshot: ChainBoundSuiEndpointSnapshot, _input: { transaction: Uint8Array }) =>
    suiSimulationSuccess(gasUsedFor(snapshot)),
);

function registerAddressBalanceGasTransaction(
  bytes: Uint8Array,
  snapshot: ChainBoundSuiEndpointSnapshot,
): AddressBalanceGasTransaction {
  const token = Object.freeze({}) as AddressBalanceGasTransaction;
  addressBalanceGasTransactionContents.set(token, {
    bytes: bytes.slice(),
    txBytesHash: createHash('sha256').update(bytes).digest('hex'),
    snapshot,
  });
  return token;
}

function requireAddressBalanceGasTransaction(transaction: AddressBalanceGasTransaction) {
  const contents = addressBalanceGasTransactionContents.get(transaction);
  if (!contents) throw new TypeError('Unknown address-balance gas transaction test token');
  return contents;
}

mockBuildAddressBalanceGasTransaction.mockImplementation(
  async (
    snapshot: ChainBoundSuiEndpointSnapshot,
    options: BuildAddressBalanceGasTransactionOptions,
  ) => {
    const source = options.transaction.getData();
    expect(source.sender).not.toBeNull();
    expect(source.gasData.owner).toBeNull();
    expect(source.gasData.price).toBeNull();
    expect(source.gasData.budget).toBeNull();
    expect(source.gasData.payment).toBeNull();
    expect(source.expiration).toBeNull();

    const bytes = await addressBalanceGasTransactionBytesFixture({
      transaction: options.transaction,
      sponsorAddress: options.sponsorAddress,
      gasBudget: options.gasBudget,
      gasPrice: 1_000n,
      chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet,
    });
    return registerAddressBalanceGasTransaction(bytes, snapshot);
  },
);

mockSimulateAddressBalanceGasTransaction.mockImplementation(
  async (transaction: AddressBalanceGasTransaction) =>
    suiSimulationSuccess(gasUsedFor(requireAddressBalanceGasTransaction(transaction).snapshot)),
);

mockGetAddressBalanceGasTransactionBytes.mockImplementation(
  (transaction: AddressBalanceGasTransaction) =>
    requireAddressBalanceGasTransaction(transaction).bytes.slice(),
);

mockGetAddressBalanceGasTransactionTxBytesHash.mockImplementation(
  (transaction: AddressBalanceGasTransaction) =>
    requireAddressBalanceGasTransaction(transaction).txBytesHash,
);

function gatewaySnapshot(gasUsed: TestGasUsed): ChainBoundSuiEndpointSnapshot {
  const snapshot = suiEndpointSnapshotFixture();
  gatewayGasUsed.set(snapshot, gasUsed);
  return snapshot;
}

// ─────────────────────────────────────────────
// Shared identities + secrets
// ─────────────────────────────────────────────

const USER_KP = Ed25519Keypair.generate();
const USER_ADDR = USER_KP.toSuiAddress();
const SPONSOR_KP = Ed25519Keypair.generate();
const SPONSOR_ADDR = SPONSOR_KP.toSuiAddress();
const TEST_HMAC_SECRET = 'two-actor-golden-flow-hmac-secret-000';
const CLIENT_IP = '127.0.0.1';

// ─────────────────────────────────────────────
// Section 1 — Generic /relay/prepare → /relay/sponsor harness
// ─────────────────────────────────────────────

// MOCK_CONFIG must be byte-identical between handlePrepare's getConfig() and
// handleSponsor's getConfig() so policyHash + L2 fee/version checks stay
// coherent across the two requests.
const GENERIC_MOCK_CONFIG = {
  packageId: '0x' + '11'.repeat(32),
  configId: '0x' + '22'.repeat(32),
  vaultRegistryId: '0x' + '33'.repeat(32),
  settlementPayoutRecipientAddress: '0x' + 'ff'.repeat(32),
  maxClaimMist: 50_000_000n,
  minSettleMist: 1_000_000n,
  maxHostFeeMist: 100_000n,
  protocolFlatFeeMist: 50_000n,
  configVersion: 1n,
  maxSpreadBps: 500n,
} as const;

const GENERIC_QUOTED_HOST_FEE = GENERIC_MOCK_CONFIG.maxHostFeeMist;

/**
 * Build a real, BCS-valid credit-only settlement transaction that pays gas
 * from the sponsor address balance. The caller picks the policyHash variant
 * and validity nonce so the same builder produces both the "prepared" tx and
 * a deterministically-different "tampered" tx.
 */
async function buildCreditTx(opts: {
  policyHashHex: string;
  /** Changing the u32 validity nonce changes the BCS bytes while preserving
   * the sender, sponsor, gas source, and settlement arguments. */
  validityNonce: number;
  /** Optional override for `nonce` settle arg — used to vary the tampered
   * variant against the prepared one if needed. */
  nonce?: bigint;
  quoteTimestampMs: number;
}): Promise<{ txBytes: Uint8Array; txBytesHash: string }> {
  const tx = new Transaction();
  tx.setSender(USER_ADDR);
  tx.setGasOwner(SPONSOR_ADDR);
  tx.setGasBudget(5_000_000n);
  tx.setGasPrice(1000);
  tx.setGasPayment([]);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: '1',
      maxEpoch: '2',
      minTimestamp: null,
      maxTimestamp: null,
      chain: SUI_CHAIN_IDENTIFIERS.testnet,
      nonce: opts.validityNonce,
    },
  });

  const digestBytes = new Uint8Array(32).fill(0x01);

  const objRef = (id: string) =>
    tx.objectRef({ objectId: id, version: '1', digest: toBase58(digestBytes) });

  const policyHashBytes = Buffer.from(opts.policyHashHex.replace('0x', ''), 'hex');

  // Argument layout matches the credit-only Move entrypoint and the canonical
  // `ARG_INDEX_MAP` in @stelis/core-relay.
  tx.moveCall({
    target: `${GENERIC_MOCK_CONFIG.packageId}::settle::${SETTLE_WITH_CREDIT_FUNCTION}`,
    arguments: [
      objRef(GENERIC_MOCK_CONFIG.configId), // 0: config
      objRef(GENERIC_MOCK_CONFIG.vaultRegistryId), // 1: registry
      objRef('0x6'), // 2: clock
      objRef('0x' + '04'.repeat(32)), // 3: vault
      tx.pure(bcs.u64().serialize(1_000n)), // 4: useCreditAmount
      tx.pure(bcs.u64().serialize(5_250_000n)), // 5: executionCostClaim
      tx.pure(bcs.Address.serialize(GENERIC_MOCK_CONFIG.settlementPayoutRecipientAddress)), // 6: settlementPayoutRecipient
      tx.pure(bcs.vector(bcs.u8()).serialize([])), // 7: receiptId (empty for fixture)
      tx.pure(bcs.u64().serialize(opts.nonce ?? 1n)), // 8: nonce
      tx.pure(bcs.u64().serialize(5_000_000n)), // 9: simGasReported
      tx.pure(bcs.u64().serialize(GAS_VARIANCE_FIXED_MIST)), // 10: gasVarianceFixedMist
      tx.pure(bcs.u64().serialize(0n)), // 11: slippageBufferMist
      tx.pure(bcs.u64().serialize(GENERIC_MOCK_CONFIG.maxHostFeeMist)), // 12: quotedHostFeeMist
      tx.pure(bcs.u64().serialize(GENERIC_MOCK_CONFIG.protocolFlatFeeMist)), // 13: expectedProtocolFeeMist
      tx.pure(bcs.u64().serialize(GENERIC_MOCK_CONFIG.configVersion)), // 14: expectedConfigVersion
      tx.pure(bcs.u64().serialize(BigInt(opts.quoteTimestampMs))), // 15: quoteTimestampMs
      tx.pure(bcs.vector(bcs.u8()).serialize([...policyHashBytes])), // 16: policyHash
      tx.pure(bcs.vector(bcs.u8()).serialize([])), // 17: orderIdHash (empty)
    ],
    typeArguments: [],
  });

  const txBytes = await tx.build({ onlyTransactionKind: false });
  const txBytesHash = createHash('sha256').update(txBytes).digest('hex');
  return { txBytes, txBytesHash };
}

/**
 * Build an empty, valid TransactionKind for the user-side input to
 * /prepare. The fixture's mocked `runGenericPrepareBuildPipeline` ignores the contents of
 * this kind because it returns a pre-built sponsor-side TX, but the
 * handler's P0/P1 still require a parseable kind.
 */
async function makeEmptyUserTxKindBytes(): Promise<string> {
  const tx = new Transaction();
  tx.makeMoveVec({ elements: [tx.pure.u64(42)] });
  const kindBytes = await tx.build({ onlyTransactionKind: true });
  return toBase64(kindBytes);
}

function genericMockSui(): ChainBoundSuiEndpointSnapshot {
  const gasUsed = {
    computationCost: '3000000',
    storageCost: '2000000',
    storageRebate: '500000',
  };
  return gatewaySnapshot(gasUsed);
}

interface GenericHarness {
  ctx: HostContext;
  sponsoredExecutionStore: MemorySponsoredExecutionStore;
  sponsorPool: SponsorPool;
  abuseBlocker: MemoryAbuseBlocker;
  prepareInflight: MemoryPrepareInflight;
  extraCfg: PrepareHandlerConfig;
}

function makeGenericHarness(): GenericHarness {
  const sponsorPool = new SponsorPool([SPONSOR_KP], { hmacSecret: TEST_HMAC_SECRET });
  const sponsoredExecutionStore = new MemorySponsoredExecutionStore(sponsorPool, undefined);
  const abuseBlocker = new MemoryAbuseBlocker();
  const prepareInflight = new MemoryPrepareInflight(8);
  const sui = genericMockSui();

  const supportedSettlementSwapPaths = [
    {
      hops: [
        {
          poolId: '0x' + 'aa'.repeat(32),
          baseType: '0x' + 'de'.repeat(32) + '::deep::DEEP',
          quoteType: '0x2::sui::SUI',
          swapDirection: 'baseForQuote' as const,
          feeBps: 0,
        },
      ],
      settlementTokenType: '0x' + 'de'.repeat(32) + '::deep::DEEP',
      settlementTokenSymbol: 'DEEP',
      settlementTokenDecimals: 6,
      lotSize: 1n,
      minSize: 1n,
      effectiveFeeRateBps: 0,
      settlementSwapDirection: 'baseForQuote' as const,
    },
  ];
  const extraCfg: PrepareHandlerConfig = {
    deepbookPackageId: '0x' + 'bb'.repeat(32),
    supportedSettlementSwapPaths,
    settlementSwapPathDescriptors: createStaticSettlementSwapPathDescriptorMap(
      supportedSettlementSwapPaths,
    ),
    allowedSettlementSwapPaths: [],
    quotedHostFeeMist: GENERIC_QUOTED_HOST_FEE,
  };

  const ctx: HostContext = {
    network: 'testnet',
    sui,
    sponsorPool,
    packageId: GENERIC_MOCK_CONFIG.packageId,
    configId: GENERIC_MOCK_CONFIG.configId,
    vaultRegistryId: GENERIC_MOCK_CONFIG.vaultRegistryId,
    vaultsTableId: '0x' + '34'.repeat(32),
    deepbookPackageId: extraCfg.deepbookPackageId,
    rateLimiter: {} as HostContext['rateLimiter'],
    abuseBlocker,
    sponsoredExecutionStore,
    prepareRequestNonceStore: {
      claim: vi.fn().mockResolvedValue('ok'),
    },
    prepareInflightLimiter: prepareInflight,
    settlementPayoutRecipientAddress: GENERIC_MOCK_CONFIG.settlementPayoutRecipientAddress,
    allowedSettlementSwapPaths: [],
    getConfig: vi.fn().mockResolvedValue({
      packageId: GENERIC_MOCK_CONFIG.packageId,
      configId: GENERIC_MOCK_CONFIG.configId,
      maxClaimMist: GENERIC_MOCK_CONFIG.maxClaimMist,
      minSettleMist: GENERIC_MOCK_CONFIG.minSettleMist,
      maxHostFeeMist: GENERIC_MOCK_CONFIG.maxHostFeeMist,
      protocolFlatFeeMist: GENERIC_MOCK_CONFIG.protocolFlatFeeMist,
      configVersion: GENERIC_MOCK_CONFIG.configVersion,
      maxSpreadBps: GENERIC_MOCK_CONFIG.maxSpreadBps,
    }),
    invalidateConfigCache: vi.fn(),
    dispose: vi.fn(),
    onSponsorResult: vi.fn().mockResolvedValue(undefined),
    isSponsorAddressAvailable: async () => true,
  };

  return {
    ctx,
    sponsoredExecutionStore,
    sponsorPool,
    abuseBlocker,
    prepareInflight,
    extraCfg,
  };
}

/**
 * Drive a successful /prepare for the generic credit-only path.
 * Returns the prepared response + the underlying real txBytes that
 * `runGenericPrepareBuildPipeline` was made to produce, so the test can sign and submit
 * them through /sponsor.
 */
async function drivePrepare(harness: GenericHarness): Promise<{
  response: Awaited<ReturnType<typeof handlePrepare>>;
  txBytes: Uint8Array;
  txBytesHash: string;
}> {
  const policyHashHex = computePolicyHash({
    maxClaimMist: GENERIC_MOCK_CONFIG.maxClaimMist,
    maxHostFeeMist: GENERIC_MOCK_CONFIG.maxHostFeeMist,
    protocolFeeMist: GENERIC_MOCK_CONFIG.protocolFlatFeeMist,
    quoteTtlMs: PREPARE_TTL_MS,
    gasVarianceFixedMist: GAS_VARIANCE_FIXED_MIST,
    slippageCapBps: SLIPPAGE_CAP_BPS,
  });
  const policyHashBytes = Uint8Array.from(Buffer.from(policyHashHex.replace('0x', ''), 'hex'));

  const quoteTimestampMs = Date.now();
  const built = await buildCreditTx({
    policyHashHex,
    validityNonce: 1,
    quoteTimestampMs,
  });

  const addressBalanceGasTransaction = registerAddressBalanceGasTransaction(
    built.txBytes,
    harness.ctx.sui,
  );
  const settleArgs = {
    configObjectId: GENERIC_MOCK_CONFIG.configId,
    registryObjectId: GENERIC_MOCK_CONFIG.vaultRegistryId,
    settlementPayoutRecipient: GENERIC_MOCK_CONFIG.settlementPayoutRecipientAddress,
    executionCostClaim: 5_250_000n,
    policyHash: policyHashBytes,
    orderIdHash: new Uint8Array(0),
    quotedHostFeeMist: GENERIC_QUOTED_HOST_FEE,
    expectedProtocolFeeMist: GENERIC_MOCK_CONFIG.protocolFlatFeeMist,
    expectedConfigVersion: GENERIC_MOCK_CONFIG.configVersion,
    nonce: 1n,
    receiptId: new Uint8Array(0),
    simGasReported: 5_000_000n,
    gasVarianceFixedMist: GAS_VARIANCE_FIXED_MIST,
    slippageBufferMist: 0n,
    quoteTimestampMs: BigInt(quoteTimestampMs),
    paymentInputTrace: {
      settleVariantClass: 'credit' as const,
      source: 'none_credit_only' as const,
      paymentCoinRefKind: 'none' as const,
    },
  };

  mockPrepareBuildPipeline.mockResolvedValueOnce({
    addressBalanceGasTransaction,
    l1Validation: { ok: true },
    settleArgs,
    executionCostClaim: 5_250_000n,
    simGas: 5_000_000n,
    gasVarianceFixedMist: GAS_VARIANCE_FIXED_MIST,
    slippageBufferMist: 0n,
    grossGas: 5_000_000n,
    profile: 'credit_general' as const,
    paymentInputSource: 'none_credit_only' as const,
    swapAmountSmallest: 0n,
  });

  // Sticky mock — the sponsor side also re-extracts args from the same
  // stored-hash-verified bytes via `revalidateGenericSponsorPolicy`. Both requests
  // must observe the identical canonical settle args.
  vi.mocked(extractSettleArgsFromBuiltTx).mockReturnValue(settleArgs);

  const response = await handlePrepare(
    harness.ctx,
    await withPrepareAuthorization(
      {
        txKindBytes: await makeEmptyUserTxKindBytes(),
        senderAddress: USER_ADDR,
        settlementTokenType: '0x' + 'de'.repeat(32) + '::deep::DEEP',
        clientIp: CLIENT_IP,
      },
      { keypair: USER_KP, packageId: GENERIC_MOCK_CONFIG.packageId },
    ),
    harness.extraCfg,
  );

  return { response, txBytes: built.txBytes, txBytesHash: built.txBytesHash };
}

describe('generic two-actor golden flow (handlePrepare → user sign → handleSponsor)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryUserCredit.mockResolvedValue({
      vaultObjectId: '0x' + 'fa'.repeat(32),
      credit: '50000000',
      needsCreate: false,
      lastNonce: '0',
    });
  });

  test('happy path: prepare commits hash → user signs → sponsor executes successfully', async () => {
    const harness = makeGenericHarness();
    const { response, txBytes, txBytesHash } = await drivePrepare(harness);

    // Cross-request binding check #1: the receipt lifecycle store now holds an entry
    // keyed by the prepare-issued receiptId, with txBytesHash = sha256(txBytes).
    const peeked = await harness.sponsoredExecutionStore.readPreparedReceipt(response.receiptId);
    expect(peeked).not.toBeNull();
    expect(peeked!.txBytesHash).toBe(txBytesHash);
    expect(peeked!.senderAddress).toBe(USER_ADDR);
    expect(peeked!.sponsorAddress).toBe(SPONSOR_ADDR);

    // Actor 2 (user) signs the prepare-issued bytes.
    const userSig = (await USER_KP.signTransaction(txBytes)).signature;

    const sponsorResult = await handleSponsor(
      harness.ctx,
      { txBytes: response.txBytes, userSignature: userSig, receiptId: response.receiptId },
      CLIENT_IP,
    );

    expect(sponsorResult.digest).toBe(TransactionDataBuilder.getDigestFromBytes(txBytes));

    // Cross-request binding check #2: the atomic execution transition ran and
    // the prepared entry is gone (single-use receipt).
    expect(
      await harness.sponsoredExecutionStore.readPreparedReceipt(response.receiptId),
    ).toBeNull();
  });

  test('tamper: prepare commits tx A; sponsor receives tx B → TAMPERING_DETECTED before execution', async () => {
    const harness = makeGenericHarness();
    const { response, txBytesHash: hashA } = await drivePrepare(harness);

    // Build a second valid signed tx with the SAME sender / gas-owner
    // identity but different bytes — changing the validity nonce changes
    // the BCS encoding without changing the address-balance gas source.
    const policyHashHex = computePolicyHash({
      maxClaimMist: GENERIC_MOCK_CONFIG.maxClaimMist,
      maxHostFeeMist: GENERIC_MOCK_CONFIG.maxHostFeeMist,
      protocolFeeMist: GENERIC_MOCK_CONFIG.protocolFlatFeeMist,
      quoteTtlMs: PREPARE_TTL_MS,
      gasVarianceFixedMist: GAS_VARIANCE_FIXED_MIST,
      slippageCapBps: SLIPPAGE_CAP_BPS,
    });
    const tampered = await buildCreditTx({
      policyHashHex,
      validityNonce: 2,
      quoteTimestampMs: Date.now() + 1,
    });
    expect(tampered.txBytesHash).not.toBe(hashA);

    const userSigB = (await USER_KP.signTransaction(tampered.txBytes)).signature;

    const err = await handleSponsor(
      harness.ctx,
      {
        txBytes: toBase64(tampered.txBytes),
        userSignature: userSigB,
        receiptId: response.receiptId,
      },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorValidationError);
    expect((err as SponsorValidationError).code).toBe('TAMPERING_DETECTED');

    // Hash mismatch is rejected before the atomic prepared-to-executing
    // transition, so the legitimate signer can still use the receipt.
    expect(
      await harness.sponsoredExecutionStore.readPreparedReceipt(response.receiptId),
    ).not.toBeNull();
  });

  test('replay: same receipt sponsored twice → second call rejects with PREPARED_TX_NOT_FOUND', async () => {
    const harness = makeGenericHarness();
    const { response, txBytes } = await drivePrepare(harness);
    const userSig = (await USER_KP.signTransaction(txBytes)).signature;

    const first = await handleSponsor(
      harness.ctx,
      { txBytes: response.txBytes, userSignature: userSig, receiptId: response.receiptId },
      CLIENT_IP,
    );
    expect(first.digest).toBe(TransactionDataBuilder.getDigestFromBytes(txBytes));

    const replay = await handleSponsor(
      harness.ctx,
      { txBytes: response.txBytes, userSignature: userSig, receiptId: response.receiptId },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(replay).toBeInstanceOf(SponsorValidationError);
    expect((replay as SponsorValidationError).code).toBe('PREPARED_TX_NOT_FOUND');
  });

  test('malformed signature: sponsor classifies as SENDER_SIGNATURE_INVALID', async () => {
    const harness = makeGenericHarness();
    const { response } = await drivePrepare(harness);

    // Sign with a different keypair so the signature is cryptographically
    // valid but does not match the canonical tx.sender encoded in the bytes.
    const wrongKp = Ed25519Keypair.generate();
    const txBytesRaw = Uint8Array.from(Buffer.from(response.txBytes, 'base64'));
    const wrongSig = (await wrongKp.signTransaction(txBytesRaw)).signature;

    const err = await handleSponsor(
      harness.ctx,
      { txBytes: response.txBytes, userSignature: wrongSig, receiptId: response.receiptId },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorValidationError);
    expect((err as SponsorValidationError).code).toBe('SENDER_SIGNATURE_INVALID');

    // A rejection before the execution transition preserves the entry — the
    // legitimate caller can still execute it without another prepare request.
    const stillPeeked = await harness.sponsoredExecutionStore.readPreparedReceipt(
      response.receiptId,
    );
    expect(stillPeeked).not.toBeNull();
  });
});

// ─────────────────────────────────────────────
// Section 2 — Studio /studio/promotions/:id/{prepare,sponsor} harness
// ─────────────────────────────────────────────

const STUDIO_USER_ID = 'studio-user-1';
const STUDIO_ALLOWED_TARGET =
  '0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin';
const STUDIO_GLOBAL_ALLOWED_TARGETS = new Set([canonicalizePromotionTarget(STUDIO_ALLOWED_TARGET)]);

/**
 * Build one endpoint snapshot for the Studio prepare path. Transaction
 * construction, simulation, and execution are mocked at their current shared
 * gateway boundaries.
 */
function studioMockSui(): ChainBoundSuiEndpointSnapshot {
  const gasUsed = {
    computationCost: '1000000',
    storageCost: '500000',
    storageRebate: '200000',
  };
  return gatewaySnapshot(gasUsed);
}

interface StudioHarness {
  prepareCtx: PromotionPrepareContext;
  sponsorCtx: PromotionSponsorContext;
  sponsoredExecutionStore: MemorySponsoredExecutionStore;
  sponsorPool: SponsorPool;
  abuseBlocker: MemoryAbuseBlocker;
  executionLedger: MemoryPromotionExecutionLedger;
  promoId: string;
  identity: VerifiedDeveloperIdentity;
}

async function makeStudioHarness(): Promise<StudioHarness> {
  const promotionStore = new MemoryPromotionStore();
  const executionLedger = new MemoryPromotionExecutionLedger(promotionStore);
  const sponsorPool = new SponsorPool([SPONSOR_KP], { hmacSecret: TEST_HMAC_SECRET });
  const sponsoredExecutionStore = new MemorySponsoredExecutionStore(sponsorPool, executionLedger);
  const abuseBlocker = new MemoryAbuseBlocker();
  const prepareInflight = new MemoryPrepareInflight(8);

  const promoRecord = await promotionStore.create({
    type: 'gas_sponsorship',
    displayName: 'Studio Golden Flow',
    description: 'two-actor harness',
    maxParticipants: 16,
    perUserGasAllowanceMist: '100000000',
    claimDeadlineAt: null,
    postClaimUseWindowMs: 0,
    startAt: null,
  });
  const promoId = promoRecord.promotionId;
  await promotionStore.transitionStatus(promoId, 'active');
  await executionLedger.claim(promoId, STUDIO_USER_ID, {
    useUntilAt: null,
  });

  const sui = studioMockSui();

  const prepareCtx: PromotionPrepareContext = {
    sui,
    promotionStore,
    executionLedger,
    sponsorPool,
    sponsoredExecutionStore,
    prepareInflightLimiter: prepareInflight,
    getConfig: async () => ({
      maxClaimMist: 50_000_000_000n,
      minSettleMist: 0n,
      maxHostFeeMist: 0n,
      protocolFlatFeeMist: 0n,
      configVersion: 1n,
      maxSpreadBps: 500n,
      packageId: '0x0',
      configId: '0x0',
    }),
    globalAllowedTargets: STUDIO_GLOBAL_ALLOWED_TARGETS,
  };

  const sponsorCtx: PromotionSponsorContext = {
    sui,
    packageId: '0xabc',
    deepbookPackageId: '0xabc',
    promotionStore,
    executionLedger,
    sponsorPool,
    sponsoredExecutionStore,
    abuseBlocker,
    globalAllowedTargets: STUDIO_GLOBAL_ALLOWED_TARGETS,
    onSponsorResult: vi.fn().mockResolvedValue(undefined),
    isSponsorAddressAvailable: async () => true,
  };

  return {
    prepareCtx,
    sponsorCtx,
    sponsoredExecutionStore,
    sponsorPool,
    abuseBlocker,
    executionLedger,
    promoId,
    identity: { userId: STUDIO_USER_ID, senderAddress: USER_ADDR },
  };
}

async function makeAllowedStudioTxKindBytes(): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({ target: STUDIO_ALLOWED_TARGET as `${string}::${string}::${string}` });
  const kindBytes = await tx.build({ onlyTransactionKind: true });
  return toBase64(kindBytes);
}

/**
 * Build a tampered Studio TX for sponsor processing. The user's
 * verified identity (sender + JWT userId) and the sponsor's gas-owner
 * remain unchanged; only the bytes differ. We forge a gas budget and
 * validity nonce that the prepare path would never have produced.
 */
async function buildStudioTamperedTx(): Promise<{
  txBytes: Uint8Array;
  txBytesHash: string;
}> {
  const tx = new Transaction();
  tx.moveCall({ target: STUDIO_ALLOWED_TARGET as `${string}::${string}::${string}` });
  tx.setSender(USER_ADDR);
  tx.setGasOwner(SPONSOR_ADDR);
  tx.setGasBudget(7_500_000n); // distinct from the prepare-set budget
  tx.setGasPrice(1000);
  tx.setGasPayment([]);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: '1',
      maxEpoch: '2',
      minTimestamp: null,
      maxTimestamp: null,
      chain: SUI_CHAIN_IDENTIFIERS.testnet,
      nonce: 42,
    },
  });
  const txBytes = await tx.build();
  const txBytesHash = createHash('sha256').update(txBytes).digest('hex');
  return { txBytes, txBytesHash };
}

describe('Studio two-actor golden flow (handlePromotionPrepare → user sign → handlePromotionSponsor)', () => {
  test('happy path: prepare commits hash → user signs → sponsor executes successfully', async () => {
    const h = await makeStudioHarness();
    const txKind = await makeAllowedStudioTxKindBytes();

    const prepareResult = await handlePromotionPrepare(h.prepareCtx, {
      promotionId: h.promoId,
      senderAddress: USER_ADDR,
      txKindBytes: txKind,
      verifiedIdentity: h.identity,
      clientIp: CLIENT_IP,
    });

    // Cross-request binding check #1: receipt store + sponsorPool
    // both observe the same receiptId → entry hash + committed lease.
    const peeked = await h.sponsoredExecutionStore.readPreparedReceipt(prepareResult.receiptId);
    expect(peeked).not.toBeNull();
    expect(peeked!.mode).toBe('promotion');
    const txBytesRaw = Uint8Array.from(Buffer.from(prepareResult.txBytes, 'base64'));
    const expectedHash = createHash('sha256').update(txBytesRaw).digest('hex');
    expect(peeked!.txBytesHash).toBe(expectedHash);

    const userSig = (await USER_KP.signTransaction(txBytesRaw)).signature;

    const sponsorResult = await handlePromotionSponsor(h.sponsorCtx, {
      promotionId: h.promoId,
      receiptId: prepareResult.receiptId,
      txBytes: prepareResult.txBytes,
      userSignature: userSig,
      verifiedIdentity: h.identity,
      clientIp: CLIENT_IP,
    });

    expect(sponsorResult.digest).toBe(TransactionDataBuilder.getDigestFromBytes(txBytesRaw));

    // Cross-request binding check #2: the prepared entry became a final
    // execution record and the ledger reservation was cleared.
    expect(await h.sponsoredExecutionStore.readPreparedReceipt(prepareResult.receiptId)).toBeNull();
    const ent = await h.executionLedger.getEntitlement(h.promoId, STUDIO_USER_ID);
    expect(ent!.activeReservationReceiptId).toBeNull();
  });

  test('tamper: prepare commits tx A; sponsor receives tx B → TAMPERING_DETECTED before execution', async () => {
    const h = await makeStudioHarness();
    const txKind = await makeAllowedStudioTxKindBytes();

    const prepareResult = await handlePromotionPrepare(h.prepareCtx, {
      promotionId: h.promoId,
      senderAddress: USER_ADDR,
      txKindBytes: txKind,
      verifiedIdentity: h.identity,
      clientIp: CLIENT_IP,
    });

    const tampered = await buildStudioTamperedTx();
    const userSigB = (await USER_KP.signTransaction(tampered.txBytes)).signature;

    const err = await handlePromotionSponsor(h.sponsorCtx, {
      promotionId: h.promoId,
      receiptId: prepareResult.receiptId,
      txBytes: toBase64(tampered.txBytes),
      userSignature: userSigB,
      verifiedIdentity: h.identity,
      clientIp: CLIENT_IP,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    expect((err as PromotionSponsorError).code).toBe('TAMPERING_DETECTED');

    // Hash mismatch is rejected before the atomic execution transition. The
    // prepared receipt and Promotion reservation remain available to the
    // legitimate signer.
    expect(
      await h.sponsoredExecutionStore.readPreparedReceipt(prepareResult.receiptId),
    ).not.toBeNull();
    const ent = await h.executionLedger.getEntitlement(h.promoId, STUDIO_USER_ID);
    expect(ent!.activeReservationReceiptId).toBe(prepareResult.receiptId);
  });

  test('replay: same receipt sponsored twice → second call rejects with PREPARED_TX_NOT_FOUND', async () => {
    const h = await makeStudioHarness();
    const txKind = await makeAllowedStudioTxKindBytes();

    const prepareResult = await handlePromotionPrepare(h.prepareCtx, {
      promotionId: h.promoId,
      senderAddress: USER_ADDR,
      txKindBytes: txKind,
      verifiedIdentity: h.identity,
      clientIp: CLIENT_IP,
    });
    const txBytesRaw = Uint8Array.from(Buffer.from(prepareResult.txBytes, 'base64'));
    const userSig = (await USER_KP.signTransaction(txBytesRaw)).signature;

    const first = await handlePromotionSponsor(h.sponsorCtx, {
      promotionId: h.promoId,
      receiptId: prepareResult.receiptId,
      txBytes: prepareResult.txBytes,
      userSignature: userSig,
      verifiedIdentity: h.identity,
      clientIp: CLIENT_IP,
    });
    expect(first.digest).toBe(TransactionDataBuilder.getDigestFromBytes(txBytesRaw));

    const replay = await handlePromotionSponsor(h.sponsorCtx, {
      promotionId: h.promoId,
      receiptId: prepareResult.receiptId,
      txBytes: prepareResult.txBytes,
      userSignature: userSig,
      verifiedIdentity: h.identity,
      clientIp: CLIENT_IP,
    }).catch((e: unknown) => e);

    expect(replay).toBeInstanceOf(PromotionSponsorError);
    expect((replay as PromotionSponsorError).code).toBe('PREPARED_TX_NOT_FOUND');
  });

  test('malformed signature: sponsor classifies as SENDER_SIGNATURE_INVALID', async () => {
    const h = await makeStudioHarness();
    const txKind = await makeAllowedStudioTxKindBytes();

    const prepareResult = await handlePromotionPrepare(h.prepareCtx, {
      promotionId: h.promoId,
      senderAddress: USER_ADDR,
      txKindBytes: txKind,
      verifiedIdentity: h.identity,
      clientIp: CLIENT_IP,
    });

    const wrongKp = Ed25519Keypair.generate();
    const txBytesRaw = Uint8Array.from(Buffer.from(prepareResult.txBytes, 'base64'));
    const wrongSig = (await wrongKp.signTransaction(txBytesRaw)).signature;

    const err = await handlePromotionSponsor(h.sponsorCtx, {
      promotionId: h.promoId,
      receiptId: prepareResult.receiptId,
      txBytes: prepareResult.txBytes,
      userSignature: wrongSig,
      verifiedIdentity: h.identity,
      clientIp: CLIENT_IP,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PromotionSponsorError);
    // The thrown classification is `SENDER_SIGNATURE_INVALID` (matching the
    // generic route). The promotion-specific `PROMO_SENDER_SIGNATURE_INVALID`
    // code lives on the abuse-recorder ledger only — verified via
    // `PROMOTION_ABUSE_RECORDED` structured log in the existing
    // `sponsorPromotionSponsored.test.ts` suite.
    expect((err as PromotionSponsorError).code).toBe('SENDER_SIGNATURE_INVALID');

    // A rejection before the execution transition preserves the entry and
    // reservation for the legitimate owner without another prepare request.
    const stillPeeked = await h.sponsoredExecutionStore.readPreparedReceipt(
      prepareResult.receiptId,
    );
    expect(stillPeeked).not.toBeNull();
    const ent = await h.executionLedger.getEntitlement(h.promoId, STUDIO_USER_ID);
    expect(ent!.activeReservationReceiptId).toBe(prepareResult.receiptId);
  });
});
