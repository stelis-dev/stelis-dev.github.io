/**
 * wrapRedisClient().scan() — fallback contract coverage.
 *
 * The promotion execution ledger reaper ([studio/executionLedgerRedis.ts]) delegates key
 * discovery to the wrapped Redis client abstraction, NOT to its own code.
 * This file covers the two branches that wrapped `scan()` is responsible for:
 *
 *   1. Raw client exposes `scanIterator`  → iterate + return key array.
 *   2. Raw client lacks `scanIterator`    → warn `REDIS_SCAN_UNAVAILABLE`
 *                                           and return `[]` (reaper degrades
 *                                           to eviction-callback-only cleanup).
 *
 * Uses a file-local fake `RawRedisClient`, not redis-memory-server: the
 * `scanIterator`-absent branch cannot be reproduced against a real client.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RawRedisClient } from '../src/store/redisClient.js';
import { wrapRedisClient } from '../src/store/redisClient.js';

function makeUnusedRawShell(): Omit<RawRedisClient, 'scanIterator'> {
  // Only `scan()` is exercised; other methods throw so accidental use is loud.
  const fail = (name: string) => () => {
    throw new Error(`unexpected ${name}() call`);
  };
  return {
    get: fail('get'),
    set: fail('set'),
    del: fail('del'),
    eval: fail('eval'),
    hGetAll: fail('hGetAll'),
  };
}

describe('wrapRedisClient().scan() fallback contract', () => {
  it('iterates scanIterator and returns matched keys when available', async () => {
    const keys = [
      'stelis:promotion_execution_ledger:res:a',
      'stelis:promotion_execution_ledger:res:b',
      'stelis:promotion_execution_ledger:res:c',
    ];
    const seenOptions: { MATCH: string; COUNT?: number }[] = [];

    const raw: RawRedisClient = {
      ...makeUnusedRawShell(),
      scanIterator(options) {
        seenOptions.push(options);
        return (async function* () {
          for (const k of keys) yield k;
        })();
      },
    };

    const client = wrapRedisClient(raw);
    const result = await client.scan('stelis:promotion_execution_ledger:res:*', 50);

    expect(result).toEqual(keys);
    expect(seenOptions).toEqual([{ MATCH: 'stelis:promotion_execution_ledger:res:*', COUNT: 50 }]);
  });

  it('applies default COUNT=100 when caller omits it', async () => {
    const seenOptions: { MATCH: string; COUNT?: number }[] = [];
    const raw: RawRedisClient = {
      ...makeUnusedRawShell(),
      scanIterator(options) {
        seenOptions.push(options);
        return (async function* () {
          // no keys
        })();
      },
    };

    const client = wrapRedisClient(raw);
    const result = await client.scan('stelis:promotion_execution_ledger:res:*');

    expect(result).toEqual([]);
    expect(seenOptions).toEqual([{ MATCH: 'stelis:promotion_execution_ledger:res:*', COUNT: 100 }]);
  });

  it('logs REDIS_SCAN_UNAVAILABLE and returns [] when scanIterator is absent', async () => {
    const raw: RawRedisClient = {
      ...makeUnusedRawShell(),
      // No scanIterator — wrapped client must fall through to the degrade path.
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = wrapRedisClient(raw);
    const result = await client.scan('stelis:promotion_execution_ledger:res:*');

    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(warnSpy.mock.calls[0]![0] as string);
    expect(payload).toMatchObject({
      event: 'REDIS_SCAN_UNAVAILABLE',
      pattern: 'stelis:promotion_execution_ledger:res:*',
    });
    expect(typeof payload.reason).toBe('string');

    warnSpy.mockRestore();
  });
});
