import { SUI_CHAIN_IDENTIFIERS, type SuiNetwork } from '@stelis/contracts';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { assertSuiNetwork, createSuiEndpointSnapshot } from '@stelis/core-relay/browser';

const SUI_RPC_URL_BY_NETWORK: Record<SuiNetwork, string> = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
};

export function getSuiRpcUrl(network: SuiNetwork): string {
  return SUI_RPC_URL_BY_NETWORK[network];
}

/** Create one app-admin client only after its declared and live chain identity agree. */
export async function createVerifiedAdminSuiClient(network: SuiNetwork): Promise<SuiGrpcClient> {
  const client = new SuiGrpcClient({
    network,
    baseUrl: getSuiRpcUrl(network),
  });
  await assertSuiNetwork(createSuiEndpointSnapshot([client]), {
    network,
    chainIdentifier: SUI_CHAIN_IDENTIFIERS[network],
  });
  return client;
}
