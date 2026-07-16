import { isIP } from 'node:net';

export interface HeaderValueReader {
  header(name: string): string | undefined;
}

export interface ClientIpResolutionOptions {
  directIp?: string | null;
  trustedProxyHops?: number;
}

export class ClientIpResolutionError extends Error {
  public readonly code = 'CLIENT_IP_UNRESOLVED';

  constructor(message: string) {
    super(message);
    this.name = 'ClientIpResolutionError';
  }
}

/**
 * Canonicalize one IP address without applying any trusted-proxy policy.
 *
 * IPv6 zone identifiers are socket-local routing metadata, not part of the
 * external client identity. The complete input must still be a valid IP
 * address, but only the canonical address portion is returned.
 */
export function canonicalizeIpAddress(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') return null;
  const version = isIP(trimmed);
  if (version === 0) return null;
  if (version === 4) return trimmed;

  const zoneIndex = trimmed.indexOf('%');
  const address = zoneIndex === -1 ? trimmed : trimmed.slice(0, zoneIndex);
  try {
    const hostname = new URL(`http://[${address}]/`).hostname;
    if (!hostname.startsWith('[') || !hostname.endsWith(']')) return null;
    return hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/**
 * Resolve the effective client IP from direct socket information or XFF.
 *
 * Security model:
 * - `trustedProxyHops=0` means "do not trust X-Forwarded-For".
 * - `trustedProxyHops>0` means "trust exactly N proxy hops" and take the
 *   client IP from the XFF chain by counting from the right.
 * - If no valid client IP can be resolved, throw `ClientIpResolutionError`
 *   before callers reach shared abuse/rate-limit keys.
 */
export function resolveClientIp(
  headers: HeaderValueReader,
  options: ClientIpResolutionOptions = {},
): string {
  const trustedProxyHops = options.trustedProxyHops ?? 0;

  if (trustedProxyHops === 0) {
    const directIp = canonicalizeIpAddress(options.directIp);
    if (!directIp) {
      throw new ClientIpResolutionError('Client IP could not be resolved from socket address');
    }
    return directIp;
  }

  const xff = headers.header('x-forwarded-for');
  if (!xff) {
    throw new ClientIpResolutionError(
      'Client IP could not be resolved from X-Forwarded-For header',
    );
  }

  const chain = xff.split(',').map((part) => part.trim());
  if (chain.some((part) => canonicalizeIpAddress(part) === null)) {
    throw new ClientIpResolutionError(
      'Client IP could not be resolved from the trusted proxy chain',
    );
  }

  const clientIndex = chain.length - (trustedProxyHops + 1);
  if (clientIndex < 0) {
    throw new ClientIpResolutionError(
      'Client IP could not be resolved from the trusted proxy chain',
    );
  }

  const clientIp = canonicalizeIpAddress(chain[clientIndex]);
  if (!clientIp) {
    throw new ClientIpResolutionError(
      'Client IP could not be resolved from the trusted proxy chain',
    );
  }
  return clientIp;
}

/**
 * Parse trusted proxy hops from runtime configuration.
 *
 * Canonical form:
 * - `TRUSTED_PROXY_HOPS=<N>`
 */
export function parseTrustedProxyHops(trustedProxyHops: string | null | undefined): number {
  const raw = trustedProxyHops?.trim();
  if (raw) {
    if (!/^\d+$/.test(raw)) {
      throw new Error(
        `TRUSTED_PROXY_HOPS must be a non-negative integer, got '${trustedProxyHops}'`,
      );
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(
        `TRUSTED_PROXY_HOPS must be a non-negative integer, got '${trustedProxyHops}'`,
      );
    }
    return parsed;
  }

  return 0;
}
