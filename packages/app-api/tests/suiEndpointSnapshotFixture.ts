import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { SUI_CHAIN_IDENTIFIERS } from '@stelis/contracts';
import {
  createChainBoundSuiEndpointSnapshot,
  type ChainBoundSuiEndpointSnapshot,
} from '@stelis/core-relay';

/**
 * Create a real opaque endpoint snapshot for tests that mock the gateway
 * operation they exercise. Tests must keep operation fixtures outside the
 * snapshot instead of adding raw-client or legacy snapshot fields.
 */
export function suiEndpointSnapshotFixture(
  network: 'testnet' | 'mainnet' = 'testnet',
): ChainBoundSuiEndpointSnapshot {
  const client = Object.freeze({ network }) as unknown as SuiGrpcClient;
  return createChainBoundSuiEndpointSnapshot([client], SUI_CHAIN_IDENTIFIERS[network]);
}
