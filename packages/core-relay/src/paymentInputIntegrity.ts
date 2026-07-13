import { normalizeSuiAddress } from '@mysten/sui/utils';
import { parseSettleArgs } from './parseSettleArgs.js';
import { findSettleCommand } from './settleCommand.js';
import {
  SETTLEMENT_ENTRY_FUNCTIONS,
  settlementParameterIndex,
  type SettleVariantClass,
} from '@stelis/contracts';
import type { MoveCallCommand, PtbCommand } from '@stelis/contracts';
import type { SettleArgs } from './types.js';
import { decodeExactPureU64Base64 } from './decodePureU64.js';
import { extractObjectIdFromInput } from './ptbInputUtils.js';
import { normalizeMoveStructType, resolveFundsWithdrawalSource } from './prefixValueTrace.js';

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

interface PaymentInputDirectMergeSource {
  readonly commandIndex: number;
  readonly inputIndex: number;
  readonly objectId: string;
}

interface PaymentInputUnsupportedMergeSource {
  readonly commandIndex: number;
  readonly sourceIndex: number;
}

interface PaymentInputObjectUse {
  readonly commandIndex: number;
  readonly inputIndex: number;
  readonly occurrences: number;
}

interface PaymentInputSenderWithdrawal {
  readonly inputIndex: number;
  readonly amount: bigint;
}

interface PaymentInputSenderRedeem extends PaymentInputSenderWithdrawal {
  readonly commandIndex: number;
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
      splitCommandIndex: number;
      baseInputIndex: number;
      baseCoinObjectId: string;
      directMergeSources: readonly PaymentInputDirectMergeSource[];
      unsupportedMergeSources: readonly PaymentInputUnsupportedMergeSource[];
      fundingInputUses: readonly PaymentInputObjectUse[];
      senderWithdrawals: readonly PaymentInputSenderWithdrawal[];
      senderRedeems: readonly PaymentInputSenderRedeem[];
    })
  | (PaymentInputTraceBase & {
      settleVariantClass: Exclude<SettleVariantClass, 'credit'>;
      source: 'address_balance';
      paymentCoinRefKind: 'result' | 'nested_result';
      producerCommandKind: 'MoveCall';
      settleSwapAmount: bigint;
      withdrawalAmount: bigint;
      redeemCommandIndex: number;
      withdrawalInputIndex: number;
      senderWithdrawals: readonly PaymentInputSenderWithdrawal[];
      senderRedeems: readonly PaymentInputSenderRedeem[];
    })
  | (PaymentInputTraceBase & {
      settleVariantClass: Exclude<SettleVariantClass, 'credit'>;
      source: 'mixed_topup';
      paymentCoinRefKind: 'result' | 'nested_result';
      producerCommandKind: 'SplitCoins';
      settleSwapAmount: bigint;
      splitAmount: bigint;
      splitCommandIndex: number;
      topupCommandKind: 'MoveCall';
      withdrawalAmount: bigint;
      redeemCommandIndex: number;
      withdrawalInputIndex: number;
      topupMergeCommandIndex: number;
      baseInputIndex: number;
      baseCoinObjectId: string;
      directMergeSources: readonly PaymentInputDirectMergeSource[];
      unsupportedMergeSources: readonly PaymentInputUnsupportedMergeSource[];
      fundingInputUses: readonly PaymentInputObjectUse[];
      senderWithdrawals: readonly PaymentInputSenderWithdrawal[];
      senderRedeems: readonly PaymentInputSenderRedeem[];
    });

export type PaymentInputIntegritySubcode =
  | 'payment_input_missing'
  | 'payment_input_invalid_shape'
  | 'payment_input_source_mismatch'
  | 'payment_input_swap_amount_invalid'
  | 'payment_input_swap_amount_mismatch'
  | 'payment_input_split_amount_mismatch'
  | 'payment_input_withdrawal_amount_mismatch'
  | 'payment_input_topup_amount_invalid'
  | 'payment_input_base_coin_mismatch'
  | 'payment_input_merge_coin_ids_mismatch'
  | 'payment_input_unexpected_merge_source'
  | 'payment_input_funding_use_mismatch'
  | 'payment_input_redeem_use_mismatch'
  | 'payment_input_redeem_amount_mismatch'
  | 'payment_input_command_boundary_mismatch';

export type PaymentInputIntegrityResult =
  | { ok: true }
  | { ok: false; subcode: PaymentInputIntegritySubcode; message: string };

export interface PaymentInputIntegrityExpectation {
  source?: PaymentInputSource;
  swapAmountSmallest?: bigint;
  /** Number of commands owned by the user prefix, before Host funding commands. */
  userCommandCount?: number;
  /** Number of inputs owned by the user prefix, before Host funding inputs. */
  userInputCount?: number;
  baseCoinObjectId?: string;
  mergeCoinObjectIds?: readonly string[];
  addressBalanceRedeemAmount?: bigint;
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
  Object.values(SETTLEMENT_ENTRY_FUNCTIONS)
    .map((entry) => entry.variantClass)
    .filter(
      (variantClass): variantClass is Exclude<SettleVariantClass, 'credit'> =>
        variantClass !== 'credit',
    ),
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

function isSameStructType(actual: string, expected: string): boolean {
  const normalizedActual = normalizeMoveStructType(actual);
  const normalizedExpected = normalizeMoveStructType(expected);
  return normalizedActual !== null && normalizedActual === normalizedExpected;
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

  return decodeExactPureU64Base64(pure.bytes);
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
  if (!typeArg || typeof typeArg.Balance !== 'string') {
    throw new Error(`FundsWithdrawal input ${ref.input} has no Balance typeArg`);
  }
  if (!isSameStructType(typeArg.Balance, expectedType)) {
    throw new Error(
      `FundsWithdrawal type ${typeArg.Balance} does not match settlement token ${expectedType}`,
    );
  }

  const withdrawFrom = asRecord(fw?.withdrawFrom);
  if (resolveFundsWithdrawalSource(withdrawFrom ?? undefined) !== 'Sender') {
    throw new Error(
      `FundsWithdrawal input ${ref.input} must withdraw from Sender for payment integrity`,
    );
  }

  return parseDecimalU64(
    reservation.MaxAmountU64,
    `FundsWithdrawal input ${ref.input} MaxAmountU64`,
  );
}

function extractCanonicalObjectId(inputs: unknown[], inputIndex: number, label: string): string {
  const input = asRecord(inputs[inputIndex]);
  const objectId = input ? extractObjectIdFromInput(input) : null;
  if (!objectId) {
    throw new Error(`${label} Input[${inputIndex}] has no object ID`);
  }
  return normalizeSuiAddress(objectId);
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

function collectFundingInputUses(
  commands: readonly PtbCommand[],
  selectedInputIndexes: ReadonlySet<number>,
): PaymentInputObjectUse[] {
  const uses: PaymentInputObjectUse[] = [];

  function visit(value: unknown, counts: Map<number, number>): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, counts);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    const ref = parseCommandRef(record);
    if (ref?.kind === 'Input') {
      if (selectedInputIndexes.has(ref.input)) {
        counts.set(ref.input, (counts.get(ref.input) ?? 0) + 1);
      }
      return;
    }
    for (const nested of Object.values(record)) visit(nested, counts);
  }

  for (let commandIndex = 0; commandIndex < commands.length; commandIndex++) {
    const counts = new Map<number, number>();
    visit(commands[commandIndex]?.arguments ?? [], counts);
    for (const [inputIndex, occurrences] of counts) {
      uses.push({ commandIndex, inputIndex, occurrences });
    }
  }
  return uses;
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
    typeof cmd.typeArguments[0] === 'string' &&
    isSameStructType(cmd.typeArguments[0], settlementTokenType)
  );
}

function collectSenderWithdrawals(
  inputs: unknown[],
  settlementTokenType: string,
): PaymentInputSenderWithdrawal[] {
  const withdrawals: PaymentInputSenderWithdrawal[] = [];
  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex++) {
    const input = asRecord(inputs[inputIndex]);
    if (input?.$kind !== 'FundsWithdrawal') continue;
    const fw = asRecord(input.FundsWithdrawal);
    const typeArg = asRecord(fw?.typeArg);
    const withdrawFrom = asRecord(fw?.withdrawFrom);
    if (
      typeof typeArg?.Balance !== 'string' ||
      !isSameStructType(typeArg.Balance, settlementTokenType) ||
      resolveFundsWithdrawalSource(withdrawFrom ?? undefined) !== 'Sender'
    ) {
      continue;
    }
    withdrawals.push({
      inputIndex,
      amount: decodeFundsWithdrawal(
        { kind: 'Input', input: inputIndex },
        inputs,
        settlementTokenType,
      ),
    });
  }
  return withdrawals;
}

function collectSenderRedeems(
  commands: PtbCommand[],
  inputs: unknown[],
  settlementTokenType: string,
): PaymentInputSenderRedeem[] {
  const redeems: PaymentInputSenderRedeem[] = [];
  for (let commandIndex = 0; commandIndex < commands.length; commandIndex++) {
    const command = commands[commandIndex]!;
    if (!isRedeemFundsCall(command, settlementTokenType)) continue;
    const withdrawalRef = parseCommandRef(command.arguments[0]);
    if (!withdrawalRef || withdrawalRef.kind !== 'Input') {
      throw new Error(`redeem_funds command ${commandIndex} must consume an Input withdrawal`);
    }
    redeems.push({
      commandIndex,
      inputIndex: withdrawalRef.input,
      amount: decodeFundsWithdrawal(withdrawalRef, inputs, settlementTokenType),
    });
  }
  return redeems;
}

function tryExtractDirectRedeemTrace(
  ref: CommandRef | null,
  commands: PtbCommand[],
  inputs: unknown[],
  settlementTokenType: string,
): {
  withdrawalAmount: bigint;
  redeemCommandIndex: number;
  withdrawalInputIndex: number;
} | null {
  if (!ref || (ref.kind !== 'Result' && ref.kind !== 'NestedResult')) {
    return null;
  }

  const redeemCmd = commands[ref.command];
  if (!redeemCmd || !isRedeemFundsCall(redeemCmd, settlementTokenType)) {
    return null;
  }
  const withdrawalArg = parseCommandRef(redeemCmd.arguments[0]);
  if (!withdrawalArg || withdrawalArg.kind !== 'Input') {
    throw new Error(`redeem_funds command ${ref.command} must consume an Input withdrawal`);
  }
  return {
    withdrawalAmount: decodeFundsWithdrawal(withdrawalArg, inputs, settlementTokenType),
    redeemCommandIndex: ref.command,
    withdrawalInputIndex: withdrawalArg.input,
  };
}

function collectBaseFundingMerges(
  commands: PtbCommand[],
  inputs: unknown[],
  settlementTokenType: string,
  baseInputIndex: number,
  splitCommandIndex: number,
): {
  directMergeSources: PaymentInputDirectMergeSource[];
  unsupportedMergeSources: PaymentInputUnsupportedMergeSource[];
  topup: {
    withdrawalAmount: bigint;
    redeemCommandIndex: number;
    withdrawalInputIndex: number;
    topupMergeCommandIndex: number;
  } | null;
} {
  const directMergeSources: PaymentInputDirectMergeSource[] = [];
  const unsupportedMergeSources: PaymentInputUnsupportedMergeSource[] = [];
  let topup: {
    withdrawalAmount: bigint;
    redeemCommandIndex: number;
    withdrawalInputIndex: number;
    topupMergeCommandIndex: number;
  } | null = null;

  for (let commandIndex = 0; commandIndex < splitCommandIndex; commandIndex++) {
    const merge = getMergePayload(commands[commandIndex]!);
    if (!merge) continue;

    const destinationRef = parseCommandRef(merge.destination);
    if (
      !destinationRef ||
      destinationRef.kind !== 'Input' ||
      destinationRef.input !== baseInputIndex
    ) {
      continue;
    }

    for (let sourceIndex = 0; sourceIndex < merge.sources.length; sourceIndex++) {
      const sourceRef = parseCommandRef(merge.sources[sourceIndex]);
      if (sourceRef?.kind === 'Input') {
        directMergeSources.push({
          commandIndex,
          inputIndex: sourceRef.input,
          objectId: extractCanonicalObjectId(
            inputs,
            sourceRef.input,
            `MergeCoins command ${commandIndex} source`,
          ),
        });
        continue;
      }

      const redeemTrace = tryExtractDirectRedeemTrace(
        sourceRef,
        commands,
        inputs,
        settlementTokenType,
      );
      if (redeemTrace) {
        if (topup) {
          throw new Error('Multiple redeem_funds topups merged into the payment base coin');
        }
        topup = { ...redeemTrace, topupMergeCommandIndex: commandIndex };
        continue;
      }

      unsupportedMergeSources.push({ commandIndex, sourceIndex });
    }
  }

  return { directMergeSources, unsupportedMergeSources, topup };
}

function extractSplitTrace(
  ref: CommandRef | null,
  commands: PtbCommand[],
  inputs: unknown[],
  settlementTokenType: string,
): {
  splitAmount: bigint;
  splitCommandIndex: number;
  baseInputIndex: number;
  baseCoinObjectId: string;
  directMergeSources: PaymentInputDirectMergeSource[];
  unsupportedMergeSources: PaymentInputUnsupportedMergeSource[];
  fundingInputUses: PaymentInputObjectUse[];
  topup: {
    withdrawalAmount: bigint;
    redeemCommandIndex: number;
    withdrawalInputIndex: number;
    topupMergeCommandIndex: number;
  } | null;
} | null {
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

  const fundingMerges = collectBaseFundingMerges(
    commands,
    inputs,
    settlementTokenType,
    baseRef.input,
    ref.command,
  );
  const baseCoinObjectId = extractCanonicalObjectId(
    inputs,
    baseRef.input,
    `SplitCoins command ${ref.command} base coin`,
  );
  const selectedObjectIds = new Set([
    baseCoinObjectId,
    ...fundingMerges.directMergeSources.map(({ objectId }) => objectId),
  ]);
  const selectedInputIndexes = new Set<number>();
  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex++) {
    const input = asRecord(inputs[inputIndex]);
    const objectId = input ? extractObjectIdFromInput(input) : null;
    if (!objectId) continue;
    try {
      if (selectedObjectIds.has(normalizeSuiAddress(objectId))) {
        selectedInputIndexes.add(inputIndex);
      }
    } catch {
      // An unrelated malformed object input is owned by the outer PTB validator.
    }
  }
  return {
    splitAmount: decodePureU64Input(parseCommandRef(split.amounts[0]), inputs),
    splitCommandIndex: ref.command,
    baseInputIndex: baseRef.input,
    baseCoinObjectId,
    fundingInputUses: collectFundingInputUses(commands, selectedInputIndexes),
    ...fundingMerges,
  };
}

export function extractPaymentInputTrace(
  commands: PtbCommand[],
  inputs: unknown[],
  settleCmd: MoveCallCommand,
): PaymentInputTrace {
  const entry = (
    SETTLEMENT_ENTRY_FUNCTIONS as Readonly<
      Record<string, (typeof SETTLEMENT_ENTRY_FUNCTIONS)[keyof typeof SETTLEMENT_ENTRY_FUNCTIONS]>
    >
  )[settleCmd.function];
  if (!entry) {
    throw new Error(`Unknown settle function for payment-input integrity: ${settleCmd.function}`);
  }
  const variantClass = entry.variantClass;

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
  const senderWithdrawals = collectSenderWithdrawals(inputs, settlementTokenType);
  const senderRedeems = collectSenderRedeems(commands, inputs, settlementTokenType);

  const paymentCoinIndex = settlementParameterIndex(settleCmd.function, 'payment_coin');
  const swapAmountIndex = settlementParameterIndex(settleCmd.function, 'swap_amount');
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

  const directRedeem = tryExtractDirectRedeemTrace(
    paymentRef,
    commands,
    inputs,
    settlementTokenType,
  );
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
      redeemCommandIndex: directRedeem.redeemCommandIndex,
      withdrawalInputIndex: directRedeem.withdrawalInputIndex,
      senderWithdrawals,
      senderRedeems,
    };
  }

  const splitTrace = extractSplitTrace(paymentRef, commands, inputs, settlementTokenType);
  if (!splitTrace) {
    throw new Error(
      `Unsupported payment coin producer for settle variant ${variantClass}: ${refKind}`,
    );
  }
  if (refKind !== 'result' && refKind !== 'nested_result') {
    throw new Error(`Payment coin split source must be a command result, got ${refKind}`);
  }

  if (splitTrace.topup) {
    return {
      settleVariantClass: variantClass,
      source: 'mixed_topup',
      paymentCoinRefKind: refKind,
      producerCommandKind: 'SplitCoins',
      settleSwapAmount,
      splitAmount: splitTrace.splitAmount,
      splitCommandIndex: splitTrace.splitCommandIndex,
      topupCommandKind: 'MoveCall',
      withdrawalAmount: splitTrace.topup.withdrawalAmount,
      redeemCommandIndex: splitTrace.topup.redeemCommandIndex,
      withdrawalInputIndex: splitTrace.topup.withdrawalInputIndex,
      topupMergeCommandIndex: splitTrace.topup.topupMergeCommandIndex,
      baseInputIndex: splitTrace.baseInputIndex,
      baseCoinObjectId: splitTrace.baseCoinObjectId,
      directMergeSources: splitTrace.directMergeSources,
      unsupportedMergeSources: splitTrace.unsupportedMergeSources,
      fundingInputUses: splitTrace.fundingInputUses,
      senderWithdrawals,
      senderRedeems,
    };
  }

  return {
    settleVariantClass: variantClass,
    source: 'coin_object',
    paymentCoinRefKind: refKind,
    producerCommandKind: 'SplitCoins',
    settleSwapAmount,
    splitAmount: splitTrace.splitAmount,
    splitCommandIndex: splitTrace.splitCommandIndex,
    baseInputIndex: splitTrace.baseInputIndex,
    baseCoinObjectId: splitTrace.baseCoinObjectId,
    directMergeSources: splitTrace.directMergeSources,
    unsupportedMergeSources: splitTrace.unsupportedMergeSources,
    fundingInputUses: splitTrace.fundingInputUses,
    senderWithdrawals,
    senderRedeems,
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

function validateExactFundingInputUses(
  trace: Extract<PaymentInputTrace, { source: 'coin_object' | 'mixed_topup' }>,
  boundary: number,
): PaymentInputIntegrityResult | null {
  if (trace.splitCommandIndex < boundary) {
    return {
      ok: false,
      subcode: 'payment_input_command_boundary_mismatch',
      message:
        `Payment split command ${trace.splitCommandIndex} precedes Host command boundary ` +
        `${boundary}`,
    };
  }

  const hostDirectMerges = trace.directMergeSources.filter(
    ({ commandIndex }) => commandIndex >= boundary,
  );
  const directMergeCommandIndexes = new Set(
    hostDirectMerges.map(({ commandIndex }) => commandIndex),
  );
  const allowed = new Map<string, number>();
  const allow = (commandIndex: number, inputIndex: number): void => {
    const key = `${commandIndex}:${inputIndex}`;
    allowed.set(key, (allowed.get(key) ?? 0) + 1);
  };

  allow(trace.splitCommandIndex, trace.baseInputIndex);
  for (const commandIndex of directMergeCommandIndexes) {
    allow(commandIndex, trace.baseInputIndex);
  }
  for (const source of hostDirectMerges) {
    allow(source.commandIndex, source.inputIndex);
  }
  if (trace.source === 'mixed_topup') {
    allow(trace.topupMergeCommandIndex, trace.baseInputIndex);
  }

  const actual = new Map<string, number>();
  for (const use of trace.fundingInputUses) {
    if (use.commandIndex < boundary) continue;
    actual.set(`${use.commandIndex}:${use.inputIndex}`, use.occurrences);
  }

  for (const [key, occurrences] of actual) {
    if (allowed.get(key) !== occurrences) {
      return {
        ok: false,
        subcode: 'payment_input_funding_use_mismatch',
        message: `Selected funding input has an unexpected Host command use at ${key}`,
      };
    }
  }
  for (const [key, occurrences] of allowed) {
    if (actual.get(key) !== occurrences) {
      return {
        ok: false,
        subcode: 'payment_input_funding_use_mismatch',
        message: `Selected funding input is missing its exact Host command use at ${key}`,
      };
    }
  }

  return null;
}

function validateExactSenderFunding(
  trace: Exclude<PaymentInputTrace, { source: 'none_credit_only' }>,
  commandBoundary: number,
  inputBoundary: number,
): PaymentInputIntegrityResult | null {
  const hostWithdrawals = trace.senderWithdrawals.filter(
    ({ inputIndex }) => inputIndex >= inputBoundary,
  );
  const hostRedeems = trace.senderRedeems.filter(
    ({ commandIndex }) => commandIndex >= commandBoundary,
  );

  if (trace.source === 'coin_object') {
    if (hostWithdrawals.length === 0 && hostRedeems.length === 0) return null;
    return {
      ok: false,
      subcode: 'payment_input_redeem_use_mismatch',
      message: 'Coin-object funding contains an unexpected Host Sender withdrawal or redeem',
    };
  }

  if (hostWithdrawals.length !== 1 || hostRedeems.length !== 1) {
    return {
      ok: false,
      subcode: 'payment_input_redeem_use_mismatch',
      message:
        `Expected one Host Sender withdrawal and redeem, got ` +
        `${hostWithdrawals.length}/${hostRedeems.length}`,
    };
  }

  const withdrawal = hostWithdrawals[0]!;
  const redeem = hostRedeems[0]!;
  if (
    withdrawal.inputIndex !== trace.withdrawalInputIndex ||
    withdrawal.amount !== trace.withdrawalAmount ||
    redeem.commandIndex !== trace.redeemCommandIndex ||
    redeem.inputIndex !== trace.withdrawalInputIndex ||
    redeem.amount !== trace.withdrawalAmount
  ) {
    return {
      ok: false,
      subcode: 'payment_input_redeem_use_mismatch',
      message: 'Host Sender withdrawal/redeem does not match the selected payment producer',
    };
  }

  return null;
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

  const hasCommandBoundary = expected.userCommandCount !== undefined;
  const hasInputBoundary = expected.userInputCount !== undefined;
  if (hasCommandBoundary !== hasInputBoundary) {
    return {
      ok: false,
      subcode: 'payment_input_command_boundary_mismatch',
      message: 'Exact payment-input validation requires both command and input boundaries',
    };
  }
  if (
    (hasCommandBoundary &&
      (!Number.isSafeInteger(expected.userCommandCount) || expected.userCommandCount! < 0)) ||
    (hasInputBoundary &&
      (!Number.isSafeInteger(expected.userInputCount) || expected.userInputCount! < 0))
  ) {
    return {
      ok: false,
      subcode: 'payment_input_command_boundary_mismatch',
      message:
        'User command/input boundaries must be non-negative safe integers, got ' +
        `${expected.userCommandCount}/${expected.userInputCount}`,
    };
  }

  if (trace.source === 'none_credit_only') {
    if (expected.source !== undefined && expected.source !== 'none_credit_only') {
      return {
        ok: false,
        subcode: 'payment_input_source_mismatch',
        message: `Payment-input source none_credit_only does not match expected ${expected.source}`,
      };
    }
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

  if (trace.source === 'mixed_topup') {
    if (
      trace.withdrawalAmount <= 0n ||
      trace.redeemCommandIndex < 0 ||
      trace.topupMergeCommandIndex <= trace.redeemCommandIndex
    ) {
      return {
        ok: false,
        subcode: 'payment_input_topup_amount_invalid',
        message:
          `Invalid redeem topup at commands ${trace.redeemCommandIndex}/` +
          `${trace.topupMergeCommandIndex} with amount ${trace.withdrawalAmount}`,
      };
    }
  }

  if (expected.source !== undefined && trace.source !== expected.source) {
    return {
      ok: false,
      subcode: 'payment_input_source_mismatch',
      message: `Payment-input source ${trace.source} does not match expected ${expected.source}`,
    };
  }

  const objectFundingTrace =
    trace.source === 'coin_object' || trace.source === 'mixed_topup' ? trace : null;

  const unsupportedHostMerge =
    objectFundingTrace && expected.userCommandCount !== undefined
      ? objectFundingTrace.unsupportedMergeSources.find(
          ({ commandIndex }) => commandIndex >= expected.userCommandCount!,
        )
      : undefined;
  if (unsupportedHostMerge) {
    return {
      ok: false,
      subcode: 'payment_input_unexpected_merge_source',
      message:
        `Payment base coin received an unsupported merge source at command ` +
        `${unsupportedHostMerge.commandIndex}, source ${unsupportedHostMerge.sourceIndex}`,
    };
  }

  if (expected.baseCoinObjectId !== undefined) {
    let normalizedExpectedBase: string;
    try {
      normalizedExpectedBase = normalizeSuiAddress(expected.baseCoinObjectId);
    } catch {
      return {
        ok: false,
        subcode: 'payment_input_base_coin_mismatch',
        message: `Expected payment base coin ID is invalid: ${expected.baseCoinObjectId}`,
      };
    }
    if (!objectFundingTrace || objectFundingTrace.baseCoinObjectId !== normalizedExpectedBase) {
      return {
        ok: false,
        subcode: 'payment_input_base_coin_mismatch',
        message:
          `Payment base coin ${objectFundingTrace?.baseCoinObjectId ?? 'none'} does not match ` +
          `expected ${normalizedExpectedBase}`,
      };
    }
  }

  if (expected.mergeCoinObjectIds !== undefined) {
    let normalizedExpectedMergeIds: string[];
    try {
      normalizedExpectedMergeIds = expected.mergeCoinObjectIds.map((objectId) =>
        normalizeSuiAddress(objectId),
      );
    } catch {
      return {
        ok: false,
        subcode: 'payment_input_merge_coin_ids_mismatch',
        message: 'Expected payment merge coin IDs contain an invalid object ID',
      };
    }

    const actualMergeIds = objectFundingTrace
      ? objectFundingTrace.directMergeSources
          .filter(
            ({ commandIndex }) =>
              expected.userCommandCount === undefined || commandIndex >= expected.userCommandCount,
          )
          .map(({ objectId }) => objectId)
      : [];
    if (
      actualMergeIds.length !== normalizedExpectedMergeIds.length ||
      actualMergeIds.some((objectId, index) => objectId !== normalizedExpectedMergeIds[index])
    ) {
      return {
        ok: false,
        subcode: 'payment_input_merge_coin_ids_mismatch',
        message:
          `Payment merge coin IDs [${actualMergeIds.join(', ')}] do not match expected ` +
          `[${normalizedExpectedMergeIds.join(', ')}]`,
      };
    }
  }

  if (expected.userCommandCount !== undefined) {
    const boundary = expected.userCommandCount;
    const inputBoundary = expected.userInputCount!;
    if (objectFundingTrace) {
      const fundingUseFailure = validateExactFundingInputUses(objectFundingTrace, boundary);
      if (fundingUseFailure) return fundingUseFailure;
    }
    if (trace.source === 'address_balance' && trace.redeemCommandIndex < boundary) {
      return {
        ok: false,
        subcode: 'payment_input_command_boundary_mismatch',
        message:
          `Address-balance redeem command ${trace.redeemCommandIndex} precedes Host command ` +
          `boundary ${boundary}`,
      };
    }
    if (
      trace.source === 'mixed_topup' &&
      (trace.redeemCommandIndex < boundary || trace.topupMergeCommandIndex < boundary)
    ) {
      return {
        ok: false,
        subcode: 'payment_input_command_boundary_mismatch',
        message:
          `Mixed-topup commands ${trace.redeemCommandIndex}/` +
          `${trace.topupMergeCommandIndex} precede Host command boundary ${boundary}`,
      };
    }
    const senderFundingFailure = validateExactSenderFunding(trace, boundary, inputBoundary);
    if (senderFundingFailure) return senderFundingFailure;
  }

  if (expected.addressBalanceRedeemAmount !== undefined) {
    let actualRedeemAmount: bigint | null = null;
    if (trace.source === 'address_balance') {
      actualRedeemAmount = trace.withdrawalAmount;
    } else if (trace.source === 'mixed_topup') {
      actualRedeemAmount = trace.withdrawalAmount;
    }
    if (actualRedeemAmount !== expected.addressBalanceRedeemAmount) {
      return {
        ok: false,
        subcode: 'payment_input_redeem_amount_mismatch',
        message:
          `Address-balance redeem amount ${actualRedeemAmount ?? 'none'} does not match expected ` +
          `${expected.addressBalanceRedeemAmount}`,
      };
    }
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

  if (trace.withdrawalAmount >= trace.settleSwapAmount) {
    return {
      ok: false,
      subcode: 'payment_input_topup_amount_invalid',
      message:
        `Mixed-topup withdrawal amount ${trace.withdrawalAmount} must be > 0 ` +
        'and < settle ' +
        `swap amount ${trace.settleSwapAmount}`,
    };
  }

  return { ok: true };
}
