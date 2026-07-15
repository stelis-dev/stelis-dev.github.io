/**
 * Resolve one exact settlement-token funding choice from the user-prefix value
 * trace and the current Sui coin/address-balance snapshot.
 *
 * This module owns chain discovery and selection. The PTB compiler receives the
 * selected object IDs and amounts and performs no discovery of its own.
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';
import {
  getSuiBalance,
  listAllSuiCoins,
  type PrefixValueTrace,
  type SuiEndpointSnapshot,
} from '@stelis/core-relay';
import type { SwapFundingResolution } from './settlePlanTypes.js';
import { PrepareValidationError } from './replay.js';

interface ResolvedCoinCandidate {
  readonly objectId: string;
  readonly balance: bigint;
  readonly appearsInPrefix: boolean;
}

const DECIMAL_BALANCE_RE = /^(?:0|[1-9]\d*)$/;
const U64_MAX = (1n << 64n) - 1n;

function parseRpcBalance(value: string, label: string): bigint {
  if (!DECIMAL_BALANCE_RE.test(value)) {
    throw new PrepareValidationError(
      'INVALID_BALANCE_FORMAT',
      `${label} must be a non-negative decimal integer string.`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > U64_MAX) {
    throw new PrepareValidationError(
      'INVALID_BALANCE_FORMAT',
      `${label} exceeds the u64 coin-balance range.`,
    );
  }
  return parsed;
}

function canonicalObjectId(value: string, label: string): string {
  try {
    return normalizeSuiAddress(value);
  } catch {
    throw new PrepareValidationError(
      'PAYMENT_COIN_CONFLICT',
      `${label} is not a canonicalizable Sui object ID.`,
    );
  }
}

function normalizeRequiredAmount(value: bigint, tokenSymbol: string): bigint {
  if (value >= 0n && value <= U64_MAX) return value;
  throw new PrepareValidationError(
    'INVALID_AMOUNT',
    `Required ${tokenSymbol} amount must be a bigint in the u64 range.`,
  );
}

/**
 * Resolve the exact post-prefix balance of every currently discovered coin that
 * is still directly available. A surviving merge destination owns every
 * snapshot component carried into it exactly once; consumed/opaque coins are
 * never emitted as separate candidates.
 */
function resolveCoinCandidates(
  discovered: ReadonlyMap<string, bigint>,
  prefixTrace: PrefixValueTrace,
): ResolvedCoinCandidate[] {
  const candidates: ResolvedCoinCandidate[] = [];
  const claimedSnapshotIds = new Set<string>();

  for (const [objectId, balance] of discovered) {
    const state = prefixTrace.directCoins.get(objectId);
    if (state && state.status !== 'surviving') continue;

    if (!state) {
      if (claimedSnapshotIds.has(objectId)) {
        throw new PrepareValidationError(
          'PAYMENT_COIN_CONFLICT',
          `Coin ${objectId} is represented by more than one surviving prefix value.`,
        );
      }
      claimedSnapshotIds.add(objectId);
      candidates.push({ objectId, balance, appearsInPrefix: false });
      continue;
    }

    let remaining = state.value.delta;
    const localSnapshotIds = new Set<string>();
    let complete = true;
    for (const snapshotId of state.value.snapshotCoinIds) {
      const canonicalSnapshotId = canonicalObjectId(snapshotId, 'Prefix coin snapshot ID');
      if (localSnapshotIds.has(canonicalSnapshotId)) {
        throw new PrepareValidationError(
          'PAYMENT_COIN_CONFLICT',
          `Coin ${canonicalSnapshotId} is duplicated inside one surviving prefix value.`,
        );
      }
      localSnapshotIds.add(canonicalSnapshotId);
      const snapshot = discovered.get(canonicalSnapshotId);
      if (snapshot === undefined) {
        complete = false;
        break;
      }
      remaining += snapshot;
    }
    if (!complete) continue;
    if (remaining < 0n || remaining > U64_MAX) {
      throw new PrepareValidationError(
        'PAYMENT_COIN_CONFLICT',
        `Prefix coin ${objectId} has an out-of-range u64 balance after exact prefix commands.`,
      );
    }
    for (const snapshotId of localSnapshotIds) {
      if (claimedSnapshotIds.has(snapshotId)) {
        throw new PrepareValidationError(
          'PAYMENT_COIN_CONFLICT',
          `Coin ${snapshotId} is represented by more than one surviving prefix value.`,
        );
      }
      claimedSnapshotIds.add(snapshotId);
    }
    candidates.push({ objectId, balance: remaining, appearsInPrefix: true });
  }

  return candidates;
}

/**
 * Prove every exact command-time carrier value that can belong to the selected
 * token. Before the immutable coin snapshot scan is exhausted, a missing object
 * remains unresolved because it may appear later in RPC order. At exhaustion,
 * a constraint with no matching objects belongs to another token; a partial
 * match is structurally invalid.
 */
function validateValueConstraints(
  discovered: ReadonlyMap<string, bigint>,
  prefixTrace: PrefixValueTrace,
  exhausted: boolean,
): boolean {
  let allResolved = true;

  for (const constraint of prefixTrace.valueConstraints) {
    let value = constraint.value.delta;
    let found = 0;
    for (const snapshotId of constraint.value.snapshotCoinIds) {
      const canonicalSnapshotId = canonicalObjectId(snapshotId, 'Prefix constraint snapshot ID');
      const snapshot = discovered.get(canonicalSnapshotId);
      if (snapshot !== undefined) {
        found += 1;
        value += snapshot;
      }
    }

    const expected = constraint.value.snapshotCoinIds.length;
    if (found !== expected) {
      if (!exhausted) {
        allResolved = false;
        continue;
      }
      if (found === 0) continue;
      throw new PrepareValidationError(
        'PAYMENT_COIN_CONFLICT',
        `Prefix command ${constraint.commandIndex} mixes settlement-token and unresolved coin values.`,
      );
    }

    if (value < 0n || value > U64_MAX) {
      throw new PrepareValidationError(
        'PAYMENT_COIN_CONFLICT',
        `Prefix command ${constraint.commandIndex} produces an out-of-range u64 coin value.`,
      );
    }
  }

  return allResolved;
}

function totalCandidateBalance(candidates: readonly ResolvedCoinCandidate[]): bigint {
  const total = candidates.reduce((sum, coin) => sum + coin.balance, 0n);
  if (total > U64_MAX) {
    throw new PrepareValidationError(
      'PAYMENT_COIN_CONFLICT',
      'Discovered settlement-token coin value exceeds the u64 balance range.',
    );
  }
  return total;
}

function resolveCoinObjectFunding(
  candidates: readonly ResolvedCoinCandidate[],
): Pick<
  Extract<SwapFundingResolution, { source: 'coin_object' }>,
  'baseCoinId' | 'mergeCoinIds' | 'remainingBalance'
> {
  const base = candidates.find((coin) => coin.appearsInPrefix) ?? candidates[0];
  if (!base) {
    throw new PrepareValidationError(
      'PAYMENT_COIN_CONFLICT',
      'Coin-object funding was selected without an available base coin.',
    );
  }

  return {
    baseCoinId: base.objectId,
    mergeCoinIds: candidates
      .filter((coin) => coin.objectId !== base.objectId)
      .map((coin) => coin.objectId),
    remainingBalance: totalCandidateBalance(candidates),
  };
}

/**
 * Determine the exact source for the settlement-token swap input.
 *
 * All coin pages are read as one endpoint-consistent operation. Selection then
 * walks that immutable result in RPC order and stops at the first safely
 * resolved prefix whose value covers the request. Address-balance or mixed
 * funding is considered only after the coin result is exhausted.
 */
export async function resolvePaymentSource(
  sui: SuiEndpointSnapshot,
  owner: string,
  coinType: string,
  requiredAmount: bigint,
  tokenSymbol: string,
  prefixTrace: PrefixValueTrace,
): Promise<SwapFundingResolution> {
  const required = normalizeRequiredAmount(requiredAmount, tokenSymbol);
  const discovered = new Map<string, bigint>();
  const coins = await listAllSuiCoins(sui, { owner, coinType });

  for (let index = 0; index < coins.length; index += 1) {
    const coin = coins[index]!;
    const objectId = canonicalObjectId(coin.objectId, 'Coin object ID');
    if (discovered.has(objectId)) {
      throw new PrepareValidationError(
        'PAYMENT_COIN_CONFLICT',
        `Coin discovery returned duplicate object ${objectId}.`,
      );
    }
    discovered.set(objectId, parseRpcBalance(coin.balance, `Coin ${objectId} balance`));

    const exhausted = index === coins.length - 1;
    const constraintsResolved = validateValueConstraints(discovered, prefixTrace, exhausted);
    const candidates = resolveCoinCandidates(discovered, prefixTrace);
    const coinBalance = totalCandidateBalance(candidates);
    if (constraintsResolved && candidates.length > 0 && coinBalance >= required) {
      return {
        source: 'coin_object',
        ...resolveCoinObjectFunding(candidates),
      };
    }
  }

  if (coins.length === 0) validateValueConstraints(discovered, prefixTrace, true);

  const candidates = resolveCoinCandidates(discovered, prefixTrace);
  const coinBalance = totalCandidateBalance(candidates);
  const balanceResult = await getSuiBalance(sui, { owner, coinType });
  const addressBalance = parseRpcBalance(balanceResult.addressBalance, 'Address balance');
  const availableAddressBalance =
    addressBalance > prefixTrace.senderWithdrawalDebit
      ? addressBalance - prefixTrace.senderWithdrawalDebit
      : 0n;

  if (availableAddressBalance >= required) {
    return { source: 'address_balance', redeemAmount: required };
  }

  if (candidates.length > 0 && coinBalance + availableAddressBalance >= required) {
    return {
      source: 'mixed_topup',
      ...resolveCoinObjectFunding(candidates),
      redeemAmount: required - coinBalance,
    };
  }

  if (discovered.size > 0 && candidates.length === 0 && availableAddressBalance === 0n) {
    throw new PrepareValidationError(
      'PAYMENT_COIN_CONFLICT',
      `No safe ${tokenSymbol} source remains after user-prefix value tracing and no address balance is available.`,
    );
  }
  throw new PrepareValidationError(
    'INSUFFICIENT_BALANCE',
    `Insufficient ${tokenSymbol} balance: coins=${coinBalance}, addressBalance=${availableAddressBalance}, need=${required}.`,
  );
}
