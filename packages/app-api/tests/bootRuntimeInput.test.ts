import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { DEEPBOOK_IDS, NODE_TIMER_MAX_DELAY_MS, STELIS_CONTRACT_IDS } from '@stelis/contracts';
import type { SingleHopSettlementSwapPath } from '@stelis/contracts';
import type { HostChainState } from '@stelis/core-api';
import { createSuiEndpointSnapshot } from '@stelis/core-relay';
import type { QualifySuiRpcEndpointsOptions } from '../src/sui/qualifiedSuiRpc.js';

const state = vi.hoisted(() => ({
  registryPath: '',
  rpcAuthValue: null as string | null,
  qualificationSignal: null as AbortSignal | null,
  loadRpcConfig: vi.fn(),
  qualifySuiRpcEndpoints: vi.fn(),
  readHostChainState: vi.fn(),
  resolveSettlementSwapPathRegistry: vi.fn(),
}));

vi.mock('@stelis/core-api', async () => {
  const actual = await vi.importActual<typeof import('@stelis/core-api')>('@stelis/core-api');
  return {
    ...actual,
    readHostChainState: state.readHostChainState,
  };
});

vi.mock('../src/settlementSwapPathRegistry.js', async () => {
  const actual = await vi.importActual<typeof import('../src/settlementSwapPathRegistry.js')>(
    '../src/settlementSwapPathRegistry.js',
  );
  return {
    ...actual,
    getSettlementSwapPathRegistryPath: () => state.registryPath,
    resolveSettlementSwapPathRegistry: state.resolveSettlementSwapPathRegistry,
  };
});

vi.mock('../src/sui/parseEndpointConfig.js', () => ({
  loadRpcConfig: state.loadRpcConfig,
}));

vi.mock('../src/sui/qualifiedSuiRpc.js', () => ({
  qualifySuiRpcEndpoints: state.qualifySuiRpcEndpoints,
}));

import { runBootValidation } from '../src/boot.js';

const ENDPOINT = { baseUrl: 'https://rpc.snapshot.test/provider/grpc', meta: {} };
const TESTNET_CONTRACT_IDS = STELIS_CONTRACT_IDS.testnet!;
const TESTNET_DEEPBOOK_IDS = DEEPBOOK_IDS.testnet!;
const PRIMARY_CLIENT = Object.freeze({ network: 'testnet' }) as unknown as SuiGrpcClient;
const QUALIFICATION_SNAPSHOT = createSuiEndpointSnapshot([PRIMARY_CLIENT]);
const INITIAL_HOST_CHAIN_STATE: HostChainState = Object.freeze({
  config: Object.freeze({
    packageId: TESTNET_CONTRACT_IDS.packageId,
    configId: TESTNET_CONTRACT_IDS.configId,
    maxClaimMist: 1n,
    minSettleMist: 2n,
    maxHostFeeMist: 3n,
    protocolFlatFeeMist: 4n,
    configVersion: 5n,
    maxSpreadBps: 6n,
  }),
  vaultRegistryId: TESTNET_CONTRACT_IDS.vaultRegistryId,
  vaultsTableId: `0x${'56'.repeat(32)}`,
});
const SETTLEMENT_SWAP_PATH: SingleHopSettlementSwapPath = {
  hops: [
    {
      poolId: `0x${'12'.repeat(32)}`,
      baseType: `0x${'78'.repeat(32)}::coin::COIN`,
      quoteType: '0x2::sui::SUI',
      swapDirection: 'baseForQuote',
      feeBps: 0,
    },
  ],
  settlementTokenType: `0x${'78'.repeat(32)}::coin::COIN`,
  settlementTokenSymbol: 'COIN',
  settlementTokenDecimals: 9,
  lotSize: 1n,
  minSize: 1n,
  effectiveFeeRateBps: 0,
  settlementSwapDirection: 'baseForQuote',
};
let temporaryDirectory = '';

function setRequiredEnvironment(): void {
  const sponsor = Ed25519Keypair.generate();
  const sponsorRefillAccount = Ed25519Keypair.generate();
  const payout = Ed25519Keypair.generate();

  vi.stubEnv('SPONSOR_SECRET_KEY', sponsor.getSecretKey());
  vi.stubEnv('SPONSOR_REFILL_ACCOUNT_SECRET_KEY', sponsorRefillAccount.getSecretKey());
  vi.stubEnv('SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS', payout.toSuiAddress());
  vi.stubEnv('SPONSOR_LEASE_HMAC_SECRET', 'boot-runtime-input-hmac-secret-00000000');
  vi.stubEnv('NETWORK', 'testnet');
  vi.stubEnv('REDIS_URL', 'redis://boot-snapshot');
  vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
  vi.stubEnv('HOST_FEE_MIST', '7');
  vi.stubEnv('PREPARE_INFLIGHT_CAPACITY', '5');
  vi.stubEnv('CORS_ORIGINS', 'https://admin.before.example');
  vi.stubEnv('RPC_AUTH_VALUE', 'rpc-auth-before-await');
  vi.stubEnv('SPONSOR_OPERATIONS_SLOT_BALANCE_TIMEOUT_MS', '5000');
  vi.stubEnv('SPONSOR_OPERATIONS_SPONSOR_REFILL_ACCOUNT_BALANCE_TIMEOUT_MS', '5000');
  vi.stubEnv('SPONSOR_OPERATIONS_REFILL_TIMEOUT_MS', '30000');
  vi.stubEnv('SPONSOR_OPERATIONS_CONFIRMATION_TIMEOUT_MS', '15000');
  vi.stubEnv('SPONSOR_OPERATIONS_RECONCILIATION_INTERVAL_MS', '15000');
}

function setStudioEnvironment(allowedTargets: string): void {
  vi.stubEnv('ADMIN_JWT_SECRET', 'studio-admin-jwt-secret-00000000');
  vi.stubEnv('ADMIN_ADDRESS', `0x${'ab'.repeat(32)}`);
  vi.stubEnv('STUDIO_ALLOWED_TARGETS', allowedTargets);
  // Target validation runs before trust parsing; these tests intentionally
  // isolate the target boundary from JWT key construction.
  vi.stubEnv('STUDIO_DEVELOPER_JWT_TRUST_JSON', '{}');
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.rpcAuthValue = null;
  state.qualificationSignal = null;
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'stelis-boot-runtime-input-'));
  state.registryPath = join(temporaryDirectory, 'settlement-swap-paths.json');
  await writeFile(
    state.registryPath,
    JSON.stringify({
      testnet: [`0x${'12'.repeat(32)}`],
      mainnet: [`0x${'34'.repeat(32)}`],
    }),
    'utf8',
  );
  setRequiredEnvironment();

  state.loadRpcConfig.mockImplementation(
    (
      _network: string,
      _filePath: string | undefined,
      envLookup: (name: string) => string | undefined,
    ) => {
      state.rpcAuthValue = envLookup('RPC_AUTH_VALUE') ?? null;
      return [ENDPOINT];
    },
  );
  state.readHostChainState.mockResolvedValue(INITIAL_HOST_CHAIN_STATE);
  state.resolveSettlementSwapPathRegistry.mockResolvedValue([SETTLEMENT_SWAP_PATH]);
  state.qualifySuiRpcEndpoints.mockImplementation(
    async (
      options: QualifySuiRpcEndpointsOptions<{
        readonly initialHostChainState: HostChainState;
        readonly settlementSwapPaths: readonly SingleHopSettlementSwapPath[];
      }>,
    ) => {
      const controller = new AbortController();
      state.qualificationSignal = controller.signal;
      process.env.RPC_AUTH_VALUE = 'rpc-auth-after-await';
      process.env.CORS_ORIGINS = 'https://admin.after.example';
      process.env.ADMIN_JWT_SECRET = 'x'.repeat(32);
      process.env.ADMIN_ADDRESS = `0x${'ab'.repeat(32)}`;
      process.env.STUDIO_ALLOWED_TARGETS = `0x${'cd'.repeat(32)}::module::entry`;
      process.env.STUDIO_DEVELOPER_JWT_TRUST_JSON = '{not valid json';
      const qualification = await options.qualify({
        snapshot: QUALIFICATION_SNAPSHOT,
        signal: controller.signal,
      });
      return Object.freeze({
        snapshot: QUALIFICATION_SNAPSHOT,
        primaryQualification: qualification,
        rejected: Object.freeze([]),
        adminSnapshot: Object.freeze({
          endpoints: Object.freeze([
            Object.freeze({ origin: 'https://rpc.snapshot.test', role: 'primary' as const }),
          ]),
        }),
      });
    },
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('runBootValidation runtime input', () => {
  it('uses one pre-await env snapshot and retains the primary endpoint qualification', async () => {
    const result = await runBootValidation();
    await rm(state.registryPath);

    expect(state.rpcAuthValue).toBe('rpc-auth-before-await');
    expect(result.publicSummary).toEqual({
      mode: 'generic',
      studioEnabled: false,
      network: 'testnet',
    });
    expect(result.runtimeInput.corsAllowedOrigins).toEqual(['https://admin.before.example']);
    expect(result.runtimeInput.context.quotedHostFeeMist).toBe(7n);
    expect(result.runtimeInput.context.prepareInflightCapacity).toBe(5);
    expect(result.runtimeInput.context.sponsorOperations.settings.withdrawalReceiptTtlMs).toBe(
      3_600_000,
    );
    expect(result.runtimeInput.context.studio).toBeNull();
    expect(result.runtimeInput.context.sui).toBe(QUALIFICATION_SNAPSHOT);
    expect(result.runtimeInput.context.initialHostChainState).toBe(INITIAL_HOST_CHAIN_STATE);
    expect(result.runtimeInput.context.settlementSwapPaths).toEqual([SETTLEMENT_SWAP_PATH]);
    expect(result.runtimeInput.context.rpcFleet).toEqual({
      endpoints: [{ origin: 'https://rpc.snapshot.test', role: 'primary' }],
    });
    expect(state.qualifySuiRpcEndpoints).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'testnet', endpoints: [ENDPOINT] }),
    );
    expect(state.readHostChainState).toHaveBeenCalledWith(
      QUALIFICATION_SNAPSHOT,
      TESTNET_CONTRACT_IDS,
      state.qualificationSignal,
    );
    expect(state.resolveSettlementSwapPathRegistry).toHaveBeenCalledWith(
      QUALIFICATION_SNAPSHOT,
      TESTNET_DEEPBOOK_IDS.packageId,
      [{ poolId: `0x${'12'.repeat(32)}` }],
      state.qualificationSignal,
    );
  });

  it('rejects enabled refill without its documented target before external services', async () => {
    vi.stubEnv('SPONSOR_OPERATIONS_REFILL_ENABLED', 'true');
    vi.stubEnv('SPONSOR_BALANCE_REFILL_TARGET_MIST', '');

    await expect(runBootValidation()).rejects.toThrow(
      'SPONSOR_BALANCE_REFILL_TARGET_MIST is required',
    );
    expect(state.qualifySuiRpcEndpoints).not.toHaveBeenCalled();
  });

  it('rejects SponsorOperations timer values that Node would truncate', async () => {
    vi.stubEnv('SPONSOR_OPERATIONS_CONFIRMATION_TIMEOUT_MS', String(NODE_TIMER_MAX_DELAY_MS + 1));

    await expect(runBootValidation()).rejects.toThrow(String(NODE_TIMER_MAX_DELAY_MS));
    expect(state.qualifySuiRpcEndpoints).not.toHaveBeenCalled();
  });

  it('rejects inconsistent SponsorOperations settings before external services', async () => {
    vi.stubEnv('SPONSOR_OPERATIONS_SLOT_BALANCE_TIMEOUT_MS', '15001');
    vi.stubEnv('SPONSOR_OPERATIONS_RECONCILIATION_INTERVAL_MS', '15000');

    await expect(runBootValidation()).rejects.toThrow(
      'balance timeouts must not exceed reconciliationIntervalMs',
    );
    expect(state.qualifySuiRpcEndpoints).not.toHaveBeenCalled();
  });

  it('rejects malformed response-header configuration before external services', async () => {
    vi.stubEnv('CORS_ORIGINS', 'https://admin.example/path');
    await expect(runBootValidation()).rejects.toThrow(
      'CORS_ORIGINS entry must be an http(s) origin',
    );

    vi.stubEnv('CORS_ORIGINS', 'https://admin.example');
    vi.stubEnv('COOKIE_DOMAIN', '.example.com; Secure');
    await expect(runBootValidation()).rejects.toThrow('COOKIE_DOMAIN must be a valid DNS domain');

    expect(state.qualifySuiRpcEndpoints).not.toHaveBeenCalled();
  });

  it.each([
    'xyz::coin::zero',
    '::coin::zero',
    '0x::coin::zero',
    '0x2::::zero',
    '0x2::coin::bad-name',
  ])('rejects an unreachable Studio target at boot: %s', async (target) => {
    setStudioEnvironment(target);
    await expect(runBootValidation()).rejects.toThrow('STUDIO_ALLOWED_TARGETS entry');
  });

  it('rejects Studio targets that collide after package-address canonicalization', async () => {
    setStudioEnvironment(`0x2::coin::zero,0x${'0'.repeat(63)}2::coin::zero`);
    await expect(runBootValidation()).rejects.toThrow(
      'STUDIO_ALLOWED_TARGETS contains duplicate entry after canonicalization',
    );
  });
});
