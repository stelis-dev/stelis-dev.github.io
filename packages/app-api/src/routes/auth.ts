/**
 * [app-api] Admin auth routes — /admin/auth/{nonce,verify,renew,logout,session}
 *
 * Admin wallet-based authentication using core-api/admin DI functions.
 * Cookie = `stelis_admin`; Redis not-before key = `stelis:app-api:admin:not_before`.
 *
 * Uses verifyAdminSignature and admin rate limiting from core-api/admin.
 * Host: signAdminJwt, verifyAdminJwt, cookie builders from src/adminAuth.ts
 */
import { Hono } from 'hono';
import {
  checkAndIncrement,
  type AdminRedisClient,
} from '@stelis/core-api/admin';
import {
  ADMIN_AUTH_LOGOUT_ERROR_CODES,
  ADMIN_AUTH_NONCE_ERROR_CODES,
  ADMIN_SESSION_ERROR_CODES,
  parseAdminAuthChallengeResponse,
  parseAdminAuthSuccessResponse,
  parseAdminSessionResponse,
  type HostErrorCode,
} from '@stelis/contracts';
import type { AdminAppApiContext } from '../context.js';
import { createAdminRedisAdapter } from '../adminRedis.js';
import { buildLogoutCookieHeader } from '../adminAuth.js';
import { requireAdminSessionFromContext } from '../requireAdminSession.js';
import { safeErrorSummary } from '@stelis/core-api/observability';
import { raiseAppApiAdminSessionNotBefore } from '../adminSessionNotBefore.js';
import { codedHostError, mapError, respondMapped } from '../errorMap.js';
import {
  adminSessionNonceKey,
  createAdminSessionIssuer,
  type AdminSessionIssueRuntime,
} from '../adminSessionIssue.js';

const NONCE_TTL_MS = 60_000;

export type AuthRoutesRuntime = AdminSessionIssueRuntime;

function getAdminRedis(context: AdminAppApiContext): AdminRedisClient {
  return createAdminRedisAdapter(context.redis);
}

function respondAuthFailure(
  c: Parameters<typeof respondMapped>[0],
  err: unknown,
  allowedCodes: readonly HostErrorCode[],
): Response {
  const mapped = mapError(err, allowedCodes, 'INTERNAL_ERROR');
  if (mapped) return respondMapped(c, mapped);
  return respondMapped(c, codedHostError('INTERNAL_ERROR', allowedCodes));
}

export function createAuthRoutes(context: AdminAppApiContext, runtime: AuthRoutesRuntime) {
  const app = new Hono();
  const sessionIssuer = createAdminSessionIssuer(context, runtime);

  // ── POST /admin/auth/nonce ───────────────────────────────────────────────
  app.post('/nonce', async (c) => {
    try {
      const admitted = await runtime.admission.begin(c, {
        allowedErrorCodes: ADMIN_AUTH_NONCE_ERROR_CODES,
        unexpectedFailureCode: 'INTERNAL_ERROR',
        ipRateLimitCheck: async (ip) => checkAndIncrement(getAdminRedis(context), ip),
      });
      if (!admitted.ok) return admitted.response;
      const redis = getAdminRedis(context);

      const nonce = `stelis-admin-login:${crypto.randomUUID()}:${Date.now()}`;
      await redis.set(adminSessionNonceKey(nonce), '1', { px: NONCE_TTL_MS });
      return c.json(parseAdminAuthChallengeResponse({ nonce }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[app-api] /admin/auth/nonce failed', safeErrorSummary(err));
      return respondAuthFailure(c, err, ADMIN_AUTH_NONCE_ERROR_CODES);
    }
  });

  // ── POST /admin/auth/verify ──────────────────────────────────────────────
  app.post('/verify', (c) => sessionIssuer.issue(c, 'login'));

  // ── POST /admin/auth/renew ───────────────────────────────────────────────
  app.post('/renew', (c) => sessionIssuer.issue(c, 'renew'));

  // ── POST /admin/auth/logout ──────────────────────────────────────────────
  app.post('/logout', async (c) => {
    try {
      const admitted = await runtime.admission.begin(c, {
        allowedErrorCodes: ADMIN_AUTH_LOGOUT_ERROR_CODES,
        unexpectedFailureCode: 'INTERNAL_ERROR',
      });
      if (!admitted.ok) return admitted.response;
      const configuredAuth = runtime.admin;
      const session = await requireAdminSessionFromContext(c, context, configuredAuth.auth.jwt);
      if (!session) {
        return respondMapped(
          c,
          codedHostError('ADMIN_UNAUTHORIZED', ADMIN_AUTH_LOGOUT_ERROR_CODES),
        );
      }
      const subjectAdmission = await runtime.admission.finishAuthenticated(
        c,
        admitted.value,
        {
          allowedErrorCodes: ADMIN_AUTH_LOGOUT_ERROR_CODES,
          subject: { kind: 'address', address: session.address },
        },
      );
      if (!subjectAdmission.ok) return subjectAdmission.response;

      const redis = getAdminRedis(context);
      await raiseAppApiAdminSessionNotBefore(redis, Math.max(Date.now(), session.iatMs + 1));
      c.header('Set-Cookie', buildLogoutCookieHeader(configuredAuth.auth.cookie));
      return c.json(parseAdminAuthSuccessResponse({ ok: true }));
    } catch (err) {
      // Do not expire the cookie or claim success until the durable cutoff is raised.
      console.error('[app-api] /admin/auth/logout failed', safeErrorSummary(err)); // eslint-disable-line no-console
      return respondAuthFailure(c, err, ADMIN_AUTH_LOGOUT_ERROR_CODES);
    }
  });

  // ── GET /admin/auth/session ──────────────────────────────────────────────
  app.get('/session', async (c) => {
    const admitted = await runtime.admission.begin(c, {
      allowedErrorCodes: ADMIN_SESSION_ERROR_CODES,
      unexpectedFailureCode: 'INTERNAL_ERROR',
    });
    if (!admitted.ok) return admitted.response;
    const configuredAuth = runtime.admin;
    // JWT + Redis not_before guard (fail-closed)
    const session = await requireAdminSessionFromContext(c, context, configuredAuth.auth.jwt);
    if (!session) {
      return respondMapped(c, codedHostError('ADMIN_UNAUTHORIZED', ADMIN_SESSION_ERROR_CODES));
    }
    const subjectAdmission = await runtime.admission.finishAuthenticated(
      c,
      admitted.value,
      {
        allowedErrorCodes: ADMIN_SESSION_ERROR_CODES,
        subject: { kind: 'address', address: session.address },
      },
    );
    if (!subjectAdmission.ok) return subjectAdmission.response;

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
