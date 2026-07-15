import { describe, expect, it, vi } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  createSuiEndpointSnapshot,
  traceUserPrefixValue,
  type SuiEndpointSnapshot,
} from '@stelis/core-relay';
import { resolvePaymentSource } from '../src/prepare/coinSelection.js';

const gatewayMocks = vi.hoisted(() => ({
  listAllSuiCoins: vi.fn(),
  getSuiBalance: vi.fn(),
}));

vi.mock('@stelis/core-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stelis/core-relay')>()),
  listAllSuiCoins: gatewayMocks.listAllSuiCoins,
  getSuiBalance: gatewayMocks.getSuiBalance,
}));

const COIN_A = `0x${'aa'.repeat(32)}`;
const COIN_B = `0x${'bb'.repeat(32)}`;
const COIN_C = `0x${'cc'.repeat(32)}`;
const OWNER = `0x${'01'.repeat(32)}`;
const RECIPIENT = `0x${'02'.repeat(32)}`;
const SETTLEMENT_TOKEN = '0x2::sui::SUI';

interface CoinPage {
  readonly objects: ReadonlyArray<{ objectId: string; balance: string }>;
}

function mockSui(pages: readonly CoinPage[], addressBalance = '0') {
  const sui = createSuiEndpointSnapshot([{ network: 'testnet' } as unknown as SuiGrpcClient]);
  const coins = pages.flatMap((page) => page.objects);
  gatewayMocks.listAllSuiCoins.mockReset().mockResolvedValue(coins);
  gatewayMocks.getSuiBalance.mockReset().mockResolvedValue({
    coinType: SETTLEMENT_TOKEN,
    balance: addressBalance,
    coinBalance: '0',
    addressBalance,
  });
  return {
    sui,
    listCoins: gatewayMocks.listAllSuiCoins,
    getBalance: gatewayMocks.getSuiBalance,
  };
}

function trace(tx: Transaction = new Transaction()) {
  return traceUserPrefixValue(tx, SETTLEMENT_TOKEN);
}

async function resolve(sui: SuiEndpointSnapshot, tx: Transaction, required: bigint) {
  return resolvePaymentSource(sui, OWNER, SETTLEMENT_TOKEN, required, 'SUI', trace(tx));
}

describe('resolvePaymentSource — exact prefix value', () => {
  it('subtracts an exact Pure u64 split debit and rejects a one-unit shortfall', async () => {
    const tx = new Transaction();
    tx.splitCoins(tx.object(COIN_A), [100n]);

    const exact = mockSui([{ objects: [{ objectId: COIN_A, balance: '1000' }] }]);
    await expect(resolve(exact.sui, tx, 900n)).resolves.toEqual({
      source: 'coin_object',
      baseCoinId: COIN_A,
      mergeCoinIds: [],
      remainingBalance: 900n,
    });
    expect(exact.listCoins).toHaveBeenCalledWith(exact.sui, {
      owner: OWNER,
      coinType: SETTLEMENT_TOKEN,
    });
    expect(exact.getBalance).not.toHaveBeenCalled();

    const short = mockSui([{ objects: [{ objectId: COIN_A, balance: '1000' }] }], '0');
    await expect(resolve(short.sui, tx, 901n)).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
  });

  it('excludes a direct source whose split amount is not a Pure u64', async () => {
    const tx = new Transaction();
    const dynamicAmount = tx.moveCall({ target: '0x2::example::dynamic_amount' });
    tx.splitCoins(tx.object(COIN_A), [dynamicAmount]);
    const mock = mockSui([{ objects: [{ objectId: COIN_A, balance: '1000' }] }], '0');

    await expect(resolve(mock.sui, tx, 1n)).rejects.toMatchObject({
      code: 'PAYMENT_COIN_CONFLICT',
    });
  });

  it('credits a split source merged into another direct coin after applying its debit once', async () => {
    const tx = new Transaction();
    tx.splitCoins(tx.object(COIN_A), [100n]);
    tx.mergeCoins(tx.object(COIN_B), [tx.object(COIN_A)]);
    const mock = mockSui([
      {
        objects: [
          { objectId: COIN_A, balance: '1000' },
          { objectId: COIN_B, balance: '200' },
        ],
      },
    ]);

    await expect(resolve(mock.sui, tx, 1_100n)).resolves.toEqual({
      source: 'coin_object',
      baseCoinId: COIN_B,
      mergeCoinIds: [],
      remainingBalance: 1_100n,
    });
  });

  it('keeps a zero-balance snapshot present when it becomes a merge destination', async () => {
    const tx = new Transaction();
    tx.mergeCoins(tx.object(COIN_A), [tx.object(COIN_B)]);
    const mock = mockSui([
      {
        objects: [
          { objectId: COIN_A, balance: '0' },
          { objectId: COIN_B, balance: '100' },
        ],
      },
    ]);

    await expect(resolve(mock.sui, tx, 100n)).resolves.toEqual({
      source: 'coin_object',
      baseCoinId: COIN_A,
      mergeCoinIds: [],
      remainingBalance: 100n,
    });
  });

  it('rejects a command-time oversplit even when a later merge hides the final deficit', async () => {
    const tx = new Transaction();
    tx.splitCoins(tx.object(COIN_A), [200n]);
    tx.mergeCoins(tx.object(COIN_A), [tx.object(COIN_B)]);
    const mock = mockSui([
      {
        objects: [
          { objectId: COIN_A, balance: '100' },
          { objectId: COIN_B, balance: '1000' },
        ],
      },
    ]);

    await expect(resolve(mock.sui, tx, 1n)).rejects.toMatchObject({
      code: 'PAYMENT_COIN_CONFLICT',
    });
  });

  it('rejects a command-time merge that overflows u64', async () => {
    const tx = new Transaction();
    tx.mergeCoins(tx.object(COIN_A), [tx.object(COIN_B)]);
    tx.splitCoins(tx.object(COIN_A), [1n]);
    const mock = mockSui([
      {
        objects: [
          { objectId: COIN_A, balance: ((1n << 64n) - 1n).toString() },
          { objectId: COIN_B, balance: '1' },
        ],
      },
    ]);

    await expect(resolve(mock.sui, tx, 1n)).rejects.toMatchObject({
      code: 'PAYMENT_COIN_CONFLICT',
    });
  });

  it('keeps a split output independent while preserving total value across both survivors', async () => {
    const tx = new Transaction();
    const [splitOutput] = tx.splitCoins(tx.object(COIN_A), [100n]);
    tx.mergeCoins(tx.object(COIN_B), [splitOutput]);
    const mock = mockSui([
      {
        objects: [
          { objectId: COIN_A, balance: '1000' },
          { objectId: COIN_B, balance: '200' },
        ],
      },
    ]);

    await expect(resolve(mock.sui, tx, 1_200n)).resolves.toEqual({
      source: 'coin_object',
      baseCoinId: COIN_A,
      mergeCoinIds: [COIN_B],
      remainingBalance: 1_200n,
    });
  });

  it('carries every snapshot balance through chained merges exactly once', async () => {
    const tx = new Transaction();
    tx.mergeCoins(tx.object(COIN_A), [tx.object(COIN_B)]);
    tx.mergeCoins(tx.object(COIN_C), [tx.object(COIN_A)]);
    const mock = mockSui([
      {
        objects: [
          { objectId: COIN_A, balance: '100' },
          { objectId: COIN_B, balance: '200' },
          { objectId: COIN_C, balance: '300' },
        ],
      },
    ]);

    await expect(resolve(mock.sui, tx, 600n)).resolves.toEqual({
      source: 'coin_object',
      baseCoinId: COIN_C,
      mergeCoinIds: [],
      remainingBalance: 600n,
    });
  });

  it('excludes a merge destination that is later transferred or passed to a MoveCall', async () => {
    const transferred = new Transaction();
    transferred.mergeCoins(transferred.object(COIN_A), [transferred.object(COIN_B)]);
    transferred.transferObjects([transferred.object(COIN_A)], RECIPIENT);

    const called = new Transaction();
    called.mergeCoins(called.object(COIN_A), [called.object(COIN_B)]);
    called.moveCall({
      target: '0x2::example::mutate_coin',
      arguments: [called.object(COIN_A)],
    });

    for (const tx of [transferred, called]) {
      const mock = mockSui(
        [
          {
            objects: [
              { objectId: COIN_A, balance: '500' },
              { objectId: COIN_B, balance: '500' },
            ],
          },
        ],
        '0',
      );
      await expect(resolve(mock.sui, tx, 1n)).rejects.toMatchObject({
        code: 'PAYMENT_COIN_CONFLICT',
      });
    }
  });
});

describe('resolvePaymentSource — address balance and mixed funding', () => {
  it('subtracts a same-token Sender withdrawal exactly once at the availability boundary', async () => {
    const tx = new Transaction();
    tx.withdrawal({ amount: 3_000n, type: SETTLEMENT_TOKEN });
    const exact = mockSui([{ objects: [] }], '10000');

    expect(trace(tx).senderWithdrawalDebit).toBe(3_000n);
    await expect(resolve(exact.sui, tx, 7_000n)).resolves.toEqual({
      source: 'address_balance',
      redeemAmount: 7_000n,
    });
    expect(exact.listCoins).toHaveBeenCalledWith(exact.sui, {
      owner: OWNER,
      coinType: SETTLEMENT_TOKEN,
    });
    expect(exact.getBalance).toHaveBeenCalledWith(exact.sui, {
      owner: OWNER,
      coinType: SETTLEMENT_TOKEN,
    });

    const oneUnitShort = mockSui([{ objects: [] }], '10000');
    await expect(resolve(oneUnitShort.sui, tx, 7_001n)).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
  });

  it('freezes exact mixed-topup object IDs, remaining balance, and redeem amount', async () => {
    const tx = new Transaction();
    const [spent] = tx.splitCoins(tx.object(COIN_A), [1_000n]);
    tx.transferObjects([spent], RECIPIENT);
    tx.withdrawal({ amount: 2_000n, type: SETTLEMENT_TOKEN });
    const mock = mockSui(
      [
        {
          objects: [
            { objectId: COIN_C, balance: '1000' },
            { objectId: COIN_A, balance: '5000' },
          ],
        },
      ],
      '4000',
    );

    await expect(resolve(mock.sui, tx, 6_500n)).resolves.toEqual({
      source: 'mixed_topup',
      baseCoinId: COIN_A,
      mergeCoinIds: [COIN_C],
      remainingBalance: 5_000n,
      redeemAmount: 1_500n,
    });
  });
});

describe('resolvePaymentSource — complete gateway coin snapshot', () => {
  it('selects exact sufficient value from the complete snapshot', async () => {
    const mock = mockSui([
      {
        objects: [{ objectId: COIN_A, balance: '1000' }],
      },
    ]);

    await expect(resolve(mock.sui, new Transaction(), 900n)).resolves.toMatchObject({
      source: 'coin_object',
      baseCoinId: COIN_A,
      remainingBalance: 1_000n,
    });
    expect(mock.listCoins).toHaveBeenCalledOnce();
  });

  it('applies prefix constraints across the complete snapshot', async () => {
    const tx = new Transaction();
    tx.splitCoins(tx.object(COIN_A), [100n]);
    const mock = mockSui([
      {
        objects: [{ objectId: COIN_C, balance: '1000' }],
      },
      {
        objects: [{ objectId: COIN_A, balance: '1000' }],
      },
    ]);

    await expect(resolve(mock.sui, tx, 500n)).resolves.toEqual({
      source: 'coin_object',
      baseCoinId: COIN_A,
      mergeCoinIds: [COIN_C],
      remainingBalance: 1_900n,
    });
    expect(mock.listCoins).toHaveBeenCalledOnce();
  });

  it('rejects a partially discovered merge constraint at pagination exhaustion', async () => {
    const tx = new Transaction();
    tx.mergeCoins(tx.object(COIN_A), [tx.object(COIN_B)]);
    const mock = mockSui([
      {
        objects: [
          { objectId: COIN_A, balance: '100' },
          { objectId: COIN_C, balance: '1000' },
        ],
      },
    ]);

    await expect(resolve(mock.sui, tx, 1n)).rejects.toMatchObject({
      code: 'PAYMENT_COIN_CONFLICT',
    });
  });

  it('combines all exact coin values returned by the gateway', async () => {
    const mock = mockSui([
      {
        objects: [{ objectId: COIN_A, balance: '400' }],
      },
      {
        objects: [{ objectId: COIN_B, balance: '600' }],
      },
    ]);

    await expect(resolve(mock.sui, new Transaction(), 1_000n)).resolves.toEqual({
      source: 'coin_object',
      baseCoinId: COIN_A,
      mergeCoinIds: [COIN_B],
      remainingBalance: 1_000n,
    });
    expect(mock.listCoins).toHaveBeenCalledOnce();
    expect(mock.getBalance).not.toHaveBeenCalled();
  });

  it('rejects duplicate object identity in the complete snapshot', async () => {
    const mock = mockSui([
      {
        objects: [{ objectId: COIN_A, balance: '400' }],
      },
      {
        objects: [{ objectId: COIN_A, balance: '400' }],
      },
    ]);

    await expect(resolve(mock.sui, new Transaction(), 1_000n)).rejects.toMatchObject({
      code: 'PAYMENT_COIN_CONFLICT',
    });
  });
});

describe('resolvePaymentSource — integer boundaries', () => {
  it('keeps balances above Number.MAX_SAFE_INTEGER exact as bigint', async () => {
    const exact = 9_007_199_254_740_993n;
    const mock = mockSui([{ objects: [{ objectId: COIN_A, balance: exact.toString() }] }]);

    await expect(resolve(mock.sui, new Transaction(), exact)).resolves.toMatchObject({
      source: 'coin_object',
      remainingBalance: exact,
    });
  });

  it('rejects required amounts outside u64 before querying Sui', async () => {
    const mock = mockSui([{ objects: [] }]);

    for (const invalid of [-1n, 1n << 64n]) {
      await expect(resolve(mock.sui, new Transaction(), invalid)).rejects.toMatchObject({
        code: 'INVALID_AMOUNT',
      });
    }
    expect(mock.listCoins).not.toHaveBeenCalled();
  });

  it('rejects non-decimal coin and address-balance strings', async () => {
    const badCoin = mockSui([{ objects: [{ objectId: COIN_A, balance: '0x10' }] }]);
    await expect(resolve(badCoin.sui, new Transaction(), 1n)).rejects.toMatchObject({
      code: 'INVALID_BALANCE_FORMAT',
    });

    const badAddress = mockSui([{ objects: [] }], '1e6');
    await expect(resolve(badAddress.sui, new Transaction(), 1n)).rejects.toMatchObject({
      code: 'INVALID_BALANCE_FORMAT',
    });
  });
});
