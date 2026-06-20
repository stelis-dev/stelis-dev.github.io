import type {
  StaticSettlementSwapPathDescriptor,
  StaticSettlementSwapPathDescriptorMap,
  StaticSettlementSwapPathDescriptorSource,
} from './types.js';

export function createStaticSettlementSwapPathDescriptor(
  source: StaticSettlementSwapPathDescriptorSource,
): StaticSettlementSwapPathDescriptor {
  return {
    settlementTokenType: source.settlementTokenType,
    settlementTokenSymbol: source.settlementTokenSymbol,
    settlementTokenDecimals: source.settlementTokenDecimals,
    effectiveFeeRateBps: source.effectiveFeeRateBps,
    settlementSwapDirection: source.settlementSwapDirection,
    hops: source.hops.map((hop) => ({ ...hop })),
    lotSize: source.lotSize,
    minSize: source.minSize,
  };
}

export function createStaticSettlementSwapPathDescriptorMap(
  sources: readonly StaticSettlementSwapPathDescriptorSource[],
): StaticSettlementSwapPathDescriptorMap {
  const map: StaticSettlementSwapPathDescriptorMap = new Map();
  for (const source of sources) {
    map.set(source.settlementTokenType, createStaticSettlementSwapPathDescriptor(source));
  }
  return map;
}
