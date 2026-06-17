/**
 * Relay route contract tests — verifies HTTP contracts.
 *
 * Tests use Hono's app.request() with a mocked AppApiContext.
 * No Redis/RPC required — all handlers are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  assertResponseKeys,
  assertNestedObjectKeys,
  assertArrayItemKeys,
} from './helpers/schemaAssert.js';

// ── Mock core-api handlers ──────────────────────────────────────────────
vi.mock('@stelis/core-api', async () => {
  const actual = await vi.importActual('@stelis/core-api');
  return {
    ...actual,
    handleStatus: vi.fn().mockResolvedValue({ ok: true }),
    handlePrepare: vi.fn().mockResolvedValue({
      receiptId: 'mock-receipt',
      txBytes: 'mock-tx-bytes',
      nonce: '1',
      cost: {
        relayerClaim: '500',
        simGas: '200',
        gasVarianceFixedMist: '100',
        slippageBufferMist: '0',
        quotedRelayerFee: '100',
        protocolFee: '50',
        grossGas: '300',
      },
      profile: 'new_user',
      quoteTimestampMs: 1700000000000,
      policyHash: '0xcafebabe',
    }),
    handleSponsor: vi.fn().mockResolvedValue({
      digest: 'mock-digest',
      effects: {},
      relayerClaim: '500',
    }),
    checkBlockedRequest: vi.fn().mockResolvedValue({ blocked: false }),
    toBlockedError: vi.fn().mockReturnValue({ error: 'blocked' }),
    readJsonBodyWithLimit: vi.fn().mockImplementation(async (req: Request) => {
      return req.json();
    }),
  };
});

// ── Mock client IP ──────────────────────────────────────────────────────
vi.mock('../src/clientIp.js', () => ({
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}));

// ── Mock sponsor operations gate response ───────────────────────────────
vi.mock('../src/sponsor-operations/gateResponse.js', () => ({
  buildSponsorUnavailableResponse: vi.fn().mockReturnValue(null),
}));

import { createRelayRoutes } from '../src/routes/relay.js';
import { getClientIp } from '../src/clientIp.js';
import { buildSponsorUnavailableResponse } from '../src/sponsor-operations/gateResponse.js';
import type { AppApiContext } from '../src/context.js';

const PREPARE_AUTH_FIELDS = {
  txKindBytesHash: '0x' + '11'.repeat(32),
  prepareAuthorizationTimestampMs: 1_700_000_000_000,
  prepareAuthorizationRequestNonce: 'route-test-nonce',
  prepareAuthorizationSignature: 'route-test-signature',
};

function prepareBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    txKindBytes: '0xTX',
    senderAddress: '0x' + 'ab'.repeat(32),
    paymentTokenType: 'SUI',
    ...PREPARE_AUTH_FIELDS,
    ...overrides,
  };
}

// ── Mock context factory ────────────────────────────────────────────────
function createMockCtx(): AppApiContext {
  return {
    relay: {
      network: 'testnet',
      packageId: '0xPKG',
      relayerRecipientAddress: '0xRECIPIENT',
      abuseBlocker: {} as never,
      rateLimiter: {
        check: vi.fn().mockResolvedValue({ allowed: true }),
      } as never,
      getConfig: vi.fn().mockResolvedValue({
        protocolFlatFeeMist: BigInt(100),
      }),
      sponsorPool: {
        leaseStatus: vi.fn().mockResolvedValue({
          leasedSlots: 0,
          freeSlots: 1,
          slots: [{ address: '0xslot', leased: false }],
        }),
      },
      dispose: vi.fn(),
    } as never,
    prepareConfig: {
      quotedRelayerFeeMist: BigInt(500),
      supportedSettlementSwapPaths: [
        {
          hops: [
            {
              poolId: 'pool-1',
              baseType: '0xDEEP',
              quoteType: '0xSUI',
              swapDirection: 'baseForQuote',
              feeBps: 0,
            },
          ],
          paymentTokenType: '0xDEEP',
          paymentTokenSymbol: 'DEEP',
          paymentTokenDecimals: 6,
          lotSize: 1n,
          minSize: 1n,
          effectiveFeeRateBps: 0,
          settlementSwapDirection: 'baseForQuote',
        },
      ],
      allowedSettlementSwapPaths: [],
    } as never,
    studio: null,

    redis: {} as never,
    sponsorOperations: {
      // Default mock returns a healthy single-slot state so the request
      // gate admits by default; deny-path tests override `readState`
      // via `(ctx.sponsorOperations.readState as Mock).mockResolvedValue(...)`.
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
    promotionStore: null,
    usageStore: null,
    executionLedger: null,
    studioGlobalTargetHashes: null,
    developerJwtTrustConfig: null,
    developerJwtVerifyUrl: null,
    dispose: vi.fn(),
  };
}

// Gate outcomes derived from the shared sponsor operations state view.
const SPONSOR_OPERATIONS_BLOCKED_CASES = [
  {
    code: 'SPONSOR_CAPACITY_UNAVAILABLE',
    error: 'No sponsor slots currently available',
    // State view: 1 degraded slot, sponsor refill account healthy → UNAVAILABLE.
    readStateResult: {
      slots: [
        {
          address: '0xslot',
          state: 'low_balance',
          balanceMist: '100',
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
    },
  },
  {
    code: 'SPONSOR_REFILL_ACCOUNT_UNHEALTHY',
    error: 'Sponsor refill account is unhealthy and no healthy sponsor slot remains',
    // State view: no healthy slot AND sponsor refill account unhealthy → SPONSOR_REFILL_ACCOUNT_UNHEALTHY.
    readStateResult: {
      slots: [
        {
          address: '0xslot',
          state: 'rpc_unreachable',
          balanceMist: null,
          lastError: 'rpc down',
          lastObservedAtMs: 1_700_000_000_000,
          writeSeq: 1,
        },
      ],
      sponsorRefillAccount: {
        balanceMist: null,
        healthy: false,
        refillsRemaining: null,
        lastError: 'sponsor refill account rpc down',
        lastObservedAtMs: 1_700_000_000_000,
        writeSeq: 1,
      },
    },
  },
] as const;

describe('relay routes', () => {
  let app: Hono;
  let mockCtx: AppApiContext;

  beforeEach(async () => {
    mockCtx = createMockCtx();
    const getCtx = async () => mockCtx;
    const routes = createRelayRoutes(getCtx);
    app = new Hono();
    app.route('/relay', routes);

    vi.mocked(getClientIp).mockReset();
    vi.mocked(getClientIp).mockReturnValue('127.0.0.1');

    // Reset mocked core-api and sponsor operations module-level functions:
    // clear accumulated call history first, then re-apply default behavior.
    // `vi.mock()`-hoisted mocks persist for the entire file, so explicit
    // `.mockClear()` keeps later `expect(...).not.toHaveBeenCalled()`
    // assertions deterministic.
    const coreApi = await import('@stelis/core-api');
    vi.mocked(coreApi.checkBlockedRequest).mockClear();
    vi.mocked(coreApi.checkBlockedRequest).mockResolvedValue({ blocked: false });
    vi.mocked(coreApi.handlePrepare).mockClear();
    vi.mocked(coreApi.handleSponsor).mockClear();
    vi.mocked(buildSponsorUnavailableResponse).mockClear();
    vi.mocked(buildSponsorUnavailableResponse).mockReturnValue(null);
  });

  describe('GET /relay/status', () => {
    it('returns 200 with status object', async () => {
      const res = await app.request('/relay/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('ok', true);
    });
  });

  describe('GET /relay/config', () => {
    it('returns 200 with network, packageId, supportedSettlementSwapPaths, fee fields', async () => {
      const res = await app.request('/relay/config');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.network).toBe('testnet');
      expect(body.packageId).toBe('0xPKG');
      expect(body.relayerRecipient).toBe('0xRECIPIENT');
      expect(body.supportedSettlementSwapPaths).toHaveLength(1);
      const pool = body.supportedSettlementSwapPaths[0];
      expect(pool.settlementSwapDirection).toBe('baseForQuote');
      expect(pool.hops).toHaveLength(1);
      expect(pool.hops[0].poolId).toBe('pool-1');
      expect(pool.hops[0].swapDirection).toBe('baseForQuote');
      expect(pool.lotSize).toBe(1);
      expect(pool.minSize).toBe(1);
      expect(body.quotedRelayerFeeMist).toBe('500');
      expect(body.protocolFlatFeeMist).toBe('100');
      expect(body.integrityPolicyVersion).toBeDefined();

      assertResponseKeys(body, 'relayConfigResponse');
      assertArrayItemKeys(body, 'supportedSettlementSwapPaths', 'singleHopSettlementSwapPath');
      assertArrayItemKeys(body.supportedSettlementSwapPaths[0], 'hops', 'deepBookPoolHop');
    });

    it('returns qfb pool with correct settlementSwapDirection and swapDirection', async () => {
      mockCtx.prepareConfig.supportedSettlementSwapPaths = [
        {
          hops: [
            {
              poolId: 'pool-qfb',
              baseType: '0xSUI',
              quoteType: '0xUSDC',
              swapDirection: 'quoteForBase',
              feeBps: 0,
            },
          ],
          paymentTokenType: '0xUSDC',
          paymentTokenSymbol: 'USDC',
          paymentTokenDecimals: 6,
          lotSize: 100n,
          minSize: 10n,
          effectiveFeeRateBps: 0,
          settlementSwapDirection: 'quoteForBase',
        },
      ] as never;
      const res = await app.request('/relay/config');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.supportedSettlementSwapPaths).toHaveLength(1);
      const pool = body.supportedSettlementSwapPaths[0];
      expect(pool.settlementSwapDirection).toBe('quoteForBase');
      expect(pool.hops[0].swapDirection).toBe('quoteForBase');
      expect(pool.hops[0].poolId).toBe('pool-qfb');
      expect(pool.lotSize).toBe(100);
      expect(pool.minSize).toBe(10);
    });

    it('returns 503 when pool metadata exceeds safe integer range (fail-closed)', async () => {
      // lotSize exceeds Number.MAX_SAFE_INTEGER → fail-closed via config error path
      mockCtx.prepareConfig.supportedSettlementSwapPaths = [
        { poolId: 'pool-1', lotSize: 9007199254740993n, minSize: 1n },
      ] as never;
      const res = await app.request('/relay/config');
      expect(res.status).toBe(503);
      // Restore for subsequent tests
      mockCtx.prepareConfig.supportedSettlementSwapPaths = [
        { poolId: 'pool-1', lotSize: 1n, minSize: 1n },
      ] as never;
    });

    it('returns 503 when getConfig fails', async () => {
      (mockCtx.relay.getConfig as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('config refresh failed'),
      );
      const res = await app.request('/relay/config');
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('CONFIG_UNAVAILABLE');
    });
  });

  describe('POST /relay/prepare', () => {
    it('passes sponsor operation state and slot leases to the prepare capacity gate', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prepareBody()),
      });

      expect(res.status).toBe(200);
      expect(mockCtx.sponsorOperations.readState).toHaveBeenCalledTimes(1);
      expect(mockCtx.relay.sponsorPool.leaseStatus).toHaveBeenCalledTimes(1);
      expect(buildSponsorUnavailableResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          slots: expect.any(Array),
          sponsorRefillAccount: expect.any(Object),
        }),
        {
          requireFreeSponsorSlot: true,
          slotLeases: {
            leasedSlots: 0,
            freeSlots: 1,
            slots: [{ address: '0xslot', leased: false }],
          },
        },
      );
    });

    it.each(SPONSOR_OPERATIONS_BLOCKED_CASES)(
      'returns 503 + $code when the sponsor operations gate blocks /relay/prepare',
      async ({ code, error }) => {
        const coreApi = await import('@stelis/core-api');
        vi.mocked(buildSponsorUnavailableResponse).mockReturnValueOnce({
          body: { error, code },
          status: 503,
          headers: {},
        });

        const res = await app.request('/relay/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            txKindBytes: '0xTX',
            senderAddress: '0xabc',
            paymentTokenType: 'SUI',
          }),
        });

        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error, code });
        expect(coreApi.handlePrepare).not.toHaveBeenCalled();
        expect(coreApi.checkBlockedRequest).not.toHaveBeenCalled();
        expect(mockCtx.relay.rateLimiter.check).not.toHaveBeenCalled();
      },
    );

    it('returns 400 CLIENT_IP_UNRESOLVED before shared admission keys when client IP cannot be resolved', async () => {
      const coreApi = await import('@stelis/core-api');
      vi.mocked(getClientIp).mockImplementationOnce(() => {
        const err = new Error('Client IP could not be resolved');
        err.name = 'ClientIpResolutionError';
        (err as { code?: string }).code = 'CLIENT_IP_UNRESOLVED';
        throw err;
      });

      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prepareBody()),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('CLIENT_IP_UNRESOLVED');
      expect(mockCtx.sponsorOperations.readState).not.toHaveBeenCalled();
      expect(coreApi.checkBlockedRequest).not.toHaveBeenCalled();
      expect(mockCtx.relay.rateLimiter.check).not.toHaveBeenCalled();
      expect(coreApi.handlePrepare).not.toHaveBeenCalled();
    });

    it('returns 400 on missing txKindBytes', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderAddress: '0xABC', paymentTokenType: 'SUI' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('BAD_REQUEST');
    });

    it('returns 400 on missing paymentTokenType', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txKindBytes: '0x...', senderAddress: '0xABC' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('BAD_REQUEST');
    });

    it('returns 400 on invalid senderAddress format', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          prepareBody({
            senderAddress: 'not-a-sui-address',
          }),
        ),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('BAD_REQUEST');
      expect(body.error).toContain('Invalid senderAddress');
    });

    it('canonicalizes short senderAddress before passing to handlePrepare', async () => {
      const coreApi = await import('@stelis/core-api');
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          prepareBody({
            senderAddress: '0x2', // short address should be zero-padded to 64 hex chars
          }),
        ),
      });
      expect(res.status).toBe(200);
      // Verify handlePrepare received the canonical (zero-padded) address, not the raw short form
      const lastCall = vi.mocked(coreApi.handlePrepare).mock.lastCall;
      expect(lastCall).toBeDefined();
      const params = lastCall![1] as { senderAddress: string };
      expect(params.senderAddress).toBe(
        '0x0000000000000000000000000000000000000000000000000000000000000002',
      );
      expect(mockCtx.relay.sponsorPool.leaseStatus).toHaveBeenCalledTimes(1);
      expect(buildSponsorUnavailableResponse).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ requireFreeSponsorSlot: true }),
      );
      // Verify success response includes nonce (PrepareResponse contract)
      const body = await res.json();
      expect(body.nonce).toBe('1');

      assertResponseKeys(body, 'prepareResponse');
      assertNestedObjectKeys(body, 'cost', 'prepareCost');
    });

    it('returns 422 with DRY_RUN_FAILED code on PrepareValidationError', async () => {
      const coreApi = await import('@stelis/core-api');
      vi.mocked(coreApi.handlePrepare).mockRejectedValueOnce(
        new coreApi.PrepareValidationError(
          'DRY_RUN_FAILED',
          'Transaction resolution failed: MoveAbort in 5th command, abort code: 12',
        ),
      );
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          prepareBody({
            senderAddress: '0x' + 'ab'.repeat(32),
            paymentTokenType:
              '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP',
          }),
        ),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('DRY_RUN_FAILED');
    });

    // S-15 companion: route-level contract — FundsWithdrawal(Sponsor) rejection
    it('returns 422 with P1_SPONSOR_WITHDRAWAL_FORBIDDEN on PrepareValidationError', async () => {
      const coreApi = await import('@stelis/core-api');
      vi.mocked(coreApi.handlePrepare).mockRejectedValueOnce(
        new coreApi.PrepareValidationError(
          'P1_SPONSOR_WITHDRAWAL_FORBIDDEN',
          'User TX contains FundsWithdrawal(Sponsor) — rejected to protect sponsor funds',
        ),
      );
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          prepareBody({
            senderAddress: '0x' + 'ab'.repeat(32),
            paymentTokenType:
              '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP',
          }),
        ),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('P1_SPONSOR_WITHDRAWAL_FORBIDDEN');
    });

    it('returns 429 on rate limit exceeded (prepare)', async () => {
      (mockCtx.relay.rateLimiter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
        allowed: false,
        retryAfterMs: 5000,
      });
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txKindBytes: '0x...',
          senderAddress: '0xABC',
          paymentTokenType: 'SUI',
        }),
      });
      expect(res.status).toBe(429);
      expect(mockCtx.relay.rateLimiter.check).toHaveBeenCalledWith(
        'prepare:client-ip:127.0.0.1',
      );
    });

    it('does not check sender address abuse at the HTTP route before authorization', async () => {
      const coreApi = await import('@stelis/core-api');
      vi.mocked(coreApi.checkBlockedRequest).mockReset();
      vi.mocked(coreApi.checkBlockedRequest).mockResolvedValueOnce({ blocked: false });

      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          prepareBody({
            senderAddress: '0x' + 'a'.repeat(64),
          }),
        ),
      });
      expect(res.status).toBe(200);
      expect(vi.mocked(coreApi.checkBlockedRequest)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(coreApi.handlePrepare)).toHaveBeenCalledTimes(1);
    });

    it('returns 503 BLOCK_CHECK_UNAVAILABLE when IP block check throws BlockCheckUnavailableError', async () => {
      const coreApi = await import('@stelis/core-api');
      vi.mocked(coreApi.checkBlockedRequest).mockReset();
      vi.mocked(coreApi.checkBlockedRequest).mockRejectedValueOnce(
        new coreApi.BlockCheckUnavailableError(),
      );

      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prepareBody({ senderAddress: '0x' + 'a'.repeat(64) })),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('BLOCK_CHECK_UNAVAILABLE');
    });

    it('passes signed prepare request fields to handlePrepare', async () => {
      const coreApi = await import('@stelis/core-api');

      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prepareBody({ senderAddress: '0x' + 'a'.repeat(64) })),
      });
      expect(res.status).toBe(200);
      const lastCall = vi.mocked(coreApi.handlePrepare).mock.lastCall;
      expect(lastCall).toBeDefined();
      expect(lastCall![1]).toMatchObject(PREPARE_AUTH_FIELDS);
    });

    // ── HTTP body BPS validation ──────────────────────────────────────────

    const validPrepareBase = {
      txKindBytes: '0xTX',
      senderAddress: '0x' + 'ab'.repeat(32),
      paymentTokenType: '0xDEEP::deep::DEEP',
      ...PREPARE_AUTH_FIELDS,
    };

    it('rejects string slippageBps with 422 INVALID_SLIPPAGE_BPS', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, slippageBps: '200' }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_SLIPPAGE_BPS');
    });

    it('rejects boolean slippageBps with 422 INVALID_SLIPPAGE_BPS', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, slippageBps: true }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_SLIPPAGE_BPS');
    });

    it('rejects null slippageBps with 422 INVALID_SLIPPAGE_BPS', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, slippageBps: null }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_SLIPPAGE_BPS');
    });

    it('rejects object slippageBps with 422 INVALID_SLIPPAGE_BPS', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, slippageBps: { value: 200 } }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_SLIPPAGE_BPS');
    });

    it('rejects decimal slippageBps with 422 INVALID_SLIPPAGE_BPS', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, slippageBps: 1.5 }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_SLIPPAGE_BPS');
    });

    it('rejects over-cap slippageBps (501) with 422 INVALID_SLIPPAGE_BPS', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, slippageBps: 501 }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_SLIPPAGE_BPS');
    });

    it('rejects string gasMarginBps with 422 INVALID_GAS_MARGIN_BPS', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, gasMarginBps: '1000' }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_GAS_MARGIN_BPS');
    });

    it('rejects boolean gasMarginBps with 422 INVALID_GAS_MARGIN_BPS', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, gasMarginBps: false }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_GAS_MARGIN_BPS');
    });

    it('rejects null gasMarginBps with 422 INVALID_GAS_MARGIN_BPS', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, gasMarginBps: null }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_GAS_MARGIN_BPS');
    });

    it('rejects object gasMarginBps with 422 INVALID_GAS_MARGIN_BPS', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, gasMarginBps: { value: 1000 } }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_GAS_MARGIN_BPS');
    });

    it('rejects decimal gasMarginBps with 422 INVALID_GAS_MARGIN_BPS', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, gasMarginBps: 10.5 }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_GAS_MARGIN_BPS');
    });

    it('rejects negative gasMarginBps with 422 INVALID_GAS_MARGIN_BPS', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, gasMarginBps: -5 }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_GAS_MARGIN_BPS');
    });

    it('rejects negative slippageBps with 422 INVALID_SLIPPAGE_BPS', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, slippageBps: -1 }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_SLIPPAGE_BPS');
    });

    it('rejects over-cap gasMarginBps (10001) with 422 INVALID_GAS_MARGIN_BPS', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, gasMarginBps: 10001 }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_GAS_MARGIN_BPS');
    });

    it('accepts omitted slippageBps/gasMarginBps (uses defaults)', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPrepareBase),
      });
      expect(res.status).toBe(200);
      // handlePrepare receives undefined for both, which triggers defaults
      const coreApi = await import('@stelis/core-api');
      const lastCall = vi.mocked(coreApi.handlePrepare).mock.lastCall;
      expect(lastCall![1].slippageBps).toBeUndefined();
      expect(lastCall![1].gasMarginBps).toBeUndefined();
    });

    it('accepts slippageBps=0 at HTTP body boundary', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, slippageBps: 0 }),
      });
      expect(res.status).toBe(200);
      const coreApi = await import('@stelis/core-api');
      const lastCall = vi.mocked(coreApi.handlePrepare).mock.lastCall;
      expect(lastCall![1].slippageBps).toBe(0);
    });

    it('accepts slippageBps at cap (500) at HTTP body boundary', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, slippageBps: 500 }),
      });
      expect(res.status).toBe(200);
      const coreApi = await import('@stelis/core-api');
      const lastCall = vi.mocked(coreApi.handlePrepare).mock.lastCall;
      expect(lastCall![1].slippageBps).toBe(500);
    });

    it('accepts gasMarginBps=0 at HTTP body boundary', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, gasMarginBps: 0 }),
      });
      expect(res.status).toBe(200);
      const coreApi = await import('@stelis/core-api');
      const lastCall = vi.mocked(coreApi.handlePrepare).mock.lastCall;
      expect(lastCall![1].gasMarginBps).toBe(0);
    });

    it('accepts gasMarginBps at cap (10000) at HTTP body boundary', async () => {
      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validPrepareBase, gasMarginBps: 10000 }),
      });
      expect(res.status).toBe(200);
      const coreApi = await import('@stelis/core-api');
      const lastCall = vi.mocked(coreApi.handlePrepare).mock.lastCall;
      expect(lastCall![1].gasMarginBps).toBe(10000);
    });
  });

  describe('POST /relay/sponsor', () => {
    const validBody = {
      txBytes: '0x...',
      userSignature: 'sig',
      receiptId: 'rcpt-1',
    };

    it('uses the sponsor health gate without requiring a free sponsor slot', async () => {
      const res = await app.request('/relay/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      expect(mockCtx.sponsorOperations.readState).toHaveBeenCalledTimes(1);
      expect(mockCtx.relay.sponsorPool.leaseStatus).not.toHaveBeenCalled();
      const gateCall = vi.mocked(buildSponsorUnavailableResponse).mock.calls[0];
      expect(gateCall).toHaveLength(1);
      expect(gateCall?.[0]).toEqual(
        expect.objectContaining({
          slots: expect.any(Array),
          sponsorRefillAccount: expect.any(Object),
        }),
      );
    });

    it.each(SPONSOR_OPERATIONS_BLOCKED_CASES)(
      'returns 503 + $code when the sponsor operations gate blocks /relay/sponsor',
      async ({ code, error }) => {
        const coreApi = await import('@stelis/core-api');
        vi.mocked(buildSponsorUnavailableResponse).mockReturnValueOnce({
          body: { error, code },
          status: 503,
          headers: {},
        });

        const res = await app.request('/relay/sponsor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validBody),
        });

        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error, code });
        expect(coreApi.handleSponsor).not.toHaveBeenCalled();
        expect(coreApi.checkBlockedRequest).not.toHaveBeenCalled();
        expect(mockCtx.relay.rateLimiter.check).not.toHaveBeenCalled();
      },
    );

    it('returns 400 CLIENT_IP_UNRESOLVED before shared admission keys when client IP cannot be resolved', async () => {
      const coreApi = await import('@stelis/core-api');
      vi.mocked(getClientIp).mockImplementationOnce(() => {
        const err = new Error('Client IP could not be resolved');
        err.name = 'ClientIpResolutionError';
        (err as { code?: string }).code = 'CLIENT_IP_UNRESOLVED';
        throw err;
      });

      const res = await app.request('/relay/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('CLIENT_IP_UNRESOLVED');
      expect(mockCtx.sponsorOperations.readState).not.toHaveBeenCalled();
      expect(coreApi.checkBlockedRequest).not.toHaveBeenCalled();
      expect(mockCtx.relay.rateLimiter.check).not.toHaveBeenCalled();
      expect(coreApi.handleSponsor).not.toHaveBeenCalled();
    });

    it('returns 400 on missing fields', async () => {
      const res = await app.request('/relay/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txBytes: '0x...' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('BAD_REQUEST');
    });

    it('returns 429 on rate limit exceeded', async () => {
      (mockCtx.relay.rateLimiter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
        allowed: false,
        retryAfterMs: 3000,
      });
      const res = await app.request('/relay/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(429);
      expect(mockCtx.relay.rateLimiter.check).toHaveBeenCalledWith(
        'sponsor:client-ip:127.0.0.1',
      );
    });

    it('returns 503 BLOCK_CHECK_UNAVAILABLE when block check throws BlockCheckUnavailableError', async () => {
      const coreApi = await import('@stelis/core-api');
      vi.mocked(coreApi.checkBlockedRequest).mockReset();
      vi.mocked(coreApi.checkBlockedRequest).mockRejectedValueOnce(
        new coreApi.BlockCheckUnavailableError(),
      );

      const res = await app.request('/relay/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('BLOCK_CHECK_UNAVAILABLE');
      expect(coreApi.handleSponsor).not.toHaveBeenCalled();
    });

    it('takes generic path when studio is null (A=false)', async () => {
      // studio: null → no binding check → generic handleSponsor.
      // No route-level observation wake. The sponsor-terminal host
      // callback (wired in `packages/app-api/src/context.ts`) writes
      // slot state directly and is covered by `handleSponsor.test.ts`.
      const res = await app.request('/relay/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.digest).toBe('mock-digest');
      expect(mockCtx.relay.sponsorPool.leaseStatus).not.toHaveBeenCalled();

      assertResponseKeys(body, 'sponsorResponse');
    });
  });

  // Note: studio /prepare → /sponsor integration is covered in the dedicated
  // promotion prepare/sponsor test suites.

  // ── Failure path: error → HTTP mapping ────────────────────────────────
  describe('failure path — error HTTP mapping', () => {
    const validSponsorBody = {
      txBytes: '0x...',
      userSignature: 'sig',
      receiptId: 'rcpt-fail',
    };

    it('returns on-chain revert as 422 (SponsorOnchainError)', async () => {
      // State refresh after failure is owned by the sponsor-terminal
      // host callback inside `handleSponsor`; the route does not fire a
      // wake signal. Callback-side state update is locked in
      // `handleSponsor.test.ts` (core-api).
      const coreApi = await import('@stelis/core-api');
      vi.mocked(coreApi.handleSponsor).mockRejectedValueOnce(
        new coreApi.SponsorOnchainError('tx-digest-fail', 'MoveAbort', undefined),
      );

      const res = await app.request('/relay/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSponsorBody),
      });
      expect(res.status).toBe(422);
    });

    it('returns 500 + SPONSOR_FAILED on post-submit SponsorValidationError(statusHint=500)', async () => {
      // Post-submit internal failure: handleSponsor throws SponsorValidationError
      // with code=SPONSOR_FAILED and statusHint=500 when execution succeeded
      // but effects are missing `gasUsed` (Sui gRPC edge case). Locks the
      // route-level invariant:
      //   errorMap projects this to HTTP 500 with code=SPONSOR_FAILED (no
      //   new public code leak, no 422 preflight misclassification).
      //
      // Slot state refresh after this path is owned by the
      // sponsor-terminal host callback inside `handleSponsor`. The
      // callback preserves `outcome='success'` for the gasUsed-missing
      // path so the per-slot balance write reflects the on-chain
      // consumption. This is locked in `handleSponsor.test.ts`
      // (core-api); the route does not fire a wake signal of its own.
      const coreApi = await import('@stelis/core-api');
      vi.mocked(coreApi.handleSponsor).mockRejectedValueOnce(
        new coreApi.SponsorValidationError(
          'SPONSOR_FAILED',
          'Execution succeeded but gasUsed missing — cannot verify economics. Digest: 0xdigest_exec_no_gas',
          500,
        ),
      );

      const res = await app.request('/relay/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSponsorBody),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe('SPONSOR_FAILED');
      // Error message preserved through errorMap for operator/client trace
      expect(body.error).toContain('0xdigest_exec_no_gas');
    });

    it('returns 503 + SPONSOR_CONGESTION on SponsorCongestionError', async () => {
      const coreApi = await import('@stelis/core-api');
      vi.mocked(coreApi.handleSponsor).mockRejectedValueOnce(
        new coreApi.SponsorCongestionError('shared object congestion'),
      );

      const res = await app.request('/relay/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSponsorBody),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('SPONSOR_CONGESTION');
    });

    it('returns 503 + LEASE_EXPIRED + Retry-After:1 on SponsorLeaseExpiredError', async () => {
      const coreApi = await import('@stelis/core-api');
      vi.mocked(coreApi.handleSponsor).mockRejectedValueOnce(
        new coreApi.SponsorLeaseExpiredError('slot-xyz'),
      );

      const res = await app.request('/relay/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSponsorBody),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('LEASE_EXPIRED');
      expect(res.headers.get('Retry-After')).toBe('1');
    });

    it('returns 429 + PREPARE_STUDIO_USER_QUOTA_EXCEEDED on PrepareStudioUserQuotaError', async () => {
      const coreApi = await import('@stelis/core-api');
      vi.mocked(coreApi.handlePrepare).mockRejectedValueOnce(
        new coreApi.PrepareStudioUserQuotaError('0xABC', 3),
      );

      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prepareBody({ senderAddress: '0xABC' })),
      });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.code).toBe('PREPARE_STUDIO_USER_QUOTA_EXCEEDED');
    });

    it('returns 429 + PREPARE_SENDER_QUOTA_EXCEEDED on PrepareSenderQuotaError', async () => {
      const coreApi = await import('@stelis/core-api');
      vi.mocked(coreApi.handlePrepare).mockRejectedValueOnce(
        new coreApi.PrepareSenderQuotaError('0xABC', 3),
      );

      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prepareBody({ senderAddress: '0xABC' })),
      });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.code).toBe('PREPARE_SENDER_QUOTA_EXCEEDED');
    });

    it('returns 503 + PREPARE_OVERLOADED + Retry-After on PrepareOverloadError', async () => {
      const coreApi = await import('@stelis/core-api');
      vi.mocked(coreApi.handlePrepare).mockRejectedValueOnce(
        new coreApi.PrepareOverloadError(5, 5),
      );

      const res = await app.request('/relay/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prepareBody({ senderAddress: '0xABC' })),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('PREPARE_OVERLOADED');
      expect(res.headers.get('Retry-After')).toBe('2');
    });
  });
});
