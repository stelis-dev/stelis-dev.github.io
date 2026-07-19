/**
 * PromotionsPage submit-time form validation unit tests.
 *
 * Locks the contract that invalid inputs (including unsafe integers whose
 * JSON round-trip would silently round to a different value) yield
 * `{ ok: false }`. Because `handleCreate` / `handleUpdate` short-circuit on
 * `!validation.ok` before any `fetch` call, asserting rejection here is
 * equivalent to asserting no API call occurs for the same input.
 */
import { describe, it, expect } from 'vitest';
import {
  validatePromotionForm,
  parseSafeIntegerString,
  type CreateFormState,
} from '../src/pages/PromotionsPage';

function makeForm(overrides: Partial<CreateFormState> = {}): CreateFormState {
  return {
    displayName: 'Test Promo',
    description: '',
    maxParticipants: '100',
    perUserGasAllowanceMist: '1000000',
    postClaimUseWindowMs: '0',
    claimDeadlineAt: '',
    ...overrides,
  };
}

describe('parseSafeIntegerString', () => {
  it('parses a typical safe integer', () => {
    expect(parseSafeIntegerString('100')).toBe(100);
  });

  it('parses zero', () => {
    expect(parseSafeIntegerString('0')).toBe(0);
  });

  it('parses a negative safe integer', () => {
    expect(parseSafeIntegerString('-42')).toBe(-42);
  });

  it('rejects an empty string', () => {
    expect(parseSafeIntegerString('')).toBeNull();
  });

  it('rejects a non-digit string', () => {
    expect(parseSafeIntegerString('abc')).toBeNull();
  });

  it('rejects a decimal string', () => {
    expect(parseSafeIntegerString('3.14')).toBeNull();
  });

  it('rejects an unsafe-integer string (rounds on Number conversion)', () => {
    // 2^53 is Number.MAX_SAFE_INTEGER + 1 — outside the safe range.
    expect(parseSafeIntegerString('9007199254740992')).toBeNull();
    expect(parseSafeIntegerString('9007199254740993')).toBeNull();
  });
});

describe('validatePromotionForm — accept', () => {
  it('accepts a minimally valid form', () => {
    const result = validatePromotionForm(makeForm());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.maxParticipants).toBe(100);
    expect(result.payload.perUserGasAllowanceMist).toBe('1000000');
    expect(result.payload.postClaimUseWindowMs).toBe(0);
  });

  it('accepts an exact millisecond window', () => {
    const result = validatePromotionForm(makeForm({ postClaimUseWindowMs: '604800001' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.postClaimUseWindowMs).toBe(604800001);
  });

  it('accepts claimDeadlineAt in ISO form', () => {
    const result = validatePromotionForm(makeForm({ claimDeadlineAt: '2030-01-01T00:00:00Z' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.claimDeadlineAt).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('validatePromotionForm — reject', () => {
  it('rejects empty displayName', () => {
    const result = validatePromotionForm(makeForm({ displayName: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/display name/i);
  });

  it('rejects maxParticipants = 0', () => {
    const result = validatePromotionForm(makeForm({ maxParticipants: '0' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/max participants/i);
  });

  it('rejects negative maxParticipants', () => {
    const result = validatePromotionForm(makeForm({ maxParticipants: '-1' }));
    expect(result.ok).toBe(false);
  });

  it('rejects decimal maxParticipants', () => {
    const result = validatePromotionForm(makeForm({ maxParticipants: '3.14' }));
    expect(result.ok).toBe(false);
  });

  it('rejects unsafe-integer maxParticipants (rounded on Number conversion)', () => {
    const result = validatePromotionForm(makeForm({ maxParticipants: '9007199254740993' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/safe integer/i);
  });

  it('rejects malformed perUserGasAllowanceMist', () => {
    const result = validatePromotionForm(makeForm({ perUserGasAllowanceMist: 'abc' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/bigint/i);
  });

  it('rejects non-decimal perUserGasAllowanceMist', () => {
    const result = validatePromotionForm(makeForm({ perUserGasAllowanceMist: '0x10' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/decimal bigint/i);
  });

  it('rejects zero perUserGasAllowanceMist', () => {
    const result = validatePromotionForm(makeForm({ perUserGasAllowanceMist: '0' }));
    expect(result.ok).toBe(false);
  });

  it('rejects empty perUserGasAllowanceMist', () => {
    const result = validatePromotionForm(makeForm({ perUserGasAllowanceMist: '' }));
    expect(result.ok).toBe(false);
  });

  it('rejects decimal postClaimUseWindowMs', () => {
    const result = validatePromotionForm(makeForm({ postClaimUseWindowMs: '3.5' }));
    expect(result.ok).toBe(false);
  });

  it('rejects negative postClaimUseWindowMs', () => {
    const result = validatePromotionForm(makeForm({ postClaimUseWindowMs: '-1' }));
    expect(result.ok).toBe(false);
  });

  it('rejects unsafe-integer postClaimUseWindowMs (rounded on Number conversion)', () => {
    const result = validatePromotionForm(makeForm({ postClaimUseWindowMs: '9007199254740993' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/safe integer/i);
  });

  it('rejects malformed claimDeadlineAt', () => {
    const result = validatePromotionForm(makeForm({ claimDeadlineAt: 'not-a-date' }));
    expect(result.ok).toBe(false);
  });
});
