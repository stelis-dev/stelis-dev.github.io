import { describe, expect, it } from 'vitest';
import { parseHostFeeEnv } from '../src/prepareConfig.js';

describe('parseHostFeeEnv', () => {
  it('parses omitted and decimal fee values', () => {
    expect(parseHostFeeEnv(undefined)).toBe(0n);
    expect(parseHostFeeEnv('0')).toBe(0n);
    expect(parseHostFeeEnv('1000')).toBe(1000n);
  });

  it('rejects non-decimal or negative fee values', () => {
    expect(() => parseHostFeeEnv('1e3')).toThrow('expected a non-negative integer string');
    expect(() => parseHostFeeEnv('0x10')).toThrow('expected a non-negative integer string');
    expect(() => parseHostFeeEnv('-1')).toThrow('expected a non-negative integer string');
  });
});
