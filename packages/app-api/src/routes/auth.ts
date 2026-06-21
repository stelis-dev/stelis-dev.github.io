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
import { tryBodyErrorResponse } from '../bodyError.js';
import {
  verifyAdminSignature,
  checkAndIncrement,
  resetAttempts,
  type AdminRedisClient,
} from '@stelis/core-api/admin';
import type { AppApiContext } from '../context.js';
import { createAdminRedisAdapter } from '../adminRedis.js';
import { signAdminJwt, buildAuthCookieHeader, buildLogoutCookieHeader } from '../adminAuth.js';
import { requireAdminSessionFromContext } from '../requireAdminSession.js';
import { getClientIp } from '../clientIp.js';
import { requireEnv } from '../env.js';
import { safeErrorSummary, writeAdminAuditLog } from '../adminAuditLog.js';
import { mapError, respondMapped } from '../errorMap.js';

const NONCE_TTL_MS = 60_000;

async function getAdminRedis(getCtx: () => Promise<AppApiContext>): Promise<AdminRedisClient> {
  return createAdminRedisAdapter((await getCtx()).redis);
}

export function createAuthRoutes(getCtx: () => Promise<AppApiContext>) {
  const app = new Hono();

  // ── GET /auth/nonce ────────────────────────────────────────────────
  app.get('/nonce', async (c) => {
    try {
      const redis = await getAdminRedis(getCtx);
      const ip = getClientIp(c);

      const rateCheck = await checkAndIncrement(redis, ip);
      if (!rateCheck.allowed) {
        return c.json({ error: 'Too many requests. Try again in 15 minutes.' }, 429);
      }

      const nonce = `stelis-admin-login:${crypto.randomUUID()}:${Date.now()}`;
      await redis.set(`stelis:admin:nonce:${nonce}`, '1', { px: NONCE_TTL_MS });
      return c.json({ nonce });
    } catch (err) {
      const mapped = mapError(err);
      if (mapped) return respondMapped(c, mapped);
      // eslint-disable-next-line no-console
      console.error('[app-api] /auth/nonce failed', safeErrorSummary(err));
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // ── POST /auth/verify ──────────────────────────────────────────────
  app.post('/verify', async (c) => {
    let ip: string | null = null;
    try {
      const redis = await getAdminRedis(getCtx);
      ip = getClientIp(c);
      // Atomic rate-limit check at entry — counts all verify attempts
      const rateCheck = await checkAndIncrement(redis, ip);
      if (!rateCheck.allowed) {
        await writeAdminAuditLog(redis, { event: 'ADMIN_LOGIN_RATE_LIMITED', ip });
        return c.json({ error: 'Too many requests. Try again in 15 minutes.' }, 429);
      }

      const body = (await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES)) as {
        nonce?: string;
        signature?: string;
        address?: string;
      };
      const { nonce, signature, address } = body;

      if (
        typeof nonce !== 'string' ||
        typeof signature !== 'string' ||
        typeof address !== 'string'
      ) {
        await writeAdminAuditLog(redis, {
          event: 'ADMIN_LOGIN_FAILED',
          reason: 'bad_request',
          ip,
        });
        return c.json({ error: 'Missing required fields: nonce, signature, address' }, 400);
      }

      // Consume nonce (single-use)
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

      // Verify signature + check address matches ADMIN_ADDRESS
      const adminAddress = requireEnv('ADMIN_ADDRESS');
      const valid = await verifyAdminSignature({ nonce, signature, address, adminAddress });
      if (!valid) {
        await writeAdminAuditLog(redis, {
          event: 'ADMIN_LOGIN_FAILED',
          reason: 'bad_signature',
          ip,
          address,
        });
        return c.json({ error: 'Signature verification failed' }, 401);
      }

      // Success — complete all fallible work before staging the cookie.
      // Hono preserves staged headers even on catch-path 500 responses,
      // so Set-Cookie must only be set right before the final return.
      const token = await signAdminJwt(address);
      const cookie = buildAuthCookieHeader(token);
      await resetAttempts(redis, ip);
      await writeAdminAuditLog(redis, { event: 'ADMIN_LOGIN_SUCCESS', ip, address });
      c.header('Set-Cookie', cookie);
      return c.json({ ok: true });
    } catch (err) {
      const bodyRes = tryBodyErrorResponse(c, err);
      if (bodyRes) return bodyRes;
      const mapped = mapError(err);
      if (mapped) return respondMapped(c, mapped);
      try {
        if (ip !== null) {
          const r = await getAdminRedis(getCtx);
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
      const redis = await getAdminRedis(getCtx);
      ip = getClientIp(c);
      // Atomic rate-limit check at entry — counts all renew attempts
      const rateCheck = await checkAndIncrement(redis, ip);
      if (!rateCheck.allowed) {
        await writeAdminAuditLog(redis, { event: 'ADMIN_RENEW_RATE_LIMITED', ip });
        return c.json({ error: 'Too many requests. Try again in 15 minutes.' }, 429);
      }

      const body = (await readJsonBodyWithLimit(c.req.raw, MAX_SMALL_REQUEST_BODY_BYTES)) as {
        nonce?: string;
        signature?: string;
        address?: string;
      };
      const { nonce, signature, address } = body;

      if (
        typeof nonce !== 'string' ||
        typeof signature !== 'string' ||
        typeof address !== 'string'
      ) {
        await writeAdminAuditLog(redis, {
          event: 'ADMIN_RENEW_FAILED',
          reason: 'bad_request',
          ip,
        });
        return c.json({ error: 'Missing required fields: nonce, signature, address' }, 400);
      }

      // Consume nonce
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

      const adminAddress = requireEnv('ADMIN_ADDRESS');
      const valid = await verifyAdminSignature({ nonce, signature, address, adminAddress });
      if (!valid) {
        await writeAdminAuditLog(redis, {
          event: 'ADMIN_RENEW_FAILED',
          reason: 'bad_signature',
          ip,
          address,
        });
        return c.json({ error: 'Signature verification failed' }, 401);
      }

      // Success — complete all fallible work before staging the cookie.
      const token = await signAdminJwt(address);
      const cookie = buildAuthCookieHeader(token);
      await resetAttempts(redis, ip);
      await writeAdminAuditLog(redis, { event: 'ADMIN_RENEW_SUCCESS', ip, address });
      c.header('Set-Cookie', cookie);
      return c.json({ ok: true });
    } catch (err) {
      const bodyRes = tryBodyErrorResponse(c, err);
      if (bodyRes) return bodyRes;
      const mapped = mapError(err);
      if (mapped) return respondMapped(c, mapped);
      try {
        if (ip !== null) {
          const r = await getAdminRedis(getCtx);
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
    c.header('Set-Cookie', buildLogoutCookieHeader());
    return c.json({ ok: true });
  });

  // ── GET /auth/session ──────────────────────────────────────────────
  app.get('/session', async (c) => {
    // JWT + Redis not_before guard (fail-closed)
    const session = await requireAdminSessionFromContext(c, getCtx);
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
