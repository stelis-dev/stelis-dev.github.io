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
 * authority is the sponsor-pool signing gate. A receipt/sponsor-only
 * HMAC is insufficient, because a live lease proof can be replayed
 * against a forged prepare entry under the same `receiptId`.
 *
 * The current proof binds sponsor admission to the prepare commit itself.
 * The commit digest is the SHA-256 of the validated transaction bytes that the
 * prepare runner stores as `PreparedTxEntry.txBytesHash`, so a Redis-only attacker cannot
 * forge a proof that matches an attacker-chosen `txBytes` unless they also
 * know the process-env secret.
 *
 * Signed string shapes are stage-separated:
 *   `reserved|${receiptId}|${sponsorAddress}`
 *   `committed|${receiptId}|${sponsorAddress}|${txBytesHash}`
 *   `executing|${receiptId}|${sponsorAddress}|${txBytesHash}|${transactionDigest}`
 *
 * The literal `|` separator prevents boundary ambiguity between fields.
 * `receiptId` is `0x` + 64 hex chars, `sponsorAddress` is a Sui address
 * (`0x` + 64 hex chars), and `txBytesHash` is 64 hex chars; none of them
 * contain the separator.
 *
 * Stage separation makes a proof unusable in any other lifecycle stage.
 * The executing proof additionally prevents a Redis-only writer from changing
 * the stored transaction digest while retaining a valid committed proof.
 *
 * Sponsor pinning: including `sponsorAddress` in the payload prevents a receipt +
 * hash combination from being reused against a different sponsor. Commit
 * pinning: including the prepare commit digest prevents a live lease from
 * authorising any PTB other than the one the prepare flow committed to.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  isValidSuiAddress,
  isValidTransactionDigest,
  normalizeSuiAddress,
} from '@mysten/sui/utils';

/**
 * Minimum acceptable length for `SPONSOR_LEASE_HMAC_SECRET`. Matches the
 * admin JWT secret floor used elsewhere in the host boot validation.
 * Callers (boot / context factories) must enforce this.
 */
export const SPONSOR_LEASE_HMAC_SECRET_MIN_LENGTH = 32;

const RECEIPT_ID_PATTERN = /^0x[0-9a-f]{64}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

interface SponsorLeaseRecordCommon {
  readonly receiptId: string;
  readonly sponsorAddress: string;
  readonly proof: string;
  readonly deadlineMs: number;
}

export interface ReservedSponsorLeaseRecord extends SponsorLeaseRecordCommon {
  readonly stage: 'reserved';
}

export interface CommittedSponsorLeaseRecord extends SponsorLeaseRecordCommon {
  readonly stage: 'committed';
  readonly txBytesHash: string;
}

export interface ExecutingSponsorLeaseRecord extends SponsorLeaseRecordCommon {
  readonly stage: 'executing';
  readonly txBytesHash: string;
  readonly transactionDigest: string;
}

/** Exact sponsor lease record accepted by the current store. */
export type SponsorLeaseRecord =
  | ReservedSponsorLeaseRecord
  | CommittedSponsorLeaseRecord
  | ExecutingSponsorLeaseRecord;

/** Exact stored value paired with its decoded current record. */
export interface SponsorLeaseRecordSnapshot {
  readonly raw: string;
  readonly record: SponsorLeaseRecord;
}

export interface SponsorLeaseRecordTransition {
  readonly key: string;
  readonly expectedRaw: string;
  readonly nextRaw: string;
  readonly nextRecord: SponsorLeaseRecord;
}

/**
 * Committed-to-executing lease transition whose deadline is authored by the
 * same Redis mutation that starts execution. The lease module still owns the
 * complete canonical JSON surrounding that one decimal value.
 */
export interface SponsorLeaseRecordDeadlineTransition {
  readonly key: string;
  readonly expectedRaw: string;
  readonly nextRawPrefix: string;
  readonly nextRawSuffix: string;
}

export interface SponsorLeaseRecordRemoval {
  readonly key: string;
  readonly expectedRaw: string;
}

/** Exact identity required to remove one lease lifecycle stage. */
export type SponsorLeaseRemovalExpectation =
  | {
      readonly stage: 'reserved';
      readonly receiptId: string;
    }
  | {
      readonly stage: 'committed';
      readonly receiptId: string;
      readonly txBytesHash: string;
    }
  | {
      readonly stage: 'executing';
      readonly receiptId: string;
      readonly txBytesHash: string;
      readonly transactionDigest: string;
    };

/**
 * Narrow record-owner surface used by the receipt coordinator. The coordinator
 * receives exact stored bytes and the owner-produced key; it does not rebuild
 * lease keys or invent a second record format.
 */
export interface SponsorLeaseRecordAccess {
  sponsorLeaseRecordKey(sponsorAddress: string): string;
  readSponsorLeaseRecord(sponsorAddress: string): Promise<SponsorLeaseRecordSnapshot | null>;
  prepareCommittedSponsorLeaseRecord(
    snapshot: SponsorLeaseRecordSnapshot,
    receiptId: string,
    txBytesHash: string,
    deadlineMs: number,
  ): SponsorLeaseRecordTransition;
  prepareExecutingSponsorLeaseRecord(
    snapshot: SponsorLeaseRecordSnapshot,
    receiptId: string,
    txBytesHash: string,
    transactionDigest: string,
  ): SponsorLeaseRecordDeadlineTransition;
  prepareSponsorLeaseRecordRemoval(
    snapshot: SponsorLeaseRecordSnapshot,
    expectation: SponsorLeaseRemovalExpectation,
  ): SponsorLeaseRecordRemoval;
}

/** In-process exact CAS surface used by the memory receipt coordinator. */
export interface MemorySponsorLeaseRecordAccess extends SponsorLeaseRecordAccess {
  matchesSponsorLeaseRecordTransition(transition: SponsorLeaseRecordTransition): boolean;
  applySponsorLeaseRecordTransition(transition: SponsorLeaseRecordTransition): boolean;
  matchesSponsorLeaseRecordDeadlineTransition(
    transition: SponsorLeaseRecordDeadlineTransition,
  ): boolean;
  applySponsorLeaseRecordDeadlineTransition(
    transition: SponsorLeaseRecordDeadlineTransition,
    deadlineMs: number,
  ): boolean;
  matchesSponsorLeaseRecordRemoval(removal: SponsorLeaseRecordRemoval): boolean;
  applySponsorLeaseRecordRemoval(removal: SponsorLeaseRecordRemoval): boolean;
}

export class SponsorLeaseRecordCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SponsorLeaseRecordCorruptionError';
  }
}

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

/** Compute the HMAC-SHA256 proof for one exact lifecycle-stage identity. */
function computeLeaseProof(
  secret: string,
  identity:
    | Pick<ReservedSponsorLeaseRecord, 'stage' | 'receiptId' | 'sponsorAddress'>
    | Pick<CommittedSponsorLeaseRecord, 'stage' | 'receiptId' | 'sponsorAddress' | 'txBytesHash'>
    | Pick<
        ExecutingSponsorLeaseRecord,
        'stage' | 'receiptId' | 'sponsorAddress' | 'txBytesHash' | 'transactionDigest'
      >,
): string {
  const payload =
    identity.stage === 'reserved'
      ? `${identity.stage}|${identity.receiptId}|${identity.sponsorAddress}`
      : identity.stage === 'committed'
        ? `${identity.stage}|${identity.receiptId}|${identity.sponsorAddress}|${identity.txBytesHash}`
        : `${identity.stage}|${identity.receiptId}|${identity.sponsorAddress}|${identity.txBytesHash}|${identity.transactionDigest}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Constant-time comparison of a stored lease proof against the expected
 * proof computed for its complete lifecycle-stage identity.
 *
 * `stored` is the Redis / in-memory value observed by the pool adapter.
 * `expected` is the fresh computation from `computeLeaseProof`.
 *
 * Returns `false` for any length mismatch, non-string inputs, or
 * constant-time digest mismatch. Never throws on malformed input.
 */
function leaseProofMatches(stored: unknown, expected: string): boolean {
  if (typeof stored !== 'string') return false;
  if (stored.length !== expected.length) return false;
  const storedBuf = Buffer.from(stored, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (storedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(storedBuf, expectedBuf);
}

export function createReservedSponsorLeaseRecord(params: {
  readonly secret: string;
  readonly receiptId: string;
  readonly sponsorAddress: string;
  readonly deadlineMs: number;
}): ReservedSponsorLeaseRecord {
  const record: ReservedSponsorLeaseRecord = {
    stage: 'reserved',
    receiptId: params.receiptId,
    sponsorAddress: params.sponsorAddress,
    proof: computeLeaseProof(params.secret, {
      stage: 'reserved',
      receiptId: params.receiptId,
      sponsorAddress: params.sponsorAddress,
    }),
    deadlineMs: params.deadlineMs,
  };
  validateSponsorLeaseRecord(record);
  return record;
}

export function createCommittedSponsorLeaseRecord(params: {
  readonly secret: string;
  readonly reserved: ReservedSponsorLeaseRecord;
  readonly txBytesHash: string;
  readonly deadlineMs: number;
}): CommittedSponsorLeaseRecord {
  assertSponsorLeaseRecordProof(params.reserved, params.secret);
  const record: CommittedSponsorLeaseRecord = {
    stage: 'committed',
    receiptId: params.reserved.receiptId,
    sponsorAddress: params.reserved.sponsorAddress,
    proof: computeLeaseProof(params.secret, {
      stage: 'committed',
      receiptId: params.reserved.receiptId,
      sponsorAddress: params.reserved.sponsorAddress,
      txBytesHash: params.txBytesHash,
    }),
    deadlineMs: params.deadlineMs,
    txBytesHash: params.txBytesHash,
  };
  validateSponsorLeaseRecord(record);
  return record;
}

export function createExecutingSponsorLeaseRecord(params: {
  readonly secret: string;
  readonly committed: CommittedSponsorLeaseRecord;
  readonly transactionDigest: string;
  readonly deadlineMs: number;
}): ExecutingSponsorLeaseRecord {
  assertSponsorLeaseRecordProof(params.committed, params.secret);
  const record: ExecutingSponsorLeaseRecord = {
    stage: 'executing',
    receiptId: params.committed.receiptId,
    sponsorAddress: params.committed.sponsorAddress,
    proof: computeLeaseProof(params.secret, {
      stage: 'executing',
      receiptId: params.committed.receiptId,
      sponsorAddress: params.committed.sponsorAddress,
      txBytesHash: params.committed.txBytesHash,
      transactionDigest: params.transactionDigest,
    }),
    deadlineMs: params.deadlineMs,
    txBytesHash: params.committed.txBytesHash,
    transactionDigest: params.transactionDigest,
  };
  validateSponsorLeaseRecord(record);
  return record;
}

/**
 * Build the one allowed reserved-to-committed transition from exact stored bytes.
 * Pool adapters provide only their key and secret; stage and identity meaning live here.
 */
export function planCommittedSponsorLeaseRecordTransition(params: {
  readonly key: string;
  readonly secret: string;
  readonly snapshot: SponsorLeaseRecordSnapshot;
  readonly receiptId: string;
  readonly txBytesHash: string;
  readonly deadlineMs: number;
}): SponsorLeaseRecordTransition {
  const current = currentSponsorLeaseSnapshot(params.snapshot);
  assertSponsorLeaseRecordProof(current, params.secret);
  if (current.stage !== 'reserved' || current.receiptId !== params.receiptId) {
    throw new SponsorLeaseCommitError(
      'LEASE_COMMIT_CAS_FAILED',
      'Expected the reserved lease for the supplied receipt',
    );
  }
  const nextRecord = createCommittedSponsorLeaseRecord({
    secret: params.secret,
    reserved: current,
    txBytesHash: params.txBytesHash,
    deadlineMs: params.deadlineMs,
  });
  return transition(params.key, params.snapshot.raw, nextRecord);
}

/** Build the one allowed committed-to-executing transition from exact stored bytes. */
export function planExecutingSponsorLeaseRecordTransition(params: {
  readonly key: string;
  readonly secret: string;
  readonly snapshot: SponsorLeaseRecordSnapshot;
  readonly receiptId: string;
  readonly txBytesHash: string;
  readonly transactionDigest: string;
}): SponsorLeaseRecordDeadlineTransition {
  const current = currentSponsorLeaseSnapshot(params.snapshot);
  assertSponsorLeaseRecordProof(current, params.secret);
  if (
    current.stage !== 'committed' ||
    current.receiptId !== params.receiptId ||
    current.txBytesHash !== params.txBytesHash
  ) {
    throw new SponsorLeaseCommitError(
      'LEASE_EXECUTION_CAS_FAILED',
      'Expected the committed lease for the supplied receipt and transaction bytes',
    );
  }
  const nextRecord = createExecutingSponsorLeaseRecord({
    secret: params.secret,
    committed: current,
    transactionDigest: params.transactionDigest,
    deadlineMs: 1,
  });
  const serialized = serializeSponsorLeaseRecord(nextRecord);
  const marker = '"deadlineMs":1';
  const markerStart = serialized.indexOf(marker);
  if (markerStart < 0 || serialized.indexOf(marker, markerStart + marker.length) >= 0) {
    throw new SponsorLeaseRecordCorruptionError(
      'Executing sponsor lease must contain exactly one deadlineMs field',
    );
  }
  const valueStart = markerStart + '"deadlineMs":'.length;
  return Object.freeze({
    key: params.key,
    expectedRaw: params.snapshot.raw,
    nextRawPrefix: serialized.slice(0, valueStart),
    nextRawSuffix: serialized.slice(markerStart + marker.length),
  });
}

export function materializeExecutingSponsorLeaseRecordTransition(
  transitionValue: SponsorLeaseRecordDeadlineTransition,
  deadlineMs: number,
): SponsorLeaseRecordTransition {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new SponsorLeaseRecordCorruptionError(
      'Executing sponsor lease deadlineMs must be a positive safe integer',
    );
  }
  const nextRaw = `${transitionValue.nextRawPrefix}${deadlineMs}${transitionValue.nextRawSuffix}`;
  const nextRecord = parseSponsorLeaseRecord(nextRaw);
  if (nextRecord.stage !== 'executing') {
    throw new SponsorLeaseRecordCorruptionError(
      'Executing sponsor lease deadline parts produced the wrong stage',
    );
  }
  return Object.freeze({
    key: transitionValue.key,
    expectedRaw: transitionValue.expectedRaw,
    nextRaw,
    nextRecord,
  });
}

/**
 * Build an exact lease removal. Prepared discard requires the committed hash;
 * execution finalization additionally requires the bound Sui transaction digest.
 */
export function planSponsorLeaseRecordRemoval(params: {
  readonly key: string;
  readonly secret: string;
  readonly snapshot: SponsorLeaseRecordSnapshot;
  readonly expectation: SponsorLeaseRemovalExpectation;
}): SponsorLeaseRecordRemoval {
  const current = currentSponsorLeaseSnapshot(params.snapshot);
  assertSponsorLeaseRecordProof(current, params.secret);
  const expected = params.expectation;
  const matches =
    current.stage === expected.stage &&
    current.receiptId === expected.receiptId &&
    (expected.stage === 'reserved' ||
      (current.stage !== 'reserved' && current.txBytesHash === expected.txBytesHash)) &&
    (expected.stage !== 'executing' ||
      (current.stage === 'executing' && current.transactionDigest === expected.transactionDigest));
  if (!matches) {
    throw new SponsorLeaseCommitError(
      'LEASE_RELEASE_CAS_FAILED',
      'Sponsor lease stage or transaction identity does not match the requested release',
    );
  }
  return {
    key: params.key,
    expectedRaw: params.snapshot.raw,
  };
}

function transition(
  key: string,
  expectedRaw: string,
  nextRecord: SponsorLeaseRecord,
): SponsorLeaseRecordTransition {
  if (typeof key !== 'string' || key.length === 0) {
    throw new SponsorLeaseRecordCorruptionError('Sponsor lease storage key is invalid');
  }
  return {
    key,
    expectedRaw,
    nextRaw: serializeSponsorLeaseRecord(nextRecord),
    nextRecord,
  };
}

function currentSponsorLeaseSnapshot(snapshot: SponsorLeaseRecordSnapshot): SponsorLeaseRecord {
  const current = parseSponsorLeaseRecord(snapshot.raw);
  if (serializeSponsorLeaseRecord(snapshot.record) !== snapshot.raw) {
    throw new SponsorLeaseRecordCorruptionError(
      'Sponsor lease snapshot record does not match its exact stored bytes',
    );
  }
  return current;
}

export function assertSponsorLeaseRecordProof(record: SponsorLeaseRecord, secret: string): void {
  const expected = computeLeaseProof(secret, record);
  if (!leaseProofMatches(record.proof, expected)) {
    throw new SponsorLeaseRecordCorruptionError('Sponsor lease proof does not match its record');
  }
}

export function serializeSponsorLeaseRecord(record: SponsorLeaseRecord): string {
  validateSponsorLeaseRecord(record);
  switch (record.stage) {
    case 'reserved':
      return JSON.stringify({
        stage: record.stage,
        receiptId: record.receiptId,
        sponsorAddress: record.sponsorAddress,
        proof: record.proof,
        deadlineMs: record.deadlineMs,
      });
    case 'committed':
      return JSON.stringify({
        stage: record.stage,
        receiptId: record.receiptId,
        sponsorAddress: record.sponsorAddress,
        proof: record.proof,
        deadlineMs: record.deadlineMs,
        txBytesHash: record.txBytesHash,
      });
    case 'executing':
      return JSON.stringify({
        stage: record.stage,
        receiptId: record.receiptId,
        sponsorAddress: record.sponsorAddress,
        proof: record.proof,
        deadlineMs: record.deadlineMs,
        txBytesHash: record.txBytesHash,
        transactionDigest: record.transactionDigest,
      });
  }
}

export function parseSponsorLeaseRecord(raw: string): SponsorLeaseRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SponsorLeaseRecordCorruptionError('Sponsor lease record is not valid JSON');
  }
  if (!isPlainRecord(value)) {
    throw new SponsorLeaseRecordCorruptionError('Sponsor lease record must be an object');
  }

  let record: SponsorLeaseRecord;
  if (value['stage'] === 'reserved') {
    assertExactKeys(value, ['stage', 'receiptId', 'sponsorAddress', 'proof', 'deadlineMs']);
    record = {
      stage: 'reserved',
      receiptId: value['receiptId'] as string,
      sponsorAddress: value['sponsorAddress'] as string,
      proof: value['proof'] as string,
      deadlineMs: value['deadlineMs'] as number,
    };
  } else if (value['stage'] === 'committed') {
    assertExactKeys(value, [
      'stage',
      'receiptId',
      'sponsorAddress',
      'proof',
      'deadlineMs',
      'txBytesHash',
    ]);
    record = {
      stage: 'committed',
      receiptId: value['receiptId'] as string,
      sponsorAddress: value['sponsorAddress'] as string,
      proof: value['proof'] as string,
      deadlineMs: value['deadlineMs'] as number,
      txBytesHash: value['txBytesHash'] as string,
    };
  } else if (value['stage'] === 'executing') {
    assertExactKeys(value, [
      'stage',
      'receiptId',
      'sponsorAddress',
      'proof',
      'deadlineMs',
      'txBytesHash',
      'transactionDigest',
    ]);
    record = {
      stage: 'executing',
      receiptId: value['receiptId'] as string,
      sponsorAddress: value['sponsorAddress'] as string,
      proof: value['proof'] as string,
      deadlineMs: value['deadlineMs'] as number,
      txBytesHash: value['txBytesHash'] as string,
      transactionDigest: value['transactionDigest'] as string,
    };
  } else {
    throw new SponsorLeaseRecordCorruptionError('Sponsor lease stage is invalid');
  }

  validateSponsorLeaseRecord(record);
  if (serializeSponsorLeaseRecord(record) !== raw) {
    throw new SponsorLeaseRecordCorruptionError('Sponsor lease record is not canonical JSON');
  }
  return record;
}

function validateSponsorLeaseRecord(record: SponsorLeaseRecord): void {
  if (typeof record.receiptId !== 'string' || !RECEIPT_ID_PATTERN.test(record.receiptId)) {
    throw new SponsorLeaseRecordCorruptionError('Sponsor lease receiptId is not canonical');
  }
  if (
    typeof record.sponsorAddress !== 'string' ||
    !isValidSuiAddress(record.sponsorAddress) ||
    normalizeSuiAddress(record.sponsorAddress) !== record.sponsorAddress
  ) {
    throw new SponsorLeaseRecordCorruptionError('Sponsor lease sponsorAddress is not canonical');
  }
  if (typeof record.proof !== 'string' || !SHA256_HEX_PATTERN.test(record.proof)) {
    throw new SponsorLeaseRecordCorruptionError('Sponsor lease proof is not canonical');
  }
  if (!Number.isSafeInteger(record.deadlineMs) || record.deadlineMs <= 0) {
    throw new SponsorLeaseRecordCorruptionError('Sponsor lease deadlineMs is invalid');
  }
  if (
    record.stage !== 'reserved' &&
    (typeof record.txBytesHash !== 'string' || !SHA256_HEX_PATTERN.test(record.txBytesHash))
  ) {
    throw new SponsorLeaseRecordCorruptionError('Sponsor lease txBytesHash is not canonical');
  }
  if (
    record.stage === 'executing' &&
    (typeof record.transactionDigest !== 'string' ||
      !isValidTransactionDigest(record.transactionDigest))
  ) {
    throw new SponsorLeaseRecordCorruptionError('Sponsor lease transactionDigest is invalid');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new SponsorLeaseRecordCorruptionError('Sponsor lease record fields are invalid');
  }
}
