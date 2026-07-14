/**
 * context.ts — getConfig singleflight test.
 *
 * Verifies that concurrent getConfig() calls share a single inflight RPC fetch
 * instead of issuing redundant sui.getObject() calls.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHostContext, SponsorPool } from '../src/context.js';
import type { HostContext } from '../src/context.js';
import { MemoryPrepareStore } from '../src/store/memoryPrepareStore.js';
import { MemoryPrepareRequestNonceStore } from '../src/store/prepareRequestNonceStore.js';
import { MemoryPrepareInflight } from '../src/store/memoryPrepareInflight.js';
import { MemoryRateLimiter } from '../src/store/memoryRateLimiter.js';
import { MemoryAbuseBlocker } from '../src/store/memoryAbuseBlocker.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const SPONSOR_KP = Ed25519Keypair.generate();
// Recipient must differ from sponsor (validateAddressConstraints)
const RECIPIENT_ADDR = '0x' + 'ff'.repeat(32);
// 32+ char HMAC secret for sponsor lease proofs.
const TEST_HMAC_SECRET = 'context-test-hmac-secret-000000000000';

function makeSponsorPool() {
  return new SponsorPool([SPONSOR_KP], { hmacSecret: TEST_HMAC_SECRET });
}

// Tests inject memory adapters explicitly; production wires Redis-backed
// adapters in `app-api`.
function makePrepareStore() {
  return new MemoryPrepareStore(() => Promise.resolve());
}
function makePrepareRequestNonceStore() {
  return new MemoryPrepareRequestNonceStore();
}
function makeInflightLimiter() {
  return new MemoryPrepareInflight(2);
}
function makeRateLimiter() {
  return new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 20 });
}
function makeAbuseBlocker() {
  return new MemoryAbuseBlocker();
}

describe('getConfig singleflight', () => {
  let ctx: HostContext;

  afterEach(() => {
    ctx?.dispose();
  });

  it('concurrent getConfig() calls issue only one RPC fetch', async () => {
    // Slow mock: resolves after 50ms to simulate real RPC latency
    const getObjectFn = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                object: {
                  json: {
                    max_host_fee_mist: '100000',
                    protocol_flat_fee_mist: '50000',
                    max_claim_mist: '50000000',
                    min_settle_mist: '1000',
                    config_version: '1',
                    max_spread_bps: '500',
                  },
                },
              }),
            50,
          ),
        ),
    );

    ctx = createHostContext({
      network: 'testnet',
      suiRpcUrl: 'http://mock.local',
      sponsorPool: makeSponsorPool(),
      prepareStore: makePrepareStore(),
      prepareRequestNonceStore: makePrepareRequestNonceStore(),
      prepareInflightLimiter: makeInflightLimiter(),
      rateLimiter: makeRateLimiter(),
      abuseBlocker: makeAbuseBlocker(),
      packageId: '0x' + '01'.repeat(32),
      deepbookPackageId: '0x' + '04'.repeat(32),
      configId: '0x' + '02'.repeat(32),
      vaultRegistryId: '0x' + '03'.repeat(32),
      settlementPayoutRecipientAddress: RECIPIENT_ADDR,
      configCacheTtlMs: 0, // disable cache so every call goes through singleflight
    });

    // Override the SUI client's getObject with our slow mock
    (ctx.sui as unknown as Record<string, unknown>).getObject = getObjectFn;

    // Fire 3 concurrent getConfig calls
    const [r1, r2, r3] = await Promise.all([ctx.getConfig(), ctx.getConfig(), ctx.getConfig()]);

    // All should return the same config
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
    expect(r1.maxClaimMist).toBe(50_000_000n);

    // Only 1 RPC call should have been made (singleflight)
    expect(getObjectFn).toHaveBeenCalledTimes(1);
  });

  it('subsequent getConfig() after singleflight completes can fetch again', async () => {
    let callCount = 0;
    const getObjectFn = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        object: {
          json: {
            max_host_fee_mist: '100000',
            protocol_flat_fee_mist: '50000',
            max_claim_mist: '50000000',
            min_settle_mist: '1000',
            config_version: String(callCount),
            max_spread_bps: '500',
          },
        },
      });
    });

    ctx = createHostContext({
      network: 'testnet',
      suiRpcUrl: 'http://mock.local',
      sponsorPool: makeSponsorPool(),
      prepareStore: makePrepareStore(),
      prepareRequestNonceStore: makePrepareRequestNonceStore(),
      prepareInflightLimiter: makeInflightLimiter(),
      rateLimiter: makeRateLimiter(),
      abuseBlocker: makeAbuseBlocker(),
      packageId: '0x' + '01'.repeat(32),
      deepbookPackageId: '0x' + '04'.repeat(32),
      configId: '0x' + '02'.repeat(32),
      vaultRegistryId: '0x' + '03'.repeat(32),
      settlementPayoutRecipientAddress: RECIPIENT_ADDR,
      configCacheTtlMs: 0,
    });

    (ctx.sui as unknown as Record<string, unknown>).getObject = getObjectFn;

    // First call: fetches
    const first = await ctx.getConfig();
    expect(first.configVersion).toBe(1n);
    expect(getObjectFn).toHaveBeenCalledTimes(1);

    // Second call: cache 0ms TTL → re-fetches (not singleflight reuse since first completed)
    const second = await ctx.getConfig();
    expect(second.configVersion).toBe(2n);
    expect(getObjectFn).toHaveBeenCalledTimes(2);
  });
});

describe('suiClient injection', () => {
  let ctx: HostContext;

  afterEach(() => {
    ctx?.dispose();
  });

  it('uses injected suiClient instead of constructing from suiRpcUrl', async () => {
    const injectedGetObject = vi.fn().mockResolvedValue({
      object: {
        json: {
          max_host_fee_mist: '200000',
          protocol_flat_fee_mist: '10000',
          max_claim_mist: '50000000',
          min_settle_mist: '1000',
          config_version: '42',
          max_spread_bps: '500',
        },
      },
    });

    // Create a mock SuiGrpcClient-like object to inject
    const mockSuiClient = {
      getObject: injectedGetObject,
    } as unknown as import('@mysten/sui/grpc').SuiGrpcClient;

    ctx = createHostContext({
      network: 'testnet',
      suiRpcUrl: 'http://should-not-be-used.invalid',
      suiClient: mockSuiClient,
      sponsorPool: makeSponsorPool(),
      prepareStore: makePrepareStore(),
      prepareRequestNonceStore: makePrepareRequestNonceStore(),
      prepareInflightLimiter: makeInflightLimiter(),
      rateLimiter: makeRateLimiter(),
      abuseBlocker: makeAbuseBlocker(),
      packageId: '0x' + '01'.repeat(32),
      deepbookPackageId: '0x' + '04'.repeat(32),
      configId: '0x' + '02'.repeat(32),
      vaultRegistryId: '0x' + '03'.repeat(32),
      settlementPayoutRecipientAddress: RECIPIENT_ADDR,
      configCacheTtlMs: 0,
    });

    // ctx.sui should be the injected client, not one built from suiRpcUrl
    expect(ctx.sui).toBe(mockSuiClient);

    // getConfig should use the injected client
    const config = await ctx.getConfig();
    expect(config.configVersion).toBe(42n);
    expect(injectedGetObject).toHaveBeenCalled();
  });

  it('falls back to suiRpcUrl when suiClient is not provided', () => {
    ctx = createHostContext({
      network: 'testnet',
      suiRpcUrl: 'http://fallback.local',
      sponsorPool: makeSponsorPool(),
      prepareStore: makePrepareStore(),
      prepareRequestNonceStore: makePrepareRequestNonceStore(),
      prepareInflightLimiter: makeInflightLimiter(),
      rateLimiter: makeRateLimiter(),
      abuseBlocker: makeAbuseBlocker(),
      packageId: '0x' + '01'.repeat(32),
      deepbookPackageId: '0x' + '04'.repeat(32),
      configId: '0x' + '02'.repeat(32),
      vaultRegistryId: '0x' + '03'.repeat(32),
      settlementPayoutRecipientAddress: RECIPIENT_ADDR,
    });

    // ctx.sui should exist and be a real SuiGrpcClient (not undefined)
    expect(ctx.sui).toBeDefined();
    expect(typeof ctx.sui.getObject).toBe('function');
  });
});
