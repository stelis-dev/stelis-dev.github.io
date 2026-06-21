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
import { createApp } from './app.js';
import { setClientIpSourceProviderForRuntime } from './clientIp.js';
import { getVercelClientIpSource } from './vercelClientIp.js';

setClientIpSourceProviderForRuntime(getVercelClientIpSource);

const { app } = await createApp();

export default app;
