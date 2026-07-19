import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createServer } from 'node:http';
import { Server as NetServer } from 'node:net';
import { parseHostHealthResponse } from '@stelis/contracts';

const mocks = vi.hoisted(() => ({
  HostContextInitializationCleanupError: class extends AggregateError {
    constructor(initializationError: unknown, cleanupError: unknown) {
      super(
        [initializationError, cleanupError],
        'Host context initialization and cleanup both failed',
      );
    }
  },
  runBootValidation: vi.fn(),
  createAppApiContextOwner: vi.fn(),
  createRelayRoutes: vi.fn(),
  createAuthRoutes: vi.fn(),
  createAdminRoutes: vi.fn(),
  createStudioRoutes: vi.fn(),
  createAdminRedisAdapter: vi.fn(),
  initializeAppApiAdminSessionNotBefore: vi.fn(),
}));

vi.mock('../src/boot.js', () => ({
  runBootValidation: mocks.runBootValidation,
}));

vi.mock('../src/context.js', () => ({
  createAppApiContextOwner: mocks.createAppApiContextOwner,
  HostContextInitializationCleanupError: mocks.HostContextInitializationCleanupError,
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

vi.mock('../src/adminRedis.js', () => ({
  createAdminRedisAdapter: mocks.createAdminRedisAdapter,
}));

vi.mock('../src/adminSessionNotBefore.js', () => ({
  initializeAppApiAdminSessionNotBefore: mocks.initializeAppApiAdminSessionNotBefore,
}));

import { createApplicationRuntime } from '../src/app.js';

const JWT_SECRET = 'secret-that-must-not-leave-application-runtime';
const HMAC_SECRET = 'internal-hmac-that-must-not-be-public';
const ADMIN_ADDRESS = `0x${'aa'.repeat(32)}`;
const adminRedis = { runtime: 'admin-redis' };

function relayOnlyBoot() {
  return {
    context: {
      mode: 'relay_only' as const,
      sponsorLeaseHmacSecret: HMAC_SECRET,
      network: 'testnet' as const,
    },
    trustedProxyHops: 1,
  };
}

function relayWithAdminBoot(adminAppOrigin: string | null = 'https://admin.snapshot.example') {
  return {
    context: {
      mode: 'relay_with_admin' as const,
      sponsorLeaseHmacSecret: HMAC_SECRET,
      network: 'testnet' as const,
    },
    trustedProxyHops: 1,
    adminAppOrigin,
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
  };
}

function relayWithAdminAndStudioBoot() {
  const admin = relayWithAdminBoot();
  return {
    ...admin,
    context: {
      ...admin.context,
      mode: 'relay_with_admin_and_studio' as const,
      studio: {
        globalAllowedTargets: new Set<string>(),
        developerJwtTrustConfig: {
          issuer: 'https://auth.runtime.test',
          audience: 'stelis-studio',
          algorithm: 'RS256' as const,
          publicKeyPem: 'test-only-key-not-parsed-by-application-runtime',
          claimPaths: { userId: 'sub', senderAddress: 'wallet_address' },
        },
        developerJwtVerifyUrl: null,
      },
    },
  };
}

function contextResources(
  trace: string[] = [],
  options: {
    readonly mode?: 'relay_only' | 'relay_with_admin' | 'relay_with_admin_and_studio';
    readonly domainStopError?: Error;
  } = {},
) {
  const context = {
    mode: options.mode ?? 'relay_only',
    host: { runtime: 'host' },
    redis: { runtime: 'redis' },
  };
  const lifecycle = {
    stopSponsorOperations: vi.fn(async () => {
      trace.push('sponsor-operations.stop');
    }),
    stopDomainTasks: vi.fn(async () => {
      trace.push('domain-tasks.stop');
      if (options.domainStopError) throw options.domainStopError;
    }),
    disposeHostContext: vi.fn(async () => {
      trace.push('host-context.dispose');
    }),
    closeRedis: vi.fn(async () => {
      trace.push('redis.close');
    }),
  };
  let activeStopTask: Promise<void> | null = null;
  let completedStopTask: Promise<void> | null = null;
  const stop = vi.fn((): Promise<void> => {
    if (completedStopTask !== null) return completedStopTask;
    if (activeStopTask !== null) return activeStopTask;
    const attempt = (async () => {
      const failures: unknown[] = [];
      for (const phase of [
        lifecycle.stopSponsorOperations,
        lifecycle.stopDomainTasks,
        lifecycle.disposeHostContext,
        lifecycle.closeRedis,
      ]) {
        try {
          await phase();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'context stop failed');
    })();
    activeStopTask = attempt;
    void attempt.then(
      () => {
        completedStopTask = attempt;
        if (activeStopTask === attempt) activeStopTask = null;
      },
      () => {
        if (activeStopTask === attempt) activeStopTask = null;
      },
    );
    return attempt;
  });
  return {
    context,
    lifecycle,
    runtime: {
      start: vi.fn(async () => context),
      stop,
    },
  };
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test port listener did not expose an IP address');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function occupyPort(): Promise<{
  readonly port: number;
  close(): Promise<void>;
}> {
  const port = await reservePort();
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Occupy the same all-interface binding that ApplicationRuntime uses.
    server.listen(port, resolve);
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.runBootValidation.mockResolvedValue(relayOnlyBoot());
  mocks.createAppApiContextOwner.mockReturnValue(contextResources().runtime);
  mocks.createRelayRoutes.mockImplementation(() => new Hono());
  mocks.createAuthRoutes.mockImplementation(() => new Hono());
  mocks.createAdminRoutes.mockImplementation(() => new Hono());
  mocks.createStudioRoutes.mockImplementation(() => new Hono());
  mocks.createAdminRedisAdapter.mockReturnValue(adminRedis);
  mocks.initializeAppApiAdminSessionNotBefore.mockResolvedValue(1);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ApplicationRuntime input and resource boundary', () => {
  it.each(['relay_only', 'relay_with_admin', 'relay_with_admin_and_studio'] as const)(
    'accepts the current Host mode in the health wire response: %s',
    (mode) => {
      expect(parseHostHealthResponse({ status: 'ok', mode })).toEqual({ status: 'ok', mode });
    },
  );

  it.each(['relay_and_studio', 'generic', 'unknown'])(
    'rejects a non-current Host mode in the health wire response: %s',
    (mode) => {
      expect(() => parseHostHealthResponse({ status: 'ok', mode })).toThrow();
    },
  );

  it('keeps `relay_only` construction free of Admin credentials and session state', async () => {
    const boot = relayOnlyBoot();
    mocks.runBootValidation.mockResolvedValueOnce(boot);
    const resources = contextResources();
    mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);
    const runtime = createApplicationRuntime();

    const bootResult = await runtime.start();
    expect(bootResult).toEqual({ mode: 'relay_only' });
    expect(JSON.stringify(bootResult)).not.toContain(HMAC_SECRET);
    expect(mocks.runBootValidation).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(mocks.createAppApiContextOwner).toHaveBeenCalledWith(boot.context);
    expect(resources.runtime.start).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(mocks.initializeAppApiAdminSessionNotBefore).not.toHaveBeenCalled();

    expect(mocks.createAuthRoutes).not.toHaveBeenCalled();
    expect(mocks.createAdminRoutes).not.toHaveBeenCalled();
    expect(mocks.createStudioRoutes).not.toHaveBeenCalled();

    const health = await runtime.fetch(new Request('http://host.test/health'));
    await expect(health.json()).resolves.toEqual({ status: 'ok', mode: 'relay_only' });
    for (const [path, code] of [
      ['/admin/auth/nonce', 'ADMIN_UNAVAILABLE'],
      ['/admin/promotions', 'ADMIN_UNAVAILABLE'],
      ['/studio/promotions', 'STUDIO_UNAVAILABLE'],
    ] as const) {
      const response = await runtime.fetch(new Request(`http://host.test${path}`));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ code });
    }
    const studioPreflight = await runtime.fetch(
      new Request('http://host.test/studio/promotions', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.test',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Authorization',
        },
      }),
    );
    expect(studioPreflight.status).toBe(204);
    expect(studioPreflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(studioPreflight.headers.get('access-control-allow-credentials')).toBeNull();
    expect(studioPreflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(studioPreflight.headers.get('access-control-allow-methods')?.split(',')).toEqual([
      'GET',
      'POST',
      'OPTIONS',
    ]);
    const relayPreflight = await runtime.fetch(
      new Request('http://host.test/relay/status', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.test',
          'Access-Control-Request-Method': 'GET',
        },
      }),
    );
    expect(relayPreflight.headers.get('access-control-allow-methods')?.split(',')).toEqual([
      'GET',
      'POST',
      'OPTIONS',
    ]);
    const studioBrowserResponse = await runtime.fetch(
      new Request('http://host.test/studio/promotions', {
        headers: {
          Origin: 'https://example.test',
          Authorization: 'Bearer unavailable-mode-test',
        },
      }),
    );
    expect(studioBrowserResponse.status).toBe(503);
    expect(studioBrowserResponse.headers.get('access-control-allow-origin')).toBe('*');
    await expect(studioBrowserResponse.json()).resolves.toMatchObject({
      code: 'STUDIO_UNAVAILABLE',
    });
    await runtime.stop();
  });

  it('keeps previous Admin route prefixes absent', async () => {
    const boot = relayOnlyBoot();
    mocks.runBootValidation.mockResolvedValueOnce(boot);
    const resources = contextResources();
    mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);
    const runtime = createApplicationRuntime();
    await runtime.start();

    for (const path of ['/auth/session', '/api/logs']) {
      const response = await runtime.fetch(new Request(`http://host.test${path}`));
      expect(response.status).toBe(404);
    }
    await runtime.stop();
  });

  it('mounts Admin without creating Studio routes for an Admin-only Host', async () => {
    const boot = relayWithAdminBoot(null);
    mocks.runBootValidation.mockResolvedValueOnce(boot);
    const resources = contextResources([], { mode: 'relay_with_admin' });
    mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);
    const runtime = createApplicationRuntime();

    await expect(runtime.start()).resolves.toEqual({ mode: 'relay_with_admin' });
    expect(mocks.createAuthRoutes).toHaveBeenCalledOnce();
    expect(mocks.createAdminRoutes).toHaveBeenCalledOnce();
    expect(mocks.createStudioRoutes).not.toHaveBeenCalled();
    const adminPreflight = await runtime.fetch(
      new Request('http://host.test/admin/auth/session', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://public-app.example',
          'Access-Control-Request-Method': 'GET',
        },
      }),
    );
    expect(adminPreflight.headers.get('access-control-allow-origin')).toBeNull();
    const response = await runtime.fetch(
      new Request('http://host.test/studio/promotions', {
        headers: { Origin: 'https://example.test' },
      }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'STUDIO_UNAVAILABLE' });
    await runtime.stop();
  });

  it.each([
    {
      name: 'Admin only',
      boot: relayWithAdminBoot,
      mode: 'relay_with_admin' as const,
      studioRoutes: false,
    },
    {
      name: 'Admin and Studio',
      boot: relayWithAdminAndStudioBoot,
      mode: 'relay_with_admin_and_studio' as const,
      studioRoutes: true,
    },
  ])('uses one ordered Admin startup process for $name', async (testCase) => {
    const trace: string[] = [];
    const cutoffGate = deferred();
    const boot = testCase.boot();
    const resources = contextResources(trace, { mode: testCase.mode });
    resources.runtime.start.mockImplementationOnce(async () => {
      trace.push('context.start');
      return resources.context;
    });
    mocks.runBootValidation.mockResolvedValueOnce(boot);
    mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);
    mocks.initializeAppApiAdminSessionNotBefore.mockImplementationOnce(async () => {
      trace.push('session-cutoff-initialization.start');
      await cutoffGate.promise;
      trace.push('session-cutoff-initialization.finish');
      return 1;
    });
    mocks.createRelayRoutes.mockImplementationOnce(() => {
      trace.push('routes.relay');
      return new Hono();
    });
    mocks.createAuthRoutes.mockImplementationOnce(() => {
      trace.push('routes.auth');
      return new Hono();
    });
    mocks.createAdminRoutes.mockImplementationOnce(() => {
      trace.push('routes.admin');
      return new Hono();
    });
    if (testCase.studioRoutes) {
      mocks.createStudioRoutes.mockImplementationOnce(() => {
        trace.push('routes.studio');
        return new Hono();
      });
    }
    const runtime = createApplicationRuntime();

    const startTask = runtime.start();
    await vi.waitFor(() =>
      expect(mocks.initializeAppApiAdminSessionNotBefore).toHaveBeenCalledOnce(),
    );
    expect(trace).toEqual(['context.start', 'session-cutoff-initialization.start']);
    expect(mocks.createRelayRoutes).not.toHaveBeenCalled();
    expect(mocks.createAuthRoutes).not.toHaveBeenCalled();
    expect(mocks.createAdminRoutes).not.toHaveBeenCalled();
    expect(mocks.createStudioRoutes).not.toHaveBeenCalled();

    cutoffGate.resolve();
    await expect(startTask).resolves.toEqual({ mode: testCase.mode });
    expect(trace).toEqual([
      'context.start',
      'session-cutoff-initialization.start',
      'session-cutoff-initialization.finish',
      'routes.relay',
      'routes.auth',
      'routes.admin',
      ...(testCase.studioRoutes ? ['routes.studio'] : []),
    ]);
    expect(mocks.createStudioRoutes).toHaveBeenCalledTimes(testCase.studioRoutes ? 1 : 0);
    await runtime.stop();
  });

  it.each(['context start', 'session cutoff initialization'] as const)(
    'does not compose Admin routes when stop aborts during %s',
    async (stage) => {
      const gate = deferred();
      const resources = contextResources([], { mode: 'relay_with_admin' });
      if (stage === 'context start') {
        resources.runtime.start.mockImplementationOnce(async () => {
          await gate.promise;
          return resources.context;
        });
      } else {
        mocks.initializeAppApiAdminSessionNotBefore.mockImplementationOnce(async () => {
          await gate.promise;
          return 1;
        });
      }
      mocks.runBootValidation.mockResolvedValueOnce(relayWithAdminBoot());
      mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);
      const runtime = createApplicationRuntime();

      const startTask = runtime.start();
      if (stage === 'context start') {
        await vi.waitFor(() => expect(resources.runtime.start).toHaveBeenCalledOnce());
      } else {
        await vi.waitFor(() =>
          expect(mocks.initializeAppApiAdminSessionNotBefore).toHaveBeenCalledOnce(),
        );
      }
      const stopTask = runtime.stop();
      gate.resolve();

      await expect(startTask).rejects.toMatchObject({ name: 'AbortError' });
      await expect(stopTask).resolves.toBeUndefined();
      expect(resources.runtime.stop).toHaveBeenCalledOnce();
      expect(mocks.createRelayRoutes).not.toHaveBeenCalled();
      expect(mocks.createAuthRoutes).not.toHaveBeenCalled();
      expect(mocks.createAdminRoutes).not.toHaveBeenCalled();
      expect(mocks.createStudioRoutes).not.toHaveBeenCalled();
      expect(mocks.initializeAppApiAdminSessionNotBefore).toHaveBeenCalledTimes(
        stage === 'context start' ? 0 : 1,
      );
    },
  );

  it('uses one Admin-and-Studio snapshot for routes, CORS, and session initialization', async () => {
    const boot = relayWithAdminAndStudioBoot();
    mocks.runBootValidation.mockResolvedValueOnce(boot);
    const resources = contextResources([], { mode: 'relay_with_admin_and_studio' });
    mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);
    const runtime = createApplicationRuntime();

    const bootResult = await runtime.start();
    expect(bootResult).toEqual({ mode: 'relay_with_admin_and_studio' });
    expect(JSON.stringify(bootResult)).not.toContain(JWT_SECRET);
    expect(JSON.stringify(bootResult)).not.toContain(HMAC_SECRET);
    expect(mocks.createAdminRedisAdapter).toHaveBeenCalledWith(resources.context.redis);
    expect(mocks.initializeAppApiAdminSessionNotBefore).toHaveBeenCalledWith(
      adminRedis,
      expect.any(Number),
    );
    expect(mocks.createAppApiContextOwner.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.initializeAppApiAdminSessionNotBefore.mock.invocationCallOrder[0],
    );

    const [, authRuntime] = mocks.createAuthRoutes.mock.calls[0];
    expect(authRuntime.admin).toEqual({
      address: ADMIN_ADDRESS,
      auth: boot.adminAuth,
    });
    const adminRuntime = mocks.createAdminRoutes.mock.calls[0]?.[1];
    expect(adminRuntime).toMatchObject({
      network: 'testnet',
      admin: {
        address: ADMIN_ADDRESS,
        jwt: boot.adminAuth.jwt,
      },
    });
    expect(authRuntime.admission).toBe(adminRuntime.admission);

    const allowed = await runtime.fetch(
      new Request('http://host.test/admin/promotions/promotion-1', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://admin.snapshot.example',
          'Access-Control-Request-Method': 'PUT',
        },
      }),
    );
    expect(allowed.headers.get('access-control-allow-origin')).toBe(
      'https://admin.snapshot.example',
    );
    expect(allowed.headers.get('access-control-allow-methods')?.split(',')).toEqual([
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'OPTIONS',
    ]);
    const authPreflight = await runtime.fetch(
      new Request('http://host.test/admin/auth/session', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://admin.snapshot.example',
          'Access-Control-Request-Method': 'GET',
        },
      }),
    );
    expect(authPreflight.headers.get('access-control-allow-methods')?.split(',')).toEqual([
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'OPTIONS',
    ]);

    await runtime.stop();
  });

  it('continues reverse cleanup through failure and closes Redis last when start fails', async () => {
    const trace: string[] = [];
    const resources = contextResources(trace, {
      mode: 'relay_with_admin_and_studio',
      domainStopError: new Error('domain stop failed'),
    });
    mocks.runBootValidation.mockResolvedValueOnce(relayWithAdminAndStudioBoot());
    mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);
    mocks.initializeAppApiAdminSessionNotBefore.mockRejectedValueOnce(
      new Error('session cutoff failed'),
    );
    const runtime = createApplicationRuntime();

    const startTask = runtime.start();
    const startFailure = await startTask.catch((error: unknown) => error);
    expect(startFailure).toBeInstanceOf(AggregateError);
    expect(startFailure).toMatchObject({
      message: 'ApplicationRuntime start and cleanup both failed',
    });
    expect((startFailure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'session cutoff failed' }),
      expect.objectContaining({ message: 'context stop failed' }),
    ]);

    expect(trace).toEqual([
      'sponsor-operations.stop',
      'domain-tasks.stop',
      'host-context.dispose',
      'redis.close',
    ]);
    expect(mocks.createRelayRoutes).not.toHaveBeenCalled();
    await expect(runtime.fetch(new Request('http://host.test/health'))).rejects.toThrow(
      'has not started',
    );
    expect(runtime.start()).toBe(startTask);
    expect(mocks.runBootValidation).toHaveBeenCalledOnce();
    expect(resources.runtime.start).toHaveBeenCalledOnce();
  });

  it('retries retained context cleanup after start reports a cleanup failure', async () => {
    const cleanupFailure = new mocks.HostContextInitializationCleanupError(
      new Error('context initialization failed'),
      new Error('acquired resource did not close'),
    );
    const failedRuntime = {
      start: vi.fn().mockRejectedValue(cleanupFailure),
      stop: vi
        .fn()
        .mockRejectedValueOnce(new Error('acquired resource did not close'))
        .mockResolvedValueOnce(undefined),
    };
    mocks.createAppApiContextOwner.mockReturnValueOnce(failedRuntime);
    const runtime = createApplicationRuntime();

    const startFailure = await runtime.start().catch((error: unknown) => error);
    expect(startFailure).toBeInstanceOf(AggregateError);
    expect((startFailure as AggregateError).errors).toEqual([
      cleanupFailure,
      expect.objectContaining({ message: 'acquired resource did not close' }),
    ]);
    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(failedRuntime.stop).toHaveBeenCalledTimes(2);
  });

  it('stops intake immediately, drains a running request, and reuses one stop operation', async () => {
    const trace: string[] = [];
    const resources = contextResources(trace);
    mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);
    const requestGate = deferred();
    let routeEntries = 0;
    mocks.createRelayRoutes.mockImplementationOnce(() => {
      const relay = new Hono();
      relay.get('/held', async (c) => {
        routeEntries += 1;
        trace.push('request.enter');
        await requestGate.promise;
        trace.push('request.leave');
        return c.json({ ok: true });
      });
      return relay;
    });
    const runtime = createApplicationRuntime();
    const port = await reservePort();
    await runtime.start({ port });

    const runningRequest = fetch(`http://127.0.0.1:${port}/relay/held`);
    await vi.waitFor(() => expect(routeEntries).toBe(1));

    const firstStop = runtime.stop();
    const secondStop = runtime.stop();
    expect(secondStop).toBe(firstStop);
    const rejected = await fetch(`http://127.0.0.1:${port}/relay/held`).catch(() => null);
    if (rejected !== null) expect(rejected.status).toBe(503);
    expect(routeEntries).toBe(1);
    expect(trace).toEqual(['request.enter']);

    requestGate.resolve();
    await expect(runningRequest).resolves.toMatchObject({ status: 200 });
    await expect(firstStop).resolves.toBeUndefined();
    expect(trace).toEqual([
      'request.enter',
      'request.leave',
      'sponsor-operations.stop',
      'domain-tasks.stop',
      'host-context.dispose',
      'redis.close',
    ]);
    expect(resources.lifecycle.closeRedis).toHaveBeenCalledOnce();
  });

  it('makes stop before start terminal without acquiring boot or context resources', async () => {
    const runtime = createApplicationRuntime();

    await expect(runtime.stop()).resolves.toBeUndefined();
    await expect(runtime.start()).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.runBootValidation).not.toHaveBeenCalled();
    expect(mocks.createAppApiContextOwner).not.toHaveBeenCalled();
  });

  it('shares one start operation and cannot report ready again after stop', async () => {
    const resources = contextResources();
    mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);
    const runtime = createApplicationRuntime();

    const firstStart = runtime.start();
    const secondStart = runtime.start();
    expect(secondStart).toBe(firstStart);
    await expect(firstStart).resolves.toEqual({ mode: 'relay_only' });
    await expect(runtime.stop()).resolves.toBeUndefined();

    await expect(runtime.start()).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.runBootValidation).toHaveBeenCalledOnce();
    expect(resources.runtime.start).toHaveBeenCalledOnce();
  });

  it('settles start and stop when shutdown closes the listener during binding', async () => {
    const port = await reservePort();
    const resources = contextResources();
    const contextStartGate = deferred();
    resources.runtime.start.mockImplementationOnce(async () => {
      await contextStartGate.promise;
      return resources.context;
    });
    mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);
    const listenObserved = deferred();
    const originalListen = NetServer.prototype.listen;
    vi.spyOn(NetServer.prototype, 'listen').mockImplementation(function (
      this: NetServer,
      ...args: unknown[]
    ) {
      listenObserved.resolve();
      return Reflect.apply(originalListen, this, args) as NetServer;
    } as typeof originalListen);
    const runtime = createApplicationRuntime();

    const startTask = runtime.start({ port });
    await vi.waitFor(() => expect(resources.runtime.start).toHaveBeenCalledOnce());
    contextStartGate.resolve();
    await listenObserved.promise;

    const startFailure = expect(startTask).rejects.toMatchObject({ name: 'AbortError' });
    const stopTask = runtime.stop();

    await startFailure;
    await expect(stopTask).resolves.toBeUndefined();
    expect(resources.runtime.stop).toHaveBeenCalledOnce();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it('preserves the original listener bind error and treats a never-listening server as closed', async () => {
    const occupied = await occupyPort();
    const resources = contextResources();
    mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);
    const runtime = createApplicationRuntime();

    try {
      const failure = await runtime.start({ port: occupied.port }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'EADDRINUSE' });
      expect(failure).not.toBeInstanceOf(AggregateError);
      await expect(runtime.stop()).resolves.toBeUndefined();
      expect(resources.runtime.stop).toHaveBeenCalledOnce();
    } finally {
      await occupied.close();
    }
  });

  it('retains a listener after close failure and retries only that handle', async () => {
    const port = await reservePort();
    const resources = contextResources();
    mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);
    const runtime = createApplicationRuntime();
    await runtime.start({ port });

    const originalClose = NetServer.prototype.close;
    let failFirstClose = true;
    vi.spyOn(NetServer.prototype, 'close').mockImplementation(function (
      this: NetServer,
      callback?: (error?: Error) => void,
    ) {
      if (failFirstClose) {
        failFirstClose = false;
        queueMicrotask(() => callback?.(new Error('listener close failed')));
        return this;
      }
      return Reflect.apply(originalClose, this, [callback]) as NetServer;
    } as typeof originalClose);

    await expect(runtime.stop()).rejects.toMatchObject({
      message: 'ApplicationRuntime stop failed',
      errors: [expect.objectContaining({ message: 'listener close failed' })],
    });
    expect(resources.runtime.stop).toHaveBeenCalledOnce();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).resolves.toMatchObject({ status: 503 });

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(resources.runtime.stop).toHaveBeenCalledTimes(2);
    expect(resources.lifecycle.stopSponsorOperations).toHaveBeenCalledOnce();
    expect(resources.lifecycle.stopDomainTasks).toHaveBeenCalledOnce();
    expect(resources.lifecycle.disposeHostContext).toHaveBeenCalledOnce();
    expect(resources.lifecycle.closeRedis).toHaveBeenCalledOnce();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'drives an actual listener through the private production %s shutdown path',
    async (signal) => {
      const port = await reservePort();
      vi.stubEnv('PORT', String(port));
      const stopGate = deferred();
      const resources = contextResources();
      resources.runtime.stop.mockImplementationOnce(async () => {
        await stopGate.promise;
      });
      mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);

      const handlers = new Map<'SIGINT' | 'SIGTERM', () => void>();
      const originalOnce = process.once.bind(process);
      const originalOff = process.off.bind(process);
      const offSpy = vi.spyOn(process, 'off').mockImplementation(((event, listener) => {
        if (event === 'SIGINT' || event === 'SIGTERM') {
          handlers.delete(event);
          return process;
        }
        return originalOff(event, listener);
      }) as typeof process.off);
      vi.spyOn(process, 'once').mockImplementation(((event, listener) => {
        if (event === 'SIGINT' || event === 'SIGTERM') {
          handlers.set(event, listener as () => void);
          return process;
        }
        return originalOnce(event, listener);
      }) as typeof process.once);
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`production entry called process.exit(${String(code)})`);
      }) as typeof process.exit);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      vi.resetModules();
      await import('../src/index.js');
      await vi.waitFor(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        expect(response.status).toBe(200);
      });
      const handler = handlers.get(signal);
      expect(handler).toBeTypeOf('function');
      handler?.();
      await vi.waitFor(() => expect(resources.runtime.stop).toHaveBeenCalledOnce());
      expect(offSpy).not.toHaveBeenCalledWith(signal, expect.any(Function));

      stopGate.resolve();
      await vi.waitFor(() => {
        expect(handlers.size).toBe(0);
      });
    },
  );
});
