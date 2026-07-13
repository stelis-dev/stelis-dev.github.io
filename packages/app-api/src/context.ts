/**
 * [app-api] Runtime context creation.
 *
 * Creates a HostContext (generic) or StudioHostContext (dual mode)
 * using Redis-backed stores for multi-instance runtime operation.
 *
 * Shared references:
 *   - createHostContext → @stelis/core-api
 *   - resolvePrepareConfig → @stelis/core-api/prepareConfig
 *   - Redis store adapters → @stelis/core-api (RedisPrepareStore, RedisSponsorPool, etc.)
 *   - Studio adapters → @stelis/core-api/studio
 *   - Sponsor operations → app-api/src/sponsor-operations/{bootstrap,redisState,sponsorResultStateUpdater,refillWorker,gate}
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
  RedisPrepareStore,
  RedisSponsorPool,
  RedisRateLimiter,
  RedisAbuseBlocker,
  RedisPrepareInflight,
  RedisPrepareRequestNonceStore,
  type HostContext,
  type PreparedTxEntry,
} from '@stelis/core-api';
import { createSponsorOperationsRefillWorker } from './sponsor-operations/refillWorker.js';
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
import { bootstrapSponsorOperations } from './sponsor-operations/bootstrap.js';
import type { SponsorAvailabilityView } from './sponsor-operations/gate.js';
import { probeAndWriteSponsorRefillAccountState } from './sponsor-operations/sponsorRefillAccountProbe.js';
import {
  createPrepareSettlementSwapPathDescriptorMap,
  resolvePrepareConfig,
} from '@stelis/core-api/prepareConfig';
import {
  logStructuredEvent,
  PREPARE_STORE_EVICT_CLEANUP_FAILED,
  PREPARE_STORE_EVICT_CLEANUP_THREW,
} from '@stelis/core-api/observability';
import type { StudioHostContext, DeveloperJwtTrustConfig } from '@stelis/core-api/studio';
import { RedisPromotionStore } from '@stelis/core-api/studio';
import type {
  PromotionStoreAdapter,
  PromotionUsageStoreAdapter,
  PromotionExecutionLedger,
} from '@stelis/core-api/studio';
import { RedisPromotionUsageStore, RedisPromotionExecutionLedger } from '@stelis/core-api/studio';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createRedisClient, type RedisClient } from './redisClient.js';
import {
  resolveSettlementSwapPathRegistry,
  type ParsedSettlementSwapPathRegistryEntry,
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
   * Canonical STUDIO_ALLOWED_TARGETS entries from the boot snapshot.
   * Used for global MoveCall target policy enforcement at prepare/sponsor time.
   * null in generic-only mode.
   */
  studioGlobalAllowedTargets: ReadonlySet<string> | null;
  /** Parsed developer JWT trust config for studio auth. null in generic-only mode. */
  developerJwtTrustConfig: DeveloperJwtTrustConfig | null;
  /** Optional developer-side JWT validity callback URL. null if not configured. */
  developerJwtVerifyUrl: string | null;
  /** Failover transport — always present for admin RPC fleet snapshots. */
  failoverTransport: import('./sui/failoverTransport.js').SuiRpcFailoverTransport;
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
 * admin `/api/sponsor-operations` calls `probeSponsorRefillAccount()` before
 * reading so its response reflects a freshly observed sponsor refill account balance.
 */
export interface AppSponsorOperations {
  /** Read the current shared state for every slot and the sponsor refill account. */
  readState(): Promise<SponsorAvailabilityView>;
  /**
   * Awaited dashboard probe. It rejects when the observation cannot be
   * committed, so `/api/sponsor-operations` never labels stale data as fresh.
   */
  probeSponsorRefillAccount(): Promise<void>;
  /** Enqueue a refill request on this instance's refill worker. */
  requestRefill(slotAddress: string): void;
  /** Execute an admin-authorized withdrawal through the shared account spend flow. */
  withdraw(input: {
    readonly destinationAddress: string;
    readonly amountMist: string;
    readonly nonceKey: string;
  }): Promise<SponsorRefillAccountSpendResult>;
  /** Slot addresses, exposed so admin route can render per-slot entries. */
  readonly slotAddresses: readonly string[];
  /** Sponsor refill account address, exposed for admin display. */
  readonly sponsorRefillAccountAddress: string;
  dispose(): void;
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
  readonly suiClient: SuiGrpcClient;
  /** Primary-pinned client used only by the serialized Sponsor Refill Account spend flow. */
  readonly primarySuiClient: SuiGrpcClient;
  readonly failoverTransport: import('./sui/failoverTransport.js').SuiRpcFailoverTransport;
  readonly settlementSwapPathRegistryEntries: readonly ParsedSettlementSwapPathRegistryEntry[];
  readonly sponsorKeys: readonly Ed25519Keypair[];
  readonly sponsorLeaseHmacSecret: string;
  readonly settlementPayoutRecipientAddress: string;
  readonly quotedHostFeeMist: bigint;
  readonly prepareInflightCapacity: number;
  readonly sponsorOperations: {
    readonly sponsorRefillAccountKey: Ed25519Keypair;
    readonly sponsorRefillAccountAddress: string;
    readonly refillEnabled: boolean;
    readonly refillTargetMist: bigint | null;
    readonly runwayTargetMist: bigint;
    readonly warnMist: bigint;
    readonly slotBalanceTimeoutMs: number;
    readonly sponsorRefillAccountBalanceTimeoutMs: number;
    readonly refillTimeoutMs: number;
    readonly confirmationTimeoutMs: number;
    /** Accepted withdrawal outcomes remain replayable for the authenticated admin session. */
    readonly withdrawalReceiptTtlMs: number;
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
  let sponsorOperationsForCleanup: AppSponsorOperations | null = null;

  try {
    // ── 2. Network + Contract IDs ───────────────────────────────────
    const network = input.network;
    const contractIds = input.contractIds;

    // ── 3. Sponsor keys ─────────────────────────────────────────────
    const sponsorKeys = [...input.sponsorKeys];
    // `RedisSponsorPool` fences slot signing with
    // `HMAC(secret, receiptId || sponsorAddress || commitDigest)`
    // where `commitDigest` is `":reserved"` at `checkout()` and the
    // `hash(txBytes)` committed at `SponsorPool.commit()` (called
    // right before `prepareStore.store()`). `sign()` then verifies
    // the committed proof against the hash of the submitted `txBytes`,
    // so a Redis-only attacker who overwrites `entry[receiptId].txBytesHash`
    // under a live committed lease still cannot reach `sign()` — the
    // stored HMAC references the original commit digest.
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
    // RedisPrepareStore(client, onRelease, options?, onEntryEvict?)
    // ExecutionLedger is bound after the prepareStore callback is wired,
    // so use a late-bound reference for evict callback.
    let _executionLedgerRef: PromotionExecutionLedger | null = null;
    const prepareStore = new RedisPrepareStore(
      redis,
      (sponsorAddress: string, receiptId: string, txBytesHash: string | null) =>
        sponsorPool.checkin(sponsorAddress, receiptId, txBytesHash),
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
    const suiClient = input.suiClient;
    const settlementSwapPaths = await resolveSettlementSwapPathRegistry(
      suiClient,
      input.deepbookPackageId,
      input.settlementSwapPathRegistryEntries,
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
    host = createHostContext({
      network,
      suiRpcUrl: '', // Not used when suiClient is provided
      suiClient,
      packageId: contractIds.packageId,
      configId: contractIds.configId,
      vaultRegistryId: contractIds.vaultRegistryId,
      // DeepBook published storage/call-target ID used by quote and PTB paths.
      // MoveAbort classification uses the distinct compiled runtime identity.
      deepbookPackageId: input.deepbookPackageId,
      settlementPayoutRecipientAddress: input.settlementPayoutRecipientAddress,
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

    // The admin session cutoff is raised in boot.ts only (not here).
    // createApp eagerly awaits context initialization. Raising it here would
    // still create a second authority for session invalidation.

    // ── 10. Sponsor Refill Account + SponsorOperations ───────────────────────────────
    const sponsorRefillAccountKey = input.sponsorOperations.sponsorRefillAccountKey;
    const sponsorRefillAccountAddress = input.sponsorOperations.sponsorRefillAccountAddress;
    const sponsorAddresses = sponsorPool.addresses();

    const {
      refillEnabled,
      refillTargetMist,
      runwayTargetMist,
      warnMist,
      slotBalanceTimeoutMs,
      sponsorRefillAccountBalanceTimeoutMs,
      refillTimeoutMs,
      confirmationTimeoutMs,
      withdrawalReceiptTtlMs,
    } = input.sponsorOperations;

    // ── 8b. Redis-shared sponsor operations state store ───────────────
    // Single writer path for slot + sponsor refill account operational state. All writes go through
    // the Lua update script; callers supply only caller-owned fields.
    const sponsorOperationsState = createRedisSponsorOperationsState({
      client: redis,
      slotAddresses: sponsorAddresses,
    });

    const sponsorRefillAccountSpendState = createSponsorRefillAccountSpendState(redis, {
      network,
      acceptedReceiptTtlMs: withdrawalReceiptTtlMs,
    });

    // The lock is only a dispatch-efficiency mutex. Durable active-spend identity
    // and CAS transitions remain authoritative after its TTL expires.
    const sponsorRefillAccountDispatchLock = createSponsorRefillAccountDispatchLock({
      client: redis,
      ttlMs: refillTimeoutMs + SPONSOR_OPERATIONS_REFILL_LOCK_SAFETY_MARGIN_MS,
    });
    const spendCoordinator = createSponsorRefillAccountSpendCoordinator({
      state: sponsorRefillAccountSpendState,
      operationsState: sponsorOperationsState,
      dispatchLock: sponsorRefillAccountDispatchLock,
      boundary: createSuiSponsorRefillAccountSpendBoundary({
        sui: input.primarySuiClient,
        signer: sponsorRefillAccountKey,
        sourceAddress: sponsorRefillAccountAddress,
      }),
      network,
      sourceAddress: sponsorRefillAccountAddress,
      sponsorSlotCount: sponsorAddresses.length,
      refillEnabled,
      refillTargetMist,
      runwayTargetMist,
      warnThresholdMist: warnMist,
      dispatchTimeoutMs: refillTimeoutMs,
      balanceTimeoutMs: sponsorRefillAccountBalanceTimeoutMs,
      confirmationTimeoutMs,
    });

    // Recover durable transaction identity before any general balance observation
    // can overwrite its account or slot projection.
    const recoveredSpend = await spendCoordinator.recoverActiveSpend();
    if (recoveredSpend?.status === 'pending') {
      throw new Error(
        `Sponsor Refill Account active spend recovery pending: ${recoveredSpend.error}`,
      );
    }

    // ── 8c. Bootstrap sync — seed slot + sponsor refill account state before listen
    // Populates every slot + sponsor refill account HASH before HTTP listen. Redis write
    // failure here throws, matching the existing `admin:not_before`
    // fail-fast boot pattern via the outer try/catch below. Chain RPC
    // failure for an individual slot or sponsor refill account is written as `rpc_unreachable`
    // / `healthy=0` and boot continues.
    await bootstrapSponsorOperations({
      sui: host.sui,
      state: sponsorOperationsState,
      spendState: sponsorRefillAccountSpendState,
      slotAddresses: sponsorAddresses,
      sponsorRefillAccountAddress: sponsorRefillAccountAddress,
      warnThresholdMist: warnMist,
      refillTargetMist: refillTargetMist ?? null,
      slotBalanceTimeoutMs,
      sponsorRefillAccountBalanceTimeoutMs,
    });

    // ── 8e. Refill worker — Redis-shared state + distributed locks ───
    const refillWorker = createSponsorOperationsRefillWorker({
      state: sponsorOperationsState,
      spendCoordinator,
      retryDelayMs: confirmationTimeoutMs,
    });

    // ── 8f. Sponsor result callback — action-driven slot and sponsor refill account writes
    // Passes the refill worker's `requestRefill` in so a slot that
    // newly writes `low_balance` in steady state immediately nudges the
    // worker instead of waiting for a periodic sweep.
    const sponsorResultStateUpdater = createSponsorResultStateUpdater({
      sui: host.sui,
      state: sponsorOperationsState,
      spendState: sponsorRefillAccountSpendState,
      sponsorRefillAccountAddress: sponsorRefillAccountAddress,
      settlementPayoutRecipientAddress: host.settlementPayoutRecipientAddress,
      slotBalanceTimeoutMs,
      sponsorRefillAccountBalanceTimeoutMs,
      warnThresholdMist: warnMist,
      refillTargetMist: refillTargetMist ?? null,
      onSlotStateChanged: (slotAddress, state) => {
        if (refillEnabled && state === 'low_balance') {
          refillWorker.requestObservedSlotRefill(slotAddress);
        }
      },
      onSponsorRefillAccountObserved: () => {
        if (!refillEnabled) return;
        return refillWorker.requestEligibleRefills();
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

    // Use the stored source balance to queue low slots and runway failures
    // whose exact threshold is satisfied. An unthresholded terminal failure
    // has no balance-based recovery proof and remains explicit operator work.
    if (refillEnabled) {
      await refillWorker.requestEligibleRefills();
    }

    // ── 8g. Sponsor refill account bounded probe helper for admin reads and withdraws
    const probeHostRef = host;
    async function probeSponsorRefillAccount(): Promise<void> {
      const balance = await probeAndWriteSponsorRefillAccountState(
        {
          sui: probeHostRef.sui,
          spendState: sponsorRefillAccountSpendState,
          sponsorRefillAccountAddress: sponsorRefillAccountAddress,
          refillTargetMist: refillTargetMist ?? null,
          sponsorRefillAccountBalanceTimeoutMs,
        },
        {
          operation: 'sponsorOperations.probeSponsorRefillAccount',
          source: 'admin_sponsor_operations_sponsor_refill_account_update',
          writeFailureMode: 'throw',
        },
      );
      if (refillEnabled && balance !== null) {
        await refillWorker.requestEligibleRefills();
      }
    }

    const sponsorOperations: AppSponsorOperations = {
      readState: () => sponsorOperationsState.readAll(),
      probeSponsorRefillAccount,
      requestRefill: (slotAddress) => refillWorker.requestRefill(slotAddress),
      withdraw: (withdrawInput) => spendCoordinator.withdraw(withdrawInput),
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
    const studioEnabled = input.studio !== null;

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
    let promotionStore: PromotionStoreAdapter | null = null;
    let usageStore: PromotionUsageStoreAdapter | null = null;
    let executionLedger: PromotionExecutionLedger | null = null;
    if (studioEnabled) {
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
      studioGlobalAllowedTargets,
      developerJwtTrustConfig,
      developerJwtVerifyUrl,
      failoverTransport: input.failoverTransport,
      redis,
      sponsorOperations: sponsorOperationsRef,
      sponsoredLogsStore,
      async dispose() {
        executionLedger?.dispose();
        hostRef.dispose();
        sponsorOperationsRef.dispose();
        await redis.dispose();
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
