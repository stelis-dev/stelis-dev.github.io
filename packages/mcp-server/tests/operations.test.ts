import { describe, expect, it, vi } from 'vitest';
import type { FetchLike, StelisMcpServerConfig } from '../src/config.js';
import { requestJson, resolveRelayApiUrl, StelisMcpHttpError } from '../src/http.js';
import {
  claimPromotion,
  getRelayApiConfig,
  listPromotions,
  preparePromotionSponsoredTransaction,
  prepareSponsoredTransaction,
  submitPromotionSponsoredTransaction,
} from '../src/operations.js';
import { RELAY_CONFIG_ERROR_CODES } from '@stelis/contracts';

function createConfig(fetchFn: FetchLike): StelisMcpServerConfig {
  return {
    defaultRelayApiUrl: 'https://host.example/relay',
    defaultTimeoutMs: 1000,
    fetchFn,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('resolveRelayApiUrl', () => {
  it('normalizes a Relay API URL and strips query/hash/trailing slash', () => {
    const config: StelisMcpServerConfig = {
      defaultRelayApiUrl: 'https://host.example/relay/?x=1#frag',
      defaultTimeoutMs: 1000,
    };
    expect(resolveRelayApiUrl(config)).toBe('https://host.example/relay');
  });

  it('rejects non-Relay API base URLs', () => {
    const config: StelisMcpServerConfig = {
      defaultRelayApiUrl: 'https://host.example',
      defaultTimeoutMs: 1000,
    };
    expect(() => resolveRelayApiUrl(config)).toThrow(/ending in \/relay/);
  });
});

describe('current Host error boundary', () => {
  it('preserves only a valid closed Host error response', async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(
        {
          error: 'Relay config unavailable',
          code: 'CONFIG_UNAVAILABLE',
        },
        503,
      ),
    );

    await expect(
      requestJson(createConfig(fetchFn), {
        path: '/config',
        allowedErrorCodes: RELAY_CONFIG_ERROR_CODES,
      }),
    ).rejects.toMatchObject({
      message: 'Relay config unavailable',
      code: 'CONFIG_UNAVAILABLE',
      body: {
        error: 'Relay config unavailable',
        code: 'CONFIG_UNAVAILABLE',
      },
    });
  });

  it('does not echo or retain a non-current remote response', async () => {
    const fetchFn = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ error: 'bad', 'sk-live-secret': 'must-not-leak' }, 500));

    try {
      await requestJson(createConfig(fetchFn), {
        path: '/config',
        allowedErrorCodes: RELAY_CONFIG_ERROR_CODES,
      });
      expect.fail('Expected StelisMcpHttpError');
    } catch (error) {
      expect(error).toBeInstanceOf(StelisMcpHttpError);
      const hostError = error as StelisMcpHttpError;
      expect(hostError.message).toBe(
        'Stelis Host returned a non-current error response (HTTP 500)',
      );
      expect(hostError.code).toBe('HTTP_ERROR');
      expect(hostError.body).toBeUndefined();
      expect(JSON.stringify(hostError)).not.toContain('must-not-leak');
      expect(JSON.stringify(hostError)).not.toContain('sk-live-secret');
    }
  });

  it('does not accept a current code on a route that cannot produce it', async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(
        {
          error: 'Prepare body invalid',
          code: 'BAD_REQUEST',
        },
        400,
      ),
    );

    await expect(
      requestJson(createConfig(fetchFn), {
        path: '/config',
        allowedErrorCodes: RELAY_CONFIG_ERROR_CODES,
      }),
    ).rejects.toMatchObject({
      message: 'Stelis Host returned a non-current error response (HTTP 400)',
      code: 'HTTP_ERROR',
      body: undefined,
    });
  });

  it('keeps Studio read and claim error ownership distinct', async () => {
    const claimFetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ error: 'Claim body invalid', code: 'BAD_REQUEST' }, 400));
    await expect(
      claimPromotion(createConfig(claimFetch), {
        developerJwt: 'jwt',
        promotionId: 'promotion',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });

    const readFetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ error: 'Wrong route', code: 'BAD_REQUEST' }, 400));
    await expect(
      listPromotions(createConfig(readFetch), { developerJwt: 'jwt' }),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR', body: undefined });
  });
});

describe('Stelis MCP operations', () => {
  it('reads Relay API config from GET /relay/config', async () => {
    const relayConfig = {
      network: 'testnet',
      packageId: '0x1',
      settlementPayoutRecipient: '0x2',
      supportedSettlementSwapPaths: [],
      quotedHostFeeMist: '1',
      protocolFlatFeeMist: '1',
    };
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(relayConfig));
    const result = await getRelayApiConfig(createConfig(fetchFn), {});

    expect(result).toEqual(relayConfig);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://host.example/relay/config',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('posts generic prepare without relay-only fields in the body', async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({
        txBytes: 'tx',
        receiptId: '0xabc',
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
        profile: 'credit_general',
        quoteTimestampMs: 1_700_000_000_000,
        policyHash: '0xabc',
      }),
    );

    await prepareSponsoredTransaction(createConfig(fetchFn), {
      relayApiUrl: 'https://override.example/relay',
      timeoutMs: 500,
      txKindBytes: 'kind',
      senderAddress: '0x1234',
      settlementTokenType: '0x2::sui::SUI',
      slippageBps: 25,
      txKindBytesHash: '0x' + '11'.repeat(32),
      prepareAuthorizationTimestampMs: 1_700_000_000_000,
      prepareAuthorizationRequestNonce: 'nonce-1',
      prepareAuthorizationSignature: 'prepare-signature',
    });

    const [, init] = fetchFn.mock.calls[0];
    expect(fetchFn.mock.calls[0][0]).toBe('https://override.example/relay/prepare');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      txKindBytes: 'kind',
      senderAddress: '0x1234',
      settlementTokenType: '0x2::sui::SUI',
      slippageBps: 25,
      txKindBytesHash: '0x' + '11'.repeat(32),
      prepareAuthorizationTimestampMs: 1_700_000_000_000,
      prepareAuthorizationRequestNonce: 'nonce-1',
      prepareAuthorizationSignature: 'prepare-signature',
    });
  });

  it('sends developer JWT only as an Authorization header for promotion reads', async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ promotions: [] }));

    await listPromotions(createConfig(fetchFn), {
      developerJwt: 'jwt-secret',
    });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://host.example/studio/promotions');
    expect(init?.headers).toEqual({ Authorization: 'Bearer jwt-secret' });
    expect(init?.body).toBeUndefined();
  });

  it('posts promotion sponsor to the studio base URL', async () => {
    const fetchFn = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ digest: 'abc', effects: {}, actualGasMist: '1' }));

    await submitPromotionSponsoredTransaction(createConfig(fetchFn), {
      developerJwt: 'jwt',
      promotionId: 'promo/1',
      receiptId: '0xabc',
      txBytes: 'tx',
      userSignature: 'sig',
    });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://host.example/studio/promotions/promo%2F1/sponsor');
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer jwt',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      receiptId: '0xabc',
      txBytes: 'tx',
      userSignature: 'sig',
    });
  });

  it('validates promotion prepare and sponsor responses at the Host boundary', async () => {
    const prepareFetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        jsonResponse({ txBytes: 'tx', receiptId: 'receipt', estimatedGasMist: '1' }),
      );
    await expect(
      preparePromotionSponsoredTransaction(createConfig(prepareFetch), {
        developerJwt: 'jwt',
        promotionId: 'promo',
        senderAddress: '0x1',
        txKindBytes: 'kind',
      }),
    ).resolves.toMatchObject({ receiptId: 'receipt' });

    const malformedSponsorFetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ digest: 'digest', effects: {} }));
    await expect(
      submitPromotionSponsoredTransaction(createConfig(malformedSponsorFetch), {
        developerJwt: 'jwt',
        promotionId: 'promo',
        receiptId: 'receipt',
        txBytes: 'tx',
        userSignature: 'signature',
      }),
    ).rejects.toThrow('actualGasMist must be a string');
  });

  it('validates promotion claim success before exposing it to a tool', async () => {
    const malformedClaimFetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({
        entitlement: {
          promotionId: 'promo',
          userId: 'user',
          claimedAt: '2026-07-14T00:00:00.000Z',
          useUntilAt: null,
          remainingGasAllowanceMist: '01',
          consumedGasAllowanceMist: '0',
          status: 'active',
          activeReservationReceiptId: null,
          activeReservationAmountMist: null,
          lastUsedAt: null,
        },
      }),
    );

    await expect(
      claimPromotion(createConfig(malformedClaimFetch), {
        developerJwt: 'jwt',
        promotionId: 'promo',
      }),
    ).rejects.toThrow(
      'PromotionEntitlement.remainingGasAllowanceMist must be a canonical non-negative decimal string',
    );
  });
});
