/**
 * Executable quote could not be produced from current market data.
 */
export class MarketQuoteUnavailableError extends Error {
  override readonly name = 'MarketQuoteUnavailableError';

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Minimal executable trade exists, but its execution gap exceeds the policy cap.
 */
export class ExecutionGapExceededError extends Error {
  override readonly name = 'ExecutionGapExceededError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * Search exhausted without finding an executable quote that satisfies the
 * requested output target.
 */
export class SwapUnviableUnderPolicyError extends Error {
  override readonly name = 'SwapUnviableUnderPolicyError';

  constructor(message: string) {
    super(message);
  }
}
