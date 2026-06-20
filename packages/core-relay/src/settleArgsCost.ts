/**
 * settleArgsCost — lightweight settle cost extractor for SDK cost cross-validation.
 *
 * Extracts executionCostClaimMist, quotedHostFeeMist and expectedProtocolFeeMist
 * from a built Transaction's settle MoveCall, without throwing.
 * Returns null on any failure.
 *
 * This is a best-effort defense-in-depth check (S-16 companion).
 * It is NOT a substitute for server L2 validation or on-chain enforcement.
 *
 * Design: null-returning (never throws) so SDK can treat parse errors as skip.
 * The PrepareValidationError-throwing full extractor remains in core-api.
 */
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { SETTLE_MODULE, SETTLE_FUNCTIONS } from '@stelis/contracts';
import { ARG_INDEX_MAP } from './parseSettleArgs.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface SettleArgsCost {
  executionCostClaimMist: bigint;
  quotedHostFeeMist: bigint;
  expectedProtocolFeeMist: bigint;
}

// ─────────────────────────────────────────────
// Minimal arg index map (fee fields only)
// ─────────────────────────────────────────────

/** claim, quotedHostFee and expectedProtocolFee arg indices, derived from ARG_INDEX_MAP.
 *  Keeps this extractor in sync with the full parser — no separate hardcoding. */
const COST_ARG_INDICES: Record<
  string,
  { claim: number; quotedHostFee: number; expectedProtocolFee: number }
> = Object.fromEntries(
  Object.entries(ARG_INDEX_MAP).map(([fn, m]) => [
    fn,
    {
      claim: m.claim,
      quotedHostFee: m.quotedHostFee,
      expectedProtocolFee: m.expectedProtocolFee,
    },
  ]),
);

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Decode BCS u64 (8-byte little-endian) from a Pure input's base64 bytes. Returns null on error. */
function decodePureU64Safe(arg: unknown, inputs: unknown[]): bigint | null {
  try {
    if (typeof arg !== 'object' || arg === null) return null;
    const ref = arg as Record<string, unknown>;
    if (ref.$kind !== 'Input' || typeof ref.Input !== 'number') return null;
    const input = inputs[ref.Input] as Record<string, unknown> | undefined;
    if (!input || input.$kind !== 'Pure') return null;
    const pure = input.Pure as Record<string, unknown> | undefined;
    if (!pure || typeof pure.bytes !== 'string') return null;
    const decoded = fromBase64(pure.bytes);
    if (decoded.length < 8) return null;
    // BCS u64: 8-byte little-endian
    let value = 0n;
    for (let i = 7; i >= 0; i--) {
      value = (value << 8n) | BigInt(decoded[i]!);
    }
    return value;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Core parsing logic: extract fees from already-parsed transaction data.
 * Exported for direct testing (no BCS build step required).
 *
 * @param commands - from tx.getData().commands
 * @param inputs   - from tx.getData().inputs
 * @param packageId - Stelis package ID (for settle function matching)
 * @returns SettleArgsCost or null if not found / parse failure
 */
export function extractCostFromTxData(
  commands: unknown[],
  inputs: unknown[],
  packageId: string,
): SettleArgsCost | null {
  try {
    const normalizedPkg = normalizeSuiAddress(packageId);

    for (const cmd of commands) {
      if (typeof cmd !== 'object' || cmd === null) continue;
      const c = cmd as Record<string, unknown>;
      if (c.$kind !== 'MoveCall' && c.kind !== 'MoveCall') continue;

      // Handle both $kind-wrapped and flat MoveCall shapes
      const mc = (c.$kind === 'MoveCall' ? c.MoveCall : c) as Record<string, unknown>;
      const pkgId = mc?.package ?? mc?.packageId;
      const mod = mc?.module;
      const fn = mc?.function;
      if (typeof pkgId !== 'string' || typeof mod !== 'string' || typeof fn !== 'string') continue;

      if (
        normalizeSuiAddress(pkgId) !== normalizedPkg ||
        mod !== SETTLE_MODULE ||
        !SETTLE_FUNCTIONS.has(fn)
      ) {
        continue;
      }

      const indices = COST_ARG_INDICES[fn];
      if (!indices) return null;

      const args = mc.arguments as unknown[] | undefined;
      if (!args) return null;

      const executionCostClaimMist = decodePureU64Safe(args[indices.claim], inputs);
      const quotedHostFeeMist = decodePureU64Safe(args[indices.quotedHostFee], inputs);
      const expectedProtocolFeeMist = decodePureU64Safe(args[indices.expectedProtocolFee], inputs);

      if (
        executionCostClaimMist === null ||
        quotedHostFeeMist === null ||
        expectedProtocolFeeMist === null
      )
        return null;

      return { executionCostClaimMist, quotedHostFeeMist, expectedProtocolFeeMist };
    }

    // No settle command found
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract executionCostClaimMist, quotedHostFeeMist and expectedProtocolFeeMist from txBytes.
 * Null-returning (best-effort): returns null on any parse/BCS failure.
 *
 * @param txBytesBase64 - base64 of the built transaction returned by /prepare
 * @param packageId     - Stelis package ID (for settle function matching)
 * @returns SettleArgsCost or null on any parse failure
 */
export function extractCostFromTxBytes(
  txBytesBase64: string,
  packageId: string,
): SettleArgsCost | null {
  try {
    // Try full transaction first (Host-returned txBytes), then kind-only bytes
    let tx: Transaction;
    try {
      tx = Transaction.from(fromBase64(txBytesBase64));
    } catch {
      tx = Transaction.fromKind(fromBase64(txBytesBase64));
    }
    const { commands, inputs } = tx.getData() as {
      commands: unknown[];
      inputs: unknown[];
    };
    return extractCostFromTxData(commands, inputs, packageId);
  } catch {
    return null;
  }
}
