import { RpcError } from '@protobuf-ts/runtime-rpc';
import { SimulationError, type ClientWithCoreApi } from '@mysten/sui/client';
import { GrpcCoreClient, GrpcTypes, type SuiGrpcClient } from '@mysten/sui/grpc';
import {
  Transaction,
  TransactionDataBuilder,
  type BuildTransactionOptions,
  type CallArg,
  type Command,
  type TransactionData,
  type TransactionPlugin,
} from '@mysten/sui/transactions';
import {
  isValidSuiAddress,
  isValidTransactionDigest,
  normalizeStructTag,
  normalizeSuiAddress,
} from '@mysten/sui/utils';
import { SUI_ZERO_ADDRESS } from '../constants.js';
import {
  malformedSuiResponse,
  rejectedSuiOperation,
  runSuiReadOperation,
  SuiOperationError,
  type SuiEndpointSnapshot,
} from './suiOperation.js';
import {
  assertExactSuiShapeKeys,
  parseExactSuiArray,
  parseRawSuiExecutedTransactionEnvelope,
  parseSuiArgument,
  parseSuiCallArg,
  parseSuiCommand,
  parseRawSuiResolutionStatus,
  rejectUnhandledSuiVariant,
  SuiTransactionShapeError,
  type SuiExecutionStatus,
} from './suiTransactionShape.js';
import { canonicalizeSuiTypeTag } from './suiTypeTag.js';
import { SUI_U64_MAX, isSuiU64 } from './suiU64.js';

export interface SuiTransactionBuildOptions {
  readonly transaction: Transaction;
  readonly onlyTransactionKind?: boolean;
  readonly signal?: AbortSignal;
}

const RAW_TRANSACTION_KEYS = [
  'bcs',
  'digest',
  'version',
  'kind',
  'sender',
  'gasPayment',
  'expiration',
] as const;
const RAW_TRANSACTION_KIND_KEYS = ['kind', 'data'] as const;
const RAW_PROGRAMMABLE_TRANSACTION_KEYS = ['inputs', 'commands'] as const;
const RAW_GAS_PAYMENT_KEYS = ['objects', 'owner', 'price', 'budget'] as const;
const RAW_INPUT_KEYS = [
  'kind',
  'pure',
  'objectId',
  'version',
  'digest',
  'mutable',
  'mutability',
  'fundsWithdrawal',
  'literal',
] as const;
const RAW_FUNDS_WITHDRAWAL_KEYS = ['amount', 'coinType', 'source'] as const;

type CurrentRawInputKind = Exclude<
  GrpcTypes.Input_InputKind,
  GrpcTypes.Input_InputKind.INPUT_KIND_UNKNOWN
>;

const CURRENT_RAW_INPUT_KINDS = {
  [GrpcTypes.Input_InputKind.PURE]: true,
  [GrpcTypes.Input_InputKind.IMMUTABLE_OR_OWNED]: true,
  [GrpcTypes.Input_InputKind.SHARED]: true,
  [GrpcTypes.Input_InputKind.RECEIVING]: true,
  [GrpcTypes.Input_InputKind.FUNDS_WITHDRAWAL]: true,
} as const satisfies Record<CurrentRawInputKind, true>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    return left instanceof Uint8Array && right instanceof Uint8Array && sameBytes(left, right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      const leftOwnsIndex = Object.prototype.hasOwnProperty.call(left, index);
      const rightOwnsIndex = Object.prototype.hasOwnProperty.call(right, index);
      if (
        leftOwnsIndex !== rightOwnsIndex ||
        !leftOwnsIndex ||
        !sameValue(left[index], right[index])
      ) {
        return false;
      }
    }
    return true;
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function requireAddress(value: unknown): string {
  if (typeof value !== 'string' || !isValidSuiAddress(value)) {
    throw new SuiTransactionShapeError('resolvedTransaction', 'expected a Sui address');
  }
  return normalizeSuiAddress(value);
}

function requireU64(value: unknown, allowZero: boolean): bigint {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) ||
    (typeof value === 'string' && !/^(?:0|[1-9]\d*)$/.test(value))
  ) {
    throw new SuiTransactionShapeError('resolvedTransaction', 'expected a canonical u64');
  }
  const parsed = BigInt(value);
  if (parsed > SUI_U64_MAX || (!allowZero && parsed === 0n)) {
    throw new SuiTransactionShapeError('resolvedTransaction', 'u64 is outside its current range');
  }
  return parsed;
}

function canonicalStructType(value: string): string {
  try {
    return normalizeStructTag(value);
  } catch {
    throw new SuiTransactionShapeError('resolvedTransaction', 'expected a current Move type');
  }
}

function canonicalTypeTag(value: string, path = 'resolvedTransaction'): string {
  try {
    return canonicalizeSuiTypeTag(value);
  } catch {
    throw new SuiTransactionShapeError(path, 'expected a current Sui type tag');
  }
}

function rawRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SuiTransactionShapeError(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function rawArray(value: unknown, path: string): unknown[] {
  return parseExactSuiArray(value, path);
}

function rawString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SuiTransactionShapeError(path, 'expected a non-empty string');
  }
  return value;
}

function rawAddress(value: unknown, path: string): string {
  const parsed = rawString(value, path);
  if (!isValidSuiAddress(parsed)) {
    throw new SuiTransactionShapeError(path, 'expected a Sui address');
  }
  return normalizeSuiAddress(parsed);
}

function rawDigest(value: unknown, path: string): string {
  const parsed = rawString(value, path);
  if (!isValidTransactionDigest(parsed)) {
    throw new SuiTransactionShapeError(path, 'expected a Sui digest');
  }
  return parsed;
}

function rawU64(value: unknown, path: string, allowZero = true): bigint {
  if (!isSuiU64(value) || (!allowZero && value === 0n)) {
    throw new SuiTransactionShapeError(path, 'expected a current protobuf u64');
  }
  return value;
}

function rawU32(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
    throw new SuiTransactionShapeError(path, 'expected a current protobuf u32');
  }
  return value as number;
}

function currentRawInputKind(value: unknown, path: string): CurrentRawInputKind {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    !Object.prototype.hasOwnProperty.call(CURRENT_RAW_INPUT_KINDS, value)
  ) {
    throw new SuiTransactionShapeError(path, 'unsupported current input kind');
  }
  return value as CurrentRawInputKind;
}

function rejectPresent(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      throw new SuiTransactionShapeError(
        `${path}.${key}`,
        'unexpected field for this current kind',
      );
    }
  }
}

function rawOneof<const Variants extends readonly string[]>(
  value: unknown,
  path: string,
  variants: Variants,
): { readonly kind: Variants[number]; readonly payload: unknown } {
  const union = rawRecord(value, path);
  const rawKind = rawString(union.oneofKind, `${path}.oneofKind`);
  if (!(variants as readonly string[]).includes(rawKind)) {
    throw new SuiTransactionShapeError(`${path}.oneofKind`, 'unsupported current oneof kind');
  }
  const kind = rawKind as Variants[number];
  for (const variant of variants) {
    if (variant === kind) {
      if (!Object.prototype.hasOwnProperty.call(union, variant) || union[variant] === undefined) {
        throw new SuiTransactionShapeError(path, `missing ${variant} payload`);
      }
    } else if (Object.prototype.hasOwnProperty.call(union, variant)) {
      throw new SuiTransactionShapeError(path, `contains opposing ${variant} payload`);
    }
  }
  assertExactSuiShapeKeys(union, path, ['oneofKind', kind]);
  return { kind, payload: union[kind] };
}

function projectRawResolverArgument(value: unknown, path: string): unknown {
  const argument = rawRecord(value, path);
  assertExactSuiShapeKeys(argument, path, ['kind', 'input', 'result', 'subresult']);
  switch (argument.kind) {
    case GrpcTypes.Argument_ArgumentKind.GAS:
      rejectPresent(argument, ['input', 'result', 'subresult'], path);
      return { kind: argument.kind };
    case GrpcTypes.Argument_ArgumentKind.INPUT: {
      const input = rawU32(argument.input, `${path}.input`);
      rejectPresent(argument, ['result', 'subresult'], path);
      return { kind: argument.kind, input };
    }
    case GrpcTypes.Argument_ArgumentKind.RESULT: {
      const result = rawU32(argument.result, `${path}.result`);
      const subresult =
        argument.subresult === undefined
          ? undefined
          : rawU32(argument.subresult, `${path}.subresult`);
      rejectPresent(argument, ['input'], path);
      return {
        kind: argument.kind,
        result,
        ...(subresult === undefined ? {} : { subresult }),
      };
    }
    default:
      throw new SuiTransactionShapeError(`${path}.kind`, 'unsupported current argument kind');
  }
}

function projectRawResolverArguments(value: unknown, path: string): readonly unknown[] {
  return rawArray(value, path).map((argument, index) =>
    projectRawResolverArgument(argument, `${path}[${index}]`),
  );
}

const RAW_COMMAND_KINDS = [
  'moveCall',
  'transferObjects',
  'splitCoins',
  'mergeCoins',
  'publish',
  'makeMoveVector',
  'upgrade',
] as const;

/**
 * Validate one raw gRPC command and project its transaction identity.
 * The resolver may normalize address and type-tag spelling; every other
 * command field remains exact in the projected comparison.
 */
function projectRawResolverCommand(value: unknown, path: string): unknown {
  const command = rawRecord(value, path);
  assertExactSuiShapeKeys(command, path, ['command']);
  const parsed = rawOneof(command.command, `${path}.command`, RAW_COMMAND_KINDS);
  const payload = rawRecord(parsed.payload, `${path}.command.${parsed.kind}`);
  switch (parsed.kind) {
    case 'moveCall':
      assertExactSuiShapeKeys(payload, `${path}.command.moveCall`, [
        'package',
        'module',
        'function',
        'typeArguments',
        'arguments',
      ]);
      return {
        kind: parsed.kind,
        package: rawAddress(payload.package, `${path}.command.moveCall.package`),
        module: rawString(payload.module, `${path}.command.moveCall.module`),
        function: rawString(payload.function, `${path}.command.moveCall.function`),
        typeArguments: rawArray(
          payload.typeArguments,
          `${path}.command.moveCall.typeArguments`,
        ).map((type, index) =>
          canonicalTypeTag(
            rawString(type, `${path}.command.moveCall.typeArguments[${index}]`),
            `${path}.command.moveCall.typeArguments[${index}]`,
          ),
        ),
        arguments: projectRawResolverArguments(
          payload.arguments,
          `${path}.command.moveCall.arguments`,
        ),
      };
    case 'transferObjects':
      assertExactSuiShapeKeys(payload, `${path}.command.transferObjects`, ['objects', 'address']);
      return {
        kind: parsed.kind,
        objects: projectRawResolverArguments(
          payload.objects,
          `${path}.command.transferObjects.objects`,
        ),
        address: projectRawResolverArgument(
          payload.address,
          `${path}.command.transferObjects.address`,
        ),
      };
    case 'splitCoins':
      assertExactSuiShapeKeys(payload, `${path}.command.splitCoins`, ['coin', 'amounts']);
      return {
        kind: parsed.kind,
        coin: projectRawResolverArgument(payload.coin, `${path}.command.splitCoins.coin`),
        amounts: projectRawResolverArguments(payload.amounts, `${path}.command.splitCoins.amounts`),
      };
    case 'mergeCoins':
      assertExactSuiShapeKeys(payload, `${path}.command.mergeCoins`, ['coin', 'coinsToMerge']);
      return {
        kind: parsed.kind,
        coin: projectRawResolverArgument(payload.coin, `${path}.command.mergeCoins.coin`),
        coinsToMerge: projectRawResolverArguments(
          payload.coinsToMerge,
          `${path}.command.mergeCoins.coinsToMerge`,
        ),
      };
    case 'publish':
      assertExactSuiShapeKeys(payload, `${path}.command.publish`, ['modules', 'dependencies']);
      return {
        kind: parsed.kind,
        modules: rawArray(payload.modules, `${path}.command.publish.modules`).map(
          (module, index) => {
            if (!(module instanceof Uint8Array)) {
              throw new SuiTransactionShapeError(
                `${path}.command.publish.modules[${index}]`,
                'expected bytes',
              );
            }
            return module;
          },
        ),
        dependencies: rawArray(payload.dependencies, `${path}.command.publish.dependencies`).map(
          (dependency, index) =>
            rawAddress(dependency, `${path}.command.publish.dependencies[${index}]`),
        ),
      };
    case 'makeMoveVector':
      assertExactSuiShapeKeys(payload, `${path}.command.makeMoveVector`, [
        'elementType',
        'elements',
      ]);
      return {
        kind: parsed.kind,
        elementType:
          payload.elementType === undefined
            ? null
            : canonicalTypeTag(
                rawString(payload.elementType, `${path}.command.makeMoveVector.elementType`),
                `${path}.command.makeMoveVector.elementType`,
              ),
        elements: projectRawResolverArguments(
          payload.elements,
          `${path}.command.makeMoveVector.elements`,
        ),
      };
    case 'upgrade':
      assertExactSuiShapeKeys(payload, `${path}.command.upgrade`, [
        'modules',
        'dependencies',
        'package',
        'ticket',
      ]);
      return {
        kind: parsed.kind,
        modules: rawArray(payload.modules, `${path}.command.upgrade.modules`).map(
          (module, index) => {
            if (!(module instanceof Uint8Array)) {
              throw new SuiTransactionShapeError(
                `${path}.command.upgrade.modules[${index}]`,
                'expected bytes',
              );
            }
            return module;
          },
        ),
        dependencies: rawArray(payload.dependencies, `${path}.command.upgrade.dependencies`).map(
          (dependency, index) =>
            rawAddress(dependency, `${path}.command.upgrade.dependencies[${index}]`),
        ),
        package: rawAddress(payload.package, `${path}.command.upgrade.package`),
        ticket: projectRawResolverArgument(payload.ticket, `${path}.command.upgrade.ticket`),
      };
    default:
      return rejectUnhandledSuiVariant(parsed.kind, `${path}.command.oneofKind`);
  }
}

function projectRawResolvedInput(value: unknown, path: string): unknown {
  const input = rawRecord(value, path);
  assertExactSuiShapeKeys(input, path, RAW_INPUT_KEYS);
  if (Object.prototype.hasOwnProperty.call(input, 'literal')) {
    throw new SuiTransactionShapeError(`${path}.literal`, 'resolved input retained a literal');
  }
  const kind = currentRawInputKind(input.kind, `${path}.kind`);
  switch (kind) {
    case GrpcTypes.Input_InputKind.PURE:
      if (!(input.pure instanceof Uint8Array)) {
        throw new SuiTransactionShapeError(`${path}.pure`, 'expected bytes');
      }
      rejectPresent(
        input,
        ['objectId', 'version', 'digest', 'mutable', 'mutability', 'fundsWithdrawal'],
        path,
      );
      return { kind, pure: input.pure };
    case GrpcTypes.Input_InputKind.IMMUTABLE_OR_OWNED:
    case GrpcTypes.Input_InputKind.RECEIVING: {
      const objectId = rawAddress(input.objectId, `${path}.objectId`);
      const version = rawU64(input.version, `${path}.version`);
      const digest = rawDigest(input.digest, `${path}.digest`);
      rejectPresent(input, ['pure', 'mutable', 'mutability', 'fundsWithdrawal'], path);
      return { kind, objectId, version, digest };
    }
    case GrpcTypes.Input_InputKind.SHARED: {
      const objectId = rawAddress(input.objectId, `${path}.objectId`);
      const version = rawU64(input.version, `${path}.version`);
      if (typeof input.mutable !== 'boolean') {
        throw new SuiTransactionShapeError(`${path}.mutable`, 'expected a boolean');
      }
      if (input.mutability !== undefined) {
        if (
          input.mutability !== GrpcTypes.Input_Mutability.IMMUTABLE &&
          input.mutability !== GrpcTypes.Input_Mutability.MUTABLE
        ) {
          throw new SuiTransactionShapeError(
            `${path}.mutability`,
            'current SDK cannot represent this shared-object mutability',
          );
        }
        if ((input.mutability === GrpcTypes.Input_Mutability.MUTABLE) !== input.mutable) {
          throw new SuiTransactionShapeError(
            `${path}.mutability`,
            'disagrees with the current SDK mutable field',
          );
        }
      }
      rejectPresent(input, ['pure', 'digest', 'fundsWithdrawal'], path);
      return { kind, objectId, version, mutable: input.mutable };
    }
    case GrpcTypes.Input_InputKind.FUNDS_WITHDRAWAL: {
      const withdrawal = rawRecord(input.fundsWithdrawal, `${path}.fundsWithdrawal`);
      assertExactSuiShapeKeys(withdrawal, `${path}.fundsWithdrawal`, RAW_FUNDS_WITHDRAWAL_KEYS);
      const amount = rawU64(withdrawal.amount, `${path}.fundsWithdrawal.amount`);
      const coinType = canonicalStructType(
        rawString(withdrawal.coinType, `${path}.fundsWithdrawal.coinType`),
      );
      if (
        withdrawal.source !== GrpcTypes.FundsWithdrawal_Source.SENDER &&
        withdrawal.source !== GrpcTypes.FundsWithdrawal_Source.SPONSOR
      ) {
        throw new SuiTransactionShapeError(
          `${path}.fundsWithdrawal.source`,
          'unsupported current withdrawal source',
        );
      }
      rejectPresent(
        input,
        ['pure', 'objectId', 'version', 'digest', 'mutable', 'mutability'],
        path,
      );
      return { kind, amount, coinType, source: withdrawal.source };
    }
    default:
      return rejectUnhandledSuiVariant(kind, `${path}.kind`);
  }
}

function validateRawUnresolvedObjectInput(value: unknown, path: string): void {
  const input = rawRecord(value, path);
  assertExactSuiShapeKeys(input, path, RAW_INPUT_KEYS);
  if (input.kind !== undefined) {
    throw new SuiTransactionShapeError(`${path}.kind`, 'expected an unresolved object input');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'literal')) {
    throw new SuiTransactionShapeError(`${path}.literal`, 'unsupported unresolved literal input');
  }
  rawAddress(input.objectId, `${path}.objectId`);
  if (input.version !== undefined) rawU64(input.version, `${path}.version`);
  if (input.digest !== undefined) rawDigest(input.digest, `${path}.digest`);
  if (input.mutable !== undefined && typeof input.mutable !== 'boolean') {
    throw new SuiTransactionShapeError(`${path}.mutable`, 'expected a boolean');
  }
  rejectPresent(input, ['pure', 'mutability', 'fundsWithdrawal'], path);
}

function projectRawResolverExpiration(value: unknown, path: string): unknown {
  const expiration = rawRecord(value, path);
  assertExactSuiShapeKeys(expiration, path, [
    'kind',
    'epoch',
    'minEpoch',
    'minTimestamp',
    'maxTimestamp',
    'chain',
    'nonce',
  ]);
  switch (expiration.kind) {
    case GrpcTypes.TransactionExpiration_TransactionExpirationKind.NONE:
      rejectPresent(
        expiration,
        ['epoch', 'minEpoch', 'minTimestamp', 'maxTimestamp', 'chain', 'nonce'],
        path,
      );
      return { kind: expiration.kind };
    case GrpcTypes.TransactionExpiration_TransactionExpirationKind.EPOCH: {
      const epoch = rawU64(expiration.epoch, `${path}.epoch`);
      rejectPresent(
        expiration,
        ['minEpoch', 'minTimestamp', 'maxTimestamp', 'chain', 'nonce'],
        path,
      );
      return { kind: expiration.kind, epoch };
    }
    case GrpcTypes.TransactionExpiration_TransactionExpirationKind.VALID_DURING: {
      const minEpoch =
        expiration.minEpoch === undefined
          ? undefined
          : rawU64(expiration.minEpoch, `${path}.minEpoch`);
      const maxEpoch =
        expiration.epoch === undefined ? undefined : rawU64(expiration.epoch, `${path}.epoch`);
      if (expiration.minEpoch === undefined && expiration.epoch === undefined) {
        throw new SuiTransactionShapeError(path, 'current ValidDuring is missing epoch bounds');
      }
      rejectPresent(expiration, ['minTimestamp', 'maxTimestamp'], path);
      return {
        kind: expiration.kind,
        ...(minEpoch === undefined ? {} : { minEpoch }),
        ...(maxEpoch === undefined ? {} : { maxEpoch }),
        chain: rawDigest(expiration.chain, `${path}.chain`),
        nonce: rawU32(expiration.nonce, `${path}.nonce`),
      };
    }
    default:
      throw new SuiTransactionShapeError(`${path}.kind`, 'unsupported current expiration kind');
  }
}

function projectRawResolverGasPayment(
  value: unknown,
  path: string,
  onlyTransactionKind: boolean,
): {
  readonly objects: readonly unknown[];
  readonly owner?: string;
  readonly price?: bigint;
  readonly budget?: bigint;
} {
  const gas = rawRecord(value, path);
  assertExactSuiShapeKeys(gas, path, RAW_GAS_PAYMENT_KEYS);
  const objects = rawArray(gas.objects, `${path}.objects`);
  const objectIds = new Set<string>();
  const projectedObjects = objects.map((value, index) => {
    const object = rawRecord(value, `${path}.objects[${index}]`);
    assertExactSuiShapeKeys(object, `${path}.objects[${index}]`, ['objectId', 'version', 'digest']);
    const objectId = rawAddress(object.objectId, `${path}.objects[${index}].objectId`);
    if (objectIds.has(objectId)) {
      throw new SuiTransactionShapeError(
        `${path}.objects[${index}].objectId`,
        'duplicates an existing gas payment object',
      );
    }
    objectIds.add(objectId);
    return {
      objectId,
      version: rawU64(object.version, `${path}.objects[${index}].version`),
      digest: rawDigest(object.digest, `${path}.objects[${index}].digest`),
    };
  });
  const owner = gas.owner === undefined ? undefined : rawAddress(gas.owner, `${path}.owner`);
  const price =
    gas.price === undefined ? undefined : rawU64(gas.price, `${path}.price`, onlyTransactionKind);
  const budget =
    gas.budget === undefined
      ? undefined
      : rawU64(gas.budget, `${path}.budget`, onlyTransactionKind);
  if (
    !onlyTransactionKind &&
    (gas.owner === undefined || gas.price === undefined || gas.budget === undefined)
  ) {
    throw new SuiTransactionShapeError(path, 'full transaction resolution is missing gas data');
  }
  return {
    objects: projectedObjects,
    ...(owner === undefined ? {} : { owner }),
    ...(price === undefined ? {} : { price }),
    ...(budget === undefined ? {} : { budget }),
  };
}

function validateRawResolvedTransaction(value: unknown, onlyTransactionKind: boolean): void {
  const path = 'resolution.transaction.transaction';
  const transaction = rawRecord(value, path);
  assertExactSuiShapeKeys(transaction, path, RAW_TRANSACTION_KEYS);
  for (const key of ['bcs', 'digest'] as const) {
    if (transaction[key] !== undefined) {
      throw new SuiTransactionShapeError(`${path}.${key}`, 'unexpected unrequested field');
    }
  }
  if (transaction.version !== 1) {
    throw new SuiTransactionShapeError(`${path}.version`, 'expected current gRPC version 1');
  }
  if (transaction.sender !== undefined) rawAddress(transaction.sender, `${path}.sender`);
  if (!onlyTransactionKind && transaction.sender === undefined) {
    throw new SuiTransactionShapeError(`${path}.sender`, 'full resolution is missing sender');
  }
  const kind = rawRecord(transaction.kind, `${path}.kind`);
  assertExactSuiShapeKeys(kind, `${path}.kind`, RAW_TRANSACTION_KIND_KEYS);
  if (kind.kind !== GrpcTypes.TransactionKind_Kind.PROGRAMMABLE_TRANSACTION) {
    throw new SuiTransactionShapeError(`${path}.kind.kind`, 'expected a programmable transaction');
  }
  const data = rawOneof(kind.data, `${path}.kind.data`, ['programmableTransaction']);
  const programmable = rawRecord(data.payload, `${path}.kind.data.programmableTransaction`);
  assertExactSuiShapeKeys(
    programmable,
    `${path}.kind.data.programmableTransaction`,
    RAW_PROGRAMMABLE_TRANSACTION_KEYS,
  );
  rawArray(programmable.inputs, `${path}.kind.data.programmableTransaction.inputs`).forEach(
    (input, index) =>
      projectRawResolvedInput(input, `${path}.kind.data.programmableTransaction.inputs[${index}]`),
  );
  rawArray(programmable.commands, `${path}.kind.data.programmableTransaction.commands`).forEach(
    (command, index) =>
      projectRawResolverCommand(
        command,
        `${path}.kind.data.programmableTransaction.commands[${index}]`,
      ),
  );
  if (transaction.gasPayment !== undefined) {
    projectRawResolverGasPayment(transaction.gasPayment, `${path}.gasPayment`, onlyTransactionKind);
  } else if (!onlyTransactionKind) {
    throw new SuiTransactionShapeError(`${path}.gasPayment`, 'full resolution is missing gas data');
  }
  if (transaction.expiration !== undefined) {
    projectRawResolverExpiration(transaction.expiration, `${path}.expiration`);
  }
}

/** @internal Exact request/response identity authority used before and after resolver RPC. */
export function assertRawSuiResolutionIdentity(
  requestValue: unknown,
  resolvedValue: unknown,
): void {
  const request = rawRecord(requestValue, 'resolution.request.transaction');
  const resolved = rawRecord(resolvedValue, 'resolution.transaction.transaction');
  assertExactSuiShapeKeys(request, 'resolution.request.transaction', RAW_TRANSACTION_KEYS);
  if (
    request.sender !== undefined &&
    rawAddress(request.sender, 'resolution.request.transaction.sender') !==
      rawAddress(resolved.sender, 'resolution.transaction.transaction.sender')
  ) {
    throw new SuiTransactionShapeError(
      'resolution.transaction.transaction.sender',
      'changed the requested sender',
    );
  }

  const requestKind = rawRecord(request.kind, 'resolution.request.transaction.kind');
  const resolvedKind = rawRecord(resolved.kind, 'resolution.transaction.transaction.kind');
  assertExactSuiShapeKeys(
    requestKind,
    'resolution.request.transaction.kind',
    RAW_TRANSACTION_KIND_KEYS,
  );
  const requestData = rawOneof(requestKind.data, 'resolution.request.transaction.kind.data', [
    'programmableTransaction',
  ]);
  const resolvedData = rawOneof(resolvedKind.data, 'resolution.transaction.transaction.kind.data', [
    'programmableTransaction',
  ]);
  const requestedProgrammable = rawRecord(
    requestData.payload,
    'resolution.request.transaction.kind.data.programmableTransaction',
  );
  const resolvedProgrammable = rawRecord(
    resolvedData.payload,
    'resolution.transaction.transaction.kind.data.programmableTransaction',
  );
  assertExactSuiShapeKeys(
    requestedProgrammable,
    'resolution.request.transaction.kind.data.programmableTransaction',
    RAW_PROGRAMMABLE_TRANSACTION_KEYS,
  );
  const requestedCommands = rawArray(
    requestedProgrammable.commands,
    'resolution.request.transaction.kind.data.programmableTransaction.commands',
  );
  const requestedCommandIdentity = requestedCommands.map((command, index) =>
    projectRawResolverCommand(
      command,
      `resolution.request.transaction.kind.data.programmableTransaction.commands[${index}]`,
    ),
  );
  const resolvedCommands = rawArray(
    resolvedProgrammable.commands,
    'resolution.transaction.transaction.kind.data.programmableTransaction.commands',
  );
  const resolvedCommandIdentity = resolvedCommands.map((command, index) =>
    projectRawResolverCommand(
      command,
      `resolution.transaction.transaction.kind.data.programmableTransaction.commands[${index}]`,
    ),
  );
  if (!sameValue(requestedCommandIdentity, resolvedCommandIdentity)) {
    throw new SuiTransactionShapeError(
      'resolution.transaction.transaction.kind.data.programmableTransaction.commands',
      'changed the requested PTB commands',
    );
  }

  const requestedInputs = rawArray(
    requestedProgrammable.inputs,
    'resolution.request.transaction.kind.data.programmableTransaction.inputs',
  );
  const resolvedInputs = rawArray(
    resolvedProgrammable.inputs,
    'resolution.transaction.transaction.kind.data.programmableTransaction.inputs',
  );
  if (requestedInputs.length !== resolvedInputs.length) {
    throw new SuiTransactionShapeError(
      'resolution.transaction.transaction.kind.data.programmableTransaction.inputs',
      'changed the requested input count',
    );
  }
  requestedInputs.forEach((requestedInput, index) => {
    const requestRecord = rawRecord(
      requestedInput,
      `resolution.request.transaction.kind.data.programmableTransaction.inputs[${index}]`,
    );
    assertExactSuiShapeKeys(
      requestRecord,
      `resolution.request.transaction.kind.data.programmableTransaction.inputs[${index}]`,
      RAW_INPUT_KEYS,
    );
    if (requestRecord.kind === undefined) {
      validateRawUnresolvedObjectInput(
        requestedInput,
        `resolution.request.transaction.kind.data.programmableTransaction.inputs[${index}]`,
      );
      return;
    }
    if (
      !sameValue(
        projectRawResolvedInput(requestedInput, `resolution.request.inputs[${index}]`),
        projectRawResolvedInput(resolvedInputs[index], `resolution.transaction.inputs[${index}]`),
      )
    ) {
      throw new SuiTransactionShapeError(
        `resolution.transaction.transaction.kind.data.programmableTransaction.inputs[${index}]`,
        'changed an already-resolved input',
      );
    }
  });

  if (request.expiration !== undefined) {
    if (
      !sameValue(
        projectRawResolverExpiration(
          request.expiration,
          'resolution.request.transaction.expiration',
        ),
        projectRawResolverExpiration(
          resolved.expiration,
          'resolution.transaction.transaction.expiration',
        ),
      )
    ) {
      throw new SuiTransactionShapeError(
        'resolution.transaction.transaction.expiration',
        'changed the requested expiration',
      );
    }
  }
  if (request.gasPayment !== undefined) {
    const requestedGas = projectRawResolverGasPayment(
      request.gasPayment,
      'resolution.request.transaction.gasPayment',
      true,
    );
    const resolvedGas = projectRawResolverGasPayment(
      resolved.gasPayment,
      'resolution.transaction.transaction.gasPayment',
      true,
    );
    for (const key of ['owner', 'price', 'budget'] as const) {
      if (requestedGas[key] !== undefined && !sameValue(requestedGas[key], resolvedGas[key])) {
        throw new SuiTransactionShapeError(
          `resolution.transaction.transaction.gasPayment.${key}`,
          `changed the requested gas ${key}`,
        );
      }
    }
    if (requestedGas.objects.length > 0 && !sameValue(requestedGas.objects, resolvedGas.objects)) {
      throw new SuiTransactionShapeError(
        'resolution.transaction.transaction.gasPayment.objects',
        'changed the requested gas payment',
      );
    }
  }
}

interface RawResolutionEvidence {
  readonly transaction: GrpcTypes.Transaction;
  readonly status: SuiExecutionStatus;
  readonly transactionDigest?: string;
}

function validateRawResolutionResponse(
  value: unknown,
  onlyTransactionKind: boolean,
  requestedTransaction: unknown,
): RawResolutionEvidence {
  const response = rawRecord(value, 'resolution');
  const envelope = parseRawSuiExecutedTransactionEnvelope(
    response.transaction,
    'resolution.transaction',
  );
  const executed = envelope.transaction;
  validateRawResolvedTransaction(executed.transaction, onlyTransactionKind);
  assertRawSuiResolutionIdentity(requestedTransaction, executed.transaction);
  const effects = rawRecord(executed.effects, 'resolution.transaction.effects');
  const status = parseRawSuiResolutionStatus(effects.status);
  let transactionDigest: string | undefined;
  if (!onlyTransactionKind) {
    transactionDigest = rawDigest(
      effects.transactionDigest,
      'resolution.transaction.effects.transactionDigest',
    );
  }
  return {
    transaction: executed.transaction as GrpcTypes.Transaction,
    status,
    ...(transactionDigest === undefined ? {} : { transactionDigest }),
  };
}

function comparableCommand(value: Command): unknown {
  const command = parseSuiCommand(value);
  const comparableArgument = (value: unknown) => {
    const argument = parseSuiArgument(value);
    return argument.$kind === 'Input' ? { $kind: 'Input', Input: argument.Input } : argument;
  };
  switch (command.$kind) {
    case 'MoveCall':
      return {
        $kind: command.$kind,
        MoveCall: {
          package: requireAddress(command.MoveCall.package),
          module: command.MoveCall.module,
          function: command.MoveCall.function,
          typeArguments: command.MoveCall.typeArguments.map((type, index) =>
            canonicalTypeTag(type, `resolved.commands.MoveCall.typeArguments[${index}]`),
          ),
          arguments: command.MoveCall.arguments.map(comparableArgument),
        },
      };
    case 'Publish':
      return {
        $kind: command.$kind,
        Publish: {
          modules: command.Publish.modules,
          dependencies: command.Publish.dependencies.map(requireAddress),
        },
      };
    case 'Upgrade':
      return {
        $kind: command.$kind,
        Upgrade: {
          modules: command.Upgrade.modules,
          dependencies: command.Upgrade.dependencies.map(requireAddress),
          package: requireAddress(command.Upgrade.package),
          ticket: comparableArgument(command.Upgrade.ticket),
        },
      };
    case 'MakeMoveVec':
      return {
        $kind: command.$kind,
        MakeMoveVec: {
          type:
            command.MakeMoveVec.type === null
              ? null
              : canonicalTypeTag(command.MakeMoveVec.type, 'resolved.commands.MakeMoveVec.type'),
          elements: command.MakeMoveVec.elements.map(comparableArgument),
        },
      };
    case 'TransferObjects':
      return {
        $kind: command.$kind,
        TransferObjects: {
          objects: command.TransferObjects.objects.map(comparableArgument),
          address: comparableArgument(command.TransferObjects.address),
        },
      };
    case 'SplitCoins':
      return {
        $kind: command.$kind,
        SplitCoins: {
          coin: comparableArgument(command.SplitCoins.coin),
          amounts: command.SplitCoins.amounts.map(comparableArgument),
        },
      };
    case 'MergeCoins':
      return {
        $kind: command.$kind,
        MergeCoins: {
          destination: comparableArgument(command.MergeCoins.destination),
          sources: command.MergeCoins.sources.map(comparableArgument),
        },
      };
    case '$Intent':
      return command;
    default:
      return rejectUnhandledSuiVariant(command, 'resolved.commands');
  }
}

function resolvedObjectId(input: CallArg): string | null {
  const parsed = parseSuiCallArg(input);
  if (parsed.$kind === 'UnresolvedObject') {
    return requireAddress(parsed.UnresolvedObject.objectId);
  }
  if (parsed.$kind !== 'Object') return null;
  switch (parsed.Object.$kind) {
    case 'ImmOrOwnedObject':
      return requireAddress(parsed.Object.ImmOrOwnedObject.objectId);
    case 'Receiving':
      return requireAddress(parsed.Object.Receiving.objectId);
    case 'SharedObject':
      return requireAddress(parsed.Object.SharedObject.objectId);
    default:
      return rejectUnhandledSuiVariant(parsed.Object, 'resolved.inputs.Object');
  }
}

function validateResolvedInput(before: CallArg, after: CallArg, index: number): void {
  const requested = parseSuiCallArg(before, `requested.inputs[${index}]`);
  const resolved = parseSuiCallArg(after, `resolved.inputs[${index}]`);
  if (resolved.$kind === 'UnresolvedObject' || resolved.$kind === 'UnresolvedPure') {
    throw new SuiTransactionShapeError(`resolved.inputs[${index}]`, 'input remained unresolved');
  }
  if (requested.$kind === 'UnresolvedObject') {
    if (resolved.$kind !== 'Object' || resolvedObjectId(requested) !== resolvedObjectId(resolved)) {
      throw new SuiTransactionShapeError(
        `resolved.inputs[${index}]`,
        'resolved a different object identity',
      );
    }
    const request = requested.UnresolvedObject;
    if (request.initialSharedVersion != null || request.mutable != null) {
      if (
        resolved.Object.$kind !== 'SharedObject' ||
        (request.initialSharedVersion != null &&
          requireU64(resolved.Object.SharedObject.initialSharedVersion, true) !==
            requireU64(request.initialSharedVersion, true)) ||
        (request.mutable != null && resolved.Object.SharedObject.mutable !== request.mutable)
      ) {
        throw new SuiTransactionShapeError(
          `resolved.inputs[${index}]`,
          'changed the requested shared-object identity',
        );
      }
    }
    if (request.version != null || request.digest != null) {
      const object =
        resolved.Object.$kind === 'ImmOrOwnedObject'
          ? resolved.Object.ImmOrOwnedObject
          : resolved.Object.$kind === 'Receiving'
            ? resolved.Object.Receiving
            : null;
      if (
        object === null ||
        (request.version != null &&
          requireU64(object.version, true) !== requireU64(request.version, true)) ||
        (request.digest != null && object.digest !== request.digest)
      ) {
        throw new SuiTransactionShapeError(
          `resolved.inputs[${index}]`,
          'changed the requested owned-object identity',
        );
      }
    }
    return;
  }
  if (requested.$kind === 'UnresolvedPure') {
    if (resolved.$kind !== 'Pure') {
      throw new SuiTransactionShapeError(
        `resolved.inputs[${index}]`,
        'did not resolve a pure input',
      );
    }
    return;
  }
  if (!sameValue(requested, resolved)) {
    throw new SuiTransactionShapeError(
      `resolved.inputs[${index}]`,
      'changed an already-resolved input',
    );
  }
}

function sameOptionalAddress(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return (
    left === right ||
    (left != null && right != null && requireAddress(left) === requireAddress(right))
  );
}

function validateGasData(
  before: TransactionData['gasData'],
  after: TransactionData['gasData'],
  onlyTransactionKind: boolean,
): void {
  // The installed current SDK deliberately clears every gas field after a
  // kind-only conversion. Raw request/response identity was already checked
  // above; there is no gas field left in the applied candidate to compare.
  if (onlyTransactionKind) return;
  if (before.owner !== null && !sameOptionalAddress(before.owner, after.owner)) {
    throw new SuiTransactionShapeError('resolved.gasData.owner', 'changed the preset gas owner');
  }
  for (const key of ['budget', 'price'] as const) {
    if (
      before[key] !== null &&
      (after[key] === null || requireU64(before[key], false) !== requireU64(after[key], false))
    ) {
      throw new SuiTransactionShapeError(
        `resolved.gasData.${key}`,
        `changed the preset gas ${key}`,
      );
    }
  }
  if (before.payment !== null && !sameValue(before.payment, after.payment)) {
    throw new SuiTransactionShapeError(
      'resolved.gasData.payment',
      'changed the preset gas payment',
    );
  }
  if (after.owner === null) {
    throw new SuiTransactionShapeError('resolved.gasData.owner', 'missing gas owner');
  }
  requireAddress(after.owner);
  requireU64(after.budget, false);
  requireU64(after.price, false);
  if (!Array.isArray(after.payment)) {
    throw new SuiTransactionShapeError('resolved.gasData.payment', 'missing gas payment');
  }
  const payments = rawArray(after.payment, 'resolved.gasData.payment') as NonNullable<
    TransactionData['gasData']['payment']
  >;
  const paymentObjectIds = new Set<string>();
  for (const [index, payment] of payments.entries()) {
    const objectId = requireAddress(payment.objectId);
    if (paymentObjectIds.has(objectId)) {
      throw new SuiTransactionShapeError(
        `resolved.gasData.payment[${index}].objectId`,
        'duplicates an existing gas payment object',
      );
    }
    paymentObjectIds.add(objectId);
    requireU64(payment.version, true);
    if (!isValidTransactionDigest(payment.digest)) {
      throw new SuiTransactionShapeError(
        `resolved.gasData.payment[${index}].digest`,
        'expected a Sui digest',
      );
    }
  }
}

function validateResolvedTransaction(
  before: TransactionData,
  after: TransactionData,
  onlyTransactionKind: boolean,
): void {
  if (after.version !== 2 || before.version !== 2) {
    throw new SuiTransactionShapeError(
      'resolved.version',
      'expected current transaction version 2',
    );
  }
  if (before.sender != null && !sameOptionalAddress(before.sender, after.sender)) {
    throw new SuiTransactionShapeError('resolved.sender', 'changed the transaction sender');
  }
  if (!onlyTransactionKind && after.sender == null) {
    throw new SuiTransactionShapeError('resolved.sender', 'missing transaction sender');
  }
  if (after.sender != null) requireAddress(after.sender);
  if (before.expiration != null && !sameValue(before.expiration, after.expiration)) {
    throw new SuiTransactionShapeError('resolved.expiration', 'changed the preset expiration');
  }
  const beforeInputs = rawArray(before.inputs, 'requested.inputs') as TransactionData['inputs'];
  const afterInputs = rawArray(after.inputs, 'resolved.inputs') as TransactionData['inputs'];
  if (beforeInputs.length !== afterInputs.length) {
    throw new SuiTransactionShapeError('resolved.inputs', 'changed the input count');
  }
  beforeInputs.forEach((input, index) => validateResolvedInput(input, afterInputs[index]!, index));
  const beforeCommands = rawArray(
    before.commands,
    'requested.commands',
  ) as TransactionData['commands'];
  const afterCommands = rawArray(
    after.commands,
    'resolved.commands',
  ) as TransactionData['commands'];
  if (
    beforeCommands.length !== afterCommands.length ||
    !beforeCommands.every((command, index) =>
      sameValue(comparableCommand(command), comparableCommand(afterCommands[index]!)),
    )
  ) {
    throw new SuiTransactionShapeError('resolved.commands', 'changed the PTB commands');
  }
  validateGasData(before.gasData, after.gasData, onlyTransactionKind);
}

export interface EndpointResolution {
  readonly data: TransactionData;
  readonly transaction: GrpcTypes.Transaction;
  /** Exact validated BCS for full resolution; null for transaction-kind resolution. */
  readonly transactionBytes: Uint8Array | null;
}

export interface EndpointResolutionContext {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

function rejectResidualUnresolvedPure(data: TransactionData): void {
  const inputs = rawArray(data.inputs, 'requested.inputs') as TransactionData['inputs'];
  const index = inputs.findIndex((input) => input.$kind === 'UnresolvedPure');
  if (index !== -1) {
    throw new TypeError(
      `Sui gRPC transaction resolution does not support residual UnresolvedPure input ${index}`,
    );
  }
}

/** @internal Resolve one transaction without selecting or retrying another endpoint. */
export async function resolveSuiTransactionOnEndpoint(
  endpoint: SuiGrpcClient,
  transactionData: TransactionDataBuilder,
  options: BuildTransactionOptions,
  context: EndpointResolutionContext,
): Promise<EndpointResolution> {
  const requested = transactionData.snapshot();
  rejectResidualUnresolvedPure(requested);
  const candidate = TransactionDataBuilder.restore(requested);
  let nextCalls = 0;
  let evidence: RawResolutionEvidence | undefined;
  try {
    const resolverClient = Object.create(endpoint) as SuiGrpcClient;
    Object.defineProperty(resolverClient, 'transactionExecutionService', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: {
        simulateTransaction: async (request: unknown) => {
          const rawRequest = rawRecord(request, 'resolution.request');
          assertExactSuiShapeKeys(rawRequest, 'resolution.request', [
            'transaction',
            'readMask',
            'checks',
            'doGasSelection',
          ]);
          try {
            const requestTransaction = rawRecord(
              rawRequest.transaction,
              'resolution.request.transaction',
            );
            assertExactSuiShapeKeys(
              requestTransaction,
              'resolution.request.transaction',
              RAW_TRANSACTION_KEYS,
            );
            if (requestTransaction.version !== 1) {
              throw new SuiTransactionShapeError(
                'resolution.request.transaction.version',
                'expected current gRPC version 1',
              );
            }
            if (requestTransaction.bcs !== undefined || requestTransaction.digest !== undefined) {
              throw new SuiTransactionShapeError(
                'resolution.request.transaction',
                'contains an unsupported pre-serialized identity',
              );
            }
            assertRawSuiResolutionIdentity(requestTransaction, requestTransaction);
          } catch (error) {
            if (error instanceof SuiTransactionShapeError) {
              throw new TypeError('Installed Sui SDK produced an invalid resolution request', {
                cause: error,
              });
            }
            throw error;
          }
          const readMask = rawRecord(rawRequest.readMask, 'resolution.request.readMask');
          assertExactSuiShapeKeys(readMask, 'resolution.request.readMask', ['paths']);
          const paths = rawArray(readMask.paths, 'resolution.request.readMask.paths').map(
            (path, index) => rawString(path, `resolution.request.readMask.paths[${index}]`),
          );
          const requiredPaths = ['transaction.transaction.version'];
          if (options.onlyTransactionKind !== true) {
            requiredPaths.push('transaction.effects.transaction_digest');
          }
          const exactPaths = [...paths];
          for (const path of requiredPaths) {
            if (!exactPaths.includes(path)) exactPaths.push(path);
          }
          if (options.onlyTransactionKind === true && rawRequest.doGasSelection !== false) {
            throw new SuiTransactionShapeError(
              'resolution.request.doGasSelection',
              'gasless kind resolution must not select gas',
            );
          }
          const result = await endpoint.transactionExecutionService.simulateTransaction(
            {
              ...rawRequest,
              readMask: { ...readMask, paths: exactPaths },
              ...(options.onlyTransactionKind === true
                ? {
                    doGasSelection: false,
                    checks: GrpcTypes.SimulateTransactionRequest_TransactionChecks.DISABLED,
                  }
                : {}),
            } as never,
            { timeout: context.timeoutMs, abort: context.signal },
          );
          try {
            evidence = validateRawResolutionResponse(
              result.response,
              options.onlyTransactionKind === true,
              rawRequest.transaction,
            );
          } catch (error) {
            if (error instanceof SuiTransactionShapeError) {
              throw malformedSuiResponse('resolve_transaction');
            }
            throw error;
          }
          if (options.onlyTransactionKind === true || evidence.status.success) return result;
          const projectedResponse = structuredClone(result.response);
          projectedResponse.transaction!.effects!.status = { success: true };
          return { ...result, response: projectedResponse };
        },
      },
    });
    const resolverCore = new GrpcCoreClient({
      client: resolverClient,
      base: endpoint,
      network: endpoint.network,
    });
    await resolverCore.resolveTransactionPlugin()(
      candidate,
      { ...options, client: endpoint },
      async () => {
        nextCalls += 1;
      },
    );
  } catch (error) {
    if (error instanceof SimulationError) {
      if (
        error.cause instanceof RpcError ||
        error.cause instanceof TypeError ||
        error.cause instanceof SuiOperationError
      ) {
        throw error.cause;
      }
    }
    if (
      error instanceof RpcError ||
      error instanceof TypeError ||
      error instanceof SuiOperationError
    ) {
      throw error;
    }
    throw malformedSuiResponse('resolve_transaction');
  }
  if (nextCalls !== 1 || evidence === undefined) {
    throw malformedSuiResponse('resolve_transaction');
  }
  const resolved = candidate.snapshot();
  let transactionBytes: Uint8Array | null = null;
  try {
    validateResolvedTransaction(requested, resolved, options.onlyTransactionKind === true);
    if (options.onlyTransactionKind !== true) {
      transactionBytes = TransactionDataBuilder.restore(resolved).build();
      const resolvedDigest = TransactionDataBuilder.getDigestFromBytes(transactionBytes);
      if (resolvedDigest !== evidence.transactionDigest) {
        throw new SuiTransactionShapeError(
          'resolution.transaction.effects.transactionDigest',
          'does not match the resolved transaction',
        );
      }
    }
  } catch (error) {
    if (error instanceof SuiTransactionShapeError) {
      throw malformedSuiResponse('resolve_transaction');
    }
    throw error;
  }
  if (options.onlyTransactionKind !== true && !evidence.status.success) {
    throw rejectedSuiOperation('resolve_transaction', evidence.status.error);
  }
  return { data: resolved, transaction: evidence.transaction, transactionBytes };
}

async function runEndpointResolver(
  snapshot: SuiEndpointSnapshot,
  transactionData: TransactionDataBuilder,
  options: BuildTransactionOptions,
  signal: AbortSignal | undefined,
): Promise<TransactionData> {
  return runSuiReadOperation(snapshot, 'resolve_transaction', signal, async (endpoint, context) => {
    const resolved = await resolveSuiTransactionOnEndpoint(
      endpoint,
      transactionData,
      options,
      context,
    );
    return resolved.data;
  });
}

export interface ResolvedSuiMoveViewTransaction {
  readonly transaction: GrpcTypes.Transaction;
  readonly data: TransactionData;
}

/** @internal Resolve one gasless Move view against the endpoint that will simulate it. */
export async function resolveSuiMoveViewTransactionOnEndpoint(
  endpoint: SuiGrpcClient,
  source: Transaction,
  context: EndpointResolutionContext,
): Promise<ResolvedSuiMoveViewTransaction> {
  if (!(source instanceof Transaction)) throw new TypeError('Sui Move view requires a Transaction');
  const initial = source.getData();
  if (
    initial.sender !== null ||
    initial.expiration !== null ||
    initial.gasData.owner !== null ||
    initial.gasData.price !== null ||
    initial.gasData.budget !== null ||
    initial.gasData.payment !== null
  ) {
    throw new TypeError('Sui Move view sender, gas, and expiration are owned by the view gateway');
  }

  const transaction = Transaction.from(source);
  transaction.setSender(SUI_ZERO_ADDRESS);
  transaction.setExpiration(null);

  const endpointResolution = await resolveSuiTransactionOnEndpoint(
    endpoint,
    TransactionDataBuilder.restore(transaction.getData()),
    { onlyTransactionKind: true },
    context,
  );

  const raw = endpointResolution.transaction;
  const gas = projectRawResolverGasPayment(raw.gasPayment, 'moveView.resolution.gasPayment', true);
  if (raw.expiration !== undefined) {
    const expiration = rawRecord(raw.expiration, 'moveView.resolution.expiration');
    if (expiration.kind !== GrpcTypes.TransactionExpiration_TransactionExpirationKind.NONE) {
      throw malformedSuiResponse('simulate_move_view');
    }
  }
  if (
    rawAddress(raw.sender, 'moveView.resolution.sender') !== SUI_ZERO_ADDRESS ||
    gas.objects.length !== 0 ||
    gas.owner !== SUI_ZERO_ADDRESS
  ) {
    throw malformedSuiResponse('simulate_move_view');
  }

  // The current gRPC resolver may populate price, budget, and an explicit
  // `None` expiration even for kind-only resolution. The installed SDK's
  // `applyGrpcResolvedTransaction(..., { onlyTransactionKind: true })`
  // deliberately discards those non-kind fields. Keep the exact validated
  // command/input evidence, then construct the actual Move-view request
  // without forwarding resolver-authored gas or expiration values.
  return {
    transaction: GrpcTypes.Transaction.create({
      version: raw.version,
      kind: raw.kind,
      sender: SUI_ZERO_ADDRESS,
    }),
    data: {
      ...endpointResolution.data,
      sender: SUI_ZERO_ADDRESS,
      expiration: null,
      gasData: {
        owner: null,
        price: null,
        budget: null,
        payment: null,
      },
    },
  };
}

/** @internal Bind returned TransactionData BCS to the resolved gasless view. */
export function bindSuiMoveViewTransactionBytes(
  value: Uint8Array,
  expected: TransactionData,
): string {
  if (!(value instanceof Uint8Array) || value.length === 0) {
    throw new SuiTransactionShapeError('moveView.transaction.bcs', 'expected non-empty bytes');
  }
  let decoded: TransactionDataBuilder;
  let canonical: Uint8Array;
  try {
    decoded = TransactionDataBuilder.fromBytes(value);
    canonical = decoded.build();
  } catch {
    throw new SuiTransactionShapeError(
      'moveView.transaction.bcs',
      'expected current TransactionData BCS',
    );
  }
  const decodedData = decoded.snapshot();
  try {
    validateResolvedTransaction(expected, decodedData, false);
  } catch {
    throw new SuiTransactionShapeError(
      'moveView.transaction.bcs',
      'does not match the endpoint-resolved transaction kind',
    );
  }
  if (
    !sameBytes(value, canonical) ||
    decodedData.sender !== SUI_ZERO_ADDRESS ||
    decodedData.gasData.owner !== SUI_ZERO_ADDRESS ||
    decodedData.gasData.payment?.length !== 0 ||
    decodedData.expiration?.$kind !== 'None'
  ) {
    throw new SuiTransactionShapeError(
      'moveView.transaction.bcs',
      'does not contain the exact gasless view envelope',
    );
  }
  return TransactionDataBuilder.getDigestFromBytes(value);
}

function exactBuildClient(
  snapshot: SuiEndpointSnapshot,
  signal: AbortSignal | undefined,
): ClientWithCoreApi {
  const resolveTransactionPlugin = (): TransactionPlugin => {
    return async (transactionData, options, next) => {
      const resolved = await runEndpointResolver(snapshot, transactionData, options, signal);
      transactionData.applyResolvedData(resolved);
      await next();
    };
  };

  const core = { resolveTransactionPlugin };
  return { core } as unknown as ClientWithCoreApi;
}

/**
 * Build through the sole current transaction-resolution authority.
 *
 * The installed SDK owns its version-exact gRPC conversion and resolution
 * mechanics. This boundary injects the attempt timeout/abort into the actual
 * raw request, validates the raw resolved transaction before SDK conversion,
 * and owns endpoint order and response identity.
 */
export function buildSuiTransaction(
  snapshot: SuiEndpointSnapshot,
  options: SuiTransactionBuildOptions,
): Promise<Uint8Array> {
  if (!(options.transaction instanceof Transaction)) {
    throw new TypeError('Exact Sui build requires a Transaction');
  }
  if (
    options.onlyTransactionKind !== undefined &&
    typeof options.onlyTransactionKind !== 'boolean'
  ) {
    throw new TypeError('onlyTransactionKind must be a boolean when provided');
  }
  let transaction: Transaction;
  try {
    transaction = Transaction.from(options.transaction);
  } catch (error) {
    throw new TypeError('Exact Sui build requires a synchronously snapshotable Transaction', {
      cause: error,
    });
  }
  return transaction.build({
    client: exactBuildClient(snapshot, options.signal),
    ...(options.onlyTransactionKind === undefined
      ? {}
      : { onlyTransactionKind: options.onlyTransactionKind }),
  });
}
