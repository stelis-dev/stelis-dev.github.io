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
import type { AdminRedisClient } from '@stelis/core-api/admin';
import type { AppApiContext } from './context.js';
import { createAdminRedisAdapter } from './adminRedis.js';

/** Unified not_before key for app-api. */
export const NOT_BEFORE_KEY = 'stelis:app-api:admin:not_before';

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
  getCtx: () => Promise<AppApiContext>,
): Promise<AdminSession | null> {
  try {
    return await requireAdminSession(c, createAdminRedisAdapter((await getCtx()).redis));
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
): Promise<AdminSession | null> {
  try {
    // Extract token from cookie
    const cookieHeader = c.req.header('cookie') ?? '';
    const match = cookieHeader.match(new RegExp(`(?:^|;)\\s*${ADMIN_COOKIE}=([^;]+)`));
    const token = match?.[1];
    if (!token) return null;

    const session = await verifyAdminJwt(token);
    if (!session) return null;
    // iat, exp, and iatMs are already validated as finite numbers by verifyAdminJwt

    const raw = await redis.get(NOT_BEFORE_KEY);

    // fail-closed: key missing → reject (boot sets this key at startup)
    if (raw == null) {
      if (!_keyMissingWarned) {
        _keyMissingWarned = true;
        // eslint-disable-next-line no-console
        console.error(
          `[admin] Redis key "${NOT_BEFORE_KEY}" is missing. ` +
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
