import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  runBootValidation: vi.fn(),
  createContext: vi.fn(),
  createRelayRoutes: vi.fn(),
  createAuthRoutes: vi.fn(),
  createAdminRoutes: vi.fn(),
  createStudioRoutes: vi.fn(),
}));

vi.mock('../src/boot.js', () => ({
  runBootValidation: mocks.runBootValidation,
}));

vi.mock('../src/context.js', () => ({
  createContext: mocks.createContext,
}));

vi.mock('../src/routes/relay.js', () => ({
  createRelayRoutes: mocks.createRelayRoutes,
}));

vi.mock('../src/routes/auth.js', () => ({
  createAuthRoutes: mocks.createAuthRoutes,
}));

vi.mock('../src/routes/admin.js', () => ({
  createAdminRoutes: mocks.createAdminRoutes,
}));

vi.mock('../src/routes/studio.js', () => ({
  createStudioRoutes: mocks.createStudioRoutes,
}));

import { createApp } from '../src/app.js';

const JWT_SECRET = 'secret-that-must-not-leave-create-app';
const HMAC_SECRET = 'internal-hmac-that-must-not-be-public';
const ADMIN_ADDRESS = `0x${'aa'.repeat(32)}`;
const contextInput = { sponsorLeaseHmacSecret: HMAC_SECRET, network: 'testnet' as const };
const context = { runtime: 'context' };

function bootValidationResult() {
  return {
    runtimeInput: {
      context: contextInput,
      trustedProxyHops: 1,
      corsAllowedOrigins: ['https://admin.snapshot.example'],
      adminAddress: ADMIN_ADDRESS,
      adminAuth: {
        jwt: {
          jwtSecret: JWT_SECRET,
          sessionExpiry: '1h',
          issuer: 'app-api',
        },
        cookie: {
          maxAgeSeconds: 3_600,
          secure: true,
          domain: '.snapshot.example',
        },
      },
      adminSponsorOperations: {
        refillEnabled: true,
        refillTargetMist: 10_000_000_000n,
        warnMist: 5_000_000_000n,
      },
    },
    publicSummary: {
      mode: 'generic',
      studioEnabled: false,
      network: 'testnet',
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runBootValidation.mockResolvedValue(bootValidationResult());
  mocks.createContext.mockResolvedValue(context);
  mocks.createRelayRoutes.mockImplementation(() => new Hono());
  mocks.createAuthRoutes.mockImplementation(() => new Hono());
  mocks.createAdminRoutes.mockImplementation(() => new Hono());
  mocks.createStudioRoutes.mockImplementation(() => new Hono());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createApp runtime input boundary', () => {
  it('returns only the public summary and keeps route/CORS slices fixed after env mutation', async () => {
    vi.stubEnv('CORS_ORIGINS', 'https://admin.mutated.example');
    vi.stubEnv('ADMIN_JWT_SECRET', 'mutated-secret');
    vi.stubEnv('TRUSTED_PROXY_HOPS', '0');

    const result = await createApp();

    expect(Object.keys(result).sort()).toEqual(['app', 'bootResult']);
    expect(result.bootResult).toEqual({
      mode: 'generic',
      studioEnabled: false,
      network: 'testnet',
    });
    expect(JSON.stringify(result.bootResult)).not.toContain(JWT_SECRET);
    expect(JSON.stringify(result.bootResult)).not.toContain(HMAC_SECRET);

    expect(mocks.createContext).toHaveBeenCalledWith(contextInput);
    const [authContextPromise, authRuntime] = mocks.createAuthRoutes.mock.calls[0];
    await expect(authContextPromise).resolves.toBe(context);
    expect(typeof authRuntime.resolveClientIp).toBe('function');
    expect(authRuntime).toEqual({
      resolveClientIp: authRuntime.resolveClientIp,
      adminAddress: ADMIN_ADDRESS,
      adminAuth: {
        jwt: {
          jwtSecret: JWT_SECRET,
          sessionExpiry: '1h',
          issuer: 'app-api',
        },
        cookie: { maxAgeSeconds: 3_600, secure: true, domain: '.snapshot.example' },
      },
    });
    const [, adminRuntime] = mocks.createAdminRoutes.mock.calls[0];
    expect(adminRuntime).toEqual({
      resolveClientIp: authRuntime.resolveClientIp,
      network: 'testnet',
      adminAddress: ADMIN_ADDRESS,
      adminJwt: {
        jwtSecret: JWT_SECRET,
        sessionExpiry: '1h',
        issuer: 'app-api',
      },
      refillEnabled: true,
      refillTargetMist: 10_000_000_000n,
      warnMist: 5_000_000_000n,
    });
    expect(mocks.createRelayRoutes).toHaveBeenCalledWith(
      authContextPromise,
      authRuntime.resolveClientIp,
    );
    expect(mocks.createStudioRoutes).toHaveBeenCalledWith(
      authContextPromise,
      authRuntime.resolveClientIp,
    );

    const allowed = await result.app.request('/auth/preflight', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://admin.snapshot.example',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(
      'https://admin.snapshot.example',
    );

    const mutated = await result.app.request('/auth/preflight', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://admin.mutated.example',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(mutated.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not return an app when eager context creation fails', async () => {
    mocks.createContext.mockRejectedValueOnce(new Error('context boot failed'));

    await expect(createApp()).rejects.toThrow('context boot failed');
    expect(mocks.createRelayRoutes).not.toHaveBeenCalled();
    expect(mocks.createAuthRoutes).not.toHaveBeenCalled();
    expect(mocks.createAdminRoutes).not.toHaveBeenCalled();
    expect(mocks.createStudioRoutes).not.toHaveBeenCalled();
  });
});
