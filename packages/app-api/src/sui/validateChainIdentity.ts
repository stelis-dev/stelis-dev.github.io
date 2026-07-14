/**
 * Boot-time chain identity validation.
 *
 * Probes each endpoint for chainIdentifier. Responding endpoints must agree
 * and match the canonical identity for NETWORK. Endpoints that fail to respond
 * (e.g. gRPC v2 transport mismatch) are warned but do not block boot.
 *
 * Per-endpoint clients preserve endpoint-local auth metadata and fetchInit.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { GrpcWebFetchTransport } from '@protobuf-ts/grpcweb-transport';
import { SUI_CHAIN_IDENTIFIERS, type SuiNetwork } from '@stelis/contracts';
import type { SuiRpcEndpointConfig } from './failoverTransport.js';
import { redactEndpointUrl, redactSensitiveText } from '@stelis/core-api/observability';

export interface ChainIdentityResult {
  chainIdentifier: string;
  endpointResults: Array<{
    url: string;
    chainIdentifier: string | null;
    error: string | null;
  }>;
}

/**
 * Validate chain identity across all configured endpoints.
 *
 * 1. Queries each endpoint individually (preserving per-endpoint auth/fetchInit)
 * 2. Requires all successful responses to agree on the same chainIdentifier
 * 3. Requires at least one endpoint to respond successfully
 * 4. Requires the agreed chainIdentifier to match the canonical value for NETWORK
 *
 * @throws Error on mismatch, all-failed, or unknown network mapping
 */
export async function validateChainIdentity(
  network: SuiNetwork,
  endpoints: SuiRpcEndpointConfig[],
): Promise<ChainIdentityResult> {
  const expectedChainId = SUI_CHAIN_IDENTIFIERS[network];
  if (!expectedChainId) {
    throw new Error(`[app-api] No canonical chainIdentifier for network "${network}".`);
  }

  // Query each endpoint individually
  const results = await Promise.all(
    endpoints.map(async (ep) => {
      try {
        const transport = new GrpcWebFetchTransport({
          baseUrl: ep.url,
          fetchInit: ep.fetchInit,
          meta: ep.meta ?? {},
        });
        const client = new SuiGrpcClient({ network, transport });
        const result = await client.core.getChainIdentifier();
        return {
          url: ep.url,
          chainIdentifier: result.chainIdentifier,
          error: null,
        };
      } catch (err) {
        return {
          url: ep.url,
          chainIdentifier: null,
          error: redactSensitiveText(err instanceof Error ? err.message : String(err)),
        };
      }
    }),
  );

  // Policy: require at least one successful probe and warn on probe
  // failures. Some providers (e.g. nodeinfra.com) do not support the gRPC v2
  // `getServiceInfo` call even though their normal RPC API (simulate,
  // getBalance, etc.) works; those must not block boot.
  const successful = results.filter((r) => r.chainIdentifier !== null);
  const failed = results.filter((r) => r.error !== null);

  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[app-api] Chain identity probe failed for ${failed.length}/${results.length} endpoint(s): ` +
        failed.map((r) => `${redactEndpointUrl(r.url)}: ${r.error}`).join('; '),
    );
  }

  if (successful.length === 0) {
    const errorSummary = results.map((r) => `${redactEndpointUrl(r.url)}: ${r.error}`).join('; ');
    throw new Error(
      `[app-api] Chain identity validation failed: no endpoint responded. ${errorSummary}`,
    );
  }

  // All responding endpoints must agree on the same chainIdentifier.
  const chainIds = new Set(successful.map((r) => r.chainIdentifier));
  if (chainIds.size > 1) {
    const mismatchSummary = successful
      .map((r) => `${redactEndpointUrl(r.url)}=${r.chainIdentifier}`)
      .join(', ');
    throw new Error(
      `[app-api] Chain identity mismatch across endpoints: ${mismatchSummary}. ` +
        `All endpoints must connect to the same ${network} network.`,
    );
  }

  const agreedChainId = successful[0].chainIdentifier!;

  // Must match the canonical expected identity
  if (agreedChainId !== expectedChainId) {
    throw new Error(
      `[app-api] Chain identity does not match NETWORK="${network}". ` +
        `Expected: ${expectedChainId}, got: ${agreedChainId}. ` +
        `Check that rpc.json endpoints are configured for ${network}.`,
    );
  }

  return { chainIdentifier: agreedChainId, endpointResults: results };
}
