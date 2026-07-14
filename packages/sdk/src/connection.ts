/** Convert a wire-validated Relay config into the SDK's bigint-safe runtime shape. */
import type { RelayConfig, RelayConfigResponse } from './types.js';

export function parseRelayConfig(wire: RelayConfigResponse): RelayConfig {
  return {
    ...wire,
    supportedSettlementSwapPaths: wire.supportedSettlementSwapPaths.map((path) => ({
      ...path,
      lotSize: BigInt(path.lotSize),
      minSize: BigInt(path.minSize),
    })),
  };
}
