import { describe, expect, it, vi } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  createSuiEndpointSnapshot,
  traceUserPrefixValue,
  type PrefixValueTrace,
  type SuiEndpointSnapshot,
} from '@stelis/core-relay';
import { createPaymentSourceReader, resolvePaymentSource } from '../src/prepare/coinSelection.js';

const gatewayMocks = vi.hoisted(() => ({
  readBoundedSuiCoins: vi.fn(),
  getSuiBalance: vi.fn(),
}));

vi.mock('@stelis/core-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stelis/core-relay')>()),
  readBoundedSuiCoins: gatewayMocks.readBoundedSuiCoins,
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

function mockSui(
  pages: readonly CoinPage[],
  addressBalance = '0',
  status: 'complete' | 'limit_exceeded' = 'complete',
) {
  const sui = createSuiEndpointSnapshot([{ network: 'testnet' } as unknown as SuiGrpcClient]);
  const coins = pages.flatMap((page) => page.objects);
  gatewayMocks.readBoundedSuiCoins.mockReset().mockResolvedValue({ status, coins });
  gatewayMocks.getSuiBalance.mockReset().mockResolvedValue({
    coinType: SETTLEMENT_TOKEN,
    balance: addressBalance,
    coinBalance: '0',
    addressBalance,
  });
  return {
    sui,
    readCoins: gatewayMocks.readBoundedSuiCoins,
    getBalance: gatewayMocks.getSuiBalance,
  };
}

function trace(tx: Transaction = new Transaction()) {
  return traceUserPrefixValue(tx, SETTLEMENT_TOKEN);
}

async function resolve(sui: SuiEndpointSnapshot, tx: Transaction, required: bigint) {
  return resolvePaymentSource(
    createPaymentSourceReader(sui, OWNER, SETTLEMENT_TOKEN),
    required,
    'SUI',
    trace(tx),
  );
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
    expect(exact.readCoins).toHaveBeenCalledWith(exact.sui, {
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
    expect(exact.readCoins).toHaveBeenCalledWith(exact.sui, {
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

  it('does not add a zero-balance Coin to mixed funding', async () => {
    const mock = mockSui(
      [
        {
          objects: [
            { objectId: COIN_A, balance: '0' },
            { objectId: COIN_B, balance: '3' },
          ],
        },
      ],
      '2',
    );

    await expect(resolve(mock.sui, new Transaction(), 5n)).resolves.toEqual({
      source: 'mixed_topup',
      baseCoinId: COIN_B,
      mergeCoinIds: [],
      remainingBalance: 3n,
      redeemAmount: 2n,
    });
  });
});

describe('resolvePaymentSource — complete gateway coin snapshot', () => {
  it('reuses one request-local Coin read and address-balance read across resolutions', async () => {
    const mock = mockSui([{ objects: [{ objectId: COIN_A, balance: '1000' }] }], '1000');
    mock.readCoins
      .mockReset()
      .mockResolvedValueOnce({
        status: 'complete',
        coins: [{ objectId: COIN_A, balance: '1000' }],
      })
      .mockResolvedValue({
        status: 'complete',
        coins: [{ objectId: COIN_B, balance: '9999' }],
      });
    mock.getBalance
      .mockReset()
      .mockResolvedValueOnce({
        coinType: SETTLEMENT_TOKEN,
        balance: '1000',
        coinBalance: '0',
        addressBalance: '1000',
      })
      .mockResolvedValue({
        coinType: SETTLEMENT_TOKEN,
        balance: '9999',
        coinBalance: '0',
        addressBalance: '9999',
      });
    const reader = createPaymentSourceReader(mock.sui, OWNER, SETTLEMENT_TOKEN);

    expect(mock.readCoins).not.toHaveBeenCalled();
    expect(mock.getBalance).not.toHaveBeenCalled();
    await expect(resolvePaymentSource(reader, 900n, 'SUI', trace())).resolves.toMatchObject({
      source: 'coin_object',
      baseCoinId: COIN_A,
    });
    const [larger, smaller] = await Promise.all([
      resolvePaymentSource(reader, 1_500n, 'SUI', trace()),
      resolvePaymentSource(reader, 1_200n, 'SUI', trace()),
    ]);
    expect(larger).toEqual({
      source: 'mixed_topup',
      baseCoinId: COIN_A,
      mergeCoinIds: [],
      remainingBalance: 1_000n,
      redeemAmount: 500n,
    });
    expect(smaller).toMatchObject({
      source: 'mixed_topup',
      redeemAmount: 200n,
    });

    expect(mock.readCoins).toHaveBeenCalledTimes(1);
    expect(mock.getBalance).toHaveBeenCalledTimes(1);
  });

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
    expect(mock.readCoins).toHaveBeenCalledOnce();
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

    await expect(resolve(mock.sui, tx, 1_500n)).resolves.toEqual({
      source: 'coin_object',
      baseCoinId: COIN_A,
      mergeCoinIds: [COIN_C],
      remainingBalance: 1_900n,
    });
    expect(mock.readCoins).toHaveBeenCalledOnce();
  });

  it('prefers the first sufficient single coin over merging earlier fragments', async () => {
    const mock = mockSui([
      {
        objects: [
          { objectId: COIN_A, balance: '400' },
          { objectId: COIN_B, balance: '1000' },
          { objectId: COIN_C, balance: '600' },
        ],
      },
    ]);

    await expect(resolve(mock.sui, new Transaction(), 900n)).resolves.toEqual({
      source: 'coin_object',
      baseCoinId: COIN_B,
      mergeCoinIds: [],
      remainingBalance: 1_000n,
    });
    expect(mock.getBalance).not.toHaveBeenCalled();
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
    expect(mock.readCoins).toHaveBeenCalledOnce();
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

  it('does not report insufficient balance when only an overflowing merge would cover the amount', async () => {
    const u64Max = (1n << 64n) - 1n;
    const required = u64Max - 5n;
    const mock = mockSui([
      {
        objects: [
          { objectId: COIN_A, balance: (u64Max - 10n).toString() },
          { objectId: COIN_B, balance: '20' },
        ],
      },
    ]);

    await expect(resolve(mock.sui, new Transaction(), required)).rejects.toMatchObject({
      code: 'PAYMENT_COIN_CONFLICT',
    });
  });

  it('does not report insufficient balance when ordered selection cannot prove another safe subset', async () => {
    const u64Max = (1n << 64n) - 1n;
    const required = u64Max - 10n;
    const mock = mockSui([
      {
        objects: [
          { objectId: COIN_A, balance: '100' },
          { objectId: COIN_B, balance: (u64Max - 50n).toString() },
          { objectId: COIN_C, balance: '40' },
        ],
      },
    ]);

    await expect(resolve(mock.sui, new Transaction(), required)).rejects.toMatchObject({
      code: 'PAYMENT_COIN_CONFLICT',
      message: 'The bounded ordered SUI coin selection could not prove a u64-safe funding subset.',
    });
  });
});

describe('resolvePaymentSource — bounded partial coin snapshot', () => {
  it('uses a sufficient single coin without reading address balance', async () => {
    const mock = mockSui(
      [
        {
          objects: [
            { objectId: COIN_A, balance: '400' },
            { objectId: COIN_B, balance: '1000' },
          ],
        },
      ],
      '10000',
      'limit_exceeded',
    );

    await expect(resolve(mock.sui, new Transaction(), 900n)).resolves.toEqual({
      source: 'coin_object',
      baseCoinId: COIN_B,
      mergeCoinIds: [],
      remainingBalance: 1_000n,
    });
    expect(mock.getBalance).not.toHaveBeenCalled();
  });

  it('uses a sufficient safe subset and stops before address-balance fallback', async () => {
    const mock = mockSui(
      [
        {
          objects: [
            { objectId: COIN_A, balance: '400' },
            { objectId: COIN_B, balance: '600' },
            { objectId: COIN_C, balance: '500' },
          ],
        },
      ],
      '10000',
      'limit_exceeded',
    );

    await expect(resolve(mock.sui, new Transaction(), 1_000n)).resolves.toEqual({
      source: 'coin_object',
      baseCoinId: COIN_A,
      mergeCoinIds: [COIN_B],
      remainingBalance: 1_000n,
    });
    expect(mock.getBalance).not.toHaveBeenCalled();
  });

  it('allows an unrelated unresolved prefix value when the selected coin is fully resolved', async () => {
    const tx = new Transaction();
    tx.splitCoins(tx.object(COIN_A), [100n]);
    const mock = mockSui(
      [{ objects: [{ objectId: COIN_C, balance: '1000' }] }],
      '0',
      'limit_exceeded',
    );

    await expect(resolve(mock.sui, tx, 900n)).resolves.toEqual({
      source: 'coin_object',
      baseCoinId: COIN_C,
      mergeCoinIds: [],
      remainingBalance: 1_000n,
    });
    expect(mock.getBalance).not.toHaveBeenCalled();
  });

  it('rejects a selected Coin when its relevant command-time value is only partially resolved', async () => {
    const mock = mockSui(
      [{ objects: [{ objectId: COIN_A, balance: '1000' }] }],
      '10000',
      'limit_exceeded',
    );
    const prefixTrace: PrefixValueTrace = {
      directCoins: new Map(),
      valueConstraints: [
        {
          commandIndex: 0,
          value: { snapshotCoinIds: [COIN_A, COIN_B], delta: 0n },
        },
      ],
      senderWithdrawalDebit: 0n,
    };

    await expect(
      resolvePaymentSource(
        createPaymentSourceReader(mock.sui, OWNER, SETTLEMENT_TOKEN),
        1n,
        'SUI',
        prefixTrace,
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_COIN_LIMIT_EXCEEDED' });
    expect(mock.getBalance).not.toHaveBeenCalled();
  });

  it('never derives address funding or insufficient balance from a partial page', async () => {
    for (const addressBalance of ['10000', '0']) {
      const mock = mockSui([{ objects: [] }], addressBalance, 'limit_exceeded');

      await expect(resolve(mock.sui, new Transaction(), 1n)).rejects.toMatchObject({
        code: 'PAYMENT_COIN_LIMIT_EXCEEDED',
      });
      expect(mock.getBalance).not.toHaveBeenCalled();
    }
  });

  it('does not let an overflowing candidate hide a later sufficient single coin', async () => {
    const u64Max = (1n << 64n) - 1n;
    const required = u64Max - 5n;
    const mock = mockSui(
      [
        {
          objects: [
            { objectId: COIN_A, balance: (u64Max - 10n).toString() },
            { objectId: COIN_B, balance: '20' },
            { objectId: COIN_C, balance: required.toString() },
          ],
        },
      ],
      '0',
      'limit_exceeded',
    );

    await expect(resolve(mock.sui, new Transaction(), required)).resolves.toEqual({
      source: 'coin_object',
      baseCoinId: COIN_C,
      mergeCoinIds: [],
      remainingBalance: required,
    });
    expect(mock.getBalance).not.toHaveBeenCalled();
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

  it('rejects non-positive or out-of-range required amounts before querying Sui', async () => {
    const mock = mockSui([{ objects: [] }]);

    for (const invalid of [-1n, 0n, 1n << 64n]) {
      await expect(resolve(mock.sui, new Transaction(), invalid)).rejects.toMatchObject({
        code: 'INVALID_AMOUNT',
      });
    }
    expect(mock.readCoins).not.toHaveBeenCalled();
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
