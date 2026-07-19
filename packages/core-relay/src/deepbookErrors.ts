/**
 * Shared DeepBook query error categories.
 *
 * Raised when a completed DeepBook view cannot be interpreted as the exact
 * current ABI result. Sui operation failures retain `SuiOperationError`.
 */
export class SlippageQueryError extends Error {
  override readonly name = 'SlippageQueryError';

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
  }
}
