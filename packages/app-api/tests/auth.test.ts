/**
 * Auth route contract tests — verifies HTTP contracts.
 *
 * Tests use Hono's app.request() with mocked dependencies.
 * No Redis required — all stores are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ClientIpResolutionError } from '@stelis/core-api';
import { hostErrorPublicMessage, type HostErrorCode } from '@stelis/contracts';

// ── Mock core-api/admin ─────────────────────────────────────────────────
const {
  mockRedis,
  mockResolveClientIp,
  mockCheckIp,
  mockCheckSubject,
  mockRecordSponsorFailure,
  mockRateLimitCheck,
} = vi.hoisted(() => ({
  mockRedis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(1),
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue(undefined),
  },
  mockResolveClientIp: vi.fn(),
  mockCheckIp: vi.fn().mockResolvedValue({ blocked: false }),
  mockCheckSubject: vi.fn().mockResolvedValue({ blocked: false }),
  mockRecordSponsorFailure: vi.fn().mockResolvedValue(undefined),
  mockRateLimitCheck: vi.fn().mockResolvedValue({
    allowed: true,
    retryAfterMs: 0,
    current: 1,
    limit: 100,
  }),
}));

vi.mock('@stelis/core-api/admin', () => ({
  verifyAdminSignature: vi.fn().mockResolvedValue(true),
  checkAndIncrement: vi.fn().mockResolvedValue({ allowed: true, current: 1, retryAfterMs: 0 }),
  resetAttempts: vi.fn().mockResolvedValue(undefined),
  raiseAdminSessionNotBefore: vi.fn().mockResolvedValue(1_700_000_000_001),
}));

// ── Mock adminAuth helpers ──────────────────────────────────────────────
vi.mock('../src/adminAuth.js', () => ({
  signAdminJwt: vi.fn().mockResolvedValue('mock-jwt-token'),
  verifyAdminJwt: vi.fn().mockResolvedValue(null),
  buildAuthCookieHeader: vi.fn().mockReturnValue('stelis_admin=mock-jwt; HttpOnly; Path=/'),
  buildLogoutCookieHeader: vi.fn().mockReturnValue('stelis_admin=; HttpOnly; Path=/; Max-Age=0'),
  ADMIN_COOKIE: 'stelis_admin',
}));

// ── Mock requireAdminSessionFromContext ─────────────────────────────────
vi.mock('../src/requireAdminSession.js', () => ({
  requireAdminSessionFromContext: vi.fn().mockResolvedValue(null),
}));

import { createAuthRoutes, type AuthRoutesRuntime } from '../src/routes/auth.js';
import type { RelayAndStudioAppApiContext } from '../src/context.js';
import { requireAdminSessionFromContext } from '../src/requireAdminSession.js';
import { ADMIN_AUDIT_LOG_KEY } from '../src/adminAuditLog.js';

const ADMIN_ORIGIN = 'https://admin.example';
const ADMIN_ADDRESS = '0x' + 'a'.repeat(64);
const ADMIN_AUTH = {
  jwt: {
    jwtSecret: 'x'.repeat(32),
    sessionExpiry: '1h',
    issuer: 'app-api',
  },
  cookie: {
    maxAgeSeconds: 3_600,
    secure: false,
    domain: null,
  },
} as const;

const AUTH_RUNTIME: AuthRoutesRuntime = {
  admission: {
    resolveClientIp: mockResolveClientIp,
    host: {
      abuseBlocker: {
        checkIp: mockCheckIp,
        checkSubject: mockCheckSubject,
        recordSponsorFailure: mockRecordSponsorFailure,
      },
      rateLimiter: { check: mockRateLimitCheck },
    },
  },
  admin: {
    address: ADMIN_ADDRESS,
    allowedOrigins: [ADMIN_ORIGIN],
    auth: {
      jwt: {
        ...ADMIN_AUTH.jwt,
      },
      cookie: {
        ...ADMIN_AUTH.cookie,
      },
    },
  },
};

function adminJsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { Origin: ADMIN_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function adminPost(): RequestInit {
  return { method: 'POST', headers: { Origin: ADMIN_ORIGIN } };
}

function clientIpResolutionError(): Error {
  return new ClientIpResolutionError('Client IP could not be resolved');
}

function codedError(code: HostErrorCode, meta: Record<string, unknown> = {}) {
  return { error: hostErrorPublicMessage(code), code, ...meta };
}

describe('auth routes', () => {
  let app: Hono;
  let mountedContext: RelayAndStudioAppApiContext;

  function mountAuthRoutes(
    context: RelayAndStudioAppApiContext = {
      redis: mockRedis,
    } as unknown as RelayAndStudioAppApiContext,
    runtime: AuthRoutesRuntime = AUTH_RUNTIME,
  ): void {
    mountedContext = context;
    const routes = createAuthRoutes(context, runtime);
    app = new Hono();
    app.route('/auth', routes);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveClientIp.mockReset();
    mockResolveClientIp.mockReturnValue('127.0.0.1');
    mockCheckIp.mockReset();
    mockCheckIp.mockResolvedValue({ blocked: false });
    mockCheckSubject.mockReset();
    mockCheckSubject.mockResolvedValue({ blocked: false });
    mockRecordSponsorFailure.mockReset();
    mockRecordSponsorFailure.mockResolvedValue(undefined);
    mockRateLimitCheck.mockReset();
    mockRateLimitCheck.mockResolvedValue({
      allowed: true,
      retryAfterMs: 0,
      current: 1,
      limit: 100,
    });
    mountAuthRoutes();
  });

  describe('POST /auth/nonce', () => {
    it('does not expose nonce issuance through GET', async () => {
      const res = await app.request('/auth/nonce');
      expect(res.status).toBe(404);
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('returns 200 with nonce string', async () => {
      const res = await app.request('/auth/nonce', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nonce).toBeDefined();
      expect(typeof body.nonce).toBe('string');
      expect(body.nonce).toMatch(/^stelis-admin-login:/);
    });

    it('returns 429 when rate limited', async () => {
      const { checkAndIncrement } = await import('@stelis/core-api/admin');
      (checkAndIncrement as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        allowed: false,
        current: 6,
        retryAfterMs: 900000,
      });
      const res = await app.request('/auth/nonce', { method: 'POST' });
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('900');
      await expect(res.json()).resolves.toEqual(
        codedError('RATE_LIMITED', { retryAfterMs: 900000 }),
      );
    });

    it('returns 400 without issuing a nonce when client IP cannot be resolved', async () => {
      const { checkAndIncrement } = await import('@stelis/core-api/admin');
      mockResolveClientIp.mockImplementationOnce(() => {
        throw clientIpResolutionError();
      });

      const res = await app.request('/auth/nonce', { method: 'POST' });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual(codedError('CLIENT_IP_UNRESOLVED'));
      expect(checkAndIncrement).not.toHaveBeenCalled();
      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(mockRedis.lpush).not.toHaveBeenCalled();
    });

    it('maps unexpected nonce admission errors without exposing internals to clients', async () => {
      const { checkAndIncrement } = await import('@stelis/core-api/admin');
      const failure = new Error('redis unavailable at redis://:secret@redis.example:6379');
      (checkAndIncrement as ReturnType<typeof vi.fn>).mockRejectedValueOnce(failure);

      const res = await app.request('/auth/nonce', { method: 'POST' });

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual(codedError('INTERNAL_ERROR'));
      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/verify', () => {
    it('returns 400 on missing fields', async () => {
      const { verifyAdminSignature } = await import('@stelis/core-api/admin');
      const res = await app.request('/auth/verify', adminJsonPost({ nonce: 'test' }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual(codedError('BAD_REQUEST'));
      expect(verifyAdminSignature).not.toHaveBeenCalled();
    });

    it.each(['nonce', 'signature', 'address'] as const)(
      'returns coded BAD_REQUEST when %s is empty',
      async (field) => {
        const body = {
          nonce: 'valid-nonce',
          signature: 'valid-signature',
          address: '0x' + 'a'.repeat(64),
          [field]: '',
        };

        const res = await app.request('/auth/verify', adminJsonPost(body));

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual(codedError('BAD_REQUEST'));
        expect(mockRedis.del).not.toHaveBeenCalled();
      },
    );

    it('returns 401 on invalid nonce (consumed)', async () => {
      mockRedis.del.mockResolvedValueOnce(0); // nonce not found
      const res = await app.request(
        '/auth/verify',
        adminJsonPost({
          nonce: 'invalid-nonce',
          signature: 'sig',
          address: ADMIN_ADDRESS,
        }),
      );
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual(codedError('ADMIN_UNAUTHORIZED'));
    });

    it('does not consume the nonce when signature verification fails', async () => {
      const { verifyAdminSignature } = await import('@stelis/core-api/admin');
      vi.mocked(verifyAdminSignature).mockResolvedValueOnce(false);
      const res = await app.request(
        '/auth/verify',
        adminJsonPost({
          nonce: 'valid-nonce',
          signature: 'invalid-signature',
          address: ADMIN_ADDRESS,
        }),
      );
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual(codedError('ADMIN_UNAUTHORIZED'));
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('allows only one concurrent valid request to consume a nonce', async () => {
      mockRedis.del.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
      const request = () =>
        app.request(
          '/auth/verify',
          adminJsonPost({
            nonce: 'shared-nonce',
            signature: 'valid-signature',
            address: ADMIN_ADDRESS,
          }),
        );
      const responses = await Promise.all([request(), request()]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
      const rejected = responses.find((response) => response.status === 401);
      await expect(rejected?.json()).resolves.toEqual(codedError('ADMIN_UNAUTHORIZED'));
    });

    it('returns 200 with Set-Cookie on valid verify', async () => {
      const { signAdminJwt, buildAuthCookieHeader } = await import('../src/adminAuth.js');
      mockRedis.del.mockResolvedValueOnce(1); // nonce consumed
      const res = await app.request(
        '/auth/verify',
        adminJsonPost({
          nonce: 'valid-nonce',
          signature: 'valid-sig',
          address: ADMIN_ADDRESS,
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(res.headers.get('Set-Cookie')).toContain('stelis_admin');
      expect(signAdminJwt).toHaveBeenCalledWith(ADMIN_ADDRESS, ADMIN_AUTH.jwt);
      expect(buildAuthCookieHeader).toHaveBeenCalledWith('mock-jwt-token', ADMIN_AUTH.cookie);
      expect(mockCheckSubject.mock.invocationCallOrder[0]).toBeLessThan(
        mockRedis.del.mock.invocationCallOrder[0]!,
      );
      expect(mockRedis.lpush).toHaveBeenCalledWith(ADMIN_AUDIT_LOG_KEY, expect.any(String));
      expect(mockRedis.ltrim).toHaveBeenCalledWith(ADMIN_AUDIT_LOG_KEY, 0, 199);
    });

    it('returns 429 when rate limited', async () => {
      const { checkAndIncrement } = await import('@stelis/core-api/admin');
      (checkAndIncrement as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        allowed: false,
        current: 6,
        retryAfterMs: 900000,
      });
      const res = await app.request(
        '/auth/verify',
        adminJsonPost({
          nonce: 'test-nonce',
          signature: 'sig',
          address: ADMIN_ADDRESS,
        }),
      );
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('900');
      await expect(res.json()).resolves.toEqual(
        codedError('RATE_LIMITED', { retryAfterMs: 900000 }),
      );
    });

    it('returns 400 without rate-limit or audit writes when client IP cannot be resolved', async () => {
      const { checkAndIncrement } = await import('@stelis/core-api/admin');
      mockResolveClientIp.mockImplementationOnce(() => {
        throw clientIpResolutionError();
      });

      const res = await app.request(
        '/auth/verify',
        adminJsonPost({
          nonce: 'test-nonce',
          signature: 'sig',
          address: ADMIN_ADDRESS,
        }),
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual(codedError('CLIENT_IP_UNRESOLVED'));
      expect(checkAndIncrement).not.toHaveBeenCalled();
      expect(mockRedis.lpush).not.toHaveBeenCalled();
    });

    it('calls resetAttempts on successful verify', async () => {
      const { resetAttempts } = await import('@stelis/core-api/admin');
      mockRedis.del.mockResolvedValueOnce(1); // nonce consumed
      await app.request(
        '/auth/verify',
        adminJsonPost({
          nonce: 'valid-nonce',
          signature: 'valid-sig',
          address: ADMIN_ADDRESS,
        }),
      );
      expect(resetAttempts).toHaveBeenCalled();
    });

    it('returns 500 without Set-Cookie when signAdminJwt throws', async () => {
      const { signAdminJwt } = await import('../src/adminAuth.js');
      (signAdminJwt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('JWT signing failed'),
      );
      mockRedis.del.mockResolvedValueOnce(1); // nonce consumed
      const res = await app.request(
        '/auth/verify',
        adminJsonPost({
          nonce: 'valid-nonce',
          signature: 'valid-sig',
          address: ADMIN_ADDRESS,
        }),
      );
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual(codedError('INTERNAL_ERROR'));
      // Set-Cookie must NOT be present — cookie is staged only after all fallible work
      expect(res.headers.get('Set-Cookie')).toBeNull();
    });

    it('rejects each admission layer before credentials, subject checks, or nonce mutation', async () => {
      const { verifyAdminSignature } = await import('@stelis/core-api/admin');

      const wrongOrigin = await app.request('/auth/verify', {
        method: 'POST',
        headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
        body: '{',
      });
      expect(wrongOrigin.status).toBe(401);
      await expect(wrongOrigin.json()).resolves.toEqual(codedError('ADMIN_UNAUTHORIZED'));
      expect(verifyAdminSignature).not.toHaveBeenCalled();

      const malformedBody = await app.request('/auth/verify', {
        method: 'POST',
        headers: { Origin: ADMIN_ORIGIN, 'Content-Type': 'application/json' },
        body: '{',
      });
      expect(malformedBody.status).toBe(400);
      await expect(malformedBody.json()).resolves.toEqual(codedError('BAD_REQUEST'));
      expect(verifyAdminSignature).not.toHaveBeenCalled();

      mockCheckSubject.mockResolvedValueOnce({ blocked: true, retryAfterMs: 5_000 });
      const blockedSubject = await app.request(
        '/auth/verify',
        adminJsonPost({
          nonce: 'valid-nonce',
          signature: 'valid-signature',
          address: ADMIN_ADDRESS,
        }),
      );
      expect(blockedSubject.status).toBe(429);
      await expect(blockedSubject.json()).resolves.toEqual(
        codedError('ABUSE_BLOCKED', { retryAfterMs: 5_000 }),
      );
      expect(vi.mocked(verifyAdminSignature).mock.invocationCallOrder[0]).toBeLessThan(
        mockCheckSubject.mock.invocationCallOrder[0]!,
      );
      expect(mockRedis.del).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/logout', () => {
    it('returns 200 with logout cookie', async () => {
      const { buildLogoutCookieHeader } = await import('../src/adminAuth.js');
      vi.mocked(requireAdminSessionFromContext).mockResolvedValueOnce({
        address: '0xADMIN',
        iat: 1_700_000_000,
        exp: 1_800_000_000,
        iatMs: 1_700_000_000_000,
      });
      const res = await app.request('/auth/logout', adminPost());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
      expect(buildLogoutCookieHeader).toHaveBeenCalledWith(ADMIN_AUTH.cookie);
    });

    it('returns 500 without expiring the cookie when the Redis cutoff update fails', async () => {
      const { raiseAdminSessionNotBefore } = await import('@stelis/core-api/admin');
      vi.mocked(requireAdminSessionFromContext).mockResolvedValueOnce({
        address: '0xADMIN',
        iat: 1_700_000_000,
        exp: 1_800_000_000,
        iatMs: 1_700_000_000_000,
      });
      vi.mocked(raiseAdminSessionNotBefore).mockRejectedValueOnce(new Error('Redis unavailable'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await app.request('/auth/logout', adminPost());
        expect(res.status).toBe(500);
        await expect(res.json()).resolves.toEqual(codedError('INTERNAL_ERROR'));
        expect(res.headers.get('Set-Cookie')).toBeNull();
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('returns coded ADMIN_UNAUTHORIZED without expiring the cookie when session is absent', async () => {
      const res = await app.request('/auth/logout', adminPost());

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual(codedError('ADMIN_UNAUTHORIZED'));
      expect(res.headers.get('Set-Cookie')).toBeNull();
    });
  });

  describe('GET /auth/session', () => {
    it('returns 401 when no session is available', async () => {
      const res = await app.request('/auth/session');
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual(codedError('ADMIN_UNAUTHORIZED'));
    });

    it('returns 200 with session data when authenticated', async () => {
      vi.mocked(requireAdminSessionFromContext).mockResolvedValueOnce({
        address: '0xADMIN',
        iat: 1000,
        exp: 2000,
        iatMs: 1000000,
      });
      const res = await app.request('/auth/session');
      expect(res.status).toBe(200);
      expect(requireAdminSessionFromContext).toHaveBeenCalledWith(
        expect.anything(),
        mountedContext,
        ADMIN_AUTH.jwt,
      );
      const body = await res.json();
      expect(body.address).toBe('0xADMIN');
      expect(body.exp).toBe(2000);
    });
  });

  describe('POST /auth/renew', () => {
    it('returns 429 when rate limited', async () => {
      const { checkAndIncrement } = await import('@stelis/core-api/admin');
      (checkAndIncrement as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        allowed: false,
        current: 6,
        retryAfterMs: 900000,
      });
      const res = await app.request(
        '/auth/renew',
        adminJsonPost({
          nonce: 'test-nonce',
          signature: 'sig',
          address: ADMIN_ADDRESS,
        }),
      );
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('900');
      await expect(res.json()).resolves.toEqual(
        codedError('RATE_LIMITED', { retryAfterMs: 900000 }),
      );
    });

    it('returns 400 without rate-limit or audit writes when client IP cannot be resolved', async () => {
      const { checkAndIncrement } = await import('@stelis/core-api/admin');
      mockResolveClientIp.mockImplementationOnce(() => {
        throw clientIpResolutionError();
      });

      const res = await app.request(
        '/auth/renew',
        adminJsonPost({
          nonce: 'test-nonce',
          signature: 'sig',
          address: ADMIN_ADDRESS,
        }),
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual(codedError('CLIENT_IP_UNRESOLVED'));
      expect(checkAndIncrement).not.toHaveBeenCalled();
      expect(mockRedis.lpush).not.toHaveBeenCalled();
    });

    it('calls resetAttempts on successful renew', async () => {
      const { resetAttempts } = await import('@stelis/core-api/admin');
      mockRedis.del.mockResolvedValueOnce(1); // nonce consumed
      const res = await app.request(
        '/auth/renew',
        adminJsonPost({
          nonce: 'valid-nonce',
          signature: 'valid-sig',
          address: ADMIN_ADDRESS,
        }),
      );
      expect(res.status).toBe(200);
      expect(resetAttempts).toHaveBeenCalled();
    });
  });
});
