/**
 * [app-api] studio auth helper — JWT verify → block check → rate-limit.
 *
 * Owns the prelude shared by user-facing Studio routes:
 * GET /studio/promotions, GET /studio/promotions/:id, and
 * POST /studio/promotions/:id/{claim,prepare,sponsor}.
 * Intentionally does NOT own: promotionStore/executionLedger null-guard, studio
 * mode, globalTargetHashes, sponsor operations gate, body parse, handler call,
 * per-route error mapping. Those stay in the route because their guard set and
 * messages differ per operation.
 *
 * Shape — plain async helper, NOT a Hono middleware. Routes call it
 * explicitly AFTER their route-local 503 guards (studio mode, stores,
 * globalTargetHashes, sponsor operations gate) have passed. This preserves the original
 * guard precedence: 503 infrastructure failures always outrank 401/429.
 * Binding this as `app.post(path, middleware, handler)` would run JWT/block/
 * rate-limit before the 503 guards — that ordering is not permitted.
 *
 * JWT failure mapping has two modes:
 *   - claim:           DeveloperJwtAuthError → 401 AUTH_FAILED.
 *                      Other JWT errors → 500 `{ error: 'Internal server error' }`
 *                      (no `code` field — matches pre-middleware claim outer
 *                      catch behavior exactly).
 *   - prepare/sponsor: DeveloperJwtAuthError → 401 AUTH_FAILED.
 *                      Other JWT errors → 401 AUTH_JWT_INVALID.
 *
 * Return shape: `{ ok: true, identity, ip }` on success, or
 * `{ ok: false, response }` carrying a ready-to-return short-circuit
 * Response on any failure.
 *
 * Not exported from the package — internal to app-api routes.
 *
 * @module middleware/studioAuth
 */

import type { Context } from 'hono';
import {
  extractBearerToken,
  verifyDeveloperJwt,
  type VerifiedDeveloperIdentity,
} from '@stelis/core-api/studio';
import { checkBlockedRequest, toBlockedError } from '@stelis/core-api';
import type { AppApiContext } from '../context.js';
import { getClientIp } from '../clientIp.js';
import { callDeveloperVerifyApi } from '../developerJwtVerifyCallback.js';
import { formatRetryAfterSeconds } from '../retryAfter.js';

/** Auth error with HTTP status hint for route-layer error mapping. */
export class DeveloperJwtAuthError extends Error {
  constructor(
    message: string,
    public readonly statusHint: number,
  ) {
    super(message);
    this.name = 'DeveloperJwtAuthError';
  }
}

export interface StudioAuthOptions {
  /**
   * Rate-limit key prefix, e.g. `'promo_list'` / `'promo_detail'` /
   * `'promo_claim'` / `'promo_prepare'` / `'promo_sponsor'`. Keys are
   * `${prefix}:client-ip:${ip}`, `${prefix}:developer-user:${userId}`, and,
   * when the route has a promotion id, `${prefix}:promotion:${promotionId}`.
   */
  rateLimitPrefix: string;
  /**
   * If true, a JWT verification error that is not a DeveloperJwtAuthError is
   * mapped to `401 AUTH_JWT_INVALID`. If false (default), such errors are
   * mapped to `500 { error: 'Internal server error' }` (no `code` field),
   * matching the pre-middleware claim route contract. Claim uses `false`;
   * prepare/sponsor use `true`.
   */
  unknownJwtErrorAs401?: boolean;
}

export type StudioAuthResult =
  | { ok: true; identity: VerifiedDeveloperIdentity; ip: string }
  | { ok: false; response: Response };

export async function verifyDeveloperJwtFromRequest(
  request: Request,
  ctx: AppApiContext,
): Promise<VerifiedDeveloperIdentity> {
  const authResult = extractBearerToken(request);
  if (authResult.status === 'absent') {
    throw new DeveloperJwtAuthError('Authorization header required', 401);
  }
  if (authResult.status === 'malformed') {
    throw new DeveloperJwtAuthError(authResult.reason, 400);
  }
  if (!ctx.developerJwtTrustConfig) {
    throw new DeveloperJwtAuthError('Developer JWT trust config not configured', 503);
  }
  const identity = await verifyDeveloperJwt(authResult.token, ctx.developerJwtTrustConfig);
  if (ctx.developerJwtVerifyUrl) {
    await callDeveloperVerifyApi(authResult.token, ctx.developerJwtVerifyUrl);
  }
  return identity;
}

/**
 * Run the JWT → block → rate-limit prelude. Call this AFTER all route-local
 * 503 guards have passed — never bind as a Hono middleware.
 */
export async function runStudioAuth(
  c: Context,
  ctx: AppApiContext,
  opts: StudioAuthOptions,
): Promise<StudioAuthResult> {
  const ip = getClientIp(c);

  // 1. JWT verify.
  let identity: VerifiedDeveloperIdentity;
  try {
    identity = await verifyDeveloperJwtFromRequest(c.req.raw, ctx);
  } catch (authErr) {
    if (authErr instanceof DeveloperJwtAuthError) {
      return {
        ok: false,
        response: c.json(
          { error: authErr.message, code: 'AUTH_FAILED' },
          authErr.statusHint as 401,
        ),
      };
    }
    if (opts.unknownJwtErrorAs401) {
      return {
        ok: false,
        response: c.json(
          {
            error: authErr instanceof Error ? authErr.message : 'JWT verification failed',
            code: 'AUTH_JWT_INVALID',
          },
          401,
        ),
      };
    }
    // Claim-path contract: unknown JWT error → 500 Internal server error
    // (no `code` field). Matches the pre-middleware route-outer catch.
    return {
      ok: false,
      response: c.json({ error: 'Internal server error' }, 500),
    };
  }

  // 2. IP + Studio user block check. The Studio promotion principal is the
  // verified developer JWT `userId`. `senderAddress` is a mutable execution
  // credential bound by the JWT for the current action (matched on the
  // prepare/sponsor route path) but is not the long-lived enforcement subject.
  const blocked = await checkBlockedRequest(ctx.relay.abuseBlocker, ip, {
    kind: 'studio_user',
    userId: identity.userId,
  });
  if (blocked.blocked) {
    return {
      ok: false,
      response: c.json(toBlockedError(blocked), {
        status: 429,
        headers: { 'Retry-After': formatRetryAfterSeconds(blocked.retryAfterMs) },
      }),
    };
  }

  // 3. Rate-limit — per-client-IP, per-developer-user, per-promotion (short-circuit in order).
  const promotionId = c.req.param('id') ?? '';
  const keys = [
    `${opts.rateLimitPrefix}:client-ip:${ip}`,
    `${opts.rateLimitPrefix}:developer-user:${identity.userId}`,
  ];
  if (promotionId) keys.push(`${opts.rateLimitPrefix}:promotion:${promotionId}`);
  for (const key of keys) {
    const rl = await ctx.relay.rateLimiter.check(key);
    if (!rl.allowed) {
      return {
        ok: false,
        response: c.json(
          { error: 'Rate limit exceeded', retryAfterMs: rl.retryAfterMs },
          {
            status: 429,
            headers: { 'Retry-After': formatRetryAfterSeconds(rl.retryAfterMs) },
          },
        ),
      };
    }
  }

  return { ok: true, identity, ip };
}
