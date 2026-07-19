/**
 * [app-api] Unified Hono API host for Stelis.
 *
 * Standard long-running Node server entry point.
 */
import { parsePortEnv } from './env.js';
import { createApplicationRuntime } from './app.js';
import { safeErrorSummary } from '@stelis/core-api/observability';

const PORT = parsePortEnv('PORT', process.env.PORT, 3200);

async function runNodeApplication(): Promise<void> {
  const runtime = createApplicationRuntime();
  let stopTask: Promise<void> | null = null;
  let resolveStopRequested: () => void = () => undefined;
  const stopRequested = new Promise<void>((resolve) => {
    resolveStopRequested = resolve;
  });
  const requestStop = () => {
    if (stopTask !== null) return;
    stopTask = runtime.stop();
    void stopTask.catch(() => undefined);
    resolveStopRequested();
  };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);

  try {
    // eslint-disable-next-line no-console
    console.log(`[app-api] Starting server on port ${PORT}...`);
    let bootResult;
    try {
      bootResult = await runtime.start({ port: PORT });
    } catch (error) {
      if (stopTask === null) throw error;
      await stopTask;
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[app-api] Listening on http://localhost:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`[app-api] ✅ Ready — mode: ${bootResult.mode}`);

    await stopRequested;
    await stopTask;
  } finally {
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
  }
}

async function main(): Promise<void> {
  await runNodeApplication();
}

void main().catch((err) => {
  // Cleanup has already attempted every owned phase. A hard failure must not
  // leave a scheduler, socket, or Redis handle keeping the terminated Host alive.
  // eslint-disable-next-line no-console
  console.error('[app-api] Fatal error:', safeErrorSummary(err));
  process.exit(1);
});
