import { bcs, TypeTagSerializer } from '@mysten/sui/bcs';
import type { SuiClientTypes } from '@mysten/sui/client';
import { GrpcTypes, type SuiGrpcClient } from '@mysten/sui/grpc';
import {
  deriveDynamicFieldID,
  fromBase64,
  isValidSuiAddress,
  isValidTransactionDigest,
  parseStructTag,
  normalizeStructTag,
  normalizeSuiAddress,
  SUI_ADDRESS_LENGTH,
  toBase64,
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
const RAW_OBJECT_KEYS = [
  'bcs',
  'objectId',
  'version',
  'digest',
  'owner',
  'objectType',
  'hasPublicTransfer',
  'contents',
  'package',
  'previousTransaction',
  'storageRebate',
  'json',
  'balance',
  'display',
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

export interface SuiCoinPage {
  readonly objects: readonly SuiCoin[];
  readonly hasNextPage: boolean;
  readonly cursor: string | null;
}

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

export interface SuiCoinPageOptions {
  readonly owner: string;
  readonly coinType: string;
  readonly limit?: number;
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
  exactKeys(owner, ['kind', 'address', 'version'], operation);
  switch (owner.kind) {
    case GrpcTypes.Owner_OwnerKind.ADDRESS:
      if (Object.prototype.hasOwnProperty.call(owner, 'version')) return fail(operation);
      return Object.freeze({
        $kind: 'AddressOwner',
        AddressOwner: requireResponseAddress(owner.address, operation),
      });
    case GrpcTypes.Owner_OwnerKind.OBJECT:
      if (Object.prototype.hasOwnProperty.call(owner, 'version')) return fail(operation);
      return Object.freeze({
        $kind: 'ObjectOwner',
        ObjectOwner: requireResponseAddress(owner.address, operation),
      });
    case GrpcTypes.Owner_OwnerKind.SHARED:
      if (
        Object.prototype.hasOwnProperty.call(owner, 'address') ||
        typeof owner.version !== 'bigint' ||
        owner.version < 0n
      ) {
        return fail(operation);
      }
      return Object.freeze({
        $kind: 'Shared',
        Shared: Object.freeze({ initialSharedVersion: owner.version.toString() }),
      });
    case GrpcTypes.Owner_OwnerKind.IMMUTABLE:
      if (
        Object.prototype.hasOwnProperty.call(owner, 'address') ||
        Object.prototype.hasOwnProperty.call(owner, 'version')
      ) {
        return fail(operation);
      }
      return Object.freeze({ $kind: 'Immutable', Immutable: true });
    case GrpcTypes.Owner_OwnerKind.CONSENSUS_ADDRESS:
      if (typeof owner.version !== 'bigint' || owner.version < 0n) return fail(operation);
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

function rejectPresentFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  operation: SuiOperationName,
): void {
  if (fields.some((field) => value[field] !== undefined)) fail(operation);
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
  exactKeys(union, ['oneofKind', kind], operation);
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
  exactKeys(wrapper, ['result'], operation);
  const union = exactProtobufOneof(wrapper.result, ['object', 'error'], operation);
  if (union.kind === 'error') {
    const status = record(union.payload, operation);
    exactKeys(status, ['code', 'message', 'details'], operation);
    const details = exactArray(status.details, operation);
    if (
      !Number.isInteger(status.code) ||
      (status.code as number) < -0x8000_0000 ||
      (status.code as number) > 0x7fff_ffff ||
      typeof status.message !== 'string'
    ) {
      return fail(operation);
    }
    for (const detailValue of details) {
      const detail = record(detailValue, operation);
      exactKeys(detail, ['typeUrl', 'value'], operation);
      if (typeof detail.typeUrl !== 'string' || !(detail.value instanceof Uint8Array)) {
        return fail(operation);
      }
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
  exactKeys(object, RAW_OBJECT_KEYS, operation);
  rejectPresentFields(
    object,
    [
      'bcs',
      'hasPublicTransfer',
      'contents',
      'package',
      'previousTransaction',
      'storageRebate',
      'balance',
      'display',
    ],
    operation,
  );
  const objectId = requireResponseAddress(object.objectId, operation);
  if (objectId !== expectedId) return fail(operation);
  if (typeof object.version !== 'bigint' || object.version < 0n) return fail(operation);
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
  const responseRecord = record(response, objectIds.length === 1 ? 'get_object' : 'get_objects');
  exactKeys(responseRecord, ['objects'], objectIds.length === 1 ? 'get_object' : 'get_objects');
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
  exactKeys(object as unknown as Record<string, unknown>, RAW_OBJECT_KEYS, operation);
  if (typeof object.version !== 'bigint' || object.version < 0n) return fail(operation);
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
  if (object.contents !== undefined) {
    exactKeys(object.contents as unknown as Record<string, unknown>, ['name', 'value'], operation);
    if (object.contents.name !== undefined && typeof object.contents.name !== 'string') {
      return fail(operation);
    }
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
      const responseRecord = record(response, 'get_dynamic_field');
      exactKeys(responseRecord, ['objects'], 'get_dynamic_field');
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
  exactKeys(coin, RAW_OBJECT_KEYS, 'list_coins');
  rejectPresentFields(
    coin,
    [
      'bcs',
      'hasPublicTransfer',
      'contents',
      'package',
      'previousTransaction',
      'storageRebate',
      'json',
      'display',
    ],
    'list_coins',
  );
  const objectId = requireResponseAddress(coin.objectId, 'list_coins');
  if (typeof coin.version !== 'bigint' || coin.version < 0n) return fail('list_coins');
  const digest = requireDigest(coin.digest, 'list_coins');
  const currentOwner = validateRawOwner(coin.owner, 'list_coins');
  if (
    currentOwner.$kind !== 'AddressOwner' ||
    normalizeSuiAddress(currentOwner.AddressOwner) !== owner
  ) {
    return fail('list_coins');
  }
  const actualType = requireResponseCoinType(coin.objectType, 'list_coins');
  if (actualType !== expectedType || typeof coin.balance !== 'bigint' || coin.balance < 0n) {
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
  readonly limit: number;
}

function normalizeCoinPageOptions(options: SuiCoinPageOptions): NormalizedCoinPageOptions {
  const owner = requireAddress(options.owner);
  const coinType = requireCoinType(options.coinType);
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError('Sui coin page limit must be an integer from 1 through 50');
  }
  return { owner, coinType, limit };
}

async function readCoinPageFromClient(
  client: SuiGrpcClient,
  options: NormalizedCoinPageOptions,
  cursor: string | null,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<SuiCoinPage> {
  const objectType = normalizeStructTag(`0x2::coin::Coin<${options.coinType}>`);
  const { response } = await client.stateService.listOwnedObjects(
    {
      owner: options.owner,
      objectType,
      pageSize: options.limit,
      pageToken: cursor === null ? undefined : fromBase64(cursor),
      readMask: { paths: [...COIN_READ_MASK] },
    },
    { timeout: timeoutMs, abort: signal },
  );
  const responseRecord = record(response, 'list_coins');
  exactKeys(responseRecord, ['objects', 'nextPageToken'], 'list_coins');
  const responseObjects = exactArray(response.objects, 'list_coins');
  if (responseObjects.length > options.limit) return fail('list_coins');
  let nextCursor = null as string | null;
  if (response.nextPageToken !== undefined) {
    if (!(response.nextPageToken instanceof Uint8Array) || response.nextPageToken.length === 0) {
      return fail('list_coins');
    }
    nextCursor = toBase64(response.nextPageToken);
  }
  if (cursor !== null && nextCursor === cursor) return fail('list_coins');
  const objects = responseObjects.map((coin) => validateCoin(coin, options.owner, objectType));
  const ids = objects.map((coin) => normalizeSuiAddress(coin.objectId));
  if (new Set(ids).size !== ids.length) return fail('list_coins');
  return Object.freeze({
    objects: Object.freeze(objects),
    hasNextPage: nextCursor !== null,
    cursor: nextCursor,
  });
}

/** Consume all current coin pages with cursor and object-identity cycle detection. */
export async function listAllSuiCoins(
  snapshot: SuiEndpointSnapshot,
  options: SuiCoinPageOptions,
): Promise<readonly SuiCoin[]> {
  const normalized = normalizeCoinPageOptions(options);
  return runSuiReadOperation(snapshot, 'list_coins', options.signal, async (client, context) => {
    const objects: SuiCoin[] = [];
    const seenCursors = new Set<string>();
    const seenObjects = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      context.assertActive();
      const page = await readCoinPageFromClient(
        client,
        normalized,
        cursor,
        context.signal,
        context.timeoutMs,
      );
      context.assertActive();
      for (const coin of page.objects) {
        const id = normalizeSuiAddress(coin.objectId);
        if (seenObjects.has(id)) throw malformedSuiResponse('list_coins');
        seenObjects.add(id);
        objects.push(coin);
      }
      if (!page.hasNextPage) return Object.freeze(objects);
      if (page.cursor === null || seenCursors.has(page.cursor)) {
        throw malformedSuiResponse('list_coins');
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
  });
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
      const responseRecord = record(response, 'get_coin_metadata');
      exactKeys(
        responseRecord,
        ['coinType', 'metadata', 'treasury', 'regulatedMetadata'],
        'get_coin_metadata',
      );
      if (
        typeof response.coinType !== 'string' ||
        requireResponseCoinType(response.coinType, 'get_coin_metadata') !== coinType
      ) {
        return fail('get_coin_metadata');
      }
      if (!response.metadata) throw suiResourceNotFound('get_coin_metadata', coinType);
      const metadata = response.metadata;
      exactKeys(
        metadata as unknown as Record<string, unknown>,
        [
          'id',
          'decimals',
          'name',
          'symbol',
          'description',
          'iconUrl',
          'metadataCapId',
          'metadataCapState',
        ],
        'get_coin_metadata',
      );
      if (response.treasury !== undefined) {
        exactKeys(
          response.treasury as unknown as Record<string, unknown>,
          ['id', 'totalSupply', 'supplyState'],
          'get_coin_metadata',
        );
        if (
          (response.treasury.id !== undefined &&
            requireResponseAddress(response.treasury.id, 'get_coin_metadata').length === 0) ||
          (response.treasury.totalSupply !== undefined &&
            (typeof response.treasury.totalSupply !== 'bigint' ||
              response.treasury.totalSupply < 0n)) ||
          (response.treasury.supplyState !== undefined &&
            ![0, 1, 2].includes(response.treasury.supplyState))
        ) {
          return fail('get_coin_metadata');
        }
      }
      if (response.regulatedMetadata !== undefined) {
        exactKeys(
          response.regulatedMetadata as unknown as Record<string, unknown>,
          [
            'id',
            'coinMetadataObject',
            'denyCapObject',
            'allowGlobalPause',
            'variant',
            'coinRegulatedState',
          ],
          'get_coin_metadata',
        );
        for (const id of [
          response.regulatedMetadata.id,
          response.regulatedMetadata.coinMetadataObject,
          response.regulatedMetadata.denyCapObject,
        ]) {
          if (id !== undefined) requireResponseAddress(id, 'get_coin_metadata');
        }
        if (
          (response.regulatedMetadata.allowGlobalPause !== undefined &&
            typeof response.regulatedMetadata.allowGlobalPause !== 'boolean') ||
          (response.regulatedMetadata.variant !== undefined &&
            (!Number.isInteger(response.regulatedMetadata.variant) ||
              response.regulatedMetadata.variant < 0 ||
              response.regulatedMetadata.variant > 0xffff_ffff)) ||
          (response.regulatedMetadata.coinRegulatedState !== undefined &&
            ![0, 1, 2].includes(response.regulatedMetadata.coinRegulatedState))
        ) {
          return fail('get_coin_metadata');
        }
      }
      for (const id of [metadata.id, metadata.metadataCapId]) {
        if (id !== undefined) requireResponseAddress(id, 'get_coin_metadata');
      }
      for (const value of [metadata.name, metadata.description, metadata.iconUrl]) {
        if (value !== undefined) requireString(value, 'get_coin_metadata', true);
      }
      if (
        metadata.metadataCapState !== undefined &&
        ![0, 1, 2, 3].includes(metadata.metadataCapState)
      ) {
        return fail('get_coin_metadata');
      }
      if (
        !Number.isInteger(metadata.decimals) ||
        metadata.decimals! < 0 ||
        metadata.decimals! > 255
      ) {
        return fail('get_coin_metadata');
      }
      const symbol = requireString(metadata.symbol, 'get_coin_metadata');
      return Object.freeze({
        decimals: metadata.decimals!,
        symbol,
      });
    },
  );
}

/** Read a balance without accepting SDK-synthesized zero placeholders. */
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
    const responseRecord = record(response, 'get_balance');
    exactKeys(responseRecord, ['balance'], 'get_balance');
    const balance = response.balance;
    if (balance !== undefined) {
      exactKeys(
        balance as unknown as Record<string, unknown>,
        ['coinType', 'balance', 'addressBalance', 'coinBalance'],
        'get_balance',
      );
    }
    if (
      !balance ||
      typeof balance.coinType !== 'string' ||
      requireResponseCoinType(balance.coinType, 'get_balance') !== coinType ||
      typeof balance.balance !== 'bigint' ||
      typeof balance.coinBalance !== 'bigint' ||
      typeof balance.addressBalance !== 'bigint' ||
      balance.balance < 0n ||
      balance.coinBalance < 0n ||
      balance.addressBalance < 0n ||
      balance.balance !== balance.coinBalance + balance.addressBalance
    ) {
      return fail('get_balance');
    }
    return Object.freeze({
      coinType,
      balance: balance.balance.toString(),
      coinBalance: balance.coinBalance.toString(),
      addressBalance: balance.addressBalance.toString(),
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
      const responseRecord = record(response, 'get_chain_identifier');
      exactKeys(
        responseRecord,
        [
          'chainId',
          'chain',
          'epoch',
          'checkpointHeight',
          'timestamp',
          'lowestAvailableCheckpoint',
          'lowestAvailableCheckpointObjects',
          'server',
        ],
        'get_chain_identifier',
      );
      if (response.timestamp !== undefined) {
        exactKeys(
          response.timestamp as unknown as Record<string, unknown>,
          ['seconds', 'nanos'],
          'get_chain_identifier',
        );
        if (
          typeof response.timestamp.seconds !== 'bigint' ||
          !Number.isInteger(response.timestamp.nanos) ||
          response.timestamp.nanos < 0 ||
          response.timestamp.nanos > 999_999_999
        ) {
          return fail('get_chain_identifier');
        }
      }
      for (const value of [
        response.epoch,
        response.checkpointHeight,
        response.lowestAvailableCheckpoint,
        response.lowestAvailableCheckpointObjects,
      ]) {
        if (value !== undefined && (typeof value !== 'bigint' || value < 0n)) {
          return fail('get_chain_identifier');
        }
      }
      for (const value of [response.chain, response.server]) {
        if (value !== undefined) requireString(value, 'get_chain_identifier', true);
      }
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
