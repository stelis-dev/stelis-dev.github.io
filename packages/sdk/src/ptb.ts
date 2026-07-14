/**
 * PTB Builders — composable Move call helpers.
 *
 * withdraw() — user-initiated vault withdrawal (SDK operation).
 *
 * Settle builders are in @stelis/core-relay/ptb/builders — server-side only.
 */
import { Transaction } from '@mysten/sui/transactions';

// ─────────────────────────────────────────────
// withdraw() PTB builder
// ─────────────────────────────────────────────

interface WithdrawPtbParams {
  packageId: string;
  vaultId: string;
  /** Address to receive the withdrawn coin */
  recipientAddress: string;
}

/**
 * Adds a withdraw() MoveCall and transfers the coin to the recipient.
 */
export function buildWithdrawPtb(tx: Transaction, params: WithdrawPtbParams): void {
  const coin = tx.moveCall({
    target: `${params.packageId}::vault::withdraw`,
    arguments: [tx.object(params.vaultId)],
  });
  tx.transferObjects([coin], tx.pure.address(params.recipientAddress));
}
