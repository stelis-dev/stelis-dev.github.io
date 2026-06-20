/**
 * R-9: classifyUserTxCoins — Result/NestedResult provenance tracking tests.
 *
 * Tests validate:
 *   1. SplitCoins source → mutated
 *   2. mutated included in suffix exclusion (wiring tested separately)
 *   3. TransferObjects(Result[splitCmd]) → source consumed
 *   4. MakeMoveVec(coin) → MoveCall(Result[vec]) → source opaqueInUse
 *   5. MakeMoveVec([coinA, coinB]) → 1:N provenance fan-in
 *   6. Unresolvable chain → fail-closed (empty provenance)
 *   7. Existing MergeCoins/TransferObjects/MoveCall direct classification preserved
 *
 * Uses Transaction.getData() without build — classifyUserTxCoins reads
 * commands and inputs directly, no RPC needed.
 */
import { describe, it, expect } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import {
  classifyUserTxCoins,
  extractPrefixWithdrawals,
  containsSponsorWithdrawal,
} from '@stelis/core-relay';

// ── Helpers ─────────────────────────────────────────────────────────────────

const COIN_A = '0x' + 'aa'.repeat(32);
const COIN_B = '0x' + 'bb'.repeat(32);
const COIN_C = '0x' + 'cc'.repeat(32);
const ATTACKER = '0x' + '01'.repeat(32);

// ── Tests ───────────────────────────────────────────────────────────────────

describe('classifyUserTxCoins — Result provenance tracking', () => {
  // SplitCoins source → mutated
  it('SplitCoins source is classified as mutated', () => {
    const tx = new Transaction();
    tx.splitCoins(tx.object(COIN_A), [100]);

    const result = classifyUserTxCoins(tx);
    expect(result.mutated.has(COIN_A)).toBe(true);
    expect(result.reusableSplitSources.has(COIN_A)).toBe(true);
    expect(result.consumed.has(COIN_A)).toBe(false);
    expect(result.opaqueInUse.has(COIN_A)).toBe(false);
  });

  // TransferObjects(Result[splitCmd]) → source stays mutated (not consumed)
  // SplitCoins creates a NEW independent object. Transferring the split result
  // does not consume the source coin — it only transfers the new object.
  it('TransferObjects of SplitCoins result: source stays mutated, not consumed', () => {
    const tx = new Transaction();
    const [splitResult] = tx.splitCoins(tx.object(COIN_A), [100]);
    tx.transferObjects([splitResult], ATTACKER);

    const result = classifyUserTxCoins(tx);
    // Source coin stays mutated (balance reduced but still alive)
    expect(result.mutated.has(COIN_A)).toBe(true);
    expect(result.reusableSplitSources.has(COIN_A)).toBe(true);
    expect(result.consumed.has(COIN_A)).toBe(false);
  });

  // MakeMoveVec(coin) → MoveCall(Result[vec]) → source opaqueInUse
  it('MakeMoveVec + MoveCall marks coin source as opaqueInUse', () => {
    const tx = new Transaction();
    const vec = tx.makeMoveVec({
      elements: [tx.object(COIN_A)],
    });
    tx.moveCall({
      target: '0x2::test::consume',
      arguments: [vec],
    });

    const result = classifyUserTxCoins(tx);
    expect(result.opaqueInUse.has(COIN_A)).toBe(true);
    expect(result.mutated.has(COIN_A)).toBe(false);
  });

  // MakeMoveVec([coinA, coinB]) → 1:N provenance
  it('MakeMoveVec with multiple elements propagates all sources', () => {
    const tx = new Transaction();
    const vec = tx.makeMoveVec({
      elements: [tx.object(COIN_A), tx.object(COIN_B)],
    });
    tx.moveCall({
      target: '0x2::test::consume',
      arguments: [vec],
    });

    const result = classifyUserTxCoins(tx);
    expect(result.opaqueInUse.has(COIN_A)).toBe(true);
    expect(result.opaqueInUse.has(COIN_B)).toBe(true);
  });

  // Unresolvable chain → fail-closed
  it('MoveCall result referenced by TransferObjects: empty provenance (fail-closed)', () => {
    const tx = new Transaction();
    // MoveCall result has unknown ABI → no provenance
    const [mcResult] = tx.moveCall({
      target: '0x2::test::create_coin',
      arguments: [],
    });
    tx.transferObjects([mcResult], ATTACKER);

    const result = classifyUserTxCoins(tx);
    // No Input coins involved → all sets empty
    expect(result.consumed.size).toBe(0);
    expect(result.mutated.size).toBe(0);
    expect(result.opaqueInUse.size).toBe(0);
  });

  // Existing MergeCoins classification preserved
  it('MergeCoins: target is survivor, sources are consumed', () => {
    const tx = new Transaction();
    tx.mergeCoins(tx.object(COIN_A), [tx.object(COIN_B), tx.object(COIN_C)]);

    const result = classifyUserTxCoins(tx);
    expect(result.survivors.has(COIN_A)).toBe(true);
    expect(result.consumed.has(COIN_B)).toBe(true);
    expect(result.consumed.has(COIN_C)).toBe(true);
  });

  // Existing TransferObjects direct classification preserved
  it('TransferObjects direct Input: coin is consumed', () => {
    const tx = new Transaction();
    tx.transferObjects([tx.object(COIN_A)], ATTACKER);

    const result = classifyUserTxCoins(tx);
    expect(result.consumed.has(COIN_A)).toBe(true);
  });

  // Existing MoveCall direct classification preserved
  it('MoveCall direct Input: argument is opaqueInUse', () => {
    const tx = new Transaction();
    tx.moveCall({
      target: '0x2::test::do_something',
      arguments: [tx.object(COIN_A)],
    });

    const result = classifyUserTxCoins(tx);
    expect(result.opaqueInUse.has(COIN_A)).toBe(true);
  });

  // Precedence: consumed > mutated (direct transfer, not split result)
  it('SplitCoins + TransferObjects(direct source): consumed wins over mutated', () => {
    const tx = new Transaction();
    tx.splitCoins(tx.object(COIN_A), [100]);
    // Direct transfer of the SOURCE coin itself (not the split result)
    tx.transferObjects([tx.object(COIN_A)], ATTACKER);

    const result = classifyUserTxCoins(tx);
    expect(result.consumed.has(COIN_A)).toBe(true);
    expect(result.mutated.has(COIN_A)).toBe(false);
    expect(result.reusableSplitSources.has(COIN_A)).toBe(false);
  });

  // Safe-reuse boundary reservationHandles: a split source stays a candidate only until
  // the original source coin itself flows into an opaque command.
  it('SplitCoins + MoveCall(direct source): opaqueInUse wins over mutated', () => {
    const tx = new Transaction();
    tx.splitCoins(tx.object(COIN_A), [100]);
    tx.moveCall({
      target: '0x2::test::consume',
      arguments: [tx.object(COIN_A)],
    });

    const result = classifyUserTxCoins(tx);
    expect(result.opaqueInUse.has(COIN_A)).toBe(true);
    expect(result.mutated.has(COIN_A)).toBe(false);
    expect(result.reusableSplitSources.has(COIN_A)).toBe(false);
    expect(result.consumed.has(COIN_A)).toBe(false);
  });

  // Result chain: SplitCoins → MergeCoins(Result as source) → provenance propagated
  it('MergeCoins consuming SplitCoins result as source: provenance propagated', () => {
    const tx = new Transaction();
    const [splitResult] = tx.splitCoins(tx.object(COIN_A), [100]);
    tx.mergeCoins(tx.object(COIN_B), [splitResult]);

    const result = classifyUserTxCoins(tx);
    // COIN_A: mutated by SplitCoins, then its result consumed by MergeCoins
    // → consumed takes precedence over mutated
    expect(result.consumed.has(COIN_A)).toBe(true);
    expect(result.mutated.has(COIN_A)).toBe(false);
    expect(result.reusableSplitSources.has(COIN_A)).toBe(false);
    // COIN_B: merge target → survivor
    expect(result.survivors.has(COIN_B)).toBe(true);
  });

  // SplitCoins output as MergeCoins DESTINATION must not
  // escape exclusion. The split source (COIN_A) must stay in mutated, not
  // get promoted to survivors via provenance-derived identity.
  it('SplitCoins output as MergeCoins destination: source stays mutated', () => {
    const tx = new Transaction();
    // SplitCoins(COIN_A, [100]) → splitOutput
    const [splitOutput] = tx.splitCoins(tx.object(COIN_A), [100]);
    // MergeCoins(splitOutput ← COIN_B) — splitOutput is the destination
    tx.mergeCoins(splitOutput, [tx.object(COIN_B)]);

    const result = classifyUserTxCoins(tx);
    // COIN_A: mutated by SplitCoins. Must NOT escape into survivors.
    expect(result.mutated.has(COIN_A)).toBe(true);
    expect(result.reusableSplitSources.has(COIN_A)).toBe(true);
    expect(result.survivors.has(COIN_A)).toBe(false);
    // COIN_B: merge source → consumed
    expect(result.consumed.has(COIN_B)).toBe(true);
  });

  // Double-check: direct Input destination still becomes survivor
  it('MergeCoins with direct Input destination: still classified as survivor', () => {
    const tx = new Transaction();
    const [splitResult] = tx.splitCoins(tx.object(COIN_A), [100]);
    // COIN_B is a direct Input destination — should be survivor
    tx.mergeCoins(tx.object(COIN_B), [splitResult]);

    const result = classifyUserTxCoins(tx);
    expect(result.survivors.has(COIN_B)).toBe(true);
  });

  // Explicit NestedResult provenance — SplitCoins produces NestedResult
  // when destructured as [output]. Verify provenance resolves correctly.
  it('NestedResult from SplitCoins: transfer does NOT consume source', () => {
    const tx = new Transaction();
    // SplitCoins returns Result; destructuring gets NestedResult([cmd, 0])
    const [splitOut] = tx.splitCoins(tx.object(COIN_A), [100]);
    // splitOut is NestedResult — transfer of split result should NOT consume source
    tx.transferObjects([splitOut], ATTACKER);

    const result = classifyUserTxCoins(tx);
    // COIN_A stays mutated (split source, balance reduced but still alive)
    expect(result.mutated.has(COIN_A)).toBe(true);
    expect(result.reusableSplitSources.has(COIN_A)).toBe(true);
    expect(result.consumed.has(COIN_A)).toBe(false);
  });

  // NestedResult chain — SplitCoins → MakeMoveVec(NestedResult)
  // → MoveCall(Result[vec]). Tests 2-level provenance resolution.
  it('NestedResult chain: SplitCoins → MakeMoveVec → MoveCall propagates provenance', () => {
    const tx = new Transaction();
    const [splitOut] = tx.splitCoins(tx.object(COIN_A), [100]);
    const vec = tx.makeMoveVec({ elements: [splitOut] });
    tx.moveCall({
      target: '0x2::test::consume',
      arguments: [vec],
    });

    const result = classifyUserTxCoins(tx);
    // COIN_A traced through NestedResult → MakeMoveVec → MoveCall → opaqueInUse
    // opaqueInUse takes precedence over mutated
    expect(result.opaqueInUse.has(COIN_A)).toBe(true);
    expect(result.mutated.has(COIN_A)).toBe(false);
    expect(result.reusableSplitSources.has(COIN_A)).toBe(false);
  });

  // MoveCall result has no provenance — subsequent NestedResult
  // reference resolves to empty set (fail-closed).
  it('NestedResult from MoveCall: empty provenance, no false inclusion', () => {
    const tx = new Transaction();
    // MoveCall produces a result with unknown ABI → no provenance
    const [mcOut] = tx.moveCall({
      target: '0x2::test::create',
      arguments: [tx.object(COIN_A)],
    });
    // Use NestedResult from MoveCall in another MoveCall
    tx.moveCall({
      target: '0x2::test::consume',
      arguments: [mcOut],
    });

    const result = classifyUserTxCoins(tx);
    // COIN_A is opaqueInUse from the first MoveCall (direct Input argument)
    expect(result.opaqueInUse.has(COIN_A)).toBe(true);
    // No other coins should be affected — second MoveCall's NestedResult
    // resolves to empty provenance
    expect(result.consumed.size).toBe(0);
    expect(result.mutated.size).toBe(0);
  });
});

// ── FundsWithdrawal accounting scope ─────────────────────────────────────
//
// These tests pin the current behavior of `classifyUserTxCoins()` against user
// prefixes that contain `FundsWithdrawal` inputs (Sui address-balance model).
// They document — as durable checks — that the classifier currently tracks
// coin-object provenance only, and does NOT record same-token address-balance
// consumption.
//
// These are coverage tests for a current accounting gap: same-token
// `FundsWithdrawal` usage is not reflected in the classifier. They are not
// intended to lock a desired final behavior.

const DUMMY_COIN_TYPE =
  '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';

describe('classifyUserTxCoins — FundsWithdrawal accounting gap', () => {
  it('user-prefix tx.withdrawal() is not recorded in any of {survivors,consumed,opaqueInUse,mutated}', () => {
    const tx = new Transaction();
    // User prefix only: a single address-balance withdrawal. No Coin<T> object
    // is referenced at all.
    tx.withdrawal({ amount: 1_000_000n, type: DUMMY_COIN_TYPE });

    const result = classifyUserTxCoins(tx);

    // Classifier tracks object provenance only. A FundsWithdrawal input has
    // no objectId, so nothing is added to any classification set.
    expect(result.survivors.size).toBe(0);
    expect(result.consumed.size).toBe(0);
    expect(result.opaqueInUse.size).toBe(0);
    expect(result.mutated.size).toBe(0);
  });

  it('withdrawal → transferObjects sequence records no per-input classification', () => {
    const tx = new Transaction();
    // User prefix: withdraw address balance → transfer the resulting Coin<T>.
    // The withdrawal source is not a tracked objectId, and the resulting Coin
    // only exists as a Result, not as an Input object.
    const [coinOut] = tx.moveCall({
      target: '0x2::coin::from_balance',
      typeArguments: [DUMMY_COIN_TYPE],
      arguments: [tx.withdrawal({ amount: 2_000_000n, type: DUMMY_COIN_TYPE })],
    });
    tx.transferObjects([coinOut], ATTACKER);

    const result = classifyUserTxCoins(tx);

    // Because the withdrawal source has no objectId and the Coin is a Result,
    // no entry lands in any classification set. This means the classifier has
    // no hook point to model "user already spent X address-balance amount".
    expect(result.survivors.size).toBe(0);
    expect(result.consumed.size).toBe(0);
    expect(result.opaqueInUse.size).toBe(0);
    expect(result.mutated.size).toBe(0);
  });

  // Simulates the exact prefix + suffix same-token withdrawal scenario:
  // user prefix `tx.withdrawal()` plus Host suffix `tx.withdrawal()`
  // on the same token when resolvePaymentSource chooses the address-balance path.
  it('prefix + suffix withdrawal on same token: classifier sees neither, PTB has both FundsWithdrawal inputs', () => {
    const tx = new Transaction();

    // User prefix: withdraw 7_000_000 from AB
    tx.withdrawal({ amount: 7_000_000n, type: DUMMY_COIN_TYPE });

    // Host suffix: withdraw 8_000_000 from AB for gas swap
    // (mirrors build.ts L767: tx.withdrawal({ amount: swapAmountSmallest, type: pool.settlementTokenType }))
    tx.withdrawal({ amount: 8_000_000n, type: DUMMY_COIN_TYPE });

    // Verify PTB actually contains 2 FundsWithdrawal inputs
    const data = tx.getData();
    const fwInputs = (data.inputs as Record<string, unknown>[]).filter(
      (inp) => (inp.$kind as string) === 'FundsWithdrawal',
    );
    expect(fwInputs.length).toBe(2);

    // Classifier sees nothing — both inputs are FundsWithdrawal, no objectId
    const result = classifyUserTxCoins(tx);
    expect(result.survivors.size).toBe(0);
    expect(result.consumed.size).toBe(0);
    expect(result.opaqueInUse.size).toBe(0);
    expect(result.mutated.size).toBe(0);

    // This proves: when prefix + suffix both use same-token AB, the current
    // classifier has zero signal about either usage. The combined AB request
    // (7M + 8M = 15M) vs actual AB availability is only caught downstream
    // at tx.build() time by Sui runtime ("Available amount < requested").
  });

  it('mixed source: coin-object side is tracked, withdrawal side is invisible', () => {
    const tx = new Transaction();
    // User prefix mixes both sides of the matrix:
    //   - touches a coin object (COIN_A) via SplitCoins
    //   - also withdraws from address balance
    tx.splitCoins(tx.object(COIN_A), [500_000]);
    tx.withdrawal({ amount: 3_000_000n, type: DUMMY_COIN_TYPE });

    const result = classifyUserTxCoins(tx);

    // Coin-object side: COIN_A is recorded as mutated (SplitCoins source).
    expect(result.mutated.has(COIN_A)).toBe(true);
    // Withdrawal side: classifier has no record at all. The resolver cannot
    // learn from classification output that same-token address balance was
    // already consumed by the prefix.
    expect(result.survivors.size).toBe(0);
    expect(result.consumed.size).toBe(0);
    expect(result.opaqueInUse.size).toBe(0);
    expect(result.mutated.size).toBe(1); // only COIN_A
  });
});

// ── extractPrefixWithdrawals — address-balance accounting ────────────────
//
// These tests cover the adversarial matrix for same-token FundsWithdrawal
// accounting.
// extractPrefixWithdrawals reads FundsWithdrawal inputs from user prefix
// and returns the total same-token address balance consumption.

const PAYMENT_TYPE = '0xdeep::deep::DEEP';
// Non-canonical form: leading-zero address padding differs
const PAYMENT_TYPE_NON_CANONICAL =
  '0x000000000000000000000000000000000000000000000000000000000000deep::deep::DEEP';
const OTHER_TYPE = '0xusdc::usdc::USDC';

describe('extractPrefixWithdrawals — R-9 AB accounting', () => {
  // A1/A14: no FundsWithdrawal → 0, unaccountable: false
  it('no FundsWithdrawal inputs → { total: 0n, unaccountable: false }', () => {
    const tx = new Transaction();
    tx.splitCoins(tx.object(COIN_A), [100]);
    expect(extractPrefixWithdrawals(tx, PAYMENT_TYPE)).toEqual({ total: 0n, unaccountable: false });
  });

  // A4: single same-token FW
  it('single same-token FundsWithdrawal → extracts amount', () => {
    const tx = new Transaction();
    tx.withdrawal({ amount: 5_000_000n, type: PAYMENT_TYPE });
    expect(extractPrefixWithdrawals(tx, PAYMENT_TYPE)).toEqual({
      total: 5_000_000n,
      unaccountable: false,
    });
  });

  // A9: different-token FW → ignored (parseable, non-matching = safe skip)
  it('different-token FundsWithdrawal → { total: 0n, unaccountable: false }', () => {
    const tx = new Transaction();
    tx.withdrawal({ amount: 5_000_000n, type: OTHER_TYPE });
    expect(extractPrefixWithdrawals(tx, PAYMENT_TYPE)).toEqual({ total: 0n, unaccountable: false });
  });

  // A10: multiple same-token FW → summed
  it('multiple same-token FundsWithdrawals → summed', () => {
    const tx = new Transaction();
    tx.withdrawal({ amount: 3_000_000n, type: PAYMENT_TYPE });
    tx.withdrawal({ amount: 7_000_000n, type: PAYMENT_TYPE });
    expect(extractPrefixWithdrawals(tx, PAYMENT_TYPE)).toEqual({
      total: 10_000_000n,
      unaccountable: false,
    });
  });

  // A9 + A10 combined: mixed token types → only same-token counted
  it('mixed token types → only same-token summed', () => {
    const tx = new Transaction();
    tx.withdrawal({ amount: 3_000_000n, type: PAYMENT_TYPE });
    tx.withdrawal({ amount: 7_000_000n, type: OTHER_TYPE });
    tx.withdrawal({ amount: 2_000_000n, type: PAYMENT_TYPE });
    expect(extractPrefixWithdrawals(tx, PAYMENT_TYPE)).toEqual({
      total: 5_000_000n,
      unaccountable: false,
    });
  });

  // A15: non-canonical type string → normalizeStructTag matches
  it('non-canonical type string normalizes to match', () => {
    const tx = new Transaction();
    tx.withdrawal({ amount: 4_000_000n, type: PAYMENT_TYPE_NON_CANONICAL });
    expect(extractPrefixWithdrawals(tx, PAYMENT_TYPE)).toEqual({
      total: 4_000_000n,
      unaccountable: false,
    });
  });

  // A14: FW with amount 0 → { total: 0n, unaccountable: false }
  it('FundsWithdrawal amount=0 → { total: 0n, unaccountable: false }', () => {
    const tx = new Transaction();
    tx.withdrawal({ amount: 0n, type: PAYMENT_TYPE });
    expect(extractPrefixWithdrawals(tx, PAYMENT_TYPE)).toEqual({ total: 0n, unaccountable: false });
  });

  it('FundsWithdrawal hex/exponent amount string → unaccountable', () => {
    const hexTx = txWithFwInput(makeFwInput({ Sender: true }, PAYMENT_TYPE, '0x10'));
    expect(extractPrefixWithdrawals(hexTx, PAYMENT_TYPE)).toEqual({
      total: 0n,
      unaccountable: true,
    });

    const exponentTx = txWithFwInput(makeFwInput({ Sender: true }, PAYMENT_TYPE, '1e6'));
    expect(extractPrefixWithdrawals(exponentTx, PAYMENT_TYPE)).toEqual({
      total: 0n,
      unaccountable: true,
    });
  });

  // A12/A13: FW + coin operations → FW extraction is independent of classifier
  it('FW + coin object operations → FW amount extracted independently', () => {
    const tx = new Transaction();
    tx.splitCoins(tx.object(COIN_A), [500_000]);
    tx.withdrawal({ amount: 3_000_000n, type: PAYMENT_TYPE });
    // extractPrefixWithdrawals only reads FW; coin ops are invisible to it
    expect(extractPrefixWithdrawals(tx, PAYMENT_TYPE)).toEqual({
      total: 3_000_000n,
      unaccountable: false,
    });
    // classifyUserTxCoins only reads coin ops; FW is invisible to it
    const classified = classifyUserTxCoins(tx);
    expect(classified.mutated.has(COIN_A)).toBe(true);
  });

  // ── Unaccountable shapes ─────────────────────────────────────────────

  // Sender withdrawal with malformed typeArg (no Balance field)
  it('Sender FW with missing typeArg.Balance → unaccountable: true', () => {
    const tx = txWithFwInput({
      $kind: 'FundsWithdrawal',
      FundsWithdrawal: {
        reservation: { $kind: 'MaxAmountU64', MaxAmountU64: '5000000' },
        typeArg: {}, // no Balance field
        withdrawFrom: { $kind: 'Sender' },
      },
    });
    expect(extractPrefixWithdrawals(tx, PAYMENT_TYPE)).toEqual({
      total: 0n,
      unaccountable: true,
    });
  });

  // Sender withdrawal with unrecognized reservation shape (not MaxAmountU64)
  it('Sender FW with unrecognized reservation shape → unaccountable: true', () => {
    const tx = txWithFwInput({
      $kind: 'FundsWithdrawal',
      FundsWithdrawal: {
        reservation: { $kind: 'UnknownShape', UnknownShape: '5000000' },
        typeArg: { $kind: 'Balance', Balance: PAYMENT_TYPE },
        withdrawFrom: { $kind: 'Sender' },
      },
    });
    expect(extractPrefixWithdrawals(tx, PAYMENT_TYPE)).toEqual({
      total: 0n,
      unaccountable: true,
    });
  });
});

// ── mergeDestToSources — carrier-aware merge credit tracking ──────────────

describe('classifyUserTxCoins — mergeDestToSources tracking', () => {
  it('MergeCoins: destination → direct-Input sources mapped', () => {
    const tx = new Transaction();
    tx.mergeCoins(tx.object(COIN_A), [tx.object(COIN_B), tx.object(COIN_C)]);

    const result = classifyUserTxCoins(tx);
    const sources = result.mergeDestToSources.get(COIN_A);
    expect(sources).toBeDefined();
    expect(sources!.has(COIN_B)).toBe(true);
    expect(sources!.has(COIN_C)).toBe(true);
  });

  it('TransferObjects: no mergeDestToSources entry', () => {
    const tx = new Transaction();
    tx.transferObjects([tx.object(COIN_A)], ATTACKER);

    const result = classifyUserTxCoins(tx);
    expect(result.mergeDestToSources.size).toBe(0);
  });

  it('merge all → split → transfer: A→{B,C} mapping, A=survivor', () => {
    const tx = new Transaction();
    tx.mergeCoins(tx.object(COIN_A), [tx.object(COIN_B), tx.object(COIN_C)]);
    const [transferCoin] = tx.splitCoins(tx.object(COIN_A), [100]);
    tx.transferObjects([transferCoin], ATTACKER);

    const result = classifyUserTxCoins(tx);
    expect(result.survivors.has(COIN_A)).toBe(true);
    const sources = result.mergeDestToSources.get(COIN_A);
    expect(sources).toBeDefined();
    expect(sources!.has(COIN_B)).toBe(true);
    expect(sources!.has(COIN_C)).toBe(true);
  });

  it('splitResult as merge source: NO entry (provenance-derived, not direct-Input)', () => {
    const tx = new Transaction();
    const [splitResult] = tx.splitCoins(tx.object(COIN_A), [100]);
    tx.mergeCoins(tx.object(COIN_B), [splitResult]);

    const result = classifyUserTxCoins(tx);
    // B is survivor, but splitResult is Result-backed — no direct-Input source
    // so mergeDestToSources for B should be empty or absent
    const sources = result.mergeDestToSources.get(COIN_B);
    expect(!sources || sources.size === 0).toBe(true);
  });

  it('Result-backed merge destination: NO entry (not a direct Input)', () => {
    const tx = new Transaction();
    const [splitOut] = tx.splitCoins(tx.object(COIN_A), [100]);
    tx.mergeCoins(splitOut, [tx.object(COIN_B)]);

    const result = classifyUserTxCoins(tx);
    // splitOut is a Result, not a direct Input → no mergeDestToSources entry
    expect(result.mergeDestToSources.size).toBe(0);
  });

  it('merge dest later transferred: entry exists but dest is not survivor', () => {
    const tx = new Transaction();
    tx.mergeCoins(tx.object(COIN_A), [tx.object(COIN_B)]);
    tx.transferObjects([tx.object(COIN_A)], ATTACKER);

    const result = classifyUserTxCoins(tx);
    // A: consumed (direct transfer), not survivor
    expect(result.consumed.has(COIN_A)).toBe(true);
    expect(result.survivors.has(COIN_A)).toBe(false);
    // Entry exists in map (classifier doesn't know future state)
    const sources = result.mergeDestToSources.get(COIN_A);
    expect(sources).toBeDefined();
    expect(sources!.has(COIN_B)).toBe(true);
    // resolvePaymentSource will ignore this because A is not a survivor
  });

  // Adversarial: merge dest then passed to arbitrary MoveCall → opaqueInUse wins
  it('merge dest + MoveCall: opaqueInUse beats survivor (fail-closed)', () => {
    const tx = new Transaction();
    tx.mergeCoins(tx.object(COIN_A), [tx.object(COIN_B)]);
    tx.moveCall({ target: '0x2::test::do_something', arguments: [tx.object(COIN_A)] });

    const result = classifyUserTxCoins(tx);
    // A: opaqueInUse (MoveCall arg) beats survivor (merge dest)
    expect(result.opaqueInUse.has(COIN_A)).toBe(true);
    expect(result.survivors.has(COIN_A)).toBe(false);
    // B: consumed (merge source)
    expect(result.consumed.has(COIN_B)).toBe(true);
    // mergeDestToSources still has entry (classifier doesn't remove on opaque)
    // but resolver won't apply credit because A is not a survivor
    const sources = result.mergeDestToSources.get(COIN_A);
    expect(sources).toBeDefined();
    expect(sources!.has(COIN_B)).toBe(true);
  });

  // Verify: merge-only survivor is NOT affected by precedence change
  it('merge-only (no MoveCall): survivor preserved', () => {
    const tx = new Transaction();
    tx.mergeCoins(tx.object(COIN_A), [tx.object(COIN_B)]);

    const result = classifyUserTxCoins(tx);
    expect(result.survivors.has(COIN_A)).toBe(true);
    expect(result.opaqueInUse.has(COIN_A)).toBe(false);
  });
});

// ── containsSponsorWithdrawal — S-15 companion (sponsor fund protection) ──

describe('containsSponsorWithdrawal — S-15 companion', () => {
  it('no FundsWithdrawal → false', () => {
    const tx = new Transaction();
    tx.splitCoins(tx.object(COIN_A), [100]);
    expect(containsSponsorWithdrawal(tx)).toBe(false);
  });

  it('FundsWithdrawal(Sender) → false (legitimate user withdrawal)', () => {
    const tx = new Transaction();
    tx.withdrawal({ amount: 5_000_000n, type: PAYMENT_TYPE });
    expect(containsSponsorWithdrawal(tx)).toBe(false);
  });

  it('FundsWithdrawal(Sponsor) → true (sponsor drain attempt)', async () => {
    // tx.withdrawal() only creates Sender. To test Sponsor, we must go through BCS:
    // build a Sender withdrawal → decode BCS → patch to Sponsor → re-encode → fromKind.
    const seed = new Transaction();
    seed.withdrawal({ amount: 999_999_999n, type: '0x2::sui::SUI' });
    const kindBytes = await seed.build({ onlyTransactionKind: true });
    const decoded = bcs.TransactionKind.parse(kindBytes);
    // Patch withdrawFrom to Sponsor
    const fw = decoded.ProgrammableTransaction.inputs[0] as {
      FundsWithdrawal: { withdrawFrom: Record<string, unknown> };
    };
    fw.FundsWithdrawal.withdrawFrom = { Sponsor: true };
    const patched = bcs.TransactionKind.serialize(decoded).toBytes();
    const tx = Transaction.fromKind(patched);
    expect(containsSponsorWithdrawal(tx)).toBe(true);
  });

  it('mixed Sender + Sponsor → true (Sponsor presence is enough)', async () => {
    // Build TX with 2 withdrawals, patch the second to Sponsor via BCS
    const seed = new Transaction();
    seed.withdrawal({ amount: 1_000_000n, type: '0x2::sui::SUI' });
    seed.withdrawal({ amount: 999_999_999n, type: '0x2::sui::SUI' });
    const kindBytes = await seed.build({ onlyTransactionKind: true });
    const decoded = bcs.TransactionKind.parse(kindBytes);
    // Patch second input to Sponsor
    const fw = decoded.ProgrammableTransaction.inputs[1] as {
      FundsWithdrawal: { withdrawFrom: Record<string, unknown> };
    };
    fw.FundsWithdrawal.withdrawFrom = { Sponsor: true };
    const patched = bcs.TransactionKind.serialize(decoded).toBytes();
    const tx = Transaction.fromKind(patched);
    expect(containsSponsorWithdrawal(tx)).toBe(true);
  });
});

// ── resolveWithdrawFrom shape coverage ($kind-based discrimination) ─────
//
// The shared resolveWithdrawFrom helper (withdrawFrom interpretation)
// must handle three representation forms:
//   1. Key-based: { Sender: true } or { Sponsor: true } (BCS roundtrip)
//   2. $kind-based: { $kind: 'Sender' } or { $kind: 'Sponsor' } ($kind-only)
//   3. Combined: { $kind: 'Sender', Sender: true } (current SDK tx.withdrawal())
//
// Forms 1 and 3 are covered by existing tests above. This section adds
// form 2 ($kind-only) coverage.
//
// These tests patch raw transaction input data to produce $kind-only shapes
// that the current SDK does not emit but must be tolerated for forward safety.

/** Build a FundsWithdrawal input object with a specific withdrawFrom shape. */
function makeFwInput(
  withdrawFrom: Record<string, unknown>,
  type = '0x2::sui::SUI',
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

/**
 * Create a Transaction-like object with custom FundsWithdrawal inputs.
 *
 * Transaction.getData() returns a deep copy, so we cannot inject inputs
 * into a real Transaction after construction. Instead, we create a minimal
 * proxy that satisfies the `tx.getData().inputs` contract used by
 * extractPrefixWithdrawals and containsSponsorWithdrawal.
 */
function txWithFwInput(fwInput: Record<string, unknown>): Transaction {
  return {
    getData: () => ({ inputs: [fwInput], commands: [] }),
  } as unknown as Transaction;
}

describe('extractPrefixWithdrawals — $kind-only withdrawFrom shape', () => {
  it('$kind-only Sender → extracts amount', () => {
    const tx = txWithFwInput(makeFwInput({ $kind: 'Sender' }, PAYMENT_TYPE));
    expect(extractPrefixWithdrawals(tx, PAYMENT_TYPE)).toEqual({
      total: 5_000_000n,
      unaccountable: false,
    });
  });

  it('$kind-only Sponsor → ignored (Sender-only accounting)', () => {
    const tx = txWithFwInput(makeFwInput({ $kind: 'Sponsor' }, PAYMENT_TYPE));
    expect(extractPrefixWithdrawals(tx, PAYMENT_TYPE)).toEqual({ total: 0n, unaccountable: false });
  });

  it('$kind-only unknown → ignored (unrecognized shape)', () => {
    const tx = txWithFwInput(makeFwInput({ $kind: 'Unknown' }, PAYMENT_TYPE));
    expect(extractPrefixWithdrawals(tx, PAYMENT_TYPE)).toEqual({ total: 0n, unaccountable: false });
  });
});

describe('containsSponsorWithdrawal — $kind-only withdrawFrom shape', () => {
  it('$kind-only Sponsor → true', () => {
    const tx = txWithFwInput(makeFwInput({ $kind: 'Sponsor' }));
    expect(containsSponsorWithdrawal(tx)).toBe(true);
  });

  it('$kind-only Sender → false', () => {
    const tx = txWithFwInput(makeFwInput({ $kind: 'Sender' }));
    expect(containsSponsorWithdrawal(tx)).toBe(false);
  });

  it('$kind-only unknown → false', () => {
    const tx = txWithFwInput(makeFwInput({ $kind: 'Unknown' }));
    expect(containsSponsorWithdrawal(tx)).toBe(false);
  });
});
