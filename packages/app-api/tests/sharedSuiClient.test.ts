/**
 * Shared Sui client wiring tests.
 *
 * Tests validate:
 *   - Missing shared client → fail-fast error (negative path)
 *   - Injected client identity is preserved through the wiring chain:
 *     loadSettlementSwapPathRegistry() and createRelayerContext() receive the same instance (positive path)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks — must be declared before any imports that use them ────────────

// Track which client was passed to loadSettlementSwapPathRegistry and createRelayerContext
let capturedSettlementSwapPathRegistryClient: unknown = null;
let capturedRelayerContextClient: unknown = null;
let capturedPrepareInflightLimiter: unknown = null;

vi.mock('../src/settlementSwapPathRegistry.js', () => ({
  getSettlementSwapPathRegistryPath: vi.fn().mockReturnValue('/tmp/settlement-swap-paths.json'),
  loadSettlementSwapPathRegistry: vi
    .fn()
    .mockImplementation((client: unknown, _pkg: unknown, _jsonFilePath: unknown) => {
      capturedSettlementSwapPathRegistryClient = client;
      return Promise.resolve([]); // empty settlement swap path registry
    }),
}));

vi.mock('@stelis/core-api', async () => {
  const actual = await vi.importActual('@stelis/core-api');
  return {
    ...actual,
    createRelayerContext: vi.fn().mockImplementation((config: Record<string, unknown>) => {
      capturedRelayerContextClient = config.suiClient;
      capturedPrepareInflightLimiter = config.prepareInflightLimiter;
      // Return a minimal mock RelayerContext
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
        prepareInflightLimiter: {
          tryAcquire: vi.fn().mockResolvedValue(null),
          inflight: 0,
          capacity: 10,
        },
      };
    }),
    parseSponsorKey: vi.fn().mockReturnValue({
      toSuiAddress: () => '0x' + 'bb'.repeat(32),
      getSecretKey: () => 'suiprivkey1sponsorrefillaccount',
      signTransaction: vi.fn(),
    }),
    parseSponsorKeys: vi.fn().mockReturnValue([
      {
        toSuiAddress: () => '0x' + 'aa'.repeat(32),
        getSecretKey: () => 'suiprivkey1mock',
      },
    ]),
    STELIS_CONTRACT_IDS: {
      testnet: {
        packageId: '0x' + '01'.repeat(32),
        configId: '0x' + '02'.repeat(32),
        vaultRegistryId: '0x' + '03'.repeat(32),
      },
    },
    DEEPBOOK_IDS: {
      testnet: { packageId: '0x' + '04'.repeat(32), deepType: '0xDEEP' },
    },
  };
});

vi.mock('../src/redisClient.js', () => ({
  createRedisClient: vi.fn().mockResolvedValue({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    hgetall: vi.fn().mockResolvedValue({}),
    eval: vi.fn().mockResolvedValue(null),
    dispose: vi.fn().mockResolvedValue(undefined),
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
  parseHostFeeEnv: vi.fn().mockReturnValue(0n),
}));

// ── Test setup ──────────────────────────────────────────────────────────

let setSharedSuiClient: typeof import('../src/context.js').setSharedSuiClient;
let getCtx: typeof import('../src/context.js').getCtx;

beforeEach(async () => {
  capturedSettlementSwapPathRegistryClient = null;
  capturedRelayerContextClient = null;
  capturedPrepareInflightLimiter = null;

  // Set required env vars for initContext
  process.env.REDIS_URL = 'redis://mock';
  process.env.NETWORK = 'testnet';
  process.env.SPONSOR_SECRET_KEY = 'suiprivkey1mock';
  process.env.SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS = '0x' + 'ff'.repeat(32);
  process.env.SPONSOR_REFILL_ACCOUNT_SECRET_KEY = 'suiprivkey1sponsorrefillaccount';
  // Sponsor pool construction requires an HMAC secret (≥32 chars).
  // Boot validation normally enforces this, but the unit test exercises
  // `initContext` directly and must
  // provide a matching env value to reach the positive-path assertions.
  process.env.SPONSOR_LEASE_HMAC_SECRET = 'shared-sui-client-test-hmac-secret-00000';
  // Strict-injection: the four SPONSOR_OPERATIONS_*_MS budgets have no code-side
  // default. `initContext` throws synchronously if any is missing or not a
  // positive integer. Values below are synthetic — this test exercises
  // wiring, not sponsor operations timing behavior.
  process.env.SPONSOR_OPERATIONS_SLOT_BALANCE_TIMEOUT_MS = '5000';
  process.env.SPONSOR_OPERATIONS_SPONSOR_REFILL_ACCOUNT_BALANCE_TIMEOUT_MS = '5000';
  process.env.SPONSOR_OPERATIONS_REFILL_TIMEOUT_MS = '30000';
  process.env.SPONSOR_OPERATIONS_CONFIRMATION_TIMEOUT_MS = '15000';
  // Ensure studio env is NOT set (avoid dual-mode init)
  delete process.env.PREPARE_INFLIGHT_CAPACITY;
  delete process.env.STUDIO_DEVELOPER_JWT_TRUST_JSON;
  delete process.env.STUDIO_ALLOWED_TARGETS;
  delete process.env.ADMIN_JWT_SECRET;
  delete process.env.ADMIN_ADDRESS;

  vi.resetModules();
  const mod = await import('../src/context.js');
  setSharedSuiClient = mod.setSharedSuiClient;
  getCtx = mod.getCtx;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('setSharedSuiClient wiring', () => {
  it('getCtx() fails fast when shared client is not set', async () => {
    await expect(getCtx()).rejects.toThrow('Shared Sui client not set');
  });

  it('injected client is used by both loadSettlementSwapPathRegistry and createRelayerContext', async () => {
    // Create a distinguishable mock client
    const mockSuiClient = {
      __testId: 'shared-client-identity',
    } as unknown as import('@mysten/sui/grpc').SuiGrpcClient;
    const mockTransport = {
      getAdminSnapshot: () => ({ endpoints: [], totalEndpoints: 0, healthyEndpoints: 0 }),
    } as unknown as import('../src/sui/failoverTransport.js').SuiRpcFailoverTransport;

    setSharedSuiClient(mockSuiClient, mockTransport, ['https://mock.test']);

    await getCtx();

    // loadSettlementSwapPathRegistry received the injected client
    expect(capturedSettlementSwapPathRegistryClient).toBe(mockSuiClient);
    // createRelayerContext received the same injected client
    expect(capturedRelayerContextClient).toBe(mockSuiClient);
    // Both received the exact same instance (identity, not equality)
    expect(capturedSettlementSwapPathRegistryClient).toBe(capturedRelayerContextClient);

    // WS2: prepareInflightLimiter must be explicitly injected as RedisPrepareInflight
    // (not the MemoryPrepareInflight default from createRelayerContext)
    expect(capturedPrepareInflightLimiter).toBeDefined();
    expect(capturedPrepareInflightLimiter).not.toBeNull();
    // Verify it's the Redis adapter by checking the constructor name.
    // The real RedisPrepareInflight class is preserved via vi.importActual.
    const limiter = capturedPrepareInflightLimiter as { constructor: { name: string } };
    expect(limiter.constructor.name).toBe('RedisPrepareInflight');
  });

  it('uses sponsor slot count times two as the default prepare in-flight capacity', async () => {
    const mockSuiClient = {
      __testId: 'default-prepare-inflight-capacity',
    } as unknown as import('@mysten/sui/grpc').SuiGrpcClient;
    const mockTransport = {
      getAdminSnapshot: () => ({ endpoints: [], totalEndpoints: 0, healthyEndpoints: 0 }),
    } as unknown as import('../src/sui/failoverTransport.js').SuiRpcFailoverTransport;

    setSharedSuiClient(mockSuiClient, mockTransport, ['https://mock.test']);

    await getCtx();

    const limiter = capturedPrepareInflightLimiter as { capacity: number };
    expect(limiter.capacity).toBe(2);
  });

  it('uses PREPARE_INFLIGHT_CAPACITY when configured', async () => {
    process.env.PREPARE_INFLIGHT_CAPACITY = '7';
    const mockSuiClient = {
      __testId: 'configured-prepare-inflight-capacity',
    } as unknown as import('@mysten/sui/grpc').SuiGrpcClient;
    const mockTransport = {
      getAdminSnapshot: () => ({ endpoints: [], totalEndpoints: 0, healthyEndpoints: 0 }),
    } as unknown as import('../src/sui/failoverTransport.js').SuiRpcFailoverTransport;

    setSharedSuiClient(mockSuiClient, mockTransport, ['https://mock.test']);

    await getCtx();

    const limiter = capturedPrepareInflightLimiter as { capacity: number };
    expect(limiter.capacity).toBe(7);
  });
});
