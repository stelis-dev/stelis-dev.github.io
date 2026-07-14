/**
 * [app-api] studio auth helper — JWT verify → block check → rate-limit.
 *
 * Owns the prelude shared by user-facing Studio routes:
 * GET /studio/promotions, GET /studio/promotions/:id, and
 * POST /studio/promotions/:id/{claim,prepare,sponsor}.
 * Intentionally does NOT own: promotionStore/executionLedger null-guard, studio
 * mode, globalAllowedTargets, sponsor operations gate, body parse, handler call,
 * per-route error mapping. Those stay in the route because their guard set and
 * messages differ per operation.
 *
 * Shape — plain async helper, NOT a Hono middleware. Routes call it
 * explicitly AFTER their route-local 503 guards (studio mode, stores,
 * globalAllowedTargets, sponsor operations gate) have passed. This preserves the original
 * guard precedence: 503 infrastructure failures always outrank 401/429.
 * Binding this as `app.post(path, middleware, handler)` would run JWT/block/
 * rate-limit before the 503 guards — that ordering is not permitted.
 *
 * JWT failures are classified once for every Studio route: credential shape,
 * verified rejection, and verifier availability have distinct current codes.
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
import type { HostErrorCode } from '@stelis/contracts';
import type { AppApiContext } from '../context.js';
import type { ResolveClientIp } from '../clientIp.js';
import {
  callDeveloperVerifyApi,
  DeveloperVerifyRejectedError,
  DeveloperVerifyUnavailableError,
} from '../developerJwtVerifyCallback.js';
import { formatRetryAfterSeconds } from '../retryAfter.js';
import { codedHostError, respondMapped, uncodedHostError } from '../errorMap.js';

type StudioAuthenticationErrorCode = 'AUTH_FAILED' | 'AUTH_JWT_INVALID' | 'AUTH_UNAVAILABLE';

/** Closed Studio authentication outcome; HTTP status belongs to contracts. */
export class StudioAuthenticationError extends Error {
  constructor(
    message: string,
    public readonly code: StudioAuthenticationErrorCode,
  ) {
    super(message);
    this.name = 'StudioAuthenticationError';
  }
}

export interface StudioAuthOptions {
  /** Current error-code set for the exact Studio route invoking this prelude. */
  allowedErrorCodes: readonly HostErrorCode[];
  /**
   * Rate-limit key prefix, e.g. `'promo_list'` / `'promo_detail'` /
   * `'promo_claim'` / `'promo_prepare'` / `'promo_sponsor'`. Keys are
   * `${prefix}:client-ip:${ip}`, `${prefix}:developer-user:${userId}`, and,
   * when the route has a promotion id, `${prefix}:promotion:${promotionId}`.
   */
  rateLimitPrefix: string;
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
    throw new StudioAuthenticationError('Authorization header required', 'AUTH_FAILED');
  }
  if (authResult.status === 'malformed') {
    throw new StudioAuthenticationError(authResult.reason, 'AUTH_FAILED');
  }
  if (!ctx.developerJwtTrustConfig) {
    throw new StudioAuthenticationError(
      'Developer JWT trust config not configured',
      'AUTH_UNAVAILABLE',
    );
  }
  let identity: VerifiedDeveloperIdentity;
  try {
    identity = await verifyDeveloperJwt(authResult.token, ctx.developerJwtTrustConfig);
  } catch (err) {
    throw new StudioAuthenticationError(
      err instanceof Error ? err.message : 'Developer JWT verification failed',
      'AUTH_JWT_INVALID',
    );
  }
  if (ctx.developerJwtVerifyUrl) {
    try {
      await callDeveloperVerifyApi(authResult.token, ctx.developerJwtVerifyUrl);
    } catch (err) {
      if (err instanceof DeveloperVerifyRejectedError) {
        throw new StudioAuthenticationError(err.message, 'AUTH_JWT_INVALID');
      }
      if (err instanceof DeveloperVerifyUnavailableError) {
        throw new StudioAuthenticationError(err.message, 'AUTH_UNAVAILABLE');
      }
      throw err;
    }
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
  resolveClientIp: ResolveClientIp,
  opts: StudioAuthOptions,
): Promise<StudioAuthResult> {
  const ip = resolveClientIp(c);

  // 1. JWT verify.
  let identity: VerifiedDeveloperIdentity;
  try {
    identity = await verifyDeveloperJwtFromRequest(c.req.raw, ctx);
  } catch (authErr) {
    if (authErr instanceof StudioAuthenticationError) {
      return {
        ok: false,
        response: respondMapped(
          c,
          codedHostError(
            {
              error:
                authErr.code === 'AUTH_UNAVAILABLE'
                  ? 'Authentication service unavailable'
                  : 'Authentication failed',
              code: authErr.code,
            },
            opts.allowedErrorCodes,
          ),
        ),
      };
    }
    return {
      ok: false,
      response: respondMapped(
        c,
        uncodedHostError({ error: 'Internal server error' }, opts.allowedErrorCodes, 500),
      ),
    };
  }

  // 2. IP + Studio user block check. The Studio promotion principal is the
  // verified developer JWT `userId`. `senderAddress` is a mutable execution
  // credential bound by the JWT for the current action (matched on the
  // prepare/sponsor route path) but is not the long-lived enforcement subject.
  const blocked = await checkBlockedRequest(ctx.host.abuseBlocker, ip, {
    kind: 'studio_user',
    userId: identity.userId,
  });
  if (blocked.blocked) {
    return {
      ok: false,
      response: respondMapped(
        c,
        codedHostError(toBlockedError(blocked), opts.allowedErrorCodes, {
          'Retry-After': formatRetryAfterSeconds(blocked.retryAfterMs),
        }),
      ),
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
    const rl = await ctx.host.rateLimiter.check(key);
    if (!rl.allowed) {
      return {
        ok: false,
        response: respondMapped(
          c,
          uncodedHostError(
            { error: 'Rate limit exceeded', retryAfterMs: rl.retryAfterMs },
            opts.allowedErrorCodes,
            429,
            { 'Retry-After': formatRetryAfterSeconds(rl.retryAfterMs) },
          ),
        ),
      };
    }
  }

  return { ok: true, identity, ip };
}
