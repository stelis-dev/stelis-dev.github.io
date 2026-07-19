import type { Context } from 'hono';
import { MIMEType } from 'node:util';
import {
  admitClientIp,
  checkBlockedSubject,
  readJsonBodyWithLimit,
  type AdmittedClientIp,
  type HostContext,
} from '@stelis/core-api';
import type { HostErrorCode } from '@stelis/contracts';
import type { ResolveClientIp } from './clientIp.js';
import { codedHostError, mapError, respondMapped } from './errorMap.js';
import { formatRetryAfterSeconds } from './retryAfter.js';

type AbuseSubject = Parameters<typeof checkBlockedSubject>[2];

export interface RequestAdmissionDependencies {
  readonly host: Pick<HostContext, 'abuseBlocker' | 'rateLimiter'>;
  readonly resolveClientIp: ResolveClientIp;
}

export interface InitialRequestAdmissionPolicy {
  readonly allowedErrorCodes: readonly HostErrorCode[];
  readonly unexpectedFailureCode: Extract<
    HostErrorCode,
    'INTERNAL_ERROR' | 'SPONSOR_FAILED' | 'CONFIG_UNAVAILABLE'
  >;
  readonly ipRateLimitKey?: (ip: string) => string;
  readonly ipRateLimitCheck?: (
    ip: string,
  ) => Promise<{ readonly allowed: boolean; readonly retryAfterMs: number }>;
  readonly jsonBodyLimitBytes?: number;
}

export interface InitialRequestAdmission {
  readonly clientIp: AdmittedClientIp;
  readonly body: unknown;
}

export type RequestAdmissionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: Response };

export interface AuthenticatedRequestAdmissionOptions {
  readonly allowedErrorCodes: readonly HostErrorCode[];
  readonly subject: AbuseSubject;
  readonly rateLimitKeys?: readonly string[];
}

/**
 * Complete Admin request-admission owner. App composition captures the one
 * Admin browser origin and the common admission dependencies here so route
 * callers cannot omit or replace that policy.
 */
export interface AdminRequestAdmission {
  begin(
    c: Context,
    policy: InitialRequestAdmissionPolicy,
  ): Promise<RequestAdmissionResult<InitialRequestAdmission>>;
  finishAuthenticated(
    c: Context,
    initial: InitialRequestAdmission,
    options: AuthenticatedRequestAdmissionOptions,
  ): Promise<RequestAdmissionResult<InitialRequestAdmission>>;
}

function reject(
  c: Context,
  code: HostErrorCode,
  allowedErrorCodes: readonly HostErrorCode[],
  headers: Record<string, string> = {},
): RequestAdmissionResult<never> {
  return {
    ok: false,
    response: respondMapped(c, codedHostError(code, allowedErrorCodes, {}, headers)),
  };
}

function mapAdmissionError(
  c: Context,
  error: unknown,
  allowedErrorCodes: readonly HostErrorCode[],
  unexpectedFailureCode: InitialRequestAdmissionPolicy['unexpectedFailureCode'],
): RequestAdmissionResult<never> {
  const mapFailureCode =
    unexpectedFailureCode === 'SPONSOR_FAILED' ? 'SPONSOR_FAILED' : 'INTERNAL_ERROR';
  const mapped = mapError(error, allowedErrorCodes, mapFailureCode);
  if (mapped) return { ok: false, response: respondMapped(c, mapped) };
  return reject(c, unexpectedFailureCode, allowedErrorCodes);
}

function hasCurrentJsonContentType(request: Request): boolean {
  const contentType = request.headers.get('content-type');
  if (contentType === null) return false;
  try {
    return (
      new MIMEType(contentType).essence === 'application/json' &&
      hasValidMediaTypeParameterSyntax(contentType)
    );
  } catch {
    return false;
  }
}

const HTTP_TOKEN_CHARACTER = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]$/;

/** Node's MIMEType parser ignores malformed parameter tails, so validate that tail in full. */
function hasValidMediaTypeParameterSyntax(value: string): boolean {
  let index = value.indexOf(';');
  if (index === -1) return true;

  const skipOptionalWhitespace = () => {
    while (value[index] === ' ' || value[index] === '\t') index += 1;
  };
  const consumeToken = () => {
    const start = index;
    while (index < value.length && HTTP_TOKEN_CHARACTER.test(value[index]!)) index += 1;
    return index > start;
  };

  while (index < value.length) {
    if (value[index] !== ';') return false;
    index += 1;
    skipOptionalWhitespace();
    // RFC 9110 permits an empty parameter entry after a semicolon. Continue
    // validating the full tail instead of relying on MIMEType's normalization.
    if (index === value.length) return true;
    if (value[index] === ';') continue;
    if (!consumeToken()) return false;
    if (value[index] !== '=') return false;
    index += 1;

    if (value[index] === '"') {
      index += 1;
      let closed = false;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code === 0x22) {
          index += 1;
          closed = true;
          break;
        }
        if (code === 0x5c) {
          index += 1;
          if (index >= value.length) return false;
          const escapedCode = value.charCodeAt(index);
          if (escapedCode !== 0x09 && (escapedCode < 0x20 || escapedCode === 0x7f)) return false;
          index += 1;
          continue;
        }
        if (code !== 0x09 && (code < 0x20 || code === 0x5c || code === 0x7f)) return false;
        index += 1;
      }
      if (!closed) return false;
    } else if (!consumeToken()) {
      return false;
    }

    skipOptionalWhitespace();
    if (index === value.length) return true;
  }
  return true;
}

async function runInitialRequestAdmission(
  c: Context,
  dependencies: RequestAdmissionDependencies,
  policy: InitialRequestAdmissionPolicy,
  allowedBrowserOrigin: string | null | undefined,
): Promise<RequestAdmissionResult<InitialRequestAdmission>> {
  let clientIp: AdmittedClientIp;
  try {
    const rawClientIp = dependencies.resolveClientIp(c);
    const result = await admitClientIp(dependencies.host.abuseBlocker, rawClientIp);
    if (result.blocked) {
      return {
        ok: false,
        response: respondMapped(
          c,
          codedHostError(
            'ABUSE_BLOCKED',
            policy.allowedErrorCodes,
            result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs },
            { 'Retry-After': formatRetryAfterSeconds(result.retryAfterMs) },
          ),
        ),
      };
    }
    clientIp = result.admittedClientIp;
    if (policy.ipRateLimitKey || policy.ipRateLimitCheck) {
      const result = policy.ipRateLimitCheck
        ? await policy.ipRateLimitCheck(rawClientIp)
        : await dependencies.host.rateLimiter.check(policy.ipRateLimitKey!(rawClientIp));
      if (!result.allowed) {
        return {
          ok: false,
          response: respondMapped(
            c,
            codedHostError(
              'RATE_LIMITED',
              policy.allowedErrorCodes,
              { retryAfterMs: result.retryAfterMs },
              { 'Retry-After': formatRetryAfterSeconds(result.retryAfterMs) },
            ),
          ),
        };
      }
    }
  } catch (error) {
    return mapAdmissionError(c, error, policy.allowedErrorCodes, policy.unexpectedFailureCode);
  }

  if (allowedBrowserOrigin !== undefined) {
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== allowedBrowserOrigin) {
      return reject(c, 'ADMIN_UNAUTHORIZED', policy.allowedErrorCodes);
    }
  }

  let body: unknown = undefined;
  if (policy.jsonBodyLimitBytes !== undefined) {
    if (!hasCurrentJsonContentType(c.req.raw)) {
      return reject(c, 'BAD_REQUEST', policy.allowedErrorCodes);
    }
    try {
      body = await readJsonBodyWithLimit(c.req.raw, policy.jsonBodyLimitBytes);
    } catch (error) {
      return mapAdmissionError(c, error, policy.allowedErrorCodes, policy.unexpectedFailureCode);
    }
  }

  return { ok: true, value: Object.freeze({ clientIp, body }) };
}

export function beginRequestAdmission(
  c: Context,
  dependencies: RequestAdmissionDependencies,
  policy: InitialRequestAdmissionPolicy,
): Promise<RequestAdmissionResult<InitialRequestAdmission>> {
  return runInitialRequestAdmission(c, dependencies, policy, undefined);
}

export function createAdminRequestAdmission(
  dependencies: RequestAdmissionDependencies,
  allowedBrowserOrigin: string | null,
): AdminRequestAdmission {
  return Object.freeze({
    begin(c: Context, policy: InitialRequestAdmissionPolicy) {
      return runInitialRequestAdmission(c, dependencies, policy, allowedBrowserOrigin);
    },
    finishAuthenticated(
      c: Context,
      initial: InitialRequestAdmission,
      options: AuthenticatedRequestAdmissionOptions,
    ) {
      return finishAuthenticatedRequestAdmission(c, dependencies, initial, options);
    },
  });
}

export async function finishAuthenticatedRequestAdmission(
  c: Context,
  dependencies: RequestAdmissionDependencies,
  initial: InitialRequestAdmission,
  options: AuthenticatedRequestAdmissionOptions,
): Promise<RequestAdmissionResult<InitialRequestAdmission>> {
  try {
    const blocked = await checkBlockedSubject(
      dependencies.host.abuseBlocker,
      initial.clientIp,
      options.subject,
    );
    if (blocked.blocked) {
      return {
        ok: false,
        response: respondMapped(
          c,
          codedHostError(
            'ABUSE_BLOCKED',
            options.allowedErrorCodes,
            blocked.retryAfterMs === undefined ? {} : { retryAfterMs: blocked.retryAfterMs },
            { 'Retry-After': formatRetryAfterSeconds(blocked.retryAfterMs) },
          ),
        ),
      };
    }
    for (const key of options.rateLimitKeys ?? []) {
      const result = await dependencies.host.rateLimiter.check(key);
      if (!result.allowed) {
        return {
          ok: false,
          response: respondMapped(
            c,
            codedHostError(
              'RATE_LIMITED',
              options.allowedErrorCodes,
              { retryAfterMs: result.retryAfterMs },
              { 'Retry-After': formatRetryAfterSeconds(result.retryAfterMs) },
            ),
          ),
        };
      }
    }
  } catch (error) {
    return mapAdmissionError(c, error, options.allowedErrorCodes, 'INTERNAL_ERROR');
  }
  return { ok: true, value: initial };
}
