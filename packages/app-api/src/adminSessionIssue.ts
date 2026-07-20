import {
  checkAndIncrement,
  resetAttempts,
  verifyAdminSignature,
  type AdminRedisClient,
} from '@stelis/core-api/admin';
import { MAX_SMALL_REQUEST_BODY_BYTES, readAdmittedClientIp } from '@stelis/core-api';
import {
  ADMIN_AUTH_VERIFY_ERROR_CODES,
  HostWireParseError,
  parseAdminAuthSuccessResponse,
  parseAdminAuthVerifyRequest,
} from '@stelis/contracts';
import type { Context } from 'hono';
import {
  buildAuthCookieHeader,
  signAdminJwt,
  type AdminAuthRuntimeConfig,
} from './adminAuth.js';
import { writeAdminAuditLog } from './adminAuditLog.js';
import { createAdminRedisAdapter } from './adminRedis.js';
import type { AdminAppApiContext } from './context.js';
import { codedHostError, mapError, respondMapped } from './errorMap.js';
import type { AdminRequestAdmission } from './requestAdmission.js';
import { safeErrorSummary } from '@stelis/core-api/observability';

export type AdminSessionIssueAction = 'login' | 'renew';

export interface AdminSessionIssueRuntime {
  readonly admission: AdminRequestAdmission;
  readonly admin: {
    readonly address: string;
    readonly auth: AdminAuthRuntimeConfig;
  };
}

export interface AdminSessionIssuer {
  issue(c: Context, action: AdminSessionIssueAction): Promise<Response>;
}

const ADMIN_SESSION_NONCE_KEY_PREFIX = 'stelis:admin:nonce:';

export function adminSessionNonceKey(nonce: string): string {
  return `${ADMIN_SESSION_NONCE_KEY_PREFIX}${nonce}`;
}

const ACTION_AUDIT_EVENTS = Object.freeze({
  login: Object.freeze({
    failure: 'ADMIN_LOGIN_FAILED',
    success: 'ADMIN_LOGIN_SUCCESS',
    error: 'ADMIN_LOGIN_ERROR',
  }),
  renew: Object.freeze({
    failure: 'ADMIN_RENEW_FAILED',
    success: 'ADMIN_RENEW_SUCCESS',
    error: 'ADMIN_RENEW_ERROR',
  }),
} as const);

class AdminAuthRequestContractError extends Error {
  constructor() {
    super('Admin auth request does not match the current Host wire contract');
    this.name = 'AdminAuthRequestContractError';
  }
}

function parseRequest(value: unknown) {
  try {
    return parseAdminAuthVerifyRequest(value);
  } catch (error) {
    if (error instanceof HostWireParseError) throw new AdminAuthRequestContractError();
    throw error;
  }
}

function respondFailure(c: Context, error: unknown): Response {
  if (error instanceof AdminAuthRequestContractError) {
    return respondMapped(c, codedHostError('BAD_REQUEST', ADMIN_AUTH_VERIFY_ERROR_CODES));
  }
  const mapped = mapError(error, ADMIN_AUTH_VERIFY_ERROR_CODES, 'INTERNAL_ERROR');
  if (mapped) return respondMapped(c, mapped);
  return respondMapped(c, codedHostError('INTERNAL_ERROR', ADMIN_AUTH_VERIFY_ERROR_CODES));
}

function getAdminRedis(context: AdminAppApiContext): AdminRedisClient {
  return createAdminRedisAdapter(context.redis);
}

/**
 * Own the complete Admin login and renewal process.
 *
 * The route chooses only the audit action. Request admission, credentials,
 * subject admission, nonce consumption, token and cookie creation, limiter
 * reset, audit persistence, and final cookie staging always run in this order.
 */
export function createAdminSessionIssuer(
  context: AdminAppApiContext,
  runtime: AdminSessionIssueRuntime,
): AdminSessionIssuer {
  return Object.freeze({
    async issue(c: Context, action: AdminSessionIssueAction): Promise<Response> {
      const auditEvents = ACTION_AUDIT_EVENTS[action];
      let ip: string | null = null;
      try {
        const admitted = await runtime.admission.begin(c, {
          allowedErrorCodes: ADMIN_AUTH_VERIFY_ERROR_CODES,
          unexpectedFailureCode: 'INTERNAL_ERROR',
          jsonBodyLimitBytes: MAX_SMALL_REQUEST_BODY_BYTES,
          ipRateLimitCheck: async (candidateIp) =>
            checkAndIncrement(getAdminRedis(context), candidateIp),
        });
        if (!admitted.ok) return admitted.response;

        ip = readAdmittedClientIp(admitted.value.clientIp);
        const { nonce, signature, address } = parseRequest(admitted.value.body);
        const redis = getAdminRedis(context);

        const valid = await verifyAdminSignature({
          nonce,
          signature,
          address,
          adminAddress: runtime.admin.address,
        });
        if (!valid) {
          await writeAdminAuditLog(redis, {
            event: auditEvents.failure,
            reason: 'bad_signature',
            ip,
            address,
          });
          return respondMapped(
            c,
            codedHostError('ADMIN_UNAUTHORIZED', ADMIN_AUTH_VERIFY_ERROR_CODES),
          );
        }

        const subjectAdmission = await runtime.admission.finishAuthenticated(c, admitted.value, {
          allowedErrorCodes: ADMIN_AUTH_VERIFY_ERROR_CODES,
          subject: { kind: 'address', address },
        });
        if (!subjectAdmission.ok) return subjectAdmission.response;

        const deleted = await redis.del(adminSessionNonceKey(nonce));
        if (deleted === 0) {
          await writeAdminAuditLog(redis, {
            event: auditEvents.failure,
            reason: 'invalid_nonce',
            ip,
            address,
          });
          return respondMapped(
            c,
            codedHostError('ADMIN_UNAUTHORIZED', ADMIN_AUTH_VERIFY_ERROR_CODES),
          );
        }

        const token = await signAdminJwt(address, runtime.admin.auth.jwt);
        const cookie = buildAuthCookieHeader(token, runtime.admin.auth.cookie);
        const body = parseAdminAuthSuccessResponse({ ok: true });
        await resetAttempts(redis, ip);
        await writeAdminAuditLog(redis, { event: auditEvents.success, ip, address });

        c.header('Set-Cookie', cookie);
        return c.json(body);
      } catch (error) {
        try {
          if (ip !== null) {
            await writeAdminAuditLog(getAdminRedis(context), {
              event: auditEvents.error,
              ip,
              error: safeErrorSummary(error),
            });
          }
        } catch {
          // The primary failure response remains authoritative when audit storage is unavailable.
        }
        return respondFailure(c, error);
      }
    },
  });
}
