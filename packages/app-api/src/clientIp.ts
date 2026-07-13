/**
 * [app-api] Client IP resolution — host-layer utility.
 *
 * Adapts Hono's Context to core-api's resolveClientIp interface.
 * The proxy-hop policy is parsed by boot and injected here once.
 */
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { resolveClientIp } from '@stelis/core-api';

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

export type ResolveClientIp = (c: Context) => string;

/**
 * Resolve client IP from Hono request context.
 *
 * Uses the injected runtime source provider for directIp, combined with
 * x-forwarded-for and the boot-snapshotted proxy-hop count.
 *
 * When TRUSTED_PROXY_HOPS=0 (no proxy), directIp is the actual client.
 * When behind a proxy, XFF chain is trusted up to the configured depth.
 */
export function createClientIpResolver(
  trustedProxyHops: number,
  sourceProvider: ClientIpSourceProvider = getNodeServerClientIpSource,
): ResolveClientIp {
  return (c) => {
    const { directIp } = sourceProvider(c);
    return resolveClientIp(
      {
        header: (name: string) => c.req.header(name) ?? undefined,
      },
      {
        directIp,
        trustedProxyHops,
      },
    );
  };
}
