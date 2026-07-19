import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createServer } from 'node:http';

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
  raiseAppApiAdminSessionNotBefore: vi.fn(),
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
  raiseAppApiAdminSessionNotBefore: mocks.raiseAppApiAdminSessionNotBefore,
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

function relayAndStudioBoot() {
  return {
    context: {
      mode: 'relay_and_studio' as const,
      sponsorLeaseHmacSecret: HMAC_SECRET,
      network: 'testnet' as const,
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
  };
}

function contextResources(
  trace: string[] = [],
  options: {
    readonly mode?: 'relay_only' | 'relay_and_studio';
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
  const stop = vi.fn(async () => {
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
  vi.clearAllMocks();
  mocks.runBootValidation.mockResolvedValue(relayOnlyBoot());
  mocks.createAppApiContextOwner.mockReturnValue(contextResources().runtime);
  mocks.createRelayRoutes.mockImplementation(() => new Hono());
  mocks.createAuthRoutes.mockImplementation(() => new Hono());
  mocks.createAdminRoutes.mockImplementation(() => new Hono());
  mocks.createStudioRoutes.mockImplementation(() => new Hono());
  mocks.createAdminRedisAdapter.mockReturnValue(adminRedis);
  mocks.raiseAppApiAdminSessionNotBefore.mockResolvedValue(1);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ApplicationRuntime input and resource boundary', () => {
  it('keeps `relay_only` construction free of Admin credentials and session mutation', async () => {
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
    expect(mocks.raiseAppApiAdminSessionNotBefore).not.toHaveBeenCalled();

    expect(mocks.createAuthRoutes).not.toHaveBeenCalled();
    expect(mocks.createAdminRoutes).not.toHaveBeenCalled();
    expect(mocks.createStudioRoutes).not.toHaveBeenCalled();

    const health = await runtime.fetch(new Request('http://host.test/health'));
    await expect(health.json()).resolves.toEqual({ status: 'ok', mode: 'relay_only' });
    for (const [path, code] of [
      ['/auth/nonce', 'ADMIN_UNAVAILABLE'],
      ['/api/promotions', 'ADMIN_UNAVAILABLE'],
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

  it('uses one `relay_and_studio` snapshot for Admin routes, CORS, and session cutoff', async () => {
    const boot = relayAndStudioBoot();
    mocks.runBootValidation.mockResolvedValueOnce(boot);
    const resources = contextResources([], { mode: 'relay_and_studio' });
    mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);
    const runtime = createApplicationRuntime();

    const bootResult = await runtime.start();
    expect(bootResult).toEqual({ mode: 'relay_and_studio' });
    expect(JSON.stringify(bootResult)).not.toContain(JWT_SECRET);
    expect(JSON.stringify(bootResult)).not.toContain(HMAC_SECRET);
    expect(mocks.createAdminRedisAdapter).toHaveBeenCalledWith(resources.context.redis);
    expect(mocks.raiseAppApiAdminSessionNotBefore).toHaveBeenCalledWith(
      adminRedis,
      expect.any(Number),
    );
    expect(mocks.createAppApiContextOwner.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.raiseAppApiAdminSessionNotBefore.mock.invocationCallOrder[0],
    );

    const [, authRuntime] = mocks.createAuthRoutes.mock.calls[0];
    expect(authRuntime.admin).toEqual({
      address: ADMIN_ADDRESS,
      auth: boot.adminAuth,
      allowedOrigins: ['https://admin.snapshot.example'],
    });
    expect(authRuntime.admission).toMatchObject({
      host: resources.context.host,
    });
    expect(mocks.createAdminRoutes.mock.calls[0]?.[1]).toMatchObject({
      network: 'testnet',
      allowedOrigins: ['https://admin.snapshot.example'],
      admin: {
        address: ADMIN_ADDRESS,
        jwt: boot.adminAuth.jwt,
      },
    });

    const allowed = await runtime.fetch(
      new Request('http://host.test/api/promotions/promotion-1', {
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
      new Request('http://host.test/auth/session', {
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
      'OPTIONS',
    ]);

    await runtime.stop();
  });

  it('continues reverse cleanup through failure and closes Redis last when start fails', async () => {
    const trace: string[] = [];
    const resources = contextResources(trace, {
      mode: 'relay_and_studio',
      domainStopError: new Error('domain stop failed'),
    });
    mocks.runBootValidation.mockResolvedValueOnce(relayAndStudioBoot());
    mocks.createAppApiContextOwner.mockReturnValueOnce(resources.runtime);
    mocks.raiseAppApiAdminSessionNotBefore.mockRejectedValueOnce(
      new Error('session cutoff failed'),
    );
    const runtime = createApplicationRuntime();

    const startFailure = await runtime.start().catch((error: unknown) => error);
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
