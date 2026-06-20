/**
 * Hardcoded DeepBook swap pairs for the sandbox Swap card.
 *
 * Independent of the relayer's settlement swap path registry — this list exists
 * solely so the sandbox can acquire arbitrary test tokens from SUI, feeding
 * balances into the Connect/Transfer cards.
 *
 * Indexed by network (testnet | mainnet) and by settlement token TYPE so the
 * Swap card can auto-select the matching pair based on the selected
 * settlement swap path.
 */

const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

export type SupportedNetwork = 'testnet' | 'mainnet';

export interface TestSwapPair {
  /** The target token type this pair produces when swapping from SUI. */
  settlementTokenType: string;
  /** Human label for UI. */
  label: string;
  poolId: string;
  baseType: string;
  quoteType: string;
  /** DeepBook swap function that converts SUI → settlementTokenType on this pool. */
  swapDirection: 'swap_exact_base_for_quote' | 'swap_exact_quote_for_base';
}

export const TEST_SWAP_PAIRS: Record<SupportedNetwork, TestSwapPair[]> = {
  testnet: [
    {
      settlementTokenType:
        '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',
      label: 'DBUSDC',
      poolId: '0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5',
      baseType: SUI_TYPE,
      quoteType:
        '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',
      // SUI(base) → DBUSDC(quote)
      swapDirection: 'swap_exact_base_for_quote',
    },
    {
      settlementTokenType:
        '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP',
      label: 'DEEP',
      poolId: '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f',
      baseType: '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP',
      quoteType: SUI_TYPE,
      // SUI(quote) → DEEP(base)
      swapDirection: 'swap_exact_quote_for_base',
    },
  ],
  mainnet: [
    // Register mainnet pairs here when needed.
  ],
};

/**
 * Look up a test swap pair by settlement token type on the given network.
 * Returns null when no hardcoded pair is registered for that token.
 */
export function findTestSwapPair(
  network: SupportedNetwork,
  settlementTokenType: string,
): TestSwapPair | null {
  return TEST_SWAP_PAIRS[network].find((p) => p.settlementTokenType === settlementTokenType) ?? null;
}
