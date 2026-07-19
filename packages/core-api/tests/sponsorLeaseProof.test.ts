import { describe, expect, it } from 'vitest';
import {
  assertSponsorLeaseRecordProof,
  createCommittedSponsorLeaseRecord,
  createExecutingSponsorLeaseRecord,
  createReservedSponsorLeaseRecord,
  materializeExecutingSponsorLeaseRecordTransition,
  planCommittedSponsorLeaseRecordTransition,
  planExecutingSponsorLeaseRecordTransition,
  planSponsorLeaseRecordRemoval,
  parseSponsorLeaseRecord,
  serializeSponsorLeaseRecord,
  SponsorLeaseRecordCorruptionError,
} from '../src/store/sponsorLeaseProof.js';

const SECRET = 'sponsor-lease-record-test-secret-with-safe-length';
const RECEIPT_ID = `0x${'11'.repeat(32)}`;
const SPONSOR_ADDRESS = `0x${'22'.repeat(32)}`;
const TX_BYTES_HASH = '33'.repeat(32);
const TRANSACTION_DIGEST = '11111111111111111111111111111111';

describe('SponsorLeaseRecord current format', () => {
  it('round-trips each closed lifecycle stage without changing exact bytes', () => {
    const reserved = createReservedSponsorLeaseRecord({
      secret: SECRET,
      receiptId: RECEIPT_ID,
      sponsorAddress: SPONSOR_ADDRESS,
      deadlineMs: 2_000_000_000_000,
    });
    const committed = createCommittedSponsorLeaseRecord({
      secret: SECRET,
      reserved,
      txBytesHash: TX_BYTES_HASH,
      deadlineMs: 2_000_000_001_000,
    });
    const executing = createExecutingSponsorLeaseRecord({
      secret: SECRET,
      committed,
      transactionDigest: TRANSACTION_DIGEST,
      deadlineMs: 2_000_000_002_000,
    });

    for (const record of [reserved, committed, executing]) {
      const raw = serializeSponsorLeaseRecord(record);
      expect(serializeSponsorLeaseRecord(parseSponsorLeaseRecord(raw))).toBe(raw);
    }
  });

  it('rejects unknown fields, noncanonical JSON, invalid numbers, and old proof-only values', () => {
    const reserved = createReservedSponsorLeaseRecord({
      secret: SECRET,
      receiptId: RECEIPT_ID,
      sponsorAddress: SPONSOR_ADDRESS,
      deadlineMs: 2_000_000_000_000,
    });
    const raw = serializeSponsorLeaseRecord(reserved);

    expect(() => parseSponsorLeaseRecord(raw.replace('}', ',"version":1}'))).toThrow(
      SponsorLeaseRecordCorruptionError,
    );
    expect(() => parseSponsorLeaseRecord(` ${raw}`)).toThrow(SponsorLeaseRecordCorruptionError);
    expect(() => parseSponsorLeaseRecord(raw.replace('2000000000000', '1.5'))).toThrow(
      SponsorLeaseRecordCorruptionError,
    );
    expect(() => parseSponsorLeaseRecord(reserved.proof)).toThrow(
      SponsorLeaseRecordCorruptionError,
    );
  });

  it('uses one stage- and transaction-bound transition contract for every adapter', () => {
    const reserved = createReservedSponsorLeaseRecord({
      secret: SECRET,
      receiptId: RECEIPT_ID,
      sponsorAddress: SPONSOR_ADDRESS,
      deadlineMs: 2_000_000_000_000,
    });
    const reservedRaw = serializeSponsorLeaseRecord(reserved);
    const committedPlan = planCommittedSponsorLeaseRecordTransition({
      key: `lease:${SPONSOR_ADDRESS}`,
      secret: SECRET,
      snapshot: { raw: reservedRaw, record: reserved },
      receiptId: RECEIPT_ID,
      txBytesHash: TX_BYTES_HASH,
      deadlineMs: 2_000_000_001_000,
    });
    const committed = committedPlan.nextRecord;
    expect(committed).toMatchObject({ stage: 'committed', txBytesHash: TX_BYTES_HASH });

    const executingPlan = planExecutingSponsorLeaseRecordTransition({
      key: committedPlan.key,
      secret: SECRET,
      snapshot: { raw: committedPlan.nextRaw, record: committed },
      receiptId: RECEIPT_ID,
      txBytesHash: TX_BYTES_HASH,
      transactionDigest: TRANSACTION_DIGEST,
    });
    const executingTransition = materializeExecutingSponsorLeaseRecordTransition(
      executingPlan,
      2_000_000_002_000,
    );
    const executing = executingTransition.nextRecord;
    if (executing.stage !== 'executing') throw new Error('expected executing lease record');
    expect(() =>
      assertSponsorLeaseRecordProof(
        {
          ...executing,
          stage: 'executing',
          transactionDigest: '22222222222222222222222222222222',
        },
        SECRET,
      ),
    ).toThrow(/proof does not match/);

    expect(() =>
      planSponsorLeaseRecordRemoval({
        key: committedPlan.key,
        secret: SECRET,
        snapshot: { raw: committedPlan.nextRaw, record: committed },
        expectation: {
          stage: 'committed',
          receiptId: RECEIPT_ID,
          txBytesHash: '44'.repeat(32),
        },
      }),
    ).toThrow(/transaction identity/);
    expect(() =>
      planSponsorLeaseRecordRemoval({
        key: committedPlan.key,
        secret: SECRET,
        snapshot: { raw: executingTransition.nextRaw, record: executing },
        expectation: {
          stage: 'executing',
          receiptId: RECEIPT_ID,
          txBytesHash: TX_BYTES_HASH,
          transactionDigest: '22222222222222222222222222222222',
        },
      }),
    ).toThrow(/transaction identity/);
    expect(
      planSponsorLeaseRecordRemoval({
        key: committedPlan.key,
        secret: SECRET,
        snapshot: { raw: executingTransition.nextRaw, record: executing },
        expectation: {
          stage: 'executing',
          receiptId: RECEIPT_ID,
          txBytesHash: TX_BYTES_HASH,
          transactionDigest: TRANSACTION_DIGEST,
        },
      }),
    ).toEqual({ key: committedPlan.key, expectedRaw: executingTransition.nextRaw });
  });
});
