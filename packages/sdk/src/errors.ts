/**
 * SDK error types and normalization.
 *
 * StelisSponsoredError — user-facing Host normalization or SDK-local sponsored-flow validation.
 * normalizeApiError   — maps StelisApiException → StelisSponsoredError.
 */
import { StelisApiException } from './client.js';
import type { HostErrorMeta } from '@stelis/contracts';

/**
 * User-friendly error thrown by sponsored-flow orchestration and local validation.
 *
 * Codes:
 * - `INSUFFICIENT_FUNDS` — balance or settle input too low.
 * - `TRANSACTION_FAILED` — dry-run simulation failure.
 * - `EXECUTION_FAILED` — sponsor preflight / on-chain revert.
 * - *(passthrough)* — a current Host code or SDK-local validation code without a
 *   user-facing normalization above.
 */
export class StelisSponsoredError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: Error,
    /** Closed current Host error fields (minSettleMist, subcode, etc.). */
    public readonly meta?: HostErrorMeta,
  ) {
    super(message);
    this.name = 'StelisSponsoredError';
  }
}

/**
 * Map a current Host StelisApiException into a user-friendly
 * StelisSponsoredError with a normalized code and message.
 */
export function normalizeApiError(err: StelisApiException): StelisSponsoredError {
  // Direct /prepare classification
  if (
    err.code === 'INSUFFICIENT_SETTLE_INPUT' ||
    err.code === 'INSUFFICIENT_BALANCE' ||
    err.code === 'PAYMENT_COIN_CONFLICT'
  ) {
    return new StelisSponsoredError(
      'INSUFFICIENT_FUNDS',
      'Transaction cost exceeds available balance. Please add funds or reduce the amount.',
      err,
      err.meta,
    );
  }
  // /sponsor with subcode (server code remains SPONSOR_*_FAILED).
  // INSUFFICIENT_SETTLE_INPUT (settle.move ETotalInTooLow, S-3 floor) and
  // INSUFFICIENT_FUNDS (settle.move EInsufficientFunds, S-4 non-loss) are
  // both user-visible exhaustion classes; collapse to INSUFFICIENT_FUNDS.
  const ownsSponsorSubcode =
    err.code === 'SPONSOR_PREFLIGHT_FAILED' ||
    err.code === 'SPONSOR_ONCHAIN_FAILED' ||
    err.code === 'PREFLIGHT_FAILED' ||
    err.code === 'ONCHAIN_REVERT';
  if (
    ownsSponsorSubcode &&
    (err.meta?.subcode === 'INSUFFICIENT_SETTLE_INPUT' ||
      err.meta?.subcode === 'INSUFFICIENT_FUNDS')
  ) {
    return new StelisSponsoredError(
      'INSUFFICIENT_FUNDS',
      'Transaction cost exceeds available balance. Please add funds or reduce the amount.',
      err,
      err.meta,
    );
  }
  if (ownsSponsorSubcode && err.meta?.subcode === 'SPREAD_EXCEEDED') {
    return new StelisSponsoredError(
      'TRANSACTION_FAILED',
      'Market spread too wide for safe execution. Please try again later.',
      err,
      err.meta,
    );
  }
  if (ownsSponsorSubcode && err.meta?.subcode === 'SLIPPAGE_EXCEEDED') {
    return new StelisSponsoredError(
      'TRANSACTION_FAILED',
      'Price moved beyond slippage tolerance. Please try a smaller amount.',
      err,
      err.meta,
    );
  }
  if (ownsSponsorSubcode && err.meta?.subcode === 'CLAIM_WOULD_EXCEED_MAX') {
    return new StelisSponsoredError(
      'TRANSACTION_FAILED',
      'Transaction exceeds safety limits. Please try a smaller amount.',
      err,
      err.meta,
    );
  }
  // Slippage / claim guard / spread guard errors → TRANSACTION_FAILED
  if (
    err.code === 'SLIPPAGE_EXCEEDED' ||
    err.code === 'CLAIM_WOULD_EXCEED_MAX' ||
    err.code === 'MARKET_QUOTE_UNAVAILABLE' ||
    err.code === 'SLIPPAGE_CONVERGENCE_FAILED' ||
    err.code === 'SPREAD_EXCEEDED'
  ) {
    return new StelisSponsoredError(
      'TRANSACTION_FAILED',
      err.code === 'MARKET_QUOTE_UNAVAILABLE'
        ? 'Unable to verify swap conditions. Please try again.'
        : 'Transaction exceeds safety limits. Please try a smaller amount.',
      err,
      err.meta,
    );
  }
  if (err.code === 'DRY_RUN_FAILED') {
    return new StelisSponsoredError(
      'TRANSACTION_FAILED',
      'Transaction simulation failed. Please try again.',
      err,
      err.meta,
    );
  }
  if (err.code === 'SPONSOR_PREFLIGHT_FAILED' || err.code === 'SPONSOR_ONCHAIN_FAILED') {
    return new StelisSponsoredError(
      'EXECUTION_FAILED',
      'Transaction execution failed. Please try again.',
      err,
      err.meta,
    );
  }
  // Preserve the validated current Host code.
  return new StelisSponsoredError(err.code, err.message, err, err.meta);
}
