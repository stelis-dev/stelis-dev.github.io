import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const state = vi.hoisted(() => ({
  registryPath: '',
  rpcAuthValue: null as string | null,
  createRedisClient: vi.fn(),
  loadRpcConfig: vi.fn(),
  createSuiClient: vi.fn(),
  validateChainIdentity: vi.fn(),
  probeEndpointCapabilities: vi.fn(),
}));

vi.mock('../src/settlementSwapPathRegistry.js', async () => {
  const actual = await vi.importActual<typeof import('../src/settlementSwapPathRegistry.js')>(
    '../src/settlementSwapPathRegistry.js',
  );
  return {
    ...actual,
    getSettlementSwapPathRegistryPath: () => state.registryPath,
  };
});

vi.mock('../src/redisClient.js', () => ({
  createRedisClient: state.createRedisClient,
}));

vi.mock('../src/sui/index.js', () => ({
  loadRpcConfig: state.loadRpcConfig,
  createSuiClient: state.createSuiClient,
}));

vi.mock('../src/sui/validateChainIdentity.js', () => ({
  validateChainIdentity: state.validateChainIdentity,
}));

vi.mock('../src/sui/probeEndpointCapabilities.js', () => ({
  probeEndpointCapabilities: state.probeEndpointCapabilities,
}));

import { runBootValidation } from '../src/boot.js';

const ENDPOINT = { url: 'https://rpc.snapshot.test', fetchInit: {}, meta: {} };
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

  state.createRedisClient.mockResolvedValue({
    eval: vi.fn().mockImplementation(async (_script, _keys, args) => {
      process.env.RPC_AUTH_VALUE = 'rpc-auth-after-await';
      process.env.CORS_ORIGINS = 'https://admin.after.example';
      process.env.ADMIN_JWT_SECRET = 'x'.repeat(32);
      process.env.ADMIN_ADDRESS = `0x${'ab'.repeat(32)}`;
      process.env.STUDIO_ALLOWED_TARGETS = `0x${'cd'.repeat(32)}::module::entry`;
      process.env.STUDIO_DEVELOPER_JWT_TRUST_JSON = '{not valid json';
      return args[0];
    }),
    set: vi.fn().mockImplementation(async () => {
      process.env.RPC_AUTH_VALUE = 'rpc-auth-after-await';
      process.env.CORS_ORIGINS = 'https://admin.after.example';
      process.env.ADMIN_JWT_SECRET = 'x'.repeat(32);
      process.env.ADMIN_ADDRESS = `0x${'ab'.repeat(32)}`;
      process.env.STUDIO_ALLOWED_TARGETS = `0x${'cd'.repeat(32)}::module::entry`;
      process.env.STUDIO_DEVELOPER_JWT_TRUST_JSON = '{not valid json';
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  });
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
  state.validateChainIdentity.mockResolvedValue({
    chainIdentifier: 'testnet-chain',
    endpointResults: [{ url: ENDPOINT.url, error: null }],
  });
  state.probeEndpointCapabilities.mockResolvedValue({ ok: true });
  state.createSuiClient.mockReturnValue({
    client: { runtime: 'sui-client' },
    primaryClient: { runtime: 'primary-sui-client' },
    failoverTransport: { runtime: 'failover-transport' },
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('runBootValidation runtime input', () => {
  it('uses one pre-await env snapshot and retains parsed registry entries after file removal', async () => {
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
    expect(result.runtimeInput.context.sponsorOperations.withdrawalReceiptTtlMs).toBe(3_600_000);
    expect(result.runtimeInput.context.studio).toBeNull();
    expect(result.runtimeInput.context.settlementSwapPathRegistryEntries).toEqual([
      { poolId: `0x${'12'.repeat(32)}` },
    ]);
  });

  it('rejects enabled refill without its documented target before external services', async () => {
    vi.stubEnv('SPONSOR_OPERATIONS_REFILL_ENABLED', 'true');
    vi.stubEnv('SPONSOR_BALANCE_REFILL_TARGET_MIST', '');

    await expect(runBootValidation()).rejects.toThrow(
      'SPONSOR_BALANCE_REFILL_TARGET_MIST is required',
    );
    expect(state.createRedisClient).not.toHaveBeenCalled();
    expect(state.validateChainIdentity).not.toHaveBeenCalled();
  });

  it('rejects malformed response-header configuration before external services', async () => {
    vi.stubEnv('CORS_ORIGINS', 'https://admin.example/path');
    await expect(runBootValidation()).rejects.toThrow(
      'CORS_ORIGINS entry must be an http(s) origin',
    );

    vi.stubEnv('CORS_ORIGINS', 'https://admin.example');
    vi.stubEnv('COOKIE_DOMAIN', '.example.com; Secure');
    await expect(runBootValidation()).rejects.toThrow('COOKIE_DOMAIN must be a valid DNS domain');

    expect(state.createRedisClient).not.toHaveBeenCalled();
    expect(state.validateChainIdentity).not.toHaveBeenCalled();
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
