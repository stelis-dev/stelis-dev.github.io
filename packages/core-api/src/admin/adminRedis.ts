/**
 * Admin Redis client interface.
 *
 * core-api owns the admin Redis command contract. The deployed Host owns
 * concrete Redis client creation, topology validation, and lifecycle. Admin
 * routes must receive this interface from the Host runtime context instead of
 * creating a second Redis connection path.
 */
export interface AdminRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { ex?: number }): Promise<void>;
  del(key: string): Promise<number>;
  scan(pattern: string): Promise<string[]>;
  ttl(key: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, field: string, value: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}
