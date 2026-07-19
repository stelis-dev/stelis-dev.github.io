/**
 * Demo-only Vercel adapter for testnet API deployments.
 *
 * Vercel runs this file as a function, not as the long-running Node server
 * used by packages/app-api/src/index.ts. Keep stable hosting on the standard
 * Node/OCI entry point.
 *
 * TODO: Remove this adapter after the stable API deployment moves to Cloud Run
 * or another long-running Node/OCI host.
 */
import { createApplicationRuntime } from './app.js';
import { getVercelClientIpSource } from './vercelClientIp.js';

const runtime = createApplicationRuntime({
  clientIpSourceProvider: getVercelClientIpSource,
});
await runtime.start();

export default { fetch: runtime.fetch };
