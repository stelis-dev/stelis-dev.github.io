/**
 * Admin route contract tests — verifies HTTP contracts.
 *
 * Tests use Hono's app.request() with mocked dependencies.
 * All admin routes require requireAdminSession — middleware tested here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { buildSponsorRefillAccountWithdrawMessage } from '@stelis/contracts';

// ── Hoisted mocks ───────────────────────────────────────────────────────
const {
  mockRedis,
  mockRequireAdminSession,
  mockGetRedisForAdmin,
  mockPushAdminOperationLog,
  mockCheckAndIncrementAdminOperationAttempt,
  mockVerifySignedMessage,
  mockParseSponsorKey,
  mockReadJsonBodyWithLimit,
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
    hincrby: vi.fn(),
    hgetall: vi.fn(),
    hset: vi.fn(),
    sadd: vi.fn(),
    smembers: vi.fn(),
    srem: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
  },
  mockRequireAdminSession: vi.fn(),
  mockGetRedisForAdmin: vi.fn(),
  mockPushAdminOperationLog: vi.fn(),
  mockCheckAndIncrementAdminOperationAttempt: vi.fn(),
  mockVerifySignedMessage: vi.fn(),
  mockParseSponsorKey: vi.fn(),
  mockReadJsonBodyWithLimit: vi.fn(),
}));

vi.mock('@stelis/core-api/admin', () => ({
  getRedisForAdmin: mockGetRedisForAdmin,
  pushAdminOperationLog: mockPushAdminOperationLog,
  checkAndIncrementAdminOperationAttempt: mockCheckAndIncrementAdminOperationAttempt,
  verifySignedMessage: mockVerifySignedMessage,
}));

vi.mock('../src/requireAdminSession.js', () => ({
  requireAdminSession: mockRequireAdminSession,
}));

vi.mock('../src/clientIp.js', () => ({
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('../src/env.js', () => ({
  requireEnv: vi.fn().mockImplementation((key: string) => {
    const vals: Record<string, string> = {
      REDIS_URL: 'redis://localhost:6379',
      ADMIN_ADDRESS: '0x' + 'a'.repeat(64),
      SPONSOR_REFILL_ACCOUNT_SECRET_KEY: 'test-sponsor-refill-account-secret-key',
    };
    if (vals[key]) return vals[key];
    throw new Error(`Missing: ${key}`);
  }),
  parseOptionalBooleanEnv: vi.fn().mockReturnValue(false),
  parseOptionalPositiveBigIntEnv: vi
    .fn()
    .mockImplementation((_key: string, raw: string | undefined) =>
      raw == null || raw.trim() === '' ? undefined : BigInt(raw),
    ),
}));

vi.mock('@stelis/core-api', async () => {
  const actual = await vi.importActual('@stelis/core-api');
  return {
    ...actual,
    parseSponsorKey: mockParseSponsorKey,
    readJsonBodyWithLimit: mockReadJsonBodyWithLimit,
  };
});

// ── Mock @mysten/sui/transactions ─────────────────────────────────────
vi.mock('@mysten/sui/transactions', () => {
  const MockTransaction = vi.fn(function Transaction() {
    return {
      gas: 'mock-gas',
      setSender: vi.fn(),
      transferObjects: vi.fn(),
      splitCoins: vi.fn().mockReturnValue(['mock-coin']),
      pure: { u64: vi.fn().mockReturnValue('mock-u64') },
      build: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    };
  });
  return { Transaction: MockTransaction };
});

import { createAdminRoutes } from '../src/routes/admin.js';
import type { AppApiContext } from '../src/context.js';

function createMockCtx(): AppApiContext {
  return {
    relay: {
      network: 'testnet',
      packageId: '0xPKG',
      settlementPayoutRecipientAddress: '0xRECIPIENT',
      sponsorPool: {
        addresses: () => ['0xSPONSOR1'],
        size: 1,
        primaryAddress: '0xSPONSOR1',
        leaseStatus: vi.fn().mockResolvedValue({
          leasedSlots: 0,
          freeSlots: 1,
          slots: [{ address: '0xSPONSOR1', leased: false }],
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
      supportedSettlementSwapPaths: [
        {
          paymentTokenType: '0xdeeb::deep::DEEP',
          paymentTokenSymbol: 'DEEP',
          paymentTokenDecimals: 6,
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
    studioGlobalTargetHashes: null,
    developerJwtTrustConfig: null,
    developerJwtVerifyUrl: null,
    failoverTransport: {
      getAdminSnapshot: vi.fn().mockReturnValue({
        endpoints: [
          {
            url: 'https://fullnode.testnet.sui.io:443',
            role: 'primary',
            status: 'healthy',
            cooldownRemainingMs: 0,
          },
        ],
        totalEndpoints: 1,
        healthyEndpoints: 1,
      }),
    },
    rpcEndpointUrls: ['https://fullnode.testnet.sui.io:443'],
    redis: {} as never,
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
  mockRedis.hincrby.mockResolvedValue(1);
  mockRedis.hgetall.mockResolvedValue({});
  mockRedis.hset.mockResolvedValue(1);
  mockRedis.sadd.mockResolvedValue(1);
  mockRedis.smembers.mockResolvedValue([]);
  mockRedis.srem.mockResolvedValue(1);
  mockRedis.incr.mockResolvedValue(1);
  mockRedis.expire.mockResolvedValue(true);

  // Admin module defaults
  mockGetRedisForAdmin.mockResolvedValue(mockRedis);
  mockPushAdminOperationLog.mockResolvedValue(undefined);
  mockCheckAndIncrementAdminOperationAttempt.mockResolvedValue({
    allowed: true,
    current: 1,
    retryAfterMs: 0,
  });
  mockVerifySignedMessage.mockResolvedValue(true);

  // Session
  mockRequireAdminSession.mockResolvedValue({
    address: '0xADMIN',
    iat: 1000,
    exp: 2000,
    iatMs: 1000000,
  });

  // core-api
  mockParseSponsorKey.mockReturnValue({
    toSuiAddress: () => '0xSPONSOR_REFILL_ACCOUNT_ADDRESS',
  });
  mockReadJsonBodyWithLimit.mockImplementation(async (req: Request) => {
    const text = await req.text();
    return JSON.parse(text);
  });
}

describe('admin routes', () => {
  let app: Hono;
  let mockCtx: AppApiContext;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDefaults();
    mockCtx = createMockCtx();
    const getCtx = async () => mockCtx;
    const routes = createAdminRoutes(getCtx);
    app = new Hono();
    app.route('/api', routes);
  });

  describe('auth guard middleware', () => {
    it('returns 401 when requireAdminSession returns null', async () => {
      mockRequireAdminSession.mockResolvedValueOnce(null);
      const res = await app.request('/api/blocklist');
      expect(res.status).toBe(401);
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
      expect(res.status).toBe(400);
    });

    it('returns 403 on unauthorized key prefix', async () => {
      const res = await app.request('/api/blocklist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'random:key' }),
      });
      expect(res.status).toBe(403);
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
      mockRedis.lrange.mockResolvedValueOnce(['log1', 'log2']);
      const res = await app.request('/api/logs');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.logs).toEqual(['log1', 'log2']);
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
      expect(res.status).toBe(400);
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
          schemaVersion: 1,
          createdAt: '2026-04-26T16:00:00Z',
          mode: 'generic',
          outcome: 'success',
          receiptId: 'r1',
          economicsStatus: 'known',
          hostFeeMist: '1000',
          protocolFeeMist: '50',
          hostNetMist: '4000',
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
      expect(res.status).toBe(400);
    });

    it('rejects non-integer limit with 400', async () => {
      const res = await app.request('/api/sponsored-logs?limit=abc');
      expect(res.status).toBe(400);
    });

    it('rejects invalid mode with 400', async () => {
      const res = await app.request('/api/sponsored-logs?mode=other');
      expect(res.status).toBe(400);
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
          schemaVersion: 1,
          createdAt: '2026-04-26T16:00:00Z',
          mode: 'generic',
          outcome: 'success',
          receiptId: 'r-gas-missing',
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
          schemaVersion: 1,
          createdAt: '2026-04-26T16:00:01Z',
          mode: 'promotion',
          outcome: 'success',
          receiptId: 'r-ledger',
          economicsStatus: 'known',
          hostFeeMist: '0',
          protocolFeeMist: '0',
          hostNetMist: '-12345',
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

  describe('GET /api/sponsor-refill-account/withdraw (nonce)', () => {
    it('returns 200 with nonce and expiresAt', async () => {
      const res = await app.request('/api/sponsor-refill-account/withdraw');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nonce).toBeDefined();
      expect(typeof body.nonce).toBe('string');
      expect(body.expiresAt).toBeDefined();
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
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('required');
    });

    it('returns 400 on invalid amountMist format', async () => {
      const res = await app.request('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validWithdrawBody, amountMist: '-100' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('amountMist');
    });

    it('returns 400 on amountMist = "0"', async () => {
      const res = await app.request('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validWithdrawBody, amountMist: '0' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 401 on expired/invalid nonce', async () => {
      // DEL returns 0 → nonce not found (expired or already consumed)
      mockRedis.del.mockResolvedValueOnce(0);
      const res = await app.request('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWithdrawBody),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('nonce');
    });

    it('returns 401 on bad signature', async () => {
      // nonce consumed by DEL (default mock returns 1)
      mockVerifySignedMessage.mockResolvedValueOnce(false);

      const res = await app.request('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWithdrawBody),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('signature');
      expect(mockVerifySignedMessage).toHaveBeenCalledWith({
        message: buildSponsorRefillAccountWithdrawMessage(
          validWithdrawBody.amountMist,
          validWithdrawBody.nonce,
        ),
        signature: validWithdrawBody.signature,
        adminAddress: '0x' + 'a'.repeat(64),
      });
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
      expect(res.status).toBe(429);
      await expect(res.json()).resolves.toEqual({
        error: 'Too many withdrawal attempts. Try again in 15 minutes.',
      });
    });

    it('returns 422 when dry-run simulation fails', async () => {
      // nonce consumed by DEL (default mock returns 1)
      // simulateTransaction returns failure status
      (mockCtx.relay as unknown as Record<string, unknown>).sui = {
        ...mockCtx.relay.sui,
        getBalance: vi.fn().mockResolvedValue({ balance: { balance: '1000000000' } }),
        simulateTransaction: vi.fn().mockResolvedValue({
          Transaction: {
            status: { success: false, error: 'InsufficientGas' },
          },
        }),
      };

      const res = await app.request('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWithdrawBody),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toContain('Dry-run failed');
      expect(body.error).toContain('InsufficientGas');
    });

    it('returns 200 on successful withdrawal', async () => {
      // nonce consumed by DEL (default mock returns 1)
      // simulateTransaction returns success, signAndExecute returns digest
      (mockCtx.relay as unknown as Record<string, unknown>).sui = {
        ...mockCtx.relay.sui,
        getBalance: vi.fn().mockResolvedValue({ balance: { balance: '500000000' } }),
        simulateTransaction: vi.fn().mockResolvedValue({
          Transaction: {
            status: { success: true },
          },
        }),
      };
      mockParseSponsorKey.mockReturnValue({
        toSuiAddress: () => '0xSPONSOR_REFILL_ACCOUNT_ADDRESS',
        signAndExecuteTransaction: vi.fn().mockResolvedValue({
          Transaction: { digest: '0xSUCCESS_DIGEST' },
        }),
      });

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
      expect(body.remainingBalanceMist).toBeDefined();
      expect(mockCtx.sponsorOperations.probeSponsorRefillAccount).toHaveBeenCalledWith(
        'admin_withdraw',
      );
    });

    it('returns 400 when runway guard blocks withdrawal (refill enabled)', async () => {
      // nonce consumed by DEL (default mock returns 1)
      const { parseOptionalBooleanEnv } = await import('../src/env.js');
      vi.mocked(parseOptionalBooleanEnv).mockReturnValueOnce(true); // refillEnabled = true
      process.env.SPONSOR_BALANCE_REFILL_TARGET_MIST = '900000000'; // 0.9 SUI

      const res = await app.request('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validWithdrawBody,
          amountMist: '990000000',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('runway');

      delete process.env.SPONSOR_BALANCE_REFILL_TARGET_MIST;
    });
  });

  describe('GET /api/settlement-swap-paths', () => {
    it('returns 200 with settlement swap path registry data', async () => {
      const res = await app.request('/api/settlement-swap-paths');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBeDefined();
      expect(Array.isArray(body.settlementSwapPaths)).toBe(true);
    });

    it('returns settlement swap path fields from prepareConfig', async () => {
      // Override mock to have a real settlement swap path entry.
      const SUI_TYPE =
        '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
      const DEEP_TYPE = '0xdeeb::deep::DEEP';
      (mockCtx.prepareConfig as unknown as Record<string, unknown>).supportedSettlementSwapPaths = [
        {
          paymentTokenType: DEEP_TYPE,
          paymentTokenSymbol: 'DEEP',
          paymentTokenDecimals: 6,
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
      expect(body.settlementSwapPaths[0].paymentTokenSymbol).toBe('DEEP');
      expect(body.settlementSwapPaths[0].hopCount).toBe(1);
      expect(body.settlementSwapPaths[0].hops[0].swapDirection).toBe('baseForQuote');
    });

    it('returns 500 when pool metadata exceeds safe integer range (fail-closed)', async () => {
      (mockCtx.prepareConfig as unknown as Record<string, unknown>).supportedSettlementSwapPaths = [
        {
          paymentTokenType: '0xTOKEN',
          paymentTokenSymbol: 'TOKEN',
          paymentTokenDecimals: 6,
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
      expect(res.status).toBe(503);
    });

    it('POST /api/promotions returns 503 when studio disabled', async () => {
      mockReadJsonBodyWithLimit.mockResolvedValueOnce({
        type: 'gas_sponsorship',
        displayName: 'Test',
        allowedTargets: ['0xPKG::mod::fn'],
      });
      const res = await app.request('/api/promotions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(503);
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
        const body = (await res.json()) as { promotions: unknown[] };
        expect(body.promotions).toEqual([]);
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

      it('POST /api/promotions success emits a PROMOTION_CREATE ops-log entry', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Audited Promo',
          maxParticipants: 42,
          perUserGasAllowanceMist: '2500000',
        });
        mockPushAdminOperationLog.mockClear();

        const res = await app.request('/api/promotions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as {
          promotion: { promotionId: string; maxParticipants: number };
        };

        const createCalls = mockPushAdminOperationLog.mock.calls.filter(
          (call) => (call[1] as { event?: string }).event === 'PROMOTION_CREATE',
        );
        expect(createCalls.length).toBe(1);
        const entry = createCalls[0]![1] as {
          event: string;
          ts: string;
          ip: string;
          detail: string;
        };
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
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('maxParticipants');
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
        expect(res.status).toBe(400);
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
        expect(res.status).toBe(400);
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
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('maxParticipants');
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
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('postClaimUseWindowMs');
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
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('maxParticipants');
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
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('perUserGasAllowanceMist');
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
        expect(res.status).toBe(400);
      });

      it('POST /api/promotions rejects perUserGasAllowanceMist > MAX_PROMOTION_LEDGER_VALUE_MIST (Number.MAX_SAFE_INTEGER) with 400', async () => {
        // Boundary: a `perUserGasAllowanceMist` above
        // `Number.MAX_SAFE_INTEGER` would land in Redis budget keys
        // and break Lua int64 arithmetic on consume/release. Reject
        // at the API boundary with 400 + the operator-readable bound
        // in the error message.
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
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('perUserGasAllowanceMist');
        expect(body.error).toContain(BigInt(Number.MAX_SAFE_INTEGER).toString());
      });

      it('POST /api/promotions accepts a draft whose per-user fits but maxParticipants × perUser overflows the bound (201) — product check is deferred to activation, not the API boundary', async () => {
        // Per-user fits the bound, but `maxParticipants ×
        // perUserGasAllowanceMist` overflows it. The API-boundary
        // fail-fast can only see the per-user value — the product
        // check belongs to `validateActivationPrerequisites` and is
        // exercised by the dedicated activation-gate test
        // (`POST /api/promotions/:id/status rejects activation when
        // maxParticipants × perUserGasAllowanceMist exceeds
        // MAX_PROMOTION_LEDGER_VALUE_MIST`).
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
        expect(res.status).toBe(201);
      });

      it('PUT /api/promotions/:id rejects perUserGasAllowanceMist > MAX_PROMOTION_LEDGER_VALUE_MIST on a draft update (400)', async () => {
        // Edit-time fail-fast parity with POST. `parseOptionalPositiveBigintString`
        // calls the same `assertPerUserAllowanceWithinBound` helper at
        // `admin.ts:880-885`, so a draft update that tries to push
        // `perUserGasAllowanceMist` above the bound must reject at 400
        // with the bound value in the response body before the value
        // ever reaches the promotion store.
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
        expect(updateRes.status).toBe(400);
        const body = (await updateRes.json()) as { error: string };
        expect(body.error).toContain('perUserGasAllowanceMist');
        expect(body.error).toContain(BigInt(Number.MAX_SAFE_INTEGER).toString());
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
        expect(res.status).toBe(400);
      });

      it('POST /api/promotions rejects unsupported promotion type', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'unsupported_type',
          displayName: 'Bad',
          allowedTargets: ['0xPKG::mod::fn'],
        });

        const res = await app.request('/api/promotions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('gas_sponsorship');
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
        expect(res.status).toBe(400);
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
        expect(res.status).toBe(404);
      });

      // ── P1-6 route contract: derived budget + temporal fields ──────

      it('POST /api/promotions response includes derived totalRequiredBudgetMist', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Budget Check',
          allowedTargets: ['0xPKG::mod::fn'],
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
          allowedTargets: ['0xPKG::mod::fn'],
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

        // Verify GET returns same values
        const getRes = await app.request(`/api/promotions/${created.promotion.promotionId}`);
        expect(getRes.status).toBe(200);
        const fetched = (await getRes.json()) as {
          promotion: {
            claimDeadlineAt: string | null;
            postClaimUseWindowMs: number;
            totalRequiredBudgetMist: string;
          };
        };
        expect(fetched.promotion.claimDeadlineAt).toBe(deadline);
        expect(fetched.promotion.postClaimUseWindowMs).toBe(windowMs);
        // 50 * 1_000_000 = 50_000_000
        expect(fetched.promotion.totalRequiredBudgetMist).toBe('50000000');
      });

      it('PUT /api/promotions/:id recalculates totalRequiredBudgetMist on budget field change', async () => {
        // Create with known budget inputs
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Recalc',
          allowedTargets: ['0xPKG::mod::fn'],
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
          allowedTargets: ['0xPKG::mod::fn'],
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
        expect(res.status).toBe(409);
      });

      // Route-body validation rejects invalid activation inputs at 400.
      // Store-level activation prerequisites are covered by
      // `packages/core-api/tests/promotionStore.test.ts`.

      it('POST /api/promotions/:id/status rejects activation when maxParticipants × perUserGasAllowanceMist exceeds MAX_PROMOTION_LEDGER_VALUE_MIST (422)', async () => {
        // End-to-end activation gate. Per-user fits the bound (so
        // create succeeds with 201), but the product overflows
        // `Number.MAX_SAFE_INTEGER`, so `transitionStatus → active`
        // calls `validateActivationPrerequisites` which throws
        // `PromotionActivationError`; the route maps it to 422 with
        // the canonical error message that includes the bound value.
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Activation product overflow',
          maxParticipants: 1_000_000,
          perUserGasAllowanceMist: '9007199254740',
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
        expect(actRes.status).toBe(422);
        const body = (await actRes.json()) as { error: string };
        expect(body.error).toContain('total budget');
        expect(body.error).toContain(BigInt(Number.MAX_SAFE_INTEGER).toString());
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
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('maxParticipants');
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
        expect(res.status).toBe(404);
      });

      it('POST /api/promotions/:id/status returns 400 for invalid status value', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({ status: 'bogus' });
        const res = await app.request('/api/promotions/any/status', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
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

      it('DELETE /api/promotions/:id returns 404 for non-draft', async () => {
        // Create and activate
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'Active',
          allowedTargets: ['0xPKG::mod::fn'],
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
        expect(res.status).toBe(404);
      });

      it('DELETE /api/promotions/:id returns 404 for non-existent', async () => {
        const res = await app.request('/api/promotions/nope', {
          method: 'DELETE',
        });
        expect(res.status).toBe(404);
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
      });

      // Cross-route: claim → admin users
      it('GET /api/promotions/:id/users reflects claimed users after ExecutionLedger.claim()', async () => {
        mockReadJsonBodyWithLimit.mockResolvedValueOnce({
          type: 'gas_sponsorship',
          displayName: 'ClaimedUsers Test',
          allowedTargets: ['0xPKG::mod::fn'],
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
          allowedTargets: ['0xPKG::mod::fn'],
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
          allowedTargets: ['0xPKG::mod::fn'],
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
      });
    });
  });

  // ── GET /api/pool — RPC fleet snapshot ────────────────────────────
  describe('GET /api/pool', () => {
    it('returns 500 when pool metadata exceeds safe integer range (fail-closed)', async () => {
      (mockCtx.prepareConfig as unknown as Record<string, unknown>).supportedSettlementSwapPaths = [
        {
          paymentTokenType: '0xTOKEN',
          lotSize: 9007199254740993n,
          minSize: 1n,
        },
      ];
      const res = await app.request('/api/pool');
      expect(res.status).toBe(500);
      // Restore
      (mockCtx.prepareConfig as unknown as Record<string, unknown>).supportedSettlementSwapPaths = [
        {
          paymentTokenType: '0xdeeb::deep::DEEP',
          paymentTokenSymbol: 'DEEP',
          paymentTokenDecimals: 6,
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
      const res = await app.request('/api/pool');
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

    it('awaits probeSponsorRefillAccount before serialising /api/pool', async () => {
      // Admin `/api/pool` runs a bounded sponsor-refill-account probe before the
      // shared-state read so the returned payload is "fresh at return
      // time" rather than stale-then-next-read.
      const res = await app.request('/api/pool');
      expect(res.status).toBe(200);
      expect(mockCtx.sponsorOperations.probeSponsorRefillAccount).toHaveBeenCalledWith(
        'admin_pool',
      );
    });

    it('fails closed when the awaited sponsor-refill-account update cannot be committed', async () => {
      (
        mockCtx.sponsorOperations.probeSponsorRefillAccount as ReturnType<typeof vi.fn>
      ).mockRejectedValueOnce(new Error('redis sponsor refill account write failed'));

      const res = await app.request('/api/pool');

      expect(res.status).toBe(500);
    });

    it('serialises the shared-state sponsor operations payload (no null/stale/generation)', async () => {
      const observedAtMs = 1_700_000_000_000;
      (
        mockCtx.relay.sponsorPool.leaseStatus as unknown as ReturnType<typeof vi.fn>
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

      const res = await app.request('/api/pool');
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

    it('omits top-level /api/pool flat fields (data lives under `sponsorOperations`)', async () => {
      const res = await app.request('/api/pool');
      expect(res.status).toBe(200);
      const body = await res.json();

      // Top-level flat fields are intentionally absent; the same data is exposed under `sponsorOperations`.
      expect(body.autoPause).toBeUndefined();
      expect(body.slots).toBeUndefined();
      expect(body.poolSize).toBeUndefined();
      expect(body.sponsorRefillAccountAddress).toBeUndefined();
      expect(body.sponsorRefillAccountBalance).toBeUndefined();
      expect(body.sponsorRefillAccountRefillsRemaining).toBeUndefined();
      // Relayer-recipient balance is not part of the response contract.
      expect(body.settlementPayoutRecipientBalance).toBeUndefined();
    });

    it('returns boot-derived configuration fields and the cached feeConfig', async () => {
      const res = await app.request('/api/pool');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.network).toBe('testnet');
      expect(body.primaryAddress).toBe('0xSPONSOR1');
      expect(body.settlementPayoutRecipientAddress).toBe('0xRECIPIENT');
      expect(typeof body.sponsorBalanceWarnMist).toBe('string');
      expect(typeof body.sponsorBalanceRefillTargetMist).toBe('string');
      expect(typeof body.refillEnabled).toBe('boolean');
      expect(typeof body.quotedHostFeeMist).toBe('string');
      expect(body.feeConfig).toMatchObject({
        maxHostFeeMist: '1000',
        protocolFlatFeeMist: '100',
        maxClaimMist: '500',
        minSettleMist: '50',
        configVersion: '1',
      });
      expect(mockCtx.relay.getConfig).toHaveBeenCalled();
      expect(body.onChainIds).toBeDefined();
      expect(typeof body.studioEnabled).toBe('boolean');
    });
  });

  describe('Redis acquire failure', () => {
    it('POST /api/sponsor-refill-account/withdraw returns 500 when getAdminRedis rejects', async () => {
      mockGetRedisForAdmin.mockRejectedValueOnce(new Error('Redis unavailable'));
      const res = await app.request('/api/sponsor-refill-account/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountMist: '1000', nonce: 'n', signature: 's' }),
      });
      expect(res.status).toBe(500);
    });
  });
});
