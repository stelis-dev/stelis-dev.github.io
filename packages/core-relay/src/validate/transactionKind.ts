import type { Transaction } from '@mysten/sui/transactions';
import { containsSponsorWithdrawal, extractPrefixWithdrawals } from '../prefixValueTrace.js';
import { convertSdkCommands } from '../convert.js';
import type { HostValidationEnv, ValidationResult } from '../types.js';
import { fail, ok } from '../types.js';
import { validatePtbStructure, validateUserCommands } from './static.js';
import { SuiTransactionShapeError } from '../sui/suiTransactionShape.js';

/**
 * Validate a user-supplied generic TransactionKind before Stelis appends settlement.
 *
 * This is the shared SDK/server source of truth for generic user TransactionKind
 * admissibility. It does not choose a payment source; funding resolution remains
 * server-owned.
 */
export function validateGenericUserTransactionKind(
  tx: Transaction,
  env: HostValidationEnv,
  settlementTokenType: string,
): ValidationResult {
  const data = tx.getData();

  try {
    if (containsSponsorWithdrawal(tx)) {
      return fail(
        'P1_SPONSOR_WITHDRAWAL_FORBIDDEN',
        'User TX contains FundsWithdrawal(Sponsor) — rejected to protect sponsor funds',
      );
    }

    extractPrefixWithdrawals(tx, settlementTokenType);
  } catch (error) {
    if (!(error instanceof SuiTransactionShapeError)) throw error;
    return fail(
      'UNACCOUNTABLE_WITHDRAWAL',
      'Transaction contains an input outside the exact current Sui transaction shape.',
    );
  }

  // Run the normal command-count policy only after input-level manipulation
  // checks, so command padding cannot hide sponsor or unaccountable withdrawals.
  const commandResult = validateUserCommands(convertSdkCommands(data.commands as unknown[]), env);
  if (!commandResult.ok) return commandResult;

  return ok();
}

/**
 * Validate a Host-built generic settlement transaction after settlement is appended.
 *
 * This is deliberately separate from user TransactionKind validation. The final
 * transaction may contain Host-created FundsWithdrawal(Sender) inputs for
 * settlement funding, so prepare-time withdrawal accounting is not repeated here.
 */
export function validateGenericSettlementTransaction(
  tx: Transaction,
  env: HostValidationEnv,
): ValidationResult {
  const data = tx.getData();
  return validatePtbStructure(convertSdkCommands(data.commands as unknown[]), env);
}
