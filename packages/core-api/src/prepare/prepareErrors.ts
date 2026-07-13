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
 *   DRY_RUN_NO_GAS            - dry-run returned no gas usage
 *
 * Numeric abort codes are resolved through the generated
 * `@stelis/contracts` settlement contract. The generator reads the exact
 * compiled modules produced from the locked Move graph.
 *
 * Slippage query errors (SLIPPAGE_QUERY_FAILED) are handled in the
 * build-time market-policy solve path.
 *
 * Package + occurrence + outer-command binding:
 *   Stelis helpers take the active Stelis package ID. DeepBook uses the
 *   original/runtime ModuleId generated from the consumed bytecode; its
 *   published storage/call-target ID is a different identity. Each match
 *   must satisfy all of:
 *     1. the abort string mentions the trusted `<pkg>::<modulePath>`
 *        substring, and
 *     2. the package/module, optional clever-error constant, numeric abort
 *        code, and command position are parsed from one supported occurrence:
 *        an abort tuple or the installed numeric/clever formatter, and
 *     3. that occurrence reports the same outer PTB command that the current
 *        transaction graph proves can execute the trusted call.
 *   External packages with the same module name (`vault`, `settle`,
 *   `pool::swap_exact_quantity`) and the same numeric code do not
 *   classify, and free-floating numeric tokens like `command N`,
 *   `5th command`, or `(instruction N)` cannot impersonate the abort
 *   code. The active Stelis ID comes from the Host/Build context; the
 *   DeepBook runtime identity comes only from the generated contract module.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Transaction } from '@mysten/sui/transactions';
import { convertSdkCommands } from '@stelis/core-relay';
import { findUniqueSettleCommandIndex } from '@stelis/core-relay/server';
import {
  DEEPBOOK_MIN_OUT_ABORT,
  SETTLE_ABORT,
  SETTLEMENT_ENTRY_FUNCTIONS,
  SETTLE_FUNCTIONS,
  SETTLE_MODULE,
  VAULT_ABORT,
} from '@stelis/contracts';
import type { MoveCallCommand, PtbCommand } from '@stelis/contracts';
import { PrepareValidationError } from './replay.js';

// ---------------------------------------------------------------------------
// Settle/vault/deepbook abort detection (package-bound)
// ---------------------------------------------------------------------------

interface MoveAbortOccurrence {
  packageId: string;
  moduleName: string;
  functionName?: string;
  code: number;
  constantName?: string;
  commandIndex: number;
}

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

const MOVE_IDENTIFIER = String.raw`[A-Za-z_][A-Za-z0-9_]*`;
const MOVE_PATH = String.raw`(0x[0-9a-fA-F]{1,64})::(${MOVE_IDENTIFIER})(?:::(${MOVE_IDENTIFIER}))?`;
const MOVE_LOCATION_PREFIX = String.raw`(?:\bin\b[\s,:()=-]*(?:module\b[\s,:()=-]*)?|\bmodule\b[\s,:()=-]*)`;
const MOVE_LOCATION_TAIL = String.raw`(?:\s*\((?:instruction|line)\s+\d+\))?\s*$`;

function normalizePackageId(packageId: string): string | undefined {
  const match = /^0x([0-9a-fA-F]{1,64})$/.exec(packageId);
  if (!match) return undefined;
  return `0x${match[1]!.toLowerCase().padStart(64, '0')}`;
}

function moveAbortSegments(reason: string): string[] {
  const segments: string[] = [];

  for (const clause of reason.split(/[;\r\n]+/)) {
    const moveAbortStarts = [...clause.matchAll(/\bMoveAbort\b/gi)].map((match) => match.index!);
    for (const [index, start] of moveAbortStarts.entries()) {
      segments.push(clause.slice(start, moveAbortStarts[index + 1] ?? clause.length));
    }
  }

  return segments;
}

function parseAbortCode(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const code = Number(value);
  return Number.isSafeInteger(code) ? code : undefined;
}

function parseCommandIndex(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const commandIndex = Number(value);
  return Number.isSafeInteger(commandIndex) ? commandIndex : undefined;
}

function parseOrdinalCommandIndex(value: string, suffix: string): number | undefined {
  const ordinal = parseCommandIndex(value);
  if (ordinal === undefined || ordinal <= 0) return undefined;
  const lastTwoDigits = ordinal % 100;
  const expectedSuffix =
    lastTwoDigits >= 11 && lastTwoDigits <= 13
      ? 'th'
      : ordinal % 10 === 1
        ? 'st'
        : ordinal % 10 === 2
          ? 'nd'
          : ordinal % 10 === 3
            ? 'rd'
            : 'th';
  return suffix.toLowerCase() === expectedSuffix ? ordinal - 1 : undefined;
}

function appendOccurrence(
  occurrences: MoveAbortOccurrence[],
  packageId: string,
  moduleName: string,
  functionName: string | undefined,
  codeText: string,
  constantName: string | undefined,
  commandIndex: number | undefined,
): void {
  const normalizedPackageId = normalizePackageId(packageId);
  const code = parseAbortCode(codeText);
  if (
    !normalizedPackageId ||
    code === undefined ||
    commandIndex === undefined ||
    !Number.isSafeInteger(commandIndex) ||
    commandIndex < 0
  ) {
    return;
  }
  occurrences.push({
    packageId: normalizedPackageId,
    moduleName,
    ...(functionName ? { functionName } : {}),
    code,
    ...(constantName ? { constantName } : {}),
    commandIndex,
  });
}

function parseMoveLocation(
  value: string,
): { packageId: string; moduleName: string; functionName?: string } | undefined {
  const prefixed = new RegExp(String.raw`^[\s,:()=-]*${MOVE_LOCATION_PREFIX}(.+)$`, 'i').exec(
    value,
  );
  if (!prefixed) return undefined;
  const location = prefixed[1]!.trim();
  for (const pattern of [
    new RegExp(String.raw`^'${MOVE_PATH}'${MOVE_LOCATION_TAIL}`, 'i'),
    new RegExp(String.raw`^"${MOVE_PATH}"${MOVE_LOCATION_TAIL}`, 'i'),
    new RegExp(String.raw`^${MOVE_PATH}${MOVE_LOCATION_TAIL}`, 'i'),
  ]) {
    const match = pattern.exec(location);
    if (match) {
      return {
        packageId: match[1]!,
        moduleName: match[2]!,
        ...(match[3] ? { functionName: match[3] } : {}),
      };
    }
  }
  return undefined;
}

/** Parse each supported Sui MoveAbort occurrence without joining data across occurrences. */
function parseMoveAbortOccurrences(reason: string): MoveAbortOccurrence[] {
  const occurrences: MoveAbortOccurrence[] = [];
  const formatterPrefix = String.raw`MoveAbort\s+in\s+(\d+)(st|nd|rd|th)\s+command`;
  const tuplePattern = new RegExp(
    String.raw`^MoveAbort\s*\(\s*${MOVE_PATH}\s*,\s*(\d+)\s*\)\s+in\s+command\s+(\d+)(?![A-Za-z0-9_.])`,
    'i',
  );
  const formatterCodePattern = new RegExp(
    String.raw`^${formatterPrefix}\s*,\s*abort code\s*:\s*(\d+)(?![\d.])\s*,([^;\r\n]*)$`,
    'i',
  );
  const formatterCleverPattern = new RegExp(
    String.raw`^${formatterPrefix}\s*,\s*'(${MOVE_IDENTIFIER})'\s*:\s*(\d+)(?![\d.])\s*,([^;\r\n]*)$`,
    'i',
  );
  for (const segment of moveAbortSegments(reason)) {
    const tuple = segment.match(tuplePattern);
    if (tuple) {
      appendOccurrence(
        occurrences,
        tuple[1]!,
        tuple[2]!,
        tuple[3],
        tuple[4]!,
        undefined,
        parseCommandIndex(tuple[5]!),
      );
      continue;
    }

    const clever = segment.match(formatterCleverPattern);
    if (clever) {
      const location = parseMoveLocation(clever[5]!);
      if (location) {
        appendOccurrence(
          occurrences,
          location.packageId,
          location.moduleName,
          location.functionName,
          clever[4]!,
          clever[3]!,
          parseOrdinalCommandIndex(clever[1]!, clever[2]!),
        );
      }
      continue;
    }

    const formatterCode = segment.match(formatterCodePattern);
    if (formatterCode) {
      const location = parseMoveLocation(formatterCode[4]!);
      if (location) {
        appendOccurrence(
          occurrences,
          location.packageId,
          location.moduleName,
          location.functionName,
          formatterCode[3]!,
          undefined,
          parseOrdinalCommandIndex(formatterCode[1]!, formatterCode[2]!),
        );
      }
      continue;
    }
  }

  return occurrences;
}

function hasMoveAbort(
  reason: string,
  packageId: string,
  modulePath: string,
  constantName: string,
  code: number,
  commandIndex: number,
): boolean {
  if (!Number.isSafeInteger(commandIndex) || commandIndex < 0) return false;
  const normalizedPackageId = normalizePackageId(packageId);
  if (!normalizedPackageId) return false;
  const [expectedModuleName, expectedFunctionName, ...unexpectedSegments] = modulePath.split('::');
  if (!expectedModuleName || unexpectedSegments.length > 0) return false;
  return parseMoveAbortOccurrences(reason).some(
    (occurrence) =>
      occurrence.packageId === normalizedPackageId &&
      occurrence.code === code &&
      occurrence.commandIndex === commandIndex &&
      (occurrence.constantName === undefined || occurrence.constantName === constantName) &&
      occurrence.moduleName === expectedModuleName &&
      (expectedFunctionName === undefined || occurrence.functionName === expectedFunctionName),
  );
}

/** settle.move EPaused */
export function isPaused(reason: string, stelisPackageId: string, commandIndex: number): boolean {
  return hasMoveAbort(
    reason,
    stelisPackageId,
    'settle',
    'EPaused',
    SETTLE_ABORT.EPaused,
    commandIndex,
  );
}

/** vault.move EVaultAlreadyRegistered */
export function isVaultAlreadyRegistered(
  reason: string,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    reason,
    stelisPackageId,
    'vault',
    'EVaultAlreadyRegistered',
    VAULT_ABORT.EVaultAlreadyRegistered,
    commandIndex,
  );
}

/** vault.move EReplayNonce */
export function isReplayNonce(
  reason: string,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    reason,
    stelisPackageId,
    'vault',
    'EReplayNonce',
    VAULT_ABORT.EReplayNonce,
    commandIndex,
  );
}

/** settle.move EClaimTooHigh */
export function isClaimTooHigh(
  reason: string,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    reason,
    stelisPackageId,
    'settle',
    'EClaimTooHigh',
    SETTLE_ABORT.EClaimTooHigh,
    commandIndex,
  );
}

/** settle.move ETotalInTooLow */
export function isTotalInTooLow(
  reason: string,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    reason,
    stelisPackageId,
    'settle',
    'ETotalInTooLow',
    SETTLE_ABORT.ETotalInTooLow,
    commandIndex,
  );
}

/** settle.move ESpreadTooWide */
export function isSpreadTooWide(
  reason: string,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    reason,
    stelisPackageId,
    'settle',
    'ESpreadTooWide',
    SETTLE_ABORT.ESpreadTooWide,
    commandIndex,
  );
}

/** settle.move EInsufficientFunds */
export function isInsufficientFunds(
  reason: string,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    reason,
    stelisPackageId,
    'settle',
    'EInsufficientFunds',
    SETTLE_ABORT.EInsufficientFunds,
    commandIndex,
  );
}

/** settle.move EInvalidReceiptId */
export function isInvalidReceiptId(
  reason: string,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    reason,
    stelisPackageId,
    'settle',
    'EInvalidReceiptId',
    SETTLE_ABORT.EInvalidReceiptId,
    commandIndex,
  );
}

/** settle.move EInvalidPolicyHash */
export function isInvalidPolicyHash(
  reason: string,
  stelisPackageId: string,
  commandIndex: number,
): boolean {
  return hasMoveAbort(
    reason,
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
 * classify as `SLIPPAGE_EXCEEDED`. Code-position-bound via
 * occurrence-bound parsing so a free-floating `(instruction 12)` token cannot
 * satisfy the code.
 */
export function isDeepbookMinOutNotMet(reason: string, commandIndex: number): boolean {
  return hasMoveAbort(
    reason,
    DEEPBOOK_MIN_OUT_ABORT.runtimePackageId,
    DEEPBOOK_MIN_OUT_ABORT.modulePath,
    DEEPBOOK_MIN_OUT_ABORT.constantName,
    DEEPBOOK_MIN_OUT_ABORT.code,
    commandIndex,
  );
}

export type SponsorFailureSubcode =
  | 'CLAIM_WOULD_EXCEED_MAX'
  | 'INSUFFICIENT_SETTLE_INPUT'
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_RECEIPT_ID'
  | 'INVALID_POLICY_HASH'
  | 'SPREAD_EXCEEDED'
  | 'SLIPPAGE_EXCEEDED'
  | 'PAUSED'
  | 'VAULT_ALREADY_REGISTERED'
  | 'REPLAY_NONCE';

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
  reason: string,
  stelisPackageId: string,
  commandIndex: number,
  functionName: string,
): Exclude<SponsorFailureSubcode, 'SLIPPAGE_EXCEEDED'> | undefined {
  const entry = compiledSettlementEntry(functionName);
  if (!entry) return undefined;
  const canSwap = entry.parameters.some((parameter) => parameter.name === 'pool');

  if (isClaimTooHigh(reason, stelisPackageId, commandIndex)) return 'CLAIM_WOULD_EXCEED_MAX';
  if (canSwap && isTotalInTooLow(reason, stelisPackageId, commandIndex)) {
    return 'INSUFFICIENT_SETTLE_INPUT';
  }
  if (isInsufficientFunds(reason, stelisPackageId, commandIndex)) return 'INSUFFICIENT_FUNDS';
  if (isInvalidReceiptId(reason, stelisPackageId, commandIndex)) return 'INVALID_RECEIPT_ID';
  if (isInvalidPolicyHash(reason, stelisPackageId, commandIndex)) return 'INVALID_POLICY_HASH';
  if (canSwap && isSpreadTooWide(reason, stelisPackageId, commandIndex)) {
    return 'SPREAD_EXCEEDED';
  }
  if (isPaused(reason, stelisPackageId, commandIndex)) return 'PAUSED';
  if (
    entry.variantClass === 'new_user' &&
    isVaultAlreadyRegistered(reason, stelisPackageId, commandIndex)
  ) {
    return 'VAULT_ALREADY_REGISTERED';
  }
  if (isReplayNonce(reason, stelisPackageId, commandIndex)) return 'REPLAY_NONCE';
  return undefined;
}

export function classifySponsorFailureSubcode(
  reason: string,
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
      classifyStelisFailureAtCommand(reason, stelisPackageId, commandIndex, functionName) ??
      (canSwap && isDeepbookMinOutNotMet(reason, commandIndex) ? 'SLIPPAGE_EXCEEDED' : undefined)
    );
  }

  for (let commandIndex = 0; commandIndex < scope.commands.length; commandIndex++) {
    const command = scope.commands[commandIndex]!;
    if (isStelisSettlementCommand(command, stelisPackageId)) {
      const functionName = (command as MoveCallCommand).function;
      const stelisSubcode = classifyStelisFailureAtCommand(
        reason,
        stelisPackageId,
        commandIndex,
        functionName,
      );
      if (stelisSubcode) return stelisSubcode;
      if (settlementEntryCanSwap(functionName) && isDeepbookMinOutNotMet(reason, commandIndex)) {
        return 'SLIPPAGE_EXCEEDED';
      }
    }
    if (
      isDirectDeepbookSwapCommand(command, scope.deepbookPackageId) &&
      isDeepbookMinOutNotMet(reason, commandIndex)
    ) {
      return 'SLIPPAGE_EXCEEDED';
    }
  }

  return undefined;
}

/**
 * Classify known prepare failures into typed validation errors.
 * Returns null when the reason is unknown and should fall back to DRY_RUN_FAILED.
 */
function classifyKnownPrepareFailure(
  reason: string,
  stelisPackageId: string,
  scope: SponsorFailureCommandScope,
  meta?: Record<string, string>,
): PrepareValidationError | null {
  if (reason.includes('InsufficientCoinBalance')) {
    return new PrepareValidationError(
      'INSUFFICIENT_BALANCE',
      `Insufficient coin balance: ${reason}`,
      meta,
    );
  }
  if (reason.includes('Available amount') && reason.includes('less than requested')) {
    return new PrepareValidationError(
      'INSUFFICIENT_BALANCE',
      `Insufficient address balance: ${reason}`,
      meta,
    );
  }

  const subcode = classifySponsorFailureSubcode(reason, stelisPackageId, scope);
  if (subcode === 'CLAIM_WOULD_EXCEED_MAX') {
    return new PrepareValidationError(
      'CLAIM_WOULD_EXCEED_MAX',
      `Computed execution cost claim exceeds configured max: ${reason}`,
      meta,
    );
  }
  if (subcode === 'INSUFFICIENT_SETTLE_INPUT') {
    return new PrepareValidationError(
      'INSUFFICIENT_SETTLE_INPUT',
      `Settle input too low: ${reason}`,
      meta,
    );
  }
  if (subcode === 'SPREAD_EXCEEDED') {
    return new PrepareValidationError(
      'SPREAD_EXCEEDED',
      `DeepBook spread too wide or book empty: ${reason}`,
      meta,
    );
  }
  if (subcode === 'SLIPPAGE_EXCEEDED') {
    return new PrepareValidationError(
      'SLIPPAGE_EXCEEDED',
      `Minimum output not met during swap: ${reason}`,
      meta,
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Dry-run failure classification
// ---------------------------------------------------------------------------

/**
 * Classify a dry-run failure reason into a specific error code.
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
  reason: string,
  stelisPackageId: string,
  commands: readonly PtbCommand[],
  meta?: Record<string, string>,
): PrepareValidationError {
  const known = classifyKnownPrepareFailure(
    reason,
    stelisPackageId,
    {
      kind: 'settlement',
      commands,
    },
    meta,
  );
  if (known) return known;
  return new PrepareValidationError('DRY_RUN_FAILED', `Dry-run failed: ${reason}`, meta);
}

// ---------------------------------------------------------------------------
// Safe TX build wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap Transaction.build() to classify SDK errors as PrepareValidationError.
 *
 * Without this, known build-time MoveAborts and coin-balance failures
 * propagate as untyped Error -> 500.
 *
 * Move-abort classifications inside this wrapper are package-bound;
 * pass the trusted Stelis package ID from the surrounding context. DeepBook's
 * abort identity is generated from compiled bytecode.
 */
export async function safeBuild(
  tx: Transaction,
  client: SuiGrpcClient,
  stelisPackageId: string,
  meta?: Record<string, string>,
): Promise<Uint8Array> {
  const commands = convertSdkCommands(tx.getData().commands as unknown[]);
  const scope = { kind: 'settlement', commands } as const;
  try {
    return await tx.build({ client });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    const known = classifyKnownPrepareFailure(msg, stelisPackageId, scope, meta);
    if (known) throw known;

    // Catch-all: MoveAbort or transaction resolution failures that don't match
    // specific patterns above. Classify as DRY_RUN_FAILED (422) instead of
    // letting them propagate as untyped Error (500).
    if (msg.includes('MoveAbort') || msg.includes('Transaction resolution failed')) {
      throw classifyDryRunFailure(msg, stelisPackageId, commands, meta);
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
): Record<string, string> {
  const totalNeeded = claimEstimate + quotedHostFeeMist + protocolFlatFeeMist;
  const required = minSettleMist > totalNeeded ? minSettleMist : totalNeeded;
  return {
    minSettleMist: minSettleMist.toString(),
    requiredTotalIn: required.toString(),
    isEstimate: String(isEstimate),
  };
}
