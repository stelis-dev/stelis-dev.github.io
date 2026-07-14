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
 * User-facing GET and POST routes share a JWT → block → rate-limit prelude via the `runStudioAuth`
 * helper (packages/app-api/src/middleware/studioAuth.ts), called AFTER the
 * route-local 503 guards so infrastructure failures keep precedence over
 * 401/429.
 *
 * Only available in dual mode when the studio env set is complete.
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
  readJsonBodyWithLimit,
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
  parsePromotionPrepareRequest,
  parsePromotionSponsorRequest,
  type PromotionClaimResponse,
  type PromotionDetailResponse,
  type PromotionListResponse,
  type PromotionPrepareResponse,
  type PromotionSponsorResponse,
} from '@stelis/contracts';
import type { AppApiContext } from '../context.js';
import type { ResolveClientIp } from '../clientIp.js';
import { buildSponsorUnavailableResponse } from '../sponsor-operations/gateResponse.js';
import { runStudioAuth } from '../middleware/studioAuth.js';
import { codedHostError, mapError, respondMapped, uncodedHostError } from '../errorMap.js';
import { safeErrorSummary } from '@stelis/core-api/observability';

export function createStudioRoutes(
  contextPromise: Promise<AppApiContext>,
  resolveClientIp: ResolveClientIp,
) {
  const app = new Hono();

  const claimFailures = {
    promotion_not_found: { code: 'PROMOTION_NOT_FOUND', message: 'Promotion not found' },
    promotion_not_active: { code: 'PROMOTION_NOT_ACTIVE', message: 'Promotion is not active' },
    promotion_not_started: { code: 'PROMOTION_NOT_ACTIVE', message: 'Promotion has not started' },
    claim_deadline_passed: {
      code: 'CLAIM_DEADLINE_PASSED',
      message: 'Promotion claim deadline has passed',
    },
    max_participants_reached: {
      code: 'PROMOTION_CAPACITY_REACHED',
      message: 'Promotion participant capacity has been reached',
    },
    already_claimed: { code: 'ALREADY_CLAIMED', message: 'Promotion already claimed' },
  } as const satisfies Record<ClaimFailureReason, { code: string; message: string }>;

  // ── GET /studio/promotions — developer-JWT principal promotion list ──
  // Guard precedence: route-local 503 → shared JWT/block/rate-limit prelude.
  app.get('/promotions', async (c) => {
    try {
      const ctx = await contextPromise;
      if (!ctx.promotionStore || !ctx.executionLedger) {
        return respondMapped(
          c,
          uncodedHostError(
            { error: 'Promotion system not available (studio not enabled)' },
            STUDIO_LIST_ERROR_CODES,
            503,
          ),
        );
      }

      const auth = await runStudioAuth(c, ctx, resolveClientIp, {
        rateLimitPrefix: 'promo_list',
        allowedErrorCodes: STUDIO_LIST_ERROR_CODES,
      });
      if (!auth.ok) return auth.response;
      const { identity } = auth;
      const userId = identity.userId;

      const promotions = await ctx.promotionStore.list({ status: 'active' });

      const items = await Promise.all(
        promotions.map(async (promo) => {
          const [entitlement, claimedCount, budgetSummary] = await Promise.all([
            ctx.executionLedger!.getEntitlement(promo.promotionId, userId),
            ctx.executionLedger!.getClaimedCount(promo.promotionId),
            ctx.executionLedger!.getBudgetSummary(promo.promotionId),
          ]);
          return computePromotionListItem(
            promo,
            entitlement,
            claimedCount,
            budgetSummary.availableMist,
          );
        }),
      );

      const response = { promotions: items } satisfies PromotionListResponse;
      return c.json(response);
    } catch (err) {
      const mapped = mapError(err, STUDIO_LIST_ERROR_CODES);
      if (mapped) return respondMapped(c, mapped);
      return respondMapped(
        c,
        uncodedHostError({ error: 'Internal server error' }, STUDIO_LIST_ERROR_CODES, 500),
      );
    }
  });

  // ── GET /studio/promotions/:id — developer-JWT principal promotion detail ──
  // Guard precedence: route-local 503 → shared JWT/block/rate-limit prelude.
  app.get('/promotions/:id', async (c) => {
    try {
      const ctx = await contextPromise;
      if (!ctx.promotionStore || !ctx.executionLedger) {
        return respondMapped(
          c,
          uncodedHostError(
            { error: 'Promotion system not available (studio not enabled)' },
            STUDIO_DETAIL_ERROR_CODES,
            503,
          ),
        );
      }

      const auth = await runStudioAuth(c, ctx, resolveClientIp, {
        rateLimitPrefix: 'promo_detail',
        allowedErrorCodes: STUDIO_DETAIL_ERROR_CODES,
      });
      if (!auth.ok) return auth.response;
      const { identity } = auth;
      const userId = identity.userId;

      const promotionId = c.req.param('id');
      const promotion = await ctx.promotionStore.get(promotionId);
      if (!promotion) {
        return respondMapped(
          c,
          codedHostError(
            { error: 'Promotion not found', code: 'PROMOTION_NOT_FOUND' },
            STUDIO_DETAIL_ERROR_CODES,
          ),
        );
      }

      const [entitlement, claimedCount, budgetSummary] = await Promise.all([
        ctx.executionLedger.getEntitlement(promotionId, userId),
        ctx.executionLedger.getClaimedCount(promotionId),
        ctx.executionLedger.getBudgetSummary(promotionId),
      ]);

      const detail = computeUserPromotionDetail(promotion, entitlement, claimedCount);

      const response = {
        promotionId: promotion.promotionId,
        displayName: promotion.displayName,
        type: promotion.type,
        promotionRemainingBudgetMist: budgetSummary.availableMist.toString(),
        detail,
      } satisfies PromotionDetailResponse;
      return c.json(response);
    } catch (err) {
      const mapped = mapError(err, STUDIO_DETAIL_ERROR_CODES);
      if (mapped) return respondMapped(c, mapped);
      return respondMapped(
        c,
        uncodedHostError({ error: 'Internal server error' }, STUDIO_DETAIL_ERROR_CODES, 500),
      );
    }
  });

  // ── POST /studio/promotions/:id/claim — claim a promotion ────────
  // Guard precedence: route-local 503 → shared JWT/block/rate-limit prelude.
  app.post('/promotions/:id/claim', async (c) => {
    try {
      const ctx = await contextPromise;
      // 503 guards first — infrastructure/availability failures outrank
      // auth and rate-limit.
      if (!ctx.promotionStore || !ctx.executionLedger) {
        return respondMapped(
          c,
          uncodedHostError(
            { error: 'Promotion system not available (studio not enabled)' },
            STUDIO_CLAIM_ERROR_CODES,
            503,
          ),
        );
      }

      const auth = await runStudioAuth(c, ctx, resolveClientIp, {
        rateLimitPrefix: 'promo_claim',
        allowedErrorCodes: STUDIO_CLAIM_ERROR_CODES,
      });
      if (!auth.ok) return auth.response;
      const { identity, ip } = auth;
      const userId = identity.userId;
      const promotionId = c.req.param('id');

      // Body — claim requires no wallet address (ownership = promotionId + userId)
      await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES);

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

        const failure = claimFailures[result.reason];
        return respondMapped(
          c,
          codedHostError({ error: failure.message, code: failure.code }, STUDIO_CLAIM_ERROR_CODES),
        );
      }

      const response = { entitlement: result.entitlement } satisfies PromotionClaimResponse;
      return c.json(response, 201);
    } catch (err) {
      const mapped = mapError(err, STUDIO_CLAIM_ERROR_CODES);
      if (mapped) return respondMapped(c, mapped);
      return respondMapped(
        c,
        uncodedHostError({ error: 'Internal server error' }, STUDIO_CLAIM_ERROR_CODES, 500),
      );
    }
  });

  // ── POST /studio/promotions/:id/prepare ────────────────────────────
  // Guard precedence: route-local 503 → shared JWT/block/rate-limit prelude.
  app.post('/promotions/:id/prepare', async (c) => {
    try {
      const ctx = await contextPromise;

      // 503 guards first — infrastructure/availability failures outrank
      // auth and rate-limit.
      if (!ctx.studio) {
        return respondMapped(
          c,
          uncodedHostError(
            { error: 'Studio mode is not enabled on this server' },
            PROMOTION_PREPARE_ERROR_CODES,
            503,
          ),
        );
      }
      if (!ctx.promotionStore || !ctx.executionLedger) {
        return respondMapped(
          c,
          uncodedHostError(
            { error: 'Promotion system not available' },
            PROMOTION_PREPARE_ERROR_CODES,
            503,
          ),
        );
      }
      if (!ctx.studioGlobalAllowedTargets) {
        return respondMapped(
          c,
          uncodedHostError(
            { error: 'Global target policy not configured' },
            PROMOTION_PREPARE_ERROR_CODES,
            503,
          ),
        );
      }

      const [sponsorOperationsState, slotLeases] = await Promise.all([
        ctx.sponsorOperations.readState(),
        ctx.host.sponsorPool.leaseStatus(),
      ]);
      const blocked = buildSponsorUnavailableResponse(sponsorOperationsState, {
        requireFreeSponsorSlot: true,
        slotLeases,
      });
      if (blocked) {
        for (const [k, v] of Object.entries(blocked.headers)) c.header(k, v);
        return respondMapped(
          c,
          codedHostError(blocked.body, PROMOTION_PREPARE_ERROR_CODES, blocked.headers),
        );
      }

      const auth = await runStudioAuth(c, ctx, resolveClientIp, {
        rateLimitPrefix: 'promo_prepare',
        allowedErrorCodes: PROMOTION_PREPARE_ERROR_CODES,
      });
      if (!auth.ok) return auth.response;
      const { identity, ip } = auth;
      const promotionId = c.req.param('id');

      const body = parsePromotionPrepareRequest(
        await readJsonBodyWithLimit(c.req.raw, MAX_PREPARE_REQUEST_BODY_BYTES),
      );

      const prepareCtx: PromotionPrepareContext = {
        sui: ctx.host.sui,
        promotionStore: ctx.promotionStore,
        executionLedger: ctx.executionLedger,
        sponsorPool: ctx.host.sponsorPool,
        prepareStore: ctx.host.prepareStore,
        prepareInflightLimiter: ctx.host.prepareInflightLimiter,
        getConfig: ctx.host.getConfig.bind(ctx.host),
        globalAllowedTargets: ctx.studioGlobalAllowedTargets,
      };

      const result: PromotionPrepareResponse = await handlePromotionPrepare(prepareCtx, {
        promotionId,
        senderAddress: body.senderAddress,
        txKindBytes: body.txKindBytes,
        verifiedIdentity: identity,
        clientIp: ip,
      });

      return c.json(result);
    } catch (err) {
      if (err instanceof HostWireParseError) {
        return respondMapped(
          c,
          codedHostError(
            {
              error: 'Request body does not match the current API contract',
              code: 'BAD_REQUEST',
            },
            PROMOTION_PREPARE_ERROR_CODES,
          ),
        );
      }
      const mapped = mapError(err, PROMOTION_PREPARE_ERROR_CODES);
      if (mapped) return respondMapped(c, mapped);
      // eslint-disable-next-line no-console
      console.error('[app-api /studio/promotions/:id/prepare] 500 error:', safeErrorSummary(err));
      return respondMapped(
        c,
        codedHostError(
          { error: 'Internal server error', code: 'INTERNAL_ERROR' },
          PROMOTION_PREPARE_ERROR_CODES,
        ),
      );
    }
  });

  // ── POST /studio/promotions/:id/sponsor ───────────────────────────
  // Guard precedence: route-local 503 → shared JWT/block/rate-limit prelude.
  app.post('/promotions/:id/sponsor', async (c) => {
    try {
      const ctx = await contextPromise;

      // 503 guards first — infrastructure/availability failures outrank
      // auth and rate-limit.
      if (!ctx.studio) {
        return respondMapped(
          c,
          uncodedHostError(
            { error: 'Studio mode is not enabled on this server' },
            PROMOTION_SPONSOR_ERROR_CODES,
            503,
          ),
        );
      }
      if (!ctx.promotionStore || !ctx.executionLedger) {
        return respondMapped(
          c,
          uncodedHostError(
            { error: 'Promotion system not available' },
            PROMOTION_SPONSOR_ERROR_CODES,
            503,
          ),
        );
      }
      if (!ctx.studioGlobalAllowedTargets) {
        return respondMapped(
          c,
          uncodedHostError(
            { error: 'Global target policy not configured' },
            PROMOTION_SPONSOR_ERROR_CODES,
            503,
          ),
        );
      }

      const sponsorOperationsState = await ctx.sponsorOperations.readState();
      const blocked = buildSponsorUnavailableResponse(sponsorOperationsState);
      if (blocked) {
        for (const [k, v] of Object.entries(blocked.headers)) c.header(k, v);
        return respondMapped(
          c,
          codedHostError(blocked.body, PROMOTION_SPONSOR_ERROR_CODES, blocked.headers),
        );
      }

      const auth = await runStudioAuth(c, ctx, resolveClientIp, {
        rateLimitPrefix: 'promo_sponsor',
        allowedErrorCodes: PROMOTION_SPONSOR_ERROR_CODES,
      });
      if (!auth.ok) return auth.response;
      const { identity, ip } = auth;
      const promotionId = c.req.param('id');

      const body = parsePromotionSponsorRequest(
        await readJsonBodyWithLimit(c.req.raw, MAX_SPONSOR_REQUEST_BODY_BYTES),
      );

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
        prepareStore: ctx.host.prepareStore,
        abuseBlocker: ctx.host.abuseBlocker,
        usageStore: ctx.usageStore ?? null,
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
        clientIp: ip,
      });

      return c.json(sponsorResult);
    } catch (err) {
      if (err instanceof HostWireParseError) {
        return respondMapped(
          c,
          codedHostError(
            {
              error: 'Request body does not match the current API contract',
              code: 'BAD_REQUEST',
            },
            PROMOTION_SPONSOR_ERROR_CODES,
          ),
        );
      }
      const mapped = mapError(err, PROMOTION_SPONSOR_ERROR_CODES);
      if (mapped) return respondMapped(c, mapped);
      // eslint-disable-next-line no-console
      console.error('[app-api /studio/promotions/:id/sponsor] 500 error:', safeErrorSummary(err));
      return respondMapped(
        c,
        codedHostError(
          { error: 'Internal server error', code: 'SPONSOR_FAILED' },
          PROMOTION_SPONSOR_ERROR_CODES,
        ),
      );
    }
  });

  return app;
}
