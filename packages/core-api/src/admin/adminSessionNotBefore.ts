import type { AdminRedisClient } from './adminRedis.js';

const RAISE_NOT_BEFORE_LUA = `
local current = redis.call('GET', KEYS[1])
if current then
  if not string.match(current, '^%d+$') then
    return redis.error_reply('INVALID_CURRENT_NOT_BEFORE')
  end
  local current_number = tonumber(current)
  if not current_number or current_number > 9007199254740991 then
    return redis.error_reply('INVALID_CURRENT_NOT_BEFORE')
  end
  if current_number >= tonumber(ARGV[1]) then
    return current
  end
end
redis.call('SET', KEYS[1], ARGV[1])
return ARGV[1]
`;

/** Atomically raise the global admin-session cutoff without ever lowering it. */
export async function raiseAdminSessionNotBefore(
  redis: Pick<AdminRedisClient, 'eval'>,
  key: string,
  candidateMs: number,
): Promise<number> {
  if (key.length === 0) throw new Error('admin session not-before key must be non-empty');
  if (!Number.isSafeInteger(candidateMs) || candidateMs < 0) {
    throw new Error('admin session not-before candidate must be a non-negative safe integer');
  }
  const result = await redis.eval(RAISE_NOT_BEFORE_LUA, [key], [String(candidateMs)]);
  if (typeof result !== 'string' || !/^\d+$/.test(result)) {
    throw new Error('admin session not-before update returned an invalid result');
  }
  const cutoff = Number(result);
  if (!Number.isSafeInteger(cutoff) || cutoff < candidateMs) {
    throw new Error('admin session not-before update returned an invalid cutoff');
  }
  return cutoff;
}
