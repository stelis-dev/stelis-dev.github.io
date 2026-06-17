/**
 * [app-api] Boot/instrumentation — runs before the server starts.
 *
 * Validates all required env vars, establishes Redis connectivity,
 * and determines runtime mode (generic-only vs. generic+studio).
 *
 * Shared references:
 *   - parseSponsorKey, parseSponsorKeys → @stelis/core-api
 *   - canonicalizeAddress, validateAddressConstraints → @stelis/core-api
 *   - parseTrustedProxyHops → @stelis/core-api
 *   - SPONSOR_BALANCE_WARN_MIST → ./sponsor-operations/defaults
 *   - STELIS_CONTRACT_IDS, DEEPBOOK_IDS, requireContractId → @stelis/contracts
 *
 * Admin session keyspace → stelis:app-api:admin:not_before
 * Dual auto-detect mode: generic always on, studio on when env is complete
 */
import {
  parseSponsorKey,
  parseSponsorKeys,
  canonicalizeAddress,
  validateAddressConstraints,
  parseTrustedProxyHops,
} from '@stelis/core-api';
import { STELIS_CONTRACT_IDS, DEEPBOOK_IDS, requireContractId } from '@stelis/contracts';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { SPONSOR_BALANCE_WARN_MIST } from './sponsor-operations/defaults.js';
import {
  requireEnv,
  parseOptionalBooleanEnv,
  parseOptionalPositiveBigIntEnv,
  parseOptionalPositiveIntegerEnv,
} from './env.js';
import { createRedisClient } from './redisClient.js';
import { loadRpcConfig, createSuiClient } from './sui/index.js';
import { redactUrl } from './sui/redactUrl.js';
import { validateChainIdentity } from './sui/validateChainIdentity.js';
import {
  getSettlementSwapPathRegistryPath,
  parseSettlementSwapPathRegistryJson,
} from './settlementSwapPathRegistry.js';
import { hashTarget, parseDeveloperJwtTrustConfig } from '@stelis/core-api/studio';

/** Runtime mode resolved at boot — determines which route groups are active. */
export interface BootResult {
  /** 'generic' | 'dual' (generic always on, studio conditional) */
  mode: 'generic' | 'dual';
  /** Whether the studio env set is complete. */
  studioEnabled: boolean;
  /** Network: testnet or mainnet */
  network: 'testnet' | 'mainnet';
  /** Shared SuiGrpcClient — multi-endpoint failover when configured. */
  suiClient: SuiGrpcClient;
  /** Failover transport — always present (no single-endpoint fast path). */
  failoverTransport: import('./sui/failoverTransport.js').SuiRpcFailoverTransport;
  /** Configured endpoint URLs (safe for admin display — no auth metadata). */
  rpcEndpointUrls: string[];
}

/** Human-readable runtime mode string for boot logs. */
export function formatRuntimeMode(mode: BootResult['mode']): string {
  return mode === 'dual' ? 'dual (relay + studio)' : 'generic (relay only)';
}

export function resolveTrustedProxyHopsForBoot(input: {
  trustedProxyHops: string | null | undefined;
  nodeEnv: string | null | undefined;
}): number {
  const trustedProxyHops = parseTrustedProxyHops(input.trustedProxyHops);
  if (input.trustedProxyHops?.trim()) return trustedProxyHops;

  const nodeEnv = input.nodeEnv?.trim();
  if (nodeEnv === 'development' || nodeEnv === 'test') return trustedProxyHops;

  throw new Error(
    '[app-api] TRUSTED_PROXY_HOPS must be set before deployed app-api starts. ' +
      'Use TRUSTED_PROXY_HOPS=0 only when app-api is directly exposed, or set the exact reverse-proxy hop count.',
  );
}

/**
 * Runs all fail-fast boot validation. Must complete before accepting requests.
 *
 * Throws on any validation failure (fail-closed).
 */
export async function runBootValidation(): Promise<BootResult> {
  // ── 1. Generic required env vars ─────────────────────────────────────────
  // RPC fleet config is loaded from packages/app-api/rpc.json (not env).
  const genericRequired = [
    'SPONSOR_SECRET_KEY',
    'NETWORK',
    'REDIS_URL',
    'RELAYER_RECIPIENT_ADDRESS',
    'SPONSOR_LEASE_HMAC_SECRET',
  ] as const;

  for (const key of genericRequired) {
    requireEnv(key);
  }

  // SPONSOR_LEASE_HMAC_SECRET must be long enough to be a real secret.
  // Matches SPONSOR_LEASE_HMAC_SECRET_MIN_LENGTH in core-api.
  // Fail-fast at boot so a misconfigured deployment never accepts a
  // weak lease proof.
  const leaseHmacSecret = requireEnv('SPONSOR_LEASE_HMAC_SECRET');
  if (leaseHmacSecret.length < 32) {
    throw new Error(
      '[app-api] SPONSOR_LEASE_HMAC_SECRET must be at least 32 characters. ' +
        'Generate a high-entropy value (e.g. `openssl rand -base64 48`) and store it in env.',
    );
  }

  // ── 2. Network validation ────────────────────────────────────────────────
  const network = requireEnv('NETWORK') as 'testnet' | 'mainnet';
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new Error(`[app-api] NETWORK must be 'testnet' or 'mainnet', got '${network}'`);
  }

  // ── 3. Contract ID validation ────────────────────────────────────────────
  // Uses STELIS_CONTRACT_IDS, DEEPBOOK_IDS, and requireContractId from @stelis/contracts.
  // app-api must not import @stelis/core-relay directly for contract IDs.
  const contractIds = STELIS_CONTRACT_IDS[network];
  const deepbookIds = DEEPBOOK_IDS[network];

  for (const [name, constantValue] of [
    ['STELIS_PACKAGE_ID', contractIds?.packageId],
    ['STELIS_CONFIG_ID', contractIds?.configId],
    ['STELIS_VAULT_REGISTRY_ID', contractIds?.vaultRegistryId],
    ['DEEPBOOK_PACKAGE_ID', deepbookIds?.packageId],
    ['DEEP_TYPE', deepbookIds?.deepType],
  ] as const) {
    requireContractId(constantValue, name);
  }

  // ── 3b. settlement-swap-paths.json format validation ───────────────
  // Early fail-fast for format issues. Full on-chain derivation happens in context init.
  const settlementSwapPathRegistryPath = getSettlementSwapPathRegistryPath();
  let settlementSwapPathRegistryRaw: string;
  try {
    const { readFileSync } = await import('node:fs');
    settlementSwapPathRegistryRaw = readFileSync(settlementSwapPathRegistryPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `[app-api] Cannot read settlement-swap-paths.json at "${settlementSwapPathRegistryPath}": ${err instanceof Error ? err.message : String(err)}. ` +
        'Copy packages/app-api/settlement-swap-paths.json.example → packages/app-api/settlement-swap-paths.json and fill in the actual DeepBook pool IDs before starting app-api.',
    );
  }
  // Capture the first pool ID for downstream simulateTransaction capability probe.
  // parseSettlementSwapPathRegistryJson guarantees non-empty registry with valid pool IDs.
  let settlementSwapPathRegistryJson: unknown;
  try {
    settlementSwapPathRegistryJson = JSON.parse(settlementSwapPathRegistryRaw);
  } catch (err) {
    throw new Error(
      `[app-api] Invalid JSON in settlement-swap-paths.json at "${settlementSwapPathRegistryPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const settlementSwapPathRegistryEntries = parseSettlementSwapPathRegistryJson(
    settlementSwapPathRegistryJson,
  );
  const simulateProbePoolId = settlementSwapPathRegistryEntries[0].poolId;

  // ── 4. Trusted proxy hops validation ─────────────────────────────────────
  void resolveTrustedProxyHopsForBoot({
    trustedProxyHops: process.env.TRUSTED_PROXY_HOPS,
    nodeEnv: process.env.NODE_ENV,
  });

  // ── 5. Prepare in-flight validation ──────────────────────────────────
  void parseOptionalPositiveIntegerEnv(
    'PREPARE_INFLIGHT_CAPACITY',
    process.env.PREPARE_INFLIGHT_CAPACITY,
  );

  // ── 6. Sponsor Refill Account validation ───────────────────────────────────────────
  const sponsorRefillAccountSecretKey = process.env.SPONSOR_REFILL_ACCOUNT_SECRET_KEY?.trim();
  if (!sponsorRefillAccountSecretKey) {
    throw new Error(
      '[app-api] Missing required environment variable: SPONSOR_REFILL_ACCOUNT_SECRET_KEY. ' +
        'Sponsor Refill Account must be a dedicated key separate from sponsor keys.',
    );
  }
  parseSponsorKey(sponsorRefillAccountSecretKey, 'SPONSOR_REFILL_ACCOUNT_SECRET_KEY');

  // ── 7. Refill validation ─────────────────────────────────────────────────
  void parseOptionalBooleanEnv(
    'SPONSOR_OPERATIONS_REFILL_ENABLED',
    process.env.SPONSOR_OPERATIONS_REFILL_ENABLED,
  );
  const warnMist =
    parseOptionalPositiveBigIntEnv(
      'SPONSOR_BALANCE_WARN_MIST',
      process.env.SPONSOR_BALANCE_WARN_MIST,
    ) ?? SPONSOR_BALANCE_WARN_MIST;
  const refillTargetMist = parseOptionalPositiveBigIntEnv(
    'SPONSOR_BALANCE_REFILL_TARGET_MIST',
    process.env.SPONSOR_BALANCE_REFILL_TARGET_MIST,
  );
  if (refillTargetMist != null && refillTargetMist <= warnMist) {
    throw new Error(
      '[app-api] SPONSOR_BALANCE_REFILL_TARGET_MIST must be greater than ' +
        `SPONSOR_BALANCE_WARN_MIST (${warnMist.toString()} MIST)`,
    );
  }

  // ── 8. Address constraint validation ─────────────────────────────────────
  const sponsorKeys = parseSponsorKeys(requireEnv('SPONSOR_SECRET_KEY'));
  const sponsorAddrs = sponsorKeys.map((kp) => kp.toSuiAddress());
  const recipientAddr = canonicalizeAddress(
    requireEnv('RELAYER_RECIPIENT_ADDRESS'),
    'RELAYER_RECIPIENT_ADDRESS',
  );
  const sponsorRefillAccountAddress = parseSponsorKey(
    sponsorRefillAccountSecretKey,
    'SPONSOR_REFILL_ACCOUNT_SECRET_KEY',
  ).toSuiAddress();
  validateAddressConstraints({
    sponsorAddresses: sponsorAddrs,
    relayerRecipientAddress: recipientAddr,
    sponsorRefillAccountAddress: sponsorRefillAccountAddress,
  });

  // ── 9. Admin env validation ──────────────────────────────────────────────
  const adminAddr = process.env.ADMIN_ADDRESS?.trim();
  if (adminAddr) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(adminAddr)) {
      throw new Error(
        '[app-api] ADMIN_ADDRESS must be a valid Sui address (0x + 64 hex characters)',
      );
    }
    // Sponsor refill account != Admin Address constraint
    if (sponsorRefillAccountAddress === canonicalizeAddress(adminAddr, 'ADMIN_ADDRESS')) {
      throw new Error(
        '[app-api] SPONSOR_REFILL_ACCOUNT_SECRET_KEY address must differ from ADMIN_ADDRESS. ' +
          'Sponsor Refill Account and Admin must be separate identities.',
      );
    }
  }
  if (process.env.ADMIN_JWT_SECRET?.trim()) {
    if (process.env.ADMIN_JWT_SECRET.trim().length < 32) {
      throw new Error('[app-api] ADMIN_JWT_SECRET must be at least 32 characters');
    }
  }
  if (process.env.ADMIN_SESSION_EXPIRY?.trim()) {
    const v = process.env.ADMIN_SESSION_EXPIRY.trim();
    if (!/^\d+(h|m|s)$/.test(v)) {
      throw new Error(
        `[app-api] ADMIN_SESSION_EXPIRY must be a duration string like "1h", "30m", or "120s" (got "${v}")`,
      );
    }
  }

  // ── 10. Redis connectivity + admin not_before key ────────────────────
  const redis = await createRedisClient(requireEnv('REDIS_URL'));
  try {
    await redis.set('stelis:app-api:admin:not_before', String(Date.now()));
  } finally {
    await redis.dispose();
  }

  // ── 10a. Load RPC fleet + validate chain identity ─────────────────────────
  const rpcEndpoints = loadRpcConfig();

  // ── Endpoint verification: chain identity + functional probe ──────────
  // 1. Chain identity: each endpoint must return correct chainIdentifier
  const chainResult = await validateChainIdentity(network, rpcEndpoints);
  // eslint-disable-next-line no-console
  console.log(`[app-api] Chain identity verified: ${chainResult.chainIdentifier} (${network})`);

  // 2. Functional probe: chain-verified endpoints must also pass getObject +
  //    getCoinMetadata + simulateTransaction capability checks. Probe logic
  //    lives in ./sui/probeEndpointCapabilities (unit-testable).
  const { probeEndpointCapabilities } = await import('./sui/probeEndpointCapabilities.js');
  const stelisConfigId = contractIds!.configId;
  const deepCoinType = deepbookIds!.deepType;
  const functionalResults = await Promise.all(
    rpcEndpoints.map(async (ep) => {
      const chainOk = chainResult.endpointResults.some((r) => r.url === ep.url && r.error === null);
      if (!chainOk) return { url: ep.url, ok: false, reason: 'chain identity failed' };

      const { GrpcWebFetchTransport } = await import('@protobuf-ts/grpcweb-transport');
      const transport = new GrpcWebFetchTransport({
        baseUrl: ep.url,
        fetchInit: ep.fetchInit,
        meta: ep.meta ?? {},
      });
      const probeClient = new (await import('@mysten/sui/grpc')).SuiGrpcClient({
        network,
        transport,
      });

      const result = await probeEndpointCapabilities(probeClient, {
        stelisConfigId,
        deepCoinType,
        simulateProbePoolId,
      });
      return { url: ep.url, ...result };
    }),
  );

  const verified = rpcEndpoints.filter((ep) =>
    functionalResults.some((r) => r.url === ep.url && r.ok),
  );
  const rejected = functionalResults.filter((r) => !r.ok);

  if (rejected.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[app-api] RPC endpoint(s) excluded: ` +
        rejected.map((r) => `${redactUrl(r.url)}: ${r.reason}`).join('; '),
    );
  }
  if (verified.length === 0) {
    throw new Error('[app-api] No usable RPC endpoints after verification.');
  }
  // eslint-disable-next-line no-console
  console.log(
    `[app-api] Sui RPC: ${verified.length}/${rpcEndpoints.length} endpoint(s) verified — ` +
      verified.map((ep) => redactUrl(ep.url)).join(', '),
  );

  const { client: suiClient, failoverTransport } = createSuiClient({
    network,
    endpoints: verified,
  });

  // On-chain contract probe is already done in the functional probe above
  // (each verified endpoint successfully read the Config object).

  // ── 10. Studio auto-detect ─────────────────────────────────────────────
  // Studio auth uses developer JWT trust (STUDIO_DEVELOPER_JWT_TRUST_JSON).
  const studioEnvKeys = [
    'ADMIN_JWT_SECRET',
    'ADMIN_ADDRESS',
    'STUDIO_ALLOWED_TARGETS',
    'STUDIO_DEVELOPER_JWT_TRUST_JSON',
  ];
  const studioEnvPresent = studioEnvKeys.every((k) => !!process.env[k]?.trim());

  if (studioEnvPresent) {
    // STUDIO_ALLOWED_TARGETS — comma-separated pkg::mod::fn, at least one entry
    const targetsRaw = requireEnv('STUDIO_ALLOWED_TARGETS');
    const targets = targetsRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (targets.length === 0) {
      throw new Error(
        '[app-api] STUDIO_ALLOWED_TARGETS must contain at least one pkg::mod::fn entry',
      );
    }
    for (const t of targets) {
      if (t.split('::').length !== 3) {
        throw new Error(
          `[app-api] STUDIO_ALLOWED_TARGETS entry "${t}" is not valid pkg::mod::fn format`,
        );
      }
    }
    // Duplicate detection after canonicalization (fail-fast)
    const seen = new Set<string>();
    for (const t of targets) {
      const hash = hashTarget(t);
      if (seen.has(hash)) {
        throw new Error(
          `[app-api] STUDIO_ALLOWED_TARGETS contains duplicate entry after canonicalization: "${t}"`,
        );
      }
      seen.add(hash);
    }

    // STUDIO_DEVELOPER_JWT_TRUST_JSON — parsed and validated at boot (single issuer object)
    const trustJson = requireEnv('STUDIO_DEVELOPER_JWT_TRUST_JSON');
    parseDeveloperJwtTrustConfig(trustJson); // throws on invalid config

    // STUDIO_DEVELOPER_JWT_VERIFY_URL — optional developer-side validity callback
    const verifyUrl = process.env.STUDIO_DEVELOPER_JWT_VERIFY_URL?.trim();
    if (verifyUrl) {
      try {
        const parsed = new URL(verifyUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('must be http or https');
        }
      } catch (e) {
        throw new Error(
          `[app-api] STUDIO_DEVELOPER_JWT_VERIFY_URL is not a valid URL: "${verifyUrl}" — ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  const studioEnabled = studioEnvPresent;
  const mode: BootResult['mode'] = studioEnabled ? 'dual' : 'generic';
  // eslint-disable-next-line no-console
  console.log(`[app-api] Boot validation complete — mode: ${formatRuntimeMode(mode)}`);

  return {
    mode,
    studioEnabled,
    network,
    suiClient,
    failoverTransport,
    rpcEndpointUrls: verified.map((ep) => ep.url),
  };
}
