import { Transaction } from '@mysten/sui/transactions';
import { convertSdkCommands } from '@stelis/core-relay';
import type { PromotionPreparedTxEntry } from '../store/prepareTypes.js';
import type { AbuseBlockerAdapter } from '../store/abuseBlockTypes.js';
import type { VerifiedDeveloperIdentity } from './developerJwtVerifier.js';
import type { PromotionStoreAdapter } from './promotionStore.js';
import type { PromotionExecutionLedger } from './executionLedger.js';
import { recordPromotionAbuseEvent, PROMOTION_ABUSE_CODES } from './promotionAbusePolicy.js';
import { logStructuredEvent } from '../structuredEventLog.js';
import {
  LEDGER_RELEASE_FAILED_IN_HANDLER,
  LEDGER_RELEASE_THREW_IN_HANDLER,
  LEDGER_CONSUME_FAILED_IN_HANDLER,
  LEDGER_CONSUME_THREW_IN_HANDLER,
} from '../observability/events.js';
import {
  validatePromotionPtbStructure,
  validatePromotionTargets,
  validatePromotionEligibility,
  type PtbStructureFailure,
  type TargetPolicyFailure,
  type EligibilityFailure,
} from './validation.js';

export class PromotionSponsorPolicyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusHint: number = 400,
  ) {
    super(message);
    this.name = 'PromotionSponsorPolicyError';
  }
}

interface PromotionPolicyContext {
  promotionStore: PromotionStoreAdapter;
  executionLedger: PromotionExecutionLedger;
  abuseBlocker: AbuseBlockerAdapter;
  globalTargetHashes: Set<string>;
}

interface PromotionPolicyInput {
  promotionId: string;
  clientIp: string;
  verifiedIdentity: VerifiedDeveloperIdentity;
}

export async function releaseLedgerReservationWithLog(
  ledger: PromotionExecutionLedger,
  receiptId: string,
  triggerReason: string,
): Promise<void> {
  try {
    const result = await ledger.release(receiptId);
    if (!result.ok) {
      logStructuredEvent(
        LEDGER_RELEASE_FAILED_IN_HANDLER,
        {
          receiptId,
          triggerReason,
          releaseFailureReason: result.reason,
        },
        'error',
      );
    }
  } catch (err) {
    logStructuredEvent(
      LEDGER_RELEASE_THREW_IN_HANDLER,
      {
        receiptId,
        triggerReason,
        error: err instanceof Error ? err.message : String(err),
      },
      'error',
    );
  }
}

/**
 * Result envelope for the failure-path consume helper.
 *
 * Mirrors the underlying `ConsumeResult` discriminated union but adds an
 * explicit `'threw'` variant so call sites can distinguish an adapter
 * throw from a `ConsumeResult.ok === false` outcome without re-parsing
 * caught errors.
 */
export type ConsumeLedgerOutcome =
  | { ok: true }
  | { ok: false; kind: 'failed'; reason: string }
  | { ok: false; kind: 'threw'; error: string };

/**
 * Failure-path ledger consume helper.
 *
 * Used by post-signature/post-submit promotion failure branches
 * (submit-infra exception, on-chain revert with/without `gasUsed`,
 * post-success `GAS_EFFECTS_MISSING`). Behavior contract:
 *
 *   - On `ConsumeResult.ok === true` returns `{ ok: true }`.
 *   - On `ConsumeResult.ok === false` emits
 *     `LEDGER_CONSUME_FAILED_IN_HANDLER` with attempted amount + branch
 *     context and returns `{ ok: false, kind: 'failed', reason }`.
 *   - On adapter throw emits `LEDGER_CONSUME_THREW_IN_HANDLER` with the
 *     same context and returns `{ ok: false, kind: 'threw', error }`.
 *
 * The helper does NOT throw and does NOT fall back to `release()`. A
 * failure-path consume failure leaves the reservation eligible for the
 * ExecutionLedger reservation reaper release path, which is documented
 * operator follow-up — call sites must mark sponsor result economics as
 * unknown/loss instead of pretending the ledger settled successfully.
 *
 * Branch-specific failure reasons stay at the call site (they go into the
 * UsageEvent `failureReason`); this helper only logs ledger-call outcome.
 */
export async function consumeLedgerReservationWithLog(
  ledger: PromotionExecutionLedger,
  receiptId: string,
  amountMist: bigint,
  triggerReason: string,
  context: {
    promotionId: string;
    userId: string;
    senderAddress: string;
    txDigest: string | null;
  },
): Promise<ConsumeLedgerOutcome> {
  try {
    const result = await ledger.consume(receiptId, amountMist);
    if (!result.ok) {
      logStructuredEvent(
        LEDGER_CONSUME_FAILED_IN_HANDLER,
        {
          receiptId,
          triggerReason,
          attemptedAmountMist: amountMist.toString(),
          consumeFailureReason: result.reason,
          promotionId: context.promotionId,
          userId: context.userId,
          senderAddress: context.senderAddress,
          txDigest: context.txDigest,
        },
        'error',
      );
      return { ok: false, kind: 'failed', reason: result.reason };
    }
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logStructuredEvent(
      LEDGER_CONSUME_THREW_IN_HANDLER,
      {
        receiptId,
        triggerReason,
        attemptedAmountMist: amountMist.toString(),
        error,
        promotionId: context.promotionId,
        userId: context.userId,
        senderAddress: context.senderAddress,
        txDigest: context.txDigest,
      },
      'error',
    );
    return { ok: false, kind: 'threw', error };
  }
}

/**
 * Validate promotion-specific policy BEFORE consume.
 *
 * Caller (Studio SponsoredExecutionPolicy) owns route-level discrimination: mode guard and
 * promotionId match happen before this function is called. This function receives
 * an already-narrowed PromotionPreparedTxEntry.
 */
export async function validatePromotionPreconsumePolicy(
  ctx: PromotionPolicyContext,
  input: PromotionPolicyInput,
  peeked: PromotionPreparedTxEntry,
  txBytes: Uint8Array,
): Promise<{ builtTx: Transaction }> {
  if (input.verifiedIdentity.senderAddress !== peeked.senderAddress) {
    throw new PromotionSponsorPolicyError(
      'Verified identity senderAddress does not match prepared senderAddress',
      'SENDER_ADDRESS_MISMATCH',
      403,
    );
  }
  if (input.verifiedIdentity.userId !== peeked.userId) {
    throw new PromotionSponsorPolicyError(
      'Verified identity userId does not match prepared userId',
      'USER_ID_MISMATCH',
      403,
    );
  }

  // Parse the stored-hash-verified `txBytes` into a Transaction. `decodeTxBytes` at the
  // route boundary already validated base64; BCS deserialization can still
  // fail on malformed TransactionKind payloads. Classify that as `BAD_REQUEST`
  // / 400 so route-level 500 `SPONSOR_FAILED` cannot mask a client-visible
  // input error. The rejection happens before `consume()`, so the prepared
  // entry remains unconsumed.
  let builtTx: Transaction;
  try {
    builtTx = Transaction.from(txBytes);
  } catch (err) {
    throw new PromotionSponsorPolicyError(
      `Malformed txBytes — cannot deserialize TransactionKind: ${err instanceof Error ? err.message : String(err)}`,
      'BAD_REQUEST',
      400,
    );
  }
  const normalizedCommands = convertSdkCommands(builtTx.getData().commands as unknown[]);

  // S1 — PTB structure. Sponsor path does NOT check sponsor withdrawal
  // (txBytesHash binding proves TX integrity against prepare-time commit).
  const ptbFailure = validatePromotionPtbStructure(normalizedCommands);
  if (ptbFailure) {
    await recordSponsorAbuseForPtbStructure(ctx, input, peeked, ptbFailure);
    throw sponsorPolicyErrorForPtbStructure(ptbFailure);
  }

  // S2 — allowed targets.
  const targetFailure = validatePromotionTargets(normalizedCommands, ctx.globalTargetHashes);
  if (targetFailure) {
    await recordSponsorAbuseForTargetPolicy(ctx, input, peeked, targetFailure);
    throw sponsorPolicyErrorForTargetPolicy(targetFailure);
  }

  // S3 — eligibility (promotion active + claimed + use-window).
  const promotion = await ctx.promotionStore.get(input.promotionId);
  const entitlement = promotion
    ? await ctx.executionLedger.getEntitlement(input.promotionId, input.verifiedIdentity.userId)
    : null;
  const eligibilityFailure = validatePromotionEligibility(promotion, entitlement);
  if (eligibilityFailure) {
    throw sponsorPolicyErrorForEligibility(eligibilityFailure);
  }

  return { builtTx };
}

// ─────────────────────────────────────────────
// Validation failure → PromotionSponsorPolicyError + (optional) abuse record
// ─────────────────────────────────────────────

function sponsorPolicyErrorForPtbStructure(f: PtbStructureFailure): PromotionSponsorPolicyError {
  switch (f.code) {
    case 'FORBIDDEN_COMMAND':
      return new PromotionSponsorPolicyError(
        `Forbidden command kind "${f.kind}" in promotion TX — only MoveCall is allowed`,
        'FORBIDDEN_COMMAND',
        403,
      );
    case 'GASCOIN_FORBIDDEN':
      return new PromotionSponsorPolicyError(
        'MoveCall references GasCoin — rejected to protect sponsor funds',
        'GASCOIN_FORBIDDEN',
        403,
      );
  }
}

function sponsorPolicyErrorForTargetPolicy(f: TargetPolicyFailure): PromotionSponsorPolicyError {
  return new PromotionSponsorPolicyError(
    `Disallowed MoveCall targets at sponsor time: ${f.disallowedTargets.join(', ')}`,
    'DISALLOWED_TARGET',
    403,
  );
}

function sponsorPolicyErrorForEligibility(f: EligibilityFailure): PromotionSponsorPolicyError {
  switch (f.code) {
    case 'PROMOTION_NOT_FOUND':
    case 'PROMOTION_NOT_ACTIVE':
      return new PromotionSponsorPolicyError(
        'Promotion not found or not active at sponsor time',
        'PROMOTION_NOT_ACTIVE',
        409,
      );
    case 'PROMOTION_NOT_STARTED':
      return new PromotionSponsorPolicyError(
        `Promotion has not started yet (starts at ${f.startAt})`,
        'PROMOTION_NOT_STARTED',
        409,
      );
    case 'NOT_CLAIMED':
      return new PromotionSponsorPolicyError('User not claimed', 'NOT_CLAIMED', 403);
    case 'USE_WINDOW_EXPIRED':
      return new PromotionSponsorPolicyError(
        `Use window expired at ${f.useUntilAt}`,
        'USE_WINDOW_EXPIRED',
        403,
      );
  }
}

async function recordSponsorAbuseForPtbStructure(
  ctx: PromotionPolicyContext,
  input: PromotionPolicyInput,
  peeked: PromotionPreparedTxEntry,
  f: PtbStructureFailure,
): Promise<void> {
  const common = {
    promotionId: input.promotionId,
    userId: input.verifiedIdentity.userId,
  };
  if (f.code === 'FORBIDDEN_COMMAND') {
    await recordPromotionAbuseEvent(
      ctx.abuseBlocker,
      input.clientIp,
      { kind: 'studio_user', userId: peeked.userId },
      PROMOTION_ABUSE_CODES.FORBIDDEN_COMMAND,
      { ...common, kind: f.kind },
    );
  } else if (f.code === 'GASCOIN_FORBIDDEN') {
    await recordPromotionAbuseEvent(
      ctx.abuseBlocker,
      input.clientIp,
      { kind: 'studio_user', userId: peeked.userId },
      PROMOTION_ABUSE_CODES.GASCOIN_FORBIDDEN,
      common,
    );
  }
}

async function recordSponsorAbuseForTargetPolicy(
  ctx: PromotionPolicyContext,
  input: PromotionPolicyInput,
  peeked: PromotionPreparedTxEntry,
  f: TargetPolicyFailure,
): Promise<void> {
  await recordPromotionAbuseEvent(
    ctx.abuseBlocker,
    input.clientIp,
    { kind: 'studio_user', userId: peeked.userId },
    PROMOTION_ABUSE_CODES.DISALLOWED_TARGET,
    {
      promotionId: input.promotionId,
      userId: input.verifiedIdentity.userId,
      detail: `disallowed: ${f.disallowedTargets.join(', ')}`,
    },
  );
}
