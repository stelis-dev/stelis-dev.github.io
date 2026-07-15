/**
 * Studio promotion route contract tests — verifies HTTP contracts
 * for promotion list, detail, and claim endpoints.
 *
 * Uses in-memory store implementations from core-api (no mocks for store logic).
 * Only mocks clientIp and developer JWT verification.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  parsePromotionClaimResponse,
  parsePromotionDetailResponse,
  parsePromotionListResponse,
} from '@stelis/contracts';

// ── Hoisted mocks ───────────────────────────────────────────────────────
const { mockVerifyDeveloperJwt } = vi.hoisted(() => ({
  mockVerifyDeveloperJwt: vi.fn().mockResolvedValue({
    userId: 'user-1',
    senderAddress: '0xAddr1',
  }),
}));

vi.mock('@stelis/core-api/studio', async () => {
  const actual = await vi.importActual('@stelis/core-api/studio');
  return {
    ...actual,
    verifyDeveloperJwt: mockVerifyDeveloperJwt,
    recordPromotionAbuseEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../src/developerJwtVerifyCallback.js', async () => {
  const actual = await vi.importActual('../src/developerJwtVerifyCallback.js');
  return { ...actual, callDeveloperVerifyApi: vi.fn().mockResolvedValue(undefined) };
});

import { createStudioRoutes } from '../src/routes/studio.js';
import type { ResolveClientIp } from '../src/clientIp.js';
import type { AppApiContext } from '../src/context.js';
import {
  MemoryPromotionStore,
  MemoryPromotionExecutionLedger,
} from '@stelis/core-api/testing/studio';
import type { AdminPromotionCreateRequest } from '@stelis/contracts';

const resolveClientIp: ResolveClientIp = () => '127.0.0.1';

// ── Helpers ─────────────────────────────────────────────────────────────

const BASE_PROMO: AdminPromotionCreateRequest = {
  type: 'gas_sponsorship',
  displayName: 'Test Promo',
  description: 'Test description',
  maxParticipants: 10,
  perUserGasAllowanceMist: '5000000',
  claimDeadlineAt: null,
  postClaimUseWindowMs: 0,
  startAt: null,
};

function createFullCtx(overrides: Partial<AppApiContext> = {}): AppApiContext {
  const promotionStore = new MemoryPromotionStore();

  return {
    host: {
      rateLimiter: { check: vi.fn().mockResolvedValue({ allowed: true }) },
      abuseBlocker: {
        checkIp: vi.fn().mockResolvedValue({ blocked: false }),
        checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
      },
    } as never,
    prepareConfig: {} as never,
    studio: {} as never,
    promotionStore,
    usageStore: null,
    executionLedger: new MemoryPromotionExecutionLedger(),
    developerJwtTrustConfig: {
      issuer: 'test',
      audience: 'test',
      algorithm: 'RS256' as const,
      publicKeyPem: 'test',
      claimPaths: { userId: 'sub', senderAddress: 'wallet' },
    },
    developerJwtVerifyUrl: null,
    redis: {} as never,
    sponsorOperations: {} as never,
    dispose: vi.fn(),
    ...overrides,
  } as AppApiContext;
}

function mountApp(ctx: AppApiContext): Hono {
  const routes = createStudioRoutes(Promise.resolve(ctx), resolveClientIp);
  const app = new Hono();
  app.route('/studio', routes);
  return app;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('studio promotion routes', () => {
  let ctx: AppApiContext;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createFullCtx();
    app = mountApp(ctx);
  });

  // ── GET /studio/promotions (list) ───────────────────────────────
  describe('GET /studio/promotions', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await app.request('/studio/promotions');
      expect(res.status).toBe(401);
    });

    it('returns empty list when no active promotions', async () => {
      const res = await app.request('/studio/promotions', {
        headers: { Authorization: 'Bearer test-jwt' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.promotions).toEqual([]);
      expect(body.nextCursor).toBeNull();
    });

    it('returns active promotions with user state', async () => {
      const record = await ctx.promotionStore!.create(BASE_PROMO);
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      const res = await app.request('/studio/promotions', {
        headers: { Authorization: 'Bearer test-jwt' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.promotions).toHaveLength(1);
      expect(body.promotions[0].promotionId).toBe(record.promotionId);
      expect(body.promotions[0].displayName).toBe('Test Promo');
      expect(body.promotions[0].canClaim).toBe(true);
      expect(body.promotions[0].canUseSponsoredAction).toBe(false);
      expect(body.promotions[0].promotionRemainingBudgetMist).toBeTruthy();

      expect(parsePromotionListResponse(body)).toEqual(body);
    });

    it('reads page ledger state through one aligned bounded batch', async () => {
      const record = await ctx.promotionStore!.create(BASE_PROMO);
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');
      const batch = vi.spyOn(ctx.executionLedger!, 'getPromotionListLedgerStatuses');
      const entitlement = vi.spyOn(ctx.executionLedger!, 'getEntitlement');
      const claimedCount = vi.spyOn(ctx.executionLedger!, 'getClaimedCount');
      const budgetSummary = vi.spyOn(ctx.executionLedger!, 'getBudgetSummary');

      const res = await app.request('/studio/promotions', {
        headers: { Authorization: 'Bearer test-jwt' },
      });

      expect(res.status).toBe(200);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(batch).toHaveBeenCalledWith([record.promotionId], 'user-1');
      expect(entitlement).not.toHaveBeenCalled();
      expect(claimedCount).not.toHaveBeenCalled();
      expect(budgetSummary).not.toHaveBeenCalled();
    });

    it('returns a deterministic cursor for the next active page', async () => {
      for (const displayName of ['First', 'Second']) {
        const record = await ctx.promotionStore!.create({ ...BASE_PROMO, displayName });
        await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');
      }

      const firstRes = await app.request('/studio/promotions?limit=1', {
        headers: { Authorization: 'Bearer test-jwt' },
      });
      expect(firstRes.status).toBe(200);
      const first = await firstRes.json();
      expect(first.promotions).toHaveLength(1);
      expect(first.nextCursor).toBe(first.promotions[0].promotionId);

      const secondRes = await app.request(`/studio/promotions?limit=1&cursor=${first.nextCursor}`, {
        headers: { Authorization: 'Bearer test-jwt' },
      });
      expect(secondRes.status).toBe(200);
      const second = await secondRes.json();
      expect(second.promotions).toHaveLength(1);
      expect(second.promotions[0].promotionId).not.toBe(first.promotions[0].promotionId);
      expect(second.nextCursor).toBeNull();
    });

    it.each([
      '/studio/promotions?cursor=not-a-promotion-id',
      '/studio/promotions?limit=0',
      '/studio/promotions?limit=101',
      '/studio/promotions?limit=1.5',
      '/studio/promotions?offset=1',
    ])('returns BAD_REQUEST for an invalid page query: %s', async (url) => {
      const res = await app.request(url, {
        headers: { Authorization: 'Bearer test-jwt' },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('checks block state and rate-limit keys on successful list', async () => {
      const record = await ctx.promotionStore!.create(BASE_PROMO);
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      const res = await app.request('/studio/promotions', {
        headers: { Authorization: 'Bearer test-jwt' },
      });
      expect(res.status).toBe(200);
      expect(vi.mocked(ctx.host.abuseBlocker.checkIp)).toHaveBeenCalledWith('127.0.0.1');
      expect(vi.mocked(ctx.host.abuseBlocker.checkSubject)).toHaveBeenCalledWith({
        kind: 'studio_user',
        userId: 'user-1',
      });
      expect(vi.mocked(ctx.host.rateLimiter.check).mock.calls.map((c) => c[0])).toEqual([
        'promo_list:client-ip:127.0.0.1',
        'promo_list:developer-user:user-1',
      ]);
    });

    it('returns 429 when list request is blocked', async () => {
      vi.mocked(ctx.host.abuseBlocker.checkIp).mockResolvedValueOnce({
        blocked: true,
        retryAfterMs: 60000,
      });

      const res = await app.request('/studio/promotions', {
        headers: { Authorization: 'Bearer test-jwt' },
      });

      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
      expect(vi.mocked(ctx.host.rateLimiter.check)).not.toHaveBeenCalled();
    });

    it('does not include draft/paused promotions', async () => {
      const draft = await ctx.promotionStore!.create(BASE_PROMO);
      // Don't activate - stays in draft
      const active = await ctx.promotionStore!.create({ ...BASE_PROMO, displayName: 'Active One' });
      await ctx.promotionStore!.transitionStatus(active.promotionId, 'active');

      const res = await app.request('/studio/promotions', {
        headers: { Authorization: 'Bearer test-jwt' },
      });
      const body = await res.json();
      expect(body.promotions).toHaveLength(1);
      expect(body.promotions[0].displayName).toBe('Active One');
      // Draft should not appear
      expect(
        body.promotions.find((p: { promotionId: string }) => p.promotionId === draft.promotionId),
      ).toBeUndefined();
    });

    it('returns future startAt as canClaim=false + unavailableReason=promotion_not_started', async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const record = await ctx.promotionStore!.create({ ...BASE_PROMO, startAt: future });
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      const res = await app.request('/studio/promotions', {
        headers: { Authorization: 'Bearer test-jwt' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.promotions).toHaveLength(1);
      expect(body.promotions[0].promotionId).toBe(record.promotionId);
      expect(body.promotions[0].canClaim).toBe(false);
      expect(body.promotions[0].canUseSponsoredAction).toBe(false);
      expect(body.promotions[0].unavailableReason).toBe('promotion_not_started');
    });
  });

  // ── GET /studio/promotions/:id (detail) ─────────────────────────
  describe('GET /studio/promotions/:id', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await app.request('/studio/promotions/some-id');
      expect(res.status).toBe(401);
    });

    it('returns 404 for nonexistent promotion', async () => {
      const res = await app.request('/studio/promotions/nonexistent', {
        headers: { Authorization: 'Bearer test-jwt' },
      });
      expect(res.status).toBe(404);
    });

    it('returns detail with promotionRemainingBudgetMist for existing promotion', async () => {
      const record = await ctx.promotionStore!.create(BASE_PROMO);
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      const res = await app.request(`/studio/promotions/${record.promotionId}`, {
        headers: { Authorization: 'Bearer test-jwt' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.promotionId).toBe(record.promotionId);
      expect(body.displayName).toBe('Test Promo');
      expect(body.type).toBe('gas_sponsorship');
      expect(body.promotionRemainingBudgetMist).toBeTruthy();
      expect(body.detail).toBeDefined();
      expect(body.detail.claimStatus).toBe('not_claimed');
      expect(body.detail.canClaim).toBe(true);

      expect(parsePromotionDetailResponse(body)).toEqual(body);
    });

    it('checks block state and rate-limit keys on successful detail', async () => {
      const record = await ctx.promotionStore!.create(BASE_PROMO);
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      const res = await app.request(`/studio/promotions/${record.promotionId}`, {
        headers: { Authorization: 'Bearer test-jwt' },
      });
      expect(res.status).toBe(200);
      expect(vi.mocked(ctx.host.abuseBlocker.checkIp)).toHaveBeenCalledWith('127.0.0.1');
      expect(vi.mocked(ctx.host.abuseBlocker.checkSubject)).toHaveBeenCalledWith({
        kind: 'studio_user',
        userId: 'user-1',
      });
      expect(vi.mocked(ctx.host.rateLimiter.check).mock.calls.map((c) => c[0])).toEqual([
        'promo_detail:client-ip:127.0.0.1',
        'promo_detail:developer-user:user-1',
        `promo_detail:promotion:${record.promotionId}`,
      ]);
    });

    it('returns 429 when detail request exceeds rate limit', async () => {
      const record = await ctx.promotionStore!.create(BASE_PROMO);
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');
      vi.mocked(ctx.host.rateLimiter.check).mockResolvedValueOnce({
        allowed: false,
        retryAfterMs: 5000,
        current: 21,
        limit: 20,
      });

      const res = await app.request(`/studio/promotions/${record.promotionId}`, {
        headers: { Authorization: 'Bearer test-jwt' },
      });

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body).toMatchObject({
        code: 'RATE_LIMITED',
        error: 'Request temporarily blocked',
      });
    });

    it('returns future startAt as detail.canClaim=false + unavailableReason=promotion_not_started', async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const record = await ctx.promotionStore!.create({ ...BASE_PROMO, startAt: future });
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      const res = await app.request(`/studio/promotions/${record.promotionId}`, {
        headers: { Authorization: 'Bearer test-jwt' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.promotionId).toBe(record.promotionId);
      expect(body.detail.claimStatus).toBe('not_claimed');
      expect(body.detail.canClaim).toBe(false);
      expect(body.detail.unavailableReason).toBe('promotion_not_started');
    });
  });

  // ── POST /studio/promotions/:id/claim ───────────────────────────
  describe('POST /studio/promotions/:id/claim', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await app.request('/studio/promotions/some-id/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });

    // 503 infrastructure failures outrank 401 auth on this route.
    it('returns 503 (not 401) when promotion system is unavailable AND Authorization is missing', async () => {
      const unavailableCtx = createFullCtx({ promotionStore: null, executionLedger: null });
      const unavailableApp = mountApp(unavailableCtx);
      const res = await unavailableApp.request('/studio/promotions/some-id/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(503);
    });

    it('classifies local JWT rejection consistently on the claim route', async () => {
      mockVerifyDeveloperJwt.mockRejectedValueOnce(new Error('kid not trusted'));
      const res = await app.request('/studio/promotions/some-id/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe('AUTH_JWT_INVALID');
    });

    it('returns 404 for nonexistent promotion', async () => {
      const res = await app.request('/studio/promotions/nonexistent/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
      expect((await res.clone().json()).code).toBe('PROMOTION_NOT_FOUND');
    });

    it('returns 201 on successful claim', async () => {
      const record = await ctx.promotionStore!.create(BASE_PROMO);
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      const res = await app.request(`/studio/promotions/${record.promotionId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.entitlement).toBeDefined();
      expect(body.entitlement.userId).toBe('user-1');
      expect(body.entitlement.remainingGasAllowanceMist).toBe('5000000');

      expect(parsePromotionClaimResponse(body)).toEqual(body);
    });

    it('returns PROMOTION_NOT_ACTIVE when startAt is in the future', async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const record = await ctx.promotionStore!.create({ ...BASE_PROMO, startAt: future });
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      const res = await app.request(`/studio/promotions/${record.promotionId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({
        code: 'PROMOTION_NOT_ACTIVE',
        error: 'Request conflicts with current state',
      });
    });

    it('returns 503 BLOCK_CHECK_UNAVAILABLE when abuse-block adapter throws during claim', async () => {
      const record = await ctx.promotionStore!.create(BASE_PROMO);
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      vi.mocked(ctx.host.abuseBlocker.checkIp).mockRejectedValueOnce(new Error('redis down'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await app.request(`/studio/promotions/${record.promotionId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('BLOCK_CHECK_UNAVAILABLE');

      warnSpy.mockRestore();
    });

    it('returns 413 REQUEST_BODY_TOO_LARGE when request body exceeds MAX_SMALL cap', async () => {
      const record = await ctx.promotionStore!.create(BASE_PROMO);
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      // MAX_SMALL_REQUEST_BODY_BYTES = 32 * 1024. Build a payload that
      // exceeds the cap so `readJsonBodyWithLimit` throws
      // `RequestBodyTooLargeError`, which the shared `mapError` maps to 413.
      const oversized = { filler: 'x'.repeat(40_000) };

      const res = await app.request(`/studio/promotions/${record.promotionId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify(oversized),
      });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.code).toBe('REQUEST_BODY_TOO_LARGE');
      expect(typeof body.error).toBe('string');
      expect(body.error.length).toBeGreaterThan(0);
    });

    it('returns 409 on duplicate claim', async () => {
      const record = await ctx.promotionStore!.create(BASE_PROMO);
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      // First claim
      await app.request(`/studio/promotions/${record.promotionId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({}),
      });

      // Second claim — duplicate
      const res = await app.request(`/studio/promotions/${record.promotionId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({
        code: 'ALREADY_CLAIMED',
        error: 'Request conflicts with current state',
      });
    });

    it('returns 409 when max participants reached', async () => {
      const record = await ctx.promotionStore!.create({ ...BASE_PROMO, maxParticipants: 1 });
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      // Fill capacity
      await app.request(`/studio/promotions/${record.promotionId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({}),
      });

      // Over capacity — use different userId via mock
      mockVerifyDeveloperJwt.mockResolvedValueOnce({ userId: 'user-2', senderAddress: '0xAddr2' });
      const res = await app.request(`/studio/promotions/${record.promotionId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt-2' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({
        code: 'PROMOTION_CAPACITY_REACHED',
        error: 'Request conflicts with current state',
      });
    });

    it('returns 409 when promotion not active (paused)', async () => {
      const record = await ctx.promotionStore!.create(BASE_PROMO);
      // Don't activate — stays in draft

      const res = await app.request(`/studio/promotions/${record.promotionId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({
        code: 'PROMOTION_NOT_ACTIVE',
        error: 'Request conflicts with current state',
      });
    });

    it('returns 429 when IP is blocked', async () => {
      // Override abuseBlocker to return blocked
      const blockedCtx = createFullCtx({
        host: {
          rateLimiter: { check: vi.fn().mockResolvedValue({ allowed: true }) },
          abuseBlocker: {
            checkIp: vi.fn().mockResolvedValue({ blocked: true, retryAfterMs: 60000 }),
            checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
          },
        } as never,
      });
      const blockedApp = mountApp(blockedCtx);
      const record = await blockedCtx.promotionStore!.create(BASE_PROMO);
      await blockedCtx.promotionStore!.transitionStatus(record.promotionId, 'active');

      const res = await blockedApp.request(`/studio/promotions/${record.promotionId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
    });

    it('returns 429 when rate limit exceeded', async () => {
      // Override rateLimiter to return not allowed
      const rlCtx = createFullCtx({
        host: {
          rateLimiter: { check: vi.fn().mockResolvedValue({ allowed: false, retryAfterMs: 5000 }) },
          abuseBlocker: {
            checkIp: vi.fn().mockResolvedValue({ blocked: false }),
            checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
          },
        } as never,
      });
      const rlApp = mountApp(rlCtx);
      const record = await rlCtx.promotionStore!.create(BASE_PROMO);
      await rlCtx.promotionStore!.transitionStatus(record.promotionId, 'active');

      const res = await rlApp.request(`/studio/promotions/${record.promotionId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body).toMatchObject({
        code: 'RATE_LIMITED',
        error: 'Request temporarily blocked',
      });
    });

    it('checks IP, userId, and promotionId rate-limit keys on successful claim', async () => {
      const record = await ctx.promotionStore!.create(BASE_PROMO);
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      await app.request(`/studio/promotions/${record.promotionId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({}),
      });
      const calls = vi.mocked(ctx.host.rateLimiter.check).mock.calls.map((c) => c[0]);
      expect(calls).toContain('promo_claim:client-ip:127.0.0.1');
      expect(calls).toContain('promo_claim:developer-user:user-1');
      expect(calls).toContain(`promo_claim:promotion:${record.promotionId}`);
    });
  });

  // ── Cross-route sequence tests ───────────────────────────────────
  // Verify that claim state is immediately observable across all routes.
  describe('cross-route claim consistency', () => {
    it('claimed user appears in GET /studio/promotions list', async () => {
      const record = await ctx.promotionStore!.create(BASE_PROMO);
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      // Claim
      const claimRes = await app.request(`/studio/promotions/${record.promotionId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({}),
      });
      expect(claimRes.status).toBe(201);

      // List — claimed user should see canUseSponsoredAction: true
      const listRes = await app.request('/studio/promotions', {
        headers: { Authorization: 'Bearer test-jwt' },
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        promotions: {
          canUseSponsoredAction: boolean;
          userRemainingGasAllowanceMist: string | null;
        }[];
      };
      expect(listBody.promotions).toHaveLength(1);
      expect(listBody.promotions[0].canUseSponsoredAction).toBe(true);
      expect(listBody.promotions[0].userRemainingGasAllowanceMist).toBe('5000000');
    });

    it('claimed user appears in GET /studio/promotions/:id detail', async () => {
      const record = await ctx.promotionStore!.create(BASE_PROMO);
      await ctx.promotionStore!.transitionStatus(record.promotionId, 'active');

      // Claim
      await app.request(`/studio/promotions/${record.promotionId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-jwt' },
        body: JSON.stringify({}),
      });

      // Detail — should reflect claimed state
      const detailRes = await app.request(`/studio/promotions/${record.promotionId}`, {
        headers: { Authorization: 'Bearer test-jwt' },
      });
      expect(detailRes.status).toBe(200);
      const detailBody = (await detailRes.json()) as {
        detail: { claimStatus: string; canUseSponsoredAction: boolean };
      };
      expect(detailBody.detail.claimStatus).toBe('claimed');
      expect(detailBody.detail.canUseSponsoredAction).toBe(true);
    });
  });
});
