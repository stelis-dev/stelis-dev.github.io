import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { ClientIpResolutionError } from '@stelis/core-api';
import {
  getClientIp,
  resetClientIpSourceProviderForRuntime,
  setClientIpSourceProviderForRuntime,
} from '../src/clientIp.js';

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
  afterEach(() => {
    resetClientIpSourceProviderForRuntime();
    vi.unstubAllEnvs();
  });

  it('keeps the default node-server source fail-closed when no socket IP is available', () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '0');

    expect(() => getClientIp(contextWithHeaders())).toThrow(ClientIpResolutionError);
  });

  it('uses the injected runtime source provider without changing route call sites', () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '0');
    setClientIpSourceProviderForRuntime(() => ({ directIp: '203.0.113.10' }));

    expect(getClientIp(contextWithHeaders())).toBe('203.0.113.10');
  });

  it('preserves the platform-neutral trusted proxy chain path', () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
    setClientIpSourceProviderForRuntime(() => ({ directIp: null }));

    expect(getClientIp(contextWithHeaders({ 'x-forwarded-for': '203.0.113.10, 10.0.0.5' }))).toBe(
      '203.0.113.10',
    );
  });
});
