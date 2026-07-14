/**
 * extractSettleArgsFromBuiltTx — /prepare-side L2 extraction.
 *
 * Thin wrapper around @stelis/core-relay parseSettleArgs.
 * Maps ParseSettleArgsError → PrepareValidationError('L2_EXTRACT_FAILED').
 * Non-parser errors are re-thrown so prepare.ts L1_PARSE_FAILED can handle them.
 *
 * IMPORTANT: executionCostClaim and settlementPayoutRecipient are decoded from
 * built TX Pure inputs — NOT from builder input values.
 * This enables independent L2 validation that catches builder encoding bugs.
 *
 * Argument index mapping remains an implementation detail of
 * `@stelis/core-relay`; this wrapper verifies behavior through the parser.
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { MoveCallCommand, PtbCommand } from '@stelis/contracts';
import { SETTLEMENT_SWAP_DIRECTION_FUNCTIONS, SETTLE_MODULE } from '@stelis/contracts';
import type { SettleArgs, HostValidationEnv } from '@stelis/core-relay';
import { parseSettleArgs, ParseSettleArgsError } from '@stelis/core-relay';
import {
  extractSettlePaymentInputContract,
  PaymentInputContractError,
} from '@stelis/core-relay/server';
import type { PaymentInputTrace } from '@stelis/core-relay/server';
import { PrepareValidationError } from '../prepare/replay.js';

export interface ExtractedSettleArgs extends SettleArgs {
  paymentInputTrace?: PaymentInputTrace;
}

export interface ExtractSettleArgsOptions {
  requirePaymentInputTrace?: boolean;
}

/**
 * Extract SettleArgs from a built Transaction's commands + inputs.
 *
 * All fields are decoded from the built TX — no input values used.
 * Throws PrepareValidationError('L2_EXTRACT_FAILED') on any extraction failure.
 */
export function extractSettleArgsFromBuiltTx(
  commands: PtbCommand[],
  inputs: unknown[],
  _env: HostValidationEnv,
  options?: ExtractSettleArgsOptions,
): ExtractedSettleArgs {
  try {
    if (options?.requirePaymentInputTrace) {
      return extractSettlePaymentInputContract(commands, inputs, _env.packageId);
    }
    return parseSettleArgs(commands, inputs, _env.packageId);
  } catch (err) {
    if (err instanceof ParseSettleArgsError) {
      throw new PrepareValidationError('L2_EXTRACT_FAILED', err.message);
    }
    if (err instanceof PaymentInputContractError) {
      throw new PrepareValidationError('L2_EXTRACT_FAILED', err.message, {
        subcode: err.subcode,
      });
    }
    if (err instanceof PrepareValidationError) {
      throw err;
    }
    throw err; // non-parser bugs propagate as-is → prepare.ts L1_PARSE_FAILED handles
  }
}

const NEW_USER_SETTLE_FNS: ReadonlySet<string> = new Set(
  Object.values(SETTLEMENT_SWAP_DIRECTION_FUNCTIONS).map((fns) => fns.newUser),
);

/**
 * Server-only discriminator: does the built PTB call a `swap_and_settle_new_user_*`
 * settle entrypoint on the trusted Stelis package? Walks the same stored-hash-verified
 * MoveCall list `parseSettleArgs` already validated; the package + module + function
 * triple must all match before the predicate returns true. External packages
 * with the same module/function name cannot satisfy this gate.
 *
 * Used by sponsor-time new-user User Vault drift detection. `SettleArgs` does not
 * expose `fnName`, so this is the narrow internal derivation path; intentionally
 * not re-exported from any browser/SDK barrel.
 */
export function isNewUserSettleMoveCall(commands: PtbCommand[], packageId: string): boolean {
  const normalizedPkg = normalizeSuiAddress(packageId);
  for (const cmd of commands) {
    if (cmd.kind !== 'MoveCall') continue;
    const mc = cmd as MoveCallCommand;
    if (
      normalizeSuiAddress(mc.packageId) === normalizedPkg &&
      mc.module === SETTLE_MODULE &&
      NEW_USER_SETTLE_FNS.has(mc.function)
    ) {
      return true;
    }
  }
  return false;
}
