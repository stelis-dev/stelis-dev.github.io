import { createHash } from 'node:crypto';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SponsorSlotLeaseSummary } from '@stelis/contracts';
import type { SponsorLease, SponsorPoolAdapter, SponsorPoolOptions } from '../context.js';
import { logSponsorPoolEvent } from '../sponsorPoolEventLog.js';
import {
  SPONSOR_POOL_LEASE_CHECKIN,
  SPONSOR_POOL_LEASE_CHECKOUT,
  SPONSOR_POOL_LEASE_COMMITTED,
  SPONSOR_POOL_LEASE_EXHAUSTED,
  SPONSOR_POOL_SIGN,
} from '../observability/events.js';
import { PREPARE_TTL_MS } from '../preparePolicy.js';
import type { RedisClientLike } from './redisClient.js';
import { SponsorLeaseExpiredError } from './sponsorPoolErrors.js';
import {
  computeLeaseProof,
  leaseProofMatches,
  COMMIT_DIGEST_RESERVED,
  SponsorLeaseCommitError,
  SPONSOR_LEASE_HMAC_SECRET_MIN_LENGTH,
} from './sponsorLeaseProof.js';
import { assertSponsorSlotCount } from '../sponsorSlotPolicy.js';

/** Extra slot-lease grace after prepare receipt expiry. */
const SPONSOR_LEASE_TTL_GRACE_MS = 5_000;

export interface RedisSponsorPoolOptions extends SponsorPoolOptions {
  keyPrefix?: string;
  leaseTtlMs?: number;
}

/**
 * Lua checkout used by `checkout()`:
 *
 *   for each rotated lease key
 *     SET(key, reservedProof, NX, PX leaseTtlMs)
 *     return {slotAddress, oneBasedOffset} on the first successful reservation
 *   return false when every slot is leased
 *
 * The HMAC proof is computed in process and passed in ARGV; Redis never
 * receives `SPONSOR_LEASE_HMAC_SECRET`.
 */
const LEASE_CHECKOUT_SCRIPT = `
-- RedisSponsorPool LEASE_CHECKOUT_SCRIPT
local ttlMs = ARGV[1]
local slotCount = #KEYS
for i = 1, slotCount do
  local slotAddress = ARGV[1 + i]
  local reservedProof = ARGV[1 + slotCount + i]
  local result = redis.call('SET', KEYS[i], reservedProof, 'NX', 'PX', ttlMs)
  if result then
    return { slotAddress, tostring(i) }
  end
end
return false
`;

/**
 * Lua lease status read used by `leaseStatus()`:
 *
 *   for each slot lease key
 *     read whether the key currently exists
 *   return the leased slot count and per-slot rows
 *
 * This preserves the admin/prepare lease snapshot shape while reducing
 * client ↔ Redis round trips to one call.
 */
const LEASE_STATUS_SCRIPT = `
-- RedisSponsorPool LEASE_STATUS_SCRIPT
local rows = {}
local leasedSlots = 0
for i = 1, #KEYS do
  local leased = redis.call('GET', KEYS[i]) ~= false
  if leased then
    leasedSlots = leasedSlots + 1
  end
  table.insert(rows, { ARGV[i], leased and '1' or '0' })
end
return { tostring(leasedSlots), rows }
`;

/**
 * Lua CAS used by `commit()`:
 *
 *   if GET(key) == ARGV[1] (reserved proof)
 *     SET(key, ARGV[2] (committed proof), PX ARGV[3])
 *     return 'OK'
 *   else
 *     return 'LEASE_MISSING' (key absent) or 'LEASE_COMMIT_CAS_FAILED'
 *
 * We re-set with an explicit PX rather than KEEPTTL so the committed
 * window starts from a fresh TTL matching `leaseTtlMs`. That keeps the
 * lease window bounded even if the reservation lingered briefly.
 */
const LEASE_COMMIT_CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 'OK'
else
  if current == false then
    return 'LEASE_MISSING'
  end
  return 'LEASE_COMMIT_CAS_FAILED'
end
`;

/**
 * Lua CAS used by `checkin()`:
 *
 *   if GET(key) == ARGV[1] (expected proof for the supplied stage)
 *     DEL(key)
 *     return 'OK'
 *   else
 *     return 'MISMATCH'
 *
 * Mismatch is a silent no-op at the TS layer (background eviction must
 * not cascade-log every stale callback), so the caller just ignores the
 * result.
 */
const LEASE_CHECKIN_CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 'OK'
end
return 'MISMATCH'
`;

/** Hex SHA-256 of the built txBytes — the canonical commit digest. */
function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Redis-backed sponsor slot leases.
 *
 * Each slot is represented by a Redis lease key and a local signing
 * keypair. The lease is cross-process; the signer lookup remains local
 * because every instance is configured with the same sponsor key set.
 *
 * Lease lifecycle:
 *
 *   checkout(receiptId)
 *     → Redis[lease:sponsorAddress] = HMAC(secret, receiptId||sponsorAddress||":reserved")
 *       via Lua-wrapped `SET NX PX` over the rotated slot list. The
 *       first free slot is reserved and existing leases are refused.
 *
 *   commit(sponsorAddress, receiptId, txBytesHash)
 *     → Lua CAS: expect reserved proof, swap to
 *       HMAC(secret, receiptId||sponsorAddress||txBytesHash). Any mismatch
 *       (missing, wrong receiptId, already committed) raises
 *       `SponsorLeaseCommitError` — silent no-op is not allowed.
 *
 *   sign(sponsorAddress, receiptId, txBytes)
 *     → computes HMAC(secret, receiptId||sponsorAddress||hash(txBytes)) and
 *       compares to the stored value. Reserved leases fail this check
 *       because the sentinel never collides with a hex digest. A
 *       Redis-write attacker who overwrites the prepare entry under
 *       `receiptId` to a forged `txBytesHash` still cannot satisfy
 *       sign() — the Redis lease value was committed by the legitimate
 *       prepare flow to a different hash.
 *
 *   checkin(sponsorAddress, receiptId, txBytesHash|null)
 *     → Lua CAS: expect the proof for the specified stage, then DEL.
 *       Silent no-op on mismatch; the Redis PX TTL covers residual state.
 *
 * The sponsor lease key stores only the HMAC proof. The prepared-entry
 * namespace separately stores `receiptId` and `txBytesHash` for consume and
 * cleanup, but neither namespace stores `SPONSOR_LEASE_HMAC_SECRET`; that
 * secret remains in process env and is what prevents proof forgery.
 */
export class RedisSponsorPool implements SponsorPoolAdapter {
  private readonly _client: RedisClientLike;
  private readonly _keypairs: Map<string, Ed25519Keypair>;
  private readonly _addresses: string[];
  private readonly _keyPrefix: string;
  private readonly _leaseTtlMs: number;
  private readonly _hmacSecret: string;
  private _cursor = 0;

  constructor(
    client: RedisClientLike,
    keypairs: Ed25519Keypair[],
    options: RedisSponsorPoolOptions,
  ) {
    assertSponsorSlotCount(keypairs.length, 'RedisSponsorPool');
    if (
      typeof options?.hmacSecret !== 'string' ||
      options.hmacSecret.length < SPONSOR_LEASE_HMAC_SECRET_MIN_LENGTH
    ) {
      throw new Error(
        `RedisSponsorPool: hmacSecret must be at least ${SPONSOR_LEASE_HMAC_SECRET_MIN_LENGTH} characters ` +
          '(SPONSOR_LEASE_HMAC_SECRET)',
      );
    }
    this._client = client;
    this._keypairs = new Map(keypairs.map((kp) => [kp.toSuiAddress(), kp]));
    this._addresses = keypairs.map((kp) => kp.toSuiAddress());
    this._keyPrefix = options.keyPrefix ?? 'stelis:sponsor_lease:';
    const leaseTtlMs = options.leaseTtlMs ?? PREPARE_TTL_MS + SPONSOR_LEASE_TTL_GRACE_MS;
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) {
      throw new Error('RedisSponsorPool: leaseTtlMs must be a positive safe integer');
    }
    this._leaseTtlMs = leaseTtlMs;
    this._hmacSecret = options.hmacSecret;
  }

  get size(): number {
    return this._addresses.length;
  }

  get primaryAddress(): string {
    return this._addresses[0];
  }

  addresses(): string[] {
    return [...this._addresses];
  }

  async leaseStatus(): Promise<SponsorSlotLeaseSummary> {
    const raw = await this._client.eval(
      LEASE_STATUS_SCRIPT,
      this._addresses.map((address) => this.leaseKey(address)),
      [...this._addresses],
    );

    if (!Array.isArray(raw) || typeof raw[0] !== 'string' || !Array.isArray(raw[1])) {
      throw new Error('RedisSponsorPool.leaseStatus: unexpected Redis response shape');
    }

    const leasedSlots = Number(raw[0]);
    const rawSlots = raw[1] as readonly unknown[];
    if (
      !Number.isSafeInteger(leasedSlots) ||
      leasedSlots < 0 ||
      leasedSlots > this.size ||
      rawSlots.length !== this._addresses.length
    ) {
      throw new Error('RedisSponsorPool.leaseStatus: unexpected Redis slot count');
    }

    const slots = rawSlots.map((rawSlot, i) => {
      if (!Array.isArray(rawSlot)) {
        throw new Error('RedisSponsorPool.leaseStatus: unexpected Redis slot row');
      }
      const row = rawSlot as readonly unknown[];
      const address = row[0];
      const leased = row[1];
      if (
        typeof address !== 'string' ||
        address !== this._addresses[i] ||
        (leased !== '1' && leased !== '0')
      ) {
        throw new Error('RedisSponsorPool.leaseStatus: unexpected Redis slot row value');
      }
      return {
        address,
        leased: leased === '1',
      };
    });

    return {
      leasedSlots,
      freeSlots: this.size - leasedSlots,
      slots,
    };
  }

  async checkout(receiptId: string): Promise<SponsorLease | null> {
    const startCursor = this._cursor;
    const rotatedAddresses: string[] = [];
    const leaseKeys: string[] = [];
    const reservedProofs: string[] = [];

    for (let i = 0; i < this._addresses.length; i++) {
      const sponsorAddress = this._addresses[(startCursor + i) % this._addresses.length]!;
      rotatedAddresses.push(sponsorAddress);
      leaseKeys.push(this.leaseKey(sponsorAddress));
      reservedProofs.push(
        computeLeaseProof(this._hmacSecret, receiptId, sponsorAddress, COMMIT_DIGEST_RESERVED),
      );
    }

    const result = await this._client.eval(LEASE_CHECKOUT_SCRIPT, leaseKeys, [
      String(this._leaseTtlMs),
      ...rotatedAddresses,
      ...reservedProofs,
    ]);

    if (result === null || result === false) {
      logSponsorPoolEvent(SPONSOR_POOL_LEASE_EXHAUSTED, {
        adapter: 'redis',
        pool_size: this.size,
      });
      return null;
    }

    if (!Array.isArray(result) || typeof result[0] !== 'string' || typeof result[1] !== 'string') {
      throw new Error('RedisSponsorPool.checkout: unexpected Redis response shape');
    }

    const sponsorAddress = result[0];
    const oneBasedOffset = Number(result[1]);
    if (
      !Number.isSafeInteger(oneBasedOffset) ||
      oneBasedOffset < 1 ||
      oneBasedOffset > rotatedAddresses.length ||
      rotatedAddresses[oneBasedOffset - 1] !== sponsorAddress
    ) {
      throw new Error('RedisSponsorPool.checkout: unexpected Redis slot offset');
    }

    this._cursor = (startCursor + oneBasedOffset) % this._addresses.length;
    logSponsorPoolEvent(SPONSOR_POOL_LEASE_CHECKOUT, {
      adapter: 'redis',
      sponsor_address: sponsorAddress,
      pool_size: this.size,
    });
    return {
      sponsorAddress,
    };
  }

  async commit(sponsorAddress: string, receiptId: string, txBytesHash: string): Promise<void> {
    const reservedProof = computeLeaseProof(
      this._hmacSecret,
      receiptId,
      sponsorAddress,
      COMMIT_DIGEST_RESERVED,
    );
    const committedProof = computeLeaseProof(
      this._hmacSecret,
      receiptId,
      sponsorAddress,
      txBytesHash,
    );
    const result = (await this._client.eval(
      LEASE_COMMIT_CAS_SCRIPT,
      [this.leaseKey(sponsorAddress)],
      [reservedProof, committedProof, String(this._leaseTtlMs)],
    )) as string | null;
    if (result === 'OK') {
      logSponsorPoolEvent(SPONSOR_POOL_LEASE_COMMITTED, {
        adapter: 'redis',
        sponsor_address: sponsorAddress,
      });
      return;
    }
    if (result === 'LEASE_MISSING') {
      throw new SponsorLeaseCommitError(
        'LEASE_MISSING',
        `RedisSponsorPool.commit: no active lease for sponsor ${sponsorAddress}`,
      );
    }
    // LEASE_COMMIT_CAS_FAILED — the Redis value exists but is not the
    // reserved proof for this (receiptId, sponsorAddress). Typically means the
    // lease already committed under a different commit digest, or
    // belongs to a different receiptId, or the reservation expired and
    // the slot was recycled.
    throw new SponsorLeaseCommitError(
      'LEASE_COMMIT_CAS_FAILED',
      `RedisSponsorPool.commit: lease for sponsor ${sponsorAddress} is not in reserved state for the given receiptId`,
    );
  }

  async checkin(
    sponsorAddress: string,
    receiptId: string,
    txBytesHash: string | null,
  ): Promise<void> {
    const commitDigest = txBytesHash ?? COMMIT_DIGEST_RESERVED;
    const expected = computeLeaseProof(this._hmacSecret, receiptId, sponsorAddress, commitDigest);
    // Lua CAS keeps DEL atomic with the GET compare — a racing commit or
    // checkout can never be lost to a stale checkin.
    const result = (await this._client.eval(
      LEASE_CHECKIN_CAS_SCRIPT,
      [this.leaseKey(sponsorAddress)],
      [expected],
    )) as string | null;
    if (result === 'OK') {
      logSponsorPoolEvent(SPONSOR_POOL_LEASE_CHECKIN, {
        adapter: 'redis',
        sponsor_address: sponsorAddress,
        stage: txBytesHash === null ? 'reserved' : 'committed',
        pool_size: this.size,
      });
    }
    // MISMATCH is a silent no-op: the lease TTL covers residual state,
    // and the same slot cannot be reclaimed by a forged receipt/hash.
  }

  async sign(
    sponsorAddress: string,
    receiptId: string,
    txBytes: Uint8Array,
  ): Promise<{ signature: string }> {
    // Committed HMAC lease proof verification — the only barrier between
    // a Redis-only attacker and the in-memory signing keypair. Reserved
    // leases fail this check because the sentinel cannot equal any hex
    // SHA-256 digest. An attacker who overwrites `entry[receiptId]` with
    // a forged txBytesHash still cannot satisfy this gate because the
    // Redis lease value was committed by the legitimate prepare flow to
    // the original hash.
    const current = await this._client.get(this.leaseKey(sponsorAddress));
    const expected = computeLeaseProof(
      this._hmacSecret,
      receiptId,
      sponsorAddress,
      sha256Hex(txBytes),
    );
    if (!leaseProofMatches(current, expected)) {
      throw new SponsorLeaseExpiredError(sponsorAddress);
    }
    const keypair = this._keypairs.get(sponsorAddress);
    if (!keypair) {
      throw new Error(`RedisSponsorPool: unknown sponsor address ${sponsorAddress}`);
    }
    logSponsorPoolEvent(SPONSOR_POOL_SIGN, {
      adapter: 'redis',
      sponsor_address: sponsorAddress,
      tx_bytes_len: txBytes.length,
    });
    return keypair.signTransaction(txBytes);
  }

  private leaseKey(sponsorAddress: string): string {
    return `${this._keyPrefix}${sponsorAddress}`;
  }
}
