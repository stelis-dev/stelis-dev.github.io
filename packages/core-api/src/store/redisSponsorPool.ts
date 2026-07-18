import { createHash } from 'node:crypto';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SponsorSlotLeaseSummary } from '@stelis/contracts';
import type { SponsorLease, SponsorPoolOptions, SponsorPoolRecordAdapter } from '../context.js';
import { logStructuredEvent } from '../structuredEventLog.js';
import {
  SPONSOR_POOL_LEASE_CHECKIN,
  SPONSOR_POOL_LEASE_CHECKOUT,
  SPONSOR_POOL_LEASE_EXHAUSTED,
  SPONSOR_POOL_SIGN,
} from '../observability/events.js';
import { PREPARE_TTL_MS } from '../preparePolicy.js';
import type { RedisClientLike } from './redisClient.js';
import { SponsorLeaseExpiredError } from './sponsorPoolErrors.js';
import {
  assertSponsorLeaseRecordProof,
  createReservedSponsorLeaseRecord,
  planCommittedSponsorLeaseRecordTransition,
  planExecutingSponsorLeaseRecordTransition,
  planSponsorLeaseRecordRemoval,
  parseSponsorLeaseRecord,
  serializeSponsorLeaseRecord,
  SPONSOR_LEASE_HMAC_SECRET_MIN_LENGTH,
  type SponsorLeaseRecordRemoval,
  type SponsorLeaseRemovalExpectation,
  type SponsorLeaseRecordDeadlineTransition,
  type SponsorLeaseRecordSnapshot,
  type SponsorLeaseRecordTransition,
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
 *     SET(key, reservedRecord, NX, PX leaseTtlMs)
 *     return {slotAddress, oneBasedOffset} on the first successful reservation
 *   return false when every slot is leased
 *
 * The lease record and HMAC proof are computed in process and passed in ARGV; Redis never
 * receives `SPONSOR_LEASE_HMAC_SECRET`.
 */
const LEASE_CHECKOUT_SCRIPT = `
-- RedisSponsorPool LEASE_CHECKOUT_SCRIPT
local ttlMs = ARGV[1]
local slotCount = #KEYS
for i = 1, slotCount do
  local slotAddress = ARGV[1 + i]
  local reservedRecord = ARGV[1 + slotCount + i]
  local result = redis.call('SET', KEYS[i], reservedRecord, 'NX', 'PX', ttlMs)
  if result then
    return { slotAddress, tostring(i) }
  end
end
return false
`;

const REDIS_TIME_MS_SCRIPT = `
-- RedisSponsorPool REDIS_TIME_MS_SCRIPT
local t = redis.call('TIME')
return tostring(t[1] * 1000 + math.floor(t[2] / 1000))
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

/** Canonical lowercase SHA-256 hash of the validated transaction bytes. */
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
 *     → Redis[lease:sponsorAddress] = the strict reserved lease record
 *       via Lua-wrapped `SET NX PX` over the rotated slot list. The
 *       first free slot is reserved and existing leases are refused.
 *
 *   prepared receipt commit
 *     → the sponsored execution store performs one Lua mutation that
 *       expects the reserved record and swaps it to a committed record whose
 *       HMAC binds receipt, sponsor, and txBytesHash. Any mismatch
 *       (missing, wrong receiptId, already committed) raises
 *       `SponsorLeaseCommitError` — silent no-op is not allowed.
 *
 *   execution start and sign(sponsorAddress, receiptId, txBytes)
 *     → the sponsored execution store first advances the committed record to
 *       `executing` and binds the expected transaction digest
 *     → verifies the executing HMAC over receipt, sponsor, transaction-byte
 *       hash, and transaction digest. Reserved and committed leases fail. A
 *       Redis-write attacker who overwrites the prepare entry under
 *       `receiptId` to a forged `txBytesHash` still cannot satisfy
 *       sign() — the Redis lease value was committed by the legitimate
 *       atomic prepare flow to a different hash.
 *
 *   checkin(sponsorAddress, receiptId)
 *     → Lua CAS: expect the exact reserved record, then DEL.
 *       Committed and executing records are removed only by the atomic
 *       sponsored-execution store; the Redis PX TTL covers residual reserved state.
 *
 * The sponsor lease key stores the strict current lease record. Neither that
 * record nor the receipt namespace stores `SPONSOR_LEASE_HMAC_SECRET`; that
 * secret remains in process env and is what prevents proof forgery.
 */
export class RedisSponsorPool implements SponsorPoolRecordAdapter {
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
      this._addresses.map((address) => this.sponsorLeaseRecordKey(address)),
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
    const reservedRecords: string[] = [];
    const deadlineMs = leaseDeadline(await this.redisNowMs(), this._leaseTtlMs);

    for (let i = 0; i < this._addresses.length; i++) {
      const sponsorAddress = this._addresses[(startCursor + i) % this._addresses.length]!;
      rotatedAddresses.push(sponsorAddress);
      leaseKeys.push(this.sponsorLeaseRecordKey(sponsorAddress));
      reservedRecords.push(
        serializeSponsorLeaseRecord(
          createReservedSponsorLeaseRecord({
            secret: this._hmacSecret,
            receiptId,
            sponsorAddress,
            deadlineMs,
          }),
        ),
      );
    }

    const result = await this._client.eval(LEASE_CHECKOUT_SCRIPT, leaseKeys, [
      String(this._leaseTtlMs),
      ...rotatedAddresses,
      ...reservedRecords,
    ]);

    if (result === null || result === false) {
      logStructuredEvent(SPONSOR_POOL_LEASE_EXHAUSTED, {
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
    logStructuredEvent(SPONSOR_POOL_LEASE_CHECKOUT, {
      adapter: 'redis',
      sponsor_address: sponsorAddress,
      pool_size: this.size,
    });
    return {
      sponsorAddress,
    };
  }

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
    // Lua CAS keeps DEL atomic with the GET compare — a racing commit or
    // checkout can never be lost to a stale checkin.
    const result = (await this._client.eval(
      LEASE_CHECKIN_CAS_SCRIPT,
      [removal.key],
      [removal.expectedRaw],
    )) as string | null;
    if (result === 'OK') {
      logStructuredEvent(SPONSOR_POOL_LEASE_CHECKIN, {
        adapter: 'redis',
        sponsor_address: sponsorAddress,
        stage: snapshot.record.stage,
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
    // or committed lease fails this executing-stage check. An attacker who
    // overwrites `entry[receiptId]` with
    // a forged txBytesHash still cannot satisfy this gate because the
    // Redis lease value was committed by the legitimate prepare flow to
    // the original hash.
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
      throw new Error(`RedisSponsorPool: unknown sponsor address ${sponsorAddress}`);
    }
    logStructuredEvent(SPONSOR_POOL_SIGN, {
      adapter: 'redis',
      sponsor_address: sponsorAddress,
      tx_bytes_len: txBytes.length,
    });
    return keypair.signTransaction(txBytes);
  }

  sponsorLeaseRecordKey(sponsorAddress: string): string {
    return `${this._keyPrefix}${sponsorAddress}`;
  }

  async readSponsorLeaseRecord(sponsorAddress: string): Promise<SponsorLeaseRecordSnapshot | null> {
    const raw = await this._client.get(this.sponsorLeaseRecordKey(sponsorAddress));
    if (raw === null) return null;
    const record = parseSponsorLeaseRecord(raw);
    assertSponsorLeaseRecordProof(record, this._hmacSecret);
    if (record.sponsorAddress !== sponsorAddress) {
      throw new Error('RedisSponsorPool: lease record sponsor does not match its key');
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

  private async redisNowMs(): Promise<number> {
    const raw = await this._client.eval(REDIS_TIME_MS_SCRIPT, [], []);
    if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) {
      throw new Error('RedisSponsorPool: Redis TIME returned an invalid millisecond value');
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('RedisSponsorPool: Redis TIME exceeds the safe integer range');
    }
    return value;
  }
}

function leaseDeadline(nowMs: number, ttlMs: number): number {
  const deadlineMs = nowMs + ttlMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= nowMs) {
    throw new Error('RedisSponsorPool: lease deadline exceeds the safe integer range');
  }
  return deadlineMs;
}
