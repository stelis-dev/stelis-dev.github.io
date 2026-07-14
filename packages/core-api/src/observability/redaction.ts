/** Maximum length of an externally observable error summary. */
export const SAFE_ERROR_SUMMARY_MAX_CHARS = 500;

const SENSITIVE_ENV_ASSIGNMENT =
  /\b((?:[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*)|REDIS_URL|KV_URL)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)/g;
const EMBEDDED_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const AUTHORIZATION_CREDENTIAL = /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[^\s,;]+/gi;
const BEARER_CREDENTIAL = /\bBearer\s+[^\s,;]+/gi;
const SUI_PRIVATE_KEY = /\bsuiprivkey1[0-9a-z]+/gi;
const MAX_DIAGNOSTIC_DEPTH = 8;

export type RedactedDiagnosticValue =
  | null
  | boolean
  | number
  | string
  | RedactedDiagnosticValue[]
  | { [key: string]: RedactedDiagnosticValue };

function isSensitiveDiagnosticKey(key: string): boolean {
  const compact = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    compact === 'redisurl' ||
    compact === 'kvurl' ||
    compact.includes('authorization') ||
    compact.includes('credential') ||
    compact.includes('password') ||
    compact.endsWith('secret') ||
    compact.endsWith('secretkey') ||
    compact.endsWith('privatekey') ||
    compact.endsWith('apikey') ||
    compact.endsWith('accesskey') ||
    compact.endsWith('token')
  );
}

/**
 * Project a configured endpoint to a log-safe identity.
 *
 * The scheme, host, and port remain useful for operations. Credentials and
 * every provider-controlled path, query, or fragment component are replaced
 * with explicit markers. Invalid input is never echoed.
 */
export function redactEndpointUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.host === '') return '[INVALID_URL]';

    const authority = `${url.protocol}//${url.host}`;
    const path = url.pathname === '' || url.pathname === '/' ? '' : '/[REDACTED]';
    const query = url.search === '' ? '' : '?[REDACTED]';
    const fragment = url.hash === '' ? '' : '#[REDACTED]';
    return `${authority}${path}${query}${fragment}`;
  } catch {
    return '[INVALID_URL]';
  }
}

/**
 * Remove credentials from arbitrary operator-visible text.
 *
 * This is deliberately presentation-only: callers that classify failures or
 * make retry decisions must inspect the original value before sanitizing it.
 */
export function redactSensitiveText(text: string): string {
  return text
    .replace(SENSITIVE_ENV_ASSIGNMENT, '$1=[REDACTED]')
    .replace(AUTHORIZATION_CREDENTIAL, 'Authorization: [REDACTED]')
    .replace(BEARER_CREDENTIAL, 'Bearer [REDACTED]')
    .replace(SUI_PRIVATE_KEY, '[REDACTED_SUI_PRIVATE_KEY]')
    .replace(EMBEDDED_URL, (raw) => redactEndpointUrl(raw));
}

/** Return a bounded, stack-free, credential-safe description of an error. */
export function safeErrorSummary(error: unknown): string {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : Object.prototype.toString.call(error);
  return redactSensitiveText(raw).slice(0, SAFE_ERROR_SUMMARY_MAX_CHARS);
}

/**
 * Project externally observable diagnostic metadata to JSON-safe values while
 * applying the same credential policy recursively.
 *
 * This is a defence-in-depth output boundary, not an open wire contract.
 * Public response builders must still project only their current documented
 * fields. Classification and retry policy must use original values first.
 */
export function redactDiagnosticRecord(
  record: Readonly<Record<string, unknown>>,
): Record<string, RedactedDiagnosticValue> {
  return redactDiagnosticRecordAtDepth(record, new WeakSet<object>(), 0);
}

function redactDiagnosticRecordAtDepth(
  record: Readonly<Record<string, unknown>>,
  ancestors: WeakSet<object>,
  depth: number,
): Record<string, RedactedDiagnosticValue> {
  if (depth > MAX_DIAGNOSTIC_DEPTH) return { truncated: '[MAX_DEPTH]' };
  if (ancestors.has(record)) return { circular: '[CIRCULAR]' };

  ancestors.add(record);
  const result: Record<string, RedactedDiagnosticValue> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = isSensitiveDiagnosticKey(key)
      ? '[REDACTED]'
      : redactDiagnosticValue(value, ancestors, depth + 1);
  }
  ancestors.delete(record);
  return result;
}

function redactDiagnosticValue(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): RedactedDiagnosticValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? redactSensitiveText(value) : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return safeErrorSummary(value);
  if (depth > MAX_DIAGNOSTIC_DEPTH) return '[MAX_DEPTH]';
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return '[CIRCULAR]';
    ancestors.add(value);
    const result = value.map((entry) => redactDiagnosticValue(entry, ancestors, depth + 1));
    ancestors.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return redactDiagnosticRecordAtDepth(
        value as Readonly<Record<string, unknown>>,
        ancestors,
        depth,
      );
    }
    return Object.prototype.toString.call(value);
  }
  return `[${typeof value}]`;
}
