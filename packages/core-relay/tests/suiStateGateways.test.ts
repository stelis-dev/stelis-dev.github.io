import { bcs, TypeTagSerializer } from '@mysten/sui/bcs';
import { GrpcTypes, type SuiGrpcClient } from '@mysten/sui/grpc';
import { deriveDynamicFieldID, normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import { describe, expect, it, vi } from 'vitest';
import { createSuiEndpointSnapshot, SuiOperationError } from '../src/sui/suiOperation.js';
import {
  getSuiBalance,
  getSuiCoinMetadata,
  getSuiDynamicField,
  getSuiChainIdentifier,
  getSuiObject,
  getSuiObjects,
  MAX_SUI_COIN_OBJECTS_PER_OPERATION,
  readBoundedSuiCoins,
} from '../src/sui/suiStateGateways.js';

const OWNER = `0x${'11'.repeat(32)}`;
const OBJECT_ID = `0x${'22'.repeat(32)}`;
const METADATA_ID = `0x${'33'.repeat(32)}`;
const DIGEST = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD';
const COIN_TYPE = normalizeStructTag('0x2::sui::SUI');
const COIN_OBJECT_TYPE = normalizeStructTag(`0x2::coin::Coin<${COIN_TYPE}>`);
const NEXT_PAGE_TOKEN = new Uint8Array([1, 2, 3]);

function client(value: Record<string, unknown>): SuiGrpcClient {
  return { network: 'testnet', ...value } as unknown as SuiGrpcClient;
}

function protoValue(value: unknown): unknown {
  if (value === null) return { kind: { oneofKind: 'nullValue', nullValue: 0 } };
  if (typeof value === 'string') return { kind: { oneofKind: 'stringValue', stringValue: value } };
  if (typeof value === 'number') return { kind: { oneofKind: 'numberValue', numberValue: value } };
  if (typeof value === 'boolean') return { kind: { oneofKind: 'boolValue', boolValue: value } };
  if (Array.isArray(value)) {
    return {
      kind: { oneofKind: 'listValue', listValue: { values: value.map(protoValue) } },
    };
  }
  const fields = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      protoValue(entry),
    ]),
  );
  return { kind: { oneofKind: 'structValue', structValue: { fields } } };
}

function rawOwner(address = OWNER): GrpcTypes.Owner {
  return GrpcTypes.Owner.create({ kind: GrpcTypes.Owner_OwnerKind.ADDRESS, address });
}

function rawObjectResult(object: Partial<GrpcTypes.Object> = {}): GrpcTypes.GetObjectResult {
  return GrpcTypes.GetObjectResult.create({
    result: {
      oneofKind: 'object',
      object: {
        objectId: OBJECT_ID,
        version: 7n,
        digest: DIGEST,
        owner: rawOwner(),
        objectType: COIN_OBJECT_TYPE,
        json: protoValue({ balance: '10' }) as GrpcTypes.Object['json'],
        ...object,
      },
    },
  });
}

function rawCoin(
  objectId: string,
  balance: bigint,
  overrides: Partial<GrpcTypes.Object> = {},
): GrpcTypes.Object {
  return GrpcTypes.Object.create({
    objectId,
    version: 1n,
    digest: DIGEST,
    owner: rawOwner(),
    objectType: COIN_OBJECT_TYPE,
    balance,
    ...overrides,
  });
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

describe('current Sui state gateways', () => {
  it('binds a raw object result by requested position and identity', async () => {
    const batchGetObjects = vi.fn(async () => ({
      response: { objects: [rawObjectResult()] },
    }));
    const result = await getSuiObject(
      createSuiEndpointSnapshot([client({ ledgerService: { batchGetObjects } })]),
      { objectId: OBJECT_ID },
    );

    expect(result).toMatchObject({
      objectId: OBJECT_ID,
      version: '7',
      owner: { $kind: 'AddressOwner', AddressOwner: OWNER },
      type: COIN_OBJECT_TYPE,
      json: { balance: '10' },
    });
    expect(batchGetObjects).toHaveBeenCalledWith(
      {
        requests: [{ objectId: OBJECT_ID }],
        readMask: {
          paths: ['owner', 'object_type', 'digest', 'version', 'object_id', 'json'],
        },
      },
      expect.objectContaining({ timeout: expect.any(Number), abort: expect.any(AbortSignal) }),
    );
  });

  it.each([
    {
      boundary: 'object version',
      object: { version: 1n << 64n },
    },
    {
      boundary: 'shared-owner version',
      object: {
        owner: {
          kind: GrpcTypes.Owner_OwnerKind.SHARED,
          version: 1n << 64n,
        },
      },
    },
  ])('rejects a consumed $boundary outside the u64 range', async ({ object }) => {
    const batchGetObjects = vi.fn(async () => ({
      response: { objects: [rawObjectResult(object)] },
    }));

    await expect(
      getSuiObject(createSuiEndpointSnapshot([client({ ledgerService: { batchGetObjects } })]), {
        objectId: OBJECT_ID,
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('accepts only a canonical StructTag or the exact package object type', async () => {
    const packageObject = vi.fn(async () => ({
      response: {
        objects: [
          rawObjectResult({
            objectType: 'package',
            owner: { kind: GrpcTypes.Owner_OwnerKind.IMMUTABLE },
            json: undefined,
          }),
        ],
      },
    }));
    await expect(
      getSuiObject(
        createSuiEndpointSnapshot([client({ ledgerService: { batchGetObjects: packageObject } })]),
        { objectId: OBJECT_ID },
      ),
    ).resolves.toMatchObject({ type: 'package' });

    const nonCurrentType = vi.fn(async () => ({
      response: { objects: [rawObjectResult({ objectType: 'legacy-package' })] },
    }));
    await expect(
      getSuiObject(
        createSuiEndpointSnapshot([client({ ledgerService: { batchGetObjects: nonCurrentType } })]),
        { objectId: OBJECT_ID },
      ),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('turns only the raw current not-found status into typed diagnostics for the requested slot', async () => {
    const batchGetObjects = vi.fn(async () => ({
      response: {
        objects: [
          {
            result: {
              oneofKind: 'error',
              error: {
                code: 5,
                message: 'provider text is not authority',
                details: [
                  {
                    typeUrl: 'type.googleapis.com/google.rpc.ResourceInfo',
                    value: new Uint8Array([1]),
                  },
                ],
              },
            },
          },
        ],
      },
    }));
    const promise = getSuiObject(
      createSuiEndpointSnapshot([client({ ledgerService: { batchGetObjects } })]),
      { objectId: OBJECT_ID },
    );

    await expect(promise).rejects.toMatchObject({
      kind: 'not_found',
      diagnostic: { resourceId: OBJECT_ID },
    });
  });

  it('uses the not-found status code without interpreting discarded provider details', async () => {
    const batchGetObjects = vi.fn(async () => ({
      response: {
        objects: [
          {
            result: {
              oneofKind: 'error',
              error: { code: 5, message: 'not found', details: [7] },
            },
          },
        ],
      },
    }));

    await expect(
      getSuiObject(createSuiEndpointSnapshot([client({ ledgerService: { batchGetObjects } })]), {
        objectId: OBJECT_ID,
      }),
    ).rejects.toMatchObject({
      kind: 'not_found',
      diagnostic: { resourceId: OBJECT_ID },
    });
  });

  it('rejects a sparse raw object batch before position binding', async () => {
    const batchGetObjects = vi.fn(async () => ({
      response: { objects: new Array(1) },
    }));

    await expect(
      getSuiObject(createSuiEndpointSnapshot([client({ ledgerService: { batchGetObjects } })]), {
        objectId: OBJECT_ID,
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('rejects a raw object batch whose response positions do not preserve request identity', async () => {
    const secondId = `0x${'44'.repeat(32)}`;
    const batchGetObjects = vi.fn(async () => ({
      response: {
        objects: [
          rawObjectResult({ objectId: secondId }),
          rawObjectResult({ objectId: OBJECT_ID }),
        ],
      },
    }));

    await expect(
      getSuiObjects(createSuiEndpointSnapshot([client({ ledgerService: { batchGetObjects } })]), {
        objectIds: [OBJECT_ID, secondId],
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('rejects opposing object-result and protobuf JSON oneof payloads', async () => {
    const opposingResult = rawObjectResult() as unknown as {
      result: Record<string, unknown>;
    };
    opposingResult.result.error = { code: 5, message: 'opposing', details: [] };
    const first = vi.fn(async () => ({ response: { objects: [opposingResult] } }));

    const json = protoValue({ balance: '10' }) as {
      kind: { structValue: { fields: Record<string, { kind: Record<string, unknown> }> } };
    };
    json.kind.structValue.fields.balance!.kind.boolValue = true;
    const second = vi.fn(async () => ({
      response: { objects: [rawObjectResult({ json: json as GrpcTypes.Object['json'] })] },
    }));

    await expect(
      getSuiObject(
        createSuiEndpointSnapshot([
          client({ ledgerService: { batchGetObjects: first } }),
          client({ ledgerService: { batchGetObjects: second } }),
        ]),
        { objectId: OBJECT_ID },
      ),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      boundary: 'protobuf Value wrapper',
      response: () => {
        const result = rawObjectResult({
          json: protoValue({ balance: '10' }) as GrpcTypes.Object['json'],
        }) as unknown as { result: { object: { json: Record<string, unknown> } } };
        result.result.object.json.legacyKind = true;
        return { objects: [result] };
      },
    },
    {
      boundary: 'protobuf ListValue wrapper',
      response: () => {
        const result = rawObjectResult({
          json: protoValue({ balances: [1] }) as GrpcTypes.Object['json'],
        }) as unknown as {
          result: {
            object: {
              json: {
                kind: {
                  structValue: {
                    fields: Record<string, { kind: { listValue: Record<string, unknown> } }>;
                  };
                };
              };
            };
          };
        };
        result.result.object.json.kind.structValue.fields.balances!.kind.listValue.legacyValues =
          [];
        return { objects: [result] };
      },
    },
  ])('rejects an unsupported key at the $boundary', async ({ response }) => {
    const batchGetObjects = vi.fn(async () => ({ response: response() }));

    await expect(
      getSuiObject(createSuiEndpointSnapshot([client({ ledgerService: { batchGetObjects } })]), {
        objectId: OBJECT_ID,
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it.each([
    {
      boundary: 'batch response wrapper',
      response: () => ({ objects: [rawObjectResult()], legacyObjects: [] }),
    },
    {
      boundary: 'object result wrapper',
      response: () => {
        const result = rawObjectResult() as unknown as Record<string, unknown>;
        result.legacyStatus = 0;
        return { objects: [result] };
      },
    },
    {
      boundary: 'raw Owner structure',
      response: () => {
        const result = rawObjectResult() as unknown as {
          result: { object: { owner: Record<string, unknown> } };
        };
        result.result.object.owner.legacyOwner = OWNER;
        return { objects: [result] };
      },
    },
    {
      boundary: 'discarded raw Owner field',
      response: () => {
        const result = rawObjectResult() as unknown as {
          result: { object: { owner: Record<string, unknown> } };
        };
        result.result.object.owner.version = 'discarded';
        return { objects: [result] };
      },
    },
  ])('ignores an additive provider field at the $boundary', async ({ response }) => {
    const batchGetObjects = vi.fn(async () => ({ response: response() }));
    await expect(
      getSuiObject(createSuiEndpointSnapshot([client({ ledgerService: { batchGetObjects } })]), {
        objectId: OBJECT_ID,
      }),
    ).resolves.toMatchObject({ objectId: OBJECT_ID });
  });

  it('rejects the raw unknown owner discriminant and retries a current owner', async () => {
    const unknown = vi.fn(async () => ({
      response: {
        objects: [
          rawObjectResult({ owner: { kind: GrpcTypes.Owner_OwnerKind.OWNER_KIND_UNKNOWN } }),
        ],
      },
    }));
    const current = vi.fn(async () => ({ response: { objects: [rawObjectResult()] } }));

    const result = await getSuiObject(
      createSuiEndpointSnapshot([
        client({ ledgerService: { batchGetObjects: unknown } }),
        client({ ledgerService: { batchGetObjects: current } }),
      ]),
      { objectId: OBJECT_ID },
    );

    expect(result.owner).toEqual({ $kind: 'AddressOwner', AddressOwner: OWNER });
    expect(unknown).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('derives and validates a dynamic field from the exact raw object bytes', async () => {
    const nameBcs = bcs.U64.serialize(1).toBytes();
    const fieldId = normalizeSuiAddress(
      deriveDynamicFieldID(OWNER, TypeTagSerializer.parseFromStr('u64'), nameBcs),
    );
    const resolvedAddress = `0x${'77'.repeat(32)}`;
    const contents = concatBytes(
      bcs.Address.serialize(fieldId).toBytes(),
      nameBcs,
      bcs.Address.serialize(resolvedAddress).toBytes(),
    );
    const batchGetObjects = vi.fn(async () => ({
      response: {
        objects: [
          rawObjectResult({
            objectId: fieldId,
            objectType: '0x2::dynamic_field::Field<u64,address>',
            contents: { value: contents },
            previousTransaction: DIGEST,
            json: undefined,
            owner: undefined,
          }),
        ],
      },
    }));

    const result = await getSuiDynamicField(
      createSuiEndpointSnapshot([client({ ledgerService: { batchGetObjects } })]),
      { parentId: OWNER, name: { type: 'u64', bcs: nameBcs } },
    );

    expect(result).toMatchObject({
      $kind: 'DynamicField',
      fieldId,
      name: { type: 'u64', bcs: nameBcs },
      value: { type: 'address', bcs: bcs.Address.serialize(resolvedAddress).toBytes() },
      previousTransaction: DIGEST,
    });
    expect(batchGetObjects).toHaveBeenCalledWith(
      expect.objectContaining({
        requests: [{ objectId: fieldId }],
        readMask: expect.objectContaining({ paths: expect.arrayContaining(['contents']) }),
      }),
      expect.objectContaining({ timeout: expect.any(Number), abort: expect.any(AbortSignal) }),
    );
  });

  it('ignores the discarded dynamic-field display name', async () => {
    const nameBcs = bcs.U64.serialize(1).toBytes();
    const fieldId = normalizeSuiAddress(
      deriveDynamicFieldID(OWNER, TypeTagSerializer.parseFromStr('u64'), nameBcs),
    );
    const contents = concatBytes(
      bcs.Address.serialize(fieldId).toBytes(),
      nameBcs,
      bcs.Address.serialize(OBJECT_ID).toBytes(),
    );
    const batchGetObjects = vi.fn(async () => ({
      response: {
        objects: [
          rawObjectResult({
            objectId: fieldId,
            objectType: '0x2::dynamic_field::Field<u64,address>',
            contents: { name: 7, value: contents } as never,
            previousTransaction: DIGEST,
            json: undefined,
            owner: undefined,
          }),
        ],
      },
    }));

    await expect(
      getSuiDynamicField(
        createSuiEndpointSnapshot([client({ ledgerService: { batchGetObjects } })]),
        { parentId: OWNER, name: { type: 'u64', bcs: nameBcs } },
      ),
    ).resolves.toMatchObject({ fieldId, valueType: 'address' });
  });

  it('rejects a dynamic-field object whose embedded name does not match the derived request', async () => {
    const nameBcs = bcs.U64.serialize(1).toBytes();
    const fieldId = normalizeSuiAddress(
      deriveDynamicFieldID(OWNER, TypeTagSerializer.parseFromStr('u64'), nameBcs),
    );
    const wrongName = bcs.U64.serialize(2).toBytes();
    const batchGetObjects = vi.fn(async () => ({
      response: {
        objects: [
          rawObjectResult({
            objectId: fieldId,
            objectType: '0x2::dynamic_field::Field<u64,address>',
            contents: {
              value: concatBytes(
                bcs.Address.serialize(fieldId).toBytes(),
                wrongName,
                bcs.Address.serialize(OBJECT_ID).toBytes(),
              ),
            },
            previousTransaction: DIGEST,
            json: undefined,
            owner: undefined,
          }),
        ],
      },
    }));

    await expect(
      getSuiDynamicField(
        createSuiEndpointSnapshot([client({ ledgerService: { batchGetObjects } })]),
        { parentId: OWNER, name: { type: 'u64', bcs: nameBcs } },
      ),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('fails over missing coin metadata without synthesizing empty metadata', async () => {
    const missing = vi.fn(async () => ({ response: { coinType: COIN_TYPE } }));
    const present = vi.fn(async () => ({
      response: {
        coinType: COIN_TYPE,
        metadata: {
          id: METADATA_ID,
          decimals: 9,
          name: '',
          symbol: 'SUI',
          description: '',
          iconUrl: '',
        },
      },
    }));
    const result = await getSuiCoinMetadata(
      createSuiEndpointSnapshot([
        client({ stateService: { getCoinInfo: missing } }),
        client({ stateService: { getCoinInfo: present } }),
      ]),
      { coinType: COIN_TYPE },
    );

    expect(result).toEqual({
      decimals: 9,
      symbol: 'SUI',
    });
  });

  it.each([
    {
      label: 'requested coin type',
      response: {
        coinType: '0x2::other::COIN',
        metadata: { decimals: 9, symbol: 'SUI' },
      },
    },
    {
      label: 'decimals',
      response: {
        coinType: COIN_TYPE,
        metadata: { decimals: 1.5, symbol: 'SUI' },
      },
    },
    {
      label: 'symbol',
      response: {
        coinType: COIN_TYPE,
        metadata: { decimals: 9, symbol: 7 },
      },
    },
  ])('rejects malformed consumed coin-metadata $label', async ({ response }) => {
    const getCoinInfo = vi.fn(async () => ({ response }));
    await expect(
      getSuiCoinMetadata(createSuiEndpointSnapshot([client({ stateService: { getCoinInfo } })]), {
        coinType: COIN_TYPE,
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('ignores additive provider fields that no returned value consumes', async () => {
    const metadata = vi.fn(async () => ({
      response: {
        coinType: COIN_TYPE,
        metadata: { decimals: 9, symbol: 'SUI', legacyDecimals: 9 },
      },
    }));
    await expect(
      getSuiCoinMetadata(
        createSuiEndpointSnapshot([client({ stateService: { getCoinInfo: metadata } })]),
        { coinType: COIN_TYPE },
      ),
    ).resolves.toEqual({ decimals: 9, symbol: 'SUI' });

    const balance = vi.fn(async () => ({
      response: {
        balance: {
          coinType: COIN_TYPE,
          balance: 3n,
          coinBalance: 2n,
          addressBalance: 1n,
          legacyBalance: 0n,
        },
      },
    }));
    await expect(
      getSuiBalance(
        createSuiEndpointSnapshot([client({ stateService: { getBalance: balance } })]),
        { owner: OWNER, coinType: COIN_TYPE },
      ),
    ).resolves.toMatchObject({ balance: '3', coinBalance: '2', addressBalance: '1' });

    const listOwnedObjects = vi.fn(async () => ({
      response: { objects: [], legacyPageToken: new Uint8Array([1]) },
    }));
    await expect(
      readBoundedSuiCoins(
        createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects } })]),
        {
          owner: OWNER,
          coinType: COIN_TYPE,
        },
      ),
    ).resolves.toEqual({ status: 'complete', coins: [] });

    const getServiceInfo = vi.fn(async () => ({
      response: { chainId: DIGEST, legacyChainId: DIGEST },
    }));
    await expect(
      getSuiChainIdentifier(
        createSuiEndpointSnapshot([client({ ledgerService: { getServiceInfo } })]),
      ),
    ).resolves.toEqual({ chainIdentifier: DIGEST });
  });

  it('ignores malformed fields excluded by the request or returned contract', async () => {
    const objectWithBalance = vi.fn(async () => ({
      response: { objects: [rawObjectResult({ balance: 9n })] },
    }));
    await expect(
      getSuiObject(
        createSuiEndpointSnapshot([
          client({ ledgerService: { batchGetObjects: objectWithBalance } }),
        ]),
        { objectId: OBJECT_ID },
      ),
    ).resolves.toMatchObject({ objectId: OBJECT_ID });

    const coinWithJson = vi.fn(async () => ({
      response: {
        objects: [rawCoin(OBJECT_ID, 1n, { json: protoValue({ balance: '1' }) as never })],
      },
    }));
    await expect(
      readBoundedSuiCoins(
        createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects: coinWithJson } })]),
        { owner: OWNER, coinType: COIN_TYPE },
      ),
    ).resolves.toMatchObject({ status: 'complete', coins: [{ objectId: OBJECT_ID }] });

    const malformedTreasury = vi.fn(async () => ({
      response: {
        coinType: COIN_TYPE,
        metadata: { decimals: 9, symbol: 'SUI' },
        treasury: { id: 'bad', totalSupply: -1n, supplyState: 99 },
      },
    }));
    await expect(
      getSuiCoinMetadata(
        createSuiEndpointSnapshot([client({ stateService: { getCoinInfo: malformedTreasury } })]),
        { coinType: COIN_TYPE },
      ),
    ).resolves.toEqual({ decimals: 9, symbol: 'SUI' });

    const malformedServiceInfo = vi.fn(async () => ({
      response: {
        chainId: DIGEST,
        epoch: -1n,
        timestamp: { seconds: 'bad', nanos: -1 },
      },
    }));
    await expect(
      getSuiChainIdentifier(
        createSuiEndpointSnapshot([
          client({ ledgerService: { getServiceInfo: malformedServiceInfo } }),
        ]),
      ),
    ).resolves.toEqual({ chainIdentifier: DIGEST });
  });

  it.each([
    {
      label: 'coin balance',
      raw: { coinType: COIN_TYPE, balance: 7n, addressBalance: 7n },
      expected: { balance: '7', coinBalance: '0', addressBalance: '7' },
    },
    {
      label: 'address balance',
      raw: { coinType: COIN_TYPE, balance: 7n, coinBalance: 7n },
      expected: { balance: '7', coinBalance: '7', addressBalance: '0' },
    },
    {
      label: 'both zero components',
      raw: { coinType: COIN_TYPE, balance: 0n },
      expected: { balance: '0', coinBalance: '0', addressBalance: '0' },
    },
  ])('restores an omitted protobuf $label as exact zero', async ({ raw, expected }) => {
    const getBalance = vi.fn(async () => ({ response: { balance: raw } }));

    await expect(
      getSuiBalance(createSuiEndpointSnapshot([client({ stateService: { getBalance } })]), {
        owner: OWNER,
        coinType: COIN_TYPE,
      }),
    ).resolves.toEqual({ coinType: COIN_TYPE, ...expected });
  });

  it('rejects a missing total instead of deriving it from balance components', async () => {
    const getBalance = vi.fn(async () => ({
      response: {
        balance: { coinType: COIN_TYPE, coinBalance: 1n, addressBalance: 2n },
      },
    }));

    await expect(
      getSuiBalance(createSuiEndpointSnapshot([client({ stateService: { getBalance } })]), {
        owner: OWNER,
        coinType: COIN_TYPE,
      }),
    ).rejects.toBeInstanceOf(SuiOperationError);
  });

  it.each([
    { label: 'null coin balance', field: 'coinBalance', value: null },
    { label: 'null address balance', field: 'addressBalance', value: null },
    { label: 'a JavaScript number', field: 'coinBalance', value: 1 },
    { label: 'a negative bigint', field: 'coinBalance', value: -1n },
    { label: 'a bigint wider than u64', field: 'coinBalance', value: 1n << 64n },
  ] as const)(
    'rejects $label instead of treating it as an omitted zero component',
    async ({ field, value }) => {
      const getBalance = vi.fn(async () => ({
        response: {
          balance: {
            coinType: COIN_TYPE,
            balance: 0n,
            coinBalance: 0n,
            addressBalance: 0n,
            [field]: value,
          },
        },
      }));

      await expect(
        getSuiBalance(createSuiEndpointSnapshot([client({ stateService: { getBalance } })]), {
          owner: OWNER,
          coinType: COIN_TYPE,
        }),
      ).rejects.toMatchObject({ kind: 'malformed_response' });
    },
  );

  it('rejects a consumed balance total that disagrees with its components', async () => {
    const getBalance = vi.fn(async () => ({
      response: {
        balance: {
          coinType: COIN_TYPE,
          balance: 4n,
          coinBalance: 2n,
          addressBalance: 1n,
        },
      },
    }));
    await expect(
      getSuiBalance(createSuiEndpointSnapshot([client({ stateService: { getBalance } })]), {
        owner: OWNER,
        coinType: COIN_TYPE,
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('rejects consumed balance values outside the u64 range', async () => {
    const getBalance = vi.fn(async () => ({
      response: {
        balance: {
          coinType: COIN_TYPE,
          balance: 1n << 64n,
          coinBalance: (1n << 64n) - 1n,
          addressBalance: 1n,
        },
      },
    }));

    await expect(
      getSuiBalance(createSuiEndpointSnapshot([client({ stateService: { getBalance } })]), {
        owner: OWNER,
        coinType: COIN_TYPE,
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('rejects a malformed consumed chain identifier', async () => {
    const getServiceInfo = vi.fn(async () => ({ response: { chainId: 'not-a-digest' } }));
    await expect(
      getSuiChainIdentifier(
        createSuiEndpointSnapshot([client({ ledgerService: { getServiceInfo } })]),
      ),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('defaults balance coin type only when omitted and rejects explicit invalid values', async () => {
    const getBalance = vi.fn(async () => ({
      response: {
        balance: {
          coinType: COIN_TYPE,
          balance: 3n,
          coinBalance: 2n,
          addressBalance: 1n,
        },
      },
    }));
    const snapshot = createSuiEndpointSnapshot([client({ stateService: { getBalance } })]);

    await expect(getSuiBalance(snapshot, { owner: OWNER })).resolves.toMatchObject({
      coinType: COIN_TYPE,
      balance: '3',
    });
    expect(() => getSuiBalance(snapshot, { owner: OWNER, coinType: null as never })).toThrow(
      TypeError,
    );
    expect(() => getSuiBalance(snapshot, { owner: OWNER, coinType: '' })).toThrow(TypeError);
    expect(getBalance).toHaveBeenCalledTimes(1);
    expect(getBalance).toHaveBeenCalledWith(
      { owner: OWNER, coinType: COIN_TYPE },
      expect.objectContaining({ timeout: expect.any(Number), abort: expect.any(AbortSignal) }),
    );
  });

  it('reads one fixed-size endpoint-consistent page and reports a non-empty next token', async () => {
    const firstId = `0x${'44'.repeat(32)}`;
    const listOwnedObjects = vi.fn(async () => ({
      response: { objects: [rawCoin(firstId, 1n)], nextPageToken: NEXT_PAGE_TOKEN },
    }));

    await expect(
      readBoundedSuiCoins(
        createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects } })]),
        { owner: OWNER, coinType: COIN_TYPE },
      ),
    ).resolves.toEqual({
      status: 'limit_exceeded',
      coins: [expect.objectContaining({ objectId: firstId, balance: '1' })],
    });
    expect(listOwnedObjects).toHaveBeenCalledTimes(1);
    expect(listOwnedObjects).toHaveBeenCalledWith(
      {
        owner: OWNER,
        objectType: COIN_OBJECT_TYPE,
        pageSize: MAX_SUI_COIN_OBJECTS_PER_OPERATION,
        pageToken: undefined,
        readMask: { paths: ['owner', 'object_type', 'digest', 'version', 'object_id', 'balance'] },
      },
      expect.objectContaining({ timeout: expect.any(Number), abort: expect.any(AbortSignal) }),
    );
  });

  it.each([
    ['short', [rawCoin(`0x${'55'.repeat(32)}`, 2n)]],
    ['empty', []],
  ])('reports a %s page with a next token as limit_exceeded', async (_label, objects) => {
    const listOwnedObjects = vi.fn(async () => ({
      response: { objects, nextPageToken: NEXT_PAGE_TOKEN },
    }));
    await expect(
      readBoundedSuiCoins(
        createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects } })]),
        { owner: OWNER, coinType: COIN_TYPE },
      ),
    ).resolves.toMatchObject({ status: 'limit_exceeded' });
    expect(listOwnedObjects).toHaveBeenCalledTimes(1);
  });

  it('reports exhaustion only when the one page has no next token', async () => {
    const listOwnedObjects = vi.fn(async () => ({ response: { objects: [] } }));
    await expect(
      readBoundedSuiCoins(
        createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects } })]),
        { owner: OWNER, coinType: COIN_TYPE },
      ),
    ).resolves.toEqual({ status: 'complete', coins: [] });
  });

  it('rejects a present empty next-page token instead of treating it as exhaustion', async () => {
    const listOwnedObjects = vi.fn(async () => ({
      response: { objects: [], nextPageToken: new Uint8Array() },
    }));

    await expect(
      readBoundedSuiCoins(
        createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects } })]),
        { owner: OWNER, coinType: COIN_TYPE },
      ),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('rejects a page larger than the fixed operation bound', async () => {
    const objects = Array.from({ length: MAX_SUI_COIN_OBJECTS_PER_OPERATION + 1 }, (_, index) =>
      rawCoin(`0x${(index + 1).toString(16).padStart(64, '0')}`, 1n),
    );
    const listOwnedObjects = vi.fn(async () => ({ response: { objects } }));
    await expect(
      readBoundedSuiCoins(
        createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects } })]),
        { owner: OWNER, coinType: COIN_TYPE },
      ),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('rejects coins whose raw type or owner does not match the requested identity', async () => {
    const wrongType = vi.fn(async () => ({
      response: {
        objects: [
          rawCoin(OBJECT_ID, 1n, {
            objectType: normalizeStructTag(`0x2::coin::Coin<0x2::foo::BAR>`),
          }),
        ],
      },
    }));
    const wrongOwner = vi.fn(async () => ({
      response: {
        objects: [rawCoin(OBJECT_ID, 1n, { owner: rawOwner(`0x${'99'.repeat(32)}`) })],
      },
    }));

    await expect(
      readBoundedSuiCoins(
        createSuiEndpointSnapshot([
          client({ stateService: { listOwnedObjects: wrongType } }),
          client({ stateService: { listOwnedObjects: wrongOwner } }),
        ]),
        { owner: OWNER, coinType: COIN_TYPE },
      ),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
    expect(wrongType).toHaveBeenCalledTimes(1);
    expect(wrongOwner).toHaveBeenCalledTimes(1);
  });

  it('rejects a returned Coin balance outside the u64 range', async () => {
    const listOwnedObjects = vi.fn(async () => ({
      response: { objects: [rawCoin(OBJECT_ID, 1n << 64n)] },
    }));
    await expect(
      readBoundedSuiCoins(
        createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects } })]),
        { owner: OWNER, coinType: COIN_TYPE },
      ),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('rejects duplicate object identity inside the bounded page', async () => {
    const coin = rawCoin(`0x${'66'.repeat(32)}`, 1n);
    const listOwnedObjects = vi.fn(async () => ({ response: { objects: [coin, coin] } }));
    await expect(
      readBoundedSuiCoins(
        createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects } })]),
        { owner: OWNER, coinType: COIN_TYPE },
      ),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });
});
