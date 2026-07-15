/**
 * Admin route contract tests — verifies HTTP contracts.
 *
 * Tests use Hono's app.request() with mocked dependencies.
 * All admin routes require requireAdminSession — middleware tested here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ClientIpResolutionError } from '@stelis/core-api';
import {
  HOST_ERROR_HTTP_STATUS,
  buildSponsorRefillAccountWithdrawMessage,
  hostErrorPublicMessage,
  parseAdminPromotionDetailResponse,
  parseAdminPromotionSummaryResponse,
  parseAdminPromotionUsersResponse,
  parseAdminSettlementSwapPathsResponse,
  parseHostErrorResponse,
  type HostErrorCode,
} from '@stelis/contracts';
import { PromotionCurrentConflictError } from '@stelis/core-api/studio';

// ── Hoisted mocks ───────────────────────────────────────────────────────
const {
  mockRedis,
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
    scan: vi.fn(),
    ttl: vi.fn(),
    lrange: vi.fn(),
    lpush: vi.fn(),
    ltrim: vi.fn(),
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
import type { AppApiContext } from '../src/context.js';
import { ADMIN_AUDIT_LOG_KEY } from '../src/adminAuditLog.js';
import { SuiRpcFailoverTransport } from '../src/sui/failoverTransport.js';

const ADMIN_ADDRESS = '0x' + 'a'.repeat(64);

function createAdminRuntime(
  overrides: Partial<AdminRoutesRuntimeInput> = {},
): AdminRoutesRuntimeInput {
  return {
    resolveClientIp: mockResolveClientIp,
    network: 'testnet',
    adminAddress: ADMIN_ADDRESS,
    adminJwt: {
      jwtSecret: 'x'.repeat(32),
      sessionExpiry: '1h',
      issuer: 'app-api',
    },
    refillEnabled: false,
    warnMist: 5_000_000_000n,
    refillTargetMist: 10_000_000_000n,
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

function createMockCtx(): AppApiContext {
  return {
    host: {
      network: 'testnet',
      packageId: '0xPKG',
      configId: null,
      vaultRegistryId: null,
      settlementPayoutRecipientAddress: '0xRECIPIENT',
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
      sui: {
        getBalance: vi.fn().mockResolvedValue({ balance: { balance: '1000000000' } }),
        getTransaction: vi.fn().mockResolvedValue({ digest: 'mock-digest', effects: {} }),
      },
      getConfig: vi.fn().mockResolvedValue({
        maxHostFeeMist: 1000n,
        protocolFlatFeeMist: 100n,
        maxClaimMist: 500n,
        minSettleMist: 50n,
        configVersion: 1n,
      }),
      dispose: vi.fn(),
    } as never,
    prepareConfig: {
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
    } as never,
    studio: null,
    promotionStore: null,
    usageStore: null,
    executionLedger: null,
    studioGlobalAllowedTargets: null,
    developerJwtTrustConfig: null,
    developerJwtVerifyUrl: null,
    failoverTransport: new SuiRpcFailoverTransport([
      { url: 'https://fullnode.testnet.sui.io:443' },
    ]),
    redis: mockRedis as never,
    sponsorOperations: {
      // Default returns a healthy single-slot state. Individual tests
      // override via `(ctx.sponsorOperations.readState as Mock).mockResolvedValue(...)`.
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
      withdraw: vi.fn().mockResolvedValue({
        status: 'succeeded',
        operationId: 'operation-success',
        digest: '0xSUCCESS_DIGEST',
        amountMist: '1000000',
        destinationAddress: ADMIN_ADDRESS,
      }),
      slotAddresses: ['0xslot'],
      sponsorRefillAccountAddress: '0x' + '55'.repeat(32),
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
    dispose: vi.fn(),
  };
}

/** Reset all hoisted mocks to default values */
function resetMockDefaults(): void {
  // Redis mock defaults
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue(undefined);
  mockRedis.del.mockResolvedValue(1);
  mockRedis.scan.mockResolvedValue([]);
  mockRedis.ttl.mockResolvedValue(300);
  mockRedis.lrange.mockResolvedValue([]);
  mockRedis.lpush.mockResolvedValue(1);
  mockRedis.ltrim.mockResolvedValue(undefined);

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
  let mockCtx: AppApiContext;
  let mountedContextPromise: Promise<AppApiContext>;
  let mountedRuntime: AdminRoutesRuntimeInput;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDefaults();
    mockCtx = createMockCtx();
    mountedContextPromise = Promise.resolve(mockCtx);
    mountedRuntime = createAdminRuntime();
    const routes = createAdminRoutes(mountedContextPromise, mountedRuntime);
    app = new Hono();
    app.route('/api', routes);
  });

  describe('auth guard middleware', () => {
    it('returns 401 when requireAdminSession returns null', async () => {
      mockRequireAdminSessionFromContext.mockResolvedValueOnce(null);
      const res = await app.request('/api/blocklist');
      await expectHostError(res, 'ADMIN_UNAUTHORIZED');
      expect(mockRequireAdminSessionFromContext).toHaveBeenCalledWith(
        expect.anything(),
        mountedContextPromise,
        mountedRuntime.adminJwt,
      );
    });
  });

  describe('GET /api/blocklist', () => {
    it('returns 200 with blocklist entries', async () => {
      mockRedis.scan.mockResolvedValueOnce(['stelis:abuse:block:ip:1.2.3.4']);
      mockRedis.scan.mockResolvedValueOnce([]);
      const res = await app.request('/api/blocklist');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.blocklist).toBeDefined();
      expect(Array.isArray(body.blocklist)).toBe(true);
    });
  });

  describe('DELETE /api/blocklist', () => {
    it('returns 400 on missing key', async () => {
      const res = await app.request('/api/blocklist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('returns 403 on unauthorized key prefix', async () => {
      const res = await app.request('/api/blocklist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'random:key' }),
      });
      await expectHostError(res, 'ADMIN_FORBIDDEN');
    });

    it('returns 200 on valid key', async () => {
      const res = await app.request('/api/blocklist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'stelis:abuse:block:ip:1.2.3.4' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
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
      const res = await app.request('/api/logs');
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
      const res = await app.request('/api/sponsored-logs/summary');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ summary });
      expect(mockCtx.sponsoredLogsStore.getSummary).toHaveBeenCalledWith('all');
    });

    it('passes mode=generic / promotion through', async () => {
      const res = await app.request('/api/sponsored-logs/summary?mode=generic');
      expect(res.status).toBe(200);
      expect(mockCtx.sponsoredLogsStore.getSummary).toHaveBeenLastCalledWith('generic');
    });

    it('rejects invalid mode with 400', async () => {
      const res = await app.request('/api/sponsored-logs/summary?mode=BAD');
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

      const res = await app.request('/api/sponsored-logs/summary');
      await expectHostError(res, 'INTERNAL_ERROR');
    });
  });

  describe('GET /api/sponsored-logs', () => {
    it('returns combined summary + entries with default limit', async () => {
      const summary = {
        mode: 'all',
        sponsoredExecutions: '2',
        lossCount: '0',
        cumulativeHostNetMist: '4000',
        cumulativeLossMist: '0',
      };
      const entries = [
        {
          createdAt: '2026-04-26T16:00:00Z',
          mode: 'generic',
          outcome: 'success',
          receiptId: 'r1',
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
          hostNetMist: '4000',
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

      const res = await app.request('/api/sponsored-logs');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary).toEqual(summary);
      expect(body.entries).toEqual(entries);
      expect(mockCtx.sponsoredLogsStore.getRecent).toHaveBeenLastCalledWith('all', 50);
    });

    it('honors mode + limit query', async () => {
      const res = await app.request('/api/sponsored-logs?mode=promotion&limit=10');
      expect(res.status).toBe(200);
      expect(mockCtx.sponsoredLogsStore.getSummary).toHaveBeenLastCalledWith('promotion');
      expect(mockCtx.sponsoredLogsStore.getRecent).toHaveBeenLastCalledWith('promotion', 10);
    });

    it('rejects limit > 200 with 400', async () => {
      const res = await app.request('/api/sponsored-logs?limit=999');
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('rejects non-integer limit with 400', async () => {
      const res = await app.request('/api/sponsored-logs?limit=abc');
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('rejects invalid mode with 400', async () => {
      const res = await app.request('/api/sponsored-logs?mode=other');
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('preserves failureReason verbatim for success+post-submit-failure rows', async () => {
      // Lock for the UI invariant: post-submit accounting failures
      // (`SPONSOR_EXEC_GAS_USED_MISSING`, `PROMOTION_LEDGER_CONSUME_FAILED`)
      // keep `outcome === 'success'` per handler contract. The API response
      // MUST emit `failureReason` so app-admin can render it inline; if
      // the API silently dropped it, operators would see "success" alone.
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
          outcome: 'success',
          receiptId: 'r-gas-missing',
          digest: 'digest-gas-missing',
          senderAddress: '0xsender',
          sponsorAddress: '0xsponsor',
          executionPathKey: 'generic:path',
          orderIdHash: 'order-hash-gas-missing',
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
          failureReason: 'SPONSOR_EXEC_GAS_USED_MISSING',
        },
        {
          createdAt: '2026-04-26T16:00:01Z',
          mode: 'promotion',
          outcome: 'success',
          receiptId: 'r-ledger',
          digest: 'digest-ledger',
          senderAddress: '0xsender',
          sponsorAddress: '0xsponsor',
          executionPathKey: 'promotion:path',
          orderIdHash: null,
          promotionId: 'promotion-1',
          userId: 'user-1',
          economicsStatus: 'known',
          recoveredGasMist: '0',
          hostPaidGasMist: '12345',
          hostFeeMist: '0',
          protocolFeeMist: '0',
          hostNetMist: '-12345',
          grossGasMist: '12345',
          storageRebateMist: '0',
          failureReason: 'PROMOTION_LEDGER_CONSUME_FAILED: budget_unavailable',
        },
      ]);

      const res = await app.request('/api/sponsored-logs');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(2);
      expect(body.entries[0].outcome).toBe('success');
      expect(body.entries[0].failureReason).toBe('SPONSOR_EXEC_GAS_USED_MISSING');
      expect(body.entries[1].outcome).toBe('success');
      expect(body.entries[1].failureReason).toBe(
        'PROMOTION_LEDGER_CONSUME_FAILED: budget_unavailable',
      );

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
      const res = await app.request('/api/sponsor-refill-account/withdraw');
      expect(res.status).toBe(404);
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('returns 200 with nonce and expiresAt', async () => {
      const res = await app.request('/api/sponsor-refill-account/withdrawal-challenge', {
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

      const res = await app.request('/api/sponsor-refill-account/withdrawal-challenge', {
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
      const res = await app.request('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountMist: '100' }),
      });
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('returns 400 on invalid amountMist format', async () => {
      const res = await app.request('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validWithdrawBody, amountMist: '-100' }),
      });
      await expectHostError(res, 'BAD_REQUEST');
    });

    it('returns 400 on amountMist = "0"', async () => {
      const res = await app.request('/api/sponsor-refill-account/withdraw', {
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
      const res = await app.request('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWithdrawBody),
      });
      await expectHostError(res, 'WITHDRAWAL_NONCE_MISSING');
    });

    it('returns 401 on bad signature', async () => {
      mockVerifySignedMessage.mockResolvedValueOnce(false);

      const res = await app.request('/api/sponsor-refill-account/withdraw', {
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

      const res = await app.request('/api/sponsor-refill-account/withdraw', {
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

      const res = await app.request('/api/sponsor-refill-account/withdraw', {
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

      const res = await app.request('/api/sponsor-refill-account/withdraw', {
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

      const res = await app.request('/api/sponsor-refill-account/withdraw', {
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

      const res = await app.request('/api/sponsor-refill-account/withdraw', {
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
      const res = await app.request('/api/sponsor-refill-account/withdraw', {
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

      const res = await app.request('/api/sponsor-refill-account/withdraw', {
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
      const mainnetRoutes = createAdminRoutes(
        mountedContextPromise,
        createAdminRuntime({ network: 'mainnet' }),
      );
      const mainnetApp = new Hono();
      mainnetApp.route('/api', mainnetRoutes);

      const res = await mainnetApp.request('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWithdrawBody),
      });

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

      const res = await app.request('/api/sponsor-refill-account/withdraw', {
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
      const res = await app.request('/api/sponsor-refill-account/withdraw', {
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
      const res = await app.request('/api/sponsor-refill-account/withdraw', {
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
      const res = await app.request('/api/settlement-swap-paths');
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

      const res = await app.request('/api/settlement-swap-paths');
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
      const res = await app.request('/api/settlement-swap-paths');
      expect(res.status).toBe(500);
    });
  });

  // ── Promotion CRUD routes ───────────────────────────────────────────

  describe('promotion CRUD routes', () => {
    it('GET /api/promotions returns 503 when studio disabled', async () => {
      // promotionStore is null by default (studio disabled)
      const res = await app.request('/api/promotions');
      await expectHostError(res, 'ADMIN_UNAVAILABLE');
    });

    it('POST /api/promotions returns 503 when studio disabled', async () => {
      mockReadJsonBodyWithLimit.mockResolvedValueOnce({
        type: 'gas_sponsorship',
        displayName: 'Test',
      });
      const res = await app.request('/api/promotions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await expectHostError(res, 'ADMIN_UNAVAILABLE');
    });

    it('POST /api/promotions returns 400 before body parsing when client IP cannot be resolved', async () => {
      mockResolveClientIp.mockImplementationOnce(() => {
        throw clientIpResolutionError();
      });

      const res = await app.request('/api/promotions', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      await expectHostError(res, 'CLIENT_IP_UNRESOLVED');
      expect(mockReadJsonBodyWithLimit).not.toHaveBeenCalled();
      expect(mockRedis.lpush).not.toHaveBeenCalled();
    });

    describe('with promotionStore enabled', () => {
      // Use real MemoryPromotionStore + MemoryPromotionExecutionLedger to prove end-to-end contract
      beforeEach(async () => {
        const { MemoryPromotionStore, MemoryPromotionExecutionLedger } =
          await import('@stelis/core-api/testing/studio');
        (mockCtx as unknown as Record<string, unknown>).promotionStore = new MemoryPromotionStore();
        (mockCtx as unknown as Record<string, unknown>).executionLedger =
          new MemoryPromotionExecutionLedger();
        // Reset body parser mock to clear stale once-queue state, then
        // restore default implementation that reads actual request body.
        mockReadJsonBodyWithLimit.mockReset();
        mockReadJsonBodyWithLimit.mockImplementation(async (req: Request) => {
          const text = await req.text();
          return JSON.parse(text);
        });
      });

      it('GET /api/promotions returns empty list', async () => {
        const res = await app.request('/api/promotions');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { promotions: unknown[]; nextCursor: string | null };
        expect(body.promotions).toEqual([]);
        expect(body.nextCursor).toBeNull();
      });

      it('GET /api/promotions forwards the shared page params and optional status', async () => {
        const cursor = '00000000-0000-4000-8000-000000000001';
        const listPage = vi.spyOn(mockCtx.promotionStore!, 'listPage');

        const res = await app.request(`/api/promotions?cursor=${cursor}&limit=7&status=active`);

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
        const res = await app.request(url);

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

        const firstRes = await app.request('/api/promotions?limit=1');
        expect(firstRes.status).toBe(200);
        const first = (await firstRes.json()) as {
          promotions: Array<{ promotionId: string }>;
          nextCursor: string | null;
        };
        expect(first.promotions).toHaveLength(1);
        expect(first.nextCursor).toBe(first.promotions[0].promotionId);

        const secondRes = await app.request(`/api/promotions?limit=1&cursor=${first.nextCursor}`);
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
              perUserGasAllowanceMist: Number.MAX_SAFE_INTEGER.toString(),
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

        const res = await app.request('/api/promotions');
        await expectHostError(res, 'INTERNAL_ERROR');
      });

      it('POST /api/promotions creates a gas_sponsorship promotion', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Test Promo',
          maxParticipants: 100,
          perUserGasAllowanceMist: '1000000',
        });

        const res = await app.request('/api/promotions', {
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

        const res = await app.request('/api/promotions', {
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

        const res = await app.request('/api/promotions', {
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

          const res = await app.request('/api/promotions', {
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

        const res = await app.request('/api/promotions/any', {
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

        const res = await app.request('/api/promotions/any/status', {
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

        const res = await app.request('/api/promotions', {
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
        const res = await app.request('/api/promotions', {
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
        const res = await app.request('/api/promotions', {
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
        const res = await app.request('/api/promotions', {
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
        const res = await app.request('/api/promotions', {
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
        const res = await app.request('/api/promotions', {
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
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        // Unsafe-integer update is rejected at the HTTP body boundary before the
        // store's freeze gate — parse guard supersedes field-class logic.
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          maxParticipants: Number.MAX_SAFE_INTEGER + 2,
        });
        const res = await app.request(`/api/promotions/${created.promotion.promotionId}`, {
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
        const res = await app.request('/api/promotions', {
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
        const res = await app.request('/api/promotions', {
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
          perUserGasAllowanceMist: (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(),
        });
        const res = await app.request('/api/promotions', {
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
          // 1M × 9_007_199_254_740 ≈ 9.0 × 10^18 > MAX_SAFE_INTEGER
          perUserGasAllowanceMist: '9007199254740',
        });
        const res = await app.request('/api/promotions', {
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
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        expect(createRes.status).toBe(201);
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          perUserGasAllowanceMist: (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(),
        });
        const updateRes = await app.request(`/api/promotions/${created.promotion.promotionId}`, {
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
        const res = await app.request('/api/promotions', {
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

        const res = await app.request('/api/promotions', {
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

        const res = await app.request('/api/promotions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'BAD_REQUEST');
      });

      it('GET /api/promotions/:id returns 404 for non-existent', async () => {
        const res = await app.request('/api/promotions/nonexistent');
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
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        const res = await app.request(`/api/promotions/${created.promotion.promotionId}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { promotion: { displayName: string } };
        expect(body.promotion.displayName).toBe('Fetch Me');
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
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        // Update
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          displayName: 'Updated',
          maxParticipants: 50,
        });
        const res = await app.request(`/api/promotions/${created.promotion.promotionId}`, {
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
        const res = await app.request('/api/promotions/nope', {
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
        const res = await app.request('/api/promotions', {
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
        const createRes = await app.request('/api/promotions', {
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
        const listRes = await app.request('/api/promotions');
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
        const createRes = await app.request('/api/promotions', {
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
        const updateRes = await app.request(`/api/promotions/${created.promotion.promotionId}`, {
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
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        // Transition
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'active' });
        const res = await app.request(`/api/promotions/${created.promotion.promotionId}/status`, {
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
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        // draft → archived (invalid)
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'archived' });
        const res = await app.request(`/api/promotions/${created.promotion.promotionId}/status`, {
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
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        expect(createRes.status).toBe(201);
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'active' });
        const actRes = await app.request(
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
        const res = await app.request(`/api/promotions/${created.promotion.promotionId}`, {
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
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'active' });
        await app.request(`/api/promotions/${created.promotion.promotionId}/status`, {
          method: 'POST',
          body: JSON.stringify({}),
        });

        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ displayName: 'Renamed' });
        const res = await app.request(`/api/promotions/${created.promotion.promotionId}`, {
          method: 'PUT',
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { promotion: { displayName: string } };
        expect(body.promotion.displayName).toBe('Renamed');
      });

      it('POST /api/promotions/:id/status returns 404 for non-existent', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'active' });
        const res = await app.request('/api/promotions/nope/status', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await expectHostError(res, 'ADMIN_NOT_FOUND');
      });

      it('POST /api/promotions/:id/status returns 400 for invalid status value', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'bogus' });
        const res = await app.request('/api/promotions/any/status', {
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

        const res = await app.request('/api/promotions/any/status', {
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
          path: '/api/promotions/conflict',
          body: { displayName: 'Conflict' },
        },
        {
          label: 'status',
          storeMethod: 'transitionStatus',
          method: 'POST',
          path: '/api/promotions/conflict/status',
          body: { status: 'active' },
        },
        {
          label: 'delete',
          storeMethod: 'delete',
          method: 'DELETE',
          path: '/api/promotions/conflict',
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

        const res = await app.request(testCase.path, {
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
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        const res = await app.request(`/api/promotions/${created.promotion.promotionId}`, {
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
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'active' });
        await app.request(`/api/promotions/${created.promotion.promotionId}/status`, {
          method: 'POST',
          body: JSON.stringify({}),
        });

        const res = await app.request(`/api/promotions/${created.promotion.promotionId}`, {
          method: 'DELETE',
        });
        await expectHostError(res, 'ADMIN_CONFLICT');
      });

      it('DELETE /api/promotions/:id returns 404 for non-existent', async () => {
        const res = await app.request('/api/promotions/nope', {
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
        await app.request('/api/promotions', { method: 'POST', body: JSON.stringify({}) });

        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Active One',
          maxParticipants: 100,
          perUserGasAllowanceMist: '10000000',
        });
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'active' });
        await app.request(`/api/promotions/${created.promotion.promotionId}/status`, {
          method: 'POST',
          body: JSON.stringify({}),
        });

        // Filter
        const res = await app.request('/api/promotions?status=active');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { promotions: Array<{ displayName: string }> };
        expect(body.promotions).toHaveLength(1);
        expect(body.promotions[0].displayName).toBe('Active One');
      });
      // ── admin claimed-user list ──────────────────────────────────
      it('GET /api/promotions/:id/users returns 503 when executionLedger not available', async () => {
        // Temporarily remove executionLedger to simulate generic-only mode
        (mockCtx as unknown as Record<string, unknown>).executionLedger = null;
        const res = await app.request('/api/promotions/some-id/users');
        expect(res.status).toBe(503);
      });

      it('GET /api/promotions/:id/users returns 404 for non-existent promotion', async () => {
        const res = await app.request('/api/promotions/nonexistent/users');
        expect(res.status).toBe(404);
      });

      it('GET /api/promotions/:id/users returns empty user list for new promotion', async () => {
        // Create promo
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Users Test',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
        });
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        const res = await app.request(`/api/promotions/${created.promotion.promotionId}/users`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { users: unknown[]; total: number };
        expect(body.users).toEqual([]);
        expect(body.total).toBe(0);
        expect(parseAdminPromotionUsersResponse(body)).toEqual(body);
      });

      // Cross-route: claim → admin users
      it('GET /api/promotions/:id/users reflects claimed users after ExecutionLedger.claim()', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'ClaimedUsers Test',
          maxParticipants: 10,
          perUserGasAllowanceMist: '5000000',
        });
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };
        const promoId = created.promotion.promotionId;

        // Claim via ExecutionLedger (simulates POST /studio/promotions/:id/claim)
        const ledger = (
          mockCtx as unknown as {
            executionLedger: import('@stelis/core-api/studio').PromotionExecutionLedger;
          }
        ).executionLedger;
        await ledger.claim(promoId, 'user-alpha', {
          maxParticipants: 10,
          perUserGasAllowanceMist: '5000000',
          useUntilAt: null,
        });
        await ledger.claim(promoId, 'user-beta', {
          maxParticipants: 10,
          perUserGasAllowanceMist: '5000000',
          useUntilAt: null,
        });

        // Admin users response should reflect both claims immediately
        const res = await app.request(`/api/promotions/${promoId}/users`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          users: {
            userId: string;
            remainingGasAllowanceMist: string | null;
            status: string | null;
          }[];
          total: number;
        };
        expect(body.total).toBe(2);
        const userIds = body.users.map((u) => u.userId).sort();
        expect(userIds).toEqual(['user-alpha', 'user-beta']);
        expect(body.users[0].remainingGasAllowanceMist).toBe('5000000');
        expect(body.users[0].status).toBe('active');
      });

      // Cross-route: claim → admin summary
      it('GET /api/promotions/:id/summary reflects claimed count + budget after claim', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Summary ClaimCount Test',
          maxParticipants: 10,
          perUserGasAllowanceMist: '5000000',
        });
        const createRes = await app.request('/api/promotions', {
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
        await ledger.claim(promoId, 'user-1', {
          maxParticipants: 10,
          perUserGasAllowanceMist: '5000000',
          useUntilAt: null,
        });

        const res = await app.request(`/api/promotions/${promoId}/summary`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          summary: {
            claimedUsers: number;
            totalRemainingBudgetMist: string;
          };
        };
        expect(body.summary.claimedUsers).toBe(1);
        // total = 10 * 5M = 50M, no reserves yet → available = 50M
        expect(body.summary.totalRemainingBudgetMist).toBe('50000000');
      });

      // ── admin summary endpoint ───────────────────────────────────
      it('GET /api/promotions/:id/summary returns 503 when executionLedger not available', async () => {
        // Create a promotion so we get past the 404 check
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Summary 503 Test',
          maxParticipants: 10,
          perUserGasAllowanceMist: '1000000',
        });
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        // Temporarily remove executionLedger → computeAdminSummary returns null → 503
        (mockCtx as unknown as Record<string, unknown>).executionLedger = null;
        const res = await app.request(`/api/promotions/${created.promotion.promotionId}/summary`);
        expect(res.status).toBe(503);
      });

      it('GET /api/promotions/:id/summary returns 404 for non-existent promotion', async () => {
        const res = await app.request('/api/promotions/nonexistent/summary');
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
        const createRes = await app.request('/api/promotions', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const created = (await createRes.json()) as { promotion: { promotionId: string } };

        const res = await app.request(`/api/promotions/${created.promotion.promotionId}/summary`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          promotionId: string;
          summary: {
            claimedUsers: number;
            totalRequiredBudgetMist: string;
            totalRemainingBudgetMist: string;
          };
        };
        expect(body.promotionId).toBe(created.promotion.promotionId);
        expect(body.summary.claimedUsers).toBe(0);
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
      const res = await app.request('/api/sponsor-operations');
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
      const res = await app.request('/api/sponsor-operations');
      expect(res.status).toBe(200);
      const body = await res.json();

      // rpcFleet must exist even for single plain URL
      expect(body.rpcFleet).toBeDefined();
      expect(body.rpcFleet.totalEndpoints).toBeGreaterThanOrEqual(1);
      expect(typeof body.rpcFleet.healthyEndpoints).toBe('number');
      expect(Array.isArray(body.rpcFleet.endpoints)).toBe(true);

      // Each endpoint has safe fields only
      for (const ep of body.rpcFleet.endpoints) {
        expect(typeof ep.url).toBe('string');
        expect(['primary', 'secondary']).toContain(ep.role);
        expect(['healthy', 'cooldown']).toContain(ep.status);
        expect(typeof ep.cooldownRemainingMs).toBe('number');

        // Must NOT contain secret fields
        expect(ep.meta).toBeUndefined();
        expect(ep.auth).toBeUndefined();
        expect(ep.token).toBeUndefined();
        expect(ep.secret).toBeUndefined();
        expect(ep.fetchInit).toBeUndefined();
      }
    });

    it('awaits probeSponsorRefillAccount before serialising /api/sponsor-operations', async () => {
      // Admin `/api/sponsor-operations` runs a bounded sponsor-refill-account probe before the
      // shared-state read so the returned payload is "fresh at return
      // time" rather than stale-then-next-read.
      const res = await app.request('/api/sponsor-operations');
      expect(res.status).toBe(200);
      expect(mockCtx.sponsorOperations.probeSponsorRefillAccount).toHaveBeenCalledWith();
    });

    it('fails closed when the awaited sponsor-refill-account update cannot be committed', async () => {
      (
        mockCtx.sponsorOperations.probeSponsorRefillAccount as ReturnType<typeof vi.fn>
      ).mockRejectedValueOnce(new Error('redis sponsor refill account write failed'));

      const res = await app.request('/api/sponsor-operations');

      await expectHostError(res, 'INTERNAL_ERROR');
    });

    it('serialises the shared-state sponsor operations payload (no null/stale/generation)', async () => {
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
        slots: [
          {
            address: '0xSLOT1',
            state: 'healthy',
            balanceMist: '5000000000',
            lastError: null,
            lastObservedAtMs: observedAtMs,
            writeSeq: 3,
          },
          {
            address: '0xSLOT2',
            state: 'low_balance',
            balanceMist: '100000000',
            lastError: null,
            lastObservedAtMs: observedAtMs,
            writeSeq: 3,
          },
        ],
        sponsorRefillAccount: {
          balanceMist: '10000000000',
          healthy: true,
          refillsRemaining: 1,
          lastError: null,
          lastObservedAtMs: observedAtMs,
          writeSeq: 3,
        },
      });

      const res = await app.request('/api/sponsor-operations');
      expect(res.status).toBe(200);
      const body = await res.json();

      // Document-level snapshot header fields are not part of sponsorOperations.
      expect(body.sponsorOperations.generation).toBeUndefined();
      expect(body.sponsorOperations.publishedAtMs).toBeUndefined();
      expect(body.sponsorOperations.staleAfterMs).toBeUndefined();
      expect(body.sponsorOperations.stale).toBeUndefined();

      // Aggregates derived from the state view.
      expect(body.sponsorOperations).toMatchObject({
        gateErrorCode: null,
        availableSlots: 1,
        degradedSlots: 1,
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
        state: 'healthy',
        balanceMist: '5000000000',
        lastObservedAtMs: observedAtMs,
        lastError: null,
      });
      expect(body.sponsorOperations.sponsorRefillAccount).toEqual({
        address: mockCtx.sponsorOperations.sponsorRefillAccountAddress,
        balanceMist: '10000000000',
        healthy: true,
        refillsRemaining: 1,
        lastObservedAtMs: observedAtMs,
        lastError: null,
      });
    });

    it('omits top-level /api/sponsor-operations flat fields (data lives under `sponsorOperations`)', async () => {
      const res = await app.request('/api/sponsor-operations');
      expect(res.status).toBe(200);
      const body = await res.json();

      // Top-level flat fields are intentionally absent; the same data is exposed under `sponsorOperations`.
      expect(body.autoPause).toBeUndefined();
      expect(body.slots).toBeUndefined();
      expect(body.poolSize).toBeUndefined();
      expect(body.sponsorRefillAccountAddress).toBeUndefined();
      expect(body.sponsorRefillAccountBalance).toBeUndefined();
      expect(body.sponsorRefillAccountRefillsRemaining).toBeUndefined();
      // Settlement payout recipient balance is not part of the response contract.
      expect(body.settlementPayoutRecipientBalance).toBeUndefined();
    });

    it('returns boot-derived configuration fields and the cached feeConfig', async () => {
      const res = await app.request('/api/sponsor-operations');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.network).toBe('testnet');
      expect(body.primaryAddress).toBe('0xslot');
      expect(body.settlementPayoutRecipientAddress).toBe('0xRECIPIENT');
      expect(body.sponsorBalanceWarnMist).toBe('5000000000');
      expect(body.sponsorBalanceRefillTargetMist).toBe('10000000000');
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
      expect(typeof body.studioEnabled).toBe('boolean');
    });
  });
});
