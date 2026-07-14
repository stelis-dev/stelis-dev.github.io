/**
 * Shared credit query helper for vault and credit lookups.
 *
 * Used by:
 *   - sdk/src/sdk.ts                (client-side, gas estimation + sponsored flow)
 *   - sdk/src/index.ts              (re-exports queryUserCredit for SDK public API)
 *   - core-api/src/session/sponsoredExecution/genericExecutionPolicy.ts
 *     (server-side prepare snapshot + sponsor new-user User Vault drift check)
 *
 * Both SDK and core-api import this to guarantee identical vault/credit
 * resolution for the same on-chain state.
 */
import { bcs } from '@mysten/sui/bcs';
import type { SuiGrpcClient } from '@mysten/sui/grpc';

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

function parseVaultDecimalField(
  value: string,
  field: 'credit' | 'last_nonce',
  vaultId: string,
  userAddress: string,
): string {
  if (!DECIMAL_U64_RE.test(value)) {
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
 * Uses the caller-provided SuiGrpcClient — works identically
 * whether called from SDK (browser) or core-api (server).
 *
 * Returns:
 *   - vaultObjectId: null if no vault exists
 *   - credit: MIST balance as string
 *   - needsCreate: true if vault does not exist yet
 */
export async function queryUserCredit(
  suiClient: SuiGrpcClient,
  vaultRegistryId: string,
  addr: string,
  /** Pre-cached vaults table ID — skips registry getObject when provided. */
  vaultsTableId?: string,
): Promise<CreditResult> {
  // Step 1: Use cached tableId or fetch from registry
  let tableId = vaultsTableId ?? null;
  if (!tableId) {
    const registryObj = await suiClient.getObject({
      objectId: vaultRegistryId,
      include: { json: true },
    });
    const registryFields = extractMoveObjectFields(registryObj.object);
    tableId = extractVaultTableId(registryFields);
  }
  if (!tableId) {
    throw new Error(
      `VaultRegistry ${vaultRegistryId} is missing the vaults table ID in JSON content`,
    );
  }

  // Step 2: Look up user's vault ID from the dynamic field table
  let registeredVaultId: string;
  try {
    const { dynamicField } = await suiClient.getDynamicField({
      parentId: tableId,
      name: {
        type: 'address',
        bcs: bcs.Address.serialize(addr).toBytes(),
      },
    });
    registeredVaultId = bcs.Address.parse(dynamicField.value.bcs);
  } catch (error) {
    if (isDynamicFieldNotFound(error)) {
      return { vaultObjectId: null, credit: '0', needsCreate: true, lastNonce: '0' };
    }
    // `@mysten/sui/grpc` resolves getDynamicField by deriving the child-object
    // ID deterministically and calling getObjects(). When the entry does not
    // exist, the error is a plain "Object <derivedChildId> not found" from
    // getObjects. Distinguish: if the missing object ID equals tableId, the
    // parent table is gone (fail-closed throw). Otherwise it is the child
    // entry — user has no vault, return needsCreate.
    if (isObjectNotFound(error)) {
      const missingId = extractObjectNotFoundId(error);
      if (missingId && missingId.toLowerCase() !== tableId.toLowerCase()) {
        return { vaultObjectId: null, credit: '0', needsCreate: true, lastNonce: '0' };
      }
    }
    throw error;
  }

  // Step 3: Fetch the vault object to read credit balance and last_nonce
  const vaultObj = await suiClient
    .getObject({
      objectId: registeredVaultId,
      include: { json: true },
    })
    .catch((error: unknown) => {
      if (isObjectNotFound(error)) return null;
      throw error;
    });

  if (!vaultObj) {
    throw new CreditQueryInconsistentStateError(
      `Registry contains vault ${registeredVaultId} for user ${addr}, but the vault object was not found on-chain. ` +
        `The new_user path is invalid because the registry entry already exists.`,
      registeredVaultId,
      addr,
    );
  }

  const vaultFields = extractMoveObjectFields(vaultObj.object);
  if (!vaultFields) {
    throw new CreditQueryInconsistentStateError(
      `Registered vault ${registeredVaultId} for user ${addr} exists but is missing JSON content.`,
      registeredVaultId,
      addr,
    );
  }

  const resolveField = (name: string): string => {
    const value =
      vaultFields[name] ??
      (vaultFields.fields && typeof vaultFields.fields === 'object'
        ? (vaultFields.fields as Record<string, unknown>)[name]
        : undefined);
    if (value === undefined || value === null) {
      throw new CreditQueryInconsistentStateError(
        `Registered vault ${registeredVaultId} for user ${addr} is missing required field '${name}'.`,
        registeredVaultId,
        addr,
      );
    }
    return String(value);
  };

  return {
    vaultObjectId: registeredVaultId,
    credit: parseVaultDecimalField(resolveField('credit'), 'credit', registeredVaultId, addr),
    lastNonce: parseVaultDecimalField(
      resolveField('last_nonce'),
      'last_nonce',
      registeredVaultId,
      addr,
    ),
    needsCreate: false,
  };
}

// ─────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────

/**
 * Extract the vaults table object ID from VaultRegistry JSON fields.
 * Exported for context.ts warmUp() to resolve once and cache.
 */
export function extractVaultTableId(registryFields: Record<string, unknown> | null): string | null {
  if (!registryFields) return null;
  const table =
    registryFields.vaults ??
    (registryFields.fields && typeof registryFields.fields === 'object'
      ? (registryFields.fields as Record<string, unknown>).vaults
      : undefined);
  return extractObjectId(table);
}

function isDynamicFieldNotFound(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === 'dynamicFieldNotFound'
  );
}

/**
 * Extract the object ID from an "Object <id> not found" error message.
 * Returns null if the error shape doesn't match.
 */
function extractObjectNotFoundId(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  if (!('message' in error) || typeof error.message !== 'string') return null;
  const match = error.message.match(/Object (0x[0-9a-fA-F]+) not found/);
  return match ? match[1] : null;
}

function isObjectNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && typeof error.code === 'string') {
    if (error.code === 'notFound' || error.code === 'objectNotFound') return true;
  }
  if ('message' in error && typeof error.message === 'string') {
    return /Object .* not found/.test(error.message);
  }
  return false;
}

function extractObjectId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id === 'string') return v.id;
  if (v.id && typeof v.id === 'object') {
    const nested = v.id as Record<string, unknown>;
    if (typeof nested.id === 'string') return nested.id;
  }
  if (v.fields && typeof v.fields === 'object') {
    const f = v.fields as Record<string, unknown>;
    if (typeof f.id === 'string') return f.id;
    if (f.id && typeof f.id === 'object') {
      const fid = f.id as Record<string, unknown>;
      if (typeof fid.id === 'string') return fid.id;
    }
  }
  return null;
}

/**
 * Extract Move object fields from a getObject response.
 * First tries `json`, then falls back to `content.fields`.
 * Exported for context.ts warmUp() to resolve VaultRegistry fields.
 */
export function extractMoveObjectFields(objectData: unknown): Record<string, unknown> | null {
  if (!objectData || typeof objectData !== 'object') return null;
  const obj = objectData as Record<string, unknown>;
  if (obj.json && typeof obj.json === 'object') return obj.json as Record<string, unknown>;
  if (obj.content && typeof obj.content === 'object') {
    const content = obj.content as Record<string, unknown>;
    if (content.fields && typeof content.fields === 'object')
      return content.fields as Record<string, unknown>;
  }
  return null;
}
