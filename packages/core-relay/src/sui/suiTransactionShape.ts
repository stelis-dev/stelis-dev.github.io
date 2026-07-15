import { GrpcTypes } from '@mysten/sui/grpc';
import type { Argument, CallArg, Command } from '@mysten/sui/transactions';
import {
  fromBase64,
  isValidSuiAddress,
  isValidTransactionDigest,
  normalizeStructTag,
  normalizeSuiAddress,
  toBase64,
} from '@mysten/sui/utils';
import { canonicalizeSuiTypeTag } from './suiTypeTag.js';

type RuntimeRecord = Record<string, unknown>;

const U64_MAX = 18_446_744_073_709_551_615n;
const DECIMAL_RE = /^(?:0|[1-9]\d*)$/;
const SIGNED_DECIMAL_RE = /^(?:0|[1-9]\d*|-[1-9]\d*)$/;
const RAW_EXECUTED_TRANSACTION_KEYS = [
  'digest',
  'transaction',
  'signatures',
  'effects',
  'events',
  'checkpoint',
  'timestamp',
  'balanceChanges',
  'objects',
] as const;

export class SuiTransactionShapeError extends TypeError {
  override readonly name = 'SuiTransactionShapeError';

  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`${path}: ${reason}`);
  }
}

/** @internal Keep accepted-variant lists and their semantic handlers exhaustive. */
export function rejectUnhandledSuiVariant(_value: never, path: string): never {
  throw new SuiTransactionShapeError(path, 'unsupported current variant');
}

function record(value: unknown, path: string): RuntimeRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SuiTransactionShapeError(path, 'expected an object');
  }
  return value as RuntimeRecord;
}

function own(value: RuntimeRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value: RuntimeRecord, path: string, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new SuiTransactionShapeError(`${path}.${key}`, 'unsupported current field');
    }
  }
}

/** @internal Shared exact-key authority for raw current-SDK structures. */
export { exactKeys as assertExactSuiShapeKeys };

function exactEnumRoot(
  value: RuntimeRecord,
  kind: string,
  path: string,
  additionalKeys: readonly string[] = [],
): void {
  exactKeys(value, path, ['$kind', kind, ...additionalKeys]);
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SuiTransactionShapeError(path, 'expected a non-empty string');
  }
  return value;
}

function suiAddress(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!isValidSuiAddress(parsed)) {
    throw new SuiTransactionShapeError(path, 'expected a Sui address');
  }
  return normalizeSuiAddress(parsed);
}

function digest(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!isValidTransactionDigest(parsed)) {
    throw new SuiTransactionShapeError(path, 'expected a Sui digest');
  }
  return parsed;
}

function structTag(value: unknown, path: string): string {
  const parsed = string(value, path);
  try {
    return normalizeStructTag(parsed);
  } catch {
    throw new SuiTransactionShapeError(path, 'expected a current Move struct tag');
  }
}

function typeTag(value: unknown, path: string): string {
  const parsed = string(value, path);
  try {
    return canonicalizeSuiTypeTag(parsed);
  } catch {
    throw new SuiTransactionShapeError(path, 'expected a current Sui type tag');
  }
}

function u64(value: unknown, path: string, max = U64_MAX): string | number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) > max) {
      throw new SuiTransactionShapeError(path, 'expected a non-negative safe u64 number');
    }
    return value;
  }
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
    throw new SuiTransactionShapeError(path, 'expected a canonical unsigned u64');
  }
  if (BigInt(value) > max) {
    throw new SuiTransactionShapeError(path, 'unsigned decimal exceeds its current width');
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SuiTransactionShapeError(path, 'expected a non-negative safe integer');
  }
  return value as number;
}

function u32Integer(value: unknown, path: string): number {
  const parsed = nonNegativeInteger(value, path);
  if (parsed > 0xffff_ffff) {
    throw new SuiTransactionShapeError(path, 'integer exceeds the current u32 range');
  }
  return parsed;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SuiTransactionShapeError(path, 'expected a boolean');
  }
  return value;
}

/** @internal Reject sparse arrays before any map/forEach projection can skip an element. */
export function parseExactSuiArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new SuiTransactionShapeError(path, 'expected an array');
  }
  const keys = Object.keys(value);
  if (keys.length !== value.length) {
    throw new SuiTransactionShapeError(path, 'expected a dense array without extra properties');
  }
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] !== String(index)) {
      throw new SuiTransactionShapeError(path, 'expected a dense array without extra properties');
    }
  }
  return value;
}

function array(value: unknown, path: string): unknown[] {
  return parseExactSuiArray(value, path);
}

/** @internal Validate the installed SDK's mandatory repeated transaction fields once. */
export function parseRawSuiExecutedTransactionEnvelope(value: unknown, path: string) {
  const transaction = record(value, path);
  exactKeys(transaction, path, RAW_EXECUTED_TRANSACTION_KEYS);
  return {
    transaction,
    signatures: array(transaction.signatures, `${path}.signatures`),
    balanceChanges: array(transaction.balanceChanges, `${path}.balanceChanges`),
  } as const;
}

/** @internal Enforce that a mandatory repeated field omitted by the read mask is empty. */
export function assertEmptyRawSuiRepeatedField(values: readonly unknown[], path: string): void {
  if (values.length !== 0) {
    throw new SuiTransactionShapeError(path, 'expected an empty unrequested repeated field');
  }
}

function assertAbsentRawSuiField(value: RuntimeRecord, key: string, path: string): void {
  if (value[key] !== undefined) {
    throw new SuiTransactionShapeError(`${path}.${key}`, 'unexpected unrequested field');
  }
}

function bytes(value: unknown, path: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new SuiTransactionShapeError(path, 'expected bytes');
  }
  return value;
}

function canonicalBase64(value: unknown, path: string): string {
  const parsed = string(value, path);
  try {
    if (toBase64(fromBase64(parsed)) !== parsed) {
      throw new SuiTransactionShapeError(path, 'expected canonical base64');
    }
  } catch (error) {
    if (error instanceof SuiTransactionShapeError) throw error;
    throw new SuiTransactionShapeError(path, 'expected canonical base64');
  }
  return parsed;
}

function enumPayload<const Variants extends readonly string[]>(
  value: unknown,
  path: string,
  variants: Variants,
): { readonly root: RuntimeRecord; readonly kind: Variants[number]; readonly payload: unknown } {
  const root = record(value, path);
  const rawKind = string(root.$kind, `${path}.$kind`);
  if (!(variants as readonly string[]).includes(rawKind)) {
    throw new SuiTransactionShapeError(`${path}.$kind`, `unsupported current kind ${rawKind}`);
  }
  const kind = rawKind as Variants[number];
  for (const variant of variants) {
    if (variant === kind) {
      if (!own(root, variant)) {
        throw new SuiTransactionShapeError(path, `missing ${variant} payload`);
      }
    } else if (own(root, variant)) {
      throw new SuiTransactionShapeError(path, `contains opposing ${variant} payload`);
    }
  }
  return { root, kind, payload: root[kind] };
}

function protobufOneof<const Variants extends readonly string[]>(
  value: unknown,
  path: string,
  variants: Variants,
): {
  readonly root: RuntimeRecord;
  readonly kind: Variants[number] | undefined;
  readonly payload: unknown;
} {
  const root = record(value, path);
  const rawKind = root.oneofKind;
  if (
    rawKind !== undefined &&
    (typeof rawKind !== 'string' || !(variants as readonly string[]).includes(rawKind))
  ) {
    throw new SuiTransactionShapeError(`${path}.oneofKind`, 'unsupported current oneof kind');
  }
  const kind = rawKind as Variants[number] | undefined;
  for (const variant of variants) {
    if (variant === kind) {
      if (!own(root, variant)) {
        throw new SuiTransactionShapeError(path, `missing ${variant} payload`);
      }
    } else if (own(root, variant)) {
      throw new SuiTransactionShapeError(path, `contains opposing ${variant} payload`);
    }
  }
  exactKeys(root, path, ['oneofKind', ...(kind === undefined ? [] : [kind])]);
  return { root, kind, payload: kind === undefined ? undefined : root[kind] };
}

function validateRawProtoValue(value: unknown, path: string): void {
  const root = record(value, path);
  exactKeys(root, path, ['kind']);
  const kind = protobufOneof(root.kind, `${path}.kind`, [
    'nullValue',
    'numberValue',
    'stringValue',
    'boolValue',
    'structValue',
    'listValue',
  ]);
  if (kind.kind === undefined) {
    throw new SuiTransactionShapeError(`${path}.kind`, 'missing current Value variant');
  }
  switch (kind.kind) {
    case 'nullValue':
      if (kind.payload !== 0) {
        throw new SuiTransactionShapeError(`${path}.kind.nullValue`, 'expected NULL_VALUE');
      }
      return;
    case 'numberValue':
      if (typeof kind.payload !== 'number' || !Number.isFinite(kind.payload)) {
        throw new SuiTransactionShapeError(`${path}.kind.numberValue`, 'expected a finite number');
      }
      return;
    case 'stringValue':
      if (typeof kind.payload !== 'string') {
        throw new SuiTransactionShapeError(`${path}.kind.stringValue`, 'expected a string');
      }
      return;
    case 'boolValue':
      boolean(kind.payload, `${path}.kind.boolValue`);
      return;
    case 'structValue': {
      const struct = record(kind.payload, `${path}.kind.structValue`);
      exactKeys(struct, `${path}.kind.structValue`, ['fields']);
      const fields = record(struct.fields, `${path}.kind.structValue.fields`);
      for (const [key, entry] of Object.entries(fields)) {
        validateRawProtoValue(entry, `${path}.kind.structValue.fields.${key}`);
      }
      return;
    }
    case 'listValue': {
      const list = record(kind.payload, `${path}.kind.listValue`);
      exactKeys(list, `${path}.kind.listValue`, ['values']);
      array(list.values, `${path}.kind.listValue.values`).forEach((entry, index) =>
        validateRawProtoValue(entry, `${path}.kind.listValue.values[${index}]`),
      );
      return;
    }
    default:
      return rejectUnhandledSuiVariant(kind.kind, `${path}.kind`);
  }
}

const ARGUMENT_KINDS = ['GasCoin', 'Input', 'Result', 'NestedResult'] as const;

/** Validate one exact current SDK 2.17 PTB argument. */
export function parseSuiArgument(value: unknown, path = 'argument'): Argument {
  const parsed = enumPayload(value, path, ARGUMENT_KINDS);
  exactEnumRoot(parsed.root, parsed.kind, path, parsed.kind === 'Input' ? ['type'] : []);
  switch (parsed.kind) {
    case 'GasCoin':
      if (parsed.payload !== true) {
        throw new SuiTransactionShapeError(`${path}.GasCoin`, 'expected true');
      }
      break;
    case 'Input':
      nonNegativeInteger(parsed.payload, `${path}.Input`);
      if (own(parsed.root, 'type')) {
        const type = parsed.root.type;
        if (type !== 'pure' && type !== 'object' && type !== 'withdrawal') {
          throw new SuiTransactionShapeError(`${path}.type`, 'unsupported current input type');
        }
      }
      break;
    case 'Result':
      nonNegativeInteger(parsed.payload, `${path}.Result`);
      break;
    case 'NestedResult': {
      const coordinates = array(parsed.payload, `${path}.NestedResult`);
      if (coordinates.length !== 2) {
        throw new SuiTransactionShapeError(`${path}.NestedResult`, 'expected two coordinates');
      }
      nonNegativeInteger(coordinates[0], `${path}.NestedResult[0]`);
      nonNegativeInteger(coordinates[1], `${path}.NestedResult[1]`);
      break;
    }
    default:
      return rejectUnhandledSuiVariant(parsed.kind, path);
  }
  return value as Argument;
}

const OBJECT_KINDS = ['ImmOrOwnedObject', 'SharedObject', 'Receiving'] as const;

function parseObjectReference(value: unknown, path: string): void {
  const ref = record(value, path);
  exactKeys(ref, path, ['objectId', 'version', 'digest']);
  suiAddress(ref.objectId, `${path}.objectId`);
  u64(ref.version, `${path}.version`);
  digest(ref.digest, `${path}.digest`);
}

function parseSuiObjectArg(value: unknown, path: string): void {
  const parsed = enumPayload(value, path, OBJECT_KINDS);
  exactEnumRoot(parsed.root, parsed.kind, path);
  switch (parsed.kind) {
    case 'SharedObject': {
      const shared = record(parsed.payload, `${path}.SharedObject`);
      exactKeys(shared, `${path}.SharedObject`, ['objectId', 'initialSharedVersion', 'mutable']);
      suiAddress(shared.objectId, `${path}.SharedObject.objectId`);
      u64(shared.initialSharedVersion, `${path}.SharedObject.initialSharedVersion`);
      boolean(shared.mutable, `${path}.SharedObject.mutable`);
      return;
    }
    case 'ImmOrOwnedObject':
    case 'Receiving':
      parseObjectReference(parsed.payload, `${path}.${parsed.kind}`);
      return;
    default:
      return rejectUnhandledSuiVariant(parsed.kind, path);
  }
}

function parseFundsWithdrawal(value: unknown, path: string): void {
  const withdrawal = record(value, path);
  exactKeys(withdrawal, path, ['reservation', 'typeArg', 'withdrawFrom']);
  const reservation = enumPayload(withdrawal.reservation, `${path}.reservation`, ['MaxAmountU64']);
  exactEnumRoot(reservation.root, reservation.kind, `${path}.reservation`);
  u64(reservation.payload, `${path}.reservation.MaxAmountU64`);

  const typeArg = enumPayload(withdrawal.typeArg, `${path}.typeArg`, ['Balance']);
  exactEnumRoot(typeArg.root, typeArg.kind, `${path}.typeArg`);
  structTag(typeArg.payload, `${path}.typeArg.Balance`);

  const withdrawFrom = enumPayload(withdrawal.withdrawFrom, `${path}.withdrawFrom`, [
    'Sender',
    'Sponsor',
  ]);
  exactEnumRoot(withdrawFrom.root, withdrawFrom.kind, `${path}.withdrawFrom`);
  if (withdrawFrom.payload !== true) {
    throw new SuiTransactionShapeError(
      `${path}.withdrawFrom.${withdrawFrom.kind}`,
      'expected true',
    );
  }
}

const CALL_ARG_KINDS = [
  'Object',
  'Pure',
  'UnresolvedPure',
  'UnresolvedObject',
  'FundsWithdrawal',
] as const;

/** Validate one exact current SDK 2.17 PTB input. */
export function parseSuiCallArg(value: unknown, path = 'input'): CallArg {
  const parsed = enumPayload(value, path, CALL_ARG_KINDS);
  exactEnumRoot(parsed.root, parsed.kind, path);
  switch (parsed.kind) {
    case 'Object':
      parseSuiObjectArg(parsed.payload, `${path}.Object`);
      break;
    case 'Pure': {
      const pure = record(parsed.payload, `${path}.Pure`);
      exactKeys(pure, `${path}.Pure`, ['bytes']);
      canonicalBase64(pure.bytes, `${path}.Pure.bytes`);
      break;
    }
    case 'UnresolvedPure': {
      const unresolved = record(parsed.payload, `${path}.UnresolvedPure`);
      exactKeys(unresolved, `${path}.UnresolvedPure`, ['value']);
      if (!own(unresolved, 'value')) {
        throw new SuiTransactionShapeError(`${path}.UnresolvedPure`, 'missing value');
      }
      break;
    }
    case 'UnresolvedObject': {
      const unresolved = record(parsed.payload, `${path}.UnresolvedObject`);
      exactKeys(unresolved, `${path}.UnresolvedObject`, [
        'objectId',
        'version',
        'digest',
        'initialSharedVersion',
        'mutable',
      ]);
      suiAddress(unresolved.objectId, `${path}.UnresolvedObject.objectId`);
      if (own(unresolved, 'version') && unresolved.version !== null) {
        u64(unresolved.version, `${path}.UnresolvedObject.version`);
      }
      if (own(unresolved, 'digest') && unresolved.digest !== null) {
        digest(unresolved.digest, `${path}.UnresolvedObject.digest`);
      }
      if (own(unresolved, 'initialSharedVersion') && unresolved.initialSharedVersion !== null) {
        u64(unresolved.initialSharedVersion, `${path}.UnresolvedObject.initialSharedVersion`);
      }
      if (own(unresolved, 'mutable') && unresolved.mutable !== null) {
        boolean(unresolved.mutable, `${path}.UnresolvedObject.mutable`);
      }
      break;
    }
    case 'FundsWithdrawal':
      parseFundsWithdrawal(parsed.payload, `${path}.FundsWithdrawal`);
      break;
    default:
      return rejectUnhandledSuiVariant(parsed.kind, path);
  }
  return value as CallArg;
}

const COMMAND_KINDS = [
  'MoveCall',
  'TransferObjects',
  'SplitCoins',
  'MergeCoins',
  'Publish',
  'MakeMoveVec',
  'Upgrade',
  '$Intent',
] as const;

function parseArgumentArray(value: unknown, path: string): void {
  array(value, path).forEach((argument, index) => parseSuiArgument(argument, `${path}[${index}]`));
}

const OPEN_SIGNATURE_SCALAR_KINDS = [
  'address',
  'bool',
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'u256',
  'unknown',
] as const;

function parseOpenSignatureBody(value: unknown, path: string): void {
  const body = record(value, path);
  const kind = string(body.$kind, `${path}.$kind`);
  const knownKinds = [...OPEN_SIGNATURE_SCALAR_KINDS, 'vector', 'datatype', 'typeParameter'];
  if (!(knownKinds as readonly string[]).includes(kind)) {
    throw new SuiTransactionShapeError(`${path}.$kind`, `unsupported current kind ${kind}`);
  }

  const payloadKeys = ['vector', 'datatype', 'index'] as const;
  const expectedPayload =
    kind === 'vector'
      ? 'vector'
      : kind === 'datatype'
        ? 'datatype'
        : kind === 'typeParameter'
          ? 'index'
          : null;
  for (const key of payloadKeys) {
    if (key === expectedPayload) {
      if (!own(body, key)) {
        throw new SuiTransactionShapeError(path, `missing ${key} payload`);
      }
    } else if (own(body, key)) {
      throw new SuiTransactionShapeError(path, `contains opposing ${key} payload`);
    }
  }
  exactKeys(body, path, ['$kind', ...(expectedPayload === null ? [] : [expectedPayload])]);

  if (kind === 'vector') {
    parseOpenSignatureBody(body.vector, `${path}.vector`);
    return;
  }
  if (kind === 'datatype') {
    const datatype = record(body.datatype, `${path}.datatype`);
    exactKeys(datatype, `${path}.datatype`, ['typeName', 'typeParameters']);
    string(datatype.typeName, `${path}.datatype.typeName`);
    array(datatype.typeParameters, `${path}.datatype.typeParameters`).forEach((parameter, index) =>
      parseOpenSignatureBody(parameter, `${path}.datatype.typeParameters[${index}]`),
    );
    return;
  }
  if (
    kind === 'typeParameter' &&
    (!Number.isSafeInteger(body.index) || (body.index as number) < 0)
  ) {
    throw new SuiTransactionShapeError(`${path}.index`, 'expected a non-negative safe integer');
  }
}

function parseOpenSignature(value: unknown, path: string): void {
  const signature = record(value, path);
  exactKeys(signature, path, ['reference', 'body']);
  if (
    signature.reference !== null &&
    signature.reference !== 'mutable' &&
    signature.reference !== 'immutable' &&
    signature.reference !== 'unknown'
  ) {
    throw new SuiTransactionShapeError(`${path}.reference`, 'unsupported current reference');
  }
  parseOpenSignatureBody(signature.body, `${path}.body`);
}

/** Validate one exact current SDK 2.17 PTB command. */
export function parseSuiCommand(value: unknown, path = 'command'): Command {
  const parsed = enumPayload(value, path, COMMAND_KINDS);
  exactEnumRoot(parsed.root, parsed.kind, path);
  const payload = record(parsed.payload, `${path}.${parsed.kind}`);
  switch (parsed.kind) {
    case 'MoveCall':
      exactKeys(payload, `${path}.MoveCall`, [
        'package',
        'module',
        'function',
        'typeArguments',
        'arguments',
        '_argumentTypes',
      ]);
      suiAddress(payload.package, `${path}.MoveCall.package`);
      string(payload.module, `${path}.MoveCall.module`);
      string(payload.function, `${path}.MoveCall.function`);
      array(payload.typeArguments, `${path}.MoveCall.typeArguments`).forEach((type, index) =>
        typeTag(type, `${path}.MoveCall.typeArguments[${index}]`),
      );
      parseArgumentArray(payload.arguments, `${path}.MoveCall.arguments`);
      if (
        own(payload, '_argumentTypes') &&
        payload._argumentTypes !== null &&
        !Array.isArray(payload._argumentTypes)
      ) {
        throw new SuiTransactionShapeError(
          `${path}.MoveCall._argumentTypes`,
          'expected an array or null',
        );
      }
      if (Array.isArray(payload._argumentTypes)) {
        array(payload._argumentTypes, `${path}.MoveCall._argumentTypes`).forEach(
          (signature, index) =>
            parseOpenSignature(signature, `${path}.MoveCall._argumentTypes[${index}]`),
        );
      }
      break;
    case 'TransferObjects':
      exactKeys(payload, `${path}.TransferObjects`, ['objects', 'address']);
      parseArgumentArray(payload.objects, `${path}.TransferObjects.objects`);
      parseSuiArgument(payload.address, `${path}.TransferObjects.address`);
      break;
    case 'SplitCoins':
      exactKeys(payload, `${path}.SplitCoins`, ['coin', 'amounts']);
      parseSuiArgument(payload.coin, `${path}.SplitCoins.coin`);
      parseArgumentArray(payload.amounts, `${path}.SplitCoins.amounts`);
      break;
    case 'MergeCoins':
      exactKeys(payload, `${path}.MergeCoins`, ['destination', 'sources']);
      parseSuiArgument(payload.destination, `${path}.MergeCoins.destination`);
      parseArgumentArray(payload.sources, `${path}.MergeCoins.sources`);
      break;
    case 'Publish':
      exactKeys(payload, `${path}.Publish`, ['modules', 'dependencies']);
      array(payload.modules, `${path}.Publish.modules`).forEach((module, index) =>
        canonicalBase64(module, `${path}.Publish.modules[${index}]`),
      );
      array(payload.dependencies, `${path}.Publish.dependencies`).forEach((dependency, index) =>
        suiAddress(dependency, `${path}.Publish.dependencies[${index}]`),
      );
      break;
    case 'MakeMoveVec':
      exactKeys(payload, `${path}.MakeMoveVec`, ['type', 'elements']);
      if (payload.type !== null) typeTag(payload.type, `${path}.MakeMoveVec.type`);
      parseArgumentArray(payload.elements, `${path}.MakeMoveVec.elements`);
      break;
    case 'Upgrade':
      exactKeys(payload, `${path}.Upgrade`, ['modules', 'dependencies', 'package', 'ticket']);
      array(payload.modules, `${path}.Upgrade.modules`).forEach((module, index) =>
        canonicalBase64(module, `${path}.Upgrade.modules[${index}]`),
      );
      array(payload.dependencies, `${path}.Upgrade.dependencies`).forEach((dependency, index) =>
        suiAddress(dependency, `${path}.Upgrade.dependencies[${index}]`),
      );
      suiAddress(payload.package, `${path}.Upgrade.package`);
      parseSuiArgument(payload.ticket, `${path}.Upgrade.ticket`);
      break;
    case '$Intent': {
      exactKeys(payload, `${path}.$Intent`, ['name', 'inputs', 'data']);
      string(payload.name, `${path}.$Intent.name`);
      const inputs = record(payload.inputs, `${path}.$Intent.inputs`);
      for (const [name, intentInput] of Object.entries(inputs)) {
        if (Array.isArray(intentInput)) {
          parseArgumentArray(intentInput, `${path}.$Intent.inputs.${name}`);
        } else {
          parseSuiArgument(intentInput, `${path}.$Intent.inputs.${name}`);
        }
      }
      record(payload.data, `${path}.$Intent.data`);
      break;
    }
    default:
      return rejectUnhandledSuiVariant(parsed.kind, path);
  }
  return value as Command;
}

/** Validate a complete current command array without manufacturing entries. */
export function parseSuiCommands(value: unknown, path = 'commands'): Command[] {
  return array(value, path).map((command, index) => parseSuiCommand(command, `${path}[${index}]`));
}

/** Project an object ID from an already-current CallArg; malformed inputs throw. */
export function projectSuiCallArgObjectId(input: CallArg): string | null {
  const current = parseSuiCallArg(input);
  if (current.$kind === 'UnresolvedObject') return current.UnresolvedObject.objectId;
  if (current.$kind !== 'Object') return null;
  switch (current.Object.$kind) {
    case 'ImmOrOwnedObject':
      return current.Object.ImmOrOwnedObject.objectId;
    case 'SharedObject':
      return current.Object.SharedObject.objectId;
    case 'Receiving':
      return current.Object.Receiving.objectId;
    default:
      return rejectUnhandledSuiVariant(current.Object, 'input.Object');
  }
}

/** Project one exact current input into the SDK integrity comparison identity. */
export function projectSuiInputIdentity(value: unknown): string {
  const input = parseSuiCallArg(value);
  if (input.$kind === 'Pure') return `Pure:${input.Pure.bytes}`;
  if (input.$kind === 'UnresolvedPure') {
    throw new SuiTransactionShapeError('input', 'integrity identity requires resolved pure input');
  }
  if (input.$kind === 'FundsWithdrawal') {
    return [
      'FundsWithdrawal',
      structTag(input.FundsWithdrawal.typeArg.Balance, 'input.FundsWithdrawal.typeArg.Balance'),
      u64(
        input.FundsWithdrawal.reservation.MaxAmountU64,
        'input.FundsWithdrawal.reservation.MaxAmountU64',
      ).toString(),
      input.FundsWithdrawal.withdrawFrom.$kind,
    ].join(':');
  }
  const objectId = projectSuiCallArgObjectId(input);
  if (objectId === null) {
    throw new SuiTransactionShapeError('input', 'integrity identity requires an object input');
  }
  return `Object:${normalizeSuiAddress(objectId)}`;
}

export interface SuiGasUsed {
  readonly computationCost: string;
  readonly storageCost: string;
  readonly storageRebate: string;
  readonly nonRefundableStorageFee: string;
}

type CurrentRawExecutionErrorKind = Exclude<
  GrpcTypes.ExecutionError_ExecutionErrorKind,
  GrpcTypes.ExecutionError_ExecutionErrorKind.EXECUTION_ERROR_KIND_UNKNOWN
>;

const RAW_EXECUTION_ERROR_KIND_NAMES = {
  [GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_GAS]: 'InsufficientGas',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.INVALID_GAS_OBJECT]: 'InvalidGasObject',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.INVARIANT_VIOLATION]: 'InvariantViolation',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.FEATURE_NOT_YET_SUPPORTED]: 'FeatureNotYetSupported',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.OBJECT_TOO_BIG]: 'ObjectTooBig',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.PACKAGE_TOO_BIG]: 'PackageTooBig',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.CIRCULAR_OBJECT_OWNERSHIP]:
    'CircularObjectOwnership',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_COIN_BALANCE]:
    'InsufficientCoinBalance',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.COIN_BALANCE_OVERFLOW]: 'CoinBalanceOverflow',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.PUBLISH_ERROR_NON_ZERO_ADDRESS]:
    'PublishErrorNonZeroAddress',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.SUI_MOVE_VERIFICATION_ERROR]:
    'SuiMoveVerificationError',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_PRIMITIVE_RUNTIME_ERROR]:
    'MovePrimitiveRuntimeError',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_ABORT]: 'MoveAbortRaw',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.VM_VERIFICATION_OR_DESERIALIZATION_ERROR]:
    'VmVerificationOrDeserializationError',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.VM_INVARIANT_VIOLATION]: 'VmInvariantViolation',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.FUNCTION_NOT_FOUND]: 'FunctionNotFound',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.ARITY_MISMATCH]: 'ArityMismatch',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.TYPE_ARITY_MISMATCH]: 'TypeArityMismatch',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.NON_ENTRY_FUNCTION_INVOKED]:
    'NonEntryFunctionInvoked',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.COMMAND_ARGUMENT_ERROR]: 'CommandArgumentErrorRaw',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.TYPE_ARGUMENT_ERROR]: 'TypeArgumentErrorRaw',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.UNUSED_VALUE_WITHOUT_DROP]: 'UnusedValueWithoutDrop',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.INVALID_PUBLIC_FUNCTION_RETURN_TYPE]:
    'InvalidPublicFunctionReturnType',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.INVALID_TRANSFER_OBJECT]: 'InvalidTransferObject',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.EFFECTS_TOO_LARGE]: 'EffectsTooLarge',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.PUBLISH_UPGRADE_MISSING_DEPENDENCY]:
    'PublishUpgradeMissingDependency',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.PUBLISH_UPGRADE_DEPENDENCY_DOWNGRADE]:
    'PublishUpgradeDependencyDowngrade',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.PACKAGE_UPGRADE_ERROR]: 'PackageUpgradeErrorRaw',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.WRITTEN_OBJECTS_TOO_LARGE]: 'WrittenObjectsTooLarge',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.CERTIFICATE_DENIED]: 'CertificateDenied',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.SUI_MOVE_VERIFICATION_TIMEDOUT]:
    'SuiMoveVerificationTimedout',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.CONSENSUS_OBJECT_OPERATION_NOT_ALLOWED]:
    'ConsensusObjectOperationNotAllowed',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.INPUT_OBJECT_DELETED]: 'InputObjectDeleted',
  [GrpcTypes.ExecutionError_ExecutionErrorKind
    .EXECUTION_CANCELED_DUE_TO_CONSENSUS_OBJECT_CONGESTION]:
    'ExecutionCanceledDueToConsensusObjectCongestion',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.ADDRESS_DENIED_FOR_COIN]: 'AddressDeniedForCoin',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.COIN_TYPE_GLOBAL_PAUSE]: 'CoinTypeGlobalPause',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.EXECUTION_CANCELED_DUE_TO_RANDOMNESS_UNAVAILABLE]:
    'ExecutionCanceledDueToRandomnessUnavailable',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_VECTOR_ELEM_TOO_BIG]: 'MoveVectorElemTooBig',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_RAW_VALUE_TOO_BIG]: 'MoveRawValueTooBig',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.INVALID_LINKAGE]: 'InvalidLinkage',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.INSUFFICIENT_FUNDS_FOR_WITHDRAW]:
    'InsufficientFundsForWithdraw',
  [GrpcTypes.ExecutionError_ExecutionErrorKind.NON_EXCLUSIVE_WRITE_INPUT_OBJECT_MODIFIED]:
    'NonExclusiveWriteInputObjectModified',
} as const satisfies Record<CurrentRawExecutionErrorKind, string>;

export type RawSuiExecutionErrorKind =
  (typeof RAW_EXECUTION_ERROR_KIND_NAMES)[keyof typeof RAW_EXECUTION_ERROR_KIND_NAMES];

export type SuiExecutionErrorKind =
  | 'MoveAbort'
  | 'SizeError'
  | 'CommandArgumentError'
  | 'TypeArgumentError'
  | 'PackageUpgradeError'
  | 'IndexError'
  | 'CoinDenyListError'
  | 'CongestedObjects'
  | 'ObjectIdError'
  | RawSuiExecutionErrorKind;

interface SuiExecutionErrorBase<Kind extends SuiExecutionErrorKind> {
  readonly kind: Kind;
  readonly command?: number;
}

export interface SuiMoveAbort {
  readonly packageId?: string;
  readonly module?: string;
  readonly functionIndex?: number;
  readonly functionName?: string;
  readonly instruction?: number;
  readonly abortCode: string;
  readonly constantName?: string;
}

export type SuiExecutionError =
  | (SuiExecutionErrorBase<'MoveAbort'> & { readonly moveAbort: SuiMoveAbort })
  | SuiExecutionErrorBase<Exclude<SuiExecutionErrorKind, 'MoveAbort'>>;

/**
 * Sole display-message authority for a parsed Sui execution failure.
 *
 * The normalized kind is a closed local vocabulary. Provider descriptions,
 * clever-error rendering, object identities, and transaction data never take
 * part in the message.
 */
export function suiExecutionErrorMessage(error: Pick<SuiExecutionError, 'kind'>): string {
  return `Sui execution failed (${error.kind})`;
}

export type SuiExecutionStatus =
  | { readonly success: true; readonly error: null }
  | { readonly success: false; readonly error: SuiExecutionError };

export interface SuiTransactionEffects {
  readonly version: 2;
  readonly transactionDigest: string;
  readonly status: SuiExecutionStatus;
  readonly gasUsed: SuiGasUsed;
  readonly eventsDigest: string | null;
}

export interface SuiEvent {
  readonly packageId: string;
  readonly module: string;
  readonly sender: string;
  readonly eventType: string;
  readonly bcs: Uint8Array;
}

interface SuiTransactionResultBase {
  readonly digest: string;
  readonly effects: SuiTransactionEffects;
}

export type SuiTransactionResult =
  | (SuiTransactionResultBase & { readonly outcome: 'success' })
  | (SuiTransactionResultBase & {
      readonly outcome: 'failure';
      readonly error: SuiExecutionError;
    });

export interface SuiBalanceChange {
  readonly address: string;
  readonly coinType: string;
  readonly amount: string;
}

export interface SuiTransactionBalanceChangesResult {
  readonly digest: string;
  readonly balanceChanges: readonly SuiBalanceChange[];
}

export interface SuiCommandOutput {
  readonly bcs: Uint8Array;
}

export interface SuiCommandResult {
  readonly returnValues: readonly SuiCommandOutput[];
  readonly mutatedReferences: readonly SuiCommandOutput[];
}

export type SuiMoveViewResult =
  | {
      readonly outcome: 'success';
      readonly commandResults: readonly SuiCommandResult[];
    }
  | {
      readonly outcome: 'failure';
      readonly error: SuiExecutionError;
    };

export type SuiTransactionWithEventsResult =
  | (SuiTransactionResultBase & {
      readonly outcome: 'success';
      readonly events: readonly SuiEvent[];
    })
  | (SuiTransactionResultBase & {
      readonly outcome: 'failure';
      readonly error: SuiExecutionError;
      readonly events: readonly SuiEvent[];
    });

function rawBigInt(value: unknown, path: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new SuiTransactionShapeError(path, 'expected an unsigned protobuf integer');
  }
  return value;
}

function rawOptionalSafeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = rawBigInt(value, path);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SuiTransactionShapeError(path, 'integer exceeds the safe range');
  }
  return Number(parsed);
}

function rawExecutionKind(
  value: unknown,
  path: string,
): {
  readonly value: CurrentRawExecutionErrorKind;
  readonly name: RawSuiExecutionErrorKind;
} {
  const number = nonNegativeInteger(value, path);
  const name = RAW_EXECUTION_ERROR_KIND_NAMES[number as CurrentRawExecutionErrorKind];
  if (!name) throw new SuiTransactionShapeError(path, 'unknown current execution-error kind');
  return { value: number as CurrentRawExecutionErrorKind, name };
}

function requireRawKind(
  actual: CurrentRawExecutionErrorKind,
  allowed: readonly CurrentRawExecutionErrorKind[],
  path: string,
): void {
  if (!allowed.includes(actual)) {
    throw new SuiTransactionShapeError(path, 'execution-error kind disagrees with its payload');
  }
}

type CurrentCommandArgumentErrorKind = Exclude<
  GrpcTypes.CommandArgumentError_CommandArgumentErrorKind,
  GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.COMMAND_ARGUMENT_ERROR_KIND_UNKNOWN
>;

const CURRENT_COMMAND_ARGUMENT_ERROR_KINDS = {
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.TYPE_MISMATCH]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.INVALID_BCS_BYTES]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.INVALID_USAGE_OF_PURE_ARGUMENT]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind
    .INVALID_ARGUMENT_TO_PRIVATE_ENTRY_FUNCTION]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.INDEX_OUT_OF_BOUNDS]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.SECONDARY_INDEX_OUT_OF_BOUNDS]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.INVALID_RESULT_ARITY]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.INVALID_GAS_COIN_USAGE]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.INVALID_VALUE_USAGE]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.INVALID_OBJECT_BY_VALUE]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.INVALID_OBJECT_BY_MUT_REF]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.CONSENSUS_OBJECT_OPERATION_NOT_ALLOWED]:
    true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.INVALID_ARGUMENT_ARITY]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.INVALID_TRANSFER_OBJECT]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind
    .INVALID_MAKE_MOVE_VEC_NON_OBJECT_ARGUMENT]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.ARGUMENT_WITHOUT_VALUE]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.CANNOT_MOVE_BORROWED_VALUE]: true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.CANNOT_WRITE_TO_EXTENDED_REFERENCE]:
    true,
  [GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.INVALID_REFERENCE_ARGUMENT]: true,
} as const satisfies Record<CurrentCommandArgumentErrorKind, true>;

const INDEXED_COMMAND_ARGUMENT_ERROR_KINDS: ReadonlySet<CurrentCommandArgumentErrorKind> = new Set([
  GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.INDEX_OUT_OF_BOUNDS,
  GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.SECONDARY_INDEX_OUT_OF_BOUNDS,
  GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.INVALID_RESULT_ARITY,
]);

type CurrentTypeArgumentErrorKind = Exclude<
  GrpcTypes.TypeArgumentError_TypeArgumentErrorKind,
  GrpcTypes.TypeArgumentError_TypeArgumentErrorKind.TYPE_ARGUMENT_ERROR_KIND_UNKNOWN
>;

const CURRENT_TYPE_ARGUMENT_ERROR_KINDS = {
  [GrpcTypes.TypeArgumentError_TypeArgumentErrorKind.TYPE_NOT_FOUND]: true,
  [GrpcTypes.TypeArgumentError_TypeArgumentErrorKind.CONSTRAINT_NOT_SATISFIED]: true,
} as const satisfies Record<CurrentTypeArgumentErrorKind, true>;

type CurrentPackageUpgradeErrorKind = Exclude<
  GrpcTypes.PackageUpgradeError_PackageUpgradeErrorKind,
  GrpcTypes.PackageUpgradeError_PackageUpgradeErrorKind.PACKAGE_UPGRADE_ERROR_KIND_UNKNOWN
>;

const CURRENT_PACKAGE_UPGRADE_ERROR_KINDS = {
  [GrpcTypes.PackageUpgradeError_PackageUpgradeErrorKind.UNABLE_TO_FETCH_PACKAGE]: true,
  [GrpcTypes.PackageUpgradeError_PackageUpgradeErrorKind.NOT_A_PACKAGE]: true,
  [GrpcTypes.PackageUpgradeError_PackageUpgradeErrorKind.INCOMPATIBLE_UPGRADE]: true,
  [GrpcTypes.PackageUpgradeError_PackageUpgradeErrorKind.DIGEST_DOES_NOT_MATCH]: true,
  [GrpcTypes.PackageUpgradeError_PackageUpgradeErrorKind.UNKNOWN_UPGRADE_POLICY]: true,
  [GrpcTypes.PackageUpgradeError_PackageUpgradeErrorKind.PACKAGE_ID_DOES_NOT_MATCH]: true,
} as const satisfies Record<CurrentPackageUpgradeErrorKind, true>;

function currentEnumValue<T extends number>(
  value: unknown,
  path: string,
  members: object,
  reason: string,
): T {
  const parsed = nonNegativeInteger(value, path);
  if (!Object.prototype.hasOwnProperty.call(members, parsed)) {
    throw new SuiTransactionShapeError(path, reason);
  }
  return parsed as T;
}

function parseRawExecutionError(value: unknown, path: string): SuiExecutionError {
  const error = record(value, path);
  exactKeys(error, path, ['description', 'command', 'kind', 'errorDetails']);
  // The installed protobuf marks this provider-controlled display text as
  // optional. When present it is type-checked (empty is current-valid) and
  // discarded; it never participates in Stelis error identity or messages.
  if (error.description !== undefined && typeof error.description !== 'string') {
    throw new SuiTransactionShapeError(`${path}.description`, 'expected a string');
  }
  const detailOneof = protobufOneof(error.errorDetails, `${path}.errorDetails`, [
    'abort',
    'sizeError',
    'commandArgumentError',
    'typeArgumentError',
    'packageUpgradeError',
    'indexError',
    'objectId',
    'coinDenyListError',
    'congestedObjects',
  ]);
  const details = detailOneof.root;
  const oneofKind = detailOneof.kind;
  const command = rawOptionalSafeInteger(error.command, `${path}.command`);
  const rawKind = rawExecutionKind(error.kind, `${path}.kind`);

  if (oneofKind === undefined) {
    if (rawKind.value === GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_ABORT) {
      throw new SuiTransactionShapeError(
        `${path}.errorDetails`,
        'MoveAbort is missing its structured payload',
      );
    }
    return command === undefined ? { kind: rawKind.name } : { kind: rawKind.name, command };
  }
  if (typeof oneofKind !== 'string' || oneofKind.length === 0) {
    throw new SuiTransactionShapeError(
      `${path}.errorDetails.oneofKind`,
      'expected a current oneof kind',
    );
  }

  let kind: SuiExecutionErrorKind;
  let moveAbort: SuiMoveAbort | undefined;
  switch (oneofKind) {
    case 'abort': {
      requireRawKind(
        rawKind.value,
        [GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_ABORT],
        `${path}.kind`,
      );
      kind = 'MoveAbort';
      const abort = record(details.abort, `${path}.errorDetails.abort`);
      exactKeys(abort, `${path}.errorDetails.abort`, ['abortCode', 'location', 'cleverError']);
      const abortCode = rawBigInt(abort.abortCode, `${path}.errorDetails.abort.abortCode`);
      const location =
        abort.location === undefined
          ? undefined
          : record(abort.location, `${path}.errorDetails.abort.location`);
      if (location) {
        exactKeys(location, `${path}.errorDetails.abort.location`, [
          'package',
          'module',
          'function',
          'instruction',
          'functionName',
        ]);
        if (location.package !== undefined)
          suiAddress(location.package, `${path}.errorDetails.abort.location.package`);
        if (location.module !== undefined)
          string(location.module, `${path}.errorDetails.abort.location.module`);
        if (location.function !== undefined)
          nonNegativeInteger(location.function, `${path}.errorDetails.abort.location.function`);
        if (location.functionName !== undefined)
          string(location.functionName, `${path}.errorDetails.abort.location.functionName`);
        if (location.instruction !== undefined)
          nonNegativeInteger(
            location.instruction,
            `${path}.errorDetails.abort.location.instruction`,
          );
      }
      const clever =
        abort.cleverError === undefined
          ? undefined
          : record(abort.cleverError, `${path}.errorDetails.abort.cleverError`);
      if (clever) {
        exactKeys(clever, `${path}.errorDetails.abort.cleverError`, [
          'errorCode',
          'lineNumber',
          'constantName',
          'constantType',
          'value',
        ]);
      }
      if (clever?.errorCode !== undefined) {
        rawBigInt(clever.errorCode, `${path}.errorDetails.abort.cleverError.errorCode`);
      }
      if (clever) {
        rawOptionalSafeInteger(
          clever.lineNumber,
          `${path}.errorDetails.abort.cleverError.lineNumber`,
        );
      }
      if (clever?.constantName !== undefined)
        string(clever.constantName, `${path}.errorDetails.abort.cleverError.constantName`);
      if (clever?.constantType !== undefined)
        string(clever.constantType, `${path}.errorDetails.abort.cleverError.constantType`);
      const cleverValue = clever
        ? protobufOneof(clever.value, `${path}.errorDetails.abort.cleverError.value`, [
            'rendered',
            'raw',
          ])
        : undefined;
      if (cleverValue?.kind !== undefined) {
        switch (cleverValue.kind) {
          case 'rendered':
            string(cleverValue.payload, `${path}.errorDetails.abort.cleverError.value.rendered`);
            break;
          case 'raw':
            bytes(cleverValue.payload, `${path}.errorDetails.abort.cleverError.value.raw`);
            break;
          default:
            rejectUnhandledSuiVariant(
              cleverValue.kind,
              `${path}.errorDetails.abort.cleverError.value`,
            );
        }
      }
      moveAbort = {
        abortCode: abortCode.toString(),
        ...(location && typeof location.package === 'string'
          ? { packageId: normalizeSuiAddress(location.package) }
          : {}),
        ...(location && typeof location.module === 'string' ? { module: location.module } : {}),
        ...(location && typeof location.function === 'number'
          ? { functionIndex: location.function }
          : {}),
        ...(location && typeof location.functionName === 'string'
          ? { functionName: location.functionName }
          : {}),
        ...(location && typeof location.instruction === 'number'
          ? { instruction: location.instruction }
          : {}),
        ...(clever && typeof clever.constantName === 'string'
          ? { constantName: clever.constantName }
          : {}),
      };
      break;
    }
    case 'sizeError': {
      requireRawKind(
        rawKind.value,
        [
          GrpcTypes.ExecutionError_ExecutionErrorKind.OBJECT_TOO_BIG,
          GrpcTypes.ExecutionError_ExecutionErrorKind.PACKAGE_TOO_BIG,
          GrpcTypes.ExecutionError_ExecutionErrorKind.EFFECTS_TOO_LARGE,
          GrpcTypes.ExecutionError_ExecutionErrorKind.WRITTEN_OBJECTS_TOO_LARGE,
          GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_VECTOR_ELEM_TOO_BIG,
          GrpcTypes.ExecutionError_ExecutionErrorKind.MOVE_RAW_VALUE_TOO_BIG,
        ],
        `${path}.kind`,
      );
      kind = 'SizeError';
      const detail = record(details.sizeError, `${path}.errorDetails.sizeError`);
      exactKeys(detail, `${path}.errorDetails.sizeError`, ['size', 'maxSize']);
      rawBigInt(detail.size, `${path}.errorDetails.sizeError.size`);
      rawBigInt(detail.maxSize, `${path}.errorDetails.sizeError.maxSize`);
      break;
    }
    case 'commandArgumentError': {
      requireRawKind(
        rawKind.value,
        [GrpcTypes.ExecutionError_ExecutionErrorKind.COMMAND_ARGUMENT_ERROR],
        `${path}.kind`,
      );
      kind = 'CommandArgumentError';
      const detail = record(
        details.commandArgumentError,
        `${path}.errorDetails.commandArgumentError`,
      );
      exactKeys(detail, `${path}.errorDetails.commandArgumentError`, [
        'argument',
        'kind',
        'indexError',
      ]);
      nonNegativeInteger(detail.argument, `${path}.errorDetails.commandArgumentError.argument`);
      const argumentKind = currentEnumValue<CurrentCommandArgumentErrorKind>(
        detail.kind,
        `${path}.errorDetails.commandArgumentError.kind`,
        CURRENT_COMMAND_ARGUMENT_ERROR_KINDS,
        'unknown current command-argument kind',
      );
      if (INDEXED_COMMAND_ARGUMENT_ERROR_KINDS.has(argumentKind)) {
        const indexError = record(
          detail.indexError,
          `${path}.errorDetails.commandArgumentError.indexError`,
        );
        exactKeys(indexError, `${path}.errorDetails.commandArgumentError.indexError`, [
          'index',
          'subresult',
        ]);
        nonNegativeInteger(
          indexError.index,
          `${path}.errorDetails.commandArgumentError.indexError.index`,
        );
        if (
          argumentKind ===
          GrpcTypes.CommandArgumentError_CommandArgumentErrorKind.SECONDARY_INDEX_OUT_OF_BOUNDS
        ) {
          nonNegativeInteger(
            indexError.subresult,
            `${path}.errorDetails.commandArgumentError.indexError.subresult`,
          );
        } else if (indexError.subresult !== undefined) {
          nonNegativeInteger(
            indexError.subresult,
            `${path}.errorDetails.commandArgumentError.indexError.subresult`,
          );
        }
      } else if (detail.indexError !== undefined) {
        throw new SuiTransactionShapeError(
          `${path}.errorDetails.commandArgumentError.indexError`,
          'unexpected index error for this command-argument kind',
        );
      }
      break;
    }
    case 'typeArgumentError': {
      requireRawKind(
        rawKind.value,
        [GrpcTypes.ExecutionError_ExecutionErrorKind.TYPE_ARGUMENT_ERROR],
        `${path}.kind`,
      );
      kind = 'TypeArgumentError';
      const detail = record(details.typeArgumentError, `${path}.errorDetails.typeArgumentError`);
      exactKeys(detail, `${path}.errorDetails.typeArgumentError`, ['typeArgument', 'kind']);
      nonNegativeInteger(
        detail.typeArgument,
        `${path}.errorDetails.typeArgumentError.typeArgument`,
      );
      currentEnumValue<CurrentTypeArgumentErrorKind>(
        detail.kind,
        `${path}.errorDetails.typeArgumentError.kind`,
        CURRENT_TYPE_ARGUMENT_ERROR_KINDS,
        'unknown current type-argument kind',
      );
      break;
    }
    case 'packageUpgradeError': {
      requireRawKind(
        rawKind.value,
        [GrpcTypes.ExecutionError_ExecutionErrorKind.PACKAGE_UPGRADE_ERROR],
        `${path}.kind`,
      );
      kind = 'PackageUpgradeError';
      const detail = record(
        details.packageUpgradeError,
        `${path}.errorDetails.packageUpgradeError`,
      );
      exactKeys(detail, `${path}.errorDetails.packageUpgradeError`, [
        'kind',
        'packageId',
        'digest',
        'policy',
        'ticketId',
      ]);
      currentEnumValue<CurrentPackageUpgradeErrorKind>(
        detail.kind,
        `${path}.errorDetails.packageUpgradeError.kind`,
        CURRENT_PACKAGE_UPGRADE_ERROR_KINDS,
        'unknown current package-upgrade kind',
      );
      if (detail.packageId !== undefined) {
        suiAddress(detail.packageId, `${path}.errorDetails.packageUpgradeError.packageId`);
      }
      if (detail.ticketId !== undefined) {
        suiAddress(detail.ticketId, `${path}.errorDetails.packageUpgradeError.ticketId`);
      }
      if (detail.digest !== undefined) {
        digest(detail.digest, `${path}.errorDetails.packageUpgradeError.digest`);
      }
      if (detail.policy !== undefined) {
        nonNegativeInteger(detail.policy, `${path}.errorDetails.packageUpgradeError.policy`);
      }
      break;
    }
    case 'indexError': {
      requireRawKind(
        rawKind.value,
        [GrpcTypes.ExecutionError_ExecutionErrorKind.UNUSED_VALUE_WITHOUT_DROP],
        `${path}.kind`,
      );
      kind = 'IndexError';
      const detail = record(details.indexError, `${path}.errorDetails.indexError`);
      exactKeys(detail, `${path}.errorDetails.indexError`, ['index', 'subresult']);
      nonNegativeInteger(detail.index, `${path}.errorDetails.indexError.index`);
      if (detail.subresult !== undefined) {
        nonNegativeInteger(detail.subresult, `${path}.errorDetails.indexError.subresult`);
      }
      break;
    }
    case 'coinDenyListError': {
      requireRawKind(
        rawKind.value,
        [
          GrpcTypes.ExecutionError_ExecutionErrorKind.ADDRESS_DENIED_FOR_COIN,
          GrpcTypes.ExecutionError_ExecutionErrorKind.COIN_TYPE_GLOBAL_PAUSE,
        ],
        `${path}.kind`,
      );
      kind = 'CoinDenyListError';
      const detail = record(details.coinDenyListError, `${path}.errorDetails.coinDenyListError`);
      exactKeys(detail, `${path}.errorDetails.coinDenyListError`, ['address', 'coinType']);
      string(detail.coinType, `${path}.errorDetails.coinDenyListError.coinType`);
      if (detail.address !== undefined) {
        suiAddress(detail.address, `${path}.errorDetails.coinDenyListError.address`);
      }
      break;
    }
    case 'congestedObjects': {
      requireRawKind(
        rawKind.value,
        [
          GrpcTypes.ExecutionError_ExecutionErrorKind
            .EXECUTION_CANCELED_DUE_TO_CONSENSUS_OBJECT_CONGESTION,
        ],
        `${path}.kind`,
      );
      kind = 'CongestedObjects';
      const detail = record(details.congestedObjects, `${path}.errorDetails.congestedObjects`);
      exactKeys(detail, `${path}.errorDetails.congestedObjects`, ['objects']);
      const objects = array(detail.objects, `${path}.errorDetails.congestedObjects.objects`);
      if (objects.length === 0) {
        throw new SuiTransactionShapeError(
          `${path}.errorDetails.congestedObjects.objects`,
          'expected at least one congested object',
        );
      }
      objects.forEach((id, index) =>
        suiAddress(id, `${path}.errorDetails.congestedObjects.objects[${index}]`),
      );
      break;
    }
    case 'objectId':
      requireRawKind(
        rawKind.value,
        [
          GrpcTypes.ExecutionError_ExecutionErrorKind.INPUT_OBJECT_DELETED,
          GrpcTypes.ExecutionError_ExecutionErrorKind.NON_EXCLUSIVE_WRITE_INPUT_OBJECT_MODIFIED,
        ],
        `${path}.kind`,
      );
      kind = 'ObjectIdError';
      suiAddress(details.objectId, `${path}.errorDetails.objectId`);
      break;
    default:
      return rejectUnhandledSuiVariant(oneofKind, `${path}.errorDetails.oneofKind`);
  }
  if (kind === 'MoveAbort') {
    if (!moveAbort) {
      throw new SuiTransactionShapeError(path, 'MoveAbort lost its structured payload');
    }
    return command === undefined ? { kind, moveAbort } : { kind, command, moveAbort };
  }
  return command === undefined ? { kind } : { kind, command };
}

function parseRawStatus(value: unknown, path: string): SuiExecutionStatus {
  const status = record(value, path);
  exactKeys(status, path, ['success', 'error']);
  if (status.success === true) {
    if (status.error !== undefined) {
      throw new SuiTransactionShapeError(path, 'successful status contains an error');
    }
    return { success: true, error: null };
  }
  if (status.success !== false || status.error === undefined) {
    throw new SuiTransactionShapeError(path, 'failed status is missing its exact error');
  }
  return { success: false, error: parseRawExecutionError(status.error, `${path}.error`) };
}

/** @internal Validate the exact raw status returned by transaction resolution. */
export function parseRawSuiResolutionStatus(value: unknown): SuiExecutionStatus {
  return parseRawStatus(value, 'resolution.transaction.effects.status');
}

function parseRawEffects(
  value: unknown,
  expectedDigest: string | undefined,
  path: string,
): SuiTransactionEffects {
  const effects = record(value, path);
  exactKeys(effects, path, [
    'bcs',
    'digest',
    'version',
    'status',
    'epoch',
    'gasUsed',
    'transactionDigest',
    'gasObject',
    'eventsDigest',
    'dependencies',
    'lamportVersion',
    'changedObjects',
    'unchangedConsensusObjects',
    'auxiliaryDataDigest',
    'unchangedLoadedRuntimeObjects',
  ]);
  for (const key of [
    'bcs',
    'digest',
    'epoch',
    'gasObject',
    'lamportVersion',
    'auxiliaryDataDigest',
  ] as const) {
    assertAbsentRawSuiField(effects, key, path);
  }
  for (const key of [
    'dependencies',
    'changedObjects',
    'unchangedConsensusObjects',
    'unchangedLoadedRuntimeObjects',
  ] as const) {
    assertEmptyRawSuiRepeatedField(array(effects[key], `${path}.${key}`), `${path}.${key}`);
  }
  if (effects.version !== 2) {
    throw new SuiTransactionShapeError(`${path}.version`, 'expected current effects version 2');
  }
  const transactionDigest = digest(effects.transactionDigest, `${path}.transactionDigest`);
  if (expectedDigest !== undefined && transactionDigest !== expectedDigest) {
    throw new SuiTransactionShapeError(`${path}.transactionDigest`, 'does not match the request');
  }
  const status = parseRawStatus(effects.status, `${path}.status`);
  const gas = record(effects.gasUsed, `${path}.gasUsed`);
  exactKeys(gas, `${path}.gasUsed`, [
    'computationCost',
    'storageCost',
    'storageRebate',
    'nonRefundableStorageFee',
  ]);
  const gasUsed: SuiGasUsed = {
    computationCost: rawBigInt(gas.computationCost, `${path}.gasUsed.computationCost`).toString(),
    storageCost: rawBigInt(gas.storageCost, `${path}.gasUsed.storageCost`).toString(),
    storageRebate: rawBigInt(gas.storageRebate, `${path}.gasUsed.storageRebate`).toString(),
    nonRefundableStorageFee: rawBigInt(
      gas.nonRefundableStorageFee,
      `${path}.gasUsed.nonRefundableStorageFee`,
    ).toString(),
  };
  const eventsDigest =
    effects.eventsDigest === undefined
      ? null
      : digest(effects.eventsDigest, `${path}.eventsDigest`);
  return { version: 2, transactionDigest, status, gasUsed, eventsDigest };
}

function parseRawEvents(
  value: unknown,
  path: string,
  eventsDigest: string | null,
): readonly SuiEvent[] {
  if (value === undefined) {
    if (eventsDigest === null) return Object.freeze([]);
    throw new SuiTransactionShapeError(path, 'event digest exists but the envelope is missing');
  }
  if (eventsDigest === null) {
    throw new SuiTransactionShapeError(path, 'event envelope exists without an effects digest');
  }
  const events = record(value, path);
  exactKeys(events, path, ['bcs', 'digest', 'events']);
  assertAbsentRawSuiField(events, 'bcs', path);
  const envelopeDigest = digest(events.digest, `${path}.digest`);
  if (envelopeDigest !== eventsDigest) {
    throw new SuiTransactionShapeError(`${path}.digest`, 'does not match the effects event digest');
  }
  const parsed = array(events.events, `${path}.events`).map((eventValue, index): SuiEvent => {
    const event = record(eventValue, `${path}.events[${index}]`);
    exactKeys(event, `${path}.events[${index}]`, [
      'packageId',
      'module',
      'sender',
      'eventType',
      'contents',
      'json',
    ]);
    assertAbsentRawSuiField(event, 'json', `${path}.events[${index}]`);
    const contents = record(event.contents, `${path}.events[${index}].contents`);
    exactKeys(contents, `${path}.events[${index}].contents`, ['name', 'value']);
    if (contents.name !== undefined && typeof contents.name !== 'string') {
      throw new SuiTransactionShapeError(
        `${path}.events[${index}].contents.name`,
        'expected a string',
      );
    }
    const packageId = suiAddress(event.packageId, `${path}.events[${index}].packageId`);
    const module = string(event.module, `${path}.events[${index}].module`);
    const eventType = structTag(event.eventType, `${path}.events[${index}].eventType`);
    return Object.freeze({
      packageId,
      module,
      sender: suiAddress(event.sender, `${path}.events[${index}].sender`),
      eventType,
      bcs: bytes(contents.value, `${path}.events[${index}].contents.value`),
    });
  });
  return Object.freeze(parsed);
}

interface RawTransactionParseOptions {
  readonly expectedDigest: string;
  readonly allowMissingTopLevelDigest: boolean;
  readonly includeEvents: boolean;
}

function parseRawTransaction(
  value: unknown,
  options: RawTransactionParseOptions,
  path: string,
): SuiTransactionResult | SuiTransactionWithEventsResult {
  const envelope = parseRawSuiExecutedTransactionEnvelope(value, path);
  const transaction = envelope.transaction;
  assertEmptyRawSuiRepeatedField(envelope.signatures, `${path}.signatures`);
  assertEmptyRawSuiRepeatedField(envelope.balanceChanges, `${path}.balanceChanges`);
  for (const key of ['transaction', 'checkpoint', 'timestamp', 'objects'] as const) {
    assertAbsentRawSuiField(transaction, key, path);
  }
  if (!options.includeEvents) assertAbsentRawSuiField(transaction, 'events', path);
  const topDigest =
    transaction.digest === undefined ? undefined : digest(transaction.digest, `${path}.digest`);
  if (topDigest === undefined && !options.allowMissingTopLevelDigest) {
    throw new SuiTransactionShapeError(`${path}.digest`, 'missing request identity');
  }
  if (topDigest !== undefined && topDigest !== options.expectedDigest) {
    throw new SuiTransactionShapeError(`${path}.digest`, 'does not match the request');
  }
  const effects = parseRawEffects(transaction.effects, options.expectedDigest, `${path}.effects`);
  const base = {
    digest: options.expectedDigest,
    effects,
  } as const;
  if (options.includeEvents) {
    const events = parseRawEvents(transaction.events, `${path}.events`, effects.eventsDigest);
    if ((events.length === 0) !== (effects.eventsDigest === null)) {
      throw new SuiTransactionShapeError(
        `${path}.events`,
        'event count disagrees with the effects event digest',
      );
    }
    if (effects.status.success) return { ...base, outcome: 'success', events };
    return { ...base, outcome: 'failure', error: effects.status.error, events };
  }
  if (effects.status.success) return { ...base, outcome: 'success' };
  return { ...base, outcome: 'failure', error: effects.status.error };
}

/** @internal Parse raw simulation transaction evidence. */
export function parseRawSuiSimulationTransaction(
  value: unknown,
  expectedDigest: string,
): SuiTransactionResult {
  return parseRawTransaction(
    value,
    { expectedDigest, allowMissingTopLevelDigest: true, includeEvents: false },
    'simulation.transaction',
  ) as SuiTransactionResult;
}

function parseRawMoveViewEnvelope(value: unknown) {
  const path = 'moveView.transaction';
  const envelope = parseRawSuiExecutedTransactionEnvelope(value, path);
  const transaction = envelope.transaction;
  assertEmptyRawSuiRepeatedField(envelope.signatures, `${path}.signatures`);
  assertEmptyRawSuiRepeatedField(envelope.balanceChanges, `${path}.balanceChanges`);
  for (const key of ['digest', 'events', 'checkpoint', 'timestamp', 'objects'] as const) {
    assertAbsentRawSuiField(transaction, key, path);
  }
  const resolved = record(transaction.transaction, `${path}.transaction`);
  exactKeys(resolved, `${path}.transaction`, [
    'bcs',
    'digest',
    'version',
    'kind',
    'sender',
    'gasPayment',
    'expiration',
  ]);
  for (const key of ['version', 'kind', 'sender', 'gasPayment', 'expiration'] as const) {
    assertAbsentRawSuiField(resolved, key, `${path}.transaction`);
  }
  const resolvedTransactionDigest = digest(resolved.digest, `${path}.transaction.digest`);
  const bcs = record(resolved.bcs, `${path}.transaction.bcs`);
  exactKeys(bcs, `${path}.transaction.bcs`, ['name', 'value']);
  if (bcs.name !== 'TransactionData') {
    throw new SuiTransactionShapeError(
      `${path}.transaction.bcs.name`,
      'expected current TransactionData evidence',
    );
  }
  const valueBytes = bytes(bcs.value, `${path}.transaction.bcs.value`);
  if (valueBytes.length === 0) {
    throw new SuiTransactionShapeError(`${path}.transaction.bcs.value`, 'expected non-empty bytes');
  }
  return { transaction, bcs: valueBytes, resolvedTransactionDigest } as const;
}

/**
 * @internal Parse the self-contained Move-view transaction and status evidence.
 *
 * With checks disabled, current Sui gRPC gives the resolved TransactionData
 * its own digest while effects may carry a different simulation digest. The
 * caller binds `resolvedTransactionDigest` to `transactionBcs`; effects are
 * still parsed exactly, but do not author the resolved transaction identity.
 */
export function parseRawSuiMoveViewEvidence(value: unknown) {
  const envelope = parseRawMoveViewEnvelope(value);
  const effects = parseRawEffects(
    envelope.transaction.effects,
    undefined,
    'moveView.transaction.effects',
  );
  return Object.freeze({
    transactionBcs: envelope.bcs,
    resolvedTransactionDigest: envelope.resolvedTransactionDigest,
    status: effects.status,
  });
}

/** @internal Parse raw execution transaction evidence. */
export function parseRawSuiExecutionTransaction(
  value: unknown,
  expectedDigest: string,
): SuiTransactionWithEventsResult {
  return parseRawTransaction(
    value,
    { expectedDigest, allowMissingTopLevelDigest: false, includeEvents: true },
    'execution.transaction',
  ) as SuiTransactionWithEventsResult;
}

/** @internal Parse raw effects lookup evidence. */
export function parseRawSuiEffectsTransaction(
  value: unknown,
  expectedDigest: string,
): SuiTransactionResult {
  return parseRawTransaction(
    value,
    { expectedDigest, allowMissingTopLevelDigest: false, includeEvents: false },
    'effects.transaction',
  ) as SuiTransactionResult;
}

/** @internal Parse raw events lookup evidence. */
export function parseRawSuiEventsTransaction(
  value: unknown,
  expectedDigest: string,
): SuiTransactionWithEventsResult {
  return parseRawTransaction(
    value,
    { expectedDigest, allowMissingTopLevelDigest: false, includeEvents: true },
    'events.transaction',
  ) as SuiTransactionWithEventsResult;
}

/** @internal Parse exact raw transaction balance-change evidence. */
export function parseRawSuiBalanceChangesTransaction(
  value: unknown,
  expectedDigest: string,
): SuiTransactionBalanceChangesResult {
  const path = 'balanceChanges.transaction';
  const envelope = parseRawSuiExecutedTransactionEnvelope(value, path);
  const transaction = envelope.transaction;
  assertEmptyRawSuiRepeatedField(envelope.signatures, `${path}.signatures`);
  const transactionDigest = digest(transaction.digest, `${path}.digest`);
  if (transactionDigest !== expectedDigest) {
    throw new SuiTransactionShapeError(`${path}.digest`, 'does not match the request');
  }
  for (const key of [
    'transaction',
    'effects',
    'events',
    'checkpoint',
    'timestamp',
    'objects',
  ] as const) {
    if (transaction[key] !== undefined) {
      throw new SuiTransactionShapeError(`${path}.${key}`, 'unexpected unrequested field');
    }
  }
  const balanceChanges = Object.freeze(
    envelope.balanceChanges.map((value, index): SuiBalanceChange => {
      const itemPath = `${path}.balanceChanges[${index}]`;
      const change = record(value, itemPath);
      exactKeys(change, itemPath, ['address', 'coinType', 'amount']);
      if (typeof change.amount !== 'string' || !SIGNED_DECIMAL_RE.test(change.amount)) {
        throw new SuiTransactionShapeError(
          `${itemPath}.amount`,
          'expected a canonical signed integer',
        );
      }
      return Object.freeze({
        address: suiAddress(change.address, `${itemPath}.address`),
        coinType: structTag(change.coinType, `${itemPath}.coinType`),
        amount: change.amount,
      });
    }),
  );
  return Object.freeze({ digest: transactionDigest, balanceChanges });
}

/** @internal Parse exact raw Move-view command outputs. */
export function parseRawSuiCommandResults(
  value: unknown,
  path = 'simulation.commandOutputs',
): readonly SuiCommandResult[] {
  const results = array(value, path).map((resultValue, resultIndex): SuiCommandResult => {
    const result = record(resultValue, `${path}[${resultIndex}]`);
    exactKeys(result, `${path}[${resultIndex}]`, ['returnValues', 'mutatedByRef']);
    const parseOutputs = (outputsValue: unknown, outputPath: string): readonly SuiCommandOutput[] =>
      Object.freeze(
        array(outputsValue, outputPath).map((outputValue, outputIndex) => {
          const output = record(outputValue, `${outputPath}[${outputIndex}]`);
          exactKeys(output, `${outputPath}[${outputIndex}]`, ['argument', 'value', 'json']);
          const outputItemPath = `${outputPath}[${outputIndex}]`;
          if (output.argument !== undefined) {
            const argument = record(output.argument, `${outputItemPath}.argument`);
            exactKeys(argument, `${outputItemPath}.argument`, [
              'kind',
              'input',
              'result',
              'subresult',
            ]);
            switch (argument.kind) {
              case GrpcTypes.Argument_ArgumentKind.GAS:
                if (
                  argument.input !== undefined ||
                  argument.result !== undefined ||
                  argument.subresult !== undefined
                ) {
                  throw new SuiTransactionShapeError(
                    `${outputItemPath}.argument`,
                    'Gas argument contains an index',
                  );
                }
                break;
              case GrpcTypes.Argument_ArgumentKind.INPUT:
                u32Integer(argument.input, `${outputItemPath}.argument.input`);
                if (argument.result !== undefined || argument.subresult !== undefined) {
                  throw new SuiTransactionShapeError(
                    `${outputItemPath}.argument`,
                    'Input argument contains a result index',
                  );
                }
                break;
              case GrpcTypes.Argument_ArgumentKind.RESULT:
                u32Integer(argument.result, `${outputItemPath}.argument.result`);
                if (argument.subresult !== undefined) {
                  u32Integer(argument.subresult, `${outputItemPath}.argument.subresult`);
                }
                if (argument.input !== undefined) {
                  throw new SuiTransactionShapeError(
                    `${outputItemPath}.argument`,
                    'Result argument contains an input index',
                  );
                }
                break;
              default:
                throw new SuiTransactionShapeError(
                  `${outputItemPath}.argument.kind`,
                  'unknown current command-output argument kind',
                );
            }
          }
          if (output.json !== undefined) {
            validateRawProtoValue(output.json, `${outputItemPath}.json`);
          }
          const bcs = record(output.value, `${outputPath}[${outputIndex}].value`);
          exactKeys(bcs, `${outputPath}[${outputIndex}].value`, ['name', 'value']);
          if (bcs.name !== undefined && typeof bcs.name !== 'string') {
            throw new SuiTransactionShapeError(`${outputItemPath}.value.name`, 'expected a string');
          }
          return Object.freeze({
            bcs: bytes(bcs.value, `${outputPath}[${outputIndex}].value.value`),
          });
        }),
      );
    return Object.freeze({
      returnValues: parseOutputs(result.returnValues, `${path}[${resultIndex}].returnValues`),
      mutatedReferences: parseOutputs(result.mutatedByRef, `${path}[${resultIndex}].mutatedByRef`),
    });
  });
  return Object.freeze(results);
}

/** @internal Require the mandatory command-output array when its read mask omitted outputs. */
export function parseRawEmptySuiCommandResults(
  value: unknown,
  path = 'simulation.commandOutputs',
): void {
  const results = parseRawSuiCommandResults(value, path);
  assertEmptyRawSuiRepeatedField(results, path);
}
