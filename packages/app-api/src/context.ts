/**
 * [app-api] Runtime context creation.
 *
 * Creates a HostContext (generic) or StudioHostContext (dual mode)
 * using Redis-backed stores for multi-instance runtime operation.
 *
 * Shared references:
 *   - createHostContext → @stelis/core-api
 *   - resolvePrepareConfig → @stelis/core-api/prepareConfig
 *   - Redis store adapters → @stelis/core-api
 *   - Studio adapters → @stelis/core-api/studio
 *   - Sponsor operations → app-api/src/sponsor-operations/{bootstrap,redisState,sponsorResultStateUpdater,reconciliationScheduler,gate}
 *
 * Ownership rules:
 *   - process.env and config-file reads → boot.ts
 *   - Redis lifecycle and runtime assembly → app-api (this file)
 *   - domain factories, store interfaces → core-api
 *
 * createApp owns the single context promise and injects it into routes.
 */
import {
  createHostContext,
  RedisSponsoredExecutionStore,
  sponsoredExecutionPreparedRecordKeyPrefix,
  SponsoredExecutionRecovery,
  RedisSponsorPool,
  RedisRateLimiter,
  RedisAbuseBlocker,
  RedisPrepareInflight,
  RedisPrepareRequestNonceStore,
  type HostContext,
  type HostChainState,
  type AbuseBlockStore,
  type SponsorResultCallback,
} from '@stelis/core-api';
import type { SingleHopSettlementSwapPath, SuiRpcFleetStatus } from '@stelis/contracts';
import {
  SUI_OPERATION_ATTEMPT_TIMEOUT_MS,
  type ChainBoundSuiEndpointSnapshot,
} from '@stelis/core-relay';
import { createRedisSponsorOperationsState } from './sponsor-operations/redisState.js';
import { createSponsorRefillAccountSpendState } from './sponsor-operations/accountSpendState.js';
import {
  createSponsorRefillAccountSpendCoordinator,
  createSuiSponsorRefillAccountSpendBoundary,
  type SponsorRefillAccountSpendResult,
} from './sponsor-operations/accountSpend.js';
import { createSponsorResultStateUpdater } from './sponsor-operations/sponsorResultStateUpdater.js';
import { RedisSponsoredLogsStore } from './sponsoredLogs/redisStore.js';
import { createSponsoredLogsRecorder, fanOutSponsorResult } from './sponsoredLogs/recorder.js';
import { createSponsorRefillAccountDispatchLock } from './sponsor-operations/refillLock.js';
import { observeSponsorOperationsBalances } from './sponsor-operations/bootstrap.js';
import { isSponsorSlotAvailable, type SponsorAvailabilityView } from './sponsor-operations/gate.js';
import type { SponsorOperationsSettings } from './sponsor-operations/settings.js';
import {
  createSponsorOperationsTaskScheduler,
  type SponsorOperationsTaskScheduler,
  type SponsorOperationsWithdrawalInput,
} from './sponsor-operations/reconciliationScheduler.js';
import { resolvePrepareConfig } from '@stelis/core-api/prepareConfig';
import type { StudioHostContext, DeveloperJwtTrustConfig } from '@stelis/core-api/studio';
import { RedisPromotionStore } from '@stelis/core-api/studio';
import type { PromotionStoreAdapter, PromotionExecutionLedger } from '@stelis/core-api/studio';
import { RedisPromotionExecutionLedger } from '@stelis/core-api/studio';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createRedisClient, type RedisClient } from './redisClient.js';

const APP_API_RATE_LIMIT_WINDOW_MS = 60_000;
const APP_API_RATE_LIMIT_MAX_REQUESTS = 20;

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
  /** Unified execution ledger — null in generic-only */
  executionLedger: PromotionExecutionLedger | null;
  /**
   * Canonical STUDIO_ALLOWED_TARGETS entries from the boot snapshot.
   * Used for global MoveCall target policy enforcement at prepare/sponsor time.
   * null in generic-only mode.
   */
  studioGlobalAllowedTargets: ReadonlySet<string> | null;
  /** Parsed developer JWT trust config for studio auth. null in generic-only mode. */
  developerJwtTrustConfig: DeveloperJwtTrustConfig | null;
  /** Optional developer-side JWT validity callback URL. null if not configured. */
  developerJwtVerifyUrl: string | null;
  /** Immutable public view of the boot-qualified RPC fleet. */
  rpcFleet: Readonly<SuiRpcFleetStatus>;
  /** Redis client (for admin, rate-limit, etc.) */
  redis: RedisClient;
  /** Single abuse block store shared by Host enforcement and Admin operations. */
  abuseStore: AbuseBlockStore;
  /** Sponsor operations runtime — shared-state reader, refill-account probe, and spend coordinator. */
  sponsorOperations: AppSponsorOperations;
  /**
   * Sponsored execution recorder store. Owns recent log + lifetime
   * aggregate. Admin route reads via `getSummary()` / `getRecent()`;
   * the persisted final receipt callback writes through `host.onSponsorResult`.
   */
  sponsoredLogsStore: import('./sponsoredLogs/store.js').SponsoredLogsStoreAdapter;
  /** Release all resources */
  dispose(): Promise<void>;
}

/**
 * Minimal context-level sponsor operations API for routes and admin. Composes the
 * Redis-shared state store, spend coordinator, and retained balance observation. Routes read
 * the shared state via `readState()` and derive gate decisions on demand;
 * admin `/api/sponsor-operations` calls `observeBalances()` before reading so
 * its response reflects the latest bounded observation pass.
 */
export interface AppSponsorOperations {
  /** The one normalized settings value used by runtime and Admin projections. */
  readonly settings: SponsorOperationsSettings;
  /** Read the current shared state for every slot and the sponsor refill account. */
  readState(): Promise<SponsorAvailabilityView>;
  /**
   * Awaited dashboard observation. It rejects when the observation cannot be
   * committed, so `/api/sponsor-operations` never labels stale data as fresh.
   */
  observeBalances(): Promise<void>;
  /** Execute an admin-authorized withdrawal through the shared account spend flow. */
  withdraw(input: SponsorOperationsWithdrawalInput): Promise<SponsorRefillAccountSpendResult>;
  /** Slot addresses, exposed so admin route can render per-slot entries. */
  readonly slotAddresses: readonly string[];
  /** Sponsor refill account address, exposed for admin display. */
  readonly sponsorRefillAccountAddress: string;
  dispose(): Promise<void>;
}

export interface ContextRuntimeInput {
  readonly redisUrl: string;
  readonly network: 'testnet' | 'mainnet';
  readonly contractIds: {
    readonly packageId: string;
    readonly configId: string;
    readonly vaultRegistryId: string;
  };
  readonly deepbookPackageId: string;
  readonly sui: ChainBoundSuiEndpointSnapshot;
  readonly rpcFleet: Readonly<SuiRpcFleetStatus>;
  readonly initialHostChainState: HostChainState;
  readonly settlementSwapPaths: readonly SingleHopSettlementSwapPath[];
  readonly sponsorKeys: readonly Ed25519Keypair[];
  readonly sponsorLeaseHmacSecret: string;
  readonly settlementPayoutRecipientAddress: string;
  readonly quotedHostFeeMist: bigint;
  readonly prepareInflightCapacity: number;
  readonly sponsorOperations: {
    readonly sponsorRefillAccountKey: Ed25519Keypair;
    readonly settings: SponsorOperationsSettings;
  };
  readonly studio: {
    readonly globalAllowedTargets: ReadonlySet<string>;
    readonly developerJwtTrustConfig: DeveloperJwtTrustConfig;
    readonly developerJwtVerifyUrl: string | null;
  } | null;
}

/**
 * Internal initialization — creates all resources.
 * Wrapped in try/catch for resource cleanup on partial failure.
 */
export async function createContext(input: ContextRuntimeInput): Promise<AppApiContext> {
  // ── 1. Redis ──────────────────────────────────────────────────────
  const redis = await createRedisClient(input.redisUrl);

  // Track disposable resources for cleanup on partial failure
  let host: HostContext | null = null;
  let abuseStoreForCleanup: AbuseBlockStore | null = null;
  let executionLedgerForCleanup: PromotionExecutionLedger | null = null;
  let sponsorOperationsForCleanup: AppSponsorOperations | null = null;
  let sponsorOperationsTaskSchedulerForCleanup: SponsorOperationsTaskScheduler | null = null;
  let sponsoredExecutionRecoveryForCleanup: SponsoredExecutionRecovery | null = null;

  try {
    // ── 2. Network + Contract IDs ───────────────────────────────────
    const network = input.network;
    const contractIds = input.contractIds;

    // ── 3. Sponsor keys ─────────────────────────────────────────────
    const sponsorKeys = [...input.sponsorKeys];
    // `RedisSponsorPool` fences slot signing with stage-separated HMAC proofs:
    // reserved binds receipt + sponsor, committed additionally binds the
    // validated transaction-bytes hash, and executing additionally binds the
    // Sui transaction digest. `sign()` verifies the committed proof against
    // the hash of the submitted `txBytes`,
    // so a Redis-only attacker who overwrites `entry[receiptId].txBytesHash`
    // under a live committed lease still cannot reach `sign()` — the
    // stored HMAC references the original transaction-bytes hash.
    //
    // Boot validation has already enforced `SPONSOR_LEASE_HMAC_SECRET`
    // (≥32 chars) and retained it only in the internal runtime input so
    // the pool can bind it to the HMAC helper. It is never returned by
    // createApp, stored in Redis, logged, or copied into prepare entries.
    const sponsorLeaseHmacSecret = input.sponsorLeaseHmacSecret;
    const sponsorPool = new RedisSponsorPool(redis, sponsorKeys, {
      hmacSecret: sponsorLeaseHmacSecret,
    });

    // ── 4. Store adapters (Redis-backed for production) ─────────────
    // RedisSponsoredExecutionStore owns prepared, executing, and final receipt state.
    // The Promotion ledger is created first because receipt transitions include
    // its reservation stage and final accounting.
    const studioEnabled = input.studio !== null;
    let promotionStore: PromotionStoreAdapter | null = null;
    let executionLedger: RedisPromotionExecutionLedger | null = null;
    if (studioEnabled) {
      const redisPromotionStore = new RedisPromotionStore(redis);
      promotionStore = redisPromotionStore;
      executionLedger = new RedisPromotionExecutionLedger(
        redis,
        redisPromotionStore,
        undefined,
        undefined,
        sponsoredExecutionPreparedRecordKeyPrefix(),
      );
      executionLedgerForCleanup = executionLedger;
    }
    const sponsoredExecutionStore = new RedisSponsoredExecutionStore(
      redis,
      sponsorPool,
      executionLedger ?? undefined,
    );
    const rateLimiter = new RedisRateLimiter(redis, {
      windowMs: APP_API_RATE_LIMIT_WINDOW_MS,
      maxRequests: APP_API_RATE_LIMIT_MAX_REQUESTS,
    });
    const abuseBlocker = new RedisAbuseBlocker(redis);
    abuseStoreForCleanup = abuseBlocker;
    const prepareRequestNonceStore = new RedisPrepareRequestNonceStore(redis);

    // ── 5. Consume the exact boot-qualified settlement swap paths ───
    const settlementSwapPaths = [...input.settlementSwapPaths];
    // eslint-disable-next-line no-console
    console.log(
      `[app-api] Settlement swap path registry ready: ${settlementSwapPaths.length} path(s) — ` +
        settlementSwapPaths.map((p) => p.settlementTokenSymbol).join(', '),
    );

    // ── 6. PrepareConfig ────────────────────────────────────────────
    const prepareConfig = resolvePrepareConfig({
      settlementSwapPaths,
      deepbookPackageId: input.deepbookPackageId,
      quotedHostFeeMist: input.quotedHostFeeMist,
    });

    // ── 7. Prepare in-flight limiter (Redis-backed, shared across app instances) ──
    // Explicit injection — official runtime must not fall back to
    // MemoryPrepareInflight. The default preserves the existing
    // sponsor-slot-based capacity heuristic.
    const prepareInflightCapacity = input.prepareInflightCapacity;
    const prepareInflightLimiter = new RedisPrepareInflight(redis, prepareInflightCapacity);

    // ── 8. Create base HostContext ───────────────────────────────
    // ── 10. Sponsor Refill Account + SponsorOperations ───────────────────────────────
    const sponsorRefillAccountKey = input.sponsorOperations.sponsorRefillAccountKey;
    const sponsorOperationsSettings = input.sponsorOperations.settings;
    const sponsorRefillAccountAddress = sponsorOperationsSettings.sponsorRefillAccountAddress;
    const sponsorAddresses = sponsorPool.addresses();
    if (
      sponsorAddresses.length !== sponsorOperationsSettings.sponsorAddresses.length ||
      sponsorAddresses.some(
        (address, index) => address !== sponsorOperationsSettings.sponsorAddresses[index],
      )
    ) {
      throw new Error('SponsorOperationsSettings sponsor addresses must match the sponsor keys');
    }

    // ── 8b. Redis-shared sponsor operations state store ───────────────
    // Single writer path for slot + sponsor refill account operational state. All writes go through
    // the Lua update script; callers supply only caller-owned fields.
    const sponsorOperationsState = createRedisSponsorOperationsState({
      client: redis,
      settings: sponsorOperationsSettings,
    });

    const sponsorRefillAccountSpendState = createSponsorRefillAccountSpendState(redis, {
      settings: sponsorOperationsSettings,
    });

    // The lock is only a dispatch-efficiency mutex. Durable active-spend identity
    // and CAS transitions remain authoritative after its TTL expires.
    const sponsorRefillAccountDispatchLock = createSponsorRefillAccountDispatchLock({
      client: redis,
      ttlMs: sponsorOperationsSettings.refillLockTtlMs,
    });
    const spendCoordinator = createSponsorRefillAccountSpendCoordinator({
      state: sponsorRefillAccountSpendState,
      operationsState: sponsorOperationsState,
      dispatchLock: sponsorRefillAccountDispatchLock,
      boundary: createSuiSponsorRefillAccountSpendBoundary({
        sui: input.sui,
        signer: sponsorRefillAccountKey,
        sourceAddress: sponsorRefillAccountAddress,
      }),
      settings: sponsorOperationsSettings,
    });

    // ── 8f. Sponsor result callback — action-driven slot and sponsor refill account writes
    // A slot that newly writes `low_balance` nudges the scheduler instead of
    // waiting for the next periodic eligibility read.
    const sponsorResultStateUpdater = createSponsorResultStateUpdater({
      sui: input.sui,
      state: sponsorOperationsState,
      spendState: sponsorRefillAccountSpendState,
      settings: sponsorOperationsSettings,
      onSlotStateChanged: (slotAddress, state) => {
        if (sponsorOperationsSettings.refillEnabled && state === 'low_balance') {
          sponsorOperationsTaskScheduler.requestObservedSlotRefill(slotAddress);
        }
      },
      onSponsorRefillAccountObserved: () => {
        if (!sponsorOperationsSettings.refillEnabled) return;
        void sponsorOperationsTaskScheduler.requestEligibleRefills().catch(() => {
          // The scheduler retains periodic observation and will retry this
          // best-effort eligibility nudge.
        });
      },
    });

    // One lifecycle owner retains every balance observation and account-spend
    // task. The immediate recovery and observation complete before HTTP listen.
    const sponsorOperationsTaskScheduler = createSponsorOperationsTaskScheduler({
      settings: sponsorOperationsSettings,
      state: sponsorOperationsState,
      spendCoordinator,
      observeBalances: (signal) =>
        observeSponsorOperationsBalances({
          sui: input.sui,
          state: sponsorOperationsState,
          spendState: sponsorRefillAccountSpendState,
          settings: sponsorOperationsSettings,
          signal,
        }),
      observeSponsorResult: sponsorResultStateUpdater,
    });
    sponsorOperationsTaskSchedulerForCleanup = sponsorOperationsTaskScheduler;
    await sponsorOperationsTaskScheduler.start();

    const retainedSponsorResultStateUpdater: SponsorResultCallback = (metadata, signal) =>
      sponsorOperationsTaskScheduler.observeSponsorResult(metadata, signal);
    // ── 8g. Sponsored execution recorder ───────────────────────────────
    // Owns the durable recent-log + lifetime-aggregate projections used
    // by the admin Dashboard / Sponsored Logs page. Composed alongside the
    // sponsor operations state callback via a fan-out wrapper so both run from
    // the single `createHostContext` onSponsorResult callback slot.
    const sponsoredLogsStore = new RedisSponsoredLogsStore(redis);
    const sponsoredLogsRecorder = createSponsoredLogsRecorder({
      store: sponsoredLogsStore,
    });

    // Assigned before studio spread (further down) so both `host` and
    // `studio` routes see the callback. HTTP listen has not started yet.
    const sponsorResultCallback = fanOutSponsorResult(
      retainedSponsorResultStateUpdater,
      sponsoredLogsRecorder,
    );
    host = createHostContext({
      network,
      sui: input.sui,
      packageId: contractIds.packageId,
      configId: contractIds.configId,
      vaultRegistryId: contractIds.vaultRegistryId,
      deepbookPackageId: input.deepbookPackageId,
      settlementPayoutRecipientAddress: input.settlementPayoutRecipientAddress,
      sponsorPool,
      isSponsorAddressAvailable: async (sponsorAddress) => {
        const slot = await sponsorOperationsState.readSlotAvailability(sponsorAddress);
        return slot !== null && isSponsorSlotAvailable(sponsorOperationsSettings, slot);
      },
      sponsoredExecutionStore,
      prepareRequestNonceStore,
      rateLimiter,
      abuseBlocker,
      prepareInflightLimiter,
      allowedSettlementSwapPaths: prepareConfig.allowedSettlementSwapPaths,
      initialChainState: input.initialHostChainState,
      onSponsorResult: sponsorResultCallback,
    });
    const sponsoredExecutionRecovery = new SponsoredExecutionRecovery({
      store: sponsoredExecutionStore,
      sui: input.sui,
      intervalMs: SUI_OPERATION_ATTEMPT_TIMEOUT_MS,
      onSponsorResult: sponsorResultCallback,
    });
    sponsoredExecutionRecoveryForCleanup = sponsoredExecutionRecovery;
    await sponsoredExecutionRecovery.start();

    const sponsorOperations: AppSponsorOperations = {
      settings: sponsorOperationsSettings,
      readState: () => sponsorOperationsState.readAll(),
      observeBalances: () => sponsorOperationsTaskScheduler.observeBalances(),
      withdraw: (withdrawInput) => sponsorOperationsTaskScheduler.withdraw(withdrawInput),
      slotAddresses: sponsorAddresses,
      sponsorRefillAccountAddress: sponsorRefillAccountAddress,
      async dispose() {
        await sponsorOperationsTaskScheduler.dispose();
      },
    };
    sponsorOperationsForCleanup = sponsorOperations;

    // ── 9. Studio context ────────────────────────────────────────────
    // Studio auth uses developer JWT trust (STUDIO_DEVELOPER_JWT_TRUST_JSON).
    let studio: StudioHostContext | null = null;
    if (studioEnabled) {
      studio = {
        ...host,
        prepareConfig,
      };

      // eslint-disable-next-line no-console
      console.log('[app-api] Studio context created (dual mode)');
    }

    // ── 9b2. Global target policy set ─────────────────────────────────
    // STUDIO_ALLOWED_TARGETS entries were canonicalized at boot.
    // Used by Studio prepare/sponsor sponsored execution policies for global MoveCall target enforcement.
    let studioGlobalAllowedTargets: ReadonlySet<string> | null = null;
    if (input.studio) studioGlobalAllowedTargets = input.studio.globalAllowedTargets;

    // ── 9b3. Developer JWT trust config ───────────────────────────────
    let developerJwtTrustConfig: DeveloperJwtTrustConfig | null = null;
    let developerJwtVerifyUrl: string | null = null;
    if (input.studio) {
      developerJwtTrustConfig = input.studio.developerJwtTrustConfig;
      developerJwtVerifyUrl = input.studio.developerJwtVerifyUrl;
    }

    // ── 9. Promotion stores ──────────────────────────────────────────
    // ── 10. Assemble ────────────────────────────────────────────────
    const hostRef = host;
    const sponsorOperationsRef = sponsorOperations;
    return {
      host: hostRef,
      prepareConfig,
      studio,
      promotionStore,
      executionLedger,
      studioGlobalAllowedTargets,
      developerJwtTrustConfig,
      developerJwtVerifyUrl,
      rpcFleet: input.rpcFleet,
      redis,
      abuseStore: abuseBlocker,
      sponsorOperations: sponsorOperationsRef,
      sponsoredLogsStore,
      async dispose() {
        await abuseBlocker.stop();
        await sponsoredExecutionRecovery.dispose();
        await sponsorOperationsRef.dispose();
        await executionLedger?.dispose();
        await hostRef.dispose();
        await redis.dispose();
      },
    };
  } catch (err) {
    // Cleanup all acquired resources on partial initialization failure
    await sponsoredExecutionRecoveryForCleanup?.dispose();
    if (sponsorOperationsForCleanup) {
      await sponsorOperationsForCleanup.dispose();
    } else {
      await sponsorOperationsTaskSchedulerForCleanup?.dispose();
    }
    await host?.dispose();
    await abuseStoreForCleanup?.stop();
    await executionLedgerForCleanup?.dispose();
    await redis.dispose();
    throw err;
  }
}
