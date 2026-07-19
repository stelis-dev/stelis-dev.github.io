export const SUI_U64_MAX = (1n << 64n) - 1n;

/** Return whether an unknown value is a current Sui u64. */
export function isSuiU64(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= SUI_U64_MAX;
}
