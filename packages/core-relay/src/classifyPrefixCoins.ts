/**
 * R-9: User TX prefix coin classification and address-balance accounting.
 *
 * Pure helpers for analyzing user prefix structure before suffix assembly.
 * Shared helpers for R-9 coin provenance tracking
 * and FundsWithdrawal address-balance accounting.
 *
 * Used by:
 *   - core-api/prepare/build.ts (suffix coin selection, source resolution)
 *   - core-api/tests (classifyUserTxCoins.test.ts, resolvePaymentSource.test.ts)
 *
 * No I/O: reads only tx.getData() inputs and commands.
 */
import type { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag } from '@mysten/sui/utils';
import { extractObjectIdFromInput } from './ptbInputUtils.js';

const DECIMAL_U64_RE = /^(?:0|[1-9]\d*)$/;

// ─────────────────────────────────────────────
// classifyUserTxCoins
// ─────────────────────────────────────────────

/**
 * R-9: Classify coins referenced by user TX prefix into survivors, consumed,
 * opaqueInUse, mutated, and additive reusable split-source candidates.
 *
 * Direct Input resolution:
 *   MergeCoins(target, [sources]):
 *     target → survivor (still alive after merge, can be reused in suffix)
 *     sources → consumed (deleted after merge, must not be referenced again)
 *   TransferObjects(objects, recipient):
 *     objects → consumed (ownership transferred)
 *   MoveCall(arguments):
 *     arguments → opaqueInUse (cannot know if callee consumes/mutates)
 *
 * Result/NestedResult provenance tracking:
 *   SplitCoins(source, [amounts]):
 *     source → mutated (balance reduced but object still exists)
 *     Result outputs → provenance points to source Input objectIds
 *   MakeMoveVec([elements]):
 *     Result → provenance is the union of all element Input objectIds (1:N)
 *   When a subsequent command references a Result/NestedResult, the provenance
 *   set is resolved and added to the appropriate classification set.
 *
 * Fail-closed principle:
 *   - Only direct (1-level) provenance is tracked.
 *   - If a Result references another Result (recursive chain), the entire
 *     provenance chain is fail-closed into opaqueInUse via the source command's
 *     own provenance. No optimistic reuse.
 *   - Move ABI inference is not performed — value-flow only.
 *
 * Precedence: consumed > opaqueInUse > survivor > mutated (strongest wins).
 * opaqueInUse beats survivor because a coin passed to arbitrary MoveCall (ABI
 * unknown) may be consumed/mutated by the callee, making it unsafe for suffix
 * reuse even if it was a merge destination.
 *
 * Additive provenance:
 *   - `mutated` is the broad SplitCoins-source set.
 *   - `reusableSplitSources` is a narrower additive subset of direct-input
 *     SplitCoins sources that survive precedence pruning and remain candidates
 *     for the current payment-token safe-reuse policy.
 */
export function classifyUserTxCoins(tx: Transaction): {
  survivors: Set<string>;
  consumed: Set<string>;
  opaqueInUse: Set<string>;
  /** All SplitCoins source coins after precedence pruning. */
  mutated: Set<string>;
  /**
   * Additive subset of direct-input SplitCoins sources that remain structurally
   * eligible for the narrow payment-token safe-reuse policy after precedence
   * pruning. Conservative callers may still exclude the broader `mutated` set.
   */
  reusableSplitSources: Set<string>;
  /** Maps merge destination objectId → Set of direct-Input source objectIds.
   *  Only populated when the merge destination is a direct Input reference.
   *  Used by resolvePaymentSource to compute merge credit: credit is only
   *  applied for sources whose destination ends up as a survivor (usable coin). */
  mergeDestToSources: Map<string, Set<string>>;
} {
  const survivors = new Set<string>();
  const consumed = new Set<string>();
  const opaqueInUse = new Set<string>();
  const mutated = new Set<string>();
  const reusableSplitSources = new Set<string>();
  const mergeDestToSources = new Map<string, Set<string>>();
  const data = tx.getData();
  const inputs = data.inputs as Record<string, unknown>[];
  const commands = data.commands as Record<string, unknown>[];

  // Provenance map: commandIndex → Set<objectId> of source Input objects.
  // Populated by SplitCoins and MakeMoveVec; consumed by subsequent commands
  // that reference Result/NestedResult.
  const provenance = new Map<number, Set<string>>();

  /**
   * Resolve a command argument to its source objectId set.
   * - Input → direct objectId lookup (singleton set or empty)
   * - Result → provenance map lookup
   * - NestedResult → provenance map lookup (same command, specific index)
   * - GasCoin/Pure → empty (not tracked)
   */
  function resolveArgObjectIds(arg: Record<string, unknown>): Set<string> {
    const kind = arg.$kind as string;
    if (kind === 'Input') {
      const idx = arg.Input as number;
      if (idx == null || idx >= inputs.length) return new Set();
      const objId = extractObjectIdFromInput(inputs[idx]);
      return objId ? new Set([objId]) : new Set();
    }
    if (kind === 'Result') {
      const cmdIdx = arg.Result as number;
      return provenance.get(cmdIdx) ?? new Set();
    }
    if (kind === 'NestedResult') {
      const pair = arg.NestedResult as [number, number];
      const cmdIdx = pair[0];
      return provenance.get(cmdIdx) ?? new Set();
    }
    return new Set();
  }

  /** Resolve a single arg to a direct Input objectId (used for survivor/consumed classification). */
  function resolveDirectInputId(arg: Record<string, unknown>): string | null {
    if (arg.$kind !== 'Input') return null;
    const idx = arg.Input as number;
    if (idx == null || idx >= inputs.length) return null;
    return extractObjectIdFromInput(inputs[idx]);
  }

  for (let cmdIdx = 0; cmdIdx < commands.length; cmdIdx++) {
    const cmd = commands[cmdIdx];
    const kind = cmd.$kind as string;

    // ── SplitCoins ──────────────────────────────────────────────────
    // Source coin's balance is reduced → mutated.
    // Each Result output has provenance pointing to the source coin.
    if (kind === 'SplitCoins') {
      const split = cmd.SplitCoins as {
        coin: Record<string, unknown>;
        amounts: Record<string, unknown>[];
      };
      const sourceIds = resolveArgObjectIds(split.coin);
      for (const id of sourceIds) mutated.add(id);
      const directSourceId = resolveDirectInputId(split.coin);
      if (directSourceId) reusableSplitSources.add(directSourceId);
      // Provenance: all split outputs trace back to the source coin(s)
      if (sourceIds.size > 0) {
        provenance.set(cmdIdx, new Set(sourceIds));
      }
    }

    // ── MakeMoveVec ─────────────────────────────────────────────────
    // Result is a vector containing all elements.
    // Provenance = union of all element source objectIds (1:N fan-in).
    if (kind === 'MakeMoveVec') {
      const mkv = cmd.MakeMoveVec as {
        elements: Record<string, unknown>[];
      };
      const unionIds = new Set<string>();
      for (const elem of mkv.elements) {
        for (const id of resolveArgObjectIds(elem)) unionIds.add(id);
      }
      if (unionIds.size > 0) {
        provenance.set(cmdIdx, unionIds);
      }
    }

    // ── MergeCoins ──────────────────────────────────────────────────
    if (kind === 'MergeCoins') {
      const merge = cmd.MergeCoins as {
        destination: Record<string, unknown>;
        sources: Record<string, unknown>[];
      };
      // target = survivor ONLY when it is a direct Input reference.
      // A Result-backed destination (e.g. SplitCoins output used as merge
      // target) is NOT a survivor — it is a transient object whose source
      // was already classified (e.g. mutated). Adding provenance-derived
      // IDs to survivors would let a SplitCoins source escape exclusion.
      const targetId = resolveDirectInputId(merge.destination);
      if (targetId) survivors.add(targetId);
      // sources = consumed (direct + provenance-derived)
      for (const src of merge.sources) {
        const directId = resolveDirectInputId(src);
        if (directId) consumed.add(directId);
        for (const id of resolveArgObjectIds(src)) consumed.add(id);
      }
      // Track merge destination → direct-Input sources mapping.
      // Only when destination is a direct Input (has a real objectId).
      // This allows resolvePaymentSource to credit merge-source balances
      // only to the specific destination that absorbed them.
      if (targetId) {
        const directSources = new Set<string>();
        for (const src of merge.sources) {
          const directId = resolveDirectInputId(src);
          if (directId) directSources.add(directId);
        }
        if (directSources.size > 0) {
          const existing = mergeDestToSources.get(targetId);
          if (existing) {
            for (const id of directSources) existing.add(id);
          } else {
            mergeDestToSources.set(targetId, directSources);
          }
        }
      }
      // MergeCoins result provenance: inherits from destination.
      // For direct Input destination: the objectId itself.
      // For Result-backed destination: the provenance of that Result.
      // This allows downstream commands referencing this MergeCoins result
      // to trace back to the original coin.
      const destProv = resolveArgObjectIds(merge.destination);
      if (destProv.size > 0) {
        provenance.set(cmdIdx, new Set(destProv));
      }
    }

    // ── TransferObjects ─────────────────────────────────────────────
    if (kind === 'TransferObjects') {
      const transfer = cmd.TransferObjects as {
        objects: Record<string, unknown>[];
      };
      for (const obj of transfer.objects) {
        const directId = resolveDirectInputId(obj);
        if (directId) consumed.add(directId);

        // Result-backed objects: provenance propagation depends on source command.
        // - SplitCoins result: an independent NEW object. Transferring it does NOT
        //   consume the split source coin. Source stays mutated (balance reduced).
        // - MergeCoins result: IS the destination coin itself. Transferring it
        //   means the destination is sent away → provenance sources consumed.
        // - MakeMoveVec result: contains the element objects. Transferring the
        //   vector transfers the elements → provenance sources consumed.
        // - MoveCall result / unknown: fail-closed → provenance sources consumed.
        const srcCmdIdx =
          obj.$kind === 'Result'
            ? (obj.Result as number)
            : obj.$kind === 'NestedResult'
              ? (obj.NestedResult as [number, number])[0]
              : null;
        const srcCmdKind =
          srcCmdIdx != null ? (commands[srcCmdIdx]?.$kind as string | undefined) : null;

        if (srcCmdKind !== 'SplitCoins') {
          // Non-split provenance: source coins are consumed by this transfer.
          for (const id of resolveArgObjectIds(obj)) consumed.add(id);
        }
        // SplitCoins provenance: source coin stays mutated, not consumed.
        // The split output is a new independent object on-chain.
      }
    }

    // ── MoveCall ────────────────────────────────────────────────────
    if (kind === 'MoveCall') {
      const mc = cmd.MoveCall as { arguments?: Record<string, unknown>[] };
      if (mc.arguments) {
        for (const arg of mc.arguments) {
          const directId = resolveDirectInputId(arg);
          if (directId) opaqueInUse.add(directId);
          // Result-backed arguments: provenance sources are opaqueInUse
          for (const id of resolveArgObjectIds(arg)) opaqueInUse.add(id);
        }
      }
      // MoveCall results have no provenance we can track (ABI unknown).
      // Any subsequent reference to this Result will resolve to empty set,
      // which is safe (fail-closed: no objectIds excluded → no reuse allowed
      // because the Result itself is not an Input and won't match any coin).
    }
  }

  // Precedence: consumed > opaqueInUse > survivor > mutated
  // opaqueInUse beats survivor because a coin passed to an arbitrary MoveCall
  // (ABI unknown) may be consumed or mutated by the callee, making it unsafe
  // for suffix reuse even if it was a merge destination (survivor).
  for (const id of consumed) {
    survivors.delete(id);
    opaqueInUse.delete(id);
    mutated.delete(id);
    reusableSplitSources.delete(id);
  }
  for (const id of opaqueInUse) {
    survivors.delete(id);
    mutated.delete(id);
    reusableSplitSources.delete(id);
  }
  for (const id of survivors) {
    mutated.delete(id);
    reusableSplitSources.delete(id);
  }

  return {
    survivors,
    consumed,
    opaqueInUse,
    mutated,
    reusableSplitSources,
    mergeDestToSources,
  };
}

// ─────────────────────────────────────────────
// resolveWithdrawFrom — shared FundsWithdrawal.withdrawFrom helper
// ─────────────────────────────────────────────

/**
 * Resolve the semantic identity of a `FundsWithdrawal.withdrawFrom` field.
 *
 * The Sui SDK runtime can materialize `withdrawFrom` in two representations:
 *   - Key-based: `{ Sender: true }` or `{ Sponsor: true }` (BCS roundtrip via Transaction.fromKind)
 *   - `$kind`-based: `{ $kind: 'Sender' }` or `{ $kind: 'Sponsor' }` (SDK internal form)
 *
 * This helper defines how both forms are interpreted.
 * All server-side guards that inspect `withdrawFrom` must use this helper
 * to avoid representation-coupled drift.
 *
 * Returns 'Sender', 'Sponsor', or null for unrecognized shapes.
 * Not exported from the package — server-side only.
 */
function resolveWithdrawFrom(
  withdrawFrom: Record<string, unknown> | undefined,
): 'Sender' | 'Sponsor' | null {
  if (!withdrawFrom) return null;

  // $kind-based discrimination (SDK internal form)
  const kind = withdrawFrom.$kind;
  if (kind === 'Sender') return 'Sender';
  if (kind === 'Sponsor') return 'Sponsor';

  // Key-based discrimination (BCS roundtrip form)
  if (withdrawFrom.Sender) return 'Sender';
  if (withdrawFrom.Sponsor) return 'Sponsor';

  return null;
}

// ─────────────────────────────────────────────
// extractPrefixWithdrawals
// ─────────────────────────────────────────────

/**
 * Extract the total address-balance consumption from user prefix FundsWithdrawal
 * inputs that match the settlement token type.
 *
 * FundsWithdrawal inputs represent Sui address-balance withdrawals (`tx.withdrawal()`).
 * The classifier (`classifyUserTxCoins`) tracks object provenance only and does not
 * account for these. This function fills that gap so `resolvePaymentSource` can
 * subtract prefix AB consumption from the chain snapshot before making its decision.
 *
 * Returns `{ total, unaccountable }` where:
 * - `total`: sum of all safely parsed same-token Sender withdrawals.
 * - `unaccountable`: true if any Sender withdrawal was encountered but could not
 *   be safely parsed (malformed typeArg, malformed reservation, non-numeric amount).
 *   The caller must reject the request when `unaccountable === true`. Silent
 *   under-counting is not acceptable on this path.
 *
 * Current constraints:
 * - Only `withdrawFrom.Sender` is accounted. Sponsor variant is not a Sender
 *   withdrawal and never sets `unaccountable`.
 * - Token type comparison uses `normalizeStructTag` (canonical form).
 * - Parseable non-matching token types are silently ignored (safe).
 * - Any parse failure on a Sender entry sets `unaccountable = true`; the caller
 *   is responsible for rejecting with `UNACCOUNTABLE_WITHDRAWAL`.
 */
export function extractPrefixWithdrawals(
  tx: Transaction,
  settlementTokenType: string,
): { total: bigint; unaccountable: boolean } {
  const inputs = tx.getData().inputs as Record<string, unknown>[];
  const normalizedPaymentType = normalizeStructTag(settlementTokenType);
  let total = 0n;
  let unaccountable = false;

  for (const input of inputs) {
    if (input.$kind !== 'FundsWithdrawal') continue;

    const fw = input.FundsWithdrawal as Record<string, unknown> | undefined;
    if (!fw) continue;

    // Gate: Sender-only accounting (resolved by resolveWithdrawFrom).
    // Non-Sender variants (Sponsor, unknown) do not affect AB accounting.
    const withdrawFrom = fw.withdrawFrom as Record<string, unknown> | undefined;
    if (resolveWithdrawFrom(withdrawFrom) !== 'Sender') continue;

    // --- From here: Sender withdrawal that requires safe accounting ---

    // Parse token type. Failure means we cannot determine relevance → unaccountable.
    const typeArg = fw.typeArg as Record<string, unknown> | undefined;
    const balanceType = typeArg?.Balance as string | undefined;
    if (!balanceType) {
      unaccountable = true;
      continue;
    }

    let normalizedFwType: string;
    try {
      normalizedFwType = normalizeStructTag(balanceType);
    } catch {
      // Malformed type string → cannot determine relevance → unaccountable.
      unaccountable = true;
      continue;
    }

    // Parseable non-matching token type: safe to ignore.
    if (normalizedFwType !== normalizedPaymentType) continue;

    // Token type matches — amount must be parseable. Any failure → unaccountable.
    const reservation = fw.reservation as Record<string, unknown> | undefined;
    if (reservation?.$kind !== 'MaxAmountU64') {
      unaccountable = true;
      continue;
    }
    const amountStr = reservation.MaxAmountU64 as string | undefined;
    if (!amountStr) {
      unaccountable = true;
      continue;
    }

    if (!DECIMAL_U64_RE.test(amountStr)) {
      // Non-numeric amount string → unaccountable.
      unaccountable = true;
      continue;
    }

    total += BigInt(amountStr);
  }

  return { total, unaccountable };
}

// ─────────────────────────────────────────────
// containsSponsorWithdrawal
// ─────────────────────────────────────────────

/**
 * S-15 companion: detect FundsWithdrawal(Sponsor) inputs in user TX prefix.
 *
 * A FundsWithdrawal with `withdrawFrom.Sponsor` would cause the Sui runtime
 * to deduct from the gas payer's (sponsor's) address balance. In a sponsored
 * transaction, the sponsor is the relayer — allowing this input would let
 * a malicious user drain sponsor funds.
 *
 * This guard runs on raw inputs (not commands) and complements the existing
 * S-15 GasCoin rejection which protects sponsor gas-coin objects.
 *
 * Returns true if any FundsWithdrawal(Sponsor) input is found.
 */
export function containsSponsorWithdrawal(tx: Transaction): boolean {
  const inputs = tx.getData().inputs as Record<string, unknown>[];
  for (const input of inputs) {
    if (input.$kind !== 'FundsWithdrawal') continue;
    const fw = input.FundsWithdrawal as Record<string, unknown> | undefined;
    if (!fw) continue;
    const withdrawFrom = fw.withdrawFrom as Record<string, unknown> | undefined;
    if (resolveWithdrawFrom(withdrawFrom) === 'Sponsor') return true;
  }
  return false;
}
