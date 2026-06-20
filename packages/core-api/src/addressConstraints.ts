/**
 * Address constraint validation for Host configuration.
 *
 * Enforces address separation rules at startup:
 *   [1] Each sponsor address must be unique (pool concurrency)
 *   [2] Sponsor addresses must differ from settlementPayoutRecipientAddress (settlement separation)
 *   [3] Sponsor addresses must differ from sponsorRefillAccountAddress (if explicitly set)
 *   [4] settlementPayoutRecipientAddress == sponsorRefillAccountAddress is allowed
 *
 * Accounting separation note:
 *   SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS: address only (no private key held by system), receives settlement payout.
 *   SPONSOR_REFILL_ACCOUNT_SECRET_KEY: private key held by system, signs refill TXs from operational capital.
 *   Keeping them separate enables clean revenue vs. opex tracking:
 *     - Recipient inflows = execution cost claim plus quoted host fee
 *     - Sponsor Refill Account outflows = refill operational cost
 *   Operators may use the same address or sweep externally. The
 *   enforced system constraints here only require sponsor addresses to
 *   stay separate from the recipient and sponsor refill account APIs.
 */
import { normalizeSuiAddress, isValidSuiAddress } from '@mysten/sui/utils';

/**
 * Validates and normalizes a raw Sui address string.
 * Throws if the address format is invalid after normalization.
 */
export function canonicalizeAddress(raw: string, label: string): string {
  const normalized = normalizeSuiAddress(raw);
  if (!isValidSuiAddress(normalized)) {
    throw new Error(`${label} is not a valid Sui address: ${raw}`);
  }
  return normalized;
}

export interface AddressConstraintInput {
  /** Already-canonical sponsor addresses (from toSuiAddress()). */
  sponsorAddresses: string[];
  /** Already-canonical settlement payout recipient address. */
  settlementPayoutRecipientAddress: string;
  /**
   * Sponsor refill account address — only when SPONSOR_REFILL_ACCOUNT_SECRET_KEY is explicitly set.
   * When undefined (fallback to primary sponsor), [3] is skipped.
   */
  sponsorRefillAccountAddress?: string;
}

/**
 * Validates address separation constraints [1]–[3].
 * Throws on first violation. Call at context creation and/or boot-time.
 */
export function validateAddressConstraints(opts: AddressConstraintInput): void {
  const { sponsorAddresses, settlementPayoutRecipientAddress, sponsorRefillAccountAddress } = opts;

  // [1] Sponsor addresses must be unique
  const seen = new Set<string>();
  for (const addr of sponsorAddresses) {
    if (seen.has(addr)) {
      throw new Error(
        `Duplicate sponsor address: ${addr}. Each SPONSOR_SECRET_KEY must derive a unique address.`,
      );
    }
    seen.add(addr);
  }

  // [2] Sponsor != Settlement Payout Recipient
  for (const addr of sponsorAddresses) {
    if (addr === settlementPayoutRecipientAddress) {
      throw new Error(
        `Sponsor address ${addr} must not equal SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS. ` +
          'Use a dedicated signing key separate from the settlement payout recipient.',
      );
    }
  }

  // [3] Sponsor != Sponsor Refill Account (only when explicitly configured)
  if (sponsorRefillAccountAddress !== undefined) {
    for (const addr of sponsorAddresses) {
      if (addr === sponsorRefillAccountAddress) {
        throw new Error(
          `Sponsor address ${addr} must not equal sponsor refill account address. ` +
            'The sponsor refill account key must be separate from all sponsor keys.',
        );
      }
    }
  }
}
