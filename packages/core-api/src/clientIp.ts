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

function normalizeIp(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') return null;
  return isIP(trimmed) === 0 ? null : trimmed;
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
    const directIp = normalizeIp(options.directIp);
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

  const chain = xff
    .split(',')
    .map((part) => part.trim());
  if (chain.some((part) => normalizeIp(part) === null)) {
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

  const clientIp = normalizeIp(chain[clientIndex]);
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

/**
 * Normalize trust-proxy hop count input.
 */
export function normalizeTrustedProxyHops(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`trustedProxyHops must be a non-negative integer, got '${value}'`);
  }
  return value;
}
