/**
 * failures — direct unit tests for the server-side failure policy.
 *
 * Covers:
 *   - code-level classification predicates
 *     (`shouldIgnoreSponsorFailureForAbuse`, `isManipulationAttemptCode`)
 *   - subcode-level carve-out predicate (`shouldCarveOutNonIpCounter`)
 *   - drift emitter level/payload (`emitSponsorDriftObserved`)
 *   - vault-drift vocabulary pin
 *   - FAILURE_TABLE public error-code coverage / classification consistency
 *
 * Adapter-conformance coverage that exercises the predicates indirectly
 * (via `recordSponsorFailureForAbuse` + `MemoryAbuseBlocker` /
 * `RedisAbuseBlocker`) lives in `abuseBlocker.conformance.ts` +
 * `abuseBlocking.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ADDRESS_CARVE_OUT_SUBCODES,
  MARKET_VOLATILITY_CARVE_OUT_SUBCODES,
  emitSponsorDriftObserved,
  isManipulationAttemptCode,
  shouldCarveOutNonIpCounter,
  shouldIgnoreSponsorFailureForAbuse,
  subjectCounterFamily,
  getFailurePolicy,
  FAILURE_TABLE,
  ADMISSION_FAILURE_CODES,
  PROMOTION_ABUSE_CODES,
  VAULT_DRIFT_NEW_USER_VAULT_EXISTS,
  VAULT_DRIFT_QUERY_FAILED,
  VAULT_DRIFT_STATE_INCONSISTENT,
  VAULT_DRIFT_PAIRS,
  type FailureCode,
  type FailureClassification,
} from '../src/failures.js';
import {
  KNOWN_PREPARE_ERROR_CODES,
  KNOWN_SPONSOR_ERROR_CODES,
  KNOWN_PROMOTION_PREPARE_ERROR_CODES,
  KNOWN_PROMOTION_SPONSOR_ERROR_CODES,
} from '../../core-relay/src/errorCode.js';

const RECEIPT_ID = '0x' + 'aa'.repeat(32);
const SENDER = '0x' + 'bb'.repeat(32);
const CLIENT_IP = '203.0.113.42';

describe('shouldIgnoreSponsorFailureForAbuse', () => {
  it('returns true for codes classified as `ignored` or `drift`', () => {
    // ignored
    expect(shouldIgnoreSponsorFailureForAbuse('NO_SPONSOR_SLOT')).toBe(true);
    expect(shouldIgnoreSponsorFailureForAbuse('ABUSE_BLOCKED')).toBe(true);
    // drift
    expect(shouldIgnoreSponsorFailureForAbuse('REPREPARE_REQUIRED')).toBe(true);
    expect(shouldIgnoreSponsorFailureForAbuse('VAULT_STATE_INCONSISTENT')).toBe(true);
    expect(shouldIgnoreSponsorFailureForAbuse('L2_CONFIG_VERSION_MISMATCH')).toBe(true);
  });

  it('returns false for manipulation, normal, and infra codes', () => {
    expect(shouldIgnoreSponsorFailureForAbuse('TAMPERING_DETECTED')).toBe(false);
    expect(shouldIgnoreSponsorFailureForAbuse('SPONSOR_PREFLIGHT_FAILED')).toBe(false);
    expect(shouldIgnoreSponsorFailureForAbuse('DRY_RUN_FAILED')).toBe(false);
    expect(shouldIgnoreSponsorFailureForAbuse('L2_POLICY_HASH_MISMATCH')).toBe(false);
    expect(shouldIgnoreSponsorFailureForAbuse('SPONSOR_ONCHAIN_FAILED')).toBe(false);
    expect(shouldIgnoreSponsorFailureForAbuse('BLOCK_CHECK_UNAVAILABLE')).toBe(false);
  });

  it('returns false for unknown / empty codes (default-open fail-safe)', () => {
    expect(shouldIgnoreSponsorFailureForAbuse('UNKNOWN_CODE')).toBe(false);
    expect(shouldIgnoreSponsorFailureForAbuse('')).toBe(false);
  });
});

describe('isManipulationAttemptCode', () => {
  it('returns true for codes classified as `manipulation`', () => {
    expect(isManipulationAttemptCode('TAMPERING_DETECTED')).toBe(true);
    expect(isManipulationAttemptCode('P1_GASCOIN_FORBIDDEN')).toBe(true);
    expect(isManipulationAttemptCode('L2_UNAUTHORIZED_SETTLEMENT_SWAP_PATH')).toBe(true);
    expect(isManipulationAttemptCode('AUTH_FAILED')).toBe(true);
    expect(isManipulationAttemptCode('SENDER_ADDRESS_MISMATCH')).toBe(true);
    expect(isManipulationAttemptCode('USER_ID_MISMATCH')).toBe(true);
  });

  it('returns false for ignored / drift codes', () => {
    expect(isManipulationAttemptCode('NO_SPONSOR_SLOT')).toBe(false);
    expect(isManipulationAttemptCode('REPREPARE_REQUIRED')).toBe(false);
  });

  it('returns false for normal and infra codes', () => {
    expect(isManipulationAttemptCode('L2_POLICY_HASH_MISMATCH')).toBe(false);
    expect(isManipulationAttemptCode('SPONSOR_PREFLIGHT_FAILED')).toBe(false);
    expect(isManipulationAttemptCode('SPONSOR_CONGESTION')).toBe(false);
  });

  it('returns false for unknown / empty codes', () => {
    expect(isManipulationAttemptCode('UNKNOWN_CODE')).toBe(false);
    expect(isManipulationAttemptCode('')).toBe(false);
  });
});

describe('shouldCarveOutNonIpCounter', () => {
  it('carves out PAUSED, VAULT_ALREADY_REGISTERED, and REPLAY_NONCE subcodes', () => {
    expect(shouldCarveOutNonIpCounter({ subcode: 'PAUSED' })).toBe(true);
    expect(shouldCarveOutNonIpCounter({ subcode: 'VAULT_ALREADY_REGISTERED' })).toBe(true);
    expect(shouldCarveOutNonIpCounter({ subcode: 'REPLAY_NONCE' })).toBe(true);
  });

  it('also carves out market-volatility SPREAD_EXCEEDED and SLIPPAGE_EXCEEDED subcodes', () => {
    expect(shouldCarveOutNonIpCounter({ subcode: 'SPREAD_EXCEEDED' })).toBe(true);
    expect(shouldCarveOutNonIpCounter({ subcode: 'SLIPPAGE_EXCEEDED' })).toBe(true);
  });

  it('does not carve out SLIPPAGE_QUERY_FAILED (prepare-time only)', () => {
    expect(shouldCarveOutNonIpCounter({ subcode: 'SLIPPAGE_QUERY_FAILED' })).toBe(false);
  });

  it('does not carve out other subcodes', () => {
    expect(shouldCarveOutNonIpCounter({ subcode: 'CLAIM_WOULD_EXCEED_MAX' })).toBe(false);
    expect(shouldCarveOutNonIpCounter({ subcode: 'CONFIG_VERSION_MISMATCH' })).toBe(false);
    expect(shouldCarveOutNonIpCounter({ subcode: '' })).toBe(false);
  });

  it('does not carve out when meta is undefined or subcode is missing', () => {
    expect(shouldCarveOutNonIpCounter(undefined)).toBe(false);
    expect(shouldCarveOutNonIpCounter({})).toBe(false);
    expect(shouldCarveOutNonIpCounter({ executionPathKey: 'promotion:foo' })).toBe(false);
  });
});

describe('Carve-out subcode policy — transport pin', () => {
  it('pins exact public/log literals for the address-level carve-out subcodes', () => {
    expect(ADDRESS_CARVE_OUT_SUBCODES).toEqual([
      'PAUSED',
      'VAULT_ALREADY_REGISTERED',
      'REPLAY_NONCE',
    ]);
  });

  it('pins exact public/log literals for the market-volatility carve-out subcodes', () => {
    expect(MARKET_VOLATILITY_CARVE_OUT_SUBCODES).toEqual(['SPREAD_EXCEEDED', 'SLIPPAGE_EXCEEDED']);
  });

  it('keeps benign retry/concurrency and market-volatility subcode lists disjoint', () => {
    const intersection = (MARKET_VOLATILITY_CARVE_OUT_SUBCODES as readonly string[]).filter((s) =>
      (ADDRESS_CARVE_OUT_SUBCODES as readonly string[]).includes(s),
    );
    expect(intersection).toEqual([]);
  });
});

describe('emitSponsorDriftObserved', () => {
  function parseDriftEvents(calls: unknown[][]): Record<string, unknown>[] {
    return calls
      .map((args) => {
        try {
          return JSON.parse(String(args[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((ev): ev is Record<string, unknown> => ev?.['event'] === 'SPONSOR_DRIFT_OBSERVED');
  }

  it('emits SPONSOR_DRIFT_OBSERVED at info level for typical post-consume drift', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    emitSponsorDriftObserved({
      stage: 'l1_ptb_structure',
      subcode: 'L1_UNKNOWN',
      receiptId: RECEIPT_ID,
      sender: SENDER,
      clientIp: CLIENT_IP,
      route: 'generic',
    });

    expect(parseDriftEvents(warnSpy.mock.calls)).toEqual([]);
    const events = parseDriftEvents(infoSpy.mock.calls);
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev['event']).toBe('SPONSOR_DRIFT_OBSERVED');
    expect(ev['stage']).toBe('l1_ptb_structure');
    expect(ev['subcode']).toBe('L1_UNKNOWN');
    expect(ev['route']).toBe('generic');
    expect(ev['receipt_id']).toBe(RECEIPT_ID);
    expect(ev['sender']).toBe(SENDER);
    expect(ev['client_ip']).toBe(CLIENT_IP);
    expect(ev['promotion_id']).toBeUndefined();

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('escalates to warn for L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED (operator misconfiguration)', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    emitSponsorDriftObserved({
      stage: 'l2_settle_args',
      subcode: 'L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED',
      receiptId: RECEIPT_ID,
      sender: SENDER,
      clientIp: CLIENT_IP,
      route: 'generic',
    });

    expect(parseDriftEvents(infoSpy.mock.calls)).toEqual([]);
    const events = parseDriftEvents(warnSpy.mock.calls);
    expect(events.length).toBe(1);
    expect(events[0]!['subcode']).toBe('L2_NO_SETTLEMENT_SWAP_PATHS_CONFIGURED');

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('includes promotion_id when route is "promotion"', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    emitSponsorDriftObserved({
      stage: 'gas_owner_mismatch',
      subcode: 'GAS_OWNER_DRIFT',
      receiptId: RECEIPT_ID,
      sender: SENDER,
      clientIp: CLIENT_IP,
      route: 'promotion',
      promotionId: 'promo-abc-123',
    });

    const events = parseDriftEvents(infoSpy.mock.calls);
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev['route']).toBe('promotion');
    expect(ev['promotion_id']).toBe('promo-abc-123');

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('does not include promotion_id for generic route emissions', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    emitSponsorDriftObserved({
      stage: 'settle_extraction',
      subcode: 'extraction_failed',
      receiptId: RECEIPT_ID,
      sender: SENDER,
      clientIp: CLIENT_IP,
      route: 'generic',
    });

    const events = parseDriftEvents(infoSpy.mock.calls);
    expect(events.length).toBe(1);
    expect(events[0]).not.toHaveProperty('promotion_id');

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('vault-drift vocabulary — public-code pin', () => {
  it('pins exact public/log literals for the three vault-drift pairs', () => {
    expect(VAULT_DRIFT_NEW_USER_VAULT_EXISTS).toEqual({
      stage: 'new_user_vault_exists',
      subcode: 'NEW_USER_VAULT_EXISTS',
    });
    expect(VAULT_DRIFT_QUERY_FAILED).toEqual({
      stage: 'new_user_vault_query_failed',
      subcode: 'VAULT_QUERY_FAILED',
    });
    expect(VAULT_DRIFT_STATE_INCONSISTENT).toEqual({
      stage: 'new_user_vault_state_inconsistent',
      subcode: 'VAULT_STATE_INCONSISTENT',
    });
  });

  it('aggregates the three pairs in VAULT_DRIFT_PAIRS in a stable order', () => {
    expect(VAULT_DRIFT_PAIRS).toEqual([
      VAULT_DRIFT_NEW_USER_VAULT_EXISTS,
      VAULT_DRIFT_QUERY_FAILED,
      VAULT_DRIFT_STATE_INCONSISTENT,
    ]);
  });
});

// ─────────────────────────────────────────────
// FAILURE_TABLE coverage / consistency lock
// ─────────────────────────────────────────────

describe('FAILURE_TABLE — coverage lock', () => {
  it('contains an entry for every route-bound, host-admission, and PROMO_* code', () => {
    const allKnownCodes = new Set<string>([
      ...KNOWN_PREPARE_ERROR_CODES,
      ...KNOWN_SPONSOR_ERROR_CODES,
      ...KNOWN_PROMOTION_PREPARE_ERROR_CODES,
      ...KNOWN_PROMOTION_SPONSOR_ERROR_CODES,
      ...Object.values(ADMISSION_FAILURE_CODES),
      ...Object.values(PROMOTION_ABUSE_CODES),
    ]);
    const tableKeys = new Set<string>(Object.keys(FAILURE_TABLE));
    const missing = [...allKnownCodes].filter((c) => !tableKeys.has(c));
    const extra = [...tableKeys].filter((c) => !allKnownCodes.has(c));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it('every PROMO_* code is classified manipulation or normal', () => {
    for (const code of Object.values(PROMOTION_ABUSE_CODES)) {
      const policy = FAILURE_TABLE[code];
      expect(['manipulation', 'normal']).toContain(policy.classification);
    }
  });

  it('every PROMO_* manipulation code triggers long-block via classification predicate', () => {
    const expectedManipulation = [
      PROMOTION_ABUSE_CODES.SENDER_SIGNATURE_INVALID,
      PROMOTION_ABUSE_CODES.DUPLICATE_CLAIM,
      PROMOTION_ABUSE_CODES.DISALLOWED_TARGET,
      PROMOTION_ABUSE_CODES.FORBIDDEN_COMMAND,
      PROMOTION_ABUSE_CODES.GASCOIN_FORBIDDEN,
    ];
    for (const code of expectedManipulation) {
      expect(isManipulationAttemptCode(code)).toBe(true);
    }
  });

  it('every entry uses one of the five standard classification values', () => {
    const valid: FailureClassification[] = ['manipulation', 'ignored', 'drift', 'infra', 'normal'];
    for (const [code, policy] of Object.entries(FAILURE_TABLE)) {
      expect(valid).toContain(policy.classification);
      // entry's `code` field must match the table key
      expect(policy.code).toBe(code as FailureCode);
    }
  });

  it('ignored / drift / infra entries skip both abuse counters', () => {
    for (const policy of Object.values(FAILURE_TABLE)) {
      if (
        policy.classification === 'ignored' ||
        policy.classification === 'drift' ||
        policy.classification === 'infra'
      ) {
        expect(policy.abuseImpact.ip).toBe('skip');
        expect(policy.abuseImpact.subject).toBe('skip');
      }
    }
  });

  it('manipulation entries record abuseImpact as SKIP_BOTH; long-block is owned by classification', () => {
    // Runtime contract:
    //   - manipulation rows are dispatched via `isManipulationAttemptCode`
    //     long-block branch in `recordSponsorFailureForAbuse` and never
    //     reach the windowed counter increment path.
    //   - the table's `abuseImpact` is the *windowed counter impact*
    //     contract; for manipulation rows the windowed counter does not
    //     run, so the row records SKIP_BOTH to match runtime truth.
    //   - long-block enforcement is owned by classification
    //     (verified in the next test) and by the runtime test in
    //     `abuseBlocker.conformance.ts` (`manipulation — TAMPERING_DETECTED
    //     applies an immediate long-duration block`).
    for (const [code, policy] of Object.entries(FAILURE_TABLE)) {
      if (policy.classification === 'manipulation') {
        expect({ code, ip: policy.abuseImpact.ip, subject: policy.abuseImpact.subject }).toEqual({
          code,
          ip: 'skip',
          subject: 'skip',
        });
      }
    }
  });

  it('non-manipulation rows: abuseImpact.subject==="count" requires subjectCounterFamily(code) !== null', () => {
    // Coherence invariant — the windowed counter increment branch in
    // `MemoryAbuseBlocker.recordSponsorFailure` /
    // `RedisAbuseBlocker.recordSponsorFailure` gates the subject increment
    // on `subjectCounterFamily(code) !== null`. If a non-manipulation
    // row claims `subject: 'count'` but no storage tier is mapped, the
    // table is lying about runtime: the increment never happens. Lock
    // the contract here so the table cannot drift from the adapter
    // routing.
    const violations: string[] = [];
    for (const [code, policy] of Object.entries(FAILURE_TABLE)) {
      if (policy.classification === 'manipulation') continue;
      if (policy.abuseImpact.subject !== 'count') continue;
      if (subjectCounterFamily(code) === null) violations.push(code);
    }
    expect(violations).toEqual([]);
  });

  it('classification==="manipulation" rows: isManipulationAttemptCode(code) === true (long-block ownership)', () => {
    // Long-block enforcement is owned by the classification predicate
    // (not by `abuseImpact`). Every row tagged manipulation must also
    // be picked up by the predicate the adapters consult, so
    // misclassification cannot silently demote a manipulation code into
    // the windowed-counter branch.
    const violations: string[] = [];
    for (const [code, policy] of Object.entries(FAILURE_TABLE)) {
      if (policy.classification !== 'manipulation') continue;
      if (!isManipulationAttemptCode(code)) violations.push(code);
    }
    expect(violations).toEqual([]);
  });

  it('every subjectCounterFamily-mapped code is a normal row with abuseImpact.subject==="count"', () => {
    // Reverse coherence — a code that has a storage family must be a
    // normal row that actually exercises the windowed-counter branch.
    // Otherwise the family entry is unreachable (manipulation /
    // ignored / drift / infra short-circuit before the family lookup).
    // Read the family map indirectly through subjectCounterFamily.
    const familyCodes = [
      'DRY_RUN_FAILED',
      'PREFLIGHT_FAILED',
      'SPONSOR_PREFLIGHT_FAILED',
      'ONCHAIN_REVERT',
      'SPONSOR_ONCHAIN_FAILED',
    ];
    for (const code of familyCodes) {
      const family = subjectCounterFamily(code);
      expect(family).not.toBe(null);
      const policy = FAILURE_TABLE[code as FailureCode];
      expect(policy.classification).toBe('normal');
      expect(policy.abuseImpact.subject).toBe('count');
      expect(policy.abuseImpact.ip).toBe('count');
    }
  });

  it('http status is one of 4xx or 5xx for HTTP-public entries', () => {
    // PROMO_* entries have httpStatus=0 because they are not HTTP-public
    // sentinel codes (recorded against the abuse blocker only); they
    // never appear in an HTTP response body.
    const promotionAbuseCodes = new Set<string>(Object.values(PROMOTION_ABUSE_CODES));
    for (const [code, policy] of Object.entries(FAILURE_TABLE)) {
      if (promotionAbuseCodes.has(code)) {
        expect(policy.httpStatus).toBe(0);
      } else {
        expect(policy.httpStatus).toBeGreaterThanOrEqual(400);
        expect(policy.httpStatus).toBeLessThan(600);
      }
    }
  });

  it('bodyFields is restricted to digest, subcode, meta', () => {
    const allowed = new Set(['digest', 'subcode', 'meta']);
    for (const policy of Object.values(FAILURE_TABLE)) {
      for (const field of policy.bodyFields) {
        expect(allowed.has(field)).toBe(true);
      }
    }
  });
});

describe('subjectCounterFamily — storage-tier mapping', () => {
  it('maps simulation-tier sponsor codes to sim_tier', () => {
    expect(subjectCounterFamily('DRY_RUN_FAILED')).toBe('sim_tier');
    expect(subjectCounterFamily('PREFLIGHT_FAILED')).toBe('sim_tier');
    expect(subjectCounterFamily('SPONSOR_PREFLIGHT_FAILED')).toBe('sim_tier');
  });

  it('maps revert codes to revert', () => {
    expect(subjectCounterFamily('ONCHAIN_REVERT')).toBe('revert');
    expect(subjectCounterFamily('SPONSOR_ONCHAIN_FAILED')).toBe('revert');
  });

  it('returns null for codes without a non-IP counter family', () => {
    expect(subjectCounterFamily('TAMPERING_DETECTED')).toBe(null);
    expect(subjectCounterFamily('PROMO_DISALLOWED_TARGET')).toBe(null);
    expect(subjectCounterFamily('NO_SPONSOR_SLOT')).toBe(null);
    expect(subjectCounterFamily('UNKNOWN_CODE')).toBe(null);
  });
});

describe('getFailurePolicy — runtime policy consumption', () => {
  it('returns the policy for known public codes (family-mapped normal row → COUNT_BOTH)', () => {
    expect(getFailurePolicy('SPONSOR_PREFLIGHT_FAILED')).toMatchObject({
      classification: 'normal',
      abuseImpact: { ip: 'count', subject: 'count' },
    });
  });

  it('returns the policy for normal rows without storage family (IP_ONLY)', () => {
    expect(getFailurePolicy('L2_POLICY_HASH_MISMATCH')).toMatchObject({
      classification: 'normal',
      abuseImpact: { ip: 'count', subject: 'skip' },
    });
    expect(getFailurePolicy('PROMO_DEADLINE_PASSED')).toMatchObject({
      classification: 'normal',
      abuseImpact: { ip: 'count', subject: 'skip' },
    });
  });

  it('returns the policy for PROMO_* manipulation codes (SKIP_BOTH; long-block via classification)', () => {
    // manipulation rows record SKIP_BOTH because the windowed counter
    // branch is not reached at runtime — long-block is dispatched via
    // the classification predicate (`isManipulationAttemptCode`).
    expect(getFailurePolicy('PROMO_DISALLOWED_TARGET')).toMatchObject({
      classification: 'manipulation',
      abuseImpact: { ip: 'skip', subject: 'skip' },
    });
  });

  it('returns undefined for unknown codes', () => {
    expect(getFailurePolicy('UNKNOWN_CODE')).toBeUndefined();
  });
});
