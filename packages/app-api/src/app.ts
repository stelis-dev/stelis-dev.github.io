/** Host composition and process-lifetime ownership. */
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { parseHostHealthResponse, type HostOperatingMode } from '@stelis/contracts';
import {
  runBootValidation,
  type AppRuntimeInput,
  type RelayAndStudioAppRuntimeInput,
  type RelayOnlyAppRuntimeInput,
} from './boot.js';
import {
  createAppApiContextOwner,
  type AppApiContext,
  type AppApiContextOwner,
  type RelayAndStudioAppApiContext,
  type RelayOnlyAppApiContext,
} from './context.js';
import { createRelayRoutes } from './routes/relay.js';
import { createAuthRoutes } from './routes/auth.js';
import { createAdminRoutes } from './routes/admin.js';
import { createStudioRoutes } from './routes/studio.js';
import { createClientIpResolver, type ClientIpSourceProvider } from './clientIp.js';
import { createAdminRedisAdapter } from './adminRedis.js';
import { raiseAppApiAdminSessionNotBefore } from './adminSessionNotBefore.js';
import type { RequestAdmissionDependencies } from './requestAdmission.js';
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

function isRelayAndStudioRuntimeInput(
  input: AppRuntimeInput,
): input is RelayAndStudioAppRuntimeInput {
  return input.context.mode === 'relay_and_studio';
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

  app.use(
    '/relay/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.get('/health', (c) => c.json(parseHostHealthResponse({ status: 'ok', mode: context.mode })));

  const admission: RequestAdmissionDependencies = Object.freeze({
    host: context.host,
    resolveClientIp,
  });
  app.route('/relay', createRelayRoutes(context, admission));
  return { app, admission };
}

function installPublicStudioCors(app: Hono): void {
  // Each mode-specific builder installs this after Host mode is resolved.
  // Preflight succeeds in both modes so browser clients can read the actual
  // request's typed STUDIO_UNAVAILABLE result from a `relay_only` Host.
  app.use(
    '/studio/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );
}

function buildRelayOnlyHonoApp(
  runtimeInput: RelayOnlyAppRuntimeInput,
  context: RelayOnlyAppApiContext,
  clientIpSourceProvider?: ClientIpSourceProvider,
): Hono {
  const { app } = createHonoAppBase(runtimeInput, context, clientIpSourceProvider);
  installPublicStudioCors(app);
  app.all('/auth/*', (c) =>
    respondMapped(c, codedHostError('ADMIN_UNAVAILABLE', ['ADMIN_UNAVAILABLE'])),
  );
  app.all('/api/*', (c) =>
    respondMapped(c, codedHostError('ADMIN_UNAVAILABLE', ['ADMIN_UNAVAILABLE'])),
  );
  app.all('/studio/*', (c) =>
    respondMapped(c, codedHostError('STUDIO_UNAVAILABLE', ['STUDIO_UNAVAILABLE'])),
  );
  return app;
}

function buildRelayAndStudioHonoApp(
  runtimeInput: RelayAndStudioAppRuntimeInput,
  context: RelayAndStudioAppApiContext,
  clientIpSourceProvider?: ClientIpSourceProvider,
): Hono {
  const allowedOrigins = [...runtimeInput.corsAllowedOrigins];
  const { app, admission } = createHonoAppBase(runtimeInput, context, clientIpSourceProvider);
  installPublicStudioCors(app);
  app.use(
    '/auth/*',
    cors({
      origin: allowedOrigins,
      credentials: true,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(
    '/api/*',
    cors({
      origin: allowedOrigins,
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  const admin = {
    address: runtimeInput.adminAddress,
    auth: runtimeInput.adminAuth,
    allowedOrigins,
  };
  app.route('/auth', createAuthRoutes(context, { admission, admin }));
  app.route(
    '/api',
    createAdminRoutes(context, {
      admission,
      network: runtimeInput.context.network,
      allowedOrigins,
      admin: { address: admin.address, jwt: admin.auth.jwt },
    }),
  );
  app.route('/studio', createStudioRoutes(context, admission));
  return app;
}

export function createApplicationRuntime(
  options: ApplicationRuntimeOptions = {},
): ApplicationRuntime {
  const clientIpSourceProvider = options.clientIpSourceProvider;
  const startupController = new AbortController();
  let app: Hono | null = null;
  let contextOwner: AppApiContextOwner | null = null;
  let server: ServerType | null = null;
  let startTask: Promise<AppBootResult> | null = null;
  let activeCleanupTask: Promise<readonly unknown[]> | null = null;
  let completedCleanupTask: Promise<readonly unknown[]> | null = null;
  let activeStopTask: Promise<void> | null = null;
  let completedStopTask: Promise<void> | null = null;
  let activeServerCloseTask: Promise<void> | null = null;
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
    if (activeServerCloseTask !== null) return activeServerCloseTask;
    // A server object exists before bind completes. Node reports
    // ERR_SERVER_NOT_RUNNING when close() is called after a bind failure, so
    // only a successfully listening server enters the close lifecycle.
    if (server === null) return Promise.resolve();
    if (!server.listening) {
      server = null;
      return Promise.resolve();
    }
    const ownedServer = server;
    const attempt = new Promise<void>((resolve, reject) => {
      ownedServer.close((error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
      const closeIdleConnections = Reflect.get(ownedServer, 'closeIdleConnections');
      if (typeof closeIdleConnections === 'function') closeIdleConnections.call(ownedServer);
    });
    activeServerCloseTask = attempt;
    void attempt.then(
      () => {
        if (server === ownedServer) server = null;
        if (activeServerCloseTask === attempt) activeServerCloseTask = null;
      },
      () => {
        if (activeServerCloseTask === attempt) activeServerCloseTask = null;
      },
    );
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
    if (completedCleanupTask !== null) return completedCleanupTask;
    if (activeCleanupTask !== null) return activeCleanupTask;

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
    activeCleanupTask = attempt;
    void attempt.then((failures) => {
      if (failures.length === 0) completedCleanupTask = attempt;
      if (activeCleanupTask === attempt) activeCleanupTask = null;
    });
    return attempt;
  };

  const runtime: ApplicationRuntime = {
    start(startOptions = {}) {
      if (startTask !== null) return startTask;
      const port = startOptions.port;
      startTask = (async () => {
        try {
          const runtimeInput = await runBootValidation(startupController.signal);
          startupController.signal.throwIfAborted();
          if (isRelayAndStudioRuntimeInput(runtimeInput)) {
            const owner = createAppApiContextOwner(runtimeInput.context);
            contextOwner = owner;
            const context = await owner.start(startupController.signal);
            startupController.signal.throwIfAborted();
            await raiseAppApiAdminSessionNotBefore(
              createAdminRedisAdapter(context.redis),
              Date.now(),
            );
            startupController.signal.throwIfAborted();
            app = buildRelayAndStudioHonoApp(runtimeInput, context, clientIpSourceProvider);
          } else {
            const owner = createAppApiContextOwner(runtimeInput.context);
            contextOwner = owner;
            const context = await owner.start(startupController.signal);
            startupController.signal.throwIfAborted();
            app = buildRelayOnlyHonoApp(runtimeInput, context, clientIpSourceProvider);
          }
          if (port !== undefined) {
            server = createAdaptorServer({
              fetch: (request, env) => trackedFetch(request, env),
            });
            await listen(server, port);
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
      if (completedStopTask !== null) return completedStopTask;
      if (activeStopTask !== null) return activeStopTask;

      const attempt = (async () => {
        const failures = await cleanupRuntimeResources();
        await startTask?.catch(() => undefined);
        if (failures.length > 0) {
          throw new AggregateError(failures, 'ApplicationRuntime stop failed');
        }
      })();
      activeStopTask = attempt;
      void attempt.then(
        () => {
          completedStopTask = attempt;
          if (activeStopTask === attempt) activeStopTask = null;
        },
        () => {
          // Context and listener owners retain only handles whose cleanup
          // failed, so a later stop can retry those handles without repeating
          // cleanup that already succeeded.
          if (activeStopTask === attempt) activeStopTask = null;
        },
      );
      return attempt;
    },
  };
  return runtime;
}

function listen(server: ServerType, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}
