import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { SETTLEMENT_CONTRACT_NETWORK, SUI_CHAIN_IDENTIFIERS } from '@stelis/contracts';
import {
  assertSuiNetwork,
  createSuiEndpointSnapshot,
  type SuiEndpointSnapshot,
} from '@stelis/core-relay/browser';

/** Prove that a server-side settlement read targets the deployed package network. */
export async function createSettlementSuiEndpoint(
  client: SuiGrpcClient,
): Promise<SuiEndpointSnapshot> {
  const endpoint = createSuiEndpointSnapshot([client]);
  await assertSuiNetwork(endpoint, {
    network: SETTLEMENT_CONTRACT_NETWORK,
    chainIdentifier: SUI_CHAIN_IDENTIFIERS[SETTLEMENT_CONTRACT_NETWORK],
  });
  return endpoint;
}
