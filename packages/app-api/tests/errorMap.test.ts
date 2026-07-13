/**
 * errorMap unit tests — handwritten expected-table for each error class
 * in scope.
 *
 * Covers the 13 error classes handled by
 * `packages/app-api/src/errorMap.ts`:
 *   - `RequestBodyTooLargeError`
 *   - `RequestBodyParseError`
 *   - `PrepareOverloadError`
 *   - `PrepareValidationError` (statusHint override + meta spread)
 *   - `PrepareStudioUserQuotaError`
 *   - `SponsorValidationError` (statusHint override)
 *   - `SponsorPreflightError` (optional subcode)
 *   - `SponsorOnchainError` (digest + optional subcode)
 *   - `SponsorCongestionError`
 *   - `SponsorLeaseExpiredError`
 *   - `PromotionPrepareError` (statusHint-driven)
 *   - `PromotionSponsorError` (statusHint-driven)
 *   - `DeveloperJwtAuthError` (statusHint-driven)
 *
 * Unknown values and plain `Error` instances must return `null` so callers
 * can fall through to their own 500 fallback.
 */
import { describe, it, expect } from 'vitest';
import {
  RequestBodyTooLargeError,
  RequestBodyParseError,
  PrepareOverloadError,
  PrepareValidationError,
  PrepareStudioUserQuotaError,
  SponsorValidationError,
  SponsorPreflightError,
  SponsorOnchainError,
  SponsorCongestionError,
  SponsorLeaseExpiredError,
} from '@stelis/core-api';
import { PromotionPrepareError, PromotionSponsorError } from '@stelis/core-api/studio';
import { DeveloperJwtAuthError } from '../src/middleware/studioAuth.js';
import { mapError } from '../src/errorMap.js';

describe('errorMap — RequestBodyTooLargeError', () => {
  it('maps to 413 with code REQUEST_BODY_TOO_LARGE', () => {
    const m = mapError(new RequestBodyTooLargeError(96 * 1024));
    expect(m).toEqual({
      status: 413,
      body: expect.objectContaining({ code: 'REQUEST_BODY_TOO_LARGE' }),
    });
    expect(m?.headers).toBeUndefined();
  });
});

describe('errorMap — RequestBodyParseError', () => {
  it('maps to 400 with code BAD_REQUEST', () => {
    const m = mapError(new RequestBodyParseError());
    expect(m?.status).toBe(400);
    expect(m?.body.code).toBe('BAD_REQUEST');
    expect(m?.headers).toBeUndefined();
  });
});

describe('errorMap — PrepareOverloadError', () => {
  it('maps to 503 with fixed Retry-After: 2 and code PREPARE_OVERLOADED', () => {
    const m = mapError(new PrepareOverloadError(10, 10));
    expect(m?.status).toBe(503);
    expect(m?.headers).toEqual({ 'Retry-After': '2' });
    expect(m?.body.code).toBe('PREPARE_OVERLOADED');
  });
});

describe('errorMap — PrepareValidationError', () => {
  it('defaults to 422 when statusHint is absent', () => {
    const m = mapError(new PrepareValidationError('INSUFFICIENT_BALANCE', 'fail'));
    expect(m?.status).toBe(422);
    expect(m?.body.code).toBe('INSUFFICIENT_BALANCE');
    expect(m?.headers).toBeUndefined();
  });

  it('spreads meta fields into the body', () => {
    const meta = { minSettleMist: '1000', requiredTotalIn: '2000', isEstimate: 'true' };
    const m = mapError(new PrepareValidationError('INSUFFICIENT_SETTLE_INPUT', 'too low', meta));
    expect(m?.body).toMatchObject({
      code: 'INSUFFICIENT_SETTLE_INPUT',
      minSettleMist: '1000',
      requiredTotalIn: '2000',
      isEstimate: 'true',
    });
  });

  it('honors statusHint override', () => {
    const m = mapError(new PrepareValidationError('BAD_REQUEST', 'override', undefined, 400));
    expect(m?.status).toBe(400);
    expect(m?.body.code).toBe('BAD_REQUEST');
  });

  it('sanitizes 5xx message and meta fields', () => {
    const m = mapError(
      new PrepareValidationError(
        'SPONSOR_LEASE_COMMIT_FAILED',
        'lease commit failed for sponsor 0x1 redis key sponsor:lease:secret',
        { sponsorAddress: '0x1', redisKey: 'sponsor:lease:secret' },
        500,
      ),
    );
    expect(m?.status).toBe(500);
    expect(m?.body).toEqual({
      error: 'Internal server error',
      code: 'SPONSOR_LEASE_COMMIT_FAILED',
    });
  });
});

describe('errorMap — PrepareStudioUserQuotaError', () => {
  it('maps to 429 with class-provided code', () => {
    const m = mapError(new PrepareStudioUserQuotaError('0xabc', 3));
    expect(m?.status).toBe(429);
    expect(m?.body.code).toBe('PREPARE_STUDIO_USER_QUOTA_EXCEEDED');
    expect(m?.headers).toBeUndefined();
  });
});

describe('errorMap — SponsorValidationError', () => {
  it('defaults to 422 when statusHint is absent', () => {
    const m = mapError(new SponsorValidationError('PREPARED_TX_NOT_FOUND', 'missing'));
    expect(m?.status).toBe(422);
    expect(m?.body.code).toBe('PREPARED_TX_NOT_FOUND');
  });

  it('honors statusHint override (e.g. 410 for expired)', () => {
    const m = mapError(new SponsorValidationError('PREPARED_TX_EXPIRED', 'expired', 410));
    expect(m?.status).toBe(410);
    expect(m?.body.code).toBe('PREPARED_TX_EXPIRED');
  });

  it('sanitizes 5xx message fields', () => {
    const m = mapError(
      new SponsorValidationError(
        'SPONSOR_FAILED',
        'Execution succeeded but gasUsed missing. Digest: 0xdigest_exec_no_gas signer=0xabc',
        500,
      ),
    );
    expect(m?.status).toBe(500);
    expect(m?.body).toEqual({ error: 'Internal server error', code: 'SPONSOR_FAILED' });
  });
});

describe('errorMap — SponsorPreflightError', () => {
  it('maps to 422 with fixed code SPONSOR_PREFLIGHT_FAILED, omits subcode when absent', () => {
    const m = mapError(new SponsorPreflightError('dry-run failed'));
    expect(m?.status).toBe(422);
    expect(m?.body).toMatchObject({ code: 'SPONSOR_PREFLIGHT_FAILED' });
    expect(m?.body.subcode).toBeUndefined();
  });

  it('includes subcode when provided', () => {
    const m = mapError(
      new SponsorPreflightError('insufficient settle input', 'INSUFFICIENT_SETTLE_INPUT'),
    );
    expect(m?.body.subcode).toBe('INSUFFICIENT_SETTLE_INPUT');
  });
});

describe('errorMap — SponsorOnchainError', () => {
  it('maps to 422 with digest + fixed code', () => {
    const m = mapError(new SponsorOnchainError('0xDIGEST', 'MoveAbort'));
    expect(m?.status).toBe(422);
    expect(m?.body).toMatchObject({
      code: 'SPONSOR_ONCHAIN_FAILED',
      digest: '0xDIGEST',
    });
    expect(m?.body.subcode).toBeUndefined();
  });

  it('includes subcode when provided', () => {
    const m = mapError(new SponsorOnchainError('0xDIGEST2', 'spread', 'SPREAD_EXCEEDED'));
    expect(m?.body).toMatchObject({ digest: '0xDIGEST2', subcode: 'SPREAD_EXCEEDED' });
  });
});

describe('errorMap — SponsorCongestionError', () => {
  it('maps to 503 with fixed code SPONSOR_CONGESTION', () => {
    const m = mapError(new SponsorCongestionError('cancelled'));
    expect(m?.status).toBe(503);
    expect(m?.body.code).toBe('SPONSOR_CONGESTION');
    expect(m?.body.error).toBe('Internal server error');
    expect(m?.headers).toBeUndefined();
  });
});

describe('errorMap — SponsorLeaseExpiredError', () => {
  it('maps to 503 with fixed Retry-After: 1 and code LEASE_EXPIRED', () => {
    const m = mapError(new SponsorLeaseExpiredError('slot-1'));
    expect(m?.status).toBe(503);
    expect(m?.headers).toEqual({ 'Retry-After': '1' });
    expect(m?.body.code).toBe('LEASE_EXPIRED');
    expect(JSON.stringify(m?.body)).not.toContain('slot-1');
  });
});

describe('errorMap — PromotionPrepareError', () => {
  it('uses the class default statusHint (400)', () => {
    const m = mapError(new PromotionPrepareError('bad tx', 'BAD_TX_KIND'));
    expect(m?.status).toBe(400);
    expect(m?.body.code).toBe('BAD_TX_KIND');
  });

  it('honors explicit statusHint override (422)', () => {
    const m = mapError(new PromotionPrepareError('gas cap', 'GAS_EXCEEDS_TX_CAP', 422));
    expect(m?.status).toBe(422);
    expect(m?.body.code).toBe('GAS_EXCEEDS_TX_CAP');
  });
});

describe('errorMap — PromotionSponsorError', () => {
  it('uses the class default statusHint (400)', () => {
    const m = mapError(new PromotionSponsorError('bad', 'BAD_REQUEST'));
    expect(m?.status).toBe(400);
    expect(m?.body.code).toBe('BAD_REQUEST');
  });

  it('honors explicit statusHint override (403)', () => {
    const m = mapError(new PromotionSponsorError('mismatch', 'SENDER_ADDRESS_MISMATCH', 403));
    expect(m?.status).toBe(403);
    expect(m?.body.code).toBe('SENDER_ADDRESS_MISMATCH');
  });

  // Classified sponsor failure subcode is exposed in the response body for
  // promotion sponsor errors, mirroring `SponsorPreflightError` /
  // `SponsorOnchainError`.
  it('includes subcode when classified PREFLIGHT_FAILED carries it', () => {
    const m = mapError(
      new PromotionSponsorError(
        'Preflight simulation failed: MoveAbort vault 1',
        'PREFLIGHT_FAILED',
        422,
        null,
        'REPLAY_NONCE',
      ),
    );
    expect(m?.status).toBe(422);
    expect(m?.body).toMatchObject({ code: 'PREFLIGHT_FAILED', subcode: 'REPLAY_NONCE' });
  });

  it('includes subcode when classified ONCHAIN_REVERT carries it', () => {
    const m = mapError(
      new PromotionSponsorError(
        'Transaction reverted on-chain: SPREAD',
        'ONCHAIN_REVERT',
        422,
        null,
        'SPREAD_EXCEEDED',
      ),
    );
    expect(m?.body).toMatchObject({ code: 'ONCHAIN_REVERT', subcode: 'SPREAD_EXCEEDED' });
  });

  // Omits subcode when undefined (unclassified preflight/on-chain).
  // Unclassified fallback literals (`simulation_failed`, `onchain_revert`)
  // never reach `PromotionSponsorError.subcode`; they remain in abuse meta.
  it('omits subcode when unclassified (PREFLIGHT_FAILED without subcode)', () => {
    const m = mapError(new PromotionSponsorError('Preflight failed', 'PREFLIGHT_FAILED', 422));
    expect(m?.body.code).toBe('PREFLIGHT_FAILED');
    expect(m?.body.subcode).toBeUndefined();
  });

  it('omits subcode when unclassified (ONCHAIN_REVERT without subcode)', () => {
    const m = mapError(new PromotionSponsorError('Reverted on-chain', 'ONCHAIN_REVERT', 422));
    expect(m?.body.code).toBe('ONCHAIN_REVERT');
    expect(m?.body.subcode).toBeUndefined();
  });
});

describe('errorMap — DeveloperJwtAuthError', () => {
  it('uses the required statusHint (401)', () => {
    const m = mapError(new DeveloperJwtAuthError('jwt invalid', 401));
    expect(m?.status).toBe(401);
    expect(m?.body.code).toBe('AUTH_FAILED');
  });
});

describe('errorMap — unknown error passes through', () => {
  it('returns null for plain Error', () => {
    expect(mapError(new Error('unexpected'))).toBeNull();
  });

  it('returns null for non-Error values', () => {
    expect(mapError('oops')).toBeNull();
    expect(mapError(42)).toBeNull();
    expect(mapError(undefined)).toBeNull();
    expect(mapError(null)).toBeNull();
    expect(mapError({ code: 'FAKE' })).toBeNull();
  });
});
