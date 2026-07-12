import { describe, expect, it } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiObjectId } from '@mysten/sui/utils';
import {
  PrefixValueTraceError,
  traceUserPrefixValue,
  type DirectCoinTrace,
  type PrefixValueTrace,
} from '../src/prefixValueTrace.js';

const COIN_A = `0x${'aa'.repeat(32)}`;
const COIN_B = `0x${'bb'.repeat(32)}`;
const COIN_C = `0x${'cc'.repeat(32)}`;
const RECIPIENT = `0x${'01'.repeat(32)}`;
const SETTLEMENT_TOKEN = '0x2::sui::SUI';
const OTHER_TOKEN = `0x${'dd'.repeat(32)}::token::TOKEN`;

function trace(tx: Transaction): PrefixValueTrace {
  return traceUserPrefixValue(tx, SETTLEMENT_TOKEN);
}

function directCoin(result: PrefixValueTrace, objectId: string): DirectCoinTrace {
  const normalizedId = normalizeSuiObjectId(objectId);
  const coin = result.directCoins.get(normalizedId);
  if (!coin) throw new Error(`Missing direct coin trace for ${normalizedId}`);
  return coin;
}

function survivingValue(result: PrefixValueTrace, objectId: string) {
  const coin = directCoin(result, objectId);
  if (coin.status !== 'surviving') {
    throw new Error(`Expected ${normalizeSuiObjectId(objectId)} to survive, got ${coin.status}`);
  }
  return coin.value;
}

describe('traceUserPrefixValue — command-ordered coin value', () => {
  it('subtracts canonical Pure u64 split amounts from a normalized direct source', () => {
    const tx = new Transaction();
    tx.splitCoins(tx.object('0xaa'), [100n, 25n]);

    const result = trace(tx);
    const objectId = normalizeSuiObjectId('0xaa');
    expect(result.directCoins.get(objectId)).toEqual({
      status: 'surviving',
      value: { snapshotCoinIds: [objectId], delta: -125n },
    });
    expect(result.valueConstraints).toEqual([
      { commandIndex: 0, value: { snapshotCoinIds: [objectId], delta: -125n } },
    ]);
  });

  it('keeps a split source alive and moves the new output value into a merge destination', () => {
    const tx = new Transaction();
    const [splitOutput] = tx.splitCoins(tx.object(COIN_A), [100n]);
    tx.mergeCoins(tx.object(COIN_B), [splitOutput]);

    const result = trace(tx);
    expect(survivingValue(result, COIN_A)).toEqual({
      snapshotCoinIds: [COIN_A],
      delta: -100n,
    });
    expect(survivingValue(result, COIN_B)).toEqual({
      snapshotCoinIds: [COIN_B],
      delta: 100n,
    });
    expect(result.valueConstraints).toEqual([
      { commandIndex: 0, value: { snapshotCoinIds: [COIN_A], delta: -100n } },
      {
        commandIndex: 1,
        value: { snapshotCoinIds: [COIN_B], delta: 100n },
      },
    ]);
  });

  it('does not taint the direct source when a derived split output enters a MoveCall', () => {
    const tx = new Transaction();
    const [splitOutput] = tx.splitCoins(tx.object(COIN_A), [100n]);
    tx.moveCall({ target: '0x2::example::use_coin', arguments: [splitOutput] });

    expect(survivingValue(trace(tx), COIN_A)).toEqual({
      snapshotCoinIds: [COIN_A],
      delta: -100n,
    });
  });

  it('carries all exact snapshot components through chained merges', () => {
    const tx = new Transaction();
    tx.mergeCoins(tx.object(COIN_A), [tx.object(COIN_B)]);
    tx.mergeCoins(tx.object(COIN_C), [tx.object(COIN_A)]);

    const result = trace(tx);
    expect(directCoin(result, COIN_A)).toEqual({ status: 'consumed' });
    expect(directCoin(result, COIN_B)).toEqual({ status: 'consumed' });
    expect(survivingValue(result, COIN_C)).toEqual({
      snapshotCoinIds: [COIN_A, COIN_B, COIN_C].sort(),
      delta: 0n,
    });
  });

  it('rejects a repeated merge source inside one command', () => {
    const tx = new Transaction();
    tx.mergeCoins(tx.object(COIN_A), [tx.object(COIN_B), tx.object(COIN_B)]);

    expect(() => trace(tx)).toThrowError(PrefixValueTraceError);
    try {
      trace(tx);
      expect.unreachable('expected duplicate merge source rejection');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'DUPLICATE_MERGE_SOURCE',
        sourceKey: `object:${COIN_B}`,
      });
    }
  });

  it('rejects a repeated merge source across commands', () => {
    const tx = new Transaction();
    tx.mergeCoins(tx.object(COIN_A), [tx.object(COIN_B)]);
    tx.mergeCoins(tx.object(COIN_C), [tx.object(COIN_B)]);

    expect(() => trace(tx)).toThrowError(PrefixValueTraceError);
  });

  it('rejects a repeated derived merge source', () => {
    const tx = new Transaction();
    const [splitOutput] = tx.splitCoins(tx.object(COIN_A), [100n]);
    tx.mergeCoins(tx.object(COIN_B), [splitOutput, splitOutput]);

    expect(() => trace(tx)).toThrowError(PrefixValueTraceError);
    try {
      trace(tx);
      expect.unreachable('expected duplicate derived merge source rejection');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'DUPLICATE_MERGE_SOURCE',
        sourceKey: 'result:0:0',
      });
    }
  });

  it('makes a direct source opaque when a split amount is dynamic', () => {
    const tx = new Transaction();
    const dynamicAmount = tx.moveCall({ target: '0x2::example::dynamic_amount' });
    tx.splitCoins(tx.object(COIN_A), [dynamicAmount]);

    expect(directCoin(trace(tx), COIN_A)).toEqual({ status: 'opaque' });
  });

  it('marks a merged destination consumed after transfer and opaque after MoveCall', () => {
    const transferred = new Transaction();
    transferred.mergeCoins(transferred.object(COIN_A), [transferred.object(COIN_B)]);
    transferred.transferObjects([transferred.object(COIN_A)], RECIPIENT);

    const transferredTrace = trace(transferred);
    expect(directCoin(transferredTrace, COIN_A)).toEqual({ status: 'consumed' });
    expect(directCoin(transferredTrace, COIN_B)).toEqual({ status: 'consumed' });

    const called = new Transaction();
    called.mergeCoins(called.object(COIN_A), [called.object(COIN_B)]);
    called.moveCall({
      target: '0x2::example::mutate_coin',
      arguments: [called.object(COIN_A)],
    });

    const calledTrace = trace(called);
    expect(directCoin(calledTrace, COIN_A)).toEqual({ status: 'opaque' });
    expect(directCoin(calledTrace, COIN_B)).toEqual({ status: 'consumed' });
  });

  it('consumes direct inputs when MakeMoveVec moves them into a derived vector', () => {
    const tx = new Transaction();
    tx.makeMoveVec({ elements: [tx.object(COIN_A), tx.object(COIN_B)] });

    const result = trace(tx);
    expect(directCoin(result, COIN_A)).toEqual({ status: 'consumed' });
    expect(directCoin(result, COIN_B)).toEqual({ status: 'consumed' });
  });
});

describe('traceUserPrefixValue — Sender address-balance debit', () => {
  it('sums only same-token Sender reservations once per input', () => {
    const tx = new Transaction();
    tx.withdrawal({ amount: 3_000n, type: SETTLEMENT_TOKEN });
    tx.withdrawal({ amount: 7_000n, type: SETTLEMENT_TOKEN });
    tx.withdrawal({ amount: 50_000n, type: OTHER_TOKEN });

    expect(trace(tx)).toMatchObject({
      senderWithdrawalDebit: 10_000n,
      unaccountableSenderWithdrawal: false,
    });
  });
});
