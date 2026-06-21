/**
 * Admin session policy tests — direct verification of cookie, issuer, not_before.
 *
 * These tests exercise the REAL adminAuth + requireAdminSession implementation
 * with a mocked Redis layer — no mock on the module under test itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ── Mock Redis only ─────────────────────────────────────────────────────────
const { mockRedis } = vi.hoisted(() => ({
  mockRedis: {
    get: vi.fn<(key: string) => Promise<string | null>>().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(1),
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue(undefined),
    lrange: vi.fn().mockResolvedValue([]),
    scan: vi.fn().mockResolvedValue([]),
    ttl: vi.fn().mockResolvedValue(-1),
  },
}));

// ── Mock env ────────────────────────────────────────────────────────────────
const TEST_JWT_SECRET = 'test-admin-jwt-secret-at-least-32-chars!!';

vi.mock('../src/env.js', () => ({
  requireEnv: vi.fn().mockImplementation((key: string) => {
    const vals: Record<string, string> = {
      REDIS_URL: 'redis://localhost:6379',
      ADMIN_JWT_SECRET: TEST_JWT_SECRET,
    };
    if (vals[key]) return vals[key];
    throw new Error(`Missing: ${key}`);
  }),
}));

// ── Import REAL modules (not mocked) ────────────────────────────────────────
import {
  ADMIN_COOKIE,
  signAdminJwt,
  verifyAdminJwt,
  buildAuthCookieHeader,
} from '../src/adminAuth.js';
import { requireAdminSession, NOT_BEFORE_KEY } from '../src/requireAdminSession.js';

// ────────────────────────────────────────────────────────────────────────────
// § 1. Constant verification
// ────────────────────────────────────────────────────────────────────────────
describe('admin session policy constants', () => {
  it('cookie name is stelis_admin', () => {
    expect(ADMIN_COOKIE).toBe('stelis_admin');
  });

  it('not_before key is stelis:app-api:admin:not_before', () => {
    expect(NOT_BEFORE_KEY).toBe('stelis:app-api:admin:not_before');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// § 2. Issuer boundary
// ────────────────────────────────────────────────────────────────────────────
describe('issuer boundary', () => {
  it('signAdminJwt embeds issuer = app-api', async () => {
    const token = await signAdminJwt('0xADMIN');
    // Decode payload (base64url)
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(payload.iss).toBe('app-api');
  });

  it('verifyAdminJwt accepts token with issuer app-api', async () => {
    const token = await signAdminJwt('0xADMIN');
    const session = await verifyAdminJwt(token);
    expect(session).not.toBeNull();
    expect(session!.address).toBe('0xADMIN');
  });

  it('verifyAdminJwt rejects token with wrong issuer', async () => {
    // Sign with a different issuer using jose directly
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode(TEST_JWT_SECRET);
    const token = await new SignJWT({
      address: '0xADMIN',
      iatMs: Date.now(),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer('wrong-issuer')
      .sign(secret);

    const session = await verifyAdminJwt(token);
    expect(session).toBeNull();
  });

  it('verifyAdminJwt rejects token without issuer', async () => {
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode(TEST_JWT_SECRET);
    const token = await new SignJWT({
      address: '0xADMIN',
      iatMs: Date.now(),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      // No issuer set
      .sign(secret);

    const session = await verifyAdminJwt(token);
    expect(session).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// § 3. Cookie parsing
// ────────────────────────────────────────────────────────────────────────────
describe('cookie parsing', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    // Test route that exercises requireAdminSession directly
    app.get('/test-session', async (c) => {
      const session = await requireAdminSession(c, mockRedis);
      if (!session) return c.json({ ok: false }, 401);
      return c.json({ ok: true, address: session.address });
    });
  });

  it('extracts token from stelis_admin cookie', async () => {
    const token = await signAdminJwt('0xADMIN');
    const now = Date.now();
    mockRedis.get.mockImplementation(async (key: string) => {
      if (key === NOT_BEFORE_KEY) return String(now - 1000);
      return null;
    });

    const res = await app.request('/test-session', {
      headers: { cookie: `stelis_admin=${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.address).toBe('0xADMIN');
  });

  it('ignores token in wrong cookie name', async () => {
    const token = await signAdminJwt('0xADMIN');
    mockRedis.get.mockResolvedValue(String(Date.now() - 1000));

    // Use a different cookie name
    const res = await app.request('/test-session', {
      headers: { cookie: `stelis_studio_admin=${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects token in wrong cookie name (stelis_main_admin)', async () => {
    const token = await signAdminJwt('0xADMIN');
    mockRedis.get.mockResolvedValue(String(Date.now() - 1000));

    const res = await app.request('/test-session', {
      headers: { cookie: `stelis_main_admin=${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when no cookie header', async () => {
    const res = await app.request('/test-session');
    expect(res.status).toBe(401);
  });

  it('buildAuthCookieHeader uses stelis_admin cookie name', () => {
    const header = buildAuthCookieHeader('jwt-token-here');
    expect(header).toMatch(/^stelis_admin=jwt-token-here/);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// § 4. Not-before check
// ────────────────────────────────────────────────────────────────────────────
describe('not_before enforcement', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.get('/test-session', async (c) => {
      const session = await requireAdminSession(c, mockRedis);
      if (!session) return c.json({ ok: false }, 401);
      return c.json({ ok: true, address: session.address });
    });
  });

  it('accepts session when iatMs >= not_before', async () => {
    const token = await signAdminJwt('0xADMIN');
    const now = Date.now();
    // not_before is in the past → session should be accepted
    mockRedis.get.mockImplementation(async (key: string) => {
      if (key === NOT_BEFORE_KEY) return String(now - 10000);
      return null;
    });

    const res = await app.request('/test-session', {
      headers: { cookie: `stelis_admin=${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects session when iatMs < not_before (server restarted)', async () => {
    const token = await signAdminJwt('0xADMIN');
    // not_before is in the future → session issued before restart
    mockRedis.get.mockImplementation(async (key: string) => {
      if (key === NOT_BEFORE_KEY) return String(Date.now() + 60000);
      return null;
    });

    const res = await app.request('/test-session', {
      headers: { cookie: `stelis_admin=${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('reads from the correct Redis key (stelis:app-api:admin:not_before)', async () => {
    const token = await signAdminJwt('0xADMIN');
    mockRedis.get.mockResolvedValue(String(Date.now() - 1000));

    await app.request('/test-session', {
      headers: { cookie: `stelis_admin=${token}` },
    });

    // Verify the exact key that was queried
    const getCall = mockRedis.get.mock.calls.find(
      (call) => call[0] === 'stelis:app-api:admin:not_before',
    );
    expect(getCall).toBeDefined();
  });

  it('rejects unsafe integer not_before values', async () => {
    const token = await signAdminJwt('0xADMIN');
    mockRedis.get.mockResolvedValue('9007199254740993');

    const res = await app.request('/test-session', {
      headers: { cookie: `stelis_admin=${token}` },
    });
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// § 5. Fail-Closed Behavior
// ────────────────────────────────────────────────────────────────────────────
describe('fail-closed behavior', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.get('/test-session', async (c) => {
      const session = await requireAdminSession(c, mockRedis);
      if (!session) return c.json({ ok: false }, 401);
      return c.json({ ok: true, address: session.address });
    });
  });

  it('rejects when Redis not_before key is missing (null)', async () => {
    const token = await signAdminJwt('0xADMIN');
    mockRedis.get.mockResolvedValue(null);

    const res = await app.request('/test-session', {
      headers: { cookie: `stelis_admin=${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects when not_before value is non-numeric', async () => {
    const token = await signAdminJwt('0xADMIN');
    mockRedis.get.mockImplementation(async (key: string) => {
      if (key === NOT_BEFORE_KEY) return 'not-a-number';
      return null;
    });

    const res = await app.request('/test-session', {
      headers: { cookie: `stelis_admin=${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects when not_before value has trailing characters (parseInt abuse)', async () => {
    const token = await signAdminJwt('0xADMIN');
    mockRedis.get.mockImplementation(async (key: string) => {
      // parseInt('123abc') = 123, but /^\d+$/ rejects
      if (key === NOT_BEFORE_KEY) return '123abc';
      return null;
    });

    const res = await app.request('/test-session', {
      headers: { cookie: `stelis_admin=${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects when Redis throws (connection failure)', async () => {
    const token = await signAdminJwt('0xADMIN');
    mockRedis.get.mockRejectedValue(new Error('Redis connection reset'));

    const res = await app.request('/test-session', {
      headers: { cookie: `stelis_admin=${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects expired JWT (valid cookie name, valid not_before)', async () => {
    // Create a token that's already expired using jose directly
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode(TEST_JWT_SECRET);
    const token = await new SignJWT({
      address: '0xADMIN',
      iatMs: Date.now() - 7200000,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600) // expired 1h ago
      .setIssuer('app-api')
      .sign(secret);

    mockRedis.get.mockResolvedValue(String(Date.now() - 86400000));

    const res = await app.request('/test-session', {
      headers: { cookie: `stelis_admin=${token}` },
    });
    expect(res.status).toBe(401);
  });
});
