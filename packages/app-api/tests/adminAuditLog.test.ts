import { describe, expect, it, vi } from 'vitest';
import type { AdminRedisClient } from '@stelis/core-api/admin';
import { ADMIN_AUDIT_LOG_KEY, safeErrorSummary, writeAdminAuditLog } from '../src/adminAuditLog.js';

function makeRedis(): AdminRedisClient {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    scan: vi.fn(),
    ttl: vi.fn(),
    lrange: vi.fn(),
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn(),
  } as unknown as AdminRedisClient;
}

describe('admin audit log helpers', () => {
  it('redacts sensitive error summaries', () => {
    const summary = safeErrorSummary(
      new Error(
        'REDIS_URL=redis://:secret@redis.example:6379 ' +
          'SPONSOR_SECRET_KEY=suiprivkey1secretabc ' +
          'Bearer eyJ.secret ' +
          'https://provider.example/rpc/api-token?apiKey=secret',
      ),
    );

    expect(summary).not.toContain('secret@');
    expect(summary).not.toContain('suiprivkey1secretabc');
    expect(summary).not.toContain('eyJ.secret');
    expect(summary).not.toContain('api-token');
    expect(summary).not.toContain('apiKey=secret');
    expect(summary).toContain('REDIS_URL=[REDACTED]');
    expect(summary).toContain('SPONSOR_SECRET_KEY=[REDACTED]');
    expect(summary).toContain('Bearer [REDACTED]');
  });

  it('writes sanitized entries to the canonical admin audit key', async () => {
    const redis = makeRedis();

    await writeAdminAuditLog(redis, {
      event: 'WITHDRAWAL_ERROR',
      ip: '127.0.0.1',
      detail: 'redis unavailable at redis://:secret@redis.example:6379',
    });

    expect(redis.lpush).toHaveBeenCalledWith(ADMIN_AUDIT_LOG_KEY, expect.any(String));
    expect(redis.ltrim).toHaveBeenCalledWith(ADMIN_AUDIT_LOG_KEY, 0, 199);
    const line = vi.mocked(redis.lpush).mock.calls[0]![1] as string;
    const entry = JSON.parse(line) as { detail: string; ts: string };
    expect(entry.detail).toBe('redis unavailable at redis://[REDACTED]@redis.example:6379');
    expect(entry.ts).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
