/**
 * AbuseBlockerAdapter — conformance + impl-only cases.
 *
 * The shared adapter contract is exercised by `abuseBlocker.conformance.ts`
 * and runs here once per backend (Memory + Redis). Memory-only cases
 * (MAX_BLOCK_KEYS bounded eviction via internal map seeding,
 * MAX_COUNTER_KEYS saturation) live under the
 * "MemoryAbuseBlocker — impl-only" describe. `RedisAbuseBlocker` has
 * no analogous bounded in-process map, so it has no corresponding
 * impl-only describe.
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
import { FakeRedisClient } from './helpers/fakeRedisClient.js';
import {
  BlockCheckUnavailableError,
  checkBlockedRequest,
  recordSponsorFailureForAbuse,
  toBlockedError,
} from '../src/abuseBlocking.js';
import {
  runAbuseBlockerConformanceTests,
  type AbuseBlockerFactory,
  type AbuseBlockerHandle,
} from './abuseBlocker.conformance.js';

// ─────────────────────────────────────────────
// Memory backend
// ─────────────────────────────────────────────

const memoryFactory: AbuseBlockerFactory = (config) => {
  const blocker = new MemoryAbuseBlocker(config);
  const handle: AbuseBlockerHandle = {
    blocker,
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

  // White-box: MAX_BLOCK_KEYS (100_000) is too large to fill via the
  // public API. Seed the internal map at capacity, then trigger a
  // new block via the public API and verify the evict-oldest path
  // does not fail-open. If MAX_BLOCK_KEYS changes in the source, the
  // constant below must follow.
  it('block map bounded: evicts oldest entry at capacity via public API', async () => {
    const blocker = new MemoryAbuseBlocker({
      manipulationBlockDurationMs: 10_000,
    });

    const ipBlocks = (blocker as unknown as Record<string, Map<string, unknown>>)._ipBlocks as Map<
      string,
      { reason: string; expiresAt: number }
    >;
    const now = Date.now();
    for (let i = 0; i < 100_000; i++) {
      const fakeIp = `10.${Math.floor(i / 65536) % 256}.${Math.floor(i / 256) % 256}.${i % 256}`;
      ipBlocks.set(fakeIp, {
        reason: 'manipulation:TAMPERING_DETECTED',
        expiresAt: now + 10_000 + i,
      });
    }
    expect(ipBlocks.size).toBe(100_000);

    const newIp = '192.168.1.1';
    const ADDRESS = '0x' + '11'.repeat(32);
    await blocker.recordSponsorFailure(
      newIp,
      { kind: 'address', address: ADDRESS },
      'TAMPERING_DETECTED',
    );

    await expect(blocker.checkIp(newIp)).resolves.toMatchObject({ blocked: true });
    await expect(blocker.checkIp('10.0.0.0')).resolves.toMatchObject({ blocked: false });
    expect(ipBlocks.size).toBe(100_000);
  });

  it('counter map saturation: fresh key still tracked (no fail-open)', async () => {
    // MAX_COUNTER_KEYS = 50_000. Saturate, then verify a fresh IP
    // still crosses its threshold — i.e. the bounded counter map
    // does not silently drop admissions.
    const blocker = new MemoryAbuseBlocker({
      ipFailureThreshold: 1,
      ipFailureWindowMs: 60_000,
      ipBlockDurationMs: 300_000,
    });

    for (let i = 0; i < 50_000; i++) {
      await blocker.recordSponsorFailure(
        `192.168.${Math.floor(i / 256)}.${i % 256}`,
        undefined,
        'PREFLIGHT_FAILED',
      );
    }

    const freshIp = '10.99.99.99';
    await blocker.recordSponsorFailure(freshIp, undefined, 'PREFLIGHT_FAILED');
    await blocker.recordSponsorFailure(freshIp, undefined, 'PREFLIGHT_FAILED');

    const status = await blocker.checkIp(freshIp);
    expect(status.blocked).toBe(true);
  });
});

// ─────────────────────────────────────────────
// Redis backend
// ─────────────────────────────────────────────

const redisFactory: AbuseBlockerFactory = (config) => {
  const redis = new FakeRedisClient();
  const blocker = new RedisAbuseBlocker(redis, config);
  const handle: AbuseBlockerHandle = {
    blocker,
    dispose: () => {
      /* no-op — FakeRedisClient has no long-lived handles */
    },
  };
  return handle;
};

describe('RedisAbuseBlocker — shared conformance', () => {
  runAbuseBlockerConformanceTests(redisFactory);
});

describe('blocked response projection', () => {
  it('omits an unavailable retry duration instead of emitting an invalid undefined wire field', () => {
    expect(toBlockedError({ blocked: true })).toEqual({
      error: 'Request temporarily blocked',
      code: 'ABUSE_BLOCKED',
    });
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
// checkBlockedRequest — adapter-unavailability fail-closed contract
// ─────────────────────────────────────────────

/**
 * On adapter throw, `checkBlockedRequest` fails closed with a typed
 * `BlockCheckUnavailableError` and emits exactly one
 * `ABUSE_BLOCK_CHECK_FAILED` structured warn. Callers (routes +
 * middleware) rely on this helper rather than duplicating the
 * swallow-and-log inline.
 */
describe('checkBlockedRequest — adapter-unavailability fail-closed contract', () => {
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

    await expect(checkBlockedRequest(blocker, '127.0.0.1')).rejects.toBeInstanceOf(
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
    await expect(
      checkBlockedRequest(blocker, '10.0.0.1', { kind: 'address', address: ADDRESS }),
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

    await expect(
      checkBlockedRequest(blocker, '127.0.0.1', {
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
});
