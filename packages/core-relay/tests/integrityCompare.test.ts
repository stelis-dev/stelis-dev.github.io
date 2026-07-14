/**
 * integrityCompare unit tests — deterministic structural comparator
 * covering:
 *   - equal MoveCall / OtherCommand cases (including key-order independence)
 *   - per-field mismatch path localization (kind / packageId / module /
 *     function / typeArguments / arguments including nested structures)
 *   - Uint8Array byte-wise equality + Uint8Array ↔ array fail-closed
 *   - class-instance fail-closed
 *   - nested plain-object key set / value divergence
 *   - the drift cases covered by structural comparison
 */
import { describe, it, expect } from 'vitest';
import { integrityCompare } from '../src/integrityCompare.js';
import type { PtbCommand, MoveCallCommand } from '@stelis/contracts';

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

type OtherCommand = Exclude<PtbCommand, MoveCallCommand>;

const makeMoveCall = (over: Partial<MoveCallCommand> = {}): MoveCallCommand => ({
  kind: 'MoveCall',
  packageId: '0xabc',
  module: 'mod',
  function: 'fn',
  typeArguments: ['0x2::sui::SUI'],
  arguments: [{ $kind: 'Input', Input: 0 }],
  ...over,
});

const makeOther = (over: Partial<OtherCommand> = {}): OtherCommand => ({
  kind: 'TransferObjects',
  arguments: [[{ $kind: 'Input', Input: 1 }], { $kind: 'GasCoin' }],
  ...over,
});

// ─────────────────────────────────────────────
// Equal cases
// ─────────────────────────────────────────────

describe('integrityCompare — equal', () => {
  it('identical MoveCall returns ok', () => {
    expect(integrityCompare(makeMoveCall(), makeMoveCall())).toEqual({ ok: true });
  });

  it('identical OtherCommand returns ok', () => {
    expect(integrityCompare(makeOther(), makeOther())).toEqual({ ok: true });
  });

  it('deeply nested identical arguments return ok', () => {
    const cmd = makeMoveCall({
      arguments: [
        { $kind: 'Input', Input: 0 },
        { $kind: 'NestedResult', NestedResult: [1, 2] },
        { $kind: 'Result', Result: 3 },
      ],
    });
    expect(integrityCompare(cmd, { ...cmd, arguments: [...cmd.arguments] })).toEqual({
      ok: true,
    });
  });

  it('property key order does not affect equality', () => {
    const a: PtbCommand = makeMoveCall({
      arguments: [{ $kind: 'Input', Input: 0 }],
    });
    const b: PtbCommand = makeMoveCall({
      arguments: [{ Input: 0, $kind: 'Input' } as unknown as Record<string, unknown>],
    });
    expect(integrityCompare(a, b)).toEqual({ ok: true });
  });

  it('identical Uint8Array byte payloads return ok', () => {
    const bytes1 = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const bytes2 = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const a: PtbCommand = makeOther({ arguments: [bytes1] });
    const b: PtbCommand = makeOther({ arguments: [bytes2] });
    expect(integrityCompare(a, b)).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────
// Kind-level mismatch
// ─────────────────────────────────────────────

describe('integrityCompare — kind mismatch', () => {
  it('MoveCall vs TransferObjects fails with path = kind', () => {
    const v = integrityCompare(makeMoveCall(), makeOther());
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.path).toBe('kind');
      expect(v.expected).toBe('MoveCall');
      expect(v.actual).toBe('TransferObjects');
    }
  });

  it('different OtherCommand kinds fail at kind path', () => {
    const v = integrityCompare(
      makeOther({ kind: 'SplitCoins' }),
      makeOther({ kind: 'MergeCoins' }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.path).toBe('kind');
      expect(v.expected).toBe('SplitCoins');
      expect(v.actual).toBe('MergeCoins');
    }
  });
});

// ─────────────────────────────────────────────
// MoveCall field mismatches
// ─────────────────────────────────────────────

describe('integrityCompare — MoveCall fields', () => {
  it('packageId mismatch reports packageId path', () => {
    const v = integrityCompare(
      makeMoveCall({ packageId: '0xabc' }),
      makeMoveCall({ packageId: '0xdef' }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.path).toBe('packageId');
  });

  it('module mismatch reports module path', () => {
    const v = integrityCompare(
      makeMoveCall({ module: 'mod_a' }),
      makeMoveCall({ module: 'mod_b' }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.path).toBe('module');
  });

  it('function mismatch reports function path', () => {
    const v = integrityCompare(
      makeMoveCall({ function: 'fn_a' }),
      makeMoveCall({ function: 'fn_b' }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.path).toBe('function');
  });

  it('typeArguments length mismatch reports typeArguments.length', () => {
    const v = integrityCompare(
      makeMoveCall({ typeArguments: ['0x2::sui::SUI'] }),
      makeMoveCall({ typeArguments: ['0x2::sui::SUI', '0xabc::token::TOKEN'] }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.path).toBe('typeArguments.length');
      expect(v.expected).toBe(1);
      expect(v.actual).toBe(2);
    }
  });

  it('typeArguments element mismatch reports typeArguments[i]', () => {
    const v = integrityCompare(
      makeMoveCall({ typeArguments: ['0x2::sui::SUI'] }),
      makeMoveCall({ typeArguments: ['0x2::sui::OTHER'] }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.path).toBe('typeArguments[0]');
  });

  it('arguments length mismatch reports arguments.length', () => {
    const v = integrityCompare(
      makeMoveCall({ arguments: [{ $kind: 'Input', Input: 0 }] }),
      makeMoveCall({
        arguments: [
          { $kind: 'Input', Input: 0 },
          { $kind: 'Input', Input: 1 },
        ],
      }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.path).toBe('arguments.length');
  });

  it('nested argument object field mismatch reports full path', () => {
    const v = integrityCompare(
      makeMoveCall({ arguments: [{ $kind: 'Input', Input: 0 }] }),
      makeMoveCall({ arguments: [{ $kind: 'Input', Input: 1 }] }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.path).toBe('arguments[0].Input');
      expect(v.expected).toBe(0);
      expect(v.actual).toBe(1);
    }
  });

  it('nested argument key set mismatch reports keys diff', () => {
    const v = integrityCompare(
      makeMoveCall({ arguments: [{ $kind: 'Input', Input: 0 }] }),
      makeMoveCall({ arguments: [{ $kind: 'Input', Input: 0, extra: true }] }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.path).toBe('arguments[0].__keys');
      expect(v.expected).toEqual(['$kind', 'Input']);
      expect(v.actual).toEqual(['$kind', 'Input', 'extra']);
    }
  });
});

// ─────────────────────────────────────────────
// Uint8Array — byte-wise
// ─────────────────────────────────────────────

describe('integrityCompare — Uint8Array', () => {
  it('byte mismatch reports indexed path', () => {
    const v = integrityCompare(
      makeOther({ arguments: [new Uint8Array([1, 2, 3])] }),
      makeOther({ arguments: [new Uint8Array([1, 9, 3])] }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.path).toBe('arguments[0][1]');
      expect(v.expected).toBe(2);
      expect(v.actual).toBe(9);
    }
  });

  it('length mismatch reports .length', () => {
    const v = integrityCompare(
      makeOther({ arguments: [new Uint8Array([1, 2, 3])] }),
      makeOther({ arguments: [new Uint8Array([1, 2])] }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.path).toBe('arguments[0].length');
  });

  it('Uint8Array vs regular number[] is fail-closed', () => {
    const v = integrityCompare(
      makeOther({ arguments: [new Uint8Array([1, 2, 3])] }),
      makeOther({ arguments: [[1, 2, 3]] }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.path).toBe('arguments[0]');
  });
});

// ─────────────────────────────────────────────
// Fail-closed type confusion
// ─────────────────────────────────────────────

describe('integrityCompare — fail-closed on non-plain references', () => {
  it('Map instance inside arguments is reported as mismatch', () => {
    const v = integrityCompare(
      makeOther({ arguments: [new Map([['k', 1]])] as unknown[] }),
      makeOther({ arguments: [new Map([['k', 1]])] as unknown[] }),
    );
    // Two equal-content Maps are still reported as mismatch because comparator
    // does not know how to deep-equal arbitrary class instances — reports
    // explicit drift signal if an unexpected payload type appears.
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.path).toBe('arguments[0]');
  });

  it('object vs null is mismatch', () => {
    const v = integrityCompare(
      makeOther({ arguments: [{ $kind: 'Input', Input: 0 }] }),
      makeOther({ arguments: [null] as unknown[] }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.path).toBe('arguments[0]');
  });

  it('string vs number primitive mismatch on argument leaf', () => {
    const v = integrityCompare(
      makeMoveCall({
        arguments: [{ $kind: 'Input', Input: '0' } as unknown as Record<string, unknown>],
      }),
      makeMoveCall({ arguments: [{ $kind: 'Input', Input: 0 }] }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.path).toBe('arguments[0].Input');
  });
});

// ─────────────────────────────────────────────
// Plain-object __keys divergence at root
// ─────────────────────────────────────────────

describe('integrityCompare — top-level shape divergence', () => {
  it('OtherCommand with extra top-level key reports __keys path', () => {
    const a: PtbCommand = makeOther();
    const b = { ...makeOther(), extra: true } as unknown as PtbCommand;
    const v = integrityCompare(a, b);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.path).toBe('__keys');
  });
});
