import { describe, expect, it } from 'vitest';
import type { Transaction } from '@mysten/sui/transactions';
import { SETTLE_MODULE, SETTLEMENT_SWAP_DIRECTION_FUNCTIONS } from '@stelis/contracts';
import type { HostValidationEnv } from '../src/types.js';
import {
  validateGenericSettlementTransaction,
  validateGenericUserTransactionKind,
} from '../src/validate/transactionKind.js';

const ENV: HostValidationEnv = {
  network: 'testnet',
  settlementPayoutRecipientAddress: '0xRELAYER',
  configId: '0xCONFIG',
  vaultRegistryId: '0xREGISTRY',
  packageId: '0xPACKAGE',
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
      package: '0xEXTERNAL',
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

  it('enforces MAX_COMMANDS through the shared user command validator', () => {
    const maxCommands = Array.from({ length: 16 }, () => moveCall());
    expect(validateGenericUserTransactionKind(txWithData(maxCommands), ENV, PAYMENT_TYPE)).toEqual({
      ok: true,
    });

    const tooManyCommands = Array.from({ length: 17 }, () => moveCall());
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
            objects: [{ $kind: 'GasCoin' }],
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
    ['Publish', { $kind: 'Publish', Publish: {} }],
    ['Upgrade', { $kind: 'Upgrade', Upgrade: {} }],
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
      txWithData([], [fundsWithdrawal({ Sponsor: true })]),
      ENV,
      PAYMENT_TYPE,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('P1_SPONSOR_WITHDRAWAL_FORBIDDEN');
  });

  it('rejects malformed same-token FundsWithdrawal(Sender)', () => {
    const result = validateGenericUserTransactionKind(
      txWithData([], [fundsWithdrawal({ Sender: true }, PAYMENT_TYPE, '0x10')]),
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
          fundsWithdrawal({ Sender: true }, PAYMENT_TYPE, '5000000'),
          fundsWithdrawal({ Sender: true }, OTHER_TYPE, '7000000'),
        ],
      ),
      ENV,
      PAYMENT_TYPE,
    );

    expect(result).toEqual({ ok: true });
  });
});

describe('validateGenericSettlementTransaction', () => {
  it('accepts final transactions with one settlement call and relayer-created Sender withdrawal', () => {
    const result = validateGenericSettlementTransaction(
      txWithData([settleCall()], [fundsWithdrawal({ Sender: true }, PAYMENT_TYPE, '5000000')]),
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
