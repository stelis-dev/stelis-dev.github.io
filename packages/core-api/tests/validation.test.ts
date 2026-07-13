/**
 * studio/validation.ts — unit tests for S1 / prepare-only sponsor-withdrawal
 * guard / S2 / S3 pure functions.
 *
 * S1 and S2 consume `PtbCommand[]` produced by `convertSdkCommands()` at the
 * prepare/sponsor boundary. Tests use either real SDK-built `Transaction`
 * objects plus `convertSdkCommands()`, or construct `PtbCommand` values
 * directly. No raw `{ $kind, MoveCall: { ... } }` synthetic fixtures are used.
 */
import { describe, it, expect, vi } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';

// Mock containsSponsorWithdrawal so we can drive the forbidden branch of the
// prepare-only companion guard without constructing a real
// FundsWithdrawal(Sponsor) input.
vi.mock('@stelis/core-relay', async () => {
  const actual = await vi.importActual<typeof import('@stelis/core-relay')>('@stelis/core-relay');
  return {
    ...actual,
    containsSponsorWithdrawal: vi.fn(() => false),
  };
});

import * as coreRelay from '@stelis/core-relay';
import type { PtbCommand, MoveCallCommand, OtherCommand } from '@stelis/contracts';
import {
  validatePromotionCommandCount,
  validatePromotionPtbStructure,
  validatePromotionSponsorWithdrawal,
  validatePromotionTargets,
  validatePromotionEligibility,
  checkPromotionTemporalGate,
} from '../src/studio/validation.js';
import { canonicalizePromotionTarget } from '../src/studio/promotionTargetPolicy.js';

const ALLOWED_TARGET =
  '0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin';
const DISALLOWED_TARGET =
  '0x0000000000000000000000000000000000000000000000000000000000000002::evil::drain';
const ALLOWED_TARGETS = new Set([canonicalizePromotionTarget(ALLOWED_TARGET)]);

// ─────────────────────────────────────────────
// PtbCommand helpers (flat normalized shape, not raw SDK shape)
// ─────────────────────────────────────────────

function moveCallCmd(target: string, args: unknown[] = []): MoveCallCommand {
  const [packageId, module, fn] = target.split('::');
  return {
    kind: 'MoveCall',
    packageId,
    module,
    function: fn,
    typeArguments: [],
    arguments: args,
  };
}

function otherCmd(kind: string, args: unknown[] = []): OtherCommand {
  return { kind, arguments: args };
}

/** Build a real SDK Transaction (kind-only) and normalize its commands. */
async function realMoveCallCommands(build: (tx: Transaction) => void): Promise<PtbCommand[]> {
  const tx = new Transaction();
  build(tx);
  const kindBytes = await tx.build({ onlyTransactionKind: true });
  const parsed = Transaction.fromKind(kindBytes);
  return coreRelay.convertSdkCommands(parsed.getData().commands as unknown[]);
}

// ─────────────────────────────────────────────
// Normalization invariant snapshot
// ─────────────────────────────────────────────

describe('convertSdkCommands normalization (S-15 reach)', () => {
  it('preserves a MoveCall `tx.gas` argument so containsGasCoinReference can reach $kind === GasCoin', async () => {
    const commands = await realMoveCallCommands((tx) => {
      tx.moveCall({
        target: ALLOWED_TARGET as `${string}::${string}::${string}`,
        arguments: [tx.gas],
      });
    });

    expect(commands).toHaveLength(1);
    const first = commands[0]!;
    expect(first.kind).toBe('MoveCall');
    expect(coreRelay.containsGasCoinReference(first.arguments ?? [])).toBe(true);
  });
});

// ─────────────────────────────────────────────
// S1 — PTB structure
// ─────────────────────────────────────────────

describe('validatePromotionPtbStructure (S1)', () => {
  it('rejects non-MoveCall command kinds', () => {
    const result = validatePromotionPtbStructure([otherCmd('SplitCoins')]);
    expect(result).toEqual({ code: 'FORBIDDEN_COMMAND', kind: 'SplitCoins' });
  });

  it('rejects GasCoin references in MoveCall arguments (PtbCommand shape)', () => {
    const result = validatePromotionPtbStructure([
      moveCallCmd(ALLOWED_TARGET, [{ $kind: 'GasCoin' }]),
    ]);
    expect(result).toEqual({ code: 'GASCOIN_FORBIDDEN' });
  });

  it('rejects real SDK MoveCall(... tx.gas ...) after normalization', async () => {
    const commands = await realMoveCallCommands((tx) => {
      tx.moveCall({
        target: ALLOWED_TARGET as `${string}::${string}::${string}`,
        arguments: [tx.gas],
      });
    });
    expect(validatePromotionPtbStructure(commands)).toEqual({ code: 'GASCOIN_FORBIDDEN' });
  });

  it('accepts MoveCall with Input/Result arguments', () => {
    const result = validatePromotionPtbStructure([
      moveCallCmd(ALLOWED_TARGET, [{ $kind: 'Input', Input: 0 }]),
    ]);
    expect(result).toBeNull();
  });

  it('preserves iteration-order precedence: non-MoveCall before MoveCall tx.gas returns FORBIDDEN_COMMAND', () => {
    const result = validatePromotionPtbStructure([
      otherCmd('SplitCoins'),
      moveCallCmd(ALLOWED_TARGET, [{ $kind: 'GasCoin' }]),
    ]);
    expect(result).toEqual({ code: 'FORBIDDEN_COMMAND', kind: 'SplitCoins' });
  });
});

describe('validatePromotionCommandCount', () => {
  it.each([1, 16])('accepts %i command(s)', (commandCount) => {
    const commands = Array.from({ length: commandCount }, () => moveCallCmd(ALLOWED_TARGET));
    expect(validatePromotionCommandCount(commands)).toBeNull();
  });

  it.each([0, 17])('rejects a Promotion command count of %i', (commandCount) => {
    const commands = Array.from({ length: commandCount }, () => moveCallCmd(ALLOWED_TARGET));
    expect(validatePromotionCommandCount(commands)).toEqual({
      code: 'INVALID_COMMAND_COUNT',
      commandCount,
    });
  });
});

// ─────────────────────────────────────────────
// Prepare-only sponsor-withdrawal guard (S-15 companion)
// ─────────────────────────────────────────────

describe('validatePromotionSponsorWithdrawal (prepare-only companion)', () => {
  it('returns null when fullTx has no FundsWithdrawal(Sponsor)', () => {
    vi.mocked(coreRelay.containsSponsorWithdrawal).mockReturnValueOnce(false);
    const tx = new Transaction();
    const result = validatePromotionSponsorWithdrawal(tx);
    expect(result).toBeNull();
    expect(coreRelay.containsSponsorWithdrawal).toHaveBeenCalledWith(tx);
  });

  it('returns SPONSOR_WITHDRAWAL_FORBIDDEN when fullTx contains FundsWithdrawal(Sponsor)', () => {
    vi.mocked(coreRelay.containsSponsorWithdrawal).mockReturnValueOnce(true);
    const tx = new Transaction();
    const result = validatePromotionSponsorWithdrawal(tx);
    expect(result).toEqual({ code: 'SPONSOR_WITHDRAWAL_FORBIDDEN' });
  });

  it('is isolated from S1: validatePromotionPtbStructure does not call containsSponsorWithdrawal', () => {
    vi.mocked(coreRelay.containsSponsorWithdrawal).mockClear();
    validatePromotionPtbStructure([moveCallCmd(ALLOWED_TARGET)]);
    expect(coreRelay.containsSponsorWithdrawal).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// S2 — allowed targets
// ─────────────────────────────────────────────

describe('validatePromotionTargets (S2)', () => {
  it('returns null when all MoveCall targets are allowed', () => {
    const result = validatePromotionTargets([moveCallCmd(ALLOWED_TARGET)], ALLOWED_TARGETS);
    expect(result).toBeNull();
  });

  it('collects disallowed targets', () => {
    const result = validatePromotionTargets(
      [moveCallCmd(ALLOWED_TARGET), moveCallCmd(DISALLOWED_TARGET)],
      ALLOWED_TARGETS,
    );
    expect(result).not.toBeNull();
    expect(result!.code).toBe('DISALLOWED_TARGET');
    expect(result!.disallowedTargets).toEqual([DISALLOWED_TARGET]);
  });

  it('skips non-MoveCall commands', () => {
    const result = validatePromotionTargets([otherCmd('SplitCoins')], ALLOWED_TARGETS);
    // Non-MoveCall is not a target failure — S1 catches it separately.
    expect(result).toBeNull();
  });

  it('rejects disallowed real SDK MoveCall target after normalization', async () => {
    const commands = await realMoveCallCommands((tx) => {
      tx.moveCall({ target: DISALLOWED_TARGET as `${string}::${string}::${string}` });
    });
    const result = validatePromotionTargets(commands, ALLOWED_TARGETS);
    expect(result).not.toBeNull();
    expect(result!.code).toBe('DISALLOWED_TARGET');
    expect(result!.disallowedTargets).toEqual([DISALLOWED_TARGET]);
  });
});

// ─────────────────────────────────────────────
// S3 — eligibility
// ─────────────────────────────────────────────

describe('validatePromotionEligibility (S3)', () => {
  const now = new Date('2026-06-15T00:00:00Z');

  it('returns null when promotion active + entitlement present + use-window ok', () => {
    const result = validatePromotionEligibility(
      { status: 'active', startAt: null },
      { useUntilAt: null },
      now,
    );
    expect(result).toBeNull();
  });

  it('returns PROMOTION_NOT_FOUND when promotion is null', () => {
    const result = validatePromotionEligibility(null, { useUntilAt: null }, now);
    expect(result).toEqual({ code: 'PROMOTION_NOT_FOUND' });
  });

  it('returns PROMOTION_NOT_ACTIVE when promotion status != active', () => {
    const result = validatePromotionEligibility(
      { status: 'paused', startAt: null },
      { useUntilAt: null },
      now,
    );
    expect(result).toEqual({ code: 'PROMOTION_NOT_ACTIVE' });
  });

  it('returns PROMOTION_NOT_STARTED when startAt is in the future', () => {
    const future = '2027-01-01T00:00:00Z';
    const result = validatePromotionEligibility(
      { status: 'active', startAt: future },
      { useUntilAt: null },
      now,
    );
    expect(result).toEqual({ code: 'PROMOTION_NOT_STARTED', startAt: future });
  });

  it('returns null when startAt is in the past', () => {
    const past = '2026-01-01T00:00:00Z';
    const result = validatePromotionEligibility(
      { status: 'active', startAt: past },
      { useUntilAt: null },
      now,
    );
    expect(result).toBeNull();
  });

  it('returns NOT_CLAIMED when entitlement is null', () => {
    const result = validatePromotionEligibility({ status: 'active', startAt: null }, null, now);
    expect(result).toEqual({ code: 'NOT_CLAIMED' });
  });

  it('returns USE_WINDOW_EXPIRED when useUntilAt has passed', () => {
    const past = '2026-01-01T00:00:00Z';
    const result = validatePromotionEligibility(
      { status: 'active', startAt: null },
      { useUntilAt: past },
      now,
    );
    expect(result).toEqual({ code: 'USE_WINDOW_EXPIRED', useUntilAt: past });
  });

  it('returns null when useUntilAt is in the future', () => {
    const future = '2027-01-01T00:00:00Z';
    const result = validatePromotionEligibility(
      { status: 'active', startAt: null },
      { useUntilAt: future },
      now,
    );
    expect(result).toBeNull();
  });

  it('returns USE_WINDOW_EXPIRED when useUntilAt === now (boundary)', () => {
    const atBoundary = now.toISOString();
    const result = validatePromotionEligibility(
      { status: 'active', startAt: null },
      { useUntilAt: atBoundary },
      now,
    );
    expect(result).toEqual({ code: 'USE_WINDOW_EXPIRED', useUntilAt: atBoundary });
  });
});

// ─────────────────────────────────────────────
// Shared temporal gate (checkPromotionTemporalGate)
// ─────────────────────────────────────────────

describe('checkPromotionTemporalGate', () => {
  const now = new Date('2026-06-15T00:00:00Z');

  it('returns null when active and startAt null', () => {
    expect(checkPromotionTemporalGate({ status: 'active', startAt: null }, now)).toBeNull();
  });

  it('returns null when active and startAt in the past', () => {
    expect(
      checkPromotionTemporalGate({ status: 'active', startAt: '2026-01-01T00:00:00Z' }, now),
    ).toBeNull();
  });

  it('returns PROMOTION_NOT_FOUND when promotion is null', () => {
    expect(checkPromotionTemporalGate(null, now)).toEqual({ code: 'PROMOTION_NOT_FOUND' });
  });

  it('returns PROMOTION_NOT_ACTIVE for paused/archived status', () => {
    expect(checkPromotionTemporalGate({ status: 'paused', startAt: null }, now)).toEqual({
      code: 'PROMOTION_NOT_ACTIVE',
    });
    expect(checkPromotionTemporalGate({ status: 'archived', startAt: null }, now)).toEqual({
      code: 'PROMOTION_NOT_ACTIVE',
    });
  });

  it('returns PROMOTION_NOT_STARTED when startAt is in the future', () => {
    const future = '2027-01-01T00:00:00Z';
    expect(checkPromotionTemporalGate({ status: 'active', startAt: future }, now)).toEqual({
      code: 'PROMOTION_NOT_STARTED',
      startAt: future,
    });
  });

  it('returns null when startAt equals now (boundary — gate opens at startAt)', () => {
    const atBoundary = now.toISOString();
    expect(checkPromotionTemporalGate({ status: 'active', startAt: atBoundary }, now)).toBeNull();
  });
});
