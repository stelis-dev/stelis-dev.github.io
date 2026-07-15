import { describe, expect, test } from 'vitest';
import {
  HOST_ERROR_HTTP_STATUS,
  HOST_ERROR_META_POLICY,
  hostErrorPublicMessage,
  PAYMENT_INPUT_INTEGRITY_SUBCODES,
  PROMOTION_PAGE_MAX_LIMIT,
  RELAY_PREPARE_ERROR_CODES,
  RELAY_SPONSOR_ERROR_CODES,
  SPONSOR_FAILURE_SUBCODES,
  parseAdminPromotionListQuery,
  parseAdminPromotionListResponse,
  parseAdminSponsoredLogsQuery,
  parseAdminSponsoredLogsResponse,
  parseHostErrorResponse,
  parsePromotionListResponse,
  parsePromotionPageQuery,
  type HostErrorCode,
} from '@stelis/contracts';

const ALL_HOST_ERROR_CODES = Object.keys(HOST_ERROR_HTTP_STATUS) as HostErrorCode[];
const PROMOTION_ID_1 = '00000000-0000-4000-8000-000000000001';
const PROMOTION_ID_2 = '00000000-0000-4000-8000-000000000002';

function promotionId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function promotionListItem(currentPromotionId: string) {
  return {
    promotionId: currentPromotionId,
    displayName: `Promotion ${currentPromotionId}`,
    type: 'gas_sponsorship',
    status: 'active',
    canClaim: true,
    canUseSponsoredAction: false,
    promotionRemainingBudgetMist: '1',
    remainingParticipantSlots: 1,
    userRemainingGasAllowanceMist: null,
    unavailableReason: null,
  };
}

function adminPromotionRecord(currentPromotionId: string) {
  return {
    promotionId: currentPromotionId,
    type: 'gas_sponsorship',
    displayName: `Promotion ${currentPromotionId}`,
    description: '',
    status: 'active',
    maxParticipants: 1,
    perUserGasAllowanceMist: '1',
    totalRequiredBudgetMist: '1',
    claimDeadlineAt: null,
    postClaimUseWindowMs: 0,
    startAt: null,
    pauseReason: null,
    archiveReason: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  };
}

function currentSponsoredLogsResponse() {
  return {
    summary: {
      mode: 'all',
      sponsoredExecutions: '1',
      lossCount: '0',
      cumulativeHostNetMist: '0',
      cumulativeLossMist: '0',
    },
    entries: [
      {
        createdAt: '2026-07-15T00:00:00.000Z',
        mode: 'generic',
        outcome: 'success',
        receiptId: 'receipt-1',
        digest: 'digest-1',
        senderAddress: '0x1',
        sponsorAddress: '0x2',
        executionPathKey: 'generic',
        orderIdHash: null,
        promotionId: null,
        userId: null,
        economicsStatus: 'known',
        recoveredGasMist: '1',
        hostPaidGasMist: '1',
        hostNetMist: '0',
        hostFeeMist: '0',
        protocolFeeMist: null,
        grossGasMist: '1',
        storageRebateMist: '0',
        failureReason: null,
      },
    ],
  };
}

describe('contracts-owned Host wire authority', () => {
  test('owns one normalized Promotion-page query and its exact boundaries', () => {
    expect(parsePromotionPageQuery({})).toEqual({
      cursor: null,
      limit: 50,
    });
    expect(parsePromotionPageQuery({ cursor: PROMOTION_ID_1, limit: 1 })).toEqual({
      cursor: PROMOTION_ID_1,
      limit: 1,
    });
    expect(parsePromotionPageQuery({ limit: String(PROMOTION_PAGE_MAX_LIMIT) })).toEqual({
      cursor: null,
      limit: PROMOTION_PAGE_MAX_LIMIT,
    });
    expect(parseAdminPromotionListQuery({ status: 'active', cursor: PROMOTION_ID_1 })).toEqual({
      cursor: PROMOTION_ID_1,
      limit: 50,
      status: 'active',
    });

    for (const limit of [0, 101, 1.5, '01', '1e2']) {
      expect(() => parsePromotionPageQuery({ limit })).toThrow(/integer from 1 through 100/);
    }
    for (const cursor of [
      '00000000-0000-3000-8000-000000000001',
      '00000000-0000-4000-7000-000000000001',
      '00000000-0000-4000-8000-00000000000A',
      '',
    ]) {
      expect(() => parsePromotionPageQuery({ cursor })).toThrow(/canonical lowercase UUID-v4/);
    }
    expect(() => parseAdminPromotionListQuery({ status: '' })).toThrow(/status is not current/);
  });

  test('binds Studio pages to canonical ascending IDs and the final-item cursor', () => {
    const first = promotionListItem(PROMOTION_ID_1);
    const second = promotionListItem(PROMOTION_ID_2);
    expect(
      parsePromotionListResponse({ promotions: [first, second], nextCursor: PROMOTION_ID_2 }),
    ).toEqual({ promotions: [first, second], nextCursor: PROMOTION_ID_2 });
    expect(parsePromotionListResponse({ promotions: [first], nextCursor: null })).toEqual({
      promotions: [first],
      nextCursor: null,
    });

    expect(() =>
      parsePromotionListResponse({ promotions: [second, first], nextCursor: null }),
    ).toThrow(/strictly ascending/);
    expect(() =>
      parsePromotionListResponse({ promotions: [first, first], nextCursor: null }),
    ).toThrow(/strictly ascending/);
    expect(() =>
      parsePromotionListResponse({ promotions: [first, second], nextCursor: PROMOTION_ID_1 }),
    ).toThrow(/final returned promotionId/);
    expect(() =>
      parsePromotionListResponse({
        promotions: [promotionListItem('00000000-0000-4000-8000-00000000000A')],
        nextCursor: null,
      }),
    ).toThrow(/canonical lowercase UUID-v4/);
    expect(() =>
      parsePromotionListResponse({
        promotions: Array.from({ length: PROMOTION_PAGE_MAX_LIMIT + 1 }, (_, index) =>
          promotionListItem(promotionId(index)),
        ),
        nextCursor: null,
      }),
    ).toThrow(/at most 100 items/);
  });

  test('keeps Admin page items distinct while enforcing the same cursor contract', () => {
    const first = adminPromotionRecord(PROMOTION_ID_1);
    const second = adminPromotionRecord(PROMOTION_ID_2);
    expect(
      parseAdminPromotionListResponse({
        promotions: [first, second],
        nextCursor: PROMOTION_ID_2,
      }),
    ).toEqual({ promotions: [first, second], nextCursor: PROMOTION_ID_2 });
    expect(() =>
      parseAdminPromotionListResponse({ promotions: [first], nextCursor: PROMOTION_ID_2 }),
    ).toThrow(/final returned promotionId/);
  });

  test('owns the sponsored-log query defaults and bounds', () => {
    expect(parseAdminSponsoredLogsQuery({})).toEqual({ mode: 'all', limit: 50 });
    expect(parseAdminSponsoredLogsQuery({ mode: 'promotion', limit: '200' })).toEqual({
      mode: 'promotion',
      limit: 200,
    });
    expect(() => parseAdminSponsoredLogsQuery({ mode: 'unsupported' })).toThrow(
      /mode is not current/,
    );
    expect(() => parseAdminSponsoredLogsQuery({ limit: '0' })).toThrow(
      /canonical positive decimal/,
    );
    expect(() => parseAdminSponsoredLogsQuery({ limit: '201' })).toThrow(/at most 200/);
    expect(() => parseAdminSponsoredLogsQuery({ limit: '50', cursor: 'unsupported' })).toThrow(
      /non-current field/,
    );
  });

  test('rejects loose Admin log rows instead of accepting valid-looking fragments', () => {
    const looseTimestamp = currentSponsoredLogsResponse();
    looseTimestamp.entries[0]!.createdAt = 'July 15, 2026';
    expect(() => parseAdminSponsoredLogsResponse(looseTimestamp)).toThrow(/ISO-8601 timestamp/);

    const impossibleTimestamp = currentSponsoredLogsResponse();
    impossibleTimestamp.entries[0]!.createdAt = '2026-02-30T00:00:00.000Z';
    expect(() => parseAdminSponsoredLogsResponse(impossibleTimestamp)).toThrow(
      /ISO-8601 timestamp/,
    );

    const emptyDigest = currentSponsoredLogsResponse();
    emptyDigest.entries[0]!.digest = '';
    expect(() => parseAdminSponsoredLogsResponse(emptyDigest)).toThrow(/non-empty string/);

    const outOfRangeMist = currentSponsoredLogsResponse();
    outOfRangeMist.entries[0]!.hostPaidGasMist = '18446744073709551616';
    expect(() => parseAdminSponsoredLogsResponse(outOfRangeMist)).toThrow(/fit in u64/);

    const genericWithPromotionIdentity = currentSponsoredLogsResponse();
    Reflect.set(genericWithPromotionIdentity.entries[0]!, 'promotionId', 'promotion-1');
    expect(() => parseAdminSponsoredLogsResponse(genericWithPromotionIdentity)).toThrow(
      /generic mode cannot carry Promotion identity/,
    );

    const unknownEconomicsWithAmount = currentSponsoredLogsResponse();
    unknownEconomicsWithAmount.entries[0]!.economicsStatus = 'unknown';
    expect(() => parseAdminSponsoredLogsResponse(unknownEconomicsWithAmount)).toThrow(
      /unknown economics requires null numeric fields/,
    );
  });

  test('binds every current error code to one status, message, and metadata policy', () => {
    for (const code of ALL_HOST_ERROR_CODES) {
      const policy = HOST_ERROR_META_POLICY[code];
      const required = policy?.required ?? [];
      const body = {
        error: hostErrorPublicMessage(code),
        code,
        ...(required.includes('digest') ? { digest: '0xdigest' } : {}),
        ...(required.includes('retryAfterMs') ? { retryAfterMs: 1 } : {}),
        ...(required.includes('operationId') ? { operationId: 'operation-1' } : {}),
      };
      const status = HOST_ERROR_HTTP_STATUS[code];
      expect(parseHostErrorResponse(body, ALL_HOST_ERROR_CODES, status)).toEqual(body);

      const wrongStatus = status === 400 ? 422 : 400;
      expect(() => parseHostErrorResponse(body, ALL_HOST_ERROR_CODES, wrongStatus)).toThrow(
        /code does not match the HTTP status/,
      );
      expect(() =>
        parseHostErrorResponse(
          { ...body, error: 'Arbitrary producer message' },
          ALL_HOST_ERROR_CODES,
          status,
        ),
      ).toThrow(/error does not match the current code/);

      const disallowedField = policy?.allowed.includes('operationId')
        ? 'isEstimate'
        : 'operationId';
      expect(() =>
        parseHostErrorResponse(
          { ...body, [disallowedField]: disallowedField === 'isEstimate' ? true : 'unexpected' },
          ALL_HOST_ERROR_CODES,
          status,
        ),
      ).toThrow(/metadata not allowed/);
    }
  });

  test('rejects uncoded errors and keeps subcode vocabularies closed', () => {
    expect(() =>
      parseHostErrorResponse(
        { error: hostErrorPublicMessage('INTERNAL_ERROR') },
        ['INTERNAL_ERROR'],
        500,
      ),
    ).toThrow(/code must be a string/);
    expect(() =>
      parseHostErrorResponse(
        {
          error: hostErrorPublicMessage('SPONSOR_PREFLIGHT_FAILED'),
          code: 'SPONSOR_PREFLIGHT_FAILED',
          subcode: 'invented_subcode',
        },
        RELAY_SPONSOR_ERROR_CODES,
        422,
      ),
    ).toThrow(/subcode/);
    expect(() =>
      parseHostErrorResponse(
        {
          error: hostErrorPublicMessage('L2_EXTRACT_FAILED'),
          code: 'L2_EXTRACT_FAILED',
          subcode: SPONSOR_FAILURE_SUBCODES[0],
        },
        RELAY_PREPARE_ERROR_CODES,
        422,
      ),
    ).toThrow(/wrong subcode kind/);
    expect(new Set(SPONSOR_FAILURE_SUBCODES).size).toBe(SPONSOR_FAILURE_SUBCODES.length);
    expect(new Set(PAYMENT_INPUT_INTEGRITY_SUBCODES).size).toBe(
      PAYMENT_INPUT_INTEGRITY_SUBCODES.length,
    );
  });
});
