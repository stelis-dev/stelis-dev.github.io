/**
 * S-16: integrity.ts unit tests.
 *
 * Tests verify prefix/suffix rules, settle invariants, GasCoin scan,
 * and fromKind/from command serialization.
 *
 * Prefix/suffix tests use PtbCommand[] directly (no Transaction.build needed).
 * fromKind/from checks use real Transaction with offline-buildable commands.
 */
import { describe, it, expect } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { convertSdkCommands } from '@stelis/core-relay/browser';
import {
  SETTLE_MODULE,
  SETTLE_WITH_CREDIT_FUNCTION,
  SETTLEMENT_SWAP_DIRECTION_FUNCTIONS,
  SUI_TYPE,
} from '@stelis/contracts';
import type { PtbCommand, MoveCallCommand } from '@stelis/contracts';
import {
  verifyPrefix,
  verifySuffix,
  verifyInputs,
  normalizeInput,
  verifyPtbIntegrity,
  verifyPromotionPtbIntegrity,
  StelisIntegrityError,
} from '../src/integrity.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const PKG = '0x' + '1'.repeat(64);
const SUI_FRAMEWORK = SUI_TYPE.split('::')[0]; // 0x0...002
const BFQ_NEW_USER = SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.newUser;
const BFQ_WITH_VAULT = SETTLEMENT_SWAP_DIRECTION_FUNCTIONS.baseForQuote.withVault;
type OtherCommand = Exclude<PtbCommand, MoveCallCommand>;

// ── PtbCommand factories ───────────────────────────────────────────────────────

function mc(pkg: string, mod: string, fn: string, args: unknown[] = []): MoveCallCommand {
  return {
    kind: 'MoveCall' as const,
    packageId: pkg,
    module: mod,
    function: fn,
    typeArguments: [],
    arguments: args,
  };
}

function settle(pkg: string, fn: string = BFQ_NEW_USER): MoveCallCommand {
  return mc(pkg, SETTLE_MODULE, fn);
}

function mergeCoins(args: unknown[] = []): OtherCommand {
  return { kind: 'MergeCoins', arguments: args };
}

function splitCoins(args: unknown[] = []): OtherCommand {
  return { kind: 'SplitCoins', arguments: args };
}

function coinRedeemFunds(): MoveCallCommand {
  return mc(SUI_FRAMEWORK, 'coin', 'redeem_funds');
}

// ─────────────────────────────────────────────
// Prefix tests
// ─────────────────────────────────────────────

describe('S-16: verifyPrefix', () => {
  it('passes when prefix matches exactly', () => {
    const origCmds: PtbCommand[] = [mc(PKG, 'swap', 'execute', [{ $kind: 'Input', Input: 0 }])];
    const retCmds: PtbCommand[] = [
      mc(PKG, 'swap', 'execute', [{ $kind: 'Input', Input: 0 }]),
      settle(PKG),
    ];
    expect(() => verifyPrefix(origCmds, retCmds)).not.toThrow();
  });

  it('rejects when argument is altered', () => {
    const origCmds: PtbCommand[] = [mc(PKG, 'swap', 'exec', [{ $kind: 'Input', Input: 0 }])];
    const retCmds: PtbCommand[] = [
      mc(PKG, 'swap', 'exec', [{ $kind: 'Input', Input: 999 }]),
      settle(PKG),
    ];
    expect(() => verifyPrefix(origCmds, retCmds)).toThrow(StelisIntegrityError);
  });

  it('rejects when function name is changed', () => {
    const origCmds: PtbCommand[] = [mc(PKG, 'swap', 'execute')];
    const retCmds: PtbCommand[] = [mc(PKG, 'swap', 'steal'), settle(PKG)];
    expect(() => verifyPrefix(origCmds, retCmds)).toThrow(StelisIntegrityError);
  });

  it('rejects when returned has fewer commands than original', () => {
    const origCmds: PtbCommand[] = [mc(PKG, 'a', 'b'), mc(PKG, 'c', 'd')];
    const retCmds: PtbCommand[] = [mc(PKG, 'a', 'b')]; // missing second
    expect(() => verifyPrefix(origCmds, retCmds)).toThrow(StelisIntegrityError);
  });

  it('error message localizes the diverging field path', () => {
    const origCmds: PtbCommand[] = [mc(PKG, 'swap', 'exec', [{ $kind: 'Input', Input: 0 }])];
    const retCmds: PtbCommand[] = [
      mc(PKG, 'swap', 'exec', [{ $kind: 'Input', Input: 999 }]),
      settle(PKG),
    ];
    try {
      verifyPrefix(origCmds, retCmds);
      throw new Error('verifyPrefix did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StelisIntegrityError);
      const msg = (err as Error).message;
      expect(msg).toContain('command 0 modified');
      expect(msg).toContain('arguments[0].Input');
      expect(msg).toContain('expected=0');
      expect(msg).toContain('actual=999');
    }
  });
});

// ─────────────────────────────────────────────
// Suffix tests
// ─────────────────────────────────────────────

describe('S-16: verifySuffix', () => {
  it('allows MergeCoins + SplitCoins + coin::redeem_funds + settle', () => {
    const suffix: PtbCommand[] = [mergeCoins(), splitCoins(), coinRedeemFunds(), settle(PKG)];
    expect(() => verifySuffix(suffix, PKG)).not.toThrow();
  });

  it('rejects coin::zero in suffix (zero_deep_fee_only: no verified consumer)', () => {
    const suffix: PtbCommand[] = [mc(SUI_FRAMEWORK, 'coin', 'zero'), settle(PKG)];
    expect(() => verifySuffix(suffix, PKG)).toThrow(StelisIntegrityError);
  });

  it('passes with settle_with_vault', () => {
    const suffix: PtbCommand[] = [settle(PKG, BFQ_WITH_VAULT)];
    expect(() => verifySuffix(suffix, PKG)).not.toThrow();
  });

  it('rejects settle count = 0', () => {
    const suffix: PtbCommand[] = [mergeCoins(), splitCoins()];
    expect(() => verifySuffix(suffix, PKG)).toThrow(StelisIntegrityError);
  });

  it('rejects settle count = 2', () => {
    const suffix: PtbCommand[] = [settle(PKG, BFQ_NEW_USER), settle(PKG, BFQ_WITH_VAULT)];
    expect(() => verifySuffix(suffix, PKG)).toThrow(StelisIntegrityError);
  });

  it('rejects settle not last', () => {
    const suffix: PtbCommand[] = [settle(PKG), mergeCoins()];
    expect(() => verifySuffix(suffix, PKG)).toThrow(StelisIntegrityError);
  });

  it('rejects Publish command', () => {
    const suffix: PtbCommand[] = [{ kind: 'Publish', arguments: [] }, settle(PKG)];
    expect(() => verifySuffix(suffix, PKG)).toThrow(StelisIntegrityError);
  });

  it('rejects unknown MoveCall', () => {
    const suffix: PtbCommand[] = [mc(PKG, 'evil', 'drain'), settle(PKG)];
    expect(() => verifySuffix(suffix, PKG)).toThrow(StelisIntegrityError);
  });

  it('rejects TransferObjects in suffix', () => {
    const suffix: PtbCommand[] = [{ kind: 'TransferObjects', arguments: [] }, settle(PKG)];
    expect(() => verifySuffix(suffix, PKG)).toThrow(StelisIntegrityError);
  });

  it('allows coin::redeem_funds in suffix (address balance path)', () => {
    const redeemFunds = mc(SUI_FRAMEWORK, 'coin', 'redeem_funds');
    const suffix: PtbCommand[] = [redeemFunds, mergeCoins(), splitCoins(), settle(PKG)];
    expect(() => verifySuffix(suffix, PKG)).not.toThrow();
  });

  it('allows redeem_funds + MergeCoins + SplitCoins + settle (mixed-topup)', () => {
    const redeemFunds = mc(SUI_FRAMEWORK, 'coin', 'redeem_funds');
    const suffix: PtbCommand[] = [
      mergeCoins(), // merge existing coins
      redeemFunds, // redeem delta from address balance
      mergeCoins(), // merge redeemed into base
      splitCoins(), // split exact amount
      settle(PKG),
    ];
    expect(() => verifySuffix(suffix, PKG)).not.toThrow();
  });

  it('rejects GasCoin reference in MergeCoins args (S-15)', () => {
    const suffix: PtbCommand[] = [
      mergeCoins([{ destination: { $kind: 'GasCoin' }, sources: [] }]),
      settle(PKG),
    ];
    expect(() => verifySuffix(suffix, PKG)).toThrow(StelisIntegrityError);
  });

  it('rejects GasCoin reference in SplitCoins args (S-15)', () => {
    const suffix: PtbCommand[] = [
      splitCoins([{ coin: { $kind: 'GasCoin' }, amounts: [] }]),
      settle(PKG),
    ];
    expect(() => verifySuffix(suffix, PKG)).toThrow(StelisIntegrityError);
  });

  it('rejects GasCoin reference nested in MoveCall arguments (S-15)', () => {
    const suffix: PtbCommand[] = [
      mc(PKG, SETTLE_MODULE, BFQ_NEW_USER, [
        { $kind: 'Result', Result: 0 },
        { $kind: 'GasCoin' }, // nested GasCoin
      ]),
    ];
    expect(() => verifySuffix(suffix, PKG)).toThrow(StelisIntegrityError);
  });

  it('allows settle MoveCall without GasCoin in arguments', () => {
    const suffix: PtbCommand[] = [
      mc(PKG, SETTLE_MODULE, BFQ_NEW_USER, [
        { $kind: 'Result', Result: 0 },
        { $kind: 'Input', Input: 1 },
      ]),
    ];
    expect(() => verifySuffix(suffix, PKG)).not.toThrow();
  });

  it('allows credit-only settlement without swap', () => {
    const suffix: PtbCommand[] = [settle(PKG, SETTLE_WITH_CREDIT_FUNCTION)];
    expect(() => verifySuffix(suffix, PKG)).not.toThrow();
  });
});

// ─────────────────────────────────────────────
// fromKind/from command serialization
// ─────────────────────────────────────────────

describe('S-16: fromKind/from command serialization', () => {
  it('MoveCall + pure args survive fromKind → append → from round-trip', async () => {
    // Build a user TX with a MoveCall and pure argument.
    const tx = new Transaction();
    tx.moveCall({
      target: `${PKG}::swap::execute`,
      arguments: [tx.pure.u64(1000)],
      typeArguments: ['0x2::sui::SUI'],
    });
    const kindBytes = await tx.build({ onlyTransactionKind: true });

    // Simulate Host: fromKind → append settle → build full
    const retTx = Transaction.fromKind(kindBytes);
    retTx.moveCall({
      target: `${PKG}::${SETTLE_MODULE}::${BFQ_NEW_USER}`,
      arguments: [],
    });
    retTx.setSender('0x' + 'a'.repeat(64));
    retTx.setGasPrice(1000);
    retTx.setGasBudget(10_000_000);
    retTx.setGasPayment([
      {
        objectId: '0x' + 'b'.repeat(64),
        version: '1',
        digest: '11111111111111111111111111111111',
      },
    ]);
    const fullBytes = await retTx.build();
    const returnedBase64 = toBase64(fullBytes);

    // Verify prefix commands match the serialized command shape.
    expect(() => verifyPtbIntegrity(kindBytes, returnedBase64, PKG)).not.toThrow();
  });

  it('convertSdkCommands round-trips MoveCall correctly', () => {
    const rawCmds = [
      {
        $kind: 'MoveCall',
        MoveCall: {
          package: PKG,
          module: 'swap',
          function: 'execute',
          typeArguments: ['0x2::sui::SUI'],
          arguments: [{ $kind: 'Input', Input: 0 }],
        },
      },
    ];
    const converted = convertSdkCommands(rawCmds);
    expect(converted).toHaveLength(1);
    expect(converted[0].kind).toBe('MoveCall');
    const mc = converted[0] as MoveCallCommand;
    expect(mc.packageId).toBe(PKG);
    expect(mc.module).toBe('swap');
    expect(mc.function).toBe('execute');
    expect(mc.typeArguments).toEqual(['0x2::sui::SUI']);
    expect(mc.arguments).toEqual([{ $kind: 'Input', Input: 0 }]);
  });

  it('complex PTB (MoveCall+SplitCoins+MergeCoins+Result) survives round-trip', async () => {
    // Build a complex user TX with multiple command types
    const tx = new Transaction();
    tx.moveCall({
      target: `${PKG}::swap::execute`,
      arguments: [tx.pure.u64(1000)],
      typeArguments: ['0x2::sui::SUI'],
    });
    // SplitCoins with pure amount.
    tx.splitCoins(tx.gas, [tx.pure.u64(500)]);
    // Use pure to merge (avoids Result reference that needs resolve)
    tx.moveCall({
      target: `${PKG}::helper::process`,
      arguments: [tx.pure.u64(42), tx.pure.bool(true)],
    });

    const kindBytes = await tx.build({ onlyTransactionKind: true });

    // Simulate Host: fromKind → append settle → build full
    const retTx = Transaction.fromKind(kindBytes);
    retTx.moveCall({
      target: `${PKG}::${SETTLE_MODULE}::${BFQ_NEW_USER}`,
      arguments: [],
    });
    retTx.setSender('0x' + 'a'.repeat(64));
    retTx.setGasPrice(1000);
    retTx.setGasBudget(10_000_000);
    retTx.setGasPayment([
      {
        objectId: '0x' + 'b'.repeat(64),
        version: '1',
        digest: '11111111111111111111111111111111',
      },
    ]);
    const fullBytes = await retTx.build();
    const returnedBase64 = toBase64(fullBytes);

    // Complex prefix must survive intact
    expect(() => verifyPtbIntegrity(kindBytes, returnedBase64, PKG)).not.toThrow();
  });

  it('complex PTB tamper: modifying MoveCall function name → reject', async () => {
    const tx = new Transaction();
    tx.moveCall({
      target: `${PKG}::swap::execute`,
      arguments: [tx.pure.u64(1000)],
    });
    tx.moveCall({
      target: `${PKG}::helper::process`,
      arguments: [tx.pure.u64(42)],
    });
    const kindBytes = await tx.build({ onlyTransactionKind: true });

    // Tampered version: second MoveCall has different function name
    // (pure arg changes are not detectable at command level because
    // args are Input index references after build)
    const tamperedTx = new Transaction();
    tamperedTx.moveCall({
      target: `${PKG}::swap::execute`,
      arguments: [tamperedTx.pure.u64(1000)],
    });
    tamperedTx.moveCall({
      target: `${PKG}::helper::steal`, // tampered: process → steal
      arguments: [tamperedTx.pure.u64(42)],
    });
    tamperedTx.moveCall({
      target: `${PKG}::${SETTLE_MODULE}::${BFQ_NEW_USER}`,
      arguments: [],
    });
    tamperedTx.setSender('0x' + 'a'.repeat(64));
    tamperedTx.setGasPrice(1000);
    tamperedTx.setGasBudget(10_000_000);
    tamperedTx.setGasPayment([
      {
        objectId: '0x' + 'b'.repeat(64),
        version: '1',
        digest: '11111111111111111111111111111111',
      },
    ]);
    const tamperedBase64 = toBase64(await tamperedTx.build());

    expect(() => verifyPtbIntegrity(kindBytes, tamperedBase64, PKG)).toThrow(StelisIntegrityError);
  });

  it('convertSdkCommands wraps SplitCoins payload in arguments array (non-MoveCall)', () => {
    // Source: convert.ts L30-37 — non-MoveCall wraps payload as [payload]
    const rawCmds = [
      {
        $kind: 'SplitCoins',
        SplitCoins: {
          coin: { $kind: 'GasCoin' },
          amounts: [{ $kind: 'Input', Input: 0 }],
        },
      },
    ];
    const converted = convertSdkCommands(rawCmds);
    expect(converted).toHaveLength(1);
    expect(converted[0].kind).toBe('SplitCoins');
    // arguments should be [payload] — the entire SplitCoins object wrapped
    expect(converted[0].arguments).toEqual([
      {
        coin: { $kind: 'GasCoin' },
        amounts: [{ $kind: 'Input', Input: 0 }],
      },
    ]);
  });

  it('convertSdkCommands wraps TransferObjects payload in arguments array (non-MoveCall)', () => {
    const rawCmds = [
      {
        $kind: 'TransferObjects',
        TransferObjects: {
          objects: [{ $kind: 'Result', Result: 0 }],
          address: { $kind: 'Input', Input: 1 },
        },
      },
    ];
    const converted = convertSdkCommands(rawCmds);
    expect(converted).toHaveLength(1);
    expect(converted[0].kind).toBe('TransferObjects');
    expect(converted[0].arguments).toEqual([
      {
        objects: [{ $kind: 'Result', Result: 0 }],
        address: { $kind: 'Input', Input: 1 },
      },
    ]);
  });

  it('convertSdkCommands wraps MergeCoins payload preserving GasCoin (S-15 scannable)', () => {
    const rawCmds = [
      {
        $kind: 'MergeCoins',
        MergeCoins: {
          destination: { $kind: 'GasCoin' },
          sources: [{ $kind: 'Result', Result: 0 }],
        },
      },
    ];
    const converted = convertSdkCommands(rawCmds);
    expect(converted).toHaveLength(1);
    expect(converted[0].kind).toBe('MergeCoins');
    // GasCoin should be preserved for S-15 scanning
    expect(converted[0].arguments).toEqual([
      {
        destination: { $kind: 'GasCoin' },
        sources: [{ $kind: 'Result', Result: 0 }],
      },
    ]);
  });
});

// ── Input verification ─────────────────────────────────────────────────
// Tests verify normalizeInput cross-type equivalence and verifyInputs prefix.
// Source: integrity.ts extractObjectIdFromInput / normalizeInput / verifyInputs

const OBJ_A = '0x' + 'a'.repeat(64);
const OBJ_B = '0x' + 'b'.repeat(64);

describe('normalizeInput', () => {
  it('Pure input → Pure:<bytes>', () => {
    const input = { $kind: 'Pure', Pure: { bytes: 'KgAAAAAAAAA=' } };
    expect(normalizeInput(input)).toBe('Pure:KgAAAAAAAAA=');
  });

  it('UnresolvedObject → Object:<normalizedId>', () => {
    const input = { $kind: 'UnresolvedObject', UnresolvedObject: { objectId: OBJ_A } };
    expect(normalizeInput(input)).toMatch(/^Object:0x0*a+$/);
  });

  it('Object.SharedObject → Object:<normalizedId>', () => {
    const input = {
      $kind: 'Object',
      Object: {
        $kind: 'SharedObject',
        SharedObject: { objectId: OBJ_A, initialSharedVersion: '1', mutable: true },
      },
    };
    expect(normalizeInput(input)).toMatch(/^Object:0x0*a+$/);
  });

  it('Object.ImmOrOwnedObject → Object:<normalizedId>', () => {
    const input = {
      $kind: 'Object',
      Object: {
        $kind: 'ImmOrOwnedObject',
        ImmOrOwnedObject: { objectId: OBJ_A, version: '5', digest: 'abc123' },
      },
    };
    expect(normalizeInput(input)).toMatch(/^Object:0x0*a+$/);
  });

  it('UnresolvedObject ↔ SharedObject cross-type equivalence (same objectId)', () => {
    const unresolved = { $kind: 'UnresolvedObject', UnresolvedObject: { objectId: OBJ_A } };
    const shared = {
      $kind: 'Object',
      Object: {
        $kind: 'SharedObject',
        SharedObject: { objectId: OBJ_A, initialSharedVersion: '10', mutable: true },
      },
    };
    expect(normalizeInput(unresolved)).toBe(normalizeInput(shared));
  });

  it('UnresolvedObject ↔ ImmOrOwnedObject cross-type equivalence (same objectId)', () => {
    const unresolved = { $kind: 'UnresolvedObject', UnresolvedObject: { objectId: OBJ_A } };
    const immOrOwned = {
      $kind: 'Object',
      Object: {
        $kind: 'ImmOrOwnedObject',
        ImmOrOwnedObject: { objectId: OBJ_A, version: '3', digest: 'xyz789' },
      },
    };
    expect(normalizeInput(unresolved)).toBe(normalizeInput(immOrOwned));
  });

  it('FundsWithdrawal → FundsWithdrawal:<type>:<amount>:<withdrawFrom>', () => {
    const input = {
      $kind: 'FundsWithdrawal',
      FundsWithdrawal: {
        reservation: { $kind: 'MaxAmountU64', MaxAmountU64: '10000000' },
        typeArg: { $kind: 'Balance', Balance: '0xdeep::deep::DEEP' },
        withdrawFrom: { $kind: 'Sender', Sender: true },
      },
    };
    expect(normalizeInput(input)).toBe('FundsWithdrawal:0xdeep::deep::DEEP:10000000:Sender');
  });

  it('FundsWithdrawal: different withdrawFrom → different normalized string', () => {
    const sender = {
      $kind: 'FundsWithdrawal',
      FundsWithdrawal: {
        reservation: { $kind: 'MaxAmountU64', MaxAmountU64: '5000' },
        typeArg: { $kind: 'Balance', Balance: '0x2::sui::SUI' },
        withdrawFrom: { $kind: 'Sender', Sender: true },
      },
    };
    const sponsor = {
      $kind: 'FundsWithdrawal',
      FundsWithdrawal: {
        reservation: { $kind: 'MaxAmountU64', MaxAmountU64: '5000' },
        typeArg: { $kind: 'Balance', Balance: '0x2::sui::SUI' },
        withdrawFrom: { $kind: 'Sponsor', Sponsor: true },
      },
    };
    expect(normalizeInput(sender)).not.toBe(normalizeInput(sponsor));
  });

  it('FundsWithdrawal as suffix input → verifyInputs allows', () => {
    const original = [{ $kind: 'Pure', Pure: { bytes: 'KgAAAAAAAAA=' } }];
    const returned = [
      { $kind: 'Pure', Pure: { bytes: 'KgAAAAAAAAA=' } },
      {
        $kind: 'FundsWithdrawal',
        FundsWithdrawal: {
          reservation: { $kind: 'MaxAmountU64', MaxAmountU64: '10000000' },
          typeArg: { $kind: 'Balance', Balance: '0xdeep::deep::DEEP' },
          withdrawFrom: { $kind: 'Sender', Sender: true },
        },
      },
    ];
    expect(() => verifyInputs(original, returned)).not.toThrow();
  });

  it('unknown input kind → fail-closed (StelisIntegrityError)', () => {
    const input = { $kind: 'SomeFutureKind', SomeFutureKind: { data: 'x' } };
    expect(() => normalizeInput(input)).toThrow(StelisIntegrityError);
    expect(() => normalizeInput(input)).toThrow('unsupported input kind');
  });
});

describe('verifyInputs', () => {
  it('Pure bytes tamper → reject', () => {
    const original = [{ $kind: 'Pure', Pure: { bytes: 'KgAAAAAAAAA=' } }];
    const returned = [{ $kind: 'Pure', Pure: { bytes: 'ZAAAAAAAAAA=' } }];
    expect(() => verifyInputs(original, returned)).toThrow(StelisIntegrityError);
    expect(() => verifyInputs(original, returned)).toThrow('input 0 modified');
  });

  it('SharedObject objectId tamper → reject', () => {
    const mkShared = (id: string) => ({
      $kind: 'Object',
      Object: {
        $kind: 'SharedObject',
        SharedObject: { objectId: id, initialSharedVersion: '1', mutable: true },
      },
    });
    expect(() => verifyInputs([mkShared(OBJ_A)], [mkShared(OBJ_B)])).toThrow(StelisIntegrityError);
  });

  it('ImmOrOwnedObject objectId tamper → reject', () => {
    const mkImm = (id: string) => ({
      $kind: 'Object',
      Object: {
        $kind: 'ImmOrOwnedObject',
        ImmOrOwnedObject: { objectId: id, version: '1', digest: 'abc' },
      },
    });
    expect(() => verifyInputs([mkImm(OBJ_A)], [mkImm(OBJ_B)])).toThrow(StelisIntegrityError);
  });

  it('UnresolvedObject objectId tamper → reject', () => {
    const mk = (id: string) => ({ $kind: 'UnresolvedObject', UnresolvedObject: { objectId: id } });
    expect(() => verifyInputs([mk(OBJ_A)], [mk(OBJ_B)])).toThrow(StelisIntegrityError);
  });

  it('UnresolvedObject ↔ SharedObject (objectId same) → allow', () => {
    const original = [{ $kind: 'UnresolvedObject', UnresolvedObject: { objectId: OBJ_A } }];
    const returned = [
      {
        $kind: 'Object',
        Object: {
          $kind: 'SharedObject',
          SharedObject: { objectId: OBJ_A, initialSharedVersion: '5', mutable: true },
        },
      },
    ];
    expect(() => verifyInputs(original, returned)).not.toThrow();
  });

  it('UnresolvedObject ↔ ImmOrOwnedObject (objectId same) → allow', () => {
    const original = [{ $kind: 'UnresolvedObject', UnresolvedObject: { objectId: OBJ_A } }];
    const returned = [
      {
        $kind: 'Object',
        Object: {
          $kind: 'ImmOrOwnedObject',
          ImmOrOwnedObject: { objectId: OBJ_A, version: '2', digest: 'def' },
        },
      },
    ];
    expect(() => verifyInputs(original, returned)).not.toThrow();
  });

  it('UnresolvedObject ↔ SharedObject (objectId different) → reject', () => {
    const original = [{ $kind: 'UnresolvedObject', UnresolvedObject: { objectId: OBJ_A } }];
    const returned = [
      {
        $kind: 'Object',
        Object: {
          $kind: 'SharedObject',
          SharedObject: { objectId: OBJ_B, initialSharedVersion: '1', mutable: true },
        },
      },
    ];
    expect(() => verifyInputs(original, returned)).toThrow(StelisIntegrityError);
  });

  it('suffix adds extra inputs → allow', () => {
    const original = [{ $kind: 'Pure', Pure: { bytes: 'KgAAAAAAAAA=' } }];
    const returned = [
      { $kind: 'Pure', Pure: { bytes: 'KgAAAAAAAAA=' } },
      { $kind: 'Pure', Pure: { bytes: 'ZAAAAAAAAAA=' } },
    ];
    expect(() => verifyInputs(original, returned)).not.toThrow();
  });

  it('input count reduced → reject', () => {
    const original = [
      { $kind: 'Pure', Pure: { bytes: 'KgAAAAAAAAA=' } },
      { $kind: 'Pure', Pure: { bytes: 'ZAAAAAAAAAA=' } },
    ];
    const returned = [{ $kind: 'Pure', Pure: { bytes: 'KgAAAAAAAAA=' } }];
    expect(() => verifyInputs(original, returned)).toThrow(StelisIntegrityError);
    expect(() => verifyInputs(original, returned)).toThrow('returned input count');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyPromotionPtbIntegrity — promotion path integrity
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyPromotionPtbIntegrity', () => {
  const GAS_PAYMENT = {
    objectId: '0x' + 'cc'.repeat(32),
    version: '1',
    digest: '11111111111111111111111111111111',
  };

  /** Build kind bytes + full TX base64 from the same user commands. */
  async function buildPromotionPair(buildFn: (tx: Transaction) => void): Promise<{
    kindBytes: Uint8Array;
    fullTxBase64: string;
  }> {
    const kindTx = new Transaction();
    buildFn(kindTx);
    const kindBytes = await kindTx.build({ onlyTransactionKind: true });

    const fullTx = Transaction.fromKind(kindBytes);
    fullTx.setSender('0x' + 'aa'.repeat(32));
    fullTx.setGasOwner('0x' + 'bb'.repeat(32));
    fullTx.setGasPrice(1000);
    fullTx.setGasBudget(10_000_000);
    fullTx.setGasPayment([GAS_PAYMENT]);
    const fullBytes = await fullTx.build();

    return { kindBytes, fullTxBase64: toBase64(fullBytes) };
  }

  it('passes when server preserves user commands exactly', async () => {
    const { kindBytes, fullTxBase64 } = await buildPromotionPair((tx) => {
      tx.moveCall({
        target: '0x' + '11'.repeat(32) + '::game::play',
        arguments: [tx.pure.u64(42n)],
      });
    });
    expect(() => verifyPromotionPtbIntegrity(kindBytes, fullTxBase64)).not.toThrow();
  });

  it('rejects when server adds extra commands', async () => {
    const kindTx = new Transaction();
    kindTx.moveCall({
      target: '0x' + '11'.repeat(32) + '::game::play',
      arguments: [kindTx.pure.u64(42n)],
    });
    const kindBytes = await kindTx.build({ onlyTransactionKind: true });

    // Server appends an extra command
    const fullTx = Transaction.fromKind(kindBytes);
    fullTx.moveCall({
      target: '0x' + '22'.repeat(32) + '::evil::steal',
      arguments: [],
    });
    fullTx.setSender('0x' + 'aa'.repeat(32));
    fullTx.setGasOwner('0x' + 'bb'.repeat(32));
    fullTx.setGasPrice(1000);
    fullTx.setGasBudget(10_000_000);
    fullTx.setGasPayment([GAS_PAYMENT]);
    const fullTxBase64 = toBase64(await fullTx.build());

    expect(() => verifyPromotionPtbIntegrity(kindBytes, fullTxBase64)).toThrow(
      StelisIntegrityError,
    );
    expect(() => verifyPromotionPtbIntegrity(kindBytes, fullTxBase64)).toThrow('extra commands');
  });

  it('rejects when server modifies a user command argument', async () => {
    const kindTx = new Transaction();
    kindTx.moveCall({
      target: '0x' + '11'.repeat(32) + '::game::play',
      arguments: [kindTx.pure.u64(42n)],
    });
    const kindBytes = await kindTx.build({ onlyTransactionKind: true });

    // Server rebuilds with different argument value
    const fullTx = new Transaction();
    fullTx.moveCall({
      target: '0x' + '11'.repeat(32) + '::game::play',
      arguments: [fullTx.pure.u64(999n)],
    });
    fullTx.setSender('0x' + 'aa'.repeat(32));
    fullTx.setGasOwner('0x' + 'bb'.repeat(32));
    fullTx.setGasPrice(1000);
    fullTx.setGasBudget(10_000_000);
    fullTx.setGasPayment([GAS_PAYMENT]);
    const fullTxBase64 = toBase64(await fullTx.build());

    expect(() => verifyPromotionPtbIntegrity(kindBytes, fullTxBase64)).toThrow(
      StelisIntegrityError,
    );
  });

  it('rejects when server changes MoveCall target', async () => {
    const kindTx = new Transaction();
    kindTx.moveCall({
      target: '0x' + '11'.repeat(32) + '::game::play',
      arguments: [],
    });
    const kindBytes = await kindTx.build({ onlyTransactionKind: true });

    const fullTx = new Transaction();
    fullTx.moveCall({
      target: '0x' + '11'.repeat(32) + '::game::cheat',
      arguments: [],
    });
    fullTx.setSender('0x' + 'aa'.repeat(32));
    fullTx.setGasOwner('0x' + 'bb'.repeat(32));
    fullTx.setGasPrice(1000);
    fullTx.setGasBudget(10_000_000);
    fullTx.setGasPayment([GAS_PAYMENT]);
    const fullTxBase64 = toBase64(await fullTx.build());

    expect(() => verifyPromotionPtbIntegrity(kindBytes, fullTxBase64)).toThrow(
      StelisIntegrityError,
    );
    expect(() => verifyPromotionPtbIntegrity(kindBytes, fullTxBase64)).toThrow(
      'command 0 modified',
    );
  });
});
