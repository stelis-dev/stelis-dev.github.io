/**
 * Runtime input snapshot wiring tests.
 *
 * The App API context owner receives an already parsed, secret-bearing runtime input.
 * These tests verify that it forwards the exact boot-qualified chain/RPC
 * snapshots to the Host context without consulting process env, re-reading
 * chain readiness state, or resolving the registry again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { HostChainState } from '@stelis/core-api';
import type { SingleHopSettlementSwapPath } from '@stelis/contracts';
import type { ContextRuntimeInput } from '../src/context.js';
import { suiEndpointSnapshotFixture } from './suiEndpointSnapshotFixture.js';
import { createTestSponsorOperationsSettings } from './sponsor-operations/settingsFixture.js';

let capturedHostConfig: Record<string, unknown> | null = null;
let capturedPrepareConfigInput: Record<string, unknown> | null = null;
let capturedSpendBoundaryInput: Record<string, unknown> | null = null;
let capturedSpendCoordinatorDeps: Record<string, unknown> | null = null;
let capturedSpendStateOptions: Record<string, unknown> | null = null;
let runtimeEvents: string[] = [];

const mocks = vi.hoisted(() => ({
  getSettlementSwapPathRegistryPath: vi.fn(),
  resolveSettlementSwapPathRegistry: vi.fn(),
  getSuiBalance: vi.fn(),
  createRedisClient: vi.fn(),
  redisDispose: vi.fn(),
  recoveryStart: vi.fn(),
  recoveryDispose: vi.fn(),
  hostDispose: vi.fn(),
  createTaskScheduler: vi.fn(),
  schedulerStart: vi.fn(),
  schedulerDispose: vi.fn(),
  schedulerObserveBalances: vi.fn(),
  schedulerObserveSponsorResult: vi.fn(),
  schedulerWithdraw: vi.fn(),
  schedulerRequestObservedSlotRefill: vi.fn(),
  schedulerRequestEligibleRefills: vi.fn(),
}));

vi.mock('../src/settlementSwapPathRegistry.js', () => ({
  getSettlementSwapPathRegistryPath: mocks.getSettlementSwapPathRegistryPath,
  resolveSettlementSwapPathRegistry: mocks.resolveSettlementSwapPathRegistry,
}));

vi.mock('@stelis/core-relay', async () => {
  const actual = await vi.importActual<typeof import('@stelis/core-relay')>('@stelis/core-relay');
  return {
    ...actual,
    getSuiBalance: mocks.getSuiBalance,
  };
});

vi.mock('@stelis/core-api', async () => {
  const actual = await vi.importActual('@stelis/core-api');
  return {
    ...actual,
    RedisSponsoredExecutionStore: class {},
    SponsoredExecutionRecovery: class {
      readonly start = mocks.recoveryStart;
      readonly dispose = mocks.recoveryDispose;
    },
    createHostContext: vi.fn().mockImplementation((config: Record<string, unknown>) => {
      capturedHostConfig = config;
      const initialChainState = config.initialChainState as HostChainState;
      return {
        network: config.network,
        sui: config.sui,
        sponsorPool: config.sponsorPool,
        packageId: config.packageId,
        configId: config.configId,
        vaultRegistryId: config.vaultRegistryId,
        deepbookPackageId: config.deepbookPackageId,
        rateLimiter: config.rateLimiter,
        abuseBlocker: config.abuseBlocker,
        sponsoredExecutionStore: config.sponsoredExecutionStore,
        settlementPayoutRecipientAddress: config.settlementPayoutRecipientAddress,
        allowedSettlementSwapPaths: config.allowedSettlementSwapPaths ?? [],
        vaultsTableId: initialChainState.vaultsTableId,
        getConfig: vi.fn().mockResolvedValue(initialChainState.config),
        invalidateConfigCache: vi.fn(),
        dispose: mocks.hostDispose,
      };
    }),
  };
});

vi.mock('../src/redisClient.js', () => ({
  createRedisClient: mocks.createRedisClient,
}));

function redisClientFixture() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    hgetall: vi.fn().mockResolvedValue({}),
    eval: vi
      .fn()
      .mockImplementation(async (script: string) =>
        script.includes("local slot = redis.call('HGETALL', KEYS[1])")
          ? [
              [
                'addressBalanceMist',
                '10000000000',
                'lastError',
                '',
                'lastObservedAtMs',
                '1700000000000',
                'writeSeq',
                '1',
              ],
              [],
              '1700000000000',
            ]
          : script.includes('local slotRows = {}')
            ? [
                [
                  [
                    SPONSOR_ADDRESS,
                    [
                      'addressBalanceMist',
                      '10000000000',
                      'lastError',
                      '',
                      'lastObservedAtMs',
                      '1700000000000',
                      'writeSeq',
                      '1',
                    ],
                  ],
                ],
                [
                  'totalBalanceMist',
                  '10000000000',
                  'lastError',
                  '',
                  'lastObservedAtMs',
                  '1700000000000',
                  'writeSeq',
                  '1',
                ],
                [],
                '1700000000000',
              ]
            : ['UPDATED'],
      ),
    dispose: mocks.redisDispose,
  };
}

vi.mock('../src/sponsor-operations/accountSpendState.js', () => ({
  createSponsorRefillAccountSpendState: vi.fn(
    (_client: unknown, options: Record<string, unknown>) => {
      capturedSpendStateOptions = options;
      return {
        read: vi.fn().mockResolvedValue(null),
        readAccountObservationCursor: vi.fn().mockResolvedValue({
          operationId: null,
          spendState: null,
          spendSequence: 0,
          writeSequence: 0,
        }),
        updateAccountObservation: vi.fn().mockResolvedValue(true),
      };
    },
  ),
}));

vi.mock('../src/sponsor-operations/accountSpend.js', async () => {
  const actual = await vi.importActual('../src/sponsor-operations/accountSpend.js');
  return {
    ...actual,
    createSuiSponsorRefillAccountSpendBoundary: vi.fn((input: Record<string, unknown>) => {
      capturedSpendBoundaryInput = input;
      return {};
    }),
    createSponsorRefillAccountSpendCoordinator: vi.fn((deps: Record<string, unknown>) => {
      capturedSpendCoordinatorDeps = deps;
      return {
        recoverActiveSpend: vi.fn(async () => {
          runtimeEvents.push('recover');
          return null;
        }),
        refill: vi.fn().mockResolvedValue({
          status: 'not_needed',
          slotAddress: SPONSOR_ADDRESS,
          addressBalanceMist: '0',
        }),
        withdraw: vi.fn(),
      };
    }),
  };
});

vi.mock('@stelis/core-api/prepareConfig', () => ({
  resolvePrepareConfig: vi.fn().mockImplementation((input: Record<string, unknown>) => {
    capturedPrepareConfigInput = input;
    return {
      supportedSettlementSwapPaths: [],
      deepbookPackageId: '0xDEEPBOOK',
      deepType: '0xDEEP',
      allowedSettlementSwapPaths: [],
      quotedHostFeeMist: 0n,
    };
  }),
}));

vi.mock('../src/sponsor-operations/reconciliationScheduler.js', () => ({
  createSponsorOperationsTaskScheduler: mocks.createTaskScheduler,
}));

import { createAppApiContextOwner } from '../src/context.js';

const SPONSOR_ADDRESS = `0x${'aa'.repeat(32)}`;
const SPONSOR_REFILL_ACCOUNT_ADDRESS = `0x${'bb'.repeat(32)}`;
const PAYOUT_ADDRESS = `0x${'ff'.repeat(32)}`;
const PACKAGE_ID = `0x${'01'.repeat(32)}`;
const CONFIG_ID = `0x${'02'.repeat(32)}`;
const VAULT_REGISTRY_ID = `0x${'03'.repeat(32)}`;
const SETTLEMENT_SWAP_PATH: SingleHopSettlementSwapPath = {
  hops: [
    {
      poolId: `0x${'05'.repeat(32)}`,
      baseType: `0x${'06'.repeat(32)}::coin::COIN`,
      quoteType: '0x2::sui::SUI',
      swapDirection: 'baseForQuote',
      feeBps: 0,
    },
  ],
  settlementTokenType: `0x${'06'.repeat(32)}::coin::COIN`,
  settlementTokenSymbol: 'COIN',
  settlementTokenDecimals: 9,
  lotSize: 1n,
  minSize: 1n,
  effectiveFeeRateBps: 0,
  settlementSwapDirection: 'baseForQuote',
};

function keypair(address: string): Ed25519Keypair {
  return {
    toSuiAddress: () => address,
    signTransaction: vi.fn(),
  } as unknown as Ed25519Keypair;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function runtimeInput(
  options: {
    prepareInflightCapacity?: number;
    mode?: 'relay_only' | 'relay_and_studio';
  } = {},
): ContextRuntimeInput {
  const sui = suiEndpointSnapshotFixture();
  const initialHostChainState: HostChainState = Object.freeze({
    config: Object.freeze({
      packageId: PACKAGE_ID,
      configId: CONFIG_ID,
      maxClaimMist: 1n,
      minSettleMist: 2n,
      maxHostFeeMist: 3n,
      protocolFlatFeeMist: 4n,
      configVersion: 5n,
      maxSpreadBps: 6n,
    }),
    vaultRegistryId: VAULT_REGISTRY_ID,
    vaultsTableId: `0x${'07'.repeat(32)}`,
  });

  const base = {
    redisUrl: 'redis://boot-snapshot',
    network: 'testnet' as const,
    contractIds: {
      packageId: PACKAGE_ID,
      configId: CONFIG_ID,
      vaultRegistryId: VAULT_REGISTRY_ID,
    },
    deepbookPackageId: `0x${'04'.repeat(32)}`,
    sui,
    initialHostChainState,
    settlementSwapPaths: Object.freeze([SETTLEMENT_SWAP_PATH]),
    sponsorKeys: [keypair(SPONSOR_ADDRESS)],
    sponsorLeaseHmacSecret: 'runtime-input-test-hmac-secret-00000000',
    settlementPayoutRecipientAddress: PAYOUT_ADDRESS,
    quotedHostFeeMist: 0n,
    prepareInflightCapacity: options.prepareInflightCapacity ?? 2,
    sponsorOperations: {
      sponsorRefillAccountKey: keypair(SPONSOR_REFILL_ACCOUNT_ADDRESS),
      settings: createTestSponsorOperationsSettings({
        sponsorAddresses: [SPONSOR_ADDRESS],
        sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
        settlementPayoutRecipientAddress: PAYOUT_ADDRESS,
        refillEnabled: false,
        refillTargetMist: null,
        runwayTargetMist: 10_000_000_000n,
        warnMist: 5_000_000_000n,
        slotBalanceTimeoutMs: 5_000,
        sponsorRefillAccountBalanceTimeoutMs: 5_000,
        refillTimeoutMs: 30_000,
        confirmationTimeoutMs: 15_000,
        reconciliationIntervalMs: 15_000,
        withdrawalReceiptTtlMs: 3_600_000,
      }),
    },
  };

  if (options.mode === 'relay_and_studio') {
    return {
      ...base,
      mode: 'relay_and_studio',
      rpcFleet: Object.freeze({
        endpoints: Object.freeze([
          Object.freeze({ origin: 'https://rpc.snapshot.test', role: 'primary' as const }),
        ]),
      }),
      studio: {
        globalAllowedTargets: new Set([`${PACKAGE_ID}::promotion::claim`]),
        developerJwtTrustConfig: {
          issuer: 'https://auth.runtime-input.test',
          audience: 'stelis-studio',
          algorithm: 'RS256',
          publicKeyPem: 'test-only-key-not-parsed-by-context-owner',
          claimPaths: { userId: 'sub', senderAddress: 'wallet_address' },
        },
        developerJwtVerifyUrl: 'https://auth.runtime-input.test/verify',
      },
    };
  }

  return { ...base, mode: 'relay_only' };
}

beforeEach(() => {
  capturedHostConfig = null;
  capturedPrepareConfigInput = null;
  capturedSpendBoundaryInput = null;
  capturedSpendCoordinatorDeps = null;
  capturedSpendStateOptions = null;
  runtimeEvents = [];
  vi.clearAllMocks();
  mocks.createRedisClient.mockResolvedValue(redisClientFixture());
  mocks.recoveryStart.mockResolvedValue(undefined);
  mocks.recoveryDispose.mockResolvedValue(undefined);
  mocks.hostDispose.mockResolvedValue(undefined);
  mocks.redisDispose.mockResolvedValue(undefined);
  mocks.createTaskScheduler.mockReturnValue({
    start: mocks.schedulerStart,
    dispose: mocks.schedulerDispose,
    observeBalances: mocks.schedulerObserveBalances,
    observeSponsorResult: mocks.schedulerObserveSponsorResult,
    withdraw: mocks.schedulerWithdraw,
    requestObservedSlotRefill: mocks.schedulerRequestObservedSlotRefill,
    requestEligibleRefills: mocks.schedulerRequestEligibleRefills,
  });
  mocks.schedulerStart.mockImplementation(async () => {
    runtimeEvents.push('recover');
    runtimeEvents.push('balance');
  });
  mocks.schedulerDispose.mockResolvedValue(undefined);
  mocks.schedulerObserveBalances.mockResolvedValue(undefined);
  mocks.schedulerObserveSponsorResult.mockResolvedValue(undefined);
  mocks.schedulerWithdraw.mockResolvedValue(undefined);
  mocks.schedulerRequestEligibleRefills.mockResolvedValue(undefined);
  mocks.getSettlementSwapPathRegistryPath.mockImplementation(() => {
    throw new Error('context must not resolve the registry file path');
  });
  mocks.resolveSettlementSwapPathRegistry.mockImplementation(() => {
    throw new Error('context must not resolve settlement swap paths');
  });
  mocks.getSuiBalance.mockImplementation(async () => {
    runtimeEvents.push('balance');
    return { balance: '10000000000', addressBalance: '10000000000' };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('App API context owner boot-snapshot wiring', () => {
  it('uses the exact boot-qualified snapshots without repeating readiness work', async () => {
    const input = runtimeInput();

    vi.stubEnv('NETWORK', 'mainnet');
    vi.stubEnv('SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS', `0x${'ee'.repeat(32)}`);
    vi.stubEnv('SPONSOR_SECRET_KEY', 'different-after-boot');

    const runtime = createAppApiContextOwner(input);
    const context = await runtime.start();
    try {
      expect(capturedHostConfig?.sui).toBe(input.sui);
      expect(capturedHostConfig?.initialChainState).toBe(input.initialHostChainState);
      expect(capturedPrepareConfigInput?.settlementSwapPaths).toEqual(input.settlementSwapPaths);
      expect(capturedSpendBoundaryInput?.sui).toBe(input.sui);
      expect(context.mode).toBe('relay_only');
      expect(Object.keys(context.sponsorAvailability)).toEqual(['readState']);
      for (const studioOrAdminField of [
        'studio',
        'rpcFleet',
        'redis',
        'abuseStore',
        'sponsoredLogsStore',
        'promotionStore',
        'executionLedger',
        'studioGlobalAllowedTargets',
        'developerJwtTrustConfig',
        'developerJwtVerifyUrl',
      ]) {
        expect(Object.hasOwn(context, studioOrAdminField)).toBe(false);
      }
      expect(mocks.getSettlementSwapPathRegistryPath).not.toHaveBeenCalled();
      expect(mocks.resolveSettlementSwapPathRegistry).not.toHaveBeenCalled();
      for (const [snapshot] of mocks.getSuiBalance.mock.calls) {
        expect(snapshot).toBe(input.sui);
      }
      expect(capturedHostConfig).toMatchObject({
        network: 'testnet',
        settlementPayoutRecipientAddress: PAYOUT_ADDRESS,
      });
      expect(capturedSpendCoordinatorDeps?.settings).toBe(input.sponsorOperations.settings);
      expect(capturedSpendStateOptions?.settings).toBe(input.sponsorOperations.settings);
      expect(runtimeEvents[0]).toBe('recover');
      expect(runtimeEvents).toContain('balance');
    } finally {
      await runtime.stop();
    }
  });

  it('uses the injected prepare capacity after the corresponding env value changes', async () => {
    const input = runtimeInput({ prepareInflightCapacity: 7 });
    vi.stubEnv('PREPARE_INFLIGHT_CAPACITY', '99');

    const runtime = createAppApiContextOwner(input);
    await runtime.start();
    try {
      const limiter = capturedHostConfig?.prepareInflightLimiter as {
        readonly capacity: number;
      };
      expect(limiter.capacity).toBe(7);
    } finally {
      await runtime.stop();
    }
  });

  it('creates Studio resources only from a complete `relay_and_studio` input', async () => {
    const input = runtimeInput({ mode: 'relay_and_studio' });
    if (input.mode !== 'relay_and_studio') {
      throw new Error('Expected relay_and_studio runtime input');
    }
    const runtime = createAppApiContextOwner(input);
    const context = await runtime.start();

    try {
      if (context.mode !== 'relay_and_studio') {
        throw new Error('Expected relay_and_studio context');
      }
      expect(Object.hasOwn(context, 'studio')).toBe(false);
      expect(context.rpcFleet).toBe(input.rpcFleet);
      expect(context.promotionStore).not.toBeNull();
      expect(context.executionLedger).not.toBeNull();
      expect(context.studioGlobalAllowedTargets).toBe(input.studio.globalAllowedTargets);
      expect(context.developerJwtTrustConfig).toBe(input.studio.developerJwtTrustConfig);
      expect(context.developerJwtVerifyUrl).toBe(input.studio.developerJwtVerifyUrl);
    } finally {
      await runtime.stop();
    }
  });

  it('uses the same ordered owner when stop aborts the immediate recovery pass', async () => {
    const trace: string[] = [];
    const recoveryStartGate = deferred();
    const sponsorStopGate = deferred();
    const domainStopGate = deferred();
    const hostStopGate = deferred();
    mocks.recoveryStart.mockImplementationOnce(async () => {
      trace.push('recovery.start');
      await recoveryStartGate.promise;
    });
    mocks.schedulerDispose.mockImplementationOnce(async () => {
      trace.push('sponsor.stop.start');
      await sponsorStopGate.promise;
      trace.push('sponsor.stop.end');
    });
    mocks.recoveryDispose.mockImplementationOnce(async () => {
      trace.push('domain.stop.start');
      recoveryStartGate.resolve();
      await domainStopGate.promise;
      trace.push('domain.stop.end');
    });
    mocks.hostDispose.mockImplementationOnce(async () => {
      trace.push('host.stop.start');
      await hostStopGate.promise;
      trace.push('host.stop.end');
    });
    mocks.redisDispose.mockImplementationOnce(async () => {
      trace.push('redis.stop');
    });

    const owner = createAppApiContextOwner(runtimeInput());
    const startTask = owner.start();
    await vi.waitFor(() => expect(trace).toEqual(['recovery.start']));
    const stopTask = owner.stop();
    await vi.waitFor(() => expect(trace).toEqual(['recovery.start', 'sponsor.stop.start']));

    sponsorStopGate.resolve();
    await vi.waitFor(() => expect(trace).toContain('domain.stop.start'));
    expect(trace).not.toContain('host.stop.start');
    domainStopGate.resolve();
    await vi.waitFor(() => expect(trace).toContain('host.stop.start'));
    expect(trace).not.toContain('redis.stop');
    hostStopGate.resolve();

    await expect(stopTask).resolves.toBeUndefined();
    await expect(startTask).rejects.toMatchObject({ name: 'AbortError' });
    expect(trace).toEqual([
      'recovery.start',
      'sponsor.stop.start',
      'sponsor.stop.end',
      'domain.stop.start',
      'domain.stop.end',
      'host.stop.start',
      'host.stop.end',
      'redis.stop',
    ]);
  });

  it('cannot acquire Redis after the context owner has stopped', async () => {
    mocks.createRedisClient.mockImplementationOnce(
      async (_redisUrl: string, signal?: AbortSignal) =>
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const owner = createAppApiContextOwner(runtimeInput());
    const startTask = owner.start();
    await vi.waitFor(() => expect(mocks.createRedisClient).toHaveBeenCalledOnce());

    await expect(owner.stop()).resolves.toBeUndefined();
    await expect(startTask).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.createTaskScheduler).not.toHaveBeenCalled();
    expect(mocks.redisDispose).not.toHaveBeenCalled();
  });

  it('retains only a failed cleanup handle for a later stop attempt', async () => {
    mocks.redisDispose
      .mockRejectedValueOnce(new Error('Redis disconnect failed'))
      .mockResolvedValueOnce(undefined);
    const owner = createAppApiContextOwner(runtimeInput());
    await owner.start();

    await expect(owner.stop()).rejects.toBeInstanceOf(AggregateError);
    expect(mocks.schedulerDispose).toHaveBeenCalledOnce();
    expect(mocks.recoveryDispose).toHaveBeenCalledOnce();
    expect(mocks.hostDispose).toHaveBeenCalledOnce();
    expect(mocks.redisDispose).toHaveBeenCalledOnce();

    await expect(owner.stop()).resolves.toBeUndefined();
    expect(mocks.schedulerDispose).toHaveBeenCalledOnce();
    expect(mocks.recoveryDispose).toHaveBeenCalledOnce();
    expect(mocks.hostDispose).toHaveBeenCalledOnce();
    expect(mocks.redisDispose).toHaveBeenCalledTimes(2);
  });
});
