/**
 * Command-ordered value tracing for settlement-token funding.
 *
 * The trace keeps object identity separate from value carriers. In particular,
 * SplitCoins outputs are new coin objects: consuming one of those outputs must
 * not consume or taint the direct input coin from which it was split.
 */
import type { Argument, CallArg, Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag, normalizeSuiObjectId } from '@mysten/sui/utils';
import { decodeExactPureU64Base64 } from './decodeU64.js';
import { extractObjectIdFromInput } from './ptbInputUtils.js';
import { parseSuiCallArg, parseSuiCommands } from './sui/suiTransactionShape.js';

export interface PrefixCoinValue {
  readonly snapshotCoinIds: readonly string[];
  readonly delta: bigint;
}

export interface PrefixCoinValueConstraint {
  readonly commandIndex: number;
  readonly value: PrefixCoinValue;
}

export type DirectCoinTrace =
  | { readonly status: 'surviving'; readonly value: PrefixCoinValue }
  | { readonly status: 'consumed' }
  | { readonly status: 'opaque' };

export interface PrefixValueTrace {
  readonly directCoins: ReadonlyMap<string, DirectCoinTrace>;
  /** Exact carrier values that must fit u64 at the command where they occur. */
  readonly valueConstraints: readonly PrefixCoinValueConstraint[];
  readonly senderWithdrawalDebit: bigint;
}

/** A structurally invalid prefix attempted to move one MergeCoins source twice. */
export class PrefixValueTraceError extends Error {
  readonly code = 'DUPLICATE_MERGE_SOURCE' as const;

  constructor(readonly sourceKey: string) {
    super(`MergeCoins source ${sourceKey} is used more than once`);
    this.name = 'PrefixValueTraceError';
  }
}

interface MutableCoinValue {
  readonly snapshotCoinIds: Set<string>;
  delta: bigint;
}

interface MutableCarrier {
  readonly key: string;
  readonly directObjectId?: string;
  available: boolean;
  /** null means the carrier exists but its value cannot be calculated exactly. */
  value: MutableCoinValue | null;
}

/** Normalize a Move struct type without turning malformed input into identity. */
export function normalizeMoveStructType(value: string): string | null {
  try {
    return normalizeStructTag(value);
  } catch {
    return null;
  }
}

function argumentInputIndex(arg: Argument): number | null {
  return arg.$kind === 'Input' ? arg.Input : null;
}

function normalizedInputObjectId(arg: Argument, inputs: readonly CallArg[]): string | null {
  const index = argumentInputIndex(arg);
  if (index === null || index >= inputs.length) return null;
  const objectId = extractObjectIdFromInput(inputs[index]! as unknown as Record<string, unknown>);
  return objectId ? normalizeSuiObjectId(objectId) : null;
}

function decodeExactSplitAmount(arg: Argument, inputs: readonly CallArg[]): bigint | null {
  const index = argumentInputIndex(arg);
  if (index === null || index >= inputs.length) return null;
  const input = inputs[index]!;
  if (input.$kind !== 'Pure') return null;

  try {
    return decodeExactPureU64Base64(input.Pure.bytes);
  } catch {
    return null;
  }
}

function mergeExactValues(target: MutableCarrier, source: MutableCarrier | null): void {
  if (!target.available) return;
  if (!source || !source.available || !target.value || !source.value || source === target) {
    target.value = null;
    return;
  }

  for (const sourceId of source.value.snapshotCoinIds) {
    // An exact value component cannot be present in two live carriers. An
    // overlap means the prefix aliases or duplicates an object value.
    if (target.value.snapshotCoinIds.has(sourceId)) {
      target.value = null;
      return;
    }
  }
  for (const sourceId of source.value.snapshotCoinIds) {
    target.value.snapshotCoinIds.add(sourceId);
  }
  target.value.delta += source.value.delta;
}

function snapshotValue(value: MutableCoinValue): PrefixCoinValue {
  return {
    snapshotCoinIds: [...value.snapshotCoinIds].sort(),
    delta: value.delta,
  };
}

/**
 * Trace direct-input coin state and exact value movement through the user prefix.
 *
 * Only canonical Pure u64 SplitCoins amounts contribute exact debits. MoveCall
 * ABI inference is deliberately out of scope: a direct input passed to a
 * MoveCall becomes opaque, while a derived result never taints its parent input.
 */
export function traceUserPrefixValue(
  tx: Transaction,
  settlementTokenType: string,
): PrefixValueTrace {
  const data = tx.getData();
  const inputs = data.inputs.map((input, index) => parseSuiCallArg(input, `inputs[${index}]`));
  const commands = parseSuiCommands(data.commands);
  const directCarriers = new Map<string, MutableCarrier>();
  const commandResults = new Map<number, readonly MutableCarrier[]>();
  const mergeSourceKeys = new Set<string>();
  const valueConstraints: PrefixCoinValueConstraint[] = [];

  function directCarrier(arg: Argument): MutableCarrier | null {
    const objectId = normalizedInputObjectId(arg, inputs);
    if (!objectId) return null;

    let carrier = directCarriers.get(objectId);
    if (!carrier) {
      carrier = {
        key: `object:${objectId}`,
        directObjectId: objectId,
        available: true,
        value: { snapshotCoinIds: new Set([objectId]), delta: 0n },
      };
      directCarriers.set(objectId, carrier);
    }
    return carrier;
  }

  function resultCoordinates(arg: Argument): [number, number] | null {
    if (arg.$kind === 'Result') {
      // Result(i) is valid only for a single-result command, in which case it
      // aliases NestedResult(i, 0).
      return [arg.Result, 0];
    }
    if (arg.$kind !== 'NestedResult') return null;
    const [commandIndex, resultIndex] = arg.NestedResult;
    return [commandIndex, resultIndex];
  }

  function resolveCarrier(arg: Argument): MutableCarrier | null {
    if (arg.$kind === 'Input') return directCarrier(arg);
    const coordinates = resultCoordinates(arg);
    if (!coordinates) return null;
    const [commandIndex, resultIndex] = coordinates;
    const results = commandResults.get(commandIndex);
    if (arg.$kind === 'Result' && results?.length !== 1) return null;
    return results?.[resultIndex] ?? null;
  }

  function mergeSourceKey(arg: Argument): string {
    const carrier = resolveCarrier(arg);
    if (carrier) return carrier.key;
    const coordinates = resultCoordinates(arg);
    if (coordinates) return `result:${coordinates[0]}:${coordinates[1]}`;
    const inputIndex = argumentInputIndex(arg);
    if (inputIndex !== null) return `input:${inputIndex}`;
    return 'gas-coin';
  }

  function consume(carrier: MutableCarrier | null): void {
    if (!carrier) return;
    carrier.available = false;
    carrier.value = null;
  }

  function markMoveCallUse(carrier: MutableCarrier | null): void {
    if (!carrier || !carrier.available) return;
    if (carrier.directObjectId) {
      carrier.value = null;
    } else {
      // Without an ABI, a derived value may be moved, borrowed, or mutated.
      consume(carrier);
    }
  }

  for (let commandIndex = 0; commandIndex < commands.length; commandIndex++) {
    const command = commands[commandIndex]!;
    const kind = command.$kind;
    commandResults.set(commandIndex, []);

    if (kind === 'SplitCoins') {
      const source = resolveCarrier(command.SplitCoins.coin);
      const amounts = command.SplitCoins.amounts.map((arg) => decodeExactSplitAmount(arg, inputs));
      const allAmountsExact = amounts.every((amount): amount is bigint => amount !== null);

      if (source?.available) {
        if (source.value && allAmountsExact) {
          source.value.delta -= amounts.reduce((sum, amount) => sum + amount, 0n);
          valueConstraints.push({ commandIndex, value: snapshotValue(source.value) });
        } else if (!allAmountsExact) {
          source.value = null;
        }
      }

      const outputs = amounts.map<MutableCarrier>((amount, resultIndex) => ({
        key: `result:${commandIndex}:${resultIndex}`,
        available: source?.available ?? false,
        value:
          source?.available && amount !== null
            ? { snapshotCoinIds: new Set(), delta: amount }
            : null,
      }));
      commandResults.set(commandIndex, outputs);
      continue;
    }

    if (kind === 'MergeCoins') {
      const targetArg = command.MergeCoins.destination;
      const sourceArgs = command.MergeCoins.sources;

      // Validate the whole command before mutating carrier state so the error
      // cannot depend on source order within a command.
      for (const sourceArg of sourceArgs) {
        const sourceKey = mergeSourceKey(sourceArg);
        if (mergeSourceKeys.has(sourceKey)) throw new PrefixValueTraceError(sourceKey);
        mergeSourceKeys.add(sourceKey);
      }

      const target = resolveCarrier(targetArg);
      for (const sourceArg of sourceArgs) {
        const source = resolveCarrier(sourceArg);
        if (target) mergeExactValues(target, source);
        if (source === target) {
          consume(target);
        } else {
          consume(source);
        }
      }
      if (target?.available && target.value) {
        valueConstraints.push({ commandIndex, value: snapshotValue(target.value) });
      }
      // MergeCoins mutates and restores its target; it has no command result.
      continue;
    }

    if (kind === 'TransferObjects') {
      for (const object of command.TransferObjects.objects) consume(resolveCarrier(object));
      continue;
    }

    if (kind === 'MakeMoveVec') {
      for (const element of command.MakeMoveVec.elements) consume(resolveCarrier(element));
      continue;
    }

    if (kind === 'MoveCall') {
      for (const arg of command.MoveCall.arguments) markMoveCallUse(resolveCarrier(arg));
    }
  }

  const directCoins = new Map<string, DirectCoinTrace>();
  for (const [objectId, carrier] of directCarriers) {
    if (!carrier.available) {
      directCoins.set(objectId, { status: 'consumed' });
    } else if (!carrier.value) {
      directCoins.set(objectId, { status: 'opaque' });
    } else {
      directCoins.set(objectId, {
        status: 'surviving',
        value: snapshotValue(carrier.value),
      });
    }
  }

  const withdrawal = extractPrefixWithdrawalsFromInputs(inputs, settlementTokenType);
  return {
    directCoins,
    valueConstraints,
    senderWithdrawalDebit: withdrawal,
  };
}

/** Resolve the exact current SDK withdrawal-source union. */
export function resolveFundsWithdrawalSource(
  withdrawFrom: Record<string, unknown> | undefined,
): 'Sender' | 'Sponsor' | null {
  if (!withdrawFrom) return null;
  if (
    withdrawFrom.$kind === 'Sender' &&
    withdrawFrom.Sender === true &&
    !Object.prototype.hasOwnProperty.call(withdrawFrom, 'Sponsor')
  ) {
    return 'Sender';
  }
  if (
    withdrawFrom.$kind === 'Sponsor' &&
    withdrawFrom.Sponsor === true &&
    !Object.prototype.hasOwnProperty.call(withdrawFrom, 'Sender')
  ) {
    return 'Sponsor';
  }
  return null;
}

/**
 * Sum same-token Sender FundsWithdrawal reservations exactly once per input.
 * Parseable reservations for other token types are unrelated and ignored.
 */
function extractPrefixWithdrawalsFromInputs(
  inputs: readonly CallArg[],
  settlementTokenType: string,
): bigint {
  const normalizedPaymentType = normalizeStructTag(settlementTokenType);
  let total = 0n;

  for (const input of inputs) {
    if (input.$kind !== 'FundsWithdrawal') continue;
    const fw = input.FundsWithdrawal;
    if (fw.withdrawFrom.$kind !== 'Sender') continue;

    const normalizedWithdrawalType = normalizeStructTag(fw.typeArg.Balance);
    if (normalizedWithdrawalType !== normalizedPaymentType) continue;

    total += BigInt(fw.reservation.MaxAmountU64);
  }

  return total;
}

export function extractPrefixWithdrawals(tx: Transaction, settlementTokenType: string): bigint {
  const inputs = tx
    .getData()
    .inputs.map((input, index) => parseSuiCallArg(input, `inputs[${index}]`));
  return extractPrefixWithdrawalsFromInputs(inputs, settlementTokenType);
}

/** Detect an explicit withdrawal from the sponsored transaction's gas owner. */
export function containsSponsorWithdrawal(tx: Transaction): boolean {
  const inputs = tx
    .getData()
    .inputs.map((input, index) => parseSuiCallArg(input, `inputs[${index}]`));
  for (const input of inputs) {
    if (input.$kind !== 'FundsWithdrawal') continue;
    if (input.FundsWithdrawal.withdrawFrom.$kind === 'Sponsor') return true;
  }
  return false;
}
