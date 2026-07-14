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
import {
  ClientIpResolutionError,
  readJsonBodyWithLimit,
  MAX_SMALL_REQUEST_BODY_BYTES,
} from '@stelis/core-api';
import { tryBodyErrorResponse } from '../bodyError.js';
import {
  verifyAdminSignature,
  checkAndIncrement,
  resetAttempts,
  type AdminRedisClient,
} from '@stelis/core-api/admin';
import {
  HostWireParseError,
  parseAdminAuthVerifyRequest,
  type AdminAuthChallengeResponse,
  type AdminAuthSuccessResponse,
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

const NONCE_TTL_MS = 60_000;

export interface AuthRoutesRuntime {
  readonly resolveClientIp: ResolveClientIp;
  readonly adminAddress: string | null;
  readonly adminAuth: AdminAuthRuntimeConfig;
}

async function getAdminRedis(contextPromise: Promise<AppApiContext>): Promise<AdminRedisClient> {
  return createAdminRedisAdapter((await contextPromise).redis);
}

function requireConfiguredAdminAuth(runtime: AuthRoutesRuntime) {
  if (runtime.adminAddress === null || runtime.adminAuth.jwt === null) {
    throw new Error('[app-api] admin authentication is not configured');
  }
  return {
    adminAddress: runtime.adminAddress,
    jwt: runtime.adminAuth.jwt,
  };
}

export function createAuthRoutes(
  contextPromise: Promise<AppApiContext>,
  runtime: AuthRoutesRuntime,
) {
  const app = new Hono();

  // ── POST /auth/nonce ───────────────────────────────────────────────
  app.post('/nonce', async (c) => {
    try {
      const redis = await getAdminRedis(contextPromise);
      const ip = runtime.resolveClientIp(c);

      const rateCheck = await checkAndIncrement(redis, ip);
      if (!rateCheck.allowed) {
        return c.json({ error: 'Too many requests. Try again in 15 minutes.' }, 429);
      }

      const nonce = `stelis-admin-login:${crypto.randomUUID()}:${Date.now()}`;
      await redis.set(`stelis:admin:nonce:${nonce}`, '1', { px: NONCE_TTL_MS });
      const response: AdminAuthChallengeResponse = { nonce };
      return c.json(response);
    } catch (err) {
      if (err instanceof ClientIpResolutionError) {
        return c.json({ error: 'Client IP could not be resolved' }, 400);
      }
      // eslint-disable-next-line no-console
      console.error('[app-api] /auth/nonce failed', safeErrorSummary(err));
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── POST /auth/verify ──────────────────────────────────────────────
  app.post('/verify', async (c) => {
    let ip: string | null = null;
    try {
      const redis = await getAdminRedis(contextPromise);
      ip = runtime.resolveClientIp(c);
      // Atomic rate-limit check at entry — counts all verify attempts
      const rateCheck = await checkAndIncrement(redis, ip);
      if (!rateCheck.allowed) {
        await writeAdminAuditLog(redis, { event: 'ADMIN_LOGIN_RATE_LIMITED', ip });
        return c.json({ error: 'Too many requests. Try again in 15 minutes.' }, 429);
      }

      const body = parseAdminAuthVerifyRequest(
        await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES),
      );
      const { nonce, signature, address } = body;

      // Verify signature + check address matches ADMIN_ADDRESS
      const configuredAuth = requireConfiguredAdminAuth(runtime);
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
        return c.json({ error: 'Signature verification failed' }, 401);
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
        return c.json({ error: 'Invalid or expired nonce' }, 401);
      }

      // Success — complete all fallible work before staging the cookie.
      // Hono preserves staged headers even on catch-path 500 responses,
      // so Set-Cookie must only be set right before the final return.
      const token = await signAdminJwt(address, configuredAuth.jwt);
      const cookie = buildAuthCookieHeader(token, runtime.adminAuth.cookie);
      await resetAttempts(redis, ip);
      await writeAdminAuditLog(redis, { event: 'ADMIN_LOGIN_SUCCESS', ip, address });
      c.header('Set-Cookie', cookie);
      const response: AdminAuthSuccessResponse = { ok: true };
      return c.json(response);
    } catch (err) {
      if (err instanceof ClientIpResolutionError) {
        return c.json({ error: 'Client IP could not be resolved' }, 400);
      }
      if (err instanceof HostWireParseError) {
        return c.json(
          { error: 'Request body does not match the current API contract', code: 'BAD_REQUEST' },
          400,
        );
      }
      const bodyRes = tryBodyErrorResponse(c, err);
      if (bodyRes) return bodyRes;
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
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── POST /auth/renew ───────────────────────────────────────────────
  app.post('/renew', async (c) => {
    let ip: string | null = null;
    try {
      const redis = await getAdminRedis(contextPromise);
      ip = runtime.resolveClientIp(c);
      // Atomic rate-limit check at entry — counts all renew attempts
      const rateCheck = await checkAndIncrement(redis, ip);
      if (!rateCheck.allowed) {
        await writeAdminAuditLog(redis, { event: 'ADMIN_RENEW_RATE_LIMITED', ip });
        return c.json({ error: 'Too many requests. Try again in 15 minutes.' }, 429);
      }

      const body = parseAdminAuthVerifyRequest(
        await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES),
      );
      const { nonce, signature, address } = body;

      const configuredAuth = requireConfiguredAdminAuth(runtime);
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
        return c.json({ error: 'Signature verification failed' }, 401);
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
        return c.json({ error: 'Invalid or expired nonce' }, 401);
      }

      // Success — complete all fallible work before staging the cookie.
      const token = await signAdminJwt(address, configuredAuth.jwt);
      const cookie = buildAuthCookieHeader(token, runtime.adminAuth.cookie);
      await resetAttempts(redis, ip);
      await writeAdminAuditLog(redis, { event: 'ADMIN_RENEW_SUCCESS', ip, address });
      c.header('Set-Cookie', cookie);
      const response: AdminAuthSuccessResponse = { ok: true };
      return c.json(response);
    } catch (err) {
      if (err instanceof ClientIpResolutionError) {
        return c.json({ error: 'Client IP could not be resolved' }, 400);
      }
      if (err instanceof HostWireParseError) {
        return c.json(
          { error: 'Request body does not match the current API contract', code: 'BAD_REQUEST' },
          400,
        );
      }
      const bodyRes = tryBodyErrorResponse(c, err);
      if (bodyRes) return bodyRes;
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
      return c.json({ error: 'Internal server error' }, 500);
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
      if (!session) return c.json({ error: 'Unauthorized' }, 401);

      const redis = await getAdminRedis(contextPromise);
      await raiseAppApiAdminSessionNotBefore(redis, Math.max(Date.now(), session.iatMs + 1));
      c.header('Set-Cookie', buildLogoutCookieHeader(runtime.adminAuth.cookie));
      const response: AdminAuthSuccessResponse = { ok: true };
      return c.json(response);
    } catch (err) {
      // Do not expire the cookie or claim success until the durable cutoff is raised.
      console.error('[app-api] /auth/logout failed', safeErrorSummary(err)); // eslint-disable-line no-console
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── GET /auth/session ──────────────────────────────────────────────
  app.get('/session', async (c) => {
    // JWT + Redis not_before guard (fail-closed)
    const session = await requireAdminSessionFromContext(c, contextPromise, runtime.adminAuth.jwt);
    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    return c.json({
      address: session.address,
      exp: session.exp,
      iat: session.iat,
    });
  });

  return app;
}
