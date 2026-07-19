import { describe, expect, it, vi } from 'vitest';
import {
  ADMIN_BLOCKLIST_CURSOR_MAX_LENGTH,
  isValidStudioUserId,
  parseAdminBlocklistDeleteRequest,
  parseAdminBlocklistQuery,
  parseAdminBlocklistResponse,
  STUDIO_USER_ID_MAX_LENGTH,
} from '@stelis/contracts';
import {
  AbuseBlockInputError,
  AbuseBlockStorageCorruptionError,
  abuseBlockMember,
  decideAbuseBlockRemoval,
  decideAbuseBlockWrite,
  decodeAbuseBlockCursor,
  decodeAbuseBlockMember,
  decodeAbuseBlockRecord,
  encodeAbuseBlockCursor,
  normalizeAbuseBlockIdentity,
  serializeAbuseBlockRecord,
} from '../src/store/abuseBlockStore.js';
import { MemoryAbuseBlocker } from '../src/store/memoryAbuseBlocker.js';
import { RedisAbuseBlocker } from '../src/store/redisAbuseBlocker.js';
import type { RedisClientLike } from '../src/store/redisClient.js';

describe('abuse block record authority', () => {
  it('canonicalizes IPv6 and Sui address identities without changing studio-user case', () => {
    expect(
      normalizeAbuseBlockIdentity({
        scope: 'ip',
        subject: '2001:0db8:0:0:0:0:0:1',
      }),
    ).toEqual({ scope: 'ip', subject: '2001:db8::1' });
    expect(
      normalizeAbuseBlockIdentity({
        scope: 'ip',
        subject: 'fe80:0:0:0:0:0:0:1%lo0',
      }),
    ).toEqual({ scope: 'ip', subject: 'fe80::1' });
    expect(
      normalizeAbuseBlockIdentity({
        scope: 'ip',
        subject: 'fe80:0:0:0:0:0:0:1%en0',
      }),
    ).toEqual({ scope: 'ip', subject: 'fe80::1' });
    expect(
      normalizeAbuseBlockIdentity({
        scope: 'ip',
        subject: `fe80::1%${'z'.repeat(400)}`,
      }),
    ).toEqual({ scope: 'ip', subject: 'fe80::1' });
    expect(
      normalizeAbuseBlockIdentity({
        scope: 'address',
        subject: '0x2',
      }),
    ).toEqual({ scope: 'address', subject: `0x${'0'.repeat(63)}2` });
    expect(
      normalizeAbuseBlockIdentity({
        scope: 'studio_user',
        subject: 'User-A',
      }),
    ).toEqual({ scope: 'studio_user', subject: 'User-A' });
  });

  it('round-trips the canonical index member, stored record, and opaque cursor', () => {
    const record = {
      identity: { scope: 'studio_user' as const, subject: 'User-A' },
      reason: 'manipulation' as const,
      blockedUntilMs: 1_800_000_000_000,
    };
    const member = abuseBlockMember(record.identity);
    expect(decodeAbuseBlockMember(member)).toEqual(record.identity);
    expect(decodeAbuseBlockRecord(serializeAbuseBlockRecord(record))).toEqual(record);
    expect(decodeAbuseBlockCursor(encodeAbuseBlockCursor(record))).toEqual({
      blockedUntilMs: record.blockedUntilMs,
      scope: 'studio_user',
      subject: 'User-A',
    });
  });

  it('uses one bounded ASCII Studio user ID rule across records and Admin cursors', () => {
    const userId = 'A'.repeat(STUDIO_USER_ID_MAX_LENGTH);
    const identity = { scope: 'studio_user' as const, subject: userId };
    const blockedUntilMs = 1_800_000_000_000;
    const cursor = encodeAbuseBlockCursor({ identity, blockedUntilMs });

    expect(isValidStudioUserId(userId)).toBe(true);
    expect(cursor.length).toBeLessThanOrEqual(ADMIN_BLOCKLIST_CURSOR_MAX_LENGTH);
    expect(parseAdminBlocklistQuery({ cursor, limit: 100 })).toEqual({ cursor, limit: 100 });
    expect(
      parseAdminBlocklistResponse({
        blocklist: [
          { scope: 'studio_user', subject: userId, reason: 'manipulation', blockedUntilMs },
        ],
        nextCursor: cursor,
      }),
    ).toMatchObject({ nextCursor: cursor });
    expect(parseAdminBlocklistDeleteRequest({ scope: 'studio_user', subject: userId })).toEqual(
      identity,
    );

    for (const invalid of ['사용자', 'User A', 'User\u0000A', 'A'.repeat(129)]) {
      expect(isValidStudioUserId(invalid)).toBe(false);
      expect(() => normalizeAbuseBlockIdentity({ scope: 'studio_user', subject: invalid })).toThrow(
        AbuseBlockInputError,
      );
      expect(() =>
        parseAdminBlocklistDeleteRequest({ scope: 'studio_user', subject: invalid }),
      ).toThrow();
      expect(() =>
        parseAdminBlocklistResponse({
          blocklist: [
            {
              scope: 'studio_user',
              subject: invalid,
              reason: 'manipulation',
              blockedUntilMs,
            },
          ],
          nextCursor: null,
        }),
      ).toThrow();
    }
    expect(() => decodeAbuseBlockCursor('a'.repeat(ADMIN_BLOCKLIST_CURSOR_MAX_LENGTH + 1))).toThrow(
      'canonical base64url',
    );
  });

  it('rejects extra or malformed stored fields and non-canonical cursors', () => {
    expect(() =>
      decodeAbuseBlockRecord(
        JSON.stringify({
          member: abuseBlockMember({ scope: 'ip', subject: '127.0.0.1' }),
          reason: 'unknown',
          blockedUntilMs: '100',
        }),
      ),
    ).toThrow(AbuseBlockStorageCorruptionError);
    expect(() =>
      decodeAbuseBlockRecord(
        JSON.stringify({
          reason: 'manipulation',
          member: abuseBlockMember({ scope: 'ip', subject: '127.0.0.1' }),
          blockedUntilMs: '100',
        }),
      ),
    ).toThrow(AbuseBlockStorageCorruptionError);
    expect(() => decodeAbuseBlockCursor('e30')).toThrow();
  });

  it('keeps block preservation and expiry removal in one pure transition authority', () => {
    const current = {
      identity: { scope: 'ip' as const, subject: '127.0.0.1' },
      reason: 'manipulation' as const,
      blockedUntilMs: 200,
    };
    const shorter = {
      ...current,
      reason: 'sponsor_failure_threshold' as const,
      blockedUntilMs: 150,
    };
    const longer = {
      ...current,
      reason: 'sponsor_failure_threshold' as const,
      blockedUntilMs: 250,
    };

    expect(decideAbuseBlockWrite(current, shorter)).toEqual({
      kind: 'preserved',
      record: current,
    });
    expect(decideAbuseBlockWrite(current, longer)).toEqual({
      kind: 'stored',
      record: longer,
    });
    expect(decideAbuseBlockRemoval(current, 199)).toBe('removed');
    expect(decideAbuseBlockRemoval(current, 200)).toBe('missing');
  });

  it('rejects an unknown runtime scope instead of treating it as studio_user', () => {
    expect(() =>
      normalizeAbuseBlockIdentity({
        scope: 'unknown',
        subject: 'User-A',
      } as never),
    ).toThrow(AbuseBlockInputError);
  });
});

describe('MemoryAbuseBlocker page and removal contract', () => {
  it('does not shorten a live manipulation block when a shorter threshold block arrives later', async () => {
    const now = 1_700_000_000_000;
    const clock = { nowMs: vi.fn(() => now) };
    const store = new MemoryAbuseBlocker(
      {
        manipulationBlockDurationMs: 24 * 60 * 60 * 1000,
        ipFailureThreshold: 0,
        ipBlockDurationMs: 15 * 60 * 1000,
      },
      clock,
    );

    await store.recordSponsorFailure('127.0.0.1', undefined, 'TAMPERING_DETECTED');
    await store.recordSponsorFailure('127.0.0.1', undefined, 'PREFLIGHT_FAILED');

    await expect(store.checkIp('127.0.0.1')).resolves.toMatchObject({
      blocked: true,
      reason: 'manipulation',
      retryAfterMs: 24 * 60 * 60 * 1000,
    });
  });

  it('uses one canonical IP key for threshold recording and checks', async () => {
    const store = new MemoryAbuseBlocker({
      ipFailureThreshold: 0,
      ipBlockDurationMs: 60_000,
    });
    await store.recordSponsorFailure('2001:0db8:0:0:0:0:0:1', undefined, 'PREFLIGHT_FAILED');
    await expect(store.checkIp('2001:db8::1')).resolves.toMatchObject({
      blocked: true,
      scope: 'ip',
    });
  });

  it('orders all scopes by deadline/member, uses an exclusive cursor, and removes idempotently', async () => {
    let now = 1_700_000_000_000;
    const store = new MemoryAbuseBlocker(
      {
        manipulationBlockDurationMs: 60_000,
      },
      { nowMs: () => now },
    );
    await store.recordSponsorFailure('127.0.0.1', undefined, 'TAMPERING_DETECTED');
    await store.recordSponsorFailure(
      '127.0.0.1',
      { kind: 'address', address: '0x2' },
      'TAMPERING_DETECTED',
    );
    await store.recordSponsorFailure(
      '127.0.0.1',
      { kind: 'studio_user', userId: 'User-A' },
      'TAMPERING_DETECTED',
    );

    const first = await store.listBlocks({ cursor: null, limit: 2 });
    expect(first.blocks).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await store.listBlocks({ cursor: first.nextCursor, limit: 2 });
    expect(second.blocks).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const identities = [...first.blocks, ...second.blocks].map((block) => block.identity.scope);
    expect(new Set(identities)).toEqual(new Set(['ip', 'address', 'studio_user']));

    const identity = second.blocks[0]!.identity;
    await expect(store.removeBlock(identity)).resolves.toBe(true);
    await expect(store.removeBlock(identity)).resolves.toBe(false);

    now += 60_001;
    await expect(store.listBlocks({ cursor: null, limit: 50 })).resolves.toEqual({
      blocks: [],
      nextCursor: null,
    });
  });

  it('includes an identity again when its deadline moves after an issued cursor', async () => {
    let now = 1_700_000_000_000;
    const store = new MemoryAbuseBlocker(
      { manipulationBlockDurationMs: 60_000 },
      { nowMs: () => now },
    );
    const address = '0x2';
    await store.recordSponsorFailure(
      '127.0.0.1',
      { kind: 'address', address },
      'TAMPERING_DETECTED',
    );
    const first = await store.listBlocks({ cursor: null, limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const movedIdentity = first.blocks[0]!.identity;

    now += 1_000;
    await store.recordSponsorFailure(
      '127.0.0.1',
      { kind: 'address', address },
      'TAMPERING_DETECTED',
    );
    const next = await store.listBlocks({ cursor: first.nextCursor, limit: 50 });
    expect(next.blocks.map((block) => block.identity)).toContainEqual(movedIdentity);
  });

  it('rejects malformed cursors and limits outside the closed boundary', async () => {
    const store = new MemoryAbuseBlocker();
    await expect(store.listBlocks({ cursor: 'e30', limit: 50 })).rejects.toBeInstanceOf(
      AbuseBlockInputError,
    );
    await expect(store.listBlocks({ cursor: null, limit: 0 })).rejects.toBeInstanceOf(
      AbuseBlockInputError,
    );
    await expect(store.listBlocks({ cursor: null, limit: 101 })).rejects.toBeInstanceOf(
      AbuseBlockInputError,
    );
    await expect(store.listBlocks({ cursor: null, limit: 100 })).resolves.toEqual({
      blocks: [],
      nextCursor: null,
    });
  });
});

describe('RedisAbuseBlocker task and sparse-page boundary', () => {
  it('coalesces scheduled ticks and stop waits for the running expiry call', async () => {
    vi.useFakeTimers();
    let resolveSweep!: (value: unknown) => void;
    const pendingSweep = new Promise<unknown>((resolve) => {
      resolveSweep = resolve;
    });
    const evalMock = vi.fn<RedisClientLike['eval']>().mockReturnValue(pendingSweep);
    const store = new RedisAbuseBlocker(redisClient(evalMock));
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(evalMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(evalMock).toHaveBeenCalledTimes(1);

      let stopped = false;
      const stopping = store.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      resolveSweep(['ok', '1700000000000', []]);
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      resolveSweep(['ok', '1700000000000', []]);
      await store.stop();
      vi.useRealTimers();
    }
  });

  it('returns a sparse bounded page without issuing a second fetch to fill stale rows', async () => {
    const identity = normalizeAbuseBlockIdentity({ scope: 'ip', subject: '127.0.0.1' });
    const member = abuseBlockMember(identity);
    const deadline = 1_800_000_000_000;
    const evalMock = vi
      .fn<RedisClientLike['eval']>()
      .mockResolvedValueOnce([
        'ok',
        '1700000000000',
        '0',
        '',
        '0',
        '',
        '1',
        member,
        String(deadline),
        [
          [abuseBlockMember({ scope: 'ip', subject: '192.0.2.1' }), '1', '0', ''],
          [abuseBlockMember({ scope: 'ip', subject: '192.0.2.2' }), '2', '0', ''],
          [
            member,
            String(deadline),
            '1',
            serializeAbuseBlockRecord({
              identity,
              reason: 'manipulation',
              blockedUntilMs: deadline,
            }),
          ],
        ],
      ])
      .mockResolvedValueOnce(['ok', '1700000000000', '2']);
    const store = new RedisAbuseBlocker(redisClient(evalMock));
    try {
      const page = await store.listBlocks({ cursor: null, limit: 3 });
      expect(page.blocks).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
      expect(evalMock).toHaveBeenCalledTimes(2);
      expect(evalMock.mock.calls[0]![2]).toContain('3');
    } finally {
      await store.stop();
    }
  });

  it('rejects a page result that exceeds the requested limit', async () => {
    const identity = normalizeAbuseBlockIdentity({ scope: 'ip', subject: '127.0.0.1' });
    const member = abuseBlockMember(identity);
    const deadline = 1_800_000_000_000;
    const row = [
      member,
      String(deadline),
      '1',
      serializeAbuseBlockRecord({
        identity,
        reason: 'manipulation',
        blockedUntilMs: deadline,
      }),
    ];
    const evalMock = vi
      .fn<RedisClientLike['eval']>()
      .mockResolvedValue(['ok', '1700000000000', '0', '', '0', '', '0', '', '', [row, row]]);
    const store = new RedisAbuseBlocker(redisClient(evalMock));
    try {
      await expect(store.listBlocks({ cursor: null, limit: 1 })).rejects.toThrow(
        'storage is corrupt',
      );
    } finally {
      await store.stop();
    }
  });

  it('rejects an expiry result larger than the fixed batch', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => [
      abuseBlockMember({ scope: 'ip', subject: `192.0.2.${index}` }),
      '1',
      '0',
      '',
    ]);
    const evalMock = vi
      .fn<RedisClientLike['eval']>()
      .mockResolvedValue(['ok', '1700000000000', rows]);
    const store = new RedisAbuseBlocker(redisClient(evalMock));
    try {
      await expect(
        (
          store as unknown as {
            runExpirySweep(): Promise<void>;
          }
        ).runExpirySweep(),
      ).rejects.toThrow('storage is corrupt');
    } finally {
      await store.stop();
    }
  });
});

function redisClient(evalMock: RedisClientLike['eval']): RedisClientLike {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    eval: evalMock,
    hgetall: vi.fn(),
  };
}
