import { describe, expect, it } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { convertSdkCommands } from '../src/convert.js';
import {
  extractPaymentInputTrace,
  validatePaymentInputIntegrity,
} from '../src/paymentInputIntegrity.js';
import { extractSettlePaymentInputContract } from '../src/server/index.js';
import { buildSettleWithCreditPtb, buildSwapAndSettlePtb } from '../src/ptb/builders.js';
import { settlementParameterIndex, type MoveCallCommand, type PtbCommand } from '@stelis/contracts';

const PKG = '0x' + '1'.repeat(64);
const CONFIG = '0x' + '2'.repeat(64);
const REGISTRY = '0x' + '3'.repeat(64);
const VAULT = '0x' + '4'.repeat(64);
const POOL = '0x' + '5'.repeat(64);
const PAYMENT_BASE = '0x' + '6'.repeat(64);
const PREFIX_MERGE = '0x' + '7'.repeat(64);
const HOST_MERGE_A = '0x' + '8'.repeat(64);
const HOST_MERGE_B = '0x' + 'a'.repeat(64);
const WRONG_COIN = '0x' + 'b'.repeat(64);
const RECIPIENT = '0x' + '9'.repeat(64);

const PAYMENT_TYPE = `${PKG}::usdc::USDC`;
const SUI_TYPE = '0x2::sui::SUI';
const PADDED_SUI_TYPE = `0x${'0'.repeat(63)}2::sui::SUI`;
const SWAP_AMOUNT = 1_000_000n;

const SETTLE_SHARED = {
  packageId: PKG,
  configId: CONFIG,
  vaultRegistryId: REGISTRY,
  executionCostClaim: 5_000_000n,
  settlementPayoutRecipient: RECIPIENT,
  receiptId: new Uint8Array(32).fill(0xaa),
  nonce: 7n,
  simGasReported: 4_000_000n,
  gasVarianceFixedMist: 200_000n,
  slippageBufferMist: 75_000n,
  quotedHostFeeMist: 100_000n,
  expectedProtocolFeeMist: 20_000n,
  expectedConfigVersion: 1n,
  quoteTimestampMs: 1_741_680_000_000n,
  policyHash: new Uint8Array(32).fill(0xbb),
  orderIdHash: new Uint8Array(0),
};

function getCommands(buildFn: (tx: Transaction) => void): {
  commands: PtbCommand[];
  inputs: unknown[];
} {
  const tx = new Transaction();
  buildFn(tx);
  const data = tx.getData() as { commands: unknown[]; inputs: unknown[] };
  return {
    commands: convertSdkCommands(data.commands),
    inputs: data.inputs,
  };
}

function findSettleCommand(commands: PtbCommand[]): MoveCallCommand {
  const settle = commands.find(
    (cmd): cmd is MoveCallCommand =>
      cmd.kind === 'MoveCall' && cmd.packageId === PKG && cmd.module === 'settle',
  );
  if (!settle) {
    throw new Error('Missing settle command');
  }
  return settle;
}

function patchSettlePureInput(
  settle: MoveCallCommand,
  inputs: unknown[],
  argumentIndex: number,
  bytes: Uint8Array,
): unknown[] {
  const ref = settle.arguments[argumentIndex] as { Input: number };
  const input = inputs[ref.Input] as { Pure: Record<string, unknown> };
  const patched = [...inputs];
  patched[ref.Input] = { ...input, Pure: { ...input.Pure, bytes: toBase64(bytes) } };
  return patched;
}

describe('paymentInputIntegrity extraction', () => {
  it('extracts none_credit_only for credit-only settlement', () => {
    const { commands, inputs } = getCommands((tx) => {
      buildSettleWithCreditPtb(tx, {
        packageId: PKG,
        configId: CONFIG,
        vaultRegistryId: REGISTRY,
        vaultId: VAULT,
        useCreditAmount: 5_000_000n,
        executionCostClaim: SETTLE_SHARED.executionCostClaim,
        settlementPayoutRecipient: SETTLE_SHARED.settlementPayoutRecipient,
        receiptId: SETTLE_SHARED.receiptId,
        nonce: SETTLE_SHARED.nonce,
        simGasReported: SETTLE_SHARED.simGasReported,
        gasVarianceFixedMist: SETTLE_SHARED.gasVarianceFixedMist,
        slippageBufferMist: 0n,
        quotedHostFeeMist: SETTLE_SHARED.quotedHostFeeMist,
        expectedProtocolFeeMist: SETTLE_SHARED.expectedProtocolFeeMist,
        expectedConfigVersion: SETTLE_SHARED.expectedConfigVersion,
        quoteTimestampMs: SETTLE_SHARED.quoteTimestampMs,
        policyHash: SETTLE_SHARED.policyHash,
        orderIdHash: SETTLE_SHARED.orderIdHash,
      });
    });

    const trace = extractPaymentInputTrace(commands, inputs, findSettleCommand(commands));
    expect(trace).toEqual({
      settleVariantClass: 'credit',
      source: 'none_credit_only',
      paymentCoinRefKind: 'none',
    });
  });

  it('extracts coin_object from split payment coin', () => {
    const { commands, inputs } = getCommands((tx) => {
      const [paymentCoin] = tx.splitCoins(tx.object(PAYMENT_BASE), [SWAP_AMOUNT]);
      buildSwapAndSettlePtb(tx, {
        variant: 'new_user',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });

    const trace = extractPaymentInputTrace(commands, inputs, findSettleCommand(commands));
    expect(trace).toEqual({
      settleVariantClass: 'new_user',
      source: 'coin_object',
      paymentCoinRefKind: 'nested_result',
      producerCommandKind: 'SplitCoins',
      settleSwapAmount: SWAP_AMOUNT,
      splitAmount: SWAP_AMOUNT,
      splitCommandIndex: 0,
      baseInputIndex: 0,
      baseCoinObjectId: PAYMENT_BASE,
      directMergeSources: [],
      unsupportedMergeSources: [],
      fundingInputUses: [{ commandIndex: 0, inputIndex: 0, occurrences: 1 }],
      senderWithdrawals: [],
      senderRedeems: [],
    });
  });

  for (const width of [7, 9]) {
    it(`rejects ${width}-byte Pure u64 swap amounts`, () => {
      const { commands, inputs } = getCommands((tx) => {
        const [paymentCoin] = tx.splitCoins(tx.object(PAYMENT_BASE), [SWAP_AMOUNT]);
        buildSwapAndSettlePtb(tx, {
          variant: 'new_user',
          settlementSwapDirection: 'baseForQuote',
          settlementTokenType: PAYMENT_TYPE,
          poolId: POOL,
          paymentCoinId: paymentCoin,
          swapAmount: SWAP_AMOUNT,
          minSuiOut: 900_000n,
          ...SETTLE_SHARED,
        });
      });
      const settle = findSettleCommand(commands);
      const patchedInputs = patchSettlePureInput(
        settle,
        inputs,
        settlementParameterIndex(settle.function, 'swap_amount')!,
        new Uint8Array(width),
      );

      expect(() => extractPaymentInputTrace(commands, patchedInputs, settle)).toThrow(
        `Pure u64 must be exactly 8 bytes, got ${width}`,
      );
    });
  }

  it('extracts address_balance from redeem_funds payment coin', () => {
    const { commands, inputs } = getCommands((tx) => {
      const withdrawal = tx.withdrawal({ amount: SWAP_AMOUNT, type: PAYMENT_TYPE });
      const [paymentCoin] = tx.moveCall({
        target: '0x2::coin::redeem_funds',
        typeArguments: [PAYMENT_TYPE],
        arguments: [withdrawal],
      });
      buildSwapAndSettlePtb(tx, {
        variant: 'with_vault',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        vaultId: VAULT,
        useCreditAmount: 0n,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });

    const trace = extractPaymentInputTrace(commands, inputs, findSettleCommand(commands));
    expect(trace).toEqual({
      settleVariantClass: 'with_vault',
      source: 'address_balance',
      paymentCoinRefKind: 'nested_result',
      producerCommandKind: 'MoveCall',
      settleSwapAmount: SWAP_AMOUNT,
      withdrawalAmount: SWAP_AMOUNT,
      redeemCommandIndex: 0,
      withdrawalInputIndex: 0,
      senderWithdrawals: [{ inputIndex: 0, amount: SWAP_AMOUNT }],
      senderRedeems: [{ commandIndex: 0, inputIndex: 0, amount: SWAP_AMOUNT }],
    });
  });

  it('rejects non-decimal FundsWithdrawal reservation amounts during extraction', () => {
    const { commands, inputs } = getCommands((tx) => {
      const withdrawal = tx.withdrawal({ amount: SWAP_AMOUNT, type: PAYMENT_TYPE });
      const [paymentCoin] = tx.moveCall({
        target: '0x2::coin::redeem_funds',
        typeArguments: [PAYMENT_TYPE],
        arguments: [withdrawal],
      });
      buildSwapAndSettlePtb(tx, {
        variant: 'with_vault',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        vaultId: VAULT,
        useCreditAmount: 0n,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });
    const withdrawalInput = inputs.find(
      (input): input is Record<string, unknown> =>
        typeof input === 'object' && input !== null && input['$kind'] === 'FundsWithdrawal',
    );
    expect(withdrawalInput).toBeDefined();
    const payload = withdrawalInput!.FundsWithdrawal as {
      reservation: { MaxAmountU64: string };
    };
    payload.reservation.MaxAmountU64 = '0x10';

    expect(() => extractPaymentInputTrace(commands, inputs, findSettleCommand(commands))).toThrow(
      'MaxAmountU64 must be a non-negative decimal integer string',
    );
  });

  it('extracts the explicit settle payment-input contract from the server API', () => {
    const { commands, inputs } = getCommands((tx) => {
      const withdrawal = tx.withdrawal({ amount: SWAP_AMOUNT, type: PAYMENT_TYPE });
      const [paymentCoin] = tx.moveCall({
        target: '0x2::coin::redeem_funds',
        typeArguments: [PAYMENT_TYPE],
        arguments: [withdrawal],
      });
      buildSwapAndSettlePtb(tx, {
        variant: 'with_vault',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        vaultId: VAULT,
        useCreditAmount: 0n,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });

    const contract = extractSettlePaymentInputContract(commands, inputs, PKG);
    expect(contract.extractedSettlementSwapPath).toEqual({
      tokenType: PAYMENT_TYPE,
      hops: [POOL],
      settlementSwapDirection: 'baseForQuote',
    });
    expect(contract.paymentInputTrace).toEqual({
      settleVariantClass: 'with_vault',
      source: 'address_balance',
      paymentCoinRefKind: 'nested_result',
      producerCommandKind: 'MoveCall',
      settleSwapAmount: SWAP_AMOUNT,
      withdrawalAmount: SWAP_AMOUNT,
      redeemCommandIndex: 0,
      withdrawalInputIndex: 0,
      senderWithdrawals: [{ inputIndex: 0, amount: SWAP_AMOUNT }],
      senderRedeems: [{ commandIndex: 0, inputIndex: 0, amount: SWAP_AMOUNT }],
    });
  });

  it('validator allows sponsor-side self-consistency without stored source metadata', () => {
    const result = validatePaymentInputIntegrity({
      settleVariantClass: 'with_vault',
      source: 'address_balance',
      paymentCoinRefKind: 'nested_result',
      producerCommandKind: 'MoveCall',
      settleSwapAmount: SWAP_AMOUNT,
      withdrawalAmount: SWAP_AMOUNT,
      redeemCommandIndex: 0,
      withdrawalInputIndex: 0,
      senderWithdrawals: [{ inputIndex: 0, amount: SWAP_AMOUNT }],
      senderRedeems: [{ commandIndex: 0, inputIndex: 0, amount: SWAP_AMOUNT }],
    });
    expect(result).toEqual({ ok: true });
  });

  it('validator rejects malformed address-balance withdrawal amount', () => {
    const result = validatePaymentInputIntegrity({
      settleVariantClass: 'with_vault',
      source: 'address_balance',
      paymentCoinRefKind: 'nested_result',
      producerCommandKind: 'MoveCall',
      settleSwapAmount: SWAP_AMOUNT,
      withdrawalAmount: SWAP_AMOUNT - 1n,
      redeemCommandIndex: 0,
      withdrawalInputIndex: 0,
      senderWithdrawals: [{ inputIndex: 0, amount: SWAP_AMOUNT - 1n }],
      senderRedeems: [{ commandIndex: 0, inputIndex: 0, amount: SWAP_AMOUNT - 1n }],
    });
    expect(result).toEqual({
      ok: false,
      subcode: 'payment_input_withdrawal_amount_mismatch',
      message:
        `Address-balance withdrawal amount ${SWAP_AMOUNT - 1n} does not match settle ` +
        `swap amount ${SWAP_AMOUNT}`,
    });
  });

  it('binds the base coin and ordered Host direct merges without counting prefix merges', () => {
    let userCommandCount = -1;
    let userInputCount = -1;
    const { commands, inputs } = getCommands((tx) => {
      const baseCoin = tx.object(PAYMENT_BASE);
      tx.mergeCoins(baseCoin, [tx.object(PREFIX_MERGE)]);
      userCommandCount = tx.getData().commands.length;
      userInputCount = tx.getData().inputs.length;
      tx.mergeCoins(baseCoin, [tx.object(HOST_MERGE_A), tx.object(HOST_MERGE_B)]);
      const [paymentCoin] = tx.splitCoins(baseCoin, [SWAP_AMOUNT]);
      buildSwapAndSettlePtb(tx, {
        variant: 'new_user',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });

    const trace = extractPaymentInputTrace(commands, inputs, findSettleCommand(commands));
    expect(trace).toMatchObject({
      source: 'coin_object',
      baseCoinObjectId: PAYMENT_BASE,
      directMergeSources: [
        { commandIndex: 0, objectId: PREFIX_MERGE },
        { commandIndex: 1, objectId: HOST_MERGE_A },
        { commandIndex: 1, objectId: HOST_MERGE_B },
      ],
    });
    expect(
      validatePaymentInputIntegrity(trace, {
        source: 'coin_object',
        swapAmountSmallest: SWAP_AMOUNT,
        userCommandCount,
        userInputCount,
        baseCoinObjectId: PAYMENT_BASE,
        mergeCoinObjectIds: [HOST_MERGE_A, HOST_MERGE_B],
      }),
    ).toEqual({ ok: true });

    expect(
      validatePaymentInputIntegrity(trace, {
        source: 'coin_object',
        userCommandCount,
        userInputCount,
        baseCoinObjectId: WRONG_COIN,
        mergeCoinObjectIds: [HOST_MERGE_A, HOST_MERGE_B],
      }),
    ).toMatchObject({ ok: false, subcode: 'payment_input_base_coin_mismatch' });
    expect(
      validatePaymentInputIntegrity(trace, {
        source: 'coin_object',
        userCommandCount,
        userInputCount,
        baseCoinObjectId: PAYMENT_BASE,
        mergeCoinObjectIds: [HOST_MERGE_B, HOST_MERGE_A],
      }),
    ).toMatchObject({ ok: false, subcode: 'payment_input_merge_coin_ids_mismatch' });
  });

  it('accepts a derived prefix merge in intrinsic and boundary-aware validation', () => {
    let userCommandCount = -1;
    let userInputCount = -1;
    const { commands, inputs } = getCommands((tx) => {
      const baseCoin = tx.object(PAYMENT_BASE);
      const [prefixValue] = tx.splitCoins(tx.object(PREFIX_MERGE), [100n]);
      tx.mergeCoins(baseCoin, [prefixValue]);
      userCommandCount = tx.getData().commands.length;
      userInputCount = tx.getData().inputs.length;

      tx.mergeCoins(baseCoin, [tx.object(HOST_MERGE_A)]);
      const [paymentCoin] = tx.splitCoins(baseCoin, [SWAP_AMOUNT]);
      buildSwapAndSettlePtb(tx, {
        variant: 'new_user',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });
    const trace = extractPaymentInputTrace(commands, inputs, findSettleCommand(commands));

    expect(trace).toMatchObject({
      source: 'coin_object',
      unsupportedMergeSources: [{ commandIndex: 1, sourceIndex: 0 }],
    });
    expect(validatePaymentInputIntegrity(trace, {})).toEqual({ ok: true });
    expect(
      validatePaymentInputIntegrity(trace, {
        source: 'coin_object',
        swapAmountSmallest: SWAP_AMOUNT,
        userCommandCount,
        userInputCount,
        baseCoinObjectId: PAYMENT_BASE,
        mergeCoinObjectIds: [HOST_MERGE_A],
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a payment split that belongs to the user prefix', () => {
    let userCommandCount = -1;
    let userInputCount = -1;
    const { commands, inputs } = getCommands((tx) => {
      const [paymentCoin] = tx.splitCoins(tx.object(PAYMENT_BASE), [SWAP_AMOUNT]);
      userCommandCount = tx.getData().commands.length;
      userInputCount = tx.getData().inputs.length;
      buildSwapAndSettlePtb(tx, {
        variant: 'new_user',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });
    const trace = extractPaymentInputTrace(commands, inputs, findSettleCommand(commands));

    expect(
      validatePaymentInputIntegrity(trace, {
        source: 'coin_object',
        userCommandCount,
        userInputCount,
        baseCoinObjectId: PAYMENT_BASE,
        mergeCoinObjectIds: [],
      }),
    ).toMatchObject({ ok: false, subcode: 'payment_input_command_boundary_mismatch' });
  });

  it('rejects an extra Host split from the selected base before the payment split', () => {
    const { commands, inputs } = getCommands((tx) => {
      const baseCoin = tx.object(PAYMENT_BASE);
      const [siphoned] = tx.splitCoins(baseCoin, [1n]);
      tx.transferObjects([siphoned], RECIPIENT);
      const [paymentCoin] = tx.splitCoins(baseCoin, [SWAP_AMOUNT]);
      buildSwapAndSettlePtb(tx, {
        variant: 'new_user',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });
    const trace = extractPaymentInputTrace(commands, inputs, findSettleCommand(commands));

    expect(
      validatePaymentInputIntegrity(trace, {
        source: 'coin_object',
        userCommandCount: 0,
        userInputCount: 0,
        baseCoinObjectId: PAYMENT_BASE,
        mergeCoinObjectIds: [],
      }),
    ).toMatchObject({ ok: false, subcode: 'payment_input_funding_use_mismatch' });
  });

  it('rejects an indirect Host mutation of an expected merge coin', () => {
    const { commands, inputs } = getCommands((tx) => {
      const mergeCoin = tx.object(HOST_MERGE_A);
      const [siphoned] = tx.splitCoins(mergeCoin, [1n]);
      tx.transferObjects([siphoned], RECIPIENT);
      const baseCoin = tx.object(PAYMENT_BASE);
      tx.mergeCoins(baseCoin, [mergeCoin]);
      const [paymentCoin] = tx.splitCoins(baseCoin, [SWAP_AMOUNT]);
      buildSwapAndSettlePtb(tx, {
        variant: 'new_user',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });
    const trace = extractPaymentInputTrace(commands, inputs, findSettleCommand(commands));

    expect(
      validatePaymentInputIntegrity(trace, {
        source: 'coin_object',
        userCommandCount: 0,
        userInputCount: 0,
        baseCoinObjectId: PAYMENT_BASE,
        mergeCoinObjectIds: [HOST_MERGE_A],
      }),
    ).toMatchObject({ ok: false, subcode: 'payment_input_funding_use_mismatch' });
  });

  it('binds a direct address-balance redeem to its exact amount and Host boundary', () => {
    const { commands, inputs } = getCommands((tx) => {
      const withdrawal = tx.withdrawal({ amount: SWAP_AMOUNT, type: PAYMENT_TYPE });
      const [paymentCoin] = tx.moveCall({
        target: '0x2::coin::redeem_funds',
        typeArguments: [PAYMENT_TYPE],
        arguments: [withdrawal],
      });
      buildSwapAndSettlePtb(tx, {
        variant: 'with_vault',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        vaultId: VAULT,
        useCreditAmount: 0n,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });
    const trace = extractPaymentInputTrace(commands, inputs, findSettleCommand(commands));

    expect(
      validatePaymentInputIntegrity(trace, {
        source: 'address_balance',
        swapAmountSmallest: SWAP_AMOUNT,
        userCommandCount: 0,
        userInputCount: 0,
        addressBalanceRedeemAmount: SWAP_AMOUNT,
      }),
    ).toEqual({ ok: true });
    expect(
      validatePaymentInputIntegrity(trace, {
        source: 'address_balance',
        userCommandCount: 0,
        userInputCount: 0,
        addressBalanceRedeemAmount: SWAP_AMOUNT - 1n,
      }),
    ).toMatchObject({ ok: false, subcode: 'payment_input_redeem_amount_mismatch' });
    expect(
      validatePaymentInputIntegrity(trace, {
        source: 'address_balance',
        userCommandCount: 1,
        userInputCount: 0,
        addressBalanceRedeemAmount: SWAP_AMOUNT,
      }),
    ).toMatchObject({ ok: false, subcode: 'payment_input_command_boundary_mismatch' });
  });

  it('allows prefix redeem use but rejects an extra Host redeem with equivalent token spelling', () => {
    let userCommandCount = -1;
    let userInputCount = -1;
    const valid = getCommands((tx) => {
      const prefixWithdrawal = tx.withdrawal({ amount: 1n, type: PAYMENT_TYPE });
      const [prefixCoin] = tx.moveCall({
        target: '0x2::coin::redeem_funds',
        typeArguments: [PAYMENT_TYPE],
        arguments: [prefixWithdrawal],
      });
      tx.transferObjects([prefixCoin], RECIPIENT);
      userCommandCount = tx.getData().commands.length;
      userInputCount = tx.getData().inputs.length;

      const withdrawal = tx.withdrawal({ amount: SWAP_AMOUNT, type: PAYMENT_TYPE });
      const [paymentCoin] = tx.moveCall({
        target: '0x2::coin::redeem_funds',
        typeArguments: [PAYMENT_TYPE],
        arguments: [withdrawal],
      });
      buildSwapAndSettlePtb(tx, {
        variant: 'with_vault',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        vaultId: VAULT,
        useCreditAmount: 0n,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });
    const validTrace = extractPaymentInputTrace(
      valid.commands,
      valid.inputs,
      findSettleCommand(valid.commands),
    );
    expect(
      validatePaymentInputIntegrity(validTrace, {
        source: 'address_balance',
        swapAmountSmallest: SWAP_AMOUNT,
        userCommandCount,
        userInputCount,
        addressBalanceRedeemAmount: SWAP_AMOUNT,
      }),
    ).toEqual({ ok: true });

    const invalid = getCommands((tx) => {
      const extraWithdrawal = tx.withdrawal({ amount: 1n, type: SUI_TYPE });
      const [extraCoin] = tx.moveCall({
        target: '0x2::coin::redeem_funds',
        typeArguments: [SUI_TYPE],
        arguments: [extraWithdrawal],
      });
      tx.transferObjects([extraCoin], RECIPIENT);

      const withdrawal = tx.withdrawal({ amount: SWAP_AMOUNT, type: SUI_TYPE });
      const [paymentCoin] = tx.moveCall({
        target: '0x2::coin::redeem_funds',
        typeArguments: [SUI_TYPE],
        arguments: [withdrawal],
      });
      buildSwapAndSettlePtb(tx, {
        variant: 'with_vault',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: SUI_TYPE,
        poolId: POOL,
        vaultId: VAULT,
        useCreditAmount: 0n,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });
    const extraWithdrawal = invalid.inputs.find(
      (input): input is { FundsWithdrawal: { typeArg: { Balance: string } } } =>
        typeof input === 'object' && input !== null && 'FundsWithdrawal' in input,
    );
    const extraRedeem = invalid.commands.find(
      (command): command is MoveCallCommand =>
        command.kind === 'MoveCall' &&
        command.module === 'coin' &&
        command.function === 'redeem_funds',
    );
    expect(extraWithdrawal).toBeDefined();
    expect(extraRedeem).toBeDefined();
    extraWithdrawal!.FundsWithdrawal.typeArg.Balance = PADDED_SUI_TYPE;
    extraRedeem!.typeArguments[0] = PADDED_SUI_TYPE;
    const invalidTrace = extractPaymentInputTrace(
      invalid.commands,
      invalid.inputs,
      findSettleCommand(invalid.commands),
    );
    expect(
      validatePaymentInputIntegrity(invalidTrace, {
        source: 'address_balance',
        swapAmountSmallest: SWAP_AMOUNT,
        userCommandCount: 0,
        userInputCount: 0,
        addressBalanceRedeemAmount: SWAP_AMOUNT,
      }),
    ).toMatchObject({ ok: false, subcode: 'payment_input_redeem_use_mismatch' });
  });

  it('accepts one Host mixed topup while excluding a prefix direct merge', () => {
    const topupAmount = 250_000n;
    let userCommandCount = -1;
    let userInputCount = -1;
    const { commands, inputs } = getCommands((tx) => {
      const baseCoin = tx.object(PAYMENT_BASE);
      tx.mergeCoins(baseCoin, [tx.object(PREFIX_MERGE)]);
      userCommandCount = tx.getData().commands.length;
      userInputCount = tx.getData().inputs.length;

      const withdrawal = tx.withdrawal({ amount: topupAmount, type: PAYMENT_TYPE });
      const [topupCoin] = tx.moveCall({
        target: '0x2::coin::redeem_funds',
        typeArguments: [PAYMENT_TYPE],
        arguments: [withdrawal],
      });
      tx.mergeCoins(baseCoin, [topupCoin]);
      const [paymentCoin] = tx.splitCoins(baseCoin, [SWAP_AMOUNT]);
      buildSwapAndSettlePtb(tx, {
        variant: 'with_vault',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        vaultId: VAULT,
        useCreditAmount: 0n,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });
    const trace = extractPaymentInputTrace(commands, inputs, findSettleCommand(commands));

    expect(trace).toMatchObject({
      source: 'mixed_topup',
      withdrawalAmount: topupAmount,
      redeemCommandIndex: 1,
      topupMergeCommandIndex: 2,
      baseCoinObjectId: PAYMENT_BASE,
      directMergeSources: [{ commandIndex: 0, objectId: PREFIX_MERGE }],
      unsupportedMergeSources: [],
    });
    expect(
      validatePaymentInputIntegrity(trace, {
        source: 'mixed_topup',
        swapAmountSmallest: SWAP_AMOUNT,
        userCommandCount,
        userInputCount,
        baseCoinObjectId: PAYMENT_BASE,
        mergeCoinObjectIds: [],
        addressBalanceRedeemAmount: topupAmount,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects an unsupported Host result merged into the payment base', () => {
    const { commands, inputs } = getCommands((tx) => {
      const baseCoin = tx.object(PAYMENT_BASE);
      const [unknownCoin] = tx.moveCall({
        target: '0x2::example::produce_coin',
        typeArguments: [PAYMENT_TYPE],
      });
      tx.mergeCoins(baseCoin, [unknownCoin]);
      const [paymentCoin] = tx.splitCoins(baseCoin, [SWAP_AMOUNT]);
      buildSwapAndSettlePtb(tx, {
        variant: 'new_user',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });
    const trace = extractPaymentInputTrace(commands, inputs, findSettleCommand(commands));

    expect(trace).toMatchObject({
      source: 'coin_object',
      unsupportedMergeSources: [{ commandIndex: 1, sourceIndex: 0 }],
    });
    expect(
      validatePaymentInputIntegrity(trace, {
        source: 'coin_object',
        swapAmountSmallest: SWAP_AMOUNT,
        userCommandCount: 0,
        userInputCount: 0,
        baseCoinObjectId: PAYMENT_BASE,
        mergeCoinObjectIds: [],
      }),
    ).toMatchObject({ ok: false, subcode: 'payment_input_unexpected_merge_source' });
  });

  it('rejects more than one redeem topup during extraction', () => {
    const { commands, inputs } = getCommands((tx) => {
      const baseCoin = tx.object(PAYMENT_BASE);
      for (const amount of [100_000n, 150_000n]) {
        const withdrawal = tx.withdrawal({ amount, type: PAYMENT_TYPE });
        const [topupCoin] = tx.moveCall({
          target: '0x2::coin::redeem_funds',
          typeArguments: [PAYMENT_TYPE],
          arguments: [withdrawal],
        });
        tx.mergeCoins(baseCoin, [topupCoin]);
      }
      const [paymentCoin] = tx.splitCoins(baseCoin, [SWAP_AMOUNT]);
      buildSwapAndSettlePtb(tx, {
        variant: 'with_vault',
        settlementSwapDirection: 'baseForQuote',
        settlementTokenType: PAYMENT_TYPE,
        poolId: POOL,
        vaultId: VAULT,
        useCreditAmount: 0n,
        paymentCoinId: paymentCoin,
        swapAmount: SWAP_AMOUNT,
        minSuiOut: 900_000n,
        ...SETTLE_SHARED,
      });
    });
    expect(() => extractPaymentInputTrace(commands, inputs, findSettleCommand(commands))).toThrow(
      'Multiple redeem_funds topups merged into the payment base coin',
    );
  });
});
