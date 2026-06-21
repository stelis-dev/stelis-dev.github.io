/**
 * [app-api] Client IP resolution — host-layer utility.
 *
 * Adapts Hono's Context to core-api's resolveClientIp interface.
 * Uses resolveClientIp and parseTrustedProxyHops from @stelis/core-api.
 */
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { resolveClientIp, parseTrustedProxyHops } from '@stelis/core-api';

export interface ClientIpSource {
  directIp: string | null;
}

export type ClientIpSourceProvider = (c: Context) => ClientIpSource;

function getNodeServerClientIpSource(c: Context): ClientIpSource {
  try {
    const connInfo = getConnInfo(c);
    return { directIp: connInfo.remote.address ?? null };
  } catch {
    // getConnInfo may throw in non-node-server environments (e.g. test mocks)
    return { directIp: null };
  }
}

let runtimeClientIpSourceProvider: ClientIpSourceProvider = getNodeServerClientIpSource;

export function setClientIpSourceProviderForRuntime(provider: ClientIpSourceProvider): void {
  runtimeClientIpSourceProvider = provider;
}

export function resetClientIpSourceProviderForRuntime(): void {
  runtimeClientIpSourceProvider = getNodeServerClientIpSource;
}

/**
 * Resolve client IP from Hono request context.
 *
 * Uses the active runtime source provider for directIp, combined with
 * x-forwarded-for and TRUSTED_PROXY_HOPS config.
 *
 * When TRUSTED_PROXY_HOPS=0 (no proxy), directIp is the actual client.
 * When behind a proxy, XFF chain is trusted up to the configured depth.
 */
export function getClientIp(c: Context): string {
  const trustedProxyHops = parseTrustedProxyHops(process.env.TRUSTED_PROXY_HOPS);
  const { directIp } = runtimeClientIpSourceProvider(c);

  return resolveClientIp(
    {
      header: (name: string) => c.req.header(name) ?? undefined,
    },
    {
      directIp,
      trustedProxyHops,
    },
  );
}
