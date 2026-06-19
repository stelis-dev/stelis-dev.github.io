/**
 * Demo-only Vercel entry point for the API host.
 *
 * The standard app-api runtime remains packages/app-api/src/index.ts, which
 * starts a long-running Node server. Vercel uses this root file only for the
 * temporary testnet demo deployment.
 *
 * TODO: Remove this file when the API moves to Cloud Run or another
 * long-running Node/OCI host.
 */
import { Hono } from 'hono';

// Vercel's Hono preset statically checks the root entry point for a Hono import.
// Keep this marker here instead of hiding it in the standard app-api runtime.
void Hono;

export { default } from './packages/app-api/dist/vercel.js';
