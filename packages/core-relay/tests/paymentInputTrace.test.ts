import { describe, expect, it } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { convertSdkCommands } from '../src/convert.js';
import {
  extractPaymentInputTrace,
  validatePaymentInputIntegrity,
} from '../src/paymentInputIntegrity.js';
import { extractSettlePaymentInputContract } from '../src/server/index.js';
import { buildSettleWithCreditPtb, buildSwapAndSettlePtb } from '../src/ptb/builders.js';
import type { MoveCallCommand, PtbCommand } from '@stelis/contracts';

const PKG = '0x' + '1'.repeat(64);
const CONFIG = '0x' + '2'.repeat(64);
const REGISTRY = '0x' + '3'.repeat(64);
const VAULT = '0x' + '4'.repeat(64);
const POOL = '0x' + '5'.repeat(64);
const PAYMENT_BASE = '0x' + '6'.repeat(64);
const RECIPIENT = '0x' + '9'.repeat(64);

const PAYMENT_TYPE = `${PKG}::usdc::USDC`;
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
  quoteTimestampMs: 1_741_680_000_000,
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
    });
  });

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
    });
    expect(result).toEqual({
      ok: false,
      subcode: 'payment_input_withdrawal_amount_mismatch',
      message:
        `Address-balance withdrawal amount ${SWAP_AMOUNT - 1n} does not match settle ` +
        `swap amount ${SWAP_AMOUNT}`,
    });
  });
});
