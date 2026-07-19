import { describe, expect, it } from 'vitest';
import { selectSuiCoinSubset } from '../src/sui/suiCoinSelection.js';

const U64_MAX = (1n << 64n) - 1n;

function coin(objectId: string, balance: bigint) {
  return { objectId, balance };
}

describe('selectSuiCoinSubset', () => {
  it('rejects a zero required amount instead of inventing an empty-funding meaning', () => {
    expect(() => selectSuiCoinSubset([coin('a', 1n)], 0n)).toThrow(
      'Required coin amount must be a positive u64 value',
    );
  });

  it('rejects a non-bigint required amount at the public runtime boundary', () => {
    expect(() => selectSuiCoinSubset([coin('a', 1n)], 1 as never)).toThrow(
      'Required coin amount must be a positive u64 value',
    );
  });

  it('prefers the first sufficient single coin over earlier fragments', () => {
    expect(selectSuiCoinSubset([coin('a', 2n), coin('b', 10n), coin('c', 20n)], 9n)).toEqual({
      coins: [coin('b', 10n)],
      totalBalance: 10n,
      sufficient: true,
    });
  });

  it('stops at the first sufficient u64-safe cumulative subset', () => {
    expect(selectSuiCoinSubset([coin('a', 4n), coin('b', 6n), coin('c', 9n)], 10n)).toEqual({
      coins: [coin('a', 4n), coin('b', 6n)],
      totalBalance: 10n,
      sufficient: true,
    });
  });

  it('skips an overflowing addition without hiding a later sufficient addition', () => {
    expect(
      selectSuiCoinSubset([coin('a', U64_MAX - 10n), coin('b', 20n), coin('c', 6n)], U64_MAX - 5n),
    ).toEqual({
      coins: [coin('a', U64_MAX - 10n), coin('c', 6n)],
      totalBalance: U64_MAX - 4n,
      sufficient: true,
    });
  });

  it('returns the safe subset without claiming sufficiency', () => {
    expect(selectSuiCoinSubset([coin('a', 3n), coin('b', 4n)], 10n)).toEqual({
      coins: [coin('a', 3n), coin('b', 4n)],
      totalBalance: 7n,
      sufficient: false,
    });
  });

  it('does not select zero-balance coins', () => {
    expect(selectSuiCoinSubset([coin('zero', 0n), coin('a', 3n)], 5n)).toEqual({
      coins: [coin('a', 3n)],
      totalBalance: 3n,
      sufficient: false,
    });
  });

  it('does not claim exhaustive subset search when ordered selection cannot prove one', () => {
    expect(
      selectSuiCoinSubset(
        [coin('a', 100n), coin('b', U64_MAX - 50n), coin('c', 40n)],
        U64_MAX - 10n,
      ),
    ).toEqual({
      coins: [coin('a', 100n), coin('c', 40n)],
      totalBalance: 140n,
      sufficient: false,
    });
  });
});
