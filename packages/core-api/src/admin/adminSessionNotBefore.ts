import type { AdminRedisClient } from './adminRedis.js';

const UPDATE_NOT_BEFORE_LUA = `
local operation = ARGV[2]
if operation ~= 'initialize' and operation ~= 'raise' then
  return redis.error_reply('INVALID_NOT_BEFORE_OPERATION')
end
local current = redis.call('GET', KEYS[1])
if current then
  if not string.match(current, '^%d+$') or (#current > 1 and string.sub(current, 1, 1) == '0') then
    return redis.error_reply('INVALID_CURRENT_NOT_BEFORE')
  end
  local current_number = tonumber(current)
  if not current_number or current_number > 9007199254740991 then
    return redis.error_reply('INVALID_CURRENT_NOT_BEFORE')
  end
  if operation == 'initialize' or current_number >= tonumber(ARGV[1]) then
    return current
  end
end
redis.call('SET', KEYS[1], ARGV[1])
return ARGV[1]
`;

type AdminSessionNotBeforeOperation = 'initialize' | 'raise';

async function updateAdminSessionNotBefore(
  redis: Pick<AdminRedisClient, 'eval'>,
  key: string,
  candidateMs: number,
  operation: AdminSessionNotBeforeOperation,
): Promise<number> {
  if (key.length === 0) throw new Error('admin session not-before key must be non-empty');
  if (!Number.isSafeInteger(candidateMs) || candidateMs < 0) {
    throw new Error('admin session not-before candidate must be a non-negative safe integer');
  }
  const result = await redis.eval(UPDATE_NOT_BEFORE_LUA, [key], [String(candidateMs), operation]);
  if (typeof result !== 'string' || !/^(?:0|[1-9]\d*)$/.test(result)) {
    throw new Error('admin session not-before update returned an invalid result');
  }
  const cutoff = Number(result);
  if (!Number.isSafeInteger(cutoff) || (operation === 'raise' && cutoff < candidateMs)) {
    throw new Error('admin session not-before update returned an invalid cutoff');
  }
  return cutoff;
}

/** Atomically create the deployment-wide cutoff without changing an existing value. */
export function initializeAdminSessionNotBefore(
  redis: Pick<AdminRedisClient, 'eval'>,
  key: string,
  candidateMs: number,
): Promise<number> {
  return updateAdminSessionNotBefore(redis, key, candidateMs, 'initialize');
}

/** Atomically raise the deployment-wide cutoff without ever lowering it. */
export function raiseAdminSessionNotBefore(
  redis: Pick<AdminRedisClient, 'eval'>,
  key: string,
  candidateMs: number,
): Promise<number> {
  return updateAdminSessionNotBefore(redis, key, candidateMs, 'raise');
}
