import type { FetchLike, StelisMcpServerConfig } from './config.js';
import {
  isNodeTimerDelayMs,
  NODE_TIMER_MAX_DELAY_MS,
  parseHostErrorResponse,
  type HostErrorCode,
  type HostErrorMeta,
} from '@stelis/contracts';

export class StelisMcpHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: HostErrorCode,
    public readonly meta?: HostErrorMeta,
  ) {
    super(message);
    this.name = 'StelisMcpHttpError';
  }
}

export interface RequestJsonOptions {
  relayApiUrl?: string;
  path: string;
  method?: 'GET' | 'POST';
  base?: 'relay' | 'studio';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  allowedErrorCodes: readonly HostErrorCode[];
}

export async function requestJson(
  config: StelisMcpServerConfig,
  options: RequestJsonOptions,
): Promise<unknown> {
  const method = options.method ?? 'GET';
  const url = buildRequestUrl(config, options);
  const fetchFn = resolveFetch(config.fetchFn);
  const timeoutMs = resolveTimeoutMs(options.timeoutMs, config.defaultTimeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      method,
      headers:
        method === 'POST'
          ? { 'Content-Type': 'application/json', ...options.headers }
          : options.headers,
      body: method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
      signal: controller.signal,
    });
    return await handleResponse(res, options.allowedErrorCodes);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Stelis Host request timed out after ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function resolveRelayApiUrl(config: StelisMcpServerConfig, relayApiUrl?: string): string {
  const raw = relayApiUrl?.trim() || config.defaultRelayApiUrl?.trim();
  if (!raw) {
    throw new Error('Missing relayApiUrl. Provide the tool argument or set STELIS_RELAY_API_URL.');
  }

  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('relayApiUrl must use http or https.');
  }

  url.hash = '';
  url.search = '';
  url.pathname = stripTrailingSlashes(url.pathname);
  if (!url.pathname.endsWith('/relay')) {
    throw new Error('relayApiUrl must point to a Relay API endpoint ending in /relay.');
  }

  return stripTrailingSlashes(url.toString());
}

export function deriveStudioBase(relayApiUrl: string): string {
  return relayApiUrl.replace(/\/relay$/, '');
}

function buildRequestUrl(config: StelisMcpServerConfig, options: RequestJsonOptions): string {
  const relayApiBase = resolveRelayApiUrl(config, options.relayApiUrl);
  const base = options.base === 'studio' ? deriveStudioBase(relayApiBase) : relayApiBase;
  const path = options.path.startsWith('/') ? options.path : `/${options.path}`;
  return `${base}${path}`;
}

function resolveFetch(fetchFn: FetchLike | undefined): FetchLike {
  if (fetchFn) return fetchFn;
  if (typeof fetch === 'function') return fetch;
  throw new Error('This runtime does not provide fetch.');
}

function resolveTimeoutMs(input: number | undefined, fallback: number): number {
  const value = input ?? fallback;
  if (!isNodeTimerDelayMs(value)) {
    throw new Error(`timeoutMs must be an integer from 1 through ${NODE_TIMER_MAX_DELAY_MS}.`);
  }
  return value;
}

async function handleResponse(
  res: Response,
  allowedErrorCodes: readonly HostErrorCode[],
): Promise<unknown> {
  const raw = await res.text();
  const data = parseJsonIfPossible(raw);

  if (!res.ok) {
    let currentError;
    try {
      currentError = parseHostErrorResponse(data, allowedErrorCodes, res.status);
    } catch {
      throw new Error(`Stelis Host returned a non-current error response (HTTP ${res.status})`);
    }
    let meta: HostErrorMeta | undefined;
    const { error: _error, code: _code, ...currentMeta } = currentError;
    if (Object.keys(currentMeta).length > 0) meta = currentMeta;
    throw new StelisMcpHttpError(currentError.error, res.status, currentError.code, meta);
  }

  if (data === undefined) {
    throw new Error(`Invalid non-JSON response from Stelis Host (HTTP ${res.status}).`);
  }

  return data;
}

function parseJsonIfPossible(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
