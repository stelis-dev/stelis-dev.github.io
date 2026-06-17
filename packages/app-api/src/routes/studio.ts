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
  handlePromotionPrepare,
  type PromotionPrepareContext,
  handlePromotionSponsor,
  type PromotionSponsorContext,
  type PromotionSponsorResult,
  recordPromotionAbuseEvent,
  PROMOTION_ABUSE_CODES,
} from '@stelis/core-api/studio';
import {
  readJsonBodyWithLimit,
  MAX_SMALL_REQUEST_BODY_BYTES,
  MAX_PREPARE_REQUEST_BODY_BYTES,
  MAX_SPONSOR_REQUEST_BODY_BYTES,
} from '@stelis/core-api';
import type { AppApiContext } from '../context.js';
import { buildSponsorUnavailableResponse } from '../sponsor-operations/gateResponse.js';
import { runStudioAuth } from '../middleware/studioAuth.js';
import { mapError, respondMapped } from '../errorMap.js';

export function createStudioRoutes(getCtx: () => Promise<AppApiContext>) {
  const app = new Hono();

  // ── GET /studio/promotions — developer-JWT principal promotion list ──
  // Guard precedence: route-local 503 → shared JWT/block/rate-limit prelude.
  app.get('/promotions', async (c) => {
    try {
      const ctx = await getCtx();
      if (!ctx.promotionStore || !ctx.executionLedger) {
        return c.json({ error: 'Promotion system not available (studio not enabled)' }, 503);
      }

      const auth = await runStudioAuth(c, ctx, { rateLimitPrefix: 'promo_list' });
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

      return c.json({ promotions: items });
    } catch (err) {
      const mapped = mapError(err);
      if (mapped) return respondMapped(c, mapped);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── GET /studio/promotions/:id — developer-JWT principal promotion detail ──
  // Guard precedence: route-local 503 → shared JWT/block/rate-limit prelude.
  app.get('/promotions/:id', async (c) => {
    try {
      const ctx = await getCtx();
      if (!ctx.promotionStore || !ctx.executionLedger) {
        return c.json({ error: 'Promotion system not available (studio not enabled)' }, 503);
      }

      const auth = await runStudioAuth(c, ctx, { rateLimitPrefix: 'promo_detail' });
      if (!auth.ok) return auth.response;
      const { identity } = auth;
      const userId = identity.userId;

      const promotionId = c.req.param('id');
      const promotion = await ctx.promotionStore.get(promotionId);
      if (!promotion) {
        return c.json({ error: 'Promotion not found' }, 404);
      }

      const [entitlement, claimedCount, budgetSummary] = await Promise.all([
        ctx.executionLedger.getEntitlement(promotionId, userId),
        ctx.executionLedger.getClaimedCount(promotionId),
        ctx.executionLedger.getBudgetSummary(promotionId),
      ]);

      const detail = computeUserPromotionDetail(promotion, entitlement, claimedCount);

      return c.json({
        promotionId: promotion.promotionId,
        displayName: promotion.displayName,
        type: promotion.type,
        promotionRemainingBudgetMist: budgetSummary.availableMist.toString(),
        detail,
      });
    } catch (err) {
      const mapped = mapError(err);
      if (mapped) return respondMapped(c, mapped);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── POST /studio/promotions/:id/claim — claim a promotion ────────
  // Guard precedence: route-local 503 → shared JWT/block/rate-limit prelude.
  // Claim uses a distinct JWT failure contract: non-DeveloperJwtAuthError
  // maps to 500 `{ error: 'Internal server error' }` (no `code` field).
  app.post('/promotions/:id/claim', async (c) => {
    try {
      const ctx = await getCtx();
      // 503 guards first — infrastructure/availability failures outrank
      // auth and rate-limit.
      if (!ctx.promotionStore || !ctx.executionLedger) {
        return c.json({ error: 'Promotion system not available (studio not enabled)' }, 503);
      }

      const auth = await runStudioAuth(c, ctx, { rateLimitPrefix: 'promo_claim' });
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
        if (abuseCode && ctx.relay.abuseBlocker) {
          await recordPromotionAbuseEvent(
            ctx.relay.abuseBlocker,
            ip,
            { kind: 'studio_user', userId: identity.userId },
            abuseCode,
            { promotionId, userId },
          );
        }

        const statusMap: Record<string, number> = {
          promotion_not_found: 404,
          promotion_not_active: 409,
          promotion_not_started: 409,
          claim_deadline_passed: 409,
          max_participants_reached: 409,
          already_claimed: 409,
        };
        return c.json(
          { error: result.reason },
          (statusMap[result.reason] ?? 500) as 404 | 409 | 500,
        );
      }

      return c.json({ entitlement: result.entitlement }, 201);
    } catch (err) {
      const mapped = mapError(err);
      if (mapped) return respondMapped(c, mapped);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── POST /studio/promotions/:id/prepare ────────────────────────────
  // Guard precedence: route-local 503 → shared JWT/block/rate-limit prelude.
  // Prepare escalates unknown JWT errors to 401 AUTH_JWT_INVALID.
  app.post('/promotions/:id/prepare', async (c) => {
    try {
      const ctx = await getCtx();

      // 503 guards first — infrastructure/availability failures outrank
      // auth and rate-limit.
      if (!ctx.studio) {
        return c.json({ error: 'Studio mode is not enabled on this server' }, 503);
      }
      if (!ctx.promotionStore || !ctx.executionLedger) {
        return c.json({ error: 'Promotion system not available' }, 503);
      }
      if (!ctx.studioGlobalTargetHashes) {
        return c.json({ error: 'Global target policy not configured' }, 503);
      }

      const [sponsorOperationsState, slotLeases] = await Promise.all([
        ctx.sponsorOperations.readState(),
        ctx.relay.sponsorPool.leaseStatus(),
      ]);
      const blocked = buildSponsorUnavailableResponse(sponsorOperationsState, {
        requireFreeSponsorSlot: true,
        slotLeases,
      });
      if (blocked) {
        for (const [k, v] of Object.entries(blocked.headers)) c.header(k, v);
        return c.json(blocked.body, blocked.status);
      }

      const auth = await runStudioAuth(c, ctx, {
        rateLimitPrefix: 'promo_prepare',
        unknownJwtErrorAs401: true,
      });
      if (!auth.ok) return auth.response;
      const { identity, ip } = auth;
      const promotionId = c.req.param('id');

      const body = await readJsonBodyWithLimit<Record<string, unknown>>(
        c.req.raw,
        MAX_PREPARE_REQUEST_BODY_BYTES,
      );
      if (typeof body.senderAddress !== 'string' || typeof body.txKindBytes !== 'string') {
        return c.json(
          { error: 'Missing required fields: senderAddress, txKindBytes', code: 'BAD_REQUEST' },
          400,
        );
      }

      const prepareCtx: PromotionPrepareContext = {
        sui: ctx.relay.sui,
        promotionStore: ctx.promotionStore,
        executionLedger: ctx.executionLedger,
        sponsorPool: ctx.relay.sponsorPool,
        prepareStore: ctx.relay.prepareStore,
        prepareInflightLimiter: ctx.relay.prepareInflightLimiter,
        getConfig: ctx.relay.getConfig.bind(ctx.relay),
        globalTargetHashes: ctx.studioGlobalTargetHashes,
      };

      const result = await handlePromotionPrepare(prepareCtx, {
        promotionId,
        senderAddress: body.senderAddress,
        txKindBytes: body.txKindBytes,
        verifiedIdentity: identity,
        clientIp: ip,
      });

      return c.json(result);
    } catch (err) {
      const mapped = mapError(err);
      if (mapped) return respondMapped(c, mapped);
      // eslint-disable-next-line no-console
      console.error(
        '[app-api /studio/promotions/:id/prepare] 500 error:',
        err instanceof Error ? err.message : err,
      );
      return c.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500);
    }
  });

  // ── POST /studio/promotions/:id/sponsor ───────────────────────────
  // Guard precedence: route-local 503 → shared JWT/block/rate-limit prelude.
  // Sponsor escalates unknown JWT errors to 401 AUTH_JWT_INVALID.
  app.post('/promotions/:id/sponsor', async (c) => {
    try {
      const ctx = await getCtx();

      // 503 guards first — infrastructure/availability failures outrank
      // auth and rate-limit.
      if (!ctx.studio) {
        return c.json({ error: 'Studio mode is not enabled on this server' }, 503);
      }
      if (!ctx.promotionStore || !ctx.executionLedger) {
        return c.json({ error: 'Promotion system not available' }, 503);
      }
      if (!ctx.studioGlobalTargetHashes) {
        return c.json({ error: 'Global target policy not configured' }, 503);
      }

      const sponsorOperationsState = await ctx.sponsorOperations.readState();
      const blocked = buildSponsorUnavailableResponse(sponsorOperationsState);
      if (blocked) {
        for (const [k, v] of Object.entries(blocked.headers)) c.header(k, v);
        return c.json(blocked.body, blocked.status);
      }

      const auth = await runStudioAuth(c, ctx, {
        rateLimitPrefix: 'promo_sponsor',
        unknownJwtErrorAs401: true,
      });
      if (!auth.ok) return auth.response;
      const { identity, ip } = auth;
      const promotionId = c.req.param('id');

      const body = await readJsonBodyWithLimit<Record<string, unknown>>(
        c.req.raw,
        MAX_SPONSOR_REQUEST_BODY_BYTES,
      );
      if (
        typeof body.receiptId !== 'string' ||
        typeof body.txBytes !== 'string' ||
        typeof body.userSignature !== 'string'
      ) {
        return c.json(
          {
            error: 'Missing required fields: receiptId, txBytes, userSignature',
            code: 'BAD_REQUEST',
          },
          400,
        );
      }

      const sponsorCtx: PromotionSponsorContext = {
        sui: ctx.relay.sui,
        // Trusted package IDs for sponsor-time abort classification.
        // Same package IDs (`RelayerContext.{packageId, deepbookPackageId}`) as
        // the generic /relay/sponsor route — bound at app-api boot via
        // `DEEPBOOK_IDS[network].packageId`.
        packageId: ctx.relay.packageId,
        deepbookPackageId: ctx.relay.deepbookPackageId,
        promotionStore: ctx.promotionStore,
        executionLedger: ctx.executionLedger,
        sponsorPool: ctx.relay.sponsorPool,
        prepareStore: ctx.relay.prepareStore,
        abuseBlocker: ctx.relay.abuseBlocker,
        usageStore: ctx.usageStore ?? null,
        globalTargetHashes: ctx.studioGlobalTargetHashes,
        onSponsorResult: ctx.relay.onSponsorResult,
      };

      // The post-terminal host callback writes slot and sponsor refill account state through
      // the sponsor runner path, so no separate wake signal
      // is required here.
      const sponsorResult: PromotionSponsorResult = await handlePromotionSponsor(sponsorCtx, {
        promotionId,
        receiptId: body.receiptId,
        txBytes: body.txBytes,
        userSignature: body.userSignature,
        verifiedIdentity: identity,
        clientIp: ip,
      });

      return c.json(sponsorResult);
    } catch (err) {
      const mapped = mapError(err);
      if (mapped) return respondMapped(c, mapped);
      // eslint-disable-next-line no-console
      console.error(
        '[app-api /studio/promotions/:id/sponsor] 500 error:',
        err instanceof Error ? err.message : err,
      );
      return c.json({ error: 'Internal server error', code: 'SPONSOR_FAILED' }, 500);
    }
  });

  return app;
}
