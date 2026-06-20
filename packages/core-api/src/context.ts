/**
 * RelayerContext — framework-independent relayer configuration.
 *
 * Provides SuiGrpcClient, sponsor keypair pool, and cached on-chain Config.
 * Pass this context to all handler functions.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiNetwork, SponsorSlotLeaseSummary } from '@stelis/contracts';
import type { OnchainConfig, AllowedSettlementSwapPath } from '@stelis/core-relay';
import { extractVaultTableId, extractMoveObjectFields } from '@stelis/core-relay';

import type { PrepareStoreAdapter } from './store/prepareTypes.js';
import type { PrepareRequestNonceStore } from './store/prepareRequestNonceStore.js';
import type { RateLimitAdapter } from './store/rateLimitTypes.js';
import type { AbuseBlockerAdapter } from './store/abuseBlockTypes.js';
import type { PrepareInflightLimiter } from './store/prepareInflightTypes.js';
import type { SponsorResultCallback } from './handlers/sponsorResult.js';
import { canonicalizeAddress, validateAddressConstraints } from './addressConstraints.js';
import { logSponsorPoolEvent } from './sponsorPoolEventLog.js';
import {
  SPONSOR_POOL_LEASE_CHECKIN,
  SPONSOR_POOL_LEASE_CHECKOUT,
  SPONSOR_POOL_LEASE_COMMITTED,
  SPONSOR_POOL_LEASE_EXHAUSTED,
  SPONSOR_POOL_SIGN,
} from './observability/events.js';
import { createHash } from 'node:crypto';
import { SponsorLeaseExpiredError } from './store/sponsorPoolErrors.js';
import {
  computeLeaseProof,
  leaseProofMatches,
  COMMIT_DIGEST_RESERVED,
  SponsorLeaseCommitError,
  SPONSOR_LEASE_HMAC_SECRET_MIN_LENGTH,
} from './store/sponsorLeaseProof.js';
import { assertSponsorSlotCount } from './sponsorSlotPolicy.js';

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
 * Serializable sponsor slot lease.
 *
 * `slotId` is stable across processes and can be persisted in Redis-backed
 * prepare records. The default in-memory pool uses the sponsor address as the
 * slot identifier.
 *
 * The adapter commits a
 * two-stage HMAC lease proof to its lease store — reserved at
 * `checkout`, committed after the caller-driven `commit` — and verifies
 * it on `sign` / `checkin`. The caller passes `receiptId` (already
 * round-tripped in the HTTP contract) as the identity, and the prepare
 * commit digest (`txBytesHash`) as the authenticator bound at
 * `commit()`.
 */
export interface SponsorLease {
  readonly slotId: string;
  readonly sponsorAddress: string;
}

/**
 * Sponsor slot adapter.
 *
 * Implementations are responsible for:
 *   1. leasing a slot for /sponsor (reserved proof keyed by `receiptId`)
 *   2. committing the leased slot to a specific prepare commit (`txBytesHash`)
 *   3. releasing it after /sponsor completes or TTL expiry
 *   4. resolving the matching signing key for /sponsor
 *
 * Lease contract (two-stage proof):
 *
 *   checkout(receiptId)
 *     → lease proof = HMAC(secret, receiptId || slotId || ":reserved")
 *     → reserved stage; `sign()` cannot satisfy this HMAC for any tx
 *       because `hash(txBytes)` never equals the literal `":reserved"`
 *
 *   commit(slotId, receiptId, txBytesHash)
 *     → CAS: require current Redis value == reserved proof, then
 *       write committed proof = HMAC(secret, receiptId || slotId || txBytesHash)
 *     → fails closed (SponsorLeaseCommitError) if the reservation is
 *       missing, already committed, or stamped by a different
 *       `(receiptId, slotId)` pair. Silent no-op is not allowed
 *
 *   sign(slotId, receiptId, txBytes)
 *     → computes HMAC(secret, receiptId || slotId || hash(txBytes))
 *     → only matches when the submitted txBytes hashes to the committed
 *       prepare digest; a Redis-only attacker who overwrites an entry's
 *       `txBytesHash` after `commit()` cannot satisfy this gate because
 *       the committed Redis value still references the original hash
 *
 *   checkin(slotId, receiptId, txBytesHash | null)
 *     → txBytesHash = string: verifies committed proof, deletes
 *     → txBytesHash = null:   verifies reserved proof, deletes
 *     → HMAC mismatch is a silent no-op (TTL safety net covers it);
 *       the same lease key cannot be stolen by a forged receipt
 */
export interface SponsorPoolAdapter {
  /** Max concurrent sponsored TXs. */
  readonly size: number;
  /** Address of the first (primary) sponsor slot, shown by /status. */
  readonly primaryAddress: string;
  /**
   * Attempt to lease a slot for the given `receiptId`. Returns null when all
   * slots are busy. The pool stores the reserved HMAC proof
   * `HMAC(secret, receiptId || slotId || ":reserved")`.
   */
  checkout(receiptId: string): Promise<SponsorLease | null>;
  /**
   * Promote a leased slot from the reserved stage to the committed stage.
   *
   * Must be called after the prepare runner has built the final
   * PTB and computed `buildResult.txBytesHash`, and just before
   * `prepareStore.store()`. CAS semantics: the current lease proof must
   * equal the reserved proof for `(receiptId, slotId)`. Any other state
   * (missing key, different receiptId, already committed, TTL expired)
   * throws `SponsorLeaseCommitError` and the caller must fall through to
   * the error path (release pending nonce reservation + checkin the slot
   * with the appropriate state). Silent no-op is not allowed — a failed
   * commit indicates either a forged state or a concurrent actor.
   */
  commit(slotId: string, receiptId: string, txBytesHash: string): Promise<void>;
  /**
   * Release a leased slot.
   *
   * `txBytesHash === null` → verify and delete the reserved proof.
   * `txBytesHash` is a hex string → verify and delete the committed proof.
   *
   * HMAC mismatch is a silent no-op; the Redis lease TTL covers residual
   * state.
   */
  checkin(slotId: string, receiptId: string, txBytesHash: string | null): Promise<void>;
  /** Current sponsor slot lease occupancy for admin observability. */
  leaseStatus(): Promise<SponsorSlotLeaseSummary>;
  /** Return all configured sponsor addresses. */
  addresses(): string[];
  /**
   * Sign txBytes with the slot's keypair. Verifies the committed HMAC
   * lease proof for `(receiptId, slotId, hash(txBytes))` before touching
   * the in-memory keypair. Reserved-stage leases fail this check because
   * the reservation sentinel cannot equal any hex SHA-256 digest.
   * Redis compromise alone cannot satisfy this check without the HMAC
   * secret held in process env.
   */
  sign(slotId: string, receiptId: string, txBytes: Uint8Array): Promise<{ signature: string }>;
}

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

/** Hex SHA-256 digest of `txBytes` — the canonical commit digest. */
function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Pool of sponsor slots. Supports single-key or multi-key deployments.
 *
 * Capacity = max concurrent sponsored TXs = target TPS × finality delay.
 * Sponsor Refill Account Key is responsible for topping up each slot's gas coins.
 *
 * The in-memory pool stores the same two-stage HMAC lease proof format as
 * `RedisSponsorPool`, so both adapters share one fencing
 * semantics. Tests covering `pool.sign()` behaviour run the same HMAC
 * code path.
 */
export class SponsorPool implements SponsorPoolAdapter {
  private readonly _keypairs: Map<string, Ed25519Keypair>;
  private readonly _inUse = new Set<string>();
  /**
   * slotId → HMAC lease proof. The HMAC input starts as
   * `receiptId || slotId || ":reserved"` at `checkout` and is replaced
   * atomically by `receiptId || slotId || txBytesHash` at `commit`. The
   * raw receiptId and the raw txBytesHash are not stored here.
   */
  private readonly _leaseProofs = new Map<string, string>();
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
   * Stores the reserved-stage HMAC proof. Returns null if all slots are
   * busy — caller maps to NO_SPONSOR_SLOT (422).
   *
   * Node.js single-threaded: this is effectively a mutex-free atomic operation.
   */
  async checkout(receiptId: string): Promise<SponsorLease | null> {
    const slotId = this._addresses.find((address) => !this._inUse.has(address));
    if (!slotId) {
      logSponsorPoolEvent(SPONSOR_POOL_LEASE_EXHAUSTED, {
        adapter: 'memory',
        pool_size: this.size,
      });
      return null;
    }
    this._inUse.add(slotId);
    this._leaseProofs.set(
      slotId,
      computeLeaseProof(this._hmacSecret, receiptId, slotId, COMMIT_DIGEST_RESERVED),
    );
    logSponsorPoolEvent(SPONSOR_POOL_LEASE_CHECKOUT, {
      adapter: 'memory',
      slot_id: slotId,
      sponsor_address: slotId,
      pool_size: this.size,
      in_use: this._inUse.size,
    });
    return {
      slotId,
      sponsorAddress: slotId,
    };
  }

  /**
   * Transition a leased slot from the reserved stage to the committed
   * stage. CAS semantics: the current proof must equal the reserved
   * proof for `(receiptId, slotId)`. Any mismatch throws
   * `SponsorLeaseCommitError` — silent no-op is not allowed.
   */
  async commit(slotId: string, receiptId: string, txBytesHash: string): Promise<void> {
    const current = this._leaseProofs.get(slotId);
    if (typeof current !== 'string') {
      throw new SponsorLeaseCommitError(
        'LEASE_MISSING',
        `SponsorPool.commit: no active lease for slot ${slotId}`,
      );
    }
    const reservedProof = computeLeaseProof(
      this._hmacSecret,
      receiptId,
      slotId,
      COMMIT_DIGEST_RESERVED,
    );
    if (!leaseProofMatches(current, reservedProof)) {
      throw new SponsorLeaseCommitError(
        'LEASE_COMMIT_CAS_FAILED',
        `SponsorPool.commit: lease for slot ${slotId} is not in reserved state for the given receiptId`,
      );
    }
    this._leaseProofs.set(
      slotId,
      computeLeaseProof(this._hmacSecret, receiptId, slotId, txBytesHash),
    );
    logSponsorPoolEvent(SPONSOR_POOL_LEASE_COMMITTED, {
      adapter: 'memory',
      slot_id: slotId,
    });
  }

  /**
   * Returns a slot to the pool after /sponsor completes, or on TTL
   * expiry, or on prepare-path failure.
   *
   * `txBytesHash === null` → verify reserved proof then delete.
   * Otherwise                → verify committed proof then delete.
   *
   * Mismatch is a silent no-op to keep background eviction paths
   * idempotent; the Redis lease TTL covers any residual state.
   */
  async checkin(slotId: string, receiptId: string, txBytesHash: string | null): Promise<void> {
    const current = this._leaseProofs.get(slotId);
    const commitDigest = txBytesHash ?? COMMIT_DIGEST_RESERVED;
    const expected = computeLeaseProof(this._hmacSecret, receiptId, slotId, commitDigest);
    if (!leaseProofMatches(current, expected)) return;
    this._inUse.delete(slotId);
    this._leaseProofs.delete(slotId);
    logSponsorPoolEvent(SPONSOR_POOL_LEASE_CHECKIN, {
      adapter: 'memory',
      slot_id: slotId,
      stage: txBytesHash === null ? 'reserved' : 'committed',
      pool_size: this.size,
      in_use: this._inUse.size,
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
      leased: this._inUse.has(address),
    }));
    const leasedSlots = slots.filter((slot) => slot.leased).length;
    return {
      leasedSlots,
      freeSlots: this.size - leasedSlots,
      slots,
    };
  }

  async sign(
    slotId: string,
    receiptId: string,
    txBytes: Uint8Array,
  ): Promise<{ signature: string }> {
    // Committed HMAC lease proof check — the only gate between a
    // Redis-only attacker and the in-memory signing keypair.
    // Reserved-stage leases fail this check because the reservation
    // sentinel can never collide with a hex SHA-256 digest.
    const expected = computeLeaseProof(this._hmacSecret, receiptId, slotId, sha256Hex(txBytes));
    if (!leaseProofMatches(this._leaseProofs.get(slotId), expected)) {
      throw new SponsorLeaseExpiredError(slotId);
    }
    const keypair = this._keypairs.get(slotId);
    if (!keypair) {
      throw new Error(`SponsorPool: unknown slotId ${slotId}`);
    }
    logSponsorPoolEvent(SPONSOR_POOL_SIGN, {
      adapter: 'memory',
      slot_id: slotId,
      tx_bytes_len: txBytes.length,
    });
    return keypair.signTransaction(txBytes);
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Minimal interface for objects that support explicit cleanup */
interface Disposable {
  dispose(): void;
}

/** Type guard — returns true if `obj` has a callable `dispose()` method */
function isDisposable(obj: unknown): obj is Disposable {
  return typeof (obj as Disposable)?.dispose === 'function';
}

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────

export interface RelayerApiConfig {
  /** Target network */
  network: SuiNetwork;
  /** Sui RPC URL (e.g. "http://127.0.0.1:9000") */
  suiRpcUrl: string;
  /** Deployed package ID */
  packageId: string;
  /** Config shared object ID */
  configId: string;
  /** VaultRegistry shared object ID */
  vaultRegistryId: string;
  /**
   * Trusted DeepBook package ID for the active network.
   *
   * Server-only trust-root data used by sponsor-time abort
   * classification: the sponsor failure subcode classifier binds
   * DeepBook `pool::swap_exact_quantity` aborts to this exact package
   * ID before emitting `SLIPPAGE_EXCEEDED`. External packages with the
   * same module name and abort code do not classify.
   *
   * Shared reference: `DEEPBOOK_IDS[network].packageId` from
   * `@stelis/contracts`. Hosts must provide it here; no env
   * override or synthetic default is permitted.
   *
   * Not a browser/SDK helper export — server-side host integrators
   * pass it explicitly at boot.
   */
  deepbookPackageId: string;
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
   * Abuse blocker — required. Hosts inject `RedisAbuseBlocker` (or a
   * test-only `MemoryAbuseBlocker` from a fixture path). No runtime
   * default.
   */
  abuseBlocker: AbuseBlockerAdapter;
  /**
   * PrepareStoreAdapter — required. Hosts inject `RedisPrepareStore` (or
   * a test-only memory adapter). No runtime default.
   */
  prepareStore: PrepareStoreAdapter;
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
   * Pre-constructed SuiGrpcClient to use instead of creating one from suiRpcUrl.
   * When provided, suiRpcUrl is ignored for client construction.
   * Use this to inject a multi-endpoint failover client from the host layer.
   */
  suiClient?: SuiGrpcClient;
  /**
   * Settlement payout recipient address for execution cost claim plus quoted host fee (required).
   * Must differ from all sponsor addresses.
   * Canonicalized with normalizeSuiAddress at context creation.
   */
  settlementPayoutRecipientAddress: string;
  /** Pre-registered settlement swap paths for L2 validation. */
  allowedSettlementSwapPaths?: AllowedSettlementSwapPath[];
  /**
   * Optional host-provided sponsor result callback. Invoked by sponsor
   * SponsoredExecutionPolicy `Release` hooks after the sponsor runner's
   * `safeSlotCheckin()` boundary, on every path that reached the
   * post-consume stage.
   * Must be best-effort / never-throws (the callback implementation
   * catches its own errors; Release hooks also wrap the invocation in
   * try/catch as defence-in-depth). Used by app-api to drive per-action
   * sponsor operations state updates.
   */
  onSponsorResult?: SponsorResultCallback;
}

// ─────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────

export interface RelayerContext {
  network: SuiNetwork;
  sui: SuiGrpcClient;
  /**
   * Sponsor pool — checkout a slot before signing, checkin after TX completes.
   * Pool size = max concurrent sponsored TXs.
   *
   * Single-key deployments have pool size 1. Multi-key deployments have pool size N.
   */
  sponsorPool: SponsorPoolAdapter;
  packageId: string;
  configId: string;
  vaultRegistryId: string;
  /**
   * Trusted DeepBook package ID for the active network. See
   * `RelayerApiConfig.deepbookPackageId` for the contract.
   * Sponsor-time abort classifier reads this to package-bind
   * DeepBook min-out aborts.
   */
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
   * Prepare store — binds /prepare-issued txBytes + slot lease to a
   * receiptId. Host-injected; production hosts use `RedisPrepareStore`,
   * tests use a fixture adapter. Includes IP concurrency enforcement
   * (max 2 outstanding per IP).
   */
  prepareStore: PrepareStoreAdapter;
  /**
   * Short-TTL store for client-generated prepare request nonces. This is
   * separate from the on-chain settlement nonce stored in `prepareStore`.
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

  /**
   * Cached VaultRegistry.vaults table ID.
   * Resolved once in warmUp() — immutable per vault.move struct.
   * ctx-local, keyed by vaultRegistryId at creation time.
   */
  vaultsTableId: string | null;
  /** Returns cached on-chain Config. Auto-refreshes after TTL. */
  getConfig(): Promise<OnchainConfig>;
  /**
   * Eagerly loads and validates on-chain Config at server startup.
   *
   * createRelayerContext() is sync, so await cannot be used inside it.
   * Call `await ctx.warmUp()` immediately after context creation to:
   *   1. Validate Config object exists on-chain
   *   2. Verify `max_host_fee_mist` / `protocol_flat_fee_mist` / `config_version` / `max_spread_bps` fields are present (fail-closed)
   *   3. Pre-populate the cache so the first API request has no cold-start latency
   *
   * If warmUp() throws, the server should exit immediately.
   */
  warmUp(): Promise<void>;
  /**
   * Invalidates the cached on-chain Config, forcing a fresh fetch on the next getConfig() call.
   * Call this at the start of /sponsor to detect fee drift since /prepare time.
   */
  invalidateConfigCache(): void;
  /**
   * Releases background resources held by injected coordination
   * adapters that implement `Disposable` (e.g. `MemoryPrepareStore`'s
   * eviction timer in test fixtures). Production Redis-backed adapters
   * do not implement `Disposable`; the host disposes the underlying
   * Redis client via its own shutdown flow (see
   * `app-api/src/context.ts` `dispose()`).
   *
   * Ownership contract:
   *   - Hosts and tests own the lifecycle of every adapter they inject
   *     into `createRelayerContext()`. `dispose()` is a convenience
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
  dispose(): void;
  /**
   * Host-provided post-sponsor result callback for sponsor handlers. See
   * `onSponsorResult` in `RelayerApiConfig` for the contract.
   * `undefined` means no callback is wired; handlers skip invocation.
   */
  onSponsorResult?: SponsorResultCallback;
}

/**
 * Creates a RelayerContext from configuration.
 * Call once at server startup, then pass to all handlers.
 *
 * Every coordination adapter (`sponsorPool`, `prepareStore`,
 * `prepareInflightLimiter`, `rateLimiter`, `abuseBlocker`) is required. There
 * is no in-memory runtime default. Hosts must inject production-capable adapters
 * (Redis-backed for `app-api`); test code injects memory fixtures directly.
 * Missing adapters fail closed at construction time.
 */
export function createRelayerContext(config: RelayerApiConfig): RelayerContext {
  const sui =
    config.suiClient ?? new SuiGrpcClient({ network: config.network, baseUrl: config.suiRpcUrl });

  if (!config.sponsorPool) {
    throw new Error(
      'createRelayerContext: sponsorPool is required (production hosts inject RedisSponsorPool; tests inject a fixture pool). No runtime default is provided.',
    );
  }
  if (!config.prepareStore) {
    throw new Error(
      'createRelayerContext: prepareStore is required (production hosts inject RedisPrepareStore; tests inject a fixture store).',
    );
  }
  if (!config.prepareRequestNonceStore) {
    throw new Error(
      'createRelayerContext: prepareRequestNonceStore is required (production hosts inject RedisPrepareRequestNonceStore; tests inject a fixture store).',
    );
  }
  if (!config.prepareInflightLimiter) {
    throw new Error(
      'createRelayerContext: prepareInflightLimiter is required (production hosts inject RedisPrepareInflight; tests inject a fixture limiter).',
    );
  }
  if (!config.rateLimiter) {
    throw new Error(
      'createRelayerContext: rateLimiter is required (production hosts inject RedisRateLimiter; tests inject a fixture limiter).',
    );
  }
  if (!config.abuseBlocker) {
    throw new Error(
      'createRelayerContext: abuseBlocker is required (production hosts inject RedisAbuseBlocker; tests inject a fixture blocker).',
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

  let cachedConfig: OnchainConfig | null = null;
  let cacheTimestamp = 0;
  let inflightFetch: Promise<OnchainConfig> | null = null;

  function parseOnchainNonNegativeBigInt(value: string | number, field: string): bigint {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Config field ${field} must be a non-negative safe integer`);
      }
      return BigInt(value);
    }
    if (!/^(?:0|[1-9]\d*)$/.test(value)) {
      throw new Error(`Config field ${field} must be a non-negative decimal integer string`);
    }
    return BigInt(value);
  }

  async function getConfig(): Promise<OnchainConfig> {
    const now = Date.now();
    if (cachedConfig && now - cacheTimestamp < cacheTtl) {
      return cachedConfig;
    }

    // Singleflight: reuse inflight fetch to avoid redundant RPC calls
    // when multiple concurrent requests invalidate the cache simultaneously.
    if (inflightFetch) return inflightFetch;

    inflightFetch = (async () => {
      try {
        const obj = await sui.getObject({
          objectId: config.configId,
          include: { json: true },
        });

        const objData = obj.object;
        /** Minimal shape of the on-chain Config object JSON fields */
        interface OnchainConfigFields {
          max_host_fee_mist?: string | number | null;
          protocol_flat_fee_mist?: string | number | null;
          max_claim_mist?: string | number | null;
          min_settle_mist?: string | number | null;
          config_version?: string | number | null;
          max_spread_bps?: string | number | null;
        }
        const fields = objData?.json as OnchainConfigFields | null | undefined;
        if (!fields) {
          throw new Error(`Config object ${config.configId} not found or not a Move object`);
        }

        // Fail-closed: throw immediately if fee fields are absent.
        // Fees are read from the on-chain Config.
        // Missing fields indicate a contract version mismatch and must block prepare/sponsor issuance.
        if (
          fields.max_host_fee_mist == null ||
          fields.protocol_flat_fee_mist == null ||
          fields.max_claim_mist == null ||
          fields.min_settle_mist == null ||
          fields.config_version == null ||
          fields.max_spread_bps == null
        ) {
          throw new Error(
            `Config object ${config.configId} missing required fields ` +
              `(max_host_fee_mist, protocol_flat_fee_mist, config_version, max_spread_bps). ` +
              `Ensure the deployed Config was created with the current contract version.`,
          );
        }

        cachedConfig = {
          packageId: config.packageId,
          configId: config.configId,
          maxClaimMist: parseOnchainNonNegativeBigInt(fields.max_claim_mist, 'max_claim_mist'),
          minSettleMist: parseOnchainNonNegativeBigInt(fields.min_settle_mist, 'min_settle_mist'),
          maxHostFeeMist: parseOnchainNonNegativeBigInt(
            fields.max_host_fee_mist,
            'max_host_fee_mist',
          ),
          protocolFlatFeeMist: parseOnchainNonNegativeBigInt(
            fields.protocol_flat_fee_mist,
            'protocol_flat_fee_mist',
          ),
          configVersion: parseOnchainNonNegativeBigInt(fields.config_version, 'config_version'),
          maxSpreadBps: parseOnchainNonNegativeBigInt(fields.max_spread_bps, 'max_spread_bps'),
        };
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
    packageId: config.packageId,
    configId: config.configId,
    vaultRegistryId: config.vaultRegistryId,
    deepbookPackageId: config.deepbookPackageId,
    // All coordination adapters are host-injected (validated above);
    // there is no in-memory runtime default. Production hosts inject
    // Redis-backed adapters (`RedisRateLimiter`, `RedisAbuseBlocker`,
    // `RedisPrepareStore`, `RedisPrepareInflight`, `RedisSponsorPool`).
    // Test code injects memory fixtures directly through this same
    // contract. See "Production Store Adapters" in `docs/operations.md`.
    rateLimiter: config.rateLimiter,
    abuseBlocker: config.abuseBlocker,
    prepareStore: config.prepareStore,
    prepareRequestNonceStore: config.prepareRequestNonceStore,
    prepareInflightLimiter: config.prepareInflightLimiter,
    settlementPayoutRecipientAddress: recipientAddr,
    allowedSettlementSwapPaths: config.allowedSettlementSwapPaths ?? [],
    vaultsTableId: null,
    getConfig,
    async warmUp() {
      await getConfig();
      // Resolve and cache VaultRegistry.vaults table ID (immutable per vault.move).
      // Uses exported helpers from @stelis/core-relay/creditQuery.
      const registryObj = await sui.getObject({
        objectId: config.vaultRegistryId,
        include: { json: true },
      });
      const registryFields = extractMoveObjectFields(registryObj.object);
      const tableId = extractVaultTableId(registryFields);
      if (!tableId) {
        throw new Error(
          `VaultRegistry ${config.vaultRegistryId} is missing the vaults table ID. ` +
            `Cannot start without cached tableId (fail-closed).`,
        );
      }
      this.vaultsTableId = tableId;
    },
    invalidateConfigCache(): void {
      // Force next getConfig() to fetch fresh from chain by resetting the cache timestamp.
      // This ensures /sponsor always re-reads fees before validation — detects any drift
      // between /prepare and /sponsor time without waiting for the cache TTL.
      cacheTimestamp = 0;
    },
    dispose() {
      // Dispatch dispose() to every injected adapter that implements
      // it. Hosts and tests own the underlying lifecycle (see the
      // `dispose()` doc on `RelayerContext`); this dispatcher fans out
      // to memory fixtures that hold background timers (e.g.
      // `MemoryPrepareStore`) so test teardown does not have to walk
      // every adapter manually. Production Redis adapters do not
      // implement `Disposable`, so the corresponding branches are
      // no-ops at runtime.
      if (isDisposable(this.prepareStore)) this.prepareStore.dispose();
      if (isDisposable(this.prepareInflightLimiter)) this.prepareInflightLimiter.dispose();
      if (isDisposable(this.rateLimiter)) this.rateLimiter.dispose();
      if (isDisposable(this.abuseBlocker)) this.abuseBlocker.dispose();
      if (isDisposable(this.sponsorPool)) this.sponsorPool.dispose();
    },
    onSponsorResult: config.onSponsorResult,
  };
}
