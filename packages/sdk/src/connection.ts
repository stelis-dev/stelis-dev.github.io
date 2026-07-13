/** Relay config loading and conversion into the SDK's bigint-safe runtime shape. */
import { parseRelayConfigResponse as parseHostRelayConfigResponse } from '@stelis/contracts';
import type { RelayConfig, StelisRequestTimeouts } from './types.js';

const DEFAULT_RELAY_CONFIG_TIMEOUT_MS = 5_000;

export async function fetchRelayConfig(
  endpoint: string,
  requestTimeouts?: StelisRequestTimeouts,
): Promise<unknown> {
  const configUrl = endpoint.replace(/\/relay\/?$/, '') + '/relay/config';
  const timeoutMs = resolveConfigTimeoutMs(requestTimeouts?.configMs);
  const res = await fetch(configUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET /relay/config failed: ${res.status}`);
  return res.json();
}

function resolveConfigTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_RELAY_CONFIG_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `[StelisSDK] requestTimeouts.configMs must be a positive integer within Number.MAX_SAFE_INTEGER, got ${String(timeoutMs)}`,
    );
  }
  return timeoutMs;
}

export function parseRelayConfig(data: unknown): RelayConfig {
  const wire = parseHostRelayConfigResponse(data);
  return {
    ...wire,
    supportedSettlementSwapPaths: wire.supportedSettlementSwapPaths.map((path) => ({
      ...path,
      lotSize: BigInt(path.lotSize),
      minSize: BigInt(path.minSize),
    })),
  };
}
