/**
 * [app-api] Runtime context creation — host-layer singleton.
 *
 * Creates and caches a HostContext (generic) or StudioHostContext (dual mode)
 * using Redis-backed stores for multi-instance runtime operation.
 *
 * Shared references:
 *   - createHostContext → @stelis/core-api
 *   - resolvePrepareConfig, parseHostFeeEnv → @stelis/core-api/prepareConfig
 *   - Redis store adapters → @stelis/core-api (RedisPrepareStore, RedisSponsorPool, etc.)
 *   - Studio adapters → @stelis/core-api/studio
 *   - Sponsor operations → app-api/src/sponsor-operations/{bootstrap,redisState,sponsorResultStateUpdater,refillWorker,gate}
 *
 * Ownership rules:
 *   - process.env reads, Redis lifecycle, singleton → app-api (this file)
 *   - domain factories, store interfaces → core-api
 *
 * Race condition prevention:
 *   Uses _ctxPromise (not _ctx) so concurrent cold-start requests share
 *   the same initialization promise.
 */
import {
  createHostContext,
  parseSponsorKey,
  parseSponsorKeys,
  RedisPrepareStore,
  RedisSponsorPool,
  RedisRateLimiter,
  RedisAbuseBlocker,
  RedisPrepareInflight,
  RedisPrepareRequestNonceStore,
  type HostContext,
  type PreparedTxEntry,
} from '@stelis/core-api';
import { STELIS_CONTRACT_IDS, DEEPBOOK_IDS } from '@stelis/contracts';
import { executeSponsorSlotRefill } from './sponsor-operations/executeRefill.js';
import { createSponsorOperationsRefillWorker } from './sponsor-operations/refillWorker.js';
import { SPONSOR_BALANCE_WARN_MIST } from './sponsor-operations/defaults.js';
import { createRedisSponsorOperationsState } from './sponsor-operations/redisState.js';
import { createSponsorResultStateUpdater } from './sponsor-operations/sponsorResultStateUpdater.js';
import { RedisSponsoredLogsStore } from './sponsoredLogs/redisStore.js';
import { createSponsoredLogsRecorder, fanOutSponsorResult } from './sponsoredLogs/recorder.js';
import {
  createRefillLock,
  createSponsorRefillAccountDispatchLock,
} from './sponsor-operations/refillLock.js';
import { bootstrapSponsorOperations } from './sponsor-operations/bootstrap.js';
import type { SponsorAvailabilityView } from './sponsor-operations/gate.js';
import { probeAndWriteSponsorRefillAccountState } from './sponsor-operations/sponsorRefillAccountProbe.js';
import { parseChainBalanceMist } from './sponsor-operations/balanceParsing.js';
import {
  createPrepareSettlementSwapPathDescriptorMap,
  resolvePrepareConfig,
  parseHostFeeEnv,
} from '@stelis/core-api/prepareConfig';
import {
  logStructuredEvent,
  PREPARE_STORE_EVICT_CLEANUP_FAILED,
  PREPARE_STORE_EVICT_CLEANUP_THREW,
} from '@stelis/core-api/observability';
import type { StudioHostContext, DeveloperJwtTrustConfig } from '@stelis/core-api/studio';
import {
  RedisPromotionStore,
  hashTargets,
  parseDeveloperJwtTrustConfig,
} from '@stelis/core-api/studio';
import type {
  PromotionStoreAdapter,
  PromotionUsageStoreAdapter,
  PromotionExecutionLedger,
} from '@stelis/core-api/studio';
import { RedisPromotionUsageStore, RedisPromotionExecutionLedger } from '@stelis/core-api/studio';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  requireEnv,
  parseOptionalBooleanEnv,
  parseOptionalPositiveBigIntEnv,
  parseOptionalPositiveIntegerEnv,
  parseRequiredPositiveIntegerEnv,
} from './env.js';
import { createRedisClient, type RedisClient } from './redisClient.js';
import {
  getSettlementSwapPathRegistryPath,
  loadSettlementSwapPathRegistry,
} from './settlementSwapPathRegistry.js';

const APP_API_RATE_LIMIT_WINDOW_MS = 60_000;
const APP_API_RATE_LIMIT_MAX_REQUESTS = 20;
const SPONSOR_OPERATIONS_REFILL_LOCK_SAFETY_MARGIN_MS = 5_000;

// ── Exported context interface ──────────────────────────────────────────

export interface AppApiContext {
  /** Base Host context (always available) */
  host: HostContext;
  /** Prepare handler config (always available — generic + studio) */
  prepareConfig: import('@stelis/core-api').PrepareHandlerConfig;
  /** Studio context (only in dual mode — null in generic-only) */
  studio: StudioHostContext | null;

  /** Promotion registry store — null in generic-only */
  promotionStore: PromotionStoreAdapter | null;
  /** Promotion usage/event store — null in generic-only */
  usageStore: PromotionUsageStoreAdapter | null;
  /** Unified execution ledger — null in generic-only */
  executionLedger: PromotionExecutionLedger | null;
  /**
   * Pre-computed sha256 hex hashes of STUDIO_ALLOWED_TARGETS entries.
   * Used for global MoveCall target policy enforcement at prepare/sponsor time.
   * null in generic-only mode.
   */
  studioGlobalTargetHashes: Set<string> | null;
  /** Parsed developer JWT trust config for studio auth. null in generic-only mode. */
  developerJwtTrustConfig: DeveloperJwtTrustConfig | null;
  /** Optional developer-side JWT validity callback URL. null if not configured. */
  developerJwtVerifyUrl: string | null;
  /** Failover transport — always present for admin RPC fleet snapshots. */
  failoverTransport: import('./sui/failoverTransport.js').SuiRpcFailoverTransport;
  /** Configured endpoint URLs (safe for admin — no auth metadata). */
  rpcEndpointUrls: string[];
  /** Redis client (for admin, rate-limit, etc.) */
  redis: RedisClient;
  /** Sponsor operations runtime — shared-state reader + sponsor refill account probe + refill queue. */
  sponsorOperations: AppSponsorOperations;
  /**
   * Sponsored execution recorder store. Owns recent log + lifetime
   * aggregate. Admin route reads via `getSummary()` / `getRecent()`;
   * sponsor SponsoredExecutionPolicy Release hooks write via the recorder callback wired into
   * `host.onSponsorResult`.
   */
  sponsoredLogsStore: import('./sponsoredLogs/store.js').SponsoredLogsStoreAdapter;
  /** Release all resources */
  dispose(): Promise<void>;
}

/**
 * Minimal context-level sponsor operations API for routes and admin. Composes the
 * Redis-shared state store, refill worker, and sponsor refill account probe helper. Routes read
 * the shared state via `readState()` and derive gate decisions on demand;
 * admin `/api/sponsor-operations` calls `probeSponsorRefillAccount('admin_sponsor_operations')` before
 * reading so its response reflects a freshly observed sponsor refill account balance.
 * Admin withdraw uses the same helper under the `admin_withdraw`
 * trigger after a successful on-chain transfer.
 */
export interface AppSponsorOperations {
  /** Read the current shared state for every slot and the sponsor refill account. */
  readState(): Promise<SponsorAvailabilityView>;
  /**
   * Awaited sponsor refill account trigger. `admin_sponsor_operations` rejects when the probe result
   * cannot be committed, so `/api/sponsor-operations` never serialises stale sponsor refill account data
   * as if it were fresh. `admin_withdraw` logs the same failure family
   * but resolves so a successful on-chain withdraw is not misreported
   * as a failed transaction.
   */
  probeSponsorRefillAccount(trigger: 'admin_sponsor_operations' | 'admin_withdraw'): Promise<void>;
  /** Enqueue a refill request on this instance's refill worker. */
  requestRefill(slotAddress: string): void;
  /** Slot addresses, exposed so admin route can render per-slot entries. */
  readonly slotAddresses: readonly string[];
  /** Sponsor refill account address, exposed for admin display. */
  readonly sponsorRefillAccountAddress: string;
  dispose(): void;
}

// ── Singleton (Promise-based to prevent race conditions) ─────────────

/**
 * Stores a Promise<AppApiContext> (not AppApiContext | null) so that:
 *   1. Initialization runs exactly once under concurrent cold-start.
 *   2. All parallel callers await the same promise.
 *   3. After resolution, subsequent calls return already-resolved promise.
 */
let _ctxPromise: Promise<AppApiContext> | null = null;

/**
 * Shared SuiGrpcClient injected by boot. Must be set before getCtx() is called.
 * This ensures boot probe, settlement swap path registry load, and relay context all use the
 * same multi-endpoint client and endpoint selection path.
 */
let _sharedSuiClient: SuiGrpcClient | null = null;
let _sharedFailoverTransport: import('./sui/failoverTransport.js').SuiRpcFailoverTransport | null =
  null;
let _sharedRpcEndpointUrls: string[] = [];

/** Set the shared Sui client, transport, and endpoint URLs from boot result. Call once before getCtx(). */
export function setSharedSuiClient(
  client: SuiGrpcClient,
  failoverTransport: import('./sui/failoverTransport.js').SuiRpcFailoverTransport,
  rpcEndpointUrls: string[],
): void {
  _sharedSuiClient = client;
  _sharedFailoverTransport = failoverTransport;
  _sharedRpcEndpointUrls = rpcEndpointUrls;
}

/**
 * Lazily creates and caches the runtime context.
 * Must only be called after boot validation has passed.
 */
export async function getCtx(): Promise<AppApiContext> {
  if (!_sharedSuiClient || !_sharedFailoverTransport) {
    throw new Error(
      '[app-api] Shared Sui client not set. Call setSharedSuiClient() from boot before getCtx().',
    );
  }
  if (!_ctxPromise) {
    _ctxPromise = initContext().catch((err) => {
      // Reset on failure so next call retries instead of returning stale rejection
      _ctxPromise = null;
      throw err;
    });
  }
  return _ctxPromise;
}

/**
 * Internal initialization — creates all resources.
 * Wrapped in try/catch for resource cleanup on partial failure.
 */
async function initContext(): Promise<AppApiContext> {
  // ── 1. Redis ──────────────────────────────────────────────────────
  const redis = await createRedisClient(requireEnv('REDIS_URL'));

  // Track disposable resources for cleanup on partial failure
  let host: HostContext | null = null;
  let sponsorOperationsForCleanup: AppSponsorOperations | null = null;

  try {
    // ── 2. Network + Contract IDs ───────────────────────────────────
    const network = requireEnv('NETWORK') as 'testnet' | 'mainnet';
    const contractIds = STELIS_CONTRACT_IDS[network]!;
    const deepbookIds = DEEPBOOK_IDS[network]!;

    // ── 3. Sponsor keys ─────────────────────────────────────────────
    const sponsorKeys = parseSponsorKeys(requireEnv('SPONSOR_SECRET_KEY'));
    // `RedisSponsorPool` fences slot signing with
    // `HMAC(secret, receiptId || slotId || commitDigest)`
    // where `commitDigest` is `":reserved"` at `checkout()` and the
    // `hash(txBytes)` committed at `SponsorPool.commit()` (called
    // right before `prepareStore.store()`). `sign()` then verifies
    // the committed proof against the hash of the submitted `txBytes`,
    // so a Redis-only attacker who overwrites `entry[receiptId].txBytesHash`
    // under a live committed lease still cannot reach `sign()` — the
    // stored HMAC references the original commit digest.
    //
    // Boot validation has already enforced `SPONSOR_LEASE_HMAC_SECRET`
    // (≥32 chars); this read exposes the value so the pool can
    // bind it to the HMAC helper. The secret lives in process env
    // only — never in Redis, never in logs, never in prepare entries.
    const sponsorLeaseHmacSecret = requireEnv('SPONSOR_LEASE_HMAC_SECRET');
    const sponsorPool = new RedisSponsorPool(redis, sponsorKeys, {
      hmacSecret: sponsorLeaseHmacSecret,
    });

    // ── 4. Store adapters (Redis-backed for production) ─────────────
    // RedisPrepareStore(client, onRelease, options?, onEntryEvict?)
    // ExecutionLedger is bound after the prepareStore callback is wired,
    // so use a late-bound reference for evict callback.
    let _executionLedgerRef: PromotionExecutionLedger | null = null;
    const prepareStore = new RedisPrepareStore(
      redis,
      (slotId: string, receiptId: string, txBytesHash: string | null) =>
        sponsorPool.checkin(slotId, receiptId, txBytesHash),
      {},
      (entry: PreparedTxEntry) => {
        // Best-effort promotion execution ledger release for promotion entries evicted by TTL/IP overflow.
        if (entry.mode === 'promotion' && _executionLedgerRef) {
          void _executionLedgerRef
            .release(entry.receiptId)
            .then((result) => {
              if (!result.ok) {
                logStructuredEvent(
                  PREPARE_STORE_EVICT_CLEANUP_FAILED,
                  {
                    receiptId: entry.receiptId,
                    releaseFailureReason: result.reason,
                  },
                  'warn',
                );
              }
            })
            .catch(() => {
              logStructuredEvent(
                PREPARE_STORE_EVICT_CLEANUP_THREW,
                {
                  receiptId: entry.receiptId,
                },
                'warn',
              );
            });
        }
      },
    );
    const rateLimiter = new RedisRateLimiter(redis, {
      windowMs: APP_API_RATE_LIMIT_WINDOW_MS,
      maxRequests: APP_API_RATE_LIMIT_MAX_REQUESTS,
    });
    const abuseBlocker = new RedisAbuseBlocker(redis);
    const prepareRequestNonceStore = new RedisPrepareRequestNonceStore(redis);

    // ── 5. Settlement swap path registry (on-chain derivation) ──────
    // _sharedSuiClient is guaranteed non-null here — getCtx() checks before calling initContext().
    const suiClient = _sharedSuiClient!;
    const settlementSwapPathRegistryPath = getSettlementSwapPathRegistryPath();
    const settlementSwapPaths = await loadSettlementSwapPathRegistry(
      suiClient,
      deepbookIds.packageId,
      settlementSwapPathRegistryPath,
      network,
    );
    const settlementSwapPathDescriptors =
      createPrepareSettlementSwapPathDescriptorMap(settlementSwapPaths);
    // eslint-disable-next-line no-console
    console.log(
      `[app-api] Settlement swap path registry loaded: ${settlementSwapPaths.length} path(s) — ` +
        settlementSwapPaths.map((p) => p.settlementTokenSymbol).join(', '),
    );

    // ── 6. PrepareConfig ────────────────────────────────────────────
    const prepareConfig = resolvePrepareConfig({
      settlementSwapPaths,
      descriptors: settlementSwapPathDescriptors,
      deepbookPackageId: deepbookIds.packageId,
      quotedHostFeeMist: parseHostFeeEnv(process.env.HOST_FEE_MIST),
    });

    // ── 7. Prepare in-flight limiter (Redis-backed, shared across app instances) ──
    // Explicit injection — official runtime must not fall back to
    // MemoryPrepareInflight. The default preserves the existing
    // sponsor-slot-based capacity heuristic.
    const prepareInflightCapacity =
      parseOptionalPositiveIntegerEnv(
        'PREPARE_INFLIGHT_CAPACITY',
        process.env.PREPARE_INFLIGHT_CAPACITY,
      ) ?? sponsorPool.size * 2;
    const prepareInflightLimiter = new RedisPrepareInflight(redis, prepareInflightCapacity);

    // ── 8. Create base HostContext ───────────────────────────────
    host = createHostContext({
      network,
      suiRpcUrl: '', // Not used when suiClient is provided
      suiClient,
      packageId: contractIds.packageId,
      configId: contractIds.configId,
      vaultRegistryId: contractIds.vaultRegistryId,
      // Server-only trust-root for sponsor-time DeepBook abort
      // classification. Same package ID (`DEEPBOOK_IDS[network].packageId`) as
      // `prepareConfig.deepbookPackageId` above; both are wired from the
      // shared contract constants without env override or synthetic
      // default.
      deepbookPackageId: deepbookIds.packageId,
      settlementPayoutRecipientAddress: requireEnv('SETTLEMENT_PAYOUT_RECIPIENT_ADDRESS'),
      sponsorPool,
      prepareStore,
      prepareRequestNonceStore,
      rateLimiter,
      abuseBlocker,
      prepareInflightLimiter,
      allowedSettlementSwapPaths: prepareConfig.allowedSettlementSwapPaths,
    });

    // ── 9. Warm up (fail-closed) ────────────────────────────────────
    await host.warmUp();

    // NOTE: NOT_BEFORE_KEY is set in boot.ts only (not here).
    // Context init is lazy (first request) — re-setting not_before here
    // would invalidate admin sessions issued between boot and first relay request.

    // ── 10. Sponsor Refill Account + SponsorOperations ───────────────────────────────
    const sponsorRefillAccountKey = parseSponsorKey(
      requireEnv('SPONSOR_REFILL_ACCOUNT_SECRET_KEY'),
      'SPONSOR_REFILL_ACCOUNT_SECRET_KEY',
    );
    const sponsorRefillAccountAddress = sponsorRefillAccountKey.toSuiAddress();
    const sponsorAddresses = sponsorPool.addresses();

    const refillEnabled =
      parseOptionalBooleanEnv(
        'SPONSOR_OPERATIONS_REFILL_ENABLED',
        process.env.SPONSOR_OPERATIONS_REFILL_ENABLED,
      ) ?? false;
    const refillTargetMist = parseOptionalPositiveBigIntEnv(
      'SPONSOR_BALANCE_REFILL_TARGET_MIST',
      process.env.SPONSOR_BALANCE_REFILL_TARGET_MIST,
    );
    const warnMist =
      parseOptionalPositiveBigIntEnv(
        'SPONSOR_BALANCE_WARN_MIST',
        process.env.SPONSOR_BALANCE_WARN_MIST,
      ) ?? SPONSOR_BALANCE_WARN_MIST;

    // Strict-injection env: four SPONSOR_OPERATIONS_*_MS budgets are required with no
    // code-side default. `docs/parameters.md` documents them as deployment-
    // defined required env values, so operators choose them at deploy time and
    // boot fails closed if any variable is missing or invalid.
    const parseRequiredPosIntEnv = (name: string, raw: string | undefined): number => {
      if (raw === undefined || raw === '') {
        throw new Error(
          `[app-api] ${name} is required (see docs/parameters.md Sponsor Operations settings)`,
        );
      }
      return parseRequiredPositiveIntegerEnv(name, raw);
    };
    const slotBalanceTimeoutMs = parseRequiredPosIntEnv(
      'SPONSOR_OPERATIONS_SLOT_BALANCE_TIMEOUT_MS',
      process.env.SPONSOR_OPERATIONS_SLOT_BALANCE_TIMEOUT_MS,
    );
    const sponsorRefillAccountBalanceTimeoutMs = parseRequiredPosIntEnv(
      'SPONSOR_OPERATIONS_SPONSOR_REFILL_ACCOUNT_BALANCE_TIMEOUT_MS',
      process.env.SPONSOR_OPERATIONS_SPONSOR_REFILL_ACCOUNT_BALANCE_TIMEOUT_MS,
    );
    const refillTimeoutMs = parseRequiredPosIntEnv(
      'SPONSOR_OPERATIONS_REFILL_TIMEOUT_MS',
      process.env.SPONSOR_OPERATIONS_REFILL_TIMEOUT_MS,
    );
    const confirmationTimeoutMs = parseRequiredPosIntEnv(
      'SPONSOR_OPERATIONS_CONFIRMATION_TIMEOUT_MS',
      process.env.SPONSOR_OPERATIONS_CONFIRMATION_TIMEOUT_MS,
    );

    // ── 8b. Redis-shared sponsor operations state store ───────────────
    // Single writer path for slot + sponsor refill account operational state. All writes go through
    // the Lua update script; callers supply only caller-owned fields.
    const sponsorOperationsState = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: sponsorAddresses,
    });

    // ── 8c. Bootstrap sync — seed slot + sponsor refill account state before listen
    // Populates every slot + sponsor refill account HASH before HTTP listen. Redis write
    // failure here throws, matching the existing `admin:not_before`
    // fail-fast boot pattern via the outer try/catch below. Chain RPC
    // failure for an individual slot or sponsor refill account is written as `rpc_unreachable`
    // / `healthy=0` and boot continues.
    await bootstrapSponsorOperations({
      sui: host.sui,
      state: sponsorOperationsState,
      slotAddresses: sponsorAddresses,
      sponsorRefillAccountAddress: sponsorRefillAccountAddress,
      warnThresholdMist: warnMist,
      refillTargetMist: refillTargetMist ?? null,
      slotBalanceTimeoutMs,
      sponsorRefillAccountBalanceTimeoutMs,
    });

    // ── 8d. Refill distributed locks ─────────────────────────────────
    // Slot lock TTL covers refill dispatch, post-refill sponsor refill account probe, awaiting
    // confirmation, and the documented safety margin. Orphaned locks
    // after process death recover at TTL expiry.
    const refillLockTtlMs =
      refillTimeoutMs +
      sponsorRefillAccountBalanceTimeoutMs +
      confirmationTimeoutMs +
      SPONSOR_OPERATIONS_REFILL_LOCK_SAFETY_MARGIN_MS;
    const refillLock = createRefillLock({
      client: redis,
      ttlMs: refillLockTtlMs,
    });
    // Dispatch lock TTL covers only the account-scoped refill TX dispatch
    // budget plus the safety margin. It prevents two app-api instances from
    // using the same sponsor refill account signer/gas source concurrently.
    const sponsorRefillAccountDispatchLock = createSponsorRefillAccountDispatchLock({
      client: redis,
      ttlMs: refillTimeoutMs + SPONSOR_OPERATIONS_REFILL_LOCK_SAFETY_MARGIN_MS,
    });

    // ── 8e. Refill worker — Redis-shared state + distributed locks ───
    const hostRefForSponsorOperations = host;
    const refillWorker = createSponsorOperationsRefillWorker({
      state: sponsorOperationsState,
      refillLock,
      sponsorRefillAccountDispatchLock,
      sui: host.sui,
      sponsorRefillAccountAddress: sponsorRefillAccountAddress,
      warnThresholdMist: warnMist,
      refillTargetMist: refillTargetMist ?? null,
      refillTimeoutMs,
      confirmationTimeoutMs,
      sponsorRefillAccountBalanceTimeoutMs,
      executeRefill: async (slotAddress: string, amountMist: bigint) => {
        if (!refillEnabled || refillTargetMist == null) {
          throw new Error('refill disabled or target not configured');
        }
        return await executeSponsorSlotRefill({
          sui: hostRefForSponsorOperations.sui,
          signer: sponsorRefillAccountKey,
          sponsorAddress: slotAddress,
          amountMist,
        });
      },
      getSlotBalance: async (slotAddress: string) => {
        const res = await hostRefForSponsorOperations.sui.getBalance({ owner: slotAddress });
        return parseChainBalanceMist(res.balance.balance, `Slot ${slotAddress} balance`);
      },
    });

    // ── 8f. Sponsor result callback — action-driven slot and sponsor refill account writes
    // Passes the refill worker's `requestRefill` in so a slot that
    // newly writes `low_balance` in steady state immediately nudges the
    // worker instead of waiting for a periodic sweep.
    const sponsorResultStateUpdater = createSponsorResultStateUpdater({
      sui: host.sui,
      state: sponsorOperationsState,
      sponsorRefillAccountAddress: sponsorRefillAccountAddress,
      settlementPayoutRecipientAddress: host.settlementPayoutRecipientAddress,
      slotBalanceTimeoutMs,
      sponsorRefillAccountBalanceTimeoutMs,
      warnThresholdMist: warnMist,
      refillTargetMist: refillTargetMist ?? null,
      onSlotStateChanged: (slotAddress, state) => {
        if (state === 'low_balance') {
          refillWorker.requestRefill(slotAddress);
        }
      },
    });
    // ── 8g. Sponsored execution recorder ───────────────────────────────
    // Owns the durable recent-log + lifetime-aggregate projections used
    // by the admin Dashboard / Sponsored Logs page. Composed alongside the
    // sponsor operations state callback via a fan-out wrapper so both run from
    // the single `HostRuntimeConfig.onSponsorResult` slot.
    const sponsoredLogsStore = new RedisSponsoredLogsStore(redis);
    const sponsoredLogsRecorder = createSponsoredLogsRecorder({
      store: sponsoredLogsStore,
    });

    // Assigned before studio spread (further down) so both `host` and
    // `studio` routes see the callback. HTTP listen has not started yet.
    host.onSponsorResult = fanOutSponsorResult(sponsorResultStateUpdater, sponsoredLogsRecorder);

    // Bootstrap may have written `low_balance` / `refill_failed` for a
    // slot that entered with a depleted balance. Queue those on process
    // start here; steady-state terminal-callback requeue only covers a
    // later `low_balance` observation.
    if (refillEnabled) {
      const { slots } = await sponsorOperationsState.readAll();
      for (const slot of slots) {
        if (slot.state === 'low_balance' || slot.state === 'refill_failed') {
          refillWorker.requestRefill(slot.address);
        }
      }
    }

    // ── 8g. Sponsor refill account bounded probe helper for admin reads and withdraws
    const probeHostRef = host;
    async function probeSponsorRefillAccount(
      trigger: 'admin_sponsor_operations' | 'admin_withdraw',
    ): Promise<void> {
      await probeAndWriteSponsorRefillAccountState(
        {
          sui: probeHostRef.sui,
          state: sponsorOperationsState,
          sponsorRefillAccountAddress: sponsorRefillAccountAddress,
          refillTargetMist: refillTargetMist ?? null,
          sponsorRefillAccountBalanceTimeoutMs,
        },
        {
          operation:
            trigger === 'admin_sponsor_operations'
              ? 'sponsorOperations.probeSponsorRefillAccount'
              : 'sponsorOperations.probeSponsorRefillAccountAfterWithdraw',
          source:
            trigger === 'admin_sponsor_operations'
              ? 'admin_sponsor_operations_sponsor_refill_account_update'
              : 'admin_withdraw_sponsor_refill_account_update',
          writeFailureMode: trigger === 'admin_sponsor_operations' ? 'throw' : 'swallow',
        },
      );
    }

    const sponsorOperations: AppSponsorOperations = {
      readState: () => sponsorOperationsState.readAll(),
      probeSponsorRefillAccount,
      requestRefill: (slotAddress) => refillWorker.requestRefill(slotAddress),
      slotAddresses: sponsorAddresses,
      sponsorRefillAccountAddress: sponsorRefillAccountAddress,
      dispose: () => {
        refillWorker.dispose();
      },
    };
    sponsorOperationsForCleanup = sponsorOperations;

    // ── 9. Studio context ────────────────────────────────────────────
    // Studio auth uses developer JWT trust (STUDIO_DEVELOPER_JWT_TRUST_JSON).
    let studio: StudioHostContext | null = null;
    const studioEnvComplete = [
      'ADMIN_JWT_SECRET',
      'ADMIN_ADDRESS',
      'STUDIO_ALLOWED_TARGETS',
      'STUDIO_DEVELOPER_JWT_TRUST_JSON',
    ].every((k) => !!process.env[k]?.trim());

    if (studioEnvComplete) {
      studio = {
        ...host,
        prepareConfig,
      };

      // eslint-disable-next-line no-console
      console.log('[app-api] Studio context created (dual mode)');
    }

    // ── 9b2. Global target policy hash set ────────────────────────────
    // Pre-compute sha256 hashes of STUDIO_ALLOWED_TARGETS entries at boot.
    // Used by Studio prepare/sponsor sponsored execution policies for global MoveCall target enforcement.
    let studioGlobalTargetHashes: Set<string> | null = null;
    if (studioEnvComplete) {
      const rawTargets = requireEnv('STUDIO_ALLOWED_TARGETS')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      studioGlobalTargetHashes = new Set(hashTargets(rawTargets));
    }

    // ── 9b3. Developer JWT trust config ───────────────────────────────
    let developerJwtTrustConfig: DeveloperJwtTrustConfig | null = null;
    let developerJwtVerifyUrl: string | null = null;
    if (studioEnvComplete) {
      const trustJsonEnv = process.env.STUDIO_DEVELOPER_JWT_TRUST_JSON?.trim();
      if (trustJsonEnv) {
        developerJwtTrustConfig = parseDeveloperJwtTrustConfig(trustJsonEnv);
      }
      developerJwtVerifyUrl = process.env.STUDIO_DEVELOPER_JWT_VERIFY_URL?.trim() || null;
    }

    // ── 9. Promotion stores ──────────────────────────────────────────
    let promotionStore: PromotionStoreAdapter | null = null;
    let usageStore: PromotionUsageStoreAdapter | null = null;
    let executionLedger: PromotionExecutionLedger | null = null;
    if (studioEnvComplete) {
      const redisPromotionStore = new RedisPromotionStore(redis);
      promotionStore = redisPromotionStore;
      usageStore = new RedisPromotionUsageStore(redis);
      // Pass the canonical promotion record key shape from the store
      // into the ledger so the claim Lua can re-read `status` atomically
      // and close the admin-pause/archive race window between
      // `promotionStore.get()` and the claim CAS. The key shape
      // stays owned by `RedisPromotionStore.recordKey`.
      executionLedger = new RedisPromotionExecutionLedger(
        redis,
        undefined,
        undefined,
        undefined,
        (promotionId) => redisPromotionStore.recordKey(promotionId),
      );
      // Late-bind executionLedger ref for the prepareStore eviction callback.
      _executionLedgerRef = executionLedger;
    }

    // ── 10. Assemble ────────────────────────────────────────────────
    const hostRef = host;
    const sponsorOperationsRef = sponsorOperations;
    return {
      host: hostRef,
      prepareConfig,
      studio,
      promotionStore,
      usageStore,
      executionLedger,
      studioGlobalTargetHashes,
      developerJwtTrustConfig,
      developerJwtVerifyUrl,
      failoverTransport: _sharedFailoverTransport!,
      rpcEndpointUrls: _sharedRpcEndpointUrls,
      redis,
      sponsorOperations: sponsorOperationsRef,
      sponsoredLogsStore,
      async dispose() {
        executionLedger?.dispose();
        hostRef.dispose();
        sponsorOperationsRef.dispose();
        await redis.dispose();
        _ctxPromise = null;
      },
    };
  } catch (err) {
    // Cleanup all acquired resources on partial initialization failure
    sponsorOperationsForCleanup?.dispose();
    host?.dispose();
    await redis.dispose();
    throw err;
  }
}

/** Reset context — for testing. */
export function resetCtx(): void {
  _ctxPromise = null;
}
