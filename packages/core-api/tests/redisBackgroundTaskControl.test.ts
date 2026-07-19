import { setImmediate as scheduleImmediate } from 'node:timers';
import { NODE_TIMER_MAX_DELAY_MS } from '@stelis/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { RedisClientLike } from '../src/store/redisClient.js';
import {
  ABUSE_BLOCK_DEADLINE_INDEX_KEY,
  ABUSE_BLOCK_EXPIRY_BATCH_SIZE,
  ABUSE_BLOCK_RECORD_PREFIX,
  abuseBlockMember,
} from '../src/store/abuseBlockStore.js';
import { RedisAbuseBlocker } from '../src/store/redisAbuseBlocker.js';
import { PROMOTION_EXECUTION_LEDGER_SWEEP_BATCH_SIZE } from '../src/studio/executionLedger.js';
import {
  RedisPromotionExecutionLedger,
  type RedisPromotionRecordAccess,
} from '../src/studio/executionLedgerRedis.js';

interface SweepBatchResult {
  readonly swept: number;
  readonly examined: number;
}

interface LedgerTaskControl {
  runSweepBatch: () => Promise<SweepBatchResult>;
  drainExpiredReservations: () => Promise<void>;
  startScheduledSweep: () => void;
}

interface AbuseTaskControl {
  runExpirySweep: () => Promise<void>;
}

describe('Redis background task control flow', () => {
  it('uses the constructor interval for scheduled Promotion sweeps', async () => {
    vi.useFakeTimers();
    const evalMock = vi.fn<RedisClientLike['eval']>().mockResolvedValue(['1700000000000', '0']);
    const ledger = createLedger(100, evalMock);

    try {
      await vi.advanceTimersByTimeAsync(100);
      await ledger.dispose();
      expect(evalMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables scheduled Promotion sweeps only when the interval is zero', async () => {
    vi.useFakeTimers();
    const evalMock = vi.fn<RedisClientLike['eval']>().mockResolvedValue(['1700000000000', '0']);
    const ledger = createLedger(0, evalMock);

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await ledger.dispose();
      expect(evalMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a Promotion sweep interval that Node would truncate', () => {
    expect(() => createLedger(NODE_TIMER_MAX_DELAY_MS + 1)).toThrow(
      String(NODE_TIMER_MAX_DELAY_MS),
    );
  });

  it('yields before draining the next full Promotion reservation batch', async () => {
    const ledger = createLedger();
    const control = ledger as unknown as LedgerTaskControl;
    let eventLoopTurnObserved = false;
    const eventLoopTurn = new Promise<void>((resolve) => {
      scheduleImmediate(() => {
        eventLoopTurnObserved = true;
        resolve();
      });
    });
    const runSweepBatch = vi
      .fn<LedgerTaskControl['runSweepBatch']>()
      .mockResolvedValueOnce({
        swept: PROMOTION_EXECUTION_LEDGER_SWEEP_BATCH_SIZE,
        examined: PROMOTION_EXECUTION_LEDGER_SWEEP_BATCH_SIZE,
      })
      .mockImplementationOnce(async () => {
        expect(eventLoopTurnObserved).toBe(true);
        return { swept: 0, examined: 0 };
      });
    control.runSweepBatch = runSweepBatch;

    await control.drainExpiredReservations();
    await eventLoopTurn;

    expect(runSweepBatch).toHaveBeenCalledTimes(2);
    await ledger.dispose();
  });

  it('dispose waits for the running Promotion reservation batch', async () => {
    const ledger = createLedger();
    const control = ledger as unknown as LedgerTaskControl;
    const batch = deferred<SweepBatchResult>();
    const runSweepBatch = vi
      .fn<LedgerTaskControl['runSweepBatch']>()
      .mockReturnValue(batch.promise);
    control.runSweepBatch = runSweepBatch;
    control.startScheduledSweep();

    let disposed = false;
    const disposing = ledger.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();

    expect(runSweepBatch).toHaveBeenCalledOnce();
    expect(disposed).toBe(false);

    batch.resolve({ swept: 0, examined: 0 });
    await disposing;
    expect(disposed).toBe(true);
  });

  it('yields before draining the next full abuse-block expiry batch', async () => {
    const members = Array.from({ length: ABUSE_BLOCK_EXPIRY_BATCH_SIZE }, (_, index) =>
      abuseBlockMember({
        scope: 'studio_user',
        subject: `expiry-user-${index.toString().padStart(3, '0')}`,
      }),
    ).sort();
    const rows = members.map((member) => [member, '1', '0', '']);
    let dueReads = 0;
    let eventLoopTurnObserved = false;
    const eventLoopTurn = new Promise<void>((resolve) => {
      scheduleImmediate(() => {
        eventLoopTurnObserved = true;
        resolve();
      });
    });
    const evalMock = vi.fn<RedisClientLike['eval']>(async (_script, keys, args) => {
      expect(keys).toEqual([ABUSE_BLOCK_DEADLINE_INDEX_KEY]);
      if (args.length === 2) {
        expect(args).toEqual([String(ABUSE_BLOCK_EXPIRY_BATCH_SIZE), ABUSE_BLOCK_RECORD_PREFIX]);
        dueReads += 1;
        if (dueReads === 1) return ['ok', '1700000000000', rows];
        expect(eventLoopTurnObserved).toBe(true);
        return ['ok', '1700000000000', []];
      }
      expect(args).toHaveLength(1 + ABUSE_BLOCK_EXPIRY_BATCH_SIZE * 4);
      expect(args[0]).toBe(ABUSE_BLOCK_RECORD_PREFIX);
      return ['ok', '1700000000000', String(ABUSE_BLOCK_EXPIRY_BATCH_SIZE)];
    });
    const store = new RedisAbuseBlocker(redisClient(evalMock));

    try {
      await (store as unknown as AbuseTaskControl).runExpirySweep();
      await eventLoopTurn;

      expect(dueReads).toBe(2);
      expect(evalMock).toHaveBeenCalledTimes(3);
    } finally {
      await store.stop();
    }
  });
});

function createLedger(
  reaperIntervalMs = 0,
  evalMock: RedisClientLike['eval'] = vi.fn(),
): RedisPromotionExecutionLedger {
  const promotionStore: RedisPromotionRecordAccess = {
    async readCurrent() {
      return null;
    },
    recordKey(promotionId) {
      return `promotion:${promotionId}`;
    },
  };
  return new RedisPromotionExecutionLedger(
    redisClient(evalMock),
    promotionStore,
    60_000,
    reaperIntervalMs,
  );
}

function redisClient(evalMock: RedisClientLike['eval']): RedisClientLike {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    eval: evalMock,
    hgetall: vi.fn(),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((currentResolve) => {
    resolve = currentResolve;
  });
  return { promise, resolve };
}
