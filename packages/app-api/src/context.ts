/**
 * [app-api] Runtime context creation.
 *
 * Creates a HostContext for `relay_only` or `relay_and_studio` operation
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
 * ApplicationRuntime owns this context and injects it into routes.
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
import type {
  HostOperatingMode,
  SingleHopSettlementSwapPath,
  SuiRpcFleetStatus,
} from '@stelis/contracts';
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
import type { DeveloperJwtTrustConfig } from '@stelis/core-api/studio';
import { RedisPromotionStore } from '@stelis/core-api/studio';
import type { PromotionStoreAdapter, PromotionExecutionLedger } from '@stelis/core-api/studio';
import { RedisPromotionExecutionLedger } from '@stelis/core-api/studio';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createRedisClient, type RedisClient } from './redisClient.js';

const APP_API_RATE_LIMIT_WINDOW_MS = 60_000;
const APP_API_RATE_LIMIT_MAX_REQUESTS = 20;

// ── Exported context interface ──────────────────────────────────────────

interface AppApiContextBase {
  readonly mode: HostOperatingMode;
  /** Base Host context (always available). */
  readonly host: HostContext;
  /** Prepare handler config (always available). */
  readonly prepareConfig: import('@stelis/core-api').PrepareHandlerConfig;
  /** Read-only SponsorAvailability needed by sponsored request admission. */
  readonly sponsorAvailability: AppSponsorAvailability;
}

export interface RelayOnlyAppApiContext extends AppApiContextBase {
  readonly mode: 'relay_only';
}

export interface RelayAndStudioAppApiContext extends AppApiContextBase {
  readonly mode: 'relay_and_studio';
  /** Full SponsorOperations control surface used only by Admin routes. */
  readonly sponsorOperations: AppSponsorOperations;
  /** Immutable public view of the boot-qualified RPC fleet. */
  readonly rpcFleet: Readonly<SuiRpcFleetStatus>;
  /** Redis client used by Auth and Admin routes. */
  readonly redis: RedisClient;
  /** Single abuse block store shared by Host enforcement and Admin operations. */
  readonly abuseStore: AbuseBlockStore;
  /**
   * Sponsored execution recorder store. Owns recent log + lifetime
   * aggregate. Admin route reads via `getSummary()` / `getRecent()`;
   * the persisted final receipt callback writes through `host.onSponsorResult`.
   */
  readonly sponsoredLogsStore: import('./sponsoredLogs/store.js').SponsoredLogsStoreAdapter;
  readonly promotionStore: PromotionStoreAdapter;
  readonly executionLedger: PromotionExecutionLedger;
  readonly studioGlobalAllowedTargets: ReadonlySet<string>;
  readonly developerJwtTrustConfig: DeveloperJwtTrustConfig;
  readonly developerJwtVerifyUrl: string | null;
}

export type AppApiContext = RelayOnlyAppApiContext | RelayAndStudioAppApiContext;

/**
 * Minimal context-level sponsor operations API for routes and admin. Composes the
 * Redis-shared state store, spend coordinator, and retained balance observation. Routes read
 * the shared state via `readState()` and derive gate decisions on demand;
 * admin `/api/sponsor-operations` calls `observeBalances()` before reading so
 * its response reflects the latest bounded observation pass.
 */
export interface AppSponsorAvailability {
  /** Read the current shared state for every slot and the sponsor refill account. */
  readState(): Promise<SponsorAvailabilityView>;
}

export interface AppSponsorOperations extends AppSponsorAvailability {
  /** The one normalized settings value used by runtime and Admin projections. */
  readonly settings: SponsorOperationsSettings;
  /**
   * Awaited dashboard observation. It rejects when the observation cannot be
   * committed, so `/api/sponsor-operations` never labels stale data as fresh.
   */
  observeBalances(): Promise<void>;
  /** Execute an admin-authorized withdrawal through the shared account spend flow. */
  withdraw(input: SponsorOperationsWithdrawalInput): Promise<SponsorRefillAccountSpendResult>;
}

export interface AppApiContextOwner<TContext extends AppApiContext = AppApiContext> {
  start(startupSignal?: AbortSignal): Promise<TContext>;
  stop(): Promise<void>;
}

export class HostContextInitializationCleanupError extends AggregateError {
  constructor(initializationError: unknown, cleanupError: unknown) {
    super(
      [initializationError, cleanupError],
      'Host context initialization and cleanup both failed',
    );
    this.name = 'HostContextInitializationCleanupError';
  }
}

interface ContextRuntimeInputBase {
  readonly redisUrl: string;
  readonly network: 'testnet' | 'mainnet';
  readonly contractIds: {
    readonly packageId: string;
    readonly configId: string;
    readonly vaultRegistryId: string;
  };
  readonly deepbookPackageId: string;
  readonly sui: ChainBoundSuiEndpointSnapshot;
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
}

export type RelayOnlyContextRuntimeInput = ContextRuntimeInputBase & {
  readonly mode: 'relay_only';
};

export type RelayAndStudioContextRuntimeInput = ContextRuntimeInputBase & {
  readonly mode: 'relay_and_studio';
  readonly rpcFleet: Readonly<SuiRpcFleetStatus>;
  readonly studio: {
    readonly globalAllowedTargets: ReadonlySet<string>;
    readonly developerJwtTrustConfig: DeveloperJwtTrustConfig;
    readonly developerJwtVerifyUrl: string | null;
  };
};

export type ContextRuntimeInput = RelayOnlyContextRuntimeInput | RelayAndStudioContextRuntimeInput;

/**
 * Internal initialization — creates all resources.
 * Wrapped in try/catch for resource cleanup on partial failure.
 */
export function createAppApiContextOwner(
  input: RelayOnlyContextRuntimeInput,
): AppApiContextOwner<RelayOnlyAppApiContext>;
export function createAppApiContextOwner(
  input: RelayAndStudioContextRuntimeInput,
): AppApiContextOwner<RelayAndStudioAppApiContext>;
export function createAppApiContextOwner(input: ContextRuntimeInput): AppApiContextOwner;
export function createAppApiContextOwner(input: ContextRuntimeInput): AppApiContextOwner {
  let redisForCleanup: RedisClient | null = null;
  let host: HostContext | null = null;
  let abuseStoreForCleanup: AbuseBlockStore | null = null;
  let executionLedgerForCleanup: PromotionExecutionLedger | null = null;
  let sponsorOperationsTaskSchedulerForCleanup: SponsorOperationsTaskScheduler | null = null;
  let sponsoredExecutionRecoveryForCleanup: SponsoredExecutionRecovery | null = null;
  let startTask: Promise<AppApiContext> | null = null;
  let activeCleanupTask: Promise<void> | null = null;
  let completedCleanupTask: Promise<void> | null = null;
  let activeStopTask: Promise<void> | null = null;
  let completedStopTask: Promise<void> | null = null;
  const ownerController = new AbortController();

  const cleanupOwnedResources = (): Promise<void> => {
    if (completedCleanupTask !== null) return completedCleanupTask;
    if (activeCleanupTask !== null) return activeCleanupTask;

    const attempt = settleCleanupInOrder([
      async () => {
        const scheduler = sponsorOperationsTaskSchedulerForCleanup;
        if (scheduler === null) return;
        await scheduler.dispose();
        if (sponsorOperationsTaskSchedulerForCleanup === scheduler) {
          sponsorOperationsTaskSchedulerForCleanup = null;
        }
      },
      () =>
        settleCleanupPhase([
          async () => {
            const recovery = sponsoredExecutionRecoveryForCleanup;
            if (recovery === null) return;
            await recovery.dispose();
            if (sponsoredExecutionRecoveryForCleanup === recovery) {
              sponsoredExecutionRecoveryForCleanup = null;
            }
          },
          async () => {
            const abuseStore = abuseStoreForCleanup;
            if (abuseStore === null) return;
            await abuseStore.stop();
            if (abuseStoreForCleanup === abuseStore) abuseStoreForCleanup = null;
          },
          async () => {
            const executionLedger = executionLedgerForCleanup;
            if (executionLedger === null) return;
            await executionLedger.dispose();
            if (executionLedgerForCleanup === executionLedger) {
              executionLedgerForCleanup = null;
            }
          },
        ]),
      async () => {
        const ownedHost = host;
        if (ownedHost === null) return;
        await ownedHost.dispose();
        if (host === ownedHost) host = null;
      },
      async () => {
        const redis = redisForCleanup;
        if (redis === null) return;
        await redis.dispose();
        if (redisForCleanup === redis) redisForCleanup = null;
      },
    ]);
    activeCleanupTask = attempt;
    void attempt.then(
      () => {
        completedCleanupTask = attempt;
        if (activeCleanupTask === attempt) activeCleanupTask = null;
      },
      () => {
        // Successfully disposed handles were cleared by their own phase. A
        // later stop retries only the retained handles whose disposal failed.
        if (activeCleanupTask === attempt) activeCleanupTask = null;
      },
    );
    return attempt;
  };

  const stop = (): Promise<void> => {
    ownerController.abort();
    if (completedStopTask !== null) return completedStopTask;
    if (activeStopTask !== null) return activeStopTask;

    const attempt = (async () => {
      // Waiting for start to settle closes the acquisition window. Startup's
      // own failure path uses cleanupOwnedResources directly, so this wait
      // cannot form a start -> stop -> start cycle.
      await startTask?.catch(() => undefined);
      await cleanupOwnedResources();
    })();
    activeStopTask = attempt;
    void attempt.then(
      () => {
        completedStopTask = attempt;
        if (activeStopTask === attempt) activeStopTask = null;
      },
      () => {
        if (activeStopTask === attempt) activeStopTask = null;
      },
    );
    return attempt;
  };

  const start = (externalSignal?: AbortSignal): Promise<AppApiContext> => {
    if (startTask !== null) return startTask;
    const startupSignal =
      externalSignal === undefined
        ? ownerController.signal
        : AbortSignal.any([ownerController.signal, externalSignal]);
    startTask = (async () => {
      startupSignal?.throwIfAborted();
      try {
        // The owner exists before the first resource is acquired. Redis also
        // receives the same startup signal so an aborted connection or probe
        // cannot outlive this runtime.
        const redis = await createRedisClient(input.redisUrl, startupSignal);
        redisForCleanup = redis;
        startupSignal?.throwIfAborted();
        // Network and contract IDs
        const network = input.network;
        const contractIds = input.contractIds;

        // Sponsor keys
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
        // the constructed context, stored in Redis, logged, or copied into prepare entries.
        const sponsorLeaseHmacSecret = input.sponsorLeaseHmacSecret;
        const sponsorPool = new RedisSponsorPool(redis, sponsorKeys, {
          hmacSecret: sponsorLeaseHmacSecret,
        });

        // Redis-backed store adapters
        // RedisSponsoredExecutionStore owns prepared, executing, and final receipt state.
        // The Promotion ledger is created first because receipt transitions include
        // its reservation stage and final accounting.
        let promotionStore: PromotionStoreAdapter | null = null;
        let executionLedger: RedisPromotionExecutionLedger | null = null;
        if (input.mode === 'relay_and_studio') {
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

        // Exact boot-qualified settlement swap paths
        const settlementSwapPaths = [...input.settlementSwapPaths];
        // eslint-disable-next-line no-console
        console.log(
          `[app-api] Settlement swap path registry ready: ${settlementSwapPaths.length} path(s) — ` +
            settlementSwapPaths.map((p) => p.settlementTokenSymbol).join(', '),
        );

        // Prepare configuration
        const prepareConfig = resolvePrepareConfig({
          settlementSwapPaths,
          deepbookPackageId: input.deepbookPackageId,
          quotedHostFeeMist: input.quotedHostFeeMist,
        });

        // Redis-backed prepare in-flight limiter shared across app instances
        // Explicit injection — official runtime must not fall back to
        // MemoryPrepareInflight. The default preserves the existing
        // sponsor-slot-based capacity heuristic.
        const prepareInflightCapacity = input.prepareInflightCapacity;
        const prepareInflightLimiter = new RedisPrepareInflight(redis, prepareInflightCapacity);

        // Sponsor Refill Account and SponsorOperations
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
          throw new Error(
            'SponsorOperationsSettings sponsor addresses must match the sponsor keys',
          );
        }

        // Redis-shared SponsorOperations state store
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

        // Sponsor result callback for action-driven slot and Sponsor Refill Account writes
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
        await runStartupTask(
          () => sponsorOperationsTaskScheduler.start(),
          cleanupOwnedResources,
          startupSignal,
        );

        const retainedSponsorResultStateUpdater: SponsorResultCallback = (metadata, signal) =>
          sponsorOperationsTaskScheduler.observeSponsorResult(metadata, signal);
        // Sponsored execution recorder
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
        await runStartupTask(
          () => sponsoredExecutionRecovery.start(),
          cleanupOwnedResources,
          startupSignal,
        );

        const sponsorAvailability: AppSponsorAvailability = {
          readState: () => sponsorOperationsState.readAll(),
        };
        const sponsorOperations: AppSponsorOperations = {
          ...sponsorAvailability,
          settings: sponsorOperationsSettings,
          observeBalances: () => sponsorOperationsTaskScheduler.observeBalances(),
          withdraw: (withdrawInput) => sponsorOperationsTaskScheduler.withdraw(withdrawInput),
        };

        // Assemble the mode-specific context
        const hostRef = host;
        const contextBase = {
          host: hostRef,
          prepareConfig,
          sponsorAvailability,
        } as const;
        let context: AppApiContext;
        if (input.mode === 'relay_and_studio') {
          if (promotionStore === null || executionLedger === null) {
            throw new Error(
              '`relay_and_studio` context construction did not create every dependency',
            );
          }
          context = {
            ...contextBase,
            mode: input.mode,
            sponsorOperations,
            rpcFleet: input.rpcFleet,
            redis,
            abuseStore: abuseBlocker,
            sponsoredLogsStore,
            promotionStore,
            executionLedger,
            studioGlobalAllowedTargets: input.studio.globalAllowedTargets,
            developerJwtTrustConfig: input.studio.developerJwtTrustConfig,
            developerJwtVerifyUrl: input.studio.developerJwtVerifyUrl,
          };
        } else {
          context = {
            ...contextBase,
            mode: input.mode,
          };
        }
        startupSignal.throwIfAborted();
        return context;
      } catch (err) {
        try {
          await cleanupOwnedResources();
        } catch (cleanupError) {
          throw new HostContextInitializationCleanupError(err, cleanupError);
        }
        throw err;
      }
    })();
    return startTask;
  };

  return { start, stop };
}

async function settleCleanupPhase(steps: readonly (() => Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(steps.map((step) => Promise.resolve().then(step)));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'Host resource cleanup failed');
}

async function settleCleanupInOrder(steps: readonly (() => Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Host resource cleanup failed');
}

async function runStartupTask(
  start: () => Promise<void>,
  stop: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let abortCleanup: Promise<void> | null = null;
  const onAbort = () => {
    abortCleanup ??= Promise.resolve().then(stop);
    void abortCleanup.catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await start();
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (abortCleanup !== null) await abortCleanup;
  }
}
