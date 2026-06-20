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
 * Numeric abort codes are resolved through `SETTLE_ABORT` / `DEEPBOOK_ABORT`
 * (core-relay), which are locked to the Move sources by
 * `packages/core-relay/tests/errorCodeLock.test.ts`. Renumbering the Move
 * source fails the lock test instead of silently skipping classification.
 *
 * Slippage query errors (SLIPPAGE_QUERY_FAILED) are handled in the
 * build-time market-policy solve path.
 *
 * Package + code-position binding:
 *   Every classifier and `isXxx` helper takes the trusted Stelis package
 *   ID and the trusted DeepBook package ID. Each match must satisfy
 *   both:
 *     1. the abort string mentions the trusted `<pkg>::<modulePath>`
 *        substring, and
 *     2. the numeric abort code is bound to its actual abort-code
 *        position — either inside the `MoveAbort(<pkg>::<modulePath>,
 *        <code>)` tuple, or after the `\\babort code\\b` keyword.
 *   External packages with the same module name (`vault`, `settle`,
 *   `pool::swap_exact_quantity`) and the same numeric code do not
 *   classify, and free-floating numeric tokens like `command N`,
 *   `5th command`, or `(instruction N)` cannot impersonate the abort
 *   code. Trusted IDs come from `RelayerContext.packageId` /
 *   `RelayerContext.deepbookPackageId` (sponsor-time) and
 *   `BuildContext.packageId` / `BuildContext.deepbookPackageId`
 *   (prepare-time); host wiring is verified by
 *   `packages/app-api/src/context.ts`.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Transaction } from '@mysten/sui/transactions';
import { SETTLE_ABORT, VAULT_ABORT, DEEPBOOK_ABORT } from '@stelis/core-relay';
import { PrepareValidationError } from './replay.js';

// ---------------------------------------------------------------------------
// Settle/vault/deepbook abort detection (package-bound)
// ---------------------------------------------------------------------------

/**
 * Escape a Sui package ID or module path for use as a regex literal.
 * Sui package IDs are `0x` + lowercase hex; module paths use `::`. We
 * escape every regex metacharacter defensively so a malformed input
 * cannot turn into a wildcard.
 */
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a regex that binds a Move abort code to its actual abort-code
 * position within the supported Sui error string forms, anchored to a
 * trusted package + module path. Free-floating numeric tokens such as
 * `command N`, `5th command`, or `(instruction N)` cannot satisfy the
 * code position.
 *
 * Package binding: the regex matches only when the abort string
 * mentions `<packageId>::<modulePath>`; external packages sharing module
 * names cannot classify.
 *
 * Code-position binding: supports the two abort forms that
 * appear in current Sui RPC error strings.
 *
 *   Form A — abort tuple form:
 *     `MoveAbort(<pkg>::<modulePath>[::<fn>]?, <code>)`
 *   The code lives inside the parenthesized abort tuple, so any
 *   numeric token outside the tuple cannot satisfy.
 *
 *   Form B — `abort code` keyword form:
 *     `... abort code[:]? <code> ... <pkg>::<modulePath> ...`
 *   The `\babort code\b` keyword anchors the next number as the
 *   abort code. Free-floating numbers like `command 5` or
 *   `(instruction 165)` lack the keyword and cannot satisfy.
 *
 * Both forms also demand the trusted `<pkg>::<modulePath>` substring,
 * so an untrusted package cannot piggy-back on a matching code.
 *
 * Numeric codes come from `SETTLE_ABORT` / `VAULT_ABORT` /
 * `DEEPBOOK_ABORT`; renumbering Move sources appears as a lock-test
 * failure rather than a silent classifier miss.
 */
function buildAbortRegex(packageId: string, modulePath: string, code: number): RegExp {
  const pkg = escapeForRegex(packageId);
  const mod = escapeForRegex(modulePath);
  const formA = `MoveAbort\\(${pkg}::${mod}(?:::[A-Za-z_][A-Za-z0-9_]*)?\\s*,\\s*${code}\\s*\\)`;
  const formB = `\\babort code\\b\\s*:?\\s*${code}\\b[\\s\\S]*?${pkg}::${mod}\\b`;
  return new RegExp(`(?:${formA})|(?:${formB})`);
}

/** settle.move EPaused */
export function isPaused(reason: string, stelisPackageId: string): boolean {
  return buildAbortRegex(stelisPackageId, 'settle', SETTLE_ABORT.EPaused).test(reason);
}

/** vault.move EVaultAlreadyRegistered */
export function isVaultAlreadyRegistered(reason: string, stelisPackageId: string): boolean {
  return buildAbortRegex(stelisPackageId, 'vault', VAULT_ABORT.EVaultAlreadyRegistered).test(
    reason,
  );
}

/** vault.move EReplayNonce */
export function isReplayNonce(reason: string, stelisPackageId: string): boolean {
  return buildAbortRegex(stelisPackageId, 'vault', VAULT_ABORT.EReplayNonce).test(reason);
}

/** settle.move EClaimTooHigh */
export function isClaimTooHigh(reason: string, stelisPackageId: string): boolean {
  return buildAbortRegex(stelisPackageId, 'settle', SETTLE_ABORT.EClaimTooHigh).test(reason);
}

/** settle.move ETotalInTooLow */
export function isTotalInTooLow(reason: string, stelisPackageId: string): boolean {
  return buildAbortRegex(stelisPackageId, 'settle', SETTLE_ABORT.ETotalInTooLow).test(reason);
}

/** settle.move ESpreadTooWide */
export function isSpreadTooWide(reason: string, stelisPackageId: string): boolean {
  return buildAbortRegex(stelisPackageId, 'settle', SETTLE_ABORT.ESpreadTooWide).test(reason);
}

/** settle.move EInsufficientFunds */
export function isInsufficientFunds(reason: string, stelisPackageId: string): boolean {
  return buildAbortRegex(stelisPackageId, 'settle', SETTLE_ABORT.EInsufficientFunds).test(reason);
}

/** settle.move EInvalidReceiptId */
export function isInvalidReceiptId(reason: string, stelisPackageId: string): boolean {
  return buildAbortRegex(stelisPackageId, 'settle', SETTLE_ABORT.EInvalidReceiptId).test(reason);
}

/** settle.move EInvalidPolicyHash */
export function isInvalidPolicyHash(reason: string, stelisPackageId: string): boolean {
  return buildAbortRegex(stelisPackageId, 'settle', SETTLE_ABORT.EInvalidPolicyHash).test(reason);
}

/**
 * DeepBook `pool::swap_exact_quantity` `EMinimumQuantityOutNotMet`.
 *
 * External dependency — `DEEPBOOK_ABORT` in core-relay tracks the numeric
 * code. Not locked to a Move source in this repo; keep aligned with the
 * DeepBook package version pinned in `packages/contracts/move/Move.toml`.
 *
 * Package-bound to the trusted DeepBook package ID so external packages
 * with module `pool::swap_exact_quantity` and the same abort code cannot
 * classify as `SLIPPAGE_EXCEEDED`. Code-position-bound via
 * `buildAbortRegex` so a free-floating `(instruction 12)` token cannot
 * satisfy the code.
 */
export function isDeepbookMinOutNotMet(reason: string, deepbookPackageId: string): boolean {
  return buildAbortRegex(
    deepbookPackageId,
    'pool::swap_exact_quantity',
    DEEPBOOK_ABORT.EMinimumQuantityOutNotMet,
  ).test(reason);
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
 * Both trusted package IDs are required: the classifier returns
 * a typed Stelis subcode only when the abort message is bound to
 * `stelisPackageId`, and `SLIPPAGE_EXCEEDED` only when bound to
 * `deepbookPackageId`. External packages with the same module names
 * and abort codes return `undefined` so the caller falls back to the
 * request-flow-specific unclassified path (`simulation_failed` /
 * `onchain_revert` / `DRY_RUN_FAILED`).
 */
export function classifySponsorFailureSubcode(
  reason: string,
  stelisPackageId: string,
  deepbookPackageId: string,
): SponsorFailureSubcode | undefined {
  if (isClaimTooHigh(reason, stelisPackageId)) return 'CLAIM_WOULD_EXCEED_MAX';
  if (isTotalInTooLow(reason, stelisPackageId)) return 'INSUFFICIENT_SETTLE_INPUT';
  if (isInsufficientFunds(reason, stelisPackageId)) return 'INSUFFICIENT_FUNDS';
  if (isInvalidReceiptId(reason, stelisPackageId)) return 'INVALID_RECEIPT_ID';
  if (isInvalidPolicyHash(reason, stelisPackageId)) return 'INVALID_POLICY_HASH';
  if (isSpreadTooWide(reason, stelisPackageId)) return 'SPREAD_EXCEEDED';
  if (isPaused(reason, stelisPackageId)) return 'PAUSED';
  if (isVaultAlreadyRegistered(reason, stelisPackageId)) return 'VAULT_ALREADY_REGISTERED';
  if (isReplayNonce(reason, stelisPackageId)) return 'REPLAY_NONCE';
  if (isDeepbookMinOutNotMet(reason, deepbookPackageId)) return 'SLIPPAGE_EXCEEDED';
  return undefined;
}

/**
 * Classify known prepare failures into typed validation errors.
 * Returns null when the reason is unknown and should fall back to DRY_RUN_FAILED.
 */
function classifyKnownPrepareFailure(
  reason: string,
  stelisPackageId: string,
  deepbookPackageId: string,
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

  const subcode = classifySponsorFailureSubcode(reason, stelisPackageId, deepbookPackageId);
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
 *   EClaimTooHigh (settle 101) -> CLAIM_WOULD_EXCEED_MAX
 *   ETotalInTooLow (settle 102) -> INSUFFICIENT_SETTLE_INPUT
 *   ESpreadTooWide (settle 110) -> SPREAD_EXCEEDED
 *   EMinimumQuantityOutNotMet (deepbook pool 12) -> SLIPPAGE_EXCEEDED
 *   everything else -> DRY_RUN_FAILED
 *
 * All Move-abort classifications are package-bound to `stelisPackageId`
 * / `deepbookPackageId`; non-trusted aborts fall through to
 * `DRY_RUN_FAILED`.
 */
export function classifyDryRunFailure(
  reason: string,
  stelisPackageId: string,
  deepbookPackageId: string,
  meta?: Record<string, string>,
): PrepareValidationError {
  const known = classifyKnownPrepareFailure(reason, stelisPackageId, deepbookPackageId, meta);
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
 * pass the trusted Stelis and DeepBook package IDs from the
 * surrounding `BuildContext` / `RelayerContext`.
 */
export async function safeBuild(
  tx: Transaction,
  client: SuiGrpcClient,
  stelisPackageId: string,
  deepbookPackageId: string,
  meta?: Record<string, string>,
): Promise<Uint8Array> {
  try {
    return await tx.build({ client });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    const known = classifyKnownPrepareFailure(msg, stelisPackageId, deepbookPackageId, meta);
    if (known) throw known;

    // Catch-all: MoveAbort or transaction resolution failures that don't match
    // specific patterns above. Classify as DRY_RUN_FAILED (422) instead of
    // letting them propagate as untyped Error (500).
    if (msg.includes('MoveAbort') || msg.includes('Transaction resolution failed')) {
      throw classifyDryRunFailure(msg, stelisPackageId, deepbookPackageId, meta);
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
