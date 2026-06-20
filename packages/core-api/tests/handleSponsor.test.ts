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
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase64, toBase58 } from '@mysten/sui/utils';
import { bcs } from '@mysten/sui/bcs';
import { GAS_VARIANCE_FIXED_MIST, sha256Bytes } from '@stelis/core-relay';
import {
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
  SETTLE_WITH_CREDIT_FUNCTION,
  SLIPPAGE_CAP_BPS,
} from '@stelis/contracts';
import {
  PREPARE_TTL_MS,
  buildExecutionPathKey as _buildExecutionPathKey,
} from '../src/handlers/prepare.js';
import { computePolicyHash } from '../src/policyHash.js';
import {
  handleSponsor,
  SponsorValidationError,
  SponsorBlockedError,
  SponsorPreflightError,
  SponsorOnchainError,
  SponsorCongestionError,
  SponsorLeaseExpiredError,
} from '../src/handlers/sponsor.js';
import type { HostContext } from '../src/context.js';
import type {
  SponsorResultCallback,
  SponsorResultMetadata,
} from '../src/handlers/sponsorResult.js';
import type { GenericPreparedTxEntry, PreparedTxEntry } from '../src/store/prepareTypes.js';
import type { AbuseBlockerAdapter } from '../src/store/abuseBlockTypes.js';
import {
  VAULT_DRIFT_NEW_USER_VAULT_EXISTS,
  VAULT_DRIFT_QUERY_FAILED,
  VAULT_DRIFT_STATE_INCONSISTENT,
} from '../src/failures.js';
import type { PrepareStoreAdapter } from '../src/store/prepareTypes.js';
import type { SponsorPoolAdapter } from '../src/context.js';
import { MemoryPrepareStore } from '../src/store/memoryPrepareStore.js';

// ─────────────────────────────────────────────
// Test constants
// ─────────────────────────────────────────────

const CLIENT_IP = '192.168.1.100';
const senderKeypair = Ed25519Keypair.generate();
const SENDER = senderKeypair.toSuiAddress();
const PAYMENT_ID = '0x' + 'cc'.repeat(32);
const SLOT_ID = 'slot-1';
const SWAP_POOL = '0x' + 'dd'.repeat(32);
const SWAP_PAYMENT_TYPE = `0x${'de'.repeat(32)}::deep::DEEP`;
const SWAP_ALLOWED_ROUTE = {
  tokenType: SWAP_PAYMENT_TYPE,
  hops: [SWAP_POOL],
  settlementSwapDirection: 'baseForQuote' as const,
};

const sponsorKeypair = Ed25519Keypair.generate();
const SPONSOR_ADDRESS = sponsorKeypair.toSuiAddress();

/**
 * Shared mock Host config values.
 * Used by both makeMockContext (getConfig mock) and makePreparedEntry (feeSnapshot).
 * Must stay in sync: the fingerprint is only valid when both sides use the same values.
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
  tx.setGasPayment([
    {
      objectId: '0x' + '01'.repeat(32),
      version: '1',
      digest: toBase58(digestBytes),
    },
  ]);

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
  const settlementPayoutRecipient = opts?.settlementPayoutRecipient ?? MOCK_CONFIG.settlementPayoutRecipientAddress;

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
  tx.setGasPayment([
    {
      objectId: '0x' + '10'.repeat(32),
      version: '1',
      digest: toBase58(digestBytes),
    },
  ]);

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

// ─────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────

function makePreparedEntry(
  txBytesHash: string,
  overrides: Partial<GenericPreparedTxEntry> = {},
): GenericPreparedTxEntry {
  return {
    issuedAt: Date.now(),
    receiptId: PAYMENT_ID,
    senderAddress: SENDER,
    nonce: 1n,
    txBytesHash,
    slotId: SLOT_ID,
    sponsorAddress: SPONSOR_ADDRESS,
    clientIp: CLIENT_IP,
    executionPathKey: 'credit', // credit-only path for unit tests
    orderId: null,
    mode: 'generic',
    ...overrides,
  };
}

function makeMockPrepareStore(
  peekResult: PreparedTxEntry | null = null,
  consumeResult: PreparedTxEntry | 'not_found' | 'expired' | 'hash_mismatch' = 'not_found',
): PrepareStoreAdapter {
  return {
    store: vi.fn(),
    consume: vi.fn().mockResolvedValue(consumeResult),
    peek: vi.fn().mockResolvedValue(peekResult),
    evictPreparedEntry: vi.fn().mockResolvedValue(undefined),
    reserveNonce: vi.fn().mockResolvedValue(1n),
    releaseReservation: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockAbuseBlocker(blocked = false, retryAfterMs?: number): AbuseBlockerAdapter {
  return {
    checkIp: vi.fn().mockResolvedValue({ blocked, retryAfterMs }),
    checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
    recordSponsorFailure: vi.fn(),
  };
}

function makeMockSponsorPool(): SponsorPoolAdapter {
  // `handleSponsor` never calls `checkout()` / `commit()` on this mock — those run during
  // `/prepare`. The mock therefore only implements the sponsor-side
  // API (`sign`, `checkin`) and provides no-op stubs for the
  // prepare-side methods so the SponsorPoolAdapter contract is
  // satisfied structurally.
  return {
    size: 1,
    primaryAddress: SPONSOR_ADDRESS,
    checkout: vi.fn().mockResolvedValue({
      slotId: SLOT_ID,
      sponsorAddress: SPONSOR_ADDRESS,
    }),
    commit: vi.fn().mockResolvedValue(undefined),
    checkin: vi.fn(),
    addresses: vi.fn().mockReturnValue([SPONSOR_ADDRESS]),
    sign: vi.fn().mockResolvedValue({ signature: 'mockSponsorSig' }),
  };
}

function makeSuccessSimResult(digest = '0xdigest123') {
  return {
    Transaction: {
      digest,
      status: { success: true },
      effects: {
        gasUsed: { computationCost: '3000000', storageCost: '2000000', storageRebate: '500000' },
      },
    },
  };
}

function makeMockSui(simResult?: unknown, execResult?: unknown) {
  return {
    simulateTransaction: vi.fn().mockResolvedValue(simResult ?? makeSuccessSimResult()),
    executeTransaction: vi.fn().mockResolvedValue(execResult ?? makeSuccessSimResult()),
    getObject: vi.fn().mockResolvedValue({
      object: {
        json: {
          max_host_fee_mist: '100000',
          protocol_flat_fee_mist: '50000',
          max_claim_mist: '50000000',
          min_settle_mist: '1000000',
          config_version: '1',
          max_spread_bps: '500',
        },
      },
    }),
  };
}

function makeMockContext(
  overrides: {
    prepareStore?: PrepareStoreAdapter;
    abuseBlocker?: AbuseBlockerAdapter;
    sponsorPool?: SponsorPoolAdapter;
    sui?: ReturnType<typeof makeMockSui>;
    onSponsorResult?: HostContext['onSponsorResult'];
  } = {},
): HostContext {
  const sponsorPool = overrides.sponsorPool ?? makeMockSponsorPool();
  const sui = overrides.sui ?? makeMockSui();
  return {
    network: 'testnet',
    sui: sui as unknown as HostContext['sui'],
    sponsorPool,
    packageId: MOCK_CONFIG.packageId,
    configId: MOCK_CONFIG.configId,
    vaultRegistryId: MOCK_CONFIG.vaultRegistryId,
    // Trusted DeepBook package ID for sponsor-time abort classification.
    // Test fixtures use the same Stelis package ID for DeepBook so an
    // abort message like `MoveAbort(0xPKG::pool::swap_exact_quantity, 12)`
    // would classify; however the mock fixtures below do not exercise
    // that path, so any value matching the test's abort fixtures is
    // sufficient.
    deepbookPackageId: MOCK_CONFIG.packageId,
    rateLimiter: {} as HostContext['rateLimiter'],
    abuseBlocker: overrides.abuseBlocker ?? makeMockAbuseBlocker(),
    prepareStore: overrides.prepareStore ?? makeMockPrepareStore(),
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
    warmUp: vi.fn(),
    dispose: vi.fn(),
    onSponsorResult: overrides.onSponsorResult,
    prepareInflightLimiter: {} as HostContext['prepareInflightLimiter'],
  };
}

// ─────────────────────────────────────────────
// Vault-lookup mock helper (shared by handler tests using new_user PTBs)
// ─────────────────────────────────────────────

const M1_VAULT_ID = '0x' + 'fa'.repeat(32);
const M1_VAULTS_TABLE_ID = '0x' + 'ab'.repeat(32);

function attachVaultLookup(
  sui: ReturnType<typeof makeMockSui>,
  mode:
    | { kind: 'no_vault' }
    | { kind: 'vault_exists' }
    | { kind: 'rpc_error'; err: Error }
    | { kind: 'inconsistent' },
): {
  getDynamicField: ReturnType<typeof vi.fn>;
  getObject: ReturnType<typeof vi.fn>;
} {
  const originalGetObject = sui.getObject;
  const getDynamicField = vi.fn();
  const getObject = vi.fn(async (params: { objectId: string }) => {
    if (params.objectId === M1_VAULT_ID) {
      if (mode.kind === 'inconsistent') {
        return { object: { json: {} } };
      }
      return {
        object: {
          json: {
            credit: '0',
            last_nonce: '0',
          },
        },
      };
    }
    return originalGetObject(params);
  });
  if (mode.kind === 'no_vault') {
    getDynamicField.mockRejectedValue({ code: 'dynamicFieldNotFound' });
  } else if (mode.kind === 'rpc_error') {
    getDynamicField.mockRejectedValue(mode.err);
  } else {
    getDynamicField.mockResolvedValue({
      dynamicField: {
        value: { bcs: bcs.Address.serialize(M1_VAULT_ID).toBytes() },
      },
    });
  }
  (sui as unknown as { getDynamicField: typeof getDynamicField }).getDynamicField = getDynamicField;
  sui.getObject = getObject;
  return { getDynamicField, getObject };
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

  // ── 1: Happy path ──────────────────────────────────────────────────────

  it('happy path: consume → preflight → sign → submit → digest + economics + checkin', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
    });

    const result = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    );

    expect(result.digest).toBe('0xdigest123');
    expect(result.effects).toBeDefined();
    // checkin must present the prepared entry's committed txBytesHash so the
    // pool CAS releases the slot.
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, txHash);
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    const logData = JSON.parse(consoleInfoSpy.mock.calls[0][0] as string) as Record<
      string,
      unknown
    >;
    expect(logData['event']).toBe('SETTLEMENT_ECONOMICS_EXECUTION');
    expect(logData['digest']).toBe('0xdigest123');
  });

  it('allows sponsor when the hash-bound PTB carries a valid address-balance payment-input contract', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildAddressBalanceSwapTx(SPONSOR_ADDRESS);
    // validationFingerprint is not checked at /sponsor — any stub value works.
    const prepared = makePreparedEntry(txHash, {
      executionPathKey: _buildExecutionPathKey(SWAP_ALLOWED_ROUTE),
    });
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    // new_user PTB triggers the pre-sign vault re-query. Stub it to
    // return "no vault" so the flow proceeds normally to sign+submit.
    const sui = makeMockSui();
    attachVaultLookup(sui, { kind: 'no_vault' });
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
      sui,
    });
    ctx.allowedSettlementSwapPaths = [SWAP_ALLOWED_ROUTE];
    (ctx as { vaultsTableId: string }).vaultsTableId = M1_VAULTS_TABLE_ID;

    const result = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    );

    expect(result.digest).toBe('0xdigest123');
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 2: PREPARED_TX_NOT_FOUND ───────────────────────────────────────────

  it('throws PREPARED_TX_NOT_FOUND when peek returns null', async () => {
    const { encodedTxBytes, txBytes } = await buildValidTx(SPONSOR_ADDRESS);
    const userSig = await buildValidSignature(txBytes);
    const ctx = makeMockContext({ prepareStore: makeMockPrepareStore(null) });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorValidationError);
  });

  // ── 2b: peek throws (corrupt entry) — must call evictPreparedEntry + reject ──

  it('rejects corrupt entry on peek throw and calls evictPreparedEntry to release slot', async () => {
    const { encodedTxBytes, txBytes } = await buildValidTx(SPONSOR_ADDRESS);
    const userSig = await buildValidSignature(txBytes);
    const evictSpy = vi.fn().mockResolvedValue(undefined);
    const peekSpy = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'RedisPrepareStore: refusing to deserialize entry with unsupported schema version 99',
        ),
      );
    const corruptStore: PrepareStoreAdapter = {
      store: vi.fn(),
      consume: vi.fn(),
      peek: peekSpy,
      evictPreparedEntry: evictSpy,
      reserveNonce: vi.fn().mockResolvedValue(1n),
      releaseReservation: vi.fn().mockResolvedValue(undefined),
    };
    const ctx = makeMockContext({ prepareStore: corruptStore });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorValidationError);

    // Both contracts must be honored simultaneously: reject + cleanup.
    expect(peekSpy).toHaveBeenCalledWith(PAYMENT_ID);
    expect(evictSpy).toHaveBeenCalledWith(PAYMENT_ID);
  });

  it('rejects corrupt entry on consume throw and calls evictPreparedEntry to release slot', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const evictSpy = vi.fn().mockResolvedValue(undefined);
    const consumeSpy = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'RedisPrepareStore: refusing to deserialize entry with unsupported schema version 42',
        ),
      );
    // peek must succeed so the handler reaches consume.
    const corruptStore: PrepareStoreAdapter = {
      store: vi.fn(),
      consume: consumeSpy,
      peek: vi.fn().mockResolvedValue(prepared),
      evictPreparedEntry: evictSpy,
      reserveNonce: vi.fn().mockResolvedValue(1n),
      releaseReservation: vi.fn().mockResolvedValue(undefined),
    };
    const ctx = makeMockContext({ prepareStore: corruptStore });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorValidationError);

    expect(consumeSpy).toHaveBeenCalled();
    expect(evictSpy).toHaveBeenCalledWith(PAYMENT_ID);
  });

  // ── 3: PREPARED_TX_EXPIRED ─────────────────────────────────────────────

  it('throws PREPARED_TX_EXPIRED when consume returns expired', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const ctx = makeMockContext({ prepareStore: makeMockPrepareStore(prepared, 'expired') });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorValidationError);
  });

  // ── 4: TAMPERING_DETECTED — hash_mismatch abuse is IP-only ─────────────
  //
  // The submitted txBytes did not match the stored prepare
  // commit, so `tx.sender` inside those unbound bytes is attacker-choosable
  // and must not be used for address-level attribution.

  it('throws TAMPERING_DETECTED and records IP-only abuse on hash_mismatch', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker();
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, 'hash_mismatch'),
      abuseBlocker,
    });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorValidationError);
    // IP-only: no address attribution before hash-binding succeeds.
    expect(abuseBlocker.recordSponsorFailure).toHaveBeenCalledWith(
      CLIENT_IP,
      undefined,
      'TAMPERING_DETECTED',
      undefined,
    );
    // Address-level attribution must NOT land on any real sender value.
    expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalledWith(
      CLIENT_IP,
      { kind: 'address', address: SENDER },
      'TAMPERING_DETECTED',
      expect.anything(),
    );
  });

  it('same receiptId with different txBytes fails before sponsor signature issuance', async () => {
    const original = await buildValidTx(SPONSOR_ADDRESS);
    const replacement = await buildValidTx(SPONSOR_ADDRESS, {
      settleOverrides: { nonce: DEFAULT_TX_SETTLE_VALUES.nonce + 1n },
    });
    expect(replacement.txHash).not.toBe(original.txHash);

    const prepared = makePreparedEntry(original.txHash);
    const userSig = await buildValidSignature(replacement.txBytes);
    const releaseSpy = vi.fn().mockResolvedValue(undefined);
    const prepareStore = new MemoryPrepareStore(releaseSpy, 60_000, 10, 10, 60_000);
    const sponsorPool = makeMockSponsorPool();
    const ctx = makeMockContext({
      prepareStore,
      sponsorPool,
      abuseBlocker: makeMockAbuseBlocker(),
    });

    try {
      await prepareStore.store(PAYMENT_ID, prepared);

      const err = await handleSponsor(
        ctx,
        { txBytes: replacement.encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SponsorValidationError);
      expect((err as SponsorValidationError).code).toBe('TAMPERING_DETECTED');
      expect(sponsorPool.sign).not.toHaveBeenCalled();
      expect(sponsorPool.checkin).not.toHaveBeenCalled();
    } finally {
      prepareStore.dispose();
    }
  });

  // ── 4b/4c: sponsor reads execution-critical values from tx-derived settleArgs ──
  // The prepare store entry is coordination-only. Sponsor response and
  // economics logs use values from `parseSettleArgs(txBytes)`, not store
  // copies. These tests pin that contract.

  it('response.executionCostClaim is the tx-derived value from parseSettleArgs(txBytes)', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker();
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      abuseBlocker,
    });

    const result = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    );

    expect(result.executionCostClaim).toBe(DEFAULT_TX_SETTLE_VALUES.executionCostClaim.toString());
    expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalledWith(
      CLIENT_IP,
      { kind: 'address', address: SENDER },
      'TAMPERING_DETECTED',
      undefined,
    );
  });

  it('economics log fee_charged is the tx-derived quotedHostFeeMist from parseSettleArgs(txBytes)', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker();
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      abuseBlocker,
    });

    const result = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    );

    expect(result.digest).toBe('0xdigest123');
    expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalledWith(
      CLIENT_IP,
      { kind: 'address', address: SENDER },
      'TAMPERING_DETECTED',
      undefined,
    );
    const economicsLog = consoleInfoSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry['event'] === 'SETTLEMENT_ECONOMICS_EXECUTION');
    expect(economicsLog).toBeDefined();
    expect(economicsLog!['fee_charged']).toBe(
      DEFAULT_TX_SETTLE_VALUES.quotedHostFeeMist.toString(),
    );
  });

  it('L3 non-loss check uses tx-derived gasVarianceFixedMist + slippageBufferMist from parseSettleArgs(txBytes)', async () => {
    // No store-side override is possible — the settle audit fields live
    // exclusively on the parsed PTB. This test confirms the happy-path
    // L3 acceptance with tx-derived audit values.
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
    });

    const result = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    );

    expect(result.digest).toBe('0xdigest123');
  });

  // Post-consume payment-integrity failure is server-side drift, not tampering.
  // After hash-binding, the submitted bytes are proven identical to prepare-time commit,
  // so a malformed payment-input contract = server validation bug, not user manipulation.
  // Response: REPREPARE_REQUIRED + SPONSOR_DRIFT_OBSERVED log. No abuse recorded.
  it('throws REPREPARE_REQUIRED (not TAMPERING_DETECTED) on malformed payment-input contract — emits SPONSOR_DRIFT_OBSERVED, no abuse', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildAddressBalanceSwapTx(SPONSOR_ADDRESS, {
      withdrawalAmount: 500_000n,
      swapAmount: 400_000n,
    });
    // validationFingerprint is not checked at /sponsor — stub value
    const prepared = makePreparedEntry(txHash, {
      executionPathKey: _buildExecutionPathKey(SWAP_ALLOWED_ROUTE),
    });
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker();
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      abuseBlocker,
    });
    ctx.allowedSettlementSwapPaths = [SWAP_ALLOWED_ROUTE];

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    // Post-consume drift: REPREPARE_REQUIRED, not TAMPERING_DETECTED
    expect(err).toBeInstanceOf(SponsorValidationError);
    expect((err as SponsorValidationError).code).toBe('REPREPARE_REQUIRED');

    // Drift is not an abuse signal — no abuse counter incremented
    expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalled();

    // Operator observability: SPONSOR_DRIFT_OBSERVED must be logged with stage+subcode
    const driftLog = consoleInfoSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry['event'] === 'SPONSOR_DRIFT_OBSERVED');
    expect(driftLog).toBeDefined();
    expect(driftLog!['stage']).toBe('payment_integrity');
    expect(typeof driftLog!['subcode']).toBe('string');
  });

  // ── 5: SponsorBlockedError (before consume) ────────────────────────────

  it('throws SponsorBlockedError when sender is abuse-blocked (before consume)', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker(true, 60_000);
    const prepareStore = makeMockPrepareStore(prepared, prepared);
    const ctx = makeMockContext({ prepareStore, abuseBlocker });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorBlockedError);
    // consume NOT called — entry preserved
    expect(prepareStore.consume).not.toHaveBeenCalled();
  });

  // ── 6: GAS_OWNER_MISMATCH — post-consume drift classification ──────
  //
  // GAS_OWNER_MISMATCH is a post-consume internal inconsistency. The
  // submitted bytes are hash-bound by consume(), so the gas owner embedded
  // in the PTB is exactly what /prepare built. If it differs from
  // prepared.sponsorAddress it means slot identity coordination failed
  // server-side — not user tampering.
  //
  // Current behaviour:
  //   - Error: SponsorValidationError(REPREPARE_REQUIRED)
  //   - Abuse: NOT recorded
  //   - Observability: SPONSOR_DRIFT_OBSERVED emitted with stage=gas_owner_mismatch

  it('gasOwner mismatch → REPREPARE_REQUIRED (not TAMPERING/PREFLIGHT), no abuse, SPONSOR_DRIFT_OBSERVED', async () => {
    const wrongOwner = '0x' + 'bb'.repeat(32);
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(wrongOwner);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker();
    const sponsorPool = makeMockSponsorPool();
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      abuseBlocker,
      sponsorPool,
    });

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    // Post-consume drift: REPREPARE_REQUIRED, not SponsorPreflightError
    expect(err).toBeInstanceOf(SponsorValidationError);
    expect((err as SponsorValidationError).code).toBe('REPREPARE_REQUIRED');

    // No abuse recorded — hash-bound internal drift
    expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalled();

    // Operator observability: SPONSOR_DRIFT_OBSERVED with correct stage
    const driftLog = consoleInfoSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry['event'] === 'SPONSOR_DRIFT_OBSERVED');
    expect(driftLog).toBeDefined();
    expect(driftLog!['stage']).toBe('gas_owner_mismatch');
    expect(driftLog!['subcode']).toBe('GAS_OWNER_MISMATCH');
    expect(driftLog!['receipt_id']).toBe(PAYMENT_ID);

    // Slot must still be checked in (finally block guarantees this)
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 7: Preflight fails (status.success = false) ────────────────────────

  it('throws SponsorPreflightError and records abuse when simulation fails', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker();
    const sponsorPool = makeMockSponsorPool();
    const failedSim = {
      Transaction: {
        digest: '0xfail',
        effects: { status: { success: false, error: { message: 'InsufficientBalance' } } },
      },
    };
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      abuseBlocker,
      sponsorPool,
      sui: makeMockSui(failedSim),
    });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorPreflightError);
    expect(abuseBlocker.recordSponsorFailure).toHaveBeenCalledWith(
      CLIENT_IP,
      { kind: 'address', address: SENDER },
      'PREFLIGHT_FAILED',
      { subcode: undefined, executionPathKey: 'credit' },
    );
    expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalledWith(
      CLIENT_IP,
      { kind: 'address', address: SENDER },
      'ONCHAIN_REVERT',
      expect.anything(),
    );
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
    expect(sponsorPool.sign).not.toHaveBeenCalled();
  });

  // Blocker adapter failures must not mask the primary classified sponsor
  // rejection. The swallow is owned by `recordSponsorFailureForAbuse`
  // helper, so handler code has no inline try/catch — this test locks
  // that behavior at the handler level.
  it('preserves SponsorPreflightError when abuse blocker recordSponsorFailure throws', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker();
    (abuseBlocker.recordSponsorFailure as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('redis unreachable'),
    );
    const sponsorPool = makeMockSponsorPool();
    const failedSim = {
      Transaction: {
        digest: '0xfail',
        effects: { status: { success: false, error: { message: 'InsufficientBalance' } } },
      },
    };
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      abuseBlocker,
      sponsorPool,
      sui: makeMockSui(failedSim),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // Primary classified rejection is preserved, not replaced by the infra error.
      await expect(
        handleSponsor(
          ctx,
          { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
          CLIENT_IP,
        ),
      ).rejects.toThrow(SponsorPreflightError);

      // Recorder still invoked — swallow happens inside the helper.
      expect(abuseBlocker.recordSponsorFailure).toHaveBeenCalledWith(
        CLIENT_IP,
        { kind: 'address', address: SENDER },
        'PREFLIGHT_FAILED',
        { subcode: undefined, executionPathKey: 'credit' },
      );

      // Recorder degradation observable via SPONSOR_FAILURE_RECORDER_FAILED.
      const recorderFailed = warnSpy.mock.calls
        .map((call) => {
          try {
            return JSON.parse(String(call[0])) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find(
          (entry): entry is Record<string, unknown> =>
            entry?.['event'] === 'SPONSOR_FAILURE_RECORDER_FAILED',
        );
      expect(recorderFailed).toBeDefined();
      expect(recorderFailed!['code']).toBe('PREFLIGHT_FAILED');
      expect(recorderFailed!['error']).toBe('redis unreachable');

      // finally{} slot checkin still runs.
      expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
      expect(sponsorPool.sign).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── 8: FailedTransaction $kind ─────────────────────────────────────────

  it('throws SponsorPreflightError on FailedTransaction $kind simulation', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker();
    const failedSim = {
      $kind: 'FailedTransaction',
      FailedTransaction: { status: { error: { message: 'MoveAbort', $kind: 'MoveAbort' } } },
    };
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      abuseBlocker,
      sui: makeMockSui(failedSim),
    });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorPreflightError);
    expect(abuseBlocker.recordSponsorFailure).toHaveBeenCalledWith(
      CLIENT_IP,
      { kind: 'address', address: SENDER },
      'PREFLIGHT_FAILED',
      { subcode: undefined, executionPathKey: 'credit' },
    );
  });

  // A stale prepared nonce returns at preflight as a `vault::EReplayNonce`
  // (numeric code `1`) Move abort. The route classifies it as
  // `REPLAY_NONCE` and propagates `{ subcode, executionPathKey }` to the abuse
  // recorder. The shared address-level carve-out predicate
  // (`shouldCarveOutNonIpCounter`) gates both the on-chain-revert
  // and simulation-tier address counters, so this propagation is what
  // makes the predicate fire on preflight as well; adapter-level
  // carve-out behavior is locked separately in
  // `abuseBlocker.conformance.ts`.
  it('rejects stale prepared nonce before sign when preflight hits on-chain replay guard', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    const abuseBlocker = makeMockAbuseBlocker();
    const staleNonceSim = {
      Transaction: {
        digest: '0xstale',
        status: {
          success: false,
          error: {
            message:
              'MoveAbort(0x1111111111111111111111111111111111111111111111111111111111111111::vault::check_and_advance_nonce, 1) in command 0',
          },
        },
      },
    };
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      abuseBlocker,
      sponsorPool,
      sui: makeMockSui(staleNonceSim),
    });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorPreflightError);
    expect(abuseBlocker.recordSponsorFailure).toHaveBeenCalledWith(
      CLIENT_IP,
      { kind: 'address', address: SENDER },
      'PREFLIGHT_FAILED',
      { subcode: 'REPLAY_NONCE', executionPathKey: 'credit' },
    );
    expect(sponsorPool.sign).not.toHaveBeenCalled();
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 9: Onchain revert ──────────────────────────────────────────────────

  it('throws SponsorOnchainError when execution reverts', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    const abuseBlocker = makeMockAbuseBlocker();
    const execResult = {
      Transaction: {
        digest: '0xrevert',
        effects: {
          status: { success: false, error: { message: 'MoveAbort(code: 7)' } },
          gasUsed: { computationCost: '1000000', storageCost: '1000000', storageRebate: '500000' },
        },
      },
    };
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
      abuseBlocker,
      sui: makeMockSui(undefined, execResult),
    });

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorOnchainError);
    expect((err as SponsorOnchainError).digest).toBe('0xrevert');
    expect((err as SponsorOnchainError).gasUsed).toEqual({
      computationCost: '1000000',
      storageCost: '1000000',
      storageRebate: '500000',
    });
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
    // Verify ONCHAIN_REVERT abuse was recorded with the hash-bound sender and route metadata.
    expect(abuseBlocker.recordSponsorFailure).toHaveBeenCalledWith(
      CLIENT_IP,
      { kind: 'address', address: SENDER },
      'ONCHAIN_REVERT',
      { subcode: undefined, executionPathKey: 'credit' },
    );
    expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalledWith(
      CLIENT_IP,
      { kind: 'address', address: SENDER },
      'PREFLIGHT_FAILED',
      expect.anything(),
    );
  });

  // ── 10: Congestion ─────────────────────────────────────────────────────

  it('throws SponsorCongestionError on shared object congestion', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    const execResult = {
      $kind: 'FailedTransaction',
      FailedTransaction: {
        digest: '0xcongested',
        status: {
          error: {
            $kind: 'ExecutionCancelledDueToSharedObjectCongestion',
            message: 'ExecutionCancelledDueToSharedObjectCongestion',
          },
        },
      },
    };
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
      sui: makeMockSui(undefined, execResult),
    });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorCongestionError);
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 10b: Path A — top-level throw does NOT record ONCHAIN_REVERT ──────

  it('Path A: top-level executeTransaction throw does not record ONCHAIN_REVERT', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    const abuseBlocker = makeMockAbuseBlocker();
    // Mock executeTransaction to throw (simulates RPC/network error)
    const sui = makeMockSui();
    sui.executeTransaction = vi.fn().mockRejectedValue(new Error('connection refused'));
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
      abuseBlocker,
      sui,
    });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow('connection refused');
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
    // ONCHAIN_REVERT must NOT be recorded — Path A is RPC/network, not on-chain revert
    expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalledWith(
      CLIENT_IP,
      { kind: 'address', address: SENDER },
      'ONCHAIN_REVERT',
    );
  });

  // ── 11: Slot checkin on success ────────────────────────────────────────

  it('always checks in slot on success', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
    });

    await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    );
    expect(sponsorPool.checkin).toHaveBeenCalledTimes(1);
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 12: Slot checkin on preflight error ────────────────────────────────

  it('checks in slot even when preflight fails (after consume)', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    const failedSim = {
      Transaction: {
        digest: '0xfail',
        effects: { status: { success: false, error: { message: 'Fail' } } },
      },
    };
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
      sui: makeMockSui(failedSim),
    });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow();
    expect(sponsorPool.checkin).toHaveBeenCalledTimes(1);
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 13: Slot checkin on onchain error ──────────────────────────────────

  it('checks in slot even when transaction reverts (after consume)', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    const execResult = {
      Transaction: {
        digest: '0xrevert2',
        effects: {
          status: { success: false, error: { message: 'Abort' } },
          gasUsed: { computationCost: '1', storageCost: '1', storageRebate: '0' },
        },
      },
    };
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
      sui: makeMockSui(undefined, execResult),
    });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow();
    expect(sponsorPool.checkin).toHaveBeenCalledTimes(1);
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 14: Invalid txBytes format ─────────────────────────────────────────

  it('throws SponsorPreflightError on invalid txBytes format', async () => {
    const ctx = makeMockContext();
    await expect(
      handleSponsor(
        ctx,
        { txBytes: '!!!not-base64!!!', userSignature: 'dummySig', receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorPreflightError);
    expect(ctx.sponsorPool.checkin).not.toHaveBeenCalled();
  });

  // ── 15: Explicit sender binding — signature signer must equal canonical tx.sender ─

  it('throws SponsorValidationError when signer is not the canonical tx.sender (explicit sender binding)', async () => {
    // buildValidTx defaults tx.sender to SENDER. Signing with sponsorKeypair
    // produces a signature that is NOT for SENDER, so the explicit sender
    // binding (step 2.5 in sponsor.ts) must reject before consume().
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const { signature: wrongSig } = await sponsorKeypair.signTransaction(txBytes);
    const ctx = makeMockContext({ prepareStore: makeMockPrepareStore(prepared, prepared) });
    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: wrongSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorValidationError);
    expect((err as SponsorValidationError).code).toBe('SENDER_SIGNATURE_INVALID');
    // No consume attempted — slot is still owned by the prepare flow.
    expect(ctx.sponsorPool.checkin).not.toHaveBeenCalled();
  });

  // ── 15b: store senderAddress drift must reject before consume() ────────

  it('rejects when store senderAddress diverges from canonical tx.sender with RECEIPT_SESSION_MISMATCH', async () => {
    // Whether the divergence is caused by store corruption or by a
    // leaked-receiptId attacker submitting their own bytes, the shape of
    // destructive cleanup authority must stay the same: only a caller
    // whose tx-derived sender matches the stored prepare-time sender
    // may reach consume(). Otherwise consume()'s hash_mismatch branch
    // becomes an unauthenticated session-kill vector.
    //
    // The gate therefore rejects pre-consume and preserves the entry so
    // that the legitimate owner (if any) can still retry. Abuse is
    // attributed IP-only because `tx.sender` is not hash-bound yet.
    const ATTACKER_ADDRESS = '0x' + 'aa'.repeat(32);
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash, { senderAddress: ATTACKER_ADDRESS });
    const userSig = await buildValidSignature(txBytes);
    const prepareStore = makeMockPrepareStore(prepared, prepared);
    const abuseBlocker = makeMockAbuseBlocker();
    const ctx = makeMockContext({ prepareStore, abuseBlocker });

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorValidationError);
    expect((err as SponsorValidationError).code).toBe('RECEIPT_SESSION_MISMATCH');
    // consume() must NOT be reached; prepared entry is preserved.
    expect(prepareStore.consume).not.toHaveBeenCalled();
    expect(prepareStore.evictPreparedEntry).not.toHaveBeenCalled();
    // IP-only abuse attribution — no address-level record pre-hash-bind.
    expect(abuseBlocker.recordSponsorFailure).toHaveBeenCalledWith(
      CLIENT_IP,
      undefined,
      'RECEIPT_SESSION_MISMATCH',
      undefined,
    );
  });

  // ── 16: Abuse recording policy ─────────────────────────────────────────

  it('does NOT record abuse on PREPARED_TX_NOT_FOUND or PREPARED_TX_EXPIRED', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);

    // not_found path
    const blocker1 = makeMockAbuseBlocker();
    const ctx1 = makeMockContext({
      prepareStore: makeMockPrepareStore(null),
      abuseBlocker: blocker1,
    });
    await handleSponsor(
      ctx1,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch(() => {});
    expect(blocker1.recordSponsorFailure).not.toHaveBeenCalled();

    // expired path
    const blocker2 = makeMockAbuseBlocker();
    const ctx2 = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, 'expired'),
      abuseBlocker: blocker2,
    });
    await handleSponsor(
      ctx2,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch(() => {});
    expect(blocker2.recordSponsorFailure).not.toHaveBeenCalled();
  });

  // ── 17: validationFingerprint is not part of GenericPreparedTxEntry ────
  //
  // The sponsor path works with entries that have no fingerprint field.
  // The reader tolerates extra fields via ...rest spread.
  //
  // This test verifies the current-writer case: a normally constructed entry
  // (no fingerprint field) goes through the sponsor flow without any
  // fingerprint-related rejection.

  it('sponsor proceeds without validationFingerprint field (happy path)', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
    });

    const result = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    );

    expect(result.digest).toBe('0xdigest123');
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 17b: drift classification — L2 env drift → REPREPARE_REQUIRED ─
  //
  // REPREPARE_REQUIRED is the canonical response for ALL post-consume L2
  // failures. Rolling-deploy config change (e.g. fee adjustment) causes the
  // sponsor's freshly computed validation data to differ from PTB-embedded
  // values. After hash-binding it cannot be user manipulation, so:
  //   - Response: REPREPARE_REQUIRED
  //   - No abuse recorded
  //   - SPONSOR_DRIFT_OBSERVED logged with stage='l2_settle_args' + an L2 subcode
  //
  // This test uses a ctx whose config returns a different protocolFlatFeeMist
  // than the PTB embeds — triggering an L2 fee field mismatch.

  it('L2 env drift (fee config changed) → REPREPARE_REQUIRED, no abuse, SPONSOR_DRIFT_OBSERVED', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker();
    const sponsorPool = makeMockSponsorPool();

    // Override getConfig to return a different protocolFlatFeeMist — simulates
    // a rolling deploy that changed the fee config after /prepare committed.
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      abuseBlocker,
      sponsorPool,
    });
    (ctx.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageId: MOCK_CONFIG.packageId,
      configId: MOCK_CONFIG.configId,
      maxClaimMist: MOCK_CONFIG.maxClaimMist,
      minSettleMist: MOCK_CONFIG.minSettleMist,
      maxHostFeeMist: MOCK_CONFIG.maxHostFeeMist,
      protocolFlatFeeMist: MOCK_CONFIG.protocolFlatFeeMist + 1n, // drifted fee
      configVersion: MOCK_CONFIG.configVersion,
      maxSpreadBps: MOCK_CONFIG.maxSpreadBps,
    });

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorValidationError);
    expect((err as SponsorValidationError).code).toBe('REPREPARE_REQUIRED');

    // Post-consume drift: no abuse counter incremented
    expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalled();

    // Slot checked in despite the error
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));

    // Structured observability: SPONSOR_DRIFT_OBSERVED must be emitted
    const driftLog = consoleInfoSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry['event'] === 'SPONSOR_DRIFT_OBSERVED');
    expect(driftLog).toBeDefined();
    expect(driftLog!['stage']).toBe('l2_settle_args');
    expect(typeof driftLog!['subcode']).toBe('string'); // L2_PROTOCOL_FEE_MISMATCH or similar
    expect(driftLog!['receipt_id']).toBe(PAYMENT_ID);
  });

  it.each([
    {
      label: 'wrong config object id',
      buildOptions: { configId: '0x' + '12'.repeat(32) },
      expectedStage: 'l2_settle_args',
      expectedSubcode: 'L2_WRONG_CONFIG',
    },
    {
      label: 'wrong registry object id',
      buildOptions: { vaultRegistryId: '0x' + '13'.repeat(32) },
      expectedStage: 'l2_settle_args',
      expectedSubcode: 'L2_WRONG_REGISTRY',
    },
    {
      label: 'wrong settlement payout recipient',
      buildOptions: { settlementPayoutRecipient: '0x' + '14'.repeat(32) },
      expectedStage: 'l2_settle_args',
      expectedSubcode: 'L2_WRONG_RECIPIENT',
    },
    {
      label: 'wrong package id',
      buildOptions: { packageId: '0x' + '15'.repeat(32) },
      expectedStage: 'l1_ptb_structure',
      expectedSubcode: 'L1_NO_SETTLE',
    },
  ])(
    'tx-bound $label → REPREPARE_REQUIRED, no abuse, SPONSOR_DRIFT_OBSERVED',
    async ({ buildOptions, expectedStage, expectedSubcode }) => {
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS, buildOptions);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);
      const abuseBlocker = makeMockAbuseBlocker();
      const sponsorPool = makeMockSponsorPool();
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        abuseBlocker,
        sponsorPool,
      });

      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SponsorValidationError);
      expect((err as SponsorValidationError).code).toBe('REPREPARE_REQUIRED');
      expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalled();
      expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));

      const driftLog = consoleInfoSpy.mock.calls
        .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
        .find((entry) => entry['event'] === 'SPONSOR_DRIFT_OBSERVED');
      expect(driftLog).toBeDefined();
      expect(driftLog!['stage']).toBe(expectedStage);
      expect(driftLog!['subcode']).toBe(expectedSubcode);
      expect(driftLog!['receipt_id']).toBe(PAYMENT_ID);
    },
  );

  // ── 17c: drift classification — L2 env drift → REPREPARE_REQUIRED ─
  //
  // If the sponsor instance's env (allowedSettlementSwapPaths, packageId) has changed
  // since /prepare, the PTB that was valid at prepare time may fail L1
  // structural checks against the new env. This is server-side drift —
  // hash-bound bytes cannot have been tampered. Response: REPREPARE_REQUIRED.

  it('L2 route-table drift → REPREPARE_REQUIRED, no abuse', async () => {
    // Build a swap TX valid for SWAP_ALLOWED_ROUTE
    const { encodedTxBytes, txBytes, txHash } = await buildAddressBalanceSwapTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash, {
      executionPathKey: _buildExecutionPathKey(SWAP_ALLOWED_ROUTE),
    });
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker();
    const sponsorPool = makeMockSponsorPool();

    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      abuseBlocker,
      sponsorPool,
    });
    // Simulate route-table drift by configuring a different route.
    // Use a non-empty list so L2_UNAUTHORIZED_SETTLEMENT_SWAP_PATH fires (info level)
    // not L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED (warn level).
    ctx.allowedSettlementSwapPaths = [
      {
        tokenType: '0x' + 'aa'.repeat(32) + '::other::OTHER',
        hops: ['0x' + 'aa'.repeat(32)],
        settlementSwapDirection: 'baseForQuote',
      },
    ];

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorValidationError);
    expect((err as SponsorValidationError).code).toBe('REPREPARE_REQUIRED');

    // No abuse — hash-bound drift
    expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalled();

    // SPONSOR_DRIFT_OBSERVED logged
    const driftLog = consoleInfoSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry['event'] === 'SPONSOR_DRIFT_OBSERVED');
    expect(driftLog).toBeDefined();
    expect(typeof driftLog!['subcode']).toBe('string');
    expect(driftLog!['receipt_id']).toBe(PAYMENT_ID);
  });

  // ── 18: L3 nonloss failure from tx-derived values → L3_NONLOSS_VIOLATION ──
  //
  // L3 reads gasVarianceFixedMist, slippageBufferMist, and
  // executionCostClaim from the parsed settleArgs (tx-derived). This test proves
  // that the decision comes from the PTB itself — the store copy is set
  // to "correct" values so the only way L3 can fail is if the tx-derived
  // side of the check is authoritative.

  it('rejects with L3_NONLOSS_VIOLATION when tx-derived executionCostClaim is below required', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS, {
      // tx-derived executionCostClaim (10_000n) is far below preflight simGas
      // (~4_500_000n from the mock) + gasVarianceFixed (250_000n) + slippage (0n).
      settleOverrides: { executionCostClaim: 10_000n },
    });
    // Store copy is deliberately "correct" so that the failure can only
    // come from the tx-derived side of the check.
    const prepared = makePreparedEntry(txHash, {
      executionCostClaim: 5_250_000n,
      simGas: 5_000_000n,
      gasVarianceFixedMist: 250_000n,
      slippageBufferMist: 0n,
    });
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
    });

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorValidationError);
    expect((err as SponsorValidationError).code).toBe('L3_NONLOSS_VIOLATION');
    expect(sponsorPool.sign).not.toHaveBeenCalled();

    // Slot must be checked in even on L3 failure
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 18b: L3 ignores forged store audit fields → decision is tx-derived ──
  //
  // A coherent tx-derived payload must pass even when non-authoritative
  // store audit copies are forged. L3 must not read store copies.

  it('L3 nonloss passes when tx-derived values are coherent, even if store audit copies are zero', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash, {
      // Forge store audit fields to zero — should be ignored.
      executionCostClaim: 0n,
      gasVarianceFixedMist: 0n,
      slippageBufferMist: 0n,
    });
    const userSig = await buildValidSignature(txBytes);
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
    });

    const result = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    );
    expect(result.digest).toBe('0xdigest123');
  });

  // ── 19: L3 fail-closed when gasUsed is absent ─────────────────────────

  it('throws SponsorPreflightError when preflight has no gasUsed (L3 fail-closed)', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);

    // Simulate a response where effects has no gasUsed
    const simResult = {
      Transaction: {
        digest: '0xdigest_no_gas',
        status: { success: true },
        effects: {}, // no gasUsed
      },
    };
    const sponsorPool = makeMockSponsorPool();
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sui: makeMockSui(simResult, makeSuccessSimResult()),
      sponsorPool,
    });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorPreflightError);

    // Slot must be checked in
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 20: Negative raw simGas clamp to 0 ──────────────────────────────────

  it('clamps negative raw simGas to 0 and passes L3 (storageRebate > comp+storage)', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    // prepared with simGas=0, gasVariance=0 — edge case from rebate-heavy TX.
    // executionCostClaim must match txBytes settle value (5_250_000n) for equality binding.
    const prepared = makePreparedEntry(txHash, {
      simGas: 0n,
      gasVarianceFixedMist: 0n,
      slippageBufferMist: 0n,
    });
    const userSig = await buildValidSignature(txBytes);

    // Simulation returns storageRebate > comp+storage → negative raw simGas
    const negativeGasSimResult = {
      Transaction: {
        digest: '0xdigest_negative_gas',
        status: { success: true },
        effects: {
          gasUsed: {
            computationCost: '1000000',
            storageCost: '500000',
            storageRebate: '3000000', // 3M > 1M + 0.5M = 1.5M → raw = -1.5M → clamp to 0
          },
        },
      },
    };
    const sponsorPool = makeMockSponsorPool();
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
      sui: makeMockSui(negativeGasSimResult, negativeGasSimResult),
    });

    const result = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    );

    expect(result.digest).toBe('0xdigest_negative_gas');
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── orderId echo ────────────────────────────────────────────────────

  it('echoes orderId from stored PreparedTxEntry in SponsorResult', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS, {
      orderId: 'payment-xyz-789',
    });
    const prepared = makePreparedEntry(txHash, { orderId: 'payment-xyz-789' });
    const userSig = await buildValidSignature(txBytes);
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
    });

    const result = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    );

    expect(result.orderId).toBe('payment-xyz-789');
  });

  it('SponsorResult.orderId is undefined when stored orderId is null', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash, { orderId: null });
    const userSig = await buildValidSignature(txBytes);
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
    });

    const result = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    );

    expect(result.orderId).toBeUndefined();
  });

  // ── orderId mismatch: post-consume drift, not tampering ────────────
  //
  // orderId mismatch between PTB and stored entry is an
  // L2 post-consume failure. The submitted bytes are hash-bound, so the
  // PTB's orderIdHash is what the user signed. If the stored orderId
  // differs, it means the store was corrupted (coordination metadata
  // failure) — not user manipulation. Response: REPREPARE_REQUIRED,
  // no abuse, SPONSOR_DRIFT_OBSERVED.

  it('PTB orderIdHash mismatches stored orderId → REPREPARE_REQUIRED, no abuse (post-consume drift)', async () => {
    // PTB built with orderId='ptb-order-A' → sha256('ptb-order-A') embedded
    // Stored entry has orderId='stored-order-B' → hash mismatch in L2
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS, {
      orderId: 'ptb-order-A',
    });
    const prepared = makePreparedEntry(txHash, { orderId: 'stored-order-B' });
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker();
    const sponsorPool = makeMockSponsorPool();
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      abuseBlocker,
      sponsorPool,
    });

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorValidationError);
    expect((err as SponsorValidationError).code).toBe('REPREPARE_REQUIRED');

    // Post-consume drift: no abuse counter incremented
    expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalled();

    // SPONSOR_DRIFT_OBSERVED must be logged
    const driftLog = consoleInfoSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .find((entry) => entry['event'] === 'SPONSOR_DRIFT_OBSERVED');
    expect(driftLog).toBeDefined();
    expect(driftLog!['stage']).toBe('l2_settle_args');

    // Slot must be checked in
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });
  // ─────────────────────────────────────────────
  // Step 7: SponsorLeaseExpiredError propagation
  // ─────────────────────────────────────────────

  it('propagates SponsorLeaseExpiredError when pool.sign() rejects with expired lease', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const userSig = await buildValidSignature(txBytes);

    const prepared = makePreparedEntry(txHash);
    const sponsorPool = makeMockSponsorPool();
    // pool.sign() rejects with SponsorLeaseExpiredError (typed — no string matching)
    (sponsorPool.sign as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SponsorLeaseExpiredError(SLOT_ID),
    );

    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
    });

    await expect(
      handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ),
    ).rejects.toThrow(SponsorLeaseExpiredError);

    // Slot must still be checked in (outer finally cleanup)
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  it('SponsorLeaseExpiredError has correct code property', () => {
    const err = new SponsorLeaseExpiredError('slot-test');
    expect(err.code).toBe('LEASE_EXPIRED');
    expect(err.name).toBe('SponsorLeaseExpiredError');
    expect(err.message).toContain('slot-test');
  });

  // ── 22b: Preflight abort 101 → subcode: CLAIM_WOULD_EXCEED_MAX ───────

  it('throws SponsorPreflightError with subcode CLAIM_WOULD_EXCEED_MAX on abort 101 in preflight', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker();
    const sponsorPool = makeMockSponsorPool();
    const failedSim = {
      Transaction: {
        digest: '0xfail_claim',
        status: {
          success: false,
          error: {
            message:
              'MoveAbort(0x1111111111111111111111111111111111111111111111111111111111111111::settle, 101) in command 5',
          },
        },
        effects: {
          gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
        },
      },
    };
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      abuseBlocker,
      sponsorPool,
      sui: makeMockSui(failedSim),
    });

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorPreflightError);
    expect((err as SponsorPreflightError).subcode).toBe('CLAIM_WOULD_EXCEED_MAX');
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 22c: On-chain revert abort 101 → subcode: CLAIM_WOULD_EXCEED_MAX ──

  it('throws SponsorOnchainError with subcode CLAIM_WOULD_EXCEED_MAX on abort 101 in execution', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    const abuseBlocker = makeMockAbuseBlocker();
    const execResult = {
      Transaction: {
        digest: '0xrevert_claim',
        effects: {
          status: {
            success: false,
            error: {
              message:
                'MoveAbort(0x1111111111111111111111111111111111111111111111111111111111111111::settle, 101) in command 3',
            },
          },
          gasUsed: { computationCost: '1000000', storageCost: '1000000', storageRebate: '500000' },
        },
      },
    };
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
      abuseBlocker,
      sui: makeMockSui(undefined, execResult),
    });

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorOnchainError);
    expect((err as SponsorOnchainError).subcode).toBe('CLAIM_WOULD_EXCEED_MAX');
    expect((err as SponsorOnchainError).digest).toBe('0xrevert_claim');
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 23: Preflight abort 110 → subcode: SPREAD_EXCEEDED ────────────────

  it('throws SponsorPreflightError with subcode SPREAD_EXCEEDED on abort 110 in preflight', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker();
    const sponsorPool = makeMockSponsorPool();
    const failedSim = {
      Transaction: {
        digest: '0xfail_spread',
        status: {
          success: false,
          error: {
            message:
              'MoveAbort(0x1111111111111111111111111111111111111111111111111111111111111111::settle, 110) in command 5',
          },
        },
        effects: {
          gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
        },
      },
    };
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      abuseBlocker,
      sponsorPool,
      sui: makeMockSui(failedSim),
    });

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorPreflightError);
    expect((err as SponsorPreflightError).subcode).toBe('SPREAD_EXCEEDED');
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 24: On-chain revert abort 110 → subcode: SPREAD_EXCEEDED ──────────

  it('throws SponsorOnchainError with subcode SPREAD_EXCEEDED on abort 110 in execution', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    const abuseBlocker = makeMockAbuseBlocker();
    const execResult = {
      Transaction: {
        digest: '0xrevert_spread',
        effects: {
          status: {
            success: false,
            error: {
              message:
                'MoveAbort(0x1111111111111111111111111111111111111111111111111111111111111111::settle, 110) in command 3',
            },
          },
          gasUsed: { computationCost: '1000000', storageCost: '1000000', storageRebate: '500000' },
        },
      },
    };
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
      abuseBlocker,
      sui: makeMockSui(undefined, execResult),
    });

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorOnchainError);
    expect((err as SponsorOnchainError).subcode).toBe('SPREAD_EXCEEDED');
    expect((err as SponsorOnchainError).digest).toBe('0xrevert_spread');
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 25: Preflight abort 12 (DeepBook min_out) → subcode: SLIPPAGE_EXCEEDED ─

  it('throws SponsorPreflightError with subcode SLIPPAGE_EXCEEDED on abort 12 in preflight', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const abuseBlocker = makeMockAbuseBlocker();
    const sponsorPool = makeMockSponsorPool();
    const failedSim = {
      Transaction: {
        digest: '0xfail_slippage',
        status: {
          success: false,
          error: {
            message:
              "Transaction resolution failed: MoveAbort in 5th command, abort code: 12, in '0x1111111111111111111111111111111111111111111111111111111111111111::pool::swap_exact_quantity' (instruction 165)",
          },
        },
        effects: {
          gasUsed: { computationCost: '1000', storageCost: '500', storageRebate: '200' },
        },
      },
    };
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      abuseBlocker,
      sponsorPool,
      sui: makeMockSui(failedSim),
    });

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorPreflightError);
    expect((err as SponsorPreflightError).subcode).toBe('SLIPPAGE_EXCEEDED');
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 26: On-chain revert abort 12 (DeepBook min_out) → subcode: SLIPPAGE_EXCEEDED ─

  it('throws SponsorOnchainError with subcode SLIPPAGE_EXCEEDED on abort 12 in execution', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    const abuseBlocker = makeMockAbuseBlocker();
    const execResult = {
      Transaction: {
        digest: '0xrevert_slippage',
        effects: {
          status: {
            success: false,
            error: {
              message:
                "Transaction resolution failed: MoveAbort in 5th command, abort code: 12, in '0x1111111111111111111111111111111111111111111111111111111111111111::pool::swap_exact_quantity' (instruction 165)",
            },
          },
          gasUsed: { computationCost: '1000000', storageCost: '1000000', storageRebate: '500000' },
        },
      },
    };
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      sponsorPool,
      abuseBlocker,
      sui: makeMockSui(undefined, execResult),
    });

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorOnchainError);
    expect((err as SponsorOnchainError).subcode).toBe('SLIPPAGE_EXCEEDED');
    expect((err as SponsorOnchainError).digest).toBe('0xrevert_slippage');
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ── 27: MODE_MISMATCH — promotion entry rejected by generic sponsor ───

  it('throws MODE_MISMATCH when consume returns a promotion-mode entry', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const promoted: PreparedTxEntry = {
      issuedAt: Date.now(),
      receiptId: PAYMENT_ID,
      senderAddress: SENDER,
      executionCostClaim: 5_250_000n,
      simGas: 5_000_000n,
      gasVarianceFixedMist: 250_000n,
      slippageBufferMist: 0n,
      grossGas: 7_000_000n,
      txBytesHash: txHash,
      slotId: SLOT_ID,
      sponsorAddress: SPONSOR_ADDRESS,
      clientIp: CLIENT_IP,
      executionPathKey: 'promotion:promo-test',
      orderId: null,
      nonce: 0n,
      mode: 'promotion',
      promotionId: 'promo-test',
      userId: 'user-1',
    };
    const userSig = await buildValidSignature(txBytes);
    const sponsorPool = makeMockSponsorPool();
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(promoted, promoted),
      sponsorPool,
    });

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SponsorValidationError);
    expect((err as SponsorValidationError).code).toBe('MODE_MISMATCH');
    // Slot must be returned
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
  });

  // ─────────────────────────────────────────────────────────────
  // Pre-consume victim-targeting immunity
  //
  // Regression guards for the pre/post-consume boundary: any failure
  // before consume() succeeds must not land address-level abuse or
  // blocks onto an arbitrary victim address, because `tx.sender` is
  // still unbound until the txBytesHash is atomically verified.
  // ─────────────────────────────────────────────────────────────

  describe('pre-consume attribution is IP-only (victim-targeting immunity)', () => {
    const VICTIM_ADDRESS = '0x' + 'bb'.repeat(32);

    it('SENDER_SIGNATURE_INVALID with attacker-chosen tx.sender does not attribute to victim', async () => {
      // Attacker crafts txBytes with tx.sender = VICTIM and signs with a
      // different key (sponsorKeypair). verifySenderSignature must reject
      // because the sig is not from VICTIM. The abuse record must NOT
      // attribute to VICTIM — that would let an attacker block an
      // arbitrary address by spamming invalid signatures.
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS, {
        txSender: VICTIM_ADDRESS,
      });
      const prepared = makePreparedEntry(txHash, { senderAddress: VICTIM_ADDRESS });
      const { signature: attackerSig } = await sponsorKeypair.signTransaction(txBytes);
      const abuseBlocker = makeMockAbuseBlocker();
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        abuseBlocker,
      });

      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: attackerSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SponsorValidationError);
      expect((err as SponsorValidationError).code).toBe('SENDER_SIGNATURE_INVALID');
      // consume() must NOT have been reached — slot stays owned by the
      // prepare flow so that the victim-original prepare can still be
      // sponsored by a legitimate caller.
      expect(ctx.prepareStore.consume).not.toHaveBeenCalled();
      // IP-only attribution.
      expect(abuseBlocker.recordSponsorFailure).toHaveBeenCalledWith(
        CLIENT_IP,
        undefined,
        'SENDER_SIGNATURE_INVALID',
        undefined,
      );
      // VICTIM must not be targeted.
      expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalledWith(
        CLIENT_IP,
        { kind: 'address', address: VICTIM_ADDRESS },
        expect.anything(),
        expect.anything(),
      );
    });

    it('hash_mismatch does not attribute abuse to the tx-sender address', async () => {
      // The abuse-attribution contract at hash_mismatch must be IP-only
      // regardless of what `tx.sender` is encoded in the submitted bytes,
      // because consume() just proved those bytes do NOT match the stored
      // commit — there is no valid hash binding between the submitted
      // `tx.sender` and any prepare identity at this point.
      //
      // Test setup: a legitimate signature-passing path whose consume()
      // returns 'hash_mismatch' (mocked). The test asserts that
      // `recordSponsorFailure` is called IP-only and is NOT called with
      // the tx-derived sender as the address, even though the signature
      // happened to verify against that address pre-consume.
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);
      const abuseBlocker = makeMockAbuseBlocker();
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, 'hash_mismatch'),
        abuseBlocker,
      });

      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SponsorValidationError);
      expect((err as SponsorValidationError).code).toBe('TAMPERING_DETECTED');
      // IP-only attribution.
      expect(abuseBlocker.recordSponsorFailure).toHaveBeenCalledWith(
        CLIENT_IP,
        undefined,
        'TAMPERING_DETECTED',
        undefined,
      );
      // The tx-derived sender must NOT be targeted even though the sig
      // verified against it — the hash binding is what upgrades tx.sender
      // to authority, and consume() just rejected it.
      expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalledWith(
        CLIENT_IP,
        { kind: 'address', address: SENDER },
        'TAMPERING_DETECTED',
        expect.anything(),
      );
    });

    it('pre-consume block check is IP-only (attacker-blocked address does not reject victim)', async () => {
      // The victim has a clean IP and a clean sender. The mock blocker
      // reports `checkSubject({ kind: 'address', address: VICTIM }) = blocked`
      // but `checkIp(IP) = clean`. The pre-consume call is IP-only
      // because submitted bytes are not hash-bound until consume();
      // address-level blocking is enforced after canonical sender
      // validation. (This is the generic `/relay/sponsor` route, where
      // post-consume non-IP attribution is keyed by the hash-bound
      // `senderAddress` — the address subject kind. Promotion routes
      // record against the studio_user subject kind instead.)
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);

      // checkSubject(address=SENDER) → blocked; checkIp → clean.
      const abuseBlocker: AbuseBlockerAdapter = {
        checkIp: vi.fn().mockResolvedValue({ blocked: false }),
        checkSubject: vi
          .fn()
          .mockImplementation(
            async (subject: import('../src/store/abuseBlockTypes.js').AbuseSubject) =>
              subject.kind === 'address' && subject.address === SENDER
                ? { blocked: true, retryAfterMs: 10_000 }
                : { blocked: false },
          ),
        recordSponsorFailure: vi.fn(),
      };
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        abuseBlocker,
      });

      // The request must still get through the pre-consume block check
      // (IP-only) and hit the post-consume address check which does reject.
      // So the net effect is the same rejection for a genuine
      // address-blocked sender — but the rejection happens post-consume
      // and does NOT fire on arbitrary victim addresses in the pre-consume
      // path.
      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SponsorBlockedError);
      // The subject check is only invoked AFTER consume().
      expect(ctx.prepareStore.consume).toHaveBeenCalled();
      expect(abuseBlocker.checkSubject).toHaveBeenCalledWith({
        kind: 'address',
        address: SENDER,
      });
    });

    it('post-consume address block check rejects a hash-bound blocked sender', async () => {
      // Positive control: once the hash is bound, the address check IS
      // authoritative and blocks. This proves that the IP-only pre-consume
      // step did not remove the address-block defence altogether — it
      // just moved it to the safe side of the hash binding.
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);
      const abuseBlocker: AbuseBlockerAdapter = {
        checkIp: vi.fn().mockResolvedValue({ blocked: false }),
        checkSubject: vi.fn().mockResolvedValue({ blocked: true, retryAfterMs: 30_000 }),
        recordSponsorFailure: vi.fn(),
      };
      const sponsorPool = makeMockSponsorPool();
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        abuseBlocker,
        sponsorPool,
      });

      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SponsorBlockedError);
      expect((err as SponsorBlockedError).retryAfterMs).toBe(30_000);
      // consume() happened before the block rejection.
      expect(ctx.prepareStore.consume).toHaveBeenCalled();
      // Slot was returned on the blocked path.
      expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, expect.any(String));
    });

    it('leaked receiptId alone cannot destroy session: RECEIPT_SESSION_MISMATCH before consume()', async () => {
      // Attack model: attacker knows only the `receiptId` (leaked through
      // proxy logs, shared dev env, or similar). They cannot produce a
      // valid signature for the victim's sender, but they CAN self-sign
      // any TX of their own. The pre-consume sender gate prevents those
      // bytes from reaching consume() and destroying the victim's entry.
      //
      // The gate must:
      //   - reject with RECEIPT_SESSION_MISMATCH (422) before consume()
      //   - leave the prepared entry intact for the legitimate caller
      //   - attribute abuse IP-only (txSender is still unbound here)
      const attackerKeypair = Ed25519Keypair.generate();
      const ATTACKER_ADDRESS = attackerKeypair.toSuiAddress();
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS, {
        txSender: ATTACKER_ADDRESS,
      });
      // Attacker signs THEIR OWN tx — signature verifies against ATTACKER.
      const { signature: attackerSig } = await attackerKeypair.signTransaction(txBytes);
      // Prepared entry was committed by the legitimate user (SENDER) in /prepare.
      const prepared = makePreparedEntry(txHash, { senderAddress: SENDER });
      const abuseBlocker = makeMockAbuseBlocker();
      const prepareStore = makeMockPrepareStore(prepared, prepared);
      const ctx = makeMockContext({ prepareStore, abuseBlocker });

      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: attackerSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      // New pre-consume gate: classified 422 without reaching consume().
      expect(err).toBeInstanceOf(SponsorValidationError);
      expect((err as SponsorValidationError).code).toBe('RECEIPT_SESSION_MISMATCH');
      // Entry must survive — the legitimate caller can still sponsor it.
      expect(prepareStore.consume).not.toHaveBeenCalled();
      expect(prepareStore.evictPreparedEntry).not.toHaveBeenCalled();
      // IP-only attribution — neither victim nor attacker-chosen tx.sender
      // may receive address-level abuse before hash-binding proves identity.
      expect(abuseBlocker.recordSponsorFailure).toHaveBeenCalledWith(
        CLIENT_IP,
        undefined,
        'RECEIPT_SESSION_MISMATCH',
        undefined,
      );
      expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalledWith(
        CLIENT_IP,
        { kind: 'address', address: SENDER },
        expect.anything(),
        expect.anything(),
      );
      expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalledWith(
        CLIENT_IP,
        ATTACKER_ADDRESS,
        expect.anything(),
        expect.anything(),
      );
    });
  });

  // ── Post-submit gasUsed-missing → SPONSOR_FAILED 500 ────────────────
  //
  // Locks four characteristics of the post-submit `success + !gasUsed`
  // path:
  //   1. Error classification: SponsorValidationError(SPONSOR_FAILED, 500)
  //      — NOT SponsorPreflightError (would invite unsafe retries).
  //   2. Observability: `SPONSOR_EXEC_GAS_USED_MISSING` structured warn
  //      event with the locked payload (route, digest, receipt_id,
  //      sender, client_ip, slot_id, sponsor_address, execution_path_key).
  //   3. No abuse attribution: server-observed edge case on a successfully
  //      submitted TX — must not increment any abuse counter.
  //   4. Cleanup: slot is checked in via the finally block.

  it('post-submit gasUsed-missing: SPONSOR_FAILED 500 + structured warn log + no abuse + slot checkin', async () => {
    const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
    const prepared = makePreparedEntry(txHash);
    const userSig = await buildValidSignature(txBytes);

    // Execution succeeds but effects have no gasUsed — Sui gRPC edge case.
    const execResultNoGas = {
      Transaction: {
        digest: '0xdigest_exec_no_gas',
        status: { success: true },
        effects: {}, // no gasUsed
      },
    };
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sponsorPool = makeMockSponsorPool();
    const abuseBlocker = makeMockAbuseBlocker();
    const ctx = makeMockContext({
      prepareStore: makeMockPrepareStore(prepared, prepared),
      // Preflight simulation succeeds WITH gasUsed (postconsume passes).
      // Execution succeeds WITHOUT gasUsed (sponsor result bug site).
      sui: makeMockSui(undefined, execResultNoGas),
      sponsorPool,
      abuseBlocker,
    });

    const err = await handleSponsor(
      ctx,
      { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
      CLIENT_IP,
    ).catch((e: unknown) => e);

    // (1) Error classification
    expect(err).toBeInstanceOf(SponsorValidationError);
    expect((err as SponsorValidationError).code).toBe('SPONSOR_FAILED');
    expect((err as SponsorValidationError).statusHint).toBe(500);
    expect((err as SponsorValidationError).message).toContain('0xdigest_exec_no_gas');
    expect(err).not.toBeInstanceOf(SponsorPreflightError);

    // (2) Observability: SPONSOR_EXEC_GAS_USED_MISSING warn event with locked payload
    const missingGasLog = consoleWarnSpy.mock.calls
      .map((args: unknown[]) => JSON.parse(args[0] as string) as Record<string, unknown>)
      .find((entry) => entry['event'] === 'SPONSOR_EXEC_GAS_USED_MISSING');
    expect(missingGasLog).toBeDefined();
    expect(missingGasLog!['route']).toBe('generic');
    expect(missingGasLog!['digest']).toBe('0xdigest_exec_no_gas');
    expect(missingGasLog!['receipt_id']).toBe(PAYMENT_ID);
    expect(missingGasLog!['sender']).toBe(SENDER);
    expect(missingGasLog!['client_ip']).toBe(CLIENT_IP);
    expect(missingGasLog!['slot_id']).toBe(SLOT_ID);
    expect(missingGasLog!['sponsor_address']).toBe(SPONSOR_ADDRESS);
    expect(missingGasLog!['execution_path_key']).toBe('credit');

    // (3) No abuse attribution on this path
    expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalled();

    // (4) Slot is checked in with the committed txBytesHash
    expect(sponsorPool.checkin).toHaveBeenCalledWith(SLOT_ID, PAYMENT_ID, txHash);

    consoleWarnSpy.mockRestore();
  });

  // ── Sponsor result host callback behavior ──────────────────────────
  //
  // `ctx.onSponsorResult` is expected to:
  //   (a) invoked on every sponsor result path that reaches post-consume,
  //   (b) with an outcome classification that reflects the slot's real
  //       on-chain state (success preserved across post-success throws),
  //   (c) strictly after `sponsorPool.checkin()`,
  //   (d) never throws — a buggy host implementation must not replace
  //       or mask the handler's primary result/error.
  describe('host sponsor result callback (onSponsorResult)', () => {
    function collectingCallback(): {
      callback: SponsorResultCallback;
      calls: SponsorResultMetadata[];
      order: string[];
    } {
      const calls: SponsorResultMetadata[] = [];
      const order: string[] = [];
      return {
        calls,
        order,
        callback: (metadata) => {
          order.push('callback');
          calls.push(metadata);
        },
      };
    }

    it('happy path → outcome=success with digest and gasUsed, invoked after safeSlotCheckin', async () => {
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);
      const sponsorPool = makeMockSponsorPool();
      const order: string[] = [];
      // Wrap checkin so we can assert callback runs after it.
      const originalCheckin = sponsorPool.checkin;
      sponsorPool.checkin = vi.fn(async (...args: Parameters<typeof originalCheckin>) => {
        order.push('checkin');
        return originalCheckin(...args);
      });
      const probe = collectingCallback();
      probe.order = order;
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sponsorPool,
        onSponsorResult: (metadata) => {
          order.push('callback');
          probe.calls.push(metadata);
        },
      });

      await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      );

      expect(probe.calls).toHaveLength(1);
      expect(probe.calls[0]).toMatchObject({
        slotId: SLOT_ID,
        sponsorAddress: SPONSOR_ADDRESS,
        outcome: 'success',
        route: 'generic',
        digest: '0xdigest123',
      });
      // Economics block feeds the sponsored-execution recorder.
      // success path → known economics with grossGas/storageRebate set.
      expect(probe.calls[0].economics.economicsStatus).toBe('known');
      if (probe.calls[0].economics.economicsStatus === 'known') {
        expect(probe.calls[0].economics.grossGasMist).not.toBeNull();
        expect(probe.calls[0].economics.storageRebateMist).not.toBeNull();
        expect(probe.calls[0].economics.recoveredGasMist).toBeDefined();
        expect(probe.calls[0].economics.hostPaidGasMist).toBeDefined();
      }
      // Ordering: pool.checkin fires before callback.
      expect(order).toEqual(['checkin', 'callback']);
    });

    it('post-submit gasUsed-missing → outcome=success (slot balance was consumed)', async () => {
      // This path still reports `success` to the host callback because
      // the slot's balance change is authoritative from submit onwards,
      // even if a later throw reports missing gasUsed.
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);
      const execResultNoGas = {
        Transaction: {
          digest: '0xdigest_exec_no_gas',
          status: { success: true },
          effects: {},
        },
      };
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const probe = collectingCallback();
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sui: makeMockSui(undefined, execResultNoGas),
        onSponsorResult: probe.callback,
      });

      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      // Primary error transport is unchanged (fail-closed 500).
      expect(err).toBeInstanceOf(SponsorValidationError);
      expect((err as SponsorValidationError).code).toBe('SPONSOR_FAILED');

      // Sponsor result callback sees success because the TX really did submit.
      expect(probe.calls).toHaveLength(1);
      expect(probe.calls[0]).toMatchObject({
        slotId: SLOT_ID,
        outcome: 'success',
        digest: '0xdigest_exec_no_gas',
      });
      // Economics block: gasUsed-missing edge path → unknown economics
      // with the SPONSOR_EXEC_GAS_USED_MISSING failureReason.
      expect(probe.calls[0].economics.economicsStatus).toBe('unknown');
      if (probe.calls[0].economics.economicsStatus === 'unknown') {
        expect(probe.calls[0].economics.failureReason).toBe('SPONSOR_EXEC_GAS_USED_MISSING');
      }
      consoleWarnSpy.mockRestore();
    });

    it('on-chain revert → outcome=onchain_revert with digest from error', async () => {
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);
      // `signAndSubmit` classifies an on-chain revert via
      // `tx.effects.status.success === false` on a `Transaction` result.
      const execRevert = {
        Transaction: {
          digest: '0xreverted_digest',
          effects: {
            status: { success: false, error: { message: 'MoveAbort(code: 7)' } },
            gasUsed: {
              computationCost: '1000000',
              storageCost: '1000000',
              storageRebate: '500000',
            },
          },
        },
      };
      const probe = collectingCallback();
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sui: makeMockSui(undefined, execRevert),
        onSponsorResult: probe.callback,
      });

      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SponsorOnchainError);
      expect(probe.calls).toHaveLength(1);
      expect(probe.calls[0].outcome).toBe('onchain_revert');
      expect(probe.calls[0].digest).toBe('0xreverted_digest');
    });

    it('congestion → outcome=congestion', async () => {
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);
      // `signAndSubmit` classifies shared-object congestion via the
      // `$kind: 'FailedTransaction'` wrapper + congestion error kind.
      const execCongestion = {
        $kind: 'FailedTransaction',
        FailedTransaction: {
          digest: '0xcongested',
          status: {
            error: {
              $kind: 'ExecutionCancelledDueToSharedObjectCongestion',
              message: 'ExecutionCancelledDueToSharedObjectCongestion',
            },
          },
        },
      };
      const probe = collectingCallback();
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sui: makeMockSui(undefined, execCongestion),
        onSponsorResult: probe.callback,
      });

      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SponsorCongestionError);
      expect(probe.calls).toHaveLength(1);
      expect(probe.calls[0].outcome).toBe('congestion');
    });

    it('submit-infra exception → outcome=internal_error with submit_infra_unknown marker on sponsor result callback (sponsor signature already issued before throw, TX may have landed)', async () => {
      // Generic submit-infra branch parity check with the promotion
      // handler. `signAndSubmit` issues the sponsor signature inside
      // `pool.sign()` BEFORE calling `executeTransaction()`
      // (`packages/core-api/src/session/sessionPrimitives.ts:285-293`).
      // Any non-congestion `executeTransaction` throw therefore happens
      // post-signature, and the TX may have reached the network and
      // burned gas. The sponsor result callback must see the
      // `submit_infra_unknown` marker so the host recorder can opt this
      // row into Sponsored Executions; the outer-catch fall-through
      // must NOT overwrite the marker with the raw RPC error message.
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);
      const probe = collectingCallback();
      const sui = makeMockSui();
      sui.executeTransaction = vi.fn().mockRejectedValue(new Error('rpc transport error'));
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sui,
        onSponsorResult: probe.callback,
      });

      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('rpc transport error');

      expect(probe.calls).toHaveLength(1);
      expect(probe.calls[0].outcome).toBe('internal_error');
      expect(probe.calls[0].route).toBe('generic');
      expect(probe.calls[0].economics.economicsStatus).toBe('unknown');
      if (probe.calls[0].economics.economicsStatus === 'unknown') {
        expect(probe.calls[0].economics.failureReason).toContain('submit_infra_unknown');
        expect(probe.calls[0].economics.failureReason).toContain('rpc transport error');
      }
    });

    it('pre-sign pool.sign() rejection (SponsorLeaseExpiredError) → sponsor result callback must NOT carry submit_infra_unknown (sponsor signature was never issued)', async () => {
      // Boundary regression: `pool.sign()` runs BEFORE
      // `executeTransaction()` inside `signAndSubmit`
      // (`packages/core-api/src/session/sessionPrimitives.ts:285-289`).
      // A `SponsorLeaseExpiredError` from `pool.sign()` therefore
      // means the sponsor signature was NEVER issued, and the leak-
      // free post-signature submit-infra policy must NOT apply. The
      // host recorder must not see the row as `submit_infra_unknown`,
      // and the sponsor result economics must be classified as
      // `validation_failure` by the outer-catch path (existing
      // classification rule for `SponsorLeaseExpiredError`).
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);
      const probe = collectingCallback();
      const sponsorPool = makeMockSponsorPool();
      sponsorPool.sign = vi.fn().mockRejectedValue(new SponsorLeaseExpiredError(SLOT_ID));
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sponsorPool,
        onSponsorResult: probe.callback,
      });

      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SponsorLeaseExpiredError);
      expect(probe.calls).toHaveLength(1);
      expect(probe.calls[0].outcome).toBe('validation_failure');
      // Critical: NO `submit_infra_unknown` marker. If this assertion
      // ever fires, the recorder would have falsely reported a
      // post-signature gas burn for a request whose sponsor signature
      // was never issued.
      expect(probe.calls[0].economics.economicsStatus).toBe('unknown');
      if (probe.calls[0].economics.economicsStatus === 'unknown') {
        expect(probe.calls[0].economics.failureReason ?? '').not.toContain('submit_infra_unknown');
      }
    });

    it('success path with rebate >= computation+storage clamps hostPaidGasMist to 0 (canonical 0-clamp parity with computeExecutionCostClaim)', async () => {
      // Generic success-path economics regression. The success path
      // builds the recorder row from
      // `buildSettlementEconomicsSnapshot({ gasUsed, ... }).netGas`. The
      // canonical helper `computeExecutionCostClaim(...).simGas` clamps a
      // negative net to 0; the snapshot builder must do the same so a
      // delete-objects-only success TX does not produce negative
      // `hostPaidGasMist` or an inflated `hostNet`.
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);
      const probe = collectingCallback();
      // computation + storage = 800_000; storageRebate = 2_000_000 →
      // rawNet = -1_200_000 → clamp to 0.
      const successExec = {
        Transaction: {
          digest: 'tx-success-rebate',
          status: { success: true },
          effects: {
            gasUsed: {
              computationCost: '500000',
              storageCost: '300000',
              storageRebate: '2000000',
            },
          },
        },
      };
      const sui = makeMockSui(undefined, successExec);
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sui,
        onSponsorResult: probe.callback,
      });

      await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      );

      expect(probe.calls).toHaveLength(1);
      expect(probe.calls[0].outcome).toBe('success');
      expect(probe.calls[0].economics.economicsStatus).toBe('known');
      if (probe.calls[0].economics.economicsStatus === 'known') {
        expect(probe.calls[0].economics.hostPaidGasMist).toBe('0');
        expect(probe.calls[0].economics.grossGasMist).toBe('800000');
        // Raw `storageRebateMist` is preserved verbatim from the
        // on-chain effects (NOT derived as `grossGas - netGas`).
        // `netGas` is clamped to 0 because the Host never pays the
        // user, but the on-chain rebate is the auditable truth and the
        // recorder row must keep it. This was a real regression: the
        // earlier derivation `grossGas - netGas` collapsed to `grossGas`
        // when rebate > grossGas, hiding the actual rebate.
        expect(probe.calls[0].economics.storageRebateMist).toBe('2000000');
      }
    });

    it('SETTLEMENT_ECONOMICS_EXECUTION structured event emits raw gross_gas + raw storage_rebate + clamped net_gas + clamped payout_net for rebate-heavy generic success', async () => {
      // Structured-event payload regression. The earlier round added
      // `storage_rebate` to the log and clarified `net_gas` as the
      // clamped quantity. This test directly inspects the emitted log
      // record so any future drift between the snapshot, the recorder
      // row, and the structured event appears immediately.
      // computation + storage = 800_000; storageRebate = 2_000_000 →
      //   gross_gas = 800_000  (raw)
      //   storage_rebate = 2_000_000 (raw)
      //   net_gas = max(0, 800_000 - 2_000_000) = 0 (clamped)
      //   payout = executionCostClaim + feeCharged (test fixture defaults)
      //   payout_net = payout - net_gas = payout (against the clamped
      //                quantity, NOT raw gross-rebate)
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);
      const successExec = {
        Transaction: {
          digest: 'tx-rebate-event-log',
          status: { success: true },
          effects: {
            gasUsed: {
              computationCost: '500000',
              storageCost: '300000',
              storageRebate: '2000000',
            },
          },
        },
      };
      const sui = makeMockSui(undefined, successExec);
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sui,
      });
      const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      );

      const log = consoleInfoSpy.mock.calls
        .map((args: unknown[]) => {
          try {
            return JSON.parse(args[0] as string) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((entry) => entry && entry['event'] === 'SETTLEMENT_ECONOMICS_EXECUTION');
      expect(log).toBeDefined();
      // Raw on-chain values preserved verbatim.
      expect(log!['gross_gas']).toBe('800000');
      expect(log!['storage_rebate']).toBe('2000000');
      // Clamped host-paid-gas quantity. NOT raw `gross_gas - storage_rebate`
      // (which would be -1_200_000n; the Host never pays the user).
      expect(log!['net_gas']).toBe('0');
      // payout_net derived from the clamped net_gas, so it equals
      // payout exactly. Test fixture's execution_cost_claim_mist + fee_charged.
      const payout = BigInt(log!['payout'] as string);
      expect(BigInt(log!['payout_net'] as string)).toBe(payout);
      // Sanity: the field set is exactly the documented structured-event
      // contract — operators can grep this assertion if the field shape
      // ever changes.
      expect(log).toMatchObject({
        event: 'SETTLEMENT_ECONOMICS_EXECUTION',
        digest: 'tx-rebate-event-log',
      });

      consoleInfoSpy.mockRestore();
    });

    it('on-chain revert with rebate >= computation+storage clamps hostPaidGasMist to 0 (canonical 0-clamp parity with computeExecutionCostClaim)', async () => {
      // Generic on-chain-revert economics regression. The canonical
      // helper `computeExecutionCostClaim(...).simGas` clamps a negative net
      // (storageRebate > computation + storage; e.g. delete-objects
      // revert) to 0; the recorder economics path must do the same so
      // `hostPaidGasMist` cannot go negative and `hostNetMist`
      // cannot inflate by the rebate-overshoot amount on the loss row.
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);
      const probe = collectingCallback();
      // computation + storage = 1_000_000; storageRebate = 1_500_000
      // → rawNet = -500_000 → clamp to 0.
      const failedExec = {
        $kind: 'FailedTransaction' as const,
        FailedTransaction: {
          digest: 'tx-revert-rebate',
          status: { error: { message: 'rebate-positive revert' } },
          effects: {
            gasUsed: {
              computationCost: '700000',
              storageCost: '300000',
              storageRebate: '1500000',
            },
          },
        },
      };
      const sui = makeMockSui(undefined, failedExec);
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sui,
        onSponsorResult: probe.callback,
      });

      await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch(() => undefined);

      expect(probe.calls).toHaveLength(1);
      expect(probe.calls[0].outcome).toBe('onchain_revert');
      expect(probe.calls[0].economics.economicsStatus).toBe('known');
      if (probe.calls[0].economics.economicsStatus === 'known') {
        expect(probe.calls[0].economics.recoveredGasMist).toBe('0');
        expect(probe.calls[0].economics.hostPaidGasMist).toBe('0');
        expect(probe.calls[0].economics.failureReason).toBe('rebate-positive revert');
        // grossGasMist + storageRebateMist preserved verbatim from the
        // raw effects so operators can still read the actual on-chain
        // numbers; only the derived `hostPaidGasMist` is clamped.
        expect(probe.calls[0].economics.grossGasMist).toBe('1000000');
        expect(probe.calls[0].economics.storageRebateMist).toBe('1500000');
      }
    });

    it('callback errors are swallowed — primary error/result is preserved', async () => {
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = makeMockContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        onSponsorResult: () => {
          throw new Error('host callback bug');
        },
      });

      const result = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      );

      // Primary response unaffected by callback failure.
      expect(result.digest).toBe('0xdigest123');
      // Structured warn log emitted by the handler's defence-in-depth catch.
      const callbackFailedLog = consoleWarnSpy.mock.calls
        .map((args: unknown[]) => JSON.parse(args[0] as string) as Record<string, unknown>)
        .find((entry) => entry['event'] === 'SPONSOR_RESULT_CALLBACK_FAILED');
      expect(callbackFailedLog).toBeDefined();
      expect(callbackFailedLog!['route']).toBe('generic');
      expect(callbackFailedLog!['outcome']).toBe('success');
      // Cross-reference shape: `source` and `digest` are required so
      // operators can correlate this emit with host-side projection
      // failures (`SPONSORED_LOGS_RECORDER_FAILED` / `SPONSOR_OPERATIONS_STATE_WRITE_FAILED`).
      expect(callbackFailedLog!['source']).toBe('sponsor_handler');
      expect(callbackFailedLog!['digest']).toBe('0xdigest123');
      consoleWarnSpy.mockRestore();
    });
  });

  // ─────────────────────────────────────────────
  // New-user vault drift pre-sign re-query
  // ─────────────────────────────────────────────
  //
  // Generic `/relay/sponsor` `swap_and_settle_new_user_*` PTBs include
  // an inline `register_vault` MoveCall; if a vault was created between
  // /prepare and /sponsor (concurrent flow, SDK fast-path, off-line
  // bootstrap), the on-chain abort burns sponsor gas before the
  // EVaultAlreadyRegistered carve-out short-circuits. The handler re-queries
  // vault state after gas-owner verification and before preflight/signing:
  //   - vault now exists  → REPREPARE_REQUIRED + SPONSOR_DRIFT_OBSERVED, no abuse, no sign.
  //   - vault still absent → flow continues unchanged.
  //   - RPC error / inconsistent state → fail closed (SPONSOR_FAILED 500), no sign.
  //   - non-new_user PTBs (with_vault, credit) → re-query is not invoked.
  describe('new-user vault drift pre-sign re-query', () => {
    function makeVaultDriftContext(
      ctxOverrides: Parameters<typeof makeMockContext>[0],
      opts: { needsAllowedSettlementSwapPaths?: boolean } = {},
    ): HostContext {
      const ctx = makeMockContext(ctxOverrides);
      // Pre-cached vaultsTableId so queryUserCredit skips the registry fetch.
      (ctx as { vaultsTableId: string }).vaultsTableId = M1_VAULTS_TABLE_ID;
      // Swap PTBs need an allowed settlement swap path entry so postconsume L2 passes.
      if (opts.needsAllowedSettlementSwapPaths !== false) {
        ctx.allowedSettlementSwapPaths = [SWAP_ALLOWED_ROUTE];
      }
      return ctx;
    }

    it('new_user PTB + vault now exists → REPREPARE_REQUIRED, no abuse, no sign, drift log emitted', async () => {
      const { encodedTxBytes, txBytes, txHash } = await buildAddressBalanceSwapTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash, { executionPathKey: 'swap:new_user' });
      const userSig = await buildValidSignature(txBytes);
      const sui = makeMockSui();
      const lookup = attachVaultLookup(sui, { kind: 'vault_exists' });
      const sponsorPool = makeMockSponsorPool();
      const abuseBlocker = makeMockAbuseBlocker();
      const ctx = makeVaultDriftContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sponsorPool,
        sui,
        abuseBlocker,
      });

      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SponsorValidationError);
      expect((err as SponsorValidationError).code).toBe('REPREPARE_REQUIRED');
      // Vault re-query was invoked exactly once.
      expect(lookup.getDynamicField).toHaveBeenCalledTimes(1);
      // No abuse counter increment (drift, not user manipulation).
      expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalled();
      // Preflight (sui.simulateTransaction) MUST NOT be reached when the
      // vault-drift gate fires. If preflight ran first the
      // on-chain `EVaultAlreadyRegistered` abort would return as
      // `SPONSOR_PREFLIGHT_FAILED` + IP-counter pressure, violating the
      // drift contract (no abuse, drift event emitted).
      expect(sui.simulateTransaction).not.toHaveBeenCalled();
      // Sponsor sign / submit are not reached.
      expect(sponsorPool.sign).not.toHaveBeenCalled();
      expect(sui.executeTransaction).not.toHaveBeenCalled();
      // SPONSOR_DRIFT_OBSERVED payload contract — pricing-and-validation.md
      // §Sponsor Failure Classification: stage / subcode / route / receipt_id /
      // sender / client_ip. The promotion-only `promotion_id` field must NOT
      // appear on a generic-execution-path emit.
      const driftLog = consoleInfoSpy.mock.calls
        .map((args: unknown[]) => JSON.parse(args[0] as string) as Record<string, unknown>)
        .find((entry) => entry['event'] === 'SPONSOR_DRIFT_OBSERVED');
      expect(driftLog).toBeDefined();
      expect(driftLog!['stage']).toBe(VAULT_DRIFT_NEW_USER_VAULT_EXISTS.stage);
      expect(driftLog!['subcode']).toBe(VAULT_DRIFT_NEW_USER_VAULT_EXISTS.subcode);
      expect(driftLog!['route']).toBe('generic');
      expect(driftLog!['receipt_id']).toBe(PAYMENT_ID);
      expect(driftLog!['sender']).toBe(SENDER);
      expect(driftLog!['client_ip']).toBe(CLIENT_IP);
      expect(driftLog!['promotion_id']).toBeUndefined();
      // finally-slot-checkin runs even on the vault-drift throw path.
      expect(sponsorPool.checkin).toHaveBeenCalledTimes(1);
    });

    it('new_user PTB + vault still absent → flow proceeds to preflight+sign+submit', async () => {
      const { encodedTxBytes, txBytes, txHash } = await buildAddressBalanceSwapTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash, { executionPathKey: 'swap:new_user' });
      const userSig = await buildValidSignature(txBytes);
      const sui = makeMockSui();
      const lookup = attachVaultLookup(sui, { kind: 'no_vault' });
      const sponsorPool = makeMockSponsorPool();
      const ctx = makeVaultDriftContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sponsorPool,
        sui,
      });

      const result = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      );

      expect(result.digest).toBeDefined();
      expect(lookup.getDynamicField).toHaveBeenCalledTimes(1);
      // When the vault-drift check passes (no drift), preflight runs
      // afterwards. This locks the gasOwner → vault check → preflight order.
      expect(sui.simulateTransaction).toHaveBeenCalledTimes(1);
      expect(sponsorPool.sign).toHaveBeenCalledTimes(1);
      expect(sui.executeTransaction).toHaveBeenCalledTimes(1);
    });

    // Regression lock: the vault-drift gate must run before preflight so
    // `EVaultAlreadyRegistered` never classifies as `SPONSOR_PREFLIGHT_FAILED`
    // when the vault already exists.
    it('new_user PTB + vault now exists + preflight stubbed VAULT_ALREADY_REGISTERED → vault check short-circuits before preflight', async () => {
      const { encodedTxBytes, txBytes, txHash } = await buildAddressBalanceSwapTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash, { executionPathKey: 'swap:new_user' });
      const userSig = await buildValidSignature(txBytes);
      // Stub preflight as if it had been reached and saw the on-chain
      // `EVaultAlreadyRegistered` abort. The test asserts preflight is
      // never invoked, so this stub value would be observed only if the
      // ordering regressed.
      const vaultAlreadyRegisteredSim = {
        Transaction: {
          digest: '0xstubbed-not-reached',
          status: {
            success: false,
            error: {
              message: `MoveAbort(${MOCK_CONFIG.packageId}::vault::register_vault, 1) in command 0`,
            },
          },
        },
      };
      const sui = makeMockSui(vaultAlreadyRegisteredSim);
      const lookup = attachVaultLookup(sui, { kind: 'vault_exists' });
      const sponsorPool = makeMockSponsorPool();
      const abuseBlocker = makeMockAbuseBlocker();
      const ctx = makeVaultDriftContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sponsorPool,
        sui,
        abuseBlocker,
      });

      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      // Drift contract: REPREPARE_REQUIRED, not SPONSOR_PREFLIGHT_FAILED.
      expect(err).toBeInstanceOf(SponsorValidationError);
      expect((err as SponsorValidationError).code).toBe('REPREPARE_REQUIRED');
      // Preflight is short-circuited.
      expect(sui.simulateTransaction).not.toHaveBeenCalled();
      // Vault re-query DID run.
      expect(lookup.getDynamicField).toHaveBeenCalledTimes(1);
      // No abuse on either address or IP counter.
      expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalled();
      // Sponsor sign + submit not reached.
      expect(sponsorPool.sign).not.toHaveBeenCalled();
      expect(sui.executeTransaction).not.toHaveBeenCalled();
      // The handler emits SPONSOR_DRIFT_OBSERVED with the right stage; it does NOT
      // emit a preflight-failure record because preflight never ran.
      const driftLog = consoleInfoSpy.mock.calls
        .map((args: unknown[]) => JSON.parse(args[0] as string) as Record<string, unknown>)
        .find((entry) => entry['event'] === 'SPONSOR_DRIFT_OBSERVED');
      expect(driftLog).toBeDefined();
      expect(driftLog!['stage']).toBe(VAULT_DRIFT_NEW_USER_VAULT_EXISTS.stage);
    });

    it('credit PTB → vault re-query is NOT invoked (predicate skips non-new_user)', async () => {
      // Credit-only PTB built by buildValidTx; the new-user predicate is false.
      const { encodedTxBytes, txBytes, txHash } = await buildValidTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash);
      const userSig = await buildValidSignature(txBytes);
      const sui = makeMockSui();
      const lookup = attachVaultLookup(sui, { kind: 'vault_exists' });
      // Credit path does not validate settlement swap paths; allowedSettlementSwapPaths can stay empty.
      const ctx = makeVaultDriftContext(
        {
          prepareStore: makeMockPrepareStore(prepared, prepared),
          sui,
        },
        { needsAllowedSettlementSwapPaths: false },
      );

      await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      );

      expect(lookup.getDynamicField).not.toHaveBeenCalled();
      // Credit path bypasses the vault re-query but still runs preflight + sign.
      expect(sui.simulateTransaction).toHaveBeenCalledTimes(1);
    });

    it('with_vault PTB → vault re-query is NOT invoked (handler-level lock for swap_and_settle_with_vault_*)', async () => {
      // Vault-backed PTB; the new-user predicate is false.
      // Handler-level lock complements the unit-level
      // `isNewUserSettleMoveCall` predicate test in extractSettleArgs.test.ts:
      // verifies that the runner-wired generic post-consume path skips the
      // vault re-query for the with-vault settle variant, not only for the
      // credit variant.
      const { encodedTxBytes, txBytes, txHash } = await buildAddressBalanceSwapTx(SPONSOR_ADDRESS, {
        settleVariant: 'with_vault',
      });
      const prepared = makePreparedEntry(txHash, {
        executionPathKey: _buildExecutionPathKey(SWAP_ALLOWED_ROUTE),
      });
      const userSig = await buildValidSignature(txBytes);
      const sui = makeMockSui();
      // Mock returns vault_exists; if the predicate were buggy and routed
      // with_vault into the gate it would throw REPREPARE_REQUIRED, so the
      // happy-path success below also locks the predicate's negative case.
      const lookup = attachVaultLookup(sui, { kind: 'vault_exists' });
      const sponsorPool = makeMockSponsorPool();
      const ctx = makeVaultDriftContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sponsorPool,
        sui,
      });

      const result = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      );

      expect(result.digest).toBeDefined();
      expect(lookup.getDynamicField).not.toHaveBeenCalled();
      // With-vault path bypasses the vault re-query but still runs preflight + sign.
      expect(sui.simulateTransaction).toHaveBeenCalledTimes(1);
      expect(sponsorPool.sign).toHaveBeenCalledTimes(1);
      expect(sui.executeTransaction).toHaveBeenCalledTimes(1);
    });

    it('new_user PTB + queryUserCredit RPC error → SPONSOR_FAILED 500, no sign, no abuse, drift log', async () => {
      const { encodedTxBytes, txBytes, txHash } = await buildAddressBalanceSwapTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash, { executionPathKey: 'swap:new_user' });
      const userSig = await buildValidSignature(txBytes);
      const sui = makeMockSui();
      attachVaultLookup(sui, { kind: 'rpc_error', err: new Error('rpc unavailable') });
      const sponsorPool = makeMockSponsorPool();
      const abuseBlocker = makeMockAbuseBlocker();
      const ctx = makeVaultDriftContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sponsorPool,
        sui,
        abuseBlocker,
      });

      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SponsorValidationError);
      expect((err as SponsorValidationError).code).toBe('SPONSOR_FAILED');
      expect((err as SponsorValidationError).statusHint).toBe(500);
      // Fail-closed BEFORE preflight + sign + submit.
      expect(sui.simulateTransaction).not.toHaveBeenCalled();
      expect(sponsorPool.sign).not.toHaveBeenCalled();
      expect(sui.executeTransaction).not.toHaveBeenCalled();
      // Sponsor-time vault re-query failure records no abuse:
      // server-observable transient/inconsistent state, not user manipulation.
      expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalled();
      const driftLog = consoleInfoSpy.mock.calls
        .map((args: unknown[]) => JSON.parse(args[0] as string) as Record<string, unknown>)
        .find((entry) => entry['event'] === 'SPONSOR_DRIFT_OBSERVED');
      expect(driftLog).toBeDefined();
      expect(driftLog!['stage']).toBe(VAULT_DRIFT_QUERY_FAILED.stage);
      expect(driftLog!['subcode']).toBe(VAULT_DRIFT_QUERY_FAILED.subcode);
      expect(driftLog!['route']).toBe('generic');
      expect(driftLog!['receipt_id']).toBe(PAYMENT_ID);
      expect(driftLog!['sender']).toBe(SENDER);
      expect(driftLog!['client_ip']).toBe(CLIENT_IP);
      expect(driftLog!['promotion_id']).toBeUndefined();
      expect(sponsorPool.checkin).toHaveBeenCalledTimes(1);
    });

    it('new_user PTB + CreditQueryInconsistentStateError → SPONSOR_FAILED 500, no abuse, distinct drift stage', async () => {
      const { encodedTxBytes, txBytes, txHash } = await buildAddressBalanceSwapTx(SPONSOR_ADDRESS);
      const prepared = makePreparedEntry(txHash, { executionPathKey: 'swap:new_user' });
      const userSig = await buildValidSignature(txBytes);
      const sui = makeMockSui();
      attachVaultLookup(sui, { kind: 'inconsistent' });
      const sponsorPool = makeMockSponsorPool();
      const abuseBlocker = makeMockAbuseBlocker();
      const ctx = makeVaultDriftContext({
        prepareStore: makeMockPrepareStore(prepared, prepared),
        sponsorPool,
        sui,
        abuseBlocker,
      });

      const err = await handleSponsor(
        ctx,
        { txBytes: encodedTxBytes, userSignature: userSig, receiptId: PAYMENT_ID },
        CLIENT_IP,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SponsorValidationError);
      expect((err as SponsorValidationError).code).toBe('SPONSOR_FAILED');
      expect((err as SponsorValidationError).statusHint).toBe(500);
      // Fail-closed BEFORE preflight + sign + submit.
      expect(sui.simulateTransaction).not.toHaveBeenCalled();
      expect(sponsorPool.sign).not.toHaveBeenCalled();
      // Sponsor-time vault re-query failure records no abuse.
      // Registry/vault inconsistency is a server-observable trust-root drift,
      // not user manipulation.
      expect(abuseBlocker.recordSponsorFailure).not.toHaveBeenCalled();
      const driftLog = consoleInfoSpy.mock.calls
        .map((args: unknown[]) => JSON.parse(args[0] as string) as Record<string, unknown>)
        .find((entry) => entry['event'] === 'SPONSOR_DRIFT_OBSERVED');
      expect(driftLog).toBeDefined();
      expect(driftLog!['stage']).toBe(VAULT_DRIFT_STATE_INCONSISTENT.stage);
      expect(driftLog!['subcode']).toBe(VAULT_DRIFT_STATE_INCONSISTENT.subcode);
      expect(driftLog!['route']).toBe('generic');
      expect(driftLog!['receipt_id']).toBe(PAYMENT_ID);
      expect(driftLog!['sender']).toBe(SENDER);
      expect(driftLog!['client_ip']).toBe(CLIENT_IP);
      expect(driftLog!['promotion_id']).toBeUndefined();
    });
  });
});
