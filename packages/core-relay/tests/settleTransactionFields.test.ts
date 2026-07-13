import { describe, expect, it } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { SUI_CLOCK_OBJECT_ID } from '../src/constants.js';
import { ARG_INDEX_MAP } from '../src/parseSettleArgs.js';
import { buildSettleWithCreditPtb } from '../src/ptb/builders.js';
import { SETTLE_WITH_CREDIT_FUNCTION } from '@stelis/contracts';
import {
  extractSettleTransactionFieldsFromData,
  extractSettleTransactionFieldsFromTxBytes,
  SettleTransactionFieldsError,
  validateSettleTransactionFields,
  type ExpectedSettleTransactionFields,
} from '../src/settleTransactionFields.js';

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
  quoteTimestampMs: 1_761_007_200_000n,
  policyHash: new Uint8Array(32).fill(0xbb),
  orderIdHash: new Uint8Array(32).fill(0xcc),
};

function buildCreditTransaction(): Transaction {
  const tx = new Transaction();
  buildSettleWithCreditPtb(tx, SETTLE_PARAMS);
  return tx;
}

function buildResolvedCreditTransaction(): Transaction {
  const tx = new Transaction();
  const sharedObject = (objectId: string) =>
    tx.sharedObjectRef({ objectId, initialSharedVersion: '1', mutable: true });

  tx.moveCall({
    target: `${PKG}::settle::${SETTLE_WITH_CREDIT_FUNCTION}`,
    arguments: [
      sharedObject(CONFIG),
      sharedObject(REGISTRY),
      sharedObject(SUI_CLOCK_OBJECT_ID),
      sharedObject(VAULT),
      tx.pure.u64(SETTLE_PARAMS.useCreditAmount),
      tx.pure.u64(SETTLE_PARAMS.executionCostClaim),
      tx.pure.address(SETTLE_PARAMS.settlementPayoutRecipient),
      tx.pure.vector('u8', Array.from(SETTLE_PARAMS.receiptId)),
      tx.pure.u64(SETTLE_PARAMS.nonce),
      tx.pure.u64(SETTLE_PARAMS.simGasReported),
      tx.pure.u64(SETTLE_PARAMS.gasVarianceFixedMist),
      tx.pure.u64(SETTLE_PARAMS.slippageBufferMist),
      tx.pure.u64(SETTLE_PARAMS.quotedHostFeeMist),
      tx.pure.u64(SETTLE_PARAMS.expectedProtocolFeeMist),
      tx.pure.u64(SETTLE_PARAMS.expectedConfigVersion),
      tx.pure.u64(SETTLE_PARAMS.quoteTimestampMs),
      tx.pure.vector('u8', Array.from(SETTLE_PARAMS.policyHash)),
      tx.pure.vector('u8', Array.from(SETTLE_PARAMS.orderIdHash)),
    ],
  });
  tx.setSender(`0x${'a'.repeat(64)}`);
  tx.setGasOwner(`0x${'b'.repeat(64)}`);
  tx.setGasPrice(1000);
  tx.setGasBudget(10_000_000);
  tx.setGasPayment([
    {
      objectId: `0x${'c'.repeat(64)}`,
      version: '1',
      digest: '11111111111111111111111111111111',
    },
  ]);
  return tx;
}

function getTxData(tx: Transaction): { commands: unknown[]; inputs: unknown[] } {
  return tx.getData() as { commands: unknown[]; inputs: unknown[] };
}

function expectedFields(): ExpectedSettleTransactionFields {
  return {
    executionCostClaimMist: SETTLE_PARAMS.executionCostClaim,
    quotedHostFeeMist: SETTLE_PARAMS.quotedHostFeeMist,
    expectedProtocolFeeMist: SETTLE_PARAMS.expectedProtocolFeeMist,
    policyHash: SETTLE_PARAMS.policyHash,
    orderIdHash: SETTLE_PARAMS.orderIdHash,
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

describe('settle transaction fields', () => {
  it('extracts settle call, cost fields, policy hash, order id hash, receipt id, and nonce', () => {
    const { commands, inputs } = getTxData(buildCreditTransaction());

    const fields = extractSettleTransactionFieldsFromData(commands, inputs, PKG);

    expect(fields.settleFunction).toBe(SETTLE_WITH_CREDIT_FUNCTION);
    expect(fields.executionCostClaimMist).toBe(SETTLE_PARAMS.executionCostClaim);
    expect(fields.quotedHostFeeMist).toBe(SETTLE_PARAMS.quotedHostFeeMist);
    expect(fields.expectedProtocolFeeMist).toBe(SETTLE_PARAMS.expectedProtocolFeeMist);
    expect(fields.policyHash).toEqual(SETTLE_PARAMS.policyHash);
    expect(fields.orderIdHash).toEqual(SETTLE_PARAMS.orderIdHash);
    expect(fields.receiptId).toEqual(SETTLE_PARAMS.receiptId);
    expect(fields.nonce).toBe(SETTLE_PARAMS.nonce);
  });

  it('fails when the transaction has no settle call', () => {
    const tx = new Transaction();
    tx.moveCall({ target: `${PKG}::not_settle::noop`, arguments: [] });
    const { commands, inputs } = getTxData(tx);

    expect(() => extractSettleTransactionFieldsFromData(commands, inputs, PKG)).toThrow(
      SettleTransactionFieldsError,
    );
  });

  it('fails validation when a cost field does not match the prepare response', () => {
    const { commands, inputs } = getTxData(buildCreditTransaction());
    const fields = extractSettleTransactionFieldsFromData(commands, inputs, PKG);

    const result = validateSettleTransactionFields(fields, {
      ...expectedFields(),
      quotedHostFeeMist: SETTLE_PARAMS.quotedHostFeeMist + 1n,
    });

    expect(result).toEqual({
      ok: false,
      code: 'SETTLE_HOST_FEE_MISMATCH',
      message: `quotedHostFeeMist ${SETTLE_PARAMS.quotedHostFeeMist} != expected ${
        SETTLE_PARAMS.quotedHostFeeMist + 1n
      }`,
    });
  });

  it('fails validation when the policy hash does not match the prepare response', () => {
    const { commands, inputs } = getTxData(buildCreditTransaction());
    const fields = extractSettleTransactionFieldsFromData(commands, inputs, PKG);

    const result = validateSettleTransactionFields(fields, {
      ...expectedFields(),
      policyHash: new Uint8Array(32).fill(0xdd),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SETTLE_POLICY_HASH_MISMATCH');
  });

  it('fails validation when the order id hash does not match the prepare response', () => {
    const { commands, inputs } = getTxData(buildCreditTransaction());
    const fields = extractSettleTransactionFieldsFromData(commands, inputs, PKG);

    const result = validateSettleTransactionFields(fields, {
      ...expectedFields(),
      orderIdHash: new Uint8Array(32).fill(0xee),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SETTLE_ORDER_ID_HASH_MISMATCH');
  });

  it('fails extraction when a u64 settle field is malformed', () => {
    const { commands, inputs } = getTxData(buildCreditTransaction());
    const indices = ARG_INDEX_MAP[SETTLE_WITH_CREDIT_FUNCTION]!;
    const patchedInputs = patchPureInputBytes(
      commands,
      inputs,
      indices.quotedHostFee,
      new Uint8Array([1, 2]),
    );

    expect(() => extractSettleTransactionFieldsFromData(commands, patchedInputs, PKG)).toThrow(
      SettleTransactionFieldsError,
    );
  });

  it('extracts fields from full transaction bytes', async () => {
    const tx = buildResolvedCreditTransaction();
    const txBytes = await tx.build();

    const fields = extractSettleTransactionFieldsFromTxBytes(toBase64(txBytes), PKG);

    expect(validateSettleTransactionFields(fields, expectedFields())).toEqual({ ok: true });
  });
});
