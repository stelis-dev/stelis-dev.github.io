/**
 * Studio route contract tests — verifies HTTP contracts.
 *
 * Tests: mode check, auth (developer JWT),
 * promotion prepare/sponsor routes (auth, sponsor operations gate, blocked-IP, rate limit,
 * body parsing, handler delegation, error mapping).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { parsePromotionPrepareResponse, parsePromotionSponsorResponse } from '@stelis/contracts';

// ── Hoisted mocks ───────────────────────────────────────────────────────
const {
  mockHandlePromotionPrepare,
  mockHandlePromotionSponsor,
  mockBuildSponsorOperationsBlockedResponse,
  mockVerifyDeveloperJwt,
  mockCallDeveloperVerifyApi,
  MockRequestBodyTooLargeError,
  MockRequestBodyParseError,
  MockPrepareValidationError,
  MockPrepareStudioUserQuotaError,
  MockPrepareOverloadError,
  MockSponsorValidationError,
  MockSponsorPreflightError,
  MockSponsorOnchainError,
  MockSponsorCongestionError,
  MockSponsorLeaseExpiredError,
  MockBlockCheckUnavailableError,
} = vi.hoisted(() => {
  class _TooLarge extends Error {
    constructor() {
      super('Request body too large');
      this.name = 'RequestBodyTooLargeError';
    }
  }
  class _ParseError extends Error {
    constructor() {
      super('Invalid JSON in request body');
      this.name = 'RequestBodyParseError';
    }
  }
  class _PrepareValidationError extends Error {
    readonly code: string;
    readonly meta?: Record<string, string>;
    constructor(code: string, message: string, meta?: Record<string, string>) {
      super(message);
      this.name = 'PrepareValidationError';
      this.code = code;
      this.meta = meta;
    }
  }
  class _PrepareStudioUserQuotaError extends Error {
    readonly code = 'PREPARE_STUDIO_USER_QUOTA_EXCEEDED';
    constructor(senderAddress: string, max: number) {
      super(
        `Sender ${senderAddress} has reached the maximum of ${max} outstanding prepared transactions.`,
      );
      this.name = 'PrepareStudioUserQuotaError';
    }
  }
  class _PrepareOverloadError extends Error {
    readonly code = 'PREPARE_OVERLOADED';
    constructor(currentInflight: number, maxInflight: number) {
      super(
        `Prepare capacity reached (${currentInflight}/${maxInflight} in-flight). Retry shortly.`,
      );
      this.name = 'PrepareOverloadError';
    }
  }
  // Minimum stubs for Sponsor* error classes — studio tests never throw
  // these directly, but `errorMap.mapError()` iterates through the whole
  // family. Missing mocks would make `err instanceof undefined` throw and
  // mask real assertion failures.
  class _SponsorValidationError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'SponsorValidationError';
    }
  }
  class _SponsorPreflightError extends Error {
    constructor(
      public readonly reason: string,
      public readonly subcode?: string,
    ) {
      super(`Preflight simulation failed: ${reason}`);
      this.name = 'SponsorPreflightError';
    }
  }
  class _SponsorOnchainError extends Error {
    constructor(
      public readonly digest: string,
      public readonly onchainError: string,
      public readonly subcode: string | undefined,
      public readonly gasUsed: {
        computationCost: string;
        storageCost: string;
        storageRebate: string;
        nonRefundableStorageFee: string;
      },
    ) {
      super(`Transaction reverted on-chain: ${onchainError}`);
      this.name = 'SponsorOnchainError';
    }
  }
  class _SponsorCongestionError extends Error {
    constructor(
      message: string,
      public readonly digest: string,
    ) {
      super(message);
      this.name = 'SponsorCongestionError';
    }
  }
  class _SponsorLeaseExpiredError extends Error {
    readonly code = 'LEASE_EXPIRED' as const;
    constructor(sponsorAddress: string) {
      super(`Sponsor lease expired for address ${sponsorAddress} — retry /prepare`);
      this.name = 'SponsorLeaseExpiredError';
    }
  }
  class _BlockCheckUnavailableError extends Error {
    constructor(message = 'Abuse block check is temporarily unavailable') {
      super(message);
      this.name = 'BlockCheckUnavailableError';
    }
  }
  return {
    mockHandlePromotionPrepare: vi.fn().mockResolvedValue({
      txBytes: 'mock-tx-bytes',
      receiptId: '0xreceipt',
      estimatedGasMist: '1000000',
    }),
    mockHandlePromotionSponsor: vi.fn().mockResolvedValue({
      digest: '0xdigest',
      effects: {},
      actualGasMist: '500000',
    }),
    mockBuildSponsorOperationsBlockedResponse: vi.fn().mockReturnValue(null),
    mockVerifyDeveloperJwt: vi.fn().mockResolvedValue({
      userId: 'mock-user',
      senderAddress: '0x1',
    }),
    mockCallDeveloperVerifyApi: vi.fn().mockResolvedValue(undefined),
    MockRequestBodyTooLargeError: _TooLarge,
    MockRequestBodyParseError: _ParseError,
    MockPrepareValidationError: _PrepareValidationError,
    MockPrepareStudioUserQuotaError: _PrepareStudioUserQuotaError,
    MockPrepareOverloadError: _PrepareOverloadError,
    MockSponsorValidationError: _SponsorValidationError,
    MockSponsorPreflightError: _SponsorPreflightError,
    MockSponsorOnchainError: _SponsorOnchainError,
    MockSponsorCongestionError: _SponsorCongestionError,
    MockSponsorLeaseExpiredError: _SponsorLeaseExpiredError,
    MockBlockCheckUnavailableError: _BlockCheckUnavailableError,
  };
});

vi.mock('@stelis/core-api/studio', async () => {
  const actual = await vi.importActual('@stelis/core-api/studio');
  return {
    ...actual,
    handlePromotionPrepare: mockHandlePromotionPrepare,
    handlePromotionSponsor: mockHandlePromotionSponsor,
    verifyDeveloperJwt: mockVerifyDeveloperJwt,
    recordPromotionAbuseEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@stelis/core-api', async () => {
  const actual = await vi.importActual<typeof import('@stelis/core-api')>('@stelis/core-api');
  return {
    ...actual,
    readJsonBodyWithLimit: vi.fn().mockImplementation(async (req: Request) => req.json()),
    checkBlockedRequest: vi.fn().mockResolvedValue({ blocked: false }),
    MAX_SMALL_REQUEST_BODY_BYTES: 32 * 1024,
    MAX_PREPARE_REQUEST_BODY_BYTES: 96 * 1024,
    MAX_SPONSOR_REQUEST_BODY_BYTES: 128 * 1024,
    RequestBodyTooLargeError: MockRequestBodyTooLargeError,
    RequestBodyParseError: MockRequestBodyParseError,
    PrepareValidationError: MockPrepareValidationError,
    PrepareStudioUserQuotaError: MockPrepareStudioUserQuotaError,
    PrepareOverloadError: MockPrepareOverloadError,
    SponsorValidationError: MockSponsorValidationError,
    SponsorPreflightError: MockSponsorPreflightError,
    SponsorOnchainError: MockSponsorOnchainError,
    SponsorCongestionError: MockSponsorCongestionError,
    SponsorLeaseExpiredError: MockSponsorLeaseExpiredError,
    BlockCheckUnavailableError: MockBlockCheckUnavailableError,
  };
});

vi.mock('../src/sponsor-operations/gateResponse.js', () => ({
  buildSponsorUnavailableResponse: mockBuildSponsorOperationsBlockedResponse,
}));

vi.mock('../src/developerJwtVerifyCallback.js', async () => {
  const actual = await vi.importActual('../src/developerJwtVerifyCallback.js');
  return { ...actual, callDeveloperVerifyApi: mockCallDeveloperVerifyApi };
});

import { createStudioRoutes } from '../src/routes/studio.js';
import type { ResolveClientIp } from '../src/clientIp.js';
import type { AppApiContext } from '../src/context.js';

const resolveClientIp: ResolveClientIp = () => '127.0.0.1';

// Fixed test trust config for developer JWT
const TEST_TRUST_CONFIG = {
  issuer: 'https://test.example.com',
  audience: 'stelis-studio',
  algorithm: 'RS256' as const,
  publicKeyPem:
    '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1234\n-----END PUBLIC KEY-----',
  claimPaths: { userId: 'sub', senderAddress: 'wallet_address' },
};

function createMockCtx(studioEnabled: boolean): AppApiContext {
  return {
    host: {
      rateLimiter: {
        check: vi.fn().mockResolvedValue({ allowed: true }),
      },
      abuseBlocker: {} as never,
      sui: {} as never,
      sponsorPool: {
        leaseStatus: vi.fn().mockResolvedValue({
          leasedSlots: 0,
          freeSlots: 1,
          slots: [{ address: '0xslot', leased: false }],
        }),
      } as never,
      prepareStore: {} as never,
      prepareInflightLimiter: {
        tryAcquire: vi.fn().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) }),
        inflight: 0,
        capacity: 10,
      },
      getConfig: vi.fn().mockResolvedValue({ maxClaimMist: 50_000_000n }),
    } as never,
    prepareConfig: {} as never,
    studio: studioEnabled ? ({} as never) : null,
    // Stores must be non-null when studio is enabled
    promotionStore: studioEnabled ? ({} as never) : null,
    usageStore: null,
    executionLedger: studioEnabled ? ({} as never) : null,
    studioGlobalAllowedTargets: studioEnabled ? new Set<string>() : null,
    developerJwtTrustConfig: studioEnabled ? TEST_TRUST_CONFIG : null,
    developerJwtVerifyUrl: null,
    rpcFleet: {
      endpoints: [{ origin: 'https://rpc.test.invalid', role: 'primary' }],
    },
    redis: {} as never,
    sponsorOperations: {
      readState: vi.fn().mockResolvedValue({
        slots: [
          {
            address: '0xslot',
            state: 'healthy',
            balanceMist: '10000000000',
            lastError: null,
            lastObservedAtMs: 1_700_000_000_000,
            writeSeq: 1,
          },
        ],
        sponsorRefillAccount: {
          balanceMist: '20000000000',
          healthy: true,
          refillsRemaining: 2,
          lastError: null,
          lastObservedAtMs: 1_700_000_000_000,
          writeSeq: 1,
        },
      }),
      probeSponsorRefillAccount: vi.fn().mockResolvedValue(undefined),
      requestRefill: vi.fn(),
      slotAddresses: ['0xslot'],
      sponsorRefillAccountAddress: '0x' + '55'.repeat(32),
      dispose: vi.fn(),
    } as never,
    sponsoredLogsStore: {
      append: vi.fn().mockResolvedValue(undefined),
      getSummary: vi.fn(),
      getRecent: vi.fn(),
    },
    dispose: vi.fn(),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function makeApp(ctx: AppApiContext) {
  const routes = createStudioRoutes(Promise.resolve(ctx), resolveClientIp);
  const app = new Hono();
  app.route('/studio', routes);
  return app;
}

const VALID_PREPARE_BODY = { senderAddress: '0x1', txKindBytes: 'base64txkind' };
const VALID_SPONSOR_BODY = {
  receiptId: '0xreceipt',
  txBytes: 'base64tx',
  userSignature: 'base64sig',
};

// ── Tests ───────────────────────────────────────────────────────────────

describe('studio routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildSponsorOperationsBlockedResponse.mockReturnValue(null);
  });

  // ── POST /studio/promotions/:id/prepare ───────────────────────────
  describe('POST /studio/promotions/:id/prepare', () => {
    it('returns 503 when studio mode is disabled', async () => {
      const ctx = createMockCtx(false);
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(503);
    });

    it('returns 503 when required stores are missing', async () => {
      const ctx = createMockCtx(true);
      ctx.promotionStore = null;
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(503);
    });

    // Precedence: 503 infrastructure failures must outrank 401 auth.
    // Locks the guard ordering after Step 10 middleware extraction.
    it('returns 503 (not 401) when studio is disabled AND Authorization is missing', async () => {
      const ctx = createMockCtx(false);
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(503);
      expect(ctx.host.sponsorPool.leaseStatus).not.toHaveBeenCalled();
    });

    it('returns 503 (not 401) when globalAllowedTargets missing AND Authorization is missing', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = null;
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(503);
    });

    it('returns 401 when Authorization header is missing', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 AUTH_FAILED when Authorization header is malformed', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'NotBearer xxx', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('AUTH_FAILED');
    });

    it('returns 429 when IP is blocked', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const app = makeApp(ctx);
      const { checkBlockedRequest } = await import('@stelis/core-api');
      vi.mocked(checkBlockedRequest).mockResolvedValueOnce({
        blocked: true,
        retryAfterMs: 5000,
      } as never);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(429);
    });

    it('returns 503 BLOCK_CHECK_UNAVAILABLE when block check throws BlockCheckUnavailableError', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const app = makeApp(ctx);
      const { checkBlockedRequest, BlockCheckUnavailableError } = await import('@stelis/core-api');
      vi.mocked(checkBlockedRequest).mockRejectedValueOnce(new BlockCheckUnavailableError());
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('BLOCK_CHECK_UNAVAILABLE');
    });

    it('returns 429 when rate limit is exceeded', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      vi.mocked(ctx.host.rateLimiter.check).mockResolvedValueOnce({
        allowed: false,
        retryAfterMs: 1000,
        current: 10,
        limit: 10,
      });
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(429);
    });

    it('returns 400 when required fields are missing', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('returns 200 with prepare result on valid request', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.txBytes).toBe('mock-tx-bytes');
      expect(body.receiptId).toBe('0xreceipt');

      expect(parsePromotionPrepareResponse(body)).toEqual(body);
    });

    it('checks IP, userId, and promotionId rate-limit keys on successful prepare', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(200);
      const calls = vi.mocked(ctx.host.rateLimiter.check).mock.calls.map((c) => c[0]);
      expect(calls).toContain('promo_prepare:client-ip:127.0.0.1');
      expect(calls).toContain('promo_prepare:developer-user:mock-user');
      expect(calls).toContain('promo_prepare:promotion:promo-1');
    });

    it('derives PromotionPrepareError status from its current code', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const { PromotionPrepareError } = await import('@stelis/core-api/studio');
      mockHandlePromotionPrepare.mockRejectedValueOnce(
        new PromotionPrepareError('Promotion not active', 'PROMOTION_NOT_ACTIVE'),
      );
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('PROMOTION_NOT_ACTIVE');
    });

    it('returns 503 when the sponsor operations gate is closed', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      mockBuildSponsorOperationsBlockedResponse.mockReturnValueOnce({
        errorCode: 'SPONSOR_CAPACITY_UNAVAILABLE',
        headers: {},
      });
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(503);
      expect(ctx.host.sponsorPool.leaseStatus).toHaveBeenCalledTimes(1);
      expect(mockBuildSponsorOperationsBlockedResponse).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ requireFreeSponsorSlot: true }),
      );
    });

    it('returns 401 AUTH_JWT_INVALID when local developer JWT verification fails', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      mockVerifyDeveloperJwt.mockRejectedValueOnce(new Error('Invalid signature'));
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer bad-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe('AUTH_JWT_INVALID');
    });

    it('returns 401 AUTH_JWT_INVALID when the developer callback explicitly rejects the JWT', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      ctx.developerJwtVerifyUrl = 'https://developer.example.test/verify';
      const { DeveloperVerifyRejectedError } = await import('../src/developerJwtVerifyCallback.js');
      mockCallDeveloperVerifyApi.mockRejectedValueOnce(
        new DeveloperVerifyRejectedError('developer callback denied the JWT'),
      );
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('AUTH_JWT_INVALID');
    });

    it('returns 503 AUTH_UNAVAILABLE when the developer callback cannot establish a verdict', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      ctx.developerJwtVerifyUrl = 'https://developer.example.test/verify';
      const { DeveloperVerifyUnavailableError } =
        await import('../src/developerJwtVerifyCallback.js');
      mockCallDeveloperVerifyApi.mockRejectedValueOnce(
        new DeveloperVerifyUnavailableError('developer callback timed out'),
      );
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('AUTH_UNAVAILABLE');
    });

    it('returns 422 when handler throws PrepareValidationError (DRY_RUN_FAILED)', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      mockHandlePromotionPrepare.mockRejectedValueOnce(
        new MockPrepareValidationError('DRY_RUN_FAILED', 'Dry-run failed: MoveAbort'),
      );
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('DRY_RUN_FAILED');
    });

    it('returns 429 when handler throws PrepareStudioUserQuotaError', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      mockHandlePromotionPrepare.mockRejectedValueOnce(
        new MockPrepareStudioUserQuotaError('0xVICTIM', 3),
      );
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.code).toBe('PREPARE_STUDIO_USER_QUOTA_EXCEEDED');
    });

    it('returns 503 PREPARE_OVERLOADED with Retry-After when handler throws PrepareOverloadError', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      mockHandlePromotionPrepare.mockRejectedValueOnce(new MockPrepareOverloadError(5, 5));
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('PREPARE_OVERLOADED');
      expect(res.headers.get('Retry-After')).toBe('2');
    });

    // S-15 companion: route-level contract — FundsWithdrawal(Sponsor) rejection
    it('returns 403 with SPONSOR_WITHDRAWAL_FORBIDDEN on PromotionPrepareError', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const { PromotionPrepareError } = await import('@stelis/core-api/studio');
      mockHandlePromotionPrepare.mockRejectedValueOnce(
        new PromotionPrepareError(
          'TX contains FundsWithdrawal(Sponsor) — rejected to protect sponsor funds',
          'SPONSOR_WITHDRAWAL_FORBIDDEN',
        ),
      );
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/prepare', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe('SPONSOR_WITHDRAWAL_FORBIDDEN');
    });
  });

  // ── POST /studio/promotions/:id/sponsor ───────────────────────────
  describe('POST /studio/promotions/:id/sponsor', () => {
    it('returns 503 when studio mode is disabled', async () => {
      const ctx = createMockCtx(false);
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(503);
      expect(ctx.host.sponsorPool.leaseStatus).not.toHaveBeenCalled();
    });

    it('returns 503 when executionLedger is missing', async () => {
      const ctx = createMockCtx(true);
      ctx.executionLedger = null;
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(503);
      expect(ctx.host.sponsorPool.leaseStatus).not.toHaveBeenCalled();
    });

    // Precedence: 503 infrastructure failures must outrank 401 auth.
    it('returns 503 (not 401) when globalAllowedTargets missing AND Authorization is malformed', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = null;
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'NotBearer xxx', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(503);
    });

    it('returns 503 (not 401) when sponsor operations gate is closed AND Authorization is missing', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      mockBuildSponsorOperationsBlockedResponse.mockReturnValueOnce({
        headers: {},
        errorCode: 'SPONSOR_CAPACITY_UNAVAILABLE',
      });
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(503);
    });

    it('returns 401 when Authorization header is missing', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 AUTH_FAILED when Authorization header is malformed', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'NotBearer xxx', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('AUTH_FAILED');
    });

    it('returns 429 when IP is blocked', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const app = makeApp(ctx);
      const { checkBlockedRequest } = await import('@stelis/core-api');
      vi.mocked(checkBlockedRequest).mockResolvedValueOnce({
        blocked: true,
        retryAfterMs: 5000,
      } as never);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(429);
    });

    it('returns 429 when rate limit is exceeded', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      vi.mocked(ctx.host.rateLimiter.check).mockResolvedValueOnce({
        allowed: false,
        retryAfterMs: 1000,
        current: 10,
        limit: 10,
      });
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(429);
    });

    it('returns 400 when required fields are missing', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('returns 200 with sponsor result on valid request', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.digest).toBe('0xdigest');
      // State refresh is owned by the sponsor-terminal host callback
      // inside `handlePromotionSponsor`; the route does not fire a
      // wake. Callback-side state writes are locked in
      // `sponsorPromotionSponsored.test.ts` (core-api).

      expect(parsePromotionSponsorResponse(body)).toEqual(body);
    });

    it('checks IP, userId, and promotionId rate-limit keys on successful sponsor', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(200);
      const calls = vi.mocked(ctx.host.rateLimiter.check).mock.calls.map((c) => c[0]);
      expect(calls).toContain('promo_sponsor:client-ip:127.0.0.1');
      expect(calls).toContain('promo_sponsor:developer-user:mock-user');
      expect(calls).toContain('promo_sponsor:promotion:promo-1');
    });

    it('returns promotion sponsor failure as 422 (PromotionSponsorError)', async () => {
      // State refresh after failure is owned by the sponsor-terminal
      // host callback inside `handlePromotionSponsor`; the route does
      // not fire a wake signal. Callback-side state writes are locked
      // in `sponsorPromotionSponsored.test.ts`.
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const { PromotionSponsorError } = await import('@stelis/core-api/studio');
      mockHandlePromotionSponsor.mockRejectedValueOnce(
        new PromotionSponsorError('TX reverted', 'ONCHAIN_REVERT', { digest: '0xreverted' }),
      );
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(422);
    });

    it('derives PromotionSponsorError status from its current code', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const { PromotionSponsorError } = await import('@stelis/core-api/studio');
      mockHandlePromotionSponsor.mockRejectedValueOnce(
        new PromotionSponsorError('Promotion not active', 'PROMOTION_NOT_ACTIVE'),
      );
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('PROMOTION_NOT_ACTIVE');
    });

    // A classified sponsor failure subcode reaches the route JSON body alongside
    // `code`, mirroring the generic `SponsorPreflightError` / `SponsorOnchainError`
    // shape. Unclassified fallback literals never appear here — only recognized
    // `SponsorFailureSubcode` values are exposed publicly.
    it('propagates classified PromotionSponsorError subcode into the route response body', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const { PromotionSponsorError } = await import('@stelis/core-api/studio');
      mockHandlePromotionSponsor.mockRejectedValueOnce(
        new PromotionSponsorError(
          'Transaction reverted on-chain: MoveAbort vault 1',
          'ONCHAIN_REVERT',
          { digest: '0xreverted', subcode: 'REPLAY_NONCE' },
        ),
      );
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('ONCHAIN_REVERT');
      expect(body.subcode).toBe('REPLAY_NONCE');
    });

    it('omits subcode in the route response body when the PromotionSponsorError is unclassified', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      const { PromotionSponsorError } = await import('@stelis/core-api/studio');
      mockHandlePromotionSponsor.mockRejectedValueOnce(
        new PromotionSponsorError('Preflight simulation failed: unrecognized', 'PREFLIGHT_FAILED'),
      );
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('PREFLIGHT_FAILED');
      expect(body.subcode).toBeUndefined();
    });

    it('returns 503 when the sponsor operations gate is closed', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      mockBuildSponsorOperationsBlockedResponse.mockReturnValueOnce({
        errorCode: 'SPONSOR_CAPACITY_UNAVAILABLE',
        headers: {},
      });
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(503);
      expect(ctx.host.sponsorPool.leaseStatus).not.toHaveBeenCalled();
    });

    it('returns 401 AUTH_JWT_INVALID when local developer JWT verification fails', async () => {
      const ctx = createMockCtx(true);
      ctx.studioGlobalAllowedTargets = new Set<string>();
      mockVerifyDeveloperJwt.mockRejectedValueOnce(new Error('Expired token'));
      const app = makeApp(ctx);
      const res = await app.request('/studio/promotions/promo-1/sponsor', {
        method: 'POST',
        headers: { Authorization: 'Bearer expired-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe('AUTH_JWT_INVALID');
    });
  });
});
