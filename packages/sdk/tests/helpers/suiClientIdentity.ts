import type { SuiNetwork } from '@stelis/contracts';
import { SUI_CHAIN_IDENTIFIERS } from '@stelis/contracts';
import type { SuiGrpcClient } from '@mysten/sui/grpc';

/** Attach the exact declared/live network proof used by SDK consumer fixtures. */
export function withSuiClientIdentity<T extends Record<string, unknown>>(
  client: T,
  network: SuiNetwork = 'testnet',
  chainIdentifier = SUI_CHAIN_IDENTIFIERS[network],
): T & SuiGrpcClient {
  const ledgerService =
    typeof client.ledgerService === 'object' && client.ledgerService !== null
      ? (client.ledgerService as Record<string, unknown>)
      : {};
  return Object.assign(client, {
    network,
    ledgerService: {
      ...ledgerService,
      getServiceInfo: async () => ({ response: { chainId: chainIdentifier } }),
    },
  }) as unknown as T & SuiGrpcClient;
}
