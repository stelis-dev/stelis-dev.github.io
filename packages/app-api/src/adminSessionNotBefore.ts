import { raiseAdminSessionNotBefore } from '@stelis/core-api/admin';
import type { AdminRedisClient } from '@stelis/core-api/admin';

export const ADMIN_SESSION_NOT_BEFORE_KEY = 'stelis:app-api:admin:not_before';

export function raiseAppApiAdminSessionNotBefore(
  redis: Pick<AdminRedisClient, 'eval'>,
  candidateMs: number,
): Promise<number> {
  return raiseAdminSessionNotBefore(redis, ADMIN_SESSION_NOT_BEFORE_KEY, candidateMs);
}
