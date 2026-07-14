import { describe, expectTypeOf, it } from 'vitest';
import type { AllowedSettlementSwapPath, AllowedSettlementSwapPaths } from '../src/types.js';

describe('AllowedSettlementSwapPaths type contract', () => {
  it('is exactly a readonly collection of AllowedSettlementSwapPath values', () => {
    expectTypeOf<AllowedSettlementSwapPaths>().toEqualTypeOf<
      readonly AllowedSettlementSwapPath[]
    >();
  });
});
