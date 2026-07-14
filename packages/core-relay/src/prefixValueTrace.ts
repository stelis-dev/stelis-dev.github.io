/**
 * Command-ordered value tracing for settlement-token funding.
 *
 * The trace keeps object identity separate from value carriers. In particular,
 * SplitCoins outputs are new coin objects: consuming one of those outputs must
 * not consume or taint the direct input coin from which it was split.
 */
import type { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag, normalizeSuiObjectId } from '@mysten/sui/utils';
import { decodeExactPureU64Base64 } from './decodeU64.js';
import { extractObjectIdFromInput } from './ptbInputUtils.js';

const DECIMAL_U64_RE = /^(?:0|[1-9]\d*)$/;

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
  readonly unaccountableSenderWithdrawal: boolean;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Normalize a Move struct type without turning malformed input into identity. */
export function normalizeMoveStructType(value: string): string | null {
  try {
    return normalizeStructTag(value);
  } catch {
    return null;
  }
}

function argumentInputIndex(arg: Record<string, unknown>): number | null {
  return arg.$kind === 'Input' && Number.isInteger(arg.Input) && (arg.Input as number) >= 0
    ? (arg.Input as number)
    : null;
}

function normalizedInputObjectId(
  arg: Record<string, unknown>,
  inputs: readonly Record<string, unknown>[],
): string | null {
  const index = argumentInputIndex(arg);
  if (index === null || index >= inputs.length) return null;
  const objectId = extractObjectIdFromInput(inputs[index]!);
  return objectId ? normalizeSuiObjectId(objectId) : null;
}

function decodeExactSplitAmount(
  arg: Record<string, unknown>,
  inputs: readonly Record<string, unknown>[],
): bigint | null {
  const index = argumentInputIndex(arg);
  if (index === null || index >= inputs.length) return null;
  const input = asRecord(inputs[index]);
  const pure = asRecord(input?.Pure);
  if (input?.$kind !== 'Pure' || typeof pure?.bytes !== 'string') return null;

  try {
    return decodeExactPureU64Base64(pure.bytes);
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
  const inputs = data.inputs as Record<string, unknown>[];
  const commands = data.commands as Record<string, unknown>[];
  const directCarriers = new Map<string, MutableCarrier>();
  const commandResults = new Map<number, readonly MutableCarrier[]>();
  const mergeSourceKeys = new Set<string>();
  const valueConstraints: PrefixCoinValueConstraint[] = [];

  function directCarrier(arg: Record<string, unknown>): MutableCarrier | null {
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

  function resultCoordinates(arg: Record<string, unknown>): [number, number] | null {
    if (arg.$kind === 'Result' && Number.isInteger(arg.Result) && (arg.Result as number) >= 0) {
      // Result(i) is valid only for a single-result command, in which case it
      // aliases NestedResult(i, 0).
      return [arg.Result as number, 0];
    }
    if (arg.$kind !== 'NestedResult' || !Array.isArray(arg.NestedResult)) return null;
    const [commandIndex, resultIndex] = arg.NestedResult;
    return Number.isInteger(commandIndex) &&
      (commandIndex as number) >= 0 &&
      Number.isInteger(resultIndex) &&
      (resultIndex as number) >= 0
      ? [commandIndex as number, resultIndex as number]
      : null;
  }

  function resolveCarrier(arg: Record<string, unknown>): MutableCarrier | null {
    if (arg.$kind === 'Input') return directCarrier(arg);
    const coordinates = resultCoordinates(arg);
    if (!coordinates) return null;
    const [commandIndex, resultIndex] = coordinates;
    const results = commandResults.get(commandIndex);
    if (arg.$kind === 'Result' && results?.length !== 1) return null;
    return results?.[resultIndex] ?? null;
  }

  function mergeSourceKey(arg: Record<string, unknown>): string {
    const carrier = resolveCarrier(arg);
    if (carrier) return carrier.key;
    const coordinates = resultCoordinates(arg);
    if (coordinates) return `result:${coordinates[0]}:${coordinates[1]}`;
    const inputIndex = argumentInputIndex(arg);
    if (inputIndex !== null) return `input:${inputIndex}`;
    return arg.$kind === 'GasCoin' ? 'gas-coin' : `unknown:${JSON.stringify(arg)}`;
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
      const split = asRecord(command.SplitCoins);
      const sourceArg = asRecord(split?.coin);
      const amountArgs = Array.isArray(split?.amounts) ? split.amounts.map(asRecord) : [];
      const source = sourceArg ? resolveCarrier(sourceArg) : null;
      const amounts = amountArgs.map((arg) => (arg ? decodeExactSplitAmount(arg, inputs) : null));
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
      const merge = asRecord(command.MergeCoins);
      const targetArg = asRecord(merge?.destination);
      const sourceArgs = Array.isArray(merge?.sources) ? merge.sources.map(asRecord) : [];

      // Validate the whole command before mutating carrier state so the error
      // cannot depend on source order within a command.
      for (const sourceArg of sourceArgs) {
        if (!sourceArg) continue;
        const sourceKey = mergeSourceKey(sourceArg);
        if (mergeSourceKeys.has(sourceKey)) throw new PrefixValueTraceError(sourceKey);
        mergeSourceKeys.add(sourceKey);
      }

      const target = targetArg ? resolveCarrier(targetArg) : null;
      for (const sourceArg of sourceArgs) {
        const source = sourceArg ? resolveCarrier(sourceArg) : null;
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
      const transfer = asRecord(command.TransferObjects);
      const objects = Array.isArray(transfer?.objects) ? transfer.objects.map(asRecord) : [];
      for (const object of objects) consume(object ? resolveCarrier(object) : null);
      continue;
    }

    if (kind === 'MakeMoveVec') {
      const makeMoveVec = asRecord(command.MakeMoveVec);
      const elements = Array.isArray(makeMoveVec?.elements)
        ? makeMoveVec.elements.map(asRecord)
        : [];
      for (const element of elements) consume(element ? resolveCarrier(element) : null);
      continue;
    }

    if (kind === 'MoveCall') {
      const moveCall = asRecord(command.MoveCall);
      const args = Array.isArray(moveCall?.arguments) ? moveCall.arguments.map(asRecord) : [];
      for (const arg of args) markMoveCallUse(arg ? resolveCarrier(arg) : null);
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
    senderWithdrawalDebit: withdrawal.total,
    unaccountableSenderWithdrawal: withdrawal.unaccountable,
  };
}

/** Resolve both SDK-internal and BCS-roundtripped withdrawal-source shapes. */
export function resolveFundsWithdrawalSource(
  withdrawFrom: Record<string, unknown> | undefined,
): 'Sender' | 'Sponsor' | null {
  if (!withdrawFrom) return null;
  if (withdrawFrom.$kind === 'Sender') return 'Sender';
  if (withdrawFrom.$kind === 'Sponsor') return 'Sponsor';
  if (withdrawFrom.Sender) return 'Sender';
  if (withdrawFrom.Sponsor) return 'Sponsor';
  return null;
}

/**
 * Sum same-token Sender FundsWithdrawal reservations exactly once per input.
 * Parseable reservations for other token types are unrelated and ignored.
 */
function extractPrefixWithdrawalsFromInputs(
  inputs: readonly Record<string, unknown>[],
  settlementTokenType: string,
): { total: bigint; unaccountable: boolean } {
  const normalizedPaymentType = normalizeStructTag(settlementTokenType);
  let total = 0n;
  let unaccountable = false;

  for (const input of inputs) {
    if (input.$kind !== 'FundsWithdrawal') continue;
    const fw = asRecord(input.FundsWithdrawal);
    if (!fw) continue;
    if (resolveFundsWithdrawalSource(asRecord(fw.withdrawFrom) ?? undefined) !== 'Sender') continue;

    const typeArg = asRecord(fw.typeArg);
    const balanceType = typeArg?.Balance;
    if (typeof balanceType !== 'string') {
      unaccountable = true;
      continue;
    }

    const normalizedWithdrawalType = normalizeMoveStructType(balanceType);
    if (!normalizedWithdrawalType) {
      unaccountable = true;
      continue;
    }
    if (normalizedWithdrawalType !== normalizedPaymentType) continue;

    const reservation = asRecord(fw.reservation);
    const amount = reservation?.MaxAmountU64;
    if (
      reservation?.$kind !== 'MaxAmountU64' ||
      typeof amount !== 'string' ||
      !DECIMAL_U64_RE.test(amount)
    ) {
      unaccountable = true;
      continue;
    }
    total += BigInt(amount);
  }

  return { total, unaccountable };
}

export function extractPrefixWithdrawals(
  tx: Transaction,
  settlementTokenType: string,
): { total: bigint; unaccountable: boolean } {
  return extractPrefixWithdrawalsFromInputs(
    tx.getData().inputs as Record<string, unknown>[],
    settlementTokenType,
  );
}

/** Detect an explicit withdrawal from the sponsored transaction's gas owner. */
export function containsSponsorWithdrawal(tx: Transaction): boolean {
  const inputs = tx.getData().inputs as Record<string, unknown>[];
  for (const input of inputs) {
    if (input.$kind !== 'FundsWithdrawal') continue;
    const fw = asRecord(input.FundsWithdrawal);
    if (fw && resolveFundsWithdrawalSource(asRecord(fw.withdrawFrom) ?? undefined) === 'Sponsor') {
      return true;
    }
  }
  return false;
}
