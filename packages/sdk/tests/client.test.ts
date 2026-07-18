import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StelisClient, StelisApiException } from '../src/client.js';
import type { RelayConfigResponse } from '../src/types.js';
import {
  hostErrorPublicMessage,
  NODE_TIMER_MAX_DELAY_MS,
  type HostErrorCode,
} from '@stelis/contracts';
import { makeRelayPrepareRequest } from './helpers/currentFixtures.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
const PROMOTION_ID = '00000000-0000-4000-8000-000000000001';

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function relayConfigResponse(): RelayConfigResponse {
  return {
    network: 'testnet',
    packageId: '0x1',
    settlementPayoutRecipient: '0x2',
    supportedSettlementSwapPaths: [],
    quotedHostFeeMist: '1',
    protocolFlatFeeMist: '1',
  };
}

function relayConfigResponseWithPath(): RelayConfigResponse {
  const settlementTokenType = '0x1::deep::DEEP';
  return {
    ...relayConfigResponse(),
    supportedSettlementSwapPaths: [
      {
        hops: [
          {
            poolId: '0x4',
            baseType: settlementTokenType,
            quoteType: '0x2::sui::SUI',
            swapDirection: 'baseForQuote',
            feeBps: 0,
          },
        ],
        settlementTokenType,
        settlementTokenSymbol: 'DEEP',
        settlementTokenDecimals: 6,
        lotSize: 100,
        minSize: 1_000_000,
        effectiveFeeRateBps: 0,
        settlementSwapDirection: 'baseForQuote',
      },
    ],
  };
}

describe('StelisClient', () => {
  let client: StelisClient;

  beforeEach(() => {
    client = new StelisClient({ endpoint: 'http://localhost:3000/relay' });
    mockFetch.mockReset();
  });

  describe('request timeouts', () => {
    it('applies per-operation timeout overrides', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      const c = new StelisClient({
        endpoint: 'http://localhost:3000/relay',
        requestTimeouts: {
          statusMs: 1111,
          configMs: 1666,
          prepareMs: 2222,
          sponsorMs: 3333,
          studioReadMs: 4444,
          studioWriteMs: 5555,
        },
      });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ ok: true })) // getStatus
        .mockResolvedValueOnce(jsonResponse(relayConfigResponse())) // getConfig
        .mockResolvedValueOnce(
          jsonResponse({
            txBytes: 'b64',
            receiptId: 'r1',
            nonce: '1',
            cost: {
              simGas: '1',
              gasVarianceFixedMist: '1',
              slippageBufferMist: '1',
              quotedHostFee: '1',
              protocolFee: '1',
              executionCostClaim: '1',
              grossGas: '1',
            },
            profile: 'new_user',
            quoteTimestampMs: Date.now(),
            policyHash: '0x' + 'ab'.repeat(32),
          }),
        ) // prepare
        .mockResolvedValueOnce(
          jsonResponse({ digest: '0x1', effects: {}, executionCostClaim: '1' }),
        ) // sponsor
        .mockResolvedValueOnce(jsonResponse({ promotions: [], nextCursor: null })) // listPromotions
        .mockResolvedValueOnce(
          jsonResponse({ txBytes: 'b64', receiptId: 'r1', estimatedGasMist: '1000' }),
        ); // promotionPrepare

      await c.getStatus();
      await c.getConfig();
      await c.prepare(
        makeRelayPrepareRequest({
          txKindBytes: 'k',
          senderAddress: '0x' + 'a'.repeat(64),
          settlementTokenType: '0x2::sui::SUI',
        }),
      );
      await c.sponsor({
        txBytes: 'b64',
        userSignature: 'sig',
        receiptId: '0x' + '1'.repeat(64),
      });
      await c.listPromotions('jwt');
      await c.promotionPrepare(
        'promo',
        { senderAddress: '0x' + 'a'.repeat(64), txKindBytes: 'k' },
        'jwt',
      );

      expect(timeoutSpy).toHaveBeenNthCalledWith(1, 1111);
      expect(timeoutSpy).toHaveBeenNthCalledWith(2, 1666);
      expect(timeoutSpy).toHaveBeenNthCalledWith(3, 2222);
      expect(timeoutSpy).toHaveBeenNthCalledWith(4, 3333);
      expect(timeoutSpy).toHaveBeenNthCalledWith(5, 4444);
      expect(timeoutSpy).toHaveBeenNthCalledWith(6, 5555);
      timeoutSpy.mockRestore();
    });

    it('rejects invalid timeout overrides', () => {
      expect(
        () =>
          new StelisClient({
            endpoint: 'http://localhost:3000/relay',
            requestTimeouts: { sponsorMs: 0 },
          }),
      ).toThrow('requestTimeouts.sponsorMs must be an integer from 1 through');
      expect(
        () =>
          new StelisClient({
            endpoint: 'http://localhost:3000/relay',
            requestTimeouts: { sponsorMs: NODE_TIMER_MAX_DELAY_MS + 1 },
          }),
      ).toThrow(String(NODE_TIMER_MAX_DELAY_MS));
    });
  });

  describe('getConfig', () => {
    it('returns the current wire shape through the shared Host parser', async () => {
      const config = relayConfigResponse();
      mockFetch.mockResolvedValueOnce(jsonResponse(config));

      await expect(client.getConfig()).resolves.toEqual(config);
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/relay/config');
    });

    it('rejects config fields and values outside the current Host contract', async () => {
      for (const config of [
        { ...relayConfigResponse(), obsoleteField: true },
        { ...relayConfigResponse(), protocolFlatFeeMist: '1.5' },
      ]) {
        mockFetch.mockResolvedValueOnce(jsonResponse(config));
        await expect(client.getConfig()).rejects.toThrow(/non-current field|canonical/);
      }
    });

    it('enforces settlement swap path identity and fee invariants at the HTTP boundary', async () => {
      const invalidConfigs: Array<{ config: RelayConfigResponse; error: string }> = [];

      const missingDirection = relayConfigResponseWithPath();
      delete (missingDirection.supportedSettlementSwapPaths[0] as Record<string, unknown>)[
        'settlementSwapDirection'
      ];
      invalidConfigs.push({
        config: missingDirection,
        error: 'settlementSwapDirection is invalid',
      });

      const directionMismatch = relayConfigResponseWithPath();
      directionMismatch.supportedSettlementSwapPaths[0].hops[0].swapDirection = 'quoteForBase';
      invalidConfigs.push({
        config: directionMismatch,
        error: 'hops do not match settlementSwapDirection',
      });

      const duplicateToken = relayConfigResponseWithPath();
      duplicateToken.supportedSettlementSwapPaths.push({
        ...duplicateToken.supportedSettlementSwapPaths[0],
        hops: [
          {
            ...duplicateToken.supportedSettlementSwapPaths[0].hops[0],
            poolId: '0x5',
          },
        ],
      });
      invalidConfigs.push({ config: duplicateToken, error: 'duplicate settlementTokenType' });

      const feeDrift = relayConfigResponseWithPath();
      feeDrift.supportedSettlementSwapPaths[0].effectiveFeeRateBps = 25;
      feeDrift.supportedSettlementSwapPaths[0].hops[0].feeBps = 20;
      invalidConfigs.push({ config: feeDrift, error: 'feeBps must equal effectiveFeeRateBps' });

      const unsafeLotSize = relayConfigResponseWithPath();
      unsafeLotSize.supportedSettlementSwapPaths[0].lotSize = Number.MAX_SAFE_INTEGER + 1;
      invalidConfigs.push({ config: unsafeLotSize, error: 'lotSize must be a safe integer' });

      for (const { config, error } of invalidConfigs) {
        mockFetch.mockResolvedValueOnce(jsonResponse(config));
        await expect(client.getConfig()).rejects.toThrow(error);
      }
    });
  });

  // ─────────────────────────────────────────
  // prepare
  // ─────────────────────────────────────────

  describe('prepare', () => {
    it('sends POST with body and returns prepareResponse', async () => {
      const prepareData = {
        txBytes: 'base64txbytes',
        receiptId: '0x7a3f',
        nonce: '1',
        cost: {
          simGas: '2000000',
          gasVarianceFixedMist: '200000',
          slippageBufferMist: '50000',
          quotedHostFee: '100000',
          protocolFee: '20000',
          executionCostClaim: '2120000',
          grossGas: '3000000',
        },
        profile: 'new_user',
        quoteTimestampMs: 1_700_000_000_000,
        policyHash: '0x' + 'ab'.repeat(32),
      };

      mockFetch.mockResolvedValueOnce(jsonResponse(prepareData));

      const request = makeRelayPrepareRequest({
        txKindBytes: 'base64kind',
        senderAddress: '0xAlice',
        settlementTokenType: 'DEEP',
      });
      const result = await client.prepare(request);

      expect(result.txBytes).toBe('base64txbytes');
      expect(result.receiptId).toBe('0x7a3f');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3000/relay/prepare');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual(request);
    });

    it('forwards orderId in request body and echoes in response', async () => {
      const prepareData = {
        txBytes: 'base64txbytes',
        receiptId: '0x7a3f',
        nonce: '1',
        cost: {
          simGas: '2000000',
          gasVarianceFixedMist: '200000',
          slippageBufferMist: '50000',
          quotedHostFee: '100000',
          protocolFee: '20000',
          executionCostClaim: '2120000',
          grossGas: '3000000',
        },
        profile: 'new_user',
        quoteTimestampMs: 1_700_000_000_000,
        policyHash: '0x' + 'ab'.repeat(32),
        orderId: 'test-123',
      };

      mockFetch.mockResolvedValueOnce(jsonResponse(prepareData));

      const result = await client.prepare(
        makeRelayPrepareRequest({
          txKindBytes: 'base64kind',
          senderAddress: '0xAlice',
          settlementTokenType: 'DEEP',
          orderId: 'test-123',
        }),
      );

      expect(result.orderId).toBe('test-123');

      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body).orderId).toBe('test-123');
    });
  });

  // ─────────────────────────────────────────
  // sponsor
  // ─────────────────────────────────────────

  describe('sponsor', () => {
    it('sends POST with body and returns response', async () => {
      const sponsorData = {
        digest: '0xresult',
        effects: { status: { success: true } },
        executionCostClaim: '1',
      };

      mockFetch.mockResolvedValueOnce(jsonResponse(sponsorData));

      const result = await client.sponsor({
        txBytes: 'base64tx',
        userSignature: 'base64sig',
        receiptId: '0x7a3f',
      });

      expect(result.digest).toBe('0xresult');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3000/relay/sponsor');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        txBytes: 'base64tx',
        userSignature: 'base64sig',
        receiptId: '0x7a3f',
      });
    });

    it('echoes orderId from sponsor response', async () => {
      const sponsorData = {
        digest: '0xresult',
        effects: { status: { success: true } },
        executionCostClaim: '1',
        orderId: 'order-abc',
      };

      mockFetch.mockResolvedValueOnce(jsonResponse(sponsorData));

      const result = await client.sponsor({
        txBytes: 'base64tx',
        userSignature: 'base64sig',
        receiptId: '0x7a3f',
      });

      expect(result.orderId).toBe('order-abc');
    });

    it('rejects a present non-string optional orderId in the Host response', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          digest: '0xresult',
          effects: {},
          executionCostClaim: '1',
          orderId: 123,
        }),
      );
      await expect(
        client.sponsor({ txBytes: 'tx', userSignature: 'sig', receiptId: 'receipt' }),
      ).rejects.toThrow('orderId must be a string');
    });
  });

  // ─────────────────────────────────────────
  // Error handling
  // ─────────────────────────────────────────

  describe('error handling', () => {
    it('preserves current codes on every route that owns them', async () => {
      const ownedRouteResponses: Array<{
        body: Record<string, unknown>;
        status: number;
        request: () => Promise<unknown>;
      }> = [
        {
          body: { error: hostErrorPublicMessage('INTERNAL_ERROR'), code: 'INTERNAL_ERROR' },
          status: 500,
          request: () => client.getStatus(),
        },
        {
          body: {
            error: hostErrorPublicMessage('CONFIG_UNAVAILABLE'),
            code: 'CONFIG_UNAVAILABLE',
          },
          status: 503,
          request: () => client.getConfig(),
        },
        {
          body: {
            error: hostErrorPublicMessage('INSUFFICIENT_BALANCE'),
            code: 'INSUFFICIENT_BALANCE',
          },
          status: 422,
          request: () =>
            client.prepare(
              makeRelayPrepareRequest({
                txKindBytes: 'kind',
                senderAddress: '0x1',
                settlementTokenType: '0x2::sui::SUI',
              }),
            ),
        },
        {
          body: {
            error: hostErrorPublicMessage('PAYMENT_COIN_LIMIT_EXCEEDED'),
            code: 'PAYMENT_COIN_LIMIT_EXCEEDED',
          },
          status: 422,
          request: () =>
            client.prepare(
              makeRelayPrepareRequest({
                txKindBytes: 'kind',
                senderAddress: '0x1',
                settlementTokenType: '0x2::sui::SUI',
              }),
            ),
        },
        {
          body: {
            error: hostErrorPublicMessage('SPONSOR_ONCHAIN_FAILED'),
            code: 'SPONSOR_ONCHAIN_FAILED',
            digest: '0xfailed',
          },
          status: 422,
          request: () =>
            client.sponsor({ txBytes: 'tx', userSignature: 'sig', receiptId: 'receipt' }),
        },
        {
          body: { error: hostErrorPublicMessage('NOT_CLAIMED'), code: 'NOT_CLAIMED' },
          status: 403,
          request: () =>
            client.promotionPrepare(
              'promotion',
              { senderAddress: '0x1', txKindBytes: 'kind' },
              'jwt',
            ),
        },
        {
          body: {
            error: hostErrorPublicMessage('ONCHAIN_REVERT'),
            code: 'ONCHAIN_REVERT',
            digest: '0xpromotion',
          },
          status: 422,
          request: () =>
            client.promotionSponsor(
              'promotion',
              { receiptId: 'receipt', txBytes: 'tx', userSignature: 'sig' },
              'jwt',
            ),
        },
        {
          body: { error: hostErrorPublicMessage('AUTH_FAILED'), code: 'AUTH_FAILED' },
          status: 401,
          request: () => client.listPromotions('jwt'),
        },
        {
          body: {
            error: hostErrorPublicMessage('CLIENT_IP_UNRESOLVED'),
            code: 'CLIENT_IP_UNRESOLVED',
          },
          status: 400,
          request: () => client.getPromotionDetail('promotion', 'jwt'),
        },
      ];

      for (const { body, status, request } of ownedRouteResponses) {
        mockFetch.mockResolvedValueOnce(jsonResponse(body, status));
        await expect(request()).rejects.toMatchObject({ code: body.code, status });
      }
    });

    it('rejects current codes when they come from a route that does not own them', async () => {
      const wrongRouteResponses: Array<{
        code: string;
        status: number;
        request: () => Promise<unknown>;
      }> = [
        { code: 'BAD_REQUEST', status: 400, request: () => client.getStatus() },
        { code: 'BAD_REQUEST', status: 400, request: () => client.getConfig() },
        {
          code: 'SPONSOR_ONCHAIN_FAILED',
          status: 422,
          request: () =>
            client.prepare(
              makeRelayPrepareRequest({
                txKindBytes: 'kind',
                senderAddress: '0x1',
                settlementTokenType: '0x2::sui::SUI',
              }),
            ),
        },
        {
          code: 'INSUFFICIENT_BALANCE',
          status: 422,
          request: () =>
            client.sponsor({ txBytes: 'tx', userSignature: 'sig', receiptId: 'receipt' }),
        },
        {
          code: 'PAYMENT_COIN_LIMIT_EXCEEDED',
          status: 422,
          request: () =>
            client.sponsor({ txBytes: 'tx', userSignature: 'sig', receiptId: 'receipt' }),
        },
        {
          code: 'SPONSOR_REFILL_ACCOUNT_UNHEALTHY',
          status: 503,
          request: () =>
            client.sponsor({ txBytes: 'tx', userSignature: 'sig', receiptId: 'receipt' }),
        },
        {
          code: 'ONCHAIN_REVERT',
          status: 422,
          request: () =>
            client.promotionPrepare(
              'promotion',
              { senderAddress: '0x1', txKindBytes: 'kind' },
              'jwt',
            ),
        },
        {
          code: 'GAS_EXCEEDS_TX_CAP',
          status: 422,
          request: () =>
            client.promotionSponsor(
              'promotion',
              { receiptId: 'receipt', txBytes: 'tx', userSignature: 'sig' },
              'jwt',
            ),
        },
        {
          code: 'SPONSOR_REFILL_ACCOUNT_UNHEALTHY',
          status: 503,
          request: () =>
            client.promotionSponsor(
              'promotion',
              { receiptId: 'receipt', txBytes: 'tx', userSignature: 'sig' },
              'jwt',
            ),
        },
        { code: 'NOT_CLAIMED', status: 403, request: () => client.listPromotions('jwt') },
        {
          code: 'NOT_CLAIMED',
          status: 403,
          request: () => client.getPromotionDetail('promotion', 'jwt'),
        },
        {
          code: 'ALREADY_CLAIMED',
          status: 409,
          request: () => client.getPromotionDetail('promotion', 'jwt'),
        },
      ];

      for (const { code, status, request } of wrongRouteResponses) {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({ error: hostErrorPublicMessage(code as HostErrorCode), code }, status),
        );
        await expect(request()).rejects.toThrow(
          `Stelis Host returned a non-current error response (HTTP ${status})`,
        );
      }
    });

    it('rejects a current code paired with the wrong HTTP status', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: hostErrorPublicMessage('AUTH_FAILED'), code: 'AUTH_FAILED' }, 422),
      );
      await expect(client.listPromotions('jwt')).rejects.toThrow(
        'Stelis Host returned a non-current error response (HTTP 422)',
      );
    });

    it('rejects a known on-chain terminal code without its required digest', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: hostErrorPublicMessage('SPONSOR_ONCHAIN_FAILED'),
            code: 'SPONSOR_ONCHAIN_FAILED',
          },
          422,
        ),
      );
      await expect(
        client.sponsor({ txBytes: 'tx', userSignature: 'sig', receiptId: 'receipt' }),
      ).rejects.toThrow('Stelis Host returned a non-current error response (HTTP 422)');
    });

    it('does not echo a non-current remote error body', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('A server error occurred while processing this request.', {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'Content-Type': 'text/plain' },
        }),
      );

      try {
        await client.getStatus();
        expect.fail('Expected a Host contract error');
      } catch (e) {
        const err = e as Error;
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(StelisApiException);
        expect(err.message).toBe('Stelis Host returned a non-current error response (HTTP 500)');
        expect(err.message).not.toContain('A server error occurred');
      }
    });

    it('rejects an uncoded rate-limit body instead of preserving remote text or metadata', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Rate limit exceeded', retryAfterMs: 2500 }, 429),
      );

      try {
        await client.getStatus();
        expect.fail('Expected a Host contract error');
      } catch (e) {
        const err = e as Error;
        expect(err).not.toBeInstanceOf(StelisApiException);
        expect(err.message).toBe('Stelis Host returned a non-current error response (HTTP 429)');
      }
    });

    it('accepts only the closed current error metadata shape', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: hostErrorPublicMessage('INSUFFICIENT_SETTLE_INPUT'),
            code: 'INSUFFICIENT_SETTLE_INPUT',
            minSettleMist: '1000',
            requiredTotalIn: '2000',
            isEstimate: false,
          },
          422,
        ),
      );

      await expect(
        client.prepare(
          makeRelayPrepareRequest({
            txKindBytes: 'kind',
            senderAddress: '0x1',
            settlementTokenType: '0x2::sui::SUI',
          }),
        ),
      ).rejects.toMatchObject({
        code: 'INSUFFICIENT_SETTLE_INPUT',
        meta: {
          minSettleMist: '1000',
          requiredTotalIn: '2000',
          isEstimate: false,
        },
      });
    });

    it('rejects unknown or mistyped remote error fields without preserving them', async () => {
      for (const body of [
        {
          error: hostErrorPublicMessage('BAD_REQUEST'),
          code: 'BAD_REQUEST',
          secretKey: 'must-not-leak',
        },
        {
          error: hostErrorPublicMessage('BAD_REQUEST'),
          code: 'BAD_REQUEST',
          isEstimate: false,
        },
        {
          error: hostErrorPublicMessage('BAD_REQUEST'),
          code: 'BAD_REQUEST',
          minSettleMist: '1',
        },
      ]) {
        mockFetch.mockResolvedValueOnce(jsonResponse(body, 400));
        try {
          await client.prepare(
            makeRelayPrepareRequest({
              txKindBytes: 'kind',
              senderAddress: '0x1',
              settlementTokenType: '0x2::sui::SUI',
            }),
          );
          expect.fail('Expected a Host contract error');
        } catch (error) {
          const apiError = error as Error;
          expect(apiError).not.toBeInstanceOf(StelisApiException);
          expect(apiError.message).toBe(
            'Stelis Host returned a non-current error response (HTTP 400)',
          );
          expect(JSON.stringify(apiError)).not.toContain('must-not-leak');
        }
      }
    });

    it('throws a readable error on successful but non-JSON response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('<html>ok</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );

      await expect(client.getStatus()).rejects.toThrow(
        /Stelis Host returned a non-JSON success response \(HTTP 200\)/,
      );
    });

    it('rejects non-current successful status bodies instead of casting them', async () => {
      for (const body of [{ ok: false }, { ok: true, unexpectedState: 'ready' }]) {
        mockFetch.mockResolvedValueOnce(jsonResponse(body));
        await expect(client.getStatus()).rejects.toThrow(/RelayStatusResponse/);
      }
    });
  });

  // ─────────────────────────────────────────
  // Endpoint normalization
  // ─────────────────────────────────────────

  describe('endpoint normalization', () => {
    it('strips trailing slash from endpoint', async () => {
      const c = new StelisClient({ endpoint: 'http://example.com/relay/' });
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

      await c.getStatus();

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('http://example.com/relay/status');
    });
  });

  // ─────────────────────────────────────────
  // studioBase derivation
  // ─────────────────────────────────────────

  describe('studioBase derivation', () => {
    it('strips /relay suffix for promotion endpoints', async () => {
      const c = new StelisClient({ endpoint: 'http://localhost:3200/relay' });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ txBytes: 'b64', receiptId: 'r1', estimatedGasMist: '1000' }),
      );

      await c.promotionPrepare('promo_1', { senderAddress: '0xA', txKindBytes: 'b64kind' }, 'jwt');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('http://localhost:3200/studio/promotions/promo_1/prepare');
    });

    it('works when endpoint has no /relay suffix', async () => {
      const c = new StelisClient({ endpoint: 'http://localhost:3200' });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ txBytes: 'b64', receiptId: 'r1', estimatedGasMist: '1000' }),
      );

      await c.promotionPrepare('promo_1', { senderAddress: '0xA', txKindBytes: 'b64kind' }, 'jwt');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('http://localhost:3200/studio/promotions/promo_1/prepare');
    });
  });

  // ─────────────────────────────────────────
  // promotionPrepare
  // ─────────────────────────────────────────

  describe('promotionPrepare', () => {
    it('sends POST with params and Authorization header', async () => {
      const prepareData = { txBytes: 'b64tx', receiptId: 'r1', estimatedGasMist: '5000000' };
      mockFetch.mockResolvedValueOnce(jsonResponse(prepareData));

      const result = await client.promotionPrepare(
        'promo_abc',
        { senderAddress: '0xAlice', txKindBytes: 'b64kind' },
        'my-jwt-token',
      );

      expect(result.txBytes).toBe('b64tx');
      expect(result.receiptId).toBe('r1');
      expect(result.estimatedGasMist).toBe('5000000');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3000/studio/promotions/promo_abc/prepare');
      expect(init.method).toBe('POST');
      expect(init.headers['Authorization']).toBe('Bearer my-jwt-token');
      expect(JSON.parse(init.body)).toEqual({
        senderAddress: '0xAlice',
        txKindBytes: 'b64kind',
      });
    });

    it('URL-encodes promotionId', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ txBytes: 'b64', receiptId: 'r1', estimatedGasMist: '1000' }),
      );

      await client.promotionPrepare(
        'promo/special chars',
        { senderAddress: '0xA', txKindBytes: 'b64' },
        'jwt',
      );

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('promo%2Fspecial%20chars');
    });
  });

  // ─────────────────────────────────────────
  // promotionSponsor
  // ─────────────────────────────────────────

  describe('promotionSponsor', () => {
    it('sends POST with params and Authorization header', async () => {
      const sponsorData = { digest: '0xdigest', effects: {}, actualGasMist: '3000000' };
      mockFetch.mockResolvedValueOnce(jsonResponse(sponsorData));

      const result = await client.promotionSponsor(
        'promo_abc',
        { receiptId: 'r1', txBytes: 'b64tx', userSignature: 'sig' },
        'jwt-token',
      );

      expect(result.digest).toBe('0xdigest');
      expect(result.actualGasMist).toBe('3000000');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3000/studio/promotions/promo_abc/sponsor');
      expect(init.method).toBe('POST');
      expect(init.headers['Authorization']).toBe('Bearer jwt-token');
      expect(JSON.parse(init.body)).toEqual({
        receiptId: 'r1',
        txBytes: 'b64tx',
        userSignature: 'sig',
      });
    });
  });

  // ─────────────────────────────────────────
  // listPromotions
  // ─────────────────────────────────────────

  describe('listPromotions', () => {
    it('sends GET with Authorization header', async () => {
      const listData = {
        promotions: [
          {
            promotionId: PROMOTION_ID,
            displayName: 'Test Promo',
            type: 'gas_sponsorship',
            status: 'active',
            canClaim: true,
            canUseSponsoredAction: false,
            promotionRemainingBudgetMist: '100000000',
            remainingParticipantSlots: 10,
            userRemainingGasAllowanceMist: null,
            unavailableReason: 'not_claimed',
          },
        ],
        nextCursor: null,
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(listData));

      const result = await client.listPromotions('dev-jwt-token');

      expect(result.promotions).toHaveLength(1);
      expect(result.promotions[0].promotionId).toBe(PROMOTION_ID);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3000/studio/promotions');
      expect(init.method).toBeUndefined(); // GET default
      expect(init.headers['Authorization']).toBe('Bearer dev-jwt-token');
    });

    it('serializes only explicitly supplied page fields', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ promotions: [], nextCursor: null }));

      await client.listPromotions('dev-jwt-token', {
        limit: 1,
      });

      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/studio/promotions?limit=1');
    });

    it('rejects an invalid page query before making a request', async () => {
      await expect(client.listPromotions('dev-jwt-token', { limit: 101 })).rejects.toThrow(
        /integer from 1 through 100/,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a non-current promotion list success body', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          promotions: [
            {
              promotionId: PROMOTION_ID,
              displayName: 'Test Promo',
              type: 'unknown_kind',
              status: 'active',
              canClaim: true,
              canUseSponsoredAction: false,
              promotionRemainingBudgetMist: '100',
              remainingParticipantSlots: 1,
              userRemainingGasAllowanceMist: null,
              unavailableReason: 'not_claimed',
            },
          ],
          nextCursor: null,
        }),
      );

      await expect(client.listPromotions('dev-jwt-token')).rejects.toThrow(
        /PromotionListResponse\.promotions\[0\]\.type is not current/,
      );
    });
  });

  // ─────────────────────────────────────────
  // getPromotionDetail
  // ─────────────────────────────────────────

  describe('getPromotionDetail', () => {
    it('sends GET with correct path and Authorization header', async () => {
      const detailData = {
        promotionId: 'p1',
        displayName: 'Test',
        type: 'gas_sponsorship',
        promotionRemainingBudgetMist: '50000000',
        detail: {
          claimStatus: 'claimed',
          userRemainingGasAllowanceMist: '25000000',
          claimDeadlineAt: null,
          useUntilAt: null,
          canClaim: false,
          canUseSponsoredAction: true,
          unavailableReason: null,
        },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(detailData));

      const result = await client.getPromotionDetail('p1', 'dev-jwt');

      expect(result.promotionId).toBe('p1');
      expect(result.detail.claimStatus).toBe('claimed');
      expect(result.detail.canUseSponsoredAction).toBe(true);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3000/studio/promotions/p1');
      expect(init.headers['Authorization']).toBe('Bearer dev-jwt');
    });

    it('rejects non-canonical MIST in a promotion detail success body', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          promotionId: 'p1',
          displayName: 'Test',
          type: 'gas_sponsorship',
          promotionRemainingBudgetMist: '01',
          detail: {
            claimStatus: 'not_claimed',
            userRemainingGasAllowanceMist: null,
            claimDeadlineAt: null,
            useUntilAt: null,
            canClaim: true,
            canUseSponsoredAction: false,
            unavailableReason: 'not_claimed',
          },
        }),
      );

      await expect(client.getPromotionDetail('p1', 'dev-jwt')).rejects.toThrow(
        /promotionRemainingBudgetMist must be a canonical non-negative decimal string/,
      );
    });
  });
});

// ─────────────────────────────────────────
// Standalone promotion discovery helpers
// ─────────────────────────────────────────

describe('Standalone promotion helpers', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('listAvailablePromotions creates client and calls listPromotions', async () => {
    const { listAvailablePromotions } = await import('../src/index.js');
    mockFetch.mockResolvedValueOnce(jsonResponse({ promotions: [], nextCursor: null }));

    const result = await listAvailablePromotions('http://localhost:3200', 'dev-jwt', {
      cursor: PROMOTION_ID,
      limit: 1,
    });

    expect(result.promotions).toEqual([]);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`http://localhost:3200/studio/promotions?cursor=${PROMOTION_ID}&limit=1`);
    expect(init.headers['Authorization']).toBe('Bearer dev-jwt');
  });

  it('listAvailablePromotions strips /relay suffix from baseUrl', async () => {
    const { listAvailablePromotions } = await import('../src/index.js');
    mockFetch.mockResolvedValueOnce(jsonResponse({ promotions: [], nextCursor: null }));

    await listAvailablePromotions('http://localhost:3200/relay', 'u');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('http://localhost:3200/studio/promotions');
  });

  it('getPromotionUserState creates client and calls getPromotionDetail', async () => {
    const { getPromotionUserState } = await import('../src/index.js');
    const detailData = {
      promotionId: 'p1',
      displayName: 'Test',
      type: 'gas_sponsorship',
      promotionRemainingBudgetMist: '100',
      detail: {
        claimStatus: 'not_claimed',
        userRemainingGasAllowanceMist: null,
        claimDeadlineAt: null,
        useUntilAt: null,
        canClaim: true,
        canUseSponsoredAction: false,
        unavailableReason: 'not_claimed',
      },
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(detailData));

    const result = await getPromotionUserState('http://localhost:3200', 'p1', 'u');

    expect(result.promotionId).toBe('p1');
    expect(result.detail.canClaim).toBe(true);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('http://localhost:3200/studio/promotions/p1');
  });
});
