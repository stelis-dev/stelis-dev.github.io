import { describe, expect, it } from 'vitest';
import {
  PrepareOverloadError,
  PrepareValidationError,
  RequestBodyParseError,
  RequestBodyTooLargeError,
  SponsorCongestionError,
  SponsorLeaseExpiredError,
  SponsorOnchainError,
  SponsorPreflightError,
  SponsorSubmissionUncertainError,
  SponsorValidationError,
} from '@stelis/core-api';
import { PromotionPrepareError, PromotionSponsorError } from '@stelis/core-api/studio';
import { SuiOperationError } from '@stelis/core-relay';
import {
  hostErrorPublicMessage,
  parseHostErrorResponse,
  PROMOTION_PREPARE_ERROR_CODES,
  PROMOTION_SPONSOR_ERROR_CODES,
  RELAY_PREPARE_ERROR_CODES,
  RELAY_SPONSOR_ERROR_CODES,
} from '@stelis/contracts';
import { codedHostError, mapError } from '../src/errorMap.js';

const GAS_USED = {
  computationCost: '10',
  storageCost: '2',
  storageRebate: '1',
};

const mapRelayPrepare = (error: unknown) =>
  mapError(error, RELAY_PREPARE_ERROR_CODES, 'INTERNAL_ERROR');
const mapRelaySponsor = (error: unknown) =>
  mapError(error, RELAY_SPONSOR_ERROR_CODES, 'SPONSOR_FAILED');
const mapPromotionPrepare = (error: unknown) =>
  mapError(error, PROMOTION_PREPARE_ERROR_CODES, 'INTERNAL_ERROR');
const mapPromotionSponsor = (error: unknown) =>
  mapError(error, PROMOTION_SPONSOR_ERROR_CODES, 'SPONSOR_FAILED');

describe('contracts-owned Host error projection', () => {
  it('derives statuses from current codes across error classes', () => {
    expect(mapRelayPrepare(new RequestBodyTooLargeError(1))?.status).toBe(413);
    expect(mapRelayPrepare(new RequestBodyParseError())?.status).toBe(400);
    expect(mapRelayPrepare(new PrepareValidationError('NO_SPONSOR_SLOT', 'busy'))?.status).toBe(
      503,
    );
    expect(
      mapRelaySponsor(new SponsorValidationError('PREPARED_TX_EXPIRED', 'expired'))?.status,
    ).toBe(410);
    expect(
      mapPromotionPrepare(new PromotionPrepareError('not found', 'PROMOTION_NOT_FOUND'))?.status,
    ).toBe(404);
    expect(
      mapPromotionSponsor(new PromotionSponsorError('mismatch', 'PROMOTION_ID_MISMATCH'))?.status,
    ).toBe(403);
  });

  it('keeps fixed operational headers without changing code-owned status', () => {
    expect(mapRelayPrepare(new PrepareOverloadError(10, 10))).toMatchObject({
      status: 503,
      headers: { 'Retry-After': '2' },
      body: { code: 'PREPARE_OVERLOADED' },
    });
    expect(mapRelaySponsor(new SponsorLeaseExpiredError('slot-1'))).toMatchObject({
      status: 503,
      headers: { 'Retry-After': '1' },
      body: { code: 'LEASE_EXPIRED' },
    });
  });

  it('rejects a current code outside the active route', () => {
    expect(
      mapError(
        new PrepareValidationError('INSUFFICIENT_BALANCE', 'prepare only'),
        RELAY_SPONSOR_ERROR_CODES,
        'SPONSOR_FAILED',
      ),
    ).toBeNull();
  });
});

describe('code-bound metadata', () => {
  it('projects only the settlement diagnostics allowed by the primary code', () => {
    const mapped = mapRelayPrepare(
      new PrepareValidationError('INSUFFICIENT_SETTLE_INPUT', 'too low', {
        minSettleMist: '1000',
        requiredTotalIn: '2000',
        isEstimate: true,
        digest: 'must-not-leak',
        endpoint: 'https://secret.example',
      }),
    );
    expect(mapped?.body).toEqual({
      error: 'Request rejected',
      code: 'INSUFFICIENT_SETTLE_INPUT',
      minSettleMist: '1000',
      requiredTotalIn: '2000',
      isEstimate: true,
    });
  });

  it('fails closed when selected diagnostics are not canonical wire values', () => {
    expect(
      mapRelayPrepare(
        new PrepareValidationError('INSUFFICIENT_SETTLE_INPUT', 'too low', {
          minSettleMist: '01',
        }),
      ),
    ).toBeNull();
  });

  it('binds sponsor subcodes to their owning primary codes', () => {
    expect(
      mapRelaySponsor(new SponsorPreflightError('simulation failed', 'INSUFFICIENT_SETTLE_INPUT'))
        ?.body,
    ).toMatchObject({
      code: 'SPONSOR_PREFLIGHT_FAILED',
      subcode: 'INSUFFICIENT_SETTLE_INPUT',
    });
    expect(
      mapPromotionSponsor(
        new PromotionSponsorError('preflight', 'PREFLIGHT_FAILED', {
          subcode: 'REPLAY_NONCE',
        }),
      )?.body,
    ).toMatchObject({ code: 'PREFLIGHT_FAILED', subcode: 'REPLAY_NONCE' });
  });

  it('requires and preserves a digest for every known post-signature terminal error', () => {
    expect(
      mapRelaySponsor(new SponsorOnchainError('0xdigest', 'MoveAbort', undefined, GAS_USED))?.body,
    ).toMatchObject({
      code: 'SPONSOR_ONCHAIN_FAILED',
      digest: '0xdigest',
    });
    expect(
      mapRelaySponsor(new SponsorCongestionError('shared-object congestion', '0xcongestion'))?.body,
    ).toEqual({
      error: 'Service temporarily unavailable',
      code: 'SPONSOR_CONGESTION',
      digest: '0xcongestion',
    });
    expect(
      mapRelaySponsor(
        new SponsorSubmissionUncertainError('0xsubmitted-unknown', new Error('rpc timeout')),
      )?.body,
    ).toEqual({
      error: 'Service temporarily unavailable',
      code: 'SPONSOR_SUBMISSION_UNCERTAIN',
      digest: '0xsubmitted-unknown',
    });
    expect(
      mapPromotionSponsor(
        new PromotionSponsorError('reverted', 'ONCHAIN_REVERT', {
          digest: '0xpromotion',
          subcode: 'SPREAD_EXCEEDED',
        }),
      )?.body,
    ).toMatchObject({
      code: 'ONCHAIN_REVERT',
      digest: '0xpromotion',
      subcode: 'SPREAD_EXCEEDED',
    });
    expect(
      mapPromotionSponsor(
        new PromotionSponsorError('congested', 'SPONSOR_CONGESTION', {
          digest: '0xpromotion-congestion',
        }),
      )?.body,
    ).toMatchObject({ code: 'SPONSOR_CONGESTION', digest: '0xpromotion-congestion' });
    expect(
      mapPromotionSponsor(
        new PromotionSponsorError('consume failed', 'CONSUME_FAILED', {
          digest: '0xpromotion-consume',
        }),
      )?.body,
    ).toMatchObject({ code: 'CONSUME_FAILED', digest: '0xpromotion-consume' });
    expect(
      mapPromotionSponsor(
        new PromotionSponsorError('submission uncertain', 'SPONSOR_SUBMISSION_UNCERTAIN', {
          digest: '0xpromotion-unknown',
        }),
      )?.body,
    ).toMatchObject({
      code: 'SPONSOR_SUBMISSION_UNCERTAIN',
      digest: '0xpromotion-unknown',
    });
  });

  it.each([
    'ONCHAIN_REVERT',
    'SPONSOR_CONGESTION',
    'SPONSOR_SUBMISSION_UNCERTAIN',
    'CONSUME_FAILED',
  ] as const)('rejects %s without its required digest', (code) => {
    expect(mapPromotionSponsor(new PromotionSponsorError('terminal failure', code))).toBeNull();
  });
});

describe('direct Host response serializer', () => {
  it('derives coded status and rejects route overreach', () => {
    expect(codedHostError('PROMOTION_NOT_FOUND', PROMOTION_PREPARE_ERROR_CODES).status).toBe(404);
    expect(() => codedHostError('PROMOTION_NOT_FOUND', RELAY_SPONSOR_ERROR_CODES)).toThrow(
      /not valid for this route/,
    );
  });

  it('binds rate-limit metadata to a current code and message', () => {
    expect(
      codedHostError('RATE_LIMITED', RELAY_PREPARE_ERROR_CODES, { retryAfterMs: 5000 }),
    ).toEqual({
      status: 429,
      body: {
        error: 'Request temporarily blocked',
        code: 'RATE_LIMITED',
        retryAfterMs: 5000,
      },
    });
  });

  it('rejects a coded response whose message drifts from the contracts authority', () => {
    expect(() =>
      parseHostErrorResponse(
        { error: 'Promotion not found', code: 'PROMOTION_NOT_FOUND' },
        PROMOTION_PREPARE_ERROR_CODES,
        404,
      ),
    ).toThrow(/error does not match the current code/);
    expect(hostErrorPublicMessage('PROMOTION_NOT_FOUND')).toBe('Resource not found');
  });
});

describe('unknown internal errors', () => {
  it('maps typed Sui failures to the route-owned existing internal code', () => {
    const error = new SuiOperationError('transport_unavailable', {
      operation: 'simulate_transaction',
      attempt: 2,
      maxAttempts: 2,
      rpcCode: 'UNAVAILABLE',
    });

    expect(mapRelayPrepare(error)).toEqual({
      status: 500,
      body: { error: 'Internal server error', code: 'INTERNAL_ERROR' },
    });
    expect(mapPromotionPrepare(error)?.body.code).toBe('INTERNAL_ERROR');
    expect(mapRelaySponsor(error)?.body.code).toBe('SPONSOR_FAILED');
    expect(mapPromotionSponsor(error)?.body.code).toBe('SPONSOR_FAILED');
    expect(JSON.stringify(mapRelayPrepare(error))).not.toContain('UNAVAILABLE');
    expect(JSON.stringify(mapRelayPrepare(error))).not.toContain('simulate_transaction');
  });

  it('does not publish internal diagnostic codes or arbitrary values', () => {
    expect(
      mapRelayPrepare(new PrepareValidationError('INVALID_AMOUNT', 'internal invariant')),
    ).toBeNull();
    expect(mapRelayPrepare(new Error('unexpected'))).toBeNull();
    expect(mapRelayPrepare(new TypeError('invalid local Sui request'))).toBeNull();
    expect(mapRelayPrepare({ code: 'FAKE' })).toBeNull();
  });
});
