/**
 * Shared Sui client factory for app-api.
 *
 * Always creates a SuiGrpcClient with SuiRpcFailoverTransport, even for
 * single-endpoint configurations. This ensures uniform transport-backed
 * behavior, honest admin snapshots, and consistent per-endpoint auth metadata.
 *
 * All host-side construction paths (boot probe, settlement swap path registry load,
 * relay context) must use this factory to ensure unified failover behavior.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import type { SuiNetwork } from '@stelis/contracts';
import { SuiRpcFailoverTransport } from './failoverTransport.js';
import type { SuiRpcEndpointConfig, FailoverTransportOptions } from './failoverTransport.js';

export interface CreateSuiClientOptions {
  network: SuiNetwork;
  endpoints: SuiRpcEndpointConfig[];
  failover?: FailoverTransportOptions;
}

export interface CreateSuiClientResult {
  client: SuiGrpcClient;
  /** Primary-pinned client used by the serialized Sponsor Refill Account spend flow. */
  primaryClient: SuiGrpcClient;
  /** Failover transport — always present (no single-endpoint fast path). */
  failoverTransport: SuiRpcFailoverTransport;
}

/**
 * Create a SuiGrpcClient from resolved endpoint descriptors.
 *
 * Every configuration — including single-endpoint — uses the transport-backed path.
 */
export function createSuiClient(options: CreateSuiClientOptions): CreateSuiClientResult {
  const { network, endpoints } = options;
  const transport = new SuiRpcFailoverTransport(endpoints, options.failover);
  const primaryTransport = new SuiRpcFailoverTransport([endpoints[0]!], options.failover);
  return {
    client: new SuiGrpcClient({ network, transport }),
    primaryClient: new SuiGrpcClient({ network, transport: primaryTransport }),
    failoverTransport: transport,
  };
}
