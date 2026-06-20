import { describe, expect, it, vi } from 'vitest';
import type { FetchLike, StelisMcpServerConfig } from '../src/config.js';
import { resolveRelayUrl } from '../src/http.js';
import {
  getRelayConfig,
  listPromotions,
  prepareSponsoredTransaction,
  submitPromotionSponsoredTransaction,
} from '../src/operations.js';

function createConfig(fetchFn: FetchLike): StelisMcpServerConfig {
  return {
    defaultRelayUrl: 'https://host.example/relay',
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

describe('resolveRelayUrl', () => {
  it('normalizes a relay URL and strips query/hash/trailing slash', () => {
    const config: StelisMcpServerConfig = {
      defaultRelayUrl: 'https://host.example/relay/?x=1#frag',
      defaultTimeoutMs: 1000,
    };
    expect(resolveRelayUrl(config)).toBe('https://host.example/relay');
  });

  it('rejects non-relay base URLs', () => {
    const config: StelisMcpServerConfig = {
      defaultRelayUrl: 'https://host.example',
      defaultTimeoutMs: 1000,
    };
    expect(() => resolveRelayUrl(config)).toThrow(/ending in \/relay/);
  });
});

describe('Stelis MCP operations', () => {
  it('reads relay config from GET /relay/config', async () => {
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ network: 'testnet' }));
    const result = await getRelayConfig(createConfig(fetchFn), {});

    expect(result).toEqual({ network: 'testnet' });
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
      }),
    );

    await prepareSponsoredTransaction(createConfig(fetchFn), {
      relayUrl: 'https://override.example/relay',
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
    const fetchFn = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ digest: 'abc' }));

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
});
