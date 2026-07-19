import { hostErrorPublicMessage } from '@stelis/contracts';
import { selectSuiCoinSubset, type SuiCoinReadResult } from '@stelis/core-relay/browser';

export interface TransferCoinSelection {
  readonly baseCoinId: string;
  readonly mergeCoinIds: readonly string[];
}

interface ParsedCoin {
  readonly objectId: string;
  readonly balance: bigint;
}

function toSelectableCoin(coin: SuiCoinReadResult['coins'][number]): ParsedCoin {
  return { objectId: coin.objectId, balance: BigInt(coin.balance) };
}

/**
 * Adapt the shared bounded coin selection to the sandbox transfer PTB.
 *
 * A partial read may succeed only when the selected subset already covers the
 * transfer. It must never be interpreted as wallet exhaustion.
 */
export function selectTransferCoins(
  result: SuiCoinReadResult,
  requiredAmount: bigint,
): TransferCoinSelection {
  const selection = selectSuiCoinSubset(result.coins.map(toSelectableCoin), requiredAmount);
  if (!selection.sufficient) {
    if (result.status === 'limit_exceeded') {
      throw new Error(hostErrorPublicMessage('PAYMENT_COIN_LIMIT_EXCEEDED'));
    }
    throw new Error('Insufficient settlement token coin balance');
  }

  const [base, ...merge] = selection.coins;
  if (!base) throw new Error('Coin selection succeeded without a base coin');
  return Object.freeze({
    baseCoinId: base.objectId,
    mergeCoinIds: Object.freeze(merge.map((coin) => coin.objectId)),
  });
}
