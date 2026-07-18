import { createHash } from 'node:crypto';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it } from 'vitest';
import { SUI_CHAIN_IDENTIFIERS } from '@stelis/contracts';
import { SponsorPool } from '../src/context.js';
import type { Clock } from '../src/clock.js';
import type { SponsorResultMetadata } from '../src/handlers/sponsorResult.js';
import { MemorySponsoredExecutionStore } from '../src/store/memorySponsoredExecutionStore.js';
import type {
  GenericPreparedTxDraft,
  PreparedTxEntry,
  PromotionPreparedTxDraft,
} from '../src/store/prepareTypes.js';
import {
  decodePreparedTxEntry,
  parseCurrentPreparedTxDraft,
  serializePreparedTxEntry,
} from '../src/store/prepareTypes.js';
import {
  decodeSponsoredExecutionRecord,
  serializeSponsoredExecutionRecord,
  storeSponsorResult,
  type ExecutingSponsoredExecutionRecord,
} from '../src/store/sponsoredExecutionRecords.js';
import { MemoryPromotionExecutionLedger } from '../src/studio/executionLedgerMemory.js';
import { createMemoryPromotionLedgerStore, PROMO_ID } from './helpers/promotionLedgerFixture.js';
import { addressBalanceGasTransactionBytesFixture } from './helpers/suiGatewayResultFixtures.js';

const HMAC_SECRET = 'sponsored-execution-memory-test-secret-aaaaaaaa';
const SENDER = `0x${'11'.repeat(32)}`;
const USER = 'sponsored-execution-user';
const CLIENT_IP = '127.0.0.1';
const U64_MAX = (1n << 64n) - 1n;

class MutableClock implements Clock {
  constructor(public now: number) {}
  nowMs(): number {
    return this.now;
  }
}

function receipt(index: number): string {
  return `0x${index.toString(16).padStart(64, '0')}`;
}

function txHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function transactionBytes(sponsorAddress: string): Promise<Uint8Array> {
  const transaction = new Transaction();
  transaction.setSender(SENDER);
  return addressBalanceGasTransactionBytesFixture({
    transaction,
    sponsorAddress,
    gasBudget: 1_000_000n,
    gasPrice: 1_000n,
    chainIdentifier: SUI_CHAIN_IDENTIFIERS.testnet,
  });
}

function genericResult(input: {
  receiptId: string;
  sponsorAddress: string;
  digest?: string;
  outcome?: SponsorResultMetadata['outcome'];
}): SponsorResultMetadata {
  return {
    sponsorAddress: input.sponsorAddress,
    outcome: input.outcome ?? 'success',
    executionStage: input.digest === undefined ? 'before_sponsor_signature' : 'on_chain',
    route: 'generic',
    ...(input.digest === undefined ? {} : { digest: input.digest }),
    receiptId: input.receiptId,
    senderAddress: SENDER,
    executionPathKey: 'generic:test',
    orderIdHash: null,
    promotionId: null,
    userId: null,
    economics: {
      economicsStatus: 'unknown',
      failureReason: input.outcome === 'success' ? null : 'test failure',
    },
  };
}

async function genericHarness(
  options: {
    now?: number;
    ttlMs?: number;
    maxOutstandingPerSender?: number;
    receiptId?: string;
  } = {},
) {
  const clock = new MutableClock(options.now ?? 10_000);
  const keypair = Ed25519Keypair.generate();
  const sponsorPool = new SponsorPool([keypair], { hmacSecret: HMAC_SECRET });
  const store = new MemorySponsoredExecutionStore(sponsorPool, undefined, {
    prepareTtlMs: options.ttlMs ?? 1_000,
    maxOutstandingPerSender: options.maxOutstandingPerSender ?? 3,
    clock,
  });
  const receiptId = options.receiptId ?? receipt(1);
  const lease = await sponsorPool.checkout(receiptId);
  if (!lease) throw new Error('Expected the test sponsor lease');
  const nonce = await store.reserveNonce(SENDER, 0n, receiptId);
  const bytes = await transactionBytes(lease.sponsorAddress);
  const draft: GenericPreparedTxDraft = {
    mode: 'generic',
    receiptId,
    senderAddress: SENDER,
    nonce,
    txBytesHash: txHash(bytes),
    sponsorAddress: lease.sponsorAddress,
    clientIp: CLIENT_IP,
    executionPathKey: 'generic:test',
    orderId: null,
  };
  return { clock, sponsorPool, store, receiptId, bytes, draft };
}

describe('Current sponsored execution records', () => {
  it('accepts only semantic prepared fields and canonical stored bytes', () => {
    const draft = {
      mode: 'generic' as const,
      receiptId: receipt(90),
      senderAddress: SENDER,
      nonce: 1n,
      txBytesHash: 'aa'.repeat(32),
      sponsorAddress: `0x${'22'.repeat(32)}`,
      clientIp: CLIENT_IP,
      executionPathKey: 'generic:test',
      orderId: 'order-1',
    };
    const entry = { ...draft, issuedAt: 10_000 };
    const raw = serializePreparedTxEntry(entry);
    expect(decodePreparedTxEntry(raw, entry.receiptId)).toEqual(entry);
    expect(() => decodePreparedTxEntry(` ${raw}`, entry.receiptId)).toThrow(/canonical JSON/);
    expect(() => parseCurrentPreparedTxDraft({ ...draft, nonce: 0n })).toThrow(
      /nonce must be a bigint from 1/,
    );
    expect(() =>
      parseCurrentPreparedTxDraft({
        ...draft,
        senderAddress: `0x${'AA'.repeat(32)}`,
      }),
    ).toThrow(/canonical Sui address/);
  });

  it('rejects noncanonical execution bytes and inconsistent stored economics', () => {
    const execution: ExecutingSponsoredExecutionRecord = {
      state: 'executing',
      receiptId: receipt(91),
      sponsorAddress: `0x${'22'.repeat(32)}`,
      txBytesHash: 'bb'.repeat(32),
      transactionDigest: '11111111111111111111111111111111',
      deadlineMs: 20_000,
      recovery: {
        route: 'generic',
        senderAddress: SENDER,
        executionPathKey: 'generic:test',
        orderIdHash: null,
        recoveredGasMist: '100',
        hostFeeMist: '10',
        protocolFeeMist: '0',
      },
    };
    const raw = serializeSponsoredExecutionRecord(execution);
    expect(decodeSponsoredExecutionRecord(raw)).toEqual(execution);
    expect(() => decodeSponsoredExecutionRecord(` ${raw}`)).toThrow(/canonical JSON/);
    expect(() =>
      storeSponsorResult({
        sponsorAddress: execution.sponsorAddress,
        outcome: 'success',
        executionStage: 'on_chain',
        route: 'generic',
        digest: execution.transactionDigest,
        receiptId: execution.receiptId,
        senderAddress: SENDER,
        executionPathKey: 'generic:test',
        orderIdHash: null,
        promotionId: null,
        userId: null,
        economics: {
          economicsStatus: 'known',
          recoveredGasMist: '100',
          hostPaidGasMist: '80',
          hostFeeMist: '10',
          hostNetMist: '31',
          grossGasMist: '90',
          storageRebateMist: '10',
          protocolFeeMist: '0',
          failureReason: null,
        },
      }),
    ).toThrow(/hostNetMist/);

    const u64Max = (1n << 64n) - 1n;
    expect(() =>
      storeSponsorResult({
        sponsorAddress: execution.sponsorAddress,
        outcome: 'success',
        executionStage: 'on_chain',
        route: 'generic',
        digest: execution.transactionDigest,
        receiptId: execution.receiptId,
        senderAddress: SENDER,
        executionPathKey: 'generic:test',
        orderIdHash: null,
        promotionId: null,
        userId: null,
        economics: {
          economicsStatus: 'known',
          recoveredGasMist: u64Max.toString(),
          hostPaidGasMist: '0',
          hostFeeMist: u64Max.toString(),
          hostNetMist: (u64Max * 2n).toString(),
          grossGasMist: null,
          storageRebateMist: null,
          protocolFeeMist: null,
          failureReason: null,
        },
      }),
    ).not.toThrow();
  });
});

describe('MemorySponsoredExecutionStore', () => {
  it('moves one exact receipt from prepared to executing to final and delivers its callback once', async () => {
    const h = await genericHarness();
    const prepared = await h.store.commitPreparedReceipt(h.draft);
    expect(
      (await h.sponsorPool.readSponsorLeaseRecord(h.draft.sponsorAddress))?.record,
    ).toMatchObject({
      stage: 'committed',
      receiptId: h.receiptId,
      txBytesHash: h.draft.txBytesHash,
    });

    h.clock.now = 10_100;
    const begun = await h.store.beginSponsoredExecution({
      receiptId: h.receiptId,
      txBytes: h.bytes,
      expectedMode: 'generic',
      executionBudgetMs: 3_000,
      recovery: {
        route: 'generic',
        senderAddress: SENDER,
        executionPathKey: 'generic:test',
        orderIdHash: null,
        recoveredGasMist: '0',
        hostFeeMist: '0',
        protocolFeeMist: '0',
      },
    });
    expect(begun.status).toBe('executing');
    if (begun.status !== 'executing') return;
    expect(begun.prepared).toEqual(prepared);
    expect(begun.execution).toMatchObject({
      receiptId: h.receiptId,
      txBytesHash: h.draft.txBytesHash,
      deadlineMs: 13_100,
    });
    expect(await h.store.readPreparedReceipt(h.receiptId)).toBeNull();
    expect(
      (await h.sponsorPool.readSponsorLeaseRecord(h.draft.sponsorAddress))?.record,
    ).toMatchObject({
      stage: 'executing',
      transactionDigest: begun.execution.transactionDigest,
      deadlineMs: 13_100,
    });
    await expect(
      h.sponsorPool.sign(h.draft.sponsorAddress, h.receiptId, h.bytes),
    ).resolves.toMatchObject({ signature: expect.any(String) });

    h.clock.now = 10_200;
    const finalized = await h.store.finalizeSponsoredExecution({
      expected: begun.execution,
      result: genericResult({
        receiptId: h.receiptId,
        sponsorAddress: h.draft.sponsorAddress,
        digest: begun.execution.transactionDigest,
      }),
      promotion: { operation: 'none' },
    });
    expect(finalized.status).toBe('finalized');
    if (finalized.status !== 'finalized') return;
    expect(await h.sponsorPool.readSponsorLeaseRecord(h.draft.sponsorAddress)).toBeNull();
    await expect(h.store.readDueExecutions(100, null)).resolves.toEqual({
      records: [],
      nextCursor: null,
    });
    await expect(h.store.readPendingCallbacks(100, null)).resolves.toEqual({
      records: [finalized.record],
      nextCursor: null,
    });
    const pendingCallbacks = (h.store as unknown as { pendingCallbacks: Map<string, number> })
      .pendingCallbacks;
    pendingCallbacks.set(h.receiptId, finalized.record.finalizedAtMs + 1);
    await expect(h.store.markCallbackDelivered(finalized.record)).resolves.toBe(false);
    pendingCallbacks.set(h.receiptId, finalized.record.finalizedAtMs);
    await expect(h.store.markCallbackDelivered(finalized.record)).resolves.toBe(true);
    await expect(h.store.markCallbackDelivered(finalized.record)).resolves.toBe(false);
    await expect(h.store.readPendingCallbacks(100, null)).resolves.toEqual({
      records: [],
      nextCursor: null,
    });
  });

  it('discards prepared state, nonce, and lease together and preserves the final result on retry', async () => {
    const h = await genericHarness();
    const prepared = await h.store.commitPreparedReceipt(h.draft);
    const discarded = await h.store.discardPreparedReceipt({
      expected: prepared,
      result: genericResult({
        receiptId: h.receiptId,
        sponsorAddress: h.draft.sponsorAddress,
        outcome: 'validation_failure',
      }),
    });
    expect(discarded.status).toBe('discarded');
    expect(await h.store.readPreparedReceipt(h.receiptId)).toBeNull();
    expect(await h.sponsorPool.readSponsorLeaseRecord(h.draft.sponsorAddress)).toBeNull();
    await expect(h.store.reserveNonce(SENDER, 0n, receipt(2))).resolves.toBe(1n);
    const retryResult = genericResult({
      receiptId: h.receiptId,
      sponsorAddress: h.draft.sponsorAddress,
      outcome: 'validation_failure',
    });
    const retry = await h.store.discardPreparedReceipt({
      expected: prepared,
      result: retryResult,
    });
    expect(retry.status).toBe('already_final');
    if (discarded.status === 'discarded' && retry.status === 'already_final') {
      expect(retry.record).toEqual(discarded.record);
    }
    await expect(
      h.store.discardPreparedReceipt({
        expected: prepared,
        result: { ...retryResult, outcome: 'internal_error' },
      }),
    ).resolves.toEqual({ status: 'state_changed' });
  });

  it('retains the execution digest when signing fails before a result digest exists', async () => {
    const h = await genericHarness();
    await h.store.commitPreparedReceipt(h.draft);
    const begun = await h.store.beginSponsoredExecution({
      receiptId: h.receiptId,
      txBytes: h.bytes,
      expectedMode: 'generic',
      executionBudgetMs: 3_000,
      recovery: {
        route: 'generic',
        senderAddress: SENDER,
        executionPathKey: 'generic:test',
        orderIdHash: null,
        recoveredGasMist: '0',
        hostFeeMist: '0',
        protocolFeeMist: '0',
      },
    });
    if (begun.status !== 'executing') throw new Error('expected executing receipt');

    const finalized = await h.store.finalizeSponsoredExecution({
      expected: begun.execution,
      result: genericResult({
        receiptId: h.receiptId,
        sponsorAddress: h.draft.sponsorAddress,
        outcome: 'internal_error',
      }),
      promotion: { operation: 'none' },
    });

    expect(finalized.status).toBe('finalized');
    if (finalized.status !== 'finalized') return;
    expect(finalized.record.transactionDigest).toBe(begun.execution.transactionDigest);
    expect(finalized.record.result.digest).toBeNull();
  });

  it('treats the exact TTL boundary as expired without mutating the recoverable prepared state', async () => {
    const h = await genericHarness({ ttlMs: 1_000 });
    const prepared = await h.store.commitPreparedReceipt(h.draft);
    h.clock.now = prepared.issuedAt + 1_000;
    await expect(
      h.store.beginSponsoredExecution({
        receiptId: h.receiptId,
        txBytes: h.bytes,
        expectedMode: 'generic',
        executionBudgetMs: 1_000,
        recovery: {
          route: 'generic',
          senderAddress: SENDER,
          executionPathKey: 'generic:test',
          orderIdHash: null,
          recoveredGasMist: '0',
          hostFeeMist: '0',
          protocolFeeMist: '0',
        },
      }),
    ).resolves.toEqual({ status: 'expired' });
    await expect(h.store.readExpiredPreparedReceipts(100, null)).resolves.toEqual({
      records: [prepared],
      nextCursor: null,
    });
    await expect(h.store.readPreparedReceipt(h.receiptId)).resolves.toEqual(prepared);
  });

  it('uses an exclusive stable receipt cursor when 101 recovery records share one score', async () => {
    const h = await genericHarness({ now: 12_000, ttlMs: 1_000 });
    const entries: PreparedTxEntry[] = Array.from({ length: 101 }, (_, index) => ({
      ...h.draft,
      receiptId: receipt(index + 1_000),
      nonce: BigInt(index + 1),
      issuedAt: 10_000,
    }));
    const internals = h.store as unknown as {
      prepared: Map<string, string>;
      preparedDeadlines: Map<string, number>;
    };
    for (const entry of entries) {
      internals.prepared.set(entry.receiptId, serializePreparedTxEntry(entry));
      internals.preparedDeadlines.set(entry.receiptId, 11_000);
    }

    const first = await h.store.readExpiredPreparedReceipts(100, null);
    expect(first.records.map((entry) => entry.receiptId)).toEqual(
      entries.slice(0, 100).map((entry) => entry.receiptId),
    );
    expect(first.nextCursor).toEqual({
      throughMs: 12_000,
      scoreMs: 11_000,
      receiptId: entries[99]?.receiptId,
    });
    if (first.nextCursor === null) throw new Error('Expected a second recovery page');

    const second = await h.store.readExpiredPreparedReceipts(100, first.nextCursor);
    const repeatedSecond = await h.store.readExpiredPreparedReceipts(100, first.nextCursor);
    expect(second).toEqual({ records: [entries[100]], nextCursor: null });
    expect(repeatedSecond).toEqual(second);
    expect(first.records.some((entry) => entry.receiptId === entries[100]?.receiptId)).toBe(false);
  });

  it('releases Promotion budget and user quota in the same prepared-receipt discard', async () => {
    const clock = new MutableClock(15_000);
    const promotionStore = await createMemoryPromotionLedgerStore();
    const ledger = new MemoryPromotionExecutionLedger(promotionStore, 60_000, clock);
    await expect(ledger.claim(PROMO_ID, USER, { useUntilAt: null })).resolves.toMatchObject({
      ok: true,
    });
    const receiptId = receipt(25);
    await expect(
      ledger.reserve({
        promotionId: PROMO_ID,
        userId: USER,
        receiptId,
        amountMist: 1_000_000n,
      }),
    ).resolves.toMatchObject({ ok: true });
    const sponsorPool = new SponsorPool([Ed25519Keypair.generate()], {
      hmacSecret: HMAC_SECRET,
    });
    const lease = await sponsorPool.checkout(receiptId);
    if (!lease) throw new Error('Expected the Promotion test sponsor lease');
    const bytes = await transactionBytes(lease.sponsorAddress);
    const store = new MemorySponsoredExecutionStore(sponsorPool, ledger, {
      clock,
      maxPerStudioUser: 1,
    });
    const prepared = await store.commitPreparedReceipt({
      mode: 'promotion',
      receiptId,
      senderAddress: SENDER,
      txBytesHash: txHash(bytes),
      sponsorAddress: lease.sponsorAddress,
      clientIp: CLIENT_IP,
      executionPathKey: 'promotion:test',
      orderId: null,
      promotionId: PROMO_ID,
      userId: USER,
      reservedGasMist: 1_000_000n,
    });
    await expect(store.checkUserQuota(USER)).resolves.toEqual({ exceeded: true, limit: 1 });
    const ledgerBeforeStaleRelease = await ledger.getPromotionLedgerStatus(PROMO_ID, USER);
    await expect(ledger.release(receiptId)).resolves.toEqual({
      ok: false,
      reason: 'record_changed',
    });
    await expect(ledger.getPromotionLedgerStatus(PROMO_ID, USER)).resolves.toEqual(
      ledgerBeforeStaleRelease,
    );
    await expect(store.readPreparedReceipt(receiptId)).resolves.toEqual(prepared);
    await expect(sponsorPool.readSponsorLeaseRecord(lease.sponsorAddress)).resolves.toMatchObject({
      record: { stage: 'committed', receiptId, txBytesHash: prepared.txBytesHash },
    });

    await expect(
      store.discardPreparedReceipt({
        expected: prepared,
        result: {
          sponsorAddress: lease.sponsorAddress,
          outcome: 'validation_failure',
          executionStage: 'before_sponsor_signature',
          route: 'promotion',
          receiptId,
          senderAddress: SENDER,
          executionPathKey: 'promotion:test',
          orderIdHash: null,
          promotionId: PROMO_ID,
          userId: USER,
          economics: { economicsStatus: 'unknown', failureReason: 'expired' },
        },
      }),
    ).resolves.toMatchObject({ status: 'discarded' });
    await expect(store.checkUserQuota(USER)).resolves.toBe('ok');
    await expect(ledger.getPromotionLedgerStatus(PROMO_ID, USER)).resolves.toMatchObject({
      budget: { reservedMist: 0n },
      entitlement: {
        activeReservationReceiptId: null,
        remainingGasAllowanceMist: '5000000',
      },
    });
  });

  it('returns the same nonce for an exact receipt retry at quota and fails when u64 is exhausted', async () => {
    const clock = new MutableClock(10_000);
    const sponsorPool = new SponsorPool([Ed25519Keypair.generate()], { hmacSecret: HMAC_SECRET });
    const store = new MemorySponsoredExecutionStore(sponsorPool, undefined, {
      maxOutstandingPerSender: 1,
      clock,
    });
    const firstReceipt = receipt(20);
    await expect(store.reserveNonce(SENDER, 0n, firstReceipt)).resolves.toBe(1n);
    await expect(store.reserveNonce(SENDER, 0n, firstReceipt)).resolves.toBe(1n);
    await expect(store.reserveNonce(SENDER, 0n, receipt(21))).rejects.toThrow(/outstanding/);
    await store.releaseNonceReservation(firstReceipt, SENDER);
    await expect(store.reserveNonce(SENDER, U64_MAX, receipt(22))).rejects.toThrow(
      'No u64 nonce remains for this sender',
    );
  });

  it('moves a Promotion reservation with the receipt and consumes only the charged MIST', async () => {
    const clock = new MutableClock(20_000);
    const promotionStore = await createMemoryPromotionLedgerStore();
    const ledger = new MemoryPromotionExecutionLedger(promotionStore, 60_000, clock);
    await expect(ledger.claim(PROMO_ID, USER, { useUntilAt: null })).resolves.toMatchObject({
      ok: true,
    });
    const receiptId = receipt(30);
    await expect(
      ledger.reserve({
        promotionId: PROMO_ID,
        userId: USER,
        receiptId,
        amountMist: 1_000_000n,
      }),
    ).resolves.toMatchObject({ ok: true });
    const sponsorPool = new SponsorPool([Ed25519Keypair.generate()], { hmacSecret: HMAC_SECRET });
    const lease = await sponsorPool.checkout(receiptId);
    if (!lease) throw new Error('Expected the Promotion test sponsor lease');
    const bytes = await transactionBytes(lease.sponsorAddress);
    const store = new MemorySponsoredExecutionStore(sponsorPool, ledger, { clock });
    const draft: PromotionPreparedTxDraft = {
      mode: 'promotion',
      receiptId,
      senderAddress: SENDER,
      txBytesHash: txHash(bytes),
      sponsorAddress: lease.sponsorAddress,
      clientIp: CLIENT_IP,
      executionPathKey: 'promotion:test',
      orderId: null,
      promotionId: PROMO_ID,
      userId: USER,
      reservedGasMist: 1_000_000n,
    };
    await store.commitPreparedReceipt(draft);
    const begun = await store.beginSponsoredExecution({
      receiptId,
      txBytes: bytes,
      expectedMode: 'promotion',
      executionBudgetMs: 2_000,
      recovery: {
        route: 'promotion',
        senderAddress: SENDER,
        executionPathKey: 'promotion:test',
        promotionId: PROMO_ID,
        userId: USER,
        reservedGasMist: '1000000',
      },
    });
    expect(begun.status).toBe('executing');
    if (begun.status !== 'executing') return;
    const result: SponsorResultMetadata = {
      sponsorAddress: lease.sponsorAddress,
      outcome: 'success',
      executionStage: 'on_chain',
      route: 'promotion',
      digest: begun.execution.transactionDigest,
      receiptId,
      senderAddress: SENDER,
      executionPathKey: 'promotion:test',
      orderIdHash: null,
      promotionId: PROMO_ID,
      userId: USER,
      economics: {
        economicsStatus: 'known',
        recoveredGasMist: '0',
        hostPaidGasMist: '600000',
        hostFeeMist: '0',
        hostNetMist: '-600000',
        grossGasMist: '600000',
        storageRebateMist: '0',
        protocolFeeMist: '0',
        failureReason: null,
      },
    };
    const finalInput = {
      expected: begun.execution,
      result,
      promotion: { operation: 'consume' as const, chargedMist: 600_000n },
    };
    await expect(store.finalizeSponsoredExecution(finalInput)).resolves.toMatchObject({
      status: 'finalized',
    });
    await expect(store.finalizeSponsoredExecution(finalInput)).resolves.toMatchObject({
      status: 'already_final',
    });
    await expect(
      store.finalizeSponsoredExecution({
        ...finalInput,
        promotion: { operation: 'consume', chargedMist: 500_000n },
      }),
    ).resolves.toEqual({ status: 'state_changed' });
    await expect(ledger.getPromotionLedgerStatus(PROMO_ID, USER)).resolves.toMatchObject({
      budget: { reservedMist: 0n, consumedMist: 600_000n },
      entitlement: {
        activeReservationReceiptId: null,
        remainingGasAllowanceMist: '4400000',
        consumedGasAllowanceMist: '600000',
      },
    });
  });

  it('rejects a draft with an unexpected field before storing it', async () => {
    const h = await genericHarness();
    await expect(
      h.store.commitPreparedReceipt({
        ...h.draft,
        unexpectedField: 1,
      } as unknown as GenericPreparedTxDraft),
    ).rejects.toThrow(/unexpected field set/);
    await expect(h.store.readPreparedReceipt(h.receiptId)).resolves.toBeNull();
    expect((await h.sponsorPool.readSponsorLeaseRecord(h.draft.sponsorAddress))?.record.stage).toBe(
      'reserved',
    );
  });
});
