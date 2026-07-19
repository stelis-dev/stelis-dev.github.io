/** Behavioral tests for the core-api wrapper around the compiled-interface
 * settle argument parser. The parser's derived index table is intentionally
 * not exposed through the package boundary.
 */
import { describe, it, expect } from 'vitest';
import { extractSettleArgsFromBuiltTx } from '../src/prepare/extractSettleArgs.js';
import { PrepareValidationError } from '../src/prepare/replay.js';
import { toBase64 } from '@mysten/sui/utils';
import {
  SETTLE_WITH_CREDIT_FUNCTION,
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
  type PtbCommand,
} from '@stelis/contracts';
import type { HostValidationEnv } from '@stelis/core-relay';

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

const DUMMY_ENV: HostValidationEnv = {
  network: 'testnet',
  settlementPayoutRecipientAddress: '0x' + 'ff'.repeat(32),
  configId: '0x' + '22'.repeat(32),
  vaultRegistryId: '0x' + '33'.repeat(32),
  packageId: '0x' + '11'.repeat(32),
  allowedSettlementSwapPaths: [],
};

const CONFIG_ID = DUMMY_ENV.configId;
const REGISTRY_ID = DUMMY_ENV.vaultRegistryId;
const CLOCK_ID = `0x${'44'.repeat(32)}`;
const VAULT_ID = `0x${'55'.repeat(32)}`;
const POOL_ID = `0x${'66'.repeat(32)}`;
const PAYMENT_COIN_ID = `0x${'77'.repeat(32)}`;
const SETTLEMENT_TOKEN_TYPE = `0x${'88'.repeat(32)}::deep::DEEP`;

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
      makeObjectInput(CONFIG_ID), // 0: config
      makeObjectInput(REGISTRY_ID), // 1: registry
      makeObjectInput(CLOCK_ID), // 2: clock
      makeObjectInput(VAULT_ID), // 3: vault
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
    expect(result.configObjectId).toBe(CONFIG_ID);
    expect(result.registryObjectId).toBe(REGISTRY_ID);
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
      makeObjectInput(CONFIG_ID), // 0: config
      makeObjectInput(REGISTRY_ID), // 1: registry
      makeObjectInput(CLOCK_ID), // 2: clock
      makeObjectInput(POOL_ID), // 3: pool
      makeObjectInput(PAYMENT_COIN_ID), // 4: paymentCoin
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
        typeArguments: [SETTLEMENT_TOKEN_TYPE],
        arguments: inputs.map((_, i) => makeInputRef(i)),
      },
    ];

    const result = extractSettleArgsFromBuiltTx(commands, inputs, DUMMY_ENV);
    expect(result.extractedSettlementSwapPath).toBeDefined();
    expect(result.extractedSettlementSwapPath!.tokenType).toBe(SETTLEMENT_TOKEN_TYPE);
    expect(result.extractedSettlementSwapPath!.hops).toEqual([POOL_ID]);
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
// isNewUserSettleMoveCall — new-user User Vault drift discriminator
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
