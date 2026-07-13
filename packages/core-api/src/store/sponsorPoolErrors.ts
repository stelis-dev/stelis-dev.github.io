/**
 * Shared error class for the sponsor pool layer.
 *
 * Kept in a shared file so that both pool implementations (SponsorPool,
 * RedisSponsorPool) and the sponsor runner / public handler adapter can import from a
 * single source without creating a circular dependency.
 *
 * Layering rule:
 *   store/sponsorPoolErrors.ts  ← pool adapters throw this
 *                               ← sponsor runner / handler adapter catch this
 *                               ← host routes import via index.ts
 */

/**
 * Thrown by `SponsorPoolAdapter.sign()` when the committed two-stage HMAC
 * lease proof for `(receiptId, sponsorAddress, hash(submittedTxBytes))` does not
 * match the stored value — either because the slot was re-allocated
 * after TTL expiry, the lease is still in the reservation stage and
 * therefore cannot satisfy any submitted tx, or the Redis lease value
 * references a different `txBytesHash` than the submitted bytes (for
 * example after a Redis-write attacker overwrites an existing
 * `entry[receiptId].txBytesHash` under a live committed lease).
 *
 * Maps to HTTP 503 with `Retry-After: 1`.
 * The client must re-call `/prepare` to obtain a fresh slot and lease.
 */
export class SponsorLeaseExpiredError extends Error {
  readonly code = 'LEASE_EXPIRED' as const;

  constructor(sponsorAddress: string) {
    super(`Sponsor lease expired for address ${sponsorAddress} — retry /prepare`);
    this.name = 'SponsorLeaseExpiredError';
  }
}
