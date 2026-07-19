/** Current Promotion-ledger numeric authority shared by every adapter and transport path. */

import { MAX_PROMOTION_LEDGER_VALUE_MIST } from '@stelis/contracts';

const DECIMAL_MIST_RE = /^(?:0|[1-9]\d*)$/;

/** A Promotion budget cannot be represented safely by the current execution ledger. */
export class PromotionLedgerValueError extends Error {
  constructor(reason: string) {
    super(`Invalid Promotion ledger value: ${reason}`);
    this.name = 'PromotionLedgerValueError';
  }
}

/** Parse a canonical non-negative decimal integer without numeric coercion. */
export function parseNonNegativeDecimalBigInt(value: string, label: string): bigint {
  if (!DECIMAL_MIST_RE.test(value)) {
    throw new Error(`${label} must be a non-negative decimal integer string`);
  }
  return BigInt(value);
}

/** Current Promotion-budget authority for stores, projections, and ledger adapters. */
export function parsePromotionLedgerBudget(
  maxParticipants: number,
  perUserGasAllowanceMist: string,
): { perUserGasAllowanceMist: bigint; totalBudgetMist: bigint } {
  if (!Number.isSafeInteger(maxParticipants) || maxParticipants <= 0) {
    throw new PromotionLedgerValueError('maxParticipants must be a positive safe integer');
  }
  let perUser: bigint;
  try {
    perUser = parseNonNegativeDecimalBigInt(perUserGasAllowanceMist, 'perUserGasAllowanceMist');
  } catch (error) {
    throw new PromotionLedgerValueError(
      error instanceof Error ? error.message : 'perUserGasAllowanceMist is invalid',
    );
  }
  if (perUser <= 0n) {
    throw new PromotionLedgerValueError('perUserGasAllowanceMist must be greater than zero');
  }
  if (perUser > MAX_PROMOTION_LEDGER_VALUE_MIST) {
    throw new PromotionLedgerValueError(
      `perUserGasAllowanceMist (${perUser.toString()}) exceeds MAX_PROMOTION_LEDGER_VALUE_MIST (${MAX_PROMOTION_LEDGER_VALUE_MIST.toString()})`,
    );
  }
  const totalBudgetMist = BigInt(maxParticipants) * perUser;
  if (totalBudgetMist > MAX_PROMOTION_LEDGER_VALUE_MIST) {
    throw new PromotionLedgerValueError(
      `total budget (maxParticipants × perUserGasAllowanceMist = ${totalBudgetMist.toString()}) exceeds MAX_PROMOTION_LEDGER_VALUE_MIST (${MAX_PROMOTION_LEDGER_VALUE_MIST.toString()})`,
    );
  }
  return {
    perUserGasAllowanceMist: perUser,
    totalBudgetMist,
  };
}

/** Reject zero or negative MIST values. */
export function assertPositiveMist(value: bigint, label: string): void {
  if (value <= 0n) {
    throw new Error(`${label} must be greater than zero`);
  }
}

/** Reject negative MIST values. */
export function assertNonNegativeMist(value: bigint, label: string): void {
  if (value < 0n) {
    throw new Error(`${label} must be non-negative`);
  }
}

/** Reject a money mutation that would leave Redis Lua's exact-integer range. */
export function assertWithinLedgerBound(value: bigint, label: string): void {
  if (value > MAX_PROMOTION_LEDGER_VALUE_MIST) {
    throw new Error(
      `${label} (${value.toString()}) exceeds MAX_PROMOTION_LEDGER_VALUE_MIST (${MAX_PROMOTION_LEDGER_VALUE_MIST.toString()})`,
    );
  }
}
