import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import { getVercelClientIpSource } from '../src/vercelClientIp.js';

function contextWithHeaders(headers: Record<string, string | undefined> = {}): Context {
  return {
    req: {
      header(name: string) {
        return headers[name.toLowerCase()];
      },
    },
  } as Context;
}

describe('Vercel client IP source provider', () => {
  it('uses the Vercel-overwritten x-forwarded-for value as direct source input', () => {
    expect(
      getVercelClientIpSource(contextWithHeaders({ 'x-forwarded-for': '203.0.113.10' })),
    ).toEqual({ directIp: '203.0.113.10' });
  });

  it('fails closed through the shared resolver when the Vercel header is absent', () => {
    expect(getVercelClientIpSource(contextWithHeaders())).toEqual({ directIp: null });
  });
});
