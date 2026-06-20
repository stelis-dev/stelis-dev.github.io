import type { Transaction } from '@mysten/sui/transactions';
import { containsSponsorWithdrawal, extractPrefixWithdrawals } from '../classifyPrefixCoins.js';
import { convertSdkCommands } from '../convert.js';
import type { RelayerEnv, ValidationResult } from '../types.js';
import { fail, ok } from '../types.js';
import { validatePtbStructure, validateUserCommands } from './static.js';

/**
 * Validate a user-supplied generic TransactionKind before Stelis appends settlement.
 *
 * This is the shared SDK/server source of truth for generic user TransactionKind
 * admissibility. It does not choose a payment source; funding resolution remains
 * server-owned.
 */
export function validateGenericUserTransactionKind(
  tx: Transaction,
  env: RelayerEnv,
  settlementTokenType: string,
): ValidationResult {
  const data = tx.getData();
  const commandResult = validateUserCommands(convertSdkCommands(data.commands as unknown[]), env);
  if (!commandResult.ok) return commandResult;

  if (containsSponsorWithdrawal(tx)) {
    return fail(
      'P1_SPONSOR_WITHDRAWAL_FORBIDDEN',
      'User TX contains FundsWithdrawal(Sponsor) — rejected to protect sponsor funds',
    );
  }

  const withdrawalResult = extractPrefixWithdrawals(tx, settlementTokenType);
  if (withdrawalResult.unaccountable) {
    return fail(
      'UNACCOUNTABLE_WITHDRAWAL',
      'Transaction contains a FundsWithdrawal(Sender) input that cannot be safely interpreted for address-balance accounting.',
    );
  }

  return ok();
}

/**
 * Validate a relayer-built generic settlement transaction after settlement is appended.
 *
 * This is deliberately separate from user TransactionKind validation. The final
 * transaction may contain relayer-created FundsWithdrawal(Sender) inputs for
 * settlement funding, so prepare-time withdrawal accounting is not repeated here.
 */
export function validateGenericSettlementTransaction(
  tx: Transaction,
  env: RelayerEnv,
): ValidationResult {
  const data = tx.getData();
  return validatePtbStructure(convertSdkCommands(data.commands as unknown[]), env);
}
