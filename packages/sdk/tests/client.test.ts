import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StelisClient, StelisApiException } from '../src/client.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
          prepareMs: 2222,
          sponsorMs: 3333,
          studioReadMs: 4444,
          studioWriteMs: 5555,
        },
      });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ ok: true })) // getStatus
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
        .mockResolvedValueOnce(jsonResponse({ promotions: [] })) // listPromotions
        .mockResolvedValueOnce(
          jsonResponse({ txBytes: 'b64', receiptId: 'r1', estimatedGasMist: '1000' }),
        ); // promotionPrepare

      await c.getStatus();
      await c.prepare({
        txKindBytes: 'k',
        senderAddress: '0x' + 'a'.repeat(64),
        settlementTokenType: '0x2::sui::SUI',
      });
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
      expect(timeoutSpy).toHaveBeenNthCalledWith(2, 2222);
      expect(timeoutSpy).toHaveBeenNthCalledWith(3, 3333);
      expect(timeoutSpy).toHaveBeenNthCalledWith(4, 4444);
      expect(timeoutSpy).toHaveBeenNthCalledWith(5, 5555);
      timeoutSpy.mockRestore();
    });

    it('rejects invalid timeout overrides', () => {
      expect(
        () =>
          new StelisClient({
            endpoint: 'http://localhost:3000/relay',
            requestTimeouts: { sponsorMs: 0 },
          }),
      ).toThrow('requestTimeouts.sponsorMs must be a positive integer');
      expect(
        () =>
          new StelisClient({
            endpoint: 'http://localhost:3000/relay',
            requestTimeouts: { sponsorMs: Number.MAX_SAFE_INTEGER + 1 },
          }),
      ).toThrow('Number.MAX_SAFE_INTEGER');
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

      const result = await client.prepare({
        txKindBytes: 'base64kind',
        senderAddress: '0xAlice',
        settlementTokenType: 'DEEP',
      });

      expect(result.txBytes).toBe('base64txbytes');
      expect(result.receiptId).toBe('0x7a3f');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3000/relay/prepare');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        txKindBytes: 'base64kind',
        senderAddress: '0xAlice',
        settlementTokenType: 'DEEP',
      });
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

      const result = await client.prepare({
        txKindBytes: 'base64kind',
        senderAddress: '0xAlice',
        settlementTokenType: 'DEEP',
        orderId: 'test-123',
      });

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
    it('throws StelisApiException on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Insufficient claim', code: 'INSUFFICIENT_CLAIM' }, 400),
      );

      await expect(client.getStatus()).rejects.toThrow(StelisApiException);

      try {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({ error: 'Not found', code: 'NOT_FOUND' }, 404),
        );
        await client.getStatus();
      } catch (e) {
        const err = e as StelisApiException;
        expect(err.code).toBe('NOT_FOUND');
        expect(err.status).toBe(404);
      }
    });

    it('throws StelisApiException with raw body snippet on non-JSON error response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('A server error occurred while processing this request.', {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'Content-Type': 'text/plain' },
        }),
      );

      try {
        await client.getStatus();
        expect.fail('Expected StelisApiException');
      } catch (e) {
        const err = e as StelisApiException;
        expect(err).toBeInstanceOf(StelisApiException);
        expect(err.code).toBe('UNKNOWN');
        expect(err.status).toBe(500);
        expect(err.message).toContain('A server error occurred');
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
        /Invalid non-JSON response from Relay API: <html>ok<\/html>/,
      );
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

    it('throws StelisApiException on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'Not claimed', code: 'NOT_CLAIMED' }, 403),
      );

      try {
        await client.promotionPrepare(
          'promo_1',
          { senderAddress: '0xA', txKindBytes: 'b64' },
          'jwt',
        );
        expect.fail('Expected StelisApiException');
      } catch (e) {
        const err = e as StelisApiException;
        expect(err).toBeInstanceOf(StelisApiException);
        expect(err.code).toBe('NOT_CLAIMED');
        expect(err.status).toBe(403);
      }
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
            promotionId: 'p1',
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
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(listData));

      const result = await client.listPromotions('dev-jwt-token');

      expect(result.promotions).toHaveLength(1);
      expect(result.promotions[0].promotionId).toBe('p1');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3000/studio/promotions');
      expect(init.method).toBeUndefined(); // GET default
      expect(init.headers['Authorization']).toBe('Bearer dev-jwt-token');
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
    mockFetch.mockResolvedValueOnce(jsonResponse({ promotions: [] }));

    const result = await listAvailablePromotions('http://localhost:3200', 'dev-jwt');

    expect(result.promotions).toEqual([]);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3200/studio/promotions');
    expect(init.headers['Authorization']).toBe('Bearer dev-jwt');
  });

  it('listAvailablePromotions strips /relay suffix from baseUrl', async () => {
    const { listAvailablePromotions } = await import('../src/index.js');
    mockFetch.mockResolvedValueOnce(jsonResponse({ promotions: [] }));

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
