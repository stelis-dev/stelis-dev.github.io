/**
 * [app-api] Auth routes — /auth/nonce, /auth/verify, /auth/renew, /auth/logout, /auth/session
 *
 * Admin wallet-based authentication using core-api/admin DI functions.
 * Cookie = `stelis_admin`; Redis not-before key = `stelis:app-api:admin:not_before`.
 *
 * Uses verifyAdminSignature and admin rate limiting from core-api/admin.
 * Host: signAdminJwt, verifyAdminJwt, cookie builders from src/adminAuth.ts
 */
import { Hono } from 'hono';
import { readJsonBodyWithLimit, MAX_SMALL_REQUEST_BODY_BYTES } from '@stelis/core-api';
import {
  verifyAdminSignature,
  checkAndIncrement,
  resetAttempts,
  type AdminRedisClient,
} from '@stelis/core-api/admin';
import {
  ADMIN_AUTH_LOGOUT_ERROR_CODES,
  ADMIN_AUTH_NONCE_ERROR_CODES,
  ADMIN_AUTH_VERIFY_ERROR_CODES,
  ADMIN_SESSION_ERROR_CODES,
  HostWireParseError,
  parseAdminAuthChallengeResponse,
  parseAdminAuthSuccessResponse,
  parseAdminAuthVerifyRequest,
  parseAdminSessionResponse,
  type HostErrorCode,
} from '@stelis/contracts';
import type { AppApiContext } from '../context.js';
import { createAdminRedisAdapter } from '../adminRedis.js';
import {
  signAdminJwt,
  buildAuthCookieHeader,
  buildLogoutCookieHeader,
  type AdminAuthRuntimeConfig,
} from '../adminAuth.js';
import { requireAdminSessionFromContext } from '../requireAdminSession.js';
import type { ResolveClientIp } from '../clientIp.js';
import { writeAdminAuditLog } from '../adminAuditLog.js';
import { safeErrorSummary } from '@stelis/core-api/observability';
import { raiseAppApiAdminSessionNotBefore } from '../adminSessionNotBefore.js';
import { codedHostError, mapError, respondMapped } from '../errorMap.js';
import { formatRetryAfterSeconds } from '../retryAfter.js';

const NONCE_TTL_MS = 60_000;

export interface AuthRoutesRuntime {
  readonly resolveClientIp: ResolveClientIp;
  readonly adminAddress: string | null;
  readonly adminAuth: AdminAuthRuntimeConfig;
}

async function getAdminRedis(contextPromise: Promise<AppApiContext>): Promise<AdminRedisClient> {
  return createAdminRedisAdapter((await contextPromise).redis);
}

function configuredAdminAuth(runtime: AuthRoutesRuntime) {
  if (runtime.adminAddress === null || runtime.adminAuth.jwt === null) {
    return null;
  }
  return {
    adminAddress: runtime.adminAddress,
    jwt: runtime.adminAuth.jwt,
  };
}

class AdminAuthRequestContractError extends Error {
  constructor() {
    super('Admin auth request does not match the current Host wire contract');
    this.name = 'AdminAuthRequestContractError';
  }
}

function parseAdminAuthRequest(value: unknown) {
  try {
    return parseAdminAuthVerifyRequest(value);
  } catch (err) {
    if (err instanceof HostWireParseError) throw new AdminAuthRequestContractError();
    throw err;
  }
}

function respondAuthFailure(
  c: Parameters<typeof respondMapped>[0],
  err: unknown,
  allowedCodes: readonly HostErrorCode[],
): Response {
  if (err instanceof AdminAuthRequestContractError && allowedCodes.includes('BAD_REQUEST')) {
    return respondMapped(c, codedHostError('BAD_REQUEST', allowedCodes));
  }
  const mapped = mapError(err, allowedCodes, 'INTERNAL_ERROR');
  if (mapped) return respondMapped(c, mapped);
  return respondMapped(c, codedHostError('INTERNAL_ERROR', allowedCodes));
}

export function createAuthRoutes(
  contextPromise: Promise<AppApiContext>,
  runtime: AuthRoutesRuntime,
) {
  const app = new Hono();

  // ── POST /auth/nonce ───────────────────────────────────────────────
  app.post('/nonce', async (c) => {
    try {
      if (configuredAdminAuth(runtime) === null) {
        return respondMapped(c, codedHostError('ADMIN_UNAVAILABLE', ADMIN_AUTH_NONCE_ERROR_CODES));
      }
      const redis = await getAdminRedis(contextPromise);
      const ip = runtime.resolveClientIp(c);

      const rateCheck = await checkAndIncrement(redis, ip);
      if (!rateCheck.allowed) {
        return respondMapped(
          c,
          codedHostError(
            'RATE_LIMITED',
            ADMIN_AUTH_NONCE_ERROR_CODES,
            {
              retryAfterMs: rateCheck.retryAfterMs,
            },
            {
              'Retry-After': formatRetryAfterSeconds(rateCheck.retryAfterMs),
            },
          ),
        );
      }

      const nonce = `stelis-admin-login:${crypto.randomUUID()}:${Date.now()}`;
      await redis.set(`stelis:admin:nonce:${nonce}`, '1', { px: NONCE_TTL_MS });
      return c.json(parseAdminAuthChallengeResponse({ nonce }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[app-api] /auth/nonce failed', safeErrorSummary(err));
      return respondAuthFailure(c, err, ADMIN_AUTH_NONCE_ERROR_CODES);
    }
  });

  // ── POST /auth/verify ──────────────────────────────────────────────
  app.post('/verify', async (c) => {
    let ip: string | null = null;
    try {
      const configuredAuth = configuredAdminAuth(runtime);
      if (configuredAuth === null) {
        return respondMapped(c, codedHostError('ADMIN_UNAVAILABLE', ADMIN_AUTH_VERIFY_ERROR_CODES));
      }
      const redis = await getAdminRedis(contextPromise);
      ip = runtime.resolveClientIp(c);
      // Atomic rate-limit check at entry — counts all verify attempts
      const rateCheck = await checkAndIncrement(redis, ip);
      if (!rateCheck.allowed) {
        await writeAdminAuditLog(redis, { event: 'ADMIN_LOGIN_RATE_LIMITED', ip });
        return respondMapped(
          c,
          codedHostError(
            'RATE_LIMITED',
            ADMIN_AUTH_VERIFY_ERROR_CODES,
            {
              retryAfterMs: rateCheck.retryAfterMs,
            },
            {
              'Retry-After': formatRetryAfterSeconds(rateCheck.retryAfterMs),
            },
          ),
        );
      }

      const body = parseAdminAuthRequest(
        await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES),
      );
      const { nonce, signature, address } = body;

      // Verify signature + check address matches ADMIN_ADDRESS
      const valid = await verifyAdminSignature({
        nonce,
        signature,
        address,
        adminAddress: configuredAuth.adminAddress,
      });
      if (!valid) {
        await writeAdminAuditLog(redis, {
          event: 'ADMIN_LOGIN_FAILED',
          reason: 'bad_signature',
          ip,
          address,
        });
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAUTHORIZED', ADMIN_AUTH_VERIFY_ERROR_CODES),
        );
      }

      // Verify first, then atomically consume. Concurrent valid requests can
      // both verify, but only one DEL can win the single-use nonce.
      const nonceKey = `stelis:admin:nonce:${nonce}`;
      const deleted = await redis.del(nonceKey);
      if (deleted === 0) {
        await writeAdminAuditLog(redis, {
          event: 'ADMIN_LOGIN_FAILED',
          reason: 'invalid_nonce',
          ip,
          address,
        });
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAUTHORIZED', ADMIN_AUTH_VERIFY_ERROR_CODES),
        );
      }

      // Success — complete all fallible work before staging the cookie.
      // Hono preserves staged headers even on catch-path 500 responses,
      // so Set-Cookie must only be set right before the final return.
      const token = await signAdminJwt(address, configuredAuth.jwt);
      const cookie = buildAuthCookieHeader(token, runtime.adminAuth.cookie);
      await resetAttempts(redis, ip);
      await writeAdminAuditLog(redis, { event: 'ADMIN_LOGIN_SUCCESS', ip, address });
      c.header('Set-Cookie', cookie);
      return c.json(parseAdminAuthSuccessResponse({ ok: true }));
    } catch (err) {
      try {
        if (ip !== null) {
          const r = await getAdminRedis(contextPromise);
          await writeAdminAuditLog(r, {
            event: 'ADMIN_LOGIN_ERROR',
            ip,
            error: safeErrorSummary(err),
          });
        }
      } catch {
        /* Redis unavailable — audit log best-effort */
      }
      return respondAuthFailure(c, err, ADMIN_AUTH_VERIFY_ERROR_CODES);
    }
  });

  // ── POST /auth/renew ───────────────────────────────────────────────
  app.post('/renew', async (c) => {
    let ip: string | null = null;
    try {
      const configuredAuth = configuredAdminAuth(runtime);
      if (configuredAuth === null) {
        return respondMapped(c, codedHostError('ADMIN_UNAVAILABLE', ADMIN_AUTH_VERIFY_ERROR_CODES));
      }
      const redis = await getAdminRedis(contextPromise);
      ip = runtime.resolveClientIp(c);
      // Atomic rate-limit check at entry — counts all renew attempts
      const rateCheck = await checkAndIncrement(redis, ip);
      if (!rateCheck.allowed) {
        await writeAdminAuditLog(redis, { event: 'ADMIN_RENEW_RATE_LIMITED', ip });
        return respondMapped(
          c,
          codedHostError(
            'RATE_LIMITED',
            ADMIN_AUTH_VERIFY_ERROR_CODES,
            {
              retryAfterMs: rateCheck.retryAfterMs,
            },
            {
              'Retry-After': formatRetryAfterSeconds(rateCheck.retryAfterMs),
            },
          ),
        );
      }

      const body = parseAdminAuthRequest(
        await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES),
      );
      const { nonce, signature, address } = body;

      const valid = await verifyAdminSignature({
        nonce,
        signature,
        address,
        adminAddress: configuredAuth.adminAddress,
      });
      if (!valid) {
        await writeAdminAuditLog(redis, {
          event: 'ADMIN_RENEW_FAILED',
          reason: 'bad_signature',
          ip,
          address,
        });
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAUTHORIZED', ADMIN_AUTH_VERIFY_ERROR_CODES),
        );
      }

      const nonceKey = `stelis:admin:nonce:${nonce}`;
      const deleted = await redis.del(nonceKey);
      if (deleted === 0) {
        await writeAdminAuditLog(redis, {
          event: 'ADMIN_RENEW_FAILED',
          reason: 'invalid_nonce',
          ip,
          address,
        });
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAUTHORIZED', ADMIN_AUTH_VERIFY_ERROR_CODES),
        );
      }

      // Success — complete all fallible work before staging the cookie.
      const token = await signAdminJwt(address, configuredAuth.jwt);
      const cookie = buildAuthCookieHeader(token, runtime.adminAuth.cookie);
      await resetAttempts(redis, ip);
      await writeAdminAuditLog(redis, { event: 'ADMIN_RENEW_SUCCESS', ip, address });
      c.header('Set-Cookie', cookie);
      return c.json(parseAdminAuthSuccessResponse({ ok: true }));
    } catch (err) {
      try {
        if (ip !== null) {
          const r = await getAdminRedis(contextPromise);
          await writeAdminAuditLog(r, {
            event: 'ADMIN_RENEW_ERROR',
            ip,
            error: safeErrorSummary(err),
          });
        }
      } catch {
        /* Redis unavailable — audit log best-effort */
      }
      return respondAuthFailure(c, err, ADMIN_AUTH_VERIFY_ERROR_CODES);
    }
  });

  // ── POST /auth/logout ──────────────────────────────────────────────
  app.post('/logout', async (c) => {
    try {
      const session = await requireAdminSessionFromContext(
        c,
        contextPromise,
        runtime.adminAuth.jwt,
      );
      if (!session) {
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAUTHORIZED', ADMIN_AUTH_LOGOUT_ERROR_CODES),
        );
      }

      const redis = await getAdminRedis(contextPromise);
      await raiseAppApiAdminSessionNotBefore(redis, Math.max(Date.now(), session.iatMs + 1));
      c.header('Set-Cookie', buildLogoutCookieHeader(runtime.adminAuth.cookie));
      return c.json(parseAdminAuthSuccessResponse({ ok: true }));
    } catch (err) {
      // Do not expire the cookie or claim success until the durable cutoff is raised.
      console.error('[app-api] /auth/logout failed', safeErrorSummary(err)); // eslint-disable-line no-console
      return respondAuthFailure(c, err, ADMIN_AUTH_LOGOUT_ERROR_CODES);
    }
  });

  // ── GET /auth/session ──────────────────────────────────────────────
  app.get('/session', async (c) => {
    // JWT + Redis not_before guard (fail-closed)
    const session = await requireAdminSessionFromContext(c, contextPromise, runtime.adminAuth.jwt);
    if (!session) {
      return respondMapped(c, codedHostError('ADMIN_UNAUTHORIZED', ADMIN_SESSION_ERROR_CODES));
    }

    return c.json(
      parseAdminSessionResponse({
        address: session.address,
        exp: session.exp,
        iat: session.iat,
      }),
    );
  });

  return app;
}
