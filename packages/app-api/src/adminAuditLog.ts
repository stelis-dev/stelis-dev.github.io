import type { AdminRedisClient } from '@stelis/core-api/admin';
import { parseAdminAuditLogEntry, type AdminAuditLogEntry } from '@stelis/contracts';
import { redactSensitiveText } from '@stelis/core-api/observability';

export const ADMIN_AUDIT_LOG_KEY = 'stelis:admin:audit_log';
export const ADMIN_AUDIT_LOG_MAX_ENTRIES = 200;

type AdminAuditLogInput = Omit<AdminAuditLogEntry, 'ts'> & { ts?: string };

function sanitizeAdminAuditEntry(entry: AdminAuditLogInput): AdminAuditLogEntry {
  return parseAdminAuditLogEntry({
    event: entry.event,
    ip: redactSensitiveText(entry.ip),
    ts: entry.ts ?? new Date().toISOString(),
    ...(entry.address === undefined ? {} : { address: redactSensitiveText(entry.address) }),
    ...(entry.reason === undefined ? {} : { reason: redactSensitiveText(entry.reason) }),
    ...(entry.error === undefined ? {} : { error: redactSensitiveText(entry.error) }),
    ...(entry.detail === undefined ? {} : { detail: redactSensitiveText(entry.detail) }),
  });
}

export async function writeAdminAuditLog(
  redis: AdminRedisClient,
  entry: AdminAuditLogInput,
): Promise<void> {
  await redis.lpush(ADMIN_AUDIT_LOG_KEY, JSON.stringify(sanitizeAdminAuditEntry(entry)));
  await redis.ltrim(ADMIN_AUDIT_LOG_KEY, 0, ADMIN_AUDIT_LOG_MAX_ENTRIES - 1);
}
