/**
 * [app-api] Hono app construction shared by the standard Node server and
 * temporary Vercel demo adapter.
 *
 * Runtime model:
 *   - Generic Relay API path: always active
 *   - Studio path: active only when studio env set is complete
 *
 * Session policy:
 *   - Cookie: stelis_admin
 *   - Redis not_before: stelis:app-api:admin:not_before
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { runBootValidation, type BootSummary } from './boot.js';
import { createContext } from './context.js';
import { createRelayRoutes } from './routes/relay.js';
import { createAuthRoutes } from './routes/auth.js';
import { createAdminRoutes } from './routes/admin.js';
import { createStudioRoutes } from './routes/studio.js';
import { createClientIpResolver, type ClientIpSourceProvider } from './clientIp.js';
import { createAdminRedisAdapter } from './adminRedis.js';
import { raiseAppApiAdminSessionNotBefore } from './adminSessionNotBefore.js';

export type AppBootResult = BootSummary;

export async function createApp(
  options: {
    clientIpSourceProvider?: ClientIpSourceProvider;
  } = {},
): Promise<{ app: Hono; bootResult: AppBootResult }> {
  // 1. Read and validate mutable runtime inputs exactly once.
  const { runtimeInput, publicSummary: bootResult } = await runBootValidation();
  const contextPromise = createContext(runtimeInput.context);
  const resolveClientIp = createClientIpResolver(
    runtimeInput.trustedProxyHops,
    options.clientIpSourceProvider,
  );

  // 2. Create Hono app
  const app = new Hono();

  // 3. Security headers (all routes)
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-XSS-Protection', '0');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  // 4. CORS policy
  //    /relay/* and /studio/* — SDK-facing, open to all origins (public API)
  app.use(
    '/relay/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(
    '/studio/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  //    /auth/*, /api/* — admin-facing, restricted to configured origins
  const allowedOrigins = [...runtimeInput.corsAllowedOrigins];
  if (allowedOrigins.length > 0) {
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
  }

  // 5. Eager context assembly from the already boot-qualified snapshots.
  // This must complete before the server starts accepting requests.
  // eslint-disable-next-line no-console
  console.log('[app-api] Initializing context from boot-qualified Sui state...');
  const context = await contextPromise;
  try {
    // Invalidate sessions only after every runtime resource and boot-qualified
    // Sui read is ready. A failed boot must not mutate the shared session
    // boundary for an instance that never becomes capable of serving traffic.
    await raiseAppApiAdminSessionNotBefore(createAdminRedisAdapter(context.redis), Date.now());
  } catch (error) {
    await context.dispose();
    throw error;
  }

  // 6. Health check (always available — context already initialized)
  app.get('/health', (c) => c.json({ status: 'ok', mode: bootResult.mode }));

  // 7. Mount route groups
  const relayRoutes = createRelayRoutes(contextPromise, resolveClientIp);
  const authRoutes = createAuthRoutes(contextPromise, {
    resolveClientIp,
    adminAddress: runtimeInput.adminAddress,
    adminAuth: runtimeInput.adminAuth,
  });
  const adminRoutes = createAdminRoutes(contextPromise, {
    resolveClientIp,
    network: runtimeInput.context.network,
    adminAddress: runtimeInput.adminAddress,
    adminJwt: runtimeInput.adminAuth.jwt,
    ...runtimeInput.adminSponsorOperations,
  });
  const studioRoutes = createStudioRoutes(contextPromise, resolveClientIp);

  app.route('/relay', relayRoutes);
  app.route('/auth', authRoutes);
  app.route('/api', adminRoutes);
  app.route('/studio', studioRoutes);

  return { app, bootResult };
}
