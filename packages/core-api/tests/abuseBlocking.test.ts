/**
 * AbuseBlockerAdapter — conformance + impl-only cases.
 *
 * The shared adapter contract is exercised by `abuseBlocker.conformance.ts`
 * and runs here once per backend (Memory + Redis). Memory-only cases
 * cover constructor validation and deliberately corrupted fixture state.
 *
 * Besides the backend conformance suites, the file carries the
 * `recordSponsorFailureForAbuse — recorder-adapter fault policy`
 * describe that covers the shared internal recorder-adapter
 * failure handling (swallow + emit `SPONSOR_FAILURE_RECORDER_FAILED`).
 * Sponsor-handler call-sites rely on this behaviour being owned
 * here — not duplicated inline.
 *
 * Classification semantics (manipulation vs ignored vs
 * counter-bucketed codes) stay owned by `abuseBlocking.ts` and
 * `docs/security.md`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AbuseBlockerAdapter } from '../src/store/abuseBlockTypes.js';
import { MemoryAbuseBlocker } from '../src/store/memoryAbuseBlocker.js';
import { RedisAbuseBlocker } from '../src/store/redisAbuseBlocker.js';
import type { RedisClientLike } from '../src/store/redisClient.js';
import {
  admitClientIp,
  BlockCheckUnavailableError,
  checkBlockedSubject,
  recordSponsorFailureForAbuse,
} from '../src/abuseBlocking.js';
import type { AdmittedClientIp } from '../src/abuseBlocking.js';
import {
  runAbuseBlockerConformanceTests,
  type AbuseBlockerFactory,
  type AbuseBlockerHandle,
} from './abuseBlocker.conformance.js';
import {
  AbuseBlockCurrentConflictError,
  AbuseBlockStorageCorruptionError,
} from '../src/store/abuseBlockStore.js';

// ─────────────────────────────────────────────
// Memory backend
// ─────────────────────────────────────────────

const memoryFactory: AbuseBlockerFactory = (config) => {
  let nowMs = Date.parse('2026-04-15T00:00:00.000Z');
  const blocker = new MemoryAbuseBlocker(config, { nowMs: () => nowMs });
  const handle: AbuseBlockerHandle = {
    blocker,
    advanceTime: (ms) => {
      nowMs += ms;
    },
    seedEqualDeadlineStudioUsers: async (userIds) => {
      for (const userId of userIds) {
        await blocker.recordSponsorFailure(
          '127.0.0.1',
          { kind: 'studio_user', userId },
          'TAMPERING_DETECTED',
        );
      }
    },
    dispose: () => {
      /* no-op — MemoryAbuseBlocker holds no timers or external handles */
    },
  };
  return handle;
};

describe('MemoryAbuseBlocker — shared conformance', () => {
  runAbuseBlockerConformanceTests(memoryFactory);
});

describe('MemoryAbuseBlocker — impl-only', () => {
  it('rejects unsafe numeric config values', () => {
    expect(() => new MemoryAbuseBlocker({ ipFailureThreshold: 1.5 })).toThrow('safe integer');
    expect(
      () => new MemoryAbuseBlocker({ ipFailureWindowMs: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow('positive safe integer');
  });

  it.each([
    {
      label: 'non-current reason',
      record: {
        identity: { scope: 'ip', subject: '127.0.0.1' },
        reason: 'not_current',
        blockedUntilMs: Date.now() + 60_000,
      },
    },
    {
      label: 'identity that differs from its map key',
      record: {
        identity: { scope: 'ip', subject: '127.0.0.2' },
        reason: 'manipulation',
        blockedUntilMs: Date.now() + 60_000,
      },
    },
  ])('rejects a stored block with $label', async ({ record }) => {
    const blocker = new MemoryAbuseBlocker();
    const blocks = Reflect.get(blocker, '_ipBlocks') as Map<string, unknown>;
    blocks.set('127.0.0.1', record);

    await expect(blocker.checkIp('127.0.0.1')).rejects.toBeInstanceOf(
      AbuseBlockStorageCorruptionError,
    );
  });
});

describe('RedisAbuseBlocker — finite transition results', () => {
  it('maps a repeated deadline_elapsed result to one typed conflict after one re-read', async () => {
    const evalCommand = vi
      .fn<RedisClientLike['eval']>()
      .mockResolvedValueOnce(['ok', '1000', '0', '', '0', ''])
      .mockResolvedValueOnce(['deadline_elapsed', '1001'])
      .mockResolvedValueOnce(['ok', '1002', '0', '', '0', ''])
      .mockResolvedValueOnce(['deadline_elapsed', '1003']);
    const client: RedisClientLike = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      hgetall: vi.fn(),
      eval: evalCommand,
    };
    const blocker = new RedisAbuseBlocker(client);

    try {
      await expect(
        blocker.recordSponsorFailure('192.0.2.12', undefined, 'TAMPERING_DETECTED'),
      ).rejects.toBeInstanceOf(AbuseBlockCurrentConflictError);
      expect(evalCommand).toHaveBeenCalledTimes(4);
    } finally {
      await blocker.stop();
    }
  });
});

// ─────────────────────────────────────────────
// recordSponsorFailureForAbuse — recorder-adapter fault policy
// ─────────────────────────────────────────────

/**
 * Blocker adapter failures must not mask the primary classified sponsor
 * rejection. Sponsor call-sites rely on this helper being owned here;
 * duplicating the swallow inline at sponsor handlers is disallowed.
 */
describe('recordSponsorFailureForAbuse — recorder-adapter fault policy', () => {
  /** Minimal adapter that throws from `recordSponsorFailure`. */
  function makeThrowingBlocker(error: Error): AbuseBlockerAdapter {
    return {
      checkIp: async () => ({ blocked: false }),
      checkSubject: async () => ({ blocked: false }),
      recordSponsorFailure: async () => {
        throw error;
      },
    };
  }

  it('swallows adapter throw and returns without re-throwing to caller', async () => {
    const blocker = makeThrowingBlocker(new Error('redis down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // MUST NOT throw — caller is on a classified-rejection path.
    await expect(
      recordSponsorFailureForAbuse(blocker, '127.0.0.1', undefined, 'SENDER_SIGNATURE_INVALID'),
    ).resolves.toBeUndefined();

    warnSpy.mockRestore();
  });

  it('emits SPONSOR_FAILURE_RECORDER_FAILED with primary fields + error message', async () => {
    const blocker = makeThrowingBlocker(new Error('redis down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await recordSponsorFailureForAbuse(
      blocker,
      '10.0.0.1',
      { kind: 'address', address: '0x' + 'ab'.repeat(32) },
      'PREFLIGHT_FAILED',
      { subcode: 'simulation_failed', executionPathKey: 'promotion:test-promo' },
    );

    const failedEvents = warnSpy.mock.calls
      .map((args) => {
        try {
          return JSON.parse(String(args[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (ev): ev is Record<string, unknown> => ev?.['event'] === 'SPONSOR_FAILURE_RECORDER_FAILED',
      );

    expect(failedEvents.length).toBe(1);
    const ev = failedEvents[0]!;
    expect(ev['ip']).toBe('10.0.0.1');
    expect(ev['address']).toBe('0x' + 'ab'.repeat(32));
    expect(ev['code']).toBe('PREFLIGHT_FAILED');
    expect(ev['subcode']).toBe('simulation_failed');
    expect(ev['executionPathKey']).toBe('promotion:test-promo');
    expect(ev['error']).toBe('redis down');

    warnSpy.mockRestore();
  });

  it('emits SPONSOR_FAILURE_RECORDED before the adapter call, even when adapter throws', async () => {
    const blocker = makeThrowingBlocker(new Error('boom'));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await recordSponsorFailureForAbuse(blocker, '127.0.0.1', undefined, 'SENDER_SIGNATURE_INVALID');

    const recorded = infoSpy.mock.calls
      .map((args) => {
        try {
          return JSON.parse(String(args[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((ev): ev is Record<string, unknown> => ev?.['event'] === 'SPONSOR_FAILURE_RECORDED');
    expect(recorded.length).toBe(1);

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('silently skips ignored codes without invoking the blocker (and no recorder_failed even if adapter would throw)', async () => {
    let adapterCalls = 0;
    const blocker: AbuseBlockerAdapter = {
      checkIp: async () => ({ blocked: false }),
      checkSubject: async () => ({ blocked: false }),
      recordSponsorFailure: async () => {
        adapterCalls++;
        throw new Error('should not be called');
      },
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // REPREPARE_REQUIRED is classified as `drift` in failures.ts;
    // shouldIgnoreSponsorFailureForAbuse returns true for the drift class.
    await recordSponsorFailureForAbuse(blocker, '127.0.0.1', undefined, 'REPREPARE_REQUIRED');

    expect(adapterCalls).toBe(0);
    const anyFailedEvent = warnSpy.mock.calls.some((args) => {
      try {
        return (
          (JSON.parse(String(args[0])) as Record<string, unknown>)['event'] ===
          'SPONSOR_FAILURE_RECORDER_FAILED'
        );
      } catch {
        return false;
      }
    });
    expect(anyFailedEvent).toBe(false);

    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────
// Opaque request admission — adapter-unavailability + anti-forgery contract
// ─────────────────────────────────────────────

/**
 * On adapter throw, IP/subject admission fails closed with a typed
 * `BlockCheckUnavailableError` and emits exactly one
 * `ABUSE_BLOCK_CHECK_FAILED` structured warn. Callers (routes +
 * middleware) rely on this helper rather than duplicating the
 * swallow-and-log inline.
 */
describe('opaque request admission', () => {
  function makeThrowingBlocker(scope: 'ip' | 'subject', error: Error): AbuseBlockerAdapter {
    return {
      checkIp: async () => {
        if (scope === 'ip') throw error;
        return { blocked: false };
      },
      checkSubject: async () => {
        if (scope === 'subject') throw error;
        return { blocked: false };
      },
      recordSponsorFailure: async () => {
        /* unused in this suite */
      },
    };
  }

  it('checkIp throw → throws BlockCheckUnavailableError and emits ABUSE_BLOCK_CHECK_FAILED warn', async () => {
    const blocker = makeThrowingBlocker('ip', new Error('redis down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(admitClientIp(blocker, '127.0.0.1')).rejects.toBeInstanceOf(
      BlockCheckUnavailableError,
    );

    const failedEvents = warnSpy.mock.calls
      .map((args) => {
        try {
          return JSON.parse(String(args[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((ev): ev is Record<string, unknown> => ev?.['event'] === 'ABUSE_BLOCK_CHECK_FAILED');
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0]!['ip']).toBe('127.0.0.1');
    expect(failedEvents[0]!['error']).toBe('redis down');
    expect(failedEvents[0]!['address']).toBeUndefined();

    warnSpy.mockRestore();
  });

  it('checkSubject throw → throws BlockCheckUnavailableError and ABUSE_BLOCK_CHECK_FAILED includes address', async () => {
    const blocker = makeThrowingBlocker('subject', new Error('adapter fault'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ADDRESS = '0x' + 'cd'.repeat(32);
    const admission = await admitClientIp(blocker, '10.0.0.1');
    if (admission.blocked) throw new Error('expected admitted test IP');
    await expect(
      checkBlockedSubject(blocker, admission.admittedClientIp, {
        kind: 'address',
        address: ADDRESS,
      }),
    ).rejects.toBeInstanceOf(BlockCheckUnavailableError);

    const failedEvents = warnSpy.mock.calls
      .map((args) => {
        try {
          return JSON.parse(String(args[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((ev): ev is Record<string, unknown> => ev?.['event'] === 'ABUSE_BLOCK_CHECK_FAILED');
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0]!['ip']).toBe('10.0.0.1');
    expect(failedEvents[0]!['address']).toBe(ADDRESS);
    expect(failedEvents[0]!['error']).toBe('adapter fault');

    warnSpy.mockRestore();
  });

  it('clean path (no adapter throw) does not emit ABUSE_BLOCK_CHECK_FAILED', async () => {
    const blocker: AbuseBlockerAdapter = {
      checkIp: async () => ({ blocked: false }),
      checkSubject: async () => ({ blocked: false }),
      recordSponsorFailure: async () => {
        /* unused */
      },
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const admission = await admitClientIp(blocker, '127.0.0.1');
    if (admission.blocked) throw new Error('expected admitted test IP');
    await expect(
      checkBlockedSubject(blocker, admission.admittedClientIp, {
        kind: 'address',
        address: '0x' + '11'.repeat(32),
      }),
    ).resolves.toMatchObject({ blocked: false });

    const emitted = warnSpy.mock.calls.some((args) => {
      try {
        return (
          (JSON.parse(String(args[0])) as Record<string, unknown>)['event'] ===
          'ABUSE_BLOCK_CHECK_FAILED'
        );
      } catch {
        return false;
      }
    });
    expect(emitted).toBe(false);

    warnSpy.mockRestore();
  });

  it('does not mint a token for a blocked IP', async () => {
    const blocker: AbuseBlockerAdapter = {
      checkIp: async () => ({ blocked: true, retryAfterMs: 5000 }),
      checkSubject: vi.fn(async () => ({ blocked: false })),
      recordSponsorFailure: async () => undefined,
    };

    const result = await admitClientIp(blocker, '203.0.113.10');

    expect(result).toEqual({ blocked: true, retryAfterMs: 5000 });
    expect('admittedClientIp' in result).toBe(false);
  });

  it('rejects a forged structural token before calling the subject adapter', async () => {
    const checkSubject = vi.fn(async () => ({ blocked: false }));
    const blocker: AbuseBlockerAdapter = {
      checkIp: async () => ({ blocked: false }),
      checkSubject,
      recordSponsorFailure: async () => undefined,
    };

    await expect(
      checkBlockedSubject({ ...blocker, checkSubject }, {} as AdmittedClientIp, {
        kind: 'address',
        address: '0x' + '11'.repeat(32),
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(checkSubject).not.toHaveBeenCalled();
  });
});
