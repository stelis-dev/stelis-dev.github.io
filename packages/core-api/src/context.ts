/**
 * HostContext — framework-independent Host runtime configuration.
 *
 * Provides the qualified Sui endpoint snapshot, sponsor keypair pool, and
 * cached on-chain Config.
 * Pass this context to all handler functions.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiNetwork, SponsorSlotLeaseSummary } from '@stelis/contracts';
import type {
  OnchainConfig,
  AllowedSettlementSwapPath,
  ChainBoundSuiEndpointSnapshot,
} from '@stelis/core-relay';

import type { SponsoredExecutionStoreAdapter } from './store/sponsoredExecutionStore.js';
import type { PrepareRequestNonceStore } from './store/prepareRequestNonceStore.js';
import type { RateLimitAdapter } from './store/rateLimitTypes.js';
import type { AbuseBlockerAdapter } from './store/abuseBlockTypes.js';
import type { PrepareInflightLimiter } from './store/prepareInflightTypes.js';
import type { SponsorResultCallback } from './handlers/sponsorResult.js';
import { PREPARE_TTL_MS } from './preparePolicy.js';
import { canonicalizeAddress, validateAddressConstraints } from './addressConstraints.js';
import { logStructuredEvent } from './structuredEventLog.js';
import {
  SPONSOR_POOL_LEASE_CHECKIN,
  SPONSOR_POOL_LEASE_CHECKOUT,
  SPONSOR_POOL_LEASE_EXHAUSTED,
  SPONSOR_POOL_SIGN,
} from './observability/events.js';
import { createHash } from 'node:crypto';
import { SponsorLeaseExpiredError } from './store/sponsorPoolErrors.js';
import {
  assertSponsorLeaseRecordProof,
  createReservedSponsorLeaseRecord,
  materializeExecutingSponsorLeaseRecordTransition,
  planCommittedSponsorLeaseRecordTransition,
  planExecutingSponsorLeaseRecordTransition,
  planSponsorLeaseRecordRemoval,
  parseSponsorLeaseRecord,
  serializeSponsorLeaseRecord,
  SPONSOR_LEASE_HMAC_SECRET_MIN_LENGTH,
  type SponsorLeaseRecordAccess,
  type MemorySponsorLeaseRecordAccess,
  type SponsorLeaseRecordRemoval,
  type SponsorLeaseRemovalExpectation,
  type SponsorLeaseRecordSnapshot,
  type SponsorLeaseRecordDeadlineTransition,
  type SponsorLeaseRecordTransition,
} from './store/sponsorLeaseProof.js';
import { assertSponsorSlotCount } from './sponsorSlotPolicy.js';
import {
  readOnchainConfig,
  type HostChainState,
  type HostChainStateIds,
} from './hostChainState.js';

const DEFAULT_CONFIG_CACHE_TTL_MS = 30_000;

// ─────────────────────────────────────────────
// Key parsing (re-exported from edge-safe module)
// ─────────────────────────────────────────────

// parseSponsorKey / parseSponsorKeys live in sponsorKeyParser.ts so that
// ambiguous-runtime modules (instrumentation.ts, middleware.ts) can import
// them without pulling in node:crypto via this module's randomUUID.
export { parseSponsorKey, parseSponsorKeys } from './sponsorKeyParser.js';

// ─────────────────────────────────────────────
// Sponsor Pool
// ─────────────────────────────────────────────

/**
 * Serializable sponsor slot lease. The sponsor address is the lease identity
 * across processes and is persisted in Redis-backed prepare records.
 *
 * The adapter stores one current lease record whose stage is `reserved`,
 * `committed`, or `executing`. Receipt-store mutations advance and remove the
 * latter two stages atomically with the receipt lifecycle. `sponsorAddress` is the lease identity;
 * `receiptId` binds that lease to one prepare operation, and `txBytesHash`
 * binds it to the validated transaction bytes at prepared-receipt commit.
 */
export interface SponsorLease {
  readonly sponsorAddress: string;
}

/**
 * Sponsor slot adapter.
 *
 * Implementations are responsible for:
 *   1. leasing a slot for /sponsor (reserved proof keyed by `receiptId`)
 *   2. exposing exact lease-record transitions to the sponsored execution store
 *   3. releasing it after /sponsor completes or TTL expiry
 *   4. resolving the matching signing key for /sponsor
 *
 * Lease contract:
 *
 *   checkout(receiptId)
 *     → lease proof = HMAC(secret, "reserved" | receiptId | sponsorAddress)
 *     → reserved stage; `sign()` accepts only an executing-stage record
 *
 *   prepared receipt commit
 *     → the sponsored execution store atomically replaces the reserved proof
 *       with HMAC(secret, "committed" | receiptId | sponsorAddress | txBytesHash)
 *
 *   execution start
 *     → the sponsored execution store atomically advances the lease to
 *       `executing` and binds the expected Sui transaction digest in the proof
 *
 *   sign(sponsorAddress, receiptId, txBytes)
 *     → verifies the executing proof for the same receipt, sponsor,
 *       hash(txBytes), and stored Sui transaction digest
 *     → only matches when the submitted txBytes hash equals the validated
 *       transaction-bytes hash; a Redis-only attacker who overwrites an entry's
 *       `txBytesHash` after the atomic commit cannot satisfy this gate because
 *       the committed Redis value still references the original hash
 *
 *   checkin(sponsorAddress, receiptId)
 *     → verifies and deletes only a pre-commit `reserved` lease
 *     → committed and executing leases can be removed only by the atomic
 *       receipt-store transition that owns their corresponding state
 *     → HMAC mismatch is a silent no-op (TTL safety net covers reserved state);
 *       the same lease key cannot be stolen by a forged receipt
 */
export interface SponsorPoolAdapter {
  /** Max concurrent sponsored TXs. */
  readonly size: number;
  /** Address of the first (primary) sponsor slot, shown by /status. */
  readonly primaryAddress: string;
  /**
   * Attempt to lease a slot for the given `receiptId`. Returns null when all
   * slots are busy. The pool stores the stage-separated reserved HMAC proof.
   */
  checkout(receiptId: string): Promise<SponsorLease | null>;
  /**
   * Release a lease that has not reached prepared-receipt commit.
   * Committed and executing leases are removed only by the receipt store's
   * atomic discard/finalization mutation.
   */
  checkin(sponsorAddress: string, receiptId: string): Promise<void>;
  /** Current sponsor slot lease occupancy for admin observability. */
  leaseStatus(): Promise<SponsorSlotLeaseSummary>;
  /** Return all configured sponsor addresses. */
  addresses(): string[];
  /**
   * Sign txBytes with the slot's keypair. Verifies the executing lease record
   * and its HMAC for `(receiptId, sponsorAddress, hash(txBytes), transactionDigest)`
   * before touching the in-memory keypair. Reserved and committed leases fail
   * because only the executing-stage record can authorize signing.
   * Redis compromise alone cannot satisfy this check without the HMAC
   * secret held in process env.
   */
  sign(
    sponsorAddress: string,
    receiptId: string,
    txBytes: Uint8Array,
  ): Promise<{ signature: string }>;
}

/** Sponsor pool with exact current lease-record access for receipt coordination. */
export interface SponsorPoolRecordAdapter extends SponsorPoolAdapter, SponsorLeaseRecordAccess {}

export interface MemorySponsorPoolRecordAdapter
  extends SponsorPoolAdapter, MemorySponsorLeaseRecordAccess {}

/**
 * Options shared by `SponsorPool` (in-memory) and `RedisSponsorPool`.
 *
 * `hmacSecret` is the process-env `SPONSOR_LEASE_HMAC_SECRET`. Enforced
 * at the host boot layer (`app-api/src/boot.ts`) and validated here as a
 * defence-in-depth length check.
 */
export interface SponsorPoolOptions {
  hmacSecret: string;
}

function assertLeaseHmacSecret(secret: string, label: string): void {
  if (typeof secret !== 'string' || secret.length < SPONSOR_LEASE_HMAC_SECRET_MIN_LENGTH) {
    throw new Error(
      `${label}: hmacSecret must be at least ${SPONSOR_LEASE_HMAC_SECRET_MIN_LENGTH} characters ` +
        '(SPONSOR_LEASE_HMAC_SECRET)',
    );
  }
}

/** Canonical lowercase SHA-256 hash of the validated transaction bytes. */
function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Pool of sponsor slots. Supports single-key or multi-key deployments.
 *
 * Capacity is exactly the configured sponsor-address count: one address can
 * own one outstanding prepared or executing receipt. Multiple addresses
 * provide parallel capacity. The Sponsor Refill Account funds each address's
 * SUI address balance.
 *
 * The in-memory pool stores the same strict three-stage lease record as
 * `RedisSponsorPool`, so both adapters share one fencing
 * semantics. Tests covering `pool.sign()` behaviour run the same HMAC
 * code path.
 */
export class SponsorPool implements MemorySponsorPoolRecordAdapter {
  private readonly _keypairs: Map<string, Ed25519Keypair>;
  private readonly _leaseRecords = new Map<string, string>();
  private readonly _addresses: string[];
  private readonly _hmacSecret: string;

  constructor(keypairs: Ed25519Keypair[], options: SponsorPoolOptions) {
    assertSponsorSlotCount(keypairs.length, 'SponsorPool');
    assertLeaseHmacSecret(options.hmacSecret, 'SponsorPool');
    this._keypairs = new Map(keypairs.map((kp) => [kp.toSuiAddress(), kp]));
    this._addresses = keypairs.map((kp) => kp.toSuiAddress());
    this._hmacSecret = options.hmacSecret;
  }

  /**
   * Returns slots count (= max concurrent TXs).
   */
  get size(): number {
    return this._addresses.length;
  }

  /**
   * Returns the address of the first (primary) sponsor slot.
   * Used for /status address reporting.
   * All slots are funded by the Sponsor Refill Account, so any address works for monitoring.
   */
  get primaryAddress(): string {
    return this._addresses[0];
  }

  /**
   * Atomically checks out an available slot for the given `receiptId`.
   * Stores the reserved-stage lease record. Returns null if all slots are
   * busy — caller maps to NO_SPONSOR_SLOT (503).
   *
   * Node.js single-threaded: this is effectively a mutex-free atomic operation.
   */
  async checkout(receiptId: string): Promise<SponsorLease | null> {
    const sponsorAddress = this._addresses.find((address) => !this._leaseRecords.has(address));
    if (!sponsorAddress) {
      logStructuredEvent(SPONSOR_POOL_LEASE_EXHAUSTED, {
        adapter: 'memory',
        pool_size: this.size,
      });
      return null;
    }
    const record = createReservedSponsorLeaseRecord({
      secret: this._hmacSecret,
      receiptId,
      sponsorAddress,
      deadlineMs: leaseDeadline(Date.now(), PREPARE_TTL_MS + 5_000),
    });
    this._leaseRecords.set(sponsorAddress, serializeSponsorLeaseRecord(record));
    logStructuredEvent(SPONSOR_POOL_LEASE_CHECKOUT, {
      adapter: 'memory',
      sponsor_address: sponsorAddress,
      pool_size: this.size,
      in_use: this._leaseRecords.size,
    });
    return {
      sponsorAddress,
    };
  }

  /**
   * Returns a slot to the pool after /sponsor completes, or on TTL
   * expiry, or on prepare-path failure.
   *
   * Only a reserved lease can be released through this path. Committed and
   * executing state belongs to the atomic sponsored-execution store.
   */
  async checkin(sponsorAddress: string, receiptId: string): Promise<void> {
    const snapshot = await this.readSponsorLeaseRecord(sponsorAddress);
    if (!snapshot) return;
    let removal: SponsorLeaseRecordRemoval;
    try {
      removal = this.prepareSponsorLeaseRecordRemoval(snapshot, {
        stage: 'reserved',
        receiptId,
      });
    } catch {
      return;
    }
    if (!this.applySponsorLeaseRecordRemoval(removal)) return;
    logStructuredEvent(SPONSOR_POOL_LEASE_CHECKIN, {
      adapter: 'memory',
      sponsor_address: sponsorAddress,
      stage: snapshot.record.stage,
      pool_size: this.size,
      in_use: this._leaseRecords.size,
    });
  }

  /**
   * Returns all slot addresses — useful for Sponsor Refill Account monitoring.
   */
  addresses(): string[] {
    return [...this._addresses];
  }

  async leaseStatus(): Promise<SponsorSlotLeaseSummary> {
    const slots = this._addresses.map((address) => ({
      address,
      leased: this._leaseRecords.has(address),
    }));
    const leasedSlots = slots.filter((slot) => slot.leased).length;
    return {
      leasedSlots,
      freeSlots: this.size - leasedSlots,
      slots,
    };
  }

  async sign(
    sponsorAddress: string,
    receiptId: string,
    txBytes: Uint8Array,
  ): Promise<{ signature: string }> {
    // Committed HMAC lease proof check — the only gate between a
    // Redis-only attacker and the in-memory signing keypair.
    // Reserved and committed leases fail because signing requires the exact
    // executing-stage record and its transaction-byte hash.
    const snapshot = await this.readSponsorLeaseRecord(sponsorAddress);
    if (
      !snapshot ||
      snapshot.record.stage !== 'executing' ||
      snapshot.record.receiptId !== receiptId ||
      snapshot.record.txBytesHash !== sha256Hex(txBytes)
    ) {
      throw new SponsorLeaseExpiredError(sponsorAddress);
    }
    const keypair = this._keypairs.get(sponsorAddress);
    if (!keypair) {
      throw new Error(`SponsorPool: unknown sponsor address ${sponsorAddress}`);
    }
    logStructuredEvent(SPONSOR_POOL_SIGN, {
      adapter: 'memory',
      sponsor_address: sponsorAddress,
      tx_bytes_len: txBytes.length,
    });
    return keypair.signTransaction(txBytes);
  }

  sponsorLeaseRecordKey(sponsorAddress: string): string {
    return sponsorAddress;
  }

  async readSponsorLeaseRecord(sponsorAddress: string): Promise<SponsorLeaseRecordSnapshot | null> {
    const raw = this._leaseRecords.get(sponsorAddress);
    if (raw === undefined) return null;
    const record = parseSponsorLeaseRecord(raw);
    assertSponsorLeaseRecordProof(record, this._hmacSecret);
    if (record.sponsorAddress !== sponsorAddress) {
      throw new Error('SponsorPool: lease record sponsor does not match its key');
    }
    return { raw, record };
  }

  prepareCommittedSponsorLeaseRecord(
    snapshot: SponsorLeaseRecordSnapshot,
    receiptId: string,
    txBytesHash: string,
    deadlineMs: number,
  ): SponsorLeaseRecordTransition {
    return planCommittedSponsorLeaseRecordTransition({
      key: this.sponsorLeaseRecordKey(snapshot.record.sponsorAddress),
      secret: this._hmacSecret,
      snapshot,
      receiptId,
      txBytesHash,
      deadlineMs,
    });
  }

  prepareExecutingSponsorLeaseRecord(
    snapshot: SponsorLeaseRecordSnapshot,
    receiptId: string,
    txBytesHash: string,
    transactionDigest: string,
  ): SponsorLeaseRecordDeadlineTransition {
    return planExecutingSponsorLeaseRecordTransition({
      key: this.sponsorLeaseRecordKey(snapshot.record.sponsorAddress),
      secret: this._hmacSecret,
      snapshot,
      receiptId,
      txBytesHash,
      transactionDigest,
    });
  }

  prepareSponsorLeaseRecordRemoval(
    snapshot: SponsorLeaseRecordSnapshot,
    expectation: SponsorLeaseRemovalExpectation,
  ): SponsorLeaseRecordRemoval {
    return planSponsorLeaseRecordRemoval({
      key: this.sponsorLeaseRecordKey(snapshot.record.sponsorAddress),
      secret: this._hmacSecret,
      snapshot,
      expectation,
    });
  }

  /** Exact single-record CAS used by the in-memory receipt coordinator. */
  matchesSponsorLeaseRecordTransition(transition: SponsorLeaseRecordTransition): boolean {
    return (
      transition.key === transition.nextRecord.sponsorAddress &&
      this._leaseRecords.get(transition.nextRecord.sponsorAddress) === transition.expectedRaw
    );
  }

  applySponsorLeaseRecordTransition(transition: SponsorLeaseRecordTransition): boolean {
    if (!this.matchesSponsorLeaseRecordTransition(transition)) return false;
    this._leaseRecords.set(transition.nextRecord.sponsorAddress, transition.nextRaw);
    return true;
  }

  matchesSponsorLeaseRecordDeadlineTransition(
    transition: SponsorLeaseRecordDeadlineTransition,
  ): boolean {
    return this._leaseRecords.get(transition.key) === transition.expectedRaw;
  }

  applySponsorLeaseRecordDeadlineTransition(
    transition: SponsorLeaseRecordDeadlineTransition,
    deadlineMs: number,
  ): boolean {
    if (!this.matchesSponsorLeaseRecordDeadlineTransition(transition)) return false;
    const materialized = materializeExecutingSponsorLeaseRecordTransition(transition, deadlineMs);
    this._leaseRecords.set(materialized.nextRecord.sponsorAddress, materialized.nextRaw);
    return true;
  }

  matchesSponsorLeaseRecordRemoval(removal: SponsorLeaseRecordRemoval): boolean {
    return this._leaseRecords.get(removal.key) === removal.expectedRaw;
  }

  applySponsorLeaseRecordRemoval(removal: SponsorLeaseRecordRemoval): boolean {
    if (!this.matchesSponsorLeaseRecordRemoval(removal)) return false;
    return this._leaseRecords.delete(removal.key);
  }
}

function leaseDeadline(nowMs: number, ttlMs: number): number {
  const deadlineMs = nowMs + ttlMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= nowMs) {
    throw new Error('Sponsor lease deadline exceeds the safe integer range');
  }
  return deadlineMs;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Minimal interface for objects that support explicit cleanup */
interface Disposable {
  dispose(): void | Promise<void>;
}

/** Type guard — returns true if `obj` has a callable `dispose()` method */
function isDisposable(obj: unknown): obj is Disposable {
  return typeof (obj as Disposable)?.dispose === 'function';
}

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

export interface HostRuntimeConfig {
  /** Target network */
  network: SuiNetwork;
  /** Immutable endpoint set that passed the Host boot reads. */
  sui: ChainBoundSuiEndpointSnapshot;
  /** Deployed package ID */
  packageId: string;
  /** Config shared object ID */
  configId: string;
  /** VaultRegistry shared object ID */
  vaultRegistryId: string;
  /**
   * Current published DeepBook storage/call-target package ID.
   *
   * Prepare quote and PTB paths consume this value. MoveAbort classification
   * uses the distinct generated original/runtime ModuleId. Shared reference:
   * `DEEPBOOK_IDS[network].packageId`; no env override or synthetic default is
   * permitted.
   */
  deepbookPackageId: string;
  /** Exact Config and VaultRegistry result produced during boot qualification. */
  initialChainState: HostChainState;
  /** Config cache TTL in milliseconds. Default: DEFAULT_CONFIG_CACHE_TTL_MS. */
  configCacheTtlMs?: number;
  /**
   * RateLimitAdapter — required. The host (e.g. `app-api`) must inject a
   * production-capable adapter such as `RedisRateLimiter`. There is no
   * runtime default; missing this field fails closed at context
   * construction time.
   */
  rateLimiter: RateLimitAdapter;
  /**
   * Sponsor pool / lease adapter — required. Hosts inject either an
   * application-managed in-memory `SponsorPool` (test/dev fixtures only)
   * or a production `RedisSponsorPool`. There is no runtime default.
   */
  sponsorPool: SponsorPoolAdapter;
  /**
   * Receipt-time availability check for the sponsor address already assigned
   * by `sponsorPool`. The Host implementation must include observation
   * freshness; aggregate pool availability is not sufficient here.
   */
  isSponsorAddressAvailable(sponsorAddress: string): Promise<boolean>;
  /**
   * Abuse blocker — required. Hosts inject `RedisAbuseBlocker` (or a
   * test-only `MemoryAbuseBlocker` from a fixture path). No runtime
   * default.
   */
  abuseBlocker: AbuseBlockerAdapter;
  /**
   * Sponsored execution store — required. It owns prepared, executing,
   * final, callback, nonce, and bounded recovery state for one receipt.
   */
  sponsoredExecutionStore: SponsoredExecutionStoreAdapter;
  /**
   * Prepare request nonce store — required. Hosts inject a short-TTL store
   * so signed `/relay/prepare` requests cannot be replayed before
   * in-flight admission.
   */
  prepareRequestNonceStore: PrepareRequestNonceStore;
  /**
   * Prepare in-flight limiter — required. Hosts inject
   * `RedisPrepareInflight` (or a test-only memory adapter). No runtime
   * default.
   */
  prepareInflightLimiter: PrepareInflightLimiter;
  /**
   * Settlement payout recipient address for execution cost claim plus quoted host fee (required).
   * Must differ from all sponsor addresses.
   * Canonicalized with normalizeSuiAddress at context creation.
   */
  settlementPayoutRecipientAddress: string;
  /** Pre-registered settlement swap paths for L2 validation. */
  allowedSettlementSwapPaths?: AllowedSettlementSwapPath[];
  /**
   * Host-provided sponsor result callback. The sponsor runner attempts it
   * after atomically storing the final receipt. Failed delivery remains
   * pending and the recovery task retries it. Used by app-api to drive
   * per-action sponsor operations state updates.
   */
  onSponsorResult: SponsorResultCallback;
}

// ─────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────

export interface HostContext {
  network: SuiNetwork;
  sui: ChainBoundSuiEndpointSnapshot;
  /**
   * Sponsor pool — reserves a sponsor address during prepare. The sponsored
   * execution store advances and releases the durable lease with each receipt
   * transition.
   * Pool size = max concurrent sponsored TXs.
   *
   * Single-key deployments have pool size 1. Multi-key deployments have pool size N.
   */
  sponsorPool: SponsorPoolAdapter;
  /** Check the fresh availability of the exact sponsor assigned to a receipt. */
  isSponsorAddressAvailable(sponsorAddress: string): Promise<boolean>;
  packageId: string;
  configId: string;
  vaultRegistryId: string;
  /** Published DeepBook storage/call target used by prepare quote and PTB paths. */
  deepbookPackageId: string;
  /**
   * Rate limiter — host-injected. Production hosts inject
   * `RedisRateLimiter`; tests use a fixture adapter.
   */
  rateLimiter: RateLimitAdapter;
  /**
   * Abuse blocker — host-injected. Production hosts inject
   * `RedisAbuseBlocker`; tests use a fixture adapter.
   */
  abuseBlocker: AbuseBlockerAdapter;
  /**
   * Receipt lifecycle store — binds prepared bytes, sponsor lease, execution,
   * final accounting, callback delivery, and bounded indexes to one receipt.
   */
  sponsoredExecutionStore: SponsoredExecutionStoreAdapter;
  /**
   * Short-TTL store for client-generated prepare request nonces. This is
   * separate from the on-chain settlement nonce reserved by the sponsored
   * execution store.
   */
  prepareRequestNonceStore: PrepareRequestNonceStore;
  /**
   * In-flight limiter for expensive prepare work (on-chain queries +
   * dry-run build). Independent of sponsor slot availability. Applied to
   * both the generic `/relay/prepare` path and the studio
   * `/studio/promotions/:id/prepare` path by `app-api` route wiring.
   * Host-injected; production hosts use `RedisPrepareInflight`, tests use
   * a fixture adapter.
   */
  prepareInflightLimiter: PrepareInflightLimiter;
  /**
   * Settlement payout recipient address (canonical form).
   * Always set — validated at context creation.
   */
  settlementPayoutRecipientAddress: string;
  /** Pre-registered settlement swap paths for L2 validation. */
  allowedSettlementSwapPaths: AllowedSettlementSwapPath[];

  /** Boot-qualified immutable VaultRegistry.vaults table ID. */
  readonly vaultsTableId: string;
  /** Returns cached on-chain Config. Auto-refreshes after TTL. */
  getConfig(): Promise<OnchainConfig>;
  /**
   * Invalidates the cached on-chain Config, forcing a fresh fetch on the next getConfig() call.
   * Call this at the start of /sponsor to detect fee drift since /prepare time.
   */
  invalidateConfigCache(): void;
  /**
   * Releases background resources held by injected coordination
   * adapters that implement `Disposable` (for example memory fixtures
   * with retained timers). Production Redis-backed adapters
   * do not implement `Disposable`; the host disposes the underlying
   * Redis client via its own shutdown flow (see
   * `app-api/src/context.ts` `dispose()`).
   *
   * Ownership contract:
   *   - Hosts and tests own the lifecycle of every adapter they inject
   *     into `createHostContext()`. `dispose()` is a convenience
   *     dispatcher that walks each injected adapter once and calls
   *     `.dispose()` if implemented; it does not own the underlying
   *     resource.
   *   - For production hosts this is effectively a no-op for adapter
   *     modules (Redis adapters teardown happens through the redis
   *     client). For test code it cleans up memory-fixture timers.
   *
   * Call on graceful shutdown or in test teardown. Not required for
   * normal process exit (memory-fixture timers are unref'd).
   */
  dispose(): Promise<void>;
  /**
   * Host-provided post-sponsor result callback for sponsor handlers. See
   * `onSponsorResult` in `HostRuntimeConfig` for the contract.
   * `undefined` means no callback is wired; handlers skip invocation.
   */
  onSponsorResult: SponsorResultCallback;
}

/**
 * Creates a HostContext from configuration.
 * Call once at server startup, then pass to all handlers.
 *
 * Every coordination adapter (`sponsorPool`, `sponsoredExecutionStore`,
 * `prepareRequestNonceStore`, `prepareInflightLimiter`, `rateLimiter`,
 * `abuseBlocker`) is required. There is no in-memory runtime default. Hosts
 * must inject production-capable adapters (Redis-backed for `app-api`); test
 * code injects memory fixtures directly. Missing adapters fail closed at
 * construction time.
 */
export function createHostContext(config: HostRuntimeConfig): HostContext {
  const sui = config.sui;
  if (sui.network !== config.network) {
    throw new Error('createHostContext: Sui endpoint snapshot network does not match Host network');
  }

  if (!config.sponsorPool) {
    throw new Error(
      'createHostContext: sponsorPool is required (production hosts inject RedisSponsorPool; tests inject a fixture pool). No runtime default is provided.',
    );
  }
  if (typeof config.isSponsorAddressAvailable !== 'function') {
    throw new Error('createHostContext: isSponsorAddressAvailable is required');
  }
  if (!config.sponsoredExecutionStore) {
    throw new Error('createHostContext: sponsoredExecutionStore is required');
  }
  if (!config.prepareRequestNonceStore) {
    throw new Error(
      'createHostContext: prepareRequestNonceStore is required (production hosts inject RedisPrepareRequestNonceStore; tests inject a fixture store).',
    );
  }
  if (!config.prepareInflightLimiter) {
    throw new Error(
      'createHostContext: prepareInflightLimiter is required (production hosts inject RedisPrepareInflight; tests inject a fixture limiter).',
    );
  }
  if (!config.rateLimiter) {
    throw new Error(
      'createHostContext: rateLimiter is required (production hosts inject RedisRateLimiter; tests inject a fixture limiter).',
    );
  }
  if (!config.abuseBlocker) {
    throw new Error(
      'createHostContext: abuseBlocker is required (production hosts inject RedisAbuseBlocker; tests inject a fixture blocker).',
    );
  }
  const sponsorPool = config.sponsorPool;

  // Canonicalize + validate settlementPayoutRecipientAddress
  const recipientAddr = canonicalizeAddress(
    config.settlementPayoutRecipientAddress,
    'settlementPayoutRecipientAddress',
  );
  // [1] Sponsor uniqueness + [2] Sponsor != Recipient
  validateAddressConstraints({
    sponsorAddresses: sponsorPool.addresses(),
    settlementPayoutRecipientAddress: recipientAddr,
    // [3] Sponsor != SponsorRefillAccount is checked at boot time
  });

  const cacheTtl = config.configCacheTtlMs ?? DEFAULT_CONFIG_CACHE_TTL_MS;
  if (!Number.isSafeInteger(cacheTtl) || cacheTtl < 0) {
    throw new Error('configCacheTtlMs must be a non-negative safe integer');
  }

  const chainIds: HostChainStateIds = {
    packageId: canonicalizeAddress(config.packageId, 'packageId'),
    configId: canonicalizeAddress(config.configId, 'configId'),
    vaultRegistryId: canonicalizeAddress(config.vaultRegistryId, 'vaultRegistryId'),
  };
  if (
    config.initialChainState.config.packageId !== chainIds.packageId ||
    config.initialChainState.config.configId !== chainIds.configId ||
    config.initialChainState.vaultRegistryId !== chainIds.vaultRegistryId
  ) {
    throw new Error('createHostContext: initial chain state does not match the configured objects');
  }

  let cachedConfig: OnchainConfig = config.initialChainState.config;
  let cacheTimestamp = Date.now();
  let inflightFetch: Promise<OnchainConfig> | null = null;

  async function getConfig(): Promise<OnchainConfig> {
    const now = Date.now();
    if (now - cacheTimestamp < cacheTtl) {
      return cachedConfig;
    }

    // Singleflight: reuse inflight fetch to avoid redundant RPC calls
    // when multiple concurrent requests invalidate the cache simultaneously.
    if (inflightFetch) return inflightFetch;

    inflightFetch = (async () => {
      try {
        cachedConfig = await readOnchainConfig(sui, chainIds);
        cacheTimestamp = Date.now();
        return cachedConfig;
      } finally {
        inflightFetch = null;
      }
    })();
    return inflightFetch;
  }

  return {
    network: config.network,
    sui,
    sponsorPool,
    isSponsorAddressAvailable: config.isSponsorAddressAvailable,
    packageId: chainIds.packageId,
    configId: chainIds.configId,
    vaultRegistryId: chainIds.vaultRegistryId,
    deepbookPackageId: config.deepbookPackageId,
    // All coordination adapters are host-injected (validated above);
    // there is no in-memory runtime default. Production hosts inject
    // Redis-backed adapters (`RedisRateLimiter`, `RedisAbuseBlocker`,
    // `RedisSponsoredExecutionStore`, `RedisPrepareInflight`, `RedisSponsorPool`).
    // Test code injects memory fixtures directly through this same
    // contract. See "Production Store Adapters" in `docs/operations.md`.
    rateLimiter: config.rateLimiter,
    abuseBlocker: config.abuseBlocker,
    sponsoredExecutionStore: config.sponsoredExecutionStore,
    prepareRequestNonceStore: config.prepareRequestNonceStore,
    prepareInflightLimiter: config.prepareInflightLimiter,
    settlementPayoutRecipientAddress: recipientAddr,
    allowedSettlementSwapPaths: config.allowedSettlementSwapPaths ?? [],
    vaultsTableId: config.initialChainState.vaultsTableId,
    getConfig,
    invalidateConfigCache(): void {
      // Force next getConfig() to fetch fresh from chain by resetting the cache timestamp.
      // This ensures /sponsor always re-reads fees before validation — detects any drift
      // between /prepare and /sponsor time without waiting for the cache TTL.
      cacheTimestamp = 0;
    },
    async dispose() {
      // Dispatch dispose() to every injected adapter that implements
      // it. Hosts and tests own the underlying lifecycle (see the
      // `dispose()` doc on `HostContext`); this dispatcher fans out
      // to memory fixtures that hold background timers (e.g.
      // `MemorySponsoredExecutionStore`) so test teardown does not have to walk
      // every adapter manually. Production Redis adapters do not
      // implement `Disposable`, so the corresponding branches are
      // no-ops at runtime.
      if (isDisposable(this.sponsoredExecutionStore)) {
        await this.sponsoredExecutionStore.dispose();
      }
      if (isDisposable(this.prepareInflightLimiter)) {
        await this.prepareInflightLimiter.dispose();
      }
      if (isDisposable(this.rateLimiter)) await this.rateLimiter.dispose();
      if (isDisposable(this.abuseBlocker)) this.abuseBlocker.dispose();
      if (isDisposable(this.sponsorPool)) this.sponsorPool.dispose();
    },
    onSponsorResult: config.onSponsorResult,
  };
}
