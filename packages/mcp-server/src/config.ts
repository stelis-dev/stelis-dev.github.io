export interface StelisMcpServerConfig {
  defaultRelayApiUrl?: string;
  defaultTimeoutMs: number;
  fetchFn?: FetchLike;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 20_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): StelisMcpServerConfig {
  return {
    defaultRelayApiUrl: normalizeOptionalEnv(env.STELIS_RELAY_API_URL),
    defaultTimeoutMs: parseTimeoutMs(env.STELIS_REQUEST_TIMEOUT_MS),
  };
}

function normalizeOptionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseTimeoutMs(raw: string | undefined): number {
  const value = normalizeOptionalEnv(raw);
  if (!value) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('STELIS_REQUEST_TIMEOUT_MS must be a positive integer.');
  }
  return parsed;
}
