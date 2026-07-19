/**
 * prepareErrors - centralized failure classification for the prepare pipeline.
 *
 * Centralized error classification for the prepare pipeline.
 * All dry-run, simulation, and DeepBook query errors are classified here
 * into PrepareValidationError with appropriate codes.
 *
 * Error codes defined here:
 *   INSUFFICIENT_BALANCE      - InsufficientCoinBalance or address balance shortage
 *   CLAIM_WOULD_EXCEED_MAX    - settle.move EClaimTooHigh
 *   INSUFFICIENT_SETTLE_INPUT - settle.move ETotalInTooLow
 *   SPREAD_EXCEEDED           - settle.move ESpreadTooWide
 *   SLIPPAGE_EXCEEDED         - DeepBook pool::swap_exact_quantity EMinimumQuantityOutNotMet
 *   DRY_RUN_FAILED            - unclassified dry-run failure
 *
 * Numeric abort codes are resolved through the generated
 * `@stelis/contracts` settlement contract. The generator reads the exact
 * compiled modules produced from the locked Move graph.
 *
 * Market-quote errors (MARKET_QUOTE_UNAVAILABLE) are handled in the
 * build-time market-policy solve path.
 *
 * Package + command binding:
 *   Stelis helpers take the active Stelis package ID. DeepBook uses the
 *   original/runtime ModuleId generated from the consumed bytecode; its
 *   published storage/call-target ID is a different identity. Classification
 *   consumes the installed SDK's structured execution-error union and requires
 *   the package, module, optional function/constant, abort code, and outer PTB
 *   command to agree. Provider display text is discarded; the remaining
 *   normalized kind-only message is diagnostic and never classification authority.
 */

import { Transaction } from '@mysten/sui/transactions';
import {
  convertSdkCommands,
  suiExecutionErrorMessage,
  type ChainBoundSuiEndpointSnapshot,
  type SuiExecutionError,
} from '@stelis/core-relay';
import {
  buildAddressBalanceGasTransaction,
  findUniqueSettleCommandIndex,
  getSuiRejectedExecutionError,
  SuiAddressBalanceGasUnavailableError,
  type AddressBalanceGasTransaction,
} from '@stelis/core-relay/server';
import {
  DEEPBOOK_MIN_OUT_ABORT,
  SETTLE_ABORT,
  SETTLEMENT_ENTRY_FUNCTIONS,
  SETTLE_FUNCTIONS,
  SETTLE_MODULE,
  VAULT_ABORT,
  type SponsorFailureSubcode,
} from '@stelis/contracts';
import type { MoveCallCommand, PtbCommand } from '@stelis/contracts';
import { PrepareValidationError, type PrepareErrorMeta } from './replay.js';

// ---------------------------------------------------------------------------
// Settle/vault/deepbook abort detection (package-bound)
// ---------------------------------------------------------------------------

export type SponsorFailureCommandScope =
  | {
      kind: 'settlement';
      commands: readonly PtbCommand[];
    }
  | {
      kind: 'direct';
      commands: readonly PtbCommand[];
      deepbookPackageId: string;
    };

function normalizePackageId(packageId: string): string | undefined {
  const match = /^0x([0-9a-fA-F]{1,64})$/.exec(packageId);
  if (!match) return undefined;
  return `0x${match[1]!.toLowerCase().padStart(64, '0')}`;
}

function hasMoveAbort(
  error: SuiExecutionError,
  packageId: string,
  modulePath: string,
  constantName: string,
  code: number,
  commandIndex: number,
): boolean {
  if (
    error.kind !== 'MoveAbort' ||
    error.command !== commandIndex ||
    !Number.isSafeInteger(commandIndex) ||
    commandIndex < 0
  ) {
    return false;
  }
  const normalizedPackageId = normalizePackageId(packageId);
  if (!normalizedPackageId) return false;
  const [expectedModuleName, expectedFunctionName, ...unexpectedSegments] = modulePath.split('::');
  if (!expectedModuleName || unexpectedSegments.length > 0) return false;
  const abort = error.moveAbort;
  return (
    abort.packageId === normalizedPackageId &&
    abort.abortCode === String(code) &&
    (abort.constantName === undefined || abort.constantName === constantName) &&
    abort.module === expectedModuleName &&
    (expectedFunctionName === undefined || abort.functionName === expectedFunctionName)
  );
}

/** settle.move EPaused */
export function isPaused(
  error: SuiExecutionError,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    error,
    stelisPackageId,
    'settle',
    'EPaused',
    SETTLE_ABORT.EPaused,
    commandIndex,
  );
}

/** vault.move EVaultAlreadyRegistered */
export function isVaultAlreadyRegistered(
  error: SuiExecutionError,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    error,
    stelisPackageId,
    'vault',
    'EVaultAlreadyRegistered',
    VAULT_ABORT.EVaultAlreadyRegistered,
    commandIndex,
  );
}

/** vault.move EReplayNonce */
export function isReplayNonce(
  error: SuiExecutionError,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    error,
    stelisPackageId,
    'vault',
    'EReplayNonce',
    VAULT_ABORT.EReplayNonce,
    commandIndex,
  );
}

/** settle.move EClaimTooHigh */
export function isClaimTooHigh(
  error: SuiExecutionError,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    error,
    stelisPackageId,
    'settle',
    'EClaimTooHigh',
    SETTLE_ABORT.EClaimTooHigh,
    commandIndex,
  );
}

/** settle.move ETotalInTooLow */
export function isTotalInTooLow(
  error: SuiExecutionError,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    error,
    stelisPackageId,
    'settle',
    'ETotalInTooLow',
    SETTLE_ABORT.ETotalInTooLow,
    commandIndex,
  );
}

/** settle.move ESpreadTooWide */
export function isSpreadTooWide(
  error: SuiExecutionError,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    error,
    stelisPackageId,
    'settle',
    'ESpreadTooWide',
    SETTLE_ABORT.ESpreadTooWide,
    commandIndex,
  );
}

/** settle.move EInsufficientFunds */
export function isInsufficientFunds(
  error: SuiExecutionError,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    error,
    stelisPackageId,
    'settle',
    'EInsufficientFunds',
    SETTLE_ABORT.EInsufficientFunds,
    commandIndex,
  );
}

/** settle.move EInvalidReceiptId */
export function isInvalidReceiptId(
  error: SuiExecutionError,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    error,
    stelisPackageId,
    'settle',
    'EInvalidReceiptId',
    SETTLE_ABORT.EInvalidReceiptId,
    commandIndex,
  );
}

/** settle.move EInvalidPolicyHash */
export function isInvalidPolicyHash(
  error: SuiExecutionError,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    error,
    stelisPackageId,
    'settle',
    'EInvalidPolicyHash',
    SETTLE_ABORT.EInvalidPolicyHash,
    commandIndex,
  );
}

/**
 * DeepBook `pool::swap_exact_quantity` `EMinimumQuantityOutNotMet`.
 *
 * The complete runtime identity is generated from the consumed DeepBook
 * `pool` bytecode. Its original/runtime ModuleId is intentionally distinct
 * from the published storage ID used to build PTB calls and quote queries.
 *
 * Package-bound to the generated DeepBook runtime ModuleId so external
 * packages with module `pool::swap_exact_quantity` and the same abort code cannot
 * classify as `SLIPPAGE_EXCEEDED`. The structured execution error also has to
 * identify the exact outer PTB command.
 */
export function isDeepbookMinOutNotMet(error: SuiExecutionError, commandIndex: number): boolean {
  return hasMoveAbort(
    error,
    DEEPBOOK_MIN_OUT_ABORT.runtimePackageId,
    DEEPBOOK_MIN_OUT_ABORT.modulePath,
    DEEPBOOK_MIN_OUT_ABORT.constantName,
    DEEPBOOK_MIN_OUT_ABORT.code,
    commandIndex,
  );
}

/**
 * Classify settle/vault/deepbook aborts into sponsor-level subcodes.
 *
 * Identity and outer-command provenance must both match. Settlement flows
 * accept only the unique active Stelis settlement command. Direct-command
 * flows accept an active Stelis settlement target or the current published
 * DeepBook pool target at the exact command index reported by Sui. External
 * wrappers therefore cannot inherit a nested Stelis/DeepBook subcode.
 */
function isStelisSettlementCommand(command: PtbCommand, stelisPackageId: string): boolean {
  if (command.kind !== 'MoveCall') return false;
  const moveCall = command as MoveCallCommand;
  const commandPackageId = normalizePackageId(moveCall.packageId);
  const activePackageId = normalizePackageId(stelisPackageId);
  return (
    commandPackageId !== undefined &&
    activePackageId !== undefined &&
    commandPackageId === activePackageId &&
    moveCall.module === SETTLE_MODULE &&
    SETTLE_FUNCTIONS.has(moveCall.function)
  );
}

function isDirectDeepbookSwapCommand(command: PtbCommand, deepbookPackageId: string): boolean {
  if (command.kind !== 'MoveCall') return false;
  const moveCall = command as MoveCallCommand;
  const commandPackageId = normalizePackageId(moveCall.packageId);
  const publishedPackageId = normalizePackageId(deepbookPackageId);
  const [moduleName, functionName, ...unexpectedSegments] =
    DEEPBOOK_MIN_OUT_ABORT.modulePath.split('::');
  return (
    unexpectedSegments.length === 0 &&
    functionName !== undefined &&
    commandPackageId !== undefined &&
    publishedPackageId !== undefined &&
    commandPackageId === publishedPackageId &&
    moveCall.module === moduleName &&
    moveCall.function === functionName
  );
}

function compiledSettlementEntry(functionName: string) {
  return (
    SETTLEMENT_ENTRY_FUNCTIONS as Readonly<
      Record<
        string,
        (typeof SETTLEMENT_ENTRY_FUNCTIONS)[keyof typeof SETTLEMENT_ENTRY_FUNCTIONS] | undefined
      >
    >
  )[functionName];
}

function settlementEntryCanSwap(functionName: string): boolean {
  return (
    compiledSettlementEntry(functionName)?.parameters.some(
      (parameter) => parameter.name === 'pool',
    ) ?? false
  );
}

function classifyStelisFailureAtCommand(
  error: SuiExecutionError,
  stelisPackageId: string,
  commandIndex: number,
  functionName: string,
): Exclude<SponsorFailureSubcode, 'SLIPPAGE_EXCEEDED'> | undefined {
  const entry = compiledSettlementEntry(functionName);
  if (!entry) return undefined;
  const canSwap = entry.parameters.some((parameter) => parameter.name === 'pool');

  if (isClaimTooHigh(error, stelisPackageId, commandIndex)) return 'CLAIM_WOULD_EXCEED_MAX';
  if (canSwap && isTotalInTooLow(error, stelisPackageId, commandIndex)) {
    return 'INSUFFICIENT_SETTLE_INPUT';
  }
  if (isInsufficientFunds(error, stelisPackageId, commandIndex)) return 'INSUFFICIENT_FUNDS';
  if (isInvalidReceiptId(error, stelisPackageId, commandIndex)) return 'INVALID_RECEIPT_ID';
  if (isInvalidPolicyHash(error, stelisPackageId, commandIndex)) return 'INVALID_POLICY_HASH';
  if (canSwap && isSpreadTooWide(error, stelisPackageId, commandIndex)) {
    return 'SPREAD_EXCEEDED';
  }
  if (isPaused(error, stelisPackageId, commandIndex)) return 'PAUSED';
  if (
    entry.variantClass === 'new_user' &&
    isVaultAlreadyRegistered(error, stelisPackageId, commandIndex)
  ) {
    return 'VAULT_ALREADY_REGISTERED';
  }
  if (isReplayNonce(error, stelisPackageId, commandIndex)) return 'REPLAY_NONCE';
  return undefined;
}

export function classifySponsorFailureSubcode(
  error: SuiExecutionError,
  stelisPackageId: string,
  scope: SponsorFailureCommandScope,
): SponsorFailureSubcode | undefined {
  if (scope.kind === 'settlement') {
    const commandIndex = findUniqueSettleCommandIndex(scope.commands, stelisPackageId);
    if (commandIndex === undefined) return undefined;
    const command = scope.commands[commandIndex];
    if (!command || command.kind !== 'MoveCall') return undefined;
    const functionName = (command as MoveCallCommand).function;
    const canSwap = settlementEntryCanSwap(functionName);
    return (
      classifyStelisFailureAtCommand(error, stelisPackageId, commandIndex, functionName) ??
      (canSwap && isDeepbookMinOutNotMet(error, commandIndex) ? 'SLIPPAGE_EXCEEDED' : undefined)
    );
  }

  for (let commandIndex = 0; commandIndex < scope.commands.length; commandIndex++) {
    const command = scope.commands[commandIndex]!;
    if (isStelisSettlementCommand(command, stelisPackageId)) {
      const functionName = (command as MoveCallCommand).function;
      const stelisSubcode = classifyStelisFailureAtCommand(
        error,
        stelisPackageId,
        commandIndex,
        functionName,
      );
      if (stelisSubcode) return stelisSubcode;
      if (settlementEntryCanSwap(functionName) && isDeepbookMinOutNotMet(error, commandIndex)) {
        return 'SLIPPAGE_EXCEEDED';
      }
    }
    if (
      isDirectDeepbookSwapCommand(command, scope.deepbookPackageId) &&
      isDeepbookMinOutNotMet(error, commandIndex)
    ) {
      return 'SLIPPAGE_EXCEEDED';
    }
  }

  return undefined;
}

/**
 * Classify known prepare failures into typed validation errors.
 * Returns null when the structured error is not a known prepare failure and
 * should fall back to DRY_RUN_FAILED.
 */
function classifyKnownPrepareFailure(
  error: SuiExecutionError,
  stelisPackageId: string,
  scope: SponsorFailureCommandScope,
  meta?: PrepareErrorMeta,
): PrepareValidationError | null {
  const message = suiExecutionErrorMessage(error);
  if (error.kind === 'InsufficientCoinBalance' || error.kind === 'InsufficientFundsForWithdraw') {
    return new PrepareValidationError(
      'INSUFFICIENT_BALANCE',
      `Insufficient coin balance: ${message}`,
      meta,
    );
  }

  const subcode = classifySponsorFailureSubcode(error, stelisPackageId, scope);
  if (subcode === 'CLAIM_WOULD_EXCEED_MAX') {
    return new PrepareValidationError(
      'CLAIM_WOULD_EXCEED_MAX',
      `Computed execution cost claim exceeds configured max: ${message}`,
      meta,
    );
  }
  if (subcode === 'INSUFFICIENT_SETTLE_INPUT') {
    return new PrepareValidationError(
      'INSUFFICIENT_SETTLE_INPUT',
      `Settle input too low: ${message}`,
      meta,
    );
  }
  if (subcode === 'SPREAD_EXCEEDED') {
    return new PrepareValidationError(
      'SPREAD_EXCEEDED',
      `DeepBook spread too wide or book empty: ${message}`,
      meta,
    );
  }
  if (subcode === 'SLIPPAGE_EXCEEDED') {
    return new PrepareValidationError(
      'SLIPPAGE_EXCEEDED',
      `Minimum output not met during swap: ${message}`,
      meta,
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Dry-run failure classification
// ---------------------------------------------------------------------------

/**
 * Classify a structured dry-run execution error into a specific error code.
 *
 * Priority order:
 *   InsufficientCoinBalance -> INSUFFICIENT_BALANCE
 *   Address balance insufficient -> INSUFFICIENT_BALANCE
 *   EClaimTooHigh -> CLAIM_WOULD_EXCEED_MAX
 *   ETotalInTooLow -> INSUFFICIENT_SETTLE_INPUT
 *   ESpreadTooWide -> SPREAD_EXCEEDED
 *   EMinimumQuantityOutNotMet -> SLIPPAGE_EXCEEDED
 *   everything else -> DRY_RUN_FAILED
 *
 * Stelis classifications are package-bound to `stelisPackageId`; DeepBook
 * classification is bound to the generated runtime identity. Non-trusted
 * aborts fall through to `DRY_RUN_FAILED`.
 */
export function classifyDryRunFailure(
  error: SuiExecutionError,
  stelisPackageId: string,
  commands: readonly PtbCommand[],
  meta?: PrepareErrorMeta,
): PrepareValidationError {
  const known = classifyKnownPrepareFailure(
    error,
    stelisPackageId,
    {
      kind: 'settlement',
      commands,
    },
    meta,
  );
  if (known) return known;
  return new PrepareValidationError(
    'DRY_RUN_FAILED',
    `Dry-run failed: ${suiExecutionErrorMessage(error)}`,
    meta,
  );
}

// ---------------------------------------------------------------------------
// Safe TX build wrapper
// ---------------------------------------------------------------------------

/**
 * Build through the exact current Sui operation authority and classify only
 * its parsed execution failure. Display text is never parsed.
 *
 * Without this, known build-time MoveAborts and coin-balance failures
 * propagate as untyped Error -> 500.
 *
 * Move-abort classifications inside this wrapper are package-bound;
 * pass the trusted Stelis package ID from the surrounding context. DeepBook's
 * abort identity is generated from compiled bytecode.
 */
export async function safeBuildAddressBalanceGasTransaction(
  tx: Transaction,
  sui: ChainBoundSuiEndpointSnapshot,
  sponsorAddress: string,
  gasBudget: bigint,
  stelisPackageId: string,
  meta?: PrepareErrorMeta,
): Promise<AddressBalanceGasTransaction> {
  const commands = convertSdkCommands(tx.getData().commands as unknown[]);
  const scope = { kind: 'settlement', commands } as const;
  try {
    return await buildAddressBalanceGasTransaction(sui, {
      transaction: tx,
      sponsorAddress,
      gasBudget,
    });
  } catch (err) {
    if (err instanceof SuiAddressBalanceGasUnavailableError) {
      throw new PrepareValidationError(
        'SPONSOR_CAPACITY_UNAVAILABLE',
        'The assigned sponsor address cannot supply the requested gas budget',
      );
    }
    const error = getSuiRejectedExecutionError(err);
    if (error) {
      // Only the address-balance builder can bind a parsed current execution failure to
      // the server-only authority extractor. Caller-created errors cannot enter
      // this classification path.
      const known = classifyKnownPrepareFailure(error, stelisPackageId, scope, meta);
      if (known) throw known;
      throw classifyDryRunFailure(error, stelisPackageId, commands, meta);
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Settle meta helper
// ---------------------------------------------------------------------------

/**
 * Build diagnostic meta for INSUFFICIENT_SETTLE_INPUT and related errors.
 * @param isEstimate true = pass1 (executionCostClaim not yet confirmed), false = pass2 (confirmed)
 */
export function buildSettleMeta(
  minSettleMist: bigint,
  quotedHostFeeMist: bigint,
  protocolFlatFeeMist: bigint,
  claimEstimate: bigint,
  isEstimate: boolean,
): PrepareErrorMeta {
  const totalNeeded = claimEstimate + quotedHostFeeMist + protocolFlatFeeMist;
  const required = minSettleMist > totalNeeded ? minSettleMist : totalNeeded;
  return {
    minSettleMist: minSettleMist.toString(),
    requiredTotalIn: required.toString(),
    isEstimate,
  };
}
