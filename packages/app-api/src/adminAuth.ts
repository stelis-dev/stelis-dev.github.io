/**
 * [app-api] Admin authentication helpers — host-layer cookie + JWT config.
 *
 * Uses core-api/admin DI functions (signAdminJwt, verifyAdminJwt)
 * with app-api-specific AdminJwtConfig and cookie namespace.
 *
 * issuer = 'app-api' for blast-radius isolation
 * Cookie name = `stelis_admin` across app-api hosts
 * Not-before checks use the `stelis:app-api:admin:not_before` Redis key
 */
import {
  signAdminJwt as coreSignAdminJwt,
  verifyAdminJwt as coreVerifyAdminJwt,
  type AdminJwtConfig,
} from '@stelis/core-api/admin';

// Unified cookie name for app-api
export const ADMIN_COOKIE = 'stelis_admin';

export interface AdminCookieRuntimeConfig {
  readonly maxAgeSeconds: number;
  readonly secure: boolean;
  readonly domain: string | null;
}

export interface AdminAuthRuntimeConfig {
  readonly jwt: AdminJwtConfig;
  readonly cookie: AdminCookieRuntimeConfig;
}

export async function signAdminJwt(address: string, config: AdminJwtConfig): Promise<string> {
  return coreSignAdminJwt(address, config);
}

export async function verifyAdminJwt(
  token: string,
  config: AdminJwtConfig,
): Promise<{ address: string; iat: number; exp: number; iatMs: number } | null> {
  return coreVerifyAdminJwt(token, config);
}

export function buildAuthCookieHeader(token: string, config: AdminCookieRuntimeConfig): string {
  const secure = config.secure ? '; Secure' : '';
  // When COOKIE_DOMAIN is set (e.g. ".sample.com"), use SameSite=Lax + Domain
  // to allow cross-subdomain auth (admin.sample.com ↔ api.sample.com).
  // Otherwise, default to SameSite=Strict (same-origin only).
  const domainAttr = config.domain ? `; Domain=${config.domain}` : '';
  const sameSite = config.domain ? 'Lax' : 'Strict';
  return `${ADMIN_COOKIE}=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${config.maxAgeSeconds}${secure}${domainAttr}`;
}

export function buildLogoutCookieHeader(config: AdminCookieRuntimeConfig): string {
  const domainAttr = config.domain ? `; Domain=${config.domain}` : '';
  const sameSite = config.domain ? 'Lax' : 'Strict';
  return `${ADMIN_COOKIE}=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${domainAttr}`;
}
