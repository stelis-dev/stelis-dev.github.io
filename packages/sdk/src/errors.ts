/**
 * SDK error types and normalization.
 *
 * StelisSponsoredError — user-facing error from executeSponsored.
 * normalizeApiError   — maps StelisApiException → StelisSponsoredError.
 * isInfraError        — classifies transient network/RPC errors.
 */
import { StelisApiException } from './client.js';

/**
 * Returns true for transient network/infrastructure errors that may resolve
 * when routed through a different endpoint (e.g. the Host's RPC node).
 * Deterministic failures (bad tx, wrong args) are NOT infra errors.
 *
 * Used only in sdk.ts — not a core-relay export (string heuristics are
 * SDK runtime policy, not shared trust-root math).
 */
export function isInfraError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('fetch') ||
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('grpc') ||
    err.name === 'AbortError'
  );
}

/**
 * User-friendly error thrown by `executeSponsored`.
 *
 * Codes:
 * - `INSUFFICIENT_FUNDS` — balance or settle input too low.
 * - `TRANSACTION_FAILED` — dry-run simulation failure.
 * - `EXECUTION_FAILED` — sponsor preflight / on-chain revert.
 * - *(passthrough)* — any other server error code.
 */
export class StelisSponsoredError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: Error,
    /** Server-side diagnostic meta (minSettleMist, requiredTotalIn, subcode, etc.) */
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StelisSponsoredError';
  }
}

/**
 * Map a StelisApiException from the server into a user-friendly
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
  if (
    err.meta?.subcode === 'INSUFFICIENT_SETTLE_INPUT' ||
    err.meta?.subcode === 'INSUFFICIENT_FUNDS'
  ) {
    return new StelisSponsoredError(
      'INSUFFICIENT_FUNDS',
      'Transaction cost exceeds available balance. Please add funds or reduce the amount.',
      err,
      err.meta,
    );
  }
  if (err.meta?.subcode === 'SPREAD_EXCEEDED') {
    return new StelisSponsoredError(
      'TRANSACTION_FAILED',
      'Market spread too wide for safe execution. Please try again later.',
      err,
      err.meta,
    );
  }
  if (err.meta?.subcode === 'SLIPPAGE_EXCEEDED') {
    return new StelisSponsoredError(
      'TRANSACTION_FAILED',
      'Price moved beyond slippage tolerance. Please try a smaller amount.',
      err,
      err.meta,
    );
  }
  if (err.meta?.subcode === 'CLAIM_WOULD_EXCEED_MAX') {
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
    err.code === 'SLIPPAGE_QUERY_FAILED' ||
    err.code === 'SLIPPAGE_CONVERGENCE_FAILED' ||
    err.code === 'SWAP_AMOUNT_OVERFLOW' ||
    err.code === 'SPREAD_EXCEEDED'
  ) {
    return new StelisSponsoredError(
      'TRANSACTION_FAILED',
      err.code === 'SLIPPAGE_QUERY_FAILED'
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
  // Passthrough — preserve original code
  return new StelisSponsoredError(err.code, err.message, err, err.meta);
}
