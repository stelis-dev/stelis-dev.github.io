import { GrpcTypes, type SuiGrpcClient } from '@mysten/sui/grpc';
import { createSuiEndpointSnapshot } from '@stelis/core-relay';
import { describe, expect, it, vi } from 'vitest';
import { readHostChainState } from '../src/hostChainState.js';

const PACKAGE_ID = `0x${'11'.repeat(32)}`;
const CONFIG_ID = `0x${'22'.repeat(32)}`;
const REGISTRY_ID = `0x${'33'.repeat(32)}`;
const TABLE_ID = `0x${'44'.repeat(32)}`;
const DIGEST = '11111111111111111111111111111111';

function protoValue(value: unknown): unknown {
  if (value === null) return { kind: { oneofKind: 'nullValue', nullValue: 0 } };
  if (typeof value === 'string') {
    return { kind: { oneofKind: 'stringValue', stringValue: value } };
  }
  if (typeof value === 'number') {
    return { kind: { oneofKind: 'numberValue', numberValue: value } };
  }
  if (typeof value === 'boolean') {
    return { kind: { oneofKind: 'boolValue', boolValue: value } };
  }
  if (Array.isArray(value)) {
    return { kind: { oneofKind: 'listValue', listValue: { values: value.map(protoValue) } } };
  }
  return {
    kind: {
      oneofKind: 'structValue',
      structValue: {
        fields: Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .map(([key, entry]) => [key, protoValue(entry)]),
        ),
      },
    },
  };
}

function object(input: { readonly id: string; readonly type: string; readonly json: object }) {
  return {
    objectId: input.id,
    version: 1n,
    digest: DIGEST,
    owner: { kind: GrpcTypes.Owner_OwnerKind.SHARED, version: 1n },
    objectType: input.type,
    json: protoValue(input.json),
  };
}

function configJson(overrides: Record<string, unknown> = {}) {
  return {
    id: CONFIG_ID,
    max_host_fee_mist: '1',
    protocol_flat_fee_mist: '2',
    max_claim_mist: '75',
    min_settle_mist: '3',
    config_version: '4',
    max_spread_bps: '500',
    ...overrides,
  };
}

function snapshot(
  config = configJson(),
  vaults: Record<string, unknown> = { id: TABLE_ID, size: '7' },
) {
  const batchGetObjects = vi.fn(async () => ({
    response: {
      objects: [
        {
          result: {
            oneofKind: 'object',
            object: object({ id: CONFIG_ID, type: `${PACKAGE_ID}::config::Config`, json: config }),
          },
        },
        {
          result: {
            oneofKind: 'object',
            object: object({
              id: REGISTRY_ID,
              type: `${PACKAGE_ID}::vault::VaultRegistry`,
              json: { id: REGISTRY_ID, vaults },
            }),
          },
        },
      ],
    },
  }));
  const client = {
    network: 'testnet',
    ledgerService: { batchGetObjects },
  } as unknown as SuiGrpcClient;
  return { value: createSuiEndpointSnapshot([client]), batchGetObjects };
}

describe('readHostChainState', () => {
  it('binds the exact Config and VaultRegistry shapes in one operation', async () => {
    const { value, batchGetObjects } = snapshot();
    const state = await readHostChainState(value, {
      packageId: PACKAGE_ID,
      configId: CONFIG_ID,
      vaultRegistryId: REGISTRY_ID,
    });

    expect(state).toEqual({
      config: {
        packageId: PACKAGE_ID,
        configId: CONFIG_ID,
        maxClaimMist: 75n,
        minSettleMist: 3n,
        maxHostFeeMist: 1n,
        protocolFlatFeeMist: 2n,
        configVersion: 4n,
        maxSpreadBps: 500n,
      },
      vaultRegistryId: REGISTRY_ID,
      vaultsTableId: TABLE_ID,
    });
    expect(batchGetObjects).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['number placeholder', { max_claim_mist: 75 }],
    ['non-canonical decimal', { max_claim_mist: '075' }],
    ['missing field', { max_claim_mist: undefined }],
  ])('rejects a Config %s', async (_name, override) => {
    const { value } = snapshot(configJson(override));
    await expect(
      readHostChainState(value, {
        packageId: PACKAGE_ID,
        configId: CONFIG_ID,
        vaultRegistryId: REGISTRY_ID,
      }),
    ).rejects.toThrow('Config.max_claim_mist is not a canonical unsigned decimal string');
  });

  it('attributes a malformed Table size to the VaultRegistry owner path', async () => {
    const { value } = snapshot(configJson(), { id: TABLE_ID, size: 7 });

    await expect(
      readHostChainState(value, {
        packageId: PACKAGE_ID,
        configId: CONFIG_ID,
        vaultRegistryId: REGISTRY_ID,
      }),
    ).rejects.toThrow('VaultRegistry.vaults.size is not a canonical unsigned decimal string');
  });
});
