/**
 * Host context tests for boot-qualified Sui state and config refreshes.
 *
 * Context construction consumes an immutable endpoint snapshot plus the exact
 * Config/Vault state qualified by the Host at boot. Later Config refreshes use
 * the shared core-relay gateway and retain the existing singleflight contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiEndpointSnapshot } from '@stelis/core-relay';
import { createHostContext, SponsorPool, type HostContext } from '../src/context.js';
import type { HostChainState } from '../src/hostChainState.js';
import { MemoryPrepareStore } from '../src/store/memoryPrepareStore.js';
import { MemoryPrepareRequestNonceStore } from '../src/store/prepareRequestNonceStore.js';
import { MemoryPrepareInflight } from '../src/store/memoryPrepareInflight.js';
import { MemoryRateLimiter } from '../src/store/memoryRateLimiter.js';
import { MemoryAbuseBlocker } from '../src/store/memoryAbuseBlocker.js';
import { suiEndpointSnapshotFixture } from './helpers/suiGatewayResultFixtures.js';

const gateway = vi.hoisted(() => ({ getSuiObject: vi.fn() }));

vi.mock('@stelis/core-relay', async () => {
  const actual = await vi.importActual<typeof import('@stelis/core-relay')>('@stelis/core-relay');
  return { ...actual, getSuiObject: gateway.getSuiObject };
});

const SPONSOR_KP = Ed25519Keypair.generate();
const RECIPIENT_ADDRESS = `0x${'ff'.repeat(32)}`;
const PACKAGE_ID = `0x${'01'.repeat(32)}`;
const CONFIG_ID = `0x${'02'.repeat(32)}`;
const VAULT_REGISTRY_ID = `0x${'03'.repeat(32)}`;
const DEEPBOOK_PACKAGE_ID = `0x${'04'.repeat(32)}`;
const VAULTS_TABLE_ID = `0x${'05'.repeat(32)}`;
const TEST_HMAC_SECRET = 'context-test-hmac-secret-000000000000';

function makeSuiSnapshot(): SuiEndpointSnapshot {
  return suiEndpointSnapshotFixture();
}

function makeInitialChainState(configVersion = 0n): HostChainState {
  return Object.freeze({
    config: Object.freeze({
      packageId: PACKAGE_ID,
      configId: CONFIG_ID,
      maxClaimMist: 50_000_000n,
      minSettleMist: 1_000n,
      maxHostFeeMist: 100_000n,
      protocolFlatFeeMist: 50_000n,
      configVersion,
      maxSpreadBps: 500n,
    }),
    vaultRegistryId: VAULT_REGISTRY_ID,
    vaultsTableId: VAULTS_TABLE_ID,
  });
}

function configObject(configVersion: bigint) {
  return {
    type: `${PACKAGE_ID}::config::Config`,
    json: {
      id: CONFIG_ID,
      max_host_fee_mist: '100000',
      protocol_flat_fee_mist: '50000',
      max_claim_mist: '50000000',
      min_settle_mist: '1000',
      config_version: configVersion.toString(),
      max_spread_bps: '500',
    },
  };
}

function makeContext(
  options: {
    readonly sui?: SuiEndpointSnapshot;
    readonly initialChainState?: HostChainState;
    readonly configCacheTtlMs?: number;
  } = {},
): HostContext {
  return createHostContext({
    network: 'testnet',
    sui: options.sui ?? makeSuiSnapshot(),
    sponsorPool: new SponsorPool([SPONSOR_KP], { hmacSecret: TEST_HMAC_SECRET }),
    prepareStore: new MemoryPrepareStore(() => Promise.resolve()),
    prepareRequestNonceStore: new MemoryPrepareRequestNonceStore(),
    prepareInflightLimiter: new MemoryPrepareInflight(2),
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 20 }),
    abuseBlocker: new MemoryAbuseBlocker(),
    packageId: PACKAGE_ID,
    deepbookPackageId: DEEPBOOK_PACKAGE_ID,
    configId: CONFIG_ID,
    vaultRegistryId: VAULT_REGISTRY_ID,
    settlementPayoutRecipientAddress: RECIPIENT_ADDRESS,
    initialChainState: options.initialChainState ?? makeInitialChainState(),
    configCacheTtlMs: options.configCacheTtlMs,
  });
}

describe('getConfig singleflight', () => {
  let context: HostContext | undefined;

  afterEach(() => {
    context?.dispose();
    gateway.getSuiObject.mockReset();
  });

  it('shares one core-relay Config refresh across concurrent callers', async () => {
    gateway.getSuiObject.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(configObject(1n)), 50);
        }),
    );
    const sui = makeSuiSnapshot();
    context = makeContext({ sui, configCacheTtlMs: 0 });

    const [first, second, third] = await Promise.all([
      context.getConfig(),
      context.getConfig(),
      context.getConfig(),
    ]);

    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(first.maxClaimMist).toBe(50_000_000n);
    expect(gateway.getSuiObject).toHaveBeenCalledTimes(1);
    expect(gateway.getSuiObject).toHaveBeenCalledWith(sui, { objectId: CONFIG_ID });
  });

  it('starts a new gateway refresh after the previous singleflight completes', async () => {
    let callCount = 0;
    gateway.getSuiObject.mockImplementation(() => {
      callCount += 1;
      return Promise.resolve(configObject(BigInt(callCount)));
    });
    context = makeContext({ configCacheTtlMs: 0 });

    await expect(context.getConfig()).resolves.toMatchObject({ configVersion: 1n });
    await expect(context.getConfig()).resolves.toMatchObject({ configVersion: 2n });
    expect(gateway.getSuiObject).toHaveBeenCalledTimes(2);
  });
});

describe('boot-qualified Host inputs', () => {
  let context: HostContext | undefined;

  afterEach(() => {
    context?.dispose();
    gateway.getSuiObject.mockReset();
  });

  it('retains the injected endpoint snapshot and initial Config/Vault state without re-reading', async () => {
    const sui = makeSuiSnapshot();
    const initialChainState = makeInitialChainState(42n);
    context = makeContext({ sui, initialChainState, configCacheTtlMs: 60_000 });

    expect(context.sui).toBe(sui);
    expect(context.vaultsTableId).toBe(VAULTS_TABLE_ID);
    await expect(context.getConfig()).resolves.toBe(initialChainState.config);
    expect(gateway.getSuiObject).not.toHaveBeenCalled();
  });

  it('rejects a snapshot whose network differs from the Host network', () => {
    const mainnetSnapshot = suiEndpointSnapshotFixture('mainnet');

    expect(() => makeContext({ sui: mainnetSnapshot })).toThrow(
      'Sui endpoint snapshot network does not match Host network',
    );
  });
});
