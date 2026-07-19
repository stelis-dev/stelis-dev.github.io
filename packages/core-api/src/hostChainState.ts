import { isValidSuiAddress, normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import {
  getSuiObject,
  getSuiObjects,
  type OnchainConfig,
  type SuiEndpointSnapshot,
  type SuiObject,
} from '@stelis/core-relay';

const CANONICAL_U64 = /^(?:0|[1-9]\d*)$/;

export interface HostChainStateIds {
  readonly packageId: string;
  readonly configId: string;
  readonly vaultRegistryId: string;
}

/** Boot-qualified on-chain inputs consumed by the Host runtime. */
export interface HostChainState {
  readonly config: OnchainConfig;
  readonly vaultRegistryId: string;
  readonly vaultsTableId: string;
}

function requireAddress(value: string, name: keyof HostChainStateIds): string {
  if (!isValidSuiAddress(value)) {
    throw new TypeError(`${name} must be a Sui object address`);
  }
  return normalizeSuiAddress(value);
}

function normalizeIds(ids: HostChainStateIds): HostChainStateIds {
  return Object.freeze({
    packageId: requireAddress(ids.packageId, 'packageId'),
    configId: requireAddress(ids.configId, 'configId'),
    vaultRegistryId: requireAddress(ids.vaultRegistryId, 'vaultRegistryId'),
  });
}

function requireJson(object: SuiObject, label: string): Record<string, unknown> {
  if (!object.json) throw new Error(`${label} is missing current JSON content`);
  return object.json;
}

function requireObjectType(object: SuiObject, expected: string, label: string): void {
  let actual: string;
  try {
    actual = normalizeStructTag(object.type);
  } catch {
    throw new Error(`${label} has an invalid Move type`);
  }
  if (actual !== normalizeStructTag(expected)) {
    throw new Error(`${label} has the wrong Move type`);
  }
}

function requireExactId(value: unknown, expected: string, label: string): void {
  if (typeof value !== 'string' || !isValidSuiAddress(value)) {
    throw new Error(`${label}.id is not a Sui object address`);
  }
  if (normalizeSuiAddress(value) !== expected) {
    throw new Error(`${label}.id does not match the requested object`);
  }
}

function requireU64(value: unknown, ownerPath: string): bigint {
  if (typeof value !== 'string' || !CANONICAL_U64.test(value)) {
    throw new Error(`${ownerPath} is not a canonical unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) {
    throw new Error(`${ownerPath} exceeds u64`);
  }
  return parsed;
}

function parseConfig(object: SuiObject, ids: HostChainStateIds): OnchainConfig {
  requireObjectType(object, `${ids.packageId}::config::Config`, 'Config');
  const json = requireJson(object, 'Config');
  requireExactId(json.id, ids.configId, 'Config');
  return Object.freeze({
    packageId: ids.packageId,
    configId: ids.configId,
    maxClaimMist: requireU64(json.max_claim_mist, 'Config.max_claim_mist'),
    minSettleMist: requireU64(json.min_settle_mist, 'Config.min_settle_mist'),
    maxHostFeeMist: requireU64(json.max_host_fee_mist, 'Config.max_host_fee_mist'),
    protocolFlatFeeMist: requireU64(json.protocol_flat_fee_mist, 'Config.protocol_flat_fee_mist'),
    configVersion: requireU64(json.config_version, 'Config.config_version'),
    maxSpreadBps: requireU64(json.max_spread_bps, 'Config.max_spread_bps'),
  });
}

function parseVaultsTableId(object: SuiObject, ids: HostChainStateIds): string {
  requireObjectType(object, `${ids.packageId}::vault::VaultRegistry`, 'VaultRegistry');
  const json = requireJson(object, 'VaultRegistry');
  requireExactId(json.id, ids.vaultRegistryId, 'VaultRegistry');
  if (typeof json.vaults !== 'object' || json.vaults === null || Array.isArray(json.vaults)) {
    throw new Error('VaultRegistry.vaults is not the current Table shape');
  }
  const table = json.vaults as Record<string, unknown>;
  if (typeof table.id !== 'string' || !isValidSuiAddress(table.id)) {
    throw new Error('VaultRegistry.vaults.id is not a Sui object address');
  }
  requireU64(table.size, 'VaultRegistry.vaults.size');
  return normalizeSuiAddress(table.id);
}

/** Read the current Config object for cache refreshes. */
export async function readOnchainConfig(
  sui: SuiEndpointSnapshot,
  idsInput: HostChainStateIds,
  signal?: AbortSignal,
): Promise<OnchainConfig> {
  const ids = normalizeIds(idsInput);
  const object = await getSuiObject(sui, { objectId: ids.configId, signal });
  return parseConfig(object, ids);
}

/**
 * Read and bind the exact Config and VaultRegistry objects in one validated
 * endpoint operation. Boot passes this immutable result into Host creation;
 * context construction never repeats the readiness reads.
 */
export async function readHostChainState(
  sui: SuiEndpointSnapshot,
  idsInput: HostChainStateIds,
  signal?: AbortSignal,
): Promise<HostChainState> {
  const ids = normalizeIds(idsInput);
  const [configObject, vaultRegistryObject] = await getSuiObjects(sui, {
    objectIds: [ids.configId, ids.vaultRegistryId],
    signal,
  });
  return Object.freeze({
    config: parseConfig(configObject!, ids),
    vaultRegistryId: ids.vaultRegistryId,
    vaultsTableId: parseVaultsTableId(vaultRegistryObject!, ids),
  });
}
