/**
 * [app-api] studio auth helper — JWT verify → block check → rate-limit.
 *
 * Owns the prelude shared by user-facing Studio routes:
 * GET /studio/promotions, GET /studio/promotions/:id, and
 * POST /studio/promotions/:id/{claim,prepare,sponsor}.
 * Host mode and the non-null Studio context are fixed by application
 * composition before this helper is reachable. This helper intentionally does
 * not own globalAllowedTargets, the sponsor operations gate, body parsing,
 * handler calls, or per-route error mapping; those differ per operation.
 *
 * Shape — plain async helper, not a Hono middleware. IP and request-shape
 * admission has already completed. This helper verifies the credential and
 * then applies the authenticated Studio-user admission boundary.
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
import { readAdmittedClientIp, type AdmittedClientIp } from '@stelis/core-api';
import type { HostErrorCode } from '@stelis/contracts';
import type { RelayWithAdminAndStudioAppApiContext } from '../context.js';
import {
  finishAuthenticatedRequestAdmission,
  type InitialRequestAdmission,
  type RequestAdmissionDependencies,
} from '../requestAdmission.js';
import {
  callDeveloperVerifyApi,
  DeveloperVerifyRejectedError,
  DeveloperVerifyUnavailableError,
} from '../developerJwtVerifyCallback.js';
import { codedHostError, respondMapped } from '../errorMap.js';

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
  /** Canonical route Promotion ID, when the route has one. */
  promotionId?: string;
}

export type StudioAuthResult =
  | {
      ok: true;
      identity: VerifiedDeveloperIdentity;
      clientIp: AdmittedClientIp;
      ip: string;
    }
  | { ok: false; response: Response };

export async function verifyDeveloperJwtFromRequest(
  request: Request,
  ctx: RelayWithAdminAndStudioAppApiContext,
): Promise<VerifiedDeveloperIdentity> {
  const authResult = extractBearerToken(request);
  if (authResult.status === 'absent') {
    throw new StudioAuthenticationError('Authorization header required', 'AUTH_FAILED');
  }
  if (authResult.status === 'malformed') {
    throw new StudioAuthenticationError(authResult.reason, 'AUTH_FAILED');
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
 * Run credential verification followed by authenticated-subject admission.
 */
export async function runStudioAuth(
  c: Context,
  ctx: RelayWithAdminAndStudioAppApiContext,
  admissionDependencies: RequestAdmissionDependencies,
  initialAdmission: InitialRequestAdmission,
  opts: StudioAuthOptions,
): Promise<StudioAuthResult> {
  const ip = readAdmittedClientIp(initialAdmission.clientIp);

  // 1. JWT verify.
  let identity: VerifiedDeveloperIdentity;
  try {
    identity = await verifyDeveloperJwtFromRequest(c.req.raw, ctx);
  } catch (authErr) {
    if (authErr instanceof StudioAuthenticationError) {
      return {
        ok: false,
        response: respondMapped(c, codedHostError(authErr.code, opts.allowedErrorCodes)),
      };
    }
    return {
      ok: false,
      response: respondMapped(c, codedHostError('INTERNAL_ERROR', opts.allowedErrorCodes)),
    };
  }

  // 2. Studio user admission. IP admission already completed before body and
  // credential processing. The Studio promotion principal is the
  // verified developer JWT `userId`. `senderAddress` is a mutable execution
  // credential bound by the JWT for the current action (matched on the
  // prepare/sponsor route path) but is not the long-lived enforcement subject.
  // 3. Rate-limit — verified developer-user and promotion only. The
  // client-IP rate limit already ran before credential verification.
  const keys = [`${opts.rateLimitPrefix}:developer-user:${identity.userId}`];
  if (opts.promotionId) keys.push(`${opts.rateLimitPrefix}:promotion:${opts.promotionId}`);
  const subjectAdmission = await finishAuthenticatedRequestAdmission(
    c,
    admissionDependencies,
    initialAdmission,
    {
      allowedErrorCodes: opts.allowedErrorCodes,
      subject: { kind: 'studio_user', userId: identity.userId },
      rateLimitKeys: keys,
    },
  );
  if (!subjectAdmission.ok) return subjectAdmission;

  return { ok: true, identity, clientIp: initialAdmission.clientIp, ip };
}
