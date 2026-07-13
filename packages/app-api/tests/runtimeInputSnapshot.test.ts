/**
 * Runtime input snapshot wiring tests.
 *
 * `createContext` receives an already parsed, secret-bearing runtime input.
 * These tests verify that it forwards those exact values to the on-chain
 * registry resolver and Host context without consulting process env or a
 * registry file again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { ContextRuntimeInput } from '../src/context.js';

let capturedRegistryClient: unknown = null;
let capturedRegistryEntries: unknown = null;
let capturedHostConfig: Record<string, unknown> | null = null;
let capturedSpendCoordinatorDeps: Record<string, unknown> | null = null;
let capturedSpendStateOptions: Record<string, unknown> | null = null;
let nextRecoveryResult: unknown = null;
let runtimeEvents: string[] = [];

vi.mock('../src/settlementSwapPathRegistry.js', () => ({
  getSettlementSwapPathRegistryPath: vi.fn(() => {
    throw new Error('context must not resolve the registry file path');
  }),
  resolveSettlementSwapPathRegistry: vi.fn(function (
    client: unknown,
    _packageId: unknown,
    entries: unknown,
  ) {
    capturedRegistryClient = client;
    capturedRegistryEntries = entries;
    return Promise.resolve([]);
  }),
}));

vi.mock('@stelis/core-api', async () => {
  const actual = await vi.importActual('@stelis/core-api');
  return {
    ...actual,
    createHostContext: vi.fn().mockImplementation((config: Record<string, unknown>) => {
      capturedHostConfig = config;
      return {
        network: config.network,
        sui: config.suiClient,
        sponsorPool: config.sponsorPool,
        packageId: config.packageId,
        configId: config.configId,
        vaultRegistryId: config.vaultRegistryId,
        rateLimiter: config.rateLimiter,
        abuseBlocker: config.abuseBlocker,
        prepareStore: config.prepareStore,
        settlementPayoutRecipientAddress: config.settlementPayoutRecipientAddress,
        allowedSettlementSwapPaths: config.allowedSettlementSwapPaths ?? [],
        vaultsTableId: null,
        getConfig: vi.fn(),
        warmUp: vi.fn().mockResolvedValue(undefined),
        invalidateConfigCache: vi.fn(),
        dispose: vi.fn(),
      };
    }),
  };
});

vi.mock('../src/redisClient.js', () => ({
  createRedisClient: vi.fn().mockResolvedValue({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    hgetall: vi.fn().mockResolvedValue({}),
    eval: vi.fn().mockResolvedValue(['UPDATED']),
    dispose: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../src/sponsor-operations/accountSpendState.js', () => ({
  createSponsorRefillAccountSpendState: vi.fn(
    (_client: unknown, options: Record<string, unknown>) => {
      capturedSpendStateOptions = options;
      return {
        read: vi.fn().mockResolvedValue(null),
        readAccountObservationCursor: vi.fn().mockResolvedValue({
          operationId: null,
          spendSequence: 0,
          writeSequence: 0,
        }),
        updateAccountObservation: vi.fn().mockResolvedValue(true),
      };
    },
  ),
}));

vi.mock('../src/sponsor-operations/accountSpend.js', () => ({
  createSuiSponsorRefillAccountSpendBoundary: vi.fn(() => ({})),
  createSponsorRefillAccountSpendCoordinator: vi.fn((deps: Record<string, unknown>) => {
    capturedSpendCoordinatorDeps = deps;
    return {
      recoverActiveSpend: vi.fn(async () => {
        runtimeEvents.push('recover');
        return nextRecoveryResult;
      }),
      refill: vi.fn().mockResolvedValue({
        status: 'not_needed',
        slotAddress: '0xslot',
        balanceMist: '0',
      }),
      withdraw: vi.fn(),
    };
  }),
}));

vi.mock('@stelis/core-api/prepareConfig', () => ({
  createPrepareSettlementSwapPathDescriptorMap: vi.fn().mockReturnValue(new Map()),
  resolvePrepareConfig: vi.fn().mockReturnValue({
    supportedSettlementSwapPaths: [],
    deepbookPackageId: '0xDEEPBOOK',
    deepType: '0xDEEP',
    allowedSettlementSwapPaths: [],
    quotedHostFeeMist: 0n,
  }),
}));

import { createContext } from '../src/context.js';

const SPONSOR_ADDRESS = `0x${'aa'.repeat(32)}`;
const SPONSOR_REFILL_ACCOUNT_ADDRESS = `0x${'bb'.repeat(32)}`;
const PAYOUT_ADDRESS = `0x${'ff'.repeat(32)}`;

function keypair(address: string): Ed25519Keypair {
  return {
    toSuiAddress: () => address,
    signTransaction: vi.fn(),
  } as unknown as Ed25519Keypair;
}

function runtimeInput(options: { prepareInflightCapacity?: number } = {}): ContextRuntimeInput {
  const suiClient = {
    __testId: 'runtime-input-sui-client',
    getBalance: vi.fn(async () => {
      runtimeEvents.push('balance');
      return { balance: { balance: '10000000000' } };
    }),
  } as unknown as SuiGrpcClient;
  const registryEntries = Object.freeze([{ poolId: '0xboot-snapshot-pool' }]);

  return {
    redisUrl: 'redis://boot-snapshot',
    network: 'testnet',
    contractIds: {
      packageId: `0x${'01'.repeat(32)}`,
      configId: `0x${'02'.repeat(32)}`,
      vaultRegistryId: `0x${'03'.repeat(32)}`,
    },
    deepbookPackageId: `0x${'04'.repeat(32)}`,
    suiClient,
    primarySuiClient: suiClient,
    failoverTransport: {
      getAdminSnapshot: () => ({ endpoints: [], totalEndpoints: 0, healthyEndpoints: 0 }),
    } as unknown as ContextRuntimeInput['failoverTransport'],
    settlementSwapPathRegistryEntries: registryEntries,
    sponsorKeys: [keypair(SPONSOR_ADDRESS)],
    sponsorLeaseHmacSecret: 'runtime-input-test-hmac-secret-00000000',
    settlementPayoutRecipientAddress: PAYOUT_ADDRESS,
    quotedHostFeeMist: 0n,
    prepareInflightCapacity: options.prepareInflightCapacity ?? 2,
    sponsorOperations: {
      sponsorRefillAccountKey: keypair(SPONSOR_REFILL_ACCOUNT_ADDRESS),
      sponsorRefillAccountAddress: SPONSOR_REFILL_ACCOUNT_ADDRESS,
      refillEnabled: false,
      refillTargetMist: null,
      runwayTargetMist: 10_000_000_000n,
      warnMist: 5_000_000_000n,
      slotBalanceTimeoutMs: 5_000,
      sponsorRefillAccountBalanceTimeoutMs: 5_000,
      refillTimeoutMs: 30_000,
      confirmationTimeoutMs: 15_000,
      withdrawalReceiptTtlMs: 3_600_000,
    },
    studio: null,
  };
}

beforeEach(() => {
  capturedRegistryClient = null;
  capturedRegistryEntries = null;
  capturedHostConfig = null;
  capturedSpendCoordinatorDeps = null;
  capturedSpendStateOptions = null;
  nextRecoveryResult = null;
  runtimeEvents = [];
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createContext boot-snapshot wiring', () => {
  it('uses the same injected client and already-parsed registry entries for runtime assembly', async () => {
    const input = runtimeInput();

    vi.stubEnv('NETWORK', 'mainnet');
    vi.stubEnv('SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS', `0x${'ee'.repeat(32)}`);
    vi.stubEnv('SPONSOR_SECRET_KEY', 'different-after-boot');

    const context = await createContext(input);
    try {
      expect(capturedRegistryClient).toBe(input.suiClient);
      expect(capturedHostConfig?.suiClient).toBe(input.suiClient);
      expect(capturedRegistryClient).toBe(capturedHostConfig?.suiClient);
      expect(capturedRegistryEntries).toBe(input.settlementSwapPathRegistryEntries);
      expect(capturedHostConfig).toMatchObject({
        network: 'testnet',
        settlementPayoutRecipientAddress: PAYOUT_ADDRESS,
      });
      expect(capturedSpendCoordinatorDeps?.runwayTargetMist).toBe(10_000_000_000n);
      expect(capturedSpendCoordinatorDeps?.network).toBe('testnet');
      expect(capturedSpendStateOptions).toEqual({
        network: 'testnet',
        acceptedReceiptTtlMs: 3_600_000,
      });
      expect(runtimeEvents[0]).toBe('recover');
      expect(runtimeEvents).toContain('balance');
    } finally {
      await context.dispose();
    }
  });

  it('uses the injected prepare capacity after the corresponding env value changes', async () => {
    const input = runtimeInput({ prepareInflightCapacity: 7 });
    vi.stubEnv('PREPARE_INFLIGHT_CAPACITY', '99');

    const context = await createContext(input);
    try {
      const limiter = capturedHostConfig?.prepareInflightLimiter as {
        readonly capacity: number;
      };
      expect(limiter.capacity).toBe(7);
    } finally {
      await context.dispose();
    }
  });

  it('fails context creation before bootstrap when active-spend recovery remains pending', async () => {
    nextRecoveryResult = {
      status: 'pending',
      operationId: 'operation-pending',
      digest: 'digest-pending',
      amountMist: '1',
      error: 'chain lookup unavailable',
    };

    await expect(createContext(runtimeInput())).rejects.toThrow(
      'Sponsor Refill Account active spend recovery pending: chain lookup unavailable',
    );
    expect(runtimeEvents).toEqual(['recover']);
  });
});
