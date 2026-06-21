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
  set(key: string, value: string, options?: { px?: number }): Promise<void>;
  del(key: string): Promise<number>;
  scan(pattern: string): Promise<string[]>;
  ttl(key: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}
