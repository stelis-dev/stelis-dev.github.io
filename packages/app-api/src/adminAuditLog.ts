import type { AdminRedisClient } from '@stelis/core-api/admin';

export const ADMIN_AUDIT_LOG_KEY = 'stelis:admin:audit_log';
export const ADMIN_AUDIT_LOG_MAX_ENTRIES = 200;
export const SAFE_ERROR_SUMMARY_MAX_CHARS = 500;

const SENSITIVE_ENV_ASSIGNMENT =
  /\b(ADMIN_JWT_SECRET|SPONSOR_SECRET_KEY|SPONSOR_REFILL_ACCOUNT_SECRET_KEY|REDIS_URL|KV_REST_API_TOKEN|KV_REST_API_READ_ONLY_TOKEN|KV_URL)=\S+/g;

type AdminAuditLogEntry = {
  event: string;
  ip: string;
  ts?: string;
  [key: string]: string | undefined;
};

export function redactSensitiveErrorText(value: string): string {
  return value
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?:[^@\s/]+@)/gi, '$1[REDACTED]@')
    .replace(/\bhttps?:\/\/[^\s?#/]+(?:\/[^\s?#]*)?(?:\?[^\s]*)?/gi, (raw) => {
      try {
        const url = new URL(raw);
        const redactedPath = url.pathname === '/' ? '' : '/[REDACTED]';
        const redactedQuery = url.search ? '?[REDACTED]' : '';
        return `${url.origin}${redactedPath}${redactedQuery}`;
      } catch {
        return '[REDACTED_URL]';
      }
    })
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsuiprivkey1[0-9a-z]+/gi, '[REDACTED_SUI_PRIVATE_KEY]')
    .replace(SENSITIVE_ENV_ASSIGNMENT, '$1=[REDACTED]');
}

export function safeErrorSummary(err: unknown): string {
  const raw =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === 'string'
        ? err
        : Object.prototype.toString.call(err);
  return redactSensitiveErrorText(raw).slice(0, SAFE_ERROR_SUMMARY_MAX_CHARS);
}

export function sanitizeAdminAuditEntry(entry: AdminAuditLogEntry): AdminAuditLogEntry {
  const sanitized: AdminAuditLogEntry = {
    event: entry.event,
    ip: redactSensitiveErrorText(entry.ip),
    ts: entry.ts ?? new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined || key === 'event' || key === 'ip' || key === 'ts') continue;
    sanitized[key] = redactSensitiveErrorText(value);
  }
  return sanitized;
}

export async function writeAdminAuditLog(
  redis: AdminRedisClient,
  entry: AdminAuditLogEntry,
): Promise<void> {
  await redis.lpush(ADMIN_AUDIT_LOG_KEY, JSON.stringify(sanitizeAdminAuditEntry(entry)));
  await redis.ltrim(ADMIN_AUDIT_LOG_KEY, 0, ADMIN_AUDIT_LOG_MAX_ENTRIES - 1);
}
