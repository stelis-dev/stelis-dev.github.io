import { describe, expect, it, vi } from 'vitest';
import type { SponsorRefillAccountSpendCoordinator } from '../../src/sponsor-operations/accountSpend.js';
import type {
  RedisSponsorOperationsState,
  SlotRead,
} from '../../src/sponsor-operations/redisState.js';
import { createSponsorOperationsRefillWorker } from '../../src/sponsor-operations/refillWorker.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function slotRead(writeSeq: number, state: SlotRead['state'] = 'healthy'): SlotRead {
  return {
    address: '0xslot',
    state,
    balanceMist: '10',
    lastError: null,
    lastObservedAtMs: 1,
    writeSeq,
    pendingRefillDigest: null,
    refillAttemptedAmountMist: null,
    refillObservedBalanceMist: null,
    refillReconciliationResult: null,
    refillOperationId: null,
    refillOperationSequence: null,
    refillOperationState: null,
    refillRequiredSourceBalanceMist: null,
  };
}

function stateStub(
  reads: readonly SlotRead[] = [slotRead(4)],
  readAllSlots: readonly SlotRead[] = [reads[reads.length - 1]!],
  sourceBalances: readonly (string | null)[] = ['100'],
) {
  let readIndex = 0;
  let readAllIndex = 0;
  return {
    readAll: vi.fn(async () => {
      const balanceMist =
        sourceBalances[Math.min(readAllIndex++, sourceBalances.length - 1)] ?? null;
      return {
        slots: readAllSlots,
        sponsorRefillAccount: {
          balanceMist,
          healthy: balanceMist === null ? false : true,
          refillsRemaining: balanceMist === null ? null : 1,
          lastError: balanceMist === null ? 'unavailable' : null,
          lastObservedAtMs: 1,
          writeSeq: readAllIndex,
        },
      };
    }),
    readSlot: vi.fn(async () => reads[Math.min(readIndex++, reads.length - 1)]),
    updateSlotIfWriteSeq: vi.fn(async () => true),
  } satisfies Pick<RedisSponsorOperationsState, 'readAll' | 'readSlot' | 'updateSlotIfWriteSeq'>;
}

describe('Sponsor operations refill trigger queue', () => {
  it('coalesces duplicate in-flight triggers into one trailing coordinator pass', async () => {
    const gate = deferred<{
      status: 'not_needed';
      slotAddress: string;
      balanceMist: string;
    }>();
    const state = stateStub();
    const refill = vi.fn(() => gate.promise);
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    worker.requestRefill('0xslot');
    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    gate.resolve({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.readSlot).toHaveBeenCalledTimes(4));
    worker.dispose();
  });

  it('does not discard an in-flight trigger when the current spend finishes failed', async () => {
    const gate = deferred<{
      status: 'failed';
      operationId: string;
      digest: string;
      amountMist: string;
      error: string;
    }>();
    const state = stateStub([slotRead(1), slotRead(2, 'refill_failed'), slotRead(3)]);
    const refill = vi
      .fn()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValueOnce({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 100,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    worker.requestRefill('0xslot');
    gate.resolve({
      status: 'failed',
      operationId: 'operation-a',
      digest: 'digest-a',
      amountMist: '10',
      error: 'on-chain failure',
    });

    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.readSlot).toHaveBeenCalledTimes(4));
    worker.dispose();
  });

  it('does not lose a retry timer that fires while an error projection is still writing', async () => {
    const state = stateStub();
    const writeGate = deferred<boolean>();
    state.updateSlotIfWriteSeq.mockImplementationOnce(() => writeGate.promise);
    const refill = vi
      .fn()
      .mockRejectedValueOnce(new Error('source balance unavailable'))
      .mockResolvedValueOnce({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(state.updateSlotIfWriteSeq).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeGate.resolve(true);

    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.readSlot).toHaveBeenCalledTimes(3));
    worker.dispose();
  });

  it('records a coordinator boundary error only if the sampled slot is still current, then retries', async () => {
    const state = stateStub();
    const refill = vi
      .fn()
      .mockRejectedValueOnce(new Error('source balance unavailable'))
      .mockResolvedValueOnce({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(state.updateSlotIfWriteSeq).toHaveBeenCalledTimes(1));
    expect(state.updateSlotIfWriteSeq).toHaveBeenCalledWith('0xslot', 4, {
      lastError: 'source balance unavailable',
    });
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    expect(refill).toHaveBeenNthCalledWith(1, '0xslot', 'explicit');
    expect(refill).toHaveBeenNthCalledWith(2, '0xslot', 'retry');
    worker.dispose();
  });

  it('does not lose a trigger when the initial Redis slot read fails', async () => {
    const state = stateStub();
    vi.mocked(state.readSlot).mockRejectedValueOnce(new Error('redis read unavailable'));
    const refill = vi.fn().mockResolvedValue({
      status: 'not_needed',
      slotAddress: '0xslot',
      balanceMist: '10',
    });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    expect(refill).toHaveBeenCalledWith('0xslot', 'retry');
    expect(state.updateSlotIfWriteSeq).not.toHaveBeenCalled();
    worker.dispose();
  });

  it('retries a durable spend whose outcome is still pending', async () => {
    const state = stateStub();
    const refill = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'pending',
        operationId: 'operation-a',
        digest: 'digest-a',
        amountMist: '10',
        error: 'lookup unavailable',
      })
      .mockResolvedValueOnce({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    expect(refill).toHaveBeenNthCalledWith(1, '0xslot', 'explicit');
    expect(refill).toHaveBeenNthCalledWith(2, '0xslot', 'explicit');
    await vi.waitFor(() => expect(state.readSlot).toHaveBeenCalledTimes(3));
    worker.dispose();
  });

  it('does not retry a refill until a new balance observation re-enqueues it', async () => {
    const state = stateStub();
    const refill = vi.fn().mockResolvedValue({
      status: 'runway_blocked',
      operationId: 'operation-runway',
      digest: null,
      amountMist: '10',
      error: 'source runway unavailable',
    });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(refill).toHaveBeenCalledTimes(1);
    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    worker.dispose();
  });

  it('keeps a low-slot observation automatic when a runway threshold is present', async () => {
    const blockedSlot = {
      ...slotRead(4, 'refill_failed'),
      refillRequiredSourceBalanceMist: '200',
    };
    const refill = vi.fn().mockResolvedValue({ status: 'not_eligible', slotAddress: '0xslot' });
    const worker = createSponsorOperationsRefillWorker({
      state: stateStub([blockedSlot]),
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestObservedSlotRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    expect(refill).toHaveBeenCalledWith('0xslot', 'slot_observed');
    worker.dispose();
  });

  it('turns a low-slot observation without a runway threshold into one refill attempt', async () => {
    const refill = vi
      .fn()
      .mockResolvedValue({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state: stateStub([slotRead(4, 'low_balance'), slotRead(5, 'healthy')]),
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestObservedSlotRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    expect(refill).toHaveBeenCalledWith('0xslot', 'slot_observed');
    worker.dispose();
  });

  it('keeps an explicit refill request distinct from automatic runway eligibility', async () => {
    const blockedSlot = {
      ...slotRead(4, 'refill_failed'),
      refillRequiredSourceBalanceMist: '200',
    };
    const refill = vi
      .fn()
      .mockResolvedValue({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state: stateStub([blockedSlot]),
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    expect(refill).toHaveBeenCalledWith('0xslot', 'explicit');
    worker.dispose();
  });

  it('revalidates an in-flight low-slot hint after the first attempt records a runway threshold', async () => {
    const initial = slotRead(4, 'low_balance');
    const blocked = {
      ...slotRead(5, 'refill_failed'),
      refillRequiredSourceBalanceMist: '200',
    };
    const gate = deferred<{
      status: 'runway_blocked';
      operationId: string;
      digest: null;
      amountMist: string;
      error: string;
    }>();
    const refill = vi
      .fn()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValueOnce({ status: 'not_eligible', slotAddress: '0xslot' });
    const state = stateStub([initial, blocked]);
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    worker.requestObservedSlotRefill('0xslot');
    gate.resolve({
      status: 'runway_blocked',
      operationId: 'operation-runway',
      digest: null,
      amountMist: '10',
      error: 'source runway unavailable',
    });

    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    expect(refill).toHaveBeenNthCalledWith(2, '0xslot', 'slot_observed');
    worker.dispose();
  });

  it('re-enqueues a runway-blocked refill only when the observed source balance reaches its threshold', async () => {
    const blockedSlot = {
      ...slotRead(4, 'refill_failed'),
      refillRequiredSourceBalanceMist: '200',
    };
    const state = stateStub([blockedSlot], [blockedSlot], ['199', '200']);
    const refill = vi
      .fn()
      .mockResolvedValue({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    await worker.requestEligibleRefills();
    await Promise.resolve();
    expect(refill).not.toHaveBeenCalled();

    await worker.requestEligibleRefills();
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    expect(refill).toHaveBeenCalledWith('0xslot', 'source_observed');
    worker.dispose();
  });

  it('uses a source-balance observation to recover an unthresholded low slot', async () => {
    const lowSlot = slotRead(4, 'low_balance');
    const refill = vi
      .fn()
      .mockResolvedValue({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state: stateStub([lowSlot, slotRead(5, 'healthy')], [lowSlot]),
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    await worker.requestEligibleRefills();
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    worker.dispose();
  });

  it('does not treat source balance as evidence to retry an unthresholded terminal failure', async () => {
    const failedSlot = slotRead(4, 'refill_failed');
    const refill = vi.fn();
    const worker = createSponsorOperationsRefillWorker({
      state: stateStub([failedSlot], [failedSlot], ['1000']),
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    await worker.requestEligibleRefills();
    await Promise.resolve();
    expect(refill).not.toHaveBeenCalled();
    worker.dispose();
  });

  it('keeps coalesced source observations automatic when the latest balance decreases', async () => {
    const initial = slotRead(4, 'low_balance');
    const threshold = {
      ...slotRead(5, 'refill_failed'),
      refillRequiredSourceBalanceMist: '240',
    };
    const gate = deferred<{
      status: 'runway_blocked';
      operationId: string;
      digest: null;
      amountMist: string;
      error: string;
    }>();
    const refill = vi
      .fn()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValueOnce({ status: 'not_eligible', slotAddress: '0xslot' });
    const worker = createSponsorOperationsRefillWorker({
      state: stateStub([initial, threshold], [threshold], ['250', '210']),
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    worker.requestObservedSlotRefill('0xslot');
    await worker.requestEligibleRefills();
    await worker.requestEligibleRefills();
    gate.resolve({
      status: 'runway_blocked',
      operationId: 'operation-runway',
      digest: null,
      amountMist: '10',
      error: 'source runway unavailable',
    });

    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    expect(refill).toHaveBeenNthCalledWith(2, '0xslot', 'source_observed');
    worker.dispose();
  });

  it('retries an unaccepted refill even when the slot projection is refill-failed', async () => {
    const state = stateStub([
      slotRead(4, 'refill_failed'),
      slotRead(4, 'refill_failed'),
      slotRead(5),
    ]);
    const refill = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'busy',
        operationId: 'blocking-withdrawal',
        digest: 'blocking-digest',
        error: 'another account spend was recovered',
      })
      .mockResolvedValueOnce({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');

    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.readSlot).toHaveBeenCalledTimes(3));
    worker.dispose();
  });

  it('does not promote an automatic refill to explicit work after a busy result', async () => {
    const state = stateStub([slotRead(4, 'low_balance'), slotRead(5, 'low_balance')]);
    const refill = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'busy',
        operationId: 'blocking-withdrawal',
        digest: 'blocking-digest',
        error: 'another account spend was recovered',
      })
      .mockResolvedValueOnce({ status: 'not_eligible', slotAddress: '0xslot' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestObservedSlotRefill('0xslot');

    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    expect(refill).toHaveBeenNthCalledWith(1, '0xslot', 'slot_observed');
    expect(refill).toHaveBeenNthCalledWith(2, '0xslot', 'slot_observed');
    worker.dispose();
  });

  it('requeues a successful refill when its terminal slot observation is still low', async () => {
    const state = stateStub([
      slotRead(4, 'low_balance'),
      slotRead(5, 'low_balance'),
      slotRead(5, 'low_balance'),
      slotRead(6),
    ]);
    const refill = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'succeeded',
        operationId: 'operation-a',
        digest: 'digest-a',
        amountMist: '10',
      })
      .mockResolvedValueOnce({ status: 'not_needed', slotAddress: '0xslot', balanceMist: '10' });
    const worker = createSponsorOperationsRefillWorker({
      state,
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });

    worker.requestRefill('0xslot');
    await vi.waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.readSlot).toHaveBeenCalledTimes(4));
    worker.dispose();
  });

  it('dispose prevents later triggers', async () => {
    const refill = vi.fn();
    const worker = createSponsorOperationsRefillWorker({
      state: stateStub(),
      spendCoordinator: { refill } as unknown as SponsorRefillAccountSpendCoordinator,
      retryDelayMs: 10,
    });
    worker.dispose();
    worker.requestRefill('0xslot');
    await Promise.resolve();
    expect(refill).not.toHaveBeenCalled();
  });
});
