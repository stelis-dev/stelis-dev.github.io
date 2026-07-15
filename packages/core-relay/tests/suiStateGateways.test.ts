import { bcs, TypeTagSerializer } from '@mysten/sui/bcs';
import { GrpcTypes, type SuiGrpcClient } from '@mysten/sui/grpc';
import {
  deriveDynamicFieldID,
  normalizeStructTag,
  normalizeSuiAddress,
  toBase64,
} from '@mysten/sui/utils';
import { describe, expect, it, vi } from 'vitest';
import {
  createSuiEndpointSnapshot,
  SUI_OPERATION_ATTEMPT_TIMEOUT_MS,
  SuiOperationError,
} from '../src/sui/suiOperation.js';
import {
  getSuiBalance,
  getSuiCoinMetadata,
  getSuiDynamicField,
  getSuiChainIdentifier,
  getSuiObject,
  getSuiObjects,
  listAllSuiCoins,
} from '../src/sui/suiStateGateways.js';

const OWNER = `0x${'11'.repeat(32)}`;
const OBJECT_ID = `0x${'22'.repeat(32)}`;
const METADATA_ID = `0x${'33'.repeat(32)}`;
const DIGEST = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD';
const COIN_TYPE = normalizeStructTag('0x2::sui::SUI');
const COIN_OBJECT_TYPE = normalizeStructTag(`0x2::coin::Coin<${COIN_TYPE}>`);
const NEXT_PAGE_TOKEN = new Uint8Array([1, 2, 3]);
const NEXT_CURSOR = toBase64(NEXT_PAGE_TOKEN);

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

  it('rejects malformed structured not-found details instead of trusting the status code alone', async () => {
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
    ).rejects.toMatchObject({ kind: 'malformed_response' });
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
      boundary: 'opposing raw Owner field even when undefined',
      response: () => {
        const result = rawObjectResult() as unknown as {
          result: { object: { owner: Record<string, unknown> } };
        };
        result.result.object.owner.version = undefined;
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

  it('rejects a dynamic-field BCS envelope with a non-string name', async () => {
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
    ).rejects.toMatchObject({ kind: 'malformed_response' });
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

  it('rejects unsupported fields in metadata, balance, pagination, and chain wrappers', async () => {
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
    ).rejects.toMatchObject({ kind: 'malformed_response' });

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
    ).rejects.toMatchObject({ kind: 'malformed_response' });

    const listOwnedObjects = vi.fn(async () => ({
      response: { objects: [], legacyPageToken: new Uint8Array([1]) },
    }));
    await expect(
      listAllSuiCoins(createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects } })]), {
        owner: OWNER,
        coinType: COIN_TYPE,
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });

    const getServiceInfo = vi.fn(async () => ({
      response: { chainId: DIGEST, legacyChainId: DIGEST },
    }));
    await expect(
      getSuiChainIdentifier(
        createSuiEndpointSnapshot([client({ ledgerService: { getServiceInfo } })]),
      ),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('rejects malformed or unrequested fields that are valid members of current protobufs', async () => {
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
    ).rejects.toMatchObject({ kind: 'malformed_response' });

    const coinWithJson = vi.fn(async () => ({
      response: {
        objects: [rawCoin(OBJECT_ID, 1n, { json: protoValue({ balance: '1' }) as never })],
      },
    }));
    await expect(
      listAllSuiCoins(
        createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects: coinWithJson } })]),
        { owner: OWNER, coinType: COIN_TYPE },
      ),
    ).rejects.toMatchObject({ kind: 'malformed_response' });

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
    ).rejects.toMatchObject({ kind: 'malformed_response' });

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
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('rejects incomplete balance evidence instead of manufacturing zero', async () => {
    const getBalance = vi.fn(async () => ({
      response: {
        balance: { coinType: COIN_TYPE, balance: 0n, coinBalance: 0n },
      },
    }));
    const promise = getSuiBalance(
      createSuiEndpointSnapshot([client({ stateService: { getBalance } })]),
      { owner: OWNER, coinType: COIN_TYPE },
    );

    await expect(promise).rejects.toBeInstanceOf(SuiOperationError);
    await expect(promise).rejects.toMatchObject({ kind: 'malformed_response' });
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

  it('restarts exact raw coin pagination on one endpoint and forwards the requested page limit', async () => {
    const firstId = `0x${'44'.repeat(32)}`;
    const secondId = `0x${'55'.repeat(32)}`;
    const firstEndpoint = vi
      .fn()
      .mockResolvedValueOnce({
        response: { objects: [rawCoin(firstId, 1n)], nextPageToken: NEXT_PAGE_TOKEN },
      })
      .mockResolvedValueOnce({ response: { objects: [{ malformed: true }] } });
    const secondEndpoint = vi
      .fn()
      .mockResolvedValueOnce({
        response: { objects: [rawCoin(firstId, 1n)], nextPageToken: NEXT_PAGE_TOKEN },
      })
      .mockResolvedValueOnce({ response: { objects: [rawCoin(secondId, 2n)] } });

    const result = await listAllSuiCoins(
      createSuiEndpointSnapshot([
        client({ stateService: { listOwnedObjects: firstEndpoint } }),
        client({ stateService: { listOwnedObjects: secondEndpoint } }),
      ]),
      { owner: OWNER, coinType: COIN_TYPE, limit: 17 },
    );

    expect(result.map(({ objectId }) => objectId)).toEqual([firstId, secondId]);
    expect(firstEndpoint.mock.calls.map(([request]) => request.pageToken)).toEqual([
      undefined,
      NEXT_PAGE_TOKEN,
    ]);
    expect(secondEndpoint.mock.calls.map(([request]) => request.pageToken)).toEqual([
      undefined,
      NEXT_PAGE_TOKEN,
    ]);
    for (const [request, callOptions] of secondEndpoint.mock.calls) {
      expect(request).toMatchObject({
        owner: OWNER,
        objectType: COIN_OBJECT_TYPE,
        pageSize: 17,
        readMask: { paths: ['owner', 'object_type', 'digest', 'version', 'object_id', 'balance'] },
      });
      expect(callOptions).toEqual(
        expect.objectContaining({ timeout: expect.any(Number), abort: expect.any(AbortSignal) }),
      );
    }
  });

  it('does not start another coin page after caller cancellation', async () => {
    const controller = new AbortController();
    const firstPage = Promise.resolve({
      response: {
        objects: [rawCoin(`0x${'44'.repeat(32)}`, 1n)],
        nextPageToken: NEXT_PAGE_TOKEN,
      },
    });
    firstPage.then(() => controller.abort());
    const listOwnedObjects = vi.fn(() => firstPage);

    await expect(
      listAllSuiCoins(createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects } })]), {
        owner: OWNER,
        coinType: COIN_TYPE,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(listOwnedObjects).toHaveBeenCalledTimes(1);
  });

  it('enforces the monotonic attempt deadline between immediately resolved coin pages', async () => {
    let nowMs = 0;
    let call = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const listOwnedObjects = vi.fn(async () => {
      call += 1;
      nowMs += SUI_OPERATION_ATTEMPT_TIMEOUT_MS / 2 + 1;
      return {
        response: {
          objects: [rawCoin(`0x${call.toString(16).padStart(64, '0')}`, 1n)],
          nextPageToken: new Uint8Array([call]),
        },
      };
    });

    try {
      await expect(
        listAllSuiCoins(
          createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects } })]),
          { owner: OWNER, coinType: COIN_TYPE },
        ),
      ).rejects.toMatchObject({ kind: 'deadline_exceeded' });
      expect(listOwnedObjects).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('uses the current 50-object default and rejects pages larger than the requested limit', async () => {
    const defaultPage = vi.fn(async () => ({ response: { objects: [] } }));
    await expect(
      listAllSuiCoins(
        createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects: defaultPage } })]),
        { owner: OWNER, coinType: COIN_TYPE },
      ),
    ).resolves.toEqual([]);
    expect(defaultPage).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 50 }),
      expect.objectContaining({ timeout: expect.any(Number), abort: expect.any(AbortSignal) }),
    );

    const oversized = vi.fn(async () => ({
      response: {
        objects: [rawCoin(`0x${'44'.repeat(32)}`, 1n), rawCoin(`0x${'55'.repeat(32)}`, 2n)],
      },
    }));
    await expect(
      listAllSuiCoins(
        createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects: oversized } })]),
        { owner: OWNER, coinType: COIN_TYPE, limit: 1 },
      ),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
    await expect(
      listAllSuiCoins(
        createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects: oversized } })]),
        { owner: OWNER, coinType: COIN_TYPE, limit: 51 },
      ),
    ).rejects.toBeInstanceOf(TypeError);
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
      listAllSuiCoins(
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

  it('fails closed when a later raw coin page repeats an earlier cursor', async () => {
    const cursorA = new Uint8Array([4]);
    const cursorB = new Uint8Array([5]);
    const listOwnedObjects = vi
      .fn()
      .mockResolvedValueOnce({
        response: { objects: [rawCoin(`0x${'66'.repeat(32)}`, 1n)], nextPageToken: cursorA },
      })
      .mockResolvedValueOnce({
        response: { objects: [rawCoin(`0x${'77'.repeat(32)}`, 1n)], nextPageToken: cursorB },
      })
      .mockResolvedValueOnce({
        response: { objects: [rawCoin(`0x${'88'.repeat(32)}`, 1n)], nextPageToken: cursorA },
      });

    await expect(
      listAllSuiCoins(createSuiEndpointSnapshot([client({ stateService: { listOwnedObjects } })]), {
        owner: OWNER,
        coinType: COIN_TYPE,
      }),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
    expect(listOwnedObjects).toHaveBeenCalledTimes(3);
    expect(toBase64(cursorA)).not.toBe(NEXT_CURSOR);
  });
});
