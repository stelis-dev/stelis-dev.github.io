export const APP_WEB_ENVIRONMENT_KEYS = Object.freeze([
  'VITE_STELIS_RELAY_API_URL',
  'VITE_STELIS_UI_MODE',
  'VITE_REPO_DOCS_BASE_URL',
] as const);

export type AppWebUiMode = 'relay' | 'studio';

export interface AppWebEnvironment {
  readonly relayApiBase: string;
  readonly uiMode: AppWebUiMode;
  readonly repoDocsBaseUrl: string | null;
}

function readOptionalString(input: Readonly<Record<string, unknown>>, key: string): string | null {
  const raw = input[key];
  if (raw == null) return null;
  if (typeof raw !== 'string') {
    throw new Error(`[app-web] ${key} must be a string when set.`);
  }
  const value = raw.trim();
  return value === '' ? null : value;
}

function requireHttpUrl(value: string, key: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`[app-web] ${key} must be a valid http(s) URL.`);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error(`[app-web] ${key} must be a valid http(s) URL without credentials.`);
  }
  return parsed;
}

function assertNoUnknownViteKeys(input: Readonly<Record<string, unknown>>): void {
  const allowed = new Set<string>(APP_WEB_ENVIRONMENT_KEYS);
  const unknown = Object.keys(input)
    .filter((key) => key.startsWith('VITE_') && !allowed.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`[app-web] Unsupported environment variable(s): ${unknown.join(', ')}`);
  }
}

export function parseAppWebEnvironment(
  input: Readonly<Record<string, unknown>>,
): AppWebEnvironment {
  assertNoUnknownViteKeys(input);

  const rawRelayApiUrl = readOptionalString(input, 'VITE_STELIS_RELAY_API_URL');
  if (!rawRelayApiUrl) {
    throw new Error(
      '[app-web] Missing required env VITE_STELIS_RELAY_API_URL. Set packages/app-web/.env (see .env.example).',
    );
  }
  const relayApiUrl = requireHttpUrl(rawRelayApiUrl, 'VITE_STELIS_RELAY_API_URL');
  if (
    (relayApiUrl.pathname !== '/relay' && relayApiUrl.pathname !== '/relay/') ||
    relayApiUrl.search !== '' ||
    relayApiUrl.hash !== ''
  ) {
    throw new Error(
      '[app-web] VITE_STELIS_RELAY_API_URL must be an http(s) Host URL whose path is exactly /relay, without query or fragment.',
    );
  }

  const rawUiMode = readOptionalString(input, 'VITE_STELIS_UI_MODE');
  if (rawUiMode !== null && rawUiMode !== 'relay' && rawUiMode !== 'studio') {
    throw new Error('[app-web] VITE_STELIS_UI_MODE must be relay or studio when set.');
  }

  const rawRepoDocsBaseUrl = readOptionalString(input, 'VITE_REPO_DOCS_BASE_URL');
  let repoDocsBaseUrl: string | null = null;
  if (rawRepoDocsBaseUrl) {
    const parsed = requireHttpUrl(rawRepoDocsBaseUrl, 'VITE_REPO_DOCS_BASE_URL');
    if (parsed.search !== '' || parsed.hash !== '') {
      throw new Error('[app-web] VITE_REPO_DOCS_BASE_URL must not contain a query or fragment.');
    }
    repoDocsBaseUrl = parsed.href.replace(/\/+$/, '');
  }

  return Object.freeze({
    relayApiBase: `${relayApiUrl.origin}/relay`,
    uiMode: rawUiMode ?? 'relay',
    repoDocsBaseUrl,
  });
}
