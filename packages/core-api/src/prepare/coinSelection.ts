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
  readBoundedSuiCoins,
  selectSuiCoinSubset,
  type PrefixValueTrace,
  type SuiCoinReadResult,
  type SuiEndpointSnapshot,
} from '@stelis/core-relay';
import type { SwapFundingResolution } from './settlePlanTypes.js';
import { PrepareValidationError } from './replay.js';

interface ResolvedCoinCandidate {
  readonly objectId: string;
  readonly balance: bigint;
  readonly appearsInPrefix: boolean;
  readonly snapshotCoinIds: readonly string[];
}

const DECIMAL_BALANCE_RE = /^(?:0|[1-9]\d*)$/;
const U64_MAX = (1n << 64n) - 1n;

export interface PaymentSourceReader {
  readCoins(): Promise<SuiCoinReadResult>;
  readAddressBalance(): Promise<bigint>;
}

export type PaymentSourceEvaluation =
  | { readonly outcome: 'funded'; readonly funding: SwapFundingResolution }
  | {
      readonly outcome: 'insufficient';
      readonly availableSettlementTokenAmount: bigint;
      readonly error: PrepareValidationError;
    }
  | {
      readonly outcome: 'indeterminate';
      readonly reason: 'bounded_coin_discovery';
      readonly error: PrepareValidationError;
    };

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

/**
 * Create one request-local reader for settlement-token funding evidence.
 *
 * Coin objects and address balance are each loaded at most once. Reads stay
 * lazy so a credit-only prepare does not query settlement-token funding.
 */
export function createPaymentSourceReader(
  sui: SuiEndpointSnapshot,
  owner: string,
  coinType: string,
): PaymentSourceReader {
  let coinRead: Promise<SuiCoinReadResult> | undefined;
  let addressBalance: Promise<bigint> | undefined;

  return Object.freeze({
    readCoins(): Promise<SuiCoinReadResult> {
      coinRead ??= readBoundedSuiCoins(sui, { owner, coinType });
      return coinRead;
    },
    readAddressBalance(): Promise<bigint> {
      addressBalance ??= getSuiBalance(sui, { owner, coinType }).then((result) =>
        parseRpcBalance(result.addressBalance, 'Address balance'),
      );
      return addressBalance;
    },
  });
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
  if (value > 0n && value <= U64_MAX) return value;
  throw new PrepareValidationError(
    'INVALID_AMOUNT',
    `Required ${tokenSymbol} amount must be a positive bigint in the u64 range.`,
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
      candidates.push({
        objectId,
        balance,
        appearsInPrefix: false,
        snapshotCoinIds: [objectId],
      });
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
    candidates.push({
      objectId,
      balance: remaining,
      appearsInPrefix: true,
      snapshotCoinIds: [...localSnapshotIds],
    });
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
  complete: boolean,
  relevantSnapshotIds?: ReadonlySet<string>,
): boolean {
  let relevantValuesResolved = true;

  for (const constraint of prefixTrace.valueConstraints) {
    let value = constraint.value.delta;
    let found = 0;
    let isRelevant = constraint.value.snapshotCoinIds.length === 0;
    for (const snapshotId of constraint.value.snapshotCoinIds) {
      const canonicalSnapshotId = canonicalObjectId(snapshotId, 'Prefix constraint snapshot ID');
      if (relevantSnapshotIds?.has(canonicalSnapshotId)) isRelevant = true;
      const snapshot = discovered.get(canonicalSnapshotId);
      if (snapshot !== undefined) {
        found += 1;
        value += snapshot;
      }
    }

    const expected = constraint.value.snapshotCoinIds.length;
    if (found !== expected) {
      if (!complete) {
        if (isRelevant) relevantValuesResolved = false;
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

  return relevantValuesResolved;
}

function totalCandidateBalance(candidates: readonly ResolvedCoinCandidate[]): bigint {
  return candidates.reduce((sum, coin) => sum + coin.balance, 0n);
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

function boundedCoinDiscovery(): Extract<PaymentSourceEvaluation, { outcome: 'indeterminate' }> {
  return {
    outcome: 'indeterminate',
    reason: 'bounded_coin_discovery',
    error: new PrepareValidationError(
      'PAYMENT_COIN_LIMIT_EXCEEDED',
      'Settlement-token coin objects exceed the bounded read and no complete funding source was proven in the returned page.',
    ),
  };
}

/**
 * Determine the exact source for the settlement-token swap input.
 *
 * Coin discovery returns one bounded, endpoint-consistent result. Selection
 * walks that immutable result in RPC order and stops at the first u64-safe
 * subset that covers the request. Address-balance or mixed funding is
 * considered only when the result proves the wallet scan is complete.
 */
export async function evaluatePaymentSource(
  reader: PaymentSourceReader,
  requiredAmount: bigint,
  tokenSymbol: string,
  prefixTrace: PrefixValueTrace,
): Promise<PaymentSourceEvaluation> {
  const required = normalizeRequiredAmount(requiredAmount, tokenSymbol);
  const discovered = new Map<string, bigint>();
  const coinRead = await reader.readCoins();

  for (const coin of coinRead.coins) {
    const objectId = canonicalObjectId(coin.objectId, 'Coin object ID');
    if (discovered.has(objectId)) {
      throw new PrepareValidationError(
        'PAYMENT_COIN_CONFLICT',
        `Coin discovery returned duplicate object ${objectId}.`,
      );
    }
    discovered.set(objectId, parseRpcBalance(coin.balance, `Coin ${objectId} balance`));
  }

  const complete = coinRead.status === 'complete';
  if (complete) validateValueConstraints(discovered, prefixTrace, true);
  const candidates = resolveCoinCandidates(discovered, prefixTrace);
  const selected = selectSuiCoinSubset(candidates, required);
  if (selected.sufficient) {
    if (!complete) {
      const relevantSnapshotIds = new Set(
        selected.coins.flatMap((coin) => [...coin.snapshotCoinIds]),
      );
      if (!validateValueConstraints(discovered, prefixTrace, false, relevantSnapshotIds)) {
        return boundedCoinDiscovery();
      }
    }
    return {
      outcome: 'funded',
      funding: {
        source: 'coin_object',
        ...resolveCoinObjectFunding(selected.coins),
      },
    };
  }

  if (!complete) return boundedCoinDiscovery();

  const coinBalance = selected.totalBalance;
  const nominalCoinBalance = totalCandidateBalance(candidates);
  const addressBalance = await reader.readAddressBalance();
  const availableAddressBalance =
    addressBalance > prefixTrace.senderWithdrawalDebit
      ? addressBalance - prefixTrace.senderWithdrawalDebit
      : 0n;

  if (availableAddressBalance >= required) {
    return {
      outcome: 'funded',
      funding: { source: 'address_balance', redeemAmount: required },
    };
  }

  if (selected.coins.length > 0 && coinBalance + availableAddressBalance >= required) {
    return {
      outcome: 'funded',
      funding: {
        source: 'mixed_topup',
        ...resolveCoinObjectFunding(selected.coins),
        redeemAmount: required - coinBalance,
      },
    };
  }

  if (nominalCoinBalance + availableAddressBalance >= required) {
    throw new PrepareValidationError(
      'PAYMENT_COIN_CONFLICT',
      `The bounded ordered ${tokenSymbol} coin selection could not prove a u64-safe funding subset.`,
    );
  }

  if (discovered.size > 0 && candidates.length === 0 && availableAddressBalance === 0n) {
    throw new PrepareValidationError(
      'PAYMENT_COIN_CONFLICT',
      `No safe ${tokenSymbol} source remains after user-prefix value tracing and no address balance is available.`,
    );
  }
  const availableSettlementTokenAmount = nominalCoinBalance + availableAddressBalance;
  return {
    outcome: 'insufficient',
    availableSettlementTokenAmount,
    error: new PrepareValidationError(
      'INSUFFICIENT_BALANCE',
      `Insufficient ${tokenSymbol} balance: coins=${coinBalance}, addressBalance=${availableAddressBalance}, need=${required}.`,
    ),
  };
}
