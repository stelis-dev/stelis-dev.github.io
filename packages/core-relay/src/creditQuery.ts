/**
 * Shared credit query helper for vault and credit lookups.
 *
 * Used by:
 *   - sdk/src/sdk.ts                (SDK-owned credit query method)
 *   - core-api/src/session/sponsoredExecution/genericExecutionPolicy.ts
 *     (server-side prepare snapshot + sponsor new-user User Vault drift check)
 *
 * Both SDK and core-api import this to guarantee identical vault/credit
 * resolution for the same on-chain state.
 */
import { bcs, TypeTagSerializer } from '@mysten/sui/bcs';
import {
  deriveDynamicFieldID,
  isValidSuiAddress,
  normalizeStructTag,
  normalizeSuiAddress,
  SUI_ADDRESS_LENGTH,
} from '@mysten/sui/utils';
import {
  getSuiDynamicField,
  getSuiObject,
  type SuiDynamicField,
  type SuiObject,
} from './sui/suiStateGateways.js';
import { SuiOperationError, type SuiEndpointSnapshot } from './sui/suiOperation.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface CreditResult {
  vaultObjectId: string | null;
  credit: string;
  needsCreate: boolean;
  /** S-14: last recorded monotonic nonce on the vault (string for SDK-safe u64). '0' if vault doesn't exist. */
  lastNonce: string;
}

// ─────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────

/**
 * Thrown when on-chain vault state is inconsistent:
 * the registry points to a vault ID, but the vault object cannot be found
 * or its required fields are missing.
 *
 * Consumers (e.g. core-api handlePrepare) map this to their own error type.
 */
export class CreditQueryInconsistentStateError extends Error {
  override readonly name = 'CreditQueryInconsistentStateError';
  constructor(
    message: string,
    public readonly vaultId: string,
    public readonly userAddress: string,
  ) {
    super(message);
  }
}

const DECIMAL_U64_RE = /^(?:0|[1-9]\d*)$/;
const U64_MAX = 18_446_744_073_709_551_615n;
const ADDRESS_TYPE = 'address';
const OBJECT_ID_TYPE = normalizeStructTag('0x2::object::ID');

function requireAddress(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidSuiAddress(value)) {
    throw new TypeError(`${field} must be a Sui address`);
  }
  return normalizeSuiAddress(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function requireMoveObjectIdentity(
  object: SuiObject,
  expectedObjectId: string,
  expectedType: string,
  label: string,
): Record<string, unknown> {
  if (requireAddress(object.objectId, `${label}.objectId`) !== expectedObjectId) {
    throw new Error(`${label} object ID does not match the requested object`);
  }
  let actualType: string;
  try {
    actualType = normalizeStructTag(object.type);
  } catch {
    throw new Error(`${label} has an invalid Move type`);
  }
  if (actualType !== expectedType) {
    throw new Error(`${label} has the wrong Move type`);
  }
  if (!object.json) {
    throw new Error(`${label} is missing current JSON content`);
  }
  if (requireAddress(object.json.id, `${label}.id`) !== expectedObjectId) {
    throw new Error(`${label}.id does not match the requested object`);
  }
  return object.json;
}

function parseRegisteredVaultId(
  dynamicField: SuiDynamicField,
  expectedUserBcs: Uint8Array,
): string {
  if (dynamicField.$kind !== 'DynamicField') {
    throw new Error('Vault registry entry is not a current DynamicField');
  }
  if (
    dynamicField.name.type !== ADDRESS_TYPE ||
    !(dynamicField.name.bcs instanceof Uint8Array) ||
    !bytesEqual(dynamicField.name.bcs, expectedUserBcs)
  ) {
    throw new Error('Vault registry entry name does not match the requested user');
  }
  if (
    dynamicField.valueType !== OBJECT_ID_TYPE ||
    dynamicField.value.type !== OBJECT_ID_TYPE ||
    !(dynamicField.value.bcs instanceof Uint8Array) ||
    dynamicField.value.bcs.length !== SUI_ADDRESS_LENGTH
  ) {
    throw new Error('Vault registry entry is not an exact 0x2::object::ID value');
  }
  const registeredVaultId = requireAddress(
    bcs.Address.parse(dynamicField.value.bcs),
    'Vault registry entry value',
  );
  if (!bytesEqual(bcs.Address.serialize(registeredVaultId).toBytes(), dynamicField.value.bcs)) {
    throw new Error('Vault registry entry value is not a canonical object ID');
  }
  return registeredVaultId;
}

function parseVaultDecimalField(
  value: string,
  field: 'credit' | 'last_nonce',
  vaultId: string,
  userAddress: string,
): string {
  if (!DECIMAL_U64_RE.test(value) || BigInt(value) > U64_MAX) {
    throw new CreditQueryInconsistentStateError(
      `Registered vault ${vaultId} for user ${userAddress} has invalid decimal field '${field}'.`,
      vaultId,
      userAddress,
    );
  }
  return BigInt(value).toString();
}

// ─────────────────────────────────────────────
// Core function
// ─────────────────────────────────────────────

/**
 * Query user vault credit directly from on-chain state.
 *
 * Uses one immutable snapshot of already-qualified endpoint clients.
 *
 * Returns:
 *   - vaultObjectId: null if no vault exists
 *   - credit: MIST balance as string
 *   - needsCreate: true if vault does not exist yet
 */
export async function queryUserCredit(
  snapshot: SuiEndpointSnapshot,
  expectedPackageId: string,
  vaultRegistryId: string,
  addr: string,
  /** Pre-cached vaults table ID — skips registry getObject when provided. */
  vaultsTableId?: string,
): Promise<CreditResult> {
  const packageId = requireAddress(expectedPackageId, 'expectedPackageId');
  const registryId = requireAddress(vaultRegistryId, 'vaultRegistryId');
  const userAddress = requireAddress(addr, 'userAddress');
  const registryType = normalizeStructTag(`${packageId}::vault::VaultRegistry`);
  const vaultType = normalizeStructTag(`${packageId}::vault::UserVault`);

  // Step 1: Use cached tableId or fetch from registry
  let tableId: string;
  if (vaultsTableId !== undefined) {
    tableId = requireAddress(vaultsTableId, 'vaultsTableId');
  } else {
    const registryObject = await getSuiObject(snapshot, { objectId: registryId });
    const registryFields = requireMoveObjectIdentity(
      registryObject,
      registryId,
      registryType,
      'VaultRegistry',
    );
    const extractedTableId = extractVaultTableId(registryFields);
    if (!extractedTableId) {
      throw new Error(`VaultRegistry ${registryId} is missing the vaults table ID in JSON content`);
    }
    tableId = extractedTableId;
  }

  // Step 2: Look up user's vault ID from the dynamic field table
  const userBcs = bcs.Address.serialize(userAddress).toBytes();
  const expectedFieldId = normalizeSuiAddress(
    deriveDynamicFieldID(tableId, TypeTagSerializer.parseFromStr(ADDRESS_TYPE, true), userBcs),
  );
  let registeredVaultId: string;
  try {
    const dynamicField = await getSuiDynamicField(snapshot, {
      parentId: tableId,
      name: {
        type: ADDRESS_TYPE,
        bcs: userBcs,
      },
    });
    registeredVaultId = parseRegisteredVaultId(dynamicField, userBcs);
  } catch (error) {
    if (error instanceof SuiOperationError && error.kind === 'not_found') {
      const missingId = error.diagnostic.resourceId;
      if (
        typeof missingId === 'string' &&
        isValidSuiAddress(missingId) &&
        normalizeSuiAddress(missingId) === expectedFieldId
      ) {
        return { vaultObjectId: null, credit: '0', needsCreate: true, lastNonce: '0' };
      }
    }
    throw error;
  }

  // Step 3: Fetch the vault object to read credit balance and last_nonce
  const vaultObject = await getSuiObject(snapshot, { objectId: registeredVaultId }).catch(
    (error: unknown) => {
      if (
        error instanceof SuiOperationError &&
        error.kind === 'not_found' &&
        typeof error.diagnostic.resourceId === 'string' &&
        isValidSuiAddress(error.diagnostic.resourceId) &&
        normalizeSuiAddress(error.diagnostic.resourceId) === registeredVaultId
      ) {
        return null;
      }
      throw error;
    },
  );

  if (!vaultObject) {
    throw new CreditQueryInconsistentStateError(
      `Registry contains vault ${registeredVaultId} for user ${userAddress}, but the vault object was not found on-chain. ` +
        `The new_user path is invalid because the registry entry already exists.`,
      registeredVaultId,
      userAddress,
    );
  }

  let vaultFields: Record<string, unknown>;
  try {
    vaultFields = requireMoveObjectIdentity(vaultObject, registeredVaultId, vaultType, 'UserVault');
    if (
      vaultObject.owner.$kind !== 'AddressOwner' ||
      requireAddress(vaultObject.owner.AddressOwner, 'UserVault owner') !== userAddress
    ) {
      throw new Error('UserVault owner does not match the requested user');
    }
  } catch (error) {
    throw new CreditQueryInconsistentStateError(
      `Registered vault ${registeredVaultId} for user ${userAddress} has inconsistent identity: ${
        error instanceof Error ? error.message : String(error)
      }`,
      registeredVaultId,
      userAddress,
    );
  }

  const resolveField = (name: string): string => {
    const value = vaultFields[name];
    if (typeof value !== 'string') {
      throw new CreditQueryInconsistentStateError(
        `Registered vault ${registeredVaultId} for user ${userAddress} is missing string field '${name}'.`,
        registeredVaultId,
        userAddress,
      );
    }
    return value;
  };

  return {
    vaultObjectId: registeredVaultId,
    credit: parseVaultDecimalField(
      resolveField('credit'),
      'credit',
      registeredVaultId,
      userAddress,
    ),
    lastNonce: parseVaultDecimalField(
      resolveField('last_nonce'),
      'last_nonce',
      registeredVaultId,
      userAddress,
    ),
    needsCreate: false,
  };
}

// ─────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────

/**
 * Extract the exact current gRPC JSON table identity from VaultRegistry.
 */
function extractVaultTableId(registryFields: Record<string, unknown> | null): string | null {
  if (!registryFields) return null;
  const table = registryFields.vaults;
  if (typeof table !== 'object' || table === null || Array.isArray(table)) return null;
  const current = table as Record<string, unknown>;
  if (
    typeof current.id !== 'string' ||
    !isValidSuiAddress(current.id) ||
    typeof current.size !== 'string' ||
    !DECIMAL_U64_RE.test(current.size) ||
    BigInt(current.size) > U64_MAX
  ) {
    return null;
  }
  return normalizeSuiAddress(current.id);
}
