/**
 * Studio Promotion Validation Pipeline — pure validation, no side effects.
 *
 * Three layers (S1 / S2 / S3), each a pure function returning `null` on success
 * or a discriminated-union failure object. Callers (prepare/sponsor route paths)
 * map the failure to their own error types and decide whether to record abuse
 * (side-effect — owned by promotionAbusePolicy.ts, never by this module).
 *
 * Layers:
 *   S1 — PTB structure (MoveCall-only + GasCoin forbidden)
 *   S2 — STUDIO_ALLOWED_TARGETS hash match
 *   S3 — promotion active + entitlement claimed + use-window active
 *
 * The normal 1..MAX_FINAL_COMMANDS admission range is checked only after S1/S2
 * by callers so padding cannot hide a manipulation-policy violation.
 *
 * Prepare-only companion guard (distinct from S1): sponsor-withdrawal forbidden.
 * Sponsor preconsume relies on the stored-hash-verified contract for this check and
 * therefore does not call the sponsor-withdrawal guard directly.
 *
 * S1 and S2 consume `PtbCommand[]` produced by `convertSdkCommands()` at the
 * prepare/sponsor boundary. This module does not touch raw Sui SDK command
 * shape; callers are responsible for normalization before invocation.
 *
 * Boot-time target hashing stays in `promotionTargetPolicy.ts` (separate concern).
 *
 * @module studio/validation
 */

import type { Transaction } from '@mysten/sui/transactions';
import {
  containsGasCoinReference,
  containsSponsorWithdrawal,
  isMoveCall,
  MAX_FINAL_COMMANDS,
} from '@stelis/core-relay';
import type { PtbCommand } from '@stelis/contracts';
import { hashTarget } from './promotionTargetPolicy.js';
import type { Promotion, Entitlement } from './domain.js';

// ─────────────────────────────────────────────
// S1 — PTB structure
// ─────────────────────────────────────────────

export type PtbStructureFailure =
  | { code: 'FORBIDDEN_COMMAND'; kind: string }
  | { code: 'GASCOIN_FORBIDDEN' };

export type PromotionCommandCountFailure = {
  code: 'INVALID_COMMAND_COUNT';
  commandCount: number;
};

/**
 * S1 — validate PTB command structure for promotion flows.
 *
 * - Rejects any non-MoveCall command.
 * - Rejects any MoveCall arg referencing GasCoin (S-15).
 *
 * Prepare-only `FundsWithdrawal(Sponsor)` check is a separate guard (see
 * `validatePromotionSponsorWithdrawal` below). Sponsor preconsume relies on
 * the stored-hash-verified contract for that check and must not invoke it.
 *
 * @returns null on success, failure discriminated union on violation.
 */
export function validatePromotionPtbStructure(
  commands: readonly PtbCommand[],
): PtbStructureFailure | null {
  for (const cmd of commands) {
    if (!isMoveCall(cmd)) {
      return { code: 'FORBIDDEN_COMMAND', kind: cmd.kind };
    }
    if (containsGasCoinReference(cmd.arguments)) {
      return { code: 'GASCOIN_FORBIDDEN' };
    }
  }
  return null;
}

/**
 * Normal Promotion command-count admission. Callers run this after the
 * manipulation-policy structure and target checks.
 */
export function validatePromotionCommandCount(
  commands: readonly PtbCommand[],
): PromotionCommandCountFailure | null {
  return commands.length === 0 || commands.length > MAX_FINAL_COMMANDS
    ? { code: 'INVALID_COMMAND_COUNT', commandCount: commands.length }
    : null;
}

// ─────────────────────────────────────────────
// Prepare-only sponsor-withdrawal guard (S-15 companion)
// ─────────────────────────────────────────────

export type SponsorWithdrawalFailure = { code: 'SPONSOR_WITHDRAWAL_FORBIDDEN' };

/**
 * Prepare-only companion guard: reject `FundsWithdrawal(Sponsor)` inputs.
 *
 * Sponsor preconsume does not call this helper because the stored-hash-verified
 * consume() contract already proves the submitted bytes match the prepare
 * commit, so any sponsor-withdrawal at sponsor time would be server-side
 * drift rather than user abuse (handled by the sponsor drift path).
 */
export function validatePromotionSponsorWithdrawal(
  fullTx: Transaction,
): SponsorWithdrawalFailure | null {
  return containsSponsorWithdrawal(fullTx) ? { code: 'SPONSOR_WITHDRAWAL_FORBIDDEN' } : null;
}

// ─────────────────────────────────────────────
// S2 — allowed-target policy
// ─────────────────────────────────────────────

export interface TargetPolicyFailure {
  code: 'DISALLOWED_TARGET';
  disallowedTargets: string[];
}

/**
 * S2 — validate that all MoveCall targets hash-match the global allowlist.
 *
 * R-10 enforcement. Canonical hashing delegated to `hashTarget()`
 * (promotionTargetPolicy.ts — shared canonicalize + sha256 helper).
 */
export function validatePromotionTargets(
  commands: readonly PtbCommand[],
  allowedHashes: Set<string>,
): TargetPolicyFailure | null {
  const disallowed: string[] = [];

  for (const cmd of commands) {
    if (!isMoveCall(cmd)) continue;
    const rawTarget = `${cmd.packageId}::${cmd.module}::${cmd.function}`;
    if (!allowedHashes.has(hashTarget(rawTarget))) {
      disallowed.push(rawTarget);
    }
  }

  return disallowed.length === 0
    ? null
    : { code: 'DISALLOWED_TARGET', disallowedTargets: disallowed };
}

// ─────────────────────────────────────────────
// Shared temporal gate (promotion existence + status + startAt window)
// ─────────────────────────────────────────────

export type TemporalGateFailure =
  | { code: 'PROMOTION_NOT_FOUND' }
  | { code: 'PROMOTION_NOT_ACTIVE' }
  | { code: 'PROMOTION_NOT_STARTED'; startAt: string };

/**
 * Shared temporal gate for Studio promotion access.
 *
 * Shared helper for "does this promotion exist, is it active, and is its
 * `startAt` window open?" — reused by `handlePromotionClaim`,
 * `validatePromotionEligibility`, and the derived read models so the
 * three callers cannot drift on how `startAt` is interpreted.
 *
 * @param promotion - Loaded from catalog, or null if not found.
 * @param now - Current time (injectable for testing).
 */
export function checkPromotionTemporalGate(
  promotion: Pick<Promotion, 'status' | 'startAt'> | null,
  now: Date = new Date(),
): TemporalGateFailure | null {
  if (!promotion) return { code: 'PROMOTION_NOT_FOUND' };
  if (promotion.status !== 'active') return { code: 'PROMOTION_NOT_ACTIVE' };
  if (promotion.startAt && new Date(promotion.startAt).getTime() > now.getTime()) {
    return { code: 'PROMOTION_NOT_STARTED', startAt: promotion.startAt };
  }
  return null;
}

// ─────────────────────────────────────────────
// S3 — eligibility (temporal gate + entitlement + use-window)
// ─────────────────────────────────────────────

export type EligibilityFailure =
  | TemporalGateFailure
  | { code: 'NOT_CLAIMED' }
  | { code: 'USE_WINDOW_EXPIRED'; useUntilAt: string };

/**
 * S3 — validate the shared temporal gate + entitlement presence + use-window.
 *
 * Single fail-closed gate for the prepare/sponsor paths. Delegates the
 * promotion-level temporal check to `checkPromotionTemporalGate` so that
 * `startAt` semantics stay shared with claim and the read models.
 *
 * @param promotion - Loaded from catalog, or null if not found.
 * @param entitlement - Loaded from ExecutionLedger, or null if user has not claimed.
 * @param now - Current time (injectable for testing).
 */
export function validatePromotionEligibility(
  promotion: Pick<Promotion, 'status' | 'startAt'> | null,
  entitlement: Pick<Entitlement, 'useUntilAt'> | null,
  now: Date = new Date(),
): EligibilityFailure | null {
  const temporal = checkPromotionTemporalGate(promotion, now);
  if (temporal) return temporal;
  if (!entitlement) return { code: 'NOT_CLAIMED' };

  if (entitlement.useUntilAt && new Date(entitlement.useUntilAt).getTime() <= now.getTime()) {
    return { code: 'USE_WINDOW_EXPIRED', useUntilAt: entitlement.useUntilAt };
  }

  return null;
}
