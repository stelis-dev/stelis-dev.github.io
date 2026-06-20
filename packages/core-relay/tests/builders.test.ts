/**
 * builders.test.ts — PTB builder type-argument wiring tests.
 *
 * These tests validate the END-TO-END bind between:
 *   buildSwapAndSettlePtb (builds the PTB)
 *     ↓
 *   parseSettleArgs (extracts route metadata from the PTB)
 *     ↓
 *   on-chain Move entry signatures (settle.move)
 *
 * In particular, for every supported SettlementSwapDirection × variant (4 combos),
 * we verify:
 *
 *   1. MoveCall typeArguments contain exactly the settlement token, matching
 *      the on-chain entry's generic params.
 *   2. parseSettleArgs().extractedSettlementSwapPath.tokenType equals the settlement token
 *      (not SUI, not a pool type arg).
 *   3. extractedSettlementSwapPath.settlementSwapDirection matches the input settlementSwapDirection.
 *   4. extractedSettlementSwapPath.hops matches the input poolId.
 *
 * Regression barrier: ensures each SettlementSwapDirection × variant combination
 * compiles with correct Move type arguments.
 */
import { describe, it, expect } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { buildSwapAndSettlePtb, buildSettleWithCreditPtb } from '../src/ptb/builders.js';
import { parseSettleArgs } from '../src/parseSettleArgs.js';
import { convertSdkCommands } from '../src/convert.js';
import { SETTLE_FIELD_SCHEMA } from '../src/settlePayloadContract.js';
import { validatePtbStructure, validateSettleArgs } from '../src/validate/static.js';
import {
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
  SETTLE_FUNCTIONS,
  SETTLE_WITH_CREDIT_FUNCTION,
  type SettlementSwapDirection,
} from '@stelis/contracts';
import type { OnchainConfig, RelayerEnv } from '../src/types.js';

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

const PKG = '0x' + '1'.repeat(64);
const CONFIG = '0x' + '2'.repeat(64);
const REGISTRY = '0x' + '3'.repeat(64);
const POOL = '0x' + '4'.repeat(64);
const PAYMENT_COIN = '0x' + '5'.repeat(64);
const VAULT = '0x' + '7'.repeat(64);
const RECIPIENT = '0x' + 'b'.repeat(64);
const ROUNDTRIP_RECIPIENT = '0x' + 'c'.repeat(64);

const PAYMENT_TYPE = `${PKG}::token::TOKEN`;

const ONCHAIN_CONFIG: OnchainConfig = {
  packageId: PKG,
  configId: CONFIG,
  maxClaimMist: 50_000_000n,
  minSettleMist: 100_000n,
  maxHostFeeMist: 500_000n,
  protocolFlatFeeMist: 20_004n,
  configVersion: 5n,
  maxSpreadBps: 500n,
};

const RELAYER_ENV: RelayerEnv = {
  network: 'testnet',
  relayerAddress: ROUNDTRIP_RECIPIENT,
  configId: CONFIG,
  vaultRegistryId: REGISTRY,
  packageId: PKG,
  allowedSettlementSwapPaths: [
    {
      tokenType: PAYMENT_TYPE,
      hops: [POOL],
      settlementSwapDirection: 'baseForQuote',
    },
    {
      tokenType: PAYMENT_TYPE,
      hops: [POOL],
      settlementSwapDirection: 'quoteForBase',
    },
  ],
};

const SHARED_PARAMS = {
  packageId: PKG,
  configId: CONFIG,
  vaultRegistryId: REGISTRY,
  paymentCoinId: PAYMENT_COIN,
  swapAmount: 1_000_000n,
  minSuiOut: 0n,
  executionCostClaim: 5_000_000n,
  settlementPayoutRecipient: RECIPIENT,
  receiptId: new Uint8Array(32).fill(0xaa),
  nonce: 1n,
  simGasReported: 5_000_000n,
  gasVarianceFixedMist: 200_000n,
  slippageBufferMist: 50_000n,
  quotedHostFeeMist: 100_000n,
  expectedProtocolFeeMist: 20_000n,
  expectedConfigVersion: 1n,
  quoteTimestampMs: 1741680000000,
  policyHash: new Uint8Array(32).fill(0xbb),
  orderIdHash: new Uint8Array(0),
};

/** Build a Transaction and return { rawCommands, normalizedCommands, inputs }. */
function getCommands(buildFn: (tx: Transaction) => void) {
  const tx = new Transaction();
  buildFn(tx);
  const data = tx.getData() as { commands: unknown[]; inputs: unknown[] };
  return {
    rawCommands: data.commands,
    normalizedCommands: convertSdkCommands(data.commands),
    inputs: data.inputs,
  };
}

/** Extract the MoveCall details from raw SDK commands (nested $kind shape). */
function findMoveCall(rawCommands: unknown[]) {
  for (const cmd of rawCommands) {
    if (typeof cmd !== 'object' || cmd === null) continue;
    const c = cmd as Record<string, unknown>;
    if (c.$kind !== 'MoveCall') continue;
    const mc = c.MoveCall as {
      package: string;
      module: string;
      function: string;
      typeArguments: string[];
    };
    return mc;
  }
  throw new Error('No MoveCall command found in raw commands');
}

// ─────────────────────────────────────────────
// SettlementSwapDirection × variant type-argument wiring
// ─────────────────────────────────────────────

describe('buildSwapAndSettlePtb — type argument wiring per SettlementSwapDirection', () => {
  const cases: Array<{
    settlementSwapDirection: SettlementSwapDirection;
    expectedNewUserFunction: string;
    expectedWithVaultFunction: string;
  }> = [
    {
      settlementSwapDirection: 'baseForQuote',
      expectedNewUserFunction: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser,
      expectedWithVaultFunction: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.withVault,
    },
    {
      settlementSwapDirection: 'quoteForBase',
      expectedNewUserFunction: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.quoteForBase.newUser,
      expectedWithVaultFunction: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.quoteForBase.withVault,
    },
  ];

  for (const {
    settlementSwapDirection,
    expectedNewUserFunction,
    expectedWithVaultFunction,
  } of cases) {
    describe(`${settlementSwapDirection}`, () => {
      it(`new_user → Move call type args start with settlementTokenType`, () => {
        const { rawCommands } = getCommands((tx) => {
          buildSwapAndSettlePtb(tx, {
            variant: 'new_user',
            settlementSwapDirection: settlementSwapDirection as 'baseForQuote' | 'quoteForBase',
            settlementTokenType: PAYMENT_TYPE,
            poolId: POOL,
            ...SHARED_PARAMS,
          });
        });
        const call = findMoveCall(rawCommands);
        expect(call.function).toBe(expectedNewUserFunction);
        expect(call.typeArguments[0]).toBe(PAYMENT_TYPE);
        expect(call.typeArguments).toEqual([PAYMENT_TYPE]);
      });

      it(`with_vault → Move call type args start with settlementTokenType`, () => {
        const { rawCommands } = getCommands((tx) => {
          buildSwapAndSettlePtb(tx, {
            variant: 'with_vault',
            settlementSwapDirection: settlementSwapDirection as 'baseForQuote' | 'quoteForBase',
            settlementTokenType: PAYMENT_TYPE,
            poolId: POOL,
            vaultId: VAULT,
            useCreditAmount: 0n,
            ...SHARED_PARAMS,
          });
        });
        const call = findMoveCall(rawCommands);
        expect(call.function).toBe(expectedWithVaultFunction);
        expect(call.typeArguments[0]).toBe(PAYMENT_TYPE);
        expect(call.typeArguments).toEqual([PAYMENT_TYPE]);
      });

      it(`parseSettleArgs extractedSettlementSwapPath reports settlementTokenType + settlementSwapDirection + hops`, () => {
        const { normalizedCommands, inputs } = getCommands((tx) => {
          buildSwapAndSettlePtb(tx, {
            variant: 'new_user',
            settlementSwapDirection: settlementSwapDirection as 'baseForQuote' | 'quoteForBase',
            settlementTokenType: PAYMENT_TYPE,
            poolId: POOL,
            ...SHARED_PARAMS,
          });
        });
        const parsed = parseSettleArgs(normalizedCommands, inputs, PKG);
        expect(parsed.extractedSettlementSwapPath).toBeDefined();
        expect(parsed.extractedSettlementSwapPath!.tokenType).toBe(PAYMENT_TYPE);
        expect(parsed.extractedSettlementSwapPath!.settlementSwapDirection).toBe(
          settlementSwapDirection,
        );
        expect(parsed.extractedSettlementSwapPath!.hops).toEqual([POOL]);
      });
    });
  }
});

// ─────────────────────────────────────────────
// Full roundtrip: builder → parser settle field value verification
//
// Verifies that every extractable settle field retains its original value
// after build → parse. Uses distinct non-zero values for all fields so
// any push-order swap would cause a mismatch.
// ─────────────────────────────────────────────

/** Distinct values for all 13 settle fields. Each bigint is unique. */
const ROUNDTRIP_VALUES = {
  executionCostClaim: 7_777_777n,
  settlementPayoutRecipient: ROUNDTRIP_RECIPIENT,
  receiptId: new Uint8Array(32).fill(0xdd),
  nonce: 42n,
  simGasReported: 3_000_000n,
  gasVarianceFixedMist: 200_001n,
  slippageBufferMist: 50_002n,
  quotedHostFeeMist: 100_003n,
  expectedProtocolFeeMist: 20_004n,
  expectedConfigVersion: 5n,
  quoteTimestampMs: 1741680099000,
  policyHash: new Uint8Array(32).fill(0xee),
  orderIdHash: new Uint8Array(32).fill(0xff),
};

const CREDIT_ROUNDTRIP_VALUES = {
  ...ROUNDTRIP_VALUES,
  slippageBufferMist: 0n,
};

describe('builder → parser settle field roundtrip', () => {
  /**
   * Assert that every field in SETTLE_FIELD_SCHEMA (13 total) round-trips
   * through builder → BCS → parser with its original value, including the
   * sponsor-side tx-derived fields `receiptId`, `simGasReported`,
   * `gasVarianceFixedMist`, `slippageBufferMist`, and `quoteTimestampMs`.
   */
  function expectRoundtripAll(
    parsed: ReturnType<typeof parseSettleArgs>,
    expected = ROUNDTRIP_VALUES,
  ): void {
    expect(parsed.executionCostClaim).toBe(expected.executionCostClaim);
    expect(parsed.settlementPayoutRecipient).toBe(expected.settlementPayoutRecipient);
    expect(parsed.receiptId).toEqual(expected.receiptId);
    expect(parsed.nonce).toBe(expected.nonce);
    expect(parsed.simGasReported).toBe(expected.simGasReported);
    expect(parsed.gasVarianceFixedMist).toBe(expected.gasVarianceFixedMist);
    expect(parsed.slippageBufferMist).toBe(expected.slippageBufferMist);
    expect(parsed.quotedHostFeeMist).toBe(expected.quotedHostFeeMist);
    expect(parsed.expectedProtocolFeeMist).toBe(expected.expectedProtocolFeeMist);
    expect(parsed.expectedConfigVersion).toBe(expected.expectedConfigVersion);
    expect(parsed.quoteTimestampMs).toBe(BigInt(expected.quoteTimestampMs));
    expect(parsed.policyHash).toEqual(expected.policyHash);
    expect(parsed.orderIdHash).toEqual(expected.orderIdHash);
  }

  it(`${SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser}: all 13 settle fields round-trip`, () => {
    const { normalizedCommands, inputs } = getCommands((tx) => {
      buildSwapAndSettlePtb(tx, {
        variant: 'new_user',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        packageId: PKG,
        configId: CONFIG,
        vaultRegistryId: REGISTRY,
        paymentCoinId: PAYMENT_COIN,
        swapAmount: 1_000_000n,
        minSuiOut: 0n,
        ...ROUNDTRIP_VALUES,
      });
    });
    const parsed = parseSettleArgs(normalizedCommands, inputs, PKG);
    expectRoundtripAll(parsed);
  });

  it(`${SETTLE_WITH_CREDIT_FUNCTION}: all 13 settle fields round-trip with zero slippage buffer`, () => {
    const { normalizedCommands, inputs } = getCommands((tx) => {
      buildSettleWithCreditPtb(tx, {
        packageId: PKG,
        configId: CONFIG,
        vaultRegistryId: REGISTRY,
        vaultId: VAULT,
        useCreditAmount: 500_000n,
        ...CREDIT_ROUNDTRIP_VALUES,
      });
    });
    const parsed = parseSettleArgs(normalizedCommands, inputs, PKG);
    expectRoundtripAll(parsed, CREDIT_ROUNDTRIP_VALUES);
    // Credit path has no extractedSettlementSwapPath
    expect(parsed.extractedSettlementSwapPath).toBeUndefined();
  });

  it(`${SETTLE_WITH_CREDIT_FUNCTION}: rejects non-zero slippage buffer at builder boundary`, () => {
    expect(() =>
      getCommands((tx) => {
        buildSettleWithCreditPtb(tx, {
          packageId: PKG,
          configId: CONFIG,
          vaultRegistryId: REGISTRY,
          vaultId: VAULT,
          useCreditAmount: 500_000n,
          ...ROUNDTRIP_VALUES,
        });
      }),
    ).toThrow(/slippageBufferMist=0/);
  });

  it('SETTLE_FIELD_SCHEMA has exactly 13 fields', () => {
    expect(SETTLE_FIELD_SCHEMA).toHaveLength(13);
  });
});

describe('builder, parser, and static validation share every current settlement function', () => {
  const cases = [
    {
      functionName: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser,
      build: (tx: Transaction) =>
        buildSwapAndSettlePtb(tx, {
          variant: 'new_user',
          settlementSwapDirection: 'baseForQuote',
          settlementTokenType: PAYMENT_TYPE,
          poolId: POOL,
          packageId: PKG,
          configId: CONFIG,
          vaultRegistryId: REGISTRY,
          paymentCoinId: PAYMENT_COIN,
          swapAmount: 1_000_000n,
          minSuiOut: 0n,
          ...ROUNDTRIP_VALUES,
        }),
    },
    {
      functionName: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.quoteForBase.newUser,
      build: (tx: Transaction) =>
        buildSwapAndSettlePtb(tx, {
          variant: 'new_user',
          settlementSwapDirection: 'quoteForBase',
          settlementTokenType: PAYMENT_TYPE,
          poolId: POOL,
          packageId: PKG,
          configId: CONFIG,
          vaultRegistryId: REGISTRY,
          paymentCoinId: PAYMENT_COIN,
          swapAmount: 1_000_000n,
          minSuiOut: 0n,
          ...ROUNDTRIP_VALUES,
        }),
    },
    {
      functionName: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.withVault,
      build: (tx: Transaction) =>
        buildSwapAndSettlePtb(tx, {
          variant: 'with_vault',
          settlementSwapDirection: 'baseForQuote',
          settlementTokenType: PAYMENT_TYPE,
          poolId: POOL,
          vaultId: VAULT,
          useCreditAmount: 0n,
          packageId: PKG,
          configId: CONFIG,
          vaultRegistryId: REGISTRY,
          paymentCoinId: PAYMENT_COIN,
          swapAmount: 1_000_000n,
          minSuiOut: 0n,
          ...ROUNDTRIP_VALUES,
        }),
    },
    {
      functionName: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.quoteForBase.withVault,
      build: (tx: Transaction) =>
        buildSwapAndSettlePtb(tx, {
          variant: 'with_vault',
          settlementSwapDirection: 'quoteForBase',
          settlementTokenType: PAYMENT_TYPE,
          poolId: POOL,
          vaultId: VAULT,
          useCreditAmount: 0n,
          packageId: PKG,
          configId: CONFIG,
          vaultRegistryId: REGISTRY,
          paymentCoinId: PAYMENT_COIN,
          swapAmount: 1_000_000n,
          minSuiOut: 0n,
          ...ROUNDTRIP_VALUES,
        }),
    },
    {
      functionName: SETTLE_WITH_CREDIT_FUNCTION,
      build: (tx: Transaction) =>
        buildSettleWithCreditPtb(tx, {
          packageId: PKG,
          configId: CONFIG,
          vaultRegistryId: REGISTRY,
          vaultId: VAULT,
          useCreditAmount: 500_000n,
          ...CREDIT_ROUNDTRIP_VALUES,
        }),
    },
  ] as const;

  it('test cases cover exactly SETTLE_FUNCTIONS', () => {
    expect(new Set(cases.map((entry) => entry.functionName))).toEqual(SETTLE_FUNCTIONS);
  });

  for (const entry of cases) {
    it(`${entry.functionName}: builder output parses and validates`, () => {
      const { rawCommands, normalizedCommands, inputs } = getCommands(entry.build);
      const call = findMoveCall(rawCommands);
      expect(call.function).toBe(entry.functionName);

      expect(validatePtbStructure(normalizedCommands, RELAYER_ENV)).toEqual({ ok: true });
      const parsed = parseSettleArgs(normalizedCommands, inputs, PKG);
      expect(validateSettleArgs(parsed, ONCHAIN_CONFIG, RELAYER_ENV)).toEqual({ ok: true });
    });
  }
});
