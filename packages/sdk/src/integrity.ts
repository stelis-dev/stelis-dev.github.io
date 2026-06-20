/**
 * S-16: Client-side PTB integrity verification (defense-in-depth).
 *
 * Verifies that Host-returned txBytes preserve the user's original commands
 * as a prefix and append only allowed settle-related commands.
 *
 * This is NOT a substitute for server L0-L4 or on-chain validation.
 *
 * Uses shared policy logic from:
 *   - @stelis/core-relay: convertSdkCommands, containsGasCoinReference
 *   - @stelis/contracts: SETTLE_MODULE, SETTLE_FUNCTIONS, SUI_TYPE,
 *     INTEGRITY_POLICY_VERSION
 */
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import {
  convertSdkCommands,
  containsGasCoinReference,
  isMoveCall,
  integrityCompare,
} from '@stelis/core-relay/browser';
import {
  SETTLE_MODULE,
  SETTLE_FUNCTIONS,
  SUI_TYPE,
  INTEGRITY_POLICY_VERSION,
} from '@stelis/contracts';
import type { PtbCommand } from '@stelis/contracts';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** The integrity policy version supported by this SDK build (from @stelis/contracts). */
export const SUPPORTED_INTEGRITY_POLICY_VERSION = INTEGRITY_POLICY_VERSION;

/** SUI framework address derived from the shared SUI_TYPE constant. */
const SUI_FRAMEWORK_ADDRESS = normalizeSuiAddress(SUI_TYPE.split('::')[0]);

// ─────────────────────────────────────────────
// Error
// ─────────────────────────────────────────────

export class StelisIntegrityError extends Error {
  constructor(message: string) {
    super(`[S-16] PTB integrity check failed: ${message}`);
    this.name = 'StelisIntegrityError';
  }
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Verify that Host-returned txBytes preserve user commands as prefix
 * and append only allowed settle commands as suffix.
 *
 * @throws StelisIntegrityError if verification fails
 */
export function verifyPtbIntegrity(
  originalKindBytes: Uint8Array,
  returnedTxBase64: string,
  packageId: string,
): void {
  // Parse both sides into PtbCommand[] via shared core conversion
  const originalTx = Transaction.fromKind(originalKindBytes);
  const returnedTx = Transaction.from(fromBase64(returnedTxBase64));

  // Step 0: Inputs — returned must preserve all original input values
  const originalInputs = originalTx.getData().inputs as Record<string, unknown>[];
  const returnedInputs = returnedTx.getData().inputs as Record<string, unknown>[];
  verifyInputs(originalInputs, returnedInputs);

  const originalCmds = convertSdkCommands(originalTx.getData().commands as unknown[]);
  const returnedCmds = convertSdkCommands(returnedTx.getData().commands as unknown[]);

  // Step 1: Prefix — returned must contain all original commands
  verifyPrefix(originalCmds, returnedCmds);

  // Step 2: Suffix — only allowed settle commands after user prefix
  const suffix = returnedCmds.slice(originalCmds.length);
  verifySuffix(suffix, packageId);
}

// ─────────────────────────────────────────────
// Input verification
// ─────────────────────────────────────────────

/**
 * Extract objectId from any Object input variant.
 * Delegates to the shared @stelis/core-relay input helper.
 */
import { extractObjectIdFromInput } from '@stelis/core-relay/browser';
export const extractObjectId = extractObjectIdFromInput;

/**
 * Normalize an input to a comparable string.
 * - Pure: compared by bytes (base64)
 * - Object (all 3 variants): compared by normalized objectId (cross-type equivalence)
 * - Unknown kind: fail-closed (throw)
 */
export function normalizeInput(input: Record<string, unknown>): string {
  const kind = input.$kind as string;

  // Pure: bytes (base64) comparison
  if (kind === 'Pure') {
    return `Pure:${(input.Pure as { bytes: string }).bytes}`;
  }

  // Object family: objectId-based cross-type equivalence
  // UnresolvedObject (pre-build) ↔ Object.SharedObject/ImmOrOwnedObject (resolved)
  // are equivalent if objectId matches. Additional resolved fields
  // (initialSharedVersion, version, digest, mutable) are added during resolve
  // and validated on-chain, not here.
  const objectId = extractObjectId(input);
  if (objectId !== null) {
    return `Object:${normalizeSuiAddress(objectId)}`;
  }

  // FundsWithdrawal: Host-appended input for address balance redemption.
  // These appear as suffix inputs (index > original.length) so they never
  // conflict with prefix verification. Normalize by kind + type + amount +
  // withdrawFrom for full semantic equivalence.
  if (kind === 'FundsWithdrawal') {
    const fw = input.FundsWithdrawal as Record<string, unknown> | undefined;
    const typeArg = (fw?.typeArg as Record<string, unknown>)?.Balance ?? 'unknown';
    const amount = (fw?.reservation as Record<string, unknown>)?.MaxAmountU64 ?? 'unknown';
    const wf = fw?.withdrawFrom as Record<string, unknown> | undefined;
    const withdrawFrom = wf?.$kind ?? 'unknown';
    return `FundsWithdrawal:${typeArg}:${amount}:${withdrawFrom}`;
  }

  // Unknown kind → fail-closed (S-16 defense-in-depth)
  throw new StelisIntegrityError(`unsupported input kind: ${kind}`);
}

/**
 * Verify that returned inputs preserve all original inputs as prefix.
 * Suffix inputs (added by Host for settle commands) are allowed.
 */
export function verifyInputs(
  originalInputs: Record<string, unknown>[],
  returnedInputs: Record<string, unknown>[],
): void {
  if (returnedInputs.length < originalInputs.length) {
    throw new StelisIntegrityError(
      `returned input count (${returnedInputs.length}) < original (${originalInputs.length})`,
    );
  }

  for (let i = 0; i < originalInputs.length; i++) {
    const origNorm = normalizeInput(originalInputs[i]);
    const retNorm = normalizeInput(returnedInputs[i]);
    if (origNorm !== retNorm) {
      throw new StelisIntegrityError(
        `input ${i} modified: original=${origNorm}, returned=${retNorm}`,
      );
    }
  }
}

// ─────────────────────────────────────────────
// Prefix verification
// ─────────────────────────────────────────────

function formatVerdictValue(v: unknown): string {
  if (v instanceof Uint8Array) {
    const hex = Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('');
    return `Uint8Array(len=${v.length}, hex=${hex})`;
  }
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function verifyPrefix(originalCmds: PtbCommand[], returnedCmds: PtbCommand[]): void {
  if (returnedCmds.length < originalCmds.length) {
    throw new StelisIntegrityError(
      `returned command count (${returnedCmds.length}) < original (${originalCmds.length})`,
    );
  }

  for (let i = 0; i < originalCmds.length; i++) {
    const verdict = integrityCompare(originalCmds[i], returnedCmds[i]);
    if (!verdict.ok) {
      const location = verdict.path ? ` at ${verdict.path}` : '';
      throw new StelisIntegrityError(
        `command ${i} modified${location}: expected=${formatVerdictValue(verdict.expected)}, actual=${formatVerdictValue(verdict.actual)}`,
      );
    }
  }
}

// ─────────────────────────────────────────────
// Promotion PTB integrity verification
// ─────────────────────────────────────────────

/**
 * Verify that server-returned promotion txBytes preserve user commands exactly.
 *
 * Promotion path (pure sponsor, no settle): server may only add gas metadata
 * (sender, gasOwner, gasBudget, gasPayment). User commands and inputs must not change.
 *
 * Unlike generic relay (verifyPtbIntegrity), this verifier:
 *   - Reuses verifyInputs() and verifyPrefix() from S-16
 *   - Forbids ANY suffix commands (no settle, no coin ops)
 *   - Does not require packageId (no settle function to verify)
 *
 * @throws StelisIntegrityError if verification fails
 */
export function verifyPromotionPtbIntegrity(
  originalKindBytes: Uint8Array,
  returnedTxBase64: string,
): void {
  const originalTx = Transaction.fromKind(originalKindBytes);
  const returnedTx = Transaction.from(fromBase64(returnedTxBase64));

  // Step 0: Inputs — returned must preserve all original input values
  const originalInputs = originalTx.getData().inputs as Record<string, unknown>[];
  const returnedInputs = returnedTx.getData().inputs as Record<string, unknown>[];
  verifyInputs(originalInputs, returnedInputs);

  const originalCmds = convertSdkCommands(originalTx.getData().commands as unknown[]);
  const returnedCmds = convertSdkCommands(returnedTx.getData().commands as unknown[]);

  // Step 1: Prefix — returned must contain all original commands
  verifyPrefix(originalCmds, returnedCmds);

  // Step 2: No suffix allowed -- promotion server must not append any commands
  if (returnedCmds.length !== originalCmds.length) {
    throw new StelisIntegrityError(
      `promotion txBytes has ${returnedCmds.length - originalCmds.length} extra commands ` +
        `after user prefix (expected 0)`,
    );
  }
}

// ─────────────────────────────────────────────
// Suffix verification
// ─────────────────────────────────────────────

export function verifySuffix(suffix: PtbCommand[], packageId: string): void {
  const normalizedPkg = normalizeSuiAddress(packageId);
  let settleCount = 0;

  for (const cmd of suffix) {
    // S-15 parity: GasCoin reference forbidden in ALL commands
    if (cmd.arguments && containsGasCoinReference(cmd.arguments)) {
      throw new StelisIntegrityError(
        `suffix ${cmd.kind} references GasCoin — rejected to protect sponsor funds`,
      );
    }

    // Kind allowlist
    if (cmd.kind === 'MergeCoins' || cmd.kind === 'SplitCoins') continue;

    if (isMoveCall(cmd)) {
      const mcPkg = normalizeSuiAddress(cmd.packageId);

      // SUI stdlib coin::redeem_funds (address-balance / mixed-topup materialization).
      // `coin::zero` is intentionally NOT in the allowlist: under the
      // zero_deep_fee_only ABI no Host suffix path emits `coin::zero<DEEP>`,
      // because the Move swap entrypoint creates the zero coin internally.
      // The integrity gate therefore rejects any externally-supplied
      // `coin::zero` MoveCall to keep the allowlist minimal.
      if (
        mcPkg === SUI_FRAMEWORK_ADDRESS &&
        cmd.module === 'coin' &&
        cmd.function === 'redeem_funds'
      ) {
        continue;
      }

      // Stelis settle functions
      if (
        mcPkg === normalizedPkg &&
        cmd.module === SETTLE_MODULE &&
        SETTLE_FUNCTIONS.has(cmd.function)
      ) {
        settleCount++;
        continue;
      }

      throw new StelisIntegrityError(
        `forbidden MoveCall: ${cmd.packageId}::${cmd.module}::${cmd.function}`,
      );
    }

    throw new StelisIntegrityError(`forbidden suffix kind: ${cmd.kind}`);
  }

  // Structural invariants (mirrors L1 static.ts:86,122,125)
  if (settleCount !== 1) {
    throw new StelisIntegrityError(
      `expected exactly 1 settle call in suffix, found ${settleCount}`,
    );
  }

  if (suffix.length > 0) {
    const last = suffix[suffix.length - 1];
    if (!isMoveCall(last) || !SETTLE_FUNCTIONS.has(last.function)) {
      throw new StelisIntegrityError('settle must be last command in suffix');
    }
  }
}
