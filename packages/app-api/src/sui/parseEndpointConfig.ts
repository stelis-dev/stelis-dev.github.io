/**
 * RPC endpoint config parser — parses a network-keyed JSON object of endpoint descriptors.
 *
 * Used by `loadRpcConfig()` to parse `packages/app-api/rpc.json`.
 *
 * Security model:
 *   - Secret token values are NOT stored in the JSON file — only env var names
 *   - `auth.valueEnv` references a separate ENV var holding the actual secret
 *   - Missing referenced ENV is a boot-time error (fail-fast, no synthetic fallback)
 *   - Resolved secrets are injected into `meta` (RpcMetadata) for grpc-web headers
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { SuiNetwork } from '@stelis/contracts';
import {
  canonicalizeSuiRpcBaseUrl,
  normalizeSuiRpcHeaderName,
  normalizeSuiRpcMetadata,
  type SuiRpcEndpointConfig,
  type SuiRpcMetadata,
} from './endpointClient.js';
import { redactEndpointUrl, redactSensitiveText } from '@stelis/core-api/observability';

const CONFIG_NETWORKS: readonly SuiNetwork[] = ['testnet', 'mainnet'];
const ENDPOINT_KEYS = ['baseUrl', 'localDevelopmentEndpoint', 'auth'] as const;
const AUTH_KEYS = ['header', 'valueEnv', 'prefix'] as const;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  position: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${position}: unsupported field "${key}"`);
    }
  }
}

// ─────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────

/**
 * Parse rpc.json content into resolved endpoint configs.
 *
 * @param json     Raw JSON string (rpc.json file content)
 * @param network  Active app-api NETWORK value
 * @param envLookup  Boot-snapshotted lookup for auth.valueEnv secrets.
 *                   Injected for testability.
 * @returns        Non-empty array of resolved endpoint configs
 * @throws         Error on invalid JSON, missing fields, or missing env vars
 */
export function parseEndpointConfigJson(
  json: string,
  network: SuiNetwork,
  envLookup: (name: string) => string | undefined,
): SuiRpcEndpointConfig[] {
  const trimmed = json.trim();
  if (trimmed === '') {
    throw new Error('rpc.json content must not be empty');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `rpc.json is not valid JSON: ${redactSensitiveText(err instanceof Error ? err.message : String(err))}`,
    );
  }

  const rawEndpoints = selectNetworkEndpointSection(raw, network);

  const results: SuiRpcEndpointConfig[] = [];
  const endpointBaseUrls = new Set<string>();

  for (let i = 0; i < rawEndpoints.length; i++) {
    const pos = `endpoint[${i}]`;

    // Each element must be a non-null object
    if (
      rawEndpoints[i] == null ||
      typeof rawEndpoints[i] !== 'object' ||
      Array.isArray(rawEndpoints[i])
    ) {
      throw new Error(
        `${pos}: must be a non-null object, got ${rawEndpoints[i] === null ? 'null' : typeof rawEndpoints[i]}`,
      );
    }
    const entry = rawEndpoints[i] as Record<string, unknown>;
    assertOnlyKeys(entry, ENDPOINT_KEYS, pos);

    // Validate the exact gRPC-web base URL.
    if (typeof entry.baseUrl !== 'string' || entry.baseUrl.trim() === '') {
      throw new Error(`${pos}: "baseUrl" must be a non-empty string`);
    }
    const rawBaseUrl = entry.baseUrl;
    if (entry.localDevelopmentEndpoint !== undefined) {
      if (typeof entry.localDevelopmentEndpoint !== 'boolean') {
        throw new Error(`${pos}: "localDevelopmentEndpoint" must be a boolean when provided`);
      }
    }

    let parsed: URL;
    let baseUrl: string;
    try {
      baseUrl = canonicalizeSuiRpcBaseUrl(rawBaseUrl);
      parsed = new URL(baseUrl);
    } catch (err) {
      throw new Error(
        `${pos}: invalid baseUrl "${redactEndpointUrl(rawBaseUrl)}": ${redactSensitiveText(err instanceof Error ? err.message : String(err))}`,
      );
    }
    if (endpointBaseUrls.has(baseUrl)) {
      throw new Error(`${pos}: duplicates an existing Sui RPC endpoint`);
    }
    endpointBaseUrls.add(baseUrl);

    const hasAuthConfig = entry.auth !== undefined;
    if (parsed.protocol === 'http:') {
      if (entry.localDevelopmentEndpoint !== true) {
        throw new Error(
          `${pos}: HTTP RPC endpoints require localDevelopmentEndpoint=true and are only allowed for unauthenticated local development endpoints`,
        );
      }
      if (!isLocalDevelopmentHost(parsed.hostname)) {
        throw new Error(
          `${pos}: HTTP RPC endpoints with localDevelopmentEndpoint=true must use localhost, 127.0.0.1, or ::1`,
        );
      }
      if (hasAuthConfig) {
        throw new Error(`${pos}: HTTP RPC endpoints must not carry auth headers`);
      }
    } else if (entry.localDevelopmentEndpoint !== undefined) {
      throw new Error(`${pos}: "localDevelopmentEndpoint" is valid only for local HTTP endpoints`);
    }

    // Resolved transport metadata is environment-derived only. It uses a
    // null-prototype map so valid HTTP names such as "__proto__" remain data.
    const resolvedMeta = Object.create(null) as SuiRpcMetadata;

    // Resolve auth → inject into meta
    if (hasAuthConfig) {
      if (typeof entry.auth !== 'object' || entry.auth === null || Array.isArray(entry.auth)) {
        throw new Error(`${pos}: "auth" must be an object`);
      }
      const auth = entry.auth as Record<string, unknown>;
      assertOnlyKeys(auth, AUTH_KEYS, `${pos}.auth`);
      if (typeof auth.header !== 'string' || auth.header.trim() === '') {
        throw new Error(`${pos}: "auth.header" must be a non-empty string`);
      }
      if (typeof auth.valueEnv !== 'string' || auth.valueEnv.trim() === '') {
        throw new Error(`${pos}: "auth.valueEnv" must be a non-empty string`);
      }

      if (auth.prefix !== undefined && typeof auth.prefix !== 'string') {
        throw new Error(
          `${pos}: "auth.prefix" must be a string when provided, got ${typeof auth.prefix}`,
        );
      }

      let headerName: string;
      try {
        headerName = normalizeSuiRpcHeaderName(auth.header);
      } catch (error) {
        throw new Error(`${pos}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const envName = auth.valueEnv.trim();
      if (envName !== auth.valueEnv || !ENV_NAME.test(envName)) {
        throw new Error(`${pos}: "auth.valueEnv" must be an uppercase environment variable name`);
      }
      const prefix = typeof auth.prefix === 'string' ? auth.prefix : '';

      const secretValue = envLookup(envName);
      if (secretValue == null || secretValue === '') {
        throw new Error(
          `${pos}: auth.valueEnv "${envName}" is not set or empty. ` +
            `Authenticated endpoints require the referenced ENV variable to contain the secret token.`,
        );
      }

      resolvedMeta[headerName] = `${prefix}${secretValue}`;
    }

    let meta: SuiRpcMetadata | undefined;
    try {
      meta = normalizeSuiRpcMetadata(resolvedMeta);
    } catch (error) {
      throw new Error(`${pos}: ${error instanceof Error ? error.message : String(error)}`);
    }
    results.push({
      baseUrl,
      meta,
    });
  }

  return results;
}

function selectNetworkEndpointSection(raw: unknown, network: SuiNetwork): unknown[] {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('rpc.json must contain an object with "testnet" and "mainnet" endpoint arrays');
  }

  const config = raw as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!CONFIG_NETWORKS.includes(key as SuiNetwork)) {
      throw new Error(`rpc.json contains unsupported network section "${key}"`);
    }
  }

  for (const key of CONFIG_NETWORKS) {
    if (!Array.isArray(config[key])) {
      throw new Error(`rpc.json.${key} must contain a JSON array`);
    }
  }

  const selected = config[network] as unknown[];
  if (selected.length === 0) {
    throw new Error(`rpc.json.${network} must contain at least one endpoint`);
  }
  return selected;
}

function isLocalDevelopmentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

/**
 * Load RPC endpoint config from packages/app-api/rpc.json for the active network.
 *
 * This parser defines the app-api RPC fleet configuration format.
 * Auth secrets are resolved from env vars referenced by auth.valueEnv.
 *
 * @param filePath   Override file path for testing. Default: package-local rpc.json.
 * @param envLookup  Boot-snapshotted lookup for auth.valueEnv secrets.
 * @returns          Non-empty array of resolved endpoint configs
 */
export function loadRpcConfig(
  network: SuiNetwork,
  filePath: string | undefined,
  envLookup: (name: string) => string | undefined,
): SuiRpcEndpointConfig[] {
  const resolvedPath = filePath ?? defaultRpcJsonPath();

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, 'utf-8');
  } catch (err) {
    const msg = redactSensitiveText(err instanceof Error ? err.message : String(err));
    throw new Error(
      `[app-api] Cannot read rpc.json at "${resolvedPath}": ${msg}. ` +
        `Restore the tracked packages/app-api/rpc.json config file.`,
    );
  }

  return parseEndpointConfigJson(raw, network, envLookup);
}

/**
 * Default path for rpc.json — package-local, deterministic.
 * Uses import.meta.url relative resolution from compiled output.
 */
function defaultRpcJsonPath(): string {
  // Compiled JS lives in packages/app-api/dist/sui/parseEndpointConfig.js
  // rpc.json lives at packages/app-api/rpc.json
  // At dev time (ts-node/vitest), source is packages/app-api/src/sui/parseEndpointConfig.ts
  // Both cases: walk up to packages/app-api/ and look for rpc.json
  const thisFile = fileURLToPath(import.meta.url);
  const pkgRoot = resolve(dirname(thisFile), '..', '..');
  return resolve(pkgRoot, 'rpc.json');
}
