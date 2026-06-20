import type { FetchLike, StelisMcpServerConfig } from './config.js';

export class StelisMcpHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly body: unknown,
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
}

export async function requestJson<T>(
  config: StelisMcpServerConfig,
  options: RequestJsonOptions,
): Promise<T> {
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
    return await handleResponse<T>(res);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Stelis host request timed out after ${timeoutMs} ms.`);
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
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('timeoutMs must be a positive integer.');
  }
  return value;
}

async function handleResponse<T>(res: Response): Promise<T> {
  const raw = await res.text();
  const data = parseJsonIfPossible(raw);

  if (!res.ok) {
    const code = readStringField(data, 'code') ?? 'HTTP_ERROR';
    const message =
      readStringField(data, 'error') ??
      summarizeHttpBody(raw) ??
      res.statusText ??
      `HTTP ${res.status}`;
    throw new StelisMcpHttpError(message, res.status, code, data);
  }

  if (data === undefined) {
    throw new Error(`Invalid non-JSON response from Stelis host (HTTP ${res.status}).`);
  }

  return data as T;
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

function summarizeHttpBody(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) return undefined;
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
}

function readStringField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
