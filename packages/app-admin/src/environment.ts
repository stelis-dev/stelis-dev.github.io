export const APP_ADMIN_ENVIRONMENT_KEYS = Object.freeze(['VITE_STELIS_API_URL'] as const);

export interface AppAdminEnvironment {
  readonly apiBase: string;
}

export function parseAppAdminEnvironment(
  input: Readonly<Record<string, unknown>>,
): AppAdminEnvironment {
  const allowed = new Set<string>(APP_ADMIN_ENVIRONMENT_KEYS);
  const unknown = Object.keys(input)
    .filter((key) => key.startsWith('VITE_') && !allowed.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new Error(`[app-admin] Unsupported environment variable(s): ${unknown.join(', ')}`);
  }

  const raw = input.VITE_STELIS_API_URL;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    throw new Error(
      '[app-admin] Missing required env VITE_STELIS_API_URL. Set packages/app-admin/.env (see .env.example).',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('[app-admin] VITE_STELIS_API_URL must be one valid http(s) Host origin.');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      '[app-admin] VITE_STELIS_API_URL must be one valid http(s) Host origin without credentials, path, query, or fragment.',
    );
  }

  return Object.freeze({ apiBase: parsed.origin });
}
