/**
 * Coin selection utilities for /prepare.
 *
 * Adapted from sdk/src/sdk.ts L540-593 (coin querying, merging, splitting).
 * Server-owned — the relayer selects, merges, and splits coins on behalf of the user.
 *
 * User protection: the final txBytes is returned for user review and signature.
 * If the relayer makes malicious coin selections, the user can refuse to sign.
 *
 * R-9: When the user TX prefix already references coins of the same type,
 * coin selection must avoid double-consuming those coins. Callers pass
 * `survivors` (merge targets still alive after prefix) and `consumed`
 * (consumed ∪ opaqueInUse ∪ mutated — suffix-excluded set) for overlap detection.
 */
import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { PaymentInputSource } from '@stelis/core-relay/server';
import type { PrefixUsage } from './settlePlanTypes.js';
import { PrepareValidationError } from './replay.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface CoinSelectionResult {
  /** The payment coin (exact amount after split) */
  paymentCoin: TransactionObjectArgument;
  /** Leftover coin returned to sender (may be null if no split needed) */
  leftoverCoin: TransactionObjectArgument | null;
}

/**
 * Result of resolvePaymentSource(): determines where the settlement token comes from.
 *
 * Callers use `source` to branch into the correct PTB construction path:
 * - `coin_object`: existing selectPaymentCoin() flow
 * - `address_balance`: redeem_funds only (no usable coin objects)
 * - `mixed_topup`: coin objects + redeem_funds delta
 */
export interface PaymentSourceResolution {
  source: PaymentInputSource;
  /** Total usable coin object balance (MIST). 0 if no usable objects. */
  usableCoinTotal: bigint;
  /** Address balance available for settlement token (MIST). 0 if not queried or disabled. */
  addressBalance: bigint;
  /** Usable coin objects (filtered by R-9 consumed set). Empty if none. */
  usableCoins: Array<{ objectId: string; balance: string }>;
  /** For mixed_topup: amount to redeem from address balance. 0 otherwise. */
  redeemDelta: bigint;
}

function createEmptyPrefixUsage(): PrefixUsage {
  return {
    survivors: new Set(),
    consumed: new Set(),
    opaqueInUse: new Set(),
    mutated: new Set(),
    reusableSplitSources: new Set(),
    mergeDestToSources: new Map(),
    prefixAbConsumed: 0n,
  };
}

function buildPaymentSelectionExcludedCoinIds(prefixUsage: PrefixUsage): Set<string> {
  const excluded = new Set<string>([...prefixUsage.consumed, ...prefixUsage.opaqueInUse]);
  for (const id of prefixUsage.mutated) {
    if (!prefixUsage.reusableSplitSources.has(id)) {
      excluded.add(id);
    }
  }
  return excluded;
}

function buildUsablePaymentCoins<T extends { objectId: string }>(
  allCoins: readonly T[],
  prefixUsage: PrefixUsage,
): T[] {
  const excluded = buildPaymentSelectionExcludedCoinIds(prefixUsage);
  return allCoins.filter((coin) => !excluded.has(coin.objectId));
}

const DECIMAL_BALANCE_RE = /^(?:0|[1-9]\d*)$/;

function parseRpcBalanceMist(value: string, label: string): bigint {
  if (!DECIMAL_BALANCE_RE.test(value)) {
    throw new PrepareValidationError(
      'INVALID_BALANCE_FORMAT',
      `${label} must be a non-negative decimal integer string.`,
    );
  }
  return BigInt(value);
}

function normalizeRequiredAmount(value: bigint | number, tokenSymbol: string): bigint {
  if (typeof value === 'bigint') {
    if (value >= 0n) return value;
  } else if (Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new PrepareValidationError(
    'INVALID_AMOUNT',
    `Required ${tokenSymbol} amount must be a non-negative safe integer.`,
  );
}

export function pickPreferredPaymentBaseCoin<T extends { objectId: string }>(
  usableCoins: readonly T[],
  prefixUsage: PrefixUsage,
): T {
  const survivorCoin = usableCoins.find((coin) => prefixUsage.survivors.has(coin.objectId));
  if (survivorCoin) return survivorCoin;

  const reusableSplitSourceCoin = usableCoins.find((coin) =>
    prefixUsage.reusableSplitSources.has(coin.objectId),
  );
  if (reusableSplitSourceCoin) return reusableSplitSourceCoin;

  const firstCoin = usableCoins[0];
  if (!firstCoin) {
    throw new Error('pickPreferredPaymentBaseCoin requires at least one usable coin');
  }
  return firstCoin;
}

// ─────────────────────────────────────────────
// selectPaymentCoin
// ─────────────────────────────────────────────

/**
 * Select, merge, and split payment coins for the user.
 *
 * 1. Query all coins of `coinType` owned by `owner`
 * 2. Filter out unsafe coins from user TX prefix provenance (R-9)
 * 3. Prefer survivor coin as base (user TX merge target, still alive)
 * 4. Merge remaining usable coins into base
 * 5. Split the exact `amount` needed
 *
 * @param prefixUsage  Normalized user-prefix runtime evidence for payment selection.
 */
export async function selectPaymentCoin(
  sui: SuiGrpcClient,
  tx: Transaction,
  owner: string,
  coinType: string,
  amount: bigint | number,
  tokenSymbol: string,
  prefixUsage: PrefixUsage = createEmptyPrefixUsage(),
): Promise<CoinSelectionResult> {
  const requiredAmount = normalizeRequiredAmount(amount, tokenSymbol);

  const coinsResult = await sui.listCoins({ owner, coinType });
  const allCoins = coinsResult.objects ?? [];
  if (allCoins.length === 0) {
    throw new PrepareValidationError(
      'NO_COINS_FOUND',
      `No ${tokenSymbol} coins found for ${owner}.`,
    );
  }

  const usable = buildUsablePaymentCoins(allCoins, prefixUsage);
  if (usable.length === 0) {
    throw new PrepareValidationError(
      'PAYMENT_COIN_CONFLICT',
      `No safe ${tokenSymbol} coin objects remain after user transaction overlap filtering.`,
    );
  }

  const baseCoin = pickPreferredPaymentBaseCoin(usable, prefixUsage);
  const baseCoinId = baseCoin.objectId;

  // Merge all other usable coins into base (usable - base)
  const toMerge = usable.filter((c) => c.objectId !== baseCoinId);
  if (toMerge.length > 0) {
    tx.mergeCoins(
      tx.object(baseCoinId),
      toMerge.map((c) => tx.object(c.objectId)),
    );
  }

  // Split exact amount
  const [splitCoin, leftoverCoin] = tx.splitCoins(tx.object(baseCoinId), [requiredAmount]);

  return {
    paymentCoin: splitCoin,
    leftoverCoin,
  };
}

// ─────────────────────────────────────────────
// resolvePaymentSource
// ─────────────────────────────────────────────

/**
 * Determine where the settlement token comes from: coin objects, address balance,
 * or a mix of both.
 *
 * Selection priority:
 *   1. coin_object — if usable coin objects cover the required amount
 *   2. address_balance — if address balance alone covers the required amount
 *   3. mixed_topup — if coin objects + address balance together cover it
 *   4. INSUFFICIENT_BALANCE — nothing covers it
 *
 */
export async function resolvePaymentSource(
  sui: SuiGrpcClient,
  owner: string,
  coinType: string,
  requiredAmount: bigint | number,
  tokenSymbol: string,
  prefixUsage: PrefixUsage = createEmptyPrefixUsage(),
): Promise<PaymentSourceResolution> {
  const required = normalizeRequiredAmount(requiredAmount, tokenSymbol);

  // Step 1: Query coin objects (listCoins returns balance per coin)
  const coinsResult = await sui.listCoins({ owner, coinType });
  const allCoins = coinsResult.objects ?? [];
  const usable = buildUsablePaymentCoins(allCoins, prefixUsage);

  // Compute usable coin total
  let usableCoinTotal = 0n;
  const usableCoins: Array<{ objectId: string; balance: string }> = [];
  for (const c of usable) {
    const bal = parseRpcBalanceMist(c.balance, `Coin ${c.objectId} balance`);
    usableCoinTotal += bal;
    usableCoins.push({ objectId: c.objectId, balance: c.balance });
  }

  // Merge credit: direct-Input coins consumed by MergeCoins have their full
  // chain-snapshot balance absorbed into the merge destination. Credit is only
  // applied when the specific destination is a survivor AND is usable (not
  // consumed/opaque/mutated). This prevents false credit when the destination
  // is a Result-backed transient object or was later consumed.
  // Fail-optimistic for the gate check; safeBuild validates actual balance.
  const usableIds = new Set(usable.map((c) => c.objectId));
  const allCoinBalances = new Map(
    allCoins.map((c) => [c.objectId, parseRpcBalanceMist(c.balance, `Coin ${c.objectId} balance`)]),
  );
  let mergeCredit = 0n;
  for (const [destId, sourceIds] of prefixUsage.mergeDestToSources) {
    // Credit only if destination is both a survivor and usable
    if (!prefixUsage.survivors.has(destId) || !usableIds.has(destId)) continue;
    for (const srcId of sourceIds) {
      const bal = allCoinBalances.get(srcId);
      if (bal != null) mergeCredit += bal;
    }
  }
  const effectiveUsableCoinTotal = usableCoinTotal + mergeCredit;

  // Priority 1: coin objects (including merge-credited balance) are sufficient
  if (effectiveUsableCoinTotal >= required) {
    return {
      source: 'coin_object',
      usableCoinTotal,
      addressBalance: 0n,
      usableCoins,
      redeemDelta: 0n,
    };
  }

  // Step 2: Query address balance (gRPC getBalance)
  const balResult = await sui.getBalance({ owner, coinType });
  const rawAddressBalance = parseRpcBalanceMist(
    balResult.balance.addressBalance,
    'Address balance',
  );

  // R-9 AB accounting: subtract prefix FundsWithdrawal consumption from chain snapshot.
  // MaxAmountU64 is an upper bound, so over-subtraction is possible but fail-conservative
  // (resolver picks a more conservative source or rejects with INSUFFICIENT_BALANCE).
  const effectiveAb =
    rawAddressBalance > prefixUsage.prefixAbConsumed
      ? rawAddressBalance - prefixUsage.prefixAbConsumed
      : 0n;

  // Priority 2: effective address balance alone is sufficient
  if (effectiveAb >= required) {
    return {
      source: 'address_balance',
      usableCoinTotal,
      addressBalance: effectiveAb,
      usableCoins,
      redeemDelta: required,
    };
  }

  // Priority 3: mixed — coin objects (including merge credit) + effective address balance
  const combined = effectiveUsableCoinTotal + effectiveAb;
  if (combined >= required) {
    const delta = required - effectiveUsableCoinTotal;
    return {
      source: 'mixed_topup',
      usableCoinTotal,
      addressBalance: effectiveAb,
      usableCoins,
      redeemDelta: delta,
    };
  }

  // Nothing covers it
  if (allCoins.length > 0 && usable.length === 0 && effectiveAb === 0n) {
    // Coins exist but none remain safe after overlap filtering, and no
    // effective address balance is available either.
    throw new PrepareValidationError(
      'PAYMENT_COIN_CONFLICT',
      `No safe ${tokenSymbol} source remains after user transaction overlap filtering and no address balance is available.`,
    );
  }
  throw new PrepareValidationError(
    'INSUFFICIENT_BALANCE',
    `Insufficient ${tokenSymbol} balance: coins=${usableCoinTotal}, addressBalance=${effectiveAb}, need=${required}.`,
  );
}
