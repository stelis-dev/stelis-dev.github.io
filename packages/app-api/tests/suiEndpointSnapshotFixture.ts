import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { createSuiEndpointSnapshot, type SuiEndpointSnapshot } from '@stelis/core-relay';

/**
 * Create a real opaque endpoint snapshot for tests that mock the gateway
 * operation they exercise. Tests must keep operation fixtures outside the
 * snapshot instead of adding raw-client or legacy snapshot fields.
 */
export function suiEndpointSnapshotFixture(
  network: 'testnet' | 'mainnet' = 'testnet',
): SuiEndpointSnapshot {
  const client = Object.freeze({ network }) as unknown as SuiGrpcClient;
  return createSuiEndpointSnapshot([client]);
}
