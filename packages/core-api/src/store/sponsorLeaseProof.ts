/**
 * sponsorLeaseProof — shared HMAC helper for sponsor slot lease fencing.
 *
 * Shared lease proof format used by both
 * `SponsorPool` (in-memory) and `RedisSponsorPool`. Keeping this in one
 * place prevents drift between the two pool adapters.
 *
 * Current proof binding:
 *
 * Sponsor-side verdicts are tx-derived (parsed settle args + fresh
 * on-chain config + explicit sender binding). The remaining off-chain
 * authority is the sponsor-pool slot signing gate. A receipt/slot-only
 * HMAC is insufficient, because a live lease proof can be replayed
 * against a forged prepare entry under the same `receiptId`.
 *
 * The current proof binds sponsor admission to the prepare commit itself.
 * The commit digest is the prepare-time SHA-256 of the built PTB
 * (`GenericPrepareBuildOutput.txBytesHash`), so a Redis-only attacker cannot
 * forge a proof that matches an attacker-chosen `txBytes` unless they also
 * know the process-env secret.
 *
 * Signed string shape:
 *   `${receiptId}|${slotId}|${commitDigest}`
 *
 *   commitDigest =
 *     COMMIT_DIGEST_RESERVED  (at `checkout`, before prepare commit exists)
 *   | txBytesHash             (hex SHA-256; set by `commit`, verified by `sign`)
 *
 * The literal `|` separator prevents boundary ambiguity between fields.
 * `receiptId` is `0x` + 64 hex chars, `slotId` is a Sui address
 * (`0x` + 64 hex chars), and `txBytesHash` is 64 hex chars; none of them
 * contain the separator.
 *
 * Reserved-stage fail-closed: `COMMIT_DIGEST_RESERVED` is a literal that
 * contains a colon, so it can never collide with a valid SHA-256 hex
 * digest. `sign()` calls during the reserved window compute their proof
 * against `hash(txBytes)` and therefore reject every candidate transaction
 * — no tx can match the reserved HMAC. This guarantees that
 * `checkout → sign` without `commit` always fails closed.
 *
 * Slot pinning: including `slotId` in the payload prevents a receipt +
 * hash combination from being reused against a different slot. Commit
 * pinning: including the prepare commit digest prevents a live lease from
 * authorising any PTB other than the one the prepare flow committed to.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimum acceptable length for `SPONSOR_LEASE_HMAC_SECRET`. Matches the
 * admin JWT secret floor used elsewhere in the host boot validation.
 * Callers (boot / context factories) must enforce this.
 */
export const SPONSOR_LEASE_HMAC_SECRET_MIN_LENGTH = 32;

/**
 * Sentinel commit digest used during the reservation window — between
 * `SponsorPoolAdapter.checkout()` and the caller-driven
 * `SponsorPoolAdapter.commit()` that transitions the lease to the
 * committed stage. The sentinel contains a colon and so can never
 * collide with a hex-encoded SHA-256 digest, which guarantees that
 * `sign()` during the reservation window fails closed for every
 * candidate `txBytes`.
 */
export const COMMIT_DIGEST_RESERVED = ':reserved';

/**
 * Typed error raised when a lease transition fails closed. Callers
 * (prepare handlers) must report this rather than retrying or
 * swallowing: a failed CAS means the pool state does not match the
 * caller's expected lease lifecycle, and silent recovery would mask
 * either a concurrent actor or a forged state.
 */
export class SponsorLeaseCommitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SponsorLeaseCommitError';
    this.code = code;
  }
}

/**
 * Compute the lease proof for a `(receiptId, slotId, commitDigest)` tuple.
 *
 * Returns a hex-encoded HMAC-SHA256 digest. The output length is 64
 * characters, which is safe to store in Redis as a normal string value.
 *
 * Callers pass `COMMIT_DIGEST_RESERVED` during the checkout window and
 * the prepare commit hash (`buildResult.txBytesHash`) during the
 * committed window. A `sign()` call computes its expected proof from
 * `hash(txBytes)` and so will only match the stored value when the
 * submitted transaction matches the commit.
 */
export function computeLeaseProof(
  secret: string,
  receiptId: string,
  slotId: string,
  commitDigest: string,
): string {
  return createHmac('sha256', secret)
    .update(`${receiptId}|${slotId}|${commitDigest}`)
    .digest('hex');
}

/**
 * Constant-time comparison of a stored lease proof against the expected
 * proof computed for a `(receiptId, slotId, commitDigest)` tuple.
 *
 * `stored` is the Redis / in-memory value observed by the pool adapter.
 * `expected` is the fresh computation from `computeLeaseProof`.
 *
 * Returns `false` for any length mismatch, non-string inputs, or
 * constant-time digest mismatch. Never throws on malformed input.
 */
export function leaseProofMatches(stored: unknown, expected: string): boolean {
  if (typeof stored !== 'string') return false;
  if (stored.length !== expected.length) return false;
  const storedBuf = Buffer.from(stored, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (storedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(storedBuf, expectedBuf);
}
