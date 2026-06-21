/**
 * Redis topology probe — host-boundary fail-closed tests.
 *
 * Tests validate that createRedisClient() rejects unsupported Redis topologies
 * at boot time, before any domain logic can execute. Probe paths:
 *   1. redis_mode:standalone data endpoint → succeeds
 *   2. redis_mode:cluster → fail-closed + client cleaned up
 *   3. redis_mode:sentinel → fail-closed + client cleaned up
 *   4. sendCommand missing → fail-closed + client cleaned up
 *   5. INFO server non-string response → fail-closed + client cleaned up
 *   6. redis_mode field missing → fail-closed + client cleaned up
 *   7. sendCommand rejects → fail-closed + client cleaned up
 *
 * Mocks the `redis` module to inject a controlled fake client.
 * INFO server mock responses use the real Redis server section field
 * `redis_mode` (not `cluster_enabled`, which is in the cluster section).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock state ────────────────────────────────────────────────────────────

let mockSendCommand: ((args: string[]) => Promise<unknown>) | undefined;
let mockHasSendCommand = true;
/** Captures the last mock client created by createClient for quit() assertions. */
let lastMockClient: Record<string, unknown> | null = null;

/** Realistic INFO server response for standalone Redis. */
const STANDALONE_INFO = `# Server\r\nredis_version:7.2.0\r\nredis_mode:standalone\r\nos:Linux\r\n`;
/** Realistic INFO server response for cluster Redis. */
const CLUSTER_INFO = `# Server\r\nredis_version:7.2.0\r\nredis_mode:cluster\r\nos:Linux\r\n`;
/** Realistic INFO server response for sentinel Redis. */
const SENTINEL_INFO = `# Server\r\nredis_version:7.2.0\r\nredis_mode:sentinel\r\nos:Linux\r\n`;
/** INFO response missing redis_mode field entirely. */
const NO_MODE_INFO = `# Server\r\nredis_version:7.2.0\r\nos:Linux\r\n`;

// ── Mock the redis package ────────────────────────────────────────────────

vi.mock('redis', () => ({
  createClient: vi.fn().mockImplementation(() => {
    const client: Record<string, unknown> = {
      isOpen: false,
      connect: vi.fn().mockImplementation(async () => {
        client.isOpen = true;
      }),
      quit: vi.fn().mockImplementation(async () => {
        client.isOpen = false;
      }),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(0),
      eval: vi.fn().mockResolvedValue(null),
      hGetAll: vi.fn().mockResolvedValue({}),
      ttl: vi.fn().mockResolvedValue(60),
      lRange: vi.fn().mockResolvedValue([]),
      lPush: vi.fn().mockResolvedValue(1),
      lTrim: vi.fn().mockResolvedValue(undefined),
    };
    // sendCommand is conditionally present based on test scenario
    if (mockHasSendCommand) {
      client.sendCommand = (...args: unknown[]) => mockSendCommand!(...(args as [string[]]));
    }
    lastMockClient = client;
    return client;
  }),
}));

// ── Import after mock ─────────────────────────────────────────────────────

import { createRedisClient } from '../src/redisClient.js';

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Redis topology probe (createRedisClient)', () => {
  beforeEach(() => {
    mockHasSendCommand = true;
    mockSendCommand = vi.fn().mockResolvedValue(STANDALONE_INFO);
    lastMockClient = null;
  });

  it('redis_mode:standalone → createRedisClient succeeds', async () => {
    mockSendCommand = vi.fn().mockResolvedValue(STANDALONE_INFO);

    const client = await createRedisClient('redis://localhost');
    expect(client).toBeDefined();
    expect(client.get).toBeDefined();
    expect(mockSendCommand).toHaveBeenCalledWith(['INFO', 'server']);
    await client.dispose();
  });

  it('reconnects and re-probes before commands when the cached client was closed', async () => {
    mockSendCommand = vi.fn().mockResolvedValue(STANDALONE_INFO);

    const client = await createRedisClient('redis://localhost');
    expect(lastMockClient!.connect).toHaveBeenCalledTimes(1);
    expect(mockSendCommand).toHaveBeenCalledTimes(1);

    lastMockClient!.isOpen = false;
    await client.eval('return 1', ['stelis:test:key'], ['900000']);

    expect(lastMockClient!.connect).toHaveBeenCalledTimes(2);
    expect(mockSendCommand).toHaveBeenCalledTimes(2);
    expect(lastMockClient!.eval).toHaveBeenCalledWith('return 1', {
      keys: ['stelis:test:key'],
      arguments: ['900000'],
    });
    await client.dispose();
  });

  it('reconnects once when a command observes a closed client race', async () => {
    mockSendCommand = vi.fn().mockResolvedValue(STANDALONE_INFO);

    const client = await createRedisClient('redis://localhost');
    const closedError = new Error('The client is closed');
    closedError.name = 'ClientClosedError';
    (lastMockClient!.eval as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      lastMockClient!.isOpen = false;
      throw closedError;
    });

    await client.eval('return 1', ['stelis:test:key'], ['900000']);

    expect(lastMockClient!.connect).toHaveBeenCalledTimes(2);
    expect(mockSendCommand).toHaveBeenCalledTimes(2);
    expect(lastMockClient!.eval).toHaveBeenCalledTimes(2);
    await client.dispose();
  });

  it('redis_mode:cluster → fail-closed + client cleaned up', async () => {
    mockSendCommand = vi.fn().mockResolvedValue(CLUSTER_INFO);

    await expect(createRedisClient('redis://localhost')).rejects.toThrow(
      /Unsupported Redis topology: redis_mode:cluster.*standalone Redis data endpoint/s,
    );
    expect(lastMockClient!.quit).toHaveBeenCalledTimes(1);
  });

  it('redis_mode:sentinel → fail-closed + client cleaned up', async () => {
    mockSendCommand = vi.fn().mockResolvedValue(SENTINEL_INFO);

    await expect(createRedisClient('redis://localhost')).rejects.toThrow(
      /Unsupported Redis topology: redis_mode:sentinel.*standalone Redis data endpoint/s,
    );
    expect(lastMockClient!.quit).toHaveBeenCalledTimes(1);
  });

  it('sendCommand missing → fail-closed + client cleaned up', async () => {
    mockHasSendCommand = false;

    await expect(createRedisClient('redis://localhost')).rejects.toThrow('cannot probe topology');
    expect(lastMockClient!.quit).toHaveBeenCalledTimes(1);
  });

  it('INFO server non-string response → fail-closed + client cleaned up', async () => {
    mockSendCommand = vi.fn().mockResolvedValue(42); // number, not string

    await expect(createRedisClient('redis://localhost')).rejects.toThrow('topology probe failed');
    expect(lastMockClient!.quit).toHaveBeenCalledTimes(1);
  });

  it('redis_mode field missing → fail-closed + client cleaned up', async () => {
    mockSendCommand = vi.fn().mockResolvedValue(NO_MODE_INFO);

    await expect(createRedisClient('redis://localhost')).rejects.toThrow(
      'did not contain redis_mode',
    );
    expect(lastMockClient!.quit).toHaveBeenCalledTimes(1);
  });

  it('sendCommand rejects → fail-closed + client cleaned up', async () => {
    mockSendCommand = vi.fn().mockRejectedValue(new Error('NOPERM'));

    await expect(createRedisClient('redis://localhost')).rejects.toThrow('topology probe failed');
    expect(lastMockClient!.quit).toHaveBeenCalledTimes(1);
  });
});
