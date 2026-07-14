/**
 * brand.ts — internal nominal type module.
 *
 * Covers:
 *   - Mist / Bps tag + untag round-trip identity at runtime
 *   - parseBps delegates to validateBps (accept / reject shapes)
 *   - Nominal property: Mist and Bps are NOT interchangeable with
 *     their base types without explicit tagging (compile-only;
 *     asserted via structural identity-at-runtime here).
 *
 * Does NOT re-verify validateBps's input rules in depth — that is
 * `validateBps.ts` responsibility. We only assert
 * that parseBps forwards the same success/failure payload.
 */
import { describe, expect, it } from 'vitest';
import { mist, bps, unBps, parseBps, type Mist, type Bps } from '../src/internal/brand.js';

describe('brand — Mist', () => {
  it('mist() tags a bigint while retaining its bigint value', () => {
    const v: Mist = mist(1_234_567n);
    expect(typeof v).toBe('bigint');
    expect(v).toBe(1_234_567n);
  });

  it('Mist is a bigint subtype — arithmetic with bigint returns bigint', () => {
    const a: Mist = mist(1_000n);
    const b = 500n; // raw bigint
    // `a + b` is typed bigint (not Mist). We still get correct arithmetic.
    const sum = a + b;
    expect(sum).toBe(1_500n);
    // Retagging is the caller's responsibility:
    const tagged: Mist = mist(sum);
    expect(tagged).toBe(1_500n);
  });
});

describe('brand — Bps', () => {
  it('bps() tags a number; unBps() restores identity', () => {
    const v: Bps = bps(500);
    expect(typeof v).toBe('number');
    expect(unBps(v)).toBe(500);
  });
});

describe('brand — parseBps (delegates to validateBps)', () => {
  it('accepts valid integer at zero', () => {
    const r = parseBps('slippageBps', 0, 10_000, 'E_BAD_BPS');
    expect(r.ok).toBe(true);
    if (r.ok) expect(unBps(r.value)).toBe(0);
  });

  it('accepts valid integer at cap', () => {
    const r = parseBps('gasMarginBps', 10_000, 10_000, 'E_BAD_BPS');
    expect(r.ok).toBe(true);
    if (r.ok) expect(unBps(r.value)).toBe(10_000);
  });

  it('rejects non-integer', () => {
    const r = parseBps('slippageBps', 1.5, 10_000, 'E_BAD_BPS');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('E_BAD_BPS');
      expect(r.message).toContain('slippageBps');
    }
  });

  it('rejects value > cap', () => {
    const r = parseBps('gasMarginBps', 10_001, 10_000, 'E_BAD_BPS');
    expect(r.ok).toBe(false);
  });

  it('rejects negative value', () => {
    const r = parseBps('slippageBps', -1, 10_000, 'E_BAD_BPS');
    expect(r.ok).toBe(false);
  });

  it('rejects non-number (string)', () => {
    const r = parseBps('slippageBps', '500', 10_000, 'E_BAD_BPS');
    expect(r.ok).toBe(false);
  });

  it('rejects non-number (boolean)', () => {
    const r = parseBps('slippageBps', true, 10_000, 'E_BAD_BPS');
    expect(r.ok).toBe(false);
  });

  it('rejects undefined', () => {
    const r = parseBps('slippageBps', undefined, 10_000, 'E_BAD_BPS');
    expect(r.ok).toBe(false);
  });
});
