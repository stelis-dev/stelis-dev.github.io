/**
 * [app-web] Runtime environment — fail-fast on missing required env.
 *
 * Network is resolved from the API via AppConfigContext, not from env.
 * Only VITE_STELIS_RELAYER_URL and VITE_SUI_RPC_URL remain as build-time env.
 */

function readRequiredEnv(key: 'VITE_STELIS_RELAYER_URL' | 'VITE_SUI_RPC_URL'): string {
  const raw = import.meta.env[key];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value) return value;

  throw new Error(
    `[app-web] Missing required env ${key}. Set it in packages/app-web/.env (see .env.example).`,
  );
}

function parseRelayBase(raw: string): string {
  const normalized = raw.replace(/\/+$/, '');
  if (!normalized.endsWith('/relay')) {
    throw new Error('[app-web] VITE_STELIS_RELAYER_URL must end with /relay.');
  }
  return normalized;
}

export const APP_WEB_SUI_RPC_URL = readRequiredEnv('VITE_SUI_RPC_URL');
export const APP_WEB_RELAYER_BASE = parseRelayBase(readRequiredEnv('VITE_STELIS_RELAYER_URL'));
