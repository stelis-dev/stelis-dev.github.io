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
import { createTestSponsorOperationsSettings } from './sponsor-operations/settingsFixture.js';

const SPONSOR_OPERATIONS_SETTINGS = createTestSponsorOperationsSettings();
const PROMOTION_ID = '00000000-0000-4000-8000-000000000001';
const RECEIPT_ID = `0x${'ab'.repeat(32)}`;

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
  return {
    mockHandlePromotionPrepare: vi.fn().mockImplementation(async (_ctx, _params, admission) => {
      await admission.assertSponsorAvailable();
      return {
        txBytes: 'mock-tx-bytes',
        receiptId: `0x${'ab'.repeat(32)}`,
        estimatedGasMist: '1000000',
      };
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
import type { RelayWithAdminAndStudioAppApiContext } from '../src/context.js';
import type { RequestAdmissionDependencies } from '../src/requestAdmission.js';

const resolveClientIp = vi.fn<ResolveClientIp>().mockReturnValue('127.0.0.1');

// Fixed test trust config for developer JWT
const TEST_TRUST_CONFIG = {
  issuer: 'https://test.example.com',
  audience: 'stelis-studio',
  algorithm: 'RS256' as const,
  publicKeyPem:
    '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1234\n-----END PUBLIC KEY-----',
  claimPaths: { userId: 'sub', senderAddress: 'wallet_address' },
};

function createMockCtx(): RelayWithAdminAndStudioAppApiContext {
  const readSponsorOperationsState = vi.fn().mockResolvedValue({
    settings: SPONSOR_OPERATIONS_SETTINGS,
    slots: [
      {
        address: '0xslot',
        state: 'healthy',
        addressBalanceMist: '10000000000',
        observationFresh: true,
        lastError: null,
        lastObservedAtMs: 1_700_000_000_000,
        writeSeq: 1,
      },
    ],
    sponsorRefillAccount: {
      totalBalanceMist: '20000000000',
      healthy: true,
      observationFresh: true,
      lastError: null,
      lastObservedAtMs: 1_700_000_000_000,
      writeSeq: 1,
    },
  });
  const base = {
    host: {
      rateLimiter: {
        check: vi.fn().mockResolvedValue({ allowed: true }),
      },
      abuseBlocker: {
        checkIp: vi.fn().mockResolvedValue({ blocked: false }),
        checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
        recordSponsorFailure: vi.fn().mockResolvedValue(undefined),
      },
      sui: {} as never,
      sponsorPool: {
        leaseStatus: vi.fn().mockResolvedValue({
          leasedSlots: 0,
          freeSlots: 1,
          slots: [{ address: '0xslot', leased: false }],
        }),
      } as never,
      prepareInflightLimiter: {
        tryAcquire: vi.fn().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) }),
        inflight: 0,
        capacity: 10,
      },
      getConfig: vi.fn().mockResolvedValue({ maxClaimMist: 50_000_000n }),
    } as never,
    prepareConfig: {} as never,
    rpcFleet: {
      endpoints: [{ origin: 'https://rpc.test.invalid', role: 'primary' as const }],
    },
    redis: {} as never,
    abuseStore: {} as never,
    sponsorAvailability: {
      readState: readSponsorOperationsState,
    },
    sponsorOperations: {
      readState: readSponsorOperationsState,
      settings: SPONSOR_OPERATIONS_SETTINGS,
      observeBalances: vi.fn().mockResolvedValue(undefined),
    } as never,
    sponsoredLogsStore: {
      append: vi.fn().mockResolvedValue(undefined),
      getSummary: vi.fn(),
      getRecent: vi.fn(),
    },
  };

  return {
    ...base,
    mode: 'relay_with_admin_and_studio',
    promotionStore: {} as never,
    executionLedger: {} as never,
    studioGlobalAllowedTargets: new Set<string>(),
    developerJwtTrustConfig: TEST_TRUST_CONFIG,
    developerJwtVerifyUrl: null,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function createRequestAdmissionDependencies(
  ctx: RelayWithAdminAndStudioAppApiContext,
  overrides: Partial<RequestAdmissionDependencies> = {},
): RequestAdmissionDependencies {
  return {
    host: ctx.host,
    resolveClientIp,
    ...overrides,
  };
}

function makeApp(
  ctx: RelayWithAdminAndStudioAppApiContext,
  admission = createRequestAdmissionDependencies(ctx),
) {
  const routes = createStudioRoutes(ctx, admission);
  const app = new Hono();
  app.route('/studio', routes);
  return app;
}

const VALID_PREPARE_BODY = { senderAddress: '0x1', txKindBytes: 'base64txkind' };
const VALID_SPONSOR_BODY = {
  receiptId: RECEIPT_ID,
  txBytes: 'base64tx',
  userSignature: 'base64sig',
};

// ── Tests ───────────────────────────────────────────────────────────────

describe('studio routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveClientIp.mockReturnValue('127.0.0.1');
    mockBuildSponsorOperationsBlockedResponse.mockReturnValue(null);
  });

  // ── POST /studio/promotions/:id/prepare ───────────────────────────
  describe('POST /studio/promotions/:id/prepare', () => {
    it('parses the bounded body before rejecting a missing credential without domain I/O', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });

      expect(res.status).toBe(401);
      expect(resolveClientIp).toHaveBeenCalledTimes(1);
      const coreApi = await import('@stelis/core-api');
      expect(coreApi.readJsonBodyWithLimit).toHaveBeenCalledTimes(1);
      expect(mockVerifyDeveloperJwt).not.toHaveBeenCalled();
      expect(ctx.host.abuseBlocker.checkSubject).not.toHaveBeenCalled();
      expect(ctx.sponsorAvailability.readState).not.toHaveBeenCalled();
      expect(ctx.host.sponsorPool.leaseStatus).not.toHaveBeenCalled();
      expect(mockHandlePromotionPrepare).not.toHaveBeenCalled();
    });

    it('returns 401 when Authorization header is missing', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 AUTH_FAILED when Authorization header is malformed', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'NotBearer xxx', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('AUTH_FAILED');
    });

    it('returns 429 when IP is blocked', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const { readJsonBodyWithLimit } = await import('@stelis/core-api');
      vi.mocked(ctx.host.abuseBlocker.checkIp).mockResolvedValueOnce({
        blocked: true,
        retryAfterMs: 5000,
      });
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(429);
      expect(readJsonBodyWithLimit).not.toHaveBeenCalled();
      expect(mockVerifyDeveloperJwt).not.toHaveBeenCalled();
      expect(ctx.host.abuseBlocker.checkSubject).not.toHaveBeenCalled();
      expect(mockHandlePromotionPrepare).not.toHaveBeenCalled();
    });

    it('returns 503 BLOCK_CHECK_UNAVAILABLE when block check throws BlockCheckUnavailableError', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const { BlockCheckUnavailableError } = await import('@stelis/core-api');
      vi.mocked(ctx.host.abuseBlocker.checkIp).mockRejectedValueOnce(
        new BlockCheckUnavailableError(),
      );
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('BLOCK_CHECK_UNAVAILABLE');
    });

    it('returns 429 when rate limit is exceeded', async () => {
      const ctx = createMockCtx();
      vi.mocked(ctx.host.rateLimiter.check).mockResolvedValueOnce({
        allowed: false,
        retryAfterMs: 1000,
        current: 10,
        limit: 10,
      });
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(429);
    });

    it('returns 400 when required fields are missing', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('returns 200 with prepare result on valid request', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.txBytes).toBe('mock-tx-bytes');
      expect(body.receiptId).toBe(RECEIPT_ID);

      expect(parsePromotionPrepareResponse(body)).toEqual(body);
    });

    it('orders IP, bounded body, credential, subject, then domain I/O', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);

      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });

      expect(res.status).toBe(200);
      const coreApi = await import('@stelis/core-api');
      const rateLimitCallOrder = vi.mocked(ctx.host.rateLimiter.check).mock.invocationCallOrder;
      const orderedCalls = [
        resolveClientIp.mock.invocationCallOrder[0]!,
        vi.mocked(ctx.host.abuseBlocker.checkIp).mock.invocationCallOrder[0]!,
        rateLimitCallOrder[0]!,
        vi.mocked(coreApi.readJsonBodyWithLimit).mock.invocationCallOrder[0]!,
        mockVerifyDeveloperJwt.mock.invocationCallOrder[0]!,
        vi.mocked(ctx.host.abuseBlocker.checkSubject).mock.invocationCallOrder[0]!,
        rateLimitCallOrder[1]!,
        rateLimitCallOrder[2]!,
        mockHandlePromotionPrepare.mock.invocationCallOrder[0]!,
        vi.mocked(ctx.sponsorAvailability.readState).mock.invocationCallOrder[0]!,
        vi.mocked(ctx.host.sponsorPool.leaseStatus).mock.invocationCallOrder[0]!,
        mockBuildSponsorOperationsBlockedResponse.mock.invocationCallOrder[0]!,
      ];
      expect(orderedCalls).not.toContain(undefined);
      expect(orderedCalls).toEqual([...orderedCalls].sort((left, right) => left - right));
      const admittedClientIp = mockHandlePromotionPrepare.mock.lastCall?.[1].clientIp;
      expect(admittedClientIp).toBeDefined();
      expect(coreApi.readAdmittedClientIp(admittedClientIp)).toBe('127.0.0.1');
    });

    it('checks IP, userId, and promotionId rate-limit keys on successful prepare', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(200);
      const calls = vi.mocked(ctx.host.rateLimiter.check).mock.calls.map((c) => c[0]);
      expect(calls).toContain('promo_prepare:client-ip:127.0.0.1');
      expect(calls).toContain('promo_prepare:developer-user:mock-user');
      expect(calls).toContain(`promo_prepare:promotion:${PROMOTION_ID}`);
    });

    it('derives PromotionPrepareError status from its current code', async () => {
      const ctx = createMockCtx();
      const { PromotionPrepareError } = await import('@stelis/core-api/studio');
      mockHandlePromotionPrepare.mockRejectedValueOnce(
        new PromotionPrepareError('Promotion not active', 'PROMOTION_NOT_ACTIVE'),
      );
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('PROMOTION_NOT_ACTIVE');
    });

    it('returns 503 when the sponsor operations gate is closed', async () => {
      const ctx = createMockCtx();
      mockBuildSponsorOperationsBlockedResponse.mockReturnValueOnce({
        errorCode: 'SPONSOR_CAPACITY_UNAVAILABLE',
        headers: {},
      });
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(503);
      expect(ctx.host.sponsorPool.leaseStatus).toHaveBeenCalledTimes(1);
      expect(mockBuildSponsorOperationsBlockedResponse).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ freeSlots: 1 }),
      );
    });

    it('returns 401 AUTH_JWT_INVALID when local developer JWT verification fails', async () => {
      const ctx = createMockCtx();
      mockVerifyDeveloperJwt.mockRejectedValueOnce(new Error('Invalid signature'));
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'Bearer bad-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe('AUTH_JWT_INVALID');
    });

    it('returns 401 AUTH_JWT_INVALID when the developer callback explicitly rejects the JWT', async () => {
      const ctx = {
        ...createMockCtx(),
        developerJwtVerifyUrl: 'https://developer.example.test/verify',
      } satisfies RelayWithAdminAndStudioAppApiContext;
      const { DeveloperVerifyRejectedError } = await import('../src/developerJwtVerifyCallback.js');
      mockCallDeveloperVerifyApi.mockRejectedValueOnce(
        new DeveloperVerifyRejectedError('developer callback denied the JWT'),
      );
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('AUTH_JWT_INVALID');
    });

    it('returns 503 AUTH_UNAVAILABLE when the developer callback cannot establish a verdict', async () => {
      const ctx = {
        ...createMockCtx(),
        developerJwtVerifyUrl: 'https://developer.example.test/verify',
      } satisfies RelayWithAdminAndStudioAppApiContext;
      const { DeveloperVerifyUnavailableError } =
        await import('../src/developerJwtVerifyCallback.js');
      mockCallDeveloperVerifyApi.mockRejectedValueOnce(
        new DeveloperVerifyUnavailableError('developer callback timed out'),
      );
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('AUTH_UNAVAILABLE');
    });

    it('returns 422 when handler throws PrepareValidationError (DRY_RUN_FAILED)', async () => {
      const ctx = createMockCtx();
      mockHandlePromotionPrepare.mockRejectedValueOnce(
        new MockPrepareValidationError('DRY_RUN_FAILED', 'Dry-run failed: MoveAbort'),
      );
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('DRY_RUN_FAILED');
    });

    it('returns 429 when handler throws PrepareStudioUserQuotaError', async () => {
      const ctx = createMockCtx();
      mockHandlePromotionPrepare.mockRejectedValueOnce(
        new MockPrepareStudioUserQuotaError('0xVICTIM', 3),
      );
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PREPARE_BODY),
      });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.code).toBe('PREPARE_STUDIO_USER_QUOTA_EXCEEDED');
    });

    it('returns 503 PREPARE_OVERLOADED with Retry-After when handler throws PrepareOverloadError', async () => {
      const ctx = createMockCtx();
      mockHandlePromotionPrepare.mockRejectedValueOnce(new MockPrepareOverloadError(5, 5));
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
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
      const ctx = createMockCtx();
      const { PromotionPrepareError } = await import('@stelis/core-api/studio');
      mockHandlePromotionPrepare.mockRejectedValueOnce(
        new PromotionPrepareError(
          'TX contains FundsWithdrawal(Sponsor) — rejected to protect sponsor funds',
          'SPONSOR_WITHDRAWAL_FORBIDDEN',
        ),
      );
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/prepare`, {
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
    it('parses the bounded body before rejecting malformed credentials without domain I/O', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/sponsor`, {
        method: 'POST',
        headers: { Authorization: 'NotBearer xxx', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });

      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('AUTH_FAILED');
      expect(resolveClientIp).toHaveBeenCalledTimes(1);
      const coreApi = await import('@stelis/core-api');
      expect(coreApi.readJsonBodyWithLimit).toHaveBeenCalledTimes(1);
      expect(mockVerifyDeveloperJwt).not.toHaveBeenCalled();
      expect(ctx.host.abuseBlocker.checkSubject).not.toHaveBeenCalled();
      expect(mockHandlePromotionSponsor).not.toHaveBeenCalled();
    });

    it('returns 401 when Authorization header is missing', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/sponsor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 AUTH_FAILED when Authorization header is malformed', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/sponsor`, {
        method: 'POST',
        headers: { Authorization: 'NotBearer xxx', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('AUTH_FAILED');
    });

    it('returns 429 when IP is blocked', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const { readJsonBodyWithLimit } = await import('@stelis/core-api');
      vi.mocked(ctx.host.abuseBlocker.checkIp).mockResolvedValueOnce({
        blocked: true,
        retryAfterMs: 5000,
      });
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/sponsor`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(429);
      expect(readJsonBodyWithLimit).not.toHaveBeenCalled();
      expect(mockVerifyDeveloperJwt).not.toHaveBeenCalled();
      expect(ctx.host.abuseBlocker.checkSubject).not.toHaveBeenCalled();
      expect(mockHandlePromotionSponsor).not.toHaveBeenCalled();
    });

    it('returns 429 when rate limit is exceeded', async () => {
      const ctx = createMockCtx();
      vi.mocked(ctx.host.rateLimiter.check).mockResolvedValueOnce({
        allowed: false,
        retryAfterMs: 1000,
        current: 10,
        limit: 10,
      });
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/sponsor`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(429);
    });

    it('returns 400 when required fields are missing', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/sponsor`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('returns 200 with sponsor result on valid request', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/sponsor`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.digest).toBe('0xdigest');
      const coreApi = await import('@stelis/core-api');
      const admittedClientIp = mockHandlePromotionSponsor.mock.lastCall?.[1].clientIp;
      expect(admittedClientIp).toBeDefined();
      expect(coreApi.readAdmittedClientIp(admittedClientIp)).toBe('127.0.0.1');
      // State refresh is owned by the sponsor-terminal host callback
      // inside `handlePromotionSponsor`; the route does not fire a
      // wake. Callback-side state writes are locked in
      // `sponsorPromotionSponsored.test.ts` (core-api).

      expect(parsePromotionSponsorResponse(body)).toEqual(body);
    });

    it('checks IP, userId, and promotionId rate-limit keys on successful sponsor', async () => {
      const ctx = createMockCtx();
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/sponsor`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(200);
      const calls = vi.mocked(ctx.host.rateLimiter.check).mock.calls.map((c) => c[0]);
      expect(calls).toContain('promo_sponsor:client-ip:127.0.0.1');
      expect(calls).toContain('promo_sponsor:developer-user:mock-user');
      expect(calls).toContain(`promo_sponsor:promotion:${PROMOTION_ID}`);
    });

    it('returns promotion sponsor failure as 422 (PromotionSponsorError)', async () => {
      // State refresh after failure is owned by the sponsor-terminal
      // host callback inside `handlePromotionSponsor`; the route does
      // not fire a wake signal. Callback-side state writes are locked
      // in `sponsorPromotionSponsored.test.ts`.
      const ctx = createMockCtx();
      const { PromotionSponsorError } = await import('@stelis/core-api/studio');
      mockHandlePromotionSponsor.mockRejectedValueOnce(
        new PromotionSponsorError('TX reverted', 'ONCHAIN_REVERT', { digest: '0xreverted' }),
      );
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/sponsor`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(422);
    });

    it('derives PromotionSponsorError status from its current code', async () => {
      const ctx = createMockCtx();
      const { PromotionSponsorError } = await import('@stelis/core-api/studio');
      mockHandlePromotionSponsor.mockRejectedValueOnce(
        new PromotionSponsorError('Promotion not active', 'PROMOTION_NOT_ACTIVE'),
      );
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/sponsor`, {
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
      const ctx = createMockCtx();
      const { PromotionSponsorError } = await import('@stelis/core-api/studio');
      mockHandlePromotionSponsor.mockRejectedValueOnce(
        new PromotionSponsorError(
          'Transaction reverted on-chain: MoveAbort vault 1',
          'ONCHAIN_REVERT',
          { digest: '0xreverted', subcode: 'REPLAY_NONCE' },
        ),
      );
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/sponsor`, {
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
      const ctx = createMockCtx();
      const { PromotionSponsorError } = await import('@stelis/core-api/studio');
      mockHandlePromotionSponsor.mockRejectedValueOnce(
        new PromotionSponsorError('Preflight simulation failed: unrecognized', 'PREFLIGHT_FAILED'),
      );
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/sponsor`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_SPONSOR_BODY),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('PREFLIGHT_FAILED');
      expect(body.subcode).toBeUndefined();
    });

    it('returns 401 AUTH_JWT_INVALID when local developer JWT verification fails', async () => {
      const ctx = createMockCtx();
      mockVerifyDeveloperJwt.mockRejectedValueOnce(new Error('Expired token'));
      const app = makeApp(ctx);
      const res = await app.request(`/studio/promotions/${PROMOTION_ID}/sponsor`, {
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
