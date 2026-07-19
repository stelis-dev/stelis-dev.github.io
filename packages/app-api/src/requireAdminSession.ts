/**
 * [app-api] Admin session guard — JWT + Redis not_before check.
 *
 * Enforcement:
 *   - Cookie: `stelis_admin` (from adminAuth.ts)
 *   - Redis not_before key: `stelis:app-api:admin:not_before`
 *   - Fail-closed: any verification failure → null
 *
 */
import type { Context } from 'hono';
import { ADMIN_COOKIE, verifyAdminJwt } from './adminAuth.js';
import type { AdminJwtConfig, AdminRedisClient } from '@stelis/core-api/admin';
import type { RelayAndStudioAppApiContext } from './context.js';
import { createAdminRedisAdapter } from './adminRedis.js';
import { ADMIN_SESSION_NOT_BEFORE_KEY } from './adminSessionNotBefore.js';

/** One-shot flag to avoid log spam when Redis key is missing. */
let _keyMissingWarned = false;

export interface AdminSession {
  address: string;
  iat: number;
  exp: number;
  iatMs: number;
}

export async function requireAdminSessionFromContext(
  c: Context,
  context: RelayAndStudioAppApiContext,
  jwtConfig: AdminJwtConfig,
): Promise<AdminSession | null> {
  try {
    return await requireAdminSession(c, createAdminRedisAdapter(context.redis), jwtConfig);
  } catch {
    return null;
  }
}

/**
 * Verify JWT signature + iatMs/exp finite + Redis not_before timestamp (ms).
 * Returns null on any failure (fail-closed).
 */
export async function requireAdminSession(
  c: Context,
  redis: AdminRedisClient,
  jwtConfig: AdminJwtConfig,
): Promise<AdminSession | null> {
  try {
    // Extract token from cookie
    const cookieHeader = c.req.header('cookie') ?? '';
    const match = cookieHeader.match(new RegExp(`(?:^|;)\\s*${ADMIN_COOKIE}=([^;]+)`));
    const token = match?.[1];
    if (!token) return null;

    const session = await verifyAdminJwt(token, jwtConfig);
    if (!session) return null;
    // iat, exp, and iatMs are already validated as finite numbers by verifyAdminJwt

    const raw = await redis.get(ADMIN_SESSION_NOT_BEFORE_KEY);

    // fail-closed: key missing → reject (boot sets this key at startup)
    if (raw == null) {
      if (!_keyMissingWarned) {
        _keyMissingWarned = true;
        // eslint-disable-next-line no-console
        console.error(
          `[admin] Redis key "${ADMIN_SESSION_NOT_BEFORE_KEY}" is missing. ` +
            'All admin sessions will be rejected until server restart.',
        );
      }
      return null;
    }

    // strict integer validation — parseInt('123abc')=123 prevention
    if (!/^\d+$/.test(raw)) return null;
    const notBefore = Number(raw);
    if (!Number.isSafeInteger(notBefore)) return null;
    if (session.iatMs < notBefore) return null;

    return session;
  } catch {
    // Redis connection failure etc. → fail-closed
    return null;
  }
}
