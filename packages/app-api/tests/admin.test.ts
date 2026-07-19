/**
 * Admin route contract tests — verifies HTTP contracts.
 *
 * Tests use one Admin request helper around Hono's app.request() with mocked dependencies.
 * All admin routes require requireAdminSession — middleware tested here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  AbuseBlockCurrentConflictError,
  AbuseBlockInputError,
  ClientIpResolutionError,
} from '@stelis/core-api';
import {
  HOST_ERROR_HTTP_STATUS,
  MAX_PROMOTION_LEDGER_VALUE_MIST,
  buildSponsorRefillAccountWithdrawMessage,
  hostErrorPublicMessage,
  parseAdminPromotionDetailResponse,
  parseAdminPromotionSummaryResponse,
  parseAdminSettlementSwapPathsResponse,
  parseAdminStudioResponse,
  parseHostErrorResponse,
  type HostErrorCode,
} from '@stelis/contracts';
import { PromotionCurrentConflictError } from '@stelis/core-api/studio';
import {
  MemoryPromotionExecutionLedger,
  MemoryPromotionStore,
} from '@stelis/core-api/testing/studio';

// ── Hoisted mocks ───────────────────────────────────────────────────────
const {
  mockRedis,
  mockAbuseStore,
  mockRateLimiter,
  mockRequireAdminSessionFromContext,
  mockCheckAndIncrementAdminOperationAttempt,
  mockVerifySignedMessage,
  mockReadJsonBodyWithLimit,
  mockResolveClientIp,
} = vi.hoisted(() => ({
  mockRedis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    lrange: vi.fn(),
    lpush: vi.fn(),
    ltrim: vi.fn(),
  },
  mockAbuseStore: {
    listBlocks: vi.fn(),
    removeBlock: vi.fn(),
    stop: vi.fn(),
    checkIp: vi.fn(),
    checkSubject: vi.fn(),
    recordSponsorFailure: vi.fn(),
  },
  mockRateLimiter: {
    check: vi.fn(),
  },
  mockRequireAdminSessionFromContext: vi.fn(),
  mockCheckAndIncrementAdminOperationAttempt: vi.fn(),
  mockVerifySignedMessage: vi.fn(),
  mockReadJsonBodyWithLimit: vi.fn(),
  mockResolveClientIp: vi.fn(),
}));

vi.mock('@stelis/core-api/admin', () => ({
  checkAndIncrementAdminOperationAttempt: mockCheckAndIncrementAdminOperationAttempt,
  verifySignedMessage: mockVerifySignedMessage,
}));

vi.mock('../src/requireAdminSession.js', () => ({
  requireAdminSessionFromContext: mockRequireAdminSessionFromContext,
}));

vi.mock('@stelis/core-api', async () => {
  const actual = await vi.importActual('@stelis/core-api');
  return {
    ...actual,
    readJsonBodyWithLimit: mockReadJsonBodyWithLimit,
  };
});

import { createAdminRoutes, type AdminRoutesRuntimeInput } from '../src/routes/admin.js';
import { encodeSponsorRefillAccountWithdrawalIssuedReceipt } from '../src/sponsor-operations/accountSpendState.js';
import type { RelayAndStudioAppApiContext } from '../src/context.js';
import { ADMIN_AUDIT_LOG_KEY } from '../src/adminAuditLog.js';
import { createTestSponsorOperationsSettings } from './sponsor-operations/settingsFixture.js';

const ADMIN_ADDRESS = '0x' + 'a'.repeat(64);
const ADMIN_ORIGIN = 'https://admin.test';
const ABSENT_PROMOTION_ID = '00000000-0000-4000-8000-000000000099';
const LOG_PROMOTION_ID = '00000000-0000-4000-8000-000000000098';
const LOG_RECEIPT_ID = `0x${'11'.repeat(32)}`;
const UNCERTAIN_LOG_RECEIPT_ID = `0x${'22'.repeat(32)}`;
const PROMOTION_LOG_RECEIPT_ID = `0x${'33'.repeat(32)}`;
const SPONSOR_OPERATIONS_SETTINGS = createTestSponsorOperationsSettings({
  refillEnabled: false,
  refillTargetMist: null,
  runwayTargetMist: 10_000_000_000n,
  warnMist: 5_000_000_000n,
});

function createAdminRuntime(
  overrides: Partial<AdminRoutesRuntimeInput> = {},
): AdminRoutesRuntimeInput {
  return {
    admission: {
      host: {
        abuseBlocker: mockAbuseStore as never,
        rateLimiter: mockRateLimiter as never,
      },
      resolveClientIp: mockResolveClientIp,
    },
    network: 'testnet',
    allowedOrigins: [ADMIN_ORIGIN],
    admin: {
      address: ADMIN_ADDRESS,
      jwt: {
        jwtSecret: 'x'.repeat(32),
        sessionExpiry: '1h',
        issuer: 'app-api',
      },
    },
    ...overrides,
  };
}

function clientIpResolutionError(): Error {
  return new ClientIpResolutionError('Client IP could not be resolved');
}

async function expectHostError(
  response: Response,
  code: HostErrorCode,
  meta: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  expect(response.status).toBe(HOST_ERROR_HTTP_STATUS[code]);
  const body: unknown = await response.json();
  expect(() => parseHostErrorResponse(body, [code], response.status)).not.toThrow();
  expect(body).toEqual({
    error: hostErrorPublicMessage(code),
    code,
    ...meta,
  });
}

async function requestAdminApplication(
  application: Hono,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers.has('origin')) {
    headers.set('origin', ADMIN_ORIGIN);
  }
  if (init.body !== undefined && init.body !== null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return application.request(path, { ...init, headers });
}

function createMockCtx(): RelayAndStudioAppApiContext {
  const promotionStore = new MemoryPromotionStore();
  const executionLedger = new MemoryPromotionExecutionLedger(promotionStore);
  const host = {
    network: 'testnet',
    packageId: '0xPKG',
    configId: null,
    vaultRegistryId: null,
    settlementPayoutRecipientAddress: '0xRECIPIENT',
    abuseBlocker: mockAbuseStore,
    rateLimiter: mockRateLimiter,
    sponsorPool: {
      addresses: () => ['0xslot'],
      size: 1,
      primaryAddress: '0xslot',
      leaseStatus: vi.fn().mockResolvedValue({
        leasedSlots: 0,
        freeSlots: 1,
        slots: [{ address: '0xslot', leased: false }],
      }),
    },
    getConfig: vi.fn().mockResolvedValue({
      maxHostFeeMist: 1000n,
      protocolFlatFeeMist: 100n,
      maxClaimMist: 500n,
      minSettleMist: 50n,
      configVersion: 1n,
    }),
    dispose: vi.fn(),
  };
  const prepareConfig = {
    quotedHostFeeMist: 500n,
    deepbookPackageId: null,
    supportedSettlementSwapPaths: [
      {
        settlementTokenType: '0xdeeb::deep::DEEP',
        settlementTokenSymbol: 'DEEP',
        settlementTokenDecimals: 6,
        lotSize: 1000000n,
        minSize: 10000000n,
        effectiveFeeRateBps: 0,
        settlementSwapDirection: 'baseForQuote',
        hops: [
          {
            poolId: 'pool-1',
            baseType: '0xdeeb::deep::DEEP',
            quoteType:
              '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
            swapDirection: 'baseForQuote' as const,
            feeBps: 0,
          },
        ],
      },
    ],
  };
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
  return {
    mode: 'relay_and_studio',
    host: host as never,
    prepareConfig: prepareConfig as never,
    promotionStore,
    executionLedger,
    studioGlobalAllowedTargets: new Set(['0x1::promotion::claim']),
    developerJwtTrustConfig: {
      issuer: 'https://auth.admin.test',
      audience: 'stelis-studio',
      algorithm: 'RS256',
      publicKeyPem: 'test-only-key-not-parsed-by-admin-routes',
      claimPaths: { userId: 'sub', senderAddress: 'wallet_address' },
    },
    developerJwtVerifyUrl: null,
    rpcFleet: Object.freeze({
      endpoints: Object.freeze([
        Object.freeze({
          origin: 'https://fullnode.testnet.sui.io',
          role: 'primary' as const,
        }),
      ]),
    }),
    redis: mockRedis as never,
    abuseStore: mockAbuseStore as never,
    sponsorAvailability: {
      readState: readSponsorOperationsState,
    },
    sponsorOperations: {
      // Default returns a healthy single-slot state. Individual tests
      // override via `(ctx.sponsorOperations.readState as Mock).mockResolvedValue(...)`.
      readState: readSponsorOperationsState,
      settings: SPONSOR_OPERATIONS_SETTINGS,
      observeBalances: vi.fn().mockResolvedValue(undefined),
      withdraw: vi.fn().mockResolvedValue({
        status: 'succeeded',
        operationId: 'operation-success',
        digest: '0xSUCCESS_DIGEST',
        amountMist: '1000000',
        destinationAddress: ADMIN_ADDRESS,
      }),
      dispose: vi.fn(),
    } as never,
    sponsoredLogsStore: {
      append: vi.fn().mockResolvedValue(undefined),
      getSummary: vi.fn().mockResolvedValue({
        mode: 'all',
        sponsoredExecutions: '0',
        lossCount: '0',
        cumulativeHostNetMist: '0',
        cumulativeLossMist: '0',
      }),
      getRecent: vi.fn().mockResolvedValue([]),
    } as never,
  };
}

/** Reset all hoisted mocks to default values */
function resetMockDefaults(): void {
  // Redis mock defaults
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue(undefined);
  mockRedis.del.mockResolvedValue(1);
  mockRedis.lrange.mockResolvedValue([]);
  mockRedis.lpush.mockResolvedValue(1);
  mockRedis.ltrim.mockResolvedValue(undefined);
  mockAbuseStore.listBlocks.mockResolvedValue({ blocks: [], nextCursor: null });
  mockAbuseStore.removeBlock.mockResolvedValue(true);
  mockAbuseStore.stop.mockResolvedValue(undefined);
  mockAbuseStore.checkIp.mockResolvedValue({ blocked: false });
  mockAbuseStore.checkSubject.mockResolvedValue({ blocked: false });
  mockRateLimiter.check.mockResolvedValue({ allowed: true, retryAfterMs: 0 });

  // Admin module defaults
  mockCheckAndIncrementAdminOperationAttempt.mockResolvedValue({
    allowed: true,
    current: 1,
    retryAfterMs: 0,
  });
  mockVerifySignedMessage.mockResolvedValue(true);

  // Session
  mockRequireAdminSessionFromContext.mockResolvedValue({
    address: '0xADMIN',
    iat: 1000,
    exp: 2000,
    iatMs: 1000000,
  });

  // Boot-snapshotted request inputs
  mockResolveClientIp.mockReset();
  mockResolveClientIp.mockReturnValue('127.0.0.1');

  // core-api
  mockReadJsonBodyWithLimit.mockImplementation(async (req: Request) => {
    const text = await req.text();
    return JSON.parse(text);
  });
}

describe('admin routes', () => {
  let app: Hono;
  let mockCtx: RelayAndStudioAppApiContext;
  let mountedRuntime: AdminRoutesRuntimeInput;
  const adminRequest = (path: string, init: RequestInit = {}) =>
    requestAdminApplication(app, path, init);

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDefaults();
    mockCtx = createMockCtx();
    mountedRuntime = createAdminRuntime();
    const routes = createAdminRoutes(mockCtx, mountedRuntime);
    app = new Hono();
    app.route('/api', routes);
  });

  describe('auth guard middleware', () => {
    it('returns 401 when requireAdminSession returns null', async () => {
      mockRequireAdminSessionFromContext.mockResolvedValueOnce(null);
      const res = await adminRequest('/api/blocklist');
      await expectHostError(res, 'ADMIN_UNAUTHORIZED');
      expect(mockRequireAdminSessionFromContext).toHaveBeenCalledWith(
        expect.anything(),
        mockCtx,
        mountedRuntime.admin!.jwt,
      );
    });

    it.each([
      { label: 'missing', origin: null },
      { label: 'wrong', origin: 'https://wrong-admin.test' },
    ])('rejects a $label mutation Origin before credentials or domain I/O', async ({ origin }) => {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (origin !== null) headers.set('Origin', origin);

      const res = await app.request('/api/blocklist', {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ scope: 'ip', subject: '127.0.0.1' }),
      });

      await expectHostError(res, 'ADMIN_UNAUTHORIZED');
      expect(mockRequireAdminSessionFromContext).not.toHaveBeenCalled();
      expect(mockReadJsonBodyWithLimit).not.toHaveBeenCalled();
      expect(mockAbuseStore.removeBlock).not.toHaveBeenCalled();
    });

    it.each([
      { method: 'DELETE', path: '/api/blocklist', domainMethod: 'removeBlock' },
      {
        method: 'POST',
        path: '/api/sponsor-refill-account/withdraw',
        domainMethod: 'withdraw',
      },
      { method: 'POST', path: '/api/promotions', domainMethod: 'create' },
      {
        method: 'PUT',
        path: `/api/promotions/${ABSENT_PROMOTION_ID}`,
        domainMethod: 'update',
      },
      {
        method: 'POST',
        path: `/api/promotions/${ABSENT_PROMOTION_ID}/status`,
        domainMethod: 'transitionStatus',
      },
    ] as const)(
      'rejects non-JSON $method $path before credentials or domain I/O',
      async ({ method, path, domainMethod }) => {
        const domainOperation =
          domainMethod === 'removeBlock'
            ? mockAbuseStore.removeBlock
            : domainMethod === 'withdraw'
              ? mockCtx.sponsorOperations.withdraw
              : vi.spyOn(mockCtx.promotionStore, domainMethod);
        const res = await app.request(path, {
          method,
          headers: {
            Origin: ADMIN_ORIGIN,
            'Content-Type': 'text/plain',
          },
          body: JSON.stringify({}),
        });

        await expectHostError(res, 'BAD_REQUEST');
        expect(mockRequireAdminSessionFromContext).not.toHaveBeenCalled();
        expect(mockReadJsonBodyWithLimit).not.toHaveBeenCalled();
        expect(domainOperation).not.toHaveBeenCalled();
      },
    );
  });

  describe('GET /api/blocklist', () => {
    it('returns one bounded typed page for all block scopes', async () => {
      mockAbuseStore.listBlocks.mockResolvedValueOnce({
        blocks: [
          {
            identity: { scope: 'studio_user', subject: 'User-A' },
            reason: 'manipulation',
            blockedUntilMs: 1_800_000_000_000,
          },
        ],
        nextCursor: 'Y3Vyc29y',
      });
      const res = await adminRequest('/api/blocklist?limit=25');
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        blocklist: [
          {
            scope: 'studio_user',
            subject: 'User-A',
            reason: 'manipulation',
            blockedUntilMs: 1_800_000_000_000,
          },
        ],
        nextCursor: 'Y3Vyc29y',
      });
      expect(mockAbuseStore.listBlocks).toHaveBeenCalledWith({ cursor: null, limit: 25 });
    });

    it('rejects an invalid page limit before calling the store', async () => {
      const res = await adminRequest('/api/blocklist?limit=101');
      await expectHostError(res, 'BAD_REQUEST');
      expect(mockAbuseStore.listBlocks).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/blocklist', () => {
    it('returns 400 on missing identity', async () => {
      const res = await adminRequest('/api/blocklist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('returns 400 on an unsupported scope', async () => {
      const res = await adminRequest('/api/blocklist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'unknown', subject: 'value' }),
      });
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('maps invalid scope-specific identity to BAD_REQUEST', async () => {
      mockAbuseStore.removeBlock.mockRejectedValueOnce(new AbuseBlockInputError('invalid address'));
      const res = await adminRequest('/api/blocklist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'address', subject: 'not-an-address' }),
      });
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('returns the idempotent typed removal result', async () => {
      const res = await adminRequest('/api/blocklist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'ip', subject: '127.0.0.1' }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ removed: true });
      expect(mockAbuseStore.removeBlock).toHaveBeenCalledWith({
        scope: 'ip',
        subject: '127.0.0.1',
      });
    });

    it('maps an exact-current removal race to ADMIN_CONFLICT', async () => {
      mockAbuseStore.removeBlock.mockRejectedValueOnce(
        new AbuseBlockCurrentConflictError('remove'),
      );

      const res = await adminRequest('/api/blocklist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'studio_user', subject: 'User-A' }),
      });

      await expectHostError(res, 'ADMIN_CONFLICT');
    });
  });

  describe('GET /api/logs', () => {
    it('returns 200 with logs array', async () => {
      const logs = [
        {
          ts: '2026-07-15T00:00:00.000Z',
          event: 'LOGIN_SUCCESS',
          ip: '127.0.0.1',
          address: ADMIN_ADDRESS,
        },
        {
          ts: '2026-07-15T00:00:01.000Z',
          event: 'PROMOTION_CREATE',
          ip: '127.0.0.1',
          detail: 'promotionId=promotion-1',
        },
      ];
      mockRedis.lrange.mockResolvedValueOnce(logs.map((entry) => JSON.stringify(entry)));
      const res = await adminRequest('/api/logs');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.logs).toEqual(logs);
      expect(mockRedis.lrange).toHaveBeenCalledWith(ADMIN_AUDIT_LOG_KEY, 0, 199);
    });
  });

  describe('GET /api/sponsored-logs/summary', () => {
    it('defaults to mode=all when query is omitted', async () => {
      const summary = {
        mode: 'all',
        sponsoredExecutions: '5',
        lossCount: '1',
        cumulativeHostNetMist: '12345',
        cumulativeLossMist: '-1000',
      };
      (mockCtx.sponsoredLogsStore.getSummary as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        summary,
      );
      const res = await adminRequest('/api/sponsored-logs/summary');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ summary });
      expect(mockCtx.sponsoredLogsStore.getSummary).toHaveBeenCalledWith('all');
    });

    it('passes mode=generic / promotion through', async () => {
      const res = await adminRequest('/api/sponsored-logs/summary?mode=generic');
      expect(res.status).toBe(200);
      expect(mockCtx.sponsoredLogsStore.getSummary).toHaveBeenLastCalledWith('generic');
    });

    it('rejects invalid mode with 400', async () => {
      const res = await adminRequest('/api/sponsored-logs/summary?mode=BAD');
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('reports a malformed internal projection as INTERNAL_ERROR, not a client request error', async () => {
      (mockCtx.sponsoredLogsStore.getSummary as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        mode: 'all',
        sponsoredExecutions: '1',
        lossCount: '2',
        cumulativeHostNetMist: '0',
        cumulativeLossMist: '0',
      });

      const res = await adminRequest('/api/sponsored-logs/summary');
      await expectHostError(res, 'INTERNAL_ERROR');
    });
  });

  describe('GET /api/sponsored-logs', () => {
    it('returns combined summary + entries with default limit', async () => {
      const summary = {
        mode: 'all',
        sponsoredExecutions: '2',
        lossCount: '0',
        cumulativeHostNetMist: '5000',
        cumulativeLossMist: '0',
      };
      const entries = [
        {
          createdAt: '2026-04-26T16:00:00Z',
          mode: 'generic',
          outcome: 'success',
          receiptId: LOG_RECEIPT_ID,
          digest: 'digest-1',
          senderAddress: '0xsender',
          sponsorAddress: '0xsponsor',
          executionPathKey: 'generic:path',
          orderIdHash: 'order-hash-1',
          promotionId: null,
          userId: null,
          economicsStatus: 'known',
          recoveredGasMist: '5000',
          hostPaidGasMist: '1000',
          hostFeeMist: '1000',
          protocolFeeMist: '50',
          hostNetMist: '5000',
          grossGasMist: '1050',
          storageRebateMist: '0',
          failureReason: null,
        },
      ];
      (mockCtx.sponsoredLogsStore.getSummary as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        summary,
      );
      (mockCtx.sponsoredLogsStore.getRecent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        entries,
      );

      const res = await adminRequest('/api/sponsored-logs');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary).toEqual(summary);
      expect(body.entries).toEqual(entries);
      expect(mockCtx.sponsoredLogsStore.getRecent).toHaveBeenLastCalledWith('all', 50);
    });

    it('honors mode + limit query', async () => {
      const res = await adminRequest('/api/sponsored-logs?mode=promotion&limit=10');
      expect(res.status).toBe(200);
      expect(mockCtx.sponsoredLogsStore.getSummary).toHaveBeenLastCalledWith('promotion');
      expect(mockCtx.sponsoredLogsStore.getRecent).toHaveBeenLastCalledWith('promotion', 10);
    });

    it('rejects limit > 200 with 400', async () => {
      const res = await adminRequest('/api/sponsored-logs?limit=999');
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('rejects non-integer limit with 400', async () => {
      const res = await adminRequest('/api/sponsored-logs?limit=abc');
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('rejects invalid mode with 400', async () => {
      const res = await adminRequest('/api/sponsored-logs?mode=other');
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('preserves failureReason verbatim for current post-submit result rows', async () => {
      // A post-signature uncertainty has unknown economics, while a confirmed
      // Promotion success may still carry a ledger-consume diagnostic. The API
      // must preserve both without manufacturing numeric certainty.
      (mockCtx.sponsoredLogsStore.getSummary as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        mode: 'all',
        sponsoredExecutions: '2',
        lossCount: '1',
        cumulativeHostNetMist: '-12345',
        cumulativeLossMist: '-12345',
      });
      (mockCtx.sponsoredLogsStore.getRecent as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          createdAt: '2026-04-26T16:00:00Z',
          mode: 'generic',
          outcome: 'internal_error',
          receiptId: UNCERTAIN_LOG_RECEIPT_ID,
          digest: 'digest-post-signature-uncertain',
          senderAddress: '0xsender',
          sponsorAddress: '0xsponsor',
          executionPathKey: 'generic:path',
          orderIdHash: 'order-hash-post-signature-uncertain',
          promotionId: null,
          userId: null,
          economicsStatus: 'unknown',
          // unknown row: every numeric field is null (no zero coercion).
          recoveredGasMist: null,
          hostPaidGasMist: null,
          hostNetMist: null,
          hostFeeMist: null,
          protocolFeeMist: null,
          grossGasMist: null,
          storageRebateMist: null,
          failureReason: 'post_signature_uncertainty: Sui RPC transport was unavailable',
        },
        {
          createdAt: '2026-04-26T16:00:01Z',
          mode: 'promotion',
          outcome: 'success',
          receiptId: PROMOTION_LOG_RECEIPT_ID,
          digest: 'digest-ledger',
          senderAddress: '0xsender',
          sponsorAddress: '0xsponsor',
          executionPathKey: 'promotion:path',
          orderIdHash: null,
          promotionId: LOG_PROMOTION_ID,
          userId: 'user-1',
          economicsStatus: 'known',
          recoveredGasMist: '0',
          hostPaidGasMist: '12345',
          hostFeeMist: '0',
          protocolFeeMist: '0',
          hostNetMist: '-12345',
          grossGasMist: '12345',
          storageRebateMist: '0',
          failureReason: 'recorder_write_failed: storage_unavailable',
        },
      ]);

      const res = await adminRequest('/api/sponsored-logs');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(2);
      expect(body.entries[0].outcome).toBe('internal_error');
      expect(body.entries[0].failureReason).toBe(
        'post_signature_uncertainty: Sui RPC transport was unavailable',
      );
      expect(body.entries[1].outcome).toBe('success');
      expect(body.entries[1].failureReason).toBe('recorder_write_failed: storage_unavailable');

      // Numeric honesty lock at the API response: an unknown row carries
      // `hostFeeMist: null` (no zero coercion); a known row carries
      // the exact MIST decimal string ("0" only when the fee is
      // explicitly zero). The two cases must round-trip through the
      // route without one being silently coerced into the other.
      expect(body.entries[0].economicsStatus).toBe('unknown');
      expect(body.entries[0].hostFeeMist).toBeNull();
      expect(body.entries[0].protocolFeeMist).toBeNull();
      expect(body.entries[0].recoveredGasMist).toBeNull();
      expect(body.entries[0].hostPaidGasMist).toBeNull();
      expect(body.entries[0].hostNetMist).toBeNull();

      expect(body.entries[1].economicsStatus).toBe('known');
      expect(body.entries[1].hostFeeMist).toBe('0');
      expect(body.entries[1].protocolFeeMist).toBe('0');
      expect(body.entries[1].hostNetMist).toBe('-12345');
    });
  });

  describe('POST /api/sponsor-refill-account/withdrawal-challenge', () => {
    it('does not issue a challenge through the withdrawal execution URL', async () => {
      const res = await adminRequest('/api/sponsor-refill-account/withdraw');
      expect(res.status).toBe(404);
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('returns 200 with nonce and expiresAt', async () => {
      const res = await adminRequest('/api/sponsor-refill-account/withdrawal-challenge', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nonce).toBeDefined();
      expect(typeof body.nonce).toBe('string');
      expect(body.expiresAt).toBeDefined();
      expect(mockRedis.set).toHaveBeenCalledWith(
        `stelis:admin:withdraw_nonce:testnet:${body.nonce}`,
        encodeSponsorRefillAccountWithdrawalIssuedReceipt('testnet'),
        { px: 60_000 },
      );
    });

    it('returns 400 without issuing a nonce when client IP cannot be resolved', async () => {
      mockResolveClientIp.mockImplementationOnce(() => {
        throw clientIpResolutionError();
      });

      const res = await adminRequest('/api/sponsor-refill-account/withdrawal-challenge', {
        method: 'POST',
      });

      await expectHostError(res, 'CLIENT_IP_UNRESOLVED');
      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(mockRedis.lpush).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/sponsor-refill-account/withdraw', () => {
    const validWithdrawBody = {
      amountMist: '1000000',
      nonce: 'stelis-withdraw:test:123',
      signature: '0xSIG',
    };

    it('returns 400 on missing fields', async () => {
      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountMist: '100' }),
      });
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('returns 400 on invalid amountMist format', async () => {
      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validWithdrawBody, amountMist: '-100' }),
      });
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('returns 400 on amountMist = "0"', async () => {
      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validWithdrawBody, amountMist: '0' }),
      });
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('returns 401 on expired/invalid nonce', async () => {
      (mockCtx.sponsorOperations.withdraw as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        status: 'nonce_missing',
      });
      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWithdrawBody),
      });
      await expectHostError(res, 'WITHDRAWAL_NONCE_MISSING');
    });

    it('returns 401 on bad signature', async () => {
      mockVerifySignedMessage.mockResolvedValueOnce(false);

      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWithdrawBody),
      });
      await expectHostError(res, 'WITHDRAWAL_SIGNATURE_INVALID');
      expect(mockVerifySignedMessage).toHaveBeenCalledWith({
        message: buildSponsorRefillAccountWithdrawMessage(
          'testnet',
          validWithdrawBody.amountMist,
          validWithdrawBody.nonce,
        ),
        signature: validWithdrawBody.signature,
        adminAddress: '0x' + 'a'.repeat(64),
      });
      expect(mockCtx.sponsorOperations.withdraw).not.toHaveBeenCalled();
    });

    it('returns 429 when rate limited', async () => {
      mockCheckAndIncrementAdminOperationAttempt.mockResolvedValueOnce({
        allowed: false,
        current: 6,
        retryAfterMs: 900000,
      });

      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWithdrawBody),
      });
      await expectHostError(res, 'RATE_LIMITED', { retryAfterMs: 900000 });
      expect(res.headers.get('Retry-After')).toBe('900');
    });

    it('returns 400 before rate-limit or audit writes when client IP cannot be resolved', async () => {
      mockResolveClientIp.mockImplementationOnce(() => {
        throw clientIpResolutionError();
      });

      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWithdrawBody),
      });

      await expectHostError(res, 'CLIENT_IP_UNRESOLVED');
      expect(mockCheckAndIncrementAdminOperationAttempt).not.toHaveBeenCalled();
      expect(mockReadJsonBodyWithLimit).not.toHaveBeenCalled();
      expect(mockRedis.lpush).not.toHaveBeenCalled();
    });

    it('returns 422 when the durable spend flow reports execution failure', async () => {
      (mockCtx.sponsorOperations.withdraw as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        status: 'failed',
        operationId: 'operation-failed',
        digest: null,
        amountMist: validWithdrawBody.amountMist,
        error: 'InsufficientGas',
      });

      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWithdrawBody),
      });
      await expectHostError(res, 'WITHDRAWAL_FAILED');
    });

    it('returns a stable pending code without hiding the durable operation identity', async () => {
      (mockCtx.sponsorOperations.withdraw as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        status: 'pending',
        operationId: 'operation-pending',
        digest: 'digest-pending',
        amountMist: validWithdrawBody.amountMist,
        error: 'transaction visibility pending',
      });

      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWithdrawBody),
      });

      await expectHostError(res, 'WITHDRAWAL_PENDING', {
        operationId: 'operation-pending',
        digest: 'digest-pending',
      });
    });

    it('distinguishes an unaccepted withdrawal from recovery of that withdrawal', async () => {
      (mockCtx.sponsorOperations.withdraw as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        status: 'busy',
        operationId: 'blocking-operation',
        digest: 'blocking-digest',
        error: 'previous spend recovered',
      });

      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWithdrawBody),
      });

      await expectHostError(res, 'WITHDRAWAL_NOT_ACCEPTED', {
        operationId: 'blocking-operation',
        digest: 'blocking-digest',
      });
    });

    it('returns 200 on successful withdrawal', async () => {
      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWithdrawBody),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.digest).toBe('0xSUCCESS_DIGEST');
      expect(body.amountMist).toBe('1000000');
      expect(body.recipient).toBeDefined();
      expect(body).not.toHaveProperty('remainingBalanceMist');
      expect(mockCtx.sponsorOperations.withdraw).toHaveBeenCalledWith({
        destinationAddress: ADMIN_ADDRESS,
        amountMist: validWithdrawBody.amountMist,
        nonceKey: `stelis:admin:withdraw_nonce:testnet:${validWithdrawBody.nonce}`,
      });
    });

    it('keeps the durable withdrawal success response when audit storage fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockRedis.lpush.mockRejectedValueOnce(new Error('audit Redis unavailable'));

      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWithdrawBody),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        digest: '0xSUCCESS_DIGEST',
        amountMist: '1000000',
        recipient: ADMIN_ADDRESS,
      });
      expect(errorSpy).toHaveBeenCalledWith(
        '[sponsor-refill-account/withdraw] Success audit write failed:',
        expect.stringContaining('audit Redis unavailable'),
      );
      errorSpy.mockRestore();
    });

    it('binds signature verification and nonce reservation to the runtime network', async () => {
      const mainnetRoutes = createAdminRoutes(mockCtx, createAdminRuntime({ network: 'mainnet' }));
      const mainnetApp = new Hono();
      mainnetApp.route('/api', mainnetRoutes);

      const res = await requestAdminApplication(
        mainnetApp,
        '/api/sponsor-refill-account/withdraw',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validWithdrawBody),
        },
      );

      expect(res.status).toBe(200);
      expect(mockVerifySignedMessage).toHaveBeenCalledWith({
        message: buildSponsorRefillAccountWithdrawMessage(
          'mainnet',
          validWithdrawBody.amountMist,
          validWithdrawBody.nonce,
        ),
        signature: validWithdrawBody.signature,
        adminAddress: ADMIN_ADDRESS,
      });
      expect(mockCtx.sponsorOperations.withdraw).toHaveBeenCalledWith({
        destinationAddress: ADMIN_ADDRESS,
        amountMist: validWithdrawBody.amountMist,
        nonceKey: `stelis:admin:withdraw_nonce:mainnet:${validWithdrawBody.nonce}`,
      });
    });

    it('returns 400 when the shared spend runway blocks withdrawal', async () => {
      (mockCtx.sponsorOperations.withdraw as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        status: 'runway_blocked',
        operationId: 'operation-runway',
        digest: null,
        amountMist: '990000000',
        error: 'post balance below runway',
      });

      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validWithdrawBody,
          amountMist: '990000000',
        }),
      });
      await expectHostError(res, 'WITHDRAWAL_RUNWAY_BLOCKED');
    });

    it('accepts the inclusive u64 maximum at the transport boundary', async () => {
      const amountMist = '18446744073709551615';
      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validWithdrawBody, amountMist }),
      });

      expect(res.status).toBe(200);
      expect(mockCtx.sponsorOperations.withdraw).toHaveBeenCalledWith(
        expect.objectContaining({ amountMist }),
      );
    });

    it('rejects a value above u64 before signature verification or operation creation', async () => {
      const res = await adminRequest('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validWithdrawBody,
          amountMist: '18446744073709551616',
        }),
      });
      await expectHostError(res, 'BAD_REQUEST');
      expect(mockVerifySignedMessage).not.toHaveBeenCalled();
      expect(mockCtx.sponsorOperations.withdraw).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/settlement-swap-paths', () => {
    it('returns 200 with settlement swap path registry data', async () => {
      const res = await adminRequest('/api/settlement-swap-paths');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBeDefined();
      expect(Array.isArray(body.settlementSwapPaths)).toBe(true);
      expect(parseAdminSettlementSwapPathsResponse(body)).toEqual(body);
    });

    it('returns settlement swap path fields from prepareConfig', async () => {
      // Override mock to have a real settlement swap path entry.
      const SUI_TYPE =
        '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
      const DEEP_TYPE = '0xdeeb::deep::DEEP';
      (mockCtx.prepareConfig as unknown as Record<string, unknown>).supportedSettlementSwapPaths = [
        {
          settlementTokenType: DEEP_TYPE,
          settlementTokenSymbol: 'DEEP',
          settlementTokenDecimals: 6,
          lotSize: 1000000n,
          minSize: 10000000n,
          effectiveFeeRateBps: 0,
          settlementSwapDirection: 'baseForQuote',
          hops: [
            {
              poolId: '0xFAKE_POOL',
              baseType: DEEP_TYPE,
              quoteType: SUI_TYPE,
              swapDirection: 'baseForQuote',
              feeBps: 0,
            },
          ],
        },
      ];

      const res = await adminRequest('/api/settlement-swap-paths');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(1);
      expect(body.settlementSwapPaths[0].settlementTokenSymbol).toBe('DEEP');
      expect(body.settlementSwapPaths[0].hopCount).toBe(1);
      expect(body.settlementSwapPaths[0].hops[0].swapDirection).toBe('baseForQuote');
    });

    it('returns 500 when pool metadata exceeds safe integer range (fail-closed)', async () => {
      (mockCtx.prepareConfig as unknown as Record<string, unknown>).supportedSettlementSwapPaths = [
        {
          settlementTokenType: '0xTOKEN',
          settlementTokenSymbol: 'TOKEN',
          settlementTokenDecimals: 6,
          lotSize: 9007199254740993n,
          minSize: 1n,
          effectiveFeeRateBps: 0,
          settlementSwapDirection: 'baseForQuote',
          hops: [],
        },
      ];
      const res = await adminRequest('/api/settlement-swap-paths');
      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/studio', () => {
    it('returns the current Studio configuration without an additional enabled flag', async () => {
      const res = await adminRequest('/api/studio');

      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(parseAdminStudioResponse(body)).toEqual({
        config: {
          developerJwtVerifyUrlConfigured: false,
        },
      });
    });
  });

  // ── Promotion CRUD routes ───────────────────────────────────────────

  describe('promotion CRUD routes', () => {
    it('POST /api/promotions returns 400 before body parsing when client IP cannot be resolved', async () => {
      mockResolveClientIp.mockImplementationOnce(() => {
        throw clientIpResolutionError();
      });

      const res = await adminRequest('/api/promotions', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      await expectHostError(res, 'CLIENT_IP_UNRESOLVED');
      expect(mockReadJsonBodyWithLimit).not.toHaveBeenCalled();
      expect(mockRedis.lpush).not.toHaveBeenCalled();
    });

    describe('with promotionStore enabled', () => {
      beforeEach(() => {
        // Reset body parser mock to clear stale once-queue state, then
        // restore default implementation that reads actual request body.
        mockReadJsonBodyWithLimit.mockReset();
        mockReadJsonBodyWithLimit.mockImplementation(async (req: Request) => {
          const text = await req.text();
          return JSON.parse(text);
        });
      });

      it('GET /api/promotions returns empty list', async () => {
        const res = await adminRequest('/api/promotions');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { promotions: unknown[]; nextCursor: string | null };
        expect(body.promotions).toEqual([]);
        expect(body.nextCursor).toBeNull();
      });

      it('GET /api/promotions forwards the shared page params and optional status', async () => {
        const cursor = '00000000-0000-4000-8000-000000000001';
        const listPage = vi.spyOn(mockCtx.promotionStore!, 'listPage');

        const res = await adminRequest(`/api/promotions?cursor=${cursor}&limit=7&status=active`);

        expect(res.status).toBe(200);
        expect(listPage).toHaveBeenCalledWith({ cursor, limit: 7 }, { status: 'active' });
      });

      it.each([
        '/api/promotions?cursor=not-a-promotion-id',
        '/api/promotions?limit=0',
        '/api/promotions?limit=101',
        '/api/promotions?limit=1.5',
        '/api/promotions?status=unknown',
        '/api/promotions?offset=1',
      ])('GET /api/promotions returns BAD_REQUEST for invalid query: %s', async (url) => {
        const res = await adminRequest(url);

        await expectHostError(res, 'BAD_REQUEST');
      });

      it('GET /api/promotions returns a cursor for the next bounded page', async () => {
        for (const displayName of ['First', 'Second']) {
          await mockCtx.promotionStore!.create({
            type: 'gas_sponsorship',
            displayName,
            maxParticipants: 10,
            perUserGasAllowanceMist: '1000000',
          });
        }

        const firstRes = await adminRequest('/api/promotions?limit=1');
        expect(firstRes.status).toBe(200);
        const first = (await firstRes.json()) as {
          promotions: Array<{ promotionId: string }>;
          nextCursor: string | null;
        };
        expect(first.promotions).toHaveLength(1);
        expect(first.nextCursor).toBe(first.promotions[0].promotionId);

        const secondRes = await adminRequest(`/api/promotions?limit=1&cursor=${first.nextCursor}`);
        expect(secondRes.status).toBe(200);
        const second = (await secondRes.json()) as {
          promotions: Array<{ promotionId: string }>;
          nextCursor: string | null;
        };
        expect(second.promotions).toHaveLength(1);
        expect(second.promotions[0].promotionId).not.toBe(first.promotions[0].promotionId);
        expect(second.nextCursor).toBeNull();
      });

      it('GET /api/promotions maps a corrupt stored budget to INTERNAL_ERROR', async () => {
        vi.spyOn(mockCtx.promotionStore!, 'listPage').mockResolvedValueOnce({
          promotions: [
            {
              promotionId: '00000000-0000-4000-8000-000000000001',
              type: 'gas_sponsorship',
              displayName: 'Corrupt promotion',
              description: '',
              status: 'draft',
              maxParticipants: 2,
              perUserGasAllowanceMist: MAX_PROMOTION_LEDGER_VALUE_MIST.toString(),
              claimDeadlineAt: null,
              postClaimUseWindowMs: 0,
              startAt: null,
              pauseReason: null,
              archiveReason: null,
              createdAt: '2026-07-15T00:00:00.000Z',
              updatedAt: '2026-07-15T00:00:00.000Z',
            },
          ],
          nextCursor: null,
        });

        const res = await adminRequest('/api/promotions');
        await expectHostError(res, 'INTERNAL_ERROR');
      });

      it('POST /api/promotions creates a gas_sponsorship promotion', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Test Promo',
          maxParticipants: 100,
          perUserGasAllowanceMist: '1000000',
        });

        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as {
          promotion: { promotionId: string; status: string; type: string };
        };
        expect(body.promotion.status).toBe('draft');
        expect(body.promotion.type).toBe('gas_sponsorship');
      });

      it('POST /api/promotions rejects removed fields before creating a record', async () => {
        const create = vi.spyOn(mockCtx.promotionStore!, 'create');
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Removed policy field',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
          allowedTargets: ['0x1::module::function'],
        });

        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });

        await expectHostError(res, 'BAD_REQUEST');
        expect(create).not.toHaveBeenCalled();
      });

      it('does not classify an arbitrary error by its name string', async () => {
        const spoofed = new Error('not a Promotion ledger error');
        spoofed.name = 'PromotionLedgerValueError';
        vi.spyOn(mockCtx.promotionStore!, 'create').mockRejectedValueOnce(spoofed);
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Spoofed error',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
        });

        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });

        await expectHostError(res, 'INTERNAL_ERROR');
      });

      it.each([
        { label: 'null', body: null },
        { label: 'array', body: [] },
      ])(
        'POST /api/promotions rejects a $label body before creating a record',
        async ({ body }) => {
          const create = vi.spyOn(mockCtx.promotionStore!, 'create');
          mockReadJsonBodyWithLimit.mockResolvedValueOnce(body);

          const res = await adminRequest('/api/promotions', {
            method: 'POST',
            body: JSON.stringify({}),
          });

          await expectHostError(res, 'BAD_REQUEST');
          expect(create).not.toHaveBeenCalled();
        },
      );

      it('PUT /api/promotions/:id rejects create-only fields before updating a record', async () => {
        const update = vi.spyOn(mockCtx.promotionStore!, 'update');
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          displayName: 'Ignored type attempt',
          type: 'gas_sponsorship',
        });

        const res = await adminRequest(`/api/promotions/${ABSENT_PROMOTION_ID}`, {
          method: 'PUT',
          body: JSON.stringify({}),
        });

        await expectHostError(res, 'BAD_REQUEST');
        expect(update).not.toHaveBeenCalled();
      });

      it('POST /api/promotions/:id/status rejects unrelated fields before transitioning a record', async () => {
        const transition = vi.spyOn(mockCtx.promotionStore!, 'transitionStatus');
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          status: 'active',
          displayName: 'Ignored rename attempt',
        });

        const res = await adminRequest(`/api/promotions/${ABSENT_PROMOTION_ID}/status`, {
          method: 'POST',
          body: JSON.stringify({}),
        });

        await expectHostError(res, 'BAD_REQUEST');
        expect(transition).not.toHaveBeenCalled();
      });

      it('POST /api/promotions success emits a PROMOTION_CREATE audit entry', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Audited Promo',
          maxParticipants: 42,
          perUserGasAllowanceMist: '2500000',
        });
        mockRedis.lpush.mockClear();

        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as {
          promotion: { promotionId: string; maxParticipants: number };
        };

        const createCalls = mockRedis.lpush.mock.calls
          .filter((call) => call[0] === ADMIN_AUDIT_LOG_KEY)
          .map((call) => JSON.parse(call[1] as string) as { event?: string; detail?: string })
          .filter((entry) => entry.event === 'PROMOTION_CREATE');
        expect(createCalls).toHaveLength(1);
        const entry = createCalls[0]! as {
          event: string;
          ts: string;
          ip: string;
          detail: string;
        };
        expect(mockRedis.ltrim).toHaveBeenCalledWith(ADMIN_AUDIT_LOG_KEY, 0, 199);
        expect(entry.event).toBe('PROMOTION_CREATE');
        expect(entry.ts).toMatch(/\d{4}-\d{2}-\d{2}T/);
        expect(entry.ip).toBe('127.0.0.1');
        expect(entry.detail).toContain(`promotionId=${body.promotion.promotionId}`);
        expect(entry.detail).toContain('maxParticipants=42');
        expect(entry.detail).toContain('perUserGasAllowanceMist=2500000');
      });

      it('POST /api/promotions rejects maxParticipants=0 at parse boundary (400)', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Zero Max',
          maxParticipants: 0,
          perUserGasAllowanceMist: '1000000',
        });
        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'BAD_REQUEST');
      });

      it('POST /api/promotions rejects non-integer maxParticipants (400)', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Float Max',
          maxParticipants: 3.14,
          perUserGasAllowanceMist: '1000000',
        });
        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'BAD_REQUEST');
      });

      it('POST /api/promotions rejects negative maxParticipants (400)', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Neg Max',
          maxParticipants: -1,
          perUserGasAllowanceMist: '1000000',
        });
        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'BAD_REQUEST');
      });

      it('POST /api/promotions rejects unsafe integer maxParticipants (400)', async () => {
        // Number.MAX_SAFE_INTEGER + 2 === 9007199254740993 parses to 9007199254740992
        // under IEEE-754 double; passing this number directly through the mock body
        // reproduces the rounded-but-still-isInteger value that the guard must reject.
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Unsafe Max',
          maxParticipants: Number.MAX_SAFE_INTEGER + 2,
          perUserGasAllowanceMist: '1000000',
        });
        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'BAD_REQUEST');
      });

      it('POST /api/promotions rejects unsafe integer postClaimUseWindowMs (400)', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Unsafe Window',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
          postClaimUseWindowMs: Number.MAX_SAFE_INTEGER + 2,
        });
        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'BAD_REQUEST');
      });

      it('PUT /api/promotions/:id rejects unsafe integer maxParticipants (400)', async () => {
        // Create a draft first (presentational freeze does not apply on draft).
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Draft For Unsafe PUT',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        // Unsafe-integer update is rejected at the HTTP body boundary before the
        // store's freeze gate — parse guard supersedes field-class logic.
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          maxParticipants: Number.MAX_SAFE_INTEGER + 2,
        });
        const res = await adminRequest(`/api/promotions/${created.promotion.promotionId}`, {
          method: 'PUT',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'BAD_REQUEST');
      });

      it('POST /api/promotions rejects malformed perUserGasAllowanceMist (400)', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Bad Bigint',
          maxParticipants: 10,
          perUserGasAllowanceMist: 'abc',
        });
        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'BAD_REQUEST');
      });

      it('POST /api/promotions rejects zero perUserGasAllowanceMist (400)', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Zero Allowance',
          maxParticipants: 10,
          perUserGasAllowanceMist: '0',
        });
        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'BAD_REQUEST');
      });

      it('POST /api/promotions rejects perUserGasAllowanceMist above the ledger bound', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Over-bound per-user',
          maxParticipants: 10,
          perUserGasAllowanceMist: (MAX_PROMOTION_LEDGER_VALUE_MIST + 1n).toString(),
        });
        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'ADMIN_UNPROCESSABLE');
      });

      it('POST /api/promotions rejects a complete budget above the ledger bound', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Over-bound product (draft)',
          maxParticipants: 1_000_000,
          // 1M × 9_007_199_254_740 exceeds the contracts-owned ledger bound.
          perUserGasAllowanceMist: '9007199254740',
        });
        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'ADMIN_UNPROCESSABLE');
      });

      it('PUT /api/promotions/:id rejects perUserGasAllowanceMist above the ledger bound', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'PUT bound seed',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        expect(createRes.status).toBe(201);
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          perUserGasAllowanceMist: (MAX_PROMOTION_LEDGER_VALUE_MIST + 1n).toString(),
        });
        const updateRes = await adminRequest(`/api/promotions/${created.promotion.promotionId}`, {
          method: 'PUT',
          body: JSON.stringify({}),
        });
        await expectHostError(updateRes, 'ADMIN_UNPROCESSABLE');
      });

      it('POST /api/promotions rejects malformed claimDeadlineAt (400)', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Bad Deadline',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
          claimDeadlineAt: 'not-a-date',
        });
        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'BAD_REQUEST');
      });

      it('POST /api/promotions rejects unsupported promotion type', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'unsupported_type',
          displayName: 'Bad',
        });

        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'BAD_REQUEST');
      });

      it('POST /api/promotions rejects missing required fields', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          displayName: 'Missing type and targets',
        });

        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'BAD_REQUEST');
      });

      it('GET /api/promotions/:id returns 404 for non-existent', async () => {
        const res = await adminRequest(`/api/promotions/${ABSENT_PROMOTION_ID}`);
        expect(res.status).toBe(404);
      });

      it('GET /api/promotions/:id returns created promotion', async () => {
        // Create first
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Fetch Me',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };
        const status = vi.spyOn(mockCtx.executionLedger!, 'getPromotionLedgerStatus');

        const res = await adminRequest(`/api/promotions/${created.promotion.promotionId}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { promotion: { displayName: string } };
        expect(body.promotion.displayName).toBe('Fetch Me');
        expect(status).toHaveBeenCalledTimes(1);
        expect(status).toHaveBeenCalledWith(created.promotion.promotionId, null);
        expect(parseAdminPromotionDetailResponse(body)).toEqual(body);
      });

      it('PUT /api/promotions/:id updates fields', async () => {
        // Create
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Original',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        // Update
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          displayName: 'Updated',
          maxParticipants: 50,
        });
        const res = await adminRequest(`/api/promotions/${created.promotion.promotionId}`, {
          method: 'PUT',
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          promotion: { displayName: string; maxParticipants: number };
        };
        expect(body.promotion.displayName).toBe('Updated');
        expect(body.promotion.maxParticipants).toBe(50);
      });

      it('PUT /api/promotions/:id returns 404 for non-existent', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ displayName: 'X' });
        const res = await adminRequest(`/api/promotions/${ABSENT_PROMOTION_ID}`, {
          method: 'PUT',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'ADMIN_NOT_FOUND');
      });

      // ── Derived budget + temporal response contract ────────────────

      it('POST /api/promotions response includes derived totalRequiredBudgetMist', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Budget Check',
          maxParticipants: 200,
          perUserGasAllowanceMist: '5000000',
        });
        const res = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as {
          promotion: {
            maxParticipants: number;
            perUserGasAllowanceMist: string;
            totalRequiredBudgetMist: string;
          };
        };
        // 200 * 5_000_000 = 1_000_000_000
        expect(body.promotion.totalRequiredBudgetMist).toBe('1000000000');
        expect(body.promotion.maxParticipants).toBe(200);
        expect(body.promotion.perUserGasAllowanceMist).toBe('5000000');
      });

      it('POST /api/promotions round-trips temporal fields (claimDeadlineAt, postClaimUseWindowMs)', async () => {
        const deadline = '2026-06-01T00:00:00.000Z';
        const windowMs = 7 * 86_400_000; // 7 days
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Temporal Fields',
          maxParticipants: 50,
          perUserGasAllowanceMist: '1000000',
          claimDeadlineAt: deadline,
          postClaimUseWindowMs: windowMs,
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        expect(createRes.status).toBe(201);
        const created = (await createRes.json()) as {
          promotion: {
            promotionId: string;
            claimDeadlineAt: string | null;
            postClaimUseWindowMs: number;
          };
        };
        expect(created.promotion.claimDeadlineAt).toBe(deadline);
        expect(created.promotion.postClaimUseWindowMs).toBe(windowMs);

        // Verify the current collection route returns the same stored values.
        const listRes = await adminRequest('/api/promotions');
        expect(listRes.status).toBe(200);
        const listed = (await listRes.json()) as {
          promotions: Array<{
            promotionId: string;
            claimDeadlineAt: string | null;
            postClaimUseWindowMs: number;
            totalRequiredBudgetMist: string;
          }>;
        };
        const fetched = listed.promotions.find(
          (promotion) => promotion.promotionId === created.promotion.promotionId,
        );
        expect(fetched).toBeDefined();
        expect(fetched?.claimDeadlineAt).toBe(deadline);
        expect(fetched?.postClaimUseWindowMs).toBe(windowMs);
        // 50 * 1_000_000 = 50_000_000
        expect(fetched?.totalRequiredBudgetMist).toBe('50000000');
      });

      it('PUT /api/promotions/:id recalculates totalRequiredBudgetMist on budget field change', async () => {
        // Create with known budget inputs
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Recalc',
          maxParticipants: 100,
          perUserGasAllowanceMist: '10000000',
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as {
          promotion: { promotionId: string; totalRequiredBudgetMist: string };
        };
        // 100 * 10_000_000 = 1_000_000_000
        expect(created.promotion.totalRequiredBudgetMist).toBe('1000000000');

        // Update maxParticipants → derived budget should change
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ maxParticipants: 200 });
        const updateRes = await adminRequest(`/api/promotions/${created.promotion.promotionId}`, {
          method: 'PUT',
          body: JSON.stringify({}),
        });
        expect(updateRes.status).toBe(200);
        const updated = (await updateRes.json()) as {
          promotion: { totalRequiredBudgetMist: string; maxParticipants: number };
        };
        // 200 * 10_000_000 = 2_000_000_000
        expect(updated.promotion.totalRequiredBudgetMist).toBe('2000000000');
        expect(updated.promotion.maxParticipants).toBe(200);
      });

      it('POST /api/promotions/:id/status transitions draft → active', async () => {
        // Create with targets
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Activate Me',
          maxParticipants: 100,
          perUserGasAllowanceMist: '10000000',
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        // Transition
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'active' });
        const res = await adminRequest(`/api/promotions/${created.promotion.promotionId}/status`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { promotion: { status: string } };
        expect(body.promotion.status).toBe('active');
      });

      it('POST /api/promotions/:id/status returns 409 for invalid transition', async () => {
        // Create draft
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Bad Transition',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        // draft → archived (invalid)
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'archived' });
        const res = await adminRequest(`/api/promotions/${created.promotion.promotionId}/status`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'ADMIN_CONFLICT');
      });

      it('PUT /api/promotions/:id rejects economic-field edit on active promotion (409)', async () => {
        // Create + activate
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Active For Freeze',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        expect(createRes.status).toBe(201);
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'active' });
        const actRes = await adminRequest(
          `/api/promotions/${created.promotion.promotionId}/status`,
          {
            method: 'POST',
            body: JSON.stringify({}),
          },
        );
        expect(actRes.status).toBe(200);
        const activated = (await actRes.json()) as { promotion: { status: string } };
        expect(activated.promotion.status).toBe('active');

        // Post-draft economic-field edit → 409 via PromotionFieldImmutableError
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ maxParticipants: 999 });
        const res = await adminRequest(`/api/promotions/${created.promotion.promotionId}`, {
          method: 'PUT',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'ADMIN_CONFLICT');
      });

      it('PUT /api/promotions/:id allows presentational-field edit on active promotion', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Rename Target',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'active' });
        await adminRequest(`/api/promotions/${created.promotion.promotionId}/status`, {
          method: 'POST',
          body: JSON.stringify({}),
        });

        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ displayName: 'Renamed' });
        const res = await adminRequest(`/api/promotions/${created.promotion.promotionId}`, {
          method: 'PUT',
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { promotion: { displayName: string } };
        expect(body.promotion.displayName).toBe('Renamed');
      });

      it('POST /api/promotions/:id/status returns 404 for non-existent', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'active' });
        const res = await adminRequest(`/api/promotions/${ABSENT_PROMOTION_ID}/status`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'ADMIN_NOT_FOUND');
      });

      it('POST /api/promotions/:id/status returns 400 for invalid status value', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'bogus' });
        const res = await adminRequest(`/api/promotions/${ABSENT_PROMOTION_ID}/status`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'BAD_REQUEST');
      });

      it('POST /api/promotions/:id/status rejects a non-string reason before the store', async () => {
        const transition = vi.spyOn(mockCtx.promotionStore!, 'transitionStatus');
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          status: 'active',
          reason: { nested: 'not-a-string' },
        });

        const res = await adminRequest(`/api/promotions/${ABSENT_PROMOTION_ID}/status`, {
          method: 'POST',
          body: JSON.stringify({}),
        });

        await expectHostError(res, 'BAD_REQUEST');
        expect(transition).not.toHaveBeenCalled();
      });

      it.each([
        {
          label: 'create',
          storeMethod: 'create',
          method: 'POST',
          path: '/api/promotions',
          body: {
            type: 'gas_sponsorship',
            displayName: 'Conflict',
            maxParticipants: 1,
            perUserGasAllowanceMist: '1',
          },
        },
        {
          label: 'update',
          storeMethod: 'update',
          method: 'PUT',
          path: `/api/promotions/${ABSENT_PROMOTION_ID}`,
          body: { displayName: 'Conflict' },
        },
        {
          label: 'status',
          storeMethod: 'transitionStatus',
          method: 'POST',
          path: `/api/promotions/${ABSENT_PROMOTION_ID}/status`,
          body: { status: 'active' },
        },
        {
          label: 'delete',
          storeMethod: 'delete',
          method: 'DELETE',
          path: `/api/promotions/${ABSENT_PROMOTION_ID}`,
          body: null,
        },
      ] as const)('maps a $label current-record race to stable 409 conflict', async (testCase) => {
        const conflict = new PromotionCurrentConflictError('conflict', testCase.label);
        (mockCtx.promotionStore as unknown as Record<string, unknown>)[testCase.storeMethod] = vi
          .fn()
          .mockRejectedValue(conflict);
        if (testCase.body !== null) {
          mockReadJsonBodyWithLimit.mockResolvedValueOnce(testCase.body);
        }

        const res = await adminRequest(testCase.path, {
          method: testCase.method,
          body: testCase.body === null ? undefined : JSON.stringify({}),
        });

        await expectHostError(res, 'PROMOTION_CURRENT_CONFLICT');
      });

      it('DELETE /api/promotions/:id deletes draft promotion', async () => {
        // Create
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Delete Me',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        const res = await adminRequest(`/api/promotions/${created.promotion.promotionId}`, {
          method: 'DELETE',
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean };
        expect(body.ok).toBe(true);
      });

      it('DELETE /api/promotions/:id returns 409 for non-draft', async () => {
        // Create and activate
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Active',
          maxParticipants: 50,
          perUserGasAllowanceMist: '5000000',
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'active' });
        await adminRequest(`/api/promotions/${created.promotion.promotionId}/status`, {
          method: 'POST',
          body: JSON.stringify({}),
        });

        const res = await adminRequest(`/api/promotions/${created.promotion.promotionId}`, {
          method: 'DELETE',
        });
        await expectHostError(res, 'ADMIN_CONFLICT');
      });

      it('DELETE /api/promotions/:id returns 404 for non-existent', async () => {
        const res = await adminRequest(`/api/promotions/${ABSENT_PROMOTION_ID}`, {
          method: 'DELETE',
        });
        await expectHostError(res, 'ADMIN_NOT_FOUND');
      });

      it('GET /api/promotions?status=active filters by status', async () => {
        // Create two promotions, activate one
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Draft One',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
        });
        await adminRequest('/api/promotions', { method: 'POST', body: JSON.stringify({}) });

        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Active One',
          maxParticipants: 100,
          perUserGasAllowanceMist: '10000000',
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'active' });
        await adminRequest(`/api/promotions/${created.promotion.promotionId}/status`, {
          method: 'POST',
          body: JSON.stringify({}),
        });

        // Filter
        const res = await adminRequest('/api/promotions?status=active');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { promotions: Array<{ displayName: string }> };
        expect(body.promotions).toHaveLength(1);
        expect(body.promotions[0].displayName).toBe('Active One');
      });
      // Cross-route: claim → admin summary
      it('GET /api/promotions/:id/summary reflects claimed count + budget after claim', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Summary ClaimCount Test',
          maxParticipants: 10,
          perUserGasAllowanceMist: '5000000',
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };
        const promoId = created.promotion.promotionId;

        const ledger = (
          mockCtx as unknown as {
            executionLedger: import('@stelis/core-api/studio').PromotionExecutionLedger;
          }
        ).executionLedger;
        const promotionStore = (
          mockCtx as unknown as {
            promotionStore: import('@stelis/core-api/studio').PromotionStoreAdapter;
          }
        ).promotionStore;
        await promotionStore.transitionStatus(promoId, 'active');
        await ledger.claim(promoId, 'user-1', {
          useUntilAt: null,
        });

        const res = await adminRequest(`/api/promotions/${promoId}/summary`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          summary: {
            claimedCount: number;
            totalRemainingBudgetMist: string;
          };
        };
        expect(body.summary.claimedCount).toBe(1);
        // total = 10 * 5M = 50M, no reserves yet → available = 50M
        expect(body.summary.totalRemainingBudgetMist).toBe('50000000');
      });

      it('GET /api/promotions/:id/summary returns 404 for non-existent promotion', async () => {
        const res = await adminRequest(`/api/promotions/${ABSENT_PROMOTION_ID}/summary`);
        expect(res.status).toBe(404);
      });

      it('GET /api/promotions/:id/summary returns budget KPIs', async () => {
        // Create promo
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Summary Test',
          maxParticipants: 10,
          perUserGasAllowanceMist: '5000000',
        });
        const createRes = await adminRequest('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        const res = await adminRequest(`/api/promotions/${created.promotion.promotionId}/summary`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          promotionId: string;
          summary: {
            claimedCount: number;
            totalRequiredBudgetMist: string;
            totalRemainingBudgetMist: string;
          };
        };
        expect(body.promotionId).toBe(created.promotion.promotionId);
        expect(body.summary.claimedCount).toBe(0);
        expect(body.summary.totalRequiredBudgetMist).toBe('50000000');
        expect(parseAdminPromotionSummaryResponse(body)).toEqual(body);
      });
    });
  });

  // ── GET /api/sponsor-operations — RPC fleet snapshot ────────────────────────────
  describe('GET /api/sponsor-operations', () => {
    it('returns 500 when pool metadata exceeds safe integer range (fail-closed)', async () => {
      (mockCtx.prepareConfig as unknown as Record<string, unknown>).supportedSettlementSwapPaths = [
        {
          settlementTokenType: '0xTOKEN',
          lotSize: 9007199254740993n,
          minSize: 1n,
        },
      ];
      const res = await adminRequest('/api/sponsor-operations');
      expect(res.status).toBe(500);
      // Restore
      (mockCtx.prepareConfig as unknown as Record<string, unknown>).supportedSettlementSwapPaths = [
        {
          settlementTokenType: '0xdeeb::deep::DEEP',
          settlementTokenSymbol: 'DEEP',
          settlementTokenDecimals: 6,
          lotSize: 1000000n,
          minSize: 10000000n,
          effectiveFeeRateBps: 0,
          settlementSwapDirection: 'baseForQuote',
          hops: [
            {
              poolId: 'pool-1',
              baseType: '0xdeeb::deep::DEEP',
              quoteType: '0x2::sui::SUI',
              swapDirection: 'baseForQuote',
              feeBps: 0,
            },
          ],
        },
      ];
    });

    it('returns rpcFleet with safe fields (no auth/secret data)', async () => {
      const res = await adminRequest('/api/sponsor-operations');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.rpcFleet).toEqual({
        endpoints: [
          {
            origin: 'https://fullnode.testnet.sui.io',
            role: 'primary',
          },
        ],
      });
      expect(body.rpcFleet.totalEndpoints).toBeUndefined();
      expect(body.rpcFleet.healthyEndpoints).toBeUndefined();
      expect(body.rpcFleet.endpointCount).toBeUndefined();

      // Each endpoint has safe fields only
      for (const ep of body.rpcFleet.endpoints) {
        expect(typeof ep.origin).toBe('string');
        expect(['primary', 'secondary']).toContain(ep.role);
        expect(ep.status).toBeUndefined();
        expect(ep.cooldownRemainingMs).toBeUndefined();

        // Must NOT contain secret fields
        expect(ep.meta).toBeUndefined();
        expect(ep.auth).toBeUndefined();
        expect(ep.token).toBeUndefined();
        expect(ep.secret).toBeUndefined();
        expect(ep.fetchInit).toBeUndefined();
      }
    });

    it('awaits the retained balance observation before serialising /api/sponsor-operations', async () => {
      // Admin `/api/sponsor-operations` runs a bounded sponsor-refill-account probe before the
      // shared-state read so the returned payload is "fresh at return
      // time" rather than stale-then-next-read.
      const res = await adminRequest('/api/sponsor-operations');
      expect(res.status).toBe(200);
      expect(mockCtx.sponsorOperations.observeBalances).toHaveBeenCalledWith();
    });

    it('fails closed when the awaited sponsor-refill-account update cannot be committed', async () => {
      (mockCtx.sponsorOperations.observeBalances as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('redis sponsor refill account write failed'),
      );

      const res = await adminRequest('/api/sponsor-operations');

      await expectHostError(res, 'INTERNAL_ERROR');
    });

    it('serialises the same freshness- and lease-aware state used by prepare admission', async () => {
      const observedAtMs = 1_700_000_000_000;
      (
        mockCtx.host.sponsorPool.leaseStatus as unknown as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce({
        leasedSlots: 1,
        freeSlots: 1,
        slots: [
          { address: '0xSLOT1', leased: true },
          { address: '0xSLOT2', leased: false },
        ],
      });
      (mockCtx.sponsorOperations.readState as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        settings: SPONSOR_OPERATIONS_SETTINGS,
        slots: [
          {
            address: '0xSLOT1',
            state: 'healthy',
            addressBalanceMist: '5000000000',
            observationFresh: false,
            lastError: null,
            lastObservedAtMs: observedAtMs,
            writeSeq: 3,
          },
          {
            address: '0xSLOT2',
            state: 'low_balance',
            addressBalanceMist: '100000000',
            observationFresh: true,
            lastError: null,
            lastObservedAtMs: observedAtMs,
            writeSeq: 3,
          },
        ],
        sponsorRefillAccount: {
          totalBalanceMist: '10000000000',
          healthy: true,
          observationFresh: true,
          lastError: null,
          lastObservedAtMs: observedAtMs,
          writeSeq: 3,
        },
      });

      const res = await adminRequest('/api/sponsor-operations');
      expect(res.status).toBe(200);
      const body = await res.json();

      // Document-level snapshot header fields are not part of sponsorOperations.
      expect(body.sponsorOperations.generation).toBeUndefined();
      expect(body.sponsorOperations.publishedAtMs).toBeUndefined();
      expect(body.sponsorOperations.staleAfterMs).toBeUndefined();
      expect(body.sponsorOperations.stale).toBeUndefined();

      // The stored state says healthy, but the expired observation is published
      // as unavailable. The only healthy-looking slot is also leased, so the
      // public gate agrees with prepare admission.
      expect(body.sponsorOperations).toMatchObject({
        gateErrorCode: 'SPONSOR_CAPACITY_UNAVAILABLE',
        healthySlots: 0,
        degradedSlots: 2,
        slotLeases: {
          leasedSlots: 1,
          freeSlots: 1,
          slots: [
            { address: '0xSLOT1', leased: true },
            { address: '0xSLOT2', leased: false },
          ],
        },
      });
      expect(body.sponsorOperations.slots).toHaveLength(2);
      expect(body.sponsorOperations.slots[0]).toEqual({
        address: '0xSLOT1',
        state: 'rpc_unreachable',
        addressBalanceMist: '5000000000',
        lastObservedAtMs: observedAtMs,
        lastError: null,
      });
      expect(body.sponsorOperations.sponsorRefillAccount).toEqual({
        address: mockCtx.sponsorOperations.settings.sponsorRefillAccountAddress,
        totalBalanceMist: '10000000000',
        healthy: true,
        lastObservedAtMs: observedAtMs,
        lastError: null,
      });
    });

    it('omits top-level /api/sponsor-operations flat fields (data lives under `sponsorOperations`)', async () => {
      const res = await adminRequest('/api/sponsor-operations');
      expect(res.status).toBe(200);
      const body = await res.json();

      // Top-level flat fields are intentionally absent; the same data is exposed under `sponsorOperations`.
      expect(body.autoPause).toBeUndefined();
      expect(body.slots).toBeUndefined();
      expect(body.poolSize).toBeUndefined();
      expect(body.sponsorRefillAccountAddress).toBeUndefined();
      expect(body.sponsorRefillAccountBalance).toBeUndefined();
      // Settlement payout recipient balance is not part of the response contract.
      expect(body.settlementPayoutRecipientBalance).toBeUndefined();
    });

    it('returns boot-derived configuration fields and the cached feeConfig', async () => {
      const res = await adminRequest('/api/sponsor-operations');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.network).toBe('testnet');
      expect(body.primaryAddress).toBe('0xslot');
      expect(body.settlementPayoutRecipientAddress).toBe('0xRECIPIENT');
      expect(body.sponsorBalanceWarnMist).toBe('5000000000');
      expect(body.sponsorBalanceRefillTargetMist).toBeNull();
      expect(body.sponsorRefillAccountRunwayTargetMist).toBe('10000000000');
      expect(body.refillEnabled).toBe(false);
      expect(typeof body.quotedHostFeeMist).toBe('string');
      expect(body.feeConfig).toMatchObject({
        maxHostFeeMist: '1000',
        protocolFlatFeeMist: '100',
        maxClaimMist: '500',
        minSettleMist: '50',
        configVersion: '1',
      });
      expect(mockCtx.host.getConfig).toHaveBeenCalled();
      expect(body.onChainIds).toBeDefined();
    });
  });
});
