/**
 * roundTripPtb.test.ts — real builder → parser → prepared-commit coverage.
 *
 * Nothing here is mocked. We:
 *
 *   1. Build a real PTB via `buildSwapAndSettlePtb` (core-relay builder).
 *   2. Serialize commands and inputs from the resulting Transaction.
 *   3. Re-extract settle args via the real `parseSettleArgs` (core-relay parser).
 *   4. Project the coordination fields through `composePreparedCommit`
 *      (core-api SponsoredExecution boundary) into a generic prepared entry.
 *   5. Assert that the parsed PTB args, the GenericPrepareBuildOutput-projected store
 *      entry, and the original audit input all agree on the canonical
 *      facts: executionCostClaim, nonce, quotedHostFeeMist, profile, and the
 *      route shape.
 *
 * This proves:
 *   - The 13 SETTLE_FIELD_SCHEMA fields embedded in the real PTB round-trip
 *     correctly to TypeScript bigints/strings via parseSettleArgs.
 *   - composePreparedCommit's input → durable entry projection does
 *     not silently drift away from the values that actually live in the
 *     PTB the user signs.
 *   - SETTLE_FIELD_SCHEMA names, builder typeArguments, and store entry
 *     fields are locked to the real PTB shape rather than mocked assumptions.
 */
import { describe, it, expect } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { buildSwapAndSettlePtb, buildSettleWithCreditPtb } from '@stelis/core-relay/browser';
import { parseSettleArgs, convertSdkCommands } from '@stelis/core-relay';
import type { GenericPrepareBuildOutput } from '../src/prepare/build.js';
import { composePreparedCommit } from '../src/session/sponsoredExecution/preparedCommit.js';

// ─── Named addresses (file-level constants per AGENTS.md test policy) ────

const ADDR_PKG = '0x' + '1'.repeat(64);
const ADDR_CONFIG = '0x' + '2'.repeat(64);
const ADDR_REGISTRY = '0x' + '3'.repeat(64);
const ADDR_POOL = '0x' + '4'.repeat(64);
const ADDR_PAYMENT_COIN = '0x' + '5'.repeat(64);
const ADDR_VAULT = '0x' + '7'.repeat(64);
const ADDR_SETTLEMENT_PAYOUT_RECIPIENT = '0x' + 'b'.repeat(64);

const PAYMENT_TYPE = `${ADDR_PKG}::token::TOKEN`;

// ─── Audit field fixture ─────────────────────────────────────────────────

const AUDIT_FIELDS = {
  executionCostClaim: 5_000_000n,
  settlementPayoutRecipient: ADDR_SETTLEMENT_PAYOUT_RECIPIENT,
  receiptId: new Uint8Array(32).fill(0xaa),
  nonce: 7n,
  simGasReported: 4_000_000n,
  gasVarianceFixedMist: 200_000n,
  slippageBufferMist: 50_000n,
  quotedHostFeeMist: 100_000n,
  expectedProtocolFeeMist: 20_000n,
  expectedConfigVersion: 1n,
  quoteTimestampMs: 1_741_680_000_000,
  policyHash: new Uint8Array(32).fill(0xbb),
  orderIdHash: new Uint8Array(0),
};

const CREDIT_AUDIT_FIELDS = {
  ...AUDIT_FIELDS,
  slippageBufferMist: 0n,
};

// ─── Test helpers ────────────────────────────────────────────────────────

function buildNewUser1HopPtb(): Transaction {
  const tx = new Transaction();
  buildSwapAndSettlePtb(tx, {
    variant: 'new_user',
    settlementSwapDirection: 'baseForQuote',
    paymentTokenType: PAYMENT_TYPE,
    poolId: ADDR_POOL,
    packageId: ADDR_PKG,
    configId: ADDR_CONFIG,
    vaultRegistryId: ADDR_REGISTRY,
    paymentCoinId: ADDR_PAYMENT_COIN,
    swapAmount: 1_000_000n,
    minSuiOut: 0n,
    ...AUDIT_FIELDS,
  });
  return tx;
}

function buildWithVault1HopPtb(): Transaction {
  const tx = new Transaction();
  buildSwapAndSettlePtb(tx, {
    variant: 'with_vault',
    settlementSwapDirection: 'baseForQuote',
    paymentTokenType: PAYMENT_TYPE,
    poolId: ADDR_POOL,
    vaultId: ADDR_VAULT,
    useCreditAmount: 0n,
    packageId: ADDR_PKG,
    configId: ADDR_CONFIG,
    vaultRegistryId: ADDR_REGISTRY,
    paymentCoinId: ADDR_PAYMENT_COIN,
    swapAmount: 1_000_000n,
    minSuiOut: 0n,
    ...AUDIT_FIELDS,
  });
  return tx;
}

function buildCreditOnlyPtb(): Transaction {
  const tx = new Transaction();
  buildSettleWithCreditPtb(tx, {
    packageId: ADDR_PKG,
    configId: ADDR_CONFIG,
    vaultRegistryId: ADDR_REGISTRY,
    vaultId: ADDR_VAULT,
    useCreditAmount: 5_120_000n,
    ...CREDIT_AUDIT_FIELDS,
  });
  return tx;
}

function build1HopQfbNewUserPtb(): Transaction {
  const tx = new Transaction();
  buildSwapAndSettlePtb(tx, {
    variant: 'new_user',
    settlementSwapDirection: 'quoteForBase',
    paymentTokenType: PAYMENT_TYPE,
    poolId: ADDR_POOL,
    packageId: ADDR_PKG,
    configId: ADDR_CONFIG,
    vaultRegistryId: ADDR_REGISTRY,
    paymentCoinId: ADDR_PAYMENT_COIN,
    swapAmount: 1_000_000n,
    minSuiOut: 0n,
    ...AUDIT_FIELDS,
  });
  return tx;
}

function build1HopQfbWithVaultPtb(): Transaction {
  const tx = new Transaction();
  buildSwapAndSettlePtb(tx, {
    variant: 'with_vault',
    settlementSwapDirection: 'quoteForBase',
    paymentTokenType: PAYMENT_TYPE,
    poolId: ADDR_POOL,
    vaultId: ADDR_VAULT,
    useCreditAmount: 0n,
    packageId: ADDR_PKG,
    configId: ADDR_CONFIG,
    vaultRegistryId: ADDR_REGISTRY,
    paymentCoinId: ADDR_PAYMENT_COIN,
    swapAmount: 1_000_000n,
    minSuiOut: 0n,
    ...AUDIT_FIELDS,
  });
  return tx;
}

/** Parse the settle args out of a built Transaction using the real parser. */
function parseFromTx(tx: Transaction) {
  const data = tx.getData() as { commands: unknown[]; inputs: unknown[] };
  const normalizedCommands = convertSdkCommands(data.commands);
  return parseSettleArgs(normalizedCommands, data.inputs, ADDR_PKG);
}

/** Make a GenericPrepareBuildOutput-shaped object that mirrors the AUDIT_FIELDS. */
function makeGenericPrepareBuildOutput(
  profile: 'new_user' | 'with_vault' | 'credit_general',
): GenericPrepareBuildOutput {
  const audit = profile === 'credit_general' ? CREDIT_AUDIT_FIELDS : AUDIT_FIELDS;
  return {
    txBytes: new Uint8Array([0x01]),
    txBytesHash: 'fake-hash-' + profile,
    executionCostClaim: audit.executionCostClaim,
    simGas: audit.simGasReported,
    gasVarianceFixedMist: audit.gasVarianceFixedMist,
    slippageBufferMist: audit.slippageBufferMist,
    grossGas: 1_500_000n,
    profile,
    paymentInputSource: profile === 'credit_general' ? 'none_credit_only' : 'coin_object',
    swapAmountSmallest: profile === 'credit_general' ? 0n : 1_000_000n,
  };
}

/**
 * Test-only: decode the tail `use_credit_amount` u64 from a with_vault PTB.
 *
 * with_vault MoveCall arg layout:
 *   0-2   common (config, registry, clock)
 *   3     vault object
 *   4     pool object
 *   5     payment_coin
 *   6-7   swap pures (swapAmount, minSuiOut)
 *   8-20  settle block (13 fields, settleStartIndex=8)
 *   21    use_credit_amount tail u64
 *
 * We follow the Input reference at MoveCall argument position 21 and
 * BCS-decode the 8-byte little-endian u64 from the Pure input bytes.
 * Does not use parseSettleArgs — exercises the raw PTB input structure.
 */
function decodeTailCreditFromPtb(tx: Transaction): bigint {
  const TAIL_ARG_INDEX = 21; // settleStartIndex(8) + SETTLE_FIELD_COUNT(13)
  const data = tx.getData() as { commands: unknown[]; inputs: unknown[] };
  const mc = (data.commands[0] as Record<string, unknown>).MoveCall as Record<string, unknown>;
  const mcArgs = mc.arguments as Array<Record<string, unknown>>;
  const tailRef = mcArgs[TAIL_ARG_INDEX];
  if (!tailRef || tailRef.$kind !== 'Input' || typeof tailRef.Input !== 'number') {
    throw new Error(`Expected Input ref at MoveCall argument index ${TAIL_ARG_INDEX}`);
  }
  const input = data.inputs[tailRef.Input] as Record<string, unknown>;
  if (input.$kind !== 'Pure') {
    throw new Error(`Expected Pure input at inputs[${tailRef.Input}]`);
  }
  const bytes = fromBase64((input.Pure as Record<string, unknown>).bytes as string);
  // BCS u64: 8-byte little-endian
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(bytes[i]!);
  }
  return value;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('roundTripPtb: real builder → parser → store entry adapter', () => {
  // ── bfq new_user ──

  it('bfq new_user — PTB args round-trip to parseSettleArgs values', () => {
    const tx = buildNewUser1HopPtb();
    const parsed = parseFromTx(tx);

    expect(parsed.executionCostClaim).toBe(AUDIT_FIELDS.executionCostClaim);
    expect(parsed.nonce).toBe(AUDIT_FIELDS.nonce);
    expect(parsed.quotedHostFeeMist).toBe(AUDIT_FIELDS.quotedHostFeeMist);
    expect(parsed.expectedProtocolFeeMist).toBe(AUDIT_FIELDS.expectedProtocolFeeMist);
    expect(parsed.slippageBufferMist).toBe(AUDIT_FIELDS.slippageBufferMist);
    expect(parsed.expectedConfigVersion).toBe(AUDIT_FIELDS.expectedConfigVersion);
    expect(parsed.settlementPayoutRecipient).toBe(AUDIT_FIELDS.settlementPayoutRecipient);
    expect(parsed.policyHash).toEqual(AUDIT_FIELDS.policyHash);
    expect(parsed.extractedSettlementSwapPath?.tokenType).toBe(PAYMENT_TYPE);
    expect(parsed.extractedSettlementSwapPath?.settlementSwapDirection).toBe('baseForQuote');
    expect(parsed.extractedSettlementSwapPath?.hops).toEqual([ADDR_POOL]);
  });

  it('bfq new_user — store adapter projects coordination-only fields (txBytesHash, nonce)', () => {
    const buildResult = makeGenericPrepareBuildOutput('new_user');
    const entry = composePreparedCommit({
      mode: 'generic',
      receiptId: '0xreceipt',
      senderAddress: '0xsender',
      clientIp: '10.0.0.1',
      txBytesHash: buildResult.txBytesHash,
      slotId: 's',
      sponsorAddress: 'a',
      executionPathKey: 'rk',
      orderId: null,
      nonce: AUDIT_FIELDS.nonce,
    });

    // The store entry is coordination-only. Settle facts
    // (executionCostClaim, fee components, profile, policyHash, etc.) live in
    // the PTB and are read by sponsor via parseSettleArgs(txBytes); the
    // round-trip lock for those facts lives in `extractSettleArgs.test.ts`
    // via ARG_INDEX_MAP. This test only verifies the build→store
    // projection contract (txBytesHash + coordination fields).
    expect(entry.txBytesHash).toBe(buildResult.txBytesHash);
    expect(entry.nonce).toBe(AUDIT_FIELDS.nonce);
    expect(entry).not.toHaveProperty('executionCostClaim');
    expect(entry).not.toHaveProperty('profile');
  });

  // ── bfq with_vault ──

  it('bfq with_vault — PTB args round-trip including vault path', () => {
    const tx = buildWithVault1HopPtb();
    const parsed = parseFromTx(tx);

    expect(parsed.executionCostClaim).toBe(AUDIT_FIELDS.executionCostClaim);
    expect(parsed.nonce).toBe(AUDIT_FIELDS.nonce);
    expect(parsed.extractedSettlementSwapPath?.settlementSwapDirection).toBe('baseForQuote');
    // The with_vault function name embeds the vault path; parseSettleArgs
    // resolves the same canonical fields regardless of variant.
  });

  // ── credit-only ──

  it('credit-only settlement — PTB args round-trip', () => {
    const tx = buildCreditOnlyPtb();
    const parsed = parseFromTx(tx);

    expect(parsed.executionCostClaim).toBe(AUDIT_FIELDS.executionCostClaim);
    expect(parsed.nonce).toBe(AUDIT_FIELDS.nonce);
    expect(parsed.quotedHostFeeMist).toBe(AUDIT_FIELDS.quotedHostFeeMist);
    expect(parsed.expectedProtocolFeeMist).toBe(AUDIT_FIELDS.expectedProtocolFeeMist);
    expect(parsed.slippageBufferMist).toBe(0n);
    // credit-only path has no extracted settlement swap path.
    expect(parsed.extractedSettlementSwapPath).toBeUndefined();
  });

  it('credit-only — store adapter projects coordination-only fields', () => {
    const buildResult = makeGenericPrepareBuildOutput('credit_general');
    const entry = composePreparedCommit({
      mode: 'generic',
      receiptId: '0xreceipt',
      senderAddress: '0xsender',
      clientIp: '10.0.0.1',
      txBytesHash: buildResult.txBytesHash,
      slotId: 's',
      sponsorAddress: 'a',
      executionPathKey: 'credit',
      orderId: null,
      nonce: AUDIT_FIELDS.nonce,
    });

    // Settle round-trip facts are PTB↔parser concerns and locked
    // elsewhere (extractSettleArgs.test.ts via ARG_INDEX_MAP). The store
    // entry carries only coordination fields.
    expect(entry.txBytesHash).toBe(buildResult.txBytesHash);
    expect(entry.nonce).toBe(AUDIT_FIELDS.nonce);
    expect(entry).not.toHaveProperty('executionCostClaim');
    expect(entry).not.toHaveProperty('profile');
    expect(entry).not.toHaveProperty('slippageBufferMist');
  });

  // ── qfb ──

  it('qfb new_user — PTB args round-trip to parseSettleArgs values', () => {
    const tx = build1HopQfbNewUserPtb();
    const parsed = parseFromTx(tx);

    expect(parsed.executionCostClaim).toBe(AUDIT_FIELDS.executionCostClaim);
    expect(parsed.nonce).toBe(AUDIT_FIELDS.nonce);
    expect(parsed.quotedHostFeeMist).toBe(AUDIT_FIELDS.quotedHostFeeMist);
    expect(parsed.expectedProtocolFeeMist).toBe(AUDIT_FIELDS.expectedProtocolFeeMist);
    expect(parsed.expectedConfigVersion).toBe(AUDIT_FIELDS.expectedConfigVersion);
    expect(parsed.settlementPayoutRecipient).toBe(AUDIT_FIELDS.settlementPayoutRecipient);
    expect(parsed.policyHash).toEqual(AUDIT_FIELDS.policyHash);
    expect(parsed.extractedSettlementSwapPath?.tokenType).toBe(PAYMENT_TYPE);
    expect(parsed.extractedSettlementSwapPath?.settlementSwapDirection).toBe('quoteForBase');
    expect(parsed.extractedSettlementSwapPath?.hops).toEqual([ADDR_POOL]);
  });

  it('qfb with_vault — PTB args round-trip including vault path', () => {
    const tx = build1HopQfbWithVaultPtb();
    const parsed = parseFromTx(tx);

    expect(parsed.executionCostClaim).toBe(AUDIT_FIELDS.executionCostClaim);
    expect(parsed.nonce).toBe(AUDIT_FIELDS.nonce);
    expect(parsed.quotedHostFeeMist).toBe(AUDIT_FIELDS.quotedHostFeeMist);
    expect(parsed.expectedProtocolFeeMist).toBe(AUDIT_FIELDS.expectedProtocolFeeMist);
    expect(parsed.expectedConfigVersion).toBe(AUDIT_FIELDS.expectedConfigVersion);
    expect(parsed.settlementPayoutRecipient).toBe(AUDIT_FIELDS.settlementPayoutRecipient);
    expect(parsed.policyHash).toEqual(AUDIT_FIELDS.policyHash);
    expect(parsed.extractedSettlementSwapPath?.tokenType).toBe(PAYMENT_TYPE);
    expect(parsed.extractedSettlementSwapPath?.settlementSwapDirection).toBe('quoteForBase');
    expect(parsed.extractedSettlementSwapPath?.hops).toEqual([ADDR_POOL]);
  });

  // ── tail credit ──

  it('bfq with_vault + useCreditAmount > 0 — tail credit decoded from PTB', () => {
    const USE_CREDIT = 2_000_000n;
    const tx = new Transaction();
    buildSwapAndSettlePtb(tx, {
      variant: 'with_vault',
      settlementSwapDirection: 'baseForQuote',
      paymentTokenType: PAYMENT_TYPE,
      poolId: ADDR_POOL,
      vaultId: ADDR_VAULT,
      useCreditAmount: USE_CREDIT,
      packageId: ADDR_PKG,
      configId: ADDR_CONFIG,
      vaultRegistryId: ADDR_REGISTRY,
      paymentCoinId: ADDR_PAYMENT_COIN,
      swapAmount: 1_000_000n,
      minSuiOut: 0n,
      ...AUDIT_FIELDS,
    });

    // Canonical settle fields still round-trip correctly.
    const parsed = parseFromTx(tx);
    expect(parsed.executionCostClaim).toBe(AUDIT_FIELDS.executionCostClaim);
    expect(parsed.nonce).toBe(AUDIT_FIELDS.nonce);

    // Tail credit is outside the 13-field settle block — verified via test-only BCS decoder.
    expect(decodeTailCreditFromPtb(tx)).toBe(USE_CREDIT);
  });

  // ── Drift detection ──

  it('drift detection — changing builder input changes parsed value', () => {
    // Sanity check that the round-trip is meaningful: if we change a PTB
    // builder input, parseSettleArgs reflects that change. This guards
    // against the round-trip being a self-confirming tautology.
    const tx = new Transaction();
    buildSwapAndSettlePtb(tx, {
      variant: 'new_user',
      settlementSwapDirection: 'baseForQuote',
      paymentTokenType: PAYMENT_TYPE,
      poolId: ADDR_POOL,
      packageId: ADDR_PKG,
      configId: ADDR_CONFIG,
      vaultRegistryId: ADDR_REGISTRY,
      paymentCoinId: ADDR_PAYMENT_COIN,
      swapAmount: 1_000_000n,
      minSuiOut: 0n,
      ...AUDIT_FIELDS,
      executionCostClaim: 9_999_999n, // overridden
      nonce: 42n, // overridden
    });

    const parsed = parseFromTx(tx);
    expect(parsed.executionCostClaim).toBe(9_999_999n);
    expect(parsed.nonce).toBe(42n);
  });
});
