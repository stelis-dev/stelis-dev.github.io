/**
 * PrepareStoreAdapter — interface for /prepare binding storage.
 *
 * Binds receiptId → PreparedTx and holds slotId until /sponsor or TTL expiry.
 *
 * Implementations:
 *   - `RedisPrepareStore` — required for production hosts; `app-api`
 *     injects this at boot.
 *   - `MemoryPrepareStore` — test-only fixture; not exported from the
 *     `@stelis/core-api` main barrel and not used as a runtime
 *     fallback.
 *
 * Key invariants:
 *   - Single-use: consume() deletes the entry (1-time use per receiptId)
 *   - Slot lease: sponsor slot is held from /prepare → /sponsor or TTL expiry
 *   - IP concurrency: max MAX_CONCURRENT_PER_IP outstanding entries per IP
 *   - Background eviction: expired entries auto-evict and release slots
 */
// ─────────────────────────────────────────────
// Base fields shared by all modes
// ─────────────────────────────────────────────

/**
 * Common fields present in every PreparedTxEntry regardless of mode.
 * Not exported — use the discriminated union `PreparedTxEntry` instead.
 *
 * Gas estimation fields are intentionally absent:
 *   - Generic: the sponsor path re-derives every settle value from
 *     `parseSettleArgs(txBytes)` at /relay/sponsor time
 *     (`ExtractedSettleArgs` is the execution authority), so the
 *     generic entry carries no settle observability copies.
 *   - Promotion: `reservedGasMist` lives on `PromotionPreparedTxEntry`.
 *     It is the ceiling passed to `ExecutionLedger.reserve()` and
 *     compared against actual execution gas in the Studio sponsor
 *     SponsoredExecutionPolicy sponsor result accounting (consume → usage append →
 *     structured log).
 */
interface PreparedTxEntryBase {
  // ── Binding (from QuoteStore pattern) ─────────────────────────
  /** Unix timestamp (ms) of prepare issuance */
  issuedAt: number;
  /** Unique receipt ID */
  receiptId: string;
  /** User wallet address */
  senderAddress: string;

  // ── Anti-tampering ────────────────────────────────────────────
  /** SHA-256 hex of the full txBytes — verified in /sponsor */
  txBytesHash: string;

  // ── Slot reservation (from ExecuteTicketStore pattern) ────────
  /** Pre-checked-out sponsor slot identifier */
  slotId: string;
  /** Sponsor address for the leased slot */
  sponsorAddress: string;
  // The raw lease fencing token is gone. The sponsor pool adapter commits
  // `HMAC(secret, receiptId || slotId || commitDigest)` to its lease
  // store, where `commitDigest` is a reserved sentinel after
  // `checkout()` and `txBytesHash` after the prepare runner calls
  // `sponsorPool.commit()` just before `prepareStore.store()`. `sign()`
  // verifies that proof against `hash(txBytes)`, so `receiptId` is the
  // lease identity and `txBytesHash` (elsewhere in this entry) is the
  // prepare-commit authenticator. Both are already persisted under
  // their own fields; no extra lease material lives here.

  // ── IP tracking (for max concurrent enforcement) ─────────────
  /** Client IP that issued this prepare request */
  clientIp: string;

  // ── Execution path key (for structured error logging) ───────────────
  /**
   * Canonical execution path identifier: `{tokenType}:{hop1,hop2,...}:{settlementSwapDirection}`.
   * Derived from the matched AllowedSettlementSwapPath at /prepare time. Attached to sponsor
   * failure records so that ONCHAIN_REVERT logs can be correlated to a specific execution path.
   */
  executionPathKey: string;

  // ── Order ID (payment tracking) ─────────────────────────────────
  /** Original orderId from /prepare request (null if not provided). */
  orderId: string | null;

  // ── S-14: Monotonic nonce ──────────────────────────────────────
  /** Server-assigned monotonic nonce for on-chain replay prevention. */
  nonce: bigint;
}

// ─────────────────────────────────────────────
// Mode-specific entry types
// ─────────────────────────────────────────────

/**
 * Generic relay prepare entry — `/relay/prepare` → `/relay/sponsor`.
 *
 * Coordination-only at `/relay/sponsor`. Every execution-critical settle
 * value (executionCostClaim, fee components, profile, policyHash,
 * quoteTimestampMs) is derived from the submitted `txBytes` via
 * `parseSettleArgs(...)` at sponsor time; `txBytesHash` consume() proves
 * byte-equality with the /prepare commit. The store therefore carries
 * only the coordination fields the sponsor lifecycle needs (slot
 * identity, hash binding, receipt identity, IP/execution-path observability echo,
 * monotonic nonce compaction key, optional orderId echo for L2
 * reconstruction).
 *
 * Build-derived observability fields (`executionCostClaim`, `simGas`,
 * `gasVarianceFixedMist`, `slippageBufferMist`, `grossGas`, `profile`,
 * `quoteTimestampMs`, `policyHash`, `quotedHostFeeMist`) are not
 * persisted — sponsor authority never reads them from the store, and
 * keeping copies would invite drift. See
 * architecture/prepare-sponsor-session.md for the full coordination-only
 * contract.
 */
export interface GenericPreparedTxEntry extends PreparedTxEntryBase {
  mode: 'generic';
  // Generic mode never carries promotion fields.
  promotionId?: never;
  userId?: never;
}

/**
 * Promotion prepare entry — `/studio/promotions/:id/prepare` → `.../sponsor`.
 *
 * Contains promotion-specific fields for ExecutionLedger reserve/consume/release.
 * Does NOT carry generic settle-specific fields (no settle PTB, no policy hash,
 * no host fee, no config drift detection, no GenericPrepareBuildOutput gas estimation fields).
 *
 * `reservedGasMist` is the amount passed to `ExecutionLedger.reserve()` at prepare
 * time and used as the ceiling for actual gas comparison in the Studio sponsor
 * SponsoredExecutionPolicy sponsor result accounting. It is the dry-run simGas +
 * GAS_VARIANCE_FIXED_MIST, not a "execution cost claim" in the generic settle sense.
 */
export interface PromotionPreparedTxEntry extends PreparedTxEntryBase {
  mode: 'promotion';

  /** Promotion ID — used to re-verify at sponsor time. */
  promotionId: string;
  /** Developer's userId — used for sponsor-side identity binding (security gate) and ledger audit. */
  userId: string;
  /**
   * Gas ceiling reserved via `ExecutionLedger.reserve()` at prepare time (MIST).
   * = dry-run simGas + GAS_VARIANCE_FIXED_MIST.
   * Compared to actual gas in the Studio sponsor SponsoredExecutionPolicy sponsor result
   * accounting to compute the delta released back to the ledger when actual <
   * reserved.
   *
   * Persisted as raw `bigint`. Internal computation paths keep the package's
   * internal nominal unit brand; the brand is dropped at the public store
   * boundary so that `@stelis/core-api`'s public declaration graph stays free
   * of package-internal types.
   */
  reservedGasMist: bigint;
}

/**
 * Discriminated union of all prepare entry modes.
 *
 * Use `entry.mode` to narrow:
 * ```ts
 * if (entry.mode === 'generic') {
 *   entry.promotionId;       // never — TS error
 * }
 * if (entry.mode === 'promotion') {
 *   entry.promotionId;       // string — accessible
 * }
 * ```
 */
export type PreparedTxEntry = GenericPreparedTxEntry | PromotionPreparedTxEntry;

// ─────────────────────────────────────────────
// Store adapter interface
// ─────────────────────────────────────────────

/**
 * Store adapter for prepare entries.
 *
 * Implementations must guarantee:
 *   1. Atomic 1-time consume semantics (same as ExecuteTicketStore)
 *   2. Slot release on TTL expiry or error
 *   3. IP concurrency enforcement (max outstanding per IP)
 */
export interface PrepareStoreAdapter {
  /**
   * Store a prepared TX entry.
   *
   * Before storing, enforces IP concurrency limit:
   *   - If the IP already has MAX_CONCURRENT_PER_IP outstanding entries,
   *     evicts the oldest one (releasing its slot) before storing the new one.
   *
   * The slot MUST already be checked out before calling this.
   */
  store(receiptId: string, entry: PreparedTxEntry): Promise<void>;

  /**
   * Atomically consume a prepare entry in /sponsor.
   *
   * Returns:
   *   - PreparedTxEntry: success — entry deleted, slot NOT released (caller's finally)
   *   - 'not_found': receiptId absent (never stored, already consumed, or evicted)
   *   - 'expired': TTL exceeded — slot released internally, entry deleted
   *   - 'hash_mismatch': txBytesHash mismatch — slot released, entry deleted
   *
   * Note: background eviction may convert 'expired' → 'not_found' (race condition).
   * Clients should treat both as "retry /prepare".
   */
  consume(
    receiptId: string,
    txBytesHash: string,
  ): Promise<PreparedTxEntry | 'not_found' | 'expired' | 'hash_mismatch'>;

  /**
   * Read without consuming. Returns null if not found or logically expired.
   *
   * Throws if the entry exists but cannot be deserialized (corrupt JSON,
   * unsupported schema version, etc.). Callers must catch the throw and
   * use `evictPreparedEntry(receiptId)` to release the held slot before
   * rejecting the request — silently returning `null` would let an
   * unparseable entry hold its sponsor slot until lease TTL.
   */
  peek(receiptId: string): Promise<PreparedTxEntry | null>;

  /**
   * Best-effort invalidation of a stored prepared entry: atomically deletes
   * the entry and releases the held sponsor slot. Idempotent and never
   * throws.
   *
   * Used for corrupt-entry eviction. `peek()` or `consume()` threw on
   * deserialize failure; raw JSON is read without invoking the typed
   * deserializer, `slotId` and `receiptId` are extracted from it, and the
   * entry is deleted. Sponsor-time policy rejections that parse cleanly are
   * owned by their route-local lifecycle code and may intentionally preserve
   * the prepared entry for retry.
   *
   * Implementation contract:
   *   1. Extract `slotId` and `receiptId` from whatever form of the
   *      entry is available (raw JSON fallback if typed read failed).
   *   2. Delete the entry from the store atomically.
   *   3. Call the configured `onRelease(slotId, receiptId)` to return
   *      the sponsor slot via the HMAC lease fencing path.
   *
   * Idempotent: a no-op if the entry is already gone. Must NEVER throw —
   * callers are already on a failure path.
   */
  evictPreparedEntry(receiptId: string): Promise<void>;

  /**
   * Pre-check Studio user quota before slot checkout for the promotion
   * route.
   *
   * Counts live promotion-mode entries by verified developer JWT
   * `userId`. Generic `/relay/prepare` skips per-subject quota because
   * unauthenticated `senderAddress` enables victim-targeted DoS; only
   * the promotion route has a pre-verified subject (`userId`) suitable
   * for outstanding-prepare quota enforcement.
   *
   * The authoritative quota check still lives in `store()` and uses the
   * same userIndex; this method is the best-effort precheck before
   * slot/RPC resources are consumed.
   *
   * Returns 'ok' or `{ exceeded: true, limit }` where `limit` is the
   * adapter's configured max so the prepare route can report the actual value
   * in errors.
   */
  checkUserQuota(userId: string): Promise<'ok' | { exceeded: true; limit: number }>;

  /**
   * S-14: Reserve the next monotonic nonce for a verified sender.
   *
   * Returns `max(onchainLastNonce, maxLiveNonce, maxPendingNonce) + 1` atomically.
   * The reservation is a live token, not a lifetime HWM:
   *   - `store()` promotes the pending reservation to a live entry (implicit confirm).
   *   - `releaseReservation()` removes the pending reservation on pre-store failure.
   *   - Entry expiry/consume removes the nonce from the live set.
   *
   * Also enforces the sender outstanding-prepare quota against live and
   * pending sender-local entries. This method is called only after
   * prepare authorization proves control of `senderAddress`.
   *
   * No standalone sender HWM is retained after all reservations and entries are gone.
   *
   * @param senderAddress   - User wallet address
   * @param onchainLastNonce - Current on-chain vault.last_nonce (from queryUserCredit)
   * @param reservationId   - Unique reservation identity (canonical receiptId hex string)
   */
  reserveNonce(
    senderAddress: string,
    onchainLastNonce: bigint,
    reservationId: string,
  ): Promise<bigint>;

  /**
   * Release a pending nonce reservation on pre-store failure.
   *
   * Must be called when `reserveNonce()` succeeded but `store()` was never reached
   * (e.g. build failure, validation failure after nonce reservation).
   * No-op if the reservation does not exist (idempotent).
   */
  releaseReservation(reservationId: string, senderAddress: string): Promise<void>;
}
