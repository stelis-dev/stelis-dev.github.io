import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import { ClientIpResolutionError } from '@stelis/core-api';
import { createClientIpResolver } from '../src/clientIp.js';

function contextWithHeaders(headers: Record<string, string | undefined> = {}): Context {
  return {
    req: {
      header(name: string) {
        return headers[name.toLowerCase()];
      },
    },
  } as Context;
}

describe('client IP runtime source boundary', () => {
  it('keeps the default node-server source fail-closed when no socket IP is available', () => {
    const resolveClientIp = createClientIpResolver(0, () => ({ directIp: null }));

    expect(() => resolveClientIp(contextWithHeaders())).toThrow(ClientIpResolutionError);
  });

  it('uses the injected runtime source provider', () => {
    const resolveClientIp = createClientIpResolver(0, () => ({ directIp: '203.0.113.10' }));

    expect(resolveClientIp(contextWithHeaders())).toBe('203.0.113.10');
  });

  it('preserves the platform-neutral trusted proxy chain path', () => {
    const resolveClientIp = createClientIpResolver(1, () => ({ directIp: null }));

    expect(
      resolveClientIp(contextWithHeaders({ 'x-forwarded-for': '203.0.113.10, 10.0.0.5' })),
    ).toBe('203.0.113.10');
  });

  it('keeps independently created proxy-hop snapshots isolated', () => {
    const directResolver = createClientIpResolver(0, () => ({ directIp: '198.51.100.20' }));
    const oneHopProxyResolver = createClientIpResolver(1, () => ({ directIp: null }));
    const request = contextWithHeaders({
      'x-forwarded-for': '203.0.113.10, 10.0.0.5',
    });

    expect(directResolver(request)).toBe('198.51.100.20');
    expect(oneHopProxyResolver(request)).toBe('203.0.113.10');
  });
});
