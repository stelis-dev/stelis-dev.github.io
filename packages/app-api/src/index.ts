/**
 * [app-api] Unified Hono API host for Stelis.
 *
 * Standard long-running Node server entry point.
 */
import { serve } from '@hono/node-server';
import { formatRuntimeMode } from './boot.js';
import { parsePortEnv } from './env.js';
import { createApp } from './app.js';
import { safeErrorSummary } from '@stelis/core-api/observability';

const PORT = parsePortEnv('PORT', process.env.PORT, 3200);

async function main() {
  const { app, bootResult } = await createApp();

  // eslint-disable-next-line no-console
  console.log(`[app-api] Starting server on port ${PORT}...`);

  serve(
    {
      fetch: app.fetch,
      port: PORT,
    },
    (info) => {
      // eslint-disable-next-line no-console
      console.log(`[app-api] Listening on http://localhost:${info.port}`);
      // eslint-disable-next-line no-console
      console.log(`[app-api] ✅ Ready — mode: ${formatRuntimeMode(bootResult.mode)}`);
    },
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[app-api] Fatal error:', safeErrorSummary(err));
  process.exit(1);
});
