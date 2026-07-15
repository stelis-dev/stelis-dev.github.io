import { bcs, TypeTagSerializer } from '@mysten/sui/bcs';
import { deriveDynamicFieldID, normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SuiEndpointSnapshot } from '../src/sui/suiOperation.js';
import { SuiOperationError } from '../src/sui/suiOperation.js';

const gateway = vi.hoisted(() => ({
  getObject: vi.fn(),
  getDynamicField: vi.fn(),
}));

vi.mock('../src/sui/suiStateGateways.js', () => ({
  getSuiObject: (...args: unknown[]) => gateway.getObject(...args),
  getSuiDynamicField: (...args: unknown[]) => gateway.getDynamicField(...args),
}));

import { CreditQueryInconsistentStateError, queryUserCredit } from '../src/creditQuery.js';

const PACKAGE_ID = `0x${'11'.repeat(32)}`;
const OTHER_PACKAGE_ID = `0x${'12'.repeat(32)}`;
const ADDR = `0x${'aa'.repeat(32)}`;
const OTHER_ADDR = `0x${'ab'.repeat(32)}`;
const VAULT_ID = `0x${'bb'.repeat(32)}`;
const TABLE_ID = `0x${'cc'.repeat(32)}`;
const REGISTRY_ID = `0x${'dd'.repeat(32)}`;
const CHILD_ID = `0x${'ee'.repeat(32)}`;
const OBJECT_ID_TYPE = normalizeStructTag('0x2::object::ID');
const USER_BCS = bcs.Address.serialize(ADDR).toBytes();
const FIELD_ID = normalizeSuiAddress(
  deriveDynamicFieldID(TABLE_ID, TypeTagSerializer.parseFromStr('address', true), USER_BCS),
);
const SNAPSHOT = {} as SuiEndpointSnapshot;

function notFound(resourceId?: string): SuiOperationError {
  return new SuiOperationError('not_found', {
    operation: 'get_dynamic_field',
    attempt: 1,
    maxAttempts: 1,
    resourceId,
  });
}

function dynamicVault(vaultId = VAULT_ID): Record<string, unknown> {
  return {
    $kind: 'DynamicField',
    name: { type: 'address', bcs: USER_BCS.slice() },
    valueType: OBJECT_ID_TYPE,
    value: { type: OBJECT_ID_TYPE, bcs: bcs.Address.serialize(vaultId).toBytes() },
  };
}

function registryObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objectId: REGISTRY_ID,
    type: `${PACKAGE_ID}::vault::VaultRegistry`,
    json: { id: REGISTRY_ID, vaults: { id: TABLE_ID, size: '1' } },
    ...overrides,
  };
}

function vaultObject(
  credit: unknown,
  lastNonce: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    objectId: VAULT_ID,
    type: `${PACKAGE_ID}::vault::UserVault`,
    owner: { $kind: 'AddressOwner', AddressOwner: ADDR },
    json: { id: VAULT_ID, credit, last_nonce: lastNonce },
    ...overrides,
  };
}

function cachedQuery(tableId: string | undefined = TABLE_ID): Promise<unknown> {
  return queryUserCredit(SNAPSHOT, PACKAGE_ID, REGISTRY_ID, ADDR, tableId);
}

beforeEach(() => {
  gateway.getObject.mockReset();
  gateway.getDynamicField.mockReset();
});

describe('queryUserCredit', () => {
  it('binds the exact package, registry, user entry, and owned UserVault identities', async () => {
    gateway.getObject
      .mockResolvedValueOnce(registryObject())
      .mockResolvedValueOnce(vaultObject('5000000', '42'));
    gateway.getDynamicField.mockResolvedValueOnce(dynamicVault());

    await expect(queryUserCredit(SNAPSHOT, PACKAGE_ID, REGISTRY_ID, ADDR)).resolves.toEqual({
      vaultObjectId: VAULT_ID,
      credit: '5000000',
      needsCreate: false,
      lastNonce: '42',
    });
    expect(gateway.getObject).toHaveBeenNthCalledWith(1, SNAPSHOT, {
      objectId: REGISTRY_ID,
    });
    expect(gateway.getDynamicField).toHaveBeenCalledWith(SNAPSHOT, {
      parentId: TABLE_ID,
      name: { type: 'address', bcs: USER_BCS },
    });
  });

  it.each([
    ['wrong package type', registryObject({ type: `${OTHER_PACKAGE_ID}::vault::VaultRegistry` })],
    [
      'wrong JSON identity',
      registryObject({ json: { id: CHILD_ID, vaults: { id: TABLE_ID, size: '1' } } }),
    ],
    [
      'non-current table shape',
      registryObject({ json: { id: REGISTRY_ID, vaults: { id: TABLE_ID } } }),
    ],
    [
      'an invalid table identity',
      registryObject({ json: { id: REGISTRY_ID, vaults: { id: '', size: '1' } } }),
    ],
  ])('rejects a registry with %s', async (_label, registry) => {
    gateway.getObject.mockResolvedValueOnce(registry);
    await expect(queryUserCredit(SNAPSHOT, PACKAGE_ID, REGISTRY_ID, ADDR)).rejects.toThrow();
    expect(gateway.getDynamicField).not.toHaveBeenCalled();
  });

  it.each([null, '', 'not-an-address'])(
    'rejects explicit non-current table ID %j',
    async (value) => {
      await expect(
        queryUserCredit(SNAPSHOT, PACKAGE_ID, REGISTRY_ID, ADDR, value as never),
      ).rejects.toBeInstanceOf(TypeError);
      expect(gateway.getObject).not.toHaveBeenCalled();
      expect(gateway.getDynamicField).not.toHaveBeenCalled();
    },
  );

  it('treats only the exact derived child absence as an absent user vault', async () => {
    gateway.getDynamicField.mockRejectedValueOnce(notFound(FIELD_ID));

    await expect(cachedQuery()).resolves.toEqual({
      vaultObjectId: null,
      credit: '0',
      needsCreate: true,
      lastNonce: '0',
    });
  });

  it.each([
    ['the parent table', notFound(TABLE_ID)],
    ['a different child', notFound(CHILD_ID)],
    ['an unbound not-found response', notFound()],
    ['an arbitrary provider message', new Error(`Object ${FIELD_ID} not found`)],
  ])('fails closed for %s', async (_label, error) => {
    gateway.getDynamicField.mockRejectedValueOnce(error);
    await expect(cachedQuery()).rejects.toBe(error);
  });

  it.each([
    ['a dynamic-object entry', { ...dynamicVault(), $kind: 'DynamicObject', childId: VAULT_ID }],
    [
      'a non-address name type',
      { ...dynamicVault(), name: { type: 'u64', bcs: USER_BCS.slice() } },
    ],
    [
      'another user name',
      {
        ...dynamicVault(),
        name: { type: 'address', bcs: bcs.Address.serialize(OTHER_ADDR).toBytes() },
      },
    ],
    [
      'a trailing name byte',
      {
        ...dynamicVault(),
        name: { type: 'address', bcs: new Uint8Array([...USER_BCS, 0]) },
      },
    ],
    ['a wrong valueType', { ...dynamicVault(), valueType: 'address' }],
    [
      'a wrong value.type',
      { ...dynamicVault(), value: { type: 'address', bcs: USER_BCS.slice() } },
    ],
    [
      'a short value BCS',
      { ...dynamicVault(), value: { type: OBJECT_ID_TYPE, bcs: USER_BCS.slice(1) } },
    ],
    [
      'a trailing value BCS byte',
      {
        ...dynamicVault(),
        value: {
          type: OBJECT_ID_TYPE,
          bcs: new Uint8Array([...bcs.Address.serialize(VAULT_ID).toBytes(), 0]),
        },
      },
    ],
  ])('rejects %s instead of accepting an unbound registry value', async (_label, field) => {
    gateway.getDynamicField.mockResolvedValueOnce(field);
    await expect(cachedQuery()).rejects.toThrow();
    expect(gateway.getObject).not.toHaveBeenCalled();
  });

  it('reports a registered but missing vault as inconsistent state', async () => {
    gateway.getDynamicField.mockResolvedValueOnce(dynamicVault());
    gateway.getObject.mockRejectedValueOnce(notFound(VAULT_ID));

    await expect(cachedQuery()).rejects.toBeInstanceOf(CreditQueryInconsistentStateError);
  });

  it.each([
    ['another object', notFound(CHILD_ID)],
    ['an unbound provider absence', notFound()],
  ])('does not mistake %s for the registered vault absence', async (_label, error) => {
    gateway.getDynamicField.mockResolvedValueOnce(dynamicVault());
    gateway.getObject.mockRejectedValueOnce(error);

    await expect(cachedQuery()).rejects.toBe(error);
  });

  it.each([
    ['missing JSON', vaultObject('1', '1', { json: null })],
    [
      'wrong package type',
      vaultObject('1', '1', { type: `${OTHER_PACKAGE_ID}::vault::UserVault` }),
    ],
    [
      'wrong JSON identity',
      vaultObject('1', '1', { json: { id: CHILD_ID, credit: '1', last_nonce: '1' } }),
    ],
    ['a shared owner', vaultObject('1', '1', { owner: { $kind: 'Shared', Shared: {} } })],
    [
      'another address owner',
      vaultObject('1', '1', {
        owner: { $kind: 'AddressOwner', AddressOwner: OTHER_ADDR },
      }),
    ],
    ['missing credit', vaultObject('1', '1', { json: { id: VAULT_ID, last_nonce: '1' } })],
    ['numeric credit', vaultObject(1, '1')],
    ['non-decimal credit', vaultObject('0x10', '1')],
    ['u64 overflow', vaultObject('18446744073709551616', '1')],
  ])('rejects a registered vault with %s', async (_label, object) => {
    gateway.getDynamicField.mockResolvedValueOnce(dynamicVault());
    gateway.getObject.mockResolvedValueOnce(object);

    await expect(cachedQuery()).rejects.toBeInstanceOf(CreditQueryInconsistentStateError);
  });

  it('propagates non-not-found operation errors without reclassification', async () => {
    const error = new SuiOperationError('transport_unavailable', {
      operation: 'get_object',
      attempt: 1,
      maxAttempts: 1,
      rpcCode: 'UNAVAILABLE',
    });
    gateway.getDynamicField.mockResolvedValueOnce(dynamicVault());
    gateway.getObject.mockRejectedValueOnce(error);

    await expect(cachedQuery()).rejects.toBe(error);
  });
});
