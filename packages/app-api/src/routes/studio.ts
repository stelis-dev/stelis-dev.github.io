/**
 * [app-api] Studio routes —
 * GET /studio/promotions, GET /studio/promotions/:id,
 * POST /studio/promotions/:id/claim,
 * POST /studio/promotions/:id/prepare,
 * POST /studio/promotions/:id/sponsor
 *
 * Auth: All user-facing routes require Authorization: Bearer <developerJwt>
 * verified locally against host-owned trust material (STUDIO_DEVELOPER_JWT_TRUST_JSON).
 *
 * User-facing GET and POST routes first perform mode, IP, request-shape, and
 * bounded-body admission. `runStudioAuth` then verifies the credential and
 * applies authenticated-subject admission before any promotion or sponsor I/O.
 *
 * Available only when the Host booted in `relay_with_admin_and_studio` mode.
 */
import { Hono } from 'hono';
import {
  computePromotionListItem,
  computeUserPromotionDetail,
  handlePromotionClaim,
  type ClaimFailureReason,
  handlePromotionPrepare,
  type PromotionPrepareContext,
  handlePromotionSponsor,
  type PromotionSponsorContext,
  recordPromotionAbuseEvent,
  PROMOTION_ABUSE_CODES,
} from '@stelis/core-api/studio';
import {
  MAX_SMALL_REQUEST_BODY_BYTES,
  MAX_PREPARE_REQUEST_BODY_BYTES,
  MAX_SPONSOR_REQUEST_BODY_BYTES,
} from '@stelis/core-api';
import {
  HostWireParseError,
  PROMOTION_PREPARE_ERROR_CODES,
  PROMOTION_SPONSOR_ERROR_CODES,
  STUDIO_CLAIM_ERROR_CODES,
  STUDIO_DETAIL_ERROR_CODES,
  STUDIO_LIST_ERROR_CODES,
  parsePromotionClaimRequest,
  parsePromotionId,
  parsePromotionListResponse,
  parsePromotionPageQuery,
  parsePromotionPrepareRequest,
  parsePromotionSponsorRequest,
  type PromotionClaimResponse,
  type PromotionDetailResponse,
  type PromotionPrepareResponse,
  type PromotionSponsorResponse,
} from '@stelis/contracts';
import type { RelayWithAdminAndStudioAppApiContext } from '../context.js';
import { beginRequestAdmission, type RequestAdmissionDependencies } from '../requestAdmission.js';
import { buildSponsorUnavailableResponse } from '../sponsor-operations/gateResponse.js';
import { runStudioAuth } from '../middleware/studioAuth.js';
import { codedHostError, mapError, respondMapped } from '../errorMap.js';
import { safeErrorSummary } from '@stelis/core-api/observability';

class StudioPrepareAdmissionError extends Error {
  constructor(
    readonly errorCode: 'SPONSOR_CAPACITY_UNAVAILABLE' | 'SPONSOR_REFILL_ACCOUNT_UNHEALTHY',
    readonly headers: Readonly<Record<string, string>>,
  ) {
    super(errorCode);
    this.name = 'StudioPrepareAdmissionError';
  }
}

export function createStudioRoutes(
  context: RelayWithAdminAndStudioAppApiContext,
  admission: RequestAdmissionDependencies,
) {
  const app = new Hono();

  const claimFailureCodes = {
    promotion_not_found: 'PROMOTION_NOT_FOUND',
    promotion_not_active: 'PROMOTION_NOT_ACTIVE',
    promotion_not_started: 'PROMOTION_NOT_ACTIVE',
    claim_deadline_passed: 'CLAIM_DEADLINE_PASSED',
    max_participants_reached: 'PROMOTION_CAPACITY_REACHED',
    already_claimed: 'ALREADY_CLAIMED',
    current_conflict: 'PROMOTION_CURRENT_CONFLICT',
  } as const satisfies Record<ClaimFailureReason, (typeof STUDIO_CLAIM_ERROR_CODES)[number]>;

  // ── GET /studio/promotions — developer-JWT principal promotion list ──
  app.get('/promotions', async (c) => {
    try {
      const admitted = await beginRequestAdmission(c, admission, {
        allowedErrorCodes: STUDIO_LIST_ERROR_CODES,
        unexpectedFailureCode: 'INTERNAL_ERROR',
        ipRateLimitKey: (ip) => `promo_list:client-ip:${ip}`,
      });
      if (!admitted.ok) return admitted.response;
      let pageParams;
      try {
        pageParams = parsePromotionPageQuery(c.req.query());
      } catch (err) {
        if (err instanceof HostWireParseError) {
          return respondMapped(c, codedHostError('BAD_REQUEST', STUDIO_LIST_ERROR_CODES));
        }
        throw err;
      }
      const ctx = context;
      const auth = await runStudioAuth(c, ctx, admission, admitted.value, {
        rateLimitPrefix: 'promo_list',
        allowedErrorCodes: STUDIO_LIST_ERROR_CODES,
      });
      if (!auth.ok) return auth.response;
      const { identity } = auth;
      const userId = identity.userId;

      const page = await ctx.promotionStore.listPage(pageParams, { status: 'active' });
      const promotionIds = page.promotions.map((promotion) => promotion.promotionId);
      const ledgerStatuses = await ctx.executionLedger.getPromotionListLedgerStatuses(
        promotionIds,
        userId,
      );
      if (ledgerStatuses.length !== page.promotions.length) {
        throw new Error('Promotion list ledger status length mismatch');
      }

      const items = page.promotions.map((promotion, index) => {
        const ledgerStatus = ledgerStatuses[index];
        if (ledgerStatus === undefined || ledgerStatus.promotionId !== promotion.promotionId) {
          throw new Error('Promotion list ledger status ID mismatch');
        }
        return computePromotionListItem(
          promotion,
          ledgerStatus.entitlement,
          ledgerStatus.claimedCount,
          ledgerStatus.availableBudgetMist,
        );
      });

      return c.json(parsePromotionListResponse({ promotions: items, nextCursor: page.nextCursor }));
    } catch (err) {
      const mapped = mapError(err, STUDIO_LIST_ERROR_CODES, 'INTERNAL_ERROR');
      if (mapped) return respondMapped(c, mapped);
      return respondMapped(c, codedHostError('INTERNAL_ERROR', STUDIO_LIST_ERROR_CODES));
    }
  });

  // ── GET /studio/promotions/:id — developer-JWT principal promotion detail ──
  app.get('/promotions/:id', async (c) => {
    try {
      const admitted = await beginRequestAdmission(c, admission, {
        allowedErrorCodes: STUDIO_DETAIL_ERROR_CODES,
        unexpectedFailureCode: 'INTERNAL_ERROR',
        ipRateLimitKey: (ip) => `promo_detail:client-ip:${ip}`,
      });
      if (!admitted.ok) return admitted.response;
      const promotionId = parsePromotionId(c.req.param('id'));
      const ctx = context;
      const auth = await runStudioAuth(c, ctx, admission, admitted.value, {
        rateLimitPrefix: 'promo_detail',
        allowedErrorCodes: STUDIO_DETAIL_ERROR_CODES,
        promotionId,
      });
      if (!auth.ok) return auth.response;
      const { identity } = auth;
      const userId = identity.userId;

      const promotion = await ctx.promotionStore.get(promotionId);
      if (!promotion) {
        return respondMapped(c, codedHostError('PROMOTION_NOT_FOUND', STUDIO_DETAIL_ERROR_CODES));
      }

      const ledgerStatus = await ctx.executionLedger.getPromotionLedgerStatus(promotionId, userId);

      const detail = computeUserPromotionDetail(
        promotion,
        ledgerStatus.entitlement,
        ledgerStatus.claimedCount,
      );

      const response = {
        promotionId: promotion.promotionId,
        displayName: promotion.displayName,
        type: promotion.type,
        promotionRemainingBudgetMist: ledgerStatus.budget.availableMist.toString(),
        detail,
      } satisfies PromotionDetailResponse;
      return c.json(response);
    } catch (err) {
      if (err instanceof HostWireParseError) {
        return respondMapped(c, codedHostError('BAD_REQUEST', STUDIO_DETAIL_ERROR_CODES));
      }
      const mapped = mapError(err, STUDIO_DETAIL_ERROR_CODES, 'INTERNAL_ERROR');
      if (mapped) return respondMapped(c, mapped);
      return respondMapped(c, codedHostError('INTERNAL_ERROR', STUDIO_DETAIL_ERROR_CODES));
    }
  });

  // ── POST /studio/promotions/:id/claim — claim a promotion ────────
  app.post('/promotions/:id/claim', async (c) => {
    try {
      const admitted = await beginRequestAdmission(c, admission, {
        allowedErrorCodes: STUDIO_CLAIM_ERROR_CODES,
        unexpectedFailureCode: 'INTERNAL_ERROR',
        ipRateLimitKey: (ip) => `promo_claim:client-ip:${ip}`,
        jsonBodyLimitBytes: MAX_SMALL_REQUEST_BODY_BYTES,
      });
      if (!admitted.ok) return admitted.response;
      parsePromotionClaimRequest(admitted.value.body);
      const promotionId = parsePromotionId(c.req.param('id'));
      const ctx = context;
      const auth = await runStudioAuth(c, ctx, admission, admitted.value, {
        rateLimitPrefix: 'promo_claim',
        allowedErrorCodes: STUDIO_CLAIM_ERROR_CODES,
        promotionId,
      });
      if (!auth.ok) return auth.response;
      const { identity, ip } = auth;
      const userId = identity.userId;

      // Body — claim requires no wallet address (ownership = promotionId + userId)
      const result = await handlePromotionClaim(
        { promotionId, userId },
        { catalog: ctx.promotionStore, ledger: ctx.executionLedger },
      );

      if (!result.ok) {
        const abuseCodeMap: Record<
          string,
          (typeof PROMOTION_ABUSE_CODES)[keyof typeof PROMOTION_ABUSE_CODES] | undefined
        > = {
          already_claimed: PROMOTION_ABUSE_CODES.DUPLICATE_CLAIM,
          claim_deadline_passed: PROMOTION_ABUSE_CODES.DEADLINE_PASSED,
          max_participants_reached: PROMOTION_ABUSE_CODES.CAPACITY_EXCEEDED,
          promotion_not_active: PROMOTION_ABUSE_CODES.NOT_ACTIVE,
        };
        const abuseCode = abuseCodeMap[result.reason];
        if (abuseCode && ctx.host.abuseBlocker) {
          await recordPromotionAbuseEvent(
            ctx.host.abuseBlocker,
            ip,
            { kind: 'studio_user', userId: identity.userId },
            abuseCode,
            { promotionId, userId },
          );
        }

        const failureCode = claimFailureCodes[result.reason];
        return respondMapped(c, codedHostError(failureCode, STUDIO_CLAIM_ERROR_CODES));
      }

      const response = { entitlement: result.entitlement } satisfies PromotionClaimResponse;
      return c.json(response, 201);
    } catch (err) {
      if (err instanceof HostWireParseError) {
        return respondMapped(c, codedHostError('BAD_REQUEST', STUDIO_CLAIM_ERROR_CODES));
      }
      const mapped = mapError(err, STUDIO_CLAIM_ERROR_CODES, 'INTERNAL_ERROR');
      if (mapped) return respondMapped(c, mapped);
      return respondMapped(c, codedHostError('INTERNAL_ERROR', STUDIO_CLAIM_ERROR_CODES));
    }
  });

  // ── POST /studio/promotions/:id/prepare ────────────────────────────
  app.post('/promotions/:id/prepare', async (c) => {
    try {
      const admitted = await beginRequestAdmission(c, admission, {
        allowedErrorCodes: PROMOTION_PREPARE_ERROR_CODES,
        unexpectedFailureCode: 'INTERNAL_ERROR',
        ipRateLimitKey: (ip) => `promo_prepare:client-ip:${ip}`,
        jsonBodyLimitBytes: MAX_PREPARE_REQUEST_BODY_BYTES,
      });
      if (!admitted.ok) return admitted.response;
      const body = parsePromotionPrepareRequest(admitted.value.body);
      const promotionId = parsePromotionId(c.req.param('id'));
      const ctx = context;
      const auth = await runStudioAuth(c, ctx, admission, admitted.value, {
        rateLimitPrefix: 'promo_prepare',
        allowedErrorCodes: PROMOTION_PREPARE_ERROR_CODES,
        promotionId,
      });
      if (!auth.ok) return auth.response;
      const { identity, clientIp } = auth;

      const prepareCtx: PromotionPrepareContext = {
        sui: ctx.host.sui,
        promotionStore: ctx.promotionStore,
        executionLedger: ctx.executionLedger,
        sponsorPool: ctx.host.sponsorPool,
        sponsoredExecutionStore: ctx.host.sponsoredExecutionStore,
        prepareInflightLimiter: ctx.host.prepareInflightLimiter,
        getConfig: ctx.host.getConfig.bind(ctx.host),
        globalAllowedTargets: ctx.studioGlobalAllowedTargets,
      };

      const result: PromotionPrepareResponse = await handlePromotionPrepare(
        prepareCtx,
        {
          promotionId,
          senderAddress: body.senderAddress,
          txKindBytes: body.txKindBytes,
          verifiedIdentity: identity,
          clientIp,
        },
        {
          async assertSponsorAvailable() {
            const [sponsorOperationsState, slotLeases] = await Promise.all([
              ctx.sponsorAvailability.readState(),
              ctx.host.sponsorPool.leaseStatus(),
            ]);
            const blocked = buildSponsorUnavailableResponse(sponsorOperationsState, slotLeases);
            if (!blocked) return;
            throw new StudioPrepareAdmissionError(blocked.errorCode, blocked.headers);
          },
        },
      );

      return c.json(result);
    } catch (err) {
      if (err instanceof StudioPrepareAdmissionError) {
        return respondMapped(
          c,
          codedHostError(err.errorCode, PROMOTION_PREPARE_ERROR_CODES, {}, err.headers),
        );
      }
      if (err instanceof HostWireParseError) {
        return respondMapped(c, codedHostError('BAD_REQUEST', PROMOTION_PREPARE_ERROR_CODES));
      }
      const mapped = mapError(err, PROMOTION_PREPARE_ERROR_CODES, 'INTERNAL_ERROR');
      if (mapped) return respondMapped(c, mapped);
      // eslint-disable-next-line no-console
      console.error('[app-api /studio/promotions/:id/prepare] 500 error:', safeErrorSummary(err));
      return respondMapped(c, codedHostError('INTERNAL_ERROR', PROMOTION_PREPARE_ERROR_CODES));
    }
  });

  // ── POST /studio/promotions/:id/sponsor ───────────────────────────
  app.post('/promotions/:id/sponsor', async (c) => {
    try {
      const admitted = await beginRequestAdmission(c, admission, {
        allowedErrorCodes: PROMOTION_SPONSOR_ERROR_CODES,
        unexpectedFailureCode: 'INTERNAL_ERROR',
        ipRateLimitKey: (ip) => `promo_sponsor:client-ip:${ip}`,
        jsonBodyLimitBytes: MAX_SPONSOR_REQUEST_BODY_BYTES,
      });
      if (!admitted.ok) return admitted.response;
      const body = parsePromotionSponsorRequest(admitted.value.body);
      const promotionId = parsePromotionId(c.req.param('id'));
      const ctx = context;
      const auth = await runStudioAuth(c, ctx, admission, admitted.value, {
        rateLimitPrefix: 'promo_sponsor',
        allowedErrorCodes: PROMOTION_SPONSOR_ERROR_CODES,
        promotionId,
      });
      if (!auth.ok) return auth.response;
      const { identity, clientIp } = auth;

      const sponsorCtx: PromotionSponsorContext = {
        sui: ctx.host.sui,
        // Trusted active Stelis package ID for sponsor-time abort classification.
        // DeepBook abort identity comes from the generated compiled contract.
        packageId: ctx.host.packageId,
        // Published call target is separate provenance evidence; the generated
        // runtime ModuleId remains the abort identity trust root.
        deepbookPackageId: ctx.host.deepbookPackageId,
        promotionStore: ctx.promotionStore,
        executionLedger: ctx.executionLedger,
        sponsorPool: ctx.host.sponsorPool,
        isSponsorAddressAvailable: ctx.host.isSponsorAddressAvailable,
        sponsoredExecutionStore: ctx.host.sponsoredExecutionStore,
        abuseBlocker: ctx.host.abuseBlocker,
        globalAllowedTargets: ctx.studioGlobalAllowedTargets,
        onSponsorResult: ctx.host.onSponsorResult,
      };

      // The post-terminal host callback writes slot and sponsor refill account state through
      // the sponsor runner path, so no separate wake signal
      // is required here.
      const sponsorResult: PromotionSponsorResponse = await handlePromotionSponsor(sponsorCtx, {
        promotionId,
        receiptId: body.receiptId,
        txBytes: body.txBytes,
        userSignature: body.userSignature,
        verifiedIdentity: identity,
        clientIp,
      });

      return c.json(sponsorResult);
    } catch (err) {
      if (err instanceof HostWireParseError) {
        return respondMapped(c, codedHostError('BAD_REQUEST', PROMOTION_SPONSOR_ERROR_CODES));
      }
      const mapped = mapError(err, PROMOTION_SPONSOR_ERROR_CODES, 'SPONSOR_FAILED');
      if (mapped) return respondMapped(c, mapped);
      // eslint-disable-next-line no-console
      console.error('[app-api /studio/promotions/:id/sponsor] 500 error:', safeErrorSummary(err));
      return respondMapped(c, codedHostError('SPONSOR_FAILED', PROMOTION_SPONSOR_ERROR_CODES));
    }
  });

  return app;
}
