import { describe, expect, it } from 'vitest';
import { hostErrorPublicMessage } from '@stelis/contracts';
import type { SuiCoinReadResult } from '@stelis/core-relay/browser';
import { selectTransferCoins } from '../src/pages/sandbox/transferCoinSelection';

function result(
  status: SuiCoinReadResult['status'],
  coins: readonly { objectId: string; balance: string }[],
): SuiCoinReadResult {
  return {
    status,
    coins: coins.map((coin) => coin as SuiCoinReadResult['coins'][number]),
  };
}

describe('selectTransferCoins', () => {
  it('uses a sufficient subset from a limited read', () => {
    expect(
      selectTransferCoins(
        result('limit_exceeded', [
          { objectId: 'a', balance: '4' },
          { objectId: 'b', balance: '6' },
          { objectId: 'c', balance: '100' },
        ]),
        10n,
      ),
    ).toEqual({ baseCoinId: 'c', mergeCoinIds: [] });
  });

  it('merges only the first sufficient safe subset', () => {
    expect(
      selectTransferCoins(
        result('complete', [
          { objectId: 'a', balance: '4' },
          { objectId: 'b', balance: '6' },
          { objectId: 'c', balance: '100' },
        ]),
        110n,
      ),
    ).toEqual({ baseCoinId: 'a', mergeCoinIds: ['b', 'c'] });
  });

  it('does not treat a limited read as insufficient wallet balance', () => {
    expect(() =>
      selectTransferCoins(result('limit_exceeded', [{ objectId: 'a', balance: '4' }]), 10n),
    ).toThrow(hostErrorPublicMessage('PAYMENT_COIN_LIMIT_EXCEEDED'));
  });
});
