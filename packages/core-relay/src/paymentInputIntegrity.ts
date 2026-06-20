import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';
import { parseSettleArgs } from './parseSettleArgs.js';
import { findSettleCommand } from './settleCommand.js';
import {
  VARIANT_LAYOUTS,
  variantClassFromFnName,
  type SettleVariantClass,
} from './settlePayloadContract.js';
import type { MoveCallCommand, PtbCommand } from '@stelis/contracts';
import type { SettleArgs } from './types.js';

const SUI_FRAMEWORK_ADDRESS = normalizeSuiAddress('0x2');

export type PaymentInputSource =
  | 'none_credit_only'
  | 'coin_object'
  | 'address_balance'
  | 'mixed_topup';

type PaymentInputRefKind = 'none' | 'input' | 'result' | 'nested_result';

type CommandRef =
  | { kind: 'Input'; input: number }
  | { kind: 'Result'; command: number }
  | { kind: 'NestedResult'; command: number; result: number };

interface PaymentInputTraceBase {
  settleVariantClass: SettleVariantClass;
  source: PaymentInputSource;
  paymentCoinRefKind: PaymentInputRefKind;
}

export type PaymentInputTrace =
  | (PaymentInputTraceBase & {
      settleVariantClass: 'credit';
      source: 'none_credit_only';
      paymentCoinRefKind: 'none';
    })
  | (PaymentInputTraceBase & {
      settleVariantClass: Exclude<SettleVariantClass, 'credit'>;
      source: 'coin_object';
      paymentCoinRefKind: 'result' | 'nested_result';
      producerCommandKind: 'SplitCoins';
      settleSwapAmount: bigint;
      splitAmount: bigint;
    })
  | (PaymentInputTraceBase & {
      settleVariantClass: Exclude<SettleVariantClass, 'credit'>;
      source: 'address_balance';
      paymentCoinRefKind: 'result' | 'nested_result';
      producerCommandKind: 'MoveCall';
      settleSwapAmount: bigint;
      withdrawalAmount: bigint;
    })
  | (PaymentInputTraceBase & {
      settleVariantClass: Exclude<SettleVariantClass, 'credit'>;
      source: 'mixed_topup';
      paymentCoinRefKind: 'result' | 'nested_result';
      producerCommandKind: 'SplitCoins';
      settleSwapAmount: bigint;
      splitAmount: bigint;
      topupCommandKind: 'MoveCall';
      withdrawalAmount: bigint;
    });

export type PaymentInputIntegritySubcode =
  | 'payment_input_missing'
  | 'payment_input_invalid_shape'
  | 'payment_input_source_mismatch'
  | 'payment_input_swap_amount_invalid'
  | 'payment_input_swap_amount_mismatch'
  | 'payment_input_split_amount_mismatch'
  | 'payment_input_withdrawal_amount_mismatch'
  | 'payment_input_topup_amount_invalid';

export type PaymentInputIntegrityResult =
  | { ok: true }
  | { ok: false; subcode: PaymentInputIntegritySubcode; message: string };

export interface PaymentInputIntegrityExpectation {
  source?: PaymentInputSource;
  swapAmountSmallest?: bigint;
}

export interface SettlePaymentInputContract extends SettleArgs {
  paymentInputTrace: PaymentInputTrace;
}

export class PaymentInputContractError extends Error {
  constructor(
    public readonly subcode: Extract<PaymentInputIntegritySubcode, 'payment_input_missing'>,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentInputContractError';
  }
}

const SWAP_VARIANTS = new Set(
  (Object.keys(VARIANT_LAYOUTS) as SettleVariantClass[]).filter((k) => k !== 'credit'),
);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

const DECIMAL_U64_RE = /^(?:0|[1-9]\d*)$/;

function parseDecimalU64(value: string, label: string): bigint {
  if (!DECIMAL_U64_RE.test(value)) {
    throw new Error(`${label} must be a non-negative decimal integer string`);
  }
  return BigInt(value);
}

function parseCommandRef(arg: unknown): CommandRef | null {
  const record = asRecord(arg);
  if (!record || typeof record.$kind !== 'string') return null;

  if (record.$kind === 'Input' && typeof record.Input === 'number') {
    return { kind: 'Input', input: record.Input };
  }
  if (record.$kind === 'Result' && typeof record.Result === 'number') {
    return { kind: 'Result', command: record.Result };
  }
  if (
    record.$kind === 'NestedResult' &&
    Array.isArray(record.NestedResult) &&
    record.NestedResult.length === 2 &&
    typeof record.NestedResult[0] === 'number' &&
    typeof record.NestedResult[1] === 'number'
  ) {
    return {
      kind: 'NestedResult',
      command: record.NestedResult[0],
      result: record.NestedResult[1],
    };
  }
  return null;
}

function paymentCoinRefKind(ref: CommandRef | null): PaymentInputRefKind {
  if (!ref) return 'none';
  if (ref.kind === 'Input') return 'input';
  if (ref.kind === 'Result') return 'result';
  return 'nested_result';
}

function decodePureU64Input(ref: CommandRef | null, inputs: unknown[]): bigint {
  if (!ref || ref.kind !== 'Input') {
    throw new Error('Expected Input reference for Pure u64');
  }
  const input = asRecord(inputs[ref.input]);
  if (!input) {
    throw new Error(`Input[${ref.input}] is not an object`);
  }
  if (input.$kind !== 'Pure') {
    throw new Error(`Input[${ref.input}] is not a Pure arg`);
  }
  const pure = asRecord(input.Pure);
  if (!pure || typeof pure.bytes !== 'string') {
    throw new Error(`Input[${ref.input}] Pure has no bytes`);
  }

  const decoded = fromBase64(pure.bytes);
  if (decoded.length < 8) {
    throw new Error(`Pure u64 needs 8 bytes, got ${decoded.length}`);
  }

  let value = 0n;
  for (let idx = 7; idx >= 0; idx--) {
    value = (value << 8n) | BigInt(decoded[idx]!);
  }
  return value;
}

function decodeFundsWithdrawal(
  ref: CommandRef | null,
  inputs: unknown[],
  expectedType: string,
): bigint {
  if (!ref || ref.kind !== 'Input') {
    throw new Error('Expected Input reference for FundsWithdrawal');
  }
  const input = asRecord(inputs[ref.input]);
  if (!input) {
    throw new Error(`Input[${ref.input}] is not an object`);
  }
  if (input.$kind !== 'FundsWithdrawal') {
    throw new Error(`Input[${ref.input}] is not a FundsWithdrawal`);
  }

  const fw = asRecord(input.FundsWithdrawal);
  const reservation = asRecord(fw?.reservation);
  if (
    !reservation ||
    reservation.$kind !== 'MaxAmountU64' ||
    typeof reservation.MaxAmountU64 !== 'string'
  ) {
    throw new Error(`FundsWithdrawal input ${ref.input} has no MaxAmountU64 reservation`);
  }

  const typeArg = asRecord(fw?.typeArg);
  if (!typeArg || typeArg.$kind !== 'Balance' || typeof typeArg.Balance !== 'string') {
    throw new Error(`FundsWithdrawal input ${ref.input} has no Balance typeArg`);
  }
  if (typeArg.Balance !== expectedType) {
    throw new Error(
      `FundsWithdrawal type ${typeArg.Balance} does not match settlement token ${expectedType}`,
    );
  }

  const withdrawFrom = asRecord(fw?.withdrawFrom);
  if (!withdrawFrom || withdrawFrom.$kind !== 'Sender') {
    throw new Error(
      `FundsWithdrawal input ${ref.input} must withdraw from Sender for payment integrity`,
    );
  }

  return parseDecimalU64(
    reservation.MaxAmountU64,
    `FundsWithdrawal input ${ref.input} MaxAmountU64`,
  );
}

function getSplitPayload(cmd: PtbCommand): { coin: unknown; amounts: unknown[] } | null {
  if (cmd.kind !== 'SplitCoins') return null;
  const payload = asRecord(cmd.arguments?.[0]);
  if (!payload || !Array.isArray(payload.amounts)) return null;
  return {
    coin: payload.coin,
    amounts: payload.amounts,
  };
}

function getMergePayload(cmd: PtbCommand): { destination: unknown; sources: unknown[] } | null {
  if (cmd.kind !== 'MergeCoins') return null;
  const payload = asRecord(cmd.arguments?.[0]);
  if (!payload || !Array.isArray(payload.sources)) return null;
  return {
    destination: payload.destination,
    sources: payload.sources,
  };
}

function isMoveCallCommand(cmd: PtbCommand): cmd is MoveCallCommand {
  return cmd.kind === 'MoveCall';
}

function isRedeemFundsCall(cmd: PtbCommand, settlementTokenType: string): cmd is MoveCallCommand {
  if (!isMoveCallCommand(cmd)) {
    return false;
  }
  return (
    normalizeSuiAddress(cmd.packageId) === SUI_FRAMEWORK_ADDRESS &&
    cmd.module === 'coin' &&
    cmd.function === 'redeem_funds' &&
    cmd.typeArguments[0] === settlementTokenType
  );
}

function tryExtractDirectRedeemTrace(
  ref: CommandRef | null,
  commands: PtbCommand[],
  inputs: unknown[],
  settlementTokenType: string,
): { withdrawalAmount: bigint } | null {
  if (!ref || (ref.kind !== 'Result' && ref.kind !== 'NestedResult')) {
    return null;
  }

  const redeemCmd = commands[ref.command];
  if (!redeemCmd || !isRedeemFundsCall(redeemCmd, settlementTokenType)) {
    return null;
  }
  const withdrawalArg = parseCommandRef(redeemCmd.arguments[0]);
  return {
    withdrawalAmount: decodeFundsWithdrawal(withdrawalArg, inputs, settlementTokenType),
  };
}

function extractSplitTrace(
  ref: CommandRef | null,
  commands: PtbCommand[],
  inputs: unknown[],
): { splitAmount: bigint; splitCommandIndex: number; baseInputIndex: number } | null {
  if (!ref || (ref.kind !== 'Result' && ref.kind !== 'NestedResult')) {
    return null;
  }

  const splitCmd = commands[ref.command];
  const split = splitCmd ? getSplitPayload(splitCmd) : null;
  if (!split) {
    return null;
  }

  if (ref.kind === 'NestedResult' && ref.result !== 0) {
    throw new Error(`SplitCoins payment result index must be 0, got ${ref.result}`);
  }

  if (split.amounts.length !== 1) {
    throw new Error(
      `SplitCoins payment source must have exactly 1 amount, got ${split.amounts.length}`,
    );
  }

  const baseRef = parseCommandRef(split.coin);
  if (!baseRef || baseRef.kind !== 'Input') {
    throw new Error('SplitCoins payment source must split from a direct Input coin');
  }

  return {
    splitAmount: decodePureU64Input(parseCommandRef(split.amounts[0]), inputs),
    splitCommandIndex: ref.command,
    baseInputIndex: baseRef.input,
  };
}

function findRedeemTopupForBase(
  commands: PtbCommand[],
  inputs: unknown[],
  settlementTokenType: string,
  baseInputIndex: number,
  splitCommandIndex: number,
): { withdrawalAmount: bigint } | null {
  let topup: { withdrawalAmount: bigint } | null = null;

  for (let idx = 0; idx < splitCommandIndex; idx++) {
    const merge = getMergePayload(commands[idx]!);
    if (!merge) continue;

    const destinationRef = parseCommandRef(merge.destination);
    if (
      !destinationRef ||
      destinationRef.kind !== 'Input' ||
      destinationRef.input !== baseInputIndex
    ) {
      continue;
    }

    for (const source of merge.sources) {
      const sourceRef = parseCommandRef(source);
      const redeemTrace = tryExtractDirectRedeemTrace(
        sourceRef,
        commands,
        inputs,
        settlementTokenType,
      );
      if (!redeemTrace) continue;
      if (topup) {
        throw new Error('Multiple redeem_funds topups merged into the payment base coin');
      }
      topup = redeemTrace;
    }
  }

  return topup;
}

export function extractPaymentInputTrace(
  commands: PtbCommand[],
  inputs: unknown[],
  settleCmd: MoveCallCommand,
): PaymentInputTrace {
  const variantClass = variantClassFromFnName(settleCmd.function);
  if (!variantClass) {
    throw new Error(`Unknown settle function for payment-input integrity: ${settleCmd.function}`);
  }

  if (variantClass === 'credit') {
    return {
      settleVariantClass: 'credit',
      source: 'none_credit_only',
      paymentCoinRefKind: 'none',
    };
  }

  const settlementTokenType = settleCmd.typeArguments[0];
  if (!settlementTokenType) {
    throw new Error(`Settle function ${settleCmd.function} has no settlement token type argument`);
  }

  const { paymentCoinIndex, swapAmountIndex } = VARIANT_LAYOUTS[variantClass];
  if (paymentCoinIndex === undefined || swapAmountIndex === undefined) {
    throw new Error(`Payment arg indices missing for settle variant ${variantClass}`);
  }

  const settleSwapAmount = decodePureU64Input(
    parseCommandRef(settleCmd.arguments[swapAmountIndex]),
    inputs,
  );
  if (settleSwapAmount <= 0n) {
    throw new Error(`swap_amount must be positive for settle variant ${variantClass}`);
  }

  const paymentRef = parseCommandRef(settleCmd.arguments[paymentCoinIndex]);
  const refKind = paymentCoinRefKind(paymentRef);

  const directRedeem = tryExtractDirectRedeemTrace(paymentRef, commands, inputs, settlementTokenType);
  if (directRedeem) {
    if (refKind !== 'result' && refKind !== 'nested_result') {
      throw new Error(`Address-balance payment coin must be a command result, got ${refKind}`);
    }
    return {
      settleVariantClass: variantClass,
      source: 'address_balance',
      paymentCoinRefKind: refKind,
      producerCommandKind: 'MoveCall',
      settleSwapAmount,
      withdrawalAmount: directRedeem.withdrawalAmount,
    };
  }

  const splitTrace = extractSplitTrace(paymentRef, commands, inputs);
  if (!splitTrace) {
    throw new Error(
      `Unsupported payment coin producer for settle variant ${variantClass}: ${refKind}`,
    );
  }
  if (refKind !== 'result' && refKind !== 'nested_result') {
    throw new Error(`Payment coin split source must be a command result, got ${refKind}`);
  }

  const topup = findRedeemTopupForBase(
    commands,
    inputs,
    settlementTokenType,
    splitTrace.baseInputIndex,
    splitTrace.splitCommandIndex,
  );

  if (topup) {
    return {
      settleVariantClass: variantClass,
      source: 'mixed_topup',
      paymentCoinRefKind: refKind,
      producerCommandKind: 'SplitCoins',
      settleSwapAmount,
      splitAmount: splitTrace.splitAmount,
      topupCommandKind: 'MoveCall',
      withdrawalAmount: topup.withdrawalAmount,
    };
  }

  return {
    settleVariantClass: variantClass,
    source: 'coin_object',
    paymentCoinRefKind: refKind,
    producerCommandKind: 'SplitCoins',
    settleSwapAmount,
    splitAmount: splitTrace.splitAmount,
  };
}

export function extractSettlePaymentInputContract(
  commands: PtbCommand[],
  inputs: unknown[],
  packageId: string,
): SettlePaymentInputContract {
  const settleArgs = parseSettleArgs(commands, inputs, packageId);
  const settleCmd = findSettleCommand(commands, packageId);
  if (!settleCmd) {
    throw new PaymentInputContractError(
      'payment_input_missing',
      'No settle function found in built transaction',
    );
  }

  try {
    return {
      ...settleArgs,
      paymentInputTrace: extractPaymentInputTrace(commands, inputs, settleCmd),
    };
  } catch (err) {
    throw new PaymentInputContractError(
      'payment_input_missing',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function validatePaymentInputIntegrity(
  trace: PaymentInputTrace | undefined,
  expected: PaymentInputIntegrityExpectation = {},
): PaymentInputIntegrityResult {
  if (!trace) {
    return {
      ok: false,
      subcode: 'payment_input_missing',
      message: 'Payment-input trace is missing from extracted settle args',
    };
  }

  if (expected.source !== undefined && trace.source !== expected.source) {
    return {
      ok: false,
      subcode: 'payment_input_source_mismatch',
      message: `Payment-input source ${trace.source} does not match expected ${expected.source}`,
    };
  }

  if (trace.source === 'none_credit_only') {
    if (expected.swapAmountSmallest !== undefined && expected.swapAmountSmallest !== 0n) {
      return {
        ok: false,
        subcode: 'payment_input_swap_amount_mismatch',
        message:
          'Credit-only payment input expected swapAmountSmallest=0 but got ' +
          `${expected.swapAmountSmallest}`,
      };
    }
    return { ok: true };
  }

  if (!SWAP_VARIANTS.has(trace.settleVariantClass)) {
    return {
      ok: false,
      subcode: 'payment_input_invalid_shape',
      message: `Unsupported settle variant ${trace.settleVariantClass} for swap payment input`,
    };
  }

  if (trace.settleSwapAmount <= 0n) {
    return {
      ok: false,
      subcode: 'payment_input_swap_amount_invalid',
      message: `Extracted settle swap amount must be positive, got ${trace.settleSwapAmount}`,
    };
  }

  if (
    expected.swapAmountSmallest !== undefined &&
    trace.settleSwapAmount !== expected.swapAmountSmallest
  ) {
    return {
      ok: false,
      subcode: 'payment_input_swap_amount_mismatch',
      message:
        `Extracted settle swap amount ${trace.settleSwapAmount} does not match expected ` +
        `${expected.swapAmountSmallest}`,
    };
  }

  if (trace.source === 'coin_object') {
    if (trace.splitAmount !== trace.settleSwapAmount) {
      return {
        ok: false,
        subcode: 'payment_input_split_amount_mismatch',
        message:
          `Coin-object split amount ${trace.splitAmount} does not match settle swap amount ` +
          `${trace.settleSwapAmount}`,
      };
    }
    return { ok: true };
  }

  if (trace.source === 'address_balance') {
    if (trace.withdrawalAmount !== trace.settleSwapAmount) {
      return {
        ok: false,
        subcode: 'payment_input_withdrawal_amount_mismatch',
        message:
          `Address-balance withdrawal amount ${trace.withdrawalAmount} does not match settle ` +
          `swap amount ${trace.settleSwapAmount}`,
      };
    }
    return { ok: true };
  }

  if (trace.splitAmount !== trace.settleSwapAmount) {
    return {
      ok: false,
      subcode: 'payment_input_split_amount_mismatch',
      message:
        `Mixed-topup split amount ${trace.splitAmount} does not match settle swap amount ` +
        `${trace.settleSwapAmount}`,
    };
  }

  if (trace.withdrawalAmount <= 0n || trace.withdrawalAmount >= trace.settleSwapAmount) {
    return {
      ok: false,
      subcode: 'payment_input_topup_amount_invalid',
      message:
        `Mixed-topup withdrawal amount ${trace.withdrawalAmount} must be > 0 and < settle ` +
        `swap amount ${trace.settleSwapAmount}`,
    };
  }

  return { ok: true };
}
