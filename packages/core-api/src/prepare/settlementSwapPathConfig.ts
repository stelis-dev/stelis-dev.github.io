import type { SingleHopSettlementSwapPath } from '@stelis/contracts';
import type {
  StaticSettlementSwapPathDescriptor,
  StaticSettlementSwapPathDescriptorMap,
} from '@stelis/core-relay/server';
import { PrepareValidationError } from './replay.js';

export interface SettlementSwapPathConfig {
  readonly settlementSwapPath: SingleHopSettlementSwapPath;
  readonly descriptor: StaticSettlementSwapPathDescriptor;
}

/** Resolve the one current runtime path and server descriptor for a token. */
export function requireSettlementSwapPathConfig(
  supportedSettlementSwapPaths: readonly SingleHopSettlementSwapPath[],
  descriptors: StaticSettlementSwapPathDescriptorMap,
  settlementTokenType: string,
): SettlementSwapPathConfig {
  const settlementSwapPath = supportedSettlementSwapPaths.find(
    (candidate) => candidate.settlementTokenType === settlementTokenType,
  );
  if (!settlementSwapPath) {
    throw new PrepareValidationError(
      'UNSUPPORTED_SETTLEMENT_TOKEN',
      `Settlement token ${settlementTokenType} is not supported`,
    );
  }
  const descriptor = descriptors.get(settlementTokenType);
  if (!descriptor) {
    throw new Error(
      `[PREPARE_CONFIG] Missing StaticSettlementSwapPathDescriptor for ${settlementTokenType}`,
    );
  }
  return { settlementSwapPath, descriptor };
}
