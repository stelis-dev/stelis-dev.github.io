/**
 * promotionTargetPolicy — unit tests.
 *
 * Tests the one canonical target representation shared by boot and runtime.
 * Target enforcement is global via STUDIO_ALLOWED_TARGETS.
 */
import { describe, it, expect } from 'vitest';
import { canonicalizePromotionTarget } from '../src/studio/promotionTargetPolicy.js';

describe('canonicalizePromotionTarget', () => {
  it('normalizes a short package address into the exact runtime target', () => {
    expect(canonicalizePromotionTarget('0x2::coin::transfer')).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000002::coin::transfer',
    );
  });

  it('normalizes short package addresses', () => {
    expect(canonicalizePromotionTarget('0x2::coin::transfer')).toBe(
      canonicalizePromotionTarget(
        '0x0000000000000000000000000000000000000000000000000000000000000002::coin::transfer',
      ),
    );
  });

  it('rejects malformed target segments instead of creating unreachable policy', () => {
    expect(() => canonicalizePromotionTarget('not_a_target')).toThrow('Invalid target format');
    expect(() => canonicalizePromotionTarget('0x2::coin')).toThrow('Invalid target format');
    expect(() => canonicalizePromotionTarget('xyz::coin::transfer')).toThrow(
      'Invalid target package address',
    );
    expect(() => canonicalizePromotionTarget('::coin::transfer')).toThrow(
      'Invalid target package address',
    );
    expect(() => canonicalizePromotionTarget('0x::coin::transfer')).toThrow(
      'Invalid target package address',
    );
    expect(() => canonicalizePromotionTarget('0x2::::transfer')).toThrow(
      'Invalid target module identifier',
    );
    expect(() => canonicalizePromotionTarget('0x2::coin::bad-name')).toThrow(
      'Invalid target function identifier',
    );
  });

  it('accepts current Move identifier syntax', () => {
    expect(canonicalizePromotionTarget('0x2::_module::do_thing2')).toMatch(/::_module::do_thing2$/);
  });
});
