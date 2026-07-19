/** Host composition and process-lifetime ownership. */
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { parseHostHealthResponse, type HostOperatingMode } from '@stelis/contracts';
import {
  runBootValidation,
  type AdminAppRuntimeInput,
  type AppRuntimeInput,
  type RelayOnlyAppRuntimeInput,
} from './boot.js';
import {
  createAppApiContextOwner,
  type AdminAppApiContext,
  type AppApiContext,
  type AppApiContextOwner,
  type RelayOnlyAppApiContext,
} from './context.js';
import { createRelayRoutes } from './routes/relay.js';
import { createAuthRoutes } from './routes/auth.js';
import { createAdminRoutes } from './routes/admin.js';
import { createStudioRoutes } from './routes/studio.js';
import { createClientIpResolver, type ClientIpSourceProvider } from './clientIp.js';
import { createAdminRedisAdapter } from './adminRedis.js';
import { initializeAppApiAdminSessionNotBefore } from './adminSessionNotBefore.js';
import {
  createAdminRequestAdmission,
  type AdminRequestAdmission,
  type RequestAdmissionDependencies,
} from './requestAdmission.js';
import { codedHostError, respondMapped } from './errorMap.js';

export interface AppBootResult {
  readonly mode: HostOperatingMode;
}

export interface ApplicationRuntimeOptions {
  readonly clientIpSourceProvider?: ClientIpSourceProvider;
}

export interface ApplicationRuntimeStartOptions {
  /** Omit when the caller supplies requests through `fetch()` without a Node listener. */
  readonly port?: number;
}

export interface ApplicationRuntime {
  start(options?: ApplicationRuntimeStartOptions): Promise<AppBootResult>;
  fetch(request: Request, env?: unknown): Promise<Response>;
  stop(): Promise<void>;
}

interface OwnedListener {
  readonly server: ServerType;
  readonly bindTask: Promise<void>;
  readonly closedTask: Promise<void>;
}

function isAdminRuntimeInput(input: AppRuntimeInput): input is AdminAppRuntimeInput {
  return input.context.mode !== 'relay_only';
}

function createHonoAppBase(
  runtimeInput: AppRuntimeInput,
  context: AppApiContext,
  clientIpSourceProvider?: ClientIpSourceProvider,
): { readonly app: Hono; readonly admission: RequestAdmissionDependencies } {
  const resolveClientIp = createClientIpResolver(
    runtimeInput.trustedProxyHops,
    clientIpSourceProvider,
  );
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-XSS-Protection', '0');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  installPublicSdkCors(app);
  app.get('/health', (c) => c.json(parseHostHealthResponse({ status: 'ok', mode: context.mode })));

  const admission: RequestAdmissionDependencies = Object.freeze({
    host: context.host,
    resolveClientIp,
  });
  app.route('/relay', createRelayRoutes(context, admission));
  return { app, admission };
}

function installPublicSdkCors(app: Hono): void {
  const publicSdkCors = cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  });
  app.use('/relay/*', publicSdkCors);
  app.use('/studio/*', publicSdkCors);
}

function buildRelayOnlyHonoApp(
  runtimeInput: RelayOnlyAppRuntimeInput,
  context: RelayOnlyAppApiContext,
  clientIpSourceProvider?: ClientIpSourceProvider,
): Hono {
  const { app } = createHonoAppBase(runtimeInput, context, clientIpSourceProvider);
  app.all('/admin/*', (c) =>
    respondMapped(c, codedHostError('ADMIN_UNAVAILABLE', ['ADMIN_UNAVAILABLE'])),
  );
  app.all('/studio/*', (c) =>
    respondMapped(c, codedHostError('STUDIO_UNAVAILABLE', ['STUDIO_UNAVAILABLE'])),
  );
  return app;
}

function installAdminBrowserAccess(
  app: Hono,
  admission: RequestAdmissionDependencies,
  adminAppOrigin: string | null,
): AdminRequestAdmission {
  if (adminAppOrigin !== null) {
    app.use(
      '/admin/*',
      cors({
        origin: adminAppOrigin,
        credentials: true,
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      }),
    );
  }
  return createAdminRequestAdmission(admission, adminAppOrigin);
}

function buildAdminHonoAppBase(
  runtimeInput: AdminAppRuntimeInput,
  context: AdminAppApiContext,
  clientIpSourceProvider?: ClientIpSourceProvider,
): { readonly app: Hono; readonly admission: RequestAdmissionDependencies } {
  const { app, admission } = createHonoAppBase(runtimeInput, context, clientIpSourceProvider);
  const adminAdmission = installAdminBrowserAccess(app, admission, runtimeInput.adminAppOrigin);
  const admin = {
    address: runtimeInput.adminAddress,
    auth: runtimeInput.adminAuth,
  };
  app.route('/admin/auth', createAuthRoutes(context, { admission: adminAdmission, admin }));
  app.route(
    '/admin',
    createAdminRoutes(context, {
      admission: adminAdmission,
      network: runtimeInput.context.network,
      admin: { address: admin.address, jwt: admin.auth.jwt },
    }),
  );
  return { app, admission };
}

function buildAdminHonoApp(
  runtimeInput: AdminAppRuntimeInput,
  context: AdminAppApiContext,
  clientIpSourceProvider?: ClientIpSourceProvider,
): Hono {
  const { app, admission } = buildAdminHonoAppBase(runtimeInput, context, clientIpSourceProvider);
  if (context.mode === 'relay_with_admin_and_studio') {
    app.route('/studio', createStudioRoutes(context, admission));
  } else {
    app.all('/studio/*', (c) =>
      respondMapped(c, codedHostError('STUDIO_UNAVAILABLE', ['STUDIO_UNAVAILABLE'])),
    );
  }
  return app;
}

async function startAdminApplication(
  runtimeInput: AdminAppRuntimeInput,
  owner: AppApiContextOwner<AdminAppApiContext>,
  startupSignal: AbortSignal,
  clientIpSourceProvider?: ClientIpSourceProvider,
): Promise<Hono> {
  const context = await owner.start(startupSignal);
  startupSignal.throwIfAborted();
  if (context.mode !== runtimeInput.context.mode) {
    throw new Error(
      `[app-api] Admin context mode ${context.mode} does not match boot mode ${runtimeInput.context.mode}`,
    );
  }
  await initializeAppApiAdminSessionNotBefore(createAdminRedisAdapter(context.redis), Date.now());
  startupSignal.throwIfAborted();
  return buildAdminHonoApp(runtimeInput, context, clientIpSourceProvider);
}

export function createApplicationRuntime(
  options: ApplicationRuntimeOptions = {},
): ApplicationRuntime {
  const clientIpSourceProvider = options.clientIpSourceProvider;
  const startupController = new AbortController();
  let app: Hono | null = null;
  let contextOwner: AppApiContextOwner | null = null;
  let listener: OwnedListener | null = null;
  let startTask: Promise<AppBootResult> | null = null;
  let cleanupTask: Promise<readonly unknown[]> | null = null;
  let stopTask: Promise<void> | null = null;
  let acceptingRequests = false;
  let activeRequests = 0;
  let resolveDrain: (() => void) | null = null;

  const drainRequests = (): Promise<void> => {
    if (activeRequests === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
  };

  const trackedFetch = async (request: Request, env?: unknown): Promise<Response> => {
    const currentApp = app;
    if (currentApp === null) throw new Error('ApplicationRuntime has not started');
    if (!acceptingRequests) {
      return new Response('Service Unavailable', { status: 503 });
    }
    activeRequests += 1;
    try {
      return await currentApp.fetch(request, env as never);
    } finally {
      activeRequests -= 1;
      if (activeRequests === 0) {
        resolveDrain?.();
        resolveDrain = null;
      }
    }
  };

  const closeServer = (): Promise<void> => {
    if (listener === null) return Promise.resolve();
    const ownedListener = listener;
    const ownedServer = ownedListener.server;

    const clearOwnedListener = () => {
      if (listener === ownedListener) listener = null;
    };
    const attempt = (async () => {
      let bindSucceeded = false;
      try {
        await ownedListener.bindTask;
        bindSucceeded = true;
      } catch {
        // The start path retains the exact bind error. Cleanup owns only the
        // now-terminal listener handle.
      }

      if (listener !== ownedListener) return;
      if (!bindSucceeded) {
        clearOwnedListener();
        return;
      }
      if (!ownedServer.listening) {
        // A successful bind can become non-listening only after `close`.
        // Await the event rather than treating readiness as ownership.
        await ownedListener.closedTask;
        clearOwnedListener();
        return;
      }

      const closeTask = new Promise<void>((resolve, reject) => {
        ownedServer.close((error?: Error) => {
          if (error) reject(error);
          else resolve();
        });
        const closeIdleConnections = Reflect.get(ownedServer, 'closeIdleConnections');
        if (typeof closeIdleConnections === 'function') closeIdleConnections.call(ownedServer);
      });
      await Promise.all([closeTask, ownedListener.closedTask]);
      clearOwnedListener();
    })();
    return attempt;
  };

  const cleanupResources = async (): Promise<void> => {
    await contextOwner?.stop();
  };

  /**
   * The single ApplicationRuntime cleanup sequence. Startup failure and
   * explicit stop share the same in-flight attempt. A fully successful attempt
   * is cached; an attempt with failures is released so a later stop can retry
   * only the handles retained by their owners.
   */
  const cleanupRuntimeResources = (): Promise<readonly unknown[]> => {
    if (cleanupTask !== null) return cleanupTask;

    const attempt = (async (): Promise<readonly unknown[]> => {
      const failures: unknown[] = [];
      for (const phase of [closeServer, drainRequests, cleanupResources]) {
        try {
          await phase();
        } catch (error) {
          failures.push(error);
        }
      }
      return Object.freeze(failures);
    })();
    cleanupTask = attempt;
    void attempt.then((failures) => {
      if (failures.length > 0 && cleanupTask === attempt) cleanupTask = null;
    });
    return attempt;
  };

  const runtime: ApplicationRuntime = {
    start(startOptions = {}) {
      if (startupController.signal.aborted) {
        return Promise.reject(startupController.signal.reason);
      }
      if (startTask !== null) return startTask;
      const port = startOptions.port;
      startTask = (async () => {
        try {
          const runtimeInput = await runBootValidation(startupController.signal);
          startupController.signal.throwIfAborted();
          if (isAdminRuntimeInput(runtimeInput)) {
            const owner = createAppApiContextOwner(runtimeInput.context);
            contextOwner = owner;
            app = await startAdminApplication(
              runtimeInput,
              owner,
              startupController.signal,
              clientIpSourceProvider,
            );
          } else {
            const owner = createAppApiContextOwner(runtimeInput.context);
            contextOwner = owner;
            const context = await owner.start(startupController.signal);
            startupController.signal.throwIfAborted();
            app = buildRelayOnlyHonoApp(runtimeInput, context, clientIpSourceProvider);
          }
          if (port !== undefined) {
            const ownedServer = createAdaptorServer({
              fetch: (request, env) => trackedFetch(request, env),
            });
            const closedTask = new Promise<void>((resolve) => {
              ownedServer.once('close', resolve);
            });
            const bindTask = listen(ownedServer, port, startupController.signal);
            listener = Object.freeze({ server: ownedServer, bindTask, closedTask });
            await bindTask;
            startupController.signal.throwIfAborted();
          }
          const bootResult: AppBootResult = Object.freeze({
            mode: runtimeInput.context.mode,
          });
          acceptingRequests = true;
          return bootResult;
        } catch (error) {
          acceptingRequests = false;
          const cleanupFailures = await cleanupRuntimeResources();
          app = null;
          if (cleanupFailures.length > 0) {
            throw new AggregateError(
              [error, ...cleanupFailures],
              'ApplicationRuntime start and cleanup both failed',
            );
          }
          throw error;
        }
      })();
      return startTask;
    },
    fetch: trackedFetch,
    stop() {
      acceptingRequests = false;
      startupController.abort();
      if (stopTask !== null) return stopTask;

      const attempt = (async () => {
        const failures = await cleanupRuntimeResources();
        await startTask?.catch(() => undefined);
        if (failures.length > 0) {
          throw new AggregateError(failures, 'ApplicationRuntime stop failed');
        }
      })();
      stopTask = attempt;
      void attempt.catch(() => {
        // Context and listener owners retain only handles whose cleanup
        // failed, so a later stop can retry those handles without repeating
        // cleanup that already succeeded.
        if (stopTask === attempt) stopTask = null;
      });
      return attempt;
    },
  };
  return runtime;
}

function listen(server: ServerType, port: number, startupSignal: AbortSignal): Promise<void> {
  const bindController = new AbortController();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const removeListeners = () => {
      startupSignal.removeEventListener('abort', onAbort);
      server.off('error', onError);
      server.off('listening', onListening);
      server.off('close', onCloseBeforeListening);
    };
    const settle = (outcome: { readonly error?: unknown }) => {
      if (settled) return;
      settled = true;
      removeListeners();
      if ('error' in outcome) reject(outcome.error);
      else resolve();
    };
    const onError = (error: Error) => {
      settle({ error });
    };
    const onListening = () => {
      settle({});
    };
    const onCloseBeforeListening = () => {
      settle({
        error: startupSignal.aborted
          ? startupSignal.reason
          : new Error('ApplicationRuntime listener closed before binding completed'),
      });
    };
    const onAbort = () => {
      bindController.abort(startupSignal.reason);
    };
    startupSignal.addEventListener('abort', onAbort, { once: true });
    server.once('error', onError);
    server.once('listening', onListening);
    server.once('close', onCloseBeforeListening);
    if (startupSignal.aborted) {
      settle({ error: startupSignal.reason });
      return;
    }
    try {
      server.listen({ port, signal: bindController.signal });
    } catch (error) {
      settle({ error });
    }
  });
}
