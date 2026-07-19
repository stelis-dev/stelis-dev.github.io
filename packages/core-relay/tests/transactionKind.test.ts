import { describe, expect, it } from 'vitest';
import type { Transaction } from '@mysten/sui/transactions';
import { SETTLE_MODULE, SETTLEMENT_SWAP_DIRECTION_FUNCTIONS } from '@stelis/contracts';
import type { HostValidationEnv } from '../src/types.js';
import {
  validateGenericSettlementTransaction,
  validateGenericUserTransactionKind,
} from '../src/validate/transactionKind.js';

const objectId = (byte: string): string => `0x${byte.repeat(64)}`;

const ENV: HostValidationEnv = {
  network: 'testnet',
  settlementPayoutRecipientAddress: objectId('1'),
  configId: objectId('2'),
  vaultRegistryId: objectId('3'),
  packageId: objectId('4'),
};

const PAYMENT_TYPE = '0x2::sui::SUI';
const OTHER_TYPE = '0x3::other::OTHER';

function txWithData(
  commands: Array<Record<string, unknown>>,
  inputs: Array<Record<string, unknown>> = [],
): Transaction {
  return {
    getData: () => ({ commands, inputs }),
  } as unknown as Transaction;
}

function moveCall(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    $kind: 'MoveCall',
    MoveCall: {
      package: objectId('5'),
      module: 'market',
      function: 'buy',
      typeArguments: [],
      arguments: [],
      ...overrides,
    },
  };
}

function settleCall(): Record<string, unknown> {
  return moveCall({
    package: ENV.packageId,
    module: SETTLE_MODULE,
    function: SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser,
  });
}

function vaultWithdrawCall(): Record<string, unknown> {
  return moveCall({
    package: ENV.packageId,
    module: 'vault',
    function: 'withdraw',
  });
}

function fundsWithdrawal(
  withdrawFrom: Record<string, unknown>,
  type = PAYMENT_TYPE,
  amount = '5000000',
): Record<string, unknown> {
  return {
    $kind: 'FundsWithdrawal',
    FundsWithdrawal: {
      reservation: { $kind: 'MaxAmountU64', MaxAmountU64: amount },
      typeArg: { $kind: 'Balance', Balance: type },
      withdrawFrom,
    },
  };
}

describe('validateGenericUserTransactionKind', () => {
  it('accepts external MoveCalls and vault::withdraw without settlement', () => {
    const result = validateGenericUserTransactionKind(
      txWithData([moveCall(), vaultWithdrawCall()]),
      ENV,
      PAYMENT_TYPE,
    );

    expect(result).toEqual({ ok: true });
  });

  it('accepts 11 user commands and rejects 12 through the shared validator', () => {
    const maxCommands = Array.from({ length: 11 }, () => moveCall());
    expect(validateGenericUserTransactionKind(txWithData(maxCommands), ENV, PAYMENT_TYPE)).toEqual({
      ok: true,
    });

    const tooManyCommands = Array.from({ length: 12 }, () => moveCall());
    const result = validateGenericUserTransactionKind(
      txWithData(tooManyCommands),
      ENV,
      PAYMENT_TYPE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_TOO_MANY_COMMANDS');
  });

  it('rejects user-supplied settlement calls', () => {
    const result = validateGenericUserTransactionKind(
      txWithData([settleCall()]),
      ENV,
      PAYMENT_TYPE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_USER_SETTLE_FORBIDDEN');
  });

  it('rejects GasCoin references in user commands', () => {
    const result = validateGenericUserTransactionKind(
      txWithData([
        {
          $kind: 'TransferObjects',
          TransferObjects: {
            objects: [{ $kind: 'GasCoin', GasCoin: true }],
            address: { $kind: 'Input', Input: 0 },
          },
        },
      ]),
      ENV,
      PAYMENT_TYPE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_GASCOIN_FORBIDDEN');
  });

  it.each([
    ['Publish', { $kind: 'Publish', Publish: { modules: ['AA=='], dependencies: [] } }],
    [
      'Upgrade',
      {
        $kind: 'Upgrade',
        Upgrade: {
          modules: ['AA=='],
          dependencies: [],
          package: objectId('5'),
          ticket: { $kind: 'Input', Input: 0 },
        },
      },
    ],
  ])('rejects forbidden non-MoveCall command %s', (_kind, command) => {
    const result = validateGenericUserTransactionKind(txWithData([command]), ENV, PAYMENT_TYPE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_FORBIDDEN_COMMAND');
  });

  it('rejects unauthorized Stelis package calls', () => {
    const result = validateGenericUserTransactionKind(
      txWithData([moveCall({ package: ENV.packageId, module: 'config', function: 'set_fee' })]),
      ENV,
      PAYMENT_TYPE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_UNAUTHORIZED_STELIS_CALL');
  });

  it('rejects FundsWithdrawal(Sponsor)', () => {
    const result = validateGenericUserTransactionKind(
      txWithData([], [fundsWithdrawal({ $kind: 'Sponsor', Sponsor: true })]),
      ENV,
      PAYMENT_TYPE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_SPONSOR_WITHDRAWAL_FORBIDDEN');
  });

  it('does not let an over-cap prefix mask FundsWithdrawal(Sponsor)', () => {
    const result = validateGenericUserTransactionKind(
      txWithData(
        Array.from({ length: 12 }, () => moveCall()),
        [fundsWithdrawal({ $kind: 'Sponsor', Sponsor: true })],
      ),
      ENV,
      PAYMENT_TYPE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_SPONSOR_WITHDRAWAL_FORBIDDEN');
  });

  it('rejects malformed same-token FundsWithdrawal(Sender)', () => {
    const result = validateGenericUserTransactionKind(
      txWithData([], [fundsWithdrawal({ $kind: 'Sender', Sender: true }, PAYMENT_TYPE, '0x10')]),
      ENV,
      PAYMENT_TYPE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNACCOUNTABLE_WITHDRAWAL');
  });

  it('does not let an over-cap prefix mask an unaccountable Sender withdrawal', () => {
    const result = validateGenericUserTransactionKind(
      txWithData(
        Array.from({ length: 12 }, () => moveCall()),
        [fundsWithdrawal({ $kind: 'Sender', Sender: true }, PAYMENT_TYPE, '0x10')],
      ),
      ENV,
      PAYMENT_TYPE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNACCOUNTABLE_WITHDRAWAL');
  });

  it('accepts bounded same-token and different-token FundsWithdrawal(Sender)', () => {
    const result = validateGenericUserTransactionKind(
      txWithData(
        [],
        [
          fundsWithdrawal({ $kind: 'Sender', Sender: true }, PAYMENT_TYPE, '5000000'),
          fundsWithdrawal({ $kind: 'Sender', Sender: true }, OTHER_TYPE, '7000000'),
        ],
      ),
      ENV,
      PAYMENT_TYPE,
    );

    expect(result).toEqual({ ok: true });
  });
});

describe('validateGenericSettlementTransaction', () => {
  it('accepts final transactions with one settlement call and Host-created Sender withdrawal', () => {
    const result = validateGenericSettlementTransaction(
      txWithData(
        [settleCall()],
        [fundsWithdrawal({ $kind: 'Sender', Sender: true }, PAYMENT_TYPE, '5000000')],
      ),
      ENV,
    );

    expect(result).toEqual({ ok: true });
  });

  it('stays separate from user TransactionKind validation', () => {
    const tx = txWithData([settleCall()]);

    const userResult = validateGenericUserTransactionKind(tx, ENV, PAYMENT_TYPE);
    const finalResult = validateGenericSettlementTransaction(tx, ENV);

    expect(userResult.ok).toBe(false);
    if (!userResult.ok) expect(userResult.code).toBe('P1_USER_SETTLE_FORBIDDEN');
    expect(finalResult).toEqual({ ok: true });
  });

  it('rejects final transactions without a settlement call', () => {
    const result = validateGenericSettlementTransaction(txWithData([moveCall()]), ENV);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_NO_SETTLE');
  });

  it('rejects final transactions with multiple settlement calls', () => {
    const result = validateGenericSettlementTransaction(
      txWithData([settleCall(), settleCall()]),
      ENV,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('L1_MULTIPLE_SETTLE');
  });
});
