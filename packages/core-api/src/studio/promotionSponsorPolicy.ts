import { Transaction } from '@mysten/sui/transactions';
import type { PromotionSponsorErrorCode } from '@stelis/contracts';
import { convertSdkCommands, MAX_FINAL_COMMANDS } from '@stelis/core-relay';
import type { PromotionPreparedTxEntry } from '../store/prepareTypes.js';
import type { AbuseBlockerAdapter } from '../store/abuseBlockTypes.js';
import type { VerifiedDeveloperIdentity } from './developerJwtVerifier.js';
import type { PromotionStoreAdapter } from './promotionStore.js';
import type { PromotionExecutionLedger } from './executionLedger.js';
import { recordPromotionAbuseEvent, PROMOTION_ABUSE_CODES } from './promotionAbusePolicy.js';
import {
  validatePromotionCommandCount,
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
    public readonly code: PromotionSponsorErrorCode,
  ) {
    super(message);
    this.name = 'PromotionSponsorPolicyError';
  }
}

interface PromotionPolicyContext {
  promotionStore: PromotionStoreAdapter;
  executionLedger: PromotionExecutionLedger;
  abuseBlocker: AbuseBlockerAdapter;
  globalAllowedTargets: ReadonlySet<string>;
}

interface PromotionPolicyInput {
  promotionId: string;
  clientIp: string;
  verifiedIdentity: VerifiedDeveloperIdentity;
}

/**
 * Validate Promotion-specific policy before durable execution begins.
 *
 * Caller (Promotion SponsoredExecutionPolicy) owns route-level discrimination: mode guard and
 * promotionId match happen before this function is called. This function receives
 * an already-narrowed PromotionPreparedTxEntry.
 */
export async function validatePromotionPreparedPolicy(
  ctx: PromotionPolicyContext,
  input: PromotionPolicyInput,
  peeked: PromotionPreparedTxEntry,
  txBytes: Uint8Array,
): Promise<{ builtTx: Transaction }> {
  if (input.verifiedIdentity.senderAddress !== peeked.senderAddress) {
    throw new PromotionSponsorPolicyError(
      'Verified identity senderAddress does not match prepared senderAddress',
      'SENDER_ADDRESS_MISMATCH',
    );
  }
  if (input.verifiedIdentity.userId !== peeked.userId) {
    throw new PromotionSponsorPolicyError(
      'Verified identity userId does not match prepared userId',
      'USER_ID_MISMATCH',
    );
  }

  // Parse the submitted `txBytes` into a Transaction. `decodeTxBytes` at the
  // route boundary already validated base64; BCS deserialization can still
  // fail on malformed TransactionData. The sponsor runner separately binds
  // these bytes to the prepared-record hash before durable execution begins.
  // Classify this parse failure as
  // `BAD_REQUEST` / 400 so route-level 500 `SPONSOR_FAILED` cannot mask a
  // client-visible input error. The rejection happens before the durable
  // prepared-to-executing transition, so the prepared receipt remains current.
  let builtTx: Transaction;
  try {
    builtTx = Transaction.from(txBytes);
  } catch (err) {
    throw new PromotionSponsorPolicyError(
      `Malformed txBytes — cannot deserialize TransactionKind: ${err instanceof Error ? err.message : String(err)}`,
      'BAD_REQUEST',
    );
  }
  const normalizedCommands = convertSdkCommands(builtTx.getData().commands as unknown[]);

  // S1 — PTB structure. Sponsor path does NOT repeat the sponsor-withdrawal
  // check; the runner's hash gate must prove these bytes are the exact
  // prepare-time transaction before signing can occur.
  const ptbFailure = validatePromotionPtbStructure(normalizedCommands);
  if (ptbFailure) {
    await recordSponsorAbuseForPtbStructure(ctx, input, peeked, ptbFailure);
    throw sponsorPolicyErrorForPtbStructure(ptbFailure);
  }

  // S2 — allowed targets.
  const targetFailure = validatePromotionTargets(normalizedCommands, ctx.globalAllowedTargets);
  if (targetFailure) {
    await recordSponsorAbuseForTargetPolicy(ctx, input, peeked, targetFailure);
    throw sponsorPolicyErrorForTargetPolicy(targetFailure);
  }

  const commandCountFailure = validatePromotionCommandCount(normalizedCommands);
  if (commandCountFailure) {
    throw new PromotionSponsorPolicyError(
      `Promotion transaction must contain 1 to ${MAX_FINAL_COMMANDS} commands; received ${commandCountFailure.commandCount}`,
      'BAD_REQUEST',
    );
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
      );
    case 'GASCOIN_FORBIDDEN':
      return new PromotionSponsorPolicyError(
        'MoveCall references GasCoin — rejected to protect sponsor funds',
        'GASCOIN_FORBIDDEN',
      );
  }
}

function sponsorPolicyErrorForTargetPolicy(f: TargetPolicyFailure): PromotionSponsorPolicyError {
  return new PromotionSponsorPolicyError(
    `Disallowed MoveCall targets at sponsor time: ${f.disallowedTargets.join(', ')}`,
    'DISALLOWED_TARGET',
  );
}

function sponsorPolicyErrorForEligibility(f: EligibilityFailure): PromotionSponsorPolicyError {
  switch (f.code) {
    case 'PROMOTION_NOT_FOUND':
    case 'PROMOTION_NOT_ACTIVE':
      return new PromotionSponsorPolicyError(
        'Promotion not found or not active at sponsor time',
        'PROMOTION_NOT_ACTIVE',
      );
    case 'PROMOTION_NOT_STARTED':
      return new PromotionSponsorPolicyError(
        `Promotion has not started yet (starts at ${f.startAt})`,
        'PROMOTION_NOT_ACTIVE',
      );
    case 'NOT_CLAIMED':
      return new PromotionSponsorPolicyError('User not claimed', 'NOT_CLAIMED');
    case 'USE_WINDOW_EXPIRED':
      return new PromotionSponsorPolicyError(
        `Use window expired at ${f.useUntilAt}`,
        'USE_WINDOW_EXPIRED',
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
  switch (f.code) {
    case 'FORBIDDEN_COMMAND':
      await recordPromotionAbuseEvent(
        ctx.abuseBlocker,
        input.clientIp,
        { kind: 'studio_user', userId: peeked.userId },
        PROMOTION_ABUSE_CODES.FORBIDDEN_COMMAND,
        { ...common, kind: f.kind },
      );
      return;
    case 'GASCOIN_FORBIDDEN':
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
