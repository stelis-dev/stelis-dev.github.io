import type { AdminRedisClient } from '@stelis/core-api/admin';
import { redactSensitiveText } from '@stelis/core-api/observability';

export const ADMIN_AUDIT_LOG_KEY = 'stelis:admin:audit_log';
export const ADMIN_AUDIT_LOG_MAX_ENTRIES = 200;

type AdminAuditLogEntry = {
  event: string;
  ip: string;
  ts?: string;
  [key: string]: string | undefined;
};

export function sanitizeAdminAuditEntry(entry: AdminAuditLogEntry): AdminAuditLogEntry {
  const sanitized: AdminAuditLogEntry = {
    event: entry.event,
    ip: redactSensitiveText(entry.ip),
    ts: entry.ts ?? new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined || key === 'event' || key === 'ip' || key === 'ts') continue;
    sanitized[key] = redactSensitiveText(value);
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
