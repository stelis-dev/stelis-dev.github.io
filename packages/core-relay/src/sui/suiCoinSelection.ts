import { SUI_U64_MAX, isSuiU64 } from './suiU64.js';

interface SuiCoinValue {
  readonly objectId: string;
  readonly balance: bigint;
}

interface SuiCoinSubset<T extends SuiCoinValue> {
  readonly coins: readonly T[];
  readonly totalBalance: bigint;
  readonly sufficient: boolean;
}

/**
 * Select one u64-safe coin-object subset from the provided candidates.
 *
 * A single sufficient coin is preferred so fragmented earlier coins do not
 * force unnecessary MergeCoins commands. Otherwise the selection walks in
 * order, skips an addition that would overflow u64, and stops at the first
 * sufficient total. Zero-balance coins are never selected. An insufficient
 * result means this deterministic ordered selection did not prove a sufficient
 * subset; it is not an exhaustive subset-search result. Callers may use the
 * returned safe subset only if their complete-state policy permits fallback.
 */
export function selectSuiCoinSubset<T extends SuiCoinValue>(
  candidates: readonly T[],
  requiredAmount: bigint,
): SuiCoinSubset<T> {
  if (!isSuiU64(requiredAmount) || requiredAmount === 0n) {
    throw new TypeError('Required coin amount must be a positive u64 value');
  }

  for (const coin of candidates) {
    if (!isSuiU64(coin.balance)) {
      throw new TypeError(`Coin ${coin.objectId} balance must be in the u64 range`);
    }
    if (coin.balance === 0n) continue;
    if (coin.balance >= requiredAmount) {
      return Object.freeze({
        coins: Object.freeze([coin]),
        totalBalance: coin.balance,
        sufficient: true,
      });
    }
  }

  const selected: T[] = [];
  let totalBalance = 0n;
  for (const coin of candidates) {
    if (coin.balance === 0n) continue;
    const next = totalBalance + coin.balance;
    if (next > SUI_U64_MAX) continue;
    selected.push(coin);
    totalBalance = next;
    if (totalBalance >= requiredAmount) {
      return Object.freeze({
        coins: Object.freeze(selected),
        totalBalance,
        sufficient: true,
      });
    }
  }

  return Object.freeze({
    coins: Object.freeze(selected),
    totalBalance,
    sufficient: false,
  });
}
