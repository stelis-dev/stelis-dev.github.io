/**
 * handleSponsor unit tests — new /prepare→/sponsor flow.
 *
 * Covers the full processing order documented in sponsor.ts:
 *   1. Decode txBytes, validate userSignature format
 *   2. peek(receiptId) → get senderAddress (read-only)
 *   3. Abuse check (ip + senderAddress) — before consume
 *   4. consume(receiptId, txHash) — single-use atomic
 *   5. gasOwner cross-check
 *   6. Preflight simulation
 *   7. Sponsor sign
 *   8. Submit + congestion detection
 *   9. Economics log (built from tx-derived settleArgs, not store copies)
 *   10. finally: slot checkin
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase64, toBase58 } from '@mysten/sui/utils';
import { bcs } from '@mysten/sui/bcs';
import {
  GAS_VARIANCE_FIXED_MIST,
  convertSdkCommands,
  sha256Bytes,
  type CreditResult,
  type SuiSimulationResult,
  type SuiTransactionWithEventsResult,
} from '@stelis/core-relay';
import type { ChainBoundSuiEndpointSnapshot } from '@stelis/core-relay';
import {
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
  SETTLE_WITH_CREDIT_FUNCTION,
  SLIPPAGE_CAP_BPS,
  SUI_CHAIN_IDENTIFIERS,
  type MoveCallCommand,
} from '@stelis/contracts';
import { PREPARE_TTL_MS } from '../src/preparePolicy.js';
import { computePolicyHash } from '../src/policyHash.js';
import {
  handleSponsor,
  SponsorValidationError,
  SponsorPreflightError,
  SponsorOnchainError,
  SponsorCongestionError,
  SponsorSubmissionUncertainError,
} from '../src/handlers/sponsor.js';
import type { HostContext } from '../src/context.js';
import type { SponsorResultMetadata } from '../src/handlers/sponsorResult.js';
import type { GenericPreparedTxDraft, GenericPreparedTxEntry } from '../src/store/prepareTypes.js';
import type { AbuseBlockerAdapter } from '../src/store/abuseBlockTypes.js';
import { VAULT_DRIFT_NEW_USER_VAULT_EXISTS } from '../src/failures.js';
import { SponsorPool } from '../src/context.js';
import { MemorySponsoredExecutionStore } from '../src/store/memorySponsoredExecutionStore.js';
import type { SponsoredExecutionStoreAdapter } from '../src/store/sponsoredExecutionStore.js';
import {
  bindSuiResultToTransactionBytes,
  congestedSuiExecutionError,
  suiExecutionFailure,
  suiExecutionSuccess,
  suiSimulationFailure,
  suiSimulationSuccess,
  TEST_SUI_TRANSACTION_DIGEST,
  moveAbortSuiExecutionError,
  suiEndpointSnapshotFixture,
} from './helpers/suiGatewayResultFixtures.js';

const suiGateways = vi.hoisted(() => ({
  executeSuiTransaction: vi.fn(),
  queryUserCredit: vi.fn(),
  simulateSuiTransaction: vi.fn(),
}));

vi.mock('@stelis/core-relay', async () => {
  const actual = await vi.importActual<typeof import('@stelis/core-relay')>('@stelis/core-relay');
  return { ...actual, ...suiGateways };
});

// ─────────────────────────────────────────────
// Test constants
// ─────────────────────────────────────────────

const CLIENT_IP = '192.168.1.100';
const senderKeypair = Ed25519Keypair.generate();
const SENDER = senderKeypair.toSuiAddress();
const PAYMENT_ID = '0x' + 'cc'.repeat(32);
const SWAP_POOL = '0x' + 'dd'.repeat(32);
const SWAP_PAYMENT_TYPE = `0x${'de'.repeat(32)}::deep::DEEP`;
const SWAP_ALLOWED_ROUTE = {
  tokenType: SWAP_PAYMENT_TYPE,
  hops: [SWAP_POOL],
  settlementSwapDirection: 'baseForQuote' as const,
};
const SWAP_EXECUTION_PATH_KEY = `${SWAP_ALLOWED_ROUTE.tokenType}:${SWAP_ALLOWED_ROUTE.hops.join(',')}:${SWAP_ALLOWED_ROUTE.settlementSwapDirection}`;

const sponsorKeypair = Ed25519Keypair.generate();
const SPONSOR_ADDRESS = sponsorKeypair.toSuiAddress();

const suiDigest = (txBytes: Uint8Array): string =>
  TransactionDataBuilder.getDigestFromBytes(txBytes);

type ConsoleCallSource = {
  readonly mock: {
    readonly calls: readonly (readonly unknown[])[];
  };
};

function findStructuredLog(
  spy: ConsoleCallSource,
  event: string,
): Record<string, unknown> | undefined {
  for (const call of spy.mock.calls) {
    const raw = call[0];
    if (typeof raw !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>)['event'] === event
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Other console output is outside the structured-event assertion surface.
    }
  }
  return undefined;
}

/**
 * Shared mock Host config values.
 * Used by both the Host config mock and the transaction builders.
 */
const MOCK_CONFIG = {
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

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Canonical (tx-derived) settle values embedded by the default
 * `buildValidTx()` fixture. Sponsor-side decisions must
 * match these values — store copies are ignored.
 */
const DEFAULT_TX_SETTLE_VALUES = {
  executionCostClaim: 5_250_000n,
  simGasReported: 5_000_000n,
  gasVarianceFixedMist: 250_000n,
  slippageBufferMist: 0n,
  quotedHostFeeMist: MOCK_CONFIG.maxHostFeeMist,
  nonce: 1n,
} as const;

interface BuildValidTxOptions {
  orderId?: string;
  packageId?: string;
  configId?: string;
  vaultRegistryId?: string;
  settlementPayoutRecipient?: string;
  /** Override any of the 13 settle-field pure u64/vec<u8> values. */
  settleOverrides?: Partial<{
    executionCostClaim: bigint;
    simGasReported: bigint;
    gasVarianceFixedMist: bigint;
    slippageBufferMist: bigint;
    quotedHostFeeMist: bigint;
    nonce: bigint;
  }>;
  /** Override the tx.sender bound into the transaction bytes. */
  txSender?: string;
}

async function buildValidTx(
  gasOwner: string,
  opts?: BuildValidTxOptions,
): Promise<{
  txBytes: Uint8Array;
  encodedTxBytes: string;
  txHash: string;
}> {
  const tx = new Transaction();
  tx.setSender(opts?.txSender ?? SENDER);
  tx.setGasOwner(gasOwner);
  tx.setGasBudget(5_000_000);
  tx.setGasPrice(1000);
  const digestBytes = new Uint8Array(32);
  digestBytes.fill(1);
  tx.setGasPayment([]);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: '1',
      maxEpoch: '2',
      minTimestamp: null,
      maxTimestamp: null,
      chain: SUI_CHAIN_IDENTIFIERS.testnet,
      nonce: 0,
    },
  });

  // Credit-only settlement layout:
  //   0: config, 1: registry, 2: clock, 3: vault, 4: useCreditAmount,
  //   5: executionCostClaim, 6: settlementPayoutRecipient, 7: receiptId, 8: nonce,
  //   9: simGas, 10: gasVarianceFixedMist, 11: slippageBufferMist,
  //   12: quotedHostFeeMist, 13: expectedProtocolFeeMist,
  //   14: expectedConfigVersion, 15: quoteTimestampMs,
  //   16: policyHash, 17: orderIdHash
  //
  // policyHash must match what sponsor.ts computes (computePolicyHash with MOCK_CONFIG fees).
  const policyHashHex = computePolicyHash({
    maxClaimMist: MOCK_CONFIG.maxClaimMist,
    maxHostFeeMist: MOCK_CONFIG.maxHostFeeMist,
    protocolFeeMist: MOCK_CONFIG.protocolFlatFeeMist,
    quoteTtlMs: PREPARE_TTL_MS,
    gasVarianceFixedMist: GAS_VARIANCE_FIXED_MIST,
    slippageCapBps: SLIPPAGE_CAP_BPS,
  });
  const policyHashBytes = Buffer.from(policyHashHex.replace('0x', ''), 'hex');

  // Helper: resolved object reference for offline build (no Sui client needed)
  const objRef = (id: string) =>
    tx.objectRef({ objectId: id, version: '1', digest: toBase58(digestBytes) });

  const settleValues = { ...DEFAULT_TX_SETTLE_VALUES, ...(opts?.settleOverrides ?? {}) };
  const packageId = opts?.packageId ?? MOCK_CONFIG.packageId;
  const configId = opts?.configId ?? MOCK_CONFIG.configId;
  const vaultRegistryId = opts?.vaultRegistryId ?? MOCK_CONFIG.vaultRegistryId;
  const settlementPayoutRecipient =
    opts?.settlementPayoutRecipient ?? MOCK_CONFIG.settlementPayoutRecipientAddress;

  tx.moveCall({
    target: `${packageId}::settle::${SETTLE_WITH_CREDIT_FUNCTION}`,
    arguments: [
      objRef(configId), // 0: config
      objRef(vaultRegistryId), // 1: registry
      objRef('0x6'), // 2: clock
      objRef('0x' + '04'.repeat(32)), // 3: vault (dummy)
      tx.pure(bcs.u64().serialize(1_000n)), // 4: useCreditAmount
      tx.pure(bcs.u64().serialize(settleValues.executionCostClaim)), // 5: executionCostClaim
      tx.pure(bcs.Address.serialize(settlementPayoutRecipient)), // 6: settlementPayoutRecipient
      tx.pure(bcs.vector(bcs.u8()).serialize([])), // 7: receiptId
      tx.pure(bcs.u64().serialize(settleValues.nonce)), // 8: nonce
      tx.pure(bcs.u64().serialize(settleValues.simGasReported)), // 9: simGasReported
      tx.pure(bcs.u64().serialize(settleValues.gasVarianceFixedMist)), // 10: gasVarianceFixedMist
      tx.pure(bcs.u64().serialize(settleValues.slippageBufferMist)), // 11: slippageBufferMist
      tx.pure(bcs.u64().serialize(settleValues.quotedHostFeeMist)), // 12: quotedHostFeeMist
      tx.pure(bcs.u64().serialize(MOCK_CONFIG.protocolFlatFeeMist)), // 13: expectedProtocolFeeMist
      tx.pure(bcs.u64().serialize(MOCK_CONFIG.configVersion)), // 14: expectedConfigVersion
      tx.pure(bcs.u64().serialize(BigInt(Date.now()))), // 15: quoteTimestampMs
      tx.pure(bcs.vector(bcs.u8()).serialize([...policyHashBytes])), // 16: policyHash
      tx.pure(
        bcs
          .vector(bcs.u8())
          .serialize(
            opts?.orderId ? [...(await sha256Bytes(new TextEncoder().encode(opts.orderId)))] : [],
          ),
      ), // 17: orderIdHash
    ],
    typeArguments: [],
  });

  const bytes = await tx.build({ onlyTransactionKind: false });
  const hash = createHash('sha256').update(bytes).digest('hex');
  return { txBytes: bytes, encodedTxBytes: toBase64(bytes), txHash: hash };
}

async function buildAddressBalanceSwapTx(
  gasOwner: string,
  opts?: {
    orderId?: string;
    withdrawalAmount?: bigint;
    swapAmount?: bigint;
    /**
     * Settle variant. Default is `'new_user'` so the existing
     * payment-input-contract test and vault-drift cases continue to use
     * the new-user settlement function. `'with_vault'`
     * builds the vault-backed settlement function with the additional
     * `vault` argument inserted at index 3 AND a trailing
     * `use_credit_amount: u64 = 0` at index 21 (the Move ABI shape
     * — the vault-backed Move entrypoint),
     * matching the production builder
     * (`packages/core-relay/src/ptb/builders.ts`). Used by the
     * with-vault no-query lock.
     */
    settleVariant?: 'new_user' | 'with_vault';
  },
): Promise<{
  txBytes: Uint8Array;
  encodedTxBytes: string;
  txHash: string;
}> {
  const tx = new Transaction();
  tx.setSender(SENDER);
  tx.setGasOwner(gasOwner);
  tx.setGasBudget(5_000_000);
  tx.setGasPrice(1000);
  const digestBytes = new Uint8Array(32);
  digestBytes.fill(2);
  tx.setGasPayment([]);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: '1',
      maxEpoch: '2',
      minTimestamp: null,
      maxTimestamp: null,
      chain: SUI_CHAIN_IDENTIFIERS.testnet,
      nonce: 0,
    },
  });

  const policyHashHex = computePolicyHash({
    maxClaimMist: MOCK_CONFIG.maxClaimMist,
    maxHostFeeMist: MOCK_CONFIG.maxHostFeeMist,
    protocolFeeMist: MOCK_CONFIG.protocolFlatFeeMist,
    quoteTtlMs: PREPARE_TTL_MS,
    gasVarianceFixedMist: GAS_VARIANCE_FIXED_MIST,
    slippageCapBps: SLIPPAGE_CAP_BPS,
  });
  const policyHashBytes = Buffer.from(policyHashHex.replace('0x', ''), 'hex');

  const objRef = (id: string) =>
    tx.objectRef({ objectId: id, version: '1', digest: toBase58(digestBytes) });

  const withdrawalAmount = opts?.withdrawalAmount ?? 500_000n;
  const swapAmount = opts?.swapAmount ?? 500_000n;
  const withdrawal = tx.withdrawal({ amount: withdrawalAmount, type: SWAP_PAYMENT_TYPE });
  const [paymentCoin] = tx.moveCall({
    target: '0x2::coin::redeem_funds',
    typeArguments: [SWAP_PAYMENT_TYPE],
    arguments: [withdrawal],
  });

  const variant = opts?.settleVariant ?? 'new_user';
  const settleArguments =
    variant === 'with_vault'
      ? [
          objRef(MOCK_CONFIG.configId), // 0: config
          objRef(MOCK_CONFIG.vaultRegistryId), // 1: registry
          objRef('0x6'), // 2: clock
          objRef('0x' + '04'.repeat(32)), // 3: vault (with_vault-only)
          objRef(SWAP_POOL), // 4: pool
          paymentCoin, // 5: payment
          tx.pure(bcs.u64().serialize(swapAmount)), // 6: swapAmount
          tx.pure(bcs.u64().serialize(400_000n)), // 7: minSuiOut
          tx.pure(bcs.u64().serialize(5_250_000n)), // 8: executionCostClaim
          tx.pure(bcs.Address.serialize(MOCK_CONFIG.settlementPayoutRecipientAddress)), // 9: settlementPayoutRecipient
          tx.pure(bcs.vector(bcs.u8()).serialize([])), // 10: receiptId
          tx.pure(bcs.u64().serialize(1n)), // 11: nonce
          tx.pure(bcs.u64().serialize(5_000_000n)), // 12: simGasReported
          tx.pure(bcs.u64().serialize(GAS_VARIANCE_FIXED_MIST)), // 13: gasVarianceFixedMist
          tx.pure(bcs.u64().serialize(0n)), // 14: slippageBufferMist
          tx.pure(bcs.u64().serialize(MOCK_CONFIG.maxHostFeeMist)), // 15: quotedHostFeeMist
          tx.pure(bcs.u64().serialize(MOCK_CONFIG.protocolFlatFeeMist)), // 16: expectedProtocolFeeMist
          tx.pure(bcs.u64().serialize(MOCK_CONFIG.configVersion)), // 17: expectedConfigVersion
          tx.pure(bcs.u64().serialize(BigInt(Date.now()))), // 18: quoteTimestampMs
          tx.pure(bcs.vector(bcs.u8()).serialize([...policyHashBytes])), // 19: policyHash
          tx.pure(
            bcs
              .vector(bcs.u8())
              .serialize(
                opts?.orderId
                  ? [...(await sha256Bytes(new TextEncoder().encode(opts.orderId)))]
                  : [],
              ),
          ), // 20: orderIdHash
          // 21: use_credit_amount — Move ABI requires this u64 AFTER
          // order_id_hash on swap_and_settle_with_vault_*; production builder
          // appends `tx.pure.u64(params.useCreditAmount ?? 0n)` at the same
          // position (`packages/core-relay/src/ptb/builders.ts`). Defaults to
          // 0 for the with-vault no-query lock — credit usage value is
          // irrelevant to the new-user predicate.
          tx.pure(bcs.u64().serialize(0n)),
        ]
      : [
          objRef(MOCK_CONFIG.configId),
          objRef(MOCK_CONFIG.vaultRegistryId),
          objRef('0x6'),
          objRef(SWAP_POOL),
          paymentCoin,
          tx.pure(bcs.u64().serialize(swapAmount)),
          tx.pure(bcs.u64().serialize(400_000n)),
          tx.pure(bcs.u64().serialize(5_250_000n)),
          tx.pure(bcs.Address.serialize(MOCK_CONFIG.settlementPayoutRecipientAddress)),
          tx.pure(bcs.vector(bcs.u8()).serialize([])),
          tx.pure(bcs.u64().serialize(1n)),
          tx.pure(bcs.u64().serialize(5_000_000n)),
          tx.pure(bcs.u64().serialize(GAS_VARIANCE_FIXED_MIST)),
          tx.pure(bcs.u64().serialize(0n)),
          tx.pure(bcs.u64().serialize(MOCK_CONFIG.maxHostFeeMist)),
          tx.pure(bcs.u64().serialize(MOCK_CONFIG.protocolFlatFeeMist)),
          tx.pure(bcs.u64().serialize(MOCK_CONFIG.configVersion)),
          tx.pure(bcs.u64().serialize(BigInt(Date.now()))),
          tx.pure(bcs.vector(bcs.u8()).serialize([...policyHashBytes])),
          tx.pure(
            bcs
              .vector(bcs.u8())
              .serialize(
                opts?.orderId
                  ? [...(await sha256Bytes(new TextEncoder().encode(opts.orderId)))]
                  : [],
              ),
          ),
        ];

  tx.moveCall({
    target:
      variant === 'with_vault'
        ? `${MOCK_CONFIG.packageId}::settle::${SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.withVault}`
        : `${MOCK_CONFIG.packageId}::settle::${SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser}`,
    typeArguments: [SWAP_PAYMENT_TYPE],
    arguments: settleArguments,
  });

  const txBytes = await tx.build({ onlyTransactionKind: false });
  const txHash = createHash('sha256').update(txBytes).digest('hex');
  return {
    txBytes,
    encodedTxBytes: toBase64(txBytes),
    txHash,
  };
}

async function buildValidSignature(data: Uint8Array): Promise<string> {
  const { signature } = await senderKeypair.signTransaction(data);
  return signature;
}

function settlementCommandIndex(txBytes: Uint8Array): number {
  const commands = convertSdkCommands(Transaction.from(txBytes).getData().commands);
  const indexes = commands.flatMap((command, index) => {
    if (command.kind !== 'MoveCall') return [];
    const moveCall = command as MoveCallCommand;
    return moveCall.packageId.toLowerCase() === MOCK_CONFIG.packageId.toLowerCase() &&
      moveCall.module === 'settle'
      ? [index]
      : [];
  });
  if (indexes.length !== 1) {
    throw new Error(`Expected exactly one Stelis settlement command, found ${indexes.length}`);
  }
  return indexes[0]!;
}

// ─────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────

function makeMockAbuseBlocker(): AbuseBlockerAdapter {
  return {
    checkIp: vi.fn().mockResolvedValue({ blocked: false }),
    checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
    recordSponsorFailure: vi.fn(),
  };
}

interface MockSuiGateways {
  readonly simulateGateway: ReturnType<
    typeof vi.fn<(transaction: Uint8Array) => Promise<SuiSimulationResult>>
  >;
  readonly executeGateway: ReturnType<
    typeof vi.fn<(transaction: Uint8Array) => Promise<SuiTransactionWithEventsResult>>
  >;
  readonly queryUserCreditGateway: ReturnType<
    typeof vi.fn<
      (
        packageId: string,
        vaultRegistryId: string,
        userAddress: string,
        vaultsTableId?: string,
      ) => Promise<CreditResult>
    >
  >;
}

type MockSuiSnapshot = ChainBoundSuiEndpointSnapshot;

const mockSuiGatewaysBySnapshot = new WeakMap<ChainBoundSuiEndpointSnapshot, MockSuiGateways>();

function mockSuiGatewaysFor(snapshot: ChainBoundSuiEndpointSnapshot): MockSuiGateways {
  const gateways = mockSuiGatewaysBySnapshot.get(snapshot);
  if (!gateways) throw new Error('Missing Sui gateway fixture');
  return gateways;
}

suiGateways.simulateSuiTransaction.mockImplementation(
  (snapshot: ChainBoundSuiEndpointSnapshot, input: { readonly transaction: Uint8Array }) =>
    mockSuiGatewaysFor(snapshot).simulateGateway(input.transaction),
);
suiGateways.executeSuiTransaction.mockImplementation(
  (snapshot: ChainBoundSuiEndpointSnapshot, input: { readonly transaction: Uint8Array }) =>
    mockSuiGatewaysFor(snapshot).executeGateway(input.transaction),
);
suiGateways.queryUserCredit.mockImplementation(
  (
    snapshot: ChainBoundSuiEndpointSnapshot,
    packageId: string,
    vaultRegistryId: string,
    userAddress: string,
    vaultsTableId?: string,
  ) =>
    mockSuiGatewaysFor(snapshot).queryUserCreditGateway(
      packageId,
      vaultRegistryId,
      userAddress,
      vaultsTableId,
    ),
);

function makeMockSui(
  simResult?: SuiSimulationResult,
  execResult?: SuiTransactionWithEventsResult,
): MockSuiSnapshot {
  const gasUsed = {
    computationCost: '3000000',
    storageCost: '2000000',
    storageRebate: '500000',
  };
  const snapshot = suiEndpointSnapshotFixture();
  mockSuiGatewaysBySnapshot.set(snapshot, {
    simulateGateway: vi.fn(
      async (_transaction: Uint8Array) => simResult ?? suiSimulationSuccess(gasUsed),
    ),
    executeGateway: vi.fn(async (transaction: Uint8Array) =>
      bindSuiResultToTransactionBytes(
        execResult ?? suiExecutionSuccess(TEST_SUI_TRANSACTION_DIGEST, gasUsed),
        transaction,
      ),
    ),
    queryUserCreditGateway: vi.fn().mockResolvedValue({
      vaultObjectId: null,
      credit: '0',
      needsCreate: true,
      lastNonce: '0',
    }),
  });
  return snapshot;
}

function makeMockContext(input: {
  sponsorPool: SponsorPool;
  sponsoredExecutionStore: SponsoredExecutionStoreAdapter;
  abuseBlocker?: AbuseBlockerAdapter;
  sui?: MockSuiSnapshot;
  onSponsorResult?: HostContext['onSponsorResult'];
}): HostContext {
  const sui = input.sui ?? makeMockSui();
  return {
    network: 'testnet',
    sui,
    sponsorPool: input.sponsorPool,
    packageId: MOCK_CONFIG.packageId,
    configId: MOCK_CONFIG.configId,
    vaultRegistryId: MOCK_CONFIG.vaultRegistryId,
    vaultsTableId: M1_VAULTS_TABLE_ID,
    // Published DeepBook call-target ID retained for prepare/quote paths.
    // Abort classification uses the generated runtime identity instead.
    deepbookPackageId: MOCK_CONFIG.packageId,
    rateLimiter: {} as HostContext['rateLimiter'],
    abuseBlocker: input.abuseBlocker ?? makeMockAbuseBlocker(),
    sponsoredExecutionStore: input.sponsoredExecutionStore,
    prepareRequestNonceStore: {
      claim: vi.fn().mockResolvedValue('ok' as const),
    },
    settlementPayoutRecipientAddress: MOCK_CONFIG.settlementPayoutRecipientAddress,
    allowedSettlementSwapPaths: [],
    getConfig: vi.fn().mockResolvedValue({
      packageId: MOCK_CONFIG.packageId,
      configId: MOCK_CONFIG.configId,
      maxClaimMist: MOCK_CONFIG.maxClaimMist,
      minSettleMist: MOCK_CONFIG.minSettleMist,
      maxHostFeeMist: MOCK_CONFIG.maxHostFeeMist,
      protocolFlatFeeMist: MOCK_CONFIG.protocolFlatFeeMist,
      configVersion: MOCK_CONFIG.configVersion,
      maxSpreadBps: MOCK_CONFIG.maxSpreadBps,
    }),
    invalidateConfigCache: vi.fn(),
    dispose: vi.fn(),
    onSponsorResult: input.onSponsorResult ?? (async () => {}),
    isSponsorAddressAvailable: async () => true,
    prepareInflightLimiter: {} as HostContext['prepareInflightLimiter'],
  };
}

const TEST_HMAC_SECRET = 'generic-sponsor-test-hmac-secret-000';

async function makePreparedContext(input?: {
  readonly tx?: Awaited<ReturnType<typeof buildValidTx>>;
  readonly entry?: Partial<GenericPreparedTxDraft>;
  readonly abuseBlocker?: AbuseBlockerAdapter;
  readonly sui?: MockSuiSnapshot;
  readonly onSponsorResult?: HostContext['onSponsorResult'];
}): Promise<{
  readonly ctx: HostContext;
  readonly tx: Awaited<ReturnType<typeof buildValidTx>>;
  readonly prepared: GenericPreparedTxEntry;
  readonly sponsorPool: SponsorPool;
  readonly store: MemorySponsoredExecutionStore;
}> {
  const tx = input?.tx ?? (await buildValidTx(SPONSOR_ADDRESS));
  const sponsorPool = new SponsorPool([sponsorKeypair], { hmacSecret: TEST_HMAC_SECRET });
  const store = new MemorySponsoredExecutionStore(sponsorPool, undefined);
  const receiptId = input?.entry?.receiptId ?? PAYMENT_ID;
  const slot = await sponsorPool.checkout(receiptId);
  if (!slot) throw new Error('Generic sponsor fixture could not reserve its only slot');
  const nonce = await store.reserveNonce(SENDER, 0n, receiptId);
  const draft: GenericPreparedTxDraft = {
    mode: 'generic',
    receiptId,
    senderAddress: SENDER,
    nonce,
    txBytesHash: tx.txHash,
    sponsorAddress: slot.sponsorAddress,
    clientIp: CLIENT_IP,
    executionPathKey: 'credit',
    orderId: null,
    ...input?.entry,
  };
  const prepared = (await store.commitPreparedReceipt(draft)) as GenericPreparedTxEntry;
  return {
    ctx: makeMockContext({
      sponsorPool,
      sponsoredExecutionStore: store,
      abuseBlocker: input?.abuseBlocker,
      sui: input?.sui,
      onSponsorResult: input?.onSponsorResult,
    }),
    tx,
    prepared,
    sponsorPool,
    store,
  };
}

// ─────────────────────────────────────────────
// Vault-lookup mock helper (shared by handler tests using new_user PTBs)
// ─────────────────────────────────────────────

const M1_VAULT_ID = '0x' + 'fa'.repeat(32);
const M1_VAULTS_TABLE_ID = '0x' + 'ab'.repeat(32);

function attachExistingVaultLookup(sui: MockSuiSnapshot): {
  queryUserCredit: ReturnType<typeof vi.fn>;
} {
  const queryUserCredit = mockSuiGatewaysFor(sui).queryUserCreditGateway;
  queryUserCredit.mockReset();
  queryUserCredit.mockResolvedValue({
    vaultObjectId: M1_VAULT_ID,
    credit: '0',
    needsCreate: false,
    lastNonce: '0',
  });
  return { queryUserCredit };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('handleSponsor', () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
  });

  it('uses one decoded transaction object through simulation, sponsor signing, and submission', async () => {
    const callbacks: SponsorResultMetadata[] = [];
    const sui = makeMockSui();
    const fixture = await makePreparedContext({
      sui,
      onSponsorResult: async (result) => {
        callbacks.push(result);
      },
    });
    const userSignature = await buildValidSignature(fixture.tx.txBytes);
    const signSpy = vi.spyOn(fixture.sponsorPool, 'sign');

    const result = await handleSponsor(
      fixture.ctx,
      {
        txBytes: fixture.tx.encodedTxBytes,
        userSignature,
        receiptId: fixture.prepared.receiptId,
      },
      CLIENT_IP,
    );

    const signedBytes = signSpy.mock.calls[0]?.[2];
    expect(signedBytes).toBeInstanceOf(Uint8Array);
    expect(mockSuiGatewaysFor(sui).simulateGateway.mock.calls[0]?.[0]).toBe(signedBytes);
    expect(mockSuiGatewaysFor(sui).executeGateway.mock.calls[0]?.[0]).toBe(signedBytes);
    expect(result).toMatchObject({
      digest: suiDigest(fixture.tx.txBytes),
      executionCostClaim: DEFAULT_TX_SETTLE_VALUES.executionCostClaim.toString(),
    });
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toMatchObject({
      receiptId: fixture.prepared.receiptId,
      route: 'generic',
      outcome: 'success',
      digest: suiDigest(fixture.tx.txBytes),
    });
    expect(await fixture.store.readPreparedReceipt(fixture.prepared.receiptId)).toBeNull();
    expect((await fixture.sponsorPool.leaseStatus()).leasedSlots).toBe(0);
  });

  it('returns PREPARED_TX_NOT_FOUND without issuing a sponsor signature', async () => {
    const sponsorPool = new SponsorPool([sponsorKeypair], { hmacSecret: TEST_HMAC_SECRET });
    const store = new MemorySponsoredExecutionStore(sponsorPool, undefined);
    const signSpy = vi.spyOn(sponsorPool, 'sign');
    const ctx = makeMockContext({ sponsorPool, sponsoredExecutionStore: store });
    const tx = await buildValidTx(SPONSOR_ADDRESS);

    const error = await handleSponsor(
      ctx,
      {
        txBytes: tx.encodedTxBytes,
        userSignature: await buildValidSignature(tx.txBytes),
        receiptId: PAYMENT_ID,
      },
      CLIENT_IP,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SponsorValidationError);
    expect((error as SponsorValidationError).code).toBe('PREPARED_TX_NOT_FOUND');
    expect(signSpy).not.toHaveBeenCalled();
  });

  it('preserves the prepared receipt on hash mismatch and attributes tampering only to the client IP', async () => {
    const abuseBlocker = makeMockAbuseBlocker();
    const callbacks: SponsorResultMetadata[] = [];
    const fixture = await makePreparedContext({
      abuseBlocker,
      onSponsorResult: async (result) => {
        callbacks.push(result);
      },
    });
    const tampered = await buildValidTx(SPONSOR_ADDRESS, {
      settleOverrides: { nonce: 2n },
    });

    const error = await handleSponsor(
      fixture.ctx,
      {
        txBytes: tampered.encodedTxBytes,
        userSignature: await buildValidSignature(tampered.txBytes),
        receiptId: fixture.prepared.receiptId,
      },
      CLIENT_IP,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SponsorValidationError);
    expect((error as SponsorValidationError).code).toBe('TAMPERING_DETECTED');
    expect(abuseBlocker.recordSponsorFailure).toHaveBeenCalledWith(
      CLIENT_IP,
      undefined,
      'TAMPERING_DETECTED',
      undefined,
    );
    expect(await fixture.store.readPreparedReceipt(fixture.prepared.receiptId)).toEqual(
      fixture.prepared,
    );
    expect((await fixture.sponsorPool.leaseStatus()).leasedSlots).toBe(1);
    expect(callbacks).toEqual([]);
  });

  it('rejects an attacker signature before signing and preserves the legitimate prepared receipt', async () => {
    const fixture = await makePreparedContext();
    const attacker = Ed25519Keypair.generate();
    const attackerSignature = await attacker.signTransaction(fixture.tx.txBytes);
    const signSpy = vi.spyOn(fixture.sponsorPool, 'sign');

    const error = await handleSponsor(
      fixture.ctx,
      {
        txBytes: fixture.tx.encodedTxBytes,
        userSignature: attackerSignature.signature,
        receiptId: fixture.prepared.receiptId,
      },
      CLIENT_IP,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SponsorValidationError);
    expect((error as SponsorValidationError).code).toBe('SENDER_SIGNATURE_INVALID');
    expect(signSpy).not.toHaveBeenCalled();
    expect(await fixture.store.readPreparedReceipt(fixture.prepared.receiptId)).toEqual(
      fixture.prepared,
    );
    expect((await fixture.sponsorPool.leaseStatus()).leasedSlots).toBe(1);
  });

  it('classifies a replay-nonce Move abort before signing and releases the receipt atomically', async () => {
    const abuseBlocker = makeMockAbuseBlocker();
    const tx = await buildValidTx(SPONSOR_ADDRESS);
    const simulation = suiSimulationFailure(
      moveAbortSuiExecutionError({
        command: settlementCommandIndex(tx.txBytes),
        packageId: MOCK_CONFIG.packageId,
        module: 'vault',
        abortCode: '1',
        constantName: 'EReplayNonce',
      }),
    );
    const fixture = await makePreparedContext({
      tx,
      abuseBlocker,
      sui: makeMockSui(simulation),
    });
    const signSpy = vi.spyOn(fixture.sponsorPool, 'sign');

    const error = await handleSponsor(
      fixture.ctx,
      {
        txBytes: tx.encodedTxBytes,
        userSignature: await buildValidSignature(tx.txBytes),
        receiptId: fixture.prepared.receiptId,
      },
      CLIENT_IP,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SponsorPreflightError);
    expect((error as SponsorPreflightError).subcode).toBe('REPLAY_NONCE');
    expect(abuseBlocker.recordSponsorFailure).toHaveBeenCalledWith(
      CLIENT_IP,
      { kind: 'address', address: SENDER },
      'PREFLIGHT_FAILED',
      { subcode: 'REPLAY_NONCE', executionPathKey: 'credit' },
    );
    expect(signSpy).not.toHaveBeenCalled();
    expect(await fixture.store.readPreparedReceipt(fixture.prepared.receiptId)).toBeNull();
    expect((await fixture.sponsorPool.leaseStatus()).leasedSlots).toBe(0);
  });

  it('persists an on-chain revert with the validated digest and actual gas', async () => {
    const abuseBlocker = makeMockAbuseBlocker();
    const tx = await buildValidTx(SPONSOR_ADDRESS);
    const execution = suiExecutionFailure(
      TEST_SUI_TRANSACTION_DIGEST,
      moveAbortSuiExecutionError({ abortCode: '7' }),
      { computationCost: '1000000', storageCost: '1000000', storageRebate: '500000' },
    );
    const callbacks: SponsorResultMetadata[] = [];
    const fixture = await makePreparedContext({
      tx,
      abuseBlocker,
      sui: makeMockSui(undefined, execution),
      onSponsorResult: async (result) => {
        callbacks.push(result);
      },
    });

    const error = await handleSponsor(
      fixture.ctx,
      {
        txBytes: tx.encodedTxBytes,
        userSignature: await buildValidSignature(tx.txBytes),
        receiptId: fixture.prepared.receiptId,
      },
      CLIENT_IP,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SponsorOnchainError);
    expect(error).toMatchObject({
      digest: suiDigest(tx.txBytes),
      gasUsed: {
        computationCost: '1000000',
        storageCost: '1000000',
        storageRebate: '500000',
        nonRefundableStorageFee: '0',
      },
    });
    expect(callbacks[0]).toMatchObject({
      route: 'generic',
      outcome: 'onchain_revert',
      executionStage: 'on_chain',
      digest: suiDigest(tx.txBytes),
    });
    expect(abuseBlocker.recordSponsorFailure).toHaveBeenCalledWith(
      CLIENT_IP,
      { kind: 'address', address: SENDER },
      'ONCHAIN_REVERT',
      { subcode: undefined, executionPathKey: 'credit' },
    );
    expect((await fixture.sponsorPool.leaseStatus()).leasedSlots).toBe(0);
  });

  it('treats only a validated congestion result as congestion and releases the execution', async () => {
    const abuseBlocker = makeMockAbuseBlocker();
    const tx = await buildValidTx(SPONSOR_ADDRESS);
    const execution = suiExecutionFailure(
      TEST_SUI_TRANSACTION_DIGEST,
      congestedSuiExecutionError(),
    );
    const fixture = await makePreparedContext({
      tx,
      abuseBlocker,
      sui: makeMockSui(undefined, execution),
    });

    const error = await handleSponsor(
      fixture.ctx,
      {
        txBytes: tx.encodedTxBytes,
        userSignature: await buildValidSignature(tx.txBytes),
        receiptId: fixture.prepared.receiptId,
      },
      CLIENT_IP,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SponsorCongestionError);
    expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalled();
    expect((await fixture.sponsorPool.leaseStatus()).leasedSlots).toBe(0);
  });

  it('keeps a signed receipt executing when submission is uncertain and does not deliver a terminal callback', async () => {
    const callbacks: SponsorResultMetadata[] = [];
    const sui = makeMockSui();
    mockSuiGatewaysFor(sui).executeGateway.mockRejectedValue(
      new Error('ExecutionCancelledDueToSharedObjectCongestion: transport disconnected'),
    );
    const fixture = await makePreparedContext({
      sui,
      onSponsorResult: async (result) => {
        callbacks.push(result);
      },
    });

    const error = await handleSponsor(
      fixture.ctx,
      {
        txBytes: fixture.tx.encodedTxBytes,
        userSignature: await buildValidSignature(fixture.tx.txBytes),
        receiptId: fixture.prepared.receiptId,
      },
      CLIENT_IP,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SponsorSubmissionUncertainError);
    expect((error as SponsorSubmissionUncertainError).digest).toBe(suiDigest(fixture.tx.txBytes));
    expect(callbacks).toEqual([]);
    expect(await fixture.store.readPreparedReceipt(fixture.prepared.receiptId)).toBeNull();
    expect((await fixture.sponsorPool.leaseStatus()).leasedSlots).toBe(1);
  });

  it('rejects a new-user transaction when the vault appeared after prepare without reaching preflight', async () => {
    const tx = await buildAddressBalanceSwapTx(SPONSOR_ADDRESS);
    const sui = makeMockSui();
    const lookup = attachExistingVaultLookup(sui);
    const abuseBlocker = makeMockAbuseBlocker();
    const fixture = await makePreparedContext({
      tx,
      sui,
      abuseBlocker,
      entry: {
        executionPathKey: SWAP_EXECUTION_PATH_KEY,
      },
    });
    fixture.ctx.allowedSettlementSwapPaths = [SWAP_ALLOWED_ROUTE];
    const signSpy = vi.spyOn(fixture.sponsorPool, 'sign');

    const error = await handleSponsor(
      fixture.ctx,
      {
        txBytes: tx.encodedTxBytes,
        userSignature: await buildValidSignature(tx.txBytes),
        receiptId: fixture.prepared.receiptId,
      },
      CLIENT_IP,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SponsorValidationError);
    expect((error as SponsorValidationError).code).toBe('REPREPARE_REQUIRED');
    expect(lookup.queryUserCredit).toHaveBeenCalledTimes(1);
    expect(mockSuiGatewaysFor(sui).simulateGateway).not.toHaveBeenCalled();
    expect(signSpy).not.toHaveBeenCalled();
    expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalled();
    expect(findStructuredLog(consoleInfoSpy, 'SPONSOR_DRIFT_OBSERVED')).toMatchObject({
      stage: VAULT_DRIFT_NEW_USER_VAULT_EXISTS.stage,
      subcode: VAULT_DRIFT_NEW_USER_VAULT_EXISTS.subcode,
      route: 'generic',
    });
  });

  it('keeps orderId and settlement economics derived from the committed transaction bytes', async () => {
    const orderId = 'invoice-2026-07-18';
    const tx = await buildValidTx(SPONSOR_ADDRESS, {
      orderId,
      settleOverrides: {
        executionCostClaim: 5_500_000n,
        quotedHostFeeMist: 90_000n,
      },
    });
    const fixture = await makePreparedContext({ tx, entry: { orderId } });

    const result = await handleSponsor(
      fixture.ctx,
      {
        txBytes: tx.encodedTxBytes,
        userSignature: await buildValidSignature(tx.txBytes),
        receiptId: fixture.prepared.receiptId,
      },
      CLIENT_IP,
    );

    expect(result.orderId).toBe(orderId);
    expect(result.executionCostClaim).toBe('5500000');
    expect(findStructuredLog(consoleInfoSpy, 'SETTLEMENT_ECONOMICS_EXECUTION')).toMatchObject({
      digest: suiDigest(tx.txBytes),
      fee_charged: '90000',
    });
  });
});
