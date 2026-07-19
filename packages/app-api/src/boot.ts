/**
 * [app-api] Boot/instrumentation — runs before the server starts.
 *
 * Validates all required env vars and the explicitly selected Host operating
 * mode. Runtime resources are created only after
 * every boot input and Sui endpoint has qualified.
 *
 * Shared references:
 *   - parseSponsorKey, parseSponsorKeys → @stelis/core-api
 *   - canonicalizeAddress, validateAddressConstraints → @stelis/core-api
 *   - parseTrustedProxyHops → @stelis/core-api
 *   - SPONSOR_BALANCE_WARN_MIST → ./sponsor-operations/defaults
 *   - STELIS_CONTRACT_IDS, DEEPBOOK_IDS, requireContractId → @stelis/contracts
 *
 * Admin session keyspace → stelis:app-api:admin:not_before
 * HOST_MODE is the only capability selector. Missing, forbidden, and partial
 * mode-specific configuration fails before runtime resources are created.
 */
import {
  parseSponsorKey,
  parseSponsorKeys,
  canonicalizeAddress,
  validateAddressConstraints,
  parseTrustedProxyHops,
  readHostChainState,
  type HostChainState,
} from '@stelis/core-api';
import {
  STELIS_CONTRACT_IDS,
  DEEPBOOK_IDS,
  HOST_OPERATING_MODES,
  isNodeTimerDelayMs,
  NODE_TIMER_MAX_DELAY_MS,
  requireContractId,
  type HostOperatingMode,
  type SingleHopSettlementSwapPath,
} from '@stelis/contracts';
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
import { loadRpcConfig } from './sui/parseEndpointConfig.js';
import { redactEndpointUrl, redactSensitiveText } from '@stelis/core-api/observability';
import { qualifySuiRpcEndpoints } from './sui/qualifiedSuiRpc.js';
import {
  getSettlementSwapPathRegistryPath,
  parseSettlementSwapPathRegistryJson,
  resolveSettlementSwapPathRegistry,
} from './settlementSwapPathRegistry.js';
import { canonicalizePromotionTarget, parseDeveloperJwtTrustConfig } from '@stelis/core-api/studio';
import { parseDuration } from '@stelis/core-api/admin';
import { parseHostFeeEnv } from '@stelis/core-api/prepareConfig';
import type {
  AdminContextRuntimeInput,
  ContextRuntimeInput,
  RelayOnlyContextRuntimeInput,
  RelayWithAdminAndStudioContextRuntimeInput,
  RelayWithAdminContextRuntimeInput,
} from './context.js';
import type { AdminAuthRuntimeConfig } from './adminAuth.js';
import { createSponsorOperationsSettings } from './sponsor-operations/settings.js';

/** Secret-bearing process input. This value never leaves ApplicationRuntime. */
interface AppRuntimeInputBase<TContext extends ContextRuntimeInput> {
  readonly context: TContext;
  readonly trustedProxyHops: number;
}

export type RelayOnlyAppRuntimeInput = AppRuntimeInputBase<RelayOnlyContextRuntimeInput>;

interface AdminAppRuntimeInputBase<
  TContext extends AdminContextRuntimeInput,
> extends AppRuntimeInputBase<TContext> {
  readonly adminAppOrigin: string | null;
  readonly adminAddress: string;
  readonly adminAuth: AdminAuthRuntimeConfig;
}

export type RelayWithAdminAppRuntimeInput =
  AdminAppRuntimeInputBase<RelayWithAdminContextRuntimeInput>;

export type RelayWithAdminAndStudioAppRuntimeInput =
  AdminAppRuntimeInputBase<RelayWithAdminAndStudioContextRuntimeInput>;

export type AdminAppRuntimeInput =
  | RelayWithAdminAppRuntimeInput
  | RelayWithAdminAndStudioAppRuntimeInput;

export type AppRuntimeInput = RelayOnlyAppRuntimeInput | AdminAppRuntimeInput;

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

function parseAdminAppOrigin(rawValue: string | undefined): string | null {
  const value = rawValue?.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      '[app-api] ADMIN_APP_ORIGIN must be one valid http(s) origin without credentials, path, query, or fragment',
    );
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
      '[app-api] ADMIN_APP_ORIGIN must be one valid http(s) origin without credentials, path, query, or fragment',
    );
  }
  return parsed.origin;
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
    throw new Error('[app-api] ADMIN_COOKIE_DOMAIN must be a valid DNS domain');
  }
  return value.toLowerCase();
}

/**
 * Runs all fail-fast boot validation. Must complete before accepting requests.
 *
 * Throws on any validation failure (fail-closed).
 */
export async function runBootValidation(signal?: AbortSignal): Promise<AppRuntimeInput> {
  // Capture before the first await. RPC auth variables referenced indirectly
  // from rpc.json use this same snapshot through the injected lookup below.
  const environment: Readonly<Record<string, string | undefined>> = { ...process.env };
  const requireBootEnv = (name: string): string => {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`[app-api] Missing required environment variable: ${name}`);
    return value;
  };

  const rawMode = environment.HOST_MODE?.trim();
  if (!rawMode) {
    throw new Error(
      `[app-api] HOST_MODE is required. Choose one of: ${HOST_OPERATING_MODES.join(', ')}`,
    );
  }
  if (!HOST_OPERATING_MODES.includes(rawMode as HostOperatingMode)) {
    throw new Error(
      `[app-api] HOST_MODE is invalid. Choose one of: ${HOST_OPERATING_MODES.join(', ')}`,
    );
  }
  const mode = rawMode as HostOperatingMode;

  const adminRequiredKeys = ['ADMIN_ADDRESS', 'ADMIN_JWT_SECRET'] as const;
  const adminOptionalKeys = [
    'ADMIN_APP_ORIGIN',
    'ADMIN_SESSION_EXPIRY',
    'ADMIN_COOKIE_DOMAIN',
  ] as const;
  const studioRequiredKeys = ['STUDIO_ALLOWED_TARGETS', 'STUDIO_DEVELOPER_JWT_TRUST_JSON'] as const;
  const studioOptionalKeys = ['STUDIO_DEVELOPER_JWT_VERIFY_URL'] as const;
  const allCapabilityKeys = [
    ...adminRequiredKeys,
    ...adminOptionalKeys,
    ...studioRequiredKeys,
    ...studioOptionalKeys,
  ] as const;
  const requiredKeys: readonly string[] =
    mode === 'relay_with_admin_and_studio'
      ? [...adminRequiredKeys, ...studioRequiredKeys]
      : mode === 'relay_with_admin'
        ? adminRequiredKeys
        : [];
  const allowedKeys: readonly string[] =
    mode === 'relay_with_admin_and_studio'
      ? allCapabilityKeys
      : mode === 'relay_with_admin'
        ? [...adminRequiredKeys, ...adminOptionalKeys]
        : [];
  const missing = requiredKeys.filter((name) => !environment[name]?.trim());
  const forbidden = allCapabilityKeys.filter(
    (name) => !!environment[name]?.trim() && !allowedKeys.includes(name),
  );
  if (missing.length > 0 || forbidden.length > 0) {
    const reasons = [
      ...(missing.length > 0 ? [`Missing: ${missing.join(', ')}`] : []),
      ...(forbidden.length > 0
        ? [`Not allowed for the selected HOST_MODE: ${forbidden.join(', ')}`]
        : []),
    ];
    throw new Error(`[app-api] HOST_MODE configuration is invalid. ${reasons.join('. ')}`);
  }

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
  // Early fail-fast for format issues. Full on-chain derivation is part of
  // each endpoint's actual boot qualification below.
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
    const value = parseRequiredPositiveIntegerEnv(name, raw);
    if (!isNodeTimerDelayMs(value)) {
      throw new Error(
        `[app-api] ${name} must be an integer from 1 through ${NODE_TIMER_MAX_DELAY_MS}`,
      );
    }
    return value;
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
  const reconciliationIntervalMs = parseRequiredSponsorOperationsTimeout(
    'SPONSOR_OPERATIONS_RECONCILIATION_INTERVAL_MS',
    environment.SPONSOR_OPERATIONS_RECONCILIATION_INTERVAL_MS,
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
  const adminAddrRaw = mode !== 'relay_only' ? requireBootEnv('ADMIN_ADDRESS') : undefined;
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
  const adminJwtSecret = mode !== 'relay_only' ? requireBootEnv('ADMIN_JWT_SECRET') : null;
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
  const cookieDomain = parseCookieDomain(environment.ADMIN_COOKIE_DOMAIN);
  const adminAuth: AdminAuthRuntimeConfig | null =
    mode !== 'relay_only'
      ? {
          jwt: {
            jwtSecret: adminJwtSecret!,
            sessionExpiry: adminSessionExpiry,
            issuer: 'app-api',
          },
          cookie: {
            maxAgeSeconds: adminSessionMaxAgeSeconds,
            secure: environment.NODE_ENV === 'production',
            domain: cookieDomain,
          },
        }
      : null;

  const sponsorOperationsSettings = createSponsorOperationsSettings({
    network,
    sponsorAddresses: sponsorAddrs,
    sponsorRefillAccountAddress,
    settlementPayoutRecipientAddress: recipientAddr,
    refillEnabled,
    refillTargetMist: refillTargetMist ?? null,
    runwayTargetMist: sponsorRefillAccountRunwayTargetMist,
    warnMist,
    slotBalanceTimeoutMs,
    sponsorRefillAccountBalanceTimeoutMs,
    refillTimeoutMs,
    confirmationTimeoutMs,
    reconciliationIntervalMs,
    withdrawalReceiptTtlMs,
  });

  const adminAppOrigin =
    mode !== 'relay_only' ? parseAdminAppOrigin(environment.ADMIN_APP_ORIGIN) : null;

  // ── 10. Studio configuration ────────────────────────────────────────────
  // Validate every local Studio input before any Sui endpoint qualification.
  let studioRuntimeInput:
    | Extract<ContextRuntimeInput, { readonly mode: 'relay_with_admin_and_studio' }>['studio']
    | null = null;

  if (mode === 'relay_with_admin_and_studio') {
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
        const loopbackHttpHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
        if (
          parsed.protocol !== 'https:' &&
          !(parsed.protocol === 'http:' && loopbackHttpHosts.has(parsed.hostname))
        ) {
          throw new Error('must use HTTPS, except for an exact loopback hostname');
        }
        if (parsed.username !== '' || parsed.password !== '') {
          throw new Error('must not contain embedded credentials');
        }
        if (parsed.hash !== '') {
          throw new Error('must not contain a fragment');
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

  // ── 11. Qualify the immutable Sui endpoint boundary ──────────────────────
  const rpcEndpoints = loadRpcConfig(network, undefined, (name) => environment[name]);
  const hostChainStateIds = Object.freeze({
    packageId: contractIds!.packageId,
    configId: contractIds!.configId,
    vaultRegistryId: contractIds!.vaultRegistryId,
  });
  const qualifiedSui = await qualifySuiRpcEndpoints<{
    readonly initialHostChainState: HostChainState;
    readonly settlementSwapPaths: readonly SingleHopSettlementSwapPath[];
  }>({
    network,
    endpoints: rpcEndpoints,
    signal,
    qualify: async ({ snapshot, signal }) => {
      const [initialHostChainState, settlementSwapPaths] = await Promise.all([
        readHostChainState(snapshot, hostChainStateIds, signal),
        resolveSettlementSwapPathRegistry(
          snapshot,
          deepbookIds!.packageId,
          settlementSwapPathRegistryEntries,
          signal,
        ),
      ]);
      return Object.freeze({
        initialHostChainState,
        settlementSwapPaths: Object.freeze([...settlementSwapPaths]),
      });
    },
  });
  if (qualifiedSui.rejected.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[app-api] RPC endpoint(s) excluded: ${qualifiedSui.rejected
        .map((endpoint) => `${endpoint.url}: ${endpoint.kind}`)
        .join('; ')}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `[app-api] Sui RPC: ${qualifiedSui.snapshot.endpointCount}/${rpcEndpoints.length} endpoint(s) qualified — ` +
      qualifiedSui.adminSnapshot.endpoints.map((endpoint) => endpoint.origin).join(', '),
  );
  const primaryQualification = qualifiedSui.primaryQualification;

  // eslint-disable-next-line no-console
  console.log(`[app-api] Boot validation complete — mode: ${mode}`);

  const contextBase = {
    redisUrl,
    network,
    contractIds: {
      packageId: contractIds!.packageId,
      configId: contractIds!.configId,
      vaultRegistryId: contractIds!.vaultRegistryId,
    },
    deepbookPackageId: deepbookIds!.packageId,
    sui: qualifiedSui.snapshot,
    initialHostChainState: primaryQualification.initialHostChainState,
    settlementSwapPaths: primaryQualification.settlementSwapPaths,
    sponsorKeys,
    sponsorLeaseHmacSecret: leaseHmacSecret,
    settlementPayoutRecipientAddress: recipientAddr,
    quotedHostFeeMist,
    prepareInflightCapacity,
    sponsorOperations: {
      sponsorRefillAccountKey,
      settings: sponsorOperationsSettings,
    },
  } as const;
  let runtimeInput: AppRuntimeInput;
  if (mode === 'relay_with_admin_and_studio') {
    runtimeInput = {
      context: {
        ...contextBase,
        mode,
        rpcFleet: qualifiedSui.adminSnapshot,
        studio: studioRuntimeInput!,
      },
      trustedProxyHops,
      adminAppOrigin,
      adminAddress: adminAddress!,
      adminAuth: adminAuth!,
    };
  } else if (mode === 'relay_with_admin') {
    runtimeInput = {
      context: {
        ...contextBase,
        mode,
        rpcFleet: qualifiedSui.adminSnapshot,
      },
      trustedProxyHops,
      adminAppOrigin,
      adminAddress: adminAddress!,
      adminAuth: adminAuth!,
    };
  } else {
    runtimeInput = {
      context: { ...contextBase, mode },
      trustedProxyHops,
    };
  }

  return runtimeInput;
}
