import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  adminAppOrigin: null as string | null,
}));

const host = {
  abuseBlocker: {
    checkIp: vi.fn().mockResolvedValue({ blocked: false }),
    checkSubject: vi.fn().mockResolvedValue({ blocked: false }),
    recordSponsorFailure: vi.fn().mockResolvedValue(undefined),
  },
  rateLimiter: {
    check: vi.fn().mockResolvedValue({ allowed: true, current: 1, limit: 100 }),
  },
};

const redis = {};
const context = {
  mode: 'relay_with_admin',
  host,
  redis,
};

vi.mock('../src/boot.js', () => ({
  runBootValidation: vi.fn(async () => ({
    context: { mode: 'relay_with_admin', network: 'testnet' },
    trustedProxyHops: 0,
    adminAppOrigin: state.adminAppOrigin,
    adminAddress: `0x${'aa'.repeat(32)}`,
    adminAuth: {
      jwt: { jwtSecret: 'x'.repeat(32), sessionExpiry: '1h', issuer: 'app-api' },
      cookie: { maxAgeSeconds: 3_600, secure: false, domain: null },
    },
  })),
}));

vi.mock('../src/context.js', () => ({
  createAppApiContextOwner: vi.fn(() => ({
    start: vi.fn(async () => context),
    stop: vi.fn(async () => undefined),
  })),
}));

vi.mock('../src/adminSessionNotBefore.js', () => ({
  initializeAppApiAdminSessionNotBefore: vi.fn(async () => 0),
  raiseAppApiAdminSessionNotBefore: vi.fn(async () => 0),
}));

import { createApplicationRuntime } from '../src/app.js';

async function startRuntime(adminAppOrigin: string | null) {
  state.adminAppOrigin = adminAppOrigin;
  const runtime = createApplicationRuntime({
    clientIpSourceProvider: () => ({ directIp: '127.0.0.1' }),
  });
  await runtime.start();
  return runtime;
}

async function malformedAdminMutation(
  runtime: ReturnType<typeof createApplicationRuntime>,
  origin?: string,
) {
  return runtime.fetch(
    new Request('http://host.test/admin/blocklist', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...(origin === undefined ? {} : { Origin: origin }),
      },
      body: '{',
    }),
  );
}

describe('production-composed browser policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps public SDK access open and owns the complete Admin origin boundary', async () => {
    const withoutAdminOrigin = await startRuntime(null);
    try {
      for (const origin of ['https://first-dapp.example', 'https://second-dapp.example']) {
        const response = await withoutAdminOrigin.fetch(
          new Request('http://host.test/relay/status', { headers: { Origin: origin } }),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(response.headers.get('access-control-allow-credentials')).toBeNull();
      }

      const studioPreflight = await withoutAdminOrigin.fetch(
        new Request('http://host.test/studio/promotions', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://third-dapp.example',
            'Access-Control-Request-Method': 'GET',
          },
        }),
      );
      expect(studioPreflight.status).toBe(204);
      expect(studioPreflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(studioPreflight.headers.get('access-control-allow-credentials')).toBeNull();

      const suppliedOrigin = await malformedAdminMutation(
        withoutAdminOrigin,
        'https://public-dapp.example',
      );
      expect(suppliedOrigin.status).toBe(401);
      expect(suppliedOrigin.headers.get('access-control-allow-origin')).toBeNull();

      const originless = await malformedAdminMutation(withoutAdminOrigin);
      expect(originless.status).toBe(400);
    } finally {
      await withoutAdminOrigin.stop();
    }

    const adminOrigin = 'https://admin.example';
    const withAdminOrigin = await startRuntime(adminOrigin);
    try {
      const exactOrigin = await malformedAdminMutation(withAdminOrigin, adminOrigin);
      expect(exactOrigin.status).toBe(400);
      expect(exactOrigin.headers.get('access-control-allow-origin')).toBe(adminOrigin);
      expect(exactOrigin.headers.get('access-control-allow-credentials')).toBe('true');

      const differentOrigin = await malformedAdminMutation(
        withAdminOrigin,
        'https://other-admin.example',
      );
      expect(differentOrigin.status).toBe(401);
      expect(differentOrigin.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await withAdminOrigin.stop();
    }
  });
});
