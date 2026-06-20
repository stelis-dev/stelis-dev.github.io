/**
 * ARG_INDEX_MAP locking tests — extractSettleArgsFromBuiltTx.
 *
 * Verifies that the argument index mapping for each settle function
 * exactly matches the Move call layout in builders.ts.
 *
 * If builders.ts changes its argument order, these tests must break
 * immediately, forcing a synchronized update to ARG_INDEX_MAP.
 *
 * References:
 *   builders.ts:buildSwapAndSettlePtb (L120-L228)
 *   builders.ts:buildSettleWithCreditPtb (L250-L276)
 */
import { describe, it, expect } from 'vitest';
import { ARG_INDEX_MAP } from '../src/prepare/extractSettleArgs.js';
import {
  SETTLE_FUNCTIONS,
  SETTLE_WITH_CREDIT_FUNCTION,
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
} from '@stelis/contracts';

describe('ARG_INDEX_MAP locking tests', () => {
  // ─────────────────────────────────────────────
  // Coverage check: map covers every SETTLE_FUNCTIONS entry
  // ─────────────────────────────────────────────
  it('covers all SETTLE_FUNCTIONS entries', () => {
    for (const fnName of SETTLE_FUNCTIONS) {
      expect(ARG_INDEX_MAP[fnName]).toBeDefined();
    }
  });

  it('has no extra entries beyond SETTLE_FUNCTIONS', () => {
    for (const fnName of Object.keys(ARG_INDEX_MAP)) {
      expect(SETTLE_FUNCTIONS.has(fnName)).toBe(true);
    }
  });

  // ─────────────────────────────────────────────
  // Common invariants across all functions
  // ─────────────────────────────────────────────
  it('config is always at index 0', () => {
    for (const map of Object.values(ARG_INDEX_MAP)) {
      expect(map.config).toBe(0);
    }
  });

  it('vault-backed variants have registry at index 1', () => {
    for (const [_fnName, map] of Object.entries(ARG_INDEX_MAP)) {
      expect(map.registry).toBe(1);
    }
  });

  it('recipient is always claim + 1', () => {
    for (const map of Object.values(ARG_INDEX_MAP)) {
      expect(map.recipient).toBe(map.claim + 1);
    }
  });

  // ─────────────────────────────────────────────
  // Per-function exact index assertions
  // (derived from builders.ts argument layout)
  // ─────────────────────────────────────────────

  // New-user base-for-quote settlement:
  //   [config(0), registry(1), clock(2), pool(3), payment(4), swapAmt(5), minSuiOut(6),
  //    claim(7), recipient(8), receiptId(9), nonce(10), simGas(11),
  //    gasVariance(12), slippage(13), quotedHostFee(14), expectedProtocol(15), expectedConfig(16),
  //    quoteTs(17), policyHash(18), orderIdHash(19)]
  it('new-user base-for-quote settlement: claim=7, recipient=8, pools=[3], nonce=10, policyHash=18, orderIdHash=19', () => {
    const m = ARG_INDEX_MAP[SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser]!;
    expect(m.claim).toBe(7);
    expect(m.recipient).toBe(8);
    expect(m.pools).toEqual([3]);
    expect(m.nonce).toBe(10);
    expect(m.policyHash).toBe(18);
    expect(m.orderIdHash).toBe(19);
  });

  // Vault-backed base-for-quote settlement:
  //   [config(0), registry(1), clock(2), vault(3), pool(4), payment(5), swapAmt(6), minSuiOut(7),
  //    claim(8), recipient(9), receiptId(10), nonce(11), ..., quotedHostFee(15), ..., policyHash(19), orderIdHash(20)]
  it('vault-backed base-for-quote settlement: claim=8, recipient=9, pools=[4], nonce=11, policyHash=19, orderIdHash=20', () => {
    const m = ARG_INDEX_MAP[SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.withVault]!;
    expect(m.claim).toBe(8);
    expect(m.recipient).toBe(9);
    expect(m.pools).toEqual([4]);
    expect(m.nonce).toBe(11);
    expect(m.policyHash).toBe(19);
    expect(m.orderIdHash).toBe(20);
  });

  // Credit-only settlement:
  //   [config(0), registry(1), clock(2), vault(3), useCredit(4),
  //    claim(5), recipient(6), receiptId(7), nonce(8), simGas(9),
  //    gasVariance(10), slippage(11), quotedHostFee(12), expectedProtocol(13), expectedConfig(14),
  //    quoteTs(15), policyHash(16), orderIdHash(17)]
  it('credit-only settlement: claim=5, recipient=6, pools=[], nonce=8, policyHash=16, orderIdHash=17', () => {
    const m = ARG_INDEX_MAP[SETTLE_WITH_CREDIT_FUNCTION]!;
    expect(m.claim).toBe(5);
    expect(m.recipient).toBe(6);
    expect(m.pools).toEqual([]);
    expect(m.nonce).toBe(8);
    expect(m.policyHash).toBe(16);
    expect(m.orderIdHash).toBe(17);
  });
});

// ─────────────────────────────────────────────
// extractSettleArgsFromBuiltTx unit tests
// ─────────────────────────────────────────────

import { extractSettleArgsFromBuiltTx } from '../src/prepare/extractSettleArgs.js';
import { PrepareValidationError } from '../src/prepare/replay.js';
import { toBase64 } from '@mysten/sui/utils';
import type { PtbCommand } from '@stelis/contracts';
import type { RelayerEnv } from '@stelis/core-relay';

/** Encode a u64 as base64 BCS (8-byte little-endian). */
function encodeU64(value: bigint): string {
  const buf = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return toBase64(buf);
}

/** Encode a 32-byte address as base64. */
function encodeAddress(hex: string): string {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const buf = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    buf[i] = parseInt(h.slice(i * 2, i * 2 + 2) || '00', 16);
  }
  return toBase64(buf);
}

function makeInputRef(idx: number) {
  return { $kind: 'Input', Input: idx, type: 'pure' };
}

function makeObjectInput(objectId: string) {
  return {
    $kind: 'UnresolvedObject',
    UnresolvedObject: { objectId },
  };
}

function makePureU64Input(value: bigint) {
  return { $kind: 'Pure', Pure: { bytes: encodeU64(value) } };
}

function makePureAddressInput(hex: string) {
  return { $kind: 'Pure', Pure: { bytes: encodeAddress(hex) } };
}

/** Encode a vector<u8> as base64 BCS (ULEB128 length prefix + raw bytes). */
function encodePureVectorU8(data: Uint8Array): string {
  // ULEB128 encode length
  const lenBytes: number[] = [];
  let len = data.length;
  do {
    let byte = len & 0x7f;
    len >>= 7;
    if (len > 0) byte |= 0x80;
    lenBytes.push(byte);
  } while (len > 0);
  const buf = new Uint8Array(lenBytes.length + data.length);
  buf.set(lenBytes, 0);
  buf.set(data, lenBytes.length);
  return toBase64(buf);
}

function makePureVectorU8Input(data: Uint8Array) {
  return { $kind: 'Pure', Pure: { bytes: encodePureVectorU8(data) } };
}

const DUMMY_ENV: RelayerEnv = {
  network: 'testnet',
  relayerAddress: '0x' + 'ff'.repeat(32),
  configId: '0x' + '22'.repeat(32),
  vaultRegistryId: '0x' + '33'.repeat(32),
  packageId: '0x' + '11'.repeat(32),
  allowedSettlementSwapPaths: [],
};

describe('extractSettleArgsFromBuiltTx — unit tests', () => {
  it('throws L2_EXTRACT_FAILED when no settle command present', () => {
    const commands: PtbCommand[] = [{ kind: 'TransferObjects' }];
    expect(() => extractSettleArgsFromBuiltTx(commands, [], DUMMY_ENV)).toThrow(
      PrepareValidationError,
    );
  });

  it('throws L2_EXTRACT_FAILED for unknown settle function', () => {
    const commands: PtbCommand[] = [
      {
        kind: 'MoveCall',
        packageId: '0x' + '11'.repeat(32),
        module: 'settle',
        function: 'totally_unknown_settle_fn',
        typeArguments: [],
        arguments: [],
      },
    ];
    expect(() => extractSettleArgsFromBuiltTx(commands, [], DUMMY_ENV)).toThrow(
      PrepareValidationError,
    );
  });

  it('credit-only settlement: extractedSettlementSwapPath is undefined', () => {
    // Credit-only args:
    // [config(0), registry(1), clock(2), vault(3), useCreditAmount(4),
    //  claim(5), recipient(6), receiptId(7), nonce(8), simGas(9),
    //  gasVariance(10), slippage(11), quotedHostFee(12), expectedProtocol(13), expectedConfig(14),
    //  quoteTs(15), policyHash(16), orderIdHash(17)]
    const policyHashData = new Uint8Array(32).fill(0xdd);
    const inputs: unknown[] = [
      makeObjectInput('0xCONFIG'), // 0: config
      makeObjectInput('0xREGISTRY'), // 1: registry
      makeObjectInput('0xCLOCK'), // 2: clock
      makeObjectInput('0xVAULT'), // 3: vault
      makePureU64Input(1000n), // 4: useCreditAmount
      makePureU64Input(5_000_000n), // 5: executionCostClaim
      makePureAddressInput('0x' + 'aa'.repeat(32)), // 6: settlementPayoutRecipient
      makePureVectorU8Input(new Uint8Array(0)), // 7: receiptId (empty)
      makePureU64Input(1n), // 8: nonce
      makePureU64Input(1_000_000n), // 9: simGasReported
      makePureU64Input(100_000n), // 10: gasVarianceFixedMist
      makePureU64Input(0n), // 11: slippageBufferMist
      makePureU64Input(500_000n), // 12: quotedHostFeeMist
      makePureU64Input(100_000n), // 13: expectedProtocolFeeMist
      makePureU64Input(1n), // 14: expectedConfigVersion
      makePureU64Input(BigInt(Date.now())), // 15: quoteTimestampMs
      makePureVectorU8Input(policyHashData), // 16: policyHash
      makePureVectorU8Input(new Uint8Array(0)), // 17: orderIdHash (empty)
    ];
    const commands: PtbCommand[] = [
      {
        kind: 'MoveCall',
        packageId: '0x' + '11'.repeat(32),
        module: 'settle',
        function: SETTLE_WITH_CREDIT_FUNCTION,
        typeArguments: [],
        arguments: inputs.map((_, i) => makeInputRef(i)),
      },
    ];

    const result = extractSettleArgsFromBuiltTx(commands, inputs, DUMMY_ENV);
    expect(result.extractedSettlementSwapPath).toBeUndefined();
    expect(result.executionCostClaim).toBe(5_000_000n);
    expect(result.configObjectId).toBe('0xCONFIG');
    expect(result.registryObjectId).toBe('0xREGISTRY');
    expect(result.policyHash).toEqual(policyHashData);
    // 5 tx-derived fields:
    expect(result.receiptId).toEqual(new Uint8Array(0));
    expect(result.simGasReported).toBe(1_000_000n);
    expect(result.gasVarianceFixedMist).toBe(100_000n);
    expect(result.slippageBufferMist).toBe(0n);
    expect(typeof result.quoteTimestampMs).toBe('bigint');
  });

  it('new-user base-for-quote settlement: extracts settlement swap path with tokenType, hops, settlementSwapDirection', () => {
    // [config(0), registry(1), clock(2), pool(3), payment(4),
    //  swapAmt(5), minSuiOut(6), claim(7), recipient(8), receiptId(9), nonce(10), simGas(11),
    //  gasVariance(12), slippage(13), quotedHostFee(14), expectedProtocol(15), expectedConfig(16),
    //  quoteTs(17), policyHash(18), orderIdHash(19)]
    const policyHashData = new Uint8Array(32).fill(0xee);
    const inputs: unknown[] = [
      makeObjectInput('0xCONFIG'), // 0: config
      makeObjectInput('0xREGISTRY'), // 1: registry
      makeObjectInput('0xCLOCK'), // 2: clock
      makeObjectInput('0xPOOL1'), // 3: pool
      makeObjectInput('0xCOIN'), // 4: paymentCoin
      makePureU64Input(1000n), // 5: swapAmount
      makePureU64Input(500n), // 6: minSuiOut
      makePureU64Input(3_000_000n), // 7: executionCostClaim
      makePureAddressInput('0x' + 'bb'.repeat(32)), // 8: settlementPayoutRecipient
      makePureVectorU8Input(new Uint8Array(32).fill(0x01)), // 9: receiptId
      makePureU64Input(1n), // 10: nonce
      makePureU64Input(1_000_000n), // 11: simGasReported
      makePureU64Input(100_000n), // 12: gasVarianceFixedMist
      makePureU64Input(50_000n), // 13: slippageBufferMist
      makePureU64Input(500_000n), // 14: quotedHostFeeMist
      makePureU64Input(100_000n), // 15: expectedProtocolFeeMist
      makePureU64Input(1n), // 16: expectedConfigVersion
      makePureU64Input(BigInt(Date.now())), // 17: quoteTimestampMs
      makePureVectorU8Input(policyHashData), // 18: policyHash
      makePureVectorU8Input(new Uint8Array(0)), // 19: orderIdHash (empty)
    ];
    const commands: PtbCommand[] = [
      {
        kind: 'MoveCall',
        packageId: '0x' + '11'.repeat(32),
        module: 'settle',
        function: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser,
        typeArguments: ['0xDEEP::deep::DEEP'],
        arguments: inputs.map((_, i) => makeInputRef(i)),
      },
    ];

    const result = extractSettleArgsFromBuiltTx(commands, inputs, DUMMY_ENV);
    expect(result.extractedSettlementSwapPath).toBeDefined();
    expect(result.extractedSettlementSwapPath!.tokenType).toBe('0xDEEP::deep::DEEP');
    expect(result.extractedSettlementSwapPath!.hops).toEqual(['0xPOOL1']);
    expect(result.extractedSettlementSwapPath!.settlementSwapDirection).toBe('baseForQuote');
    expect(result.executionCostClaim).toBe(3_000_000n);
    expect(result.policyHash).toEqual(policyHashData);
    // 5 tx-derived fields:
    expect(result.receiptId).toEqual(new Uint8Array(32).fill(0x01));
    expect(result.simGasReported).toBe(1_000_000n);
    expect(result.gasVarianceFixedMist).toBe(100_000n);
    expect(result.slippageBufferMist).toBe(50_000n);
    expect(typeof result.quoteTimestampMs).toBe('bigint');
  });
});

// ─────────────────────────────────────────────
// isNewUserSettleMoveCall — new-user vault drift discriminator
// ─────────────────────────────────────────────

import { isNewUserSettleMoveCall } from '../src/prepare/extractSettleArgs.js';

describe('isNewUserSettleMoveCall — unit tests', () => {
  const STELIS_PKG = '0x' + '11'.repeat(32);
  const FOREIGN_PKG = '0x' + '99'.repeat(32);

  function buildSettleCmd(packageId: string, fn: string): PtbCommand {
    return {
      kind: 'MoveCall',
      packageId,
      module: 'settle',
      function: fn,
      typeArguments: [],
      arguments: [],
    };
  }

  it('returns true for new-user base-for-quote settlement on the trusted Stelis package', () => {
    const commands: PtbCommand[] = [
      buildSettleCmd(STELIS_PKG, SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser),
    ];
    expect(isNewUserSettleMoveCall(commands, STELIS_PKG)).toBe(true);
  });

  it('returns true for new-user quote-for-base settlement on the trusted Stelis package', () => {
    const commands: PtbCommand[] = [
      buildSettleCmd(STELIS_PKG, SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.quoteForBase.newUser),
    ];
    expect(isNewUserSettleMoveCall(commands, STELIS_PKG)).toBe(true);
  });

  it('returns false for vault-backed base-for-quote settlement', () => {
    const commands: PtbCommand[] = [
      buildSettleCmd(STELIS_PKG, SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.withVault),
    ];
    expect(isNewUserSettleMoveCall(commands, STELIS_PKG)).toBe(false);
  });

  it('returns false for vault-backed quote-for-base settlement', () => {
    const commands: PtbCommand[] = [
      buildSettleCmd(STELIS_PKG, SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.quoteForBase.withVault),
    ];
    expect(isNewUserSettleMoveCall(commands, STELIS_PKG)).toBe(false);
  });

  it('returns false for credit-only settlement', () => {
    const commands: PtbCommand[] = [buildSettleCmd(STELIS_PKG, SETTLE_WITH_CREDIT_FUNCTION)];
    expect(isNewUserSettleMoveCall(commands, STELIS_PKG)).toBe(false);
  });

  it('returns false when the new-user fn name appears on a foreign package (package-bound)', () => {
    const commands: PtbCommand[] = [
      buildSettleCmd(FOREIGN_PKG, SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser),
    ];
    expect(isNewUserSettleMoveCall(commands, STELIS_PKG)).toBe(false);
  });

  it('returns false when the new-user fn name appears on a non-settle module (module-bound)', () => {
    const commands: PtbCommand[] = [
      {
        kind: 'MoveCall',
        packageId: STELIS_PKG,
        module: 'fake_settle',
        function: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser,
        typeArguments: [],
        arguments: [],
      },
    ];
    expect(isNewUserSettleMoveCall(commands, STELIS_PKG)).toBe(false);
  });

  it('returns false on an empty command list', () => {
    expect(isNewUserSettleMoveCall([], STELIS_PKG)).toBe(false);
  });
});
