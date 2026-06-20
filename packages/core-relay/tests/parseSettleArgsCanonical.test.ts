import { describe, expect, it } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { SETTLE_WITH_CREDIT_FUNCTION } from '@stelis/contracts';
import { convertSdkCommands } from '../src/convert.js';
import { ARG_INDEX_MAP, parseSettleArgs, ParseSettleArgsError } from '../src/parseSettleArgs.js';
import { buildSettleWithCreditPtb } from '../src/ptb/builders.js';

const PKG = `0x${'1'.repeat(64)}`;
const CONFIG = `0x${'2'.repeat(64)}`;
const REGISTRY = `0x${'3'.repeat(64)}`;
const VAULT = `0x${'4'.repeat(64)}`;
const RECIPIENT = `0x${'5'.repeat(64)}`;

const SETTLE_PARAMS = {
  packageId: PKG,
  configId: CONFIG,
  vaultRegistryId: REGISTRY,
  vaultId: VAULT,
  useCreditAmount: 1_000_000n,
  executionCostClaim: 5_000_000n,
  settlementPayoutRecipient: RECIPIENT,
  receiptId: new Uint8Array(32).fill(0xaa),
  nonce: 7n,
  simGasReported: 4_800_000n,
  gasVarianceFixedMist: 200_000n,
  slippageBufferMist: 0n,
  quotedHostFeeMist: 100_000n,
  expectedProtocolFeeMist: 20_000n,
  expectedConfigVersion: 3n,
  quoteTimestampMs: 1_761_007_200_000,
  policyHash: new Uint8Array(32).fill(0xbb),
  orderIdHash: new Uint8Array(32).fill(0xcc),
};

function buildCreditData(): {
  commands: unknown[];
  normalizedCommands: ReturnType<typeof convertSdkCommands>;
  inputs: unknown[];
} {
  const tx = new Transaction();
  buildSettleWithCreditPtb(tx, SETTLE_PARAMS);
  const data = tx.getData() as { commands: unknown[]; inputs: unknown[] };
  return {
    commands: data.commands,
    normalizedCommands: convertSdkCommands(data.commands),
    inputs: data.inputs,
  };
}

function patchPureInputBytes(
  commands: unknown[],
  inputs: unknown[],
  argIndex: number,
  bytes: Uint8Array,
): unknown[] {
  const command = commands.find(
    (cmd) =>
      typeof cmd === 'object' && cmd !== null && (cmd as { $kind?: string }).$kind === 'MoveCall',
  ) as { MoveCall: { arguments: unknown[] } } | undefined;
  if (!command) throw new Error('test setup failed: MoveCall command not found');

  const inputRef = command.MoveCall.arguments[argIndex] as { $kind: 'Input'; Input: number };
  const input = inputs[inputRef.Input] as { Pure: Record<string, unknown> };
  const nextInputs = [...inputs];
  nextInputs[inputRef.Input] = {
    ...input,
    Pure: {
      ...input.Pure,
      bytes: toBase64(bytes),
    },
  };
  return nextInputs;
}

describe('parseSettleArgs canonical BCS input checks', () => {
  const indexMap = ARG_INDEX_MAP[SETTLE_WITH_CREDIT_FUNCTION]!;

  it('rejects overlong Pure u64 bytes', () => {
    const { commands, normalizedCommands, inputs } = buildCreditData();
    const patchedInputs = patchPureInputBytes(
      commands,
      inputs,
      indexMap.quotedHostFee,
      new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0]),
    );

    expect(() => parseSettleArgs(normalizedCommands, patchedInputs, PKG)).toThrow(
      ParseSettleArgsError,
    );
  });

  it('rejects non-canonical ULEB128 vector length prefixes', () => {
    const { commands, normalizedCommands, inputs } = buildCreditData();
    const patchedInputs = patchPureInputBytes(
      commands,
      inputs,
      indexMap.receiptId,
      new Uint8Array([0x80, 0x00]),
    );

    expect(() => parseSettleArgs(normalizedCommands, patchedInputs, PKG)).toThrow(
      ParseSettleArgsError,
    );
  });

  it('rejects trailing bytes after a vector<u8> payload', () => {
    const { commands, normalizedCommands, inputs } = buildCreditData();
    const patchedInputs = patchPureInputBytes(
      commands,
      inputs,
      indexMap.policyHash,
      new Uint8Array([0x00, 0xff]),
    );

    expect(() => parseSettleArgs(normalizedCommands, patchedInputs, PKG)).toThrow(
      ParseSettleArgsError,
    );
  });

  it('rejects ULEB128 vector length overflow', () => {
    const { commands, normalizedCommands, inputs } = buildCreditData();
    const patchedInputs = patchPureInputBytes(
      commands,
      inputs,
      indexMap.orderIdHash,
      new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x10]),
    );

    expect(() => parseSettleArgs(normalizedCommands, patchedInputs, PKG)).toThrow(
      ParseSettleArgsError,
    );
  });

  it('rejects settle MoveCalls from a non-canonical package', () => {
    const { normalizedCommands, inputs } = buildCreditData();
    const wrongPackageId = `0x${'6'.repeat(64)}`;

    expect(() => parseSettleArgs(normalizedCommands, inputs, wrongPackageId)).toThrow(
      ParseSettleArgsError,
    );
  });
});
