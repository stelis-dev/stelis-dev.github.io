/**
 * [app-api] Cross-instance Sponsor Refill Account dispatch lock.
 *
 * Serializes new spend work and request-path recovery for every refill and
 * withdrawal that uses the same Sponsor Refill Account. Boot recovery may
 * bypass a dead process's remaining efficiency-lock TTL. Acquired via
 * `SET key value NX PX` with an
 * instance-unique token; released via Lua CAS that deletes only when the
 * stored token matches (mirrors `RedisSponsorPool.LEASE_CHECKIN_CAS_SCRIPT`).
 *
 * The TTL is an orphan cleanup and efficiency bound, not transaction safety.
 * Durable operation identity and expected-sequence CAS remain authoritative
 * when the TTL expires while an RPC request is still in flight.
 */

import { randomUUID } from 'node:crypto';
import type { RedisClientLike } from '@stelis/core-api';
import { SPONSOR_OPERATIONS_KEY_PREFIX } from './redisState.js';

export const sponsorRefillAccountDispatchLockKey = (sponsorRefillAccountAddress: string): string =>
  `${SPONSOR_OPERATIONS_KEY_PREFIX}sponsor-refill-account-dispatch-lock:${sponsorRefillAccountAddress}`;

/**
 * Lua CAS used by `release`:
 *   if GET(key) == ARGV[1] (expected token) DEL(key) return 'OK'
 *   else                                                return 'MISMATCH'
 * Mismatch is a silent no-op at the TS layer: TTL safety net covers it.
 */
const RELEASE_LUA = [
  "local current = redis.call('GET', KEYS[1])",
  'if current == ARGV[1] then',
  "  redis.call('DEL', KEYS[1])",
  "  return 'OK'",
  'end',
  "return 'MISMATCH'",
].join('\n');

export interface SponsorRefillAccountDispatchLockHandle {
  /** Opaque token identifying the owner; required for release CAS. */
  readonly token: string;
  /** Sponsor refill account address the dispatch lock is held for. */
  readonly sponsorRefillAccountAddress: string;
}

export interface SponsorRefillAccountDispatchLockDeps {
  readonly client: RedisClientLike;
  /**
   * Lock TTL in ms. It bounds abandoned mutex ownership only; correctness
   * does not depend on it outliving network submission.
   */
  readonly ttlMs: number;
  /**
   * Optional instance-scoped prefix for the lock token. Useful in
   * multi-instance deployments for log correlation. Defaults to a short
   * constant; the token itself is randomised per acquisition.
   */
  readonly instanceId?: string;
}

export interface SponsorRefillAccountDispatchLock {
  acquire(
    sponsorRefillAccountAddress: string,
  ): Promise<SponsorRefillAccountDispatchLockHandle | null>;
  release(handle: SponsorRefillAccountDispatchLockHandle): Promise<void>;
}

export function createSponsorRefillAccountDispatchLock(
  deps: SponsorRefillAccountDispatchLockDeps,
): SponsorRefillAccountDispatchLock {
  if (!Number.isSafeInteger(deps.ttlMs) || deps.ttlMs <= 0) {
    throw new Error(
      `createSponsorRefillAccountDispatchLock: ttlMs must be a positive safe integer, got ${String(deps.ttlMs)}`,
    );
  }
  const instanceId = deps.instanceId ?? 'app-api';

  async function acquire(
    sponsorRefillAccountAddress: string,
  ): Promise<SponsorRefillAccountDispatchLockHandle | null> {
    const token = `${instanceId}:${randomUUID()}`;
    const key = sponsorRefillAccountDispatchLockKey(sponsorRefillAccountAddress);
    const result = await deps.client.set(key, token, { nx: true, px: deps.ttlMs });
    if (result !== 'OK') return null;
    return { token, sponsorRefillAccountAddress };
  }

  async function release(handle: SponsorRefillAccountDispatchLockHandle): Promise<void> {
    const key = sponsorRefillAccountDispatchLockKey(handle.sponsorRefillAccountAddress);
    try {
      await deps.client.eval(RELEASE_LUA, [key], [handle.token]);
    } catch {
      // TTL safety net covers residual state; swallowing is intentional.
    }
  }

  return { acquire, release };
}
