import { bcs, TypeTagSerializer } from '@mysten/sui/bcs';
import type { SuiClientTypes } from '@mysten/sui/client';
import { GrpcTypes, type SuiGrpcClient } from '@mysten/sui/grpc';
import {
  deriveDynamicFieldID,
  isValidSuiAddress,
  isValidTransactionDigest,
  parseStructTag,
  normalizeStructTag,
  normalizeSuiAddress,
  SUI_ADDRESS_LENGTH,
} from '@mysten/sui/utils';
import {
  malformedSuiResponse,
  runSuiReadOperation,
  SuiOperationError,
  suiResourceNotFound,
  type SuiEndpointSnapshot,
  type SuiOperationName,
} from './suiOperation.js';
import { assertExactSuiShapeKeys, parseExactSuiArray } from './suiTransactionShape.js';
import { isSuiU64 } from './suiU64.js';

const GRPC_NOT_FOUND = 5;
const OBJECT_READ_MASK = [
  'owner',
  'object_type',
  'digest',
  'version',
  'object_id',
  'json',
] as const;
const DYNAMIC_FIELD_READ_MASK = [
  'object_id',
  'object_type',
  'digest',
  'version',
  'previous_transaction',
  'contents',
] as const;
const COIN_READ_MASK = [
  'owner',
  'object_type',
  'digest',
  'version',
  'object_id',
  'balance',
] as const;
export interface SuiObject {
  readonly objectId: string;
  readonly version: string;
  readonly digest: string;
  readonly owner: SuiClientTypes.ObjectOwner;
  readonly type: string;
  readonly json: Record<string, unknown> | null;
}
export type SuiDynamicField = SuiClientTypes.DynamicField;
export type SuiCoin = SuiClientTypes.Coin;

export const MAX_SUI_COIN_OBJECTS_PER_OPERATION = 50;

export type SuiCoinReadResult =
  | { readonly status: 'complete'; readonly coins: readonly SuiCoin[] }
  | { readonly status: 'limit_exceeded'; readonly coins: readonly SuiCoin[] };

export interface SuiCoinMetadata {
  readonly decimals: number;
  readonly symbol: string;
}

export interface SuiBalance {
  readonly coinType: string;
  readonly balance: string;
  readonly coinBalance: string;
  readonly addressBalance: string;
}

export interface SuiObjectOptions {
  readonly objectId: string;
  readonly signal?: AbortSignal;
}

export interface SuiObjectsOptions {
  readonly objectIds: readonly string[];
  readonly signal?: AbortSignal;
}

export interface SuiDynamicFieldOptions {
  readonly parentId: string;
  readonly name: SuiClientTypes.DynamicFieldName;
  readonly signal?: AbortSignal;
}

export interface SuiCoinReadOptions {
  readonly owner: string;
  readonly coinType: string;
  readonly signal?: AbortSignal;
}

export interface SuiCoinMetadataOptions {
  readonly coinType: string;
  readonly signal?: AbortSignal;
}

export interface SuiBalanceOptions {
  readonly owner: string;
  readonly coinType?: string;
  readonly signal?: AbortSignal;
}

export interface SuiNetworkExpectation {
  readonly network: string;
  readonly chainIdentifier: string;
  readonly signal?: AbortSignal;
}

function fail(operation: SuiOperationName): never {
  throw malformedSuiResponse(operation);
}

function requireAddress(value: unknown): string {
  if (typeof value !== 'string' || !isValidSuiAddress(value))
    throw new TypeError('Invalid Sui address');
  return normalizeSuiAddress(value);
}

function requireResponseAddress(value: unknown, operation: SuiOperationName): string {
  if (typeof value !== 'string' || !isValidSuiAddress(value)) return fail(operation);
  return normalizeSuiAddress(value);
}

function requireDigest(value: unknown, operation: SuiOperationName): string {
  if (typeof value !== 'string' || !isValidTransactionDigest(value)) return fail(operation);
  return value;
}

function requireString(value: unknown, operation: SuiOperationName, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) return fail(operation);
  return value;
}

function requireCoinType(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('Invalid Sui coin type');
  try {
    return normalizeStructTag(value);
  } catch {
    throw new TypeError('Invalid Sui coin type');
  }
}

function requireResponseCoinType(value: unknown, operation: SuiOperationName): string {
  if (typeof value !== 'string' || value.length === 0) return fail(operation);
  try {
    return normalizeStructTag(value);
  } catch {
    return fail(operation);
  }
}

function validateRawOwner(value: unknown, operation: SuiOperationName): SuiClientTypes.ObjectOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(operation);
  const owner = value as Record<string, unknown>;
  switch (owner.kind) {
    case GrpcTypes.Owner_OwnerKind.ADDRESS:
      return Object.freeze({
        $kind: 'AddressOwner',
        AddressOwner: requireResponseAddress(owner.address, operation),
      });
    case GrpcTypes.Owner_OwnerKind.OBJECT:
      return Object.freeze({
        $kind: 'ObjectOwner',
        ObjectOwner: requireResponseAddress(owner.address, operation),
      });
    case GrpcTypes.Owner_OwnerKind.SHARED:
      if (!isSuiU64(owner.version)) {
        return fail(operation);
      }
      return Object.freeze({
        $kind: 'Shared',
        Shared: Object.freeze({ initialSharedVersion: owner.version.toString() }),
      });
    case GrpcTypes.Owner_OwnerKind.IMMUTABLE:
      return Object.freeze({ $kind: 'Immutable', Immutable: true });
    case GrpcTypes.Owner_OwnerKind.CONSENSUS_ADDRESS:
      if (!isSuiU64(owner.version)) return fail(operation);
      return Object.freeze({
        $kind: 'ConsensusAddressOwner',
        ConsensusAddressOwner: Object.freeze({
          owner: requireResponseAddress(owner.address, operation),
          startVersion: owner.version.toString(),
        }),
      });
    default:
      return fail(operation);
  }
}

function record(value: unknown, operation: SuiOperationName): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(operation);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  operation: SuiOperationName,
): void {
  try {
    assertExactSuiShapeKeys(value, operation, allowed);
  } catch {
    fail(operation);
  }
}

function exactArray(value: unknown, operation: SuiOperationName): unknown[] {
  try {
    return parseExactSuiArray(value, operation);
  } catch {
    return fail(operation);
  }
}

function exactProtobufOneof(
  value: unknown,
  variants: readonly string[],
  operation: SuiOperationName,
): { readonly kind: string; readonly payload: unknown } {
  const union = record(value, operation);
  const kind = union.oneofKind;
  if (typeof kind !== 'string' || !variants.includes(kind)) return fail(operation);
  for (const variant of variants) {
    if (variant === kind) {
      if (!Object.prototype.hasOwnProperty.call(union, variant) || union[variant] === undefined) {
        return fail(operation);
      }
    } else if (Object.prototype.hasOwnProperty.call(union, variant)) {
      return fail(operation);
    }
  }
  return { kind, payload: union[kind] };
}

function parseProtoJsonValue(value: unknown, operation: SuiOperationName): unknown {
  const wrapped = record(value, operation);
  exactKeys(wrapped, ['kind'], operation);
  const kind = exactProtobufOneof(
    wrapped.kind,
    ['nullValue', 'numberValue', 'stringValue', 'boolValue', 'structValue', 'listValue'],
    operation,
  );
  const oneofKind = kind.kind;
  switch (oneofKind) {
    case 'nullValue':
      if (kind.payload !== 0) return fail(operation);
      return null;
    case 'numberValue':
      if (typeof kind.payload !== 'number' || !Number.isFinite(kind.payload)) {
        return fail(operation);
      }
      return kind.payload;
    case 'stringValue':
      return requireString(kind.payload, operation, true);
    case 'boolValue':
      if (typeof kind.payload !== 'boolean') return fail(operation);
      return kind.payload;
    case 'listValue': {
      const list = record(kind.payload, operation);
      exactKeys(list, ['values'], operation);
      return Object.freeze(
        exactArray(list.values, operation).map((entry) => parseProtoJsonValue(entry, operation)),
      );
    }
    case 'structValue': {
      const struct = record(kind.payload, operation);
      exactKeys(struct, ['fields'], operation);
      const fields = record(struct.fields, operation);
      return Object.freeze(
        Object.fromEntries(
          Object.entries(fields).map(([key, entry]) => [
            key,
            parseProtoJsonValue(entry, operation),
          ]),
        ),
      );
    }
    default:
      return fail(operation);
  }
}

function parseObjectJson(
  value: unknown,
  operation: 'get_object' | 'get_objects',
): Record<string, unknown> | null {
  if (value === undefined) return null;
  const parsed = parseProtoJsonValue(value, operation);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return fail(operation);
  return parsed as Record<string, unknown>;
}

function parseRawObjectResult(
  result: unknown,
  expectedId: string,
  operation: 'get_object' | 'get_objects' | 'get_dynamic_field',
): GrpcTypes.Object {
  const wrapper = record(result, operation);
  const union = exactProtobufOneof(wrapper.result, ['object', 'error'], operation);
  if (union.kind === 'error') {
    const status = record(union.payload, operation);
    if (
      !Number.isInteger(status.code) ||
      (status.code as number) < -0x8000_0000 ||
      (status.code as number) > 0x7fff_ffff
    ) {
      return fail(operation);
    }
    if (status.code === GRPC_NOT_FOUND) throw suiResourceNotFound(operation, expectedId);
    return fail(operation);
  }
  const object = record(union.payload, operation);
  if (requireResponseAddress(object.objectId, operation) !== expectedId) return fail(operation);
  return object as GrpcTypes.Object;
}

function validateObject(
  value: unknown,
  expectedId: string,
  operation: 'get_object' | 'get_objects',
): SuiObject {
  const object = value as Record<string, unknown>;
  const objectId = requireResponseAddress(object.objectId, operation);
  if (objectId !== expectedId) return fail(operation);
  if (!isSuiU64(object.version)) return fail(operation);
  const digest = requireDigest(object.digest, operation);
  const owner = validateRawOwner(object.owner, operation);
  const rawType = requireString(object.objectType, operation);
  const type = rawType === 'package' ? rawType : requireResponseCoinType(rawType, operation);
  const json = parseObjectJson(object.json, operation);
  return Object.freeze({
    objectId,
    version: object.version.toString(),
    digest,
    owner,
    type,
    json,
  });
}

async function readObjectsFromClient(
  client: SuiGrpcClient,
  objectIds: readonly string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<readonly SuiObject[]> {
  const { response } = await client.ledgerService.batchGetObjects(
    {
      requests: objectIds.map((objectId) => ({ objectId })),
      readMask: { paths: [...OBJECT_READ_MASK] },
    },
    { timeout: timeoutMs, abort: signal },
  );
  record(response, objectIds.length === 1 ? 'get_object' : 'get_objects');
  const responseObjects = exactArray(
    response.objects,
    objectIds.length === 1 ? 'get_object' : 'get_objects',
  );
  if (responseObjects.length !== objectIds.length) {
    return fail(objectIds.length === 1 ? 'get_object' : 'get_objects');
  }
  return Object.freeze(
    responseObjects.map((result, index) => {
      const operation = objectIds.length === 1 ? 'get_object' : 'get_objects';
      const object = parseRawObjectResult(result, objectIds[index]!, operation);
      return validateObject(object, objectIds[index]!, operation);
    }),
  );
}

/** Read one exact object with JSON content requested. */
export function getSuiObject(
  snapshot: SuiEndpointSnapshot,
  options: SuiObjectOptions,
): Promise<SuiObject> {
  const objectId = requireAddress(options.objectId);
  return runSuiReadOperation(snapshot, 'get_object', options.signal, async (client, context) => {
    const objects = await readObjectsFromClient(
      client,
      [objectId],
      context.signal,
      context.timeoutMs,
    );
    return objects[0]!;
  });
}

/** Read at most one raw SDK batch (50 objects) and bind every result by position. */
export function getSuiObjects(
  snapshot: SuiEndpointSnapshot,
  options: SuiObjectsOptions,
): Promise<readonly SuiObject[]> {
  if (
    !Array.isArray(options.objectIds) ||
    options.objectIds.length === 0 ||
    options.objectIds.length > 50
  ) {
    throw new TypeError('Sui object batch requires between 1 and 50 object IDs');
  }
  const objectIds = parseExactSuiArray(options.objectIds, 'objectIds').map(requireAddress);
  if (new Set(objectIds).size !== objectIds.length) {
    throw new TypeError('Sui object batch contains duplicate object IDs');
  }
  return runSuiReadOperation(snapshot, 'get_objects', options.signal, (client, context) =>
    readObjectsFromClient(client, objectIds, context.signal, context.timeoutMs),
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function normalizeDynamicFieldNameType(value: string): {
  readonly tag: ReturnType<typeof TypeTagSerializer.parseFromStr>;
  readonly name: string;
} {
  try {
    const tag = TypeTagSerializer.parseFromStr(value, true);
    return { tag, name: TypeTagSerializer.tagToString(tag) };
  } catch {
    throw new TypeError('Invalid Sui dynamic-field name');
  }
}

function parseRawDynamicField(
  object: GrpcTypes.Object,
  fieldId: string,
  nameType: string,
  nameBcs: Uint8Array,
): SuiDynamicField {
  const operation = 'get_dynamic_field';
  if (!isSuiU64(object.version)) return fail(operation);
  const digest = requireDigest(object.digest, operation);
  const previousTransaction = requireDigest(object.previousTransaction, operation);
  const rawType = requireString(object.objectType, operation);
  let fieldType: ReturnType<typeof parseStructTag>;
  try {
    fieldType = parseStructTag(rawType);
  } catch {
    return fail(operation);
  }
  if (
    normalizeSuiAddress(fieldType.address) !== normalizeSuiAddress('0x2') ||
    fieldType.module !== 'dynamic_field' ||
    fieldType.name !== 'Field' ||
    fieldType.typeParams.length !== 2
  ) {
    return fail(operation);
  }
  const [rawNameType, rawValueType] = fieldType.typeParams;
  const isDynamicObject =
    typeof rawNameType !== 'string' &&
    normalizeSuiAddress(rawNameType.address) === normalizeSuiAddress('0x2') &&
    rawNameType.module === 'dynamic_object_field' &&
    rawNameType.name === 'Wrapper' &&
    rawNameType.typeParams.length === 1;
  const actualNameType = isDynamicObject ? rawNameType.typeParams[0] : rawNameType;
  const resolvedNameType =
    typeof actualNameType === 'string' ? actualNameType : normalizeStructTag(actualNameType);
  if (resolvedNameType !== nameType) return fail(operation);
  const valueType =
    typeof rawValueType === 'string' ? rawValueType : normalizeStructTag(rawValueType);
  if (isDynamicObject && valueType !== normalizeStructTag('0x2::object::ID')) {
    return fail(operation);
  }
  const contents = object.contents?.value;
  if (!(contents instanceof Uint8Array)) return fail(operation);
  const prefixLength = SUI_ADDRESS_LENGTH + nameBcs.length;
  if (contents.length <= prefixLength) return fail(operation);
  const embeddedId = bcs.Address.parse(contents.slice(0, SUI_ADDRESS_LENGTH));
  if (normalizeSuiAddress(embeddedId) !== fieldId) return fail(operation);
  if (!bytesEqual(contents.slice(SUI_ADDRESS_LENGTH, prefixLength), nameBcs)) {
    return fail(operation);
  }
  const valueBcs = contents.slice(prefixLength);
  let childId: string | undefined;
  if (isDynamicObject) {
    if (valueBcs.length !== SUI_ADDRESS_LENGTH) return fail(operation);
    childId = normalizeSuiAddress(bcs.Address.parse(valueBcs));
  }
  const common = {
    fieldId,
    type: normalizeStructTag(fieldType),
    name: Object.freeze({ type: nameType, bcs: nameBcs.slice() }),
    valueType,
    value: Object.freeze({ type: valueType, bcs: valueBcs }),
    version: object.version.toString(),
    digest,
    previousTransaction,
  } as const;
  return Object.freeze(
    isDynamicObject
      ? { ...common, $kind: 'DynamicObject' as const, childId: childId! }
      : { ...common, $kind: 'DynamicField' as const },
  );
}

/** Read and validate one current dynamic field. */
export function getSuiDynamicField(
  snapshot: SuiEndpointSnapshot,
  options: SuiDynamicFieldOptions,
): Promise<SuiDynamicField> {
  const parentId = requireAddress(options.parentId);
  if (
    typeof options.name !== 'object' ||
    options.name === null ||
    typeof options.name.type !== 'string' ||
    options.name.type.length === 0 ||
    !(options.name.bcs instanceof Uint8Array)
  ) {
    throw new TypeError('Invalid Sui dynamic-field name');
  }
  const normalizedName = normalizeDynamicFieldNameType(options.name.type);
  const fieldId = normalizeSuiAddress(
    deriveDynamicFieldID(parentId, normalizedName.tag, options.name.bcs),
  );
  return runSuiReadOperation(
    snapshot,
    'get_dynamic_field',
    options.signal,
    async (client, context) => {
      const { response } = await client.ledgerService.batchGetObjects(
        {
          requests: [{ objectId: fieldId }],
          readMask: { paths: [...DYNAMIC_FIELD_READ_MASK] },
        },
        { timeout: context.timeoutMs, abort: context.signal },
      );
      record(response, 'get_dynamic_field');
      const objects = exactArray(response.objects, 'get_dynamic_field');
      if (objects.length !== 1) return fail('get_dynamic_field');
      const object = parseRawObjectResult(objects[0], fieldId, 'get_dynamic_field');
      return parseRawDynamicField(object, fieldId, normalizedName.name, options.name.bcs);
    },
  );
}

function validateCoin(value: unknown, owner: string, expectedType: string): SuiCoin {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return fail('list_coins');
  const coin = value as Record<string, unknown>;
  const objectId = requireResponseAddress(coin.objectId, 'list_coins');
  if (!isSuiU64(coin.version)) return fail('list_coins');
  const digest = requireDigest(coin.digest, 'list_coins');
  const currentOwner = validateRawOwner(coin.owner, 'list_coins');
  if (
    currentOwner.$kind !== 'AddressOwner' ||
    normalizeSuiAddress(currentOwner.AddressOwner) !== owner
  ) {
    return fail('list_coins');
  }
  const actualType = requireResponseCoinType(coin.objectType, 'list_coins');
  if (actualType !== expectedType || !isSuiU64(coin.balance)) {
    return fail('list_coins');
  }
  return Object.freeze({
    objectId,
    version: coin.version.toString(),
    digest,
    owner: currentOwner,
    type: actualType,
    balance: coin.balance.toString(),
  });
}

interface NormalizedCoinPageOptions {
  readonly owner: string;
  readonly coinType: string;
}

function normalizeCoinReadOptions(options: SuiCoinReadOptions): NormalizedCoinPageOptions {
  const owner = requireAddress(options.owner);
  const coinType = requireCoinType(options.coinType);
  return { owner, coinType };
}

async function readBoundedCoinPageFromClient(
  client: SuiGrpcClient,
  options: NormalizedCoinPageOptions,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<SuiCoinReadResult> {
  const objectType = normalizeStructTag(`0x2::coin::Coin<${options.coinType}>`);
  const { response } = await client.stateService.listOwnedObjects(
    {
      owner: options.owner,
      objectType,
      pageSize: MAX_SUI_COIN_OBJECTS_PER_OPERATION,
      readMask: { paths: [...COIN_READ_MASK] },
    },
    { timeout: timeoutMs, abort: signal },
  );
  record(response, 'list_coins');
  const responseObjects = exactArray(response.objects, 'list_coins');
  if (responseObjects.length > MAX_SUI_COIN_OBJECTS_PER_OPERATION) return fail('list_coins');
  let hasNextPage = false;
  if (response.nextPageToken !== undefined) {
    if (!(response.nextPageToken instanceof Uint8Array) || response.nextPageToken.length === 0) {
      return fail('list_coins');
    }
    hasNextPage = true;
  }
  const objects = responseObjects.map((coin) => validateCoin(coin, options.owner, objectType));
  const ids = objects.map((coin) => normalizeSuiAddress(coin.objectId));
  if (new Set(ids).size !== ids.length) return fail('list_coins');
  return Object.freeze({
    status: hasNextPage ? 'limit_exceeded' : 'complete',
    coins: Object.freeze(objects),
  });
}

/** Read at most one endpoint-consistent page of current coin objects. */
export function readBoundedSuiCoins(
  snapshot: SuiEndpointSnapshot,
  options: SuiCoinReadOptions,
): Promise<SuiCoinReadResult> {
  const normalized = normalizeCoinReadOptions(options);
  return runSuiReadOperation(snapshot, 'list_coins', options.signal, (client, context) =>
    readBoundedCoinPageFromClient(client, normalized, context.signal, context.timeoutMs),
  );
}

/** Read coin metadata without accepting SDK-synthesized zero/empty placeholders. */
export function getSuiCoinMetadata(
  snapshot: SuiEndpointSnapshot,
  options: SuiCoinMetadataOptions,
): Promise<SuiCoinMetadata> {
  const coinType = requireCoinType(options.coinType);
  return runSuiReadOperation(
    snapshot,
    'get_coin_metadata',
    options.signal,
    async (client, context) => {
      const { response } = await client.stateService.getCoinInfo(
        { coinType },
        { timeout: context.timeoutMs, abort: context.signal },
      );
      record(response, 'get_coin_metadata');
      if (
        typeof response.coinType !== 'string' ||
        requireResponseCoinType(response.coinType, 'get_coin_metadata') !== coinType
      ) {
        return fail('get_coin_metadata');
      }
      if (!response.metadata) throw suiResourceNotFound('get_coin_metadata', coinType);
      const metadata = record(response.metadata, 'get_coin_metadata');
      if (
        !Number.isInteger(metadata.decimals) ||
        (metadata.decimals as number) < 0 ||
        (metadata.decimals as number) > 255
      ) {
        return fail('get_coin_metadata');
      }
      const symbol = requireString(metadata.symbol, 'get_coin_metadata');
      return Object.freeze({
        decimals: metadata.decimals as number,
        symbol,
      });
    },
  );
}

/** Read one exact Sui balance, restoring protobuf-omitted zero components. */
export function getSuiBalance(
  snapshot: SuiEndpointSnapshot,
  options: SuiBalanceOptions,
): Promise<SuiBalance> {
  const owner = requireAddress(options.owner);
  const coinType =
    options.coinType === undefined
      ? requireCoinType('0x2::sui::SUI')
      : requireCoinType(options.coinType);
  return runSuiReadOperation(snapshot, 'get_balance', options.signal, async (client, context) => {
    const { response } = await client.stateService.getBalance(
      { owner, coinType },
      { timeout: context.timeoutMs, abort: context.signal },
    );
    record(response, 'get_balance');
    const balance = response.balance;
    const coinBalance = balance?.coinBalance === undefined ? 0n : balance.coinBalance;
    const addressBalance = balance?.addressBalance === undefined ? 0n : balance.addressBalance;
    if (
      !balance ||
      typeof balance.coinType !== 'string' ||
      requireResponseCoinType(balance.coinType, 'get_balance') !== coinType ||
      !isSuiU64(balance.balance) ||
      !isSuiU64(coinBalance) ||
      !isSuiU64(addressBalance) ||
      balance.balance !== coinBalance + addressBalance
    ) {
      return fail('get_balance');
    }
    return Object.freeze({
      coinType,
      balance: balance.balance.toString(),
      coinBalance: coinBalance.toString(),
      addressBalance: addressBalance.toString(),
    });
  });
}

/** Read the exact chain identifier through the qualified endpoint set. */
export function getSuiChainIdentifier(
  snapshot: SuiEndpointSnapshot,
  options: { readonly signal?: AbortSignal } = {},
): Promise<{ readonly chainIdentifier: string }> {
  return runSuiReadOperation(
    snapshot,
    'get_chain_identifier',
    options.signal,
    async (client, context) => {
      const { response } = await client.ledgerService.getServiceInfo(
        {},
        { timeout: context.timeoutMs, abort: context.signal },
      );
      record(response, 'get_chain_identifier');
      return Object.freeze({
        chainIdentifier: requireDigest(response.chainId, 'get_chain_identifier'),
      });
    },
  );
}

/** Prove declared and live chain identity before a product enables signing. */
export async function assertSuiNetwork(
  snapshot: SuiEndpointSnapshot,
  expected: SuiNetworkExpectation,
): Promise<void> {
  if (
    typeof expected.network !== 'string' ||
    expected.network.length === 0 ||
    !isValidTransactionDigest(expected.chainIdentifier)
  ) {
    throw new TypeError('Invalid expected Sui network identity');
  }
  if (snapshot.network !== expected.network) {
    throw new SuiOperationError('invalid_request', {
      operation: 'get_chain_identifier',
      attempt: 1,
      maxAttempts: snapshot.endpointCount,
    });
  }
  const actual = await getSuiChainIdentifier(snapshot, { signal: expected.signal });
  if (actual.chainIdentifier !== expected.chainIdentifier) {
    throw malformedSuiResponse('get_chain_identifier');
  }
}
