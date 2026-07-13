/**
 * settleArgsCost — unit tests for extractCostFromTxData and extractCostFromTxBytes.
 *
 * IMPORTANT: Uses tx.getData() (no tx.build() required) to get real PTB
 * commands/inputs built by buildSwapAndSettlePtb and buildSettleWithCreditPtb.
 * This verifies the fee parser against ACTUAL PTB structure without needing
 * a SuiClient for object resolution.
 *
 * costValidation.test.ts mocks extractCostFromTxBytes — this file validates
 * the underlying parser against real PTB command shapes.
 *
 * Covers:
 *   P-1: new-user swap settlement → correct fee extraction
 *   P-2: vault-backed swap settlement → correct fee extraction
 *   P-3: credit-only settlement → correct fee extraction
 *   P-4: wrong packageId → null return
 *   P-5: unrelated TX (no settle call) → null return
 *
 * Only one-hop settlement swap paths are supported.
 */
import { describe, it, expect } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { SETTLE_WITH_CREDIT_FUNCTION, SUI_TYPE } from '@stelis/contracts';
import { buildSwapAndSettlePtb, buildSettleWithCreditPtb } from '../src/ptb/builders.js';
import { extractCostFromTxData } from '../src/settleArgsCost.js';
import { ARG_INDEX_MAP } from '../src/parseSettleArgs.js';

// ─────────────────────────────────────────────
// Test constants
// ─────────────────────────────────────────────

const PKG = '0x' + '1'.repeat(64);
const CONFIG = '0x' + '2'.repeat(64);
const REGISTRY = '0x' + '3'.repeat(64);
const POOL = '0x' + '4'.repeat(64);
const PAYMENT_COIN = '0x' + '5'.repeat(64);
const VAULT = '0x' + '7'.repeat(64);
const RECIPIENT = '0x' + 'b'.repeat(64);
const DEEP_TYPE = `${PKG}::deep::DEEP`;

const QUOTED_HOST_FEE = 100_000n;
const EXPECTED_PROTOCOL_FEE = 20_000n;

const COMMON_SETTLE_PARAMS = {
  packageId: PKG,
  configId: CONFIG,
  vaultRegistryId: REGISTRY,
  executionCostClaim: 5_000_000n,
  settlementPayoutRecipient: RECIPIENT,
  receiptId: new Uint8Array(32).fill(0xaa),
  simGasReported: 5_000_000n,
  gasVarianceFixedMist: 200_000n,
  slippageBufferMist: 50_000n,
  nonce: 1n,
  quotedHostFeeMist: QUOTED_HOST_FEE,
  expectedProtocolFeeMist: EXPECTED_PROTOCOL_FEE,
  expectedConfigVersion: 1n,
  quoteTimestampMs: 1_741_680_000_000n,
  policyHash: new Uint8Array(32).fill(0xbb),
  orderIdHash: new Uint8Array(0),
};

/**
 * Build a Transaction and return its raw getData() (commands + inputs).
 * No tx.build() required — object IDs are unresolved but pure u64 values
 * (fees) are already encoded as Pure inputs, which is all the parser needs.
 */
function getTxData(buildFn: (tx: Transaction) => void): {
  commands: unknown[];
  inputs: unknown[];
} {
  const tx = new Transaction();
  buildFn(tx);
  return tx.getData() as { commands: unknown[]; inputs: unknown[] };
}

function patchPureInput(
  commands: unknown[],
  inputs: unknown[],
  argumentIndex: number,
  bytes: Uint8Array,
): unknown[] {
  const command = commands.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { $kind?: string }).$kind === 'MoveCall',
  ) as { MoveCall: { arguments: Array<{ Input: number }> } } | undefined;
  if (!command) throw new Error('test setup failed: MoveCall command not found');
  const inputIndex = command.MoveCall.arguments[argumentIndex]!.Input;
  const input = inputs[inputIndex] as { Pure: Record<string, unknown> };
  const patched = [...inputs];
  patched[inputIndex] = { ...input, Pure: { ...input.Pure, bytes: toBase64(bytes) } };
  return patched;
}

function patchMoveCall(
  commands: unknown[],
  patch: (moveCall: Record<string, unknown>) => Record<string, unknown>,
): unknown[] {
  let found = false;
  const patched = commands.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return candidate;
    const command = candidate as Record<string, unknown>;
    if (
      command.$kind !== 'MoveCall' ||
      typeof command.MoveCall !== 'object' ||
      command.MoveCall === null
    ) {
      return candidate;
    }
    found = true;
    return { ...command, MoveCall: patch(command.MoveCall as Record<string, unknown>) };
  });
  if (!found) throw new Error('test setup failed: MoveCall command not found');
  return patched;
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('extractCostFromTxData — real PTB command/input structures', () => {
  // P-1: new-user swap settlement
  it('P-1: extracts fees from new-user swap settlement', () => {
    const { commands, inputs } = getTxData((tx) => {
      buildSwapAndSettlePtb(tx, {
        variant: 'new_user',
        ...COMMON_SETTLE_PARAMS,
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: DEEP_TYPE,
        poolId: POOL,
        paymentCoinId: PAYMENT_COIN,
        swapAmount: 1_000_000n,
        minSuiOut: 0n,
      });
    });

    const result = extractCostFromTxData(commands, inputs, PKG);
    expect(result).not.toBeNull();
    expect(result!.executionCostClaimMist).toBe(COMMON_SETTLE_PARAMS.executionCostClaim);
    expect(result!.quotedHostFeeMist).toBe(QUOTED_HOST_FEE);
    expect(result!.expectedProtocolFeeMist).toBe(EXPECTED_PROTOCOL_FEE);
  });

  // P-2: vault-backed swap settlement
  it('P-2: extracts fees from vault-backed swap settlement', () => {
    const { commands, inputs } = getTxData((tx) => {
      buildSwapAndSettlePtb(tx, {
        variant: 'with_vault',
        ...COMMON_SETTLE_PARAMS,
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: DEEP_TYPE,
        poolId: POOL,
        paymentCoinId: PAYMENT_COIN,
        swapAmount: 1_000_000n,
        minSuiOut: 0n,
        vaultId: VAULT,
        useCreditAmount: 0n,
      });
    });

    const result = extractCostFromTxData(commands, inputs, PKG);
    expect(result).not.toBeNull();
    expect(result!.executionCostClaimMist).toBe(COMMON_SETTLE_PARAMS.executionCostClaim);
    expect(result!.quotedHostFeeMist).toBe(QUOTED_HOST_FEE);
    expect(result!.expectedProtocolFeeMist).toBe(EXPECTED_PROTOCOL_FEE);
  });

  // P-3: credit-only settlement
  it('P-3: extracts fees from credit-only settlement', () => {
    const { commands, inputs } = getTxData((tx) => {
      buildSettleWithCreditPtb(tx, {
        ...COMMON_SETTLE_PARAMS,
        vaultId: VAULT,
        useCreditAmount: 1_000_000n,
        slippageBufferMist: 0n,
      });
    });

    const result = extractCostFromTxData(commands, inputs, PKG);
    expect(result).not.toBeNull();
    expect(result!.executionCostClaimMist).toBe(COMMON_SETTLE_PARAMS.executionCostClaim);
    expect(result!.quotedHostFeeMist).toBe(QUOTED_HOST_FEE);
    expect(result!.expectedProtocolFeeMist).toBe(EXPECTED_PROTOCOL_FEE);
  });

  it('returns null when a settlement call has extra value arguments', () => {
    const { commands, inputs } = getTxData((tx) => {
      buildSettleWithCreditPtb(tx, {
        ...COMMON_SETTLE_PARAMS,
        vaultId: VAULT,
        useCreditAmount: 1_000_000n,
        slippageBufferMist: 0n,
      });
    });
    const malformedCommands = patchMoveCall(commands, (moveCall) => ({
      ...moveCall,
      arguments: [...(moveCall.arguments as unknown[]), (moveCall.arguments as unknown[])[0]],
    }));

    expect(extractCostFromTxData(malformedCommands, inputs, PKG)).toBeNull();
  });

  it('returns null when a settlement call has extra type arguments', () => {
    const { commands, inputs } = getTxData((tx) => {
      buildSwapAndSettlePtb(tx, {
        variant: 'new_user',
        ...COMMON_SETTLE_PARAMS,
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: DEEP_TYPE,
        poolId: POOL,
        paymentCoinId: PAYMENT_COIN,
        swapAmount: 1_000_000n,
        minSuiOut: 0n,
      });
    });
    const malformedCommands = patchMoveCall(commands, (moveCall) => ({
      ...moveCall,
      typeArguments: [...(moveCall.typeArguments as unknown[]), SUI_TYPE],
    }));

    expect(extractCostFromTxData(malformedCommands, inputs, PKG)).toBeNull();
  });

  for (const width of [7, 9]) {
    it(`rejects ${width}-byte Pure u64 cost inputs`, () => {
      const { commands, inputs } = getTxData((tx) => {
        buildSettleWithCreditPtb(tx, {
          ...COMMON_SETTLE_PARAMS,
          vaultId: VAULT,
          useCreditAmount: 1_000_000n,
          slippageBufferMist: 0n,
        });
      });
      const argumentIndex = ARG_INDEX_MAP[SETTLE_WITH_CREDIT_FUNCTION]!.quotedHostFee;
      const patchedInputs = patchPureInput(commands, inputs, argumentIndex, new Uint8Array(width));

      expect(extractCostFromTxData(commands, patchedInputs, PKG)).toBeNull();
    });
  }

  // P-4: wrong packageId → settle command not found → null
  it('P-4: returns null when packageId does not match', () => {
    const { commands, inputs } = getTxData((tx) => {
      buildSwapAndSettlePtb(tx, {
        variant: 'new_user',
        ...COMMON_SETTLE_PARAMS,
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: DEEP_TYPE,
        poolId: POOL,
        paymentCoinId: PAYMENT_COIN,
        swapAmount: 1_000_000n,
        minSuiOut: 0n,
      });
    });

    const wrongPkg = '0x' + 'f'.repeat(64);
    const result = extractCostFromTxData(commands, inputs, wrongPkg);
    expect(result).toBeNull();
  });

  // P-5: TX with no settle call → null
  it('P-5: returns null for transaction with no settle call', () => {
    const { commands, inputs } = getTxData((tx) => {
      tx.moveCall({
        target: `${PKG}::not_settle::some_function`,
        arguments: [],
      });
    });

    const result = extractCostFromTxData(commands, inputs, PKG);
    expect(result).toBeNull();
  });
});
