import { describe, expect, it, vi } from 'vitest';
import type { FetchLike, StelisMcpServerConfig } from '../src/config.js';
import { resolveRelayApiUrl } from '../src/http.js';
import {
  getRelayApiConfig,
  listPromotions,
  preparePromotionSponsoredTransaction,
  prepareSponsoredTransaction,
  submitPromotionSponsoredTransaction,
} from '../src/operations.js';

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
});
