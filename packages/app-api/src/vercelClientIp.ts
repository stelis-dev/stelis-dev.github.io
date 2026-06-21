/**
 * Temporary Vercel client-IP source provider.
 *
 * Vercel documents x-forwarded-for as the client public IP and overwrites
 * incoming values to prevent IP spoofing. Keep this adapter-local so it can be
 * removed with src/vercel.ts when the Host moves to a long-running Node runtime.
 */
import type { ClientIpSourceProvider } from './clientIp.js';

export const getVercelClientIpSource: ClientIpSourceProvider = (c) => ({
  directIp: c.req.header('x-forwarded-for') ?? null,
});
