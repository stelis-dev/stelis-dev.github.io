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
import {
  SPONSOR_BALANCE_REFILL_TARGET_MIST,
  SPONSOR_BALANCE_WARN_MIST,
} from './sponsor-operations/defaults.js';
import {
  parseOptionalBooleanEnv,
  parseOptionalPositiveBigIntEnv,
  parseOptionalPositiveIntegerEnv,
  parseRequiredPositiveIntegerEnv,
} from './env.js';
import { createRedisClient } from './redisClient.js';
import { loadRpcConfig } from './sui/parseEndpointConfig.js';
import { createSuiClient } from './sui/createSuiClient.js';
import {
  redactEndpointUrl,
  redactSensitiveText,
  safeErrorSummary,
} from '@stelis/core-api/observability';
import { validateChainIdentity } from './sui/validateChainIdentity.js';
import {
  getSettlementSwapPathRegistryPath,
  parseSettlementSwapPathRegistryJson,
} from './settlementSwapPathRegistry.js';
import { canonicalizePromotionTarget, parseDeveloperJwtTrustConfig } from '@stelis/core-api/studio';
import { parseDuration } from '@stelis/core-api/admin';
import { parseHostFeeEnv } from '@stelis/core-api/prepareConfig';
import type { ContextRuntimeInput } from './context.js';
import type { AdminAuthRuntimeConfig } from './adminAuth.js';
import { createAdminRedisAdapter } from './adminRedis.js';
import { raiseAppApiAdminSessionNotBefore } from './adminSessionNotBefore.js';

/** Runtime mode resolved at boot — determines which route groups are active. */
export interface BootSummary {
  /** 'generic' | 'dual' (generic always on, studio conditional) */
  readonly mode: 'generic' | 'dual';
  /** Whether the studio env set is complete. */
  readonly studioEnabled: boolean;
  /** Network: testnet or mainnet */
  readonly network: 'testnet' | 'mainnet';
}

/** Secret-bearing process input. This value never leaves createApp. */
export interface AppRuntimeInput {
  readonly context: ContextRuntimeInput;
  readonly trustedProxyHops: number;
  readonly corsAllowedOrigins: readonly string[];
  readonly adminAddress: string | null;
  readonly adminAuth: AdminAuthRuntimeConfig;
  readonly adminSponsorOperations: {
    readonly refillEnabled: boolean;
    /** Existing admin runway/withdraw fallback, distinct from the optional worker target. */
    readonly refillTargetMist: bigint;
    readonly warnMist: bigint;
  };
}

export interface BootValidationResult {
  readonly runtimeInput: AppRuntimeInput;
  readonly publicSummary: BootSummary;
}

/** Human-readable runtime mode string for boot logs. */
export function formatRuntimeMode(mode: BootSummary['mode']): string {
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

function parseCorsAllowedOrigins(rawValue: string | undefined): string[] {
  if (!rawValue?.trim()) return [];

  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error(`[app-api] CORS_ORIGINS contains an invalid origin: "${value}"`);
      }
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        parsed.pathname !== '/' ||
        parsed.search !== '' ||
        parsed.hash !== ''
      ) {
        throw new Error(
          `[app-api] CORS_ORIGINS entry must be an http(s) origin without credentials, path, query, or fragment: "${value}"`,
        );
      }
      return parsed.origin;
    });
}

function parseCookieDomain(rawValue: string | undefined): string | null {
  const value = rawValue?.trim();
  if (!value) return null;

  const hostname = value.startsWith('.') ? value.slice(1) : value;
  const labels = hostname.split('.');
  const valid =
    value.length <= 253 &&
    hostname.length > 0 &&
    labels.every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    );
  if (!valid) {
    throw new Error(`[app-api] COOKIE_DOMAIN must be a valid DNS domain, got "${value}"`);
  }
  return value.toLowerCase();
}

/**
 * Runs all fail-fast boot validation. Must complete before accepting requests.
 *
 * Throws on any validation failure (fail-closed).
 */
export async function runBootValidation(): Promise<BootValidationResult> {
  // Capture before the first await. RPC auth variables referenced indirectly
  // from rpc.json use this same snapshot through the injected lookup below.
  const environment: Readonly<Record<string, string | undefined>> = { ...process.env };
  const requireBootEnv = (name: string): string => {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`[app-api] Missing required environment variable: ${name}`);
    return value;
  };

  // ── 1. Generic required env vars ─────────────────────────────────────────
  // RPC fleet config is loaded from packages/app-api/rpc.json (not env).
  const genericRequired = [
    'SPONSOR_SECRET_KEY',
    'NETWORK',
    'REDIS_URL',
    'SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS',
    'SPONSOR_LEASE_HMAC_SECRET',
  ] as const;

  for (const key of genericRequired) {
    requireBootEnv(key);
  }
  const redisUrl = requireBootEnv('REDIS_URL');

  // SPONSOR_LEASE_HMAC_SECRET must be long enough to be a real secret.
  // Matches SPONSOR_LEASE_HMAC_SECRET_MIN_LENGTH in core-api.
  // Fail-fast at boot so a misconfigured deployment never accepts a
  // weak lease proof.
  const leaseHmacSecret = requireBootEnv('SPONSOR_LEASE_HMAC_SECRET');
  if (leaseHmacSecret.length < 32) {
    throw new Error(
      '[app-api] SPONSOR_LEASE_HMAC_SECRET must be at least 32 characters. ' +
        'Generate a high-entropy value (e.g. `openssl rand -base64 48`) and store it in env.',
    );
  }

  // ── 2. Network validation ────────────────────────────────────────────────
  const network = requireBootEnv('NETWORK') as 'testnet' | 'mainnet';
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
      `[app-api] Cannot read settlement-swap-paths.json at "${settlementSwapPathRegistryPath}": ${redactSensitiveText(err instanceof Error ? err.message : String(err))}. ` +
        'Restore the tracked packages/app-api/settlement-swap-paths.json config file and configure the active NETWORK section before starting app-api.',
    );
  }
  // Capture the first pool ID for downstream simulateTransaction capability probe.
  // parseSettlementSwapPathRegistryJson guarantees non-empty registry with valid pool IDs.
  let settlementSwapPathRegistryJson: unknown;
  try {
    settlementSwapPathRegistryJson = JSON.parse(settlementSwapPathRegistryRaw);
  } catch (err) {
    throw new Error(
      `[app-api] Invalid JSON in settlement-swap-paths.json at "${settlementSwapPathRegistryPath}": ${redactSensitiveText(err instanceof Error ? err.message : String(err))}`,
    );
  }
  const settlementSwapPathRegistryEntries = parseSettlementSwapPathRegistryJson(
    settlementSwapPathRegistryJson,
    network,
  );
  const simulateProbePoolId = settlementSwapPathRegistryEntries[0].poolId;

  // ── 4. Trusted proxy hops validation ─────────────────────────────────────
  const trustedProxyHops = resolveTrustedProxyHopsForBoot({
    trustedProxyHops: environment.TRUSTED_PROXY_HOPS,
    nodeEnv: environment.NODE_ENV,
  });

  // ── 5. Prepare in-flight validation ──────────────────────────────────
  const prepareInflightCapacityOverride = parseOptionalPositiveIntegerEnv(
    'PREPARE_INFLIGHT_CAPACITY',
    environment.PREPARE_INFLIGHT_CAPACITY,
  );
  const quotedHostFeeMist = parseHostFeeEnv(environment.HOST_FEE_MIST);

  // ── 6. Sponsor Refill Account validation ───────────────────────────────────────────
  const sponsorRefillAccountSecretKey = environment.SPONSOR_REFILL_ACCOUNT_SECRET_KEY?.trim();
  if (!sponsorRefillAccountSecretKey) {
    throw new Error(
      '[app-api] Missing required environment variable: SPONSOR_REFILL_ACCOUNT_SECRET_KEY. ' +
        'Sponsor Refill Account must be a dedicated key separate from sponsor keys.',
    );
  }
  const sponsorRefillAccountKey = parseSponsorKey(
    sponsorRefillAccountSecretKey,
    'SPONSOR_REFILL_ACCOUNT_SECRET_KEY',
  );

  // ── 7. Refill validation ─────────────────────────────────────────────────
  const refillEnabled =
    parseOptionalBooleanEnv(
      'SPONSOR_OPERATIONS_REFILL_ENABLED',
      environment.SPONSOR_OPERATIONS_REFILL_ENABLED,
    ) ?? false;
  const warnMist =
    parseOptionalPositiveBigIntEnv(
      'SPONSOR_BALANCE_WARN_MIST',
      environment.SPONSOR_BALANCE_WARN_MIST,
    ) ?? SPONSOR_BALANCE_WARN_MIST;
  const refillTargetMist = parseOptionalPositiveBigIntEnv(
    'SPONSOR_BALANCE_REFILL_TARGET_MIST',
    environment.SPONSOR_BALANCE_REFILL_TARGET_MIST,
  );
  if (refillEnabled && refillTargetMist == null) {
    throw new Error(
      '[app-api] SPONSOR_BALANCE_REFILL_TARGET_MIST is required when ' +
        'SPONSOR_OPERATIONS_REFILL_ENABLED=true',
    );
  }
  if (refillTargetMist != null && refillTargetMist <= warnMist) {
    throw new Error(
      '[app-api] SPONSOR_BALANCE_REFILL_TARGET_MIST must be greater than ' +
        `SPONSOR_BALANCE_WARN_MIST (${warnMist.toString()} MIST)`,
    );
  }
  const sponsorRefillAccountRunwayTargetMist =
    refillTargetMist ?? SPONSOR_BALANCE_REFILL_TARGET_MIST;

  const parseRequiredSponsorOperationsTimeout = (name: string, raw: string | undefined): number => {
    if (raw === undefined || raw === '') {
      throw new Error(
        `[app-api] ${name} is required (see docs/parameters.md Sponsor Operations settings)`,
      );
    }
    return parseRequiredPositiveIntegerEnv(name, raw);
  };
  const slotBalanceTimeoutMs = parseRequiredSponsorOperationsTimeout(
    'SPONSOR_OPERATIONS_SLOT_BALANCE_TIMEOUT_MS',
    environment.SPONSOR_OPERATIONS_SLOT_BALANCE_TIMEOUT_MS,
  );
  const sponsorRefillAccountBalanceTimeoutMs = parseRequiredSponsorOperationsTimeout(
    'SPONSOR_OPERATIONS_SPONSOR_REFILL_ACCOUNT_BALANCE_TIMEOUT_MS',
    environment.SPONSOR_OPERATIONS_SPONSOR_REFILL_ACCOUNT_BALANCE_TIMEOUT_MS,
  );
  const refillTimeoutMs = parseRequiredSponsorOperationsTimeout(
    'SPONSOR_OPERATIONS_REFILL_TIMEOUT_MS',
    environment.SPONSOR_OPERATIONS_REFILL_TIMEOUT_MS,
  );
  const confirmationTimeoutMs = parseRequiredSponsorOperationsTimeout(
    'SPONSOR_OPERATIONS_CONFIRMATION_TIMEOUT_MS',
    environment.SPONSOR_OPERATIONS_CONFIRMATION_TIMEOUT_MS,
  );

  // ── 8. Address constraint validation ─────────────────────────────────────
  const sponsorKeys = parseSponsorKeys(requireBootEnv('SPONSOR_SECRET_KEY'));
  const prepareInflightCapacity = prepareInflightCapacityOverride ?? sponsorKeys.length * 2;
  const sponsorAddrs = sponsorKeys.map((kp) => kp.toSuiAddress());
  const recipientAddr = canonicalizeAddress(
    requireBootEnv('SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS'),
    'SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS',
  );
  const sponsorRefillAccountAddress = sponsorRefillAccountKey.toSuiAddress();
  validateAddressConstraints({
    sponsorAddresses: sponsorAddrs,
    settlementPayoutRecipientAddress: recipientAddr,
    sponsorRefillAccountAddress: sponsorRefillAccountAddress,
  });

  // ── 9. Admin env validation ──────────────────────────────────────────────
  const adminAddrRaw = environment.ADMIN_ADDRESS?.trim();
  let adminAddress: string | null = null;
  if (adminAddrRaw) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(adminAddrRaw)) {
      throw new Error(
        '[app-api] ADMIN_ADDRESS must be a valid Sui address (0x + 64 hex characters)',
      );
    }
    adminAddress = canonicalizeAddress(adminAddrRaw, 'ADMIN_ADDRESS');
    // Sponsor refill account != Admin Address constraint
    if (sponsorRefillAccountAddress === adminAddress) {
      throw new Error(
        '[app-api] SPONSOR_REFILL_ACCOUNT_SECRET_KEY address must differ from ADMIN_ADDRESS. ' +
          'Sponsor Refill Account and Admin must be separate identities.',
      );
    }
  }
  const adminJwtSecret = environment.ADMIN_JWT_SECRET?.trim() || null;
  if (adminJwtSecret) {
    if (adminJwtSecret.length < 32) {
      throw new Error('[app-api] ADMIN_JWT_SECRET must be at least 32 characters');
    }
  }
  const adminSessionExpiry = environment.ADMIN_SESSION_EXPIRY?.trim() || '1h';
  const adminSessionMaxAgeSeconds = parseDuration(adminSessionExpiry);
  const withdrawalReceiptTtlMs = adminSessionMaxAgeSeconds * 1_000;
  if (!Number.isSafeInteger(withdrawalReceiptTtlMs)) {
    throw new Error('[app-api] ADMIN_SESSION_EXPIRY is too large for withdrawal receipt TTL');
  }
  const cookieDomain = parseCookieDomain(environment.COOKIE_DOMAIN);
  const adminAuth: AdminAuthRuntimeConfig = {
    jwt: adminJwtSecret
      ? {
          jwtSecret: adminJwtSecret,
          sessionExpiry: adminSessionExpiry,
          issuer: 'app-api',
        }
      : null,
    cookie: {
      maxAgeSeconds: adminSessionMaxAgeSeconds,
      secure: environment.NODE_ENV === 'production',
      domain: cookieDomain,
    },
  };

  const corsAllowedOrigins = parseCorsAllowedOrigins(environment.CORS_ORIGINS);

  // ── 10. Redis connectivity + admin not_before key ────────────────────
  const redis = await createRedisClient(redisUrl);
  try {
    await raiseAppApiAdminSessionNotBefore(createAdminRedisAdapter(redis), Date.now());
  } finally {
    await redis.dispose();
  }

  // ── 10a. Load RPC fleet + validate chain identity ─────────────────────────
  const rpcEndpoints = loadRpcConfig(network, undefined, (name) => environment[name]);

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
        rejected
          .map((r) => `${redactEndpointUrl(r.url)}: ${safeErrorSummary(r.reason)}`)
          .join('; '),
    );
  }
  if (verified.length === 0) {
    throw new Error('[app-api] No usable RPC endpoints after verification.');
  }
  // eslint-disable-next-line no-console
  console.log(
    `[app-api] Sui RPC: ${verified.length}/${rpcEndpoints.length} endpoint(s) verified — ` +
      verified.map((ep) => redactEndpointUrl(ep.url)).join(', '),
  );

  const {
    client: suiClient,
    primaryClient: primarySuiClient,
    failoverTransport,
  } = createSuiClient({
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
  const studioEnvPresent = studioEnvKeys.every((k) => !!environment[k]?.trim());
  let studioRuntimeInput: ContextRuntimeInput['studio'] = null;

  if (studioEnvPresent) {
    // STUDIO_ALLOWED_TARGETS — comma-separated pkg::mod::fn, at least one entry
    const targetsRaw = requireBootEnv('STUDIO_ALLOWED_TARGETS');
    const targets = targetsRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (targets.length === 0) {
      throw new Error(
        '[app-api] STUDIO_ALLOWED_TARGETS must contain at least one pkg::mod::fn entry',
      );
    }
    // Canonicalize once at boot. Runtime policies compare these exact strings.
    const allowedTargets = new Set<string>();
    for (const t of targets) {
      let canonicalTarget: string;
      try {
        canonicalTarget = canonicalizePromotionTarget(t);
      } catch (error) {
        throw new Error(
          `[app-api] STUDIO_ALLOWED_TARGETS entry "${t}" is invalid: ${redactSensitiveText(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
      }
      if (allowedTargets.has(canonicalTarget)) {
        throw new Error(
          `[app-api] STUDIO_ALLOWED_TARGETS contains duplicate entry after canonicalization: "${t}"`,
        );
      }
      allowedTargets.add(canonicalTarget);
    }

    // STUDIO_DEVELOPER_JWT_TRUST_JSON — parsed and validated at boot (single issuer object)
    const trustJson = requireBootEnv('STUDIO_DEVELOPER_JWT_TRUST_JSON');
    const developerJwtTrustConfig = parseDeveloperJwtTrustConfig(trustJson);

    // STUDIO_DEVELOPER_JWT_VERIFY_URL — optional developer-side validity callback
    const verifyUrl = environment.STUDIO_DEVELOPER_JWT_VERIFY_URL?.trim() || null;
    if (verifyUrl) {
      try {
        const parsed = new URL(verifyUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('must be http or https');
        }
      } catch (e) {
        throw new Error(
          `[app-api] STUDIO_DEVELOPER_JWT_VERIFY_URL is not a valid URL: "${redactEndpointUrl(verifyUrl)}" — ${redactSensitiveText(e instanceof Error ? e.message : String(e))}`,
        );
      }
    }

    studioRuntimeInput = {
      globalAllowedTargets: allowedTargets,
      developerJwtTrustConfig,
      developerJwtVerifyUrl: verifyUrl,
    };
  }

  const studioEnabled = studioEnvPresent;
  const mode: BootSummary['mode'] = studioEnabled ? 'dual' : 'generic';
  // eslint-disable-next-line no-console
  console.log(`[app-api] Boot validation complete — mode: ${formatRuntimeMode(mode)}`);

  return {
    runtimeInput: {
      context: {
        redisUrl,
        network,
        contractIds: {
          packageId: contractIds!.packageId,
          configId: contractIds!.configId,
          vaultRegistryId: contractIds!.vaultRegistryId,
        },
        deepbookPackageId: deepbookIds!.packageId,
        suiClient,
        primarySuiClient,
        failoverTransport,
        settlementSwapPathRegistryEntries,
        sponsorKeys,
        sponsorLeaseHmacSecret: leaseHmacSecret,
        settlementPayoutRecipientAddress: recipientAddr,
        quotedHostFeeMist,
        prepareInflightCapacity,
        sponsorOperations: {
          sponsorRefillAccountKey,
          sponsorRefillAccountAddress,
          refillEnabled,
          refillTargetMist: refillTargetMist ?? null,
          runwayTargetMist: sponsorRefillAccountRunwayTargetMist,
          warnMist,
          slotBalanceTimeoutMs,
          sponsorRefillAccountBalanceTimeoutMs,
          refillTimeoutMs,
          confirmationTimeoutMs,
          withdrawalReceiptTtlMs,
        },
        studio: studioRuntimeInput,
      },
      trustedProxyHops,
      corsAllowedOrigins,
      adminAddress,
      adminAuth,
      adminSponsorOperations: {
        refillEnabled,
        refillTargetMist: sponsorRefillAccountRunwayTargetMist,
        warnMist,
      },
    },
    publicSummary: {
      mode,
      studioEnabled,
      network,
    },
  };
}
