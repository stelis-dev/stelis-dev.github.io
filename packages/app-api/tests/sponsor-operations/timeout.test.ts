import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SponsorOperationsTimeoutError,
  withTimeout,
} from '../../src/sponsor-operations/timeout.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('SponsorOperations timeout boundary', () => {
  it('waits for delayed task cleanup before reporting a timeout', async () => {
    vi.useFakeTimers();
    let captureTaskSignal!: (signal: AbortSignal) => void;
    const taskStarted = new Promise<AbortSignal>((resolve) => {
      captureTaskSignal = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let taskCleanedUp = false;
    const result = withTimeout('balance probe', 25, async (signal) => {
      captureTaskSignal(signal);
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await cleanup;
      taskCleanedUp = true;
      throw signal.reason;
    });
    let resultSettled = false;
    void result.then(
      () => {
        resultSettled = true;
      },
      () => {
        resultSettled = true;
      },
    );
    const taskSignal = await taskStarted;

    await vi.advanceTimersByTimeAsync(25);
    expect(taskSignal.aborted).toBe(true);
    expect(taskSignal.reason).toBeInstanceOf(SponsorOperationsTimeoutError);
    expect(resultSettled).toBe(false);
    expect(taskCleanedUp).toBe(false);

    releaseCleanup();
    await expect(result).rejects.toBeInstanceOf(SponsorOperationsTimeoutError);
    expect(taskCleanedUp).toBe(true);
  });

  it('waits for delayed task cleanup before reporting caller cancellation', async () => {
    const caller = new AbortController();
    let captureTaskSignal!: (signal: AbortSignal) => void;
    const taskStarted = new Promise<AbortSignal>((resolve) => {
      captureTaskSignal = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let taskCleanedUp = false;
    const result = withTimeout(
      'balance probe',
      1_000,
      async (signal) => {
        captureTaskSignal(signal);
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await cleanup;
        taskCleanedUp = true;
        throw signal.reason;
      },
      caller.signal,
    );
    let resultSettled = false;
    void result.then(
      () => {
        resultSettled = true;
      },
      () => {
        resultSettled = true;
      },
    );

    const taskSignal = await taskStarted;
    caller.abort();
    expect(taskSignal.aborted).toBe(true);
    await Promise.resolve();
    expect(resultSettled).toBe(false);
    expect(taskCleanedUp).toBe(false);

    releaseCleanup();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(taskCleanedUp).toBe(true);
  });

  it('does not lose caller cancellation while registering its listener', async () => {
    let abortedReads = 0;
    const reason = new DOMException('Aborted', 'AbortError');
    const signal = {
      get aborted() {
        abortedReads += 1;
        return abortedReads >= 2;
      },
      get reason() {
        return reason;
      },
      throwIfAborted() {
        abortedReads += 1;
        if (abortedReads >= 2) throw reason;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const task = vi.fn(async () => 'must not run');

    await expect(withTimeout('balance probe', 1_000, task, signal)).rejects.toBe(reason);
    expect(task).not.toHaveBeenCalled();
  });
});
